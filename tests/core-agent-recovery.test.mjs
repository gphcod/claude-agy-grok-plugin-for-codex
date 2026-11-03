// 1.1.4: a companion lost between its spawn and its post-spawn agent save left the record on `explore`; once the
// recovered job was pruned, a read-only reply asked a session that ran Grok's default agent to go back. Recovery now
// sets a one-way marker beside the record, and never writes the record, so concurrent cancels cannot regress it.
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { makeWorld, ctxFor, jobIdOf } from "./helpers.mjs";
import { loadAdapter, planTurn, resolveThread } from "../plugins/council/scripts/lib/cli/plan.mjs";
import { claimHeld, claimThread } from "../plugins/council/scripts/lib/core/claims.mjs";
import { createJob, loadJob, loadThread, markDefaultAgent, markStopped, saveThread } from "../plugins/council/scripts/lib/core/jobs.mjs";
import { cancelManaged } from "../plugins/council/scripts/lib/core/lifecycle.mjs";
import { RESUME_DENY } from "../plugins/council/scripts/lib/providers/grok.mjs";

const THREAD = "66666666-6666-4666-8666-666666666666";
const FAKE_GROK = fileURLToPath(new URL("./fixtures/fake-grok.mjs", import.meta.url));
const gone = { snapshot: () => ({ state: "ok", rows: [] }), inspect: () => ({ state: "gone", rows: [] }) };

function world() {
  const w = makeWorld();
  w.env.COUNCIL_GROK_BIN = FAKE_GROK;
  fs.mkdirSync(path.join(w.dir, ".grok"), { recursive: true });
  fs.writeFileSync(path.join(w.dir, ".grok", "auth.json"), "{}", { mode: 0o600 });
  return w;
}
const recordFile = (w, id = THREAD) => path.join(w.home, "threads", `grok-${id.toLowerCase()}.json`);
const marker = (w, id = THREAD) => recordFile(w, id).replace(/\.json$/, ".default-agent");
const record = (w, over = {}) => saveThread(w.home, { provider: "grok", threadId: THREAD, cwd: w.workspace, model: "grok-4.7", effort: "high", requestedEffort: "high", tier: "consult", round: 2, rounds: 9, agent: "explore", readOnly: true, lastJob: "earlier", ...over });
/** A task whose durable job save landed and whose agent save did not: the window. */
const lost = (w, over = {}) => createJob(w.home, { provider: "grok", verb: "task", status: "running", admitted: true, cwd: w.workspace, session: null, companionPid: 999999, companionIdentity: { pid: 999999, stamp: "x" },
  threadId: THREAD, threadIds: [THREAD], spawnedAt: new Date().toISOString(), spawnAttempted: true, providerStarted: true, pid: 4242, agent: "default", readOnly: false, model: "grok-4.7", effort: "high", tier: "exec", round: 3, rounds: 9, ...over });
const cancel = (w, job, options = {}) => cancelManaged(ctxFor(w), loadJob(w.home, job.id), { timeoutMs: 2000, control: gone, ...options });
const pruned = (job) => fs.rmSync(job.dir, { recursive: true, force: true });
/** The argv a read-only reply would launch; a job id reads history as admission does. */
async function replyArgs(w, options, jobId = null, plan = null) {
  const adapter = await loadAdapter("grok", w.env);
  const turn = (plan ?? planTurn(ctxFor(w), adapter, "reply", options, "delta", {})).prepare(jobId);
  const dir = path.join(w.home, "planned-job");
  fs.mkdirSync(dir, { recursive: true });
  return turn.build(dir).args;
}
function assertDefaultAgent(args, why) {
  assert.equal(args.includes("--agent"), false, `${why}: explore is not requested of a session that ran the default agent`);
  assert.equal(args[args.indexOf("--disallowed-tools") + 1], RESUME_DENY.join(","), why);
}

test("the window: recovered and then pruned, a reply by native id stays on the default agent", async () => {
  const w = world();
  record(w);
  const job = lost(w);
  const result = await cancel(w, job);
  assert.equal(result.code, 0, result.error);
  assert.equal(JSON.parse(fs.readFileSync(recordFile(w), "utf8")).agent, "explore", "recovery does not write the record");
  assertDefaultAgent(await replyArgs(w, { thread: job.id, to: "grok" }), "job retained, by job id");
  assertDefaultAgent(await replyArgs(w, { thread: THREAD, to: "grok" }), "job retained, by native id");
  pruned(job);
  assert.equal(resolveThread(ctxFor(w), "reply", { thread: THREAD, to: "grok" }).prev, null);
  assertDefaultAgent(await replyArgs(w, { thread: THREAD, to: "grok" }), "job pruned, by native id");
});

