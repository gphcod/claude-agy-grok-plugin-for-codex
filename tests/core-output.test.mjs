// S2.2: the A3.4 start line, footer and --json grammar for every field combination; the 24 KiB cap; the answer scan.
// Ported in part from grok_plugin_for_codex tests/stream-bounds.test.mjs and execution-ownership.test.mjs (readAnswer).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { ANSWER_CAP, capAnswer, elapsed, footer, modelToken, readAnswer, recoveryHint, renderResult, resultJson, startLine, utf8Prefix } from "../plugins/council/scripts/lib/core/output.mjs";

const base = { id: "k3f9k3f9k3f9k3f9", dir: "/state/jobs/k3f9k3f9k3f9k3f9", provider: "grok", verb: "ask", outcome: "ok", code: 0, model: "grok-4.7", effort: "high",
  requestedEffort: "high", spawnedAt: "2026-10-31T10:00:00.000Z", endedAt: "2026-10-31T10:00:38.000Z", round: 1, rounds: 9, threadId: "t-1", admitted: true, edited: [] };

test("the start line names provider, job and thread, with the review target when there is one", () => {
  assert.equal(startLine(base), "[council] provider=grok job=k3f9k3f9k3f9k3f9 thread=t-1");
  assert.equal(startLine({ ...base, threadId: null, requestedThreadId: "req" }), "[council] provider=grok job=k3f9k3f9k3f9k3f9 thread=req");
  assert.equal(startLine({ ...base, threadId: null }), "[council] provider=grok job=k3f9k3f9k3f9k3f9 thread=?");
  assert.equal(startLine({ ...base, verb: "review", target: "working tree (staged,\nunstaged)" }), "[council] provider=grok job=k3f9k3f9k3f9k3f9 thread=t-1 target=working tree (staged, unstaged)");
});

test("the footer: status, job, model/effort with clamp, duration, and round only on threaded verbs", () => {
  assert.equal(footer(base, false), "council grok ok · job k3f9k3f9k3f9k3f9 · grok-4.7/high · 38s · round 1/9");
  assert.equal(footer({ ...base, requestedEffort: "max", effort: "xhigh" }, false), "council grok ok · job k3f9k3f9k3f9k3f9 · grok-4.7/xhigh<=max · 38s · round 1/9");
  assert.equal(modelToken({ model: "gemini-4-argon", effort: "high", requestedEffort: "xhigh" }), "gemini-4-argon/high<=xhigh");
  assert.equal(modelToken({ model: null, effort: "high" }), "default/high");
  assert.equal(footer({ ...base, outcome: "attention", code: 10 }, false), "council grok needs attention · job k3f9k3f9k3f9k3f9 · grok-4.7/high · 38s · round 1/9");
  assert.equal(footer({ ...base, verb: "review", outcome: "failed", code: 1, error: "x  y\nz" }, false), "council grok failed · job k3f9k3f9k3f9k3f9 · grok-4.7/high · 38s · error: x y z", "review has no round");
  assert.equal(footer({ ...base, outcome: "cancelled", code: 1 }, false), "council grok cancelled · job k3f9k3f9k3f9k3f9 · grok-4.7/high · 38s · round 1/9");
  assert.equal(footer({ ...base, provider: "claude", verb: "task", round: 1, rounds: 9, edited: ["a.js", "b.js"] }, false), "council claude ok · job k3f9k3f9k3f9k3f9 · grok-4.7/high · 38s · round 1/9 · edited 2");
  assert.equal(footer({ ...base, verb: "reply", round: 9, rounds: 9 }, false), "council grok ok · job k3f9k3f9k3f9k3f9 · grok-4.7/high · 38s · round 9/9");
  assert.equal(footer({ ...base, verb: "reply", rounds: undefined }, false), "council grok ok · job k3f9k3f9k3f9k3f9 · grok-4.7/high · 38s", "no budget, no round token");
});

