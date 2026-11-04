// S3.4: the Claude adapter through the entry against fake-claude (which exits 99 on any launch-contract mismatch):
// every verb, the flag set on every ask/review/task/reply transition, --web, batched reviews with the findings ledger,
// the terminal failure scenarios, denials, edits, the observed model, ownership, preflight and probe counts.
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { makeWorld, jobIdOf, footerOf, until, alive, ROOT, PLUGIN_ROOT } from "./helpers.mjs";
import adapter from "../plugins/council/scripts/lib/providers/claude.mjs";
import { ownedExecution, processSnapshot } from "../plugins/council/scripts/lib/core/execution.mjs";

const FAKE = path.join(ROOT, "tests", "fixtures", "fake-claude.mjs");
const CONTRACT = path.join(PLUGIN_ROOT, "contract.md");
const template = (name) => fs.readFileSync(path.join(PLUGIN_ROOT, "prompts", `${name}.md`), "utf8").trim();
const READ = ["Read", "Glob", "Grep"], TASK = ["Read", "Glob", "Grep", "Edit", "Write", "MultiEdit", "NotebookEdit", "Bash"];
const DISALLOWED = ["Bash(git push*)", "Bash(git reset --hard*)", "Bash(rm -rf *)", "Bash(sudo *)"];

/** A world whose claude is the fake; the proxy variable keeps the network check offline (proxy transport is reported unverified). */
function world() {
  const w = makeWorld();
  Object.assign(w.env, { COUNCIL_CLAUDE_BIN: FAKE, HTTPS_PROXY: "http://127.0.0.1:9" });
  const call = w.call;
  w.launches = () => w.fakeCalls().filter((c) => !c.probe); // fakeCalls() also lists the cold probes
  w.claude = (args, scenario = "ok", opts = {}) => call(args, { ...opts, env: { COUNCIL_FAKE_SCENARIO: scenario, ...(opts.env ?? {}) } });
  return w;
}
const value = (argv, flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined);
const variadic = (argv, flag) => { const i = argv.indexOf(flag); if (i < 0) return []; const out = []; for (let j = i + 1; j < argv.length && !argv[j].startsWith("-"); j += 1) out.push(...argv[j].split(",")); return out; };
/** The effective flag set of one launch, as the fake logged it. */
const flags = (call) => ({ mode: value(call.argv, "--permission-mode"), tools: value(call.argv, "--tools").split(","), allowed: variadic(call.argv, "--allowedTools"),
  disallowed: variadic(call.argv, "--disallowedTools"), contract: value(call.argv, "--append-system-prompt-file"), snapshot: value(call.argv, "--system-prompt-snapshot"),
  schema: call.argv.includes("--json-schema"), resume: value(call.argv, "--resume") ?? null, session: value(call.argv, "--session-id") ?? null, maxTurns: value(call.argv, "--max-turns"),
  model: value(call.argv, "--model") ?? null, mcpOff: value(call.argv, "--mcp-config") === '{"mcpServers":{}}', hooksOff: value(call.argv, "--settings") === '{"disableAllHooks":true}' });
const json = (r) => JSON.parse(r.stdout);
const READ_ONLY = { mode: "dontAsk", tools: READ, allowed: [], disallowed: [], contract: CONTRACT, snapshot: "on", mcpOff: true, hooksOff: true };
const TASK_SET = { mode: "acceptEdits", tools: TASK, allowed: ["Edit", "Write", "MultiEdit", "NotebookEdit", "Bash"], disallowed: DISALLOWED, contract: CONTRACT, snapshot: "on", mcpOff: true, hooksOff: true };
const subset = (actual, expected) => Object.fromEntries(Object.keys(expected).map((k) => [k, actual[k]]));

