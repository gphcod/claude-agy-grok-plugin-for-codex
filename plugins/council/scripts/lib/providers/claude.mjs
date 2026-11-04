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
import { pathCandidates, resolveLauncher as resolveBinary, runSync } from "../core/launcher.mjs";
import { depthEnv } from "../core/host.mjs";
import { stateRootDescriptor } from "../core/preflight.mjs";

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
/** The static catalog (S1.6): aliases plus pass-through; Claude has no model listing. */
export const catalog = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, "models.json"), "utf8")).claude;

export const TESTED_VERSION = "2.1.314";
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
export const READ_TOOLS = ["Read", "Glob", "Grep"];
export const WEB_TOOLS = ["WebFetch", "WebSearch"];
/** Tools whose `tool_use` blocks name an edited path (A5.1); the core's workspace snapshots count Bash edits (S7.1). */
export const EDIT_TOOLS = ["Edit", "Write", "MultiEdit", "NotebookEdit"];
/** The S1.1 task launch (docs/decisions.md S1). */
export const TASK_TOOLS = [...READ_TOOLS, ...EDIT_TOOLS, "Bash"];
export const TASK_ALLOWED = [...EDIT_TOOLS, "Bash"];
export const TASK_DISALLOWED = [];
export const PERMISSION_MODE = "bypassPermissions";
/** A task whose init event offers no Bash finishes with this attention, so the caller learns no command could run. */
export const NO_SHELL = "Claude offered no shell tool, so this task cannot run commands; install Git for Windows or set CLAUDE_CODE_GIT_BASH_PATH";
/** `--max-turns` defaults by verb (A3.3). */
export const MAX_TURNS = Object.freeze({ review: 20, ask: 20, reply: 20, task: 30 });
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
/**
 * Inside a Git Bash shell the first git on PATH is Git for Windows' mingw copy, and Claude then misses Git Bash and drops
 * its Bash tool without saying so. Name it for the child in that one case; a value the caller set always stands.
 */
export function gitBashEnv(env, platform = process.platform) {
  if (platform !== "win32" || env.CLAUDE_CODE_GIT_BASH_PATH) return {};
  const [git] = pathCandidates("git", env, platform);
  const root = git && /^(.*)[\\/](?:mingw64|mingw32|clangarm64|ucrt64)[\\/]bin[\\/]git\.exe$/i.exec(git)?.[1];
  const bash = root && path.join(root, "bin", "bash.exe");
  return bash && fs.existsSync(bash) ? { CLAUDE_CODE_GIT_BASH_PATH: bash } : {};
}
/** The complete argument vector of one launch (CLAUDEX `buildClaudeArgs`, with the S1.1 task launch and council's flags). */
export function buildArgs(request, session) {
  const policy = request.policy ?? {};
  const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"];
  args.push(request.resume ? "--resume" : "--session-id", session);
  args.push("--system-prompt-snapshot", "on", "--append-system-prompt-file", request.contractPath, "--max-turns", String(request.maxTurns ?? MAX_TURNS[request.verb] ?? 20));
  if (request.effort) args.push("--effort", request.effort);
  if (request.model) args.push("--model", request.model); // null is `default`: the user's configured model, no flag
  if (request.maxBudgetUsd !== null && request.maxBudgetUsd !== undefined) args.push("--max-budget-usd", String(request.maxBudgetUsd));
  // Scope is the turn's instruction, not a tool fence. In particular Read/Glob/Grep
  // must work on the other repositories explicitly named in an ordinary question.
  args.push("--permission-mode", PERMISSION_MODE, "--permission-prompts", "none", "--setting-sources", "user,project,local");
  args.push("--tools", "default");
  if (policy.allowMcp === false) args.push("--mcp-config", EMPTY_MCP, "--strict-mcp-config");
  args.push("--settings", NO_HOOKS);
  for (const root of new Set([...(policy.readRoots ?? []), request.reviewRoot, request.reviewInputRoot].filter(Boolean))) args.push("--add-dir", root);
  if (request.structured && request.schemaPath) args.push("--json-schema", JSON.stringify(JSON.parse(fs.readFileSync(request.schemaPath, "utf8"))));
  return args;
}

const homeOf = (env) => env.HOME || env.USERPROFILE || os.homedir();
/** Claude's session storage, which every turn writes (CLAUDEX preflight `claudeStorage`). */
export const claudeStorage = (env) => path.join(path.resolve(env.CLAUDE_CONFIG_DIR || path.join(homeOf(env), ".claude")), "projects");
/** The capability probe's sentinel: a path that must not exist, stable so the cold result caches. */
export const sentinelOf = (stateRoot) => path.join(stateRoot, ".missing-capability-probe");