test("a reply resolved before a recovery reads the marker under the claim", async () => {
  const w = world();
  record(w);
  const adapter = await loadAdapter("grok", w.env);
  const plan = planTurn(ctxFor(w), adapter, "reply", { thread: THREAD, to: "grok" }, "delta", {});
  assert.equal(plan.thread.record.agent, "explore", "resolved first");
  const job = lost(w);
  assert.equal((await cancel(w, job)).code, 0);
  pruned(job);
  assertDefaultAgent(await replyArgs(w, null, "ffffffffffffffff", plan), "prepared under the claim");
});

test("the record's default outranks an older retained job on explore", async () => {
  const w = world();
  record(w);
  markDefaultAgent(w.home, "grok", THREAD);
  const older = createJob(w.home, { provider: "grok", verb: "ask", status: "done", admitted: true, cwd: w.workspace, session: null, companionPid: 999999, threadId: THREAD, threadIds: [THREAD], spawnedAt: new Date().toISOString(), providerStarted: true, pid: 4242, agent: "explore", round: 1, rounds: 9, model: "grok-4.7", effort: "high", tier: "consult" });
  markStopped(older);
  assertDefaultAgent(await replyArgs(w, { thread: THREAD, to: "grok" }), "older job retained");
});

test("recovery marks a job that started or may have started, and no other", async () => {
  const cases = [
    [{}, true, "started"],
    [{ providerStarted: undefined, pid: null }, true, "may have started"],
    [{ providerStarted: false, pid: null }, false, "spawn failed"],
    [{ spawnAttempted: false, providerStarted: false, pid: null }, false, "never attempted"],
    [{ spawnAttempted: undefined, providerStarted: undefined, pid: null }, false, "lost before admission"],
    [{ agent: "explore" }, false, "explore"],
    [{ agent: null }, false, "no agent"],
    [{ threadId: null }, false, "no thread"],
  ];
  for (const [over, marked, why] of cases) {
    const w = world();
    record(w);
    const result = await cancel(w, lost(w, over));
    assert.equal(result.code, 0, `${why}: ${result.error}`);
    assert.equal(fs.existsSync(marker(w)), marked, why);
  }
});

test("--confirm-ended takes the same route", async () => {
  const w = world();
  record(w);
  const job = lost(w, { unattributedPipes: true });
  const result = await cancel(w, job, { confirmEnded: true });
  assert.equal(result.code, 0, result.error);
  assert.ok(fs.existsSync(marker(w)));
});

test("a first turn lost before any record still recovers and marks", async () => {
  const w = world();
  assert.equal(fs.existsSync(path.join(w.home, "threads")), false);
  const job = lost(w);
  const result = await cancel(w, job);
  assert.equal(result.code, 0, result.error);
  assert.ok(loadJob(w.home, job.id).stopped);
  assert.ok(fs.existsSync(marker(w)));
});

test("a marker that exists succeeds, and an uppercase native id reads through the same record", () => {
  const w = world();
  markDefaultAgent(w.home, "grok", "TID-1");
  assert.doesNotThrow(() => markDefaultAgent(w.home, "grok", "TID-1"));
  saveThread(w.home, { provider: "grok", threadId: "tid-1", cwd: w.workspace, agent: "explore" });
  assert.equal(loadThread(w.home, "grok", "tid-1").agent, "default");
  assert.equal(loadThread(w.home, "grok", "TID-1").agent, "default");
  assert.throws(() => markDefaultAgent(w.home, "grok", "../x"), /invalid/);
});

