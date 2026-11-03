#!/usr/bin/env node
// Council for Codex: the companion entry (S2.6, reordered in S2.8). One process per provider call, in the A4 order:
// parse → guards → request-id reservation or replay → load adapter → bind → preflight → prepare → tombstone → turn → print.
// Ported from grok_plugin_for_codex 1.1.0 grok.mjs (request keys, replay, thread resolution, inheritance, wait/cancel
// dispatch). Provider modules live in ./lib/providers/<p>.mjs and are imported only when a turn needs them; `wait` loads
// none, and `cancel` loads the recorded provider's module for `ownsProcess` only.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { UsageError, USAGE, parseArgv, seconds } from "./lib/core/args.mjs";
import { readText } from "./lib/core/stdin.mjs";
import { canonical } from "./lib/core/fs.mjs";
import { PROVIDERS, hostSession } from "./lib/core/host.mjs";
import { StateError, assertStateOutsideWorkspace, candidates, claimHeld, cleanupNeeded, findJob, homeDir, jobView, lastEvent, loadJob, lookupRequest, releaseRequest, requestFingerprint, requestJobId, requestKey, resultRecord, stateOf, claimRequest, bindRequest } from "./lib/core/jobs.mjs";
import { depthGuard, executionController, companionState, processSnapshot } from "./lib/core/execution.mjs";
import { runManagedTurn, cancelManaged } from "./lib/core/lifecycle.mjs";
import { elapsed, elapsedOf, readAnswer, renderResult, resultJson, startLine } from "./lib/core/output.mjs";
import { PreflightBlocked, runPreflight, runDescriptor, stateRootDescriptor } from "./lib/core/preflight.mjs";

import { PLUGIN_ROOT, DEFAULT_ROUNDS, INACTIVITY_S, DEADLINE_S, WAIT_S, CANCEL_S } from "./lib/cli/config.mjs";
import { loadAdapter, requireAdapter, checkFlags, latestOf, resolveThread, planTurn } from "./lib/cli/plan.mjs";
import { createCatalogCommands } from "./lib/cli/catalog.mjs";
export { PLUGIN_ROOT, DEFAULT_ROUNDS, INACTIVITY_S, DEADLINE_S, WAIT_S, CANCEL_S, loadAdapter };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const writer = (stream) => (text) => stream.write(text);

/** Prints a finished job (a replay, `wait`); the start line is not repeated. */
function printFinished(ctx, o, job, out) {
  let record = resultRecord(job), answer = "";
  try { const parsed = readAnswer(path.join(job.dir, "answer.md")); answer = parsed.answer; record = { ...record, answerClipped: parsed.answerClipped }; }
  catch (error) {
    // A finished ok or attention result without its body is not a success (the whole body pruned reads `result expired`).
    if ([0, 10].includes(record.code)) record = { ...record, code: 1, outcome: "failed", status: "failed", error: error.code === "ENOENT" ? "stored answer missing: the result body is incomplete" : `stored answer unreadable: ${error.message}` };
  }
  record = jobView(ctx.home, record);
  out(o.json ? `${JSON.stringify(resultJson(record, answer))}\n` : renderResult(record, answer));
  return record.code;
}
/** Waits for a job to leave `running`; returns 20 with the last event when the timeout passes first (A3.2 `wait`). */
async function awaitJob(ctx, o, id, timeoutMs, out) {
  for (const end = Date.now() + timeoutMs; ; await sleep(100)) {
    const job = loadJob(ctx.home, id);
    if (!job) { out(o.json ? `${JSON.stringify({ status: "expired", exit: 1, job: id, error: "result expired" })}\n` : `result expired · job ${id}\n`); return 1; }
    if (stateOf(job) !== "running") return printFinished(ctx, o, job, out);
    if (Date.now() >= end) {
      const data = { provider: job.provider, job: job.id, status: "running", exit: 20, thread: job.threadId ?? job.requestedThreadId ?? null, elapsedMs: elapsedOf(job), lastEvent: lastEvent(job) };
      out(o.json ? `${JSON.stringify(data)}\n` : `still running · ${job.provider} · job ${job.id} · ${elapsed(data.elapsedMs)} · last event: ${data.lastEvent ?? "none yet"}\n`);
      return 20;
    }
  }
}

