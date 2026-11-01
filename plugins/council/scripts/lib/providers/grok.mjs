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
const homeOf = (env, platform) => (platform === "win32" ? env.USERPROFILE : env.HOME) || null;
/** Grok's login evidence (S1.3): `~/.grok/auth.json` under the per-call environment's home, unless GROK_API_KEY is set. */
export const loginFile = (env, platform = process.platform) => { const home = homeOf(env, platform); return home ? path.join(home, ".grok", "auth.json") : null; };

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
  buildTurn() { throw new Error("grok: buildTurn is not implemented in this build (S4.2)"); },
  parseEvent() { return { fatal: "grok: parseEvent is not implemented in this build (S4.3)" }; },
  /** S4.4 implements the inline schema carrier and the answer mapping. */
  reviewPlan() { return { native: false, batches: null, promptTemplate: "review", schemaCarrier: "inline" }; },
  finalizeReview({ structured, unreviewed }) { return { structured: structured ?? null, unreviewed }; },
};
