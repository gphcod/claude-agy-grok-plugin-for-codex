// S5.5: the Gemini adapter through the entry against fake-agy (tests/fixtures/fake-agy.mjs), which validates the A5.1
// launch contract (argv, settings file, stdin, guard variables) before it answers. No test reaches the real agy: the
// world's COUNCIL_AGY_BIN names the fake, and HTTPS_PROXY makes the network descriptor skip its live request.
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { makeWorld, jobIdOf, footerOf, alive, until } from "./helpers.mjs";
import { main } from "../plugins/council/scripts/council.mjs";
import { READ_ONLY_DENY } from "../plugins/council/scripts/lib/providers/gemini.mjs";

const FAKE = path.resolve("tests", "fixtures", "fake-agy.mjs");
const darwinOnly = { skip: process.platform === "win32" };
/** A world wired to fake-agy, with an optional global agy settings file under its HOME. */
function world({ git = true, global } = {}) {
  const w = makeWorld({ git });
  Object.assign(w.env, { COUNCIL_AGY_BIN: FAKE, HTTPS_PROXY: "http://127.0.0.1:9" });
  if (global !== undefined) {
    fs.mkdirSync(path.join(w.dir, ".gemini", "antigravity-cli"), { recursive: true });
    fs.writeFileSync(path.join(w.dir, ".gemini", "antigravity-cli", "settings.json"), JSON.stringify(global));
  }
  w.gemini = (args, scenario = "ok", extra = {}) => w.call(args, { ...extra, env: { COUNCIL_FAKE_SCENARIO: scenario, ...(extra.env ?? {}) } });
  w.logged = () => (fs.existsSync(w.env.COUNCIL_FAKE_LOG) ? fs.readFileSync(w.env.COUNCIL_FAKE_LOG, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  // fake-agy logs probes with their argv too: submissions are the entries that carry a prompt.
  w.fakeCalls = () => w.logged().filter((e) => typeof e.prompt === "string");
  w.probes = () => w.logged().filter((e) => e.probe);
  return w;
}
const flag = (argv, name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
async function inProcess(w, argv, { env = {}, hooks } = {}) {
  let stdout = "", stderr = "";
  const io = { stdout: { write: (t) => { stdout += t; return true; } }, stderr: { write: (t) => { stderr += t; return true; } }, stdin: Readable.from([]) };
  const code = await main(argv, { ...w.env, ...env }, io, { cwd: w.workspace, ...(hooks ? { hooks } : {}) });
  return { code, stdout, stderr };
}

test("verification: ask --to gemini --effort low prints the answer and the footer with the model and effort", () => {
  const w = world();
  const r = w.gemini(["ask", "--to", "gemini", "--effort", "low", "--", "Reply with pong"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^pong\ncouncil gemini ok · job [a-z0-9]{16} · gemini-4-argon\/low · \d+s · round 1\/9\n$/);
  assert.match(r.stderr, /^\[council\] provider=gemini job=[a-z0-9]{16} thread=[0-9a-f-]{36}\n$/);
  const job = w.job(jobIdOf(r.stderr));
  assert.equal(job.threadId, w.fakeCalls()[0].conversation ?? job.threadId);
  assert.deepEqual([job.mutationCoverage, job.readOnly], ["complete", true]);
});

test("ask → task --thread → reply → task --thread: settings, --sandbox, --mode and --conversation on every transition", () => {
  const w = world({ global: { permissions: { allow: ["run_command(*)", "command(which)", "read_file(docs/*)"], deny: ["read_file(.env)"] }, toolPermission: "always-proceed" } });
  const ask = w.gemini(["ask", "--to", "gemini", "--", "plan it"]);
  assert.equal(ask.status, 0, ask.stderr);
  const id = jobIdOf(ask.stderr);
  const thread = w.job(id).threadId;
  const task = w.gemini(["task", "--to", "gemini", "--thread", id, "--allow-command", "node check.mjs", "--", "do it"], "task");
  assert.equal(task.status, 0, task.stderr);
  assert.match(footerOf(task.stdout), / · gemini-4-argon\/high · \d+s · round 2\/9 · edited 0$/, "task --thread inherits the thread's model and effort");
  const reply = w.gemini(["reply", id, "--", "and?"], "resume");
  assert.equal(reply.status, 0, reply.stderr);
  assert.match(footerOf(reply.stdout), /round 3\/9$/);
  const again = w.gemini(["task", "--to", "gemini", "--thread", id, "--", "more"], "task");
  assert.equal(again.status, 0, again.stderr);
  const calls = w.fakeCalls();
  assert.equal(calls.length, 4);
  assert.deepEqual(calls.map((c) => [c.edit, c.conversation ?? null, c.argv.includes("--sandbox")]), [[false, null, true], [true, thread, true], [false, thread, true], [true, thread, true]]);
  const readOnly = { permissions: { allow: ["read_file(docs/*)"], ask: [], deny: ["read_file(.env)", ...READ_ONLY_DENY] }, agentMode: "", toolPermission: "request-review" };
  assert.deepEqual(calls[0].settings, readOnly, "run_command(*) and command(which) are filtered out; the global deny stays");
  assert.deepEqual(calls[2].settings, readOnly, "a reply after a task is read-only again");
  assert.deepEqual(calls[1].settings, { permissions: { allow: ["run_command(*)", "command(which)", "read_file(docs/*)", "command(node check.mjs)", "unsandboxed(node check.mjs)"], ask: [], deny: ["read_file(.env)"] },
    toolPermission: "request-review" }, "a task keeps the global lists; --allow-command adds the pair and forces request-review");
  assert.equal(calls[3].settings.toolPermission, "always-proceed", "a task without --allow-command keeps the global value");
  const settingsPaths = calls.map((c) => flag(c.argv, "--settings"));
  assert.equal(new Set(settingsPaths).size, 4, "one settings file per job");
  for (const [i, p] of settingsPaths.entries()) assert.equal(path.basename(path.dirname(p)), w.job(i === 0 ? id : jobIdOf([ask, task, reply, again][i].stderr)).id);
  assert.match(calls[1].prompt, /Instructions for this turn \(task: edits are authorized/);
  assert.match(calls[2].prompt, /Instructions for this turn \(advice, read-only\)[\s\S]*and\?$/);
  assert.match(calls[0].prompt, /^<council_contract version="1">/, "the standing contract is prepended on every turn");
});

test("strict is preserved on read-only turns and on tasks with --allow-command; --allow-command and --web are refused elsewhere", () => {
  const w = world({ global: { toolPermission: "strict" } });
  assert.equal(w.gemini(["ask", "--to", "gemini", "--", "q"]).status, 0);
  assert.equal(w.gemini(["task", "--to", "gemini", "--allow-command", "node check.mjs", "--", "t"], "task").status, 0);
  assert.deepEqual(w.fakeCalls().map((c) => c.settings.toolPermission), ["strict", "strict"]);
  for (const [args, pattern] of [[["ask", "--to", "gemini", "--allow-command", "x", "--", "q"], /--allow-command is not accepted by ask/],
    [["ask", "--to", "gemini", "--web", "--", "q"], /--web is not offered for gemini/], [["task", "--to", "gemini", "--allow-command", "node -e f()", "--", "q"], /parentheses/]]) {
    const r = w.gemini(args);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, pattern);
  }
  assert.equal(w.fakeCalls().length, 2, "a refusal spawns nothing");
});

test("denials exit 10: a deny-rule tool error, and denied_actions with an empty response (not an empty-response failure)", () => {
  const w = world();
  const rule = w.gemini(["ask", "--to", "gemini", "--json", "--", "write a file"], "denied");
  assert.equal(rule.status, 10, rule.stdout);
  const ruleJson = JSON.parse(rule.stdout);
  assert.deepEqual([ruleJson.status, ruleJson.exit], ["attention", 10]);
  assert.deepEqual(w.job(ruleJson.job).denied.map((d) => d.tool), ["write_file", "run_command"]);
  const prompt = w.gemini(["task", "--to", "gemini", "--allow-command", "node check.mjs", "--", "run both"], "denied-prompt");
  assert.equal(prompt.status, 10, prompt.stdout + prompt.stderr);
  assert.match(prompt.stdout, /^agy denied command \(RunCommand\): headless mode cannot prompt for this permission\.\ncouncil gemini needs attention/);
});

test("failures exit 1: duplicate result, missing result, status ERROR, empty response, print_timeout", () => {
  const w = world();
  for (const [scenario, pattern] of [["duplicate-result", /error: agy sent a duplicate terminal result/], ["missing-result", /error: gemini ended without completing the turn/],
    ["effort-error", /error: agy status ERROR: invalid model selection/], ["empty-response", /error: agy returned an empty response/], ["print-timeout", /error: print_timeout: /]]) {
    const r = w.gemini(["ask", "--to", "gemini", "--", "q"], scenario);
    assert.equal(r.status, 1, `${scenario}: ${r.stdout}${r.stderr}`);
    assert.match(footerOf(r.stdout), /^council gemini failed · /, scenario);
    assert.match(footerOf(r.stdout), pattern, scenario);
  }
});

test("model and effort: a suffix conflict exits 2 before any spawn; xhigh is clamped to high in the footer; a suffixed id travels alone", () => {
  const w = world();
  const conflict = w.gemini(["ask", "--to", "gemini", "--model", "gemini-4-argon-low", "--effort", "high", "--", "q"]);
  assert.equal(conflict.status, 2);
  assert.match(conflict.stderr, /--model gemini-4-argon-low conflicts with --effort high/);
  assert.equal(w.fakeCalls().length, 0);
  const clamped = w.gemini(["ask", "--to", "gemini", "--effort", "xhigh", "--", "q"]);
  assert.equal(clamped.status, 0, clamped.stderr);
  assert.match(footerOf(clamped.stdout), / · gemini-4-argon\/high<=xhigh · /);
  assert.equal(flag(w.fakeCalls().at(-1).argv, "--effort"), "high");
  const suffixed = w.gemini(["ask", "--to", "gemini", "--model", "gemini-3.8-flash-low", "--", "q"]);
  assert.equal(suffixed.status, 0, suffixed.stderr);
  assert.match(footerOf(suffixed.stdout), / · gemini-3\.8-flash-low\/low · /);
  assert.equal(w.fakeCalls().at(-1).effort, undefined);
  assert.equal(w.gemini(["ask", "--to", "gemini", "--model", "argon", "--effort", "medium", "--", "q"]).status, 0);
  assert.equal(flag(w.fakeCalls().at(-1).argv, "--model"), "gemini-4-argon", "aliases resolve inside the catalog");
});

test("review: structured through --json-schema, findings exit 10; adversarial template; malformed output exits 10 incomplete", () => {
  const w = world();
  fs.writeFileSync(path.join(w.workspace, "sum.mjs"), "export const sum = (items) => { let s = 0; for (let i = 1; i < items.length; i++) s += items[i]; return s; };\n");
  const review = w.gemini(["review", "--to", "gemini"], "review-findings");
  assert.equal(review.status, 10, review.stderr);
  assert.match(review.stdout, /^Verdict: needs attention\.[\s\S]*F1 BLOCKER sum\.mjs:2 CHANGE: Off-by-one/);
  assert.match(footerOf(review.stdout), /^council gemini needs attention · job [a-z0-9]{16} · gemini-4-argon\/high · \d+s$/);
  const call = w.fakeCalls().at(-1);
  assert.equal(flag(call.argv, "--json-schema"), path.resolve("plugins", "council", "schemas", "review-output.schema.json"));
  assert.match(call.prompt, /Instructions for this turn \(structured code review, read-only\)/);
  assert.match(call.prompt, /Answer in the structured-output schema the harness enforces/, "the schema is not embedded: agy enforces it");
  assert.equal(call.edit, false);
  const adversarial = w.gemini(["review", "--to", "gemini", "--adversarial"], "review-findings");
  assert.equal(adversarial.status, 10);
  assert.match(w.fakeCalls().at(-1).prompt, /adversarial/i);
  const malformed = w.gemini(["review", "--to", "gemini", "--json"], "review-malformed");
  assert.equal(malformed.status, 10, malformed.stdout);
  const json = JSON.parse(malformed.stdout);
  assert.equal(json.verdict, "incomplete");
  assert.match(json.answer, /Incomplete: review finding 1 needs an id/);
});

test("a two-batch review continues with reply --next-input, keeping the blocker until the clean synthesis", () => {
  const w = world();
  for (let i = 0; i < 3; i++) fs.writeFileSync(path.join(w.workspace, `part${i}.txt`), "snapshot\n".repeat(18000));
  const first = w.gemini(["review", "--to", "gemini"], "large-review");
  assert.equal(first.status, 10, first.stderr);
  assert.match(footerOf(first.stdout), / · batch 1\/\d+ · next: reply [a-z0-9]{16} --next-input$/);
  const job = jobIdOf(first.stderr);
  let last = first;
  for (let i = 0; i < 6 && / --next-input$/.test(footerOf(last.stdout)); i++) last = w.gemini(["reply", job, "--next-input"], "large-review");
  assert.equal(last.status, 10, "the blocker from the first batch stays open");
  assert.doesNotMatch(footerOf(last.stdout), /--next-input/, "every saved batch and the synthesis were delivered");
  assert.match(last.stdout, /F1 BLOCKER/);
  assert.ok(w.fakeCalls().slice(1).every((c) => c.conversation === w.job(job).threadId && flag(c.argv, "--json-schema")), "each batch resumes the conversation with the schema");
});

test("snapshots: a task reports its edited files; a read-only turn whose workspace changed is incomplete; outside Git coverage is unknown", () => {
  const w = world();
  const task = w.gemini(["task", "--to", "gemini", "--", "edit"], "task-edit");
  assert.equal(task.status, 0, task.stderr);
  assert.match(footerOf(task.stdout), / · edited 1$/);
  assert.deepEqual(w.job(jobIdOf(task.stderr)).edited, ["edited.txt"]);
  const touched = w.gemini(["ask", "--to", "gemini", "--json", "--", "look"], "touch");
  assert.equal(touched.status, 10, touched.stdout);
  const job = w.job(JSON.parse(touched.stdout).job);
  assert.equal(job.incomplete, "the workspace changed during a read-only turn: touched.txt");
  const plain = world({ git: false });
  const r = plain.gemini(["task", "--to", "gemini", "--", "edit"], "task-edit");
  assert.equal(r.status, 0, r.stderr);
  const outside = plain.job(jobIdOf(r.stderr));
  assert.deepEqual([outside.mutationCoverage, outside.edited], ["unknown", []], "unknown coverage, never a claimed clean result");
});

test("two concurrent jobs are told apart by their settings paths: cancelling one leaves the other running to completion", darwinOnly, async () => {
  const w = world();
  const env = { COUNCIL_FAKE_SCENARIO: "slow", COUNCIL_FAKE_SLOW_MS: "4000" };
  const a = w.start(["ask", "--to", "gemini", "--", "first"], { env });
  const b = w.start(["ask", "--to", "gemini", "--", "second"], { env });
  // agy names its conversation in its first event, so the start line comes late; each job's id is its settings path's directory.
  await until(() => w.fakeCalls().length === 2);
  const jobOf = (call) => path.basename(path.dirname(flag(call.argv, "--settings")));
  const first = w.fakeCalls().find((c) => c.prompt.endsWith("first"));
  const second = w.fakeCalls().find((c) => c.prompt.endsWith("second"));
  assert.notEqual(jobOf(first), jobOf(second));
  const cancel = w.call(["cancel", jobOf(first)]);
  assert.equal(cancel.status, 0, cancel.stdout + cancel.stderr);
  assert.match(cancel.stdout, new RegExp(`^cancelled · gemini · job ${jobOf(first)}`));
  const [ra, rb] = await Promise.all([a.exited, b.exited]);
  assert.equal(ra.code, 1, ra.stdout + ra.stderr);
  assert.match(footerOf(ra.stdout), /^council gemini cancelled · /);
  assert.equal(rb.code, 0, rb.stdout + rb.stderr);
  assert.match(footerOf(rb.stdout), new RegExp(`^council gemini ok · job ${jobOf(second)} `), "the other job's agy was never touched");
});

test("the stop path ends agy's language-server child with its group (deadline), and a child reparented to pid 1", darwinOnly, async () => {
  const w = world();
  const stopped = w.gemini(["ask", "--to", "gemini", "--deadline", "2", "--", "q"], "language-server");
  assert.equal(stopped.status, 1, stopped.stdout);
  assert.match(footerOf(stopped.stdout), /error: wall-clock deadline passed/);
  const server = w.logged().find((e) => e.languageServer).languageServer;
  await until(() => !alive(server), 5000);
  assert.equal(w.job(jobIdOf(stopped.stderr)).cleanupPending, false);
  const orphan = world();
  const r = await inProcess(orphan, ["ask", "--to", "gemini", "--json", "--", "q"], { env: { COUNCIL_FAKE_SCENARIO: "language-server-orphan", COUNCIL_FAKE_ORPHAN_MS: "1200" }, hooks: { beatMs: 100 } });
  const json = JSON.parse(r.stdout);
  const child = orphan.logged().find((e) => e.languageServer).languageServer;
  await until(() => !alive(child), 5000);
  assert.equal(json.cleanupPending, false, "the reparented child was adopted by its recorded identity and stopped");
  assert.match(json.error ?? "", /owned execution survived the launcher/);
});

test("preflight blocked: a loopback listener that cannot bind exits 1 with the action line and zero spawns", () => {
  const w = world();
  const r = w.gemini(["ask", "--to", "gemini", "--", "q"], "ok", { env: { COUNCIL_AGY_LISTEN_HOST: "192.0.2.1" } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^council: preflight_blocked: agy's loopback listener \(listener 192\.0\.2\.1\): loopback listener bind failed/);
  assert.match(r.stderr, /\naction: Allow a loopback listener\./);
  assert.equal(w.fakeCalls().length + w.probes().length, 0, "blocked before any probe or submission");
  assert.ok(!fs.existsSync(path.join(w.home, "jobs")) || fs.readdirSync(path.join(w.home, "jobs")).length === 0);
  const unwritable = world();
  fs.writeFileSync(path.join(unwritable.dir, ".gemini"), "not a directory");
  const state = unwritable.gemini(["ask", "--to", "gemini", "--", "q"]);
  assert.equal(state.status, 1);
  assert.match(state.stderr, /preflight_blocked: agy backend state/);
});

test("setup, models --refresh, wait and cancel: warnings, the listing, a replay without a new spawn", () => {
  const w = world({ global: { toolPermission: "always-proceed" } });
  const setup = w.call(["setup", "--to", "gemini"]);
  assert.equal(setup.status, 0, setup.stderr);
  assert.match(setup.stdout, /^gemini: .*fake-agy\.mjs \(node-script\) · 1\.4\.12 · logged in · tiers consult=gemini-4-argon\/high exec=gemini-3\.8-flash\/high deep=gemini-4-argon\/high · preflight ok\n/);
  assert.match(setup.stdout, /\n  warning: Gemini tasks without --allow-command run any command: the global agy toolPermission is always-proceed\n/);
  assert.match(setup.stdout, /\n  warning: Gemini read-only turns can search the web; --web is not offered for Gemini\n/);
  assert.equal(w.fakeCalls().length, 0, "setup submits nothing");
  const models = w.call(["models", "--to", "gemini", "--refresh"]);
  assert.equal(models.status, 0, models.stderr);
  assert.match(models.stdout, /^gemini \(refreshed [^)]+\)\n[\s\S]*  gemini-4-argon: low, medium, high\n/);
  assert.ok(!/claude-opus/.test(models.stdout), "only gemini- ids are routed");
  const ask = w.gemini(["ask", "--to", "gemini", "--request-id", "g1", "--", "q"]);
  assert.equal(ask.status, 0);
  const replay = w.gemini(["ask", "--to", "gemini", "--request-id", "g1", "--", "q"]);
  assert.equal(replay.status, 0);
  assert.equal(w.fakeCalls().length, 1, "a replay starts no agy");
  const job = jobIdOf(ask.stderr);
  assert.match(w.call(["wait", job]).stdout, /^pong\ncouncil gemini ok/);
  assert.match(w.call(["cancel", job]).stdout, /^finished · gemini · job [a-z0-9]{16}/);
});
