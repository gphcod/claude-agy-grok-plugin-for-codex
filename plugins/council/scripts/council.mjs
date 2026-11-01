#!/usr/bin/env node
// Council for Codex: the companion entry (S2.6). One process per provider call, in the A4 order:
// parse → guards → request-id replay → load adapter → resolve tier, model, effort → preflight → admit → turn → print.
// Ported from grok_plugin_for_codex 1.1.0 grok.mjs (request keys, replay, thread resolution, inheritance, wait/cancel
// dispatch). Provider modules live in ./lib/providers/<p>.mjs and are imported only when a turn needs them; `wait` loads
// none, and `cancel` loads the recorded provider's module for `ownsProcess` only.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL, fileURLToPath } from "node:url";
import { UsageError, USAGE, TURN_VERBS, parseArgv, positiveInt, seconds } from "./lib/core/args.mjs";
import { readText } from "./lib/core/stdin.mjs";
import { canonical, readJson } from "./lib/core/fs.mjs";
import { BINARIES, PROVIDERS, ROUNDS_ENV, hostSession, depthEnv } from "./lib/core/host.mjs";
import { StateError, assertStateOutsideWorkspace, candidates, claimHeld, cleanupNeeded, findJob, homeDir, jobView, lastEvent, latestOnThread, listJobs, loadJob,
  loadThread, lookupRequest, onThread, providersOf, releaseRequest, requestFingerprint, requestJobId, requestKey, resultRecord, stateOf, threadProviders,
  claimRequest } from "./lib/core/jobs.mjs";
import { depthGuard, executionController, companionState, processSnapshot } from "./lib/core/execution.mjs";
import { runManagedTurn, cancelManaged } from "./lib/core/lifecycle.mjs";
import { elapsed, elapsedOf, readAnswer, renderResult, resultJson, startLine } from "./lib/core/output.mjs";
import { PreflightBlocked, runPreflight, getPolicy, setPolicy } from "./lib/core/preflight.mjs";
import { LauncherError, resolveLauncher } from "./lib/core/launcher.mjs";
import { loadCatalog, loadStatic, resolveEffort, resolveModel, saveRefreshedCatalog } from "./lib/core/catalog.mjs";
import { loadTiers, resolveTier } from "./lib/core/tiers.mjs";
import { buildBatchReviewPrompt, collectReview, continueReviewTurn, finalizeReviewTurn, loadTemplate, startReviewTurn } from "./lib/core/review.mjs";

export const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA_PATH = path.join(PLUGIN_ROOT, "schemas", "review-output.schema.json");
/** The reply budget a thread uses until `--rounds` sets one; COUNCIL_CODEX_ROUNDS changes it (A3.5). */
export const DEFAULT_ROUNDS = 9;
/** Seconds without an event, and in total, before a turn is stopped (A3.3 timing defaults, from GROKX). */
export const INACTIVITY_S = 1200;
export const DEADLINE_S = 14400;
export const WAIT_S = 90;
export const CANCEL_S = 30;
/** Provider-scoped and verb-scoped flags (A3.3): anything else with them exits 2. */
const VERB_FLAGS = { "next-input": ["reply"], base: ["review"], commit: ["review"], uncommitted: ["review"], adversarial: ["review"], refresh: ["models"], live: ["setup"],
  set: ["setup"], "confirm-ended": ["cancel"], last: ["reply"], thread: ["reply", "task"], timeout: ["wait", "cancel"], "allow-command": ["task"] };
const PROVIDER_FLAGS = { "max-turns": ["claude"], "max-budget-usd": ["claude"], "allow-command": ["gemini"] };
const TEST_ADAPTER = "null";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const writer = (stream) => (text) => stream.write(text);

