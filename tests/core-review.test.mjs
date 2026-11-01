// S2.5: templates, the batch prompt, the normalized result and its exit rules, and whole review sessions over saved
// snapshots (500 KB rollout, tampering, workspace change, failed and invalid responses, early major finding then clean
// synthesis, identified resolution, unchanged findings, failed publication, binary input through synthesis), ported from
// claude_plugin_for_codex 0.5.0 and grok_plugin_for_codex 1.1.0 tests/review-batches.test.mjs onto the core API.
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { PLUGIN_ROOT, TEMPLATES, batchPosition, buildBatchReviewPrompt, collectReview, continueReviewTurn, finalizeReviewTurn, interpolate, loadTemplate, normalizeReview,
  renderReview, saveReviewInput, startReviewTurn } from "../plugins/council/scripts/lib/core/review.mjs";
import { UsageError } from "../plugins/council/scripts/lib/core/args.mjs";
import * as repos from "./fixtures/build-repos.mjs";

const SCHEMA = fs.readFileSync(path.join(PLUGIN_ROOT, "schemas", "review-output.schema.json"), "utf8");
const finding = (extra = {}) => ({ id: "F1", severity: "high", title: "Loop drops the first item", body: "The loop starts at 1.", file: "part0.txt", line_start: 1, line_end: 1, confidence: 0.9,
  recommendation: "Start at 0.", ...extra });
const clean = { verdict: "approve", summary: "No issues in this batch.", findings: [], next_steps: [] };
const flagged = (findings = [finding()]) => ({ verdict: "needs-attention", summary: "A defect.", findings, next_steps: ["Fix it."] });

/** A review session over a real repository, with its saved input under a job directory, as the lifecycle lays it out. */
function session(dir, { reviewRef = "aaaaaaaaaaaaaaaa", options = {} } = {}) {
  const home = repos.tmp("council-review-");
  const review = collectReview(dir, options);
  const inputRoot = path.join(home, "jobs", reviewRef, "review-input");
  saveReviewInput(inputRoot, review.snapshot, review.fullDiff);
  const first = startReviewTurn(review, reviewRef, inputRoot);
  let n = 0;
  const resultPath = () => path.join(home, "jobs", `job${String(++n).padStart(13, "0")}`, "meta.json");
  return { home, review, inputRoot, first, resultPath };
}
const settle = (s, state, structured, success = true) => finalizeReviewTurn({ state, structured, success, resultPath: s.resultPath(), jobId: "x" });

