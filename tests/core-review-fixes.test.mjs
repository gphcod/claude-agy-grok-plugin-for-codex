// S2.8: regression tests for the milestone 2 review fixes (Codex gpt-6.1-sol and Gemini 4 Argon, merged as F1–F19, plus
// the coordinator's corrections from the twin's confirmation review). Each test names the finding it pins.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { makeWorld, jobIdOf, footerOf, alive, until, turnFor, ctxFor, adapter, ENTRY } from "./helpers.mjs";
import { claimRequest, createJob, loadJob, markDone, saveJob, loadThread, lookupRequest, requestFingerprint, requestKey, stateOf } from "../plugins/council/scripts/lib/core/jobs.mjs";
import { claimThread, inspectClaim } from "../plugins/council/scripts/lib/core/claims.mjs";
import { executionController, ownedExecution } from "../plugins/council/scripts/lib/core/execution.mjs";
import { runManagedTurn, cancelManaged } from "../plugins/council/scripts/lib/core/lifecycle.mjs";

const { main } = await import(pathToFileURL(ENTRY).href);
const timers = { inactivityMs: 30000, deadlineMs: 60000 };
const finding = (extra = {}) => ({ id: "F1", severity: "high", title: "Off by one", body: "The loop skips item 0.", file: "README.md", line_start: 1, line_end: 1, confidence: 0.9, recommendation: "Start at 0.", ...extra });
const structured = (value) => ({ COUNCIL_FAKE_STRUCTURED: JSON.stringify(value) });
const flagged = { verdict: "needs-attention", summary: "Defect.", findings: [finding()], next_steps: [] };
const threadOf = (world, stderr) => loadJob(world.home, jobIdOf(stderr))?.threadId;
/** No process query can be answered: cleanup is never confirmed. */
const blind = { platform: process.platform, self: () => null, snapshot: () => ({ state: "unknown", rows: [] }), inspect: () => ({ state: "unknown", rows: [] }), stop: () => "unknown" };
/** A process table that holds nothing: the owner companion and every owned row are gone. */
const empty = { platform: process.platform, self: () => null, snapshot: () => ({ state: "ok", rows: [] }), inspect: () => ({ state: "gone", rows: [] }), stop: () => "gone" };

/** The entry in this process, so tests can pass an environment process.env lacks and lifecycle hooks. */
async function inProcess(w, argv, { env = {}, hooks } = {}) {
  let stdout = "", stderr = "";
  const io = { stdout: { write: (t) => { stdout += t; return true; } }, stderr: { write: (t) => { stderr += t; return true; } }, stdin: Readable.from([]) };
  const code = await main(argv, { ...w.env, ...env }, io, { cwd: w.workspace, ...(hooks ? { hooks } : {}) });
  return { code, stdout, stderr };
}

test("F1: a descendant recorded at a heartbeat is adopted by its identity after its parent exits, and stopped", { skip: process.platform === "win32" }, async () => {
  const w = makeWorld();
  const pidFile = path.join(w.dir, "grandchild.pid");
  const turn = turnFor(w, { env: { COUNCIL_FAKE_SCENARIO: "slow", COUNCIL_FAKE_SLOW_MS: "1200", COUNCIL_FAKE_GRANDCHILD: pidFile, COUNCIL_FAKE_HOLD_MS: "30000" } });
  let jobId = null;
  const running = runManagedTurn(ctxFor(w), adapter, turn, null, timers, { beatMs: 100, pipeWaitMs: 500, beforeSpawn: (job) => { jobId = job.id; } });
  const grandchild = Number(await until(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, "utf8")));
  await until(() => (loadJob(w.home, jobId)?.execution ?? []).some((r) => r.pid === grandchild), 10000);
  const result = await running;
  assert.ok(result.job.execution.some((r) => r.pid === grandchild), "persisted while the turn ran");
  await until(() => !alive(grandchild), 10000);
  assert.equal(result.job.cleanupPending, false, "the recorded identity proves the reparented process ours, so cleanup is confirmed");
  assert.match(result.job.error, /owned execution survived the launcher/);
});

