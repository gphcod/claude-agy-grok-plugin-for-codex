import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { makeWorld, turnFor, ctxFor, adapter, PLUGIN_ROOT } from "./helpers.mjs";
import { KEEP_FINISHED, createJob, listJobs, loadJob, loadThread, markDone, prune, saveThread } from "../plugins/council/scripts/lib/core/jobs.mjs";
import { claimPath, claimThread, inspectClaim, releaseThread } from "../plugins/council/scripts/lib/core/claims.mjs";
import { runManagedTurn, cancelManaged } from "../plugins/council/scripts/lib/core/lifecycle.mjs";
import { recoveryHint, resultJson } from "../plugins/council/scripts/lib/core/output.mjs";

const timers = { json: true, deadlineMs: 20000, inactivityMs: 20000 };

test("a busy metadata read retries beyond 40 ms and unreadable existing jobs fail closed", (t) => {
  const world = makeWorld();
  const job = createJob(world.home, { provider: "null", status: "running", cwd: world.workspace });
  const target = path.join(job.dir, "meta.json");
  const read = fs.readFileSync;
  let attempts = 0;
  t.mock.method(fs, "readFileSync", (file, ...args) => {
    if (String(file) === target && ++attempts <= 10) throw Object.assign(new Error("busy"), { code: "EBUSY" });
    return read(file, ...args);
  });
  assert.equal(loadJob(world.home, job.id).id, job.id);
  assert.equal(attempts, 11);
  fs.writeFileSync(target, "{broken metadata");
  assert.throws(() => listJobs(world.home), SyntaxError, "implicit selection cannot skip a corrupt latest job");
});

test("unreadable unrelated metadata cannot abort a new turn or be deleted by pruning", () => {
  const world = makeWorld();
  const corrupt = createJob(world.home, { provider: "null", status: "running", cwd: world.workspace });
  const file = path.join(corrupt.dir, "meta.json");
  fs.writeFileSync(file, "{unreadable");
  const fresh = world.call(["ask", "--to", "null", "--json", "--", "new independent turn"]);
  assert.equal(fresh.status, 0, fresh.stderr + fresh.stdout);
  assert.equal(JSON.parse(fresh.stdout).exit, 0);
  assert.equal(fs.readFileSync(file, "utf8"), "{unreadable");
  const implicit = world.call(["wait"]);
  assert.equal(implicit.status, 1);
  assert.ok(implicit.stderr.includes(file), implicit.stderr);
  assert.match(implicit.stderr, /separate COUNCIL_CODEX_HOME/);
  for (let i = 0; i < KEEP_FINISHED + 3; i++) {
    const finished = createJob(world.home, { provider: "null", status: "done", outcome: "ok", code: 0, cwd: world.workspace,
      spawnedAt: new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString() });
    markDone(finished);
  }
  const directories = fs.readdirSync(path.join(world.home, "jobs")).sort();
  assert.ok(directories.length > KEEP_FINISHED);
  prune(world.home);
  assert.deepEqual(fs.readdirSync(path.join(world.home, "jobs")).sort(), directories, "an unreadable inventory prevents every prune deletion");
});

test("a busy job directory is retried and an unreadable existing directory is never reported expired", (t) => {
  const world = makeWorld();
  const job = createJob(world.home, { provider: "null", status: "running", cwd: world.workspace });
  const read = fs.readdirSync;
  let attempts = 0, permanent = false;
  t.mock.method(fs, "readdirSync", (dir, ...args) => {
    if (String(dir) === job.dir && (permanent || ++attempts < 4)) throw Object.assign(new Error("directory blocked"), { code: permanent ? "EIO" : "EBUSY" });
    return read(dir, ...args);
  });
  assert.equal(loadJob(world.home, job.id).id, job.id);
  permanent = true;
  assert.throws(() => loadJob(world.home, job.id), /cannot read job directory.*directory blocked/);
});

