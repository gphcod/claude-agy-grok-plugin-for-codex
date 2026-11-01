import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { defaultTests, liveTests, isLiveFile, coreRatio } from "../scripts/run-tests.mjs";

test("the default and live test sets are disjoint on the real tree, and the default set holds this file", () => {
  const defaults = defaultTests();
  const live = liveTests();
  assert.ok(defaults.includes("tests/runner.test.mjs"));
  assert.deepEqual(defaults.filter((f) => live.includes(f)), []);
  assert.ok(defaults.every((f) => !isLiveFile(f)));
  assert.ok(live.every((f) => isLiveFile(f)));
});

test("a live file name never matches the default pattern, wherever it lives", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "council-runner-"));
  fs.mkdirSync(path.join(root, "tests", "live", "nested"), { recursive: true });
  fs.mkdirSync(path.join(root, "tests", "unit"), { recursive: true });
  for (const f of ["tests/a.test.mjs", "tests/unit/b.test.mjs", "tests/c.live.test.mjs", "tests/live/d.live.test.mjs",
    "tests/live/nested/e.live.test.mjs", "tests/live/f.test.mjs", "tests/helper.mjs", "tests/fixture.json"]) {
    fs.writeFileSync(path.join(root, f), "");
  }
  assert.deepEqual(defaultTests(root), ["tests/a.test.mjs", "tests/unit/b.test.mjs"]);
  assert.deepEqual(liveTests(root), ["tests/live/d.live.test.mjs", "tests/live/nested/e.live.test.mjs"]);
  assert.ok(!defaultTests(root).includes("tests/live/f.test.mjs"), "anything under tests/live is excluded from the default set");
  assert.ok(!liveTests(root).includes("tests/live/f.test.mjs"), "a live test must carry the .live.test.mjs suffix");
  fs.rmSync(root, { recursive: true, force: true });
});

test("the core ratio counts non-blank lines of core-*.test.mjs over core/*.mjs", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "council-ratio-"));
  fs.mkdirSync(path.join(root, "tests"), { recursive: true });
  fs.mkdirSync(path.join(root, "plugins", "council", "scripts", "lib", "core"), { recursive: true });
  fs.writeFileSync(path.join(root, "tests", "core-x.test.mjs"), "a\n\nb\nc\n");
  fs.writeFileSync(path.join(root, "tests", "other.test.mjs"), "x\n".repeat(50));
  fs.writeFileSync(path.join(root, "plugins", "council", "scripts", "lib", "core", "x.mjs"), "1\n2\n\n");
  assert.deepEqual(coreRatio(root), { testLines: 3, coreLines: 2, ratio: 1.5 });
  fs.rmSync(root, { recursive: true, force: true });
});

test("an unknown argument exits 2 and runs no test set", () => {
  const r = spawnSync(process.execPath, ["scripts/run-tests.mjs", "--live", "--help"], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown argument --help/);
});
