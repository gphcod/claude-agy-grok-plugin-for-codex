// Check the eight Claude-hosted rc.9 findings against the Codex-hosted paths.
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { makeWorld, ctxFor, turnFor, adapter, ENTRY } from "./helpers.mjs";
import { resolveThread, planTurn } from "../plugins/council/scripts/lib/cli/plan.mjs";
import { createJob, saveJob, markDone, markStopped, saveThread, loadThread, loadJob, prune, latestOnThread } from "../plugins/council/scripts/lib/core/jobs.mjs";
import { runManagedTurn } from "../plugins/council/scripts/lib/core/lifecycle.mjs";
import { serviceRetry } from "../plugins/council/scripts/lib/core/gemini-service.mjs";
import { currentIdentity } from "../plugins/council/scripts/lib/core/execution.mjs";
import { collectTarget } from "../plugins/council/scripts/lib/core/git.mjs";
import { collectReview } from "../plugins/council/scripts/lib/core/review.mjs";
import * as repos from "./fixtures/build-repos.mjs";

const OLD = "11111111-1111-4111-8111-111111111111";
const fields = (w, at, extra = {}) => ({ provider: "grok", verb: "ask", cwd: w.workspace, session: null,
  status: "running", admitted: true, companionPid: process.pid, threadIds: [], spawnedAt: new Date(at).toISOString(), ...extra });
function older(w) {
  const job = createJob(w.home, fields(w, Date.now() - 60000, { threadId: OLD }));
  Object.assign(job, { outcome: "ok", code: 0 }); saveJob(job); markDone(job);
  saveThread(w.home, { provider: "grok", threadId: OLD, cwd: w.workspace, round: 1, rounds: 9 });
  return job;
}

test("--last refuses an open or lost newer Grok job instead of selecting an older conversation", () => {
  const w = makeWorld(); older(w);
  const job = createJob(w.home, fields(w, Date.now()));
  for (const pid of [process.pid, 2000000000]) {
    job.companionPid = pid; saveJob(job);
    assert.throws(() => resolveThread(ctxFor(w), "reply", { last: true }), new RegExp(`job ${job.id}.*wait.*cancel`));
  }
  markStopped(job);
  assert.equal(resolveThread(ctxFor(w), "reply", { last: true }).threadId, OLD);
});

test("--last blocks unadmitted open work, skips completed threadless attempts, and selects a completed conversation", () => {
  const w = makeWorld(); older(w);
  const rejected = createJob(w.home, fields(w, Date.now() - 2000, { admitted: false }));
  assert.throws(() => resolveThread(ctxFor(w), "reply", { last: true }), /not admitted yet.*wait.*cancel/);
  markDone(rejected);
  const newer = createJob(w.home, fields(w, Date.now() - 1000)); markDone(newer);
  assert.equal(resolveThread(ctxFor(w), "reply", { last: true }).threadId, OLD);
  newer.threadId = "22222222-2222-4222-8222-222222222222"; saveJob(newer);
  assert.equal(resolveThread(ctxFor(w), "reply", { last: true }).threadId, newer.threadId);
});