/** The provider module, or null when this build has none (S2.6: `provider <p> not available in this build`). */
export async function loadAdapter(provider, env = process.env) {
  if (provider === TEST_ADAPTER) {
    if (env.COUNCIL_TEST_NULL_ADAPTER !== "1") return null;
    const file = path.join(PLUGIN_ROOT, "..", "..", "tests", "fixtures", "null-adapter.mjs");
    return fs.existsSync(file) ? (await import(pathToFileURL(file).href)).default : null;
  }
  if (!PROVIDERS.includes(provider)) return null;
  const file = path.join(PLUGIN_ROOT, "scripts", "lib", "providers", `${provider}.mjs`);
  return fs.existsSync(file) ? (await import(pathToFileURL(file).href)).default : null;
}
const knownProvider = (p, env) => PROVIDERS.includes(p) || (p === TEST_ADAPTER && env.COUNCIL_TEST_NULL_ADAPTER === "1");
async function requireAdapter(provider, env) {
  if (!knownProvider(provider, env)) throw new UsageError(`unknown provider ${JSON.stringify(provider)}; use ${PROVIDERS.join(", ")}`);
  const adapter = await loadAdapter(provider, env);
  if (!adapter) throw new UsageError(`provider ${provider} not available in this build`);
  return adapter;
}
/** The catalog and tiers of an adapter: the static files for the three providers, the adapter's own for a test adapter. */
function catalogFor(adapter, home) {
  return PROVIDERS.includes(adapter.id) ? loadCatalog(home, adapter.id) : loadCatalog(home, adapter.id, { [adapter.id]: adapter.catalog });
}
const tiersFor = (adapter) => (PROVIDERS.includes(adapter.id) ? loadTiers() : { [adapter.id]: adapter.tiers });

/** Verb and provider scoping of flags (A3.3), checked before anything is claimed or spawned. */
function checkFlags(verb, o, provider = null) {
  for (const [flag, verbs] of Object.entries(VERB_FLAGS)) if (o[flag] !== undefined && !verbs.includes(verb)) throw new UsageError(`--${flag} is not accepted by ${verb}`);
  if (provider) for (const [flag, providers] of Object.entries(PROVIDER_FLAGS)) {
    if (o[flag] !== undefined && !providers.includes(provider)) throw new UsageError(`--${flag} applies only to ${providers.join(", ")}`);
  }
  if (o["max-turns"] !== undefined) { const n = positiveInt(o["max-turns"], "--max-turns"); if (n > 100) throw new UsageError("--max-turns accepts 1 to 100"); }
  if (o["max-budget-usd"] !== undefined && !(Number(o["max-budget-usd"]) > 0)) throw new UsageError("--max-budget-usd needs a positive amount");
  if (o.rounds !== undefined) positiveInt(o.rounds, "--rounds");
  if (o.web && provider === "gemini") throw new UsageError("--web is not offered for gemini: its read-only turns cannot switch web search off (S1.2)");
  if (o.last && o.thread) throw new UsageError("give --last or a thread, not both");
}

/**
 * The thread a reply or `task --thread` continues, with its provider (A7.3): a job id (any session), a native thread id
 * known to council (namespaced by provider; one matching several providers needs --to), or --last (this cwd and session).
 */
