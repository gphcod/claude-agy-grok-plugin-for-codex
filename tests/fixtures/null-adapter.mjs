// The null adapter (S2.1): the A5 interface over tests/fixtures/fake-child.mjs, loaded by the entry only under
// COUNCIL_TEST_NULL_ADAPTER=1. Profiles come from the environment:
//   COUNCIL_NULL_ID     preassigned (Grok-like: the thread id is chosen before spawn) | discovered (the id arrives in an event)
//   COUNCIL_NULL_INPUT  stdin | prompt-file
//   COUNCIL_NULL_OUTPUT stream | answer-file
// beforeTurn/afterTurn record their calls to COUNCIL_FAKE_HOOKS so lifecycle tests can count them.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { depthEnv } from "../../plugins/council/scripts/lib/core/host.mjs";
import { runSync } from "../../plugins/council/scripts/lib/core/launcher.mjs";

export const FAKE_CHILD = fileURLToPath(new URL("./fake-child.mjs", import.meta.url));
const profile = (env = process.env) => ({ id: env.COUNCIL_NULL_ID || "preassigned", input: env.COUNCIL_NULL_INPUT || "stdin", output: env.COUNCIL_NULL_OUTPUT || "stream" });
const hook = (name, ctx, outcome) => { const file = ctx.env?.COUNCIL_FAKE_HOOKS ?? process.env.COUNCIL_FAKE_HOOKS; if (file) fs.appendFileSync(file, `${JSON.stringify({ hook: name, job: ctx.job?.id ?? null, verb: ctx.request?.verb ?? null, outcome: outcome ?? null })}\n`); };

export const catalog = { listing: true, models: { "null-model": ["low", "medium", "high", "xhigh"], "null-fast": ["low", "medium", "high"] }, aliases: { fast: "null-fast" }, suffixed: false };
export const tiers = { consult: { model: "null-model", effort: "high" }, exec: { model: "null-fast", effort: "high" }, deep: { model: "null-model", effort: "xhigh" } };