test("claim release retries busy operations and restores its owner after a failed directory removal", (t) => {
  const world = makeWorld();
  const owner = { provider: "null", id: "aaaaaaaaaaaaaaaa", ownerToken: "a".repeat(32) };
  claimThread(world.home, "null", "thread", owner);
  let unlinks = 0, removals = 0;
  const busy = { ...fs,
    unlinkSync(file) { if (++unlinks <= 2) throw Object.assign(new Error("busy"), { code: "EBUSY" }); return fs.unlinkSync(file); },
    rmdirSync(dir) { if (++removals <= 2) throw Object.assign(new Error("busy"), { code: "EPERM" }); return fs.rmdirSync(dir); },
  };
  assert.equal(releaseThread(world.home, "null", "thread", owner, busy), true);
  assert.equal(inspectClaim(world.home, "null", "thread").state, "absent");
  claimThread(world.home, "null", "thread", owner);
  const failed = { ...fs, rmdirSync() { throw Object.assign(new Error("remove failed"), { code: "ENOSPC" }); } };
  assert.throws(() => releaseThread(world.home, "null", "thread", owner, failed), /remove failed/);
  assert.equal(inspectClaim(world.home, "null", "thread").job, owner.id, "cancel retains owner-specific recovery evidence");
  assert.equal(releaseThread(world.home, "null", "thread", owner), true);
});

test("a release error after done preserves the successful result and can be recovered by cancel", async (t) => {
  const world = makeWorld();
  const turn = turnFor(world);
  const target = claimPath(world.home, "null", turn.thread);
  const remove = fs.rmdirSync;
  t.mock.method(fs, "rmdirSync", (dir, ...args) => {
    if (String(dir) === target) throw Object.assign(new Error("fixture claim removal failure"), { code: "ENOSPC" });
    return remove(dir, ...args);
  });
  const result = await runManagedTurn(ctxFor(world), adapter, turn, null, timers);
  assert.equal(result.job.code, 0);
  assert.equal(result.job.outcome, "ok");
  assert.equal(result.job.cleanupPending, true);
  assert.match(result.job.error, /claim release failed/);
  assert.equal(loadJob(world.home, result.job.id).code, 0, "replay agrees with the original caller");
  t.mock.restoreAll();
  const control = { snapshot: () => ({ state: "ok", rows: [] }), inspect: () => ({ state: "gone", rows: [] }), stop: () => "sent" };
  const recovered = await cancelManaged(ctxFor(world), loadJob(world.home, result.job.id), { control, adapter, timeoutMs: 2000 });
  assert.equal(recovered.code, 0, recovered.error);
  assert.equal(inspectClaim(world.home, "null", turn.thread).state, "absent");
  assert.equal(loadJob(world.home, result.job.id).code, 0);
});

test("the default agent is recorded before a resumed task spawns", async () => {
  const world = makeWorld();
  const turn = turnFor(world, { verb: "task", confirmed: true });
  saveThread(world.home, { provider: "null", threadId: turn.thread, agent: "explore", cwd: world.workspace });
  const build = turn.build;
  turn.build = (dir) => ({ ...build(dir), agent: "default" });
  let checked = false;
  const result = await runManagedTurn(ctxFor(world), adapter, turn, null, timers, {
    beforeSpawn() { assert.equal(loadThread(world.home, "null", turn.thread).agent, "default"); checked = true; },
  });
  assert.equal(result.job.code, 0, result.job.error);
  assert.equal(checked, true);
});

test("a task preserves pending review continuation while still reporting unknown mutation coverage", () => {
  const job = { id: "task", dir: "/state/task", verb: "task", mutationCoverage: "unknown", reviewState: { pending: 2 } };
  assert.equal(recoveryHint(job), "coverage unknown; next: reply task --next-input");
  assert.equal(resultJson(job, "done").coverage, null);
});

test("a state root inside the plugin is rejected before any directory is created", () => {
  const world = makeWorld();
  const inside = path.join(PLUGIN_ROOT, `.state-probe-${path.basename(world.dir)}`);
  assert.equal(world.call(["wait"], { env: { COUNCIL_CODEX_HOME: inside } }).status, 1);
  assert.equal(fs.existsSync(inside), false);
});
