// S2.3/S2.6: the request lifecycle of A7.4 through the entry (jobs.mjs request records and tombstones, lifecycle preparation),
// ported from grok_plugin_for_codex 1.1.0 tests/requests.test.mjs onto the null adapter.
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { makeWorld, jobIdOf, footerOf, until } from "./helpers.mjs";
import { createJob, lookupRequest, markDone, requestJobId, requestKey, saveJob } from "../plugins/council/scripts/lib/core/jobs.mjs";

const ask = (w, id, text = "q", extra = {}) => w.call(["ask", "--to", "null", "--request-id", id, "--", text], extra);

test("a retry with the same request id and input returns the first result without a second submission; --json is presentation", () => {
  const w = makeWorld();
  const first = ask(w, "r1");
  assert.equal(first.status, 0, first.stderr);
  const job = jobIdOf(first.stderr);
  assert.equal(job, requestJobId("null", null, fs.realpathSync(w.workspace), "r1"), "the job id is derived from provider, session, cwd and request id");
  const retry = ask(w, "r1", "q", { env: { COUNCIL_FAKE_ANSWER: "a second run would say this" } });
  assert.equal(retry.status, 0, retry.stderr);
  assert.equal(retry.stdout, first.stdout.replace(/· \d+s ·/, (m) => m), "the same answer and footer");
  assert.equal(retry.stderr, "", "no start line on a replay");
  assert.equal(JSON.parse(w.call(["ask", "--to", "null", "--request-id", "r1", "--json", "--", "q"]).stdout).answer, "fake answer to: q");
  assert.equal(w.fakeCalls().length, 1, "one native submission");
  assert.equal(lookupRequest(w.home, requestKey(null, fs.realpathSync(w.workspace), "r1")).state, "tombstone");
});

test("changed input under a used request id is refused with exit 2 before anything starts", () => {
  const w = makeWorld();
  assert.equal(ask(w, "r2").status, 0);
  for (const [args, why] of [[["ask", "--to", "null", "--request-id", "r2", "--", "other"], "text"], [["ask", "--to", "null", "--request-id", "r2", "--tier", "deep", "--", "q"], "tier"],
    [["task", "--to", "null", "--request-id", "r2", "--", "q"], "verb"], [["ask", "--to", "null", "--request-id", "r2", "--effort", "low", "--", "q"], "effort"]]) {
    const r = w.call(args);
    assert.equal(r.status, 2, why);
    assert.match(r.stderr, /request id r2 was already used with different input/);
  }
  assert.equal(w.fakeCalls().length, 1);
  assert.equal(ask(w, "r3").status, 0, "a new id is a new request");
  assert.equal(ask(w, "r2", "other", { env: { CODEX_THREAD_ID: "another" } }).status, 0, "an id is scoped to its Codex thread");
  const elsewhere = path.join(w.dir, "elsewhere");
  fs.mkdirSync(elsewhere);
  assert.equal(ask(w, "r2", "other", { cwd: elsewhere }).status, 0, "and to its workspace");
  assert.equal(w.fakeCalls().length, 4);
});

test("concurrent identical requests agree on one job and start one child", async () => {
  const w = makeWorld();
  const runs = Array.from({ length: 4 }, () => w.start(["ask", "--to", "null", "--request-id", "r4", "--", "q"], { env: { COUNCIL_FAKE_SCENARIO: "slow", COUNCIL_FAKE_SLOW_MS: "600" } }));
  const results = await Promise.all(runs.map((r) => r.exited));
  for (const r of results) {
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /fake answer to: q\ncouncil null ok/);
  }
  assert.equal(new Set(results.map((r) => /council null ok · job (\w+)/.exec(r.stdout)[1])).size, 1);
  assert.equal(w.fakeCalls().length, 1);
  assert.equal(fs.readdirSync(path.join(w.home, "jobs")).length, 1, "one job directory");
});