test("F3: cancel without the provider module reads ownership as unknown: no stop, no release, exit 1 with a hint", async () => {
  const w = makeWorld();
  const running = w.start(["ask", "--to", "null", "--", "q"], { env: { COUNCIL_FAKE_HANG: "1" } });
  const [, id] = await running.waitFor(/job=([a-z0-9]{16})/);
  await until(() => w.job(id).pid);
  const events = path.join(w.home, "jobs", id, "events.jsonl");
  await until(() => fs.existsSync(events) && fs.readFileSync(events, "utf8").split("\n").filter((l) => l.includes('"type":"text"')).length === 2);
  const child = w.job(id).pid, thread = w.job(id).requestedThreadId;
  running.child.kill("SIGKILL");
  await running.exited;
  const refused = w.call(["cancel", id, "--timeout", "3"], { env: { COUNCIL_TEST_NULL_ADAPTER: "0" } });
  assert.equal(refused.status, 1, refused.stdout + refused.stderr);
  assert.match(refused.stdout, /module is not available in this build, so job [a-z0-9]{16}'s processes cannot be identified and nothing was stopped or released: restore it, then run cancel/);
  if (process.platform !== "win32") assert.ok(alive(child), "nothing was signalled"); // Windows ends the child with its hard-killed parent.
  assert.equal(inspectClaim(w.home, "null", thread).state, "owned", "the claim is kept");
  assert.ok(!fs.existsSync(path.join(w.home, "jobs", id, "stopped")));
  assert.equal(w.call(["cancel", id, "--timeout", "15"]).status, 0, "with the module back, cancel recovers it");
  await until(() => !alive(child), 5000);
});

test("F4: a structured review gets the complete spooled answer, past the 24 KiB display cap", () => {
  const w = makeWorld();
  fs.writeFileSync(path.join(w.workspace, "README.md"), "# changed\n");
  const text = JSON.stringify({ ...flagged, summary: `Defect. ${"x".repeat(30000)}` });
  const r = w.call(["review", "--to", "null", "--json"], { env: { COUNCIL_FAKE_REVIEW_TEXT: text, COUNCIL_FAKE_STRUCTURED: "null" } });
  assert.equal(r.status, 10, r.stdout + r.stderr);
  const json = JSON.parse(r.stdout);
  assert.deepEqual(json.findings.map((f) => [f.id, f.severity]), [["F1", "BLOCKER"]], "parsed from the whole text, not a clipped preview");
});

test("F5: a denied or workspace-changing review grants no coverage and records no finding", () => {
  const w = makeWorld();
  fs.writeFileSync(path.join(w.workspace, "README.md"), "# changed\n");
  for (const env of [{ COUNCIL_FAKE_DENY: "secret.txt" }, { COUNCIL_FAKE_EDITS: "README.md" }]) {
    const r = w.call(["review", "--to", "null"], { env: { ...env, ...structured(flagged) } });
    assert.equal(r.status, 10, r.stdout + r.stderr);
    const id = jobIdOf(r.stderr);
    const job = w.job(id);
    assert.deepEqual([job.reviewState.completed, job.reviewState.findingsLedger ?? [], job.findings ?? null], [[], [], null], JSON.stringify(env));
    assert.ok(!fs.existsSync(path.join(w.home, "jobs", id, "review-input", "responses")), "no response artifact published");
  }
  assert.match(w.job(jobIdOf(w.call(["review", "--to", "null"], { env: { COUNCIL_FAKE_EDITS: "README.md" } }).stderr)).incomplete, /read-only review changed the workspace: README\.md/);
});

test("F5/F8: unverified cleanup fails the review without coverage and defers afterTurn to the cancel that confirms cleanup, once", async () => {
  const w = makeWorld();
  fs.writeFileSync(path.join(w.workspace, "README.md"), "# changed\n");
  const r = await inProcess(w, ["review", "--to", "null", "--json"], { env: structured(flagged), hooks: { control: blind } });
  assert.equal(r.code, 1, r.stdout + r.stderr);
  const id = JSON.parse(r.stdout).job;
  const job = loadJob(w.home, id);
  assert.deepEqual([job.cleanupPending, job.reviewState.completed, job.findings ?? null], [true, [], null]);
  assert.deepEqual(w.hooks().map((h) => h.hook), ["beforeTurn"], "afterTurn is not run while cleanup is unverified");
  assert.deepEqual(job.afterTurnPending, { reason: null, completed: true, denials: [] });
  const first = await cancelManaged(ctxFor(w), job, { control: empty, adapter, timeoutMs: 2000 });
  assert.equal(first.code, 0, JSON.stringify(first));
  assert.deepEqual(w.hooks().map((h) => [h.hook, h.outcome?.cleanupConfirmed ?? null, h.outcome?.deferred ?? null]), [["beforeTurn", null, null], ["afterTurn", true, true]]);
  await cancelManaged(ctxFor(w), loadJob(w.home, id), { control: empty, adapter, timeoutMs: 2000 });
  assert.equal(w.hooks().length, 2, "a second cancel does not run it again");
});

test("F6: the thread record is written while the claim is held and before completion; its failure publishes no success", async () => {
  const w = makeWorld();
  const turn = turnFor(w);
  const seen = [];
  const ok = await runManagedTurn(ctxFor(w), adapter, turn, null, timers, { saveThread: (home, record) => {
    seen.push({ done: fs.existsSync(path.join(home, "jobs", record.lastJob, "done")), claim: inspectClaim(home, "null", record.threadId).state });
    fs.mkdirSync(path.join(home, "threads"), { recursive: true });
  } });
  assert.equal(ok.job.code, 0);
  assert.deepEqual(seen, [{ done: false, claim: "owned" }]);
  const failing = turnFor(w);
  const failed = await runManagedTurn(ctxFor(w), adapter, failing, null, timers, { saveThread: () => { throw new Error("thread store full"); } });
  assert.deepEqual([failed.job.code, failed.job.outcome], [1, "failed"]);
  assert.match(failed.job.error, /^finalization failed: thread store full/);
  const stored = loadJob(w.home, failed.job.id);
  assert.deepEqual([stored.outcome, stateOf(stored), stored.cleanupPending], ["failed", "failed", true], "the stored record is a failure, not a success");
  assert.equal(inspectClaim(w.home, "null", failing.thread).state, "owned", "the claim stays until recovery");
});

test("F7: a discovered thread id whose claim fails is never published", async () => {
  const w = makeWorld();
  const turn = turnFor(w, { thread: null, env: { COUNCIL_NULL_ID: "discovered" } });
  const claimIo = { ...fs, mkdirSync(dir, ...rest) { if (/discovered-/.test(String(dir))) throw new Error("fixture claim refused"); return fs.mkdirSync(dir, ...rest); } };
  const result = await runManagedTurn(ctxFor(w), adapter, turn, null, timers, { claimIo });
  assert.equal(result.job.code, 1);
  assert.match(result.job.error, /fixture claim refused/);
  assert.equal(result.job.threadId, null);
  assert.equal(loadJob(w.home, result.job.id).threadId, null);
  assert.ok(!fs.existsSync(path.join(w.home, "threads")) || fs.readdirSync(path.join(w.home, "threads")).length === 0, "no thread record");
});

test("F9: a plain reply on a review thread is a structured discussion turn whose identified REJECT clears the blocker", () => {
  const w = makeWorld();
  fs.writeFileSync(path.join(w.workspace, "README.md"), "# changed\n");
  const first = w.call(["review", "--to", "null"], { env: structured(flagged) });
  assert.equal(first.status, 10);
  const job = jobIdOf(first.stderr);
  assert.equal(JSON.parse(w.call(["wait", job, "--json"]).stdout).coverage.blocking, true);
  const reply = w.call(["reply", job, "--", "F1 is a false positive: the loop starts at 0."], { env: structured({ verdict: "approve", summary: "Agreed.", findings: [finding({ decision: "REJECT" })], next_steps: [] }) });
  assert.equal(reply.status, 0, reply.stdout + reply.stderr);
  const sent = w.fakeCalls().at(-1);
  assert.ok(sent.argv.includes("--schema"));
  assert.match(sent.prompt, /delivers no new review input/);
  assert.match(sent.prompt, /F1/);
  const json = JSON.parse(w.call(["wait", jobIdOf(reply.stderr), "--json"]).stdout);
  assert.deepEqual([json.coverage.blocking, json.coverage.status], [false, "complete"], "the ledger reconciled; coverage unchanged");
  const ask = w.call(["ask", "--to", "null", "--", "q"]);
  w.call(["reply", jobIdOf(ask.stderr), "--", "more"]);
  assert.ok(!w.fakeCalls().at(-1).argv.includes("--schema"), "a reply on a plain thread stays unstructured");
});

test("F10: one provider-neutral reservation: two identical reply --last calls start one CLI even when --last changes provider", async () => {
  const w = makeWorld();
  assert.equal(w.call(["ask", "--to", "null", "--", "first"]).status, 0);
  const args = ["reply", "--last", "--request-id", "rl", "--", "follow"];
  const slow = w.start(args, { env: { COUNCIL_FAKE_SCENARIO: "slow", COUNCIL_FAKE_SLOW_MS: "2500" } });
  const [, firstJob] = await slow.waitFor(/provider=null job=([a-z0-9]{16})/);
  assert.equal(w.call(["ask", "--to", "null2", "--", "other"]).status, 0, "the latest thread now belongs to another provider");
  const second = w.call(args);
  const done = await slow.exited;
  assert.equal(done.code, 0, done.stdout + done.stderr);
  assert.equal(second.status, 0, second.stdout + second.stderr);
  assert.equal(jobIdOf(second.stdout), firstJob, "the second call replays the first");
  assert.equal(w.fakeCalls().filter((c) => c.prompt.includes("follow")).length, 1);
});

test("F10: a prompt write that fails leaves the job unadmitted and the request id untombstoned", async () => {
  const w = makeWorld();
  const cwd = fs.realpathSync(w.workspace);
  const key = requestKey(null, cwd, "rw");
  const jobId = "w".repeat(16);
  claimRequest(w.home, { key, requestId: "rw", provider: "null", session: null, cwd, fingerprint: "f", jobId });
  const turn = turnFor(w, { env: { COUNCIL_NULL_INPUT: "prompt-file" } });
  const io = { ...fs, writeFileSync(file, ...rest) { if (String(file).endsWith("prompt.md")) throw Object.assign(new Error("disk full"), { code: "ENOSPC" }); return fs.writeFileSync(file, ...rest); } };
  const result = await runManagedTurn(ctxFor(w), adapter, turn, null, { ...timers, jobId, requestKey: key, requestId: "rw" }, { io });
  assert.deepEqual([result.job.admitted, result.job.code], [false, 1]);
  assert.equal(lookupRequest(w.home, key).state, "reserved", "the entry frees a reservation that never became a tombstone");
  assert.equal(w.fakeCalls().length, 0);
});

test("F10: a failed reservation write leaves nothing behind; a failed temp-file removal after publishing keeps the claim", (t) => {
  const w = makeWorld();
  fs.mkdirSync(w.home, { recursive: true });
  const base = { requestId: "re", session: null, cwd: w.workspace, fingerprint: "f" };
  const key = requestKey(null, w.workspace, "re");
  const link = fs.linkSync, rm = fs.rmSync;
  t.after(() => { fs.linkSync = link; fs.rmSync = rm; });
  fs.linkSync = () => { throw Object.assign(new Error("no space left"), { code: "ENOSPC" }); };
  assert.throws(() => claimRequest(w.home, { ...base, key }), /no space left/);
  fs.linkSync = link;
  assert.deepEqual(fs.readdirSync(path.join(w.home, "requests")), [], "no reservation and no temp file");
  fs.rmSync = (file, ...rest) => { if (String(file).endsWith(".tmp")) throw Object.assign(new Error("busy"), { code: "EPERM" }); return rm(file, ...rest); };
  const claimed = claimRequest(w.home, { ...base, key });
  fs.rmSync = rm;
  assert.equal(claimed.fresh, true);
  assert.deepEqual([lookupRequest(w.home, key).state, lookupRequest(w.home, key).fingerprint], ["reserved", "f"], "the published reservation is readable");
  assert.equal(claimRequest(w.home, { ...base, key }).fresh, false, "an identical call replays it");
});

test("F11: a reply that finds only the thread record keeps round, budget, requested effort and web", () => {
  const w = makeWorld();
  const log = path.join(w.dir, "requests.log");
  const first = w.call(["ask", "--to", "null", "--rounds", "3", "--web", "--effort", "max", "--", "q"]);
  assert.equal(first.status, 0, first.stdout + first.stderr);
  const thread = threadOf(w, first.stderr);
  assert.equal(loadThread(w.home, "null", thread).requestedEffort, "max");
  fs.rmSync(path.join(w.home, "jobs"), { recursive: true, force: true }); // the job history is gone; the thread record stays
  const reply = w.call(["reply", thread, "--", "again"], { env: { COUNCIL_FAKE_REQUEST_LOG: log } });
  assert.equal(reply.status, 0, reply.stdout + reply.stderr);
  assert.match(footerOf(reply.stdout), /null-model\/xhigh<=max · .* · round 2\/3/);
  assert.equal(JSON.parse(fs.readFileSync(log, "utf8").trim().split("\n").at(-1)).web, true);
});

test("F12: a replayed ok result whose answer body is missing exits 1, not ok", () => {
  const w = makeWorld();
  const first = w.call(["ask", "--to", "null", "--request-id", "ra", "--", "q"]);
  assert.equal(first.status, 0);
  const id = jobIdOf(first.stderr);
  fs.rmSync(path.join(w.home, "jobs", id, "answer.md"));
  for (const r of [w.call(["ask", "--to", "null", "--request-id", "ra", "--", "q"]), w.call(["wait", id])]) {
    assert.equal(r.status, 1, r.stdout);
    assert.match(footerOf(r.stdout), /stored answer missing/);
  }
});

test("F14: an exact timestamp tie for reply --last or bare cancel exits 2", () => {
  const w = makeWorld();
  const cwd = fs.realpathSync(w.workspace);
  const at = new Date().toISOString();
  for (const thread of ["t-a", "t-b"]) createJob(w.home, { provider: "null", verb: "ask", status: "running", cwd, session: null, threadId: thread, threadIds: [], admitted: true, admittedAt: at, spawnedAt: at });
  const last = w.call(["reply", "--last", "--", "x"]);
  assert.equal(last.status, 2);
  assert.match(last.stderr, /--last is ambiguous: jobs [a-z0-9]{16} and [a-z0-9]{16} started at the same moment; name one/);
  const cancel = w.call(["cancel"]);
  assert.equal(cancel.status, 2);
  assert.match(cancel.stderr, /cancel is ambiguous/);
  assert.equal(w.fakeCalls().length, 0);
});

test("F15: an observed model replaces a requested default; probe warnings reach setup", async () => {
  const w = makeWorld();
  const observed = await runManagedTurn(ctxFor(w), adapter, turnFor(w, { model: "default", env: { COUNCIL_FAKE_MODEL: "null-observed" } }), null, timers);
  assert.deepEqual([observed.job.model, observed.job.modelObserved], ["null-observed", true]);
  const named = await runManagedTurn(ctxFor(w), adapter, turnFor(w, { env: { COUNCIL_FAKE_MODEL: "null-observed" } }), null, timers);
  assert.equal(named.job.model, "null-model", "an explicitly resolved model is kept");
  const setup = await inProcess(w, ["setup", "--to", "null"], { env: { COUNCIL_NULL_PROBE_WARNING: "tier deep's model is not listed" } });
  assert.equal(setup.code, 0, setup.stdout + setup.stderr);
  assert.match(setup.stdout, /\n {2}warning: tier deep's model is not listed\n/);
});

test("F16: buildTurn gets the per-call env and the resolved launcher; preflight and probe read the call's env, not process.env", async () => {
  const w = makeWorld();
  const log = path.join(w.dir, "requests.log");
  assert.equal(process.env.COUNCIL_FAKE_REQUEST_LOG, undefined);
  const r = await inProcess(w, ["ask", "--to", "null", "--", "q"], { env: { COUNCIL_FAKE_REQUEST_LOG: log } });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const request = JSON.parse(fs.readFileSync(log, "utf8").trim());
  assert.equal(request.launcherKind, "node-script");
  assert.ok(request.envKeys > 0);
  const blocked = await inProcess(w, ["ask", "--to", "null", "--", "q"], { env: { COUNCIL_NULL_PREFLIGHT_BLOCK: path.join(w.dir, "absent") } });
  assert.equal(blocked.code, 1);
  assert.match(blocked.stderr, /action: Grant read access/);
});

test("F19: checkRequest refuses before any job record, freeing the request id; timers are not part of the fingerprint", () => {
  const w = makeWorld();
  const refused = w.call(["ask", "--to", "null", "--web", "--request-id", "rc", "--", "q"], { env: { COUNCIL_NULL_REFUSE: "web" } });
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /the null provider refuses web/);
  assert.ok(!fs.existsSync(path.join(w.home, "jobs")) || fs.readdirSync(path.join(w.home, "jobs")).length === 0, "no job record");
  assert.equal(lookupRequest(w.home, requestKey(null, fs.realpathSync(w.workspace), "rc")), null);
  assert.equal(w.call(["ask", "--to", "null", "--web", "--request-id", "rc", "--", "q"]).status, 0, "the id runs once the flag is accepted");
  assert.equal(requestFingerprint("ask", { deadline: "5" }, "q"), requestFingerprint("ask", { deadline: "50", "inactivity-timeout": "9" }, "q"));
  const first = w.call(["ask", "--to", "null", "--request-id", "rt", "--deadline", "100", "--", "q"]);
  assert.equal(first.status, 0, JSON.stringify({ stdout: first.stdout, stderr: first.stderr, error: first.error?.message, signal: first.signal }));
  const longer = w.call(["ask", "--to", "null", "--request-id", "rt", "--deadline", "200", "--inactivity-timeout", "50", "--", "q"]);
  assert.equal(longer.status, 0, longer.stdout + longer.stderr);
  assert.equal(longer.stdout, first.stdout, "a retry with a longer deadline replays the first call");
  assert.equal(w.fakeCalls().length, 2);
});

// S2.9: the three resolutions Codex's confirmation found incomplete.

test("S2.9 fix 1: an unrecorded member born after a cleanup-pending job ended keeps ownership unknown; the confirming cancel keeps the claim", async () => {
  const w = makeWorld();
  const ms = (sec) => new Date(2026, 9, 31, 12, 0, sec).getTime();
  // `pidWindow` is the S2.8 record shape, kept so this test also fails against that rule.
  const job = createJob(w.home, { provider: "null", verb: "ask", status: "failed", cwd: w.workspace, session: null, threadId: "t-1", threadIds: ["t-1"], admitted: true, pid: 201,
    leader: { pid: 201, stamp: "Sat Oct 31 12:00:00 2026" }, pidWindow: [ms(0), ms(0) + 20], execution: [], childArgs: ["--thread", "t-1"], argv: ["node", "fake", "--thread", "t-1"], cleanupPending: true, endedAt: new Date(ms(5)).toISOString(),
    companionPid: 999999, companionIdentity: { pid: 999999, stamp: "1" } });
  markDone(job);
  claimThread(w.home, "null", "t-1", job);
  const member = { pid: 203, ppid: 1, pgid: 201, stamp: "Sat Oct 31 12:00:10 2026", argv: null, raw: "node helper.js", name: "node" };
  const control = executionController({ adapter, platform: "darwin", snapshot: () => ({ state: "ok", rows: [member] }) });
  assert.equal(ownedExecution(loadJob(w.home, job.id), { state: "ok", rows: [member] }, "darwin", [], adapter).state, "unknown");
  const result = await cancelManaged(ctxFor(w), loadJob(w.home, job.id), { control, adapter, timeoutMs: 3000 });
  assert.equal(result.code, 1, JSON.stringify(result));
  assert.match(result.error, /cannot be confirmed; claim and cancellation request retained/);
  assert.equal(inspectClaim(w.home, "null", "t-1").state, "owned");
  assert.ok(!fs.existsSync(path.join(job.dir, "stopped")));
});

test("S2.9 fix 2: a native binary under a path with spaces is owned when the path exists, and unknown (never gone) when it cannot be told apart", { skip: process.platform === "win32" && "macOS text rows; a Windows row carries its parsed argv" }, () => {
  const w = makeWorld();
  const bin = path.join(w.dir, "First Last", ".grok", "bin", "grok");
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(bin, "");
  const childArgs = ["--prompt-file", "/state/jobs/j/prompt.md", "--output-format", "streaming-json"];
  const job = { dir: "/state/jobs/j", argv: ["node", "/npm/grok", ...childArgs], childArgs, promptFile: "/state/jobs/j/prompt.md" };
  const grok = { id: "grok", ownsProcess: (r, j, platform, has) => has(r, "--prompt-file", j.promptFile, platform) };
  const at = (raw) => ({ state: "ok", rows: [{ pid: 401, ppid: 1, pgid: 401, stamp: "Sat Oct 31 12:00:00 2026", argv: null, raw, name: "grok" }] });
  const found = ownedExecution(job, at(`${bin} ${childArgs.join(" ")}`), "darwin", [], grok);
  assert.deepEqual([found.state, found.rows.map((r) => r.pid)], ["owned", [401]]);
  const ambiguous = ownedExecution(job, at(`${path.join(w.dir, "No Such", "grok")} ${childArgs.join(" ")}`), "darwin", [], grok);
  assert.deepEqual([ambiguous.state, ambiguous.rows], ["unknown", []], "not signalled, not gone");
});

test("S2.9 fix 3: the deferred afterTurn is reserved before stop and release; ENOSPC on its marker keeps the claim and a retry runs it once", async () => {
  const w = makeWorld();
  const turn = turnFor(w);
  const result = await runManagedTurn(ctxFor(w), adapter, turn, null, timers, { control: blind });
  assert.equal(result.job.cleanupPending, true);
  const io = { ...fs, writeFileSync(file, ...rest) { if (path.basename(String(file)).startsWith("after-turn")) throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" }); return fs.writeFileSync(file, ...rest); } };
  const first = await cancelManaged(ctxFor(w), loadJob(w.home, result.job.id), { control: empty, adapter, io, timeoutMs: 2000 });
  assert.equal(first.code, 1, JSON.stringify(first));
  assert.match(first.error, /afterTurn could not be reserved \(no space left on device\); cleanup is confirmed but the claim is kept/);
  assert.equal(inspectClaim(w.home, "null", turn.thread).state, "owned");
  assert.ok(!fs.existsSync(path.join(result.job.dir, "stopped")));
  assert.deepEqual(w.hooks().map((h) => h.hook), ["beforeTurn"]);
  const second = await cancelManaged(ctxFor(w), loadJob(w.home, result.job.id), { control: empty, adapter, timeoutMs: 2000 });
  assert.equal(second.code, 0, JSON.stringify(second));
  assert.deepEqual(w.hooks().map((h) => [h.hook, h.outcome?.deferred ?? null]), [["beforeTurn", null], ["afterTurn", true]]);
  assert.equal(inspectClaim(w.home, "null", turn.thread).state, "absent");
  await cancelManaged(ctxFor(w), loadJob(w.home, result.job.id), { control: empty, adapter, timeoutMs: 2000 });
  assert.equal(w.hooks().length, 2, "once");
});

test("S2.9 (c): the leader's identity is recorded right after spawn, so even a turn shorter than a heartbeat has evidence", { skip: process.platform === "win32" }, async () => {
  const w = makeWorld();
  const result = await runManagedTurn(ctxFor(w), adapter, turnFor(w), null, timers);
  assert.equal(result.job.code, 0);
  const stored = loadJob(w.home, result.job.id);
  assert.equal(stored.leader.pid, stored.pid);
  assert.ok(stored.leader.stamp, "pid and creation time");
  assert.ok(stored.execution.some((r) => r.pid === stored.pid && r.stamp === stored.leader.stamp), "persisted with the launch");
});

test("S2.10: a cancel that finds the deferred afterTurn running under a live holder touches nothing; only a settled hook releases, once", async () => {
  const w = makeWorld();
  const turn = turnFor(w);
  const result = await runManagedTurn(ctxFor(w), adapter, turn, null, timers, { control: blind });
  const job = loadJob(w.home, result.job.id);
  // The job's companion is gone; this process, the hook's holder, is live in the table both cancels read.
  saveJob({ ...job, companionPid: 999999, companionIdentity: { pid: 999999, stamp: "1" } });
  const me = { pid: process.pid, stamp: "me" };
  const control = { ...empty, self: () => me, snapshot: () => ({ state: "ok", rows: [{ ...me, raw: "node", argv: ["node"] }] }) };
  let open, entered;
  const barrier = new Promise((resolve) => { open = resolve; });
  const inside = new Promise((resolve) => { entered = resolve; });
  let runs = 0;
  const gated = { ...adapter, afterTurn: async () => { runs += 1; entered(); await barrier; } };
  const a = cancelManaged(ctxFor(w), loadJob(w.home, job.id), { control, adapter: gated, timeoutMs: 5000 });
  await inside;
  const b = await cancelManaged(ctxFor(w), loadJob(w.home, job.id), { control, adapter: gated, timeoutMs: 5000 });
  assert.deepEqual([b.code, b.status], [20, "running"], JSON.stringify(b));
  assert.match(b.error, /another cancel \(pid \d+\) is running job [a-z0-9]{16}'s deferred afterTurn; nothing was released/);
  assert.equal(inspectClaim(w.home, "null", turn.thread).state, "owned", "the claim is kept while the hook runs");
  assert.ok(!fs.existsSync(path.join(job.dir, "stopped")));
  open();
  assert.equal((await a).code, 0);
  assert.equal(inspectClaim(w.home, "null", turn.thread).state, "absent");
  assert.equal(JSON.parse(fs.readFileSync(path.join(job.dir, "after-turn"), "utf8")).state, "settled");
  assert.equal((await cancelManaged(ctxFor(w), loadJob(w.home, job.id), { control, adapter: gated, timeoutMs: 2000 })).code, 0);
  assert.equal(runs, 1, "the hook ran once");
});

test("S2.10: a running reservation whose holder is proven gone is taken over and the hook runs again before release", async () => {
  const w = makeWorld();
  const turn = turnFor(w);
  const result = await runManagedTurn(ctxFor(w), adapter, turn, null, timers, { control: blind });
  fs.writeFileSync(path.join(result.job.dir, "after-turn"), JSON.stringify({ state: "running", pid: 999998, identity: { pid: 999998, stamp: "x" }, startedAt: "2026-10-31T00:00:00.000Z" }));
  const r = await cancelManaged(ctxFor(w), loadJob(w.home, result.job.id), { control: empty, adapter, timeoutMs: 2000 });
  assert.equal(r.code, 0, JSON.stringify(r));
  assert.deepEqual(w.hooks().map((h) => h.hook), ["beforeTurn", "afterTurn"]);
  assert.equal(inspectClaim(w.home, "null", turn.thread).state, "absent");
});

test("S2.11: the hook holder is checked by a fresh query after the read, not by the cancel's earlier table", async () => {
  const w = makeWorld();
  const turn = turnFor(w);
  const result = await runManagedTurn(ctxFor(w), adapter, turn, null, timers, { control: blind });
  saveJob({ ...loadJob(w.home, result.job.id), companionPid: 999999, companionIdentity: { pid: 999999, stamp: "1" } });
  const me = { pid: process.pid, stamp: "me", raw: "node", argv: ["node"] };
  let open, entered, runs = 0;
  const barrier = new Promise((resolve) => { open = resolve; });
  const inside = new Promise((resolve) => { entered = resolve; });
  const gated = { ...adapter, afterTurn: async () => { runs += 1; entered(); await barrier; } };
  // Cancel A reserves the hook and blocks in it.
  const a = cancelManaged(ctxFor(w), loadJob(w.home, result.job.id), { control: { ...empty, self: () => ({ pid: me.pid, stamp: me.stamp }), snapshot: () => ({ state: "ok", rows: [me] }) }, adapter: gated, timeoutMs: 5000 });
  await inside;
  // Cancel B's table was taken before A started (A absent from it); only a fresh scoped query shows A live.
  const stale = { ...empty, self: () => ({ pid: 4242, stamp: "b" }), snapshot: () => ({ state: "ok", rows: [] }), scoped: (pid) => ({ state: "ok", rows: pid === me.pid ? [me] : [] }) };
  const b = await cancelManaged(ctxFor(w), loadJob(w.home, result.job.id), { control: stale, adapter: gated, timeoutMs: 5000 });
  assert.deepEqual([b.code, b.status], [20, "running"], JSON.stringify(b));
  assert.equal(inspectClaim(w.home, "null", turn.thread).state, "owned");
  const failing = { ...stale, scoped: () => { throw new Error("ps failed"); } };
  assert.equal((await cancelManaged(ctxFor(w), loadJob(w.home, result.job.id), { control: failing, adapter: gated, timeoutMs: 5000 })).code, 1, "a failed fresh query is unknown, never gone");
  open();
  assert.equal((await a).code, 0);
  assert.equal(runs, 1, "one hook run");
  assert.equal(inspectClaim(w.home, "null", turn.thread).state, "absent");
});