/**
 * Replays a request id (A7.4) before any selector, catalog, adapter or preflight runs; starts no provider process. The
 * first call may not have bound its provider yet. A reservation whose call is gone with nothing prepared is released
 * (nothing ran); changed input exits 2.
 */
async function replay(ctx, o, record, fingerprint, out, deps) {
  if (record.fingerprint !== fingerprint) throw new UsageError(`request id ${o["request-id"]} was already used with different input; use a new request id`);
  const end = Date.now() + seconds(o.deadline, DEADLINE_S, "deadline") * 1000;
  for (let checkedAt = 0; !(record.job && loadJob(ctx.home, record.job)); await sleep(50)) {
    if (record.state === "tombstone") break; // prepared, then pruned: the result has expired
    const current = lookupRequest(ctx.home, record.key);
    if (!current) throw new UsageError(`request id ${o["request-id"]}: its first call failed before preparing and freed the id; retry with the same id to run it`);
    if (current.fingerprint !== fingerprint) throw new UsageError(`request id ${o["request-id"]} was already used with different input; use a new request id`);
    record = current;
    if (current.state === "tombstone") continue;
    if (Date.now() - checkedAt >= 1000) {
      checkedAt = Date.now();
      let snapshot;
      try { snapshot = (deps.snapshot ?? processSnapshot)({ platform: deps.platform ?? process.platform, pid: current.companionPid }); } catch { snapshot = { state: "unknown", rows: [] }; }
      if (companionState(current, snapshot) === "gone" && !(current.job && loadJob(ctx.home, current.job))) {
        await requireWritableRoot(ctx); // the release removes the record: a read-only root is the state-root line, not EACCES
        if (releaseRequest(ctx.home, current.key, current.job, current.recordToken) === false) { record = lookupRequest(ctx.home, current.key) ?? current; continue; }
        throw new UsageError(`request id ${o["request-id"]} names ${current.job ? `job ${current.job}` : "a call"} that ended before it prepared; nothing ran, so the same request id can run again`);
      }
    }
    if (Date.now() >= end) {
      out(o.json ? `${JSON.stringify({ status: "preparing", exit: 20, job: record.job, provider: record.provider })}\n`
        : `still preparing · ${record.provider ?? "provider not resolved yet"} · job ${record.job ?? "not bound yet"} · the first call with this request id has not started yet; retry with the same request id to keep waiting\n`);
      return 20;
    }
  }
  return awaitJob(ctx, o, record.job, Math.max(1, end - Date.now()), out);
}

/** The provider of a turn (--to, or the job or thread record on reply and task --thread), with its flag scoping (A3.3). */
function resolveProvider(ctx, verb, o, memo = {}) {
  let provider = o.to;
  if (verb === "reply" || (verb === "task" && (o.thread || o.last))) {
    const thread = resolveThread(ctx, verb, o);
    memo.resolvedThread = thread;
    if (o.to && o.to !== thread.provider) throw new UsageError(`the thread belongs to ${thread.provider}; --to ${o.to} conflicts with it`);
    provider = thread.provider;
  } else if (!provider) throw new UsageError(`${verb} needs --to ${PROVIDERS.join("|")}`);
  checkFlags(verb, o, provider);
  if (o["allow-command"] && verb !== "task") throw new UsageError("--allow-command applies only to task");
  return provider;
}
/** Control verbs that write (models --refresh, setup --set, cancel): the same state-root line before the first write. */
async function requireWritableRoot(ctx) {
  const root = stateRootDescriptor(ctx.home);
  const writable = await runDescriptor(root, { env: ctx.env, platform: ctx.platform });
  if (!writable.ok) throw new PreflightBlocked(root, writable.detail);
}

