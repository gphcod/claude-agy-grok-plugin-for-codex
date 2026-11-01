// Gemini adapter (S5): the Antigravity CLI `agy` behind the A5 interface. Ported from gemini-plugin-for-codex 0.1.2
// (MIT, NOTICE): lib/native.mjs (launch arguments, the `denial` regex, the stdin message, the 4 MiB caps),
// lib/settings.mjs (`configuredPolicy`, `sessionSettings`), lib/outcome.mjs (`classify`: terminal-result rules) and
// lib/snapshot.mjs (the bounded before/after Git snapshots, made synchronous here). Process supervision, the run store
// and `result`/`release`/`prune` are council's core. Changes from the donor are listed in docs/parity/gemini.md.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { resolveLauncher as findLauncher, runSync } from "../core/launcher.mjs";
import { depthEnv } from "../core/host.mjs";
import { loadStatic, parseModelListing } from "../core/catalog.mjs";
import { writeFileAtomic } from "../core/fs.mjs";

export const BINARY = "agy";
export const BIN_ENV = "COUNCIL_AGY_BIN";
/** Frame, partial-answer and settings caps (AGYX native.mjs LIMIT, settings.mjs 2 MiB). */
export const LIMIT = 4 * 1024 * 1024;
const SETTINGS_CAP = 2 * 1024 * 1024;
/** A8: Gemini is qualified on macOS only until S7 qualifies Windows. */
export const WINDOWS_UNSUPPORTED = "gemini (agy) is not supported on Windows in this release (A8): only macOS is qualified; use --to claude or --to grok";
/** The deny-rule / approval signature on a tool step (A2; AGYX native.mjs `denial`). */
export const DENIAL = /permission (?:check failed|denied)|approval (?:required|denied)|user.configured deny/i;
/** Tools that write files (AGYX `denial`'s write list). */
const WRITE_TOOLS = /^(write_file|edit_file|write_to_file|replace_file_content|multi_replace_file_content|notebook_edit)$/;
/** Rules added on every read-only turn (A5.1: the donor's list plus gemini-plugin-cc's `edit_file(*)`). */
export const READ_ONLY_DENY = ["write_file(*)", "edit_file(*)", "command(*)", "unsandboxed(*)", "mcp(*)", "execute_url(*)"];
const READ_ONLY_ALLOW = /^(read_file|read_url)\(.*\)$/;
const SUFFIX = /-(low|medium|high)$/;
/** Snapshot bounds (AGYX snapshot.mjs defaults). */
export const SNAPSHOT = Object.freeze({ maxFiles: 500, maxBytes: 4 * 1024 * 1024, timeoutMs: 2500 });

const homeOf = (env = {}) => env.HOME || env.USERPROFILE || os.homedir();
/** `<HOME>/.gemini/antigravity-cli`: agy's backend state, which it writes even on read-only turns (AGYX docs/P0.md). */
export const stateDir = (env) => path.join(homeOf(env), ".gemini", "antigravity-cli");
export const globalSettingsFile = (env) => path.join(stateDir(env), "settings.json");
const clip = (text, bytes) => { const b = Buffer.from(String(text)); return b.length <= bytes ? String(text) : b.subarray(0, bytes).toString("utf8").replace(/�$/, ""); };
const sha = (data) => createHash("sha256").update(data).digest("hex");
const uniq = (list) => [...new Set(list)];

// ---------------------------------------------------------------------------------------------------------------------
// Settings (AGYX settings.mjs): the per-job file built from the user's global lists, because a session file's
// allow/ask/deny arrays and toolPermission replace the global ones (S1.2, the twin's scratch-HOME probe).

function lists(settings = {}) {
  const value = settings.permissions;
  if (value !== undefined && (!value || typeof value !== "object" || Array.isArray(value))) throw new Error("global agy settings: permissions must be an object");
  return Object.fromEntries(["allow", "ask", "deny"].map((key) => {
    const items = value?.[key] ?? [];
    if (!Array.isArray(items) || items.some((item) => typeof item !== "string")) throw new Error(`global agy settings: permissions.${key} must be a string array`);
    return [key, items];
  }));
}
/** The user's global permission lists and toolPermission; never credentials or other keys. A missing file is `{}`. */
export function configuredPolicy(file) {
  let text;
  try {
    if (fs.statSync(file).size > SETTINGS_CAP) throw new Error(`${file} exceeds 2 MiB; no turn submitted`);
    text = fs.readFileSync(file, "utf8");
  } catch (error) { if (error.code === "ENOENT") return {}; throw error; }
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(`${file} is invalid JSON; no turn submitted`); }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error(`${file} must contain a JSON object; no turn submitted`);
  return { permissions: lists(data), toolPermission: data.toolPermission };
}
/**
 * The session settings of one turn (A5.1). Read-only: allow filtered to read_file/read_url, the six deny rules added,
 * agentMode "" and toolPermission strict (kept) or request-review. Task: the global lists kept, `command(X)` and
 * `unsandboxed(X)` added per --allow-command, which forces request-review unless the global value is strict; without
 * --allow-command the global toolPermission is preserved.
 */
