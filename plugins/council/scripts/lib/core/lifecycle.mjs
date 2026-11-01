// Turn lifecycle (S2.4): `runManagedTurn(ctx, adapter, initial, prepare, options, hooks)` and `cancelManaged`, ported from
// grok_plugin_for_codex 1.1.0 lib/lifecycle.mjs with codex-plugin-cc 2.3.2's 12 s PIPE_WAIT_MS, unattributed-pipe handling
// and `thread locked`, and claude_plugin_for_codex 0.5.0 process.mjs's held-output lock. One writer owns the job from
// admission through finalization; the adapter's beforeTurn/afterTurn run once each, afterTurn only after verified cleanup
// (deferred to the `cancel` that confirms it when the turn ends with cleanup pending).
// The stop path snapshots owned descendants, SIGTERMs the child's group, then SIGKILLs (taskkill /T /F on Windows).
import fs from "node:fs";
import path from "node:path";
import { BusyError, claimThread, claimHeld, releaseClaims } from "./claims.mjs";
import { createJob, saveJob, markDone, markStopped, loadJob, cleanupNeeded, jobView, markRequestPrepared, saveThread } from "./jobs.mjs";
import { BEAT_MS, refreshBeat } from "./heartbeat.mjs";
import { executionController, companionState, recordRecoveryEvidence, QUERY_MS } from "./execution.mjs";
import { spawnChild } from "./launcher.mjs";
import { createReader } from "./reader.mjs";
import { attentionReason, readAnswer } from "./output.mjs";
import { writeFileAtomic } from "./fs.mjs";
import { snapshotBefore, workspaceEdits } from "./snapshot.mjs";
import { UsageError } from "./args.mjs";

/** Production defaults; tests inject shorter ones through hooks. */
export const SHUTDOWN_MS = 60000;
export const RETRY_MS = 10000;
/** How long the group gets after SIGTERM before identified rows are SIGKILLed (A7.5). */
export const GRACE_MS = 3000;
export const DRAIN_MS = 1500;
/** How long after a clean exit the child's pipes may stay open, held by nothing the turn owns, before the thread locks (A7.8). */
export const PIPE_WAIT_MS = 12000;
const UNSURE_MS = 1000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const running = (child) => child && child.exitCode === null && child.signalCode === null;
const remaining = (end, queryMs) => Math.max(1, Math.min(queryMs, end - Date.now()));
const label = (job) => job.done && job.outcome !== "cancelled" ? "finished" : "cancelled";
const unique = (rows) => [...new Map(rows.map((r) => [`${r.pid}:${r.stamp}:${r.boot ?? ""}`, r])).values()];
const release = (child) => { if (!child) return; for (const stream of [child.stdin, child.stdout, child.stderr]) stream?.destroy(); child.unref(); };

/** A footer's `error:` is cut at 200 B: the action comes first, and the id, whose length the provider decides, after it. */
export const lockedThreadMessage = (thread, job) => `start a new ask, or cancel ${job} --confirm-ended after checking the process table: thread ${thread} is locked; an unidentified process held that job's output`;

