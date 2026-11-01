// core (S4.8): a turn may finish without confirming its thread (ParsedEvent `unconfirmed`), ported from the twin's 9a9fb24:
// the answer and exit code stand, the footer prints the hint, the thread is not resumable (reply, --last, task --thread
// and the native id all exit 2 with the hint). A fatal event keeps the cost, usage and structured output it carries.
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { makeWorld, jobIdOf, footerOf, adapter } from "./helpers.mjs";
import { createReader } from "../plugins/council/scripts/lib/core/reader.mjs";
import { main } from "../plugins/council/scripts/council.mjs";
import { saveThread, loadThread } from "../plugins/council/scripts/lib/core/jobs.mjs";
import { inspectClaim } from "../plugins/council/scripts/lib/core/claims.mjs";

async function inProcess(w, args, { env = {}, hooks = {} } = {}) {
  let out = "", err = "";
  const { PassThrough } = await import("node:stream");
  const stdin = new PassThrough();
  stdin.end("");
  const code = await main(args, { ...w.env, ...env }, { stdout: { write: (x) => { out += x; } }, stderr: { write: (x) => { err += x; } }, stdin }, { cwd: w.workspace, hooks });
  return { code, out, err };
}

const HINT = "session not confirmed: start a new ask";
const unconfirmed = { COUNCIL_FAKE_UNCONFIRMED: HINT };

test("a fresh thread that finishes unconfirmed keeps its answer and exit 0, prints the hint, and cannot be resumed", () => {
  const w = makeWorld();
  const r = w.call(["ask", "--to", "null", "--", "q"], { env: unconfirmed });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.stdout.split("\n")[0], "fake answer to: q");
  assert.match(footerOf(r.stdout), new RegExp(`^council null ok · job [a-z0-9]{16} · null-model/high · \\d+s · round 1/9 · ${HINT}$`));
  const id = jobIdOf(r.stderr);
  const job = w.job(id);
  assert.deepEqual([job.threadId, job.unconfirmed], [null, HINT]);
  const calls = w.fakeCalls().length;
  for (const args of [["reply", id, "--", "more"], ["reply", "--last", "--", "more"], ["task", "--to", "null", "--thread", id, "--", "edit"], ["reply", job.requestedThreadId, "--to", "null", "--", "more"]]) {
    const again = w.call(args);
    assert.equal(again.status, 2, `${args.join(" ")}: ${again.stdout}${again.stderr}`);
    assert.match(again.stderr, new RegExp(HINT), args.join(" "));
  }
  assert.equal(w.fakeCalls().length, calls, "nothing was started");
  assert.equal(JSON.parse(w.call(["wait", id, "--json"]).stdout).exit, 0);
});

test("a resumed thread that finishes unconfirmed is marked resumable: false; replying through an earlier job exits 2", () => {
  const w = makeWorld();
  const first = jobIdOf(w.call(["ask", "--to", "null", "--", "q"]).stderr);
  const thread = w.job(first).threadId;
  const r = w.call(["reply", first, "--", "more"], { env: unconfirmed });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(footerOf(r.stdout), new RegExp(`round 2/9 · ${HINT}$`));
  const record = JSON.parse(fs.readFileSync(path.join(w.home, "threads", `null-${thread}.json`), "utf8"));
  assert.deepEqual([record.resumable, record.unconfirmed], [false, HINT]);
  for (const args of [["reply", first, "--", "again"], ["reply", "--last", "--", "again"], ["reply", thread, "--to", "null", "--", "again"]]) {
    const again = w.call(args);
    assert.equal(again.status, 2, args.join(" "));
    assert.match(again.stderr, new RegExp(HINT));
  }
  assert.equal(w.call(["ask", "--to", "null", "--", "fresh"]).status, 0, "a new ask is unaffected");
});

test("a fatal event keeps the answer, cost and structured output it carries; the turn fails with its message", () => {
  const w = makeWorld();
  const r = w.call(["ask", "--to", "null", "--", "q"], { env: { COUNCIL_FAKE_END_FATAL: "incomplete: stopped early" } });
  assert.equal(r.status, 1);
  assert.equal(r.stdout.split("\n")[0], "fake answer to: q");
  assert.match(footerOf(r.stdout), /error: incomplete: stopped early/);
  const job = w.job(jobIdOf(r.stderr));
  assert.deepEqual([job.cost, job.usage], [0.001, { fatal: true }]);
  const reader = createReader(adapter, {});
  reader.feed(`${JSON.stringify({ type: "end", fatal: "x", cost: 0.5, structured: { verdict: "approve" } })}\n`);
  assert.deepEqual([reader.state.failed, reader.state.costUsd, reader.state.structured], ["x", 0.5, { verdict: "approve" }]);
});

