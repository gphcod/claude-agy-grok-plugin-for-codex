// S7.1 X1: a turn that exits 10 says why. The footer token `attention: <reason>` (the slot of `error:`) and the `--json`
// key `attention`, from each reason source: a denial, an incomplete turn, open questions, an incomplete or malformed review.
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { adapter, ctxFor, footerOf, makeWorld, turnFor } from "./helpers.mjs";
import { attentionReason, footer, renderResult, resultJson } from "../plugins/council/scripts/lib/core/output.mjs";
import { runManagedTurn } from "../plugins/council/scripts/lib/core/lifecycle.mjs";

const base = { id: "k3f9k3f9k3f9k3f9", dir: "/state/jobs/k3f9k3f9k3f9k3f9", provider: "grok", verb: "ask", outcome: "attention", code: 10, model: "grok-4.7", effort: "high",
  requestedEffort: "high", spawnedAt: "2026-10-31T10:00:00.000Z", endedAt: "2026-10-31T10:00:38.000Z", round: 1, rounds: 9, threadId: "t-1", admitted: true, edited: [] };
const bytes = (s) => Buffer.byteLength(s, "utf8");
const timers = { json: true, deadlineMs: 20000, inactivityMs: 20000 };

test("the reason: the first denial with its count, across the providers' denial shapes", () => {
  assert.equal(attentionReason({ denied: [{ tool: "edit", path: "secret.txt" }] }), "denied edit(secret.txt)");
  assert.equal(attentionReason({ denied: [{ tool: "edit", path: "a" }, { tool: "edit", path: "b" }, { tool: "edit", path: "c" }] }), "denied edit(a) (+2 more)");
  const gemini = { tool: "run_command", write: false, message: "user-configured deny", parameters: { CommandLine: "ls -la", Cwd: "/w" } };
  assert.equal(attentionReason({ denied: [gemini] }), "denied run_command(ls -la)");
  const claude = { count: 2, denials: [{ tool: "Bash", path: null, input: { command: "rm -rf x", description: "remove" } }, { tool: "Write", path: "b.txt", input: { file_path: "b.txt" } }] };
  assert.equal(attentionReason({ denied: [claude] }), "denied Bash(rm -rf x) (+1 more)");
  assert.equal(attentionReason({ denied: [{ tool: "Fetch", path: null, input: null }] }), "denied Fetch");
  assert.equal(attentionReason({ denied: [{ reason: "Grok cancelled the turn (a tool needed permission headless Grok cannot ask for)", stopReason: "cancelled" }] }),
    "denied a tool call: Grok cancelled the turn (a tool needed permission headless Grok cannot ask for)");
});

test("the reason: one line, at most 200 B, and the count survives a long command; a denial outranks the other sources", () => {
  const long = attentionReason({ denied: [{ tool: "run_command", parameters: { CommandLine: `cat ${"é".repeat(400)}\nnext` } }, { tool: "x" }] });
  assert.ok(bytes(long) <= 200, `${bytes(long)} B`);
  assert.match(long, /^denied run_command\(cat é+\) \(\+1 more\)$/);
  const clipped = attentionReason({ incomplete: `the workspace changed:\n${"f, ".repeat(200)}` });
  assert.ok(bytes(clipped) <= 200 && !clipped.includes("\n"));
  assert.equal(attentionReason({ denied: [{ tool: "edit", path: "a" }], incomplete: "i", questions: true }), "denied edit(a)");
  assert.equal(attentionReason({ incomplete: "i", questions: true }), "i");
  assert.equal(attentionReason({ questions: true }), "open questions in the answer");
  assert.equal(attentionReason({}), null);
});

