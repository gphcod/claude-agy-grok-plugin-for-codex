// S2.3: job records, ids, request records and tombstones, candidates, pruning, thread records (ported from
// grok_plugin_for_codex tests/jobs.test.mjs, job-recovery.test.mjs and requests.test.mjs; codex-plugin-cc pruning).
// Entry-driven replay cases (spawn counts, --last recovery) run through main() in S2.6.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { KEEP_FINISHED, StateError, assertStateOutsideWorkspace, candidates, claimRequest, cleanupNeeded, createJob, describeEvent, findJob, homeDir,
  lastEvent, latestOnThread, listJobs, loadJob, loadThread, lookupRequest, markDone, markRequestPrepared, markStopped, onThread, providersOf, prune,
  releaseRequest, requestFingerprint, requestJobId, requestKey, requestReserved, reserveJob, resultRecord, reviewInputPending, saveJob, saveThread, stateOf,
  threadProviders } from "../plugins/council/scripts/lib/core/jobs.mjs";
import { claimThread } from "../plugins/council/scripts/lib/core/claims.mjs";
import { BEAT_MS, BEAT_STALE_MS, beatAgeMs, touchBeat } from "../plugins/council/scripts/lib/core/heartbeat.mjs";
import { UsageError } from "../plugins/council/scripts/lib/core/args.mjs";

const tmp = (prefix = "council-jobs-") => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
function fixture(t) {
  const home = tmp();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const make = (fields = {}) => createJob(home, { provider: "grok", cwd: home, session: "mine", status: "running", threadId: "thread-a", spawnedAt: new Date().toISOString(), ...fields });
  return { home, make };
}