/**
 * ask, reply, review, task. A request id is reserved first, provider-neutral (A7.4); the reservation is bound to the
 * provider and job once resolved, then preflight → prepare → tombstone → run. Any failure before the tombstone frees it.
 */
async function runTurnVerb(ctx, parsed, text, io, deps) {
  const { verb, options: o } = parsed;
  checkFlags(verb, o);
  const timers = { inactivityMs: seconds(o["inactivity-timeout"], INACTIVITY_S, "inactivity-timeout") * 1000, deadlineMs: seconds(o.deadline, DEADLINE_S, "deadline") * 1000 };
  // (3) The request id before anything else: a recorded request replays (read-only, A7.4), whatever the sandbox allows.
  const fingerprint = requestFingerprint(verb, o, text);
  const key = o["request-id"] !== undefined ? requestKey(ctx.session, ctx.cwd, o["request-id"]) : null;
  if (key) {
    const recorded = lookupRequest(ctx.home, key);
    if (recorded) return replay(ctx, o, recorded, fingerprint, writer(io.stdout), deps);
  }
  // The state root must be writable before the first write (the reservation, the job, claims, the preflight cache): a
  // sandbox that blocks it (Codex workspace-write, S1.4) is preflight_blocked with the state-root action line, never a
  // raw EACCES/EPERM. Invalid input still wins: the call is validated read-only first, so its exit 2 stands.
  const root = stateRootDescriptor(ctx.home);
  const writable = await runDescriptor(root, { env: ctx.env, platform: ctx.platform });
  if (!writable.ok) {
    try {
      const provider = resolveProvider(ctx, verb, o);
      const adapter = await requireAdapter(provider, ctx.env);
      planTurn(ctx, adapter, verb, o, text, {}).prepare(null); // checkRequest and settings, nothing written
    } catch (error) { if (error instanceof UsageError) throw error; }
    throw new PreflightBlocked(root, writable.detail);
  }
  let requestToken = null;
  if (key) {
    const claimed = claimRequest(ctx.home, { key, requestId: o["request-id"], session: ctx.session, cwd: ctx.cwd, fingerprint,
      companionIdentity: executionController({ platform: deps.platform }).self() });
    if (!claimed.fresh) return replay(ctx, o, claimed.record, fingerprint, writer(io.stdout), deps);
    requestToken = claimed.record.recordToken;
  }
  let jobId = null;
  const unprepared = () => {
    if (!key) return;
    try { if (lookupRequest(ctx.home, key)?.state !== "tombstone") releaseRequest(ctx.home, key, jobId, requestToken); } catch { /* an unreadable record stays: never reused */ }
  };
  const out = writer(io.stdout), err = writer(io.stderr);
  let result;
  try {
    // (4) Provider: --to, or the job or thread record on reply and task --thread.
    const memo = {};
    const provider = resolveProvider(ctx, verb, o, memo);
    const adapter = await requireAdapter(provider, ctx.env);
    if (key) { jobId = requestJobId(provider, ctx.session, ctx.cwd, o["request-id"]); bindRequest(ctx.home, key, { provider, jobId, recordToken: requestToken }); }
    // (5) Preflight through the cached runner: a blocked resource exits 1 with zero submissions.
    const plan = planTurn(ctx, adapter, verb, o, text, memo);
    const descriptors = adapter.preflight ? adapter.preflight({ stateRoot: ctx.home, env: ctx.env, platform: deps.platform ?? process.platform, verb, cwd: plan.cwd }) : [];
    await runPreflight({ home: ctx.home, provider, launcher: plan.launcher, descriptors, env: ctx.env, platform: deps.platform ?? process.platform });
    // (6) Prepare (tier, model, effort, review collection, checkRequest), then the managed turn: it re-prepares after
    // admission, writes the prompt and review input, tombstones the request id and runs.
    const initial = plan.prepare(null);
    result = await runManagedTurn(ctx, adapter, { ...initial, thread: initial.thread }, (id) => plan.prepare(id),
      { jobId: jobId ?? undefined, requestKey: key, requestToken, requestId: o["request-id"] ?? null, json: o.json, ...timers }, { announce: (job) => err(`${startLine(job)}\n`), ...(deps.hooks ?? {}) });
  } catch (error) {
    unprepared(); // nothing prepared: a retry may run
    throw error;
  }
  if (!result.job.admitted) unprepared(); // refused before preparing (a busy thread): nothing ran, the id may run again
  out(o.json ? `${JSON.stringify(resultJson(result.job, result.answer))}\n` : renderResult(result.job, result.answer));
  return result.job.code;
}

