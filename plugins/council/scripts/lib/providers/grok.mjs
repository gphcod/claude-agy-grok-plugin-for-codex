// The Grok adapter (S4): A5 over the Grok CLI 1.0.70. Ported from grok_plugin_for_codex 1.1.0: `recipe()` and `compatEnv()`
// from lib/recipes.mjs (whole), the launch argv from grok.mjs `makeTurn` (A5.1), the catalogue guard, session confirmation,
// edit paths, stop reason, cost and usage from lib/reader.mjs (now parseEvent), `parseModels` and the tier warnings from
// lib/setup.mjs, the prompt-file ownership operand from lib/execution.mjs. Review batching, the schema validator, the
// ledger and coverage are the core's (S2.5); this module only carries the schema inline and returns the structured answer.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveLauncher as resolveBinary, runSync } from "../core/launcher.mjs";
import { loadStatic, parseModelListing } from "../core/catalog.mjs";
import { loadTiers } from "../core/tiers.mjs";
import { reviewProblem } from "../core/review-validate.mjs";

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SCHEMA_PATH = path.join(PLUGIN_ROOT, "schemas", "review-output.schema.json");
export const BIN_ENV = "COUNCIL_GROK_BIN";
/** GROKX reader LINE_CAP. */
export const LINE_CAP = 1024 * 1024;
const PATH_CAP = 10000;

// ---- lib/recipes.mjs (grok_plugin_for_codex 1.1.0), ported whole ----
// Grok argv per access mode. The read-only guard itself is parseEvent's check of the advertised catalogue against
// FORBIDDEN; these flags only shape it.
export const HOSTILE = ["Agent", "ask_user_question", "enter_plan_mode", "exit_plan_mode", "image_gen", "image_edit", "image_to_video", "reference_to_video"];
// search_tool and use_tool are the default agent's way to MCP and other deferred tools.
export const FORBIDDEN = ["search_replace", "write", "run_terminal_command", "spawn_subagent", "search_tool", "use_tool"];
// Fallback for a session that runs the default agent (it has written) and cannot switch to explore: the verified
// read-only denylist. Grok removes the shell only by its flag id, run_terminal_cmd; its event name is listed too.
export const RESUME_DENY = [
  "search_replace",
  "write",
  "run_terminal_cmd", "run_terminal_command",
  "search_tool",
  "use_tool",
  "todo_write",
  "monitor",
  "workflow",
  "scheduler_create",
  "scheduler_delete",
  "scheduler_list",
  "send_feedback",
  ...HOSTILE,
];
// Read-only turns also deny every MCP tool; parseEvent's guard stays the check.
const NO_MCP = ["--deny", "MCPTool(*)"];

/** `agent` is the Grok agent the turn runs; the job and thread record keep it so later turns on the session follow it. */
export function recipe(kind, { web = false, defaultAgent = false } = {}) {
  const common = ["--always-approve", "--no-subagents", ...(web ? [] : ["--disable-web-search"]), "--disallowed-tools"];
  if (kind === "read-only") {
    if (defaultAgent) return { readOnly: true, agent: "default", args: [...common, RESUME_DENY.join(","), ...NO_MCP], forbidden: FORBIDDEN };
    return { readOnly: true, agent: "explore", args: ["--agent", "explore", ...common, HOSTILE.join(","), ...NO_MCP], forbidden: FORBIDDEN };
  }
  if (kind === "write") {
    return { readOnly: false, agent: "default", args: [...common, HOSTILE.join(","), "--deny", "Bash(git push*)", "--deny", "Bash(rm -rf *)"], forbidden: [] };
  }
  throw new Error(`unknown recipe ${kind}`);
}

/**
 * Child environment. Claude skills, agents, hooks and MCP stay off inside Grok (hook recursion); read-only turns also
 * skip Claude's rules directories; a task drops an inherited disabled setting so Grok's default applies. The guard
 * variables Grok's own plugins read (GROK_CODEX_DEPTH, GROK_BUILD_DEPTH) and COUNCIL_DEPTH are set here; the core adds
 * all five (A5.1).
 */
export function compatEnv(base, readOnly) {
  const env = {
    ...base,
    GROK_DISABLE_AUTOUPDATER: "1",
    GROK_CLAUDE_SKILLS_ENABLED: "0",
    GROK_CLAUDE_AGENTS_ENABLED: "0",
    GROK_CLAUDE_HOOKS_ENABLED: "0",
    GROK_CLAUDE_MCPS_ENABLED: "0",
    GROK_CODEX_DEPTH: "1",
    GROK_BUILD_DEPTH: "1",
    COUNCIL_DEPTH: "1",
  };
  if (readOnly) env.GROK_CLAUDE_RULES_ENABLED = "0";
  else delete env.GROK_CLAUDE_RULES_ENABLED;
  return env;
}