/** A denial in one shape, whatever produced it (CLAUDEX envelope.mjs `permissionDenials`). */
const denial = (d, reason) => ({ tool: d.tool_name || d.tool || d.name || "unknown", path: d.tool_input?.file_path || d.tool_input?.notebook_path || d.tool_input?.path || d.input?.file_path || d.path || null,
  input: d.tool_input || d.input || null, ...(d.tool_use_id ? { id: d.tool_use_id } : {}), ...(reason ? { reason } : {}) });
/** One entry per denied call: the same tool_use_id, or the same tool, path and input, is one denial. */
function dedupe(list) {
  const out = [], seen = new Set();
  for (const d of list) {
    const keys = [`t:${JSON.stringify([d.tool, d.path, d.input])}`, ...(d.id ? [`i:${d.id}`] : [])];
    if (keys.some((k) => seen.has(k))) continue;
    keys.forEach((k) => seen.add(k));
    out.push(d);
  }
  return out;
}
/** Claude's wording when a permission rule or the mode refuses a tool call (2.1.314: "... has been denied ..."). */
const DENIAL_TEXT = /No such tool available|\bhas been denied\b|\bpermission to use \S+.*\bdenied\b/i;
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
      stateRootDescriptor(ctx.stateRoot), // first for every provider (S1.4): the action line names council's own directory
      { kind: "process-table", target: (ctx.platform ?? process.platform) === "win32" ? "powershell Win32_Process" : "ps", timeoutMs: 20000, why: "process identity and cleanup",
        action: "Allow the process-table query before submitting Claude work; cleanup requires fresh process identity evidence." },
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
    return { args, env: { ...request.env, ...gitBashEnv(request.env ?? {}), ...depthEnv(), NO_COLOR: "1" }, stdin: requestLine(turnInput(request), session), answerFile: null, promptFile: null,
      readOnly: request.verb !== "task", requestedThreadId: session, agent: null, contractCarrier: "append-system-prompt-file" };
  },
  /**
   * S3.3. `state.adapter` is this turn's scratch, seeded by the lifecycle with the launch's `readOnly`; it also keeps the
   * init session, pending tool uses, denials and retries. Confirm the launched approval mode,
   * report observed edits and preserve actual provider denials.
   */
  parseEvent(line, state) {
    const s = state.adapter;
    s.pending ??= new Map(); s.denials ??= []; s.retries ??= 0;
    let ev;
    try { ev = JSON.parse(line); } catch { return { fatal: "malformed JSON in the Claude event stream" }; }
    if (!isMap(ev) || typeof ev.type !== "string") return { fatal: "malformed Claude event" };
    const readOnly = s.readOnly !== false;
    if (ev.type === "system" && ev.subtype === "init") {
      if (typeof ev.session_id !== "string" || !ev.session_id) return { fatal: "Claude init event without a session id" };
      if (s.session && s.session !== ev.session_id) return { fatal: "a second Claude init event names another session" };
      const launched = PERMISSION_MODE;
      if (ev.permissionMode !== launched) return { fatal: `Claude reports permission mode ${JSON.stringify(ev.permissionMode)}, not the launched ${launched}` };
      s.session = ev.session_id;
      return { threadId: ev.session_id, ...(typeof ev.model === "string" && ev.model ? { model: ev.model } : {}),
        ...(!readOnly && Array.isArray(ev.tools) && !ev.tools.some((tool) => tool === "Bash" || tool === "PowerShell") ? { incomplete: NO_SHELL } : {}) };
    }
    if (ev.type === "system" && ev.subtype === "api_retry") { s.retries += 1; s.lastRetry = ev.category || ev.error?.type || "unknown"; return null; }
    if (ev.type === "permission_denied") { s.denials.push(denial(ev)); return null; }
    if (ev.type === "assistant") {
      s.firstAssistantAt ??= Date.now();
      const uses = (Array.isArray(ev.message?.content) ? ev.message.content : []).filter((c) => c?.type === "tool_use");
      for (const use of uses) if (typeof use.id === "string") s.pending.set(use.id, { name: use.name, input: use.input ?? {} });
      return uses.length ? { toolStep: String(uses[0].name) } : null;
    }
    if (ev.type === "user") {
      const edited = [], out = {};
      for (const block of Array.isArray(ev.message?.content) ? ev.message.content : []) {
        if (block?.type !== "tool_result" || !s.pending.has(block.tool_use_id)) continue;
        const use = s.pending.get(block.tool_use_id);
        s.pending.delete(block.tool_use_id);
        const failed = block.is_error === true;
        const text = resultText(block.content);
        const call = { tool_name: use.name, tool_use_id: block.tool_use_id, tool_input: use.input };
        if (failed && DENIAL_TEXT.test(text)) {
          s.denials.push(denial(call, text.slice(0, 200)));
        } else if (EDIT_TOOLS.includes(use.name)) {
          if (!failed && pathOf(use.input)) edited.push(pathOf(use.input)); // a failed edit changed nothing
        } else if ((use.name === "Bash" || use.name === "PowerShell") && failed) {
          // A call a permission rule refused (--disallowedTools, outside --allowedTools) is a denial only, never also a failed command.
          const refused = DENIAL_TEXT.test(text) || s.denials.some((d) => (d.id && d.id === block.tool_use_id) || (d.tool === use.name && d.input?.command === use.input?.command));
          if (refused) s.denials.push(denial(call, text.slice(0, 200)));
          else if (!out.failedCommand) out.failedCommand = String(use.input?.command ?? "Bash");
        }
      }
      if (edited.length) out.edited = edited;
      return Object.keys(out).length ? out : null;
    }
    if (ev.type === "result") {
      if (s.result) return { fatal: "duplicate Claude result event" };
      s.result = true;
      if (typeof ev.session_id !== "string" || !ev.session_id) return { fatal: "malformed_result: the Claude result has no session id" };
      if (s.session && ev.session_id !== s.session) return { fatal: `the Claude result names session ${ev.session_id}, not ${s.session}` };
      if (typeof ev.subtype !== "string" || typeof ev.is_error !== "boolean") return { fatal: "malformed_result: the Claude result is missing subtype or is_error" };
      const denials = dedupe([...s.denials, ...(Array.isArray(ev.permission_denials) ? ev.permission_denials.map((d) => denial(d)) : [])]);
      const accounting = { ...(typeof ev.total_cost_usd === "number" ? { costUsd: ev.total_cost_usd } : {}),
        ...(isMap(ev.usage) ? { usage: { ...ev.usage, turns: ev.num_turns ?? null, retries: s.retries } } : {}) };
      if (ev.is_error || ev.subtype !== "success") {
        const detail = ev.terminal_reason || ev.subtype;
        const message = typeof ev.result === "string" && ev.result.trim() ? ev.result.trim() : JSON.stringify(ev.errors ?? [ev.subtype]);
        // A turn a denial made fail is a denial (exit 10), with the error text kept as its answer; otherwise it failed (exit 1).
        if (denials.length) return { threadId: ev.session_id, textDelta: `claude ${detail}: ${message}`, completed: true, denied: { count: denials.length, denials }, ...accounting };
        return { threadId: ev.session_id, fatal: `claude ${detail}: ${message}` };
      }
      const structured = isMap(ev.structured_output) ? ev.structured_output : null;
      const answer = structured ? JSON.stringify(structured) : typeof ev.result === "string" ? ev.result : null;
      if (answer === null) return { threadId: ev.session_id, fatal: "the Claude result has no answer text" };
      if (!answer.trim()) return { threadId: ev.session_id, fatal: "the Claude result is empty" };
      // An edit whose tool result never arrived may have happened: a task reports it.
      const unconfirmed = [...s.pending.values()].filter((u) => EDIT_TOOLS.includes(u.name) && pathOf(u.input)).map((u) => pathOf(u.input));
      return {
        threadId: ev.session_id, textDelta: answer, completed: true,
        ...(structured ? { structured } : {}), ...accounting,
        ...(denials.length ? { denied: { count: denials.length, denials } } : {}),
        ...(unconfirmed.length ? { edited: unconfirmed } : {}),
      };
    }
    return null; // rate_limit_event, system/thinking_tokens, stream events: nothing for the turn
  },
  reviewPlan(review, request) {
    return { native: false, batches: review?.batches, promptTemplate: request?.adversarial ? "adversarial-review" : "review", schemaCarrier: "flag" };
  },
  /** `structured_output` is authoritative; the answer text (the same JSON) is the fallback. The core validates and reconciles. */
  finalizeReview({ answerText, structured, unreviewed }) {
    if (!isMap(structured) && answerText) { try { structured = JSON.parse(answerText); } catch { structured = null; } }
    return { structured: isMap(structured) ? structured : null, unreviewed };
  },
};
