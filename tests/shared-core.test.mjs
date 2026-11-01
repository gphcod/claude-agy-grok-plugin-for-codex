// S2.7: scripts/core-check.mjs never reports an equality it did not compute: local pins, a deferred comparison, and a
// comparison against a twin checkout that has an implemented, pinned core.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { ROOT, check, readPins } from "../scripts/core-check.mjs";

const CORE = path.join("plugins", "council", "scripts", "lib", "core");
function copyRepo(pins) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "council-twin-"));
  fs.mkdirSync(path.join(dir, CORE), { recursive: true });
  fs.mkdirSync(path.join(dir, "docs"));
  for (const { module } of pins) fs.copyFileSync(path.join(ROOT, CORE, module), path.join(dir, CORE, module));
  fs.copyFileSync(path.join(ROOT, "docs", "shared-core.md"), path.join(dir, "docs", "shared-core.md"));
  return dir;
}

test("the manifest pins the nine host-neutral modules and they match", () => {
  const pins = readPins(path.join(ROOT, "docs", "shared-core.md"));
  assert.deepEqual(pins.map((p) => p.module), ["claims.mjs", "heartbeat.mjs", "reader.mjs", "tiers.mjs", "fs.mjs", "review-input.mjs", "findings.mjs", "jobs.mjs", "execution.mjs"]);
  assert.deepEqual(check({ twin: undefined }), { code: 0, lines: ["local pins: 9 host-neutral modules match docs/shared-core.md", "comparison deferred"] });
  const r = spawnSync(process.execPath, [path.join(ROOT, "scripts", "core-check.mjs")], { encoding: "utf8", env: { ...process.env, COUNCIL_CC_ROOT: "" } });
  assert.deepEqual([r.status, r.stdout.trim().split("\n").at(-1)], [0, "comparison deferred"]);
});

test("a twin without an implemented, pinned core defers; a twin with one is compared byte for byte", () => {
  const pins = readPins(path.join(ROOT, "docs", "shared-core.md"));
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "council-empty-twin-"));
  assert.equal(check({ twin: empty }).lines.at(-1), "comparison deferred", "no manifest, no core: nothing is claimed");
  const twin = copyRepo(pins);
  assert.deepEqual(check({ twin }), { code: 0, lines: ["local pins: 9 host-neutral modules match docs/shared-core.md", `identical with the twin: ${pins.map((p) => p.module).join(", ")}`] });
  fs.appendFileSync(path.join(twin, CORE, "reader.mjs"), "\n// drift\n");
  fs.rmSync(path.join(twin, CORE, "fs.mjs"));
  const result = check({ twin });
  assert.equal(result.code, 1);
  assert.ok(result.lines.includes("differs from the twin: reader.mjs"));
  assert.ok(result.lines.includes("not pinned by the twin: fs.mjs"));
});

test("a local module that no longer matches its pin fails the check", () => {
  const pins = readPins(path.join(ROOT, "docs", "shared-core.md"));
  const copy = copyRepo(pins);
  fs.appendFileSync(path.join(copy, CORE, "claims.mjs"), "\n");
  const result = check({ root: copy, twin: undefined });
  assert.deepEqual(result, { code: 1, lines: ["local drift: claims.mjs no longer match their pins", "comparison deferred"] });
  fs.writeFileSync(path.join(copy, "docs", "shared-core.md"), "# empty\n");
  assert.equal(check({ root: copy }).code, 1);
});
