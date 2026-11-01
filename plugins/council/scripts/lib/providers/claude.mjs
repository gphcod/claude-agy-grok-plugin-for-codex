// The Claude Code adapter (S3, PLAN.md A5.1 claude). Ported from claude_plugin_for_codex 0.5.0: runtime.mjs:72-96
// (`buildClaudeArgs`, `requestLine`), engine.mjs (turn limits, budget), events.mjs:54-78 (`interpretEvent`: init and
// result session checks, duplicate result, denials, api retries), envelope.mjs:20-66 (`permissionDenials`,
// `streamOutcome`, `answerOf`: terminal checks and answer extraction) and preflight.mjs (`resolveExecutable`'s native-only
// rule, the four cold probes, the network check, Claude's storage directory). The answer comes only from the terminal
// `result` event (`structured_output` when present, else `result`), never from `assistant` events.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolveLauncher as resolveBinary, runSync } from "../core/launcher.mjs";
import { depthEnv } from "../core/host.mjs";

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
/** The static catalog (S1.6): aliases plus pass-through; Claude has no model listing. */
export const catalog = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, "models.json"), "utf8")).claude;

export const TESTED_VERSION = "2.1.314";
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
export const READ_TOOLS = ["Read", "Glob", "Grep"];
export const WEB_TOOLS = ["WebFetch", "WebSearch"];
/** Tools whose `tool_use` blocks name an edited path (A5.1); Bash edits are reported by Claude in its answer. */
export const EDIT_TOOLS = ["Edit", "Write", "MultiEdit", "NotebookEdit"];
/** The S1.1 task launch (docs/decisions.md S1). */
export const TASK_TOOLS = [...READ_TOOLS, ...EDIT_TOOLS, "Bash"];
export const TASK_ALLOWED = [...EDIT_TOOLS, "Bash"];
export const TASK_DISALLOWED = ["Bash(git push*)", "Bash(git reset --hard*)", "Bash(rm -rf *)", "Bash(sudo *)"];
/** Tools a read-only launch must never advertise in its init event. */
const MUTATING = [...EDIT_TOOLS, "Bash"];
/** `--max-turns` defaults by verb (A3.3). */
export const MAX_TURNS = Object.freeze({ review: 2, ask: 20, reply: 20, task: 30 });
export const EMPTY_MCP = '{"mcpServers":{}}';
export const NO_HOOKS = '{"disableAllHooks":true}';
/** The serialized stdin line's cap (CLAUDEX runtime.mjs LIMITS.requestBytes). */
export const REQUEST_BYTES = 8_000_000;
/** Flags `claude --help` must list (CLAUDEX REQUIRED_FLAGS without `--fork-session`, which council does not use). */
export const REQUIRED_FLAGS = ["--input-format", "--output-format", "--verbose", "--session-id", "--resume", "--permission-mode", "--permission-prompts", "--tools",
  "--allowedTools", "--disallowedTools", "--mcp-config", "--strict-mcp-config", "--no-chrome", "--settings", "--setting-sources", "--effort", "--json-schema",
  "--max-budget-usd", "--system-prompt-snapshot", "--add-dir", "--model"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** One NDJSON user message, then EOF (CLAUDEX runtime.mjs `requestLine`). */
export function requestLine(content, session) {
  const line = `${JSON.stringify({ type: "user", session_id: session, message: { role: "user", content }, parent_tool_use_id: null })}\n`;
  if (Buffer.byteLength(line) > REQUEST_BYTES) throw new Error(`the serialized Claude input exceeds ${REQUEST_BYTES} UTF-8 bytes; send less text`);
  return line;
}
/** The turn's input: the per-verb template, then the text; a review or discussion prompt already carries its instructions. */
export function turnInput(request) {
  return request.instructions ? `${request.instructions.trim()}\n\n${request.prompt}` : request.prompt;
}
/** The complete argument vector of one launch (CLAUDEX `buildClaudeArgs`, with the S1.1 task launch and council's flags). */
export function buildArgs(request, session) {
  const readOnly = request.verb !== "task";
  const policy = request.policy ?? {};
  const web = Boolean(request.web || policy.web);
  const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"];
  args.push(request.resume ? "--resume" : "--session-id", session);
  args.push("--system-prompt-snapshot", "on", "--append-system-prompt-file", request.contractPath, "--max-turns", String(request.maxTurns ?? MAX_TURNS[request.verb] ?? 20));
  if (request.effort) args.push("--effort", request.effort);
  if (request.model) args.push("--model", request.model); // null is `default`: the user's configured model, no flag
  if (request.maxBudgetUsd !== null && request.maxBudgetUsd !== undefined) args.push("--max-budget-usd", String(request.maxBudgetUsd));
  args.push("--permission-mode", readOnly ? "dontAsk" : "acceptEdits", "--permission-prompts", "none", "--setting-sources", "user");
  const tools = [...(readOnly ? READ_TOOLS : TASK_TOOLS), ...(web ? WEB_TOOLS : [])];
  const allowed = [...(readOnly ? [] : TASK_ALLOWED), ...(web ? WEB_TOOLS : [])];
  args.push("--tools", tools.join(","));
  if (!policy.allowMcp) args.push("--mcp-config", EMPTY_MCP, "--strict-mcp-config");
  args.push("--settings", NO_HOOKS, "--no-chrome");
  for (const root of policy.readRoots ?? []) args.push("--add-dir", root);
  if (request.structured && request.schemaPath) args.push("--json-schema", JSON.stringify(JSON.parse(fs.readFileSync(request.schemaPath, "utf8"))));
  // --allowedTools and --disallowedTools are variadic, so they come last (docs/spike/claude.md).
  if (allowed.length) args.push("--allowedTools", allowed.join(","));
  if (!readOnly) args.push("--disallowedTools", ...TASK_DISALLOWED);
  return args;
}

const homeOf = (env) => env.HOME || env.USERPROFILE || os.homedir();
/** Claude's session storage, which every turn writes (CLAUDEX preflight `claudeStorage`). */
export const claudeStorage = (env) => path.join(path.resolve(env.CLAUDE_CONFIG_DIR || path.join(homeOf(env), ".claude")), "projects");
/** The capability probe's sentinel: a path that must not exist, stable so the cold result caches. */
export const sentinelOf = (stateRoot) => path.join(stateRoot, ".missing-capability-probe");

/** A denial in one shape, whatever produced it (CLAUDEX envelope.mjs `permissionDenials`). */
const denial = (d, reason) => ({ tool: d.tool_name || d.tool || d.name || "unknown", path: d.tool_input?.file_path || d.tool_input?.notebook_path || d.tool_input?.path || d.input?.file_path || d.path || null,
  input: d.tool_input || d.input || null, ...(reason ? { reason } : {}) });
const dedupe = (list) => [...new Map(list.map((d) => [JSON.stringify([d.tool, d.path, d.input]), d])).values()];
const pathOf = (input) => input?.file_path ?? input?.notebook_path ?? null;
const resultText = (content) => typeof content === "string" ? content : Array.isArray(content) ? content.map((c) => c?.text ?? "").join("") : "";
const isMap = (v) => v && typeof v === "object" && !Array.isArray(v);

export default {
  id: "claude",
  binEnv: "COUNCIL_CLAUDE_BIN",
  catalog,
  maxLineBytes: 16 * 1024 * 1024, // CLAUDEX LIMITS.eventBytes: a structured review result is one line
  /** PATH must give the native executable; a configured COUNCIL_CLAUDE_BIN may name a .js/.mjs/.cjs entry (A2). */
  resolveLauncher(env = process.env, platform = process.platform) {
    return resolveBinary({ name: "claude", binEnv: "COUNCIL_CLAUDE_BIN", env, platform, nativeOnly: true });
  },
  /** No launcher kind is qualified yet (S7): every exit is followed by the post-exit scan. */
  trustsCleanExit() { return false; },
  /** Ownership evidence: the launch's --session-id or --resume uuid operand, as recorded in the job's child arguments. */
  ownsProcess(row, job, platform = process.platform, hasFlagOperand) {
    const args = job.childArgs ?? [];
    const recorded = ["--session-id", "--resume"].map((flag) => [flag, args[args.indexOf(flag) + 1]]).filter(([flag, v]) => args.includes(flag) && UUID.test(v ?? ""));
    const pairs = recorded.length ? recorded : ["--session-id", "--resume"].flatMap((flag) => [job.threadId, job.requestedThreadId].filter((v) => UUID.test(v ?? "")).map((v) => [flag, v]));
    return pairs.some(([flag, value]) => hasFlagOperand(row, flag, value, platform));
  },
  /** Non-billable: `--version` and `auth status --json` (only `loggedIn` is read; the account fields are never kept). */
  async probe(launcher = this.resolveLauncher(), env = process.env) {
    const version = runSync(launcher, ["--version"], { env });
    const auth = runSync(launcher, ["auth", "status", "--json"], { env });
    let loggedIn = null;
    try { loggedIn = JSON.parse(auth.stdout).loggedIn === true; } catch { loggedIn = auth.status === 0 ? null : false; }
    const found = /\d+\.\d+\.\d+/.exec(`${version.stdout ?? ""}`)?.[0] ?? null;
    const warnings = found && found !== TESTED_VERSION ? [`Claude Code ${found} is untested; council was qualified against ${TESTED_VERSION}`] : [];
    return { version: version.status === 0 ? (version.stdout ?? "").trim() : null, loggedIn, models: null, warnings };
  },
  /**
   * S3.1: Claude's storage (write), the state root (write), the network (CLAUDEX's check) and the four cold probes
   * (`--version`, `auth status --json`, `--help`, the missing-file capability probe), cached by executable.
   */
  preflight(ctx) {
    const env = ctx.env ?? process.env;
    const launcher = this.resolveLauncher(env, ctx.platform ?? process.platform);
    const storage = claudeStorage(env);
    const endpoint = env.ANTHROPIC_BASE_URL || "https://api.anthropic.com";
    const exec = (args, extra) => ({ command: launcher?.command ?? "claude", args: [...(launcher?.args ?? []), ...args], ...extra });
    return [
      { kind: "dir", target: ctx.stateRoot, access: "write", timeoutMs: 1000, why: "council job records", action: "Set COUNCIL_CODEX_HOME to a writable directory outside the workspace." },
      { kind: "dir", target: storage, access: "write", timeoutMs: 1000, why: "Claude session storage",
        action: `Grant write access to ${storage}; Claude Code stores every session there (escalate only if the host allows it).` },
      { kind: "exec", target: exec(["--version"], { expectText: "\\d+\\.\\d+\\.\\d+" }), timeoutMs: 15000, why: "claude --version", action: "Install Claude Code, then run setup." },
      { kind: "exec", target: exec(["auth", "status", "--json"], { expectText: '"loggedIn":\\s*true', recordOutput: false }), timeoutMs: 15000, why: "Claude login",
        action: "Run claude auth login, then setup." },
      { kind: "exec", target: exec(["--help"], { expectText: `^${REQUIRED_FLAGS.map((f) => `(?=[\\s\\S]*${escape(f)}\\b)`).join("")}` }), timeoutMs: 15000, why: "Claude flags",
        action: "Install a Claude Code version that supports every flag council passes, then run setup." },
      // Hidden flags: a missing-file parse failure proves --append-system-prompt-file and --max-turns without a model call.
      { kind: "exec", target: exec(["-p", "--append-system-prompt-file", sentinelOf(ctx.stateRoot), "--max-turns", "1", "--tools", "", "--permission-mode", "dontAsk", "--permission-prompts", "none",
        "--mcp-config", EMPTY_MCP, "--strict-mcp-config", "--no-chrome", "--settings", NO_HOOKS], { expectStatus: 1, expectText: "Append system prompt file not found" }),
        timeoutMs: 15000, why: "Claude hidden flags", action: "Install a Claude Code version that accepts --append-system-prompt-file and --max-turns, then run setup." },
      { kind: "network", target: endpoint, timeoutMs: 8000, why: "Anthropic API", action: `Restore network/proxy/certificate access to ${new URL(endpoint).origin}; escalate only if the host allows it. Do not resubmit model work.` },
    ];
  },
  /** Refusals before any job record (exit 2): the effort vocabulary (the CLI ignores an unknown value), argv-safe model ids, a resumable uuid. */
  checkRequest(request) {
    if (request.effort !== undefined && request.effort !== null && !EFFORTS.includes(request.effort)) return `claude accepts --effort ${EFFORTS.join("|")}; got ${request.effort}`;
    if (request.model && (/^-/.test(request.model) || /\s/.test(request.model))) return `invalid claude model id ${JSON.stringify(request.model)}`;
    if (request.allowCommands?.length) return "--allow-command applies only to gemini";
    if (request.resume && !UUID.test(request.threadId ?? "")) return `claude resumes only a full session uuid; got ${JSON.stringify(request.threadId)}`;
    return null;
  },
  buildTurn(request) {
    const session = request.resume ? String(request.threadId).toLowerCase() : randomUUID();
    const args = buildArgs(request, session);
    return { args, env: { ...request.env, ...depthEnv(), NO_COLOR: "1" }, stdin: requestLine(turnInput(request), session), answerFile: null, promptFile: null,
      readOnly: request.verb !== "task", requestedThreadId: session, agent: null, contractCarrier: "append-system-prompt-file" };
  },
  parseEvent() { return { fatal: "claude parseEvent arrives in S3.3" }; },
  reviewPlan() { return { native: false, promptTemplate: "review", schemaCarrier: "flag" }; },
  finalizeReview() { return null; },
};
