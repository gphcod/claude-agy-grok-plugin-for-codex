// S2.4: runManagedTurn and cancelManaged through the null adapter and the fake child (ported in part from
// grok_plugin_for_codex tests/lifecycle-integration.test.mjs, lifecycle-drain.test.mjs and cancel.test.mjs, and codex-plugin-cc's
// held-pipe handling). Entry-driven cases (wait --timeout, replay counters) run through main() in S2.6.
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { randomUUID } from "node:crypto";
import { makeWorld, turnFor, ctxFor, adapter, alive, until } from "./helpers.mjs";
import { runManagedTurn, cancelManaged, PIPE_WAIT_MS, SHUTDOWN_MS, RETRY_MS, DRAIN_MS, lockedThreadMessage } from "../plugins/council/scripts/lib/core/lifecycle.mjs";
import { loadJob, loadThread, stateOf, createJob, markDone, saveJob } from "../plugins/council/scripts/lib/core/jobs.mjs";
import { claimThread, inspectClaim } from "../plugins/council/scripts/lib/core/claims.mjs";
import { currentIdentity, executionController } from "../plugins/council/scripts/lib/core/execution.mjs";

const timers = { json: true, deadlineMs: 20000, inactivityMs: 20000 };
const runTurn = (w, turn, options = {}, hooks = {}) => runManagedTurn(ctxFor(w), adapter, turn, (id) => ({ ...turn, jobId: id }), { ...timers, ...options }, hooks);
const hookNames = (w) => w.hooks().map((h) => h.hook);

test("a stdin/stream turn with a preassigned id completes: answer, thread confirmed, claim released, thread record, hooks once each", async () => {
  const w = makeWorld();
  const turn = turnFor(w);
  const result = await runTurn(w, turn);
  assert.equal(result.job.code, 0, result.job.error);
  assert.deepEqual([result.job.outcome, result.job.provider, result.job.threadId, result.job.requestedThreadId, result.job.claimHeld, result.job.cleanupPending], ["ok", "null", turn.thread, turn.thread, false, false]);
  assert.equal(result.answer, "fake answer to: q");
  assert.match(result.job.id, /^[a-z0-9]{16}$/);
  assert.ok(fs.existsSync(path.join(result.job.dir, "done")));
  assert.equal(fs.readFileSync(path.join(result.job.dir, "answer.md"), "utf8"), "fake answer to: q");
  assert.ok(fs.readFileSync(path.join(result.job.dir, "events.jsonl"), "utf8").includes('"type":"end"'));
  assert.equal(inspectClaim(w.home, "null", turn.thread).state, "absent");
  const record = loadThread(w.home, "null", turn.thread);
  assert.deepEqual([record.provider, record.model, record.effort, record.round, record.rounds, record.lastJob], ["null", "null-model", "low", 0, 9, result.job.id]);
  assert.deepEqual(hookNames(w), ["beforeTurn", "afterTurn"]);
  const call = w.fakeCalls().at(-1);
  assert.equal(call.prompt, "q");
  for (const name of ["COUNCIL_DEPTH", "CLAUDE_PLUGIN_CODEX_DEPTH", "GROK_CODEX_DEPTH", "GROK_BUILD_DEPTH", "AGY_BRIDGE_DEPTH"]) assert.equal(call.depth[name], "1", name);
  assert.deepEqual(result.job.edited, []);
  assert.equal(result.job.cost, 0.001);
});

test("prompt-file and answer-file profiles with a discovered id: the claim is taken on discovery before the id is published", async () => {
  const w = makeWorld();
  const env = { COUNCIL_NULL_ID: "discovered", COUNCIL_NULL_INPUT: "prompt-file", COUNCIL_NULL_OUTPUT: "answer-file" };
  const seen = [];
  const turn = turnFor(w, { thread: null, env, prompt: "from a file" });
  const result = await runTurn(w, turn, { json: false }, { announce: (job) => seen.push({ thread: job.threadId, claim: inspectClaim(w.home, "null", job.threadId).state }) });
  assert.equal(result.job.code, 0, result.job.error);
  assert.match(result.job.threadId, /^discovered-\d+$/);
  assert.deepEqual(seen, [{ thread: result.job.threadId, claim: "owned" }], "announced once, after the discovered id was claimed");
  assert.equal(result.answer, "fake answer to: from a file");
  assert.equal(fs.readFileSync(result.job.promptFile, "utf8"), "from a file");
  assert.equal(result.job.answerFile, path.join(result.job.dir, "answer.md"));
  assert.equal(inspectClaim(w.home, "null", result.job.threadId).state, "absent");
  assert.ok(loadThread(w.home, "null", result.job.threadId));
});