for (const [name, method] of [["writing the marker", "writeFileSync"], ["creating its directory", "mkdirSync"]]) {
  test(`a failure ${name} keeps the claim and writes no stopped; cancel then retries it`, async (t) => {
    const w = world();
    record(w);
    const job = lost(w);
    claimThread(w.home, "grok", THREAD, job);
    const real = fs[method];
    const hits = (target) => (method === "writeFileSync" ? String(target) === marker(w) : String(target) === path.join(w.home, "threads"));
    const mocked = t.mock.method(fs, method, function (target, ...rest) {
      if (hits(target)) throw Object.assign(new Error("EACCES: denied"), { code: "EACCES" });
      return real.call(this, target, ...rest);
    });
    const failed = await cancel(w, job);
    assert.deepEqual([failed.status, failed.code], ["unknown", 1]);
    assert.match(failed.error, /cannot save the thread's agent: EACCES: denied; claim and cancellation request retained/);
    assert.equal(loadJob(w.home, job.id).stopped, false);
    assert.equal(claimHeld(w.home, job), true);
    mocked.mock.restore();
    const retried = await cancel(w, job);
    assert.equal(retried.code, 0, retried.error);
    assert.ok(loadJob(w.home, job.id).stopped);
    assert.equal(claimHeld(w.home, job), false);
    assert.equal(loadThread(w.home, "grok", THREAD).agent, "default");
  });
}

for (const code of ["EBUSY", "EPERM", "EACCES"]) {
  test(`a marker lookup failing with ${code} refuses; it never reads as explore`, async (t) => {
    const w = world();
    record(w);
    markDefaultAgent(w.home, "grok", THREAD);
    const real = fs.statSync;
    const mocked = t.mock.method(fs, "statSync", function (target, ...rest) {
      if (String(target) === marker(w)) throw Object.assign(new Error(`${code}: locked`), { code });
      return real.call(this, target, ...rest);
    });
    assert.throws(() => loadThread(w.home, "grok", THREAD), new RegExp(`cannot read state record .*${code}: locked`));
    mocked.mock.restore();
    assert.equal(loadThread(w.home, "grok", THREAD).agent, "default");
  });
}

test("a delayed second canceller cannot regress the record, whichever job it holds", async () => {
  for (const agent of ["default", "explore"]) {
    const w = world();
    record(w);
    const job = lost(w, { agent });
    let finalized = "";
    // Past its early checks, this canceller waits while another recovers the job and a later turn finalizes.
    const delayed = { ...gone, inspect: () => {
      markStopped(loadJob(w.home, job.id));
      saveThread(w.home, { provider: "grok", threadId: THREAD, cwd: w.workspace, model: "newer-model", round: 7, rounds: 9, agent: "default", lastJob: "later" });
      finalized = fs.readFileSync(recordFile(w), "utf8");
      return gone.inspect();
    } };
    const result = await cancel(w, job, { control: delayed });
    assert.equal(result.code, 0, result.error);
    assert.equal(fs.readFileSync(recordFile(w), "utf8"), finalized, agent);
    const read = loadThread(w.home, "grok", THREAD);
    assert.deepEqual([read.model, read.round, read.lastJob, read.agent], ["newer-model", 7, "later", "default"], agent);
    assert.equal(fs.existsSync(marker(w)), agent === "default");
  }
});

test("reading a thread writes nothing, and a healthy explore thread stays on explore", async () => {
  const w = world();
  record(w);
  const args = await replyArgs(w, { thread: THREAD, to: "grok" });
  assert.equal(args[args.indexOf("--agent") + 1], "explore");
  assert.equal(fs.existsSync(marker(w)), false);
});

test("end to end: kill the companion during task --thread, cancel, prune, and a reply by native id keeps the default agent", { timeout: 120000 }, async () => {
  const w = world();
  const first = w.call(["ask", "--to", "grok", "--effort", "low", "--", "start the thread"]);
  assert.equal(first.status, 0, first.stderr + first.stdout);
  const started = jobIdOf(first.stderr);
  const thread = loadJob(w.home, started).threadId;
  assert.ok(thread);

  const companion = w.start(["task", "--thread", started, "--effort", "low", "--", "make the edit"], { env: { COUNCIL_FAKE_SCENARIO: "slow", COUNCIL_FAKE_SLOW_MS: "120000" } });
  const id = (await companion.waitFor(/job[= ]([a-z0-9]{16})/, 60000))[1];
  for (const end = Date.now() + 60000; !loadJob(w.home, id)?.pid && Date.now() < end; await new Promise((r) => setTimeout(r, 25)));
  assert.ok(loadJob(w.home, id).pid, "the provider started");
  companion.child.kill("SIGKILL");
  await companion.exited;
  // What the window leaves: the post-spawn save never happened.
  fs.writeFileSync(recordFile(w, thread), `${JSON.stringify({ ...JSON.parse(fs.readFileSync(recordFile(w, thread), "utf8")), agent: "explore" }, null, 2)}\n`);

  const blocked = w.call(["reply", "--thread", thread, "--effort", "low", "--", "too early"], { env: { COUNCIL_FAKE_SCENARIO: "resume" } });
  assert.notEqual(blocked.status, 0, "the lost job blocks its thread until cancel");
  const cancelled = w.call(["cancel", id]);
  assert.equal(cancelled.status, 0, cancelled.stderr + cancelled.stdout);
  pruned(loadJob(w.home, id));

  const next = w.call(["reply", "--thread", thread, "--effort", "low", "--", "read it back"], { env: { COUNCIL_FAKE_SCENARIO: "resume" } });
  assert.equal(next.status, 0, next.stderr + next.stdout);
  assertDefaultAgent(loadJob(w.home, jobIdOf(next.stderr)).childArgs, "the logged launch");
});
