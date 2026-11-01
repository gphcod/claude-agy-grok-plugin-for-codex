// S2.4/S2.6 through the entry: wait, cancel and owner-death recovery, deadlines, thread selection and inheritance, and the
// subprocess counters of A1 (cold, warm, replay, owner-death cancellation). Ported from grok_plugin_for_codex 1.1.0
// tests/jobs.test.mjs, job-recovery.test.mjs, cancel.test.mjs and companion.test.mjs onto the null adapter.
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { makeWorld, jobIdOf, footerOf, alive, until } from "./helpers.mjs";
import { createJob, loadJob, loadThread, markDone, saveJob } from "../plugins/council/scripts/lib/core/jobs.mjs";
import { claimThread, inspectClaim } from "../plugins/council/scripts/lib/core/claims.mjs";

const hang = { COUNCIL_FAKE_HANG: "1" };
const ask = (w, text = "q", extra = {}) => w.call(["ask", "--to", "null", "--", text], extra);

test("wait on a finished job prints the answer and footer with the job's exit; a job id or its thread names it; unknown ids exit 2", () => {
  const w = makeWorld();
  const first = ask(w, "q", { env: { COUNCIL_FAKE_ANSWER: "Stored answer." } });
  const job = jobIdOf(first.stderr);
  const byJob = w.call(["wait", job]);
  assert.equal(byJob.status, 0, byJob.stderr);
  assert.match(byJob.stdout, /^Stored answer\.\ncouncil null ok · job /);
  assert.equal(JSON.parse(w.call(["wait", w.job(job).threadId, "--json"]).stdout).answer, "Stored answer.");
  const attention = ask(w, "q", { env: { COUNCIL_FAKE_ANSWER: "Done.\nOpen questions: which one?" } });
  assert.equal(attention.status, 10, "open questions are attention");
  assert.equal(w.call(["wait", jobIdOf(attention.stderr)]).status, 10);
  assert.equal(w.call(["wait", "nosuchjob"]).status, 2);
});

test("wait on a running job returns 20 with the last event after --timeout and stops nothing; the job then finishes normally", async () => {
  const w = makeWorld();
  const running = w.start(["ask", "--to", "null", "--", "q"], { env: { COUNCIL_FAKE_SCENARIO: "slow", COUNCIL_FAKE_SLOW_MS: "2500" } });
  const [, job] = await running.waitFor(/job=([a-z0-9]{16})/);
  const started = Date.now();
  const r = w.call(["wait", job, "--timeout", "90", "--timeout", "0.5"]);
  assert.equal(r.status, 20, r.stdout + r.stderr);
  assert.match(r.stdout, new RegExp(`^still running · null · job ${job} · \\d+s · last event: start\\n$`));
  assert.ok(Date.now() - started < 8000);
  const json = JSON.parse(w.call(["wait", job, "--timeout", "0.2", "--json"]).stdout);
  assert.deepEqual([json.status, json.exit, json.job], ["running", 20, job]);
  assert.equal((await running.exited).code, 0, "wait --timeout stopped nothing");
  assert.equal(w.call(["wait", job]).status, 0);
});

test("bare wait lists this cwd's and this session's jobs, newest first; another session sees nothing", async () => {
  const w = makeWorld();
  assert.match(w.call(["wait"]).stdout, /^no council jobs/);
  const done = jobIdOf(ask(w).stderr);
  const running = w.start(["ask", "--to", "null", "--", "q"], { env: hang });
  const [, live] = await running.waitFor(/job=([a-z0-9]{16})/);
  try {
    const lines = w.call(["wait"]).stdout.trim().split("\n");
    assert.equal(lines.length, 2);
    assert.match(lines[0], new RegExp(`^${live} · null · running · `));
    assert.match(lines[1], new RegExp(`^${done} · null · done · ${w.job(done).threadId} · \\d+s · end`));
    assert.equal(JSON.parse(w.call(["wait", "--json"]).stdout).length, 2);
    assert.match(w.call(["wait"], { env: { CODEX_THREAD_ID: "other" } }).stdout, /^no council jobs/);
    const elsewhere = path.join(w.dir, "elsewhere");
    fs.mkdirSync(elsewhere);
    assert.match(w.call(["wait"], { cwd: elsewhere }).stdout, /^no council jobs/);
  } finally {
    assert.equal(w.call(["cancel", live]).status, 0);
    await running.exited;
  }
});