export async function runManagedTurn(ctx, adapter, initial, prepare, options = {}, hooks = {}) {
  const platform = hooks.platform ?? process.platform;
  const control = hooks.control ?? executionController({ adapter, platform });
  const io = hooks.io ?? fs;
  const save = hooks.saveJob ?? saveJob;
  const finishMarker = hooks.markDone ?? markDone;
  const queryMs = hooks.queryMs ?? QUERY_MS;
  const provider = adapter.id;
  const job = createJob(ctx.home, {
    provider, verb: initial.verb, status: "running", tier: initial.tier ?? null, model: initial.model ?? null, effort: initial.effort ?? null,
    requestedEffort: initial.requestedEffort ?? initial.effort ?? null, modelVerified: initial.modelVerified !== false, web: Boolean(initial.web),
    cwd: initial.cwd, session: ctx.session ?? null, threadId: initial.confirmed ? initial.thread : null, requestedThreadId: initial.thread ?? null, threadIds: [],
    admitted: false, cleanupPending: false, companionPid: process.pid, companionIdentity: control.self(), execution: [], pid: null,
    spawnedAt: new Date().toISOString(), round: 0, rounds: initial.rounds ?? null, roundsSet: Boolean(initial.roundsSet),
    requestKey: options.requestKey ?? null, requestId: options.requestId ?? null,
  }, options.jobId);
  const answerFile = path.join(job.dir, "answer.md");
  const cancelFile = path.join(job.dir, "cancel");
  const cancelled = () => io.existsSync(cancelFile);
  const beat = () => refreshBeat(job, io);
  const controlled = {
    inspect: (...args) => control.inspect(...args),
    snapshot: (...args) => { beat(); return control.snapshot(...args); },
    stop: (...args) => { beat(); return control.stop(...args); },
  };
  let turn = initial, built = null, child = null, reason = null, persistenceFailed = false, spawnError = null;
  let drainExpired = false, pipesClosed = false, exhausted = false, announced = false, answer = "", queryError = null;
  let afterTurnDone = false, hookOutcome = null, refusal = null, released = false;
  const announce = () => { if (!announced && !options.json) { announced = true; hooks.announce?.(job); } };
  const claim = (id) => {
    if (!id) return;
    try { claimThread(ctx.home, provider, id, job, hooks.claimIo); }
    catch (error) {
      if (error.claimLeft) { job.threadIds = [...new Set([...job.threadIds, id])]; try { save(job); } catch { /* finalization saves again */ } }
      const holder = error instanceof BusyError && error.job ? loadJob(ctx.home, error.job) : null;
      if (holder?.done && holder.unattributedPipes && !holder.stopped) error.message = lockedThreadMessage(id, error.job);
      throw error;
    }
    job.threadIds = [...new Set([...job.threadIds, id])];
    save(job);
  };
  let reader = null;
  let cleanupConfirmed = true; // No spawn yet.
  let streamFailure = null;
  let stop = (why) => { reason ??= why; };
  const afterTurn = async (outcome) => {
    if (afterTurnDone || !adapter.afterTurn) return;
    afterTurnDone = true;
    try { hookOutcome = (await adapter.afterTurn({ job, request: turn, cwd: job.cwd, env: ctx.env }, outcome)) ?? null; }
    catch (error) { reason ??= `afterTurn failed: ${error.message}`; }
  };

  try {
    await hooks.beforeClaim?.(job);
    claim(initial.thread);
    // Re-read history after admission so a turn that finished meanwhile is inherited.
    turn = prepare ? prepare(job.id) : initial;
    if (initial.thread && turn.thread !== initial.thread) throw new Error("the thread changed during admission");
    built = turn.build ? turn.build(job.dir) : turn.built;
    if (!initial.thread && built.requestedThreadId) { claim(built.requestedThreadId); job.requestedThreadId = built.requestedThreadId; }
    Object.assign(job, {
      tier: turn.tier ?? job.tier, model: turn.model ?? job.model, modelInput: turn.modelInput ?? null, effort: turn.effort ?? job.effort, requestedEffort: turn.requestedEffort ?? job.requestedEffort,
      modelVerified: turn.modelVerified !== false, web: Boolean(turn.web), cwd: turn.cwd ?? job.cwd, agent: built.agent ?? null, readOnly: built.readOnly !== false,
      target: turn.target ?? null, unreviewed: turn.unreviewed ?? [],
      reviewState: turn.reviewState ?? null, reviewStateBase: turn.reviewState ?? null, nextInput: Boolean(turn.nextInput), batch: turn.batch ?? null,
      round: turn.round ?? 0, rounds: turn.rounds ?? job.rounds, roundsSet: Boolean(turn.roundsSet),
      childArgs: built.args, promptFile: built.promptFile ?? null, answerFile: built.answerFile ?? null,
      argv: [turn.launcher.command, ...turn.launcher.args, ...built.args],
    });
    // A prompt-file adapter may compose the file itself (promptText: instructions plus text), without piping stdin.
    if (built.promptFile) io.writeFileSync(built.promptFile, built.promptText ?? built.stdin ?? turn.prompt ?? "");
    if (turn.reviewFiles) {
      const root = path.join(job.dir, "review-input");
      io.mkdirSync(root, { recursive: true });
      io.writeFileSync(path.join(root, "review.diff"), turn.reviewFiles.diff);
      io.writeFileSync(path.join(root, "index.json"), JSON.stringify(turn.reviewFiles.snapshot.index));
      io.writeFileSync(path.join(root, "review.data"), turn.reviewFiles.snapshot.data);
    }
    save(job);
    // Preparation complete (every prompt and review-input write done): the reservation becomes a tombstone, and only
    // then is the job admitted; a failure before this point leaves it unadmitted, so the entry frees the request id.
    if (options.requestKey) markRequestPrepared(ctx.home, options.requestKey);
    Object.assign(job, { admitted: true, admittedAt: new Date().toISOString() });
    save(job);
    // Every task counts working-tree changes, so an edit made through a shell is counted (S7.1); read-only turns have no such check here.
    if (job.verb === "task") snapshotBefore(job, job.cwd, ctx.env);
    if (adapter.beforeTurn) await adapter.beforeTurn({ job, request: turn, cwd: job.cwd, env: ctx.env });
    await hooks.beforeSpawn?.(job);
    if (cancelled()) {
      reason = "cancelled";
    } else {
      cleanupConfirmed = false;
      job.spawnAttempted = true;
      save(job); // Persist the exact operands before any executable can start.
      const startedAt = Date.now();
      let stoppedAt = 0, killedAt = 0, lastEventAt = startedAt, beatAt = startedAt, exitedAt = 0, termSent = false;
      const shutdownMs = hooks.shutdownMs ?? SHUTDOWN_MS;
      const retryMs = hooks.retryMs ?? RETRY_MS;
      const graceMs = hooks.graceMs ?? Math.min(GRACE_MS, retryMs);
      const drainMs = hooks.drainMs ?? DRAIN_MS;
      const pipeWaitMs = hooks.pipeWaitMs ?? PIPE_WAIT_MS;
      const beatMs = hooks.beatMs ?? BEAT_MS;
      // Every heartbeat persists the identities (pid + creation time) of the owned descendants, so recovery can adopt a
      // group member reparented after the leader exits only by a recorded identity (A7.5). Not on Windows (no groups;
      // its query costs most of a second); a failed query changes nothing.
      const persistDescendants = () => {
        if (platform === "win32" || reason) return;
        try {
          const found = control.inspect(job, control.snapshot(queryMs));
          if (found.rows.length) { job.execution = unique([...job.execution, ...found.rows]); save(job); }
        } catch { /* the next heartbeat or the stop snapshot records them */ }
      };
      const stopOwned = () => {
        let found;
        const end = stoppedAt + shutdownMs;
        try {
          found = controlled.inspect(job, controlled.snapshot(remaining(end, queryMs)));
          job.execution = unique([...job.execution, ...found.rows]);
          save(job); // Capture descendants before their parent can disappear.
        } catch (error) { persistenceFailed = true; reason ??= `storage/process query: ${error.message}`; return; }
        // The group first, by SIGTERM, then every identified row by SIGKILL (taskkill /T /F on Windows).
        if (!termSent && child?.pid && platform !== "win32" && running(child)) {
          termSent = true;
          try { process.kill(-child.pid, "SIGTERM"); } catch { try { child.kill("SIGTERM"); } catch { /* gone */ } }
          killedAt = Date.now() - retryMs + graceMs; // the SIGKILL pass follows after the grace period, not a full retry
          return;
        }
        for (const row of found?.rows ?? []) {
          if (Date.now() - stoppedAt >= shutdownMs) break;
          try { controlled.stop(row, remaining(end, queryMs)); } catch { /* Unknown: rescan before release. */ }
        }
      };
      stop = (why) => {
        reason ??= why;
        if (stoppedAt) return;
        stoppedAt = killedAt = Date.now();
        stopOwned();
      };
      const onText = (text) => { // Spooled whole, structured reviews too; only rendering caps it.
        if (persistenceFailed || built.answerFile) return;
        try { io.appendFileSync(answerFile, text); }
        catch (error) { persistenceFailed = true; stop(`answer storage failed: ${error.message}`); }
      };
      reader = createReader(adapter, {
        cwd: job.cwd, expectedThreadId: turn.thread ?? built.requestedThreadId ?? null, onText,
        onFailure: (message) => { streamFailure = message; stop(message); },
        onThread: (id) => {
          // A discovered id is claimed before it is published; a collision fails the turn and the id is never published.
          try { if (!job.threadIds.includes(id)) claim(id); }
          catch (error) { streamFailure = error.message; stop(error.message); return false; }
          job.threadId = id;
          try { save(job); } catch (error) { persistenceFailed = true; stop(`job storage failed: ${error.message}`); }
          announce();
          return true;
        },
      });
      // parseEvent sees the turn's mode in its per-turn scratch: a read-only guard (Grok's FORBIDDEN catalogue) fails closed.
      Object.assign(reader.state.adapter, { readOnly: built.readOnly !== false, agent: built.agent ?? null });
      await new Promise((resolve) => {
        let settled = false, exitTimer = null, timer = null;
        const handlers = new Map();
        const finish = () => {
          if (settled) return;
          settled = true; clearInterval(timer); clearTimeout(exitTimer);
          for (const [signal, fn] of handlers) process.off(signal, fn);
          resolve();
        };
        try {
          child = (hooks.spawn ?? spawnChild)(turn.launcher, built.args, { cwd: turn.cwd, env: built.env ?? ctx.env, stdin: built.stdin !== undefined ? "pipe" : "ignore", platform });
        } catch (error) { spawnError = error; cleanupConfirmed = true; finish(); return; }
        child.on("error", (error) => { spawnError = error; finish(); });
        child.on("exit", () => {
          exitedAt = Date.now();
          clearInterval(timer);
          exitTimer = setTimeout(() => { drainExpired = true; finish(); }, drainMs); // Do not truncate bytes queued after exit, or wait forever for inherited pipes.
        });
        child.on("close", () => { pipesClosed = true; finish(); });
        for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) { const fn = () => stop("interrupted"); handlers.set(signal, fn); process.on(signal, fn); }
        child.stdin?.on("error", () => {});
        child.stdout.on("data", (chunk) => {
          if (!persistenceFailed) {
            try { io.appendFileSync(path.join(job.dir, "events.jsonl"), chunk); }
            catch (error) { persistenceFailed = true; stop(`event storage failed: ${error.message}`); }
          }
          if (reader.feed(chunk)) lastEventAt = Date.now();
        });
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk) => { job.stderrTail = ((job.stderrTail ?? "") + chunk).slice(-4096); });
        timer = setInterval(() => {
          const now = Date.now();
          if (now - beatAt >= beatMs) {
            if (refreshBeat(job, io)) { beatAt = now; persistDescendants(); }
            else { persistenceFailed = true; stop("heartbeat storage failed"); }
          }
          if (reason) {
            if (now - stoppedAt >= shutdownMs) { exhausted = true; finish(); }
            else if (now - killedAt >= retryMs) { killedAt = now; stopOwned(); }
          } else if (cancelled()) stop("cancelled");
          else if (now - startedAt >= options.deadlineMs) stop("wall-clock deadline passed");
          else if (now - lastEventAt >= options.inactivityMs) stop(`${provider} printed nothing before the inactivity deadline`);
        }, Math.max(20, Math.min(250, Math.min(options.deadlineMs, options.inactivityMs) / 10)));
        job.pid = child.pid ?? null;
        // The leader's own identity (one scoped query), persisted with the launch: without it no persisted identity
        // adopts a reparented group member (macOS rule). Not on Windows, whose query costs most of a second.
        if (job.pid && platform !== "win32") {
          try {
            const leader = control.identify?.(job.pid, queryMs);
            if (leader) { job.leader = { pid: leader.pid, stamp: leader.stamp, ...(leader.boot ? { boot: leader.boot } : {}) }; job.execution = unique([...job.execution, leader]); }
          } catch { /* no leader identity: group members stay unverified */ }
        }
        try {
          save(job); // Recovery finds the child by its recorded operands; no per-turn process query.
          if (cancelled()) stop("cancelled"); // Covers the cancellation-before/while-spawning race.
          else if (turn.thread || built.requestedThreadId) announce();
          if (built.stdin !== undefined && child.stdin) child.stdin.end(built.stdin);
        } catch (error) { persistenceFailed = true; stop(`launch storage failed: ${error.message}`); }
      });
      reader.end();
      if (!drainExpired) release(child);
      else { child.stdin?.destroy(); for (const stream of [child.stdout, child.stderr]) { stream.removeAllListeners("data"); stream.resume(); } }
      // A trusted launcher's clean exit ends everything that holds the turn's operands (Windows native, S7); otherwise scan.
      if (!cleanupConfirmed && !reason && !drainExpired && !running(child) && child.exitCode === 0 && adapter.trustsCleanExit?.(turn.launcher)) cleanupConfirmed = true;
      const scanOwned = async () => {
        let found = controlled.inspect(job, controlled.snapshot(queryMs));
        const stopped = found.rows.length > 0;
        if (stopped) {
          reason ??= "owned execution survived the launcher";
          const end = Date.now() + (exhausted ? 0 : shutdownMs); // the whole shutdown budget, not one query's (GROKX)
          do {
            job.execution = unique([...job.execution, ...found.rows]);
            save(job);
            for (const row of found.rows) {
              if (Date.now() >= end) break;
              try { controlled.stop(row, remaining(end, queryMs)); } catch { /* Keep cleanup pending. */ }
            }
            await sleep(50);
            found = controlled.inspect(job, controlled.snapshot(remaining(end, queryMs)));
          } while (found.state === "owned" && Date.now() < end);
        }
        return { found, stopped };
      };
      if (!cleanupConfirmed) {
        let { found, stopped } = await scanOwned();
        cleanupConfirmed = found.state === "gone" && !running(child);
        if (drainExpired) {
          for (const end = Date.now() + (stopped ? drainMs : 0); !pipesClosed && Date.now() < end;) await sleep(20);
          // After a clean exit that left nothing owned, wait a bounded time for whatever holds the pipes to let go.
          if (!pipesClosed && cleanupConfirmed && !stopped && !reason && child.exitCode === 0) {
            cleanupConfirmed = false;
            job.unattributedPipes = true;
            save(job);
            for (const end = exitedAt + pipeWaitMs; !pipesClosed && Date.now() < end;) {
              await sleep(50);
              if (Date.now() - beatAt >= BEAT_MS) { refreshBeat(job, io); beatAt = Date.now(); }
            }
            if (pipesClosed) {
              delete job.unattributedPipes;
              ({ found, stopped } = await scanOwned());
              cleanupConfirmed = found.state === "gone" && !running(child);
            }
          }
          if (!pipesClosed) {
            // Nothing observable can clear a held output: the thread stays locked until cancel --confirm-ended (A7.8).
            Object.assign(job, { unattributedPipes: true, identifiedStopped: found.state === "gone", threadLocked: true });
            cleanupConfirmed = false;
          }
        }
        queryError = found.error ?? null;
      }
      release(child);
    }
  } catch (error) {
    if (child && running(child)) { stop(error.message); cleanupConfirmed = false; }
    release(child);
    reason ??= error.message;
    // A usage refusal while preparing under the claim (a thread found not resumable after the claim): exit 2 once released.
    if (error instanceof UsageError && !job.admitted && !job.spawnAttempted) refusal = error;
  }

  const seen = reader?.state;
  if (seen?.threadId && !seen.failed && job.threadIds.includes(seen.threadId)) job.threadId = seen.threadId;
  if (seen?.model && (!job.model || job.model === "default")) Object.assign(job, { model: seen.model, modelObserved: true });
  // afterTurn only after verified cleanup; otherwise the cancel that confirms cleanup runs it (A7.5).
  const hookInput = { reason, completed: Boolean(seen?.completed), denials: seen?.denials ?? [] };
  // One path is one edit, whichever source named it and however (the reader keeps a path outside the cwd as the provider gave it).
  const addEdited = (paths) => {
    const known = new Set([...(seen?.edited ?? [])].map((p) => path.resolve(job.cwd, p)));
    for (const p of paths ?? []) if (!known.has(path.resolve(job.cwd, p))) { known.add(path.resolve(job.cwd, p)); seen?.edited.add(p); }
  };
  if (cleanupConfirmed && job.verb === "task" && job.spawnAttempted) {
    beat();
    try { addEdited(workspaceEdits(job, job.cwd, ctx.env)); } catch { /* the event-reported edits stand */ }
  }
  if (cleanupConfirmed) await afterTurn({ cleanupConfirmed, ...hookInput });
  else if (adapter.afterTurn) job.afterTurnPending = hookInput;
  addEdited(hookOutcome?.edited);
  let parsed = null;
  try { parsed = readAnswer(answerFile); answer = parsed.answer; }
  catch (error) { if (error.code !== "ENOENT") reason ??= `answer storage failed: ${error.message}`; }
  let outcome = "failed", error = reason, openQuestions = false, reviewIncomplete = null;
  const denied = seen?.denials?.length ? seen.denials : [];
  const incomplete = hookOutcome?.incomplete ?? seen?.incomplete ?? null;
  if (reason === "cancelled") outcome = "cancelled";
  else if (!error && persistenceFailed) error = "job storage failed";
  else if (!error && spawnError) error = `could not start ${provider}: ${spawnError.message}`;
  else if (!error && (streamFailure || seen?.failed)) error = streamFailure ?? seen.failed;
  else if (!error && !seen?.completed) error = job.stderrTail?.trim().split(/\r?\n/).at(-1) || `${provider} ended without completing the turn`;
  // A completed turn whose provider recorded a denial ends in attention (exit 10) even when the CLI exits non-zero for it
  // (Claude exits 1 on an is_error result that a denial caused); any other non-zero exit fails the turn.
  else if (!error && child?.exitCode !== 0 && !(seen?.completed && seen?.denials?.length && typeof child?.exitCode === "number")) error = `${provider} exited with code ${child?.exitCode}`;
  if (!error && outcome === "failed" && !turn.structuredReview && turn.finalizeTurn) {
    try { Object.assign(job, turn.finalizeTurn({ seen, job }) ?? {}); } catch (failure) { error = failure.message; }
  }
  if (!error && outcome === "failed") {
    if (!parsed?.nonempty && !turn.structuredReview) error = `${provider} returned no answer`;
    else if (denied.length) { outcome = "attention"; job.denied = denied; }
    else if (incomplete) { outcome = "attention"; job.incomplete = incomplete; }
    else if (turn.structuredReview && job.readOnly && seen?.edited?.size) { outcome = "attention"; job.incomplete = `the read-only review changed the workspace: ${[...seen.edited].slice(0, 5).join(", ")}`; }
    else if (turn.structuredReview) outcome = "review"; // settled below, after the cleanup check
    else { openQuestions = parsed.questions; outcome = openQuestions ? "attention" : "ok"; }
  }
  if (!cleanupConfirmed) {
    if (job.unattributedPipes) job.answerComplete = ["ok", "attention", "review"].includes(outcome);
    outcome = "failed";
    error = job.threadLocked ? `${[reason, queryError].filter(Boolean).join("; ") || "clean exit"}; thread locked: ${provider}'s output stayed open past ${hooks.pipeWaitMs ?? PIPE_WAIT_MS} ms, held by a process this turn cannot identify`
      : `${[reason, queryError].filter(Boolean).join("; ") || "execution ended"}; cleanup pending: ${provider} or a descendant may still be running`;
  }
  if (outcome === "review") {
    // Coverage and the findings ledger are committed only now: the turn completed with no denial, no workspace change,
    // verified cleanup, and the rendered result is stored. Any failure leaves the admission state (reviewStateBase).
    outcome = "failed";
    let answerText = null;
    try { answerText = io.readFileSync(answerFile, "utf8"); } catch (failure) { if (failure.code !== "ENOENT") error = `answer storage failed: ${failure.message}`; }
    const review = error ? null : turn.finalizeReview ? turn.finalizeReview({ seen, job, answerText, answerFile }) : { error: "no review finalizer" };
    if (review?.error) error = review.error;
    else if (review) {
      try {
        let text = review.text;
        if (text !== undefined && review.incomplete) {
          // An incomplete review still shows what it received (no coverage is granted for it).
          const received = answerText?.trim() ? answerText.trim() : seen?.structured != null ? JSON.stringify(seen.structured, null, 2) : "";
          if (received) text = `${text.trimEnd()}\n\nReceived output (not accepted):\n${received}\n`;
        }
        if (text !== undefined) { io.writeFileSync(answerFile, text); parsed = readAnswer(answerFile); answer = parsed.answer; }
        Object.assign(job, { verdict: review.verdict ?? null, findings: review.findings ?? null, reviewState: review.reviewState ?? job.reviewState, unreviewed: review.unreviewed ?? job.unreviewed });
        if (review.attention) job.reviewAttention = review.attention;
        if (review.incomplete) reviewIncomplete = review.incomplete;
        outcome = job.reviewAttention || (job.unreviewed ?? []).length > 0 || job.reviewState?.synthesisPending || job.reviewState?.pending || job.reviewState?.blocking ? "attention" : "ok";
      } catch (failure) { error = `answer storage failed: ${failure.message}`; }
    }
  }
  if (outcome === "failed" && turn.structuredReview && !parsed?.nonempty && seen?.structured != null) {
    // A failed review keeps the structured output it received as its answer (no coverage is granted for it).
    try { io.writeFileSync(answerFile, `${JSON.stringify(seen.structured, null, 2)}\n`); parsed = readAnswer(answerFile); answer = parsed.answer; } catch { /* the job record keeps it */ }
  }
  Object.assign(job, {
    status: ["ok", "attention"].includes(outcome) ? "done" : outcome, outcome, code: outcome === "ok" ? 0 : outcome === "attention" ? 10 : 1,
    error, cleanupPending: !cleanupConfirmed, endedAt: new Date().toISOString(),
    edited: [...(seen?.edited ?? [])], failedCommands: [...(seen?.failedCommands ?? []), ...(hookOutcome?.failedCommands ?? [])], cost: seen?.costUsd ?? null, usage: seen?.usage ?? null,
    answerClipped: parsed?.answerClipped ?? false, denied: denied.length ? denied : undefined,
    attention: outcome === "attention" ? attentionReason({ denied, incomplete: job.incomplete ?? reviewIncomplete, questions: openQuestions }) : null,
    unconfirmed: seen?.unconfirmed ?? null, ...(outcome === "failed" && seen?.structured ? { structured: seen.structured } : {}),
  });
  delete job.stderrTail;
  try {
    beat();
    await hooks.beforeFinalize?.(job);
    if (["ok", "attention"].includes(job.outcome) && !io.existsSync(answerFile)) io.writeFileSync(answerFile, ""); // a replay finds the body
    // The thread record is written while the claim is held, before completion is published (A7.6).
    if (job.threadId && job.admitted) {
      (hooks.saveThread ?? saveThread)(ctx.home, { provider, threadId: job.threadId, cwd: job.cwd, session: job.session, model: job.model, modelInput: job.modelInput ?? null, effort: job.effort,
        requestedEffort: job.requestedEffort ?? null, tier: job.tier, round: job.round, rounds: job.rounds, roundsSet: job.roundsSet, agent: job.agent ?? null, web: job.web, readOnly: job.readOnly,
        policyVersion: turn.policyVersion ?? null, lastJob: job.id, ...(job.unconfirmed ? { resumable: false, unconfirmed: job.unconfirmed } : {}) });
    }
    save(job); finishMarker(job);
    if (cleanupConfirmed) { releaseClaims(ctx.home, job); released = true; }
  } catch (failure) {
    Object.assign(job, { code: 1, outcome: "failed", status: "failed", cleanupPending: true, attention: null, error: `finalization failed: ${failure.message}` });
    if (!job.done && job.reviewStateBase) job.reviewState = job.reviewStateBase;
    if (!job.done) { try { save(job); finishMarker(job); } catch { /* storage is gone: the heartbeat lapses and recovery reads the job as lost */ } }
  }
  // The usage refusal (exit 2) only once its job is finalized and the claim released; otherwise the storage failure and
  // its recovery handle (the job id, `cancel <job>`) are the result (exit 1).
  if (refusal && released) throw refusal;
  announce();
  return { job: jobView(ctx.home, job), answer };
}

