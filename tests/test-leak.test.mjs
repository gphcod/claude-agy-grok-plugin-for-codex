// S7.1: a fake child must not outlive its test. Two stale fake-child processes were found, 18 h and 4 h old: a test had killed
// its companion to make the job lost and an assertion failed before the `cancel` on its last line.
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { ROOT, FAKE_CHILD, alive, until } from "./helpers.mjs";

test("a test process that dies with a lost job's child running leaves no fake child behind", { skip: process.platform === "win32" }, async () => {
  const helpers = path.join(ROOT, "tests", "helpers.mjs");
  const script = `import { makeWorld, until } from ${JSON.stringify(helpers)};
    const w = makeWorld();
    const running = w.start(["ask", "--to", "null", "--", "q"], { env: { COUNCIL_FAKE_HANG: "1" } });
    const [, id] = await running.waitFor(/job=([a-z0-9]{16})/);
    await until(() => w.job(id).pid);
    process.stdout.write(String(w.job(id).pid));
    running.child.kill("SIGKILL");
    await running.exited;
    throw new Error("an assertion failed before the cleanup");`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 60000, cwd: ROOT });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /an assertion failed before the cleanup/);
  const child = Number(r.stdout);
  assert.ok(child > 0, r.stdout + r.stderr);
  await until(() => !alive(child), 5000);
});

test("a hanging fake child ends by itself, even if nothing is left to stop it", () => {
  const r = spawnSync(process.execPath, [FAKE_CHILD, "--thread", "t"], { input: "q", encoding: "utf8", timeout: 20000, env: { ...process.env, COUNCIL_FAKE_HANG: "1", COUNCIL_FAKE_HANG_MS: "100" } });
  assert.equal(r.status, 97, r.stderr);
});
