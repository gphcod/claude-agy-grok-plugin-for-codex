// Shared helpers for the three fakes (tests/fixtures/fake-*.mjs). A fake validates the complete launch
// contract of its adapter (A5.1) before it emits anything; a mismatch exits 99 with the reason on stderr.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const DEPTH_VARIABLES = ["COUNCIL_DEPTH", "CLAUDE_PLUGIN_CODEX_DEPTH", "GROK_CODEX_DEPTH", "GROK_BUILD_DEPTH", "AGY_BRIDGE_DEPTH"];
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const scenario = () => process.env.COUNCIL_FAKE_SCENARIO || "ok";
export const streams = (name) => JSON.parse(fs.readFileSync(path.join(ROOT, "tests", "fixtures", "streams", `${name}.json`), "utf8"));
export const spikeText = (file) => fs.readFileSync(path.join(ROOT, "docs", "spike", file), "utf8");
export const log = (entry) => { if (process.env.COUNCIL_FAKE_LOG) fs.appendFileSync(process.env.COUNCIL_FAKE_LOG, `${JSON.stringify(entry)}\n`); };
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const SLOW_MS = Number(process.env.COUNCIL_FAKE_SLOW_MS || 1500);
export const HOLD_MS = Number(process.env.COUNCIL_FAKE_HOLD_MS || 2000);

/** Launch-contract failure: exit 99 with the reason, before any output. */
export function mismatch(reason, extra) {
  process.stderr.write(`fake launch contract violated: ${reason}${extra !== undefined ? ` ${JSON.stringify(extra)}` : ""}\n`);
  log({ mismatch: reason, argv: process.argv.slice(2) });
  process.exit(99);
}
export const expect = (ok, reason, extra) => { if (!ok) mismatch(reason, extra); };
export function flagValue(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}
export function flagValues(argv, name) {
  const out = [];
  for (let i = 0; i < argv.length; i += 1) if (argv[i] === name && argv[i + 1] !== undefined) out.push(argv[i + 1]);
  return out;
}
export function requireDepth(env = process.env) {
  for (const name of DEPTH_VARIABLES) expect(env[name], `guard variable ${name} must be set on the child`);
}
export async function readStdin() {
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  return text;
}
export const emitJson = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
/** A detached grandchild that inherits stdout and keeps it open for `ms` after this process exits. */
export function holdPipes(ms = HOLD_MS) {
  const child = spawn(process.execPath, ["-e", `setTimeout(() => {}, ${ms})`], { stdio: ["ignore", "inherit", "inherit"], detached: true, windowsHide: true });
  child.unref();
  return child.pid;
}
/** The batch marker a review prompt carries (`batch i/n`); `large-review` answers findings until the last batch. */
export function batchOf(text) {
  const m = /batch (\d+)\/(\d+)/.exec(text ?? "");
  return m ? { index: Number(m[1]), total: Number(m[2]) } : null;
}
export const fileExists = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