/**
 * The afterTurn a turn deferred because its cleanup was unverified, run by the cancel that confirms cleanup, before that
 * cancel marks the job stopped and releases its claims. Its reservation, the `after-turn` record, carries a state:
 * `running` with the holder's pid and identity (created whole and exclusively: a private file linked into place), then
 * `settled` with the outcome (an atomic rename). Only `settled` lets a cancel mark stopped and release. A cancel that
 * finds `running` under a live holder (checked by a fresh scoped query taken after the read) touches nothing (`{busy}`,
 * exit 20); under a holder that cannot be checked or an
 * unreadable record it touches nothing either (`{blocked}`, exit 1); under a holder proven gone it takes the reservation
 * over and runs the hook again, so afterTurn must tolerate a re-run. A failure before the hook begins is `{blocked}`:
 * the job stays cleanup-pending with its claim and a retry runs it. `request` is null and the result changes no record.
 */
async function deferredAfterTurn(ctx, job, adapter, io, control) {
  if (!job.afterTurnPending || !adapter?.afterTurn) return {};
  const file = path.join(job.dir, "after-turn");
  const me = { state: "running", pid: process.pid, identity: control.self?.() ?? null, startedAt: new Date().toISOString() };
  const retry = `run cancel ${job.id} again`;
  const read = () => { try { return JSON.parse(io.readFileSync(file, "utf8")); } catch (error) { return error.code === "ENOENT" ? null : { state: "unreadable" }; } };
  let reserved = false;
  try {
    const temp = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
    try { io.writeFileSync(temp, JSON.stringify(me), { flag: "wx" }); io.linkSync(temp, file); reserved = true; }
    finally { try { io.rmSync(temp, { force: true }); } catch { /* best effort */ } }
  } catch (error) { if (error.code !== "EEXIST") return { blocked: `afterTurn could not be reserved (${error.message}); cleanup is confirmed but the claim is kept: ${retry}` }; }
  if (!reserved) {
    const record = read();
    if (record?.state === "settled") return record.outcome === "ok" ? {} : { error: record.outcome };
    if (record?.state !== "running") return { blocked: `job ${job.id}'s deferred afterTurn record is unreadable; the claim is kept` };
    // The holder is checked by a query taken after the record was read (S2.11): a table from before the read may predate
    // the holder. Not found in that fresh query is gone; a failed query is unknown.
    let fresh;
    try { fresh = control.scoped ? control.scoped(record.pid) : control.snapshot(); } catch { fresh = { state: "unknown", rows: [] }; }
    const holder = companionState({ companionPid: record.pid, companionIdentity: record.identity }, fresh);
    if (holder === "live") return { busy: `another cancel (pid ${record.pid}) is running job ${job.id}'s deferred afterTurn; nothing was released: ${retry} after it settles` };
    if (holder !== "gone") return { blocked: `the holder of job ${job.id}'s deferred afterTurn (pid ${record.pid}) cannot be checked; the claim is kept: ${retry}` };
    try { writeFileAtomic(file, JSON.stringify(me)); } catch (error) { return { blocked: `afterTurn could not be taken over (${error.message}); the claim is kept: ${retry}` }; }
    const now = read();
    if (now?.pid !== me.pid || now?.startedAt !== me.startedAt) return { busy: `another cancel took over job ${job.id}'s deferred afterTurn; nothing was released: ${retry} after it settles` };
  }
  let outcome = "ok";
  try { await adapter.afterTurn({ job, request: null, cwd: job.cwd, env: ctx.env }, { ...job.afterTurnPending, cleanupConfirmed: true, deferred: true }); }
  catch (error) { outcome = `afterTurn failed: ${error.message}`; }
  try { writeFileAtomic(file, JSON.stringify({ state: "settled", outcome, settledAt: new Date().toISOString() })); }
  catch (error) { return { blocked: `afterTurn ran but its settlement could not be stored (${error.message}); the claim is kept: ${retry}` }; }
  return outcome === "ok" ? {} : { error: outcome };
}

