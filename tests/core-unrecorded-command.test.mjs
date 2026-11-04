// 1.1.5: on Windows a provider can end with its lost companion and leave a command whose parents are gone. Heartbeats
// now record identities there too, so cancel can stop that command; one no heartbeat saw stays unseen, and cancel says so.
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { makeWorld, turnFor, ctxFor, adapter, alive, until } from "./helpers.mjs";
import { claimThread } from "../plugins/council/scripts/lib/core/claims.mjs";
import { executionController } from "../plugins/council/scripts/lib/core/execution.mjs";
import { createJob, loadJob } from "../plugins/council/scripts/lib/core/jobs.mjs";
import { UNRECORDED, cancelManaged, runManagedTurn } from "../plugins/council/scripts/lib/core/lifecycle.mjs";

const timers = { json: true, deadlineMs: 20000, inactivityMs: 20000 };
const turn = (w, hooks, env = {}) => { const t = turnFor(w, { env }); return runManagedTurn(ctxFor(w), adapter, t, (id) => ({ ...t, jobId: id }), timers, { platform: "win32", drainMs: 150, shutdownMs: 5000, retryMs: 300, pipeWaitMs: 300, ...hooks }); };
const helper = { pid: 999991, ppid: 999990, stamp: "1", raw: "helper.exe", name: "helper.exe" };
const owned = (rows) => ({ state: rows.length ? "owned" : "gone", rows });

test("a heartbeat on Windows records the owned rows once", async () => {
  const w = makeWorld();
  let queries = 0;
  const control = { ...executionController({ adapter, platform: "win32" }), self: () => ({ pid: process.pid, startedMs: Date.now() }), snapshot: () => { queries += 1; return { state: "ok", rows: queries <= 3 ? [helper] : [] }; }, inspect: (_, snap) => owned(snap.rows) };
  const { job } = await turn(w, { control, beatMs: 40 }, { COUNCIL_FAKE_SCENARIO: "slow", COUNCIL_FAKE_SLOW_MS: "1500" });
  assert.ok(queries > 3, "more than one heartbeat queried");
  assert.deepEqual(job.execution.filter((r) => r.pid === helper.pid).length, 1);
  assert.deepEqual([job.code, job.outcome, job.cleanupPending], [0, "ok", false], "the helper had gone before the turn ended");
});

test("a recorded helper that exits by itself after a clean exit neither fails the turn nor gets signalled", async () => {
  const w = makeWorld();
  let scans = 0;
  const stopped = [];
  const control = { ...executionController({ adapter, platform: "win32" }), self: () => ({ pid: process.pid, startedMs: Date.now() }), snapshot: () => ({ state: "ok", rows: [] }), inspect: () => { scans += 1; return owned(scans <= 2 ? [helper] : []); }, stop: (row) => { stopped.push(row.pid); return "sent"; } };
  const { job } = await turn(w, { control, beatMs: 60000, unverifiedWaitMs: 3000 });
  assert.equal(scans, 3);
  assert.deepEqual(stopped, []);
  assert.deepEqual([job.code, job.outcome, job.error ?? null], [0, "ok", null]);
});

test("a recorded process that outlasts the wait is stopped and fails the turn", async () => {
  const w = makeWorld();
  let live = true, scans = 0;
  const stopped = [];
  const control = { ...executionController({ adapter, platform: "win32" }), self: () => ({ pid: process.pid, startedMs: Date.now() }), snapshot: () => ({ state: "ok", rows: [] }), inspect: () => { scans += 1; return owned(live ? [helper] : []); }, stop: (row) => { stopped.push(row.pid); live = false; return "sent"; } };
  const { job } = await turn(w, { control, beatMs: 60000, unverifiedWaitMs: 250 });
  assert.ok(scans > 2, "it looked again before calling it a survivor");
  assert.deepEqual(stopped, [helper.pid]);
  assert.deepEqual([job.code, job.outcome, job.error, job.cleanupPending], [1, "failed", "owned execution survived the launcher", false]);
});

const wrapper = { pid: 999981, ppid: 999980, stamp: "10", raw: "wrapper.exe", name: "wrapper.exe", argv: ["wrapper.exe"] };
const command = { pid: 999982, ppid: 999981, stamp: "20", raw: "node.exe -e sleep", name: "node.exe", argv: ["node.exe", "-e", "sleep"] };
/** The first scan finds the wrapper and its command; `next` is every later snapshot, until the command is stopped. */
const wrapperExits = (next, stopped) => {
  let scans = 0, live = true;
  const real = executionController({ adapter: { ...adapter, ownsProcess: (row) => row.pid === wrapper.pid }, platform: "win32", snapshot: () => { scans += 1; return !live ? { state: "ok", rows: [] } : scans === 1 ? { state: "ok", rows: [wrapper, command] } : next; } });
  return { ...real, stop: (row) => { stopped.push(row.pid); live = false; return "sent"; } };
};

test("a command known only through a wrapper that exits during the wait is still stopped and fails the turn", async () => {
  const w = makeWorld();
  const stopped = [];
  const { job } = await turn(w, { control: wrapperExits({ state: "ok", rows: [command] }, stopped), beatMs: 60000, unverifiedWaitMs: 300 });
  assert.deepEqual(stopped, [command.pid]);
  assert.deepEqual([job.code, job.error, job.cleanupPending], [1, "owned execution survived the launcher", false]);
  assert.ok(job.execution.some((r) => r.pid === command.pid));
});