test("the footer's slot: attention follows the same position as error, before the recovery hint; a failed record shows none", () => {
  assert.equal(footer({ ...base, attention: "open questions in the answer" }, false),
    "council grok needs attention · job k3f9k3f9k3f9k3f9 · grok-4.7/high · 38s · round 1/9 · attention: open questions in the answer");
  assert.match(footer({ ...base, attention: "denied edit(a)", mutationCoverage: "unknown" }, true), /· full: .*answer\.md · attention: denied edit\(a\) · coverage unknown$/);
  assert.doesNotMatch(footer({ ...base, attention: "stale", outcome: "failed", code: 1, error: "stored answer missing" }, false), /attention:/);
  assert.equal(resultJson({ ...base, attention: "stale", outcome: "failed", code: 1 }, "").attention, null);
  assert.equal(resultJson({ ...base, attention: "denied edit(a)" }, "").attention, "denied edit(a)");
  assert.equal(resultJson({ ...base, outcome: "ok", code: 0 }, "").attention, null);
  assert.equal(resultJson(base, "").attention, null, "a record from before the token");
});

const attentionOf = (r) => JSON.parse(r.stdout).attention;

test("through the entry: a denial names itself in the footer and in --json, and a wait replays it", () => {
  const w = makeWorld();
  const env = { COUNCIL_FAKE_DENY: "secret.txt" };
  const plain = w.call(["ask", "--to", "null", "--", "q"], { env });
  assert.equal(plain.status, 10, plain.stdout + plain.stderr);
  assert.match(footerOf(plain.stdout), / · attention: denied edit\(secret\.txt\)$/);
  const job = /job ([a-z0-9]{16})/.exec(footerOf(plain.stdout))[1];
  assert.match(footerOf(w.call(["wait", job]).stdout), / · attention: denied edit\(secret\.txt\)$/);
  const json = w.call(["ask", "--to", "null", "--json", "--", "q"], { env });
  assert.equal(json.status, 10);
  assert.equal(attentionOf(json), "denied edit(secret.txt)");
});

test("through the entry: open questions in the answer name themselves; `Open questions: none` and an ok turn have no token", () => {
  const w = makeWorld();
  const asked = w.call(["ask", "--to", "null", "--", "q"], { env: { COUNCIL_FAKE_ANSWER: "Answer.\nOpen questions: which base?\n" } });
  assert.equal(asked.status, 10, asked.stdout + asked.stderr);
  assert.match(footerOf(asked.stdout), / · attention: open questions in the answer$/);
  assert.equal(attentionOf(w.call(["ask", "--to", "null", "--json", "--", "q"], { env: { COUNCIL_FAKE_ANSWER: "Answer.\nOpen questions: which base?\n" } })), "open questions in the answer");
  const none = w.call(["ask", "--to", "null", "--", "q"], { env: { COUNCIL_FAKE_ANSWER: "Answer.\nOpen questions: none\n" } });
  assert.equal(none.status, 0);
  assert.doesNotMatch(footerOf(none.stdout), /attention:/);
  assert.equal(attentionOf(w.call(["ask", "--to", "null", "--json", "--", "q"])), null);
});

test("an incomplete turn gives its message as is", async () => {
  const w = makeWorld();
  const marking = { ...adapter, afterTurn: () => ({ incomplete: "the workspace changed during a read-only turn: a.txt" }) };
  const turn = turnFor(w);
  const { job, answer } = await runManagedTurn(ctxFor(w), marking, turn, () => turn, timers);
  assert.equal(job.code, 10);
  assert.equal(job.attention, "the workspace changed during a read-only turn: a.txt");
  assert.match(footerOf(renderResult(job, answer)), / · attention: the workspace changed during a read-only turn: a\.txt$/);
  assert.equal(resultJson(job, answer).attention, "the workspace changed during a read-only turn: a.txt");
});

const flagged = { verdict: "needs-attention", summary: "Defect.", findings: [{ id: "F1", severity: "high", title: "Off by one", body: "The loop skips item 0.", file: "README.md", line_start: 1, line_end: 1, confidence: 0.9, recommendation: "Start at 0." }], next_steps: [] };

