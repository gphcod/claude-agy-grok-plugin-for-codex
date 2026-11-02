// Host constants (A2, A5.1, A7): the only module that knows it runs under Codex. The twin's copy names the Claude
// Code host; everything else in core/ reads these values instead of naming the host.
import os from "node:os";
import path from "node:path";

/** State root override and default (A7.1). */
export const STATE_ROOT_ENV = "COUNCIL_CODEX_HOME";
export const defaultStateRoot = () => path.join(os.homedir(), ".codex", "council");
/** The host session variable that scopes `--last`, bare `wait` and bare `cancel` (A7.2). */
export const SESSION_ENV = "CODEX_THREAD_ID";
/** The reply budget override (A3.5). */
export const ROUNDS_ENV = "COUNCIL_CODEX_ROUNDS";
/** Guard variables: every provider child receives all of them, so no plugin this one replaces can nest either; admission refuses when any is set (A5.1). */
export const DEPTH_VARIABLES = ["COUNCIL_DEPTH", "CODEX_COMPANION_DEPTH", "CLAUDE_PLUGIN_CODEX_DEPTH", "GROK_CODEX_DEPTH", "GROK_BUILD_DEPTH", "AGY_BRIDGE_DEPTH"];
export const depthEnv = () => Object.fromEntries(DEPTH_VARIABLES.map((name) => [name, "1"]));
/** The environment of every provider child: turns, probes and exec preflight descriptors alike (A5.1). */
export const guardedEnv = (env = process.env) => ({ ...env, ...depthEnv() });
/** Provider ids in the order `models` and `setup` iterate them (S2.6). */
export const PROVIDERS = ["claude", "gemini", "grok"];
/** Binary names and their override variables (A5.1). */
export const BINARIES = { claude: { name: "claude", env: "COUNCIL_CLAUDE_BIN" }, gemini: { name: "agy", env: "COUNCIL_AGY_BIN" }, grok: { name: "grok", env: "COUNCIL_GROK_BIN" } };
/** Executables whose rows the process scan treats as unknown when their command line is unreadable (S2.4). */
export const CHILD_BINARIES = ["claude", "claude.exe", "agy", "agy.exe", "grok", "grok.exe", "node", "node.exe"];
/** PowerShell rules (A2, A3.1): the here-string call form and the limits that send text through --prompt-file. */
export const POWERSHELL = Object.freeze({ callSuffix: "; exit $LASTEXITCODE", hereStringOpen: "@'", hereStringClose: "'@", promptFileBytes: 16 * 1024, commandLineChars: 32560 });
/** Text over this many bytes goes through --prompt-file on every platform (A3.1). */
export const PROMPT_FILE_BYTES = 64 * 1024;
/** The host session value, or null when the variable is absent or empty. */
export const hostSession = (env = process.env) => env[SESSION_ENV] || null;