test("a claim collision during discovery fails the turn and claims nothing new", async () => {
  const w = makeWorld();
  const env = { COUNCIL_NULL_ID: "discovered" };
  const holder = createJob(w.home, { provider: "null", status: "running", cwd: w.workspace, spawnedAt: new Date().toISOString(), threadIds: [] });
  // The fake child discovers `discovered-<pid>`; a competing job already owns that id.
  const first = await runTurn(w, turnFor(w, { thread: null, env }));
  const id = first.job.threadId;
  claimThread(w.home, "null", id, holder);
  const probe = turnFor(w, { thread: null, env });
  // Force the same discovered id by pre-naming it through the fake's --thread operand.
  probe.build = (jobDir) => ({ ...adapter.buildTurn({ verb: "ask", prompt: "q", model: "null-model", effort: "low", env: { ...w.env, ...env }, resume: false, threadId: null, jobDir }), args: ["--thread", id, "--model", "null-model", "--effort", "low"], requestedThreadId: null });
  const result = await runTurn(w, probe);
  assert.equal(result.job.code, 1);
  assert.match(result.job.error, new RegExp(`thread ${id} is busy as job ${holder.id}`));
  assert.equal(inspectClaim(w.home, "null", id).job, holder.id, "the holder keeps its claim");
  assert.equal(result.job.cleanupPending, false, result.job.error);
});

test("failure outcomes: exit-nonzero, no-completion, huge-line and a malformed stream are exit 1 with cleanup confirmed and afterTurn after it", async () => {
  const w = makeWorld();
  const cases = [["exit-nonzero", /exited with code 3|fake child: fatal/], ["no-completion", /ended without completing the turn/], ["huge-line", /JSONL line over/]];
  for (const [scenario, error] of cases) {
    const result = await runTurn(w, turnFor(w, { env: { COUNCIL_FAKE_SCENARIO: scenario, COUNCIL_FAKE_HUGE_BYTES: String(2 * 1024 * 1024) } }));
    assert.equal(result.job.code, 1, scenario);
    assert.match(result.job.error, error, scenario);
    assert.deepEqual([result.job.outcome, result.job.cleanupPending, result.job.claimHeld], ["failed", false, false], scenario);
    assert.ok(!alive(result.job.pid), `${scenario}: the child is gone`);
  }
  const hooks = w.hooks();
  assert.equal(hooks.filter((h) => h.hook === "beforeTurn").length, 3);
  assert.deepEqual(hooks.filter((h) => h.hook === "afterTurn").map((h) => h.outcome.cleanupConfirmed), [true, true, true], "afterTurn runs after verified cleanup");
  const frag = await runTurn(w, turnFor(w, { env: { COUNCIL_FAKE_SCENARIO: "fragmented-frames" } }));
  assert.equal(frag.job.code, 0, frag.job.error);
  assert.equal(frag.answer, "fake answer to: q");
});

test("a denial is exit 10 with the denied tool recorded; an incomplete read-only turn from afterTurn is exit 10 too", async () => {
  const w = makeWorld();
  const denied = await runTurn(w, turnFor(w, { env: { COUNCIL_FAKE_DENY: "secret.txt" } }));
  assert.deepEqual([denied.job.code, denied.job.outcome], [10, "attention"]);
  assert.deepEqual(denied.job.denied, [{ tool: "edit", path: "secret.txt" }]);
  const marking = { ...adapter, afterTurn: () => ({ incomplete: "workspace changed during a read-only turn" }) };
  const turn = turnFor(w);
  const result = await runManagedTurn(ctxFor(w), marking, turn, () => turn, timers);
  assert.deepEqual([result.job.code, result.job.incomplete], [10, "workspace changed during a read-only turn"]);
  const edits = await runTurn(w, turnFor(w, { verb: "task", env: { COUNCIL_FAKE_EDITS: "a.js,b.js", COUNCIL_FAKE_FAILED_COMMAND: "make test" } }));
  assert.deepEqual([edits.job.code, edits.job.edited, edits.job.failedCommands], [0, ["a.js", "b.js"], ["make test"]]);
});

