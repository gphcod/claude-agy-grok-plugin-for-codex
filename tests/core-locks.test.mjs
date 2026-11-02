// S2.4/S2.6: the held-output lock of A7.8 through the entry, a reservation still preparing (A7.4), claim publication
// failures inside the lifecycle, and small core edges (heartbeat refresh, an unsupported process table, --json quietness).
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { makeWorld, ctxFor, turnFor, adapter, alive, until, jobIdOf, footerOf } from "./helpers.mjs";
import { main } from "../plugins/council/scripts/council.mjs";
import { requestJobId, requestKey, loadJob, createJob, saveJob } from "../plugins/council/scripts/lib/core/jobs.mjs";
import { spawnSync } from "node:child_process";
import { inspectClaim } from "../plugins/council/scripts/lib/core/claims.mjs";
import { runManagedTurn } from "../plugins/council/scripts/lib/core/lifecycle.mjs";
import { beatAgeMs, refreshBeat, touchBeat } from "../plugins/council/scripts/lib/core/heartbeat.mjs";
import { runDescriptor } from "../plugins/council/scripts/lib/core/preflight.mjs";
import { currentIdentity } from "../plugins/council/scripts/lib/core/execution.mjs";

/** main() in-process, with output captured and lifecycle seams; stdin is an ended stream. */
async function inProcess(w, args, { env = {}, hooks = {} } = {}) {
  let out = "", err = "";
  const { PassThrough } = await import("node:stream");
  const stdin = new PassThrough();
  stdin.end("");
  const code = await main(args, { ...w.env, ...env }, { stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { err += s; } }, stdin }, { cwd: w.workspace, hooks });
  return { code, out, err };
}

test("through the entry: output held open after a clean exit locks the thread; only cancel --confirm-ended after the holder is gone releases it", async () => {
  const w = makeWorld();
  const pidFile = path.join(w.dir, "holder.pid");
  const r = await inProcess(w, ["ask", "--to", "null", "--", "q"], { env: { COUNCIL_FAKE_SCENARIO: "hold-pipes", COUNCIL_FAKE_HOLD_MS: "30000", COUNCIL_FAKE_HOLD_PID: pidFile },
    hooks: { pipeWaitMs: 500, drainMs: 100 } });
  const holder = Number(fs.readFileSync(pidFile, "utf8"));
  try {
    assert.equal(r.code, 1, r.out + r.err);
    const job = jobIdOf(r.err);
    assert.match(footerOf(r.out), new RegExp(`thread locked: null's output stayed open past 500 ms, held by a process this turn cannot identify · thread locked; next: cancel ${job} --confirm-ended after checking the process table; do not resume$`));
    assert.match(r.out, /^fake answer to: q\n/, "the answer itself arrived whole");
    const thread = w.job(job).requestedThreadId;
    assert.equal(inspectClaim(w.home, "null", thread).job, job);
    const live = w.call(["cancel", job, "--timeout", "0.5"]);
    assert.match(live.stdout, /^not-stopped/, "while its companion (this process) lives, nothing is released");
    // The companion of a real call exits after printing; record it as gone, as the process table would show it.
    const record = loadJob(w.home, job);
    saveJob({ ...record, companionPid: spawnSync(process.execPath, ["-e", "0"]).pid, companionIdentity: { pid: 1, stamp: "exited" } });
    const plain = w.call(["cancel", job, "--timeout", "2"]);
    assert.equal(plain.status, 1);
    assert.match(plain.stdout, /thread stays locked until cancel .* --confirm-ended/);
    assert.equal(w.call(["wait"]).stdout.includes("cleanup pending"), true, "wait shows the job as cleanup pending");
  } finally { try { process.kill(holder, "SIGKILL"); } catch { /* gone */ } }
  await until(() => !alive(holder));
  const job = jobIdOf(r.err);
  const released = w.call(["cancel", job, "--confirm-ended", "--json"]);
  assert.equal(released.status, 0, released.stdout + released.stderr);
  assert.deepEqual([JSON.parse(released.stdout).status, JSON.parse(released.stdout).released], ["finished", true]);
  assert.equal(inspectClaim(w.home, "null", w.job(job).requestedThreadId).state, "absent");
  assert.equal(w.call(["reply", job, "--", "again"]).status, 0, "the thread is usable again");
});

