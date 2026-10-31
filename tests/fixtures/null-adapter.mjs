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

export const FAKE_CHILD = fileURLToPath(new URL("./fake-child.mjs", import.meta.url));
const profile = (env = process.env) => ({ id: env.COUNCIL_NULL_ID || "preassigned", input: env.COUNCIL_NULL_INPUT || "stdin", output: env.COUNCIL_NULL_OUTPUT || "stream" });
const hook = (name, ctx, outcome) => { if (process.env.COUNCIL_FAKE_HOOKS) fs.appendFileSync(process.env.COUNCIL_FAKE_HOOKS, `${JSON.stringify({ hook: name, job: ctx.job?.id ?? null, verb: ctx.request?.verb ?? null, outcome: outcome ?? null })}\n`); };

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
  /** Ownership evidence: the --thread operand (preassigned) or the --answer-file / --prompt-file operand. */
  ownsProcess(row, job, platform = process.platform, hasFlagOperand) {
    const operands = [["--prompt-file", job.promptFile], ["--answer-file", job.answerFile], ["--thread", job.requestedThreadId]].filter(([, v]) => v);
    return operands.some(([flag, value]) => hasFlagOperand(row, flag, value, platform));
  },
  async probe() { return { version: "null 0.0.1", loggedIn: true, models: [{ id: "null-model", efforts: ["low", "medium", "high", "xhigh"] }, { id: "null-fast", efforts: ["low", "medium", "high"] }] }; },
  preflight(ctx) {
    const blocked = process.env.COUNCIL_NULL_PREFLIGHT_BLOCK;
    return [
      { kind: "dir", target: ctx.stateRoot, access: "write", timeoutMs: 1000, why: "job records", action: "Set COUNCIL_CODEX_HOME to a writable directory outside the workspace." },
      ...(blocked ? [{ kind: "file", target: blocked, access: "read", timeoutMs: 1000, why: "null login file", action: `Grant read access to ${blocked}; the host sandbox blocks it.` }] : []),
    ];
  },
  buildTurn(request) {
    const p = profile(request.env);
    const args = [];
    const thread = request.resume ? request.threadId : p.id === "preassigned" ? randomUUID() : null;
    if (thread) args.push("--thread", thread);
    args.push("--model", request.model ?? "null-model", "--effort", request.effort ?? "high");
    if (request.verb === "review") args.push("--schema", request.schemaPath ?? "inline");
    if (request.verb === "task") args.push("--edit");
    const promptFile = p.input === "prompt-file" ? path.join(request.jobDir, "prompt.md") : null;
    const answerFile = p.output === "answer-file" ? path.join(request.jobDir, "answer.md") : null;
    if (promptFile) args.push("--prompt-file", promptFile);
    if (answerFile) args.push("--answer-file", answerFile);
    return { args, env: { ...request.env, ...depthEnv() }, ...(promptFile ? { promptFile } : { stdin: request.prompt }), answerFile,
      readOnly: request.verb !== "task", requestedThreadId: thread, contractCarrier: "stdin", agent: null };
  },
  beforeTurn(ctx) { hook("beforeTurn", ctx); },
  afterTurn(ctx, outcome) { hook("afterTurn", ctx, outcome); },
  parseEvent(line, state) {
    let event;
    try { event = JSON.parse(line); } catch { return { fatal: "malformed event" }; }
    if (typeof event?.type !== "string") return { fatal: "event without a type" };
    switch (event.type) {
      case "start": return { threadId: event.thread };
      case "text": return { textDelta: event.data };
      case "tool": return event.denied ? { denied: { tool: event.name, path: event.path } } : event.ok === false ? { failedCommand: event.command ?? event.name } : event.name === "edit" ? { edited: event.path, toolStep: event.name } : { toolStep: event.name };
      case "end": return { completed: true, threadId: event.thread, costUsd: event.cost, ...(event.structured ? { structured: event.structured } : {}) };
      default: return null;
    }
  },
  reviewPlan(gitInfo, request) { return { native: false, batches: gitInfo.batches, promptTemplate: request.adversarial ? "adversarial-review" : "review", schemaCarrier: "inline" }; },
  finalizeReview({ structured, unreviewed }) { return { structured, unreviewed }; },
};
