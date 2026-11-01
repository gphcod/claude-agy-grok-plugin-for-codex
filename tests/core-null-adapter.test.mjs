// S2.1: the null adapter's shape and the fake child's scenarios, exercised directly (the lifecycle arrives in S2.4).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import adapter, { FAKE_CHILD, catalog, tiers } from "./fixtures/null-adapter.mjs";
import { DEPTH_VARIABLES, depthEnv } from "../plugins/council/scripts/lib/core/host.mjs";

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "council-null-")));
const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(COUNCIL|CLAUDE|CODEX|GROK|AGY)/.test(k) && k !== "CLAUDECODE"));
const run = (args, { stdin = "", env = {}, timeout = 15000 } = {}) => {
  const r = spawnSync(process.execPath, [FAKE_CHILD, ...args], { cwd: dir, input: stdin, encoding: "utf8", timeout, env: { ...baseEnv, ...depthEnv(), ...env } });
  return { ...r, events: r.stdout.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return { RAW: l.length }; } }) };
};
const request = (overrides = {}) => ({ verb: "ask", prompt: "hello", model: "null-model", effort: "low", env: {}, jobDir: dir, resume: false, threadId: null, ...overrides });

test("the null adapter implements every A5 member with the documented return shapes", async () => {
  for (const key of ["id", "binEnv", "resolveLauncher", "trustsCleanExit", "ownsProcess", "maxLineBytes", "probe", "preflight", "catalog", "buildTurn", "beforeTurn", "afterTurn", "parseEvent", "reviewPlan", "finalizeReview"]) {
    assert.ok(key in adapter, key);
  }
  assert.equal(adapter.id, "null");
  assert.deepEqual(adapter.resolveLauncher({}), { command: process.execPath, args: [FAKE_CHILD], path: FAKE_CHILD, kind: "node-script" });
  assert.equal(adapter.trustsCleanExit(adapter.resolveLauncher({})), false);
  const probe = await adapter.probe(adapter.resolveLauncher({}));
  assert.deepEqual(probe, { version: "null 0.0.1", loggedIn: true, models: [{ id: "null-model", efforts: ["low", "medium", "high", "xhigh"] }, { id: "null-fast", efforts: ["low", "medium", "high"] }] });
  assert.deepEqual(adapter.preflight({ stateRoot: dir }).map((d) => d.kind), ["dir", "exec"]);
  assert.deepEqual(Object.keys(tiers), ["consult", "exec", "deep"]);
  assert.deepEqual(Object.keys(catalog.models), ["null-model", "null-fast"]);
  assert.deepEqual(adapter.reviewPlan({ batches: [1, 2] }, { adversarial: true }), { native: false, batches: [1, 2], promptTemplate: "adversarial-review", schemaCarrier: "inline" });
});

test("buildTurn follows the id, input and output profiles and sets all five guard variables", () => {
  const stdinTurn = adapter.buildTurn(request());
  assert.ok(stdinTurn.stdin === "hello" && !stdinTurn.promptFile && stdinTurn.answerFile === null);
  assert.match(stdinTurn.args[1], /^[0-9a-f-]{36}$/, "preassigned: a uuid before spawn");
  assert.equal(stdinTurn.requestedThreadId, stdinTurn.args[1]);
  for (const name of DEPTH_VARIABLES) assert.equal(stdinTurn.env[name], "1", name);
  assert.equal(stdinTurn.readOnly, true);
  const discovered = adapter.buildTurn(request({ env: { COUNCIL_NULL_ID: "discovered", COUNCIL_NULL_INPUT: "prompt-file", COUNCIL_NULL_OUTPUT: "answer-file" } }));
  assert.ok(!discovered.args.includes("--thread") && discovered.requestedThreadId === null);
  assert.equal(discovered.promptFile, path.join(dir, "prompt.md"));
  assert.equal(discovered.answerFile, path.join(dir, "answer.md"));
  assert.equal(discovered.stdin, undefined);
  const resumed = adapter.buildTurn(request({ resume: true, threadId: "t-1", verb: "task" }));
  assert.deepEqual(resumed.args.slice(0, 2), ["--thread", "t-1"]);
  assert.ok(resumed.args.includes("--edit") && resumed.readOnly === false);
  assert.ok(adapter.buildTurn(request({ verb: "review", schemaPath: "/s.json" })).args.includes("--schema"));
});

test("ownsProcess delegates to the operand check the core supplies", () => {
  const seen = [];
  const hasFlagOperand = (row, flag, value) => { seen.push([flag, value]); return row.argv?.includes(value) ?? false; };
  assert.equal(adapter.ownsProcess({ argv: ["node", "fake", "--thread", "t-1"] }, { requestedThreadId: "t-1" }, "linux", hasFlagOperand), true);
  assert.equal(adapter.ownsProcess({ argv: ["node", "fake", "--thread", "t-2"] }, { requestedThreadId: "t-1", promptFile: "/p" }, "linux", hasFlagOperand), false);
  assert.deepEqual(seen.map((s) => s[0]), ["--thread", "--prompt-file", "--thread"]);
});