// ---- lib/setup.mjs ----
/** `grok models` text: a login line, then `* model (default)` / `- model` rows. */
export function parseModels(text) {
  const models = [], denied = [];
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^\s*[-*]\s+(\S+)/.exec(line);
    if (m) models.push(m[1]);
    else if (/not authenticated|not logged in/i.test(line)) denied.push(line.trim());
  }
  return { models, loggedIn: !denied.length, denied: denied[0] ?? null };
}
const firstLine = (run) => (run.stderr || run.stdout || run.error?.message || `exit ${run.status}`).trim().split(/\r?\n/)[0];

// ---- grok.mjs ----
/** Grok trims the edges of its input, so text with whitespace at either edge is framed (GROKX `framePrompt`). */
export function framePrompt(text, tag) {
  return /^\s|\s$/.test(text) ? `<r-${tag}>\n${text}\n</r-${tag}>` : text;
}
/** The standing contract on one line: argv carries it, and nothing in it needs a newline (GROKX). */
export const contractText = (file) => fs.readFileSync(file, "utf8").replace(/\s*\r?\n\s*/g, " ").trim();
/** The repository review schema, inline (A5.2: Grok receives it as a `--json-schema` operand). */
export const schemaText = (file = SCHEMA_PATH) => JSON.stringify(JSON.parse(fs.readFileSync(file, "utf8")));
const homeOf = (env, platform) => (platform === "win32" ? env.USERPROFILE : env.HOME) || null;
/** Grok's login evidence (S1.3): `~/.grok/auth.json` under the per-call environment's home, unless GROK_API_KEY is set. */
export const loginFile = (env, platform = process.platform) => { const home = homeOf(env, platform); return home ? path.join(home, ".grok", "auth.json") : null; };
const realOr = (p) => { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } };
function gitTop(cwd, env) {
  const r = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, env, encoding: "utf8", shell: false, windowsHide: true, timeout: 15000 });
  return r.status === 0 ? r.stdout.trim() : null;
}

