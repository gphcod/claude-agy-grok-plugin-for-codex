import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { reviewProblem, DECISIONS } from "../plugins/council/scripts/lib/core/review-validate.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const schema = JSON.parse(fs.readFileSync(path.join(ROOT, "plugins", "council", "schemas", "review-output.schema.json"), "utf8"));
const { $comment, ...reference } = JSON.parse(fs.readFileSync(path.join(ROOT, "tests", "fixtures", "review-output.reference.json"), "utf8"));

const finding = (extra = {}) => ({ id: "F1", severity: "high", title: "Off by one", body: "The loop stops early.", file: "src/a.mjs",
  line_start: 10, line_end: 12, confidence: 0.9, recommendation: "Use <=.", ...extra });
const output = (extra = {}) => ({ verdict: "needs-attention", summary: "One defect.", findings: [finding()], next_steps: ["Fix the loop."], ...extra });

test("the repository schema is the committed reference, in draft-07, with provenance on the fixture only", () => {
  assert.deepEqual(schema, reference);
  assert.equal(schema.$schema, "http://json-schema.org/draft-07/schema#");
  assert.match($comment, /148bc55/);
  assert.match($comment, /be9fe54/);
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.findings.items.additionalProperties, false);
  assert.ok(schema.properties.findings.items.required.includes("id"));
  assert.ok(!schema.properties.findings.items.required.includes("decision"));
  assert.deepEqual(schema.properties.findings.items.properties.decision.enum, DECISIONS);
});

test("the validator accepts a clean approval and a finding with each decision", () => {
  assert.equal(reviewProblem({ verdict: "approve", summary: "Fine.", findings: [], next_steps: [] }), null);
  for (const decision of DECISIONS) assert.equal(reviewProblem(output({ findings: [finding({ decision })] })), null, decision);
  assert.equal(reviewProblem(output()), null);
});

test("the validator rejects a missing id, an unknown severity, an out-of-range confidence and an extra property", () => {
  const { id, ...noId } = finding();
  assert.match(reviewProblem(output({ findings: [noId] })), /needs an id/);
  assert.match(reviewProblem(output({ findings: [finding({ severity: "BLOCKER" })] })), /unknown severity/);
  assert.match(reviewProblem(output({ findings: [finding({ confidence: 1.5 })] })), /confidence must be 0 to 1/);
  assert.match(reviewProblem(output({ findings: [finding({ confidence: -0.1 })] })), /confidence must be 0 to 1/);
  assert.match(reviewProblem(output({ findings: [finding({ evidence: "verified" })] })), /unknown property evidence/);
  assert.match(reviewProblem(output({ coverage: "all" })), /unknown property coverage/);
  assert.match(reviewProblem(output({ findings: [finding({ decision: "MAYBE" })] })), /decision must be/);
  assert.match(reviewProblem(output({ findings: [finding(), finding()] })), /repeats id F1/);
  assert.match(reviewProblem(output({ verdict: "changes" })), /verdict/);
  assert.match(reviewProblem(output({ findings: [finding({ line_end: 9 })] })), /invalid line range/);
  assert.match(reviewProblem(null), /missing structured review output/);
  assert.match(reviewProblem(output({ next_steps: [""] })), /next_steps/);
});