test("a retry while the first call still runs waits for it and prints its result", async () => {
  const w = makeWorld();
  const running = w.start(["ask", "--to", "null", "--request-id", "r5", "--", "q"], { env: { COUNCIL_FAKE_SCENARIO: "slow", COUNCIL_FAKE_SLOW_MS: "800", COUNCIL_FAKE_ANSWER: "late" } });
  await running.waitFor(/job=[a-z0-9]{16}/);
  const retry = ask(w, "r5");
  assert.equal(retry.status, 0, retry.stderr);
  assert.match(retry.stdout, /^late\n/);
  await running.exited;
  assert.equal(w.fakeCalls().length, 1);
});

test("a call that fails before preparing frees its request id for a corrected retry", () => {
  const w = makeWorld();
  const jobs = () => (fs.existsSync(path.join(w.home, "jobs")) ? fs.readdirSync(path.join(w.home, "jobs")).length : 0);
  for (const args of [["reply", "nosuchjob"], ["ask", "--to", "null", "--deadline", "NaN"], ["ask", "--to", "null", "--inactivity-timeout", "0"], ["ask", "--to", "claude"]]) {
    const bad = w.call([...args, "--request-id", "r6", "--", "q"]);
    assert.equal(bad.status, 2, `${args.join(" ")}: ${bad.stdout}${bad.stderr}`);
    assert.equal(jobs(), 0, `${args.join(" ")}: no claim is left behind`);
  }
  const blocked = w.call(["ask", "--to", "null", "--request-id", "r6", "--", "q"], { env: { COUNCIL_NULL_PREFLIGHT_BLOCK: path.join(w.dir, "nope") } });
  assert.equal(blocked.status, 1, "a blocked preflight claims nothing either");
  assert.equal(lookupRequest(w.home, requestKey(null, fs.realpathSync(w.workspace), "r6")), null);
  assert.equal(ask(w, "r6").status, 0, "the id now names the corrected call");
  assert.equal(w.fakeCalls().length, 1);
});

test("a request that failed or was cancelled is never run again: a retry reports the same outcome", async () => {
  const w = makeWorld();
  const failed = ask(w, "r8", "q", { env: { COUNCIL_FAKE_SCENARIO: "exit-nonzero" } });
  assert.equal(failed.status, 1);
  const again = ask(w, "r8");
  assert.equal(again.status, 1, "the retry is the first call's result, not a fresh attempt");
  assert.equal(footerOf(again.stdout), footerOf(failed.stdout));
  assert.equal(w.fakeCalls().length, 1);
  const running = w.start(["ask", "--to", "null", "--request-id", "r9", "--", "q"], { env: { COUNCIL_FAKE_HANG: "1" } });
  const [, job] = await running.waitFor(/job=([a-z0-9]{16})/);
  await until(() => w.job(job).pid);
  assert.equal(w.call(["cancel", job]).status, 0);
  assert.equal((await running.exited).code, 1);
  const retry = ask(w, "r9");
  assert.equal(retry.status, 1);
  assert.match(footerOf(retry.stdout), new RegExp(`^council null cancelled · job ${job} `));
  assert.equal(w.fakeCalls().length, 2, "the cancelled request did not start a second child");
});

test("a request-id job is an ordinary job: wait, reply and --last reach it, and a replayed reply prints the first reply", () => {
  const w = makeWorld();
  const job = jobIdOf(ask(w, "r10").stderr);
  const waited = w.call(["wait", job]);
  assert.equal(waited.status, 0);
  assert.match(waited.stdout, new RegExp(`^fake answer to: q\\ncouncil null ok · job ${job} `));
  const reply = w.call(["reply", job, "--request-id", "r11", "--", "and?"]);
  assert.equal(reply.status, 0, reply.stderr);
  assert.equal(w.fakeCalls().at(-1).thread, w.job(job).threadId, "the reply resumed the job's thread");
  assert.match(reply.stdout, /round 2\/9/);
  const replayed = w.call(["reply", job, "--request-id", "r11", "--", "and?"]);
  assert.equal(replayed.stdout, reply.stdout, "the replay prints the first reply's result");
  assert.equal(w.call(["reply", "--last", "--", "more"]).status, 0);
  assert.equal(w.fakeCalls().length, 3);
});