function resolveThread(ctx, verb, o) {
  let job = null, provider = o.to ?? null;
  if (o.last) {
    job = candidates(ctx.home, ctx).find((j) => j.admitted !== false && j.threadId);
    if (!job) throw new UsageError(`no earlier confirmed thread in this ${ctx.session ? "Codex thread" : "workspace"}; name a job or thread`);
  } else {
    const ref = o.thread;
    if (!ref) throw new UsageError(`${verb} needs a job or thread id${verb === "reply" ? ", or --last" : ""}`);
    job = loadJob(ctx.home, ref);
    if (!job) {
      const providers = [...new Set([...providersOf(ctx.home, ref), ...threadProviders(ctx.home, ref)])];
      if (providers.length > 1 && !provider) throw new UsageError(`thread ${ref} exists for ${providers.join(" and ")}; add --to <provider>`);
      provider ??= providers[0] ?? null;
      if (!provider || !providers.includes(provider)) throw new UsageError(`no job or thread ${ref}${provider ? ` for ${provider}` : ""} known to council`);
      job = latestOnThread(ctx.home, provider, ref);
      if (!job) {
        const record = loadThread(ctx.home, provider, ref);
        return { provider, threadId: ref, prev: null, record };
      }
      if (!onThread(job, provider, ref)) throw new UsageError(`no job or thread ${ref} known to council`);
      return { provider, threadId: job.threadId && job.threadId.toLowerCase() === ref.toLowerCase() ? job.threadId : ref, prev: job, record: loadThread(ctx.home, provider, ref) };
    }
  }
  if (provider && provider !== job.provider) throw new UsageError(`job ${job.id} belongs to ${job.provider}; --to ${provider} conflicts with it`);
  if (job.admitted === false) throw new UsageError(`job ${job.id} was not admitted; use the original thread`);
  let threadId = job.threadId;
  if (!threadId) {
    if (!job.done && !job.stopped && job.requestedThreadId) threadId = job.requestedThreadId; // still in flight: the claim reports it busy
    else throw new UsageError(job.requestedThreadId ? `job ${job.id} never confirmed thread ${job.requestedThreadId}; to try it anyway, pass it instead of the job id` : `job ${job.id} has no thread`);
  }
  const prev = latestOnThread(ctx.home, job.provider, threadId) ?? job;
  return { provider: job.provider, threadId, prev, record: loadThread(ctx.home, job.provider, threadId) };
}

/** Tier, model and effort (A3.3): explicit flags win; a reply or task --thread inherits unless --tier, --model or --effort says otherwise. */
function resolveSettings(adapter, home, verb, o, prev) {
  const catalog = catalogFor(adapter, home);
  const inherit = prev && !o.tier;
  const tierName = o.tier ?? (inherit && prev.tier ? prev.tier : verb === "task" ? "exec" : "consult");
  const tier = resolveTier(adapter.id, tierName, { model: o.model, effort: o.effort }, tiersFor(adapter));
  const modelInput = o.model ?? (inherit ? prev.modelInput ?? prev.model : tier.model);
  const effortInput = o.effort ?? (inherit ? prev.requestedEffort ?? prev.effort : tier.effort);
  const model = resolveModel(adapter.id, modelInput, catalog);
  const effort = resolveEffort(adapter.id, model.id, effortInput, catalog, { explicit: o.effort !== undefined });
  return { tier: tierName, modelInput, model: model.id ?? "default", modelId: model.id, modelVerified: model.verified, effort: effort.effort, requestedEffort: effort.requested };
}

/** The review state a --next-input or discussion reply inherits from the thread's latest job (GROKX `makeTurn`). */
function inheritedReviewState(prev) {
  if (!prev) return null;
  const state = prev.done && [0, 10].includes(prev.code) ? prev.reviewState : prev.reviewStateBase ?? prev.reviewState;
  return state ? { ...state, active: [] } : null;
}