export default {
  id: "grok",
  binEnv: BIN_ENV,
  catalog: loadStatic().grok,
  maxLineBytes: LINE_CAP,
  /** COUNCIL_GROK_BIN, then PATH, then `~/.grok/bin/grok.exe` on Windows (GROKX launcher). */
  resolveLauncher(env = process.env, platform = process.platform) {
    return resolveBinary({ name: "grok", binEnv: BIN_ENV, env, platform,
      nativeFallback: platform === "win32" ? (home) => (home ? path.join(home, ".grok", "bin", "grok.exe") : null) : null });
  },
  /** No Grok launcher is qualified to end every holder of the turn's operands on a clean exit: always scan (A5.1). */
  trustsCleanExit() { return false; },
  /** Ownership evidence: the exact `--prompt-file` operand recorded at launch (GROKX `ownsExecution`). */
  ownsProcess(row, job, platform = process.platform, hasFlagOperand) {
    const args = job.childArgs ?? [];
    const at = args.indexOf("--prompt-file");
    const operand = job.promptFile ?? (at >= 0 ? args[at + 1] : null);
    return Boolean(operand) && hasFlagOperand(row, "--prompt-file", operand, platform);
  },
  /** Non-billable: `--version` and `grok models` (parseModels); a tier model missing from the listing is a warning (GROKX setup.mjs). */
  async probe(launcher = this.resolveLauncher(), env = process.env) {
    const warnings = [];
    const version = runSync(launcher, ["--version"], { env });
    if (version.status !== 0) { warnings.push(`grok --version failed: ${firstLine(version)}`); return { version: null, loggedIn: null, models: null, warnings }; }
    const listing = runSync(launcher, ["models"], { env, timeoutMs: 30000 });
    const versionText = version.stdout.trim().split(/\r?\n/)[0];
    if (listing.status !== 0) { warnings.push(`grok models failed: ${firstLine(listing)}`); return { version: versionText, loggedIn: null, models: null, warnings }; }
    const parsed = parseModels(listing.stdout);
    if (!parsed.loggedIn) warnings.push(`Grok is not logged in (grok models: "${parsed.denied}"): run \`grok\` once and complete login`);
    const listed = parseModelListing("grok", listing.stdout)?.models ?? {};
    const models = Object.entries(listed).map(([id, efforts]) => ({ id, efforts }));
    if (parsed.loggedIn) {
      for (const [name, { model }] of Object.entries(loadTiers().grok ?? {})) if (!parsed.models.includes(model)) warnings.push(`tier ${name}: model ${model} is not in \`grok models\``);
    }
    return { version: versionText, loggedIn: parsed.loggedIn, models: parsed.loggedIn ? models : null, warnings };
  },
  /**
   * The resources a Grok turn needs (A5.1, S1.3): the login file (read; skipped under GROK_API_KEY), the state root
   * (write), the process-table query, then the two cached cold probes (`--version`, `models`). A sandbox that hides the
   * login or the query fails before spawn with `preflight_blocked` naming the resource.
   */
  preflight(ctx) {
    const env = ctx.env ?? process.env, platform = ctx.platform ?? process.platform;
    const out = [];
    if (!env.GROK_API_KEY) {
      const file = loginFile(env, platform);
      out.push({ kind: "file", target: file ?? path.join("~", ".grok", "auth.json"), access: "read", timeoutMs: 1000, why: "Grok login file",
        action: `Grant read access to ${file ?? "~/.grok/auth.json"} (or set GROK_API_KEY); if the host forbids escalation, stop without retrying. If the file is absent, run \`grok\` once and log in.` });
    }
    out.push({ kind: "dir", target: ctx.stateRoot, access: "write", timeoutMs: 1000, why: "council job records",
      action: "Grant write access to the council state root, or set COUNCIL_CODEX_HOME to a writable directory outside the workspace." });
    out.push({ kind: "process-table", target: platform === "win32" ? "powershell Win32_Process" : "ps", timeoutMs: 20000, why: "process-table query for cleanup and ownership",
      action: "Allow process inspection (ps, or PowerShell on Windows); without it council cannot confirm cleanup, so it does not start Grok." });
    let launcher = null;
    try { launcher = this.resolveLauncher(env, platform); } catch { launcher = null; }
    if (launcher) {
      out.push({ kind: "exec", target: { command: launcher.command, args: [...launcher.args, "--version"], expectText: "^grok " }, timeoutMs: 15000, why: "grok version probe",
        action: `Install the Grok CLI or set ${BIN_ENV} to it.` });
      out.push({ kind: "exec", target: { command: launcher.command, args: [...launcher.args, "models"], expectText: "^(?![\\s\\S]*(not logged in|not authenticated))" }, timeoutMs: 30000,
        why: "grok login probe (grok models)", action: "Run `grok` once and complete login, or set GROK_API_KEY." });
    }
    return out;
  },
  /** Grok sessions work only in their cwd (`--add-dir` is refused, S1.3): a review runs at the repository root. */
  checkRequest(request, env = process.env) {
    if (request.verb !== "review") return null;
    const top = gitTop(request.cwd, env);
    if (top && realOr(top) !== realOr(request.cwd)) {
      return `grok reviews run at the repository root (a Grok session cannot reach folders outside its cwd); rerun from ${top} or pass --cwd ${top}`;
    }
    return null;
  },
  buildTurn(request) {
    const readOnly = request.readOnly !== false && request.verb !== "task";
    // Grok keeps a session's agent: once a session ran the default agent (a task), later read-only turns on it use RESUME_DENY.
    const plan = recipe(readOnly ? "read-only" : "write", { web: Boolean(request.web), defaultAgent: readOnly && request.resume && request.agent === "default" });
    const thread = request.resume ? request.threadId : randomUUID();
    const session = request.resume ? ["-r", thread] : ["--session-id", thread];
    const promptFile = path.join(request.jobDir, "prompt.md");
    // The review answers in the schema, so the text contract is left out there (GROKX).
    const carrier = request.structured ? ["--json-schema", schemaText(request.schemaPath ?? SCHEMA_PATH)] : ["--rules", contractText(request.contractPath)];
    const args = ["--prompt-file", promptFile, "--output-format", "streaming-json", ...(request.model ? ["--model", request.model] : []),
      ...(request.effort ? ["--effort", request.effort] : []), "--no-auto-update", ...plan.args, ...carrier, ...session];
    // The per-turn instructions travel in the input (contract.md); reviews carry them in the batch prompt.
    // Only the user's text is framed (GROKX): a structured turn's prompt is the core's own composition.
    const body = request.structured ? request.prompt ?? "" : framePrompt(request.prompt ?? "", path.basename(request.jobDir));
    const promptText = request.instructions ? `${request.instructions.trimEnd()}\n\n${body}` : body;
    return { args, env: compatEnv(request.env ?? {}, plan.readOnly), promptFile, promptText, answerFile: null, readOnly: plan.readOnly,
      requestedThreadId: request.resume ? null : thread, agent: plan.agent, contractCarrier: request.structured ? "none" : "rules" };
  },
  parseEvent() { return { fatal: "grok: parseEvent is not implemented in this build (S4.3)" }; },
  /** S4.4 implements the inline schema carrier and the answer mapping. */
  reviewPlan() { return { native: false, batches: null, promptTemplate: "review", schemaCarrier: "inline" }; },
  finalizeReview({ structured, unreviewed }) { return { structured: structured ?? null, unreviewed }; },
};
