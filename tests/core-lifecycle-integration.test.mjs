// S2.4: lifecycle integration with real companion processes and IPC barriers, ported from grok_plugin_for_codex 1.1.0
// tests/lifecycle-integration.test.mjs and cancel.test.mjs onto the null adapter and the fake child.
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fork } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { makeWorld, ctxFor, alive, until, jobIdOf, footerOf } from "./helpers.mjs";
import adapter from "./fixtures/null-adapter.mjs";
import { createJob, loadJob, markDone, saveJob } from "../plugins/council/scripts/lib/core/jobs.mjs";
import { claimThread, inspectClaim } from "../plugins/council/scripts/lib/core/claims.mjs";
import { currentIdentity, executionController, processSnapshot } from "../plugins/council/scripts/lib/core/execution.mjs";
import { cancelManaged } from "../plugins/council/scripts/lib/core/lifecycle.mjs";

const workerPath = fileURLToPath(new URL("./fixtures/lifecycle-worker.mjs", import.meta.url));
const metaPath = (w, id) => path.join(w.home, "jobs", id, "meta.json");
const donePath = (w, id) => path.join(w.home, "jobs", id, "done");
function startWorker(t, w, cfg = {}) {
  const child = fork(workerPath, [JSON.stringify({ home: w.home, cwd: fs.realpathSync(w.workspace), env: w.env, ...cfg })], { stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true });
  let stdout = "", stderr = "";
  const messages = [];
  child.stdout.on("data", (b) => { stdout += b; });
  child.stderr.on("data", (b) => { stderr += b; });
  child.on("message", (m) => messages.push(m));
  const closed = once(child, "close");
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  return { child, closed, stdout: () => stdout, stderr: () => stderr, barrier: () => until(() => messages[0]) };
}
function seed(w) {
  const r = w.call(["ask", "--to", "null", "--", "start"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  return w.job(jobIdOf(r.stderr));
}

test("barrier: two real companions admit exactly one turn on one thread; the loser does not change history", async (t) => {
  const w = makeWorld(), original = seed(w);
  const cfg = { barrier: "beforeClaim", thread: original.threadId, env: { COUNCIL_FAKE_HANG: "1" } };
  const a = startWorker(t, w, cfg), b = startWorker(t, w, cfg);
  const [ma, mb] = await Promise.all([a.barrier(), b.barrier()]);
  a.child.send("go"); b.child.send("go");
  const loser = await Promise.race([a.closed.then(() => a), b.closed.then(() => b)]);
  const winner = loser === a ? b : a;
  assert.match(loser.stdout(), /busy/);
  const loserId = loser === a ? ma.id : mb.id, winnerId = loser === a ? mb.id : ma.id;
  assert.equal(w.job(loserId).admitted, false);
  await until(() => w.job(winnerId).pid);
  const cancel = w.call(["cancel", winnerId, "--timeout", "10"]);
  assert.ok([0, 1].includes(cancel.status), cancel.stdout);
  await winner.closed;
  assert.equal(inspectClaim(w.home, "null", original.threadId).state, "absent");
  const next = w.call(["reply", original.threadId, "--to", "null", "--", "again"]);
  assert.equal(next.status, 0, next.stdout + next.stderr);
  assert.match(footerOf(next.stdout), /round 2\/9/, "the refused turn spent no round");
});

test("different threads run independently in parallel", async (t) => {
  const w = makeWorld(), one = seed(w), two = seed(w);
  const a = startWorker(t, w, { barrier: "beforeClaim", thread: one.threadId });
  const b = startWorker(t, w, { barrier: "beforeClaim", thread: two.threadId });
  await Promise.all([a.barrier(), b.barrier()]);
  a.child.send("go"); b.child.send("go");
  const results = await Promise.all([a.closed, b.closed]);
  assert.deepEqual(results.map(([code]) => code), [0, 0], a.stderr() + b.stderr());
  assert.equal(w.fakeCalls().length, 4);
});

test("a cancel before spawn cannot release a paused live companion's claim, and prevents its spawn", async (t) => {
  const w = makeWorld(), previous = seed(w);
  const worker = startWorker(t, w, { barrier: "beforeSpawn", thread: previous.threadId });
  const { id } = await worker.barrier();
  const before = fs.readFileSync(metaPath(w, id), "utf8");
  const r = w.call(["cancel", id, "--timeout", ".1"]);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.equal(fs.existsSync(donePath(w, id)), false);
  assert.equal(fs.readFileSync(metaPath(w, id), "utf8"), before, "cancel is never a second metadata writer");
  assert.equal(inspectClaim(w.home, "null", previous.threadId).job, id);
  worker.child.send("go");
  assert.equal((await worker.closed)[0], 1, worker.stderr());
  assert.equal(w.fakeCalls().length, 1, "cancelled before any spawn");
  assert.equal(w.job(id).outcome, "cancelled");
  assert.equal(inspectClaim(w.home, "null", previous.threadId).state, "absent");
});

test("a cancel while finalization is paused never rewrites the result; the completed result wins", async (t) => {
  const w = makeWorld(), previous = seed(w);
  const worker = startWorker(t, w, { barrier: "beforeFinalize", thread: previous.threadId });
  const { id } = await worker.barrier();
  const before = fs.readFileSync(metaPath(w, id), "utf8");
  const r = w.call(["cancel", id, "--timeout", ".1"]);
  assert.equal(r.status, 1);
  assert.equal(fs.existsSync(donePath(w, id)), false);
  assert.equal(fs.readFileSync(metaPath(w, id), "utf8"), before);
  worker.child.send("go");
  assert.equal((await worker.closed)[0], 0, worker.stderr());
  const final = fs.readFileSync(metaPath(w, id), "utf8");
  assert.equal(w.call(["cancel", id]).status, 0);
  assert.equal(fs.readFileSync(metaPath(w, id), "utf8"), final);
  assert.equal(w.call(["wait", id]).status, 0);
});

test("a child that answers on another thread fails the turn, claims nothing for it, and leaves the original resumable", () => {
  const w = makeWorld(), previous = seed(w);
  const other = randomUUID();
  const bin = path.join(w.dir, "wrong-thread.mjs");
  fs.writeFileSync(bin, `if (process.argv.includes("--version")) { console.log("null 0.0.2"); process.exit(0); } process.stdin.resume(); process.stdin.on("end", () => { console.log(JSON.stringify({ type: "start", thread: ${JSON.stringify(other)} })); console.log(JSON.stringify({ type: "text", data: "x" })); console.log(JSON.stringify({ type: "end", thread: ${JSON.stringify(other)} })); });`);
  const r = w.call(["reply", previous.id, "--", "continue"], { env: { COUNCIL_NULL_BIN: bin } });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(footerOf(r.stdout), new RegExp(`answered on thread "${other}", expected ${previous.threadId}`));
  assert.equal(inspectClaim(w.home, "null", previous.threadId).state, "absent");
  assert.equal(inspectClaim(w.home, "null", other).state, "absent");
  assert.equal(w.call(["reply", previous.id, "--", "after"]).status, 0);
  assert.equal(w.fakeCalls().at(-1).thread, previous.threadId);
});

test("a first run under an aliased state root that did not exist yet is still recovered: the backend is stopped by its operand", async () => {
  const w = makeWorld();
  const real = path.join(w.dir, "real"), alias = path.join(w.dir, "alias");
  fs.mkdirSync(real);
  fs.symlinkSync(real, alias, process.platform === "win32" ? "junction" : "dir");
  const pidFile = path.join(w.dir, "backend.pid");
  const env = { COUNCIL_CODEX_HOME: path.join(alias, "state"), COUNCIL_FAKE_HANG: "1", COUNCIL_FAKE_BACKEND: pidFile };
  const running = w.start(["ask", "--to", "null", "--", "q"], { env });
  const [, id] = await running.waitFor(/job=([a-z0-9]{16})/);
  await until(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, "utf8"));
  const backend = Number(fs.readFileSync(pidFile, "utf8"));
  const home = path.join(real, "state");
  const events = path.join(home, "jobs", id, "events.jsonl");
  await until(() => fs.existsSync(events) && fs.readFileSync(events, "utf8").split("\n").filter((l) => l.includes('"type":"text"')).length === 2);
  const child = JSON.parse(fs.readFileSync(path.join(home, "jobs", id, "meta.json"), "utf8")).pid;
  running.child.kill("SIGKILL");
  await running.exited;
  assert.ok(alive(backend) && alive(child), "the backend and the launcher outlive the companion");
  const cancel = w.call(["cancel", id, "--timeout", "15"], { env: { COUNCIL_CODEX_HOME: path.join(alias, "state") } });
  assert.equal(cancel.status, 0, cancel.stdout + cancel.stderr);
  await until(() => !alive(backend) && !alive(child), 5000);
});

test("an unknown query and a failed kill preserve the final failure, the cancellation intent and the claim", async () => {
  const w = makeWorld();
  const thread = randomUUID();
  const j = createJob(w.home, { provider: "null", threadId: thread, threadIds: [thread], admitted: true, status: "failed", code: 1, outcome: "failed", cleanupPending: true, companionPid: 12345,
    cwd: w.workspace, spawnedAt: new Date().toISOString() });
  claimThread(w.home, "null", thread, j); markDone(j);
  const before = fs.readFileSync(metaPath(w, j.id), "utf8");
  let queries = 0;
  const unknown = await cancelManaged(ctxFor(w), loadJob(w.home, j.id), { timeoutMs: 1500, control: { snapshot: () => (queries += 1, { state: "unknown", rows: [] }) } });
  assert.equal(unknown.code, 1);
  assert.equal(inspectClaim(w.home, "null", thread).job, j.id);
  assert.ok(queries > 1, "a failed query is looked at again before it is reported");
  assert.ok(fs.existsSync(path.join(j.dir, "cancel")));
  const row = { pid: 12346, stamp: "1", raw: "owned" };
  const stubborn = await cancelManaged(ctxFor(w), loadJob(w.home, j.id), { timeoutMs: 20, control: { snapshot: () => ({ state: "ok", rows: [row] }), inspect: () => ({ state: "owned", rows: [row] }), stop: () => "unknown" } });
  assert.equal(stubborn.code, 1);
  assert.equal(fs.readFileSync(metaPath(w, j.id), "utf8"), before);
  assert.equal(fs.existsSync(path.join(j.dir, "stopped")), false);
  let cold = true; // the first query fails, as a cold WMI start can; the next confirms
  const gone = await cancelManaged(ctxFor(w), loadJob(w.home, j.id), { control: { snapshot: () => (cold ? (cold = false, { state: "unknown", rows: [] }) : { state: "ok", rows: [] }), inspect: () => ({ state: "gone", rows: [] }) } });
  assert.equal(gone.code, 0);
  assert.equal(fs.readFileSync(metaPath(w, j.id), "utf8"), before);
  assert.equal(inspectClaim(w.home, "null", thread).state, "absent");
});

test("event storage and final-marker failures cannot publish success or drop recovery evidence", async (t) => {
  for (const field of ["failAppend", "failFinalize"]) {
    const w = makeWorld(), previous = seed(w);
    const worker = startWorker(t, w, { [field]: true, thread: previous.threadId });
    assert.equal((await worker.closed)[0], 1, worker.stderr());
    assert.match(worker.stdout(), /outcome=failed/);
    const id = jobIdOf(worker.stdout());
    if (field === "failFinalize") {
      assert.equal(fs.existsSync(donePath(w, id)), false);
      assert.equal(inspectClaim(w.home, "null", previous.threadId).job, id, "the claim is kept for recovery");
    }
    const cancel = w.call(["cancel", id, "--timeout", "10"]);
    assert.equal(cancel.status, 0, cancel.stdout + cancel.stderr);
    assert.equal(inspectClaim(w.home, "null", previous.threadId).state, "absent");
  }
});

test("more edited paths than the cap stop the child and release the thread; an empty answer and an oversized line fail", () => {
  const w = makeWorld();
  const many = w.call(["task", "--to", "null", "--", "q"], { env: { COUNCIL_FAKE_TOOLS: "10002", COUNCIL_FAKE_HANG: "1" } });
  assert.equal(many.status, 1, many.stdout + many.stderr);
  assert.match(footerOf(many.stdout), /error: too many edited paths in event stream/);
  const job = w.job(jobIdOf(many.stderr));
  assert.equal(job.cleanupPending, false, job.error);
  assert.equal(inspectClaim(w.home, "null", job.requestedThreadId).state, "absent");
  assert.ok(!alive(job.pid), "the hanging child was stopped");
  const empty = w.call(["ask", "--to", "null", "--", "q"], { env: { COUNCIL_FAKE_ANSWER: " \n\t" } });
  assert.equal(empty.status, 1);
  assert.match(footerOf(empty.stdout), /null returned no answer/);
  const huge = w.call(["ask", "--to", "null", "--", "q"], { env: { COUNCIL_FAKE_SCENARIO: "huge-line" } });
  assert.equal(huge.status, 1);
  assert.match(footerOf(huge.stdout), /JSONL line over 1048576 bytes/);
  const long = `${"a".repeat(28000)}\nOpen questions: choose one\nNext: none\n`;
  const r = w.call(["ask", "--to", "null", "--json", "--", "q"], { env: { COUNCIL_FAKE_ANSWER: long } });
  assert.equal(r.status, 10, r.stdout + r.stderr);
  const data = JSON.parse(r.stdout);
  assert.ok(data.clipped);
  assert.equal(Buffer.byteLength(data.answer), 24576);
  assert.equal(fs.readFileSync(data.answerFile, "utf8"), long, "the full answer stays on disk; a late open question still counts");
});

test("a child that keeps printing past the deadline is stopped; one that ignores SIGTERM is killed after the grace period", () => {
  const w = makeWorld();
  const spin = w.call(["ask", "--to", "null", "--deadline", ".4", "--", "q"], { env: { COUNCIL_FAKE_SPIN_MS: "5000" } });
  assert.equal(spin.status, 1);
  assert.match(footerOf(spin.stdout), /wall-clock deadline passed/);
  assert.equal(w.job(jobIdOf(spin.stderr)).cleanupPending, false);
  const started = Date.now();
  const stubborn = w.call(["ask", "--to", "null", "--deadline", ".3", "--", "q"], { env: { COUNCIL_FAKE_HANG: "1", COUNCIL_FAKE_IGNORE_TERM: "1" } });
  assert.equal(stubborn.status, 1);
  const job = w.job(jobIdOf(stubborn.stderr));
  assert.equal(job.cleanupPending, false, job.error);
  assert.ok(!alive(job.pid), "SIGKILL followed the ignored SIGTERM");
  assert.ok(Date.now() - started < 20000);
});

test("cancel captures and stops a descendant in a separate process group", async (t) => {
  const w = makeWorld();
  const pidFile = path.join(w.dir, "grandchild.pid");
  const running = w.start(["task", "--to", "null", "--", "q"], { env: { COUNCIL_FAKE_HANG: "1", COUNCIL_FAKE_GRANDCHILD: pidFile, COUNCIL_FAKE_HOLD_MS: "60000" } });
  t.after(() => running.child.kill("SIGKILL"));
  const [, id] = await running.waitFor(/job=([a-z0-9]{16})/);
  await until(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, "utf8"));
  const pid = Number(fs.readFileSync(pidFile, "utf8"));
  assert.ok(currentIdentity(pid));
  const r = w.call(["cancel", id, "--timeout", "10"]);
  assert.ok([0, 1].includes(r.status), r.stdout);
  const done = await running.exited;
  assert.equal(done.code, 1);
  await until(() => !alive(pid), 5000);
  assert.equal(w.job(id).cleanupPending, false, w.job(id).error);
});