test("--deadline and --inactivity-timeout through argv stop the child and exit 1 with cleanup confirmed", () => {
  const w = makeWorld();
  for (const [args, pattern] of [[["--deadline", "0.4"], /wall-clock deadline passed/], [["--inactivity-timeout", "0.4"], /printed nothing before the inactivity deadline/]]) {
    const r = w.call(["ask", "--to", "null", ...args, "--", "q"], { env: hang });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(footerOf(r.stdout), pattern);
    const job = w.job(jobIdOf(r.stderr));
    assert.equal(job.cleanupPending, false, job.error);
    assert.ok(!alive(job.pid));
  }
});

test("cancel while the owner companion runs only marks the job; the owner stops its child and records cancelled", async () => {
  const w = makeWorld();
  const running = w.start(["ask", "--to", "null", "--", "q"], { env: hang });
  const [, job] = await running.waitFor(/job=([a-z0-9]{16})/);
  await until(() => w.job(job).pid);
  const child = w.job(job).pid;
  const r = w.call(["cancel", job, "--json"]);
  const data = JSON.parse(r.stdout);
  assert.equal(data.job, job);
  assert.ok(["cancelled", "not-stopped"].includes(data.status), r.stdout);
  const finished = await running.exited;
  assert.equal(finished.code, 1);
  assert.match(footerOf(finished.stdout), new RegExp(`^council null cancelled · job ${job}`));
  assert.ok(!alive(child));
  assert.ok(!fs.existsSync(path.join(w.home, "jobs", job, "stopped")), "no second metadata writer");
  assert.equal(w.call(["cancel", job]).status, 0, "a finished job counts as stopped");
});

test("bare cancel is scoped to this cwd and session; a session with no jobs selects nothing", async () => {
  const w = makeWorld();
  const running = w.start(["ask", "--to", "null", "--", "q"], { env: { ...hang, CODEX_THREAD_ID: "s1" } });
  const [, job] = await running.waitFor(/job=([a-z0-9]{16})/);
  await until(() => w.job(job).pid);
  const stranger = w.call(["cancel"], { env: { CODEX_THREAD_ID: "other" } });
  assert.match(stranger.stdout, /^no running council job to cancel/);
  assert.equal(fs.existsSync(path.join(w.home, "jobs", job, "cancel")), false, "another session's job was not touched");
  assert.equal(w.call(["cancel"], { env: { CODEX_THREAD_ID: "s1" } }).status, 0, "its own session stops it");
  assert.equal((await running.exited).code, 1);
});

