// S2.4/S2.6: cancel against real processes through the entry, ported from grok_plugin_for_codex 1.1.0 tests/cancel.test.mjs:
// ownership by the job's own invocation, never by a reused pid or a mere mention, and recovery that never rewrites the result.
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { makeWorld, FAKE_CHILD, jobIdOf, alive, until } from "./helpers.mjs";
import adapter from "./fixtures/null-adapter.mjs";
import { createJob, loadJob, saveJob, stateOf } from "../plugins/council/scripts/lib/core/jobs.mjs";
import { claimThread, inspectClaim } from "../plugins/council/scripts/lib/core/claims.mjs";
import { ownsExecution, ownedExecution, processSnapshot, stopIdentity } from "../plugins/council/scripts/lib/core/execution.mjs";

const deadPid = () => spawnSync(process.execPath, ["-e", "0"]).pid;
const isStopped = (home, id) => fs.existsSync(path.join(home, "jobs", id, "stopped"));
const isDone = (home, id) => fs.existsSync(path.join(home, "jobs", id, "done"));
const cancelReal = (w, args, options = {}) => w.call(["cancel", ...args, "--timeout", "60"], { timeout: 120000, ...options });

/** A running null job whose companion is gone, recorded as the lifecycle would have recorded its launch. */
function runningRecord(w, { pid = null, home = w.home } = {}) {
  const thread = randomUUID();
  const childArgs = ["--thread", thread, "--model", "null-model", "--effort", "low"];
  const job = createJob(home, { provider: "null", verb: "ask", status: "running", tier: "consult", model: "null-model", effort: "low", cwd: fs.realpathSync(w.workspace), session: null,
    threadId: null, requestedThreadId: thread, threadIds: [thread], admitted: true, spawnedAt: new Date().toISOString(), round: 1, rounds: 9,
    companionPid: deadPid(), companionIdentity: { pid: 1, stamp: "dead" }, pid, childArgs, argv: [process.execPath, FAKE_CHILD, ...childArgs], execution: [] });
  claimThread(home, "null", thread, job);
  return job;
}
const orphanFor = (w, job) => {
  const child = spawn(process.execPath, [FAKE_CHILD, ...job.childArgs], { env: { ...w.env, COUNCIL_FAKE_HANG: "1", COUNCIL_FAKE_LOG: "" }, stdio: ["pipe", "ignore", "ignore"], windowsHide: true });
  child.stdin.end("q");
  return child;
};

test("cancel kills the child whose command line is the job's own invocation, and the thread stays resumable", async () => {
  const w = makeWorld();
  const job = runningRecord(w);
  const orphan = orphanFor(w, job);
  try {
    job.pid = orphan.pid;
    saveJob(job);
    await until(() => alive(orphan.pid));
    const r = cancelReal(w, [job.id]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, new RegExp(`^cancelled · null · job ${job.id}`));
    await until(() => !alive(orphan.pid), 5000);
    assert.equal(stateOf(loadJob(w.home, job.id)), "cancelled");
    assert.equal(w.job(job.id).status, "running", "recovery never rewrites the original metadata");
    assert.ok(isStopped(w.home, job.id) && !isDone(w.home, job.id));
    assert.equal(inspectClaim(w.home, "null", job.requestedThreadId).state, "absent");
    assert.equal(w.call(["wait", job.id]).status, 1, "a cancelled job reads as not ok");
  } finally { orphan.kill("SIGKILL"); }
});

test("cancel refuses a process on the reused pid, even another fake child, and records the job as stopped", () => {
  const w = makeWorld();
  const other = runningRecord(w);
  const stranger = orphanFor(w, other);
  try {
    const job = runningRecord(w, { pid: stranger.pid });
    const r = cancelReal(w, [job.id]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^cancelled/);
    assert.ok(alive(stranger.pid), "the unrelated process was left alone");
    assert.equal(stateOf(loadJob(w.home, job.id)), "cancelled");
    assert.ok(isStopped(w.home, job.id) && !isDone(w.home, job.id));
  } finally { stranger.kill("SIGKILL"); }
});