test("closing stderr before the real entry's start line still permits durable finalization", { timeout: 60000 }, async () => {
  const w = makeWorld();
  const child = spawn(process.execPath, [ENTRY, "ask", "--to", "null", "--", "q"], {
    cwd: w.workspace, env: w.env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = new Promise((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
  child.stderr.destroy();
  let out = ""; child.stdout.on("data", chunk => out += chunk);
  const timer = setTimeout(() => child.kill(), 45000);
  let code; try { code = await exited; } finally { clearTimeout(timer); }
  assert.equal(code, 0, out);
  const dirs = fs.readdirSync(path.join(w.home, "jobs")); assert.equal(dirs.length, 1);
  assert.ok(fs.existsSync(path.join(w.home, "jobs", dirs[0], "done")));
  assert.match(out, /council null ok/);
});

test("persistent thread-read locks already fail closed instead of bypassing resumable:false", t => {
  const w = makeWorld(), job = older(w);
  saveThread(w.home, { provider: "grok", threadId: OLD, resumable: false, unconfirmed: "not resumable" });
  assert.throws(() => resolveThread(ctxFor(w), "reply", { thread: job.id }), /not resumable/);
  const file = path.join(w.home, "threads", `grok-${OLD}.json`), read = fs.readFileSync;
  t.mock.method(fs, "readFileSync", function (target, ...rest) {
    if (String(target) === file) throw Object.assign(new Error("fixture locked"), { code: "EBUSY" });
    return read.call(this, target, ...rest);
  });
  assert.throws(() => resolveThread(ctxFor(w), "reply", { thread: job.id }), /cannot read state record/);
});

test("invalid thread/provider references perform no record read", t => {
  const w = makeWorld(); let reads = 0;
  t.mock.method(fs, "readFileSync", () => { reads += 1; throw Object.assign(new Error("missing"), { code: "ENOENT" }); });
  for (const id of ["../outside", "a/../../outside", "..\\outside", "", null, undefined]) assert.equal(loadThread(w.home, "grok", id), null);
  assert.equal(loadThread(w.home, "x/../..", "outside"), null);
  assert.equal(reads, 0);
});

for (const setting of ["diff.noprefix", "diff.mnemonicPrefix"]) test(`canonical coverage already survives ${setting} for working tree, base and commit`, () => {
  const dir = repos.init(path.join(repos.tmp(), "repo"));
  repos.commit(dir, { "small.txt": "one\n", "large.txt": "one\n" }, "base");
  repos.git(dir, ["config", setting, "true"]);
  repos.write(dir, "small.txt", "two\n"); repos.write(dir, "large.txt", "x".repeat(6000) + "\n");
  const names = options => collectTarget(dir, options).entries.map(e => e.path).sort();
  assert.deepEqual(names({ uncommitted: true }), ["large.txt", "small.txt"]);
  const review = collectReview(dir, { uncommitted: true }, { inlineCap: 2048 });
  assert.ok(review.snapshot.index.units.some(u => u.path === "large.txt"));
  repos.git(dir, ["add", "-A"]); repos.git(dir, ["commit", "-qm", "change"]);
  for (const options of [{ commit: "HEAD" }, { base: "HEAD~1" }]) assert.deepEqual(names(options), ["large.txt", "small.txt"]);
});

for (const style of ["log", "diff"]) test(`canonical coverage already includes a real submodule under diff.submodule=${style}`, () => {
  const root = repos.tmp(), inner = repos.init(path.join(root, "inner")), outer = repos.init(path.join(root, "outer"));
  repos.commit(inner, { "f.txt": "one\n" }, "base");
  repos.git(outer, ["-c", "protocol.file.allow=always", "submodule", "--quiet", "add", inner, "sub"]);
  repos.commit(outer, { "other.txt": "one\n" }, "base");
  const sub = path.join(outer, "sub");
  repos.git(sub, ["config", "user.name", "Fixture"]); repos.git(sub, ["config", "user.email", "fixture@example.invalid"]);
  repos.git(sub, ["config", "commit.gpgsign", "false"]);
  repos.commit(sub, { "f.txt": "two\n" }, "moved");
  repos.git(outer, ["config", "diff.submodule", style]);
  assert.ok(collectTarget(outer, { uncommitted: true }).entries.some(e => e.path === "sub"));
  assert.ok(collectReview(outer, { uncommitted: true }).unsupported.some(name => name.startsWith("sub")));
});

const timers = { json: true, deadlineMs: 15000, inactivityMs: 15000 };
for (const failure of ["spawn", "async-spawn", "beforeTurn", "cancel"]) test(`an unstarted resumed ${failure} leaves thread bytes and subsequent inheritance unchanged`, async () => {
  const w = makeWorld(), seed = turnFor(w, { round: 1 });
  const first = await runManagedTurn(ctxFor(w), adapter, seed, () => seed, timers);
  assert.equal(first.job.code, 0, first.job.error);
  const file = path.join(w.home, "threads", `null-${seed.thread}.json`), before = fs.readFileSync(file, "utf8");
  const resumed = turnFor(w, { verb: "task", thread: seed.thread, confirmed: true, round: 2, model: "null-fast", effort: "high" });
  const build = resumed.build; resumed.build = dir => ({ ...build(dir), agent: "default" });
  const hooks = failure === "spawn" ? { spawn: () => { throw new Error("spawn refused"); } }
    : failure === "async-spawn" ? { spawn: () => {
      const child = Object.assign(new EventEmitter(), { pid: undefined, exitCode: null, signalCode: null,
        stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), unref() {} });
      setImmediate(() => { child.stdout.end(); child.stderr.end(); child.emit("error", new Error("async spawn refused")); child.emit("close", 1); });
      return child;
    } }
    : failure === "cancel" ? { beforeSpawn: job => fs.writeFileSync(path.join(job.dir, "cancel"), "") } : {};
  const implementation = failure === "beforeTurn" ? { ...adapter, beforeTurn: () => { throw new Error("beforeTurn refused"); } } : adapter;
  const failed = await runManagedTurn(ctxFor(w), implementation, resumed, () => resumed, timers, hooks);
  assert.equal(failed.job.code, 1);
  assert.equal(fs.readFileSync(file, "utf8"), before, "no round, model, effort, agent or timestamp mutation");
  assert.equal(latestOnThread(w.home, "null", seed.thread).id, first.job.id);
  const plan = planTurn(ctxFor(w), adapter, "reply", { thread: first.job.id }, "delta", {});
  const next = plan.prepare(null);
  assert.deepEqual([next.round, next.model, next.effort], [2, "null-model", "low"]);
});

function syntheticChild(play) {
  const child = Object.assign(new EventEmitter(), { pid: 2000000000, exitCode: null, signalCode: null,
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), unref() {}, kill() {} });
  child.stdin.resume(); setImmediate(() => play(child)); return child;
}
const gone = { self: () => currentIdentity(), snapshot: () => ({ state: "ok", rows: [] }),
  inspect: () => ({ state: "gone", rows: [] }), stop: () => "sent" };

test("a resumed provider that started and then failed still records its round", async () => {
  const w = makeWorld(), turn = turnFor(w, { verb: "reply", thread: OLD, confirmed: true, round: 2 });
  saveThread(w.home, { provider: "null", threadId: OLD, round: 1 });
  const result = await runManagedTurn(ctxFor(w), adapter, turn, () => turn, timers, { control: gone,
    spawn: () => syntheticChild(child => { child.exitCode = 1; child.stdout.end(); child.stderr.end(); child.emit("exit", 1); child.emit("close", 1); }) });
  assert.equal(result.job.code, 1); assert.equal(loadThread(w.home, "null", OLD).round, 2);
});

test("a resumed 503 with no stream-confirmed thread cannot offer automatic retry", async () => {
  const w = makeWorld(), turn = turnFor(w, { verb: "reply", thread: OLD, confirmed: true, round: 2 });
  const fakeGemini = { ...adapter, id: "gemini", parseEvent: () => ({ fatal: "API error (attempt 1): UNAVAILABLE (code 503): unavailable",
    transientFailure: { category: "service_unavailable", status: 503, noVisibleWork: true } }) };
  const result = await runManagedTurn(ctxFor(w), fakeGemini, turn, () => turn, timers, { control: gone,
    spawn: () => syntheticChild(child => { child.stdout.end("{}\n"); child.stderr.end(); child.exitCode = 1; child.emit("exit", 1); child.emit("close", 1); }) });
  assert.equal(result.job.code, 1, result.job.error);
  assert.equal(result.job.transientFailure?.status, 503);
  assert.equal(serviceRetry(result.job).eligible, false);
});

test("pruning keeps a finished job with unreadable claims without failing the next turn", () => {
  const w = makeWorld(); let oldest;
  for (let i = 0; i < 101; i++) {
    const job = createJob(w.home, fields(w, Date.now() - 200000 + i * 1000, { threadId: `t-${i}` }));
    job.outcome = "ok"; job.code = 0; saveJob(job); markDone(job); oldest ??= job;
  }
  fs.mkdirSync(path.join(w.home, "claims"), { recursive: true });
  fs.writeFileSync(path.join(w.home, "claims", "grok"), "not a directory");
  assert.doesNotThrow(() => prune(w.home));
  assert.ok(loadJob(w.home, oldest.id));
});

test("claims becoming unreadable during prune's final recheck keep the job", t => {
  const w = makeWorld(); let oldest;
  for (let i = 0; i < 101; i++) {
    const job = createJob(w.home, fields(w, Date.now() - 200000 + i * 1000, { threadId: `t-${i}` }));
    saveJob(job); markDone(job); oldest ??= job;
  }
  const read = fs.readdirSync, directory = path.join(w.home, "claims", "grok"); let checks = 0;
  t.mock.method(fs, "readdirSync", function (file, ...rest) {
    if (String(file) === directory && ++checks >= 2) throw Object.assign(new Error("claim access refused"), { code: "EACCES" });
    return read.call(this, file, ...rest);
  });
  assert.doesNotThrow(() => prune(w.home));
  assert.equal(checks, 2); assert.ok(loadJob(w.home, oldest.id));
});

test("the real entry refuses retry for a resumed native Gemini 503 without any thread event", () => {
  const w = makeWorld(), log = path.join(w.dir, "transient.jsonl");
  fs.writeFileSync(log, "{}\n"); // The normal fake establishes the original thread.
  const env = { COUNCIL_AGY_BIN: path.join(path.dirname(ENTRY), "..", "..", "..", "tests", "fixtures", "fake-agy-transient.mjs"),
    COUNCIL_FAKE_TRANSIENT_LOG: log, COUNCIL_FAKE_JOB_DIR: path.join(w.home, "jobs"), COUNCIL_FAKE_EXPECT_PROMPT_CONTAINS: "",
    COUNCIL_FAKE_EXPECT_CONTRACT: fs.readFileSync(path.join(path.dirname(ENTRY), "..", "contract.md"), "utf8").trim(), COUNCIL_FAKE_TRANSIENT_NO_ID: "1" };
  const seed = w.call(["ask", "--to", "gemini", "--json", "--request-id", "seed", "--", "pong"], { env: { ...env, COUNCIL_FAKE_SCENARIO: "ok" } });
  assert.equal(seed.status, 0, seed.stderr + seed.stdout);
  fs.writeFileSync(log, "");
  const args = ["reply", JSON.parse(seed.stdout).job, "--json", "--request-id", "early-503", "--", "pong"];
  const failed = w.call(args, { env: { ...env, COUNCIL_FAKE_SCENARIO: "resume" } });
  assert.equal(failed.status, 1, failed.stderr + failed.stdout);
  const result = JSON.parse(failed.stdout);
  assert.deepEqual([result.retry?.status, result.retry?.eligible, result.retry?.maxRetries], [503, false, 0]);
  const replay = w.call(args, { env: { ...env, COUNCIL_FAKE_SCENARIO: "resume" } });
  assert.equal(replay.status, 1); assert.equal(JSON.parse(replay.stdout).job, result.job);
  assert.equal(fs.readFileSync(log, "utf8").trim().split("\n").length, 1, "one failed submission; same id replays it");
});

test("Claude F1: an explicit unstarted job id cannot replace pruned thread history", () => {
  const w = makeWorld();
  saveThread(w.home, { provider: "null", threadId: OLD, cwd: w.workspace, round: 1, rounds: 9,
    model: "null-model", effort: "low", requestedEffort: "low", tier: "consult", agent: "explore" });
  const failed = createJob(w.home, { ...fields(w, Date.now()), provider: "null", verb: "task", threadId: OLD,
    providerStarted: false, model: "null-fast", effort: "high", requestedEffort: "high", tier: "exec", round: 2, rounds: 9, agent: "default" });
  failed.code = 1; failed.outcome = "failed"; saveJob(failed); markDone(failed);
  let request;
  const capture = { ...adapter, buildTurn(input) { request = input; return adapter.buildTurn(input); } };
  const next = planTurn(ctxFor(w), capture, "reply", { thread: failed.id }, "delta", {}).prepare(null);
  assert.deepEqual([next.round, next.model, next.effort], [2, "null-model", "low"]);
  next.build(path.join(w.home, "planned-job"));
  assert.equal(request.agent, "explore");
});

test("Claude F3: unstarted job and native ids without started history or a record cannot move a thread", () => {
  const w = makeWorld();
  const failed = createJob(w.home, { ...fields(w, Date.now()), provider: "null", verb: "task", threadId: OLD,
    providerStarted: false, round: 2, rounds: 9, cwd: w.workspace, agent: "default" });
  failed.code = 1; saveJob(failed); markDone(failed);
  const other = path.join(w.dir, "other-workspace"); fs.mkdirSync(other);
  for (const ref of [failed.id, OLD]) assert.throws(() => resolveThread(ctxFor(w, { cwd: other }), "reply", { thread: ref }), /no started history or retained record.*new ask/);
});

test("a late unreadable dependent keeps its older review snapshot during pruning", t => {
  const w = makeWorld(); let owner, dependent;
  for (let i = 0; i < 102; i++) {
    const extra = i === 1 ? { reviewState: { inputRoot: path.join(owner.dir, "review-input"), pending: 0, synthesisPending: false } } : {};
    const job = createJob(w.home, fields(w, Date.now() - 200000 + i * 1000, { threadId: `t-${i}`, ...extra }));
    job.code = 0; saveJob(job); markDone(job); owner ??= job;
    if (i === 1) dependent = job;
  }
  const read = fs.readdirSync, directory = path.join(w.home, "claims", "grok"); let checks = 0;
  t.mock.method(fs, "readdirSync", function (file, ...rest) {
    if (String(file) === directory && ++checks === 3) throw Object.assign(new Error("dependent claim unreadable"), { code: "EACCES" });
    return read.call(this, file, ...rest);
  });
  assert.doesNotThrow(() => prune(w.home));
  assert.ok(loadJob(w.home, dependent.id), "dependent kept on its final claim-read failure");
  assert.ok(loadJob(w.home, owner.id), "the still-kept dependent must not lose its older snapshot owner");
});