test("the footer: unreviewed and batch only on reviews and --next-input replies; model unverified; full: file; hints", () => {
  const review = { ...base, verb: "review", outcome: "attention", code: 10, unreviewed: ["a (binary)", "b (binary)"], batch: { index: 1, total: 3 } };
  assert.equal(footer(review, false), "council grok needs attention · job k3f9k3f9k3f9k3f9 · grok-4.7/high · 38s · unreviewed 2 · batch 1/3");
  assert.equal(footer({ ...review, verb: "reply", nextInput: true }, false), "council grok needs attention · job k3f9k3f9k3f9k3f9 · grok-4.7/high · 38s · round 1/9 · unreviewed 2 · batch 1/3");
  assert.equal(footer({ ...base, unreviewed: ["x"], batch: { index: 1, total: 2 } }, false), "council grok ok · job k3f9k3f9k3f9k3f9 · grok-4.7/high · 38s · round 1/9", "an ask shows neither");
  assert.equal(footer({ ...base, modelVerified: false, model: "gpt-6.1-sol" }, false), "council grok ok · job k3f9k3f9k3f9k3f9 · gpt-6.1-sol/high · 38s · round 1/9 · model unverified");
  assert.equal(footer(base, true), "council grok ok · job k3f9k3f9k3f9k3f9 · grok-4.7/high · 38s · round 1/9 · full: /state/jobs/k3f9k3f9k3f9k3f9/answer.md");
  assert.equal(footer({ ...base, answerClipped: true }, false).endsWith("full: /state/jobs/k3f9k3f9k3f9k3f9/answer.md"), true);
  assert.equal(footer({ ...base, outcome: "failed", code: 1, cleanupPending: true, error: "lost" }, false),
    "council grok failed · job k3f9k3f9k3f9k3f9 · grok-4.7/high · 38s · round 1/9 · error: lost · cleanup pending; next: cancel k3f9k3f9k3f9k3f9; do not resume");
  assert.equal(recoveryHint({ ...base, claimHeld: true }), "cleanup pending; next: cancel k3f9k3f9k3f9k3f9; do not resume");
  assert.equal(recoveryHint({ ...base, threadLocked: true }), "thread locked; next: cancel k3f9k3f9k3f9k3f9 --confirm-ended after checking the process table; do not resume");
  assert.equal(recoveryHint({ ...base, outcome: "failed", threadId: null, requestedThreadId: "r" }), "thread not confirmed; start a new ask");
  assert.equal(recoveryHint({ ...base, reviewState: { pending: 2 } }), "next: reply k3f9k3f9k3f9k3f9 --next-input");
  assert.equal(recoveryHint(base), null);
  assert.equal(recoveryHint({ ...base, mutationCoverage: "unknown" }), "coverage unknown", "an unverified workspace check is named in the footer");
  assert.equal(recoveryHint({ ...base, mutationCoverage: "complete" }), null);
  assert.equal(recoveryHint({ ...base, mutationCoverage: "unknown", claimHeld: true }), "cleanup pending; next: cancel k3f9k3f9k3f9k3f9; do not resume", "a recovery step outranks the coverage note");
  assert.match(footer({ ...base, mutationCoverage: "unknown" }), / · coverage unknown$/);
  const everything = footer({ ...base, provider: "gemini", verb: "reply", nextInput: true, outcome: "attention", requestedEffort: "xhigh", effort: "high", model: "gemini-4-argon",
    unreviewed: ["u"], batch: { index: 2, total: 2 }, modelVerified: false, answerClipped: true, error: "e", cleanupPending: true }, false);
  assert.equal(everything, "council gemini needs attention · job k3f9k3f9k3f9k3f9 · gemini-4-argon/high<=xhigh · 38s · round 1/9 · unreviewed 1 · batch 2/2 · model unverified · full: /state/jobs/k3f9k3f9k3f9k3f9/answer.md · error: e · cleanup pending; next: cancel k3f9k3f9k3f9k3f9; do not resume");
});

test("renderResult prints the answer then the footer; an empty answer prints the footer alone", () => {
  assert.equal(renderResult(base, "pong\n\n"), "pong\ncouncil grok ok · job k3f9k3f9k3f9k3f9 · grok-4.7/high · 38s · round 1/9\n");
  assert.equal(renderResult(base, ""), "council grok ok · job k3f9k3f9k3f9k3f9 · grok-4.7/high · 38s · round 1/9\n");
});