test("a hard-killed companion keeps its thread blocked until cancel recovers it; recovery stops the child, spawns no provider and keeps the metadata", async () => {
  const w = makeWorld();
  const running = w.start(["ask", "--to", "null", "--", "q"], { env: hang });
  const [, id] = await running.waitFor(/job=([a-z0-9]{16})/);
  await until(() => w.job(id).pid);
  // Kill the companion only once the child has written everything it writes before hanging: a write into a pipe whose
  // reader just died would end the child with EPIPE, which is not what this test is about.
  const events = path.join(w.home, "jobs", id, "events.jsonl");
  await until(() => fs.existsSync(events) && fs.readFileSync(events, "utf8").split("\n").filter((l) => l.includes('"type":"text"')).length === 2);
  const child = w.job(id).pid;
  const thread = w.job(id).requestedThreadId;
  running.child.kill("SIGKILL");
  await running.exited;
  assert.ok(alive(child), "the child outlives its companion");
  const before = fs.readFileSync(path.join(w.home, "jobs", id, "meta.json"), "utf8");
  const blocked = w.call(["reply", thread, "--to", "null", "--", "again"]);
  assert.equal(blocked.status, 1, "the requested id of a lost job is still claimed");
  assert.match(footerOf(blocked.stdout), new RegExp(`busy as job ${id}`));
  const busy = w.call(["reply", id, "--", "again"]);
  assert.equal(busy.status, 1, busy.stdout + busy.stderr);
  assert.match(footerOf(busy.stdout), new RegExp(`busy as job ${id}`));
  const calls = w.fakeCalls().length, probes = w.probes().length;
  const cancel = w.call(["cancel", id, "--timeout", "15"]);
  assert.equal(cancel.status, 0, cancel.stdout + cancel.stderr);
  await until(() => !alive(child), 5000);
  assert.deepEqual([w.fakeCalls().length, w.probes().length], [calls, probes], "owner-death cancellation starts zero provider processes");
  assert.equal(fs.readFileSync(path.join(w.home, "jobs", id, "meta.json"), "utf8"), before);
  assert.ok(fs.existsSync(path.join(w.home, "jobs", id, "stopped")) && !fs.existsSync(path.join(w.home, "jobs", id, "done")));
  assert.equal(inspectClaim(w.home, "null", thread).state, "absent");
  assert.equal(w.call(["wait", id]).status, 1);
});

test("a job with a stale heartbeat is lost, and its thread stays blocked until recovery confirms; a live unproven PID is never signalled", () => {
  const w = makeWorld();
  const thread = randomUUID();
  const record = createJob(w.home, { provider: "null", verb: "ask", status: "running", tier: "consult", model: "null-model", effort: "high", cwd: fs.realpathSync(w.workspace), session: null,
    threadId: thread, requestedThreadId: thread, threadIds: [thread], admitted: true, companionPid: process.pid, pid: process.pid, spawnedAt: new Date().toISOString(), round: 1, rounds: 9 });
  claimThread(w.home, "null", thread, record);
  assert.match(w.call(["wait"]).stdout, new RegExp(`^${record.id} · null · running`));
  assert.match(footerOf(w.call(["reply", thread, "--", "now"]).stdout), new RegExp(`is busy as job ${record.id}`));
  w.ageBeat(record.id, 31000);
  assert.match(w.call(["wait"]).stdout, new RegExp(`${record.id} · null · lost`));
  const recovery = w.call(["cancel", record.id, "--timeout", "1"]);
  assert.equal(recovery.status, 1, "a live PID without a birth identity stays unknown");
  assert.match(recovery.stdout, /unknown/);
  assert.match(footerOf(w.call(["reply", thread, "--", "now"]).stdout), /is busy as job/);
  assert.equal(w.fakeCalls().length, 0);
});

test("subprocess counters (A1): a cold call probes once, a warm call probes nothing, a replay starts nothing", () => {
  const w = makeWorld();
  assert.equal(ask(w, "one").status, 0);
  assert.deepEqual([w.probes().length, w.fakeCalls().length], [1, 1], "cold: one capability probe and one submission");
  assert.equal(ask(w, "two").status, 0);
  assert.deepEqual([w.probes().length, w.fakeCalls().length], [1, 2], "warm: the cached probe is reused");
  assert.equal(w.call(["ask", "--to", "null", "--request-id", "c1", "--", "three"]).status, 0);
  assert.equal(w.call(["ask", "--to", "null", "--request-id", "c1", "--", "three"]).status, 0);
  assert.deepEqual([w.probes().length, w.fakeCalls().length], [1, 3], "replay: zero provider processes");
  const binary = path.join(w.dir, "child-copy.mjs");
  fs.copyFileSync(path.join(process.cwd(), "tests", "fixtures", "fake-child.mjs"), binary);
  fs.mkdirSync(path.join(w.dir, "fixtures"), { recursive: true });
  assert.equal(ask(w, "four", { env: { COUNCIL_NULL_BIN: path.join(process.cwd(), "tests", "fixtures", "fake-child.mjs") } }).status, 0);
  assert.equal(w.probes().length, 1, "the same executable stays warm");
});

