// Turn lifecycle (S2.4): `runManagedTurn(ctx, adapter, initial, prepare, options, hooks)` and `cancelManaged`, ported from
// grok_plugin_for_codex 1.1.0 lib/lifecycle.mjs with codex-plugin-cc 2.3.2's 12 s PIPE_WAIT_MS, unattributed-pipe handling
// and `thread locked`, and claude_plugin_for_codex 0.5.0 process.mjs's held-output lock. One writer owns the job from
// admission through finalization; the adapter's beforeTurn/afterTurn run once each, afterTurn after verified cleanup.
// The stop path snapshots owned descendants, SIGTERMs the child's group, then SIGKILLs (taskkill /T /F on Windows).
import fs from "node:fs";
import path from "node:path";
import { BusyError, claimThread, claimHeld, releaseClaims } from "./claims.mjs";
import { createJob, saveJob, markDone, markStopped, loadJob, cleanupNeeded, jobView, markRequestPrepared, saveThread } from "./jobs.mjs";
import { BEAT_MS, refreshBeat } from "./heartbeat.mjs";
import { executionController, companionState, recordRecoveryEvidence, QUERY_MS } from "./execution.mjs";
import { spawnChild } from "./launcher.mjs";
import { createReader } from "./reader.mjs";
import { readAnswer } from "./output.mjs";

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
  let afterTurnDone = false, hookOutcome = null;
  const announce = () => { if (!announced && !options.json) { announced = true; hooks.announce?.(job); } };
  const claim = (id) => {
    if (!id) return;
    try { claimThread(ctx.home, provider, id, job, hooks.claimIo); }
    catch (error) {
      if (error.claimLeft) { job.threadIds = [...new Set([...job.threadIds, id])]; try { save(job); } catch { /* finalization saves again */ } }
      const holder = error instanceof BusyError && error.job ? loadJob(ctx.home, error.job) : null;
      if (holder?.done && holder.unattributedPipes && !holder.stopped) error.message = `thread ${id} is locked by job ${error.job}, whose output an unidentified process kept open; cancel ${error.job} --confirm-ended after checking the process table, or continue with a new ask`;
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
      tier: turn.tier ?? job.tier, model: turn.model ?? job.model, effort: turn.effort ?? job.effort, requestedEffort: turn.requestedEffort ?? job.requestedEffort,
      modelVerified: turn.modelVerified !== false, web: Boolean(turn.web), cwd: turn.cwd ?? job.cwd, agent: built.agent ?? null, readOnly: built.readOnly !== false,
      target: turn.target ?? null, unreviewed: turn.unreviewed ?? [], admitted: true, admittedAt: new Date().toISOString(),
      reviewState: turn.reviewState ?? null, reviewStateBase: turn.reviewState ?? null, nextInput: Boolean(turn.nextInput), batch: turn.batch ?? null,
      round: turn.round ?? 0, rounds: turn.rounds ?? job.rounds, roundsSet: Boolean(turn.roundsSet),
      childArgs: built.args, promptFile: built.promptFile ?? null, answerFile: built.answerFile ?? null,
      argv: [turn.launcher.command, ...turn.launcher.args, ...built.args],
    });
    if (built.promptFile) io.writeFileSync(built.promptFile, built.stdin ?? turn.prompt ?? "");
    if (turn.reviewFiles) {
      const root = path.join(job.dir, "review-input");
      io.mkdirSync(root, { recursive: true });
      io.writeFileSync(path.join(root, "review.diff"), turn.reviewFiles.diff);
      io.writeFileSync(path.join(root, "index.json"), JSON.stringify(turn.reviewFiles.snapshot.index));
      io.writeFileSync(path.join(root, "review.data"), turn.reviewFiles.snapshot.data);
    }
    save(job);
    if (options.requestKey) markRequestPrepared(ctx.home, options.requestKey); // Preparation complete: the reservation is a tombstone.
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
      const structured = Boolean(turn.structuredReview);
      const onText = (text) => {
        if (persistenceFailed || built.answerFile || structured) return;
        try { io.appendFileSync(answerFile, text); }
        catch (error) { persistenceFailed = true; stop(`answer storage failed: ${error.message}`); }
      };
      reader = createReader(adapter, {
        cwd: job.cwd, expectedThreadId: turn.thread ?? built.requestedThreadId ?? null, onText,
        onFailure: (message) => { streamFailure = message; stop(message); },
        onThread: (id) => {
          // A discovered id is claimed before it is published; a collision fails the turn.
          if (job.threadIds.includes(id)) { job.threadId = id; save(job); announce(); return; }
          try { claim(id); job.threadId = id; save(job); announce(); }
          catch (error) { streamFailure = error.message; stop(error.message); }
        },
      });
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
          if (now - beatAt >= BEAT_MS) {
            if (refreshBeat(job, io)) beatAt = now;
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
  }

  const seen = reader?.state;
  if (seen?.threadId && !seen.failed) job.threadId = seen.threadId;
  await afterTurn({ cleanupConfirmed, reason, completed: Boolean(seen?.completed), denials: seen?.denials ?? [] });
  if (hookOutcome?.edited) for (const p of hookOutcome.edited) seen?.edited.add(p);
  let parsed = null;
  try { parsed = readAnswer(answerFile); answer = parsed.answer; }
  catch (error) { if (error.code !== "ENOENT") reason ??= `answer storage failed: ${error.message}`; }
  let outcome = "failed", error = reason;
  const denied = seen?.denials?.length ? seen.denials : [];
  const incomplete = hookOutcome?.incomplete ?? seen?.incomplete ?? null;
  if (reason === "cancelled") outcome = "cancelled";
  else if (!error && persistenceFailed) error = "job storage failed";
  else if (!error && spawnError) error = `could not start ${provider}: ${spawnError.message}`;
  else if (!error && (streamFailure || seen?.failed)) error = streamFailure ?? seen.failed;
  else if (!error && !seen?.completed) error = job.stderrTail?.trim().split(/\r?\n/).at(-1) || `${provider} ended without completing the turn`;
  else if (!error && child?.exitCode !== 0) error = `${provider} exited with code ${child?.exitCode}`;
  if (!error && outcome === "failed" && turn.structuredReview && turn.finalizeReview) {
    const review = turn.finalizeReview({ seen, job, answerFile, io });
    if (review.error) error = review.error;
    else {
      Object.assign(job, { verdict: review.verdict ?? null, findings: review.findings ?? null, reviewState: review.reviewState ?? job.reviewState, unreviewed: review.unreviewed ?? job.unreviewed });
      if (review.text !== undefined) { try { io.writeFileSync(answerFile, review.text); parsed = readAnswer(answerFile); answer = parsed.answer; } catch (failure) { error = `answer storage failed: ${failure.message}`; } }
      if (review.attention) job.reviewAttention = review.attention;
    }
  } else if (!error && outcome === "failed" && turn.finalizeTurn) {
    try { Object.assign(job, turn.finalizeTurn({ seen, job }) ?? {}); } catch (failure) { error = failure.message; }
  }
  if (!error && outcome === "failed") {
    if (!parsed?.nonempty && !turn.structuredReview) error = `${provider} returned no answer`;
    else if (denied.length) { outcome = "attention"; job.denied = denied; }
    else if (incomplete) { outcome = "attention"; job.incomplete = incomplete; }
    else if (turn.structuredReview) outcome = job.reviewAttention || (job.unreviewed ?? []).length > 0 || job.reviewState?.synthesisPending || job.reviewState?.pending || job.reviewState?.blocking ? "attention" : "ok";
    else outcome = parsed.questions ? "attention" : "ok";
  }
  if (!cleanupConfirmed) {
    if (job.unattributedPipes) job.answerComplete = ["ok", "attention"].includes(outcome);
    outcome = "failed";
    error = job.threadLocked ? `${[reason, queryError].filter(Boolean).join("; ") || "clean exit"}; thread locked: ${provider}'s output stayed open past ${hooks.pipeWaitMs ?? PIPE_WAIT_MS} ms, held by a process this turn cannot identify`
      : `${[reason, queryError].filter(Boolean).join("; ") || "execution ended"}; cleanup pending: ${provider} or a descendant may still be running`;
  }
  Object.assign(job, {
    status: ["ok", "attention"].includes(outcome) ? "done" : outcome, outcome, code: outcome === "ok" ? 0 : outcome === "attention" ? 10 : 1,
    error, cleanupPending: !cleanupConfirmed, endedAt: new Date().toISOString(),
    edited: [...(seen?.edited ?? [])], failedCommands: [...(seen?.failedCommands ?? []), ...(hookOutcome?.failedCommands ?? [])], cost: seen?.costUsd ?? null, usage: seen?.usage ?? null,
    answerClipped: parsed?.answerClipped ?? false, denied: denied.length ? denied : undefined,
  });
  delete job.stderrTail;
  try {
    beat();
    await hooks.beforeFinalize?.(job);
    save(job); finishMarker(job);
    if (cleanupConfirmed) releaseClaims(ctx.home, job);
    if (job.threadId && job.admitted) {
      saveThread(ctx.home, { provider, threadId: job.threadId, cwd: job.cwd, session: job.session, model: job.model, effort: job.effort, tier: job.tier,
        round: job.round, rounds: job.rounds, roundsSet: job.roundsSet, agent: job.agent ?? null, web: job.web, readOnly: job.readOnly, policyVersion: turn.policyVersion ?? null, lastJob: job.id });
    }
  } catch (failure) {
    job.code = 1; job.outcome = "failed"; job.cleanupPending = true;
    if (!job.done && job.reviewStateBase) job.reviewState = job.reviewStateBase;
    job.error = `finalization failed: ${failure.message}`;
  }
  announce();
  return { job: jobView(ctx.home, job), answer };
}

/**
 * Explicit recovery (A7.5, A7.8). No metadata writes, no age-based reclamation, no kill of a live companion.
 * `confirmEnded` releases a held-output lock only after the process table shows no owned process and refuses (exit 10)
 * while the owner companion or an identified child is live or the query failed.
 */
export async function cancelManaged(ctx, job, { timeoutMs = 30000, control = executionController(), io = fs, confirmEnded = false } = {}) {
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
        markStopped(job);
        releaseClaims(ctx.home, job);
        const current = view();
        return { status: current.claimHeld ? "unknown" : label(job), code: current.claimHeld ? 1 : 0, job: current, ...(confirmEnded ? { released: true } : {}) };
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