test("a backend surviving its launcher is found by the exact operand after a clean exit, stopped, and named in the error", () => {
  const w = makeWorld();
  const pidFile = path.join(w.dir, "backend.pid");
  const r = w.call(["ask", "--to", "null", "--", "q"], { env: { COUNCIL_FAKE_BACKEND: pidFile } });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(footerOf(r.stdout), /owned execution survived the launcher/);
  assert.ok(!alive(Number(fs.readFileSync(pidFile, "utf8"))));
  assert.equal(w.job(jobIdOf(r.stderr)).cleanupPending, false);
});

test("two concurrent recovery calls cannot rewrite result metadata or leave an owned child running", async () => {
  const w = makeWorld();
  const running = w.start(["ask", "--to", "null", "--", "q"], { env: { COUNCIL_FAKE_HANG: "1" } });
  const [, id] = await running.waitFor(/job=([a-z0-9]{16})/);
  await until(() => w.job(id).pid);
  const events = path.join(w.home, "jobs", id, "events.jsonl");
  await until(() => fs.existsSync(events) && fs.readFileSync(events, "utf8").split("\n").filter((l) => l.includes('"type":"text"')).length === 2);
  running.child.kill("SIGKILL");
  await running.exited;
  const before = fs.readFileSync(metaPath(w, id), "utf8");
  const job = loadJob(w.home, id);
  const control = () => executionController({ adapter });
  const results = await Promise.all([cancelManaged(ctxFor(w), job, { control: control() }), cancelManaged(ctxFor(w), job, { control: control() })]);
  assert.ok(results.every((r) => r.code === 0), JSON.stringify(results));
  assert.equal(fs.readFileSync(metaPath(w, id), "utf8"), before);
  await until(() => !alive(job.pid), 5000);
});