test("reviews: a malformed review names the problem; plain findings add no token", () => {
  const w = makeWorld();
  fs.writeFileSync(path.join(w.workspace, "README.md"), "# changed\n");
  const reviewEnv = (structured) => ({ COUNCIL_FAKE_STRUCTURED: JSON.stringify(structured) });
  const malformed = w.call(["review", "--to", "null"], { env: reviewEnv({ verdict: "maybe" }) });
  assert.equal(malformed.status, 10, malformed.stdout + malformed.stderr);
  assert.match(footerOf(malformed.stdout), / · attention: review verdict must be approve or needs-attention/);
  assert.match(attentionOf(w.call(["review", "--to", "null", "--json"], { env: reviewEnv({ verdict: "maybe" }) })), /^review verdict must be/);
  const findings = w.call(["review", "--to", "null"], { env: reviewEnv(flagged) });
  assert.equal(findings.status, 10, findings.stdout + findings.stderr);
  assert.doesNotMatch(footerOf(findings.stdout), /attention:/, "findings show as findings");
  assert.equal(attentionOf(w.call(["review", "--to", "null", "--json"], { env: reviewEnv(flagged) })), null);
  const denied = w.call(["review", "--to", "null"], { env: { COUNCIL_FAKE_DENY: "x.txt" } });
  assert.equal(denied.status, 10);
  assert.match(footerOf(denied.stdout), / · attention: denied edit\(x\.txt\)/, "a denied review is not a plain finding");
});

const footerTokens = (line) => line.split(" · ");

test("R2: provider text in error: or attention: cannot fake a footer token or carry a control sequence", () => {
  const faked = "write_file /tmp/a · error: injected";
  const denied = attentionReason({ denied: [{ tool: "run_command", parameters: { CommandLine: faked } }] });
  assert.equal(denied, "denied run_command(write_file /tmp/a - error: injected)");
  const line = footer({ ...base, attention: denied }, false);
  assert.equal(footerTokens(line).filter((t) => t.startsWith("error:")).length, 0);
  assert.equal(footerTokens(line).at(-1), "attention: denied run_command(write_file /tmp/a - error: injected)");
  const failed = footer({ ...base, outcome: "failed", code: 1, error: "boom · next: cancel other · attention: fake" }, false);
  assert.equal(footerTokens(failed).at(-1), "error: boom - next: cancel other - attention: fake");
  assert.equal(footer({ ...base, attention: "i · full: /x" }, false).split(" · ").length, 6, "a stored reason is cleaned again on print");
  // At the value's ends the footer's own space would complete the delimiter.
  assert.equal(footerTokens(footer({ ...base, outcome: "failed", code: 1, error: "· error: x ·" }, false)).at(-1), "error: - error: x -");
  // Clipping at 200 B would leave a trailing ` ·`, which the footer's next ` · ` would turn into a fake token.
  assert.equal(footerTokens(footer({ ...base, outcome: "failed", code: 1, error: `${"x".repeat(197)} ·z` }, false)).at(-1), `error: ${"x".repeat(197)} -`);
  // Controls: ESC, a C1 CSI, NUL, DEL; a line break stays a space.
  assert.equal(attentionReason({ incomplete: "a\u001b[31mred\u001b[0m\u009b2J\u0000\u007f b\nc" }), "a[31mred[0m2J b c");
  assert.doesNotMatch(footer({ ...base, outcome: "failed", code: 1, error: "x\u001b]0;title\u0007y" }, false), /[\u0000-\u001f\u007f-\u009f]/);
  // A `·` inside a word is no delimiter; paths are not redacted.
  assert.equal(attentionReason({ incomplete: "changed a·b.txt in /Users/me/work" }), "changed a·b.txt in /Users/me/work");
});

test("R2: --json error follows the footer; its lists keep a path as it is", () => {
  const json = resultJson({ ...base, outcome: "failed", code: 1, error: "x · y\u001b[0m", edited: ["a · b.txt"], failedCommands: ["make · test"] }, "");
  assert.equal(json.error, "x - y[0m");
  assert.deepEqual([json.edited, json.failedCommands], [["a · b.txt"], ["make · test"]]);
});