test("the four prompt templates and the standing contract exist; every template placeholder resolves and none is left", () => {
  assert.deepEqual(TEMPLATES, ["advice", "review", "adversarial-review", "task"]);
  for (const name of TEMPLATES) assert.ok(loadTemplate(name).trim().length > 100, name);
  const contract = fs.readFileSync(path.join(PLUGIN_ROOT, "contract.md"), "utf8");
  assert.match(contract, /^<council_contract version="1">/);
  assert.match(contract, /arrive with the input; follow them for that turn only/, "the standing contract is mode-neutral: per-turn instructions travel in the input");
  for (const text of [contract, loadTemplate("advice"), loadTemplate("task")]) assert.doesNotMatch(text, /\{\{/);
  assert.match(loadTemplate("task"), /Never run `git push`, `git reset --hard`, `rm -rf`/);
  for (const name of ["review", "adversarial-review"]) {
    const placeholders = [...loadTemplate(name).matchAll(/\{\{([A-Z_]+)\}\}/g)].map((m) => m[1]).sort();
    assert.deepEqual(placeholders, ["PRIOR_FINDINGS", "REVIEW_INPUT", "SCHEMA", "TARGET_LABEL", "UNSUPPORTED", "USER_FOCUS"], name);
  }
  assert.throws(() => loadTemplate("consensus"), /unknown prompt template/);
});

test("interpolate fills every placeholder and rejects a missing value or an unused one", () => {
  assert.equal(interpolate("a {{X}} b {{Y_Z}}", { X: 1, Y_Z: "two" }), "a 1 b two");
  assert.throws(() => interpolate("a {{X}} {{Y}}", { X: 1 }), /unresolved placeholder \{\{Y\}\}/);
  assert.throws(() => interpolate("a {{X}}", { X: 1, EXTRA: 2 }), /template has no placeholder \{\{EXTRA\}\}/);
  assert.equal(interpolate("{{X}}{{X}}", { X: "r" }), "rr");
});

test("buildBatchReviewPrompt: review or adversarial template, focus, prior findings on batch 2+, unsupported list, coverage and embedded schema", () => {
  const base = { label: "working tree", batchText: "<the diff>" };
  const first = buildBatchReviewPrompt(base);
  assert.match(first, /^Instructions for this turn \(structured code review, read-only\)/);
  assert.match(first, /Target: working tree\nUser focus: none given/);
  assert.match(first, /First batch: no earlier findings\./);
  assert.match(first, /Every collected change is reviewable text\./);
  assert.match(first, /Answer in the structured-output schema the harness enforces\./);
  assert.match(first, /<review_input>\n<the diff>\n<\/review_input>/);
  const later = buildBatchReviewPrompt({ ...base, adversarial: true, focus: " the cache ", ledger: [{ id: "u1-F1", location: "a.js:3", severity: "high", decision: "AGREE", title: "T" }],
    unsupported: ["blob (binary)"], embedSchema: SCHEMA });
  assert.match(later, /^Instructions for this turn \(adversarial code review, read-only\)/);
  assert.match(later, /User focus: the cache\n/);
  assert.match(later, /- u1-F1 BLOCKER a\.js:3 AGREE: T/);
  assert.match(later, /do not approve them:\n- blob \(binary\)/);
  assert.match(later, /matching this draft-07 schema exactly:\n\{/);
  assert.ok(later.includes(SCHEMA.trim().slice(0, 40)));
  const many = buildBatchReviewPrompt({ ...base, unsupported: Array.from({ length: 25 }, (_, i) => `f${i} (binary)`) });
  assert.match(many, /- f19 \(binary\)\n25 unsupported paths in total; see the saved index\./);
  assert.doesNotMatch(many, /f20 \(binary\)/);
});

test("normalized result: severity map, needs-attention → changes, approval with findings → changes, malformed → incomplete, all exit 10", () => {
  const ok = normalizeReview(clean, { state: { completed: ["u1"], pending: 0 } });
  assert.deepEqual([ok.verdict, ok.exit, ok.findings, ok.coverage], ["approve", 0, [], { reviewed: 1, unreviewed: 0, pending: 0 }]);
  const changes = normalizeReview(flagged([finding(), finding({ id: "F2", severity: "medium" }), finding({ id: "F3", severity: "low" })]));
  assert.deepEqual([changes.verdict, changes.exit], ["changes", 10]);
  assert.deepEqual(changes.findings.map((f) => [f.id, f.severity, f.file, f.line]), [["F1", "BLOCKER", "part0.txt", 1], ["F2", "MAJOR", "part0.txt", 1], ["F3", "MINOR", "part0.txt", 1]]);
  assert.deepEqual(changes.findings[0], { id: "F1", severity: "BLOCKER", file: "part0.txt", line: 1, title: "Loop drops the first item", text: "The loop starts at 1.", recommendation: "Start at 0." });
  const sneaky = normalizeReview({ ...clean, findings: [finding({ severity: "low" })] });
  assert.deepEqual([sneaky.verdict, sneaky.exit], ["changes", 10], "an approval that keeps findings is not an approval");
  const rejected = normalizeReview({ ...clean, findings: [finding({ decision: "REJECT" })] }, { state: { completed: [], pending: 0 } });
  assert.deepEqual([rejected.verdict, rejected.exit], ["approve", 0], "a REJECTed finding is not open");
  assert.deepEqual([normalizeReview({ ...flagged([]), verdict: "needs-attention" }).exit, normalizeReview({ ...flagged([]) }).verdict], [10, "changes"], "needs-attention without findings is still 10");
  for (const bad of [null, { verdict: "lgtm" }, { ...clean, extra: 1 }, { ...clean, findings: [{ ...finding(), id: undefined }] }]) {
    const n = normalizeReview(bad);
    assert.deepEqual([n.verdict, n.exit, n.findings], ["incomplete", 10, []], JSON.stringify(bad));
    assert.ok(n.incomplete);
  }
  assert.equal(normalizeReview(clean, { state: { completed: [], pending: 2 } }).exit, 10, "pending coverage");
  assert.equal(normalizeReview(clean, { state: { completed: [], pending: 0, synthesisPending: true } }).coverage.pending, 1);
  assert.equal(normalizeReview(clean, { unreviewed: ["blob (binary)"] }).exit, 10, "unreviewed coverage");
  assert.equal(normalizeReview(clean, { state: { completed: [], pending: 0, blocking: true } }).exit, 10, "an open earlier blocker");
  assert.match(renderReview(changes), /^Verdict: needs attention\. A defect\.\n\nF1 BLOCKER part0\.txt:1: Loop drops the first item\nThe loop starts at 1\.\nFix: Start at 0\./);
  assert.match(renderReview(normalizeReview(null)), /^Verdict: incomplete\.\nIncomplete: missing structured review output/);
});

test("a single-batch review settles in one turn: coverage complete, the response published inside the input root", () => {
  const dir = repos.init(path.join(repos.tmp(), "small"));
  repos.commit(dir, { "a.txt": "1\n" }, "base");
  repos.write(dir, "a.txt", "1\n2\n");
  const s = session(dir);
  assert.deepEqual([s.first.state.active, s.first.state.synthesisRequired, s.first.batch], [["u1"], false, { index: 1, total: 1 }]);
  const done = settle(s, s.first.state, clean);
  assert.deepEqual([done.verdict, done.attention, done.reviewState.status, done.reviewState.completed], ["approve", false, "complete", ["u1"]]);
  assert.ok(done.reviewState.results[0].path.startsWith(s.inputRoot + path.sep));
  assert.equal(JSON.parse(fs.readFileSync(done.reviewState.results[0].path)).response.verdict, "approve");
  assert.throws(() => continueReviewTurn(done.reviewState), (e) => e instanceof UsageError && /nothing left to send/.test(e.message));
});

test("a 500 KB review continues from its snapshot, ignores live workspace changes, keeps coverage through a discussion reply and requires synthesis", () => {
  const { dir } = repos.largeChangeRepo();
  const s = session(dir);
  const original = fs.readFileSync(path.join(s.inputRoot, "review.data"));
  assert.ok(original.length >= 500000);
  assert.ok(s.first.state.synthesisRequired);
  let result = settle(s, s.first.state, clean);
  assert.equal(result.attention, true, "pending coverage is attention");
  assert.equal(result.reviewState.status, "partial");
  const completedAfterFirst = result.reviewState.completed.length;
  for (let i = 0; i < 5; i++) repos.write(dir, `part${i}.txt`, "live workspace changed\n");
  const reply = settle(s, { ...result.reviewState, active: [] }, clean);
  assert.equal(reply.reviewState.completed.length, completedAfterFirst, "a discussion reply grants no delivery coverage");
  let state = reply.reviewState, rounds = 0, sawSynthesis = false;
  const positions = [s.first.batch];
  while (state.status !== "complete" && rounds++ < 10) {
    const next = continueReviewTurn(state, true);
    positions.push(next.batch);
    assert.doesNotMatch(next.text, /live workspace changed/);
    sawSynthesis ||= next.text.includes("Final synthesis:");
    assert.equal(next.state.snapshotId, s.first.state.snapshotId);
    result = settle(s, next.state, clean);
    state = result.reviewState;
  }
  assert.ok(sawSynthesis);
  assert.deepEqual([state.status, state.pending, state.synthesisPending, result.attention], ["complete", 0, false, false]);
  assert.equal(state.completed.length, state.total);
  assert.deepEqual(positions.map((p) => p.index), positions.map((_, i) => i + 1), "batch i/n counts up");
  assert.ok(positions.every((p) => p.total === positions.length), JSON.stringify(positions));
  for (const item of state.results) {
    assert.ok(item.path.startsWith(s.inputRoot + path.sep));
    assert.ok(item.inputPath.startsWith(s.inputRoot + path.sep));
    assert.ok(Array.isArray(JSON.parse(fs.readFileSync(item.path)).response.findings));
  }
  assert.ok(JSON.parse(fs.readFileSync(state.synthesisIndex)).length > 1);
  assert.ok(fs.readFileSync(path.join(s.inputRoot, "review.data")).equals(original), "the saved input never changes");
  assert.throws(() => continueReviewTurn(state), UsageError);
});

test("a failed or invalid batch earns no coverage, a discussion reply cannot clear it, and --next-input re-sends the same batch", () => {
  const { dir } = repos.largeChangeRepo({ files: 3, lines: 9000 });
  const s = session(dir);
  for (const [structured, success] of [[clean, false], [{ ...clean, verdict: "invalid" }, true], [null, true]]) {
    const r = settle(s, s.first.state, structured, success);
    assert.deepEqual(r.reviewState.completed, [], JSON.stringify(structured));
    assert.equal(r.verdict, "incomplete");
    assert.equal(r.attention, true);
    assert.ok(r.incomplete);
    const discussion = settle(s, { ...r.reviewState, active: [] }, clean);
    assert.deepEqual(discussion.reviewState.completed, []);
    assert.equal(discussion.reviewState.status, "partial");
    const again = continueReviewTurn(r.reviewState, false);
    assert.deepEqual(again.state.active, s.first.state.active, "the uncredited batch is sent again");
    assert.equal(again.batch.index, 1);
  }
});

test("snapshot tampering stops a continuation before another model submission", () => {
  const { dir } = repos.largeChangeRepo({ files: 3, lines: 9000 });
  const s = session(dir);
  const settled = settle(s, s.first.state, clean);
  fs.appendFileSync(path.join(s.inputRoot, "review.data"), "tampered");
  assert.throws(() => continueReviewTurn(settled.reviewState, true), /hash mismatch/);
  const other = session(repos.largeChangeRepo({ files: 3, lines: 9000 }).dir);
  const ok = settle(other, other.first.state, clean);
  fs.appendFileSync(path.join(other.inputRoot, "review.diff"), "tampered");
  assert.throws(() => continueReviewTurn(ok.reviewState), /Saved tracked patch hash mismatch/);
});

test("an early major finding stays visible through a clean synthesis, and only its identified REJECT resolves it", () => {
  const { dir } = repos.largeChangeRepo({ files: 3, lines: 9000 });
  const s = session(dir);
  let result = settle(s, s.first.state, flagged());
  assert.equal(result.reviewState.blocking, true);
  assert.equal(result.reviewState.results[0].blocking, true);
  assert.deepEqual(result.findings.map((f) => f.id), ["u1-F1"]);
  let state = result.reviewState, rounds = 0;
  while ((state.pending || state.synthesisPending) && rounds++ < 10) {
    const next = continueReviewTurn(state, true);
    result = settle(s, next.state, { ...flagged([finding({ id: "F2", severity: "low", file: "part2.txt" })]), verdict: "needs-attention" });
    state = result.reviewState;
  }
  assert.equal(state.status, "complete");
  assert.equal(result.attention, true, "the earlier blocker keeps the review in attention");
  assert.match(result.text, /Earlier review responses reported blocking findings that remain open: u1-F1\./);
  assert.equal(state.results.at(-1).blocking, false);
  assert.deepEqual(state.findingsLedger.filter((i) => i.severity === "high").map((i) => i.id), ["u1-F1"], "unchanged findings stay in the ledger");
  const unrelated = settle(s, { ...state, active: [] }, { ...clean, findings: [finding({ id: "u9-F1", decision: "REJECT", file: "nope.txt" })] });
  assert.equal(unrelated.reviewState.blocking, true, "rejecting an unknown finding resolves nothing");
  const resolved = settle(s, { ...state, active: [] }, { ...clean, findings: [finding({ id: "u1-F1", decision: "REJECT" })] });
  assert.deepEqual([resolved.reviewState.blocking, resolved.attention, resolved.verdict], [false, false, "approve"]);
  assert.equal(resolved.reviewState.status, "complete", "a discussion reply leaves coverage as it was");
});

test("a failed publication leaves the prior findings ledger and coverage unchanged", (t) => {
  const { dir } = repos.largeChangeRepo({ files: 3, lines: 9000 });
  const s = session(dir);
  const settled = settle(s, s.first.state, flagged());
  const next = continueReviewTurn(settled.reviewState, true);
  const before = JSON.stringify({ completed: next.state.completed, ledger: next.state.findingsLedger, blocking: next.state.blocking });
  const link = fs.linkSync;
  t.after(() => { fs.linkSync = link; });
  fs.linkSync = () => { throw Object.assign(new Error("publication failed"), { code: "EIO" }); };
  for (const structured of [{ ...clean, findings: [finding({ id: "u1-F1", decision: "REJECT" })] }, flagged([finding({ id: "F7", severity: "low" })])]) {
    const failed = settle(s, next.state, structured);
    assert.match(failed.error, /^review integrity: publication failed/);
    assert.equal(JSON.stringify({ completed: failed.reviewState.completed, ledger: failed.reviewState.findingsLedger, blocking: failed.reviewState.blocking }), before);
  }
  fs.linkSync = link;
  assert.equal(settle(s, next.state, clean).error, undefined, "the same batch publishes once storage works");
});

test("unsupported binary input keeps the review partial after every text batch and synthesis", () => {
  const { dir } = repos.largeChangeRepo({ files: 3, lines: 9000 });
  repos.write(dir, "binary", Buffer.from([0, 1]));
  const s = session(dir);
  let result = settle(s, s.first.state, clean), rounds = 0;
  while ((result.reviewState.pending || result.reviewState.synthesisPending) && rounds++ < 10) result = settle(s, continueReviewTurn(result.reviewState, true).state, clean);
  assert.deepEqual([result.reviewState.pending, result.reviewState.synthesisPending, result.reviewState.status], [0, false, "partial"]);
  assert.deepEqual(result.unreviewed, ["binary (untracked, binary)"], "pending saved batches are pending, not unreviewed");
  assert.equal(result.attention, true);
  assert.equal(result.normalized.coverage.unreviewed, 1);
});

test("batchPosition reports i/n for text batches and puts synthesis last; a single batch is 1/1", () => {
  const { dir } = repos.largeChangeRepo({ files: 3, lines: 9000 });
  const s = session(dir);
  const total = s.first.batch.total;
  assert.ok(total >= 3);
  assert.deepEqual(batchPosition(s.review.snapshot, { ...s.first.state, active: ["synthesis"] }), { index: total, total });
  const allDone = { ...s.first.state, completed: s.review.snapshot.index.units.map((u) => u.id), active: [] };
  assert.equal(batchPosition(s.review.snapshot, allDone).index, total, "every text batch done: the next and last batch is synthesis");
});
