// S4.5: the Grok adapter through the entry against tests/fixtures/fake-grok.mjs, which validates the A5.1 launch contract
// and exits 99 on any mismatch: every verb, thread continuity and agent persistence, the read-only guard, --web, the effort
// clamp, reviews with batches and the ledger, preflight, concurrency and cancel.
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { makeWorld, jobIdOf, footerOf, ROOT } from "./helpers.mjs";
import { HOSTILE, RESUME_DENY } from "../plugins/council/scripts/lib/providers/grok.mjs";

const FAKE = path.join(ROOT, "tests", "fixtures", "fake-grok.mjs");
const CONTRACT_LINE = fs.readFileSync(path.join(ROOT, "plugins", "council", "contract.md"), "utf8").replace(/\s*\r?\n\s*/g, " ").trim();
const SCHEMA = JSON.parse(fs.readFileSync(path.join(ROOT, "plugins", "council", "schemas", "review-output.schema.json"), "utf8"));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function world({ git = true, login = true } = {}) {
  const w = makeWorld({ git });
  if (login) { fs.mkdirSync(path.join(w.dir, ".grok"), { recursive: true }); fs.writeFileSync(path.join(w.dir, ".grok", "auth.json"), "{}", { mode: 0o600 }); }
  w.env.COUNCIL_GROK_BIN = FAKE;
  delete w.env.COUNCIL_TEST_NULL_ADAPTER;
  w.grok = (args, opts = {}) => w.call(args, { ...opts, env: { ...(opts.scenario ? { COUNCIL_FAKE_SCENARIO: opts.scenario } : {}), ...(opts.env ?? {}) } });
  w.launches = () => w.fakeCalls().filter((c) => !c.mismatch && !c.probe);
  w.mismatches = () => w.fakeCalls().filter((c) => c.mismatch);
  return w;
}
const flag = (argv, name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const large = (w, files = 3) => { for (let i = 0; i < files; i++) fs.writeFileSync(path.join(w.workspace, `part${i}.txt`), "snapshot\n".repeat(18000)); };

test("ask: explore recipe, prompt file with the advice instructions, --rules contract text, a new --session-id, compatEnv, footer with the requested model", () => {
  const w = world();
  const r = w.grok(["ask", "--to", "grok", "--effort", "low", "--", "Reply with pong"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.stdout.split("\n")[0], "pong");
  assert.match(footerOf(r.stdout), /^council grok ok · job [a-z0-9]{16} · grok-4\.7\/low · \d+s · round 1\/9$/);
  const call = w.launches().at(-1);
  assert.equal(w.mismatches().length, 0);
  assert.deepEqual([call.agent, call.readOnly, call.web], ["explore", true, false]);
  assert.equal(flag(call.argv, "--rules"), CONTRACT_LINE);
  assert.equal(flag(call.argv, "--model"), "grok-4.7");
  assert.ok(call.argv.includes("--no-auto-update") && call.argv.includes("--disable-web-search"));
  assert.equal(flag(call.argv, "--disallowed-tools"), HOSTILE.join(","));
  assert.match(flag(call.argv, "--session-id"), UUID);
  assert.equal(call.argv.includes("-r"), false);
  assert.match(call.prompt, /^Instructions for this turn \(advice, read-only\)[\s\S]*\n\nReply with pong$/);
  assert.equal(call.env.GROK_CLAUDE_RULES_ENABLED, "0");
  for (const name of ["COUNCIL_DEPTH", "CLAUDE_PLUGIN_CODEX_DEPTH", "GROK_CODEX_DEPTH", "GROK_BUILD_DEPTH", "AGY_BRIDGE_DEPTH"]) assert.equal(call.env[name], "1", name);
  const job = w.job(jobIdOf(r.stderr));
  assert.deepEqual([job.threadId, job.agent, job.model, job.cost], [flag(call.argv, "--session-id"), "explore", "grok-4.7", 0.016236]);
  assert.equal(job.modelObserved, undefined, "end.modelUsage's grok-4.7-build is never reported as the model");
  assert.equal(job.promptFile, flag(call.argv, "--prompt-file"));
});

test("ask → task --thread → reply → task --thread: -r on the session, the recipe follows the session's agent, agent persists", () => {
  const w = world();
  const ask = w.grok(["ask", "--to", "grok", "--", "look"]);
  assert.equal(ask.status, 0, ask.stderr);
  const job = jobIdOf(ask.stderr);
  const session = w.job(job).threadId;
  const task = w.grok(["task", "--to", "grok", "--thread", job, "--", "fix it"], { scenario: "resume" });
  assert.equal(task.status, 0, task.stdout + task.stderr);
  let call = w.launches().at(-1);
  assert.deepEqual([flag(call.argv, "-r"), call.agent, call.readOnly, call.argv.includes("--agent")], [session, "default", false, false]);
  assert.ok(call.argv.includes("Bash(git push*)") && call.argv.includes("Bash(rm -rf *)"));
  assert.equal(flag(call.argv, "--model"), "grok-4.7", "task --thread inherits the thread's model");
  assert.match(call.prompt, /^Instructions for this turn \(task: edits are authorized/);
  assert.equal(call.env.GROK_CLAUDE_RULES_ENABLED, undefined);
  assert.equal(w.job(jobIdOf(task.stderr)).agent, "default");
  assert.match(footerOf(task.stdout), /round 2\/9/);
  const reply = w.grok(["reply", job, "--", "and now?"], { scenario: "resume" });
  assert.equal(reply.status, 0, reply.stdout + reply.stderr);
  call = w.launches().at(-1);
  assert.deepEqual([flag(call.argv, "-r"), call.agent, call.readOnly, call.argv.includes("--agent")], [session, "default", true, false]);
  assert.equal(flag(call.argv, "--disallowed-tools"), RESUME_DENY.join(","), "a read-only turn on a default-agent session uses RESUME_DENY");
  assert.equal(flag(call.argv, "--deny"), "MCPTool(*)");
  assert.equal(w.job(jobIdOf(reply.stderr)).agent, "default");
  const again = w.grok(["task", "--to", "grok", "--thread", session, "--", "more"], { scenario: "resume" });
  assert.equal(again.status, 0, again.stderr);
  call = w.launches().at(-1);
  assert.deepEqual([flag(call.argv, "-r"), call.agent, call.readOnly], [session, "default", false]);
  assert.match(footerOf(again.stdout), /round 4\/9/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(w.home, "threads", `grok-${session}.json`), "utf8")).agent, "default");
  assert.equal(w.mismatches().length, 0);
});

test("a read-only reply on an explore session stays on explore; a fresh task starts the default agent with the exec tier", () => {
  const w = world();
  const ask = w.grok(["ask", "--to", "grok", "--", "q"]);
  w.grok(["reply", jobIdOf(ask.stderr), "--", "r"], { scenario: "resume" });
  assert.deepEqual([w.launches().at(-1).agent, flag(w.launches().at(-1).argv, "--agent")], ["explore", "explore"]);
  const task = w.grok(["task", "--to", "grok", "--", "do it"]);
  assert.equal(task.status, 0, task.stderr);
  const call = w.launches().at(-1);
  assert.deepEqual([call.agent, flag(call.argv, "--model"), flag(call.argv, "--effort")], ["default", "grok-4.7-build-fast", "xhigh"]);
  assert.match(flag(call.argv, "--session-id"), UUID);
});

test("a forbidden tool advertised on a read-only turn fails closed (exit 1) before any text", () => {
  const w = world();
  const r = w.grok(["ask", "--to", "grok", "--", "q"], { scenario: "denied" });
  assert.equal(r.status, 1, r.stdout);
  assert.doesNotMatch(r.stdout, /should never be read/);
  assert.match(footerOf(r.stdout), /^council grok failed · .* · error: read-only tool guard failed: search_replace, write, run_terminal_command/);
  const answer = path.join(w.home, "jobs", jobIdOf(r.stderr), "answer.md");
  assert.equal(fs.existsSync(answer) ? fs.readFileSync(answer, "utf8") : "", "");
});

test("--web omits --disable-web-search and persists on the thread", () => {
  const w = world();
  const r = w.grok(["ask", "--to", "grok", "--web", "--", "news?"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual([w.launches().at(-1).web, w.launches().at(-1).argv.includes("--disable-web-search")], [true, false]);
  w.grok(["reply", jobIdOf(r.stderr), "--", "more"], { scenario: "resume" });
  assert.equal(w.launches().at(-1).web, true);
});

test("--effort max is clamped to xhigh before launch; the footer shows the clamp", () => {
  const w = world();
  const r = w.grok(["ask", "--to", "grok", "--model", "4.7", "--effort", "max", "--", "q"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(footerOf(r.stdout), / · grok-4\.7\/xhigh<=max · /);
  assert.equal(flag(w.launches().at(-1).argv, "--effort"), "xhigh");
  const json = JSON.parse(w.grok(["ask", "--to", "grok", "--effort", "max", "--json", "--", "q"]).stdout);
  assert.deepEqual([json.model, json.effort, json.requestedEffort], ["grok-4.7", "xhigh", "max"]);
});

test("Grok's effort error (an unverified model passes max through) fails with Grok's message", () => {
  const w = world();
  const r = w.grok(["ask", "--to", "grok", "--model", "grok-9", "--effort", "max", "--", "q"], { scenario: "effort-error" });
  assert.equal(r.status, 1, r.stdout);
  assert.match(footerOf(r.stdout), /grok-9\/max · .* · model unverified · error: .*unknown effort level 'max'/);
});

test("an end event without a session id fails: session not confirmed, with the start-a-new-ask hint", () => {
  const w = world();
  const r = w.grok(["ask", "--to", "grok", "--", "q"], { scenario: "no-session" });
  assert.equal(r.status, 1);
  assert.match(footerOf(r.stdout), /error: session not confirmed: Grok's end event names no session · thread not confirmed; start a new ask$/);
});

test("review: explore, inline --json-schema equal to the repository schema, no --rules, the batch prompt in the prompt file; findings → 10", () => {
  const w = world();
  fs.writeFileSync(path.join(w.workspace, "README.md"), "# changed\n");
  const r = w.grok(["review", "--to", "grok", "--effort", "low"], { scenario: "review-findings" });
  assert.equal(r.status, 10, r.stdout + r.stderr);
  assert.match(r.stdout, /^Verdict: needs attention\. The rewritten loop skips items\[0\]/);
  assert.match(r.stdout, /F1 BLOCKER sum\.mjs:2: Sum loop starts at index 1/);
  const call = w.launches().at(-1);
  assert.deepEqual(JSON.parse(flag(call.argv, "--json-schema")), SCHEMA);
  assert.equal(call.argv.includes("--rules"), false);
  assert.deepEqual([call.agent, call.readOnly], ["explore", true]);
  assert.match(call.prompt, /^Instructions for this turn \(structured code review, read-only\)/);
  assert.match(call.prompt, /\+# changed/);
  assert.equal(call.cwd, fs.realpathSync(w.workspace));
  const json = JSON.parse(w.grok(["review", "--to", "grok", "--json"], { scenario: "review-findings" }).stdout);
  assert.deepEqual([json.verdict, json.findings.map((f) => [f.id, f.severity])], ["needs-attention", [["F1", "BLOCKER"]]]);
});

test("review: malformed structured output is incomplete (10); a clean approval is 0", () => {
  const w = world();
  fs.writeFileSync(path.join(w.workspace, "README.md"), "# changed\n");
  const bad = w.grok(["review", "--to", "grok"], { scenario: "review-malformed" });
  assert.equal(bad.status, 10);
  assert.match(bad.stdout, /^Verdict: incomplete\.\nIncomplete: review finding 1 needs an id/);
  const reject = w.grok(["review", "--to", "grok"], { scenario: "review-reject" });
  assert.equal(reject.status, 0, reject.stdout);
});

test("review from a subdirectory exits 2 before any job: a Grok session cannot reach folders outside its cwd", () => {
  const w = world();
  fs.mkdirSync(path.join(w.workspace, "sub"));
  fs.writeFileSync(path.join(w.workspace, "sub", "x.txt"), "x\n");
  const r = w.grok(["review", "--to", "grok"], { cwd: path.join(w.workspace, "sub") });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /grok reviews run at the repository root .*rerun from .* or pass --cwd /);
  assert.equal(w.launches().length, 0);
  assert.equal(fs.existsSync(path.join(w.home, "jobs")) ? fs.readdirSync(path.join(w.home, "jobs")).length : 0, 0);
  const ok = w.grok(["review", "--to", "grok", "--cwd", w.workspace], { cwd: path.join(w.workspace, "sub"), scenario: "review-reject" });
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
});

test("two-batch review: findings in batch 1, --next-input to a clean synthesis keeps the blocker (10) until an identified REJECT clears it", () => {
  const w = world();
  large(w, 2);
  const first = w.grok(["review", "--to", "grok"], { scenario: "large-review" });
  assert.equal(first.status, 10, first.stdout + first.stderr);
  const job = jobIdOf(first.stderr);
  const [, , total] = /batch (\d+)\/(\d+)/.exec(footerOf(first.stdout));
  assert.equal(Number(total), 3, "two text batches and the synthesis pass");
  assert.match(footerOf(first.stdout), new RegExp(`batch 1/${total} · next: reply ${job} --next-input$`));
  let ref = job, last = first, sawSynthesis = false;
  for (let i = 0; i < 10; i++) {
    const next = w.grok(["reply", ref, "--next-input"], { scenario: "large-review" });
    if (next.status === 2) break;
    last = next;
    ref = jobIdOf(next.stderr);
    const call = w.launches().at(-1);
    sawSynthesis ||= /Batch units: synthesis/.test(call.prompt);
    assert.deepEqual(JSON.parse(flag(call.argv, "--json-schema")), SCHEMA);
    assert.equal(flag(call.argv, "-r"), w.job(job).threadId, "--next-input continues the review's session");
  }
  assert.ok(sawSynthesis);
  assert.equal(last.status, 10, last.stdout);
  let json = JSON.parse(w.grok(["wait", ref, "--json"]).stdout);
  assert.deepEqual([json.coverage.status, json.coverage.blocking], ["complete", true]);
  assert.match(last.stdout, /blocking findings that remain open: u1-F1, u2-F1\./);
  const reject = w.grok(["reply", ref, "--", "u1-F1 and u2-F1 are false positives"], { scenario: "review-reject" });
  assert.match(w.launches().at(-1).prompt, /- u1-F1 BLOCKER sum\.mjs:2/, "the discussion prompt names the open findings by id");
  assert.equal(reject.status, 0, reject.stdout + reject.stderr);
  json = JSON.parse(w.grok(["wait", jobIdOf(reject.stderr), "--json"]).stdout);
  assert.equal(json.coverage.blocking, false);
  assert.equal(w.mismatches().length, 0);
});

test("preflight: a hidden login file exits 1 preflight_blocked naming it, with zero spawns and zero probes; GROK_API_KEY replaces the file", () => {
  const w = world({ login: false });
  const r = w.grok(["ask", "--to", "grok", "--", "q"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^council: preflight_blocked: Grok login file \(file .*\.grok\/auth\.json\): read access is missing \(ENOENT\)\naction: Grant read access to .*auth\.json/);
  assert.deepEqual([w.fakeCalls().length, w.probes().length], [0, 0]);
  assert.equal(fs.existsSync(path.join(w.home, "jobs")) ? fs.readdirSync(path.join(w.home, "jobs")).length : 0, 0);
  const keyed = w.grok(["ask", "--to", "grok", "--", "q"], { env: { GROK_API_KEY: "test-key" } });
  assert.equal(keyed.status, 0, keyed.stderr);
});

test("preflight: cold call runs the two probes (--version, models), a warm call none; a logged-out listing blocks", () => {
  const w = world();
  assert.equal(w.grok(["ask", "--to", "grok", "--", "q"]).status, 0);
  assert.deepEqual(w.probes().map((p) => p.probe), ["version", "models"]);
  assert.equal(w.grok(["ask", "--to", "grok", "--", "q2"]).status, 0);
  assert.equal(w.probes().length, 2, "warm: the cache answers");
  const out = world();
  const r = out.grok(["ask", "--to", "grok", "--", "q"], { env: { COUNCIL_FAKE_LOGGED_OUT: "1" } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /preflight_blocked: grok login probe \(grok models\)[\s\S]*action: Run `grok` once and complete login/);
  assert.equal(out.launches().length, 0);
});

test("a task reports Grok's completed edits in the footer and --json", () => {
  const w = world();
  const stream = path.join(w.dir, "edit-stream.mjs");
  // A wrapper that runs the fake for its contract checks, then appends an edit before the end event.
  fs.writeFileSync(stream, `import { spawnSync } from "node:child_process";
const r = spawnSync(process.execPath, [${JSON.stringify(FAKE)}, ...process.argv.slice(2)], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
if (r.status !== 0 || !process.argv.includes("--prompt-file")) { process.stdout.write(r.stdout); process.exit(r.status); }
const lines = r.stdout.trim().split("\\n"), end = lines.pop();
lines.push(JSON.stringify({ type: "tool_call", toolName: "search_replace", toolCallId: "t1", rawInput: { file_path: process.cwd() + "/README.md" } }));
lines.push(JSON.stringify({ type: "tool_call_update", toolCallId: "t1", status: "completed" }));
process.stdout.write(lines.concat(end).join("\\n") + "\\n");
`);
  const r = w.grok(["task", "--to", "grok", "--json", "--", "edit"], { env: { COUNCIL_GROK_BIN: stream } });
  const json = JSON.parse(r.stdout);
  assert.equal(json.exit, 0, r.stdout + r.stderr);
  assert.deepEqual(json.edited, ["README.md"]);
});

test("two concurrent asks with the same model and effort both finish with cleanup confirmed (the post-exit scan never cross-matches)", async () => {
  const w = world();
  const env = { COUNCIL_FAKE_SCENARIO: "slow", COUNCIL_FAKE_SLOW_MS: "800" };
  const one = w.start(["ask", "--to", "grok", "--effort", "low", "--", "one"], { env }), two = w.start(["ask", "--to", "grok", "--effort", "low", "--", "two"], { env });
  const [r1, r2] = await Promise.all([one.exited, two.exited]);
  assert.deepEqual([r1.code, r2.code], [0, 0], r1.stdout + r1.stderr + r2.stdout + r2.stderr);
  for (const r of [r1, r2]) { const job = w.job(jobIdOf(r.stderr)); assert.deepEqual([job.cleanupPending, job.claimHeld ?? false], [false, false]); }
});

test("cancel stops a running Grok turn; a grandchild holding the pipes briefly still ends ok", async () => {
  const w = world();
  const slow = w.start(["ask", "--to", "grok", "--", "wait"], { env: { COUNCIL_FAKE_SCENARIO: "slow", COUNCIL_FAKE_SLOW_MS: "20000" } });
  const [, job] = await slow.waitFor(/job=([a-z0-9]{16})/);
  await new Promise((r) => setTimeout(r, 300));
  const c = w.grok(["cancel", job]);
  assert.equal(c.status, 0, c.stdout + c.stderr);
  const done = await slow.exited;
  assert.equal(done.code, 1);
  assert.match(footerOf(done.stdout), /^council grok cancelled · /);
  const held = w.grok(["ask", "--to", "grok", "--", "q"], { scenario: "hold-pipes", env: { COUNCIL_FAKE_HOLD_MS: "1500" } });
  assert.equal(held.status, 0, held.stdout + held.stderr);
});

test("no --add-dir or --cwd is ever passed: the session works in the turn's cwd", () => {
  const w = world();
  w.grok(["ask", "--to", "grok", "--", "q"]);
  const call = w.launches().at(-1);
  assert.equal(call.argv.includes("--add-dir") || call.argv.includes("--cwd"), false);
  assert.equal(call.cwd, fs.realpathSync(w.workspace));
});

test("wait replays a finished Grok job and a repeated --request-id starts no second Grok process", () => {
  const w = world();
  const first = w.grok(["ask", "--to", "grok", "--request-id", "g-1", "--", "q"]);
  assert.equal(first.status, 0, first.stderr);
  const job = jobIdOf(first.stderr);
  const launches = w.launches().length, probes = w.probes().length;
  const again = w.grok(["ask", "--to", "grok", "--request-id", "g-1", "--", "q"]);
  assert.equal(again.status, 0);
  assert.equal(footerOf(again.stdout), footerOf(first.stdout));
  const waited = w.grok(["wait", job]);
  assert.deepEqual([waited.status, waited.stdout.split("\n")[0], footerOf(waited.stdout)], [0, "pong", footerOf(first.stdout)]);
  assert.deepEqual([w.launches().length, w.probes().length], [launches, probes], "replay and wait start nothing");
  assert.equal(w.grok(["ask", "--to", "grok", "--request-id", "g-1", "--", "changed"]).status, 2);
});