/** Builds the initial turn and the `prepare(jobId)` that re-reads history after admission (A7.4: prepare after claim). */
function planTurn(ctx, adapter, verb, o, text, memo) {
  const resumed = verb === "reply" || (verb === "task" && (o.thread || o.last));
  const thread = resumed ? resolveThread(ctx, verb, o) : null;
  if (thread && thread.provider !== adapter.id) throw new UsageError(`thread belongs to ${thread.provider}`);
  const prepare = (jobId) => {
    const prev = thread ? latestOnThread(ctx.home, adapter.id, thread.threadId, jobId) ?? thread.prev : null;
    const cwd = prev?.cwd ?? thread?.record?.cwd ?? ctx.cwd;
    if (!fs.existsSync(cwd)) throw new UsageError(`the thread's recorded workspace ${cwd} no longer exists; it cannot move to another directory`);
    const settings = resolveSettings(adapter, ctx.home, verb, o, prev ?? thread?.record ?? null);
    const roundsSet = o.rounds !== undefined || prev?.roundsSet === true;
    const rounds = o.rounds !== undefined ? positiveInt(o.rounds, "--rounds") : roundsSet ? prev.rounds
      : ctx.env[ROUNDS_ENV] ? positiveInt(ctx.env[ROUNDS_ENV], ROUNDS_ENV) : DEFAULT_ROUNDS;
    const nextInput = Boolean(o["next-input"]);
    const round = verb === "reply" ? (prev?.round ?? 0) + (nextInput ? 0 : 1) : verb === "task" && thread ? (prev?.round ?? 0) + 1 : 1;
    const structuredReview = verb === "review" || nextInput;
    const policy = getPolicy(ctx.home);
    let prompt = text, instructions = null, reviewState = inheritedReviewState(prev), reviewFiles = null, target = prev?.target ?? null;
    let unreviewed = prev?.unreviewed ?? [], batch = null, schemaCarrier = null;
    if (verb === "review") {
      const review = memo.review ??= collectReview(cwd, { base: o.base, commit: o.commit, uncommitted: o.uncommitted });
      const plan = adapter.reviewPlan ? adapter.reviewPlan(review, { adversarial: Boolean(o.adversarial) }) : { schemaCarrier: "path" };
      schemaCarrier = plan.schemaCarrier;
      const inputRoot = jobId ? path.join(ctx.home, "jobs", jobId, "review-input") : "";
      const first = startReviewTurn(review, jobId ?? "pending", inputRoot);
      reviewState = { ...first.state, adversarial: Boolean(o.adversarial), focus: text };
      batch = first.batch;
      target = review.label;
      unreviewed = review.unsupported;
      reviewFiles = { snapshot: review.snapshot, diff: review.fullDiff };
      prompt = buildBatchReviewPrompt({ adversarial: Boolean(o.adversarial), focus: text, ledger: [], batchText: first.text, label: review.label, unsupported: review.unsupported,
        state: first.state, embedSchema: schemaCarrier === "embed" ? fs.readFileSync(SCHEMA_PATH, "utf8") : null });
    } else if (nextInput) {
      if (!reviewState) throw new UsageError("--next-input requires a thread started by review");
      const next = continueReviewTurn(reviewState, Boolean(jobId));
      reviewState = { ...next.state, adversarial: reviewState.adversarial, focus: reviewState.focus };
      batch = next.batch;
      const plan = adapter.reviewPlan ? adapter.reviewPlan({ snapshot: null }, { adversarial: Boolean(reviewState.adversarial) }) : { schemaCarrier: "path" };
      schemaCarrier = plan.schemaCarrier;
      prompt = buildBatchReviewPrompt({ adversarial: Boolean(reviewState.adversarial), focus: reviewState.focus ?? "", ledger: reviewState.findingsLedger ?? [], batchText: next.text,
        label: target ?? "", unsupported: unreviewed.filter((u) => !u.endsWith("(pending saved input batch)")), state: next.state,
        embedSchema: schemaCarrier === "embed" ? fs.readFileSync(SCHEMA_PATH, "utf8") : null });
    } else {
      instructions = loadTemplate(verb === "task" ? "task" : "advice");
    }
    const resume = Boolean(thread);
    const request = {
      verb, nextInput, text, prompt, instructions, contractPath: path.join(PLUGIN_ROOT, "contract.md"), model: settings.modelId, effort: settings.effort, resume,
      threadId: thread?.threadId ?? null, cwd, env: ctx.env, schemaPath: structuredReview ? SCHEMA_PATH : null, structured: structuredReview, readOnly: verb !== "task",
      web: Boolean(o.web ?? prev?.web), allowCommands: o["allow-command"] ?? [], maxTurns: o["max-turns"] !== undefined ? Number(o["max-turns"]) : null,
      maxBudgetUsd: o["max-budget-usd"] !== undefined ? Number(o["max-budget-usd"]) : null, policy, agent: prev?.agent ?? thread?.record?.agent ?? null,
    };
    const launcher = adapter.resolveLauncher(ctx.env);
    if (!launcher) throw new LauncherError(`${adapter.id} not found: install its CLI or set ${adapter.binEnv}`);
    return {
      verb, cwd, ...settings, thread: thread?.threadId ?? null, confirmed: resume, round, rounds, roundsSet, prompt, launcher, web: request.web,
      target, unreviewed, reviewState, reviewFiles, batch, structuredReview, nextInput, policyVersion: policy.version,
      build: (jobDir) => {
        const built = adapter.buildTurn({ ...request, jobDir });
        return { ...built, env: { ...(built.env ?? ctx.env), ...depthEnv() } };
      },
      finalizeReview: ({ seen, job }) => {
        let structured = seen?.structured ?? null;
        if (adapter.finalizeReview) {
          const mapped = adapter.finalizeReview({ answerText: null, structured, unreviewed: job.unreviewed ?? [], batch: job.batch, ledger: job.reviewState?.findingsLedger ?? [] });
          if (mapped && Object.hasOwn(mapped, "structured")) structured = mapped.structured;
          else if (mapped !== undefined) structured = mapped;
        }
        return finalizeReviewTurn({ state: job.reviewState, structured, success: true, resultPath: path.join(job.dir, "meta.json"), jobId: job.id });
      },
    };
  };
  return { thread, prepare };
}