test("ask: the explicit Opus 5.5 default, CLI-default override, cold then warm probes", () => {
  const w = world();
  const r = w.claude(["ask", "--to", "claude", "--effort", "low", "--", "Reply with pong"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.stdout.split("\n")[0], "pong");
  assert.match(footerOf(r.stdout), /^council claude ok · job [a-z0-9]{16} · claude-opus-5-5\/low · \d+s · round 1\/9$/);
  assert.match(r.stderr, /^\[council\] provider=claude job=[a-z0-9]{16}$/m);
  assert.deepEqual(w.probes().map((p) => p.probe), ["version", "auth", "help", "capability"], "cold: CLAUDEX's four probes");
  const [call] = w.launches();
  assert.deepEqual(subset(flags(call), READ_ONLY), READ_ONLY);
  assert.deepEqual([flags(call).model, flags(call).maxTurns, flags(call).resume], ["claude-opus-5-5", "20", null], "the default pins Opus 5.5; ask gets 20 turns");
  assert.ok(call.prompt.startsWith(`${template("advice")}\n\nReply with pong`), "the advice template travels in the input");
  for (const name of ["COUNCIL_DEPTH", "CLAUDE_PLUGIN_CODEX_DEPTH", "GROK_CODEX_DEPTH", "GROK_BUILD_DEPTH", "AGY_BRIDGE_DEPTH"]) assert.equal(call.env[name], "1");
  const job = json(w.call(["wait", jobIdOf(r.stderr), "--json"]));
  assert.deepEqual([job.model, job.modelVerified, job.effort, job.thread, job.costUsd], ["claude-opus-5-5", true, "low", flags(call).session, 0.0272304]);
  const warm = w.claude(["ask", "--to", "claude", "--model", "default", "--", "again"]);
  assert.equal(warm.status, 0, warm.stderr);
  assert.equal(w.probes().length, 4, "warm: zero probes");
  assert.equal(flags(w.launches()[1]).model, null, "--model default omits the flag");
  assert.match(footerOf(warm.stdout), / · claude-opus-5-5\/high · /, "consult tier effort, observed model");
});

test("models: an explicit alias is passed through; an unknown id is unverified, and the CLI's is_error answer fails the turn", () => {
  const w = world();
  const sonnet = w.claude(["ask", "--to", "claude", "--model", "sonnet", "--", "q"]);
  assert.equal(sonnet.status, 0, sonnet.stderr);
  assert.equal(flags(w.launches()[0]).model, "sonnet");
  assert.match(footerOf(sonnet.stdout), / · sonnet\/high · /, "an explicit model is printed as requested");
  const passthrough = w.claude(["ask", "--to", "claude", "--model", "claude-opus-9", "--", "q"]);
  assert.equal(passthrough.status, 0);
  assert.match(footerOf(passthrough.stdout), / · claude-opus-9\/high · .* · model unverified$/);
  const unknown = w.claude(["ask", "--to", "claude", "--model", "gpt-6.1-sol", "--effort", "low", "--", "q"], "is-error");
  assert.equal(unknown.status, 1);
  assert.match(footerOf(unknown.stdout), /^council claude failed · .* · gpt-6\.1-sol\/low · .* · model unverified · error: claude api_error: There's an issue with the selected model/);
  const ultra = w.claude(["ask", "--to", "claude", "--effort", "ultra", "--", "q"]);
  assert.equal(ultra.status, 2, "council's vocabulary check guards the effort the CLI would ignore");
  assert.equal(w.launches().length, 3, "no launch for the refused effort");
  const budget = w.claude(["ask", "--to", "claude", "--max-turns", "3", "--max-budget-usd", "0.25", "--", "q"]);
  assert.equal(budget.status, 0, budget.stderr);
  assert.deepEqual([value(w.launches()[3].argv, "--max-turns"), value(w.launches()[3].argv, "--max-budget-usd")], ["3", "0.25"]);
});

test("ask → task --thread → reply → task --thread: the complete flag set on every transition; a reply after a task is read-only again", () => {
  const w = world();
  const ask = w.claude(["ask", "--to", "claude", "--", "plan it"]);
  assert.equal(ask.status, 0, ask.stderr);
  const task = w.claude(["task", "--thread", jobIdOf(ask.stderr), "--request-id", "t1", "--", "edit value.mjs"], "task");
  assert.equal(task.status, 0, task.stdout + task.stderr);
  assert.match(footerOf(task.stdout), /^council claude ok · .* · round 2\/9 · edited 1$/);
  const reply = w.claude(["reply", jobIdOf(task.stderr), "--", "and now?"], "resume");
  assert.equal(reply.status, 0, reply.stdout + reply.stderr);
  const again = w.claude(["task", "--thread", jobIdOf(reply.stderr), "--request-id", "t2", "--", "one more"], "task");
  assert.equal(again.status, 0, again.stderr);
  assert.match(footerOf(again.stdout), / · round 4\/9 · edited 1$/);
  const calls = w.launches();
  const session = flags(calls[0]).session;
  assert.deepEqual(calls.map((c) => subset(flags(c), READ_ONLY)), [READ_ONLY, subset(TASK_SET, READ_ONLY), READ_ONLY, subset(TASK_SET, READ_ONLY)]);
  assert.deepEqual(calls.map((c) => [flags(c).session, flags(c).resume, flags(c).maxTurns, flags(c).schema]), [[session, null, "20", false], [null, session, "30", false], [null, session, "20", false], [null, session, "30", false]]);
  assert.deepEqual(calls.map((c) => c.prompt.split("\n\n")[0] === template("advice").split("\n\n")[0] ? "advice" : c.prompt.startsWith(template("task")) ? "task" : "?"), ["advice", "task", "advice", "task"]);
  assert.ok(calls.every((c) => c.session === session), "stdin names the same session throughout");
  assert.deepEqual(json(w.call(["wait", jobIdOf(task.stderr), "--json"])).edited, ["<SCRATCH>/repo/value.mjs"]);
});

test("review → task --thread → reply: schema and two turns on the review, the task launch, then a structured read-only discussion", () => {
  const w = world();
  fs.writeFileSync(path.join(w.workspace, "README.md"), "# changed\n");
  const review = w.claude(["review", "--to", "claude", "--request-id", "r1"], "review-findings");
  assert.equal(review.status, 10, review.stdout + review.stderr);
  assert.match(review.stdout, /^Verdict: needs attention\./);
  assert.match(review.stdout, /\nF1 BLOCKER sum\.mjs:2 AGREE: Off-by-one: first element skipped/);
  const task = w.claude(["task", "--thread", jobIdOf(review.stderr), "--request-id", "r2", "--", "fix F1"], "task");
  assert.equal(task.status, 0, task.stdout + task.stderr);
  const reply = w.claude(["reply", jobIdOf(task.stderr), "--", "F1 fixed?"], "review-findings");
  assert.ok([0, 10].includes(reply.status), reply.stdout + reply.stderr);
  const calls = w.launches();
  assert.deepEqual(calls.map((c) => [flags(c).mode, flags(c).schema, flags(c).maxTurns]), [["dontAsk", true, "20"], ["acceptEdits", false, "30"], ["dontAsk", true, "20"]]);
  assert.deepEqual(subset(flags(calls[0]), READ_ONLY), READ_ONLY);
  assert.deepEqual(subset(flags(calls[1]), READ_ONLY), subset(TASK_SET, READ_ONLY));
  assert.deepEqual(subset(flags(calls[2]), READ_ONLY), READ_ONLY);
  assert.match(calls[0].prompt, /Review snapshot /, "the batch prompt is the review input");
  assert.ok(calls[1].prompt.startsWith(template("task")));
  assert.match(calls[2].prompt, /^F1 fixed\?\nThis follow-up on the review above delivers no new review input/);
});

test("--web: WebFetch,WebSearch in --tools and --allowedTools on the fresh turn and the inheriting resume", () => {
  const w = world();
  const ask = w.claude(["ask", "--to", "claude", "--web", "--", "look it up"]);
  assert.equal(ask.status, 0, ask.stderr);
  const reply = w.claude(["reply", jobIdOf(ask.stderr), "--", "more"], "resume");
  assert.equal(reply.status, 0, reply.stderr);
  for (const call of w.launches()) assert.deepEqual([flags(call).tools, flags(call).allowed], [[...READ, "WebFetch", "WebSearch"], ["WebFetch", "WebSearch"]]);
  const plain = w.claude(["ask", "--to", "claude", "--", "q"]);
  assert.deepEqual(flags(w.launches().at(-1)).allowed, [], "off by default");
  assert.equal(plain.status, 0);
});

test("a two-batch review: findings, then a clean synthesis keeps the blocker (10); an identified REJECT resolves it (0)", () => {
  const w = world();
  for (let i = 0; i < 3; i++) fs.writeFileSync(path.join(w.workspace, `part${i}.txt`), "snapshot\n".repeat(18000));
  const first = w.claude(["review", "--to", "claude", "--request-id", "big"], "large-review");
  assert.equal(first.status, 10, first.stdout + first.stderr);
  const [, , total] = /batch (\d+)\/(\d+)/.exec(footerOf(first.stdout));
  assert.ok(Number(total) >= 2);
  let ref = jobIdOf(first.stderr), last = first, synthesis = false;
  for (let i = 0; i < 10; i++) {
    const next = w.claude(["reply", ref, "--next-input"], "large-review");
    if (next.status === 2) break;
    last = next; ref = jobIdOf(next.stderr);
    synthesis ||= w.launches().at(-1).prompt.includes("Final synthesis:");
  }
  assert.ok(synthesis, "the synthesis pass ran");
  assert.equal(last.status, 10, "the early blocker survives a clean synthesis");
  const done = json(w.call(["wait", ref, "--json"]));
  assert.deepEqual([done.coverage.status, done.coverage.blocking], ["complete", true]);
  assert.ok(w.launches().every((c) => flags(c).schema && flags(c).mode === "dontAsk"));
  const reject = w.claude(["reply", ref, "--", "F1 and F2 are not defects: the caller guarantees non-empty arrays."], "review-reject");
  assert.equal(reject.status, 0, reject.stdout + reject.stderr);
  assert.match(w.launches().at(-1).prompt, /^- \S+-F1 BLOCKER sum\.mjs:2 AGREE/m, "the discussion prompt lists the ledger ids");
  assert.equal(json(w.call(["wait", jobIdOf(reject.stderr), "--json"])).coverage.blocking, false);
});

test("terminal failures exit 1: missing, duplicate and wrong-session results, is_error, the turn limit", () => {
  const w = world();
  const expect = { "missing-result": /error: /, "duplicate-result": /error: duplicate Claude result event/, "wrong-session": /error: the provider answered on thread "00000000-0000-4000-8000-000000000099"/,
    "is-error": /error: claude api_error/, "turn-limit": /error: claude max_turns/ };
  for (const [scenario, pattern] of Object.entries(expect)) {
    const r = w.claude(["ask", "--to", "claude", "--", "q"], scenario);
    assert.equal(r.status, 1, `${scenario}: ${r.stdout}${r.stderr}`);
    assert.match(footerOf(r.stdout), /^council claude failed · /);
    assert.match(footerOf(r.stdout), pattern, scenario);
  }
});

test("denials exit 10: a denied permission, and an edit attempted on a task session resumed read-only (edited stays empty)", () => {
  const w = world();
  const denied = w.claude(["ask", "--to", "claude", "--", "read the secret"], "denied");
  assert.equal(denied.status, 10, denied.stdout + denied.stderr);
  assert.match(denied.stdout, /^Partial answer\.\n/);
  assert.match(footerOf(denied.stdout), /^council claude needs attention · /);
  const task = w.claude(["task", "--to", "claude", "--request-id", "t", "--", "edit"], "task");
  assert.equal(task.status, 0, task.stderr);
  const absent = w.claude(["reply", jobIdOf(task.stderr), "--", "edit again"], "tool-absent");
  assert.equal(absent.status, 10, absent.stdout + absent.stderr);
  const job = w.job(jobIdOf(absent.stderr));
  assert.deepEqual([job.edited, job.denied[0].denials[0].tool, job.readOnly], [[], "Edit", true]);
  assert.equal(flags(w.launches().at(-1)).mode, "dontAsk");
});

test("a task whose Edit result is an error leaves that path out of edited; its failed Bash is counted", () => {
  const w = world();
  const r = w.claude(["task", "--to", "claude", "--request-id", "e", "--json", "--", "edit"], "task-edit-error");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const out = json(r);
  assert.deepEqual([out.edited, out.editedCount, out.failedCommandCount, out.failedCommands], [[], 0, 1, ['node -e "process.exit(0)"; echo $?']]);
});

test("ownership: the live child is found by its session uuid operand and cancel stops it", async () => {
  const w = world();
  const run = w.start(["ask", "--to", "claude", "--", "q"], { env: { COUNCIL_FAKE_SCENARIO: "slow", COUNCIL_FAKE_SLOW_MS: "20000" } });
  const [, job] = await run.waitFor(/job=([a-z0-9]{16})/);
  const meta = await until(() => { const m = w.job(job); return m.pid && m.childArgs ? m : null; });
  const found = ownedExecution(meta, processSnapshot(), process.platform, [], adapter);
  assert.equal(found.state, "owned", JSON.stringify(found));
  assert.ok(found.rows.some((r) => r.pid === meta.pid));
  const other = { ...meta, pid: null, leader: undefined, execution: [], childArgs: meta.childArgs.map((a) => (a === value(meta.childArgs, "--session-id") ? "22222222-2222-4222-8222-222222222222" : a)), threadId: null, requestedThreadId: null };
  assert.equal(ownedExecution(other, processSnapshot(), process.platform, [], adapter).rows.some((r) => r.pid === meta.pid), false, "another session's job owns nothing of it");
  const cancel = w.call(["cancel", job]);
  assert.equal(cancel.status, 0, cancel.stdout + cancel.stderr);
  const { code } = await run.exited;
  assert.equal(code, 1);
  assert.equal(alive(meta.pid), false);
});

test("preflight blocked: Claude's storage not writable exits 1 with the action line, zero probes and zero launches", () => {
  const w = world();
  const file = path.join(w.dir, "not-a-dir");
  fs.writeFileSync(file, "");
  const r = w.claude(["ask", "--to", "claude", "--", "q"], "ok", { env: { CLAUDE_CONFIG_DIR: file } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /preflight_blocked: Claude session storage \(dir .*not-a-dir[\\/]projects\)/);
  assert.match(r.stderr, /\naction: Grant write access to .*not-a-dir[\\/]projects/);
  assert.deepEqual([w.probes().length, w.launches().length], [0, 0]);
  const loggedOut = w.claude(["ask", "--to", "claude", "--", "q"], "ok", { env: { COUNCIL_FAKE_LOGGED_OUT: "1" } });
  assert.equal(loggedOut.status, 1);
  assert.match(loggedOut.stderr, /action: Run claude auth login, then setup\./);
  assert.equal(w.launches().length, 0);
});

test("setup and models: the claude row from the probes, no listing to refresh", () => {
  const w = world();
  const setup = w.call(["setup", "--to", "claude"]);
  assert.equal(setup.status, 0, setup.stderr);
  assert.match(setup.stdout, /^claude: .*fake-claude\.mjs \(node-script\) · 2\.1\.314 \(Claude Code\) · logged in · tiers consult=claude-opus-5-5\/high exec=sonnet\/high deep=claude-opus-5-5\/xhigh · preflight ok/);
  assert.ok(!setup.stdout.includes("firstParty"));
  const models = w.call(["models", "--to", "claude", "--refresh"]);
  assert.equal(models.status, 0);
  assert.match(models.stdout, /^claude \(static catalog\)\n {2}default: low, medium, high, xhigh, max\n/);
  assert.ok(!w.probes().some((p) => p.argv.includes("models")), "claude models would be a paid prompt");
});

test("S3.7: a denial that made Claude's result is_error (and its exit 1) ends needs attention, exit 10, with the error text", () => {
  const w = world();
  const r = w.claude(["ask", "--to", "claude", "--", "read the secret"], "denied-error");
  assert.equal(r.status, 10, r.stdout + r.stderr);
  assert.match(r.stdout, /^claude error_during_execution: Partial answer\.\n/);
  assert.match(footerOf(r.stdout), /^council claude needs attention · /);
});