test("a finished job or a missing process counts as stopped; nothing to cancel is exit 0; an unknown id is exit 2", () => {
  const w = makeWorld();
  const finished = jobIdOf(w.call(["ask", "--to", "null", "--", "q"]).stderr);
  const before = fs.readFileSync(path.join(w.home, "jobs", finished, "meta.json"), "utf8");
  const again = w.call(["cancel", finished]);
  assert.equal(again.status, 0);
  assert.match(again.stdout, /^finished · null · job /);
  assert.equal(fs.readFileSync(path.join(w.home, "jobs", finished, "meta.json"), "utf8"), before, "nothing was rewritten");
  const gone = runningRecord(w, { pid: deadPid() });
  const r = w.call(["cancel", gone.id]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, new RegExp(`^cancelled · null · job ${gone.id}`));
  assert.ok(isStopped(w.home, gone.id) && !isDone(w.home, gone.id));
  assert.match(w.call(["cancel"]).stdout, /no running council job to cancel/);
  assert.equal(w.call(["cancel", "nosuchjob"]).status, 2);
});

// Real processes whose command line mentions the job's operands without being its child.
const mentions = (job) => ({
  "a reader of the thread id": ["-e", "setTimeout(() => {}, 60000)", job.requestedThreadId],
  "a script with the whole invocation inside one argument": ["-e", `setTimeout(() => {}, 60000); // ${job.childArgs.join(" ")}`],
  "a longer --thread operand that starts with the id": ["-e", "setTimeout(() => {}, 60000)", "--", "--thread", `${job.requestedThreadId} backup`],
  "one argument with quotes and the operands inside": ["-e", "setTimeout(() => {}, 60000)", "--", `note "hello" --thread ${job.requestedThreadId} tail`],
});

test("cancel refuses a process that merely mentions the job's operands, however it does so", () => {
  const w = makeWorld();
  for (const what of Object.keys(mentions({ requestedThreadId: "x", childArgs: [] }))) {
    const job = runningRecord(w);
    const sleeper = spawn(process.execPath, mentions(job)[what], { stdio: "ignore", windowsHide: true });
    try {
      job.pid = sleeper.pid;
      saveJob(job);
      const r = cancelReal(w, [job.id]);
      assert.equal(r.status, 0, `${what}: ${r.stdout}${r.stderr}`);
      assert.match(r.stdout, /^cancelled/, what);
      assert.ok(alive(sleeper.pid), `${what}: the process was left alone`);
    } finally { sleeper.kill("SIGKILL"); }
  }
});

test("a state root with spaces and non-ASCII letters in the operands is still recognised, and the child is killed", async () => {
  const w = makeWorld();
  const state = path.join(w.dir, "state with spaces and é");
  const home = fs.mkdirSync(state, { recursive: true }) && fs.realpathSync(state);
  const thread = randomUUID();
  const promptFile = path.join(home, "jobs", "p r o m p t.md");
  fs.mkdirSync(path.dirname(promptFile), { recursive: true });
  fs.writeFileSync(promptFile, "q");
  const childArgs = ["--thread", thread, "--model", "null-model", "--effort", "low", "--prompt-file", promptFile];
  const job = createJob(home, { provider: "null", verb: "ask", status: "running", cwd: fs.realpathSync(w.workspace), session: null, requestedThreadId: thread, threadIds: [thread], admitted: true,
    spawnedAt: new Date().toISOString(), companionPid: deadPid(), companionIdentity: { pid: 1, stamp: "dead" }, childArgs, argv: [process.execPath, FAKE_CHILD, ...childArgs], promptFile, execution: [] });
  claimThread(home, "null", thread, job);
  const orphan = spawn(process.execPath, [FAKE_CHILD, ...childArgs], { env: { ...w.env, COUNCIL_FAKE_HANG: "1", COUNCIL_FAKE_LOG: "" }, stdio: ["ignore", "ignore", "ignore"] });
  try {
    job.pid = orphan.pid;
    saveJob(job);
    await until(() => alive(orphan.pid));
    const r = cancelReal(w, [job.id], { env: { COUNCIL_CODEX_HOME: state } });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, new RegExp(`^cancelled · null · job ${job.id}`));
    await until(() => !alive(orphan.pid), 5000);
    assert.equal(JSON.parse(fs.readFileSync(path.join(job.dir, "meta.json"), "utf8")).status, "running");
  } finally { orphan.kill("SIGKILL"); }
});