test("a replay of reply --last recovers the original provider and job after another provider's job became the latest, and loads no adapter", () => {
  const w = makeWorld();
  const cwd = fs.realpathSync(w.workspace);
  assert.equal(ask(w, "seed").status, 0);
  const reply = w.call(["reply", "--last", "--request-id", "r12", "--", "follow up"]);
  assert.equal(reply.status, 0, reply.stderr);
  const later = createJob(w.home, { provider: "grok", verb: "ask", status: "done", outcome: "ok", code: 0, cwd, session: null, threadId: "grok-thread", admitted: true,
    admittedAt: "9999-01-01T00:00:00.000Z", spawnedAt: "9999-01-01T00:00:00.000Z", endedAt: "9999-01-01T00:00:01.000Z" });
  markDone(later);
  const calls = w.fakeCalls().length;
  const replayed = w.call(["reply", "--last", "--request-id", "r12", "--", "follow up"], { env: { COUNCIL_TEST_NULL_ADAPTER: "" } });
  assert.equal(replayed.status, 0, replayed.stderr);
  assert.equal(replayed.stdout, reply.stdout, "the original null job, though --last now names a grok job and the null adapter cannot load");
  assert.equal(w.fakeCalls().length, calls, "a replay spawns nothing");
});

test("a pruned request reports `result expired` (exit 1) and runs nothing; an abandoned reservation is released and may run again", () => {
  const w = makeWorld();
  const first = ask(w, "r13");
  fs.rmSync(path.join(w.home, "jobs", jobIdOf(first.stderr)), { recursive: true, force: true });
  const expired = ask(w, "r13");
  assert.equal(expired.status, 1);
  assert.match(expired.stdout, /^result expired · job [a-z0-9]{16}\n$/);
  assert.equal(w.fakeCalls().length, 1);
  const cwd = fs.realpathSync(w.workspace);
  const key = requestKey(null, cwd, "r14");
  const jobId = requestJobId("null", null, cwd, "r14");
  fs.mkdirSync(path.join(w.home, "requests"), { recursive: true });
  fs.writeFileSync(path.join(w.home, "requests", `${key}.json`), JSON.stringify({ state: "reserved", id: "r14", key, provider: "null", job: jobId, session: null, cwd,
    fingerprint: JSON.parse(fs.readFileSync(path.join(w.home, "requests", `${requestKey(null, cwd, "r13")}.json`), "utf8")).fingerprint.replace(/./, "x"), companionPid: 999999, companionIdentity: { pid: 999999, stamp: "1" } }));
  const mismatch = ask(w, "r14");
  assert.equal(mismatch.status, 2, "a different fingerprint is refused even for an abandoned reservation");
  const record = JSON.parse(fs.readFileSync(path.join(w.home, "requests", `${key}.json`), "utf8"));
  const fp = (() => { const tmp = ask(w, "probe-fp"); assert.equal(tmp.status, 0); return JSON.parse(fs.readFileSync(path.join(w.home, "requests", `${requestKey(null, cwd, "probe-fp")}.json`), "utf8")).fingerprint; })();
  fs.writeFileSync(path.join(w.home, "requests", `${key}.json`), JSON.stringify({ ...record, fingerprint: fp }));
  const abandoned = ask(w, "r14");
  assert.equal(abandoned.status, 2);
  assert.match(abandoned.stderr, /names job [a-z0-9]{16} that ended before it prepared; nothing ran, so the same request id can run again/);
  assert.equal(lookupRequest(w.home, key), null, "the reservation was released");
  assert.equal(ask(w, "r14").status, 0, "and the id runs");
});

test("review and task honour request ids: a retried task never edits twice", () => {
  const w = makeWorld();
  fs.writeFileSync(path.join(w.workspace, "README.md"), "# changed\n");
  const review = () => w.call(["review", "--to", "null", "--request-id", "r15"]);
  const first = review();
  assert.equal(first.status, 0, first.stdout + first.stderr);
  assert.equal(review().stdout, first.stdout);
  const task = () => w.call(["task", "--to", "null", "--request-id", "r16", "--", "fix it"], { env: { COUNCIL_FAKE_EDITS: "a.js" } });
  const edited = task();
  assert.match(footerOf(edited.stdout), /edited 1$/);
  assert.equal(task().stdout, edited.stdout);
  assert.equal(w.fakeCalls().length, 2, "one review and one task reached the child");
});