export default {
  id: "null",
  binEnv: "COUNCIL_NULL_BIN",
  catalog,
  tiers,
  maxLineBytes: 1024 * 1024,
  resolveLauncher(env = process.env) {
    const file = env.COUNCIL_NULL_BIN || FAKE_CHILD;
    return { command: process.execPath, args: [file], path: file, kind: "node-script" };
  },
  trustsCleanExit() { return false; },
  /** Ownership evidence: the --thread operand (preassigned), the --answer-file / --prompt-file operand, or the --job-dir operand recorded at launch. */
  ownsProcess(row, job, platform = process.platform, hasFlagOperand) {
    const at = job.childArgs?.indexOf("--job-dir") ?? -1;
    const operands = [["--prompt-file", job.promptFile], ["--answer-file", job.answerFile], ["--thread", job.requestedThreadId], ["--job-dir", at >= 0 ? job.childArgs[at + 1] : null]].filter(([, v]) => v);
    return operands.some(([flag, value]) => hasFlagOperand(row, flag, value, platform));
  },
  /** Non-billable probes (A5): `--version` and the `models` listing of the child, as the real adapters run them. */
  async probe(launcher = this.resolveLauncher(), env = process.env) {
    env = { ...env, ...(launcher.env ?? {}) };
    const version = runSync(launcher, ["--version"], { env });
    const listing = runSync(launcher, ["models"], { env });
    const ids = listing.status === 0 ? listing.stdout.split("\n").map((l) => /^\s*-\s+(\S+)/.exec(l)?.[1]).filter(Boolean) : [];
    const warnings = env.COUNCIL_NULL_PROBE_WARNING ? [env.COUNCIL_NULL_PROBE_WARNING] : [];
    return { version: version.status === 0 ? version.stdout.trim() : null, loggedIn: listing.status === 0, models: ids.map((id) => ({ id, efforts: catalog.models[id] ?? ["low", "medium", "high"] })), warnings };
  },
  preflight(ctx) {
    ctx = { env: process.env, ...ctx };
    const blocked = ctx.env.COUNCIL_NULL_PREFLIGHT_BLOCK;
    return [
      { kind: "dir", target: ctx.stateRoot, access: "write", timeoutMs: 1000, why: "job records", action: "Set COUNCIL_CODEX_HOME to a writable directory outside the workspace." },
      // The cold, non-billable capability probe (A1): cached by executable, so a warm call spawns none.
      { kind: "exec", target: { command: process.execPath, args: [this.resolveLauncher(ctx.env).path, "--version"], expectText: "^null " }, timeoutMs: 15000, why: "null version probe", action: "Install the null child." },
      ...(blocked ? [{ kind: "file", target: blocked, access: "read", timeoutMs: 1000, why: "null login file", action: `Grant read access to ${blocked}; the host sandbox blocks it.` }] : []),
    ];
  },
  buildTurn(request) {
    const p = profile(request.env);
    const requestLog = request.env?.COUNCIL_FAKE_REQUEST_LOG;
    if (requestLog) { const { env, policy, launcher, ...rest } = request; fs.appendFileSync(requestLog, `${JSON.stringify({ ...rest, envKeys: Object.keys(env ?? {}).length, policy, launcherKind: launcher?.kind ?? null })}\n`); }
    const args = [];
    const thread = request.threadId ?? (p.id === "preassigned" ? randomUUID() : null);
    if (thread) args.push("--thread", thread);
    args.push("--model", request.model ?? "null-model", "--effort", request.effort ?? "high");
    if (request.verb === "review" || request.structured) args.push("--schema", request.schemaPath ?? "inline");
    if (request.verb === "task") args.push("--edit");
    const promptFile = p.input === "prompt-file" ? path.join(request.jobDir, "prompt.md") : null;
    const answerFile = p.output === "answer-file" ? path.join(request.jobDir, "answer.md") : null;
    if (promptFile) args.push("--prompt-file", promptFile);
    if (answerFile) args.push("--answer-file", answerFile);
    args.push("--job-dir", request.jobDir);
    return { args, env: { ...request.env, ...depthEnv() }, ...(promptFile ? { promptFile } : { stdin: request.prompt }), answerFile,
      readOnly: request.verb !== "task", requestedThreadId: thread, contractCarrier: "stdin", agent: null };
  },
  /** Refuses a flag before any job record (exit 2): COUNCIL_NULL_REFUSE names a request field that must be falsy. */
  checkRequest(request, env = process.env) {
    const field = env.COUNCIL_NULL_REFUSE;
    return field && request[field] ? `the null provider refuses ${field}` : null;
  },
  beforeTurn(ctx) { hook("beforeTurn", ctx); },
  afterTurn(ctx, outcome) { hook("afterTurn", ctx, outcome); },
  parseEvent(line, state) {
    let event;
    try { event = JSON.parse(line); } catch { return { fatal: "malformed event" }; }
    if (typeof event?.type !== "string") return { fatal: "event without a type" };
    switch (event.type) {
      case "start": return { threadId: event.thread, ...(event.model ? { model: event.model } : {}) };
      case "text": return { textDelta: event.data };
      case "tool": return event.denied ? { denied: { tool: event.name, path: event.path } } : event.ok === false ? { failedCommand: event.command ?? event.name } : event.name === "edit" ? { edited: event.path, toolStep: event.name } : { toolStep: event.name };
      case "end":
        if (event.fatal) return { fatal: event.fatal, costUsd: event.cost, usage: { fatal: true }, ...(event.structured ? { structured: event.structured } : {}) };
        return { completed: true, threadId: event.thread, costUsd: event.cost, ...(event.structured ? { structured: event.structured } : {}), ...(event.unconfirmed ? { unconfirmed: event.unconfirmed } : {}) };
      default: return null;
    }
  },
  reviewPlan(gitInfo, request) { return { native: false, batches: gitInfo.batches, promptTemplate: request.adversarial ? "adversarial-review" : "review", schemaCarrier: "inline" }; },
  /** Structured output from the end event, else the complete answer text parsed as JSON (an embedded-schema provider). */
  finalizeReview({ answerText, structured, unreviewed }) {
    if (!structured && answerText) { try { structured = JSON.parse(answerText); } catch { /* malformed: the validator reports it */ } }
    return { structured, unreviewed };
  },
};