test("reply --last picks this session's latest confirmed thread in this cwd; none selects nothing", () => {
  const w = makeWorld();
  const sessionAsk = (session) => w.job(jobIdOf(ask(w, "q", { env: { CODEX_THREAD_ID: session } }).stderr));
  sessionAsk("s1");
  const two = sessionAsk("s2").threadId;
  const three = sessionAsk("s1").threadId;
  const reply = (session) => w.call(["reply", "--last", "--", "more"], { env: session ? { CODEX_THREAD_ID: session } : {} });
  assert.equal(reply("s2").status, 0);
  assert.equal(w.fakeCalls().at(-1).thread, two);
  assert.equal(w.fakeCalls().at(-1).prompt, "more", "a reply sends only the delta");
  assert.equal(reply("s1").status, 0);
  assert.equal(w.fakeCalls().at(-1).thread, three, "the session's latest, not an older one");
  const none = reply("other");
  assert.equal(none.status, 2);
  assert.match(none.stderr, /no earlier confirmed thread in this Codex thread/);
  const noSession = reply(null);
  assert.equal(noSession.status, 2, "jobs recorded under a session are not offered to a call without one");
  assert.match(noSession.stderr, /in this workspace/);
});

test("a reply keeps the thread's model, effort and tier unless the user names one; an explicit --tier lowers it and is kept", () => {
  const w = makeWorld();
  const first = w.call(["ask", "--to", "null", "--tier", "deep", "--", "q"]);
  const job = jobIdOf(first.stderr);
  assert.match(footerOf(first.stdout), /null-model\/xhigh/);
  const flag = (name) => { const argv = w.fakeCalls().at(-1).argv; return argv[argv.indexOf(name) + 1]; };
  assert.equal(w.call(["reply", job, "--", "a"]).status, 0);
  assert.deepEqual([flag("--model"), flag("--effort")], ["null-model", "xhigh"], "inherited");
  assert.equal(w.call(["reply", job, "--effort", "low", "--", "b"]).status, 0);
  assert.equal(flag("--effort"), "low");
  assert.equal(w.call(["reply", job, "--", "c"]).status, 0);
  assert.equal(flag("--effort"), "low", "an explicit value wins for that turn and is persisted");
  assert.equal(w.call(["reply", job, "--tier", "exec", "--", "d"]).status, 0);
  assert.deepEqual([flag("--model"), flag("--effort")], ["null-fast", "high"], "--tier overrides the inherited settings");
  const clamp = w.call(["reply", job, "--model", "fast", "--effort", "max", "--", "e"]);
  assert.match(footerOf(clamp.stdout), /null-fast\/high<=max/, "the clamp shows in the footer");
  const unknown = w.call(["reply", job, "--model", "mystery", "--", "f"]);
  assert.match(footerOf(unknown.stdout), /mystery\/max · .* · model unverified/, "an unknown model passes the inherited effort through unclamped");
  assert.equal(loadThread(w.home, "null", w.job(job).threadId).modelInput, "mystery");
});

test("a reply budget set with --rounds is kept; otherwise the thread follows COUNCIL_CODEX_ROUNDS or 9; round counts replies", () => {
  const w = makeWorld();
  const job = jobIdOf(ask(w).stderr);
  assert.match(footerOf(w.call(["reply", job, "--", "a"]).stdout), /round 2\/9$/);
  assert.match(footerOf(w.call(["reply", job, "--", "b"], { env: { COUNCIL_CODEX_ROUNDS: "4" } }).stdout), /round 3\/4$/);
  assert.match(footerOf(w.call(["reply", job, "--rounds", "12", "--", "c"]).stdout), /round 4\/12$/);
  assert.match(footerOf(w.call(["reply", job, "--", "d"], { env: { COUNCIL_CODEX_ROUNDS: "4" } }).stdout), /round 5\/12$/, "a budget set with --rounds is kept");
  const fresh = jobIdOf(ask(w).stderr);
  assert.equal(w.call(["reply", fresh, "--", "e"], { env: { COUNCIL_CODEX_ROUNDS: "zero" } }).status, 2, "an invalid budget variable is a usage error");
});