test("the reader latches the first unconfirmed hint; adapters that never return it are unaffected", () => {
  const reader = createReader({ ...adapter, parseEvent: (line) => JSON.parse(line) }, {});
  reader.feed(`${JSON.stringify({ unconfirmed: "first" })}\n${JSON.stringify({ unconfirmed: "second" })}\n${JSON.stringify({ unconfirmed: true })}\n`);
  assert.equal(reader.state.unconfirmed, "first");
  const plain = createReader({ ...adapter, parseEvent: (line) => JSON.parse(line) }, {});
  plain.feed(`${JSON.stringify({ unconfirmed: true })}\n`);
  assert.equal(plain.state.unconfirmed, "thread not confirmed: start a new ask");
  const none = createReader(adapter, {});
  none.feed(`${JSON.stringify({ type: "end", thread: "t", cost: 0 })}\n`);
  assert.equal(none.state.unconfirmed, null);
});

test("non-resumability is rechecked under the claim: a thread made non-resumable after resolution releases and exits 2 before any spawn", async () => {
  const w = makeWorld();
  const first = jobIdOf(w.call(["ask", "--to", "null", "--", "q"]).stderr);
  const thread = w.job(first).threadId;
  const calls = w.fakeCalls().length;
  // Another turn on the thread finishes unconfirmed between this reply's resolution and its claim.
  const beforeClaim = () => saveThread(w.home, { ...loadThread(w.home, "null", thread), resumable: false, unconfirmed: HINT });
  const r = await inProcess(w, ["reply", first, "--", "more"], { hooks: { beforeClaim } });
  assert.equal(r.code, 2, r.out + r.err);
  assert.match(r.err, new RegExp(`null thread ${thread}: ${HINT}`));
  assert.equal(w.fakeCalls().length, calls, "nothing was spawned");
  assert.equal(inspectClaim(w.home, "null", thread).state, "absent", "the claim is released");
  const again = await inProcess(w, ["reply", first, "--request-id", "r-1", "--", "more"], { hooks: { beforeClaim } });
  assert.equal(again.code, 2);
  assert.equal(w.call(["reply", first, "--request-id", "r-1", "--", "more"]).status, 2, "the request id was freed, and the thread stays refused");
});

test("a failed review stores and prints the structured output it received; exit and coverage unchanged", () => {
  const w = makeWorld();
  fs.writeFileSync(path.join(w.workspace, "README.md"), "# changed\n");
  const findings = { verdict: "needs-attention", summary: "Partial.", findings: [], next_steps: [] };
  const r = w.call(["review", "--to", "null"], { env: { COUNCIL_FAKE_END_FATAL: "incomplete: max turns", COUNCIL_FAKE_STRUCTURED: JSON.stringify(findings) } });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /^\{\n {2}"verdict": "needs-attention",\n {2}"summary": "Partial\.",/);
  assert.match(footerOf(r.stdout), /error: incomplete: max turns/);
  const job = jobIdOf(r.stderr);
  const json = JSON.parse(w.call(["wait", job, "--json"]).stdout);
  assert.deepEqual([json.exit, json.coverage.reviewed, JSON.parse(json.answer).summary], [1, 0, "Partial."]);
  const text = w.call(["review", "--to", "null"], { env: { COUNCIL_FAKE_END_FATAL: "incomplete: max turns", COUNCIL_FAKE_REVIEW_TEXT: "streamed partial text" } });
  assert.equal(text.status, 1);
  assert.equal(text.stdout.split("\n")[0], "streamed partial text", "streamed text is the answer when there is any");
});

test("an incomplete review (malformed output) prints what it received after the incomplete notice; exit 10, no coverage", () => {
  const w = makeWorld();
  fs.writeFileSync(path.join(w.workspace, "README.md"), "# changed\n");
  const r = w.call(["review", "--to", "null", "--json"], { env: { COUNCIL_FAKE_STRUCTURED: JSON.stringify({ verdict: "lgtm", summary: "fine" }) } });
  const out = JSON.parse(r.stdout);
  assert.equal(out.exit, 10);
  assert.match(out.answer, /^Verdict: incomplete\.\nIncomplete: review verdict must be approve or needs-attention[\s\S]*\n\nReceived output \(not accepted\):\n\{\n {2}"verdict": "lgtm"/);
  assert.equal(out.coverage.reviewed, 0);
  const t = JSON.parse(w.call(["review", "--to", "null", "--json"], { env: { COUNCIL_FAKE_STRUCTURED: JSON.stringify({ verdict: "lgtm" }), COUNCIL_FAKE_REVIEW_TEXT: "raw model text" } }).stdout);
  assert.match(t.answer, /Received output \(not accepted\):\nraw model text\n?$/);
});