export function sessionSettings({ readOnly, allowCommands = [] }, configured = {}) {
  const original = lists(configured);
  const permissions = { allow: uniq(original.allow), ask: uniq(original.ask), deny: uniq(original.deny) };
  const settings = { permissions };
  const strict = configured.toolPermission === "strict";
  if (readOnly) {
    permissions.allow = permissions.allow.filter((rule) => READ_ONLY_ALLOW.test(rule));
    permissions.deny = uniq([...permissions.deny, ...READ_ONLY_DENY]);
    Object.assign(settings, { agentMode: "", toolPermission: strict ? "strict" : "request-review" });
  } else if (allowCommands.length) {
    permissions.allow = uniq([...permissions.allow, ...allowCommands.flatMap((value) => [`command(${value})`, `unsandboxed(${value})`])]);
    settings.toolPermission = strict ? "strict" : "request-review";
  } else if (configured.toolPermission !== undefined) settings.toolPermission = configured.toolPermission;
  return settings;
}
/** An --allow-command value that keeps the `command(X)` rule well formed: one line, no parentheses. */
export function allowCommandProblem(value) {
  if (typeof value !== "string" || !value.trim()) return "--allow-command needs a non-empty command";
  if (/[\r\n\0]/.test(value)) return "--allow-command takes one line";
  if (/[()]/.test(value)) return `--allow-command ${JSON.stringify(value)}: parentheses would break agy's command(X) rule`;
  return null;
}

// ---------------------------------------------------------------------------------------------------------------------
// The adapter.

/** Gemini's static catalog entry (models.json); the entry merges the refreshed listing itself. */
export const catalog = loadStatic().gemini;

/** The `--print-timeout` value: the deadline less a margin for the graceful partial result (AGYX native.mjs). */
export function printTimeout(deadlineMs = 14400 * 1000) {
  const seconds = Math.max(0.1, (deadlineMs - Math.min(3000, deadlineMs / 3)) / 1000);
  return `${Number(seconds.toFixed(3))}s`;
}
/** The user message on stdin: the standing contract, the turn's instructions, then the text (A5.1). */
export function stdinMessage(request) {
  const contract = request.contractPath ? fs.readFileSync(request.contractPath, "utf8").trimEnd() : "";
  const content = [contract, request.instructions?.trimEnd(), request.prompt].filter((part) => typeof part === "string" && part.trim()).join("\n\n");
  return `${JSON.stringify({ event: "user", message: { content } })}\n`;
}