/** wait [job] [--timeout s]: list this session's jobs, or await one; loads no adapter and starts nothing. */
async function waitVerb(ctx, { options: o }, io) {
  checkFlags("wait", o);
  const out = writer(io.stdout);
  const timeoutMs = seconds(o.timeout, WAIT_S, "timeout") * 1000;
  if (!o.job) {
    const rows = candidates(ctx.home, ctx).slice(0, 10).map((j) => ({ provider: j.provider, job: j.id,
      state: stateOf(j) === "done" && j.outcome === "attention" ? "needs attention" : stateOf(j), thread: j.threadId ?? null, elapsedMs: elapsedOf(j), lastEvent: lastEvent(j),
      cleanupPending: (cleanupNeeded(j) && stateOf(j) !== "running") || (claimHeld(ctx.home, j) && j.done) }));
    out(o.json ? `${JSON.stringify(rows)}\n` : rows.length ? `${rows.map((r) => `${r.job} · ${r.provider} · ${r.state} · ${r.thread ?? "-"} · ${elapsed(r.elapsedMs)} · ${r.lastEvent ?? "-"}${r.cleanupPending ? " · cleanup pending" : ""}`).join("\n")}\n`
      : "no council jobs in this workspace and Codex thread\n");
    return 0;
  }
  const job = findJob(ctx.home, o.job, o.to ?? null);
  if (!job) throw new UsageError(`no job or thread ${o.job}`);
  return awaitJob(ctx, o, job.id, timeoutMs, out);
}

/**
 * cancel [job] [--confirm-ended]: stop a job and confirm cleanup (A7.5). Loads the recorded provider's module for
 * `ownsProcess` only, bypassing preflight, probes and buildTurn; starts no provider process.
 */
async function cancelVerb(ctx, { options: o }, io, deps) {
  checkFlags("cancel", o);
  const out = writer(io.stdout);
  const timeoutMs = seconds(o.timeout, CANCEL_S, "timeout") * 1000;
  const job = o.job ? findJob(ctx.home, o.job, o.to ?? null) : latestOf(candidates(ctx.home, ctx).filter((j) => cleanupNeeded(j) || claimHeld(ctx.home, j)), "cancel is ambiguous");
  if (o.job && !job) throw new UsageError(`no job or thread ${o.job}; an unidentified claim requires quiescent manual recovery`);
  if (!job) { out(o.json ? '{"status":"none","exit":0}\n' : "no running council job to cancel\n"); return 0; }
  await requireWritableRoot(ctx); // the cancel marker, the stop record and the claim release are written there
  // Without the provider module there is no ownership evidence: the scan reads unknown, so nothing is stopped or released.
  let adapter = null, loadError = null;
  try { adapter = await loadAdapter(job.provider, ctx.env); } catch (error) { loadError = error.message; }
  const control = executionController({ adapter, platform: deps.platform, ...(deps.snapshot ? { snapshot: deps.snapshot } : {}), ...(deps.powershell ? { powershell: deps.powershell } : {}) });
  const result = await cancelManaged(ctx, job, { timeoutMs, control, confirmEnded: Boolean(o["confirm-ended"]), adapter });
  if (!adapter && result.code !== 0) {
    result.error = `${result.error ?? "cleanup not confirmed"}; provider ${job.provider}'s module ${loadError ? `failed to load (${loadError})` : "is not available in this build"}, so job ${job.id}'s processes cannot be identified and nothing was stopped or released: restore it, then run cancel ${job.id} again`;
  }
  const data = { provider: job.provider, job: job.id, status: result.status, exit: result.code, thread: result.job?.threadId ?? null, cleanupPending: result.code !== 0, released: Boolean(result.released), error: result.error ?? null };
  out(o.json ? `${JSON.stringify(data)}\n` : `${result.status} · ${job.provider} · job ${job.id}${result.error ? ` · ${result.error}` : ""}${result.code === 0 && result.job?.threadId ? " · the thread stays resumable" : ""}\n`);
  return result.code;
}

