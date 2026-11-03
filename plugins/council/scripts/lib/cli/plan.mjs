// Provider loading, validation and immutable turn planning. No admission writes or process launch.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { UsageError, positiveInt, seconds } from "../core/args.mjs";
import { PROVIDERS, ROUNDS_ENV, guardedEnv } from "../core/host.mjs";
import { candidates, latestOnThread, loadJob, loadThread, onThread, providersOf, threadProviders } from "../core/jobs.mjs";
import { priorFindingsNote } from "../core/findings.mjs";
import { getPolicy } from "../core/preflight.mjs";
import { LauncherError } from "../core/launcher.mjs";
import { assertAdapter } from "../core/types.mjs";
import { loadCatalog, resolveEffort, resolveModel } from "../core/catalog.mjs";
import { loadTiers, resolveTier } from "../core/tiers.mjs";
import { buildBatchReviewPrompt, collectReview, continueReviewTurn, finalizeReviewTurn, loadTemplate, startReviewTurn } from "../core/review.mjs";

import { PLUGIN_ROOT, SCHEMA_PATH, DEFAULT_ROUNDS, DEADLINE_S } from "./config.mjs";

/** Provider-scoped and verb-scoped flags (A3.3): anything else with them exits 2. */
const VERB_FLAGS = { "next-input": ["reply"], base: ["review"], commit: ["review"], uncommitted: ["review"], adversarial: ["review"], refresh: ["models"], live: ["setup"],
  set: ["setup"], "confirm-ended": ["cancel"], last: ["reply"], thread: ["reply", "task"], timeout: ["wait", "cancel"], "allow-command": ["task"] };
const PROVIDER_FLAGS = { "max-turns": ["claude"], "max-budget-usd": ["claude"], "allow-command": ["gemini"] };
export const TEST_ADAPTER = "null";
/** Test providers, loaded only under COUNCIL_TEST_NULL_ADAPTER=1: the null adapter and a second copy under another id. */
const TEST_ADAPTERS = { null: "null-adapter.mjs", null2: "null2-adapter.mjs" };


/** The provider module, or null when this build has none (S2.6: `provider <p> not available in this build`). */
export async function loadAdapter(provider, env = process.env) {
  if (Object.hasOwn(TEST_ADAPTERS, provider)) {
    if (env.COUNCIL_TEST_NULL_ADAPTER !== "1") return null;
    const file = path.join(PLUGIN_ROOT, "..", "..", "tests", "fixtures", TEST_ADAPTERS[provider]);
    return fs.existsSync(file) ? assertAdapter((await import(pathToFileURL(file).href)).default, provider) : null;
  }
  if (!PROVIDERS.includes(provider)) return null;
  // Test seam: under COUNCIL_TEST_NULL_ADAPTER=1, COUNCIL_TEST_ABSENT_PROVIDERS (comma-separated) hides shipped provider
  // modules, so a test that needs an absent provider never resolves and starts the real CLI on PATH.
  if (env.COUNCIL_TEST_NULL_ADAPTER === "1" && String(env.COUNCIL_TEST_ABSENT_PROVIDERS ?? "").split(",").includes(provider)) return null;
  const file = path.join(PLUGIN_ROOT, "scripts", "lib", "providers", `${provider}.mjs`);
  return fs.existsSync(file) ? assertAdapter((await import(pathToFileURL(file).href)).default, provider) : null;
}
export const knownProvider = (p, env) => PROVIDERS.includes(p) || (Object.hasOwn(TEST_ADAPTERS, p) && env.COUNCIL_TEST_NULL_ADAPTER === "1");
/** The newest of an implicit selection (`reply --last`, bare `cancel`); an exact timestamp tie is ambiguous (exit 2). */
export function latestOf(list, what) {
  const at = (j) => String(j.admittedAt ?? j.spawnedAt);
  if (list.length > 1 && at(list[0]) === at(list[1])) throw new UsageError(`${what}: jobs ${list[0].id} and ${list[1].id} started at the same moment; name one`);
  return list[0] ?? null;
}
export async function requireAdapter(provider, env) {
  if (!knownProvider(provider, env)) throw new UsageError(`unknown provider ${JSON.stringify(provider)}; use ${PROVIDERS.join(", ")}`);
  const adapter = await loadAdapter(provider, env);
  if (!adapter) throw new UsageError(`provider ${provider} not available in this build`);
  return adapter;
}
/** The catalog and tiers of an adapter: the static files for the three providers, the adapter's own for a test adapter. */
export function catalogFor(adapter, home) {
  return PROVIDERS.includes(adapter.id) ? loadCatalog(home, adapter.id) : loadCatalog(home, adapter.id, { [adapter.id]: adapter.catalog });
}
export const tiersFor = (adapter) => (PROVIDERS.includes(adapter.id) ? loadTiers() : { [adapter.id]: adapter.tiers });