/**
 * Explicit recovery (A7.5, A7.8). No metadata writes, no age-based reclamation, no kill of a live companion.
 * `confirmEnded` releases a held-output lock only after the process table shows no owned process and refuses (exit 10)
 * while the owner companion or an identified child is live or the query failed.
 */
export async function cancelManaged(ctx, job, { timeoutMs = 30000, control = executionController(), io = fs, confirmEnded = false, adapter = null } = {}) {
  const view = () => jobView(ctx.home, loadJob(ctx.home, job.id) ?? job);
  if (job.done && !cleanupNeeded(job) && !claimHeld(ctx.home, job)) return { status: label(job), code: 0, job };
  io.writeFileSync(path.join(job.dir, "cancel"), "");
  const end = Date.now() + timeoutMs;
  let unsureSince = 0;
  for (;;) {
    job = loadJob(ctx.home, job.id);
    if (!job) return { status: "unknown", code: 1, error: "job record cannot be read" };
    if ((job.done || job.stopped) && !cleanupNeeded(job) && !claimHeld(ctx.home, job)) return { status: label(job), code: 0, job: view() };
    let snapshot, unsure = null;
    try { snapshot = control.snapshot(); }
    catch (e) { snapshot = { state: "unknown", rows: [], error: `process query failed: ${e.message}` }; }
    const owner = companionState(job, snapshot);
    if (owner === "gone") {
      let found;
      try { found = control.inspect(job, snapshot); }
      catch (e) { return { status: "unknown", code: 1, job: view(), error: e.message }; }
      if (found.state === "unknown") unsure = "execution ownership/cleanup cannot be confirmed; claim and cancellation request retained";
      else if (found.state === "gone") {
        if (job.unattributedPipes && !confirmEnded) return { status: "unknown", code: 1, job: view(), error: `an unidentified process held job ${job.id}'s output; the thread stays locked until cancel ${job.id} --confirm-ended after checking the process table` };
        const hook = await deferredAfterTurn(ctx, job, adapter, io, control);
        if (hook.busy) return { status: "running", code: 20, job: view(), error: hook.busy };
        if (hook.blocked) return { status: "unknown", code: 1, job: view(), error: hook.blocked };
        markStopped(job);
        releaseClaims(ctx.home, job);
        const current = view();
        return { status: current.claimHeld ? "unknown" : label(job), code: current.claimHeld ? 1 : 0, job: current, ...(confirmEnded ? { released: true } : {}), ...(hook.error ? { error: hook.error } : {}) };
      } else {
        if (confirmEnded) return { status: "refused", code: 10, job: view(), error: `--confirm-ended refused: ${found.rows.length} owned process${found.rows.length > 1 ? "es are" : " is"} still live (pid ${found.rows.map((r) => r.pid).join(", ")})` };
        try { recordRecoveryEvidence(job, found.rows); }
        catch (e) { return { status: "unknown", code: 1, job: view(), error: `cannot save cleanup evidence: ${e.message}` }; }
        for (const row of found.rows) {
          if (Date.now() >= end) break;
          try { control.stop(row); } catch { /* Must be confirmed by a later snapshot. */ }
        }
      }
    } else if (owner === "unknown") {
      if (confirmEnded) return { status: "refused", code: 10, job: view(), error: `--confirm-ended refused: ${snapshot.error ?? "the process table could not be read"}; nothing released` };
      unsure = `${snapshot.error ?? "original companion identity cannot be confirmed"}; no claim released`;
    } else if (confirmEnded) {
      return { status: "refused", code: 10, job: view(), error: `--confirm-ended refused: the owner companion (pid ${job.companionPid}) is still live` };
    }
    if (!unsure) unsureSince = 0;
    else if (Date.now() - (unsureSince ||= Date.now()) >= UNSURE_MS || Date.now() >= end) return { status: "unknown", code: 1, job: view(), error: unsure };
    if (Date.now() >= end) return { status: "not-stopped", code: 1, job: view(), error: "shutdown not confirmed; claim and cancellation request retained; run cancel again" };
    await sleep(100);
  }
}
