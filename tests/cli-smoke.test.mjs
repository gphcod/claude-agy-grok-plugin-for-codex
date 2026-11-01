// S2.6: the entry's surface: help, usage errors, guards, scoping of flags, the no-stdin rule, unavailable providers,
// and a replay that bypasses preflight.
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { ENTRY, makeWorld, jobIdOf, footerOf, built, BINARY } from "./helpers.mjs";
import { DEPTH_VARIABLES } from "../plugins/council/scripts/lib/core/host.mjs";

test("--help prints the usage line and exits 0; no verb, an unknown verb or an unknown flag exits 2 with the usage", () => {
  const w = makeWorld({ git: false });
  const help = w.call(["--help"]);
  assert.deepEqual([help.status, help.stdout.trim()], [0, "usage: council.mjs <ask|reply|review|task|wait|cancel|models|setup> [--to claude|gemini|grok] [--options] [-- text, or text on stdin]"]);
  for (const args of [[], ["rescue"], ["ask", "--bogus"], ["ask", "--tier"]]) {
    const r = w.call(args);
    assert.equal(r.status, 2, args.join(" "));
    assert.match(r.stderr, /usage: council\.mjs|Missing value for --tier/, args.join(" "));
  }
  const json = w.call(["ask", "--bogus", "--json"]);
  assert.deepEqual(JSON.parse(json.stdout), { status: "failed", exit: 2, error: "Unknown option --bogus. Put -- before the text if it starts with a dash." });
});

test("ask, review and task need --to; an unknown provider and a provider this build lacks exit 2 before anything runs", () => {
  const w = makeWorld();
  for (const verb of ["ask", "task"]) assert.match(w.call([verb, "--", "q"]).stderr, new RegExp(`${verb} needs --to claude\\|gemini\\|grok`));
  assert.equal(w.call(["review"]).status, 2);
  assert.match(w.call(["ask", "--to", "openai", "--", "q"]).stderr, /unknown provider "openai"/);
  for (const provider of ["claude", "gemini", "grok"]) {
    // PATH is empty so a provider this build ships finds no binary (exit 1, nothing started) and no real CLI is ever called.
    const r = w.call(["ask", "--to", provider, "--", "q"], { env: { PATH: "" } });
    if (built(provider)) assert.deepEqual([r.status, r.stderr.trim()], [1, `council: ${provider} not found: install its CLI or set ${BINARY[provider][1]}`]);
    else assert.deepEqual([r.status, r.stderr.trim()], [2, `council: provider ${provider} not available in this build`]);
  }
  const off = w.call(["ask", "--to", "null", "--", "q"], { env: { COUNCIL_TEST_NULL_ADAPTER: "" } });
  assert.match(off.stderr, /unknown provider "null"/, "the null adapter exists only under COUNCIL_TEST_NULL_ADAPTER=1");
  assert.equal(w.fakeCalls().length + w.probes().length, 0);
  assert.ok(!fs.existsSync(path.join(w.home, "jobs")) || fs.readdirSync(path.join(w.home, "jobs")).length === 0, "no job was created");
});

test("the depth guard refuses a nested call for each of the five variables with exit 1 and starts nothing", () => {
  const w = makeWorld();
  for (const name of DEPTH_VARIABLES) {
    const r = w.call(["ask", "--to", "null", "--", "q"], { env: { [name]: "1" } });
    assert.equal(r.status, 1, name);
    assert.match(r.stderr, new RegExp(`refusing a nested call: ${name} set`));
  }
  assert.equal(w.call(["wait"], { env: { COUNCIL_DEPTH: "1" } }).status, 1, "control verbs are guarded too");
  assert.equal(w.fakeCalls().length, 0);
});

