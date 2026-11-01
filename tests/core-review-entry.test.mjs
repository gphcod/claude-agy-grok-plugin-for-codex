// S2.5/S2.6 through the entry: review collection, the batch prompt, coverage and the ledger across `reply --next-input`,
// ported from grok_plugin_for_codex 1.1.0 and claude_plugin_for_codex 0.5.0 tests/review-batches.test.mjs onto the null adapter.
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { makeWorld, jobIdOf, footerOf, run } from "./helpers.mjs";

const finding = (extra = {}) => ({ id: "F1", severity: "high", title: "Off by one", body: "The loop skips item 0.", file: "part0.txt", line_start: 1, line_end: 1, confidence: 0.9, recommendation: "Start at 0.", ...extra });
const structured = (value) => ({ COUNCIL_FAKE_STRUCTURED: JSON.stringify(value) });
const clean = { verdict: "approve", summary: "Clean.", findings: [], next_steps: [] };
const review = (w, args = [], env = {}) => w.call(["review", "--to", "null", ...args, "--json"], { env });
const large = (w, files = 3) => { for (let i = 0; i < files; i++) fs.writeFileSync(path.join(w.workspace, `part${i}.txt`), "snapshot\n".repeat(18000)); };

test("a small review completes in one batch: no round token, the review template in the prompt, coverage complete", () => {
  const w = makeWorld();
  fs.writeFileSync(path.join(w.workspace, "README.md"), "# changed\n");
  const r = w.call(["review", "--to", "null"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stderr, /^\[council\] provider=null job=[a-z0-9]{16} thread=[0-9a-f-]{36} target=working tree \(staged, unstaged and untracked\)\n$/);
  assert.match(footerOf(r.stdout), /^council null ok · job [a-z0-9]{16} · null-model\/high · \d+s$/, "no round on a review, no batch token for a single batch");
  assert.match(r.stdout, /^Verdict: approve\./);
  const sent = w.fakeCalls().at(-1);
  assert.ok(sent.argv.includes("--schema"));
  assert.match(sent.prompt, /^Instructions for this turn \(structured code review, read-only\)/);
  assert.match(sent.prompt, /User focus: none given/);
  assert.match(sent.prompt, /<review_input>\nReview snapshot [0-9a-f]{64}; review reference [a-z0-9]{16}\./);
  assert.match(sent.prompt, /\+# changed/);
  const json = JSON.parse(review(w).stdout);
  assert.deepEqual([json.verdict, json.coverage.status, json.coverage.pending, json.exit], ["approve", "complete", 0, 0]);
});

test("--adversarial and a focus after -- select the adversarial template; an empty tree and a bad ref exit 2", () => {
  const w = makeWorld();
  assert.match(w.call(["review", "--to", "null"]).stderr, /nothing to review: no changes in the working tree/);
  fs.writeFileSync(path.join(w.workspace, "README.md"), "# changed\n");
  const r = w.call(["review", "--to", "null", "--adversarial", "--", "the", "cache"]);
  assert.equal(r.status, 0, r.stderr);
  const sent = w.fakeCalls().at(-1).prompt;
  assert.match(sent, /^Instructions for this turn \(adversarial code review, read-only\)/);
  assert.match(sent, /User focus: the cache\n/);
  assert.equal(w.call(["review", "--to", "null", "--base", "nope"]).status, 2);
  assert.equal(w.call(["review", "--to", "null", "--commit", "-p"]).status, 2);
});

test("--commit and --base select their targets through the entry; the label is the start line's target", () => {
  const w = makeWorld();
  run("git", ["checkout", "-q", "-b", "topic"], { cwd: w.workspace });
  fs.writeFileSync(path.join(w.workspace, "topic.txt"), "topic\n");
  run("git", ["add", "."], { cwd: w.workspace });
  run("git", ["commit", "-qm", "topic"], { cwd: w.workspace });
  const commit = w.call(["review", "--to", "null", "--commit", "HEAD"]);
  assert.equal(commit.status, 0, commit.stderr);
  assert.match(commit.stderr, /target=commit [0-9a-f]{12}\n/);
  assert.match(w.fakeCalls().at(-1).prompt, /\+topic/);
  const base = w.call(["review", "--to", "null", "--base", "main"]);
  assert.match(base.stderr, /target=branch against main \(merge base [0-9a-f]{12}\), with the working tree and untracked files\n/);
});

test("findings are attention (exit 10) with the severity map in the answer; invalid output is incomplete, also 10", () => {
  const w = makeWorld();
  fs.writeFileSync(path.join(w.workspace, "README.md"), "# changed\n");
  const flagged = w.call(["review", "--to", "null"], { env: structured({ verdict: "needs-attention", summary: "A defect.", findings: [finding()], next_steps: [] }) });
  assert.equal(flagged.status, 10);
  assert.match(flagged.stdout, /^Verdict: needs attention\. A defect\.\n\nF1 BLOCKER part0\.txt:1: Off by one/);
  assert.match(footerOf(flagged.stdout), /^council null needs attention · /);
  const json = JSON.parse(review(w, [], structured({ verdict: "needs-attention", summary: "A defect.", findings: [finding()], next_steps: [] })).stdout);
  assert.deepEqual([json.verdict, json.findings.map((f) => [f.id, f.severity])], ["needs-attention", [["F1", "BLOCKER"]]]);
  const sneaky = w.call(["review", "--to", "null"], { env: structured({ ...clean, findings: [finding({ severity: "low" })] }) });
  assert.equal(sneaky.status, 10, "an approval with findings is changes");
  const invalid = w.call(["review", "--to", "null"], { env: structured({ verdict: "lgtm" }) });
  assert.equal(invalid.status, 10, invalid.stdout + invalid.stderr);
  assert.match(invalid.stdout, /^Verdict: incomplete\.\nIncomplete: review verdict must be approve or needs-attention/);
  const missing = w.call(["review", "--to", "null"], { env: structured(null) });
  assert.equal(missing.status, 10);
  assert.match(missing.stdout, /Incomplete: missing structured review output/);
});

test("a large review is delivered in batches: batch i/n, --next-input to synthesis, no round spent, coverage complete, exit 0", () => {
  const w = makeWorld();
  large(w);
  const first = w.call(["review", "--to", "null", "--request-id", "big"]);
  assert.equal(first.status, 10, first.stdout + first.stderr);
  const job = jobIdOf(first.stderr);
  const [, , total] = /batch (\d+)\/(\d+)/.exec(footerOf(first.stdout));
  assert.match(footerOf(first.stdout), new RegExp(`batch 1/${total} · next: reply ${job} --next-input$`));
  const original = fs.readFileSync(path.join(w.home, "jobs", job, "review-input", "review.data"));
  for (let i = 0; i < 3; i++) fs.writeFileSync(path.join(w.workspace, `part${i}.txt`), "live workspace changed\n");
  const discussion = w.call(["reply", job, "--", "F1 AGREE"]);
  assert.equal(discussion.status, 10, "a discussion reply is a structured review turn (S2.8 F9): pending batches keep it in attention");
  assert.equal(JSON.parse(w.call(["wait", jobIdOf(discussion.stderr), "--json"]).stdout).coverage.reviewed, 1, "a discussion reply keeps coverage and earns none");
  let last = discussion, ref = jobIdOf(discussion.stderr), rounds = 0, sawSynthesis = false;
  while (rounds++ < 10) {
    last = w.call(["reply", ref, "--next-input"]);
    if (last.status === 2) break;
    ref = jobIdOf(last.stderr);
    const prompt = w.fakeCalls().at(-1).prompt;
    assert.doesNotMatch(prompt, /live workspace changed/);
    sawSynthesis ||= prompt.includes("Final synthesis:");
    assert.match(footerOf(last.stdout), new RegExp(`· round 2/9 · batch ${rounds + 1}/${total}`), "--next-input spends no round");
    if (last.status === 0) break;
  }
  assert.equal(last.status, 0, last.stdout + last.stderr);
  assert.ok(sawSynthesis);
  const json = JSON.parse(w.call(["wait", ref, "--json"]).stdout);
  assert.deepEqual([json.coverage.status, json.coverage.pending, json.coverage.reviewed], ["complete", 0, json.coverage.total]);
  assert.equal(w.call(["reply", ref, "--next-input"]).status, 2, "nothing left to send");
  assert.ok(fs.readFileSync(path.join(w.home, "jobs", job, "review-input", "review.data")).equals(original));
  assert.equal(jobIdOf(w.call(["review", "--to", "null", "--request-id", "big"]).stdout), job, "the review request replays");
});

test("an early blocking batch keeps the review in attention through a clean synthesis until its identified REJECT", () => {
  const w = makeWorld();
  large(w);
  const first = w.call(["review", "--to", "null"], { env: structured({ verdict: "needs-attention", summary: "Defect.", findings: [finding()], next_steps: [] }) });
  assert.equal(first.status, 10);
  let ref = jobIdOf(first.stderr), last = first;
  for (let i = 0; i < 10; i++) {
    const next = w.call(["reply", ref, "--next-input"]);
    if (next.status === 2) break;
    last = next;
    ref = jobIdOf(next.stderr);
  }
  const json = JSON.parse(w.call(["wait", ref, "--json"]).stdout);
  assert.deepEqual([json.coverage.status, json.coverage.blocking, last.status], ["complete", true, 10]);
  assert.match(last.stdout, /Earlier review responses reported blocking findings that remain open: u1-F1\./);
});

test("unsupported binary input stays partial after every batch and synthesis; --next-input on a non-review thread exits 2", () => {
  const w = makeWorld();
  large(w);
  fs.writeFileSync(path.join(w.workspace, "blob.bin"), Buffer.from([0, 1, 2]));
  const first = w.call(["review", "--to", "null"]);
  assert.match(footerOf(first.stdout), /unreviewed 1 · batch 1\//);
  let ref = jobIdOf(first.stderr), last = first;
  for (let i = 0; i < 10; i++) { const next = w.call(["reply", ref, "--next-input"]); if (next.status === 2) break; last = next; ref = jobIdOf(next.stderr); }
  assert.equal(last.status, 10);
  const json = JSON.parse(w.call(["wait", ref, "--json"]).stdout);
  assert.deepEqual([json.coverage.status, json.coverage.pending, json.coverage.unreviewed], ["partial", 0, ["blob.bin (untracked, binary)"]]);
  const plain = jobIdOf(w.call(["ask", "--to", "null", "--", "q"]).stderr);
  const bad = w.call(["reply", plain, "--next-input"]);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /--next-input requires a thread started by review/);
});

test("snapshot tampering stops a continuation before another submission", () => {
  const w = makeWorld();
  large(w);
  const first = w.call(["review", "--to", "null"]);
  const job = jobIdOf(first.stderr);
  fs.appendFileSync(path.join(w.home, "jobs", job, "review-input", "review.data"), "tampered");
  const calls = w.fakeCalls().length;
  const r = w.call(["reply", job, "--next-input"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /hash mismatch/);
  assert.equal(w.fakeCalls().length, calls);
});