test("the deadline and the inactivity timeout stop the child (SIGTERM the group, then SIGKILL) and exit 1 with cleanup confirmed", async () => {
  const w = makeWorld();
  for (const [options, pattern] of [[{ deadlineMs: 300, inactivityMs: 20000 }, /deadline passed/], [{ deadlineMs: 20000, inactivityMs: 400 }, /printed nothing before the inactivity deadline/]]) {
    const started = Date.now();
    const result = await runTurn(w, turnFor(w, { env: { COUNCIL_FAKE_HANG: "1" } }), options, { retryMs: 200, shutdownMs: 5000 });
    assert.equal(result.job.code, 1, result.job.error);
    assert.match(result.job.error, pattern);
    assert.deepEqual([result.job.cleanupPending, result.job.claimHeld], [false, false]);
    assert.ok(!alive(result.job.pid), "the hanging child was stopped");
    assert.ok(Date.now() - started < 8000);
  }
  assert.deepEqual([SHUTDOWN_MS, RETRY_MS, DRAIN_MS, PIPE_WAIT_MS], [60000, 10000, 1500, 12000], "production defaults");
});

test("held pipes on a clean exit: the turn waits PIPE_WAIT_MS, then locks the thread, keeps the claim and fails with the hint", async () => {
  const w = makeWorld();
  const pidFile = path.join(w.dir, "holder.pid");
  const turn = turnFor(w, { env: { COUNCIL_FAKE_SCENARIO: "hold-pipes", COUNCIL_FAKE_HOLD_MS: "30000", COUNCIL_FAKE_HOLD_PID: pidFile } });
  const started = Date.now();
  const result = await runTurn(w, turn, {}, { pipeWaitMs: 600, drainMs: 100 });
  const holder = Number(fs.readFileSync(pidFile));
  try {
    assert.ok(Date.now() - started >= 600 && Date.now() - started < 10000, `waited ${Date.now() - started} ms`);
    assert.deepEqual([result.job.code, result.job.outcome, result.job.threadLocked, result.job.unattributedPipes, result.job.cleanupPending, result.job.answerComplete], [1, "failed", true, true, true, true]);
    assert.match(result.job.error, /thread locked: null's output stayed open past 600 ms/);
    assert.equal(inspectClaim(w.home, "null", turn.thread).job, result.job.id, "the thread stays claimed");
    assert.ok(alive(holder), "nothing was killed: the holder is not identified as ours");
    const again = turnFor(w, { thread: turn.thread, confirmed: true, verb: "reply" });
    const blocked = await runTurn(w, again);
    assert.equal(blocked.job.code, 1);
    assert.equal(blocked.job.error, lockedThreadMessage(turn.thread, result.job.id));
    assert.ok(Buffer.byteLength(blocked.job.error) <= 200, "the footer prints it whole");
    // Plain cancel refuses to release what nothing observed, even once the owner companion is gone and nothing owned is left.
    const gone = { snapshot: () => ({ state: "ok", rows: [] }), inspect: () => ({ state: "gone", rows: [] }), stop: () => "sent" };
    const plain = await cancelManaged(ctxFor(w), loadJob(w.home, result.job.id), { timeoutMs: 2000, control: gone });
    assert.equal(plain.code, 1);
    assert.match(plain.error, /thread stays locked until cancel .* --confirm-ended/);
    assert.equal(inspectClaim(w.home, "null", turn.thread).job, result.job.id);
  } finally { try { process.kill(holder, "SIGKILL"); } catch { /* gone */ } }
  // Once the holder is gone, --confirm-ended releases.
  await until(() => !alive(holder));
  const live = executionController({ adapter });
  const confirmed = await cancelManaged(ctxFor(w), loadJob(w.home, result.job.id), { timeoutMs: 5000, confirmEnded: true,
    control: { ...live, snapshot: () => { const snap = live.snapshot(); return { ...snap, rows: snap.rows.filter((r) => r.pid !== process.pid) }; } } });
  assert.equal(confirmed.code, 0, confirmed.error);
  assert.equal(confirmed.released, true);
  assert.equal(inspectClaim(w.home, "null", turn.thread).state, "absent");
});

test("pipes that close within PIPE_WAIT_MS leave the turn clean", async () => {
  const w = makeWorld();
  const result = await runTurn(w, turnFor(w, { env: { COUNCIL_FAKE_SCENARIO: "hold-pipes", COUNCIL_FAKE_HOLD_MS: "300" } }), {}, { pipeWaitMs: 5000, drainMs: 100 });
  assert.equal(result.job.code, 0, result.job.error);
  assert.deepEqual([result.job.threadLocked, result.job.unattributedPipes, result.job.cleanupPending], [undefined, undefined, false]);
});

test("cancel --confirm-ended refuses (exit 10) with a live owner, a live owned child or a failed query, and releases only when none is observed", async () => {
  const w = makeWorld();
  const thread = randomUUID();
  const job = createJob(w.home, { provider: "null", verb: "ask", status: "running", cwd: w.workspace, threadId: thread, requestedThreadId: thread, threadIds: [thread], admitted: true, cleanupPending: false,
    companionPid: 4242, companionIdentity: { pid: 4242, stamp: "100" }, pid: 4300, spawnedAt: new Date().toISOString(), unattributedPipes: true, threadLocked: true, ownerToken: "a".repeat(32) });
  Object.assign(job, { status: "failed", outcome: "failed", code: 1 }); saveJob(job); markDone(job);
  claimThread(w.home, "null", thread, job);
  const companion = { pid: 4242, ppid: 1, stamp: "100", raw: "node council.mjs ask", name: "node" };
  const child = { pid: 4300, ppid: 4242, stamp: "101", raw: "node fake-child.mjs --thread x", name: "node" };
  const control = (snapshot, inspect) => ({ snapshot: () => snapshot, inspect: () => inspect, stop: () => "sent" });
  const ok = { state: "ok" };
  const liveOwner = await cancelManaged(ctxFor(w), loadJob(w.home, job.id), { confirmEnded: true, timeoutMs: 500, control: control({ ...ok, rows: [companion, child] }, { state: "owned", rows: [child] }) });
  assert.deepEqual([liveOwner.code, liveOwner.status], [10, "refused"]);
  assert.match(liveOwner.error, /owner companion \(pid 4242\) is still live/);
  const liveChild = await cancelManaged(ctxFor(w), loadJob(w.home, job.id), { confirmEnded: true, timeoutMs: 500, control: control({ ...ok, rows: [child] }, { state: "owned", rows: [child] }) });
  assert.deepEqual([liveChild.code, liveChild.status], [10, "refused"]);
  assert.match(liveChild.error, /1 owned process is still live \(pid 4300\)/);
  const failedQuery = await cancelManaged(ctxFor(w), loadJob(w.home, job.id), { confirmEnded: true, timeoutMs: 500, control: control({ state: "unknown", rows: [], error: "process query failed: boom" }, { state: "unknown", rows: [] }) });
  assert.deepEqual([failedQuery.code, failedQuery.status], [10, "refused"]);
  assert.match(failedQuery.error, /process query failed: boom/);
  assert.equal(inspectClaim(w.home, "null", thread).job, job.id, "every refusal leaves the claim");
  const plain = await cancelManaged(ctxFor(w), loadJob(w.home, job.id), { timeoutMs: 500, control: control({ ...ok, rows: [] }, { state: "gone", rows: [] }) });
  assert.equal(plain.code, 1, "without --confirm-ended a held output is never released");
  const released = await cancelManaged(ctxFor(w), loadJob(w.home, job.id), { confirmEnded: true, timeoutMs: 500, control: control({ ...ok, rows: [] }, { state: "gone", rows: [] }) });
  assert.deepEqual([released.code, released.status, released.released], [0, "finished", true]);
  assert.equal(inspectClaim(w.home, "null", thread).state, "absent");
  assert.ok(fs.existsSync(path.join(job.dir, "stopped")));
});

test("cancel with the owner live only writes the marker and the owner stops its child; the companion finalizes as cancelled", async () => {
  const w = makeWorld();
  const turn = turnFor(w, { env: { COUNCIL_FAKE_HANG: "1" } });
  let jobId = null;
  const running = runTurn(w, turn, { json: false }, { retryMs: 200, shutdownMs: 5000, announce: (job) => { jobId = job.id; } });
  await until(() => jobId && w.job(jobId).pid);
  const pid = w.job(jobId).pid;
  assert.ok(alive(pid));
  const cancel = await cancelManaged(ctxFor(w), loadJob(w.home, jobId), { timeoutMs: 50, control: executionController({ adapter }) });
  // The live owner is never signalled: cancel either returns before the owner reacts (not-stopped) or sees the owner's own
  // cancelled result; it never writes the stop marker itself.
  assert.ok((cancel.code === 1 && cancel.status === "not-stopped") || (cancel.code === 0 && cancel.status === "cancelled"), JSON.stringify(cancel));
  assert.ok(fs.existsSync(path.join(w.home, "jobs", jobId, "cancel")), "the marker was written");
  assert.ok(!fs.existsSync(path.join(w.home, "jobs", jobId, "stopped")), "no second metadata writer");
  const result = await running;
  assert.ok(!fs.existsSync(path.join(w.home, "jobs", jobId, "stopped")), "recovery never ran: the owner finalized its own job");
  assert.deepEqual([result.job.outcome, result.job.code, result.job.cleanupPending], ["cancelled", 1, false]);
  assert.ok(!alive(pid));
  assert.equal(inspectClaim(w.home, "null", turn.thread).state, "absent");
  assert.equal(stateOf(loadJob(w.home, jobId)), "cancelled");
  assert.deepEqual(hookNames(w), ["beforeTurn", "afterTurn"]);
  assert.equal(w.hooks()[1].outcome.reason, "cancelled");
});

test("cancel before spawn: the marker makes the turn end cancelled with zero children", async () => {
  const w = makeWorld();
  const turn = turnFor(w);
  const result = await runTurn(w, turn, {}, { beforeSpawn: (job) => fs.writeFileSync(path.join(job.dir, "cancel"), "") });
  assert.deepEqual([result.job.outcome, result.job.code, result.job.pid, result.job.threadId], ["cancelled", 1, null, null]);
  assert.equal(w.fakeCalls().length, 0);
  assert.equal(inspectClaim(w.home, "null", turn.thread).state, "absent");
  assert.deepEqual(hookNames(w), ["beforeTurn", "afterTurn"], "both hooks still run once");
});

test("cancel with the owner gone verifies identity by creation timestamp: a mismatched stamp refuses, a match stops and releases", async () => {
  const w = makeWorld();
  const thread = randomUUID();
  const make = () => {
    const job = createJob(w.home, { provider: "null", verb: "ask", status: "running", cwd: w.workspace, threadId: null, requestedThreadId: thread, threadIds: [thread], admitted: true, cleanupPending: false,
      companionPid: 5151, companionIdentity: { pid: 5151, stamp: "900" }, pid: 5200, spawnedAt: new Date().toISOString(), promptFile: "/x/prompt.md" });
    claimThread(w.home, "null", thread, job);
    return job;
  };
  const job = make();
  const child = { pid: 5200, ppid: 1, stamp: "901", argv: ["node", "fake", "--thread", thread], raw: `node fake --thread ${thread}`, name: "node" };
  const stops = [];
  let tables = [[{ pid: 5151, ppid: 1, stamp: "999", raw: "something else", name: "node" }, child], []];
  const control = { snapshot: () => ({ state: "ok", rows: tables.length > 1 ? tables.shift() : tables[0] }), inspect: (j, snap) => { const owned = snap.rows.filter((r) => r.pid === 5200); return owned.length ? { state: "owned", rows: owned } : { state: "gone", rows: [] }; }, stop: (row) => { stops.push(row.pid); return "sent"; } };
  const result = await cancelManaged(ctxFor(w), loadJob(w.home, job.id), { timeoutMs: 5000, control });
  assert.deepEqual([result.code, result.status, stops], [0, "cancelled", [5200]], "the companion pid now belongs to a younger process: it is gone, its child is stopped by identity");
  assert.equal(inspectClaim(w.home, "null", thread).state, "absent");
  assert.ok(fs.existsSync(path.join(job.dir, "cleanup-evidence")));
  // A live companion (stamp matches) is never signalled.
  const job2 = make();
  const waited = await cancelManaged(ctxFor(w), loadJob(w.home, job2.id), { timeoutMs: 300, control: { snapshot: () => ({ state: "ok", rows: [{ pid: 5151, stamp: "900", raw: "node council", name: "node" }, child] }), inspect: () => ({ state: "owned", rows: [child] }), stop: () => assert.fail("never stop while the owner lives") } });
  assert.deepEqual([waited.code, waited.status], [1, "not-stopped"]);
  assert.equal(inspectClaim(w.home, "null", thread).job, job2.id);
  // A record without the companion's identity cannot prove it is gone.
  const old = createJob(w.home, { provider: "null", verb: "ask", status: "running", threadIds: [], admitted: true, companionPid: 5151, cwd: w.workspace, spawnedAt: new Date().toISOString() });
  const unknown = await cancelManaged(ctxFor(w), loadJob(w.home, old.id), { timeoutMs: 300, control: { snapshot: () => ({ state: "ok", rows: [{ pid: 5151, stamp: "900" }] }), inspect: () => ({ state: "gone", rows: [] }) } });
  assert.equal(unknown.status, "unknown");
  assert.equal(unknown.error, "original companion identity cannot be confirmed; no claim released");
});

test("a lost owner: the hard-killed companion's job is recovered by cancel, which stops the orphaned child and keeps the metadata", async () => {
  const w = makeWorld();
  const running = w.start ? null : null;
  // Run the turn in a child process so it can be killed.
  const script = `import { runManagedTurn } from ${JSON.stringify(path.join(process.cwd(), "plugins/council/scripts/lib/core/lifecycle.mjs"))};
    import adapter from ${JSON.stringify(path.join(process.cwd(), "tests/fixtures/null-adapter.mjs"))};
    const turn = JSON.parse(process.argv[1]); turn.build = (jobDir) => adapter.buildTurn({ verb: "ask", prompt: "q", model: "null-model", effort: "low", env: process.env, resume: false, threadId: turn.thread, jobDir });
    await runManagedTurn({ home: process.env.COUNCIL_CODEX_HOME, env: process.env, cwd: process.cwd(), session: null }, adapter, turn, () => turn, { json: false, deadlineMs: 60000, inactivityMs: 60000 }, { announce: (job) => console.log("job=" + job.id) });`;
  const { spawn } = await import("node:child_process");
  const turn = turnFor(w, { env: { COUNCIL_FAKE_HANG: "1" } });
  const child = spawn(process.execPath, ["--input-type=module", "-e", script, JSON.stringify({ ...turn, launcher: adapter.resolveLauncher(w.env), build: undefined })], { cwd: w.workspace, env: { ...w.env, COUNCIL_FAKE_HANG: "1" }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "", err = "";
  child.stdout.on("data", (c) => { out += c; });
  child.stderr.on("data", (c) => { err += c; });
  const [, id] = await until(() => /job=([a-z0-9]{16})/.exec(out), 20000) ?? [];
  assert.ok(id, err);
  await until(() => w.job(id).pid);
  const events = path.join(w.home, "jobs", id, "events.jsonl");
  await until(() => fs.existsSync(events) && fs.readFileSync(events, "utf8").split("\n").filter((l) => l.includes('"type":"text"')).length === 2);
  const grand = w.job(id).pid;
  child.kill("SIGKILL");
  await new Promise((resolve) => child.on("exit", resolve));
  assert.ok(alive(grand), "the orphaned fake child survives its companion");
  const before = fs.readFileSync(path.join(w.home, "jobs", id, "meta.json"), "utf8");
  w.ageBeat(id);
  assert.equal(stateOf(loadJob(w.home, id)), "lost");
  const cancel = await cancelManaged(ctxFor(w), loadJob(w.home, id), { timeoutMs: 15000, control: executionController({ adapter }) });
  assert.equal(cancel.code, 0, cancel.error);
  await until(() => !alive(grand), 5000);
  assert.equal(fs.readFileSync(path.join(w.home, "jobs", id, "meta.json"), "utf8"), before, "recovery writes no metadata");
  assert.ok(fs.existsSync(path.join(w.home, "jobs", id, "stopped")) && !fs.existsSync(path.join(w.home, "jobs", id, "done")));
  assert.equal(inspectClaim(w.home, "null", turn.thread).state, "absent");
  assert.equal(stateOf(loadJob(w.home, id)), "cancelled");
});

test("trustsCleanExit false runs the post-exit scan; a scan that finds owned rows stops them and records the survivor", async () => {
  const w = makeWorld();
  let scans = 0;
  const backend = { pid: 2000000001, stamp: "1", raw: "node fake --thread x", name: "node" };
  let aliveBackend = true;
  const control = { self: () => currentIdentity(), snapshot: () => { scans += 1; return { state: "ok", rows: aliveBackend ? [backend] : [] }; },
    inspect: (_job, snap) => (snap.rows.length ? { state: "owned", rows: snap.rows } : { state: "gone", rows: [] }), stop: () => { aliveBackend = false; return "sent"; } };
  const result = await runTurn(w, turnFor(w), {}, { control });
  assert.ok(scans >= 1, "the clean exit was not trusted");
  assert.equal(aliveBackend, false, "the surviving owned row was stopped");
  assert.match(result.job.error, /survived the launcher/);
  assert.deepEqual([result.job.code, result.job.cleanupPending], [1, false]);
  const trusting = { ...adapter, trustsCleanExit: () => true };
  let scans2 = 0;
  const turn = turnFor(w);
  const trusted = await runManagedTurn(ctxFor(w), trusting, turn, () => turn, timers, { control: { ...control, snapshot: () => { scans2 += 1; return { state: "ok", rows: [] }; } } });
  assert.deepEqual([trusted.job.code, scans2], [0, 0], "a trusted clean exit scans nothing");
});

test("terminal stdout queued after exit is drained before finalization, and cleanup gets the whole shutdown budget", async () => {
  const w = makeWorld();
  const turn = turnFor(w);
  const fakeChild = (play) => {
    const child = new EventEmitter();
    Object.assign(child, { pid: 2000000000, exitCode: null, signalCode: null, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), unref() {}, kill() {} });
    child.stdin.resume();
    setImmediate(() => play(child));
    return child;
  };
  const drained = await runTurn(w, turn, {}, { drainMs: 500, control: { self: () => currentIdentity(), snapshot: () => ({ state: "ok", rows: [] }), inspect: () => ({ state: "gone", rows: [] }), stop: () => "sent" },
    spawn: () => fakeChild((child) => {
      child.stdout.write(`{"type":"start","thread":"${turn.thread}"}\n{"type":"text","data":"Complete "}\n`);
      child.exitCode = 0; child.emit("exit", 0, null);
      setTimeout(() => { child.stdout.write(`{"type":"text","data":"answer"}\n{"type":"end","thread":"${turn.thread}"}\n`); child.stdout.end(); child.stderr.end(); child.emit("close", 0, null); }, 20);
    }) });
  assert.equal(drained.job.code, 0, drained.job.error);
  assert.equal(drained.answer, "Complete answer");
  const slow = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
  const backend = { pid: 2000000001, stamp: "1", raw: "x", name: "node" };
  let aliveBackend = true;
  const second = turnFor(w);
  const budget = await runTurn(w, second, {}, { drainMs: 50, queryMs: 200, shutdownMs: 3000, control: { self: () => currentIdentity(),
    snapshot: (timeout) => { slow(); return timeout < 150 ? { state: "unknown", rows: [] } : { state: "ok", rows: aliveBackend ? [backend] : [] }; },
    inspect: (_job, snap) => (snap.state !== "ok" ? { state: "unknown", rows: [] } : snap.rows.length ? { state: "owned", rows: snap.rows } : { state: "gone", rows: [] }), stop: () => { slow(); aliveBackend = false; return "sent"; } },
  spawn: () => fakeChild((child) => { child.stdout.end(`{"type":"start","thread":"${second.thread}"}\n{"type":"text","data":"ok"}\n{"type":"end","thread":"${second.thread}"}\n`); child.stderr.end(); child.exitCode = 0; child.emit("exit", 0, null); child.emit("close", 0, null); }) });
  assert.equal(aliveBackend, false);
  assert.equal(budget.job.cleanupPending, false, budget.job.error);
  assert.match(budget.job.error, /survived the launcher/);
});

test("the heartbeat exists before the record and stays fresh through a slow stop until the result is published", async () => {
  const w = makeWorld();
  const turn = turnFor(w);
  let dir = null, child = null, backendAlive = true, backendStops = 0;
  const seen = [];
  const blocked = (what) => {
    seen.push(`${what}: ${stateOf(loadJob(w.home, path.basename(dir)))}`);
    const beat = path.join(dir, "beat"), then = new Date(fs.statSync(beat).mtimeMs - 20000);
    fs.utimesSync(beat, then, then);
  };
  const grok = { pid: 2000000010, stamp: "1", raw: "a", name: "node" }, backend = { pid: 2000000011, stamp: "1", raw: "b", name: "node" };
  const control = { self: () => currentIdentity(),
    snapshot: () => { blocked("snapshot"); return { state: "ok", rows: [...(child.signalCode === null ? [grok] : []), ...(backendAlive ? [backend] : [])] }; },
    inspect: (_job, snap) => (snap.rows.length ? { state: "owned", rows: snap.rows } : { state: "gone", rows: [] }),
    stop: (row) => { blocked(row === grok ? "stop grok" : "stop backend"); if (row === grok) setImmediate(() => { child.signalCode = "SIGKILL"; child.emit("exit", null, "SIGKILL"); child.emit("close", null, "SIGKILL"); }); else if (++backendStops === 2) backendAlive = false; return "sent"; } };
  const result = await runTurn(w, turn, {}, { control, platform: "linux-fake", graceMs: 50, retryMs: 200, beforeSpawn: (job) => { dir = job.dir; }, beforeFinalize: () => seen.push(`finalize: ${stateOf(loadJob(w.home, path.basename(dir)))}`),
    spawn() {
      child = new EventEmitter();
      Object.assign(child, { pid: grok.pid, exitCode: null, signalCode: null, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), unref() {}, kill() {} });
      child.stdin.resume();
      setImmediate(() => child.stdout.write("not json at all\n")); // a malformed event: the reader fails the turn at once
      return child;
    } });
  // The first snapshot precedes the group's SIGTERM; after the grace period the rows are SIGKILLed; the post-exit scan stops the backend again.
  assert.deepEqual(seen, ["snapshot: running", "snapshot: running", "stop grok: running", "stop backend: running", "snapshot: running", "stop backend: running", "snapshot: running", "finalize: running"], "every query starts, and the result is published, with a fresh heartbeat");
  assert.deepEqual([result.job.code, result.job.cleanupPending], [1, false]);
  assert.match(result.job.error, /malformed event/);
  assert.equal(stateOf(loadJob(w.home, path.basename(dir))), "failed");
});

test("storage failures: a failed answer append stops the child and fails the turn; a failed marker keeps the claim for recovery", async () => {
  const w = makeWorld();
  const failing = { ...fs, appendFileSync(file, ...rest) { if (String(file).endsWith("answer.md")) throw new Error("fixture answer disk full"); return fs.appendFileSync(file, ...rest); } };
  const result = await runTurn(w, turnFor(w), {}, { io: failing });
  assert.equal(result.job.code, 1);
  assert.match(result.job.error, /answer storage failed: fixture answer disk full/);
  assert.equal(result.job.cleanupPending, false, result.job.error);
  assert.match(fs.readFileSync(path.join(result.job.dir, "events.jsonl"), "utf8"), /"type":"start"/, "the event stream is still saved");
  const turn = turnFor(w);
  const marker = await runTurn(w, turn, {}, { markDone: () => { throw new Error("fixture marker failure"); } });
  assert.deepEqual([marker.job.code, marker.job.cleanupPending], [1, true]);
  assert.match(marker.job.error, /finalization failed: fixture marker failure/);
  assert.equal(inspectClaim(w.home, "null", turn.thread).job, marker.job.id, "the claim is retained when finalization could not complete");
  assert.ok(!fs.existsSync(path.join(marker.job.dir, "done")));
  const gone = { snapshot: () => ({ state: "ok", rows: [] }), inspect: () => ({ state: "gone", rows: [] }), stop: () => "sent" };
  const cancel = await cancelManaged(ctxFor(w), loadJob(w.home, marker.job.id), { timeoutMs: 10000, control: gone });
  assert.equal(cancel.code, 0, cancel.error);
  assert.equal(inspectClaim(w.home, "null", turn.thread).state, "absent", "recovery released the retained claim");
});

test("a spawn failure fails the turn with cleanup confirmed, afterTurn once, and no process", async () => {
  const w = makeWorld();
  const turn = turnFor(w);
  const result = await runTurn(w, turn, {}, { spawn: () => { throw new Error("ENOENT: no such binary"); } });
  assert.deepEqual([result.job.code, result.job.cleanupPending], [1, false]);
  assert.match(result.job.error, /could not start null: ENOENT/);
  assert.deepEqual(hookNames(w), ["beforeTurn", "afterTurn"]);
  assert.equal(inspectClaim(w.home, "null", turn.thread).state, "absent");
});

test("a concurrent turn on a busy thread is refused without spawning, and the history is unchanged", async () => {
  const w = makeWorld();
  const thread = randomUUID();
  const first = runTurn(w, turnFor(w, { thread, env: { COUNCIL_FAKE_HANG: "1" } }), {}, { retryMs: 200, shutdownMs: 5000, beforeSpawn: () => new Promise((r) => setTimeout(r, 400)) });
  await until(() => inspectClaim(w.home, "null", thread).state === "owned");
  const second = await runTurn(w, turnFor(w, { thread, confirmed: true, verb: "reply" }));
  assert.equal(second.job.code, 1);
  assert.match(second.job.error, /is busy as job/);
  assert.equal(second.job.admitted, false);
  const firstId = inspectClaim(w.home, "null", thread).job;
  await until(() => w.job(firstId).pid);
  fs.writeFileSync(path.join(w.home, "jobs", firstId, "cancel"), "");
  const done = await first;
  assert.equal(done.job.outcome, "cancelled");
  assert.equal(w.fakeCalls().length, 1, "the refused turn never spawned");
});