test("parseEvent maps the child's protocol onto the A5 result shape and fails closed on garbage", () => {
  const state = {};
  assert.deepEqual(adapter.parseEvent('{"type":"start","thread":"t"}', state), { threadId: "t" });
  assert.deepEqual(adapter.parseEvent('{"type":"text","data":"hi"}', state), { textDelta: "hi" });
  assert.deepEqual(adapter.parseEvent('{"type":"tool","name":"edit","path":"a.js","ok":true}', state), { edited: "a.js", toolStep: "edit" });
  assert.deepEqual(adapter.parseEvent('{"type":"tool","name":"shell","command":"make","ok":false}', state), { failedCommand: "make" });
  assert.deepEqual(adapter.parseEvent('{"type":"tool","name":"edit","path":"b.js","ok":false,"denied":true}', state), { denied: { tool: "edit", path: "b.js" } });
  assert.deepEqual(adapter.parseEvent('{"type":"end","thread":"t","cost":0.5}', state), { completed: true, threadId: "t", costUsd: 0.5 });
  assert.deepEqual(adapter.parseEvent('{"type":"end","thread":"t","structured":{"verdict":"approve"}}', state).structured, { verdict: "approve" });
  assert.equal(adapter.parseEvent('{"type":"unknown"}', state), null);
  assert.deepEqual(adapter.parseEvent("not json", state), { fatal: "malformed event" });
  assert.deepEqual(adapter.parseEvent('{"x":1}', state), { fatal: "event without a type" });
});

test("fake child: ok, exit-nonzero, no-completion, fragmented-frames, huge-line, slow, fail-then-success, hold-pipes", async () => {
  const log = path.join(dir, "log.jsonl");
  const ok = run(["--thread", "t-1", "--model", "null-model", "--effort", "low"], { stdin: "hello", env: { COUNCIL_FAKE_LOG: log } });
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual(ok.events.map((e) => e.type), ["start", "text", "text", "end"]);
  assert.equal(ok.events.filter((e) => e.type === "text").map((e) => e.data).join(""), "fake answer to: hello");
  assert.equal(ok.events.at(-1).thread, "t-1");
  const logged = JSON.parse(fs.readFileSync(log, "utf8").split("\n").filter(Boolean).at(-1));
  assert.equal(logged.prompt, "hello");
  for (const name of DEPTH_VARIABLES) assert.equal(logged.depth[name], "1");
  assert.equal(run(["--version"]).stdout.trim(), "null 0.0.1");
  assert.match(run(["models"]).stdout, /null-model/);
  const discovered = run(["--model", "null-model", "--effort", "low", "--prompt-file", (fs.writeFileSync(path.join(dir, "p.txt"), "from file"), path.join(dir, "p.txt")), "--answer-file", path.join(dir, "a.md")]);
  assert.equal(discovered.status, 0);
  assert.deepEqual(discovered.events.map((e) => e.type), ["start", "end"], "answer-file output streams no text");
  assert.match(discovered.events[0].thread, /^discovered-\d+$/);
  assert.equal(fs.readFileSync(path.join(dir, "a.md"), "utf8"), "fake answer to: from file");
  const nonzero = run(["--thread", "t"], { scenario: 1, env: { COUNCIL_FAKE_SCENARIO: "exit-nonzero" } });
  assert.equal(nonzero.status, 3);
  assert.deepEqual(nonzero.events.map((e) => e.type), ["start"]);
  const incomplete = run(["--thread", "t"], { env: { COUNCIL_FAKE_SCENARIO: "no-completion" } });
  assert.equal(incomplete.status, 0);
  assert.ok(!incomplete.events.some((e) => e.type === "end"));
  const frag = run(["--thread", "t"], { env: { COUNCIL_FAKE_SCENARIO: "fragmented-frames" } });
  assert.deepEqual(frag.events.map((e) => e.type), ["start", "text", "text", "end"], "byte-at-a-time writes still form whole lines");
  const huge = run(["--thread", "t"], { env: { COUNCIL_FAKE_SCENARIO: "huge-line", COUNCIL_FAKE_HUGE_BYTES: "70000" } });
  assert.ok(huge.events.some((e) => e.type === "text" && e.data.length === 70000));
  const started = Date.now();
  const slow = run(["--thread", "t"], { env: { COUNCIL_FAKE_SCENARIO: "slow", COUNCIL_FAKE_SLOW_MS: "500" } });
  assert.equal(slow.status, 0);
  assert.ok(Date.now() - started >= 500);
  const log2 = path.join(dir, "log2.jsonl");
  const first = run(["--thread", "t"], { env: { COUNCIL_FAKE_SCENARIO: "fail-then-success", COUNCIL_FAKE_LOG: log2 } });
  const second = run(["--thread", "t"], { env: { COUNCIL_FAKE_SCENARIO: "fail-then-success", COUNCIL_FAKE_LOG: log2 } });
  assert.deepEqual([first.status, second.status], [3, 0]);
  assert.ok(second.events.some((e) => e.type === "end"));
  const edits = run(["--thread", "t", "--edit"], { env: { COUNCIL_FAKE_EDITS: "a.js,b.js", COUNCIL_FAKE_FAILED_COMMAND: "make", COUNCIL_FAKE_DENY: "c.js" } });
  assert.deepEqual(edits.events.filter((e) => e.type === "tool").map((e) => [e.name, e.path ?? e.command, e.ok]), [["edit", "a.js", true], ["edit", "b.js", true], ["shell", "make", false], ["edit", "c.js", false]]);
  const child = spawn(process.execPath, [FAKE_CHILD, "--thread", "t"], { cwd: dir, env: { ...baseEnv, ...depthEnv(), COUNCIL_FAKE_SCENARIO: "hold-pipes", COUNCIL_FAKE_HOLD_MS: "1200" }, stdio: ["pipe", "pipe", "pipe"] });
  child.stdin.end("x");
  let out = "";
  child.stdout.on("data", (c) => { out += c; });
  const exited = await new Promise((resolve) => child.on("exit", (code) => resolve({ code, at: Date.now() })));
  const closed = await new Promise((resolve) => child.on("close", () => resolve(Date.now())));
  assert.equal(exited.code, 0);
  assert.ok(closed - exited.at >= 900, `stdout stayed open ${closed - exited.at} ms after exit`);
  assert.match(out, /"type":"end"/);
});