test("a retry whose first call is still preparing (its companion alive, no job yet) waits within its deadline, then reports 20", async () => {
  const w = makeWorld();
  const cwd = fs.realpathSync(w.workspace);
  const key = requestKey(null, cwd, "slow");
  const job = requestJobId("null", null, cwd, "slow");
  const first = await inProcess(w, ["ask", "--to", "null", "--request-id", "fp-source", "--deadline", "0.6", "--", "q"]);
  assert.equal(first.code, 0);
  const fingerprint = JSON.parse(fs.readFileSync(path.join(w.home, "requests", `${requestKey(null, cwd, "fp-source")}.json`), "utf8")).fingerprint;
  fs.writeFileSync(path.join(w.home, "requests", `${key}.json`), JSON.stringify({ state: "reserved", id: "slow", key, provider: "null", job, session: null, cwd, fingerprint,
    companionPid: process.pid, companionIdentity: currentIdentity(process.pid) }));
  const started = Date.now();
  const r = await inProcess(w, ["ask", "--to", "null", "--request-id", "slow", "--deadline", "0.6", "--", "q"]);
  assert.equal(r.code, 20, r.out + r.err);
  assert.match(r.out, new RegExp(`^still preparing · null · job ${job} · the first call with this request id has not started yet`));
  assert.ok(Date.now() - started >= 500);
  assert.equal(w.fakeCalls().length, 1, "the retry started nothing");
});

test("a claim whose publication fails is kept as an unknown claim on the job, which then holds the thread for recovery", async () => {
  const w = makeWorld();
  const turn = turnFor(w);
  const claimIo = { ...fs, writeFileSync(file, ...rest) { if (path.basename(String(file)).startsWith("owner-")) throw new Error("fixture claim disk full"); return fs.writeFileSync(file, ...rest); } };
  const result = await runManagedTurn(ctxFor(w), adapter, turn, () => turn, { json: true, deadlineMs: 5000, inactivityMs: 5000 }, { claimIo });
  assert.equal(result.job.code, 1);
  assert.match(result.job.error, /fixture claim disk full/);
  assert.deepEqual(result.job.threadIds, [turn.thread], "the job records the claim it left behind");
  assert.equal(inspectClaim(w.home, "null", turn.thread).state, "unknown");
  assert.equal(result.job.claimHeld, true, "an unknown claim on one of its threads counts as held");
  assert.equal(w.fakeCalls().length, 0);
});

test("--json suppresses the start line; text output prints it on stderr only", () => {
  const w = makeWorld();
  const json = w.call(["ask", "--to", "null", "--json", "--", "q"]);
  assert.equal(json.stderr, "");
  assert.equal(JSON.parse(json.stdout).status, "ok");
  const text = w.call(["ask", "--to", "null", "--", "q"]);
  assert.match(text.stderr, /^\[council\] provider=null job=[a-z0-9]{16}\n$/);
  assert.doesNotMatch(text.stdout, /\[council\]/);
});

test("heartbeat helpers: touch creates, refresh reports storage failure without throwing, age is Infinity when missing", () => {
  const w = makeWorld({ git: false });
  const job = createJob(w.home, { provider: "null", status: "running", cwd: w.dir, spawnedAt: new Date().toISOString() });
  assert.ok(beatAgeMs(job) < 5000);
  const then = new Date(Date.now() - 60000);
  fs.utimesSync(path.join(job.dir, "beat"), then, then);
  assert.ok(beatAgeMs(job) >= 59000);
  assert.equal(refreshBeat(job), true);
  assert.ok(beatAgeMs(job) < 5000);
  assert.equal(refreshBeat(job, { ...fs, utimesSync() { throw new Error("read-only"); } }), false);
  fs.rmSync(path.join(job.dir, "beat"));
  assert.equal(beatAgeMs(job), Infinity);
  assert.equal(refreshBeat(job), false, "refresh never recreates a missing beat");
  touchBeat(job);
  assert.ok(beatAgeMs(job) < 5000, "touch does");
  assert.equal(loadJob(w.home, job.id).beatMs > 0, true);
});

test("a process-table descriptor on a platform without a query is blocked, never read as an empty table", async () => {
  const r = await runDescriptor({ kind: "process-table", target: "ps", timeoutMs: 1000 }, { platform: "aix" });
  assert.deepEqual(r, { ok: false, detail: "process query returned no table" });
});
