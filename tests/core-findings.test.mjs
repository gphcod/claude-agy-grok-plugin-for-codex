// S2.5: the identified findings ledger, ported from claude_plugin_for_codex 0.5.0 lib/review-findings.mjs behaviour
// (exercised there through tests/review-batches.test.mjs) with the A5.2 shape: critical/high block, file:line_start matches.
import test from "node:test";
import assert from "node:assert/strict";
import { SEVERITY_RANK, location, priorFindingsNote, reconcileFindings, summarizeFindings } from "../plugins/council/scripts/lib/core/findings.mjs";

const finding = (extra = {}) => ({ id: "F1", severity: "high", title: "Off by one", body: "B", file: "a.js", line_start: 3, line_end: 4, confidence: 0.9, recommendation: "fix", ...extra });
const output = (findings) => ({ verdict: findings.length ? "needs-attention" : "approve", summary: "s", findings, next_steps: [] });

test("severity map and location: critical and high are blockers, matched by file:line_start", () => {
  assert.deepEqual(SEVERITY_RANK, { critical: "BLOCKER", high: "BLOCKER", medium: "MAJOR", low: "MINOR" });
  assert.equal(location(finding()), "a.js:3");
});

test("a single-batch review keeps the model's ids; blocking follows open critical/high findings", () => {
  const state = { active: ["u1"], synthesisRequired: false, findingsLedger: [] };
  const r = reconcileFindings(state, output([finding(), finding({ id: "F2", severity: "medium", line_start: 9 })]), "job");
  assert.deepEqual(r.output.findings.map((f) => f.id), ["F1", "F2"]);
  assert.deepEqual(r.state.findingsLedger.map((i) => [i.id, i.location, i.severity, i.decision]), [["F1", "a.js:3", "high", "AGREE"], ["F2", "a.js:9", "medium", "AGREE"]]);
  assert.equal(r.state.blocking, true);
  assert.equal(r.reportedBlocking, true);
  const minor = reconcileFindings(state, output([finding({ severity: "low" })]), "job");
  assert.deepEqual([minor.state.blocking, minor.reportedBlocking], [false, false], "medium and low never block");
  const critical = reconcileFindings(state, output([finding({ severity: "critical" })]), "job");
  assert.equal(critical.state.blocking, true);
});

test("batched reviews scope new ids to the batch, and synthesis findings to the synthesis pass", () => {
  const b1 = reconcileFindings({ active: ["u1", "u2"], synthesisRequired: true, findingsLedger: [] }, output([finding()]), "job");
  assert.deepEqual(b1.output.findings.map((f) => f.id), ["u1-F1"]);
  const b2 = reconcileFindings({ ...b1.state, active: ["u3"] }, output([finding({ file: "b.js" })]), "job");
  assert.deepEqual(b2.output.findings.map((f) => f.id), ["u3-F1"], "the same short id in another batch is another finding");
  const pre = reconcileFindings({ ...b2.state, active: ["u4"] }, output([finding({ id: "u4-F2", severity: "low" })]), "job");
  assert.deepEqual(pre.output.findings.map((f) => f.id), ["u4-F2"], "an id already carrying the batch prefix is kept");
  const synth = reconcileFindings({ ...pre.state, active: ["synthesis"] }, output([finding({ id: "F9", severity: "low", file: "c.js" })]), "job");
  assert.deepEqual(synth.output.findings.map((f) => f.id), ["synthesis-F9"]);
  assert.deepEqual(synth.state.findingsLedger.map((i) => i.id), ["u1-F1", "u3-F1", "u4-F2", "synthesis-F9"], "unmentioned findings stay in the ledger");
  assert.equal(synth.state.blocking, true, "an earlier blocker keeps the aggregate blocking after a clean or minor synthesis");
});

test("an identified decision resolves only that finding; an unknown short id resolves by unique suffix and location", () => {
  const b1 = reconcileFindings({ active: ["u1"], synthesisRequired: true, findingsLedger: [] }, output([finding(), finding({ id: "F2", line_start: 20 })]), "job");
  const reject = reconcileFindings({ ...b1.state, active: [] }, output([finding({ id: "u1-F1", decision: "REJECT" })]), "job");
  assert.deepEqual(reject.output.findings.map((f) => f.id), ["u1-F1"]);
  assert.equal(reject.state.findingsLedger.find((i) => i.id === "u1-F1").decision, "REJECT");
  assert.equal(reject.state.blocking, true, "u1-F2 is still open");
  const both = reconcileFindings({ ...reject.state, active: [] }, output([finding({ id: "F2", line_start: 20, decision: "REJECT" })]), "job");
  assert.deepEqual(both.output.findings.map((f) => f.id), ["u1-F2"], "the short id matched the one ledger entry ending in -F2 at a.js:20");
  assert.equal(both.state.blocking, false);
  const elsewhere = reconcileFindings({ ...b1.state, active: [] }, output([finding({ id: "F2", line_start: 99, decision: "REJECT" })]), "job7");
  assert.deepEqual(elsewhere.output.findings.map((f) => f.id), ["discussion-job7-F2"], "no match at that location: a new discussion finding");
  assert.equal(elsewhere.state.findingsLedger.find((i) => i.id === "u1-F2").decision, "AGREE", "the unmatched decision resolves nothing");
  const change = reconcileFindings({ ...b1.state, active: [] }, output([finding({ id: "u1-F1", decision: "CHANGE", severity: "low" })]), "job");
  assert.equal(change.state.findingsLedger.find((i) => i.id === "u1-F1").severity, "low", "CHANGE updates the finding");
  assert.equal(change.state.blocking, true, "u1-F2 still blocks");
});

test("summaries and the prior-findings note name ids, severities, locations and decisions", () => {
  const ledger = [{ id: "u1-F1", location: "a.js:3", severity: "high", decision: "AGREE", title: "Off by one" }, { id: "u2-F1", location: "b.js:1", severity: "low", decision: "REJECT", title: "Nit" }];
  assert.deepEqual(summarizeFindings(ledger), { open: 1, blocking: 1, rejected: 1, ids: ["u1-F1"] });
  assert.deepEqual(summarizeFindings([]), { open: 0, blocking: 0, rejected: 0, ids: [] });
  assert.equal(priorFindingsNote([]), "");
  const note = priorFindingsNote(ledger);
  assert.match(note, /^Earlier batches reported these findings; keep their ids/);
  assert.match(note, /\n- u1-F1 BLOCKER a\.js:3 AGREE: Off by one\n- u2-F1 MINOR b\.js:1 REJECT: Nit$/);
});