test("the state root comes from COUNCIL_CODEX_HOME (default ~/.codex/council), is created and canonical, and never inside the workspace", (t) => {
  const root = tmp();
  const link = path.join(root, "alias");
  const real = path.join(root, "real");
  fs.mkdirSync(real);
  fs.symlinkSync(real, link, process.platform === "win32" ? "junction" : "dir");
  const home = homeDir({ COUNCIL_CODEX_HOME: path.join(link, "state") });
  assert.equal(home, path.join(real, "state"), "the aliased root resolves to its real path on first use");
  assert.ok(fs.existsSync(home));
  assert.ok(homeDir({}).endsWith(path.join(".codex", "council")));
  assert.throws(() => assertStateOutsideWorkspace(home, real), StateError);
  assert.throws(() => assertStateOutsideWorkspace(home, link), /lies inside the workspace/, "the workspace is compared by real path too");
  assert.doesNotThrow(() => assertStateOutsideWorkspace(home, path.join(root, "elsewhere")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
});

test("both id routes produce 16 characters, and a request id's job id is derived from provider, session, cwd and id", (t) => {
  const { home } = fixture(t);
  const fresh = reserveJob(home);
  assert.match(fresh, /^[a-z0-9]{16}$/);
  assert.ok(fs.existsSync(path.join(home, "jobs", fresh)), "the directory is reserved before any record");
  const derived = requestJobId("grok", "s1", "/w", "r1");
  assert.match(derived, /^[0-9a-f]{16}$/);
  assert.equal(derived, requestJobId("grok", "s1", "/w", "r1"));
  for (const other of [requestJobId("claude", "s1", "/w", "r1"), requestJobId("grok", "s2", "/w", "r1"), requestJobId("grok", "s1", "/x", "r1"), requestJobId("grok", "s1", "/w", "r2"), requestJobId("grok", null, "/w", "r1")]) {
    assert.notEqual(other, derived);
  }
});

test("request keys scope by session, cwd and id; fingerprints cover the raw inputs but not --json, --request-id or --timeout", () => {
  const key = requestKey("s1", "/w", "r1");
  assert.match(key, /^[0-9a-f]{40}$/);
  assert.equal(key, requestKey("s1", "/w", "r1"));
  assert.notEqual(key, requestKey(null, "/w", "r1"));
  assert.notEqual(key, requestKey("s1", "/x", "r1"));
  for (const bad of ["", "-x", "a b", "x".repeat(129), "é"]) assert.throws(() => requestKey("s1", "/w", bad), (e) => e instanceof UsageError && /--request-id needs/.test(e.message));
  const fp = requestFingerprint("ask", { to: "grok", tier: "deep", "request-id": "r1", json: true, timeout: "5" }, "q");
  assert.equal(fp, requestFingerprint("ask", { to: "grok", tier: "deep" }, "q"), "presentation and scope options are not inputs");
  assert.equal(fp, requestFingerprint("ask", { tier: "deep", to: "grok" }, "q"), "option order does not matter");
  for (const changed of [requestFingerprint("ask", { to: "grok", tier: "deep" }, "other"), requestFingerprint("ask", { to: "grok", tier: "exec" }, "q"),
    requestFingerprint("task", { to: "grok", tier: "deep" }, "q"), requestFingerprint("ask", { to: "claude", tier: "deep" }, "q"), requestFingerprint("ask", { to: "grok", tier: "deep", "allow-command": ["x"] }, "q")]) {
    assert.notEqual(changed, fp);
  }
});

test("request lifecycle: exclusive reservation, lookup recovers the provider, tombstone after prepare, release when nothing ran", (t) => {
  const { home } = fixture(t);
  const key = requestKey("s1", home, "r1");
  const jobId = requestJobId("grok", "s1", home, "r1");
  const base = { key, requestId: "r1", provider: "grok", session: "s1", cwd: home, fingerprint: "fp", jobId, companionIdentity: { pid: process.pid } };
  assert.equal(lookupRequest(home, key), null);
  const first = claimRequest(home, base);
  assert.equal(first.fresh, true);
  assert.deepEqual([first.record.state, first.record.provider, first.record.job, first.record.fingerprint, first.record.companionPid], ["reserved", "grok", jobId, "fp", process.pid]);
  assert.ok(fs.existsSync(path.join(home, "jobs", jobId)), "the job directory is claimed with the reservation");
  const again = claimRequest(home, { ...base, provider: "claude", fingerprint: "other" });
  assert.equal(again.fresh, false);
  assert.equal(again.record.provider, "grok", "the existing record keeps the original provider binding");
  assert.equal(requestReserved(home, key), true);
  markRequestPrepared(home, key);
  assert.equal(lookupRequest(home, key).state, "tombstone");
  assert.ok(lookupRequest(home, key).preparedAt);
  // A call that fails before preparation frees the id and its directory.
  const key2 = requestKey("s1", home, "r2");
  const job2 = requestJobId("grok", "s1", home, "r2");
  claimRequest(home, { ...base, key: key2, requestId: "r2", jobId: job2 });
  releaseRequest(home, key2, job2);
  assert.equal(requestReserved(home, key2), false);
  assert.ok(!fs.existsSync(path.join(home, "jobs", job2)));
  assert.equal(claimRequest(home, { ...base, key: key2, requestId: "r2", jobId: job2 }).fresh, true, "the id runs again");
  // An existing job directory under the derived id refuses the claim and leaves no record behind.
  const key3 = requestKey("s1", home, "r3");
  const job3 = requestJobId("grok", "s1", home, "r3");
  fs.mkdirSync(path.join(home, "jobs", job3), { recursive: true });
  assert.throws(() => claimRequest(home, { ...base, key: key3, requestId: "r3", jobId: job3 }), /job directory .* already exists/);
  assert.equal(requestReserved(home, key3), false);
});

test("an unreadable request record is waited for, then reported, never read as absent", (t) => {
  const { home } = fixture(t);
  const key = requestKey(null, home, "slow");
  fs.mkdirSync(path.join(home, "requests"), { recursive: true });
  const file = path.join(home, "requests", `${key}.json`);
  fs.writeFileSync(file, "");
  // The lookup blocks synchronously (as a replaying companion does), so the slow writer is another process.
  const writer = spawn(process.execPath, ["-e", `setTimeout(() => require("fs").writeFileSync(${JSON.stringify(file)}, ${JSON.stringify(JSON.stringify({ fingerprint: "f", job: "a".repeat(16), provider: "grok" }))}), 150)`], { stdio: "ignore" });
  assert.equal(lookupRequest(home, key, { waitMs: 3000 }).job, "a".repeat(16));
  writer.kill();
  fs.writeFileSync(path.join(home, "requests", `${key}.json`), "{broken");
  assert.throws(() => lookupRequest(home, key, { waitMs: 60 }), /unreadable record/);
});

test("stale and cleanup-pending results block until explicit recovery; the stop marker ends it without a second writer", (t) => {
  const { home, make } = fixture(t);
  const job = make();
  assert.equal(stateOf(loadJob(home, job.id)), "running");
  fs.utimesSync(path.join(job.dir, "beat"), new Date(0), new Date(0));
  assert.equal(stateOf(loadJob(home, job.id)), "lost");
  assert.equal(cleanupNeeded(loadJob(home, job.id)), true, "a lost job blocks until recovered");
  Object.assign(job, { status: "failed", outcome: "failed", code: 1, cleanupPending: true });
  saveJob(job); markDone(job);
  assert.equal(cleanupNeeded(loadJob(home, job.id)), true, "a failure that left cleanup pending still blocks");
  const before = fs.readFileSync(path.join(job.dir, "meta.json"), "utf8");
  markStopped(job); markStopped(job);
  assert.equal(cleanupNeeded(loadJob(home, job.id)), false, "the stop marker ends recovery");
  assert.equal(fs.readFileSync(path.join(job.dir, "meta.json"), "utf8"), before);
  assert.equal(resultRecord(loadJob(home, job.id)).outcome, "failed");
  const lost = make();
  fs.writeFileSync(path.join(lost.dir, "cancel"), ""); markStopped(lost);
  const recovered = loadJob(home, lost.id);
  assert.deepEqual([stateOf(recovered), cleanupNeeded(recovered), resultRecord(recovered).code, resultRecord(recovered).outcome, recovered.done], ["cancelled", false, 1, "cancelled", false]);
  assert.match(lost.ownerToken, /^[a-f0-9]{32}$/);
  const running = resultRecord(make());
  assert.deepEqual([running.code, running.cleanupPending], [1, true]);
  assert.match(running.error, /companion lost; run cancel before resuming/);
});

test("read-time markers never leak into metadata on save", (t) => {
  const { home, make } = fixture(t);
  const job = make(); markStopped(job);
  saveJob(loadJob(home, job.id));
  const meta = JSON.parse(fs.readFileSync(path.join(job.dir, "meta.json")));
  for (const field of ["dir", "done", "beatMs", "stopped", "stoppedAt", "cancelRequested", "claimHeld"]) assert.equal(Object.hasOwn(meta, field), false, field);
  assert.equal(meta.provider, "grok");
});

test("rejected attempts do not become inherited settings; thread queries are namespaced by provider", (t) => {
  const { home, make } = fixture(t);
  const first = make({ admitted: true, requestedThreadId: "old", threadIds: ["old", "thread-a"], model: "kept" });
  Object.assign(first, { status: "done", code: 0 }); saveJob(first); markDone(first);
  make({ admitted: false, model: "rejected", spawnedAt: "9999-01-01T00:00:00.000Z" });
  assert.equal(latestOnThread(home, "grok", "thread-a").id, first.id);
  assert.equal(latestOnThread(home, "grok", "THREAD-A").id, first.id, "case-insensitive");
  assert.equal(findJob(home, "old").id, first.id);
  assert.equal(latestOnThread(home, "grok", "thread-a", first.id), null);
  assert.equal(latestOnThread(home, "claude", "thread-a"), null, "another provider's history is separate");
  assert.ok(onThread(first, null, "old") && onThread(first, "grok", "thread-a") && !onThread(first, "claude", "thread-a"));
  const claude = make({ provider: "claude", admitted: true, model: "claude-model" });
  Object.assign(claude, { status: "done", code: 0 }); saveJob(claude); markDone(claude);
  assert.deepEqual(providersOf(home, "thread-a").sort(), ["claude", "grok"]);
  assert.throws(() => findJob(home, "thread-a"), (e) => e instanceof UsageError && /thread thread-a exists for .*; add --to <provider>/.test(e.message), "a bare native id matching two providers");
  assert.equal(findJob(home, "thread-a", "claude").id, claude.id);
  assert.equal(findJob(home, "thread-a", "grok").id, first.id);
  assert.equal(findJob(home, "nosuch"), null);
  assert.equal(findJob(home, claude.id).provider, "claude", "a job id resolves whatever the provider");
});

test("implicit candidates need this cwd and this session together; a named id resolves across sessions", (t) => {
  const { home, make } = fixture(t);
  const other = tmp();
  const a = make({ session: "s1", spawnedAt: "2026-01-01T00:01:00.000Z" });
  const b = make({ session: "s2", spawnedAt: "2026-01-01T00:02:00.000Z" });
  const c = make({ session: "s1", cwd: other, spawnedAt: "2026-01-01T00:03:00.000Z" });
  const d = make({ session: null, spawnedAt: "2026-01-01T00:04:00.000Z" });
  const ids = (ctx) => candidates(home, ctx).map((j) => j.id);
  assert.deepEqual(ids({ cwd: home, session: "s1" }), [a.id], "another session's job and another cwd's job are ignored");
  assert.deepEqual(ids({ cwd: home, session: "s2" }), [b.id]);
  assert.deepEqual(ids({ cwd: other, session: "s1" }), [c.id]);
  assert.deepEqual(ids({ cwd: home, session: null }), [d.id], "no session matches only jobs recorded without one");
  assert.deepEqual(ids({ cwd: home }), [d.id]);
  assert.deepEqual(ids({ cwd: home, session: "s3" }), [], "no fallback to other sessions or the whole workspace");
  assert.equal(findJob(home, c.id).session, "s1", "a named id is found across sessions and directories");
  assert.equal(listJobs(home).length, 4);
  assert.deepEqual(listJobs(home).map((j) => j.id), [d.id, c.id, b.id, a.id], "newest first");
});

test("a reader never sees a half-written meta.json", async () => {
  const dir = tmp();
  const file = path.join(dir, "meta.json");
  const jobsModule = pathToFileURL(path.join(process.cwd(), "plugins", "council", "scripts", "lib", "core", "jobs.mjs")).href;
  const writer = spawn(process.execPath, ["--input-type=module", "-e",
    `import { saveJob } from ${JSON.stringify(jobsModule)};
     const end = Date.now() + 1500;
     for (let seq = 0; seq < 100 || Date.now() < end; seq += 1) saveJob({ dir: ${JSON.stringify(dir)}, seq, pad: "x".repeat(2000 + (seq % 5) * 10000) });`],
  { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
  let stderr = "";
  writer.stderr.on("data", (b) => { stderr += b; });
  const finished = new Promise((resolve) => writer.on("close", resolve));
  let reads = 0, done = false;
  finished.then(() => { done = true; });
  while (!done) {
    let text;
    try { text = fs.readFileSync(file, "utf8"); }
    catch (error) {
      if (["ENOENT", "EPERM", "EBUSY", "EACCES"].includes(error.code)) { await new Promise((r) => setTimeout(r, 1)); continue; }
      throw error;
    }
    const meta = JSON.parse(text);
    assert.equal(meta.pad.length, 2000 + (meta.seq % 5) * 10000);
    reads += 1;
    await new Promise((r) => setTimeout(r, 2));
  }
  assert.equal(await finished, 0, `the writer failed after ${reads} reads: ${stderr.trim().split("\n").slice(0, 8).join(" | ")}`);
  assert.ok(reads > 5, `read ${reads} times while the writer ran`);
  assert.deepEqual(fs.readdirSync(dir), ["meta.json"], "no temp file is left behind");
});

test("a job record never appears without its heartbeat, so a just-created running job never reads as lost", () => {
  const home = tmp();
  const rename = fs.renameSync, seen = [];
  fs.renameSync = (from, to) => {
    rename(from, to);
    if (path.basename(String(to)) !== "meta.json") return;
    const job = loadJob(home, path.basename(path.dirname(String(to))));
    seen.push(job && stateOf(job));
  };
  try {
    const fields = { provider: "grok", cwd: home, session: null, status: "running", spawnedAt: new Date().toISOString() };
    createJob(home, fields);
    const key = requestKey(null, home, "r1");
    const id = requestJobId("grok", null, home, "r1");
    claimRequest(home, { key, requestId: "r1", provider: "grok", session: null, cwd: home, fingerprint: "k", jobId: id });
    createJob(home, fields, id);
  } finally { fs.renameSync = rename; }
  assert.deepEqual(seen, ["running", "running"]);
  assert.deepEqual([BEAT_MS, BEAT_STALE_MS], [10000, 30000]);
  const job = createJob(home, { provider: "grok", cwd: home, status: "running", spawnedAt: new Date().toISOString() });
  assert.ok(beatAgeMs(job) < 5000);
  fs.unlinkSync(path.join(job.dir, "beat"));
  assert.equal(beatAgeMs(job), Infinity);
  touchBeat(job);
  assert.ok(beatAgeMs(job) < 5000, "touchBeat recreates a missing beat");
});

test("prune deletes finished bodies past 100 through trash/ and never a running, lost, cleanup-pending, claim-holding or review-input-pending job", (t) => {
  const { home } = fixture(t);
  const at = (i) => new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString();
  const finished = (i, extra = {}) => {
    const job = createJob(home, { provider: "grok", verb: "ask", status: "done", outcome: "ok", code: 0, cwd: home, session: null, threadId: `t-${i}`, spawnedAt: at(i), endedAt: at(i), ...extra });
    fs.writeFileSync(path.join(job.dir, "answer.md"), `answer ${i}`);
    markDone(job);
    return job;
  };
  // The oldest five are special: running (fresh beat), lost (stale beat), cleanup-pending, claim-holding, review-input-pending.
  const running = createJob(home, { provider: "grok", status: "running", cwd: home, spawnedAt: at(0) });
  const lost = createJob(home, { provider: "grok", status: "running", cwd: home, spawnedAt: at(1) });
  fs.utimesSync(path.join(lost.dir, "beat"), new Date(0), new Date(0));
  const pending = finished(2, { cleanupPending: true, outcome: "failed", status: "failed", code: 1 });
  const holding = finished(3, { threadIds: ["held-thread"] });
  claimThread(home, "grok", "held-thread", holding);
  const review = finished(4, { verb: "review", reviewState: { pending: 2, synthesisPending: false } });
  assert.equal(reviewInputPending(review), true);
  for (let i = 5; i < 5 + KEEP_FINISHED + 3; i += 1) finished(i);
  prune(home);
  const left = new Set(fs.readdirSync(path.join(home, "jobs")));
  for (const kept of [running, lost, pending, holding, review]) assert.ok(left.has(kept.id), `${kept.id} is kept`);
  const bodies = listJobs(home).filter((j) => j.done && !cleanupNeeded(j) && !reviewInputPending(j) && !j.threadIds);
  assert.equal(bodies.length, KEEP_FINISHED, "exactly the newest 100 plain finished jobs remain");
  assert.ok(!left.has(listJobs(home).find((j) => j.threadId === "t-5")?.id ?? "t-5-gone"), "the oldest plain finished job is gone");
  assert.ok(left.has(listJobs(home).find((j) => j.threadId === `t-${5 + KEEP_FINISHED + 2}`).id), "the newest stays");
  assert.deepEqual(fs.existsSync(path.join(home, "trash")) ? fs.readdirSync(path.join(home, "trash")) : [], [], "trash is emptied after the renames");
  saveThread(home, { provider: "grok", threadId: "t-5", round: 1 });
  prune(home);
  assert.equal(loadThread(home, "grok", "t-5").round, 1, "thread records survive prune");
});

test("thread records live under threads/<provider>-<threadId>.json and name their providers", (t) => {
  const { home } = fixture(t);
  saveThread(home, { provider: "grok", threadId: "ABC-1", cwd: home, session: "s1", model: "grok-4.7", effort: "high", tier: "consult", round: 2, rounds: 9, agent: "explore" });
  saveThread(home, { provider: "claude", threadId: "abc-1", cwd: home, session: "s1", model: null, effort: "high", tier: "consult", round: 1, rounds: 9, policyVersion: "default-v1" });
  assert.equal(fs.existsSync(path.join(home, "threads", "grok-abc-1.json")), true, "ids are lowercased");
  assert.deepEqual([loadThread(home, "grok", "abc-1").round, loadThread(home, "claude", "ABC-1").policyVersion, loadThread(home, "gemini", "abc-1")], [2, "default-v1", null]);
  assert.ok(loadThread(home, "grok", "abc-1").updatedAt);
  assert.deepEqual(threadProviders(home, "abc-1").sort(), ["claude", "grok"]);
  assert.deepEqual(threadProviders(home, "nope"), []);
  assert.throws(() => saveThread(home, { provider: "grok" }), /needs provider and threadId/);
});

test("lastEvent reads the tail of events.jsonl, adapter-neutral, and ignores partial or diagnostic lines", (t) => {
  const { home, make } = fixture(t);
  const job = make();
  assert.equal(lastEvent(job), null);
  fs.writeFileSync(path.join(job.dir, "events.jsonl"), 'garbage\n{"type":"start","thread":"t"}\n{"type":"tool","name":"edit"}\n{"event":"step_update","step_update":{"tool_name":"read_file"}}\n{"type":"system","subtype":"init"}\n{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Edit"}]}}\n{"type":"end"}\n{"type":"tex');
  assert.equal(lastEvent(job), "end");
  fs.writeFileSync(path.join(job.dir, "events.jsonl"), '{"type":"tool","name":"edit"}\n');
  assert.equal(lastEvent(job), "tool:edit");
  assert.deepEqual(["step_update:read_file", "system/init", "assistant:Edit", "tool_call:grep", null], [
    describeEvent({ event: "step_update", step_update: { tool_name: "read_file" } }), describeEvent({ type: "system", subtype: "init" }),
    describeEvent({ type: "assistant", message: { content: [{ type: "tool_use", name: "Edit" }] } }), describeEvent({ type: "tool_call", toolName: "grep" }), describeEvent({ x: 1 })]);
  fs.writeFileSync(path.join(job.dir, "events.jsonl"), `${"x".repeat(9000)}\n{"type":"text"}\n`);
  assert.equal(lastEvent(job), "text", "only the 8 KiB tail is read");
});
