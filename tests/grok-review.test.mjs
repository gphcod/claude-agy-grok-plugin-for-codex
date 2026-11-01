// S4.4: finalizeReview and reviewPlan. The schema travels inline; the core validates, maps into A5.2, reconciles the
// ledger and publishes coverage (core/review.mjs finalizeReviewTurn).
import test from "node:test";
import assert from "node:assert/strict";
import grok from "../plugins/council/scripts/lib/providers/grok.mjs";
import { normalizeReview } from "../plugins/council/scripts/lib/core/review.mjs";
import { reviewProblem } from "../plugins/council/scripts/lib/core/review-validate.mjs";

test("finalizeReview prefers a valid structuredOutput, falls back to the complete answer text, and leaves an invalid answer to the core", () => {
  const good = { verdict: "approve", summary: "ok", findings: [], next_steps: [] };
  assert.deepEqual(grok.finalizeReview({ answerText: '{"verd', structured: good, unreviewed: [] }).structured, good);
  assert.deepEqual(grok.finalizeReview({ answerText: JSON.stringify(good), structured: null, unreviewed: [] }).structured, good);
  assert.deepEqual(grok.finalizeReview({ answerText: "```json\n" + JSON.stringify(good) + "\n```", structured: { verdict: "lgtm" }, unreviewed: [] }).structured, good);
  assert.deepEqual(grok.finalizeReview({ answerText: "no json", structured: { verdict: "lgtm" }, unreviewed: [] }).structured, { verdict: "lgtm" });
  assert.equal(grok.finalizeReview({ answerText: null, structured: null, unreviewed: [] }).structured, null);
  assert.deepEqual(grok.reviewPlan({ batches: [{ id: "u1" }] }, { adversarial: true }), { native: false, batches: [{ id: "u1" }], promptTemplate: "adversarial-review", schemaCarrier: "inline" });
  assert.deepEqual(grok.reviewPlan({ batch: { index: 1, total: 2 } }, {}).batches, undefined, "A5's member is `batches`; the core's `batch` position is not it");
});

test("the chosen answer maps into the A5.2 result through the core's validator and normalizer", () => {
  const finding = { id: "F1", severity: "high", title: "Off by one", body: "Skips item 0.", file: "sum.mjs", line_start: 2, line_end: 2, confidence: 0.9, recommendation: "Start at 0." };
  const { structured } = grok.finalizeReview({ answerText: null, structured: { verdict: "needs-attention", summary: "Defect.", findings: [finding], next_steps: [] }, unreviewed: [] });
  assert.equal(reviewProblem(structured), null);
  const out = normalizeReview(structured, { state: { completed: [], pending: 0 } });
  assert.deepEqual([out.verdict, out.findings.map((f) => [f.id, f.severity, f.file, f.line]), out.exit], ["changes", [["F1", "BLOCKER", "sum.mjs", 2]], 10]);
  assert.equal(reviewProblem(grok.finalizeReview({ answerText: "nope", structured: { verdict: "lgtm" }, unreviewed: [] }).structured), "review verdict must be approve or needs-attention");
});