test("on macOS without a recorded leader a saved identity proves nothing, so the first scan's processes are stopped at once", async () => {
  const w = makeWorld();
  const stopped = [];
  let scans = 0, live = true;
  const real = executionController({ adapter: { ...adapter, ownsProcess: (row) => row.pid === wrapper.pid }, platform: "darwin", snapshot: () => { scans += 1; return { state: "ok", rows: !live ? [] : scans === 1 ? [wrapper, command] : [command] }; } });
  const control = { ...real, identify: () => null, self: () => ({ pid: process.pid, startedMs: Date.now() }), stop: (row) => { stopped.push(row.pid); live = false; return "sent"; } };
  const { job } = await turn(w, { platform: "darwin", control, beatMs: 60000, unverifiedWaitMs: 2000 });
  assert.equal(job.leader ?? null, null);
  assert.deepEqual(stopped, [wrapper.pid, command.pid]);
  assert.deepEqual([job.code, job.error, job.cleanupPending], [1, "owned execution survived the launcher", false]);
});

test("a failed query during the wait keeps what the first scan proved and leaves cleanup pending", async () => {
  const w = makeWorld();
  const stopped = [];
  const { job } = await turn(w, { control: wrapperExits({ state: "unknown", rows: [] }, stopped), beatMs: 60000, unverifiedWaitMs: 300 });
  assert.deepEqual(stopped, [], "nothing is signalled on a query that says nothing");
  assert.deepEqual([job.code, job.cleanupPending], [1, true]);
  assert.deepEqual(job.execution.map((r) => r.pid).sort(), [wrapper.pid, command.pid]);
});

const lostJob = (w, over = {}) => {
  const job = createJob(w.home, { provider: "null", verb: "task", status: "running", admitted: true, cwd: w.workspace, session: null, companionPid: 999999, companionIdentity: { pid: 999999, stamp: "x" }, threadId: "t-lost", threadIds: ["t-lost"], requestedThreadId: "t-lost", spawnAttempted: true, providerStarted: true, execution: [], pid: 999998, spawnedAt: new Date().toISOString(), ...over });
  claimThread(w.home, "null", "t-lost", job);
  return job;
};

test("an orphan no heartbeat recorded is never signalled, and only the recovering cancel warns about it", async () => {
  const w = makeWorld();
  const orphan = { pid: 999997, ppid: 999996, stamp: "5", raw: "node.exe -e sleep", name: "node.exe" };
  const kills = [];
  const control = executionController({ adapter, platform: "linux", snapshot: () => ({ state: "ok", rows: [orphan] }), kill: (...a) => kills.push(a) });
  const job = lostJob(w);
  const first = await cancelManaged(ctxFor(w), loadJob(w.home, job.id), { timeoutMs: 2000, control });
  assert.deepEqual([first.status, first.code, first.warning], ["cancelled", 0, UNRECORDED]);
  assert.deepEqual(kills, []);
  assert.doesNotMatch(loadJob(w.home, job.id).error ?? "", /may still be running/, "cleanup is not owed");
  const second = await cancelManaged(ctxFor(w), loadJob(w.home, job.id), { timeoutMs: 2000, control });
  assert.deepEqual([second.status, second.code, second.warning], ["cancelled", 0, undefined], "a repeat looked at no process table");
});

test("a lost job that never started its provider gets no warning", async () => {
  for (const over of [{ spawnAttempted: false }, { providerStarted: false }]) {
    const w = makeWorld();
    const control = executionController({ adapter, platform: "linux", snapshot: () => ({ state: "ok", rows: [] }) });
    const result = await cancelManaged(ctxFor(w), loadJob(w.home, lostJob(w, over).id), { timeoutMs: 2000, control });
    assert.deepEqual([result.status, result.warning], ["cancelled", undefined], JSON.stringify(over));
  }
});

test("end to end: the companion and the provider die, the recorded command runs on, and cancel stops it and warns", async () => {
  const w = makeWorld();
  const pidFile = path.join(w.dir, "grandchild.pid");
  const running = w.start(["ask", "--to", "null", "--", "q"], { env: { COUNCIL_FAKE_HANG: "1", COUNCIL_FAKE_GRANDCHILD: pidFile, COUNCIL_FAKE_HOLD_MS: "120000" } });
  const [, id] = await running.waitFor(/job=([a-z0-9]{16})/);
  const grandchild = Number(await until(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, "utf8")));
  try {
    await until(() => (w.job(id).execution ?? []).some((r) => r.pid === grandchild));
    const provider = w.job(id).pid;
    running.child.kill("SIGKILL");
    await running.exited;
    if (alive(provider)) process.kill(provider, "SIGKILL");
    assert.ok(alive(grandchild), "the command outlives both");
    const r = w.call(["cancel", id, "--timeout", "30", "--json"]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const data = JSON.parse(r.stdout);
    assert.deepEqual([data.status, data.cleanupPending, data.warning], ["cancelled", false, UNRECORDED]);
    await until(() => !alive(grandchild), 10000);
  } finally { if (alive(grandchild)) process.kill(grandchild, "SIGKILL"); }
});