test("a state root inside the workspace is refused with exit 1 before any record is written", () => {
  const w = makeWorld();
  const inside = path.join(w.workspace, ".council-state");
  const r = w.call(["ask", "--to", "null", "--", "q"], { env: { COUNCIL_CODEX_HOME: inside } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /the state root .*\.council-state lies inside the workspace .*; set COUNCIL_CODEX_HOME to a directory outside it/);
  assert.ok(!fs.existsSync(path.join(inside, "jobs")));
  const sub = path.join(w.workspace, "pkg");
  fs.mkdirSync(sub);
  assert.equal(w.call(["wait"], { cwd: sub, env: { COUNCIL_CODEX_HOME: path.join(sub, "state") } }).status, 1, "inside a subdirectory workspace too");
  assert.equal(w.call(["wait"], { cwd: sub, env: { COUNCIL_CODEX_HOME: inside } }).status, 0, "the workspace is realpath(cwd), not the Git root (A7.1)");
  const elsewhere = path.join(w.dir, "elsewhere");
  fs.mkdirSync(elsewhere);
  assert.equal(w.call(["wait", "--cwd", elsewhere], { env: { COUNCIL_CODEX_HOME: inside } }).status, 0, "--cwd moves the workspace");
  assert.equal(w.call(["wait"], { cwd: elsewhere, env: { COUNCIL_CODEX_HOME: inside } }).status, 0);
  assert.equal(w.call(["wait", "--cwd", w.workspace], { cwd: elsewhere, env: { COUNCIL_CODEX_HOME: inside } }).status, 1, "and --cwd into the workspace is guarded");
});

test("verb-scoped and provider-scoped flags exit 2 elsewhere", () => {
  const w = makeWorld();
  const cases = [[["ask", "--to", "null", "--next-input"], /--next-input is not accepted by ask/], [["ask", "--to", "null", "--base", "main", "--", "q"], /--base is not accepted by ask/],
    [["review", "--to", "null", "--refresh"], /--refresh is not accepted by review/], [["wait", "--live"], /--live is not accepted by wait/],
    [["ask", "--to", "null", "--confirm-ended", "--", "q"], /--confirm-ended is not accepted by ask/], [["ask", "--to", "null", "--max-turns", "3", "--", "q"], /--max-turns applies only to claude/],
    [["task", "--to", "grok", "--allow-command", "node x", "--", "q"], /--allow-command applies only to gemini/], [["ask", "--to", "gemini", "--allow-command", "x", "--", "q"], /--allow-command is not accepted by ask/],
    [["ask", "--to", "gemini", "--web", "--", "q"], /--web is not offered for gemini/], [["ask", "--to", "claude", "--max-turns", "0", "--", "q"], /--max-turns needs a positive integer/],
    [["ask", "--to", "claude", "--max-turns", "101", "--", "q"], /--max-turns accepts 1 to 100/], [["ask", "--to", "null", "--rounds", "0", "--", "q"], /--rounds needs a positive integer/],
    [["ask", "--to", "null", "--request-id", "bad id", "--", "q"], /--request-id needs 1 to 128/], [["reply", "--last", "--thread", "x", "--", "q"], /give --last or a thread, not both/],
    [["ask", "--to", "null", "--deadline", "NaN", "--", "q"], /--deadline needs a finite positive number/], [["review", "--to", "null", "--base", "main", "--commit", "HEAD"], /give one of --base, --commit or --uncommitted/],
    [["wait", "a", "b"], /wait accepts one job/], [["models", "--to", "null", "--", "text"], /models takes no text/]];
  for (const [args, pattern] of cases) {
    const r = w.call(args);
    assert.equal(r.status, 2, `${args.join(" ")}: ${r.stderr}`);
    assert.match(r.stderr, pattern, args.join(" "));
  }
  assert.equal(w.fakeCalls().length, 0);
});

test("bare review, --next-input and the control verbs never wait on an open stdin; --next-input with text exits 2", async () => {
  const w = makeWorld();
  fs.writeFileSync(path.join(w.workspace, "README.md"), "# changed\n");
  const open = (args) => new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [ENTRY, ...args], { cwd: w.workspace, env: { ...w.env, COUNCIL_STDIN_DEADLINE_MS: "8000" }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (c) => { stdout += c; });
    child.stderr.on("data", (c) => { stderr += c; });
    child.on("close", (status) => { child.stdin.destroy(); resolve({ status, stdout, stderr, ms: Date.now() - started }); });
  });
  const results = await Promise.all([open(["review", "--to", "null"]), open(["wait"]), open(["cancel"]), open(["models", "--to", "null"]), open(["setup", "--to", "null"])]);
  for (const r of results) {
    assert.ok([0, 10].includes(r.status), r.stdout + r.stderr);
    assert.ok(r.ms < 7000, `returned after ${r.ms} ms without waiting for stdin`);
  }
  const job = jobIdOf(results[0].stderr);
  const next = w.call(["reply", job, "--next-input", "--", "more"]);
  assert.equal(next.status, 2);
  assert.match(next.stderr, /--next-input accepts no text/);
  const silent = await open(["ask", "--to", "null"]);
  assert.equal(silent.status, 2, "an ask with no text anywhere is refused after the stdin deadline");
  assert.match(silent.stderr, /stdin stayed open for 8 s with no input/);
});