test("a stopped backend is no evidence about a separate grandchild still holding the launcher's pipes", (t) => {
  const w = makeWorld();
  const backendPid = path.join(w.dir, "backend.pid"), grandchildPid = path.join(w.dir, "grandchild.pid");
  const r = w.call(["ask", "--to", "null", "--", "q"], { env: { COUNCIL_FAKE_BACKEND: backendPid, COUNCIL_FAKE_GRANDCHILD: grandchildPid, COUNCIL_FAKE_HOLD_MS: "20000" } });
  const grandchild = Number(fs.readFileSync(grandchildPid, "utf8"));
  t.after(() => { try { process.kill(grandchild, "SIGKILL"); } catch { /* gone */ } });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(footerOf(r.stdout), /survived the launcher/);
  assert.ok(!alive(Number(fs.readFileSync(backendPid, "utf8"))), "the backend was stopped");
  assert.ok(alive(grandchild), "the pipe holder is still running: nothing identified it as owned");
  const job = w.job(jobIdOf(r.stderr));
  assert.equal(job.cleanupPending, true, "an unexplained held pipe keeps cleanup pending");
  assert.ok(job.unattributedPipes);
  assert.deepEqual([inspectClaim(w.home, "null", job.requestedThreadId).state, inspectClaim(w.home, "null", job.requestedThreadId).job], ["owned", job.id]);
});

test("the ps snapshot finds a live child with its group; the companion's own row is never owned", () => {
  const snap = processSnapshot();
  assert.equal(snap.state, "ok");
  const me = snap.rows.find((r) => r.pid === process.pid);
  assert.ok(me, "this process is listed");
  if (process.platform === "darwin") assert.ok(Number.isInteger(me.pgid));
  const job = { requestedThreadId: "x", dir: "/nowhere", execution: [{ pid: process.pid, stamp: me.stamp, boot: me.boot }] };
  assert.equal(executionController({ adapter }).inspect(job, snap).rows.some((r) => r.pid === process.pid), false);
});
