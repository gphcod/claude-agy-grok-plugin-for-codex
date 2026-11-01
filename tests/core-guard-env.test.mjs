// core: provider probes and preflight exec descriptors run with the five A5.1 guard variables, like every turn's child.
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { makeWorld } from "./helpers.mjs";
import { DEPTH_VARIABLES, guardedEnv } from "../plugins/council/scripts/lib/core/host.mjs";
import { runDescriptor } from "../plugins/council/scripts/lib/core/preflight.mjs";

/** A child that records its argv and the guard variables it sees, and answers like the null child's probes. */
function recorder(dir) {
  const log = path.join(dir, "guard.log");
  const file = path.join(dir, "recorder.mjs");
  fs.writeFileSync(file, `import fs from "node:fs";
const names = ${JSON.stringify(DEPTH_VARIABLES)};
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), guards: names.filter((n) => process.env[n] === "1") }) + "\\n");
if (process.argv.includes("--version")) console.log("null 9.9.9");
else if (process.argv.includes("models")) console.log("- null-model");
`);
  return { file, entries: () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []) };
}

test("guardedEnv overlays all five guard variables and keeps the rest", () => {
  const env = guardedEnv({ PATH: "/bin", COUNCIL_DEPTH: "0" });
  assert.equal(env.PATH, "/bin");
  for (const name of DEPTH_VARIABLES) assert.equal(env[name], "1");
});

test("an exec preflight descriptor's child sees all five guard variables, even from a bare environment", async () => {
  const w = makeWorld({ git: false });
  const rec = recorder(w.dir);
  const result = await runDescriptor({ kind: "exec", target: { command: process.execPath, args: [rec.file, "--version"], expectText: "^null " } }, { env: { PATH: process.env.PATH } });
  assert.equal(result.ok, true, result.detail);
  assert.deepEqual(rec.entries().map((e) => e.guards), [DEPTH_VARIABLES]);
});

test("setup and models --refresh: every probe child and exec descriptor sees all five guard variables", () => {
  const w = makeWorld({ git: false });
  const rec = recorder(w.dir);
  const setup = w.call(["setup", "--to", "null"], { env: { COUNCIL_NULL_BIN: rec.file } });
  assert.equal(setup.status, 0, setup.stdout + setup.stderr);
  const refresh = w.call(["models", "--to", "null", "--refresh"], { env: { COUNCIL_NULL_BIN: rec.file } });
  assert.equal(refresh.status, 0, refresh.stdout + refresh.stderr);
  const entries = rec.entries();
  assert.deepEqual(entries.map((e) => e.argv.join(" ")), ["--version", "models", "--version", "--version", "models"], "setup: probe --version, probe models, the exec descriptor; then the refresh probe");
  for (const entry of entries) assert.deepEqual(entry.guards, DEPTH_VARIABLES, entry.argv.join(" "));
});