/** Verb and provider scoping of flags (A3.3), checked before anything is claimed or spawned. */
export function checkFlags(verb, o, provider = null) {
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
export function resolveThread(ctx, verb, o) {
  let job = null, provider = o.to ?? null;
  if (o.last) {
    // An open/lost turn must block --last even before its provider discovers a native id.
    job = latestOf(candidates(ctx.home, ctx).filter((j) => (!j.done && !j.stopped)
      || (j.admitted !== false && j.providerStarted !== false && (j.threadId || j.unconfirmed))), "--last is ambiguous");
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
        return resumable({ provider, threadId: ref, prev: null, record });
      }
      if (!onThread(job, provider, ref)) throw new UsageError(`no job or thread ${ref} known to council`);
      return resumable({ provider, threadId: job.threadId && job.threadId.toLowerCase() === ref.toLowerCase() ? job.threadId : ref, prev: job, record: loadThread(ctx.home, provider, ref) });
    }
  }
  if (provider && provider !== job.provider) throw new UsageError(`job ${job.id} belongs to ${job.provider}; --to ${provider} conflicts with it`);
  if (job.admitted === false) throw new UsageError(!job.done && !job.stopped
    ? `job ${job.id} is not admitted yet; wait ${job.id} or cancel ${job.id}` : `job ${job.id} was not admitted; use the original thread`);
  if (job.unconfirmed) throw new UsageError(`job ${job.id}: ${job.unconfirmed}`);
  let threadId = job.threadId;
  if (!threadId) {
    if (!job.done && !job.stopped) throw new UsageError(`job ${job.id} has not confirmed a thread; wait ${job.id} or cancel ${job.id}`);
    throw new UsageError(job.requestedThreadId ? `job ${job.id} never confirmed thread ${job.requestedThreadId}; to try it anyway, pass it instead of the job id` : `job ${job.id} has no thread`);
  }
  const prev = latestOnThread(ctx.home, job.provider, threadId) ?? (job.providerStarted === false ? null : job);
  return resumable({ provider: job.provider, threadId, prev, record: loadThread(ctx.home, job.provider, threadId) });
}
/** A thread whose last turn finished unconfirmed is not resumable (its record says so, or its latest job does): exit 2 with the hint. */
function resumable(found) {
  if (!found.prev && !found.record) throw new UsageError(`${found.provider} thread ${found.threadId} has no started history or retained record; start a new ask`);
  const why = found.prev?.unconfirmed ?? (found.record?.resumable === false ? found.record.unconfirmed ?? "not resumable" : null);
  if (why) throw new UsageError(`${found.provider} thread ${found.threadId}: ${why}`);
  return found;
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
export function planTurn(ctx, adapter, verb, o, text, memo) {
  const resumed = verb === "reply" || (verb === "task" && (o.thread || o.last));
  const thread = resumed ? memo.resolvedThread ?? resolveThread(ctx, verb, o) : null;
  if (thread && thread.provider !== adapter.id) throw new UsageError(`thread belongs to ${thread.provider}`);
  const launcher = adapter.resolveLauncher(ctx.env);
  if (!launcher) throw new LauncherError(`${adapter.id} not found: install its CLI or set ${adapter.binEnv}`);
  const prepare = (jobId) => {
    // The speculative validation reuses the resolved snapshot; admission always reads fresh history under the claim.
    const prev = thread ? (jobId ? latestOnThread(ctx.home, adapter.id, thread.threadId, jobId) ?? thread.prev : thread.prev) : null;
    // Rechecked under the claim: another turn may have made the thread non-resumable since it was resolved, or a recovery set its agent.
    const record = thread ? (jobId ? loadThread(ctx.home, adapter.id, thread.threadId) : thread.record) : null;
    if (thread && jobId) resumable({ provider: adapter.id, threadId: thread.threadId, prev, record });
    // The thread record stands in for pruned job history (A7.6): round, budget, effort request and web persist there.
    const base = prev ?? record ?? null;
    const cwd = base?.cwd ?? ctx.cwd;
    if (!fs.existsSync(cwd)) throw new UsageError(`the thread's recorded workspace ${cwd} no longer exists; it cannot move to another directory`);
    const settings = resolveSettings(adapter, ctx.home, verb, o, base);
    const roundsSet = o.rounds !== undefined || base?.roundsSet === true;
    const rounds = o.rounds !== undefined ? positiveInt(o.rounds, "--rounds") : roundsSet ? base.rounds
      : ctx.env[ROUNDS_ENV] ? positiveInt(ctx.env[ROUNDS_ENV], ROUNDS_ENV) : DEFAULT_ROUNDS;
    const nextInput = Boolean(o["next-input"]);
    const round = verb === "reply" ? (base?.round ?? 0) + (nextInput ? 0 : 1) : verb === "task" && thread ? (base?.round ?? 0) + 1 : 1;
    const inherited = inheritedReviewState(prev);
    // A plain reply on a review thread is a discussion turn: structured, reconciled into the ledger, no delivery coverage (A5.2).
    const discussion = verb === "reply" && !nextInput && Boolean(inherited);
    const structuredReview = verb === "review" || nextInput || discussion;
    const policy = getPolicy(ctx.home);
    let prompt = text, instructions = null, reviewState = inherited, reviewFiles = null, target = prev?.target ?? null;
    let unreviewed = prev?.unreviewed ?? [], batch = null, schemaCarrier = null;
    if (verb === "review") {
      const review = memo.review ??= collectReview(cwd, { base: o.base, commit: o.commit, uncommitted: o.uncommitted });
      const plan = adapter.reviewPlan ? adapter.reviewPlan(review, { adversarial: Boolean(o.adversarial) }) : { schemaCarrier: "path" };
      schemaCarrier = plan.schemaCarrier;
      const inputRoot = jobId ? path.join(ctx.home, "jobs", jobId, "review-input") : "";
      const first = startReviewTurn(review, jobId ?? "pending", inputRoot);
      reviewState = { ...first.state, adversarial: Boolean(o.adversarial), focus: text, workspaceRoot: review.root };
      batch = first.batch;
      target = review.label;
      unreviewed = review.unsupported;
      reviewFiles = { snapshot: review.snapshot, diff: review.fullDiff };
      prompt = buildBatchReviewPrompt({ adversarial: Boolean(o.adversarial), focus: text, ledger: [], batchText: first.text, label: review.label, unsupported: review.unsupported,
        state: reviewState, embedSchema: schemaCarrier === "embed" ? fs.readFileSync(SCHEMA_PATH, "utf8") : null });
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
    } else if (discussion) {
      const plan = adapter.reviewPlan ? adapter.reviewPlan({ snapshot: null }, { adversarial: Boolean(reviewState.adversarial) }) : { schemaCarrier: "path" };
      schemaCarrier = plan.schemaCarrier;
      prompt = [text.trim(), "", "This follow-up on the review above delivers no new review input. Answer in the review schema: to update an earlier finding, repeat its id with decision AGREE, CHANGE or REJECT; add a finding only if this discussion reveals one.",
        priorFindingsNote(reviewState.findingsLedger ?? []), schemaCarrier === "embed" ? `Answer with one JSON object and nothing else, matching this draft-07 schema exactly:\n${fs.readFileSync(SCHEMA_PATH, "utf8")}` : ""].filter(Boolean).join("\n");
    } else {
      instructions = loadTemplate(verb === "task" ? "task" : "advice");
    }
    const resume = Boolean(thread);
    const request = {
      verb, nextInput, text, prompt, instructions, contractPath: path.join(PLUGIN_ROOT, "contract.md"), model: settings.modelId, effort: settings.effort, resume,
      threadId: thread?.threadId ?? null, cwd, env: ctx.env, reviewInputRoot: structuredReview ? reviewState?.inputRoot || null : null,
      reviewRoot: structuredReview ? reviewState?.workspaceRoot || null : null, schemaPath: structuredReview ? SCHEMA_PATH : null, structured: structuredReview, readOnly: verb !== "task",
      web: Boolean(o.web ?? base?.web), allowCommands: o["allow-command"] ?? [], maxTurns: o["max-turns"] !== undefined ? Number(o["max-turns"]) : null,
      // A session cannot leave Grok's default agent, so the record's "default" outranks an older retained job.
      maxBudgetUsd: o["max-budget-usd"] !== undefined ? Number(o["max-budget-usd"]) : null, policy, agent: record?.agent === "default" ? "default" : prev?.agent ?? record?.agent ?? null, launcher,
      deadlineMs: seconds(o.deadline, DEADLINE_S, "deadline") * 1000, // agy's --print-timeout is set from it (A3.3)
    };
    // The adapter's own refusals (A5 checkRequest): exit 2 before any job record and before the request id is tombstoned.
    const refusal = adapter.checkRequest ? adapter.checkRequest(request, ctx.env, ctx.platform ?? process.platform) : null;
    if (refusal) throw new UsageError(refusal);
    return {
      verb, cwd, ...settings, thread: thread?.threadId ?? null, confirmed: resume, round, rounds, roundsSet, prompt, launcher, web: request.web,
      target, unreviewed, reviewState, reviewFiles, batch, structuredReview, nextInput, policyVersion: policy.version,
      build: (jobDir) => {
        const built = adapter.buildTurn({ ...request, jobDir });
        return { ...built, env: guardedEnv(built.env ?? ctx.env) };
      },
      finalizeReview: ({ seen, job, answerText = null }) => {
        let structured = seen?.structured ?? null;
        if (adapter.finalizeReview) {
          const mapped = adapter.finalizeReview({ answerText, structured, unreviewed: job.unreviewed ?? [], batch: job.batch, ledger: job.reviewState?.findingsLedger ?? [] });
          if (mapped && Object.hasOwn(mapped, "structured")) structured = mapped.structured;
          else if (mapped !== undefined) structured = mapped;
        }
        return finalizeReviewTurn({ state: job.reviewState, structured, success: true, resultPath: path.join(job.dir, "meta.json"), jobId: job.id });
      },
    };
  };
  return { thread, launcher, cwd: thread?.prev?.cwd ?? thread?.record?.cwd ?? ctx.cwd, prepare };
}