test("cancel --json prints one JSON object for each outcome", () => {
  const w = makeWorld();
  const json = (args) => { const r = w.call(args); return { status: r.status, data: JSON.parse(r.stdout) }; };
  assert.deepEqual(json(["cancel", "--json"]), { status: 0, data: { status: "none", exit: 0 } });
  const finished = jobIdOf(w.call(["ask", "--to", "null", "--", "q"]).stderr);
  const done = json(["cancel", finished, "--json"]);
  assert.deepEqual([done.status, done.data.status, done.data.exit, done.data.provider, done.data.job, done.data.cleanupPending], [0, "finished", 0, "null", finished, false]);
  const gone = runningRecord(w, { pid: deadPid() });
  const stopped = json(["cancel", gone.id, "--json"]);
  assert.deepEqual([stopped.data.status, stopped.data.exit, stopped.data.released, stopped.data.error], ["cancelled", 0, false, null]);
  const bad = w.call(["cancel", "nosuchjob", "--json"]);
  assert.deepEqual([bad.status, JSON.parse(bad.stdout).exit], [2, 2]);
});

test("ownership is whole arguments: --thread, then exactly the id, normalized only on Windows", () => {
  const job = { requestedThreadId: "C:/state/jobs/k3f9/thread", promptFile: null, answerFile: null };
  const owns = (argv, platform = "win32") => ownsExecution({ argv }, job, platform, adapter);
  assert.ok(owns(["node", "child.js", "--thread", "C:/state/jobs/k3f9/thread", "--model", "m"]));
  assert.ok(owns(["child.exe", "--thread", String.raw`C:\State\Jobs\K3F9\thread`]), "normalized: case and slashes");
  assert.equal(owns(["child", "--thread", String.raw`C:\State\Jobs\K3F9\thread`], "linux"), false, "Linux keeps case and separators");
  for (const argv of [["node", "-e", "console.log('--thread C:/state/jobs/k3f9/thread')"], ["node", String.raw`--thread C:\state\jobs\k3f9\thread`], ["child", "--thread", "C:/state/jobs/k3f9/thread backup"],
    ["child", "--thread", "C:/state/jobs/k3f9/thread.bak"], ["child", "--thread2", "C:/state/jobs/k3f9/thread"], ["child", "--thread=C:/state/jobs/k3f9/thread"], ["type", "C:/state/jobs/k3f9/thread"],
    ["child", "--model", "C:/state/jobs/k3f9/thread"], ["child", "--thread", "C:/other/thread"], ["child", "--thread"]]) {
    assert.ok(!owns(argv), JSON.stringify(argv));
  }
});

test("the ps snapshot finds the process with the job's invocation, leaves others, and reads a zombie as gone", { skip: process.platform === "win32" }, async () => {
  const thread = randomUUID();
  const childArgs = ["-e", "setTimeout(() => {}, 60000)", "--", "--thread", thread];
  const job = { requestedThreadId: thread, argv: [process.execPath, ...childArgs], childArgs, execution: [], dir: "/nowhere" };
  const sleeper = (args) => spawn(process.execPath, args, { stdio: "ignore" });
  const mine = sleeper(childArgs), other = sleeper(["-e", "setTimeout(() => {}, 60000)", "--", "--thread", `${thread}.other`]), zombie = sleeper(["-e", "setTimeout(() => {}, 60000)"]);
  try {
    await new Promise((resolve) => setTimeout(resolve, 300));
    const found = ownedExecution(job, processSnapshot(), process.platform, [], adapter);
    assert.deepEqual(found.rows.map((r) => r.pid), [mine.pid], "only the process with the job's invocation");
    assert.equal(stopIdentity(found.rows[0]), "sent");
    await until(() => !alive(mine.pid), 5000);
    assert.ok(alive(other.pid));
    zombie.kill("SIGKILL");
    for (const end = Date.now() + 300; Date.now() < end;); // keep Node from reaping it while ps looks
    assert.deepEqual(processSnapshot({ pid: zombie.pid }), { state: "ok", rows: [] });
  } finally { for (const child of [mine, other, zombie]) child.kill("SIGKILL"); }
});