test("a replay bypasses preflight: a finished request with a now-blocked descriptor prints its first result and probes nothing", () => {
  const w = makeWorld();
  const first = w.call(["ask", "--to", "null", "--request-id", "r1", "--", "q"]);
  assert.equal(first.status, 0, first.stderr);
  const probes = w.probes().length, calls = w.fakeCalls().length;
  const blocked = path.join(w.dir, "missing-login.json");
  const direct = w.call(["ask", "--to", "null", "--", "other"], { env: { COUNCIL_NULL_PREFLIGHT_BLOCK: blocked } });
  assert.equal(direct.status, 1);
  assert.match(direct.stderr, /^council: preflight_blocked: null login file \(file .*missing-login\.json\): read access is missing \(ENOENT\)\naction: Grant read access to .*missing-login\.json; the host sandbox blocks it\.\n$/);
  const json = JSON.parse(w.call(["ask", "--to", "null", "--json", "--", "other"], { env: { COUNCIL_NULL_PREFLIGHT_BLOCK: blocked } }).stdout);
  assert.deepEqual([json.status, json.exit], ["preflight_blocked", 1]);
  assert.match(json.action, /Grant read access/);
  const replayed = w.call(["ask", "--to", "null", "--request-id", "r1", "--", "q"], { env: { COUNCIL_NULL_PREFLIGHT_BLOCK: blocked } });
  assert.equal(replayed.status, 0, replayed.stderr);
  assert.equal(footerOf(replayed.stdout), footerOf(first.stdout));
  assert.equal(replayed.stderr, "", "a replay prints no start line");
  assert.deepEqual([w.probes().length, w.fakeCalls().length], [probes, calls], "zero submissions while blocked, zero processes for the replay");
});

test("COUNCIL_TEST_ABSENT_PROVIDERS hides a shipped provider only under COUNCIL_TEST_NULL_ADAPTER=1, and no test world can reach a real CLI", () => {
  const w = makeWorld();
  for (const provider of ["claude", "gemini", "grok"]) {
    const hidden = w.call(["ask", "--to", provider, "--", "q"], { env: { COUNCIL_TEST_ABSENT_PROVIDERS: `x,${provider}` } });
    assert.deepEqual([hidden.status, hidden.stderr.trim()], [2, `council: provider ${provider} not available in this build`]);
    const r = w.call(["ask", "--to", provider, "--", "q"], { env: { COUNCIL_TEST_ABSENT_PROVIDERS: provider, COUNCIL_TEST_NULL_ADAPTER: "" } });
    if (built(provider)) assert.deepEqual([r.status, r.stderr.trim()], [1, `council: ${provider} not found: install its CLI or set ${BINARY[provider][1]}`], "the seam is inert outside tests; the world's binary override names a missing file");
    else assert.equal(r.status, 2);
  }
  assert.equal(w.fakeCalls().length + w.probes().length, 0);
});