const CONTROL = { wait: waitVerb, cancel: cancelVerb, ...createCatalogCommands({ runTurnVerb, requireWritableRoot }) };

/**
 * Entry: returns the exit code. `io` carries stdout, stderr and stdin; `deps` are test seams for the process query
 * (platform, snapshot, powershell) and lifecycle hooks; production passes none.
 */
export async function main(argv, env = process.env, io = { stdout: process.stdout, stderr: process.stderr, stdin: process.stdin }, deps = {}) {
  let parsed;
  const json = argv.includes("--json");
  try {
    // (1) Parse argv, honour --cwd.
    parsed = parseArgv(argv);
    if (parsed.verb === "help" || parsed.options.help) { io.stdout.write(`${USAGE}\n`); return 0; }
    const cwd = canonical(path.resolve(parsed.options.cwd ?? deps.cwd ?? process.cwd()));
    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new UsageError(`--cwd ${parsed.options.cwd} is not a directory`);
    // (2) Guards: no nested call, state outside the workspace.
    const nested = depthGuard(env);
    if (nested) throw new StateError(nested);
    const home = homeDir(env, { create: false });
    assertStateOutsideWorkspace(home, cwd);
    assertStateOutsideWorkspace(home, PLUGIN_ROOT);
    const ctx = { env, home, cwd, session: hostSession(env), platform: deps.platform ?? process.platform };
    const text = await readText(parsed, { stream: io.stdin, env }); // control verbs, bare review and --next-input read no stdin
    if (CONTROL[parsed.verb]) {
      if (parsed.positionals.length) throw new UsageError(`${parsed.verb} takes no text`);
      return await CONTROL[parsed.verb](ctx, parsed, io, deps);
    }
    return await runTurnVerb(ctx, parsed, text, io, deps);
  } catch (error) {
    const code = error instanceof UsageError ? 2 : 1;
    if (error instanceof PreflightBlocked) {
      if (json) io.stdout.write(`${JSON.stringify({ status: "preflight_blocked", exit: 1, error: error.message, action: error.action })}\n`);
      else io.stderr.write(`council: ${error.message}\naction: ${error.action}\n`);
      return 1;
    }
    if (json) io.stdout.write(`${JSON.stringify({ status: "failed", exit: code, error: error.message })}\n`);
    else io.stderr.write(`council: ${error.message}${code === 2 && !/usage:/.test(error.message) && /unknown verb|Unknown option/.test(error.message) ? `\n${USAGE}` : ""}\n`);
    return code;
  }
}

// Real paths: a symlinked install or temp directory must not silently skip main().
const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) {
  process.stdout.on("error", () => {}); // A departed caller must not bypass durable finalization.
  process.stderr.on("error", () => {});
  main(process.argv.slice(2), process.env).then((code) => { process.exitCode = code; }, (error) => {
    process.stderr.write(`council: ${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