test("a thread whose recorded workspace is gone is not continued elsewhere; a reply runs in the recorded cwd", () => {
  const w = makeWorld();
  const other = path.join(w.dir, "other");
  fs.mkdirSync(other);
  const job = jobIdOf(ask(w, "q", { cwd: other }).stderr);
  assert.equal(w.call(["reply", job, "--", "from elsewhere"]).status, 0);
  assert.equal(w.fakeCalls().at(-1).cwd, fs.realpathSync(other), "the reply ran in the thread's own workspace");
  fs.rmSync(other, { recursive: true, force: true });
  const gone = w.call(["reply", job, "--", "again"]);
  assert.equal(gone.status, 2);
  assert.match(gone.stderr, /recorded workspace .* no longer exists/);
});

test("reply is provider-locked: a conflicting --to exits 2; a bare thread id matching two providers needs --to", () => {
  const w = makeWorld();
  const job = jobIdOf(ask(w).stderr);
  const thread = w.job(job).threadId;
  const conflict = w.call(["reply", job, "--to", "grok", "--", "x"]);
  assert.equal(conflict.status, 2);
  assert.match(conflict.stderr, /belongs to null; --to grok conflicts/);
  const twin = createJob(w.home, { provider: "grok", verb: "ask", status: "done", outcome: "ok", code: 0, cwd: fs.realpathSync(w.workspace), session: null, threadId: thread, admitted: true,
    spawnedAt: new Date().toISOString() });
  markDone(twin);
  const ambiguous = w.call(["reply", thread, "--", "x"]);
  assert.equal(ambiguous.status, 2);
  assert.match(ambiguous.stderr, new RegExp(`thread ${thread} exists for (null and grok|grok and null); add --to <provider>`));
  assert.equal(w.call(["reply", thread, "--to", "null", "--", "x"]).status, 0, "--to disambiguates");
  assert.equal(w.call(["reply", "never-seen", "--to", "null", "--", "x"]).status, 2, "a native id council never recorded is not adopted");
  assert.equal(w.call(["cancel", thread]).status, 2, "a bare ambiguous id cannot be cancelled either");
});

test("task is edit-mode with edited N in the footer; task --thread resumes it; a reply after a task is read-only again", () => {
  const w = makeWorld();
  const task = w.call(["task", "--to", "null", "--", "fix it"], { env: { COUNCIL_FAKE_EDITS: "src/a.js,src/b.js", COUNCIL_FAKE_FAILED_COMMAND: "npm test" } });
  assert.equal(task.status, 0, task.stderr);
  assert.match(footerOf(task.stdout), /null-fast\/high · \d+s · round 1\/9 · edited 2$/, "task defaults to the exec tier");
  assert.ok(w.fakeCalls().at(-1).argv.includes("--edit"));
  const job = jobIdOf(task.stderr);
  const json = JSON.parse(w.call(["wait", job, "--json"]).stdout);
  assert.deepEqual([json.edited, json.failedCommands], [["src/a.js", "src/b.js"], ["npm test"]]);
  const again = w.call(["task", "--to", "null", "--thread", job, "--", "more"]);
  assert.match(footerOf(again.stdout), /round 2\/9 · edited 0$/);
  assert.ok(w.fakeCalls().at(-1).argv.includes("--edit"));
  assert.equal(w.call(["reply", job, "--", "and?"]).status, 0);
  assert.ok(!w.fakeCalls().at(-1).argv.includes("--edit"), "reply is always read-only");
});