/** Prints a finished job (a replay, `wait`); the start line is not repeated. */
function printFinished(ctx, o, job, out) {
  let record = resultRecord(job), answer = "";
  try { const parsed = readAnswer(path.join(job.dir, "answer.md")); answer = parsed.answer; record = { ...record, answerClipped: parsed.answerClipped }; }
  catch (error) { if (error.code !== "ENOENT" && [0, 10].includes(record.code)) record = { ...record, code: 1, outcome: "failed", error: `stored answer unreadable: ${error.message}` }; }
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
 * Replays a request id (A7.4) before any selector, catalog, adapter or preflight runs; starts no provider process. A
 * reservation whose call is gone with nothing prepared is released (nothing ran); changed input exits 2.
 */
async function replay(ctx, o, record, fingerprint, out, deps) {
  if (record.fingerprint !== fingerprint) throw new UsageError(`request id ${o["request-id"]} was already used with different input; use a new request id`);
  const end = Date.now() + seconds(o.deadline, DEADLINE_S, "deadline") * 1000;
  for (let checkedAt = 0; !loadJob(ctx.home, record.job); await sleep(50)) {
    if (record.state === "tombstone") break; // prepared, then pruned: the result has expired
    if (Date.now() - checkedAt >= 1000) {
      checkedAt = Date.now();
      let snapshot;
      try { snapshot = (deps.snapshot ?? processSnapshot)({ platform: deps.platform ?? process.platform }); } catch { snapshot = { state: "unknown", rows: [] }; }
      const current = lookupRequest(ctx.home, record.key);
      if (!current) throw new UsageError(`request id ${o["request-id"]}: its first call failed before preparing and freed the id; retry with the same id to run it`);
      if (current.state === "tombstone") { record = current; continue; }
      if (companionState(current, snapshot) === "gone" && !loadJob(ctx.home, record.job)) {
        releaseRequest(ctx.home, record.key, record.job);
        throw new UsageError(`request id ${o["request-id"]} names job ${record.job}, whose call ended before it prepared; nothing ran, so the same request id can run again`);
      }
    }
    if (Date.now() >= end) {
      out(o.json ? `${JSON.stringify({ status: "preparing", exit: 20, job: record.job, provider: record.provider })}\n`
        : `still preparing · ${record.provider} · job ${record.job} · the first call with this request id has not started yet; retry with the same request id to keep waiting\n`);
      return 20;
    }
  }
  return awaitJob(ctx, o, record.job, Math.max(1, end - Date.now()), out);
}

/** ask, reply, review, task. */
async function runTurnVerb(ctx, parsed, text, io, deps) {
  const { verb, options: o } = parsed;
  checkFlags(verb, o);
  const timers = { inactivityMs: seconds(o["inactivity-timeout"], INACTIVITY_S, "inactivity-timeout") * 1000, deadlineMs: seconds(o.deadline, DEADLINE_S, "deadline") * 1000 };
  // (3) Request-id lookup before anything else; the fingerprint covers the raw inputs.
  const fingerprint = requestFingerprint(verb, o, text);
  const key = o["request-id"] !== undefined ? requestKey(ctx.session, ctx.cwd, o["request-id"]) : null;
  if (key) {
    const existing = lookupRequest(ctx.home, key);
    if (existing) return replay(ctx, o, existing, fingerprint, writer(io.stdout), deps);
  }
  // (4) Provider: --to, or the job or thread record on reply and task --thread.
  let provider = o.to;
  if (verb === "reply" || (verb === "task" && (o.thread || o.last))) {
    const thread = resolveThread(ctx, verb, o);
    if (o.to && o.to !== thread.provider) throw new UsageError(`the thread belongs to ${thread.provider}; --to ${o.to} conflicts with it`);
    provider = thread.provider;
  } else if (!provider) throw new UsageError(`${verb} needs --to ${PROVIDERS.join("|")}`);
  checkFlags(verb, o, provider);
  if (o["allow-command"] && verb !== "task") throw new UsageError("--allow-command applies only to task");
  const adapter = await requireAdapter(provider, ctx.env);
  // (5) Tier, model and effort, and the turn itself, resolved once before admission (re-resolved by prepare after it).
  const memo = {};
  const { prepare } = planTurn(ctx, adapter, verb, o, text, memo);
  const initial = prepare(null);
  // (6) Preflight through the cached runner: a blocked resource exits 1 with zero submissions.
  const descriptors = adapter.preflight ? adapter.preflight({ stateRoot: ctx.home, env: ctx.env, platform: deps.platform ?? process.platform, verb, cwd: initial.cwd }) : [];
  await runPreflight({ home: ctx.home, provider, launcher: initial.launcher, descriptors, env: ctx.env, platform: deps.platform ?? process.platform });
  // (7) Admit: claim the request id (a fresh request claims, prepares, tombstones, runs), then the managed turn.
  let jobId;
  if (key) {
    jobId = requestJobId(provider, ctx.session, ctx.cwd, o["request-id"]);
    const claimed = claimRequest(ctx.home, { key, requestId: o["request-id"], provider, session: ctx.session, cwd: ctx.cwd, fingerprint, jobId,
      companionIdentity: executionController({ platform: deps.platform }).self() });
    if (!claimed.fresh) return replay(ctx, o, claimed.record, fingerprint, writer(io.stdout), deps);
  }
  const out = writer(io.stdout), err = writer(io.stderr);
  let result;
  try {
    result = await runManagedTurn(ctx, adapter, { ...initial, thread: initial.thread }, (id) => prepare(id),
      { jobId, requestKey: key, requestId: o["request-id"] ?? null, json: o.json, ...timers }, { announce: (job) => err(`${startLine(job)}\n`), ...(deps.hooks ?? {}) });
  } catch (error) {
    if (key && !loadJob(ctx.home, jobId)?.admitted) releaseRequest(ctx.home, key, jobId); // nothing prepared: a retry may run
    throw error;
  }
  if (key && !result.job.admitted) releaseRequest(ctx.home, key, jobId); // refused before preparing (a busy thread): nothing ran, the id may run again
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
  const job = o.job ? findJob(ctx.home, o.job, o.to ?? null) : candidates(ctx.home, ctx).find((j) => cleanupNeeded(j) || claimHeld(ctx.home, j));
  if (o.job && !job) throw new UsageError(`no job or thread ${o.job}; an unidentified claim requires quiescent manual recovery`);
  if (!job) { out(o.json ? '{"status":"none","exit":0}\n' : "no running council job to cancel\n"); return 0; }
  const adapter = await loadAdapter(job.provider, ctx.env);
  const control = executionController({ adapter, platform: deps.platform, ...(deps.snapshot ? { snapshot: deps.snapshot } : {}), ...(deps.powershell ? { powershell: deps.powershell } : {}) });
  const result = await cancelManaged(ctx, job, { timeoutMs, control, confirmEnded: Boolean(o["confirm-ended"]) });
  const data = { provider: job.provider, job: job.id, status: result.status, exit: result.code, thread: result.job?.threadId ?? null, cleanupPending: result.code !== 0, released: Boolean(result.released), error: result.error ?? null };
  out(o.json ? `${JSON.stringify(data)}\n` : `${result.status} · ${job.provider} · job ${job.id}${result.error ? ` · ${result.error}` : ""}${result.code === 0 && result.job?.threadId ? " · the thread stays resumable" : ""}\n`);
  return result.code;
}

const providerList = (o, env) => (o.to ? [o.to] : [...PROVIDERS, ...(env.COUNCIL_TEST_NULL_ADAPTER === "1" ? [TEST_ADAPTER] : [])]);

/** models [--to p] [--refresh]: the catalog; --refresh re-runs the provider's listing (Claude has none). */
async function modelsVerb(ctx, { options: o }, io) {
  checkFlags("models", o);
  const out = writer(io.stdout), report = [];
  for (const provider of providerList(o, ctx.env)) {
    if (!knownProvider(provider, ctx.env)) throw new UsageError(`unknown provider ${JSON.stringify(provider)}`);
    const adapter = await loadAdapter(provider, ctx.env);
    if (!adapter) {
      const statics = loadStatic()[provider];
      report.push({ provider, available: false, models: statics ? Object.keys(statics.models ?? statics.families ?? {}) : [], aliases: statics?.aliases ?? {} });
      continue;
    }
    let refreshed = null;
    if (o.refresh && adapter.catalog?.listing !== false) {
      const probe = await adapter.probe(adapter.resolveLauncher(ctx.env));
      if (probe?.models) refreshed = saveRefreshedCatalog(ctx.home, provider, probe.models).updatedAt;
    }
    const catalog = catalogFor(adapter, ctx.home);
    report.push({ provider, available: true, refreshedAt: catalog.refreshedAt ?? refreshed, models: Object.entries(catalog.models).map(([id, efforts]) => ({ id, efforts })), aliases: catalog.aliases });
  }
  if (o.json) out(`${JSON.stringify(report)}\n`);
  else for (const r of report) {
    if (!r.available) { out(`${r.provider}: provider not available in this build · static catalog: ${r.models.join(", ") || "none"}\n`); continue; }
    out(`${r.provider}${r.refreshedAt ? ` (refreshed ${r.refreshedAt})` : " (static catalog)"}\n${r.models.map((m) => `  ${m.id}: ${m.efforts.join(", ") || "-"}`).join("\n")}\n`);
    if (Object.keys(r.aliases).length) out(`  aliases: ${Object.entries(r.aliases).map(([a, id]) => `${a}=${id}`).join(", ")}\n`);
  }
  return 0;
}

/** setup [--to p] [--live] [--set policy.json]: binary, login, version, catalog age, tiers, launcher kind, preflight, trade-offs. */
async function setupVerb(ctx, parsed, io, deps) {
  const { options: o } = parsed;
  checkFlags("setup", o);
  const out = writer(io.stdout), report = [];
  if (o.set !== undefined) {
    const policy = setPolicy(ctx.home, readJson(path.resolve(ctx.cwd, o.set)) ?? (() => { throw new UsageError(`cannot read policy file ${o.set}`); })());
    out(o.json ? "" : `policy ${policy.version} stored: read roots ${policy.readRoots.length}, web ${policy.web}, MCP ${policy.allowMcp}\n`);
  }
  for (const provider of providerList(o, ctx.env)) {
    if (!knownProvider(provider, ctx.env)) throw new UsageError(`unknown provider ${JSON.stringify(provider)}`);
    const adapter = await loadAdapter(provider, ctx.env);
    if (!adapter) {
      const { name, env: binEnv } = BINARIES[provider] ?? { name: provider, env: null };
      let binary = null;
      try { binary = resolveLauncher({ name, binEnv, env: ctx.env, nativeOnly: provider === "claude" })?.path ?? null; } catch { binary = null; }
      report.push({ provider, available: false, binary, name });
      continue;
    }
    const entry = { provider, available: true, binary: null, kind: null, version: null, loggedIn: null, tiers: tiersFor(adapter)[provider], preflight: null, warnings: [] };
    try {
      const launcher = adapter.resolveLauncher(ctx.env);
      if (!launcher) throw new LauncherError(`${provider} not found: install its CLI or set ${adapter.binEnv}`);
      Object.assign(entry, { binary: launcher.path, kind: launcher.kind });
      const probe = await adapter.probe(launcher);
      Object.assign(entry, { version: probe?.version ?? null, loggedIn: probe?.loggedIn ?? null });
      const pre = await runPreflight({ home: ctx.home, provider, launcher, descriptors: adapter.preflight({ stateRoot: ctx.home, env: ctx.env, platform: deps.platform ?? process.platform, verb: "setup", cwd: ctx.cwd }),
        env: ctx.env, platform: deps.platform ?? process.platform });
      entry.preflight = pre.cached ? "ok (cached)" : "ok";
    } catch (error) {
      entry.preflight = error instanceof PreflightBlocked ? `preflight_blocked: ${error.detail}` : null;
      entry.warnings.push(error.message);
      if (error instanceof PreflightBlocked) entry.action = error.action;
    }
    if (provider === "gemini") entry.warnings.push("Gemini read-only turns can search the web; --web is not offered for Gemini");
    report.push(entry);
  }
  if (o.json) out(`${JSON.stringify(report)}\n`);
  else for (const r of report) {
    if (!r.available) { out(`${r.provider}: ${r.name} ${r.binary ?? "not found"} · provider not available in this build\n`); continue; }
    out(`${r.provider}: ${r.binary ?? "not found"}${r.kind ? ` (${r.kind})` : ""}${r.version ? ` · ${r.version}` : ""}${r.loggedIn === null ? "" : r.loggedIn ? " · logged in" : " · not logged in"}`
      + `${r.tiers ? ` · tiers ${Object.entries(r.tiers).map(([t, v]) => `${t}=${v.model}/${v.effort}`).join(" ")}` : ""} · preflight ${r.preflight ?? "not run"}\n`);
    for (const w of r.warnings) out(`  warning: ${w}\n`);
    if (r.action) out(`  action: ${r.action}\n`);
  }
  if (o.live) {
    let code = 0;
    for (const r of report.filter((x) => x.available)) {
      const live = { verb: "ask", options: { to: r.provider, tier: "consult" }, positionals: [], hasDashDash: true };
      code = Math.max(code, await runTurnVerb(ctx, live, "Reply with exactly PASS.", io, deps));
    }
    return code;
  }
  return 0;
}

const CONTROL = { wait: waitVerb, cancel: cancelVerb, models: modelsVerb, setup: setupVerb };

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
    if (parsed.verb === "help") { io.stdout.write(`${USAGE}\n`); return 0; }
    const cwd = canonical(path.resolve(parsed.options.cwd ?? deps.cwd ?? process.cwd()));
    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new UsageError(`--cwd ${parsed.options.cwd} is not a directory`);
    // (2) Guards: no nested call, state outside the workspace.
    const nested = depthGuard(env);
    if (nested) throw new StateError(nested);
    const home = homeDir(env);
    assertStateOutsideWorkspace(home, cwd);
    const ctx = { env, home, cwd, session: hostSession(env) };
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
  main(process.argv.slice(2), process.env).then((code) => { process.exitCode = code; }, (error) => {
    process.stderr.write(`council: ${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