const adapter = {
  id: "gemini",
  binEnv: BIN_ENV,
  catalog,
  maxLineBytes: LIMIT,
  resolveLauncher(env = {}, platform = process.platform) {
    return findLauncher({ name: BINARY, binEnv: BIN_ENV, env, platform });
  },
  trustsCleanExit() { return false; },
  /** Ownership evidence: the job's own `--settings <job-dir>/settings.json` operand. */
  ownsProcess(row, job, platform, hasFlagOperand) {
    const at = job.childArgs?.indexOf("--settings") ?? -1;
    const settings = at >= 0 ? job.childArgs[at + 1] : null;
    return Boolean(settings) && hasFlagOperand(row, "--settings", settings, platform);
  },
  /** Non-billable: `--version` and `models` (authentication evidence); warnings for setup (A3.2). */
  async probe(launcher = this.resolveLauncher(), env = {}, platform = process.platform) {
    const version = runSync(launcher, ["--version"], { env });
    const listing = runSync(launcher, ["models"], { env, timeoutMs: 30000 });
    const parsed = listing.status === 0 ? parseModelListing("gemini", listing.stdout) : null;
    const models = parsed && Object.keys(parsed.models).length ? Object.entries(parsed.models).map(([id, efforts]) => ({ id, efforts })) : null;
    const warnings = [];
    if (platform === "win32") warnings.push(WINDOWS_UNSUPPORTED);
    try {
      if (configuredPolicy(globalSettingsFile(env)).toolPermission === "always-proceed") {
        warnings.push("Gemini tasks without --allow-command run any command: the global agy toolPermission is always-proceed");
      }
    } catch (error) { warnings.push(`global agy settings unreadable, so no Gemini turn can start: ${error.message}`); }
    return { version: version.status === 0 ? version.stdout.trim() : null, loggedIn: listing.status === 0, models, warnings };
  },
  /** Resources agy needs inside the Codex sandbox (A2, AGYX docs/P0.md); none on Windows, where checkRequest refuses. */
  preflight(ctx) {
    const env = ctx.env ?? {};
    if (ctx.platform === "win32") return [];
    const launcher = (() => { try { return this.resolveLauncher(env, ctx.platform); } catch { return null; } })();
    const sandbox = "Run Codex with a sandbox that allows it (danger-full-access), or run the call outside the sandbox; the line grants no escalation.";
    return [
      { kind: "dir", target: stateDir(env), access: "write", timeoutMs: 1000, why: "agy backend state (~/.gemini/antigravity-cli)", action: `Grant write access to ${stateDir(env)}. ${sandbox}` },
      { kind: "dir", target: ctx.stateRoot, access: "write", timeoutMs: 1000, why: "council job records", action: "Set COUNCIL_CODEX_HOME to a writable directory outside the workspace." },
      // COUNCIL_AGY_LISTEN_HOST is a diagnostic seam (tests bind an unassignable address to prove the blocked path).
      { kind: "listener", target: env.COUNCIL_AGY_LISTEN_HOST || "127.0.0.1", timeoutMs: 2000, why: "agy's loopback listener", action: `Allow a loopback listener. ${sandbox}` },
      { kind: "process-table", target: "ps", timeoutMs: 20000, why: "process inspection for cleanup", action: `Allow the process query (ps). ${sandbox}` },
      ...(launcher ? [
        { kind: "exec", target: { command: launcher.command, args: [...launcher.args, "--version"], expectText: "\\d+\\.\\d+" }, timeoutMs: 15000, why: "agy version probe", action: "Install agy or set COUNCIL_AGY_BIN." },
        { kind: "exec", target: { command: launcher.command, args: [...launcher.args, "models"], expectText: "gemini-" }, timeoutMs: 30000, why: "agy model listing (login evidence)", action: "Run agy once to sign in, then retry." },
      ] : []),
      { kind: "network", target: "https://generativelanguage.googleapis.com/", timeoutMs: 8000, why: "network access to the Gemini backend", action: `Allow network access. ${sandbox}` },
    ];
  },
  /** Refusals before any job record (exit 2): Windows (A8), --web (A3.3), --allow-command outside tasks or malformed. */
  checkRequest(request, env = {}, platform = process.platform) {
    if (platform === "win32") return WINDOWS_UNSUPPORTED;
    if (request.web) return "--web is not offered for gemini: its read-only turns cannot switch web search off (S1.2)";
    const commands = request.allowCommands ?? [];
    if (commands.length && request.verb !== "task") return "--allow-command applies only to task --to gemini";
    for (const value of commands) { const problem = allowCommandProblem(value); if (problem) return problem; }
    return null;
  },
  buildTurn(request) {
    if (process.platform === "win32") throw new Error(WINDOWS_UNSUPPORTED);
    const env = request.env ?? {};
    const readOnly = request.verb !== "task";
    const settings = sessionSettings({ readOnly, allowCommands: readOnly ? [] : request.allowCommands ?? [] }, configuredPolicy(globalSettingsFile(env)));
    const settingsPath = path.join(request.jobDir, "settings.json");
    fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
    const args = ["--input-format", "stream-json", "--output-format", "stream-json", "--disable-slash-commands", "--print-timeout", printTimeout(request.deadlineMs), "--sandbox",
      "--settings", settingsPath];
    // A suffixed id carries its effort and travels alone; a family id takes --effort (A5.1).
    const suffix = request.model ? SUFFIX.exec(request.model)?.[1] : null;
    if (request.model) args.push("--model", request.model);
    if (request.effort && !(suffix && request.effort === suffix)) args.push("--effort", request.effort);
    if (request.resume && request.threadId) args.push("--conversation", request.threadId);
    if (request.structured && request.schemaPath) args.push("--json-schema", request.schemaPath);
    if (!readOnly) args.push("--mode", "accept-edits");
    return { args, env: { ...env, ...depthEnv() }, stdin: stdinMessage(request), answerFile: null, readOnly, requestedThreadId: null, agent: null, contractCarrier: "stdin" };
  },
  parseEvent() { return { fatal: "gemini events arrive in S5.3" }; },
  reviewPlan() { throw new Error("gemini reviews arrive in S5.4"); },
  finalizeReview() { throw new Error("gemini reviews arrive in S5.3"); },
};

export default adapter;