test("the --json object carries every A3.4 field and bounds its lists", () => {
  const json = resultJson({ ...base, session: "codex-1", tier: "consult", cost: 0.0123, verdict: "approve", findings: [{ id: "F1" }], failedCommands: ["make"],
    reviewState: { reviewRef: "r", snapshotId: "s", status: "partial", total: 4, pending: 2, completed: ["u1"], unsupportedCount: 1, synthesisPending: true, blocking: false },
    unreviewed: ["a", "b"], batch: { index: 1, total: 2 }, edited: Array.from({ length: 100 }, (_, i) => `f${i}.js`) }, "answer");
  assert.deepEqual(Object.keys(json), ["provider", "job", "thread", "requestedThread", "session", "status", "exit", "verb", "tier", "model", "modelVerified", "effort", "requestedEffort",
    "round", "rounds", "verdict", "findings", "coverage", "batch", "edited", "editedCount", "failedCommands", "failedCommandCount", "costUsd", "elapsedMs", "error", "attention", "cleanupPending",
    "threadLocked", "answer", "clipped", "answerFile"]);
  assert.deepEqual([json.provider, json.job, json.thread, json.session, json.model, json.modelVerified, json.effort, json.requestedEffort, json.tier, json.round, json.rounds, json.verdict, json.exit, json.costUsd],
    ["grok", "k3f9k3f9k3f9k3f9", "t-1", "codex-1", "grok-4.7", true, "high", "high", "consult", 1, 9, "approve", 0, 0.0123]);
  assert.deepEqual(json.coverage, { reviewRef: "r", snapshotId: "s", status: "partial", total: 4, pending: 2, reviewed: 1, unreviewed: ["a", "b"], unsupportedCount: 1, synthesisPending: true, blocking: false });
  assert.deepEqual([json.edited.length, json.editedCount, json.failedCommands, json.failedCommandCount, json.batch], [10, 100, ["make"], 1, { index: 1, total: 2 }]);
  assert.equal(json.answerFile, "/state/jobs/k3f9k3f9k3f9k3f9/answer.md");
  assert.equal(resultJson({ ...base, modelVerified: false, model: "gpt-6.1-sol" }, "").modelVerified, false);
  assert.equal(resultJson({ ...base, model: null }, "").model, "default");
  assert.equal(resultJson(base, "").coverage, null);
});

test("answer clipping preserves real U+FFFD and never splits multibyte characters", () => {
  assert.equal(ANSWER_CAP, 24 * 1024);
  for (const char of ["日", "😀", "�"]) {
    for (let offset = 0; offset < 4; offset++) {
      const text = "a".repeat(ANSWER_CAP - offset) + char.repeat(5);
      const clipped = capAnswer(text);
      assert.ok(Buffer.byteLength(clipped.text) <= ANSWER_CAP);
      assert.ok(text.startsWith(clipped.text)); assert.ok(clipped.clipped);
    }
  }
  assert.equal(utf8Prefix("abc", 10), "abc");
  assert.deepEqual(capAnswer("short"), { text: "short", clipped: false });
  assert.deepEqual([elapsed(5000), elapsed(65000), elapsed(3725000), elapsed(-5)], ["5s", "1m05s", "1h02m", "0s"]);
});

test("JSON and text bound ancillary details and never suggest resuming pending cleanup", () => {
  const job = { ...base, verb: "task", outcome: "failed", code: 1, cleanupPending: true, edited: Array.from({ length: 100 }, () => "日".repeat(1000)), error: "x".repeat(5000) };
  const f = footer(job, false);
  assert.match(f, /cleanup pending; next: cancel k3f9k3f9k3f9k3f9; do not resume/);
  assert.doesNotMatch(f, /next: reply/);
  assert.ok(Buffer.byteLength(f) < 4000);
  const json = resultJson(job, "😀".repeat(10000));
  assert.equal(json.edited.length, 10); assert.equal(json.editedCount, 100);
  assert.ok(Buffer.byteLength(JSON.stringify(json)) < ANSWER_CAP + 5000);
  const review = { ...job, verb: "review", cleanupPending: false, unreviewed: Array.from({ length: 100 }, () => "u".repeat(1000)) };
  assert.match(footer(review, false), /unreviewed 100/);
  assert.equal(resultJson(review, "").coverage, null);
});

test("the answer scan sees content and questions beyond the preview without unbounded accumulation", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "council-answer-"));
  const file = path.join(dir, "answer.md");
  fs.writeFileSync(file, "x\n".repeat(30000) + "**Open questions:**\n- Which?\nNext: none\n");
  const read = readAnswer(file);
  assert.equal(read.questions, true); assert.equal(read.nonempty, true);
  assert.ok(Buffer.byteLength(read.answer) <= ANSWER_CAP); assert.ok(read.answerClipped);
  fs.writeFileSync(file, " ".repeat(2048));
  assert.equal(readAnswer(file).nonempty, false);
  fs.writeFileSync(file, "Done.\nOpen questions: none\nNext: ship\n");
  assert.deepEqual([readAnswer(file).questions, readAnswer(file).answerClipped], [false, false]);
  const text = "😀\n".repeat(20000) + "Open questions: None.\nNext: none\n";
  fs.writeFileSync(file, text);
  const r = readAnswer(file);
  assert.ok(r.answerClipped); assert.ok(text.startsWith(r.answer)); assert.equal(r.questions, false);
  fs.writeFileSync(file, "x".repeat(1024 * 1024 + 1));
  assert.throws(() => readAnswer(file), /exceeds 1 MiB/);
});
