// S5.1–S5.4: the Gemini adapter at module level: launcher, ownership, probe, preflight descriptors, request refusals,
// the settings file, the launch arguments and stdin, the event mapping over the S1.2 streams, the snapshot hooks and the
// review plan. The entry-level cases against fake-agy are in tests/gemini.test.mjs.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import gemini, * as G from "../plugins/council/scripts/lib/providers/gemini.mjs";
import { assertAdapter } from "../plugins/council/scripts/lib/core/types.mjs";
import { hasFlagOperand } from "../plugins/council/scripts/lib/core/execution.mjs";
import { createReader } from "../plugins/council/scripts/lib/core/reader.mjs";
import { DEPTH_VARIABLES } from "../plugins/council/scripts/lib/core/host.mjs";

const { configuredPolicy, sessionSettings, reviewInputRule, printTimeout, stdinMessage, snapshot, workspace, changes, allowCommandProblem, READ_ONLY_DENY, READ_ONLY_COMMANDS, WINDOWS_QUALIFIED, LIMIT } = G;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FAKE = path.join(ROOT, "tests", "fixtures", "fake-agy.mjs");
const CONTRACT = path.join(ROOT, "plugins", "council", "contract.md");
const SCHEMA = path.join(ROOT, "plugins", "council", "schemas", "review-output.schema.json");
const STREAMS = JSON.parse(fs.readFileSync(path.join(ROOT, "tests", "fixtures", "streams", "agy.json"), "utf8"));
const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "council-gemini-")));
const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(COUNCIL|CLAUDE|CODEX|GROK|AGY)/.test(k)));
/** A HOME with an optional global agy settings file. */
function home(global) {
  const dir = tmp();
  if (global !== undefined) {
    fs.mkdirSync(path.join(dir, ".gemini", "antigravity-cli"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".gemini", "antigravity-cli", "settings.json"), typeof global === "string" ? global : JSON.stringify(global));
  }
  return dir;
}
/** buildTurn refuses on Windows as a backstop to checkRequest (A8); the cases that build a launch run elsewhere. */
const buildsHere = {};
const launcher = () => gemini.resolveLauncher({ COUNCIL_AGY_BIN: FAKE });
/** A TurnRequest as the entry builds it. */
function request(extra = {}) {
  const dir = extra.home ?? home();
  const jobDir = path.join(dir, "job");
  fs.mkdirSync(jobDir, { recursive: true });
  return { verb: "ask", nextInput: false, text: "q", prompt: "q", instructions: "Instructions for this turn (advice, read-only)", contractPath: CONTRACT, model: "gemini-4-argon",
    effort: "high", resume: false, threadId: null, cwd: dir, env: { PATH: process.env.PATH, HOME: dir }, launcher: launcher(), schemaPath: null, structured: false, readOnly: true,
    web: false, allowCommands: [], maxTurns: null, maxBudgetUsd: null, policy: { version: "default-v1", readRoots: [], web: false, allowMcp: false }, agent: null, jobDir,
    deadlineMs: 14400 * 1000, ...extra };
}
const settingsOf = (built) => JSON.parse(fs.readFileSync(built.args[built.args.indexOf("--settings") + 1], "utf8"));
const flag = (args, name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const fill = (events, id = "conv-1") => events.map((e) => JSON.stringify(e).replaceAll("<CONVERSATION>", id));
/** Runs lines through the core reader with the adapter, as the lifecycle does. */
function read(lines, { readOnly = true, expectedThreadId = null } = {}) {
  let text = "";
  const reader = createReader(gemini, { cwd: "/repo", expectedThreadId, onText: (t) => { text += t; } });
  Object.assign(reader.state.adapter, { readOnly, agent: null });
  for (const line of lines) reader.feed(`${line}\n`);
  reader.end();
  return { ...reader.state, text };
}
const git = (cwd, ...args) => spawnSync("git", args, { cwd, encoding: "utf8" });
function repo() {
  const dir = tmp();
  git(dir, "init", "-q", "-b", "main");
  for (const [k, v] of [["user.name", "t"], ["user.email", "t@example.com"], ["commit.gpgsign", "false"]]) git(dir, "config", k, v);
  fs.writeFileSync(path.join(dir, "a.txt"), "a\n");
  git(dir, "add", "a.txt"); git(dir, "commit", "-qm", "a");
  return dir;
}
const jobIn = (dir, fields = {}) => { const jobDir = path.join(tmp(), "job"); fs.mkdirSync(jobDir); return { dir: jobDir, cwd: dir, verb: "ask", readOnly: true, ...fields }; };

// ---------------------------------------------------------------------------------------------------------------- S5.1

test("S5.1 the module implements the frozen adapter interface with binEnv COUNCIL_AGY_BIN and the static Gemini catalog", () => {
  assert.equal(assertAdapter(gemini, "gemini"), gemini);
  assert.deepEqual([gemini.id, gemini.binEnv, gemini.maxLineBytes, gemini.trustsCleanExit(launcher())], ["gemini", "COUNCIL_AGY_BIN", 4 * 1024 * 1024, false]);
  assert.deepEqual(gemini.catalog.families["gemini-4-argon"], ["low", "medium", "high"]);
  assert.equal(typeof gemini.checkRequest, "function");
});

test("S5.1 launcher: COUNCIL_AGY_BIN wins (a .mjs runs through node); without it and without agy on PATH there is none", () => {
  assert.deepEqual(launcher(), { command: process.execPath, args: [FAKE], path: FAKE, kind: "node-script" });
  assert.equal(gemini.resolveLauncher({ PATH: "" }), null);
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "agy"), "#!/bin/sh\necho 1.4.12\n", { mode: 0o755 });
  if (process.platform !== "win32") assert.deepEqual(gemini.resolveLauncher({ PATH: dir }, "darwin"), { command: path.join(dir, "agy"), args: [], path: path.join(dir, "agy"), kind: "native" }); // A POSIX PATH splits on the colon of a Windows drive.
});

test("S5.1 ownership is the job's own --settings operand, so two concurrent jobs never cross-match", () => {
  const a = { childArgs: ["--input-format", "stream-json", "--settings", "/state/jobs/aaaa/settings.json", "--model", "gemini-4-argon"] };
  const b = { childArgs: ["--settings", "/state/jobs/bbbb/settings.json"] };
  const rowA = { argv: ["agy", ...a.childArgs] };
  const rawA = { raw: `/Users/x/.local/bin/agy ${a.childArgs.join(" ")}` };
  assert.equal(gemini.ownsProcess(rowA, a, "linux", hasFlagOperand), true);
  assert.equal(gemini.ownsProcess(rowA, b, "linux", hasFlagOperand), false);
  assert.equal(gemini.ownsProcess(rawA, a, "darwin", hasFlagOperand), true);
  assert.equal(gemini.ownsProcess(rawA, b, "darwin", hasFlagOperand), false);
  assert.equal(gemini.ownsProcess({ raw: "agy --settings /state/jobs/aaaa/settings.json.bak" }, a, "darwin", hasFlagOperand), false, "a longer operand is another file");
  assert.equal(gemini.ownsProcess(rowA, { childArgs: [] }, "linux", hasFlagOperand), false, "no recorded operand, no ownership");
  assert.equal(gemini.ownsProcess({ argv: ["agy", "language_server"] }, a, "linux", hasFlagOperand), false, "the language server is followed through the group, not by argv");
});

test("S5.1 probe: --version and models (login evidence) through the fake, Gemini ids only, and setup warnings", async () => {
  const env = (extra = {}, global) => { const dir = home(global); return { ...baseEnv, HOME: dir, USERPROFILE: dir, ...extra }; };
  const ok = await gemini.probe(launcher(), env({}, { toolPermission: "request-review" }), "darwin");
  assert.deepEqual([ok.version, ok.loggedIn, ok.warnings], ["1.4.12", true, []]);
  const ids = ok.models.map((m) => m.id);
  assert.ok(ids.includes("gemini-4-argon") && ids.includes("gemini-3.8-flash-low") && !ids.some((id) => id.startsWith("claude")));
  assert.deepEqual(ok.models.find((m) => m.id === "gemini-4-argon").efforts, ["low", "medium", "high"]);
  const proceed = await gemini.probe(launcher(), env({}, { toolPermission: "always-proceed" }), "darwin");
  assert.deepEqual(proceed.warnings, ["Gemini tasks without --allow-command run any command: the global agy toolPermission is always-proceed"]);
  assert.deepEqual((await gemini.probe(launcher(), env({}, { toolPermission: "strict" }), "darwin")).warnings, []);
  assert.deepEqual((await gemini.probe(launcher(), env(), "darwin")).warnings, [], "no global settings file");
  assert.match((await gemini.probe(launcher(), env({}, "{oops"), "darwin")).warnings[0], /global agy settings unreadable, so no Gemini turn can start: .*invalid JSON/);
  assert.deepEqual((await gemini.probe(launcher(), env(), "win32")).warnings, [], "Windows is qualified (A8)");
  const out = await gemini.probe(launcher(), env({ COUNCIL_FAKE_LOGGED_OUT: "1" }), "darwin");
  assert.deepEqual([out.loggedIn, out.models], [false, null]);
});

test("S5.1 preflight: state root (write, first since S1.4), agy state (write), loopback listener, process table, the two cold probes, network; the same on win32", () => {
  const h = home();
  const list = gemini.preflight({ stateRoot: "/state", env: { HOME: h, USERPROFILE: h, COUNCIL_AGY_BIN: FAKE }, platform: "darwin", verb: "ask", cwd: h });
  assert.deepEqual(list.map((d) => d.kind), ["dir", "dir", "listener", "process-table", "exec", "exec", "network"]);
  assert.deepEqual([list[0].target, list[0].access, list[1].target, list[1].access, list[2].target], ["/state", "write", path.join(h, ".gemini", "antigravity-cli"), "write", "127.0.0.1"]);
  assert.deepEqual(list[4].target.args, [FAKE, "--version"]);
  assert.deepEqual(list[5].target.args, [FAKE, "models"]);
  for (const d of list) assert.ok(d.why && d.action, `${d.kind} carries why and an action line`);
  assert.equal(gemini.preflight({ stateRoot: "/s", env: { HOME: h, COUNCIL_AGY_LISTEN_HOST: "192.0.2.1", PATH: "" }, platform: "darwin" }).find((d) => d.kind === "listener").target, "192.0.2.1");
  assert.ok(!gemini.preflight({ stateRoot: "/s", env: { HOME: h, PATH: "" }, platform: "darwin" }).some((d) => d.kind === "exec"), "no binary, no probe descriptors");
  const windows = gemini.preflight({ stateRoot: "/s", env: { HOME: h, USERPROFILE: h, PATH: "" }, platform: "win32" });
  assert.deepEqual(windows.map((d) => d.kind), ["dir", "dir", "listener", "process-table", "network"], "Windows is qualified (A8)");
  assert.equal(windows[3].target, "powershell Win32_Process");
  assert.deepEqual([windows[4].tlsRefusalPasses, list.at(-1).tlsRefusalPasses], [true, undefined], "the stand-in target is lenient on Windows only");
});

test("S5.1 checkRequest: Windows (A8), --web, --allow-command outside a task or malformed; a task's allow-command passes", () => {
  const r = (extra) => ({ verb: "ask", web: false, allowCommands: [], ...extra });
  assert.equal(WINDOWS_QUALIFIED, true, "docs/qualification/windows.md records the session");
  assert.equal(gemini.checkRequest(r({}), {}, "win32"), null);
  assert.equal(gemini.checkRequest(r({ verb: "task" }), {}, "win32"), null);
  assert.equal(gemini.checkRequest(r({}), {}, "darwin"), null);
  assert.match(gemini.checkRequest(r({ web: true }), {}, "darwin"), /--web is not offered for gemini/);
  for (const verb of ["ask", "reply", "review"]) assert.match(gemini.checkRequest(r({ verb, allowCommands: ["node x"] }), {}, "darwin"), /applies only to task --to gemini/);
  assert.equal(gemini.checkRequest(r({ verb: "task", allowCommands: ["node check.mjs", "npm test"] }), {}, "linux"), null);
  assert.match(gemini.checkRequest(r({ verb: "task", allowCommands: ["node -e f()"] }), {}, "darwin"), /parentheses/);
  assert.match(allowCommandProblem("a\nb"), /one line/);
  assert.match(allowCommandProblem("  "), /non-empty/);
});

// ---------------------------------------------------------------------------------------------------------------- S5.2

test("S5.2 settings: read-only turns filter allow, permit inspection and keep denies and keep global denies; strict is kept, anything else becomes request-review", () => {
  const global = { permissions: { allow: ["run_command(*)", "command(which)", "read_file(src/*)", "read_url(https://x/*)"], ask: ["mcp(foo)"], deny: ["read_file(secret/*)", "command(*)"] }, toolPermission: "always-proceed" };
  const ro = sessionSettings({ readOnly: true }, global);
  assert.deepEqual(ro, { permissions: { allow: ["read_file(src/*)", "read_url(https://x/*)", ...READ_ONLY_COMMANDS], ask: ["mcp(foo)"], deny: ["read_file(secret/*)", "command(*)", ...READ_ONLY_DENY.filter((r) => r !== "command(*)")] },
    agentMode: "", toolPermission: "request-review" });
  assert.equal(sessionSettings({ readOnly: true }, { ...global, toolPermission: "strict" }).toolPermission, "strict");
  assert.deepEqual(sessionSettings({ readOnly: true }, {}).permissions, { allow: READ_ONLY_COMMANDS, ask: [], deny: READ_ONLY_DENY });
});

test("S5.2 settings: tasks keep the global lists; --allow-command adds the pair and forces request-review unless strict; without it the global value stays", () => {
  const global = { permissions: { allow: ["command(which)"], ask: [], deny: ["write_file(*.lock)"] }, toolPermission: "always-proceed" };
  assert.deepEqual(sessionSettings({ readOnly: false }, global), { permissions: { allow: ["command(which)", "command(*)"], ask: [], deny: ["write_file(*.lock)"] }, toolPermission: "always-proceed" });
  assert.deepEqual(sessionSettings({ readOnly: false, allowCommands: ["node check.mjs"] }, global),
    { permissions: { allow: ["command(which)", "command(*)", "command(node check.mjs)", "unsandboxed(node check.mjs)"], ask: [], deny: ["write_file(*.lock)"] }, toolPermission: "request-review" });
  assert.equal(sessionSettings({ readOnly: false, allowCommands: ["x"] }, { ...global, toolPermission: "strict" }).toolPermission, "strict");
  assert.equal(sessionSettings({ readOnly: false }, { permissions: {} }).toolPermission, undefined, "no global value: agy's own default");
  assert.equal(sessionSettings({ readOnly: false }, {}).agentMode, undefined, "agentMode is set only on read-only turns");
});

test("efficient shell defaults preserve explicit policy and do not leak task grants into replies", () => {
  const policy = { permissions: { allow: ["read_file(src)"] , ask: ["command(git push)"], deny: ["command(rm)", "command(*)"] }, toolPermission: "strict" };
  const before = JSON.stringify(policy);
  const task = sessionSettings({ readOnly: false }, policy);
  assert.ok(task.permissions.allow.includes("command(*)"));
  assert.deepEqual(task.permissions.ask, ["command(git push)"]);
  assert.deepEqual(task.permissions.deny, ["command(rm)", "command(*)"]);
  assert.equal(task.toolPermission, "strict");
  const reply = sessionSettings({ readOnly: true }, policy);
  assert.ok(reply.permissions.allow.includes("command(git status)"));
  assert.ok(reply.permissions.allow.includes("command(rg)"));
  assert.ok(!reply.permissions.allow.includes("command(*)"));
  assert.ok(reply.permissions.deny.includes("command(*)"), "a user deny is retained even though the wrapper no longer inserts it");
  assert.deepEqual(reply.permissions.ask, policy.permissions.ask);
  assert.equal(reply.toolPermission, "strict");
  assert.equal(JSON.stringify(policy), before);
  const defaults = sessionSettings({ readOnly: true });
  assert.ok(!defaults.permissions.deny.includes("command(*)"));
  assert.ok(defaults.permissions.deny.includes("write_file(*)"));
});

test("S5.2 configuredPolicy reads only permissions and toolPermission; a broken global file stops the turn", buildsHere, () => {
  const h = home({ permissions: { allow: ["command(ls)"] }, toolPermission: "strict", apiKey: "secret", model: "x" });
  assert.deepEqual(configuredPolicy(path.join(h, ".gemini", "antigravity-cli", "settings.json")), { permissions: { allow: ["command(ls)"], ask: [], deny: [] }, toolPermission: "strict" });
  assert.deepEqual(configuredPolicy(path.join(tmp(), "missing.json")), {});
  assert.throws(() => configuredPolicy(path.join(home("[1]"), ".gemini", "antigravity-cli", "settings.json")), /must contain a JSON object/);
  assert.throws(() => configuredPolicy(path.join(home({ permissions: { deny: "x" } }), ".gemini", "antigravity-cli", "settings.json")), /permissions\.deny must be a string array/);
  assert.throws(() => gemini.buildTurn(request({ home: home("{") })), /invalid JSON; no turn submitted/);
});

test("S5.2 buildTurn: a read-only ask carries the exact A5.1 flag set, the job's settings file and one NDJSON message", buildsHere, () => {
  const h = home({ permissions: { allow: ["run_command(*)"], deny: ["read_file(.env)"] }, toolPermission: "always-proceed" });
  const req = request({ home: h, deadlineMs: 90000 });
  const built = gemini.buildTurn(req);
  const settingsPath = path.join(req.jobDir, "settings.json");
  assert.deepEqual(built.args, ["--input-format", "stream-json", "--output-format", "stream-json", "--disable-slash-commands", "--print-timeout", "87s", "--sandbox", "--settings", settingsPath,
    "--model", "gemini-4-argon", "--effort", "high"]);
  assert.deepEqual(settingsOf(built), { permissions: { allow: READ_ONLY_COMMANDS, ask: [], deny: ["read_file(.env)", ...READ_ONLY_DENY] }, agentMode: "", toolPermission: "request-review" });
  if (process.platform !== "win32") assert.equal(fs.statSync(settingsPath).mode & 0o777, 0o600); // Windows has no such mode bits.
  assert.deepEqual([built.readOnly, built.requestedThreadId, built.answerFile, built.contractCarrier, built.agent], [true, null, null, "stdin", null]);
  const lines = built.stdin.split("\n");
  assert.deepEqual([lines.length, lines[1]], [2, ""]);
  const message = JSON.parse(lines[0]);
  assert.equal(message.event, "user");
  const contract = fs.readFileSync(CONTRACT, "utf8").trimEnd();
  assert.equal(message.message.content, `${contract}\n\nInstructions for this turn (advice, read-only)\n\nq`, "contract, then the turn's instructions, then the text");
  for (const name of DEPTH_VARIABLES) assert.equal(built.env[name], "1");
  assert.equal(built.env.HOME, h);
  assert.equal(built.env.TERM_PROGRAM_SECRET, undefined, "the child environment is the request's, never process.env");
});

test("S5.2 buildTurn: model and effort rules, --conversation on resumes, --json-schema on structured turns, --mode only on tasks", buildsHere, () => {
  const args = (extra) => gemini.buildTurn(request(extra)).args;
  const suffixed = args({ model: "gemini-4-argon-low", effort: "low" });
  assert.deepEqual([flag(suffixed, "--model"), suffixed.includes("--effort")], ["gemini-4-argon-low", false], "a suffixed id travels alone");
  assert.deepEqual([flag(args({ model: "gemini-3.8-flash", effort: "medium" }), "--effort")], ["medium"]);
  const unknown = args({ model: "gemini-4-argon-xhigh", effort: "xhigh" });
  assert.deepEqual([flag(unknown, "--model"), flag(unknown, "--effort")], ["gemini-4-argon-xhigh", "xhigh"], "an id the family does not offer is passed through, agy decides");
  const reply = args({ verb: "reply", resume: true, threadId: "conv-9" });
  assert.equal(flag(reply, "--conversation"), "conv-9");
  assert.ok(!args({}).includes("--conversation"));
  const review = args({ verb: "review", structured: true, schemaPath: SCHEMA, instructions: null });
  assert.deepEqual([flag(review, "--json-schema"), review.includes("--mode")], [SCHEMA, false]);
  for (const verb of ["ask", "reply", "review"]) assert.ok(!args({ verb }).includes("--mode"), `${verb} never gets --mode`);
  const task = gemini.buildTurn(request({ verb: "task", readOnly: false, allowCommands: ["node check.mjs"] }));
  assert.deepEqual([flag(task.args, "--mode"), task.readOnly], ["accept-edits", false]);
  assert.deepEqual(settingsOf(task).permissions.allow, ["command(*)", "command(node check.mjs)", "unsandboxed(node check.mjs)"]);
  assert.ok(!task.args.includes("--allow-command"), "--allow-command is never forwarded to agy");
  assert.ok(!gemini.buildTurn(request({ verb: "task", readOnly: false })).args.includes("--sandbox"), "authorized tasks can execute workspace tools outside agy terminal sandbox");
});

test("S5.2 the print timeout follows the deadline less a margin; the review prompt carries no separate instructions", () => {
  assert.deepEqual([printTimeout(90000), printTimeout(6000), printTimeout(14400000), printTimeout(100)], ["87s", "4s", "14397s", "0.1s"]);
  assert.equal(printTimeout(), "14397s");
  const content = JSON.parse(stdinMessage({ contractPath: CONTRACT, instructions: null, prompt: "Instructions for this turn (structured code review" })).message.content;
  assert.ok(content.endsWith("\n\nInstructions for this turn (structured code review"));
});

// ---------------------------------------------------------------------------------------------------------------- S5.3

test("S5.3 ok and resume: the conversation id from init and result, the response as the answer, usage summed per turn", () => {
  const ok = read(fill(STREAMS.ok));
  assert.deepEqual([ok.threadId, ok.completed, ok.failed, ok.text, ok.denials.length], ["conv-1", true, null, "pong\n", 0]);
  assert.equal(ok.usage.input_tokens, 7686);
  const resume = read(fill(STREAMS.resume, "conv-2"), { expectedThreadId: "conv-2" });
  assert.deepEqual([resume.completed, resume.text, resume.usage.input_tokens, resume.usage.conversation.input_tokens], [true, "pong2\n", 2274, 9960], "this turn's usage, and the conversation's");
  const wrong = read(fill(STREAMS.resume, "conv-3"), { expectedThreadId: "conv-2" });
  assert.match(wrong.failed, /answered on thread "conv-3", expected conv-2/);
  const switched = read(fill(STREAMS.ok).map((line) => {
    const event = JSON.parse(line);
    if (event.event === "result") event.result.conversation_id = "conv-other";
    return JSON.stringify(event);
  }));
  assert.match(switched.failed, /answered on thread "conv-other", expected conv-1/);
  assert.equal(switched.completed, false, "a new conversation cannot complete under another thread's claim");
});

test("S5.3 denials: a deny-rule tool error is denied with the answer kept; denied_actions with an empty response is denied, not an empty-response failure", () => {
  const rule = read(fill(STREAMS.denied));
  assert.deepEqual([rule.completed, rule.failed, rule.denials.map((d) => d.tool)], [true, null, ["write_file", "run_command"]]);
  assert.equal(rule.denials[0].write, true);
  assert.match(rule.text, /^Step 1: Failed/);
  const prompt = read(fill(STREAMS["denied-prompt"]));
  assert.deepEqual([prompt.completed, prompt.failed], [true, null], "the reader latches the first fatal, so denied_actions is checked first");
  assert.deepEqual(prompt.denials.map((d) => d.tool), ["run_command", "command"]);
  assert.deepEqual(prompt.denials[1].actions, [{ action: "command", display: "RunCommand" }]);
  assert.match(prompt.text, /^agy denied command \(RunCommand\): headless mode cannot prompt/);
});

test("S5.3 failures: status ERROR, print_timeout, empty response, duplicate result, missing result, malformed lines", () => {
  assert.match(read(fill(STREAMS["effort-error"])).failed, /^agy status ERROR: invalid model selection/);
  assert.equal(read(fill(STREAMS["effort-error"])).threadId, null, "an empty conversation id is no thread");
  const empty = fill(STREAMS.ok).map((l) => l.replace('"response":"pong\\n"', '"response":"  "'));
  assert.equal(read(empty).failed, "agy returned an empty response");
  const ok = fill(STREAMS.ok);
  assert.equal(read([...ok, ok.at(-1)]).failed, "agy sent a duplicate terminal result");
  const missing = read(ok.slice(0, -1));
  assert.deepEqual([missing.completed, missing.failed], [false, null], "EOF without a result: the lifecycle fails the turn (exit 1)");
  assert.equal(read(["{not json"]).failed, "agy emitted malformed NDJSON");
  assert.equal(read([JSON.stringify({ type: "x" })]).failed, "agy event name missing");
  assert.equal(read([JSON.stringify({ event: "result", result: { response: "x" } })]).failed, "agy sent a missing or malformed terminal result");
  const interrupted = read([JSON.stringify({ event: "result", result: { conversation_id: "c", status: "ERROR", error: "interrupted", finished_reason: "interrupted", response: "" } })]);
  assert.match(interrupted.failed, /agy status ERROR: interrupted/);
  assert.equal(read([JSON.stringify({ event: "unknown_kind" }), ...ok]).completed, true, "unknown events are ignored");
});

test("S5.3 caps: a frame over 4 MiB and a partial answer over 4 MiB are fatal", () => {
  const huge = JSON.stringify({ event: "step_update", step_update: { step_type: "agent_response", state: "ACTIVE", text_delta: "x".repeat(LIMIT) } });
  assert.match(read([huge]).failed, /JSONL line over 4194304 bytes/);
  const chunk = JSON.stringify({ event: "step_update", step_update: { step_type: "agent_response", state: "ACTIVE", text_delta: "y".repeat(1024 * 1024) } });
  assert.equal(read([chunk, chunk, chunk, chunk, chunk]).failed, "agy's partial answer exceeds the 4 MiB limit");
});

test("S5.3 tool steps: failed commands, task edits from write tools, a completed write on a read-only turn is incomplete", () => {
  const step = (tool, state, parameters, output) => JSON.stringify({ event: "step_update", step_update: { conversation_id: "conv-1", step_type: "tool", state, tool_name: tool, tool_info: { name: tool, parameters, ...(output ? { output } : {}) } } });
  const ok = fill(STREAMS.ok);
  const task = read([step("run_command", "DONE", { CommandLine: "npm test" }, "Command exited with code 2.\n\nCommand output:\nfail"), step("run_command", "DONE", { CommandLine: "ls" }, "Command exited with code 0."),
    step("run_command", "ERROR", { CommandLine: "make" }), step("write_to_file", "DONE", { TargetFile: "/repo/src/a.js" }), step("write_to_file", "ERROR", { TargetFile: "/repo/b.js" }), ...ok], { readOnly: false });
  assert.deepEqual(task.failedCommands, ["npm test", "make"]);
  assert.deepEqual([...task.edited], ["src/a.js"], "a failed write is no edit");
  assert.equal(task.toolSteps, 5);
  const ro = read([step("replace_file_content", "DONE", { TargetFile: "/repo/a.js" }), ...ok], { readOnly: true });
  assert.deepEqual([ro.incomplete, ro.edited.size], ["agy completed replace_file_content on a read-only turn", 0]);
  assert.equal(read(fill(STREAMS.task), { readOnly: false }).failedCommands.length, 0);
  assert.equal(read(fill(STREAMS.web)).toolSteps, 1, "web search is a tool step, not a denial (S1.2 trade-off)");
});

test("S5.3 structured review output comes from result.structured_output; finalizeReview falls back to the response text", () => {
  const review = read(fill(STREAMS["review-findings"]));
  assert.equal(review.structured.findings[0].id, "F1");
  assert.equal(JSON.parse(review.text).findings[0].id, "F1");
  const malformed = read(fill(STREAMS["review-malformed"]));
  assert.deepEqual([malformed.completed, malformed.failed], [true, null], "an empty response with structured output is no empty-response failure");
  assert.equal(JSON.parse(malformed.text).findings[0].id, undefined, "the validator, not the reader, rejects it (exit 10)");
  const parsed = gemini.finalizeReview({ answerText: '{"verdict":"approve"}', structured: null, unreviewed: ["u"] });
  assert.deepEqual(parsed, { structured: { verdict: "approve" }, unreviewed: ["u"] });
  assert.deepEqual(gemini.finalizeReview({ answerText: "not json", structured: null, unreviewed: [] }), { structured: null, unreviewed: [] });
  const s = { verdict: "approve" };
  assert.equal(gemini.finalizeReview({ answerText: "{}", structured: s, unreviewed: [] }).structured, s);
});

test("S5.3 the optional lifecycle hooks are present", () => {
  for (const name of ["beforeTurn", "afterTurn"]) assert.equal(typeof gemini[name], "function");
});

test("S5.3 snapshots: bounded, complete in a small repository, unchecked outside Git, partial past the file cap", () => {
  const dir = repo();
  const before = snapshot(workspace(dir));
  assert.equal(before.coverage, "tracked-and-unignored");
  fs.writeFileSync(path.join(dir, "a.txt"), "changed\n");
  fs.writeFileSync(path.join(dir, "new.txt"), "n\n");
  const after = snapshot(workspace(dir));
  assert.deepEqual(changes(before, after), { changed: true, files: ["a.txt", "new.txt"], coverage: "complete" });
  assert.deepEqual(changes(after, snapshot(workspace(dir))).changed, false);
  assert.equal(snapshot(workspace(tmp())).coverage, "unchecked");
  for (let i = 0; i < 4; i++) fs.writeFileSync(path.join(dir, `f${i}.txt`), "x");
  assert.equal(snapshot(workspace(dir), {}, { maxFiles: 2 }).coverage, "partial");
});

test("S5.3 hooks: a task reports edited paths relative to its cwd; a read-only turn that changed the workspace is incomplete", async () => {
  const dir = repo();
  fs.mkdirSync(path.join(dir, "sub"));
  fs.writeFileSync(path.join(dir, "sub", "keep.txt"), "dirty before the turn\n");
  const job = jobIn(path.join(dir, "sub"), { verb: "task", readOnly: false });
  const ctx = { job, request: {}, cwd: job.cwd, env: { PATH: process.env.PATH } };
  await gemini.beforeTurn(ctx);
  fs.writeFileSync(path.join(dir, "sub", "made.txt"), "m\n");
  fs.writeFileSync(path.join(dir, "a.txt"), "edited\n");
  const outcome = await gemini.afterTurn(ctx, { cleanupConfirmed: true });
  assert.deepEqual(outcome, { coverage: "complete", edited: ["../a.txt", "made.txt"] }, "the pre-existing dirty file is unchanged, so not edited");
  assert.equal(job.mutationCoverage, "complete");
  const ro = jobIn(dir);
  const rctx = { job: ro, request: {}, cwd: dir, env: { PATH: process.env.PATH } };
  await gemini.beforeTurn(rctx);
  assert.deepEqual(await gemini.afterTurn(rctx, {}), { coverage: "complete" }, "an unchanged workspace");
  const ro2 = jobIn(dir);
  const r2 = { job: ro2, request: {}, cwd: dir, env: { PATH: process.env.PATH } };
  await gemini.beforeTurn(r2);
  fs.writeFileSync(path.join(dir, "touched.txt"), "t\n");
  assert.deepEqual(await gemini.afterTurn(r2, {}), { coverage: "complete", incomplete: "the workspace changed during a read-only turn: touched.txt" });
});

test("S5.3 hooks: unavailable snapshots leave coverage unknown; a re-run of afterTurn (deferred cancel) reuses the stored after snapshot", async () => {
  const outside = jobIn(tmp(), { verb: "task", readOnly: false });
  const octx = { job: outside, request: {}, cwd: outside.cwd, env: { PATH: process.env.PATH } };
  await gemini.beforeTurn(octx);
  fs.writeFileSync(path.join(outside.cwd, "x.txt"), "x");
  assert.deepEqual(await gemini.afterTurn(octx, {}), { coverage: "unknown" });
  assert.equal(outside.mutationCoverage, "unknown");
  const noBefore = jobIn(repo());
  assert.deepEqual(await gemini.afterTurn({ job: noBefore, request: null, cwd: noBefore.cwd, env: {} }, { deferred: true }), { coverage: "unknown" }, "no before snapshot: unknown, never a clean result");
  const dir = repo();
  const job = jobIn(dir);
  const ctx = { job, request: null, cwd: dir, env: { PATH: process.env.PATH } };
  await gemini.beforeTurn(ctx);
  fs.writeFileSync(path.join(dir, "during.txt"), "d");
  const first = await gemini.afterTurn(ctx, { deferred: true, cleanupConfirmed: true });
  assert.match(first.incomplete, /during\.txt/);
  assert.equal(job.incomplete, first.incomplete, "a deferred run records the finding on the job the cancel saves");
  fs.writeFileSync(path.join(dir, "later.txt"), "user's own work after the turn");
  assert.deepEqual(await gemini.afterTurn(ctx, { deferred: true, cleanupConfirmed: true }), first, "the re-run compares the same stored snapshots");
  await gemini.beforeTurn(ctx);
  assert.deepEqual(await gemini.afterTurn(ctx, {}), first, "beforeTurn never replaces a stored before snapshot");
});

test("S5.7 parity: AGYX's stderr host-denial heuristics, skipped when the stream already carried a denial or on a deferred run", async () => {
  assert.match(G.hostNotice("Error: attempt to write a readonly database"), /denied host access/);
  assert.match(G.hostNotice("operation not permitted: ~/.gemini/antigravity-cli/brain"), /denied host access/);
  assert.match(G.hostNotice("approval requires a prompt that was not allowed"), /unclassified permission notice/);
  assert.equal(G.hostNotice("[agy] print timeout after 5s"), null);
  const dir = repo();
  const job = { ...jobIn(dir), stderrTail: "readonly database" };
  const ctx = { job, request: {}, cwd: dir, env: { PATH: process.env.PATH } };
  await gemini.beforeTurn(ctx);
  assert.match((await gemini.afterTurn(ctx, { denials: [] })).incomplete, /denied host access/);
  assert.equal((await gemini.afterTurn(ctx, { denials: [{ tool: "command" }] })).incomplete, undefined, "a recorded denial already explains the notice");
});

test("review fix 1: print_timeout keeps the answer (the terminal response, else the streamed deltas) and leaves the turn uncompleted (exit 1)", () => {
  const recorded = read(fill(STREAMS["print-timeout"]));
  assert.deepEqual([recorded.completed, recorded.failed, recorded.text], [false, null, ""], "the S1.2 stream: denials, then an empty print_timeout result");
  assert.match(recorded.incomplete, /^print_timeout: /);
  const result = (fields) => JSON.stringify({ event: "result", result: { conversation_id: "conv-1", status: "SUCCESS", finished_reason: "print_timeout", ...fields } });
  const delta = (text) => JSON.stringify({ event: "step_update", step_update: { conversation_id: "conv-1", step_type: "agent_response", state: "ACTIVE", text_delta: text } });
  const terminal = read([delta("partial "), result({ response: "kept terminal answer" })]);
  assert.deepEqual([terminal.completed, terminal.failed, terminal.text], [false, null, "kept terminal answer"]);
  const deltas = read([delta("first half, "), delta("second half"), result({ response: "" })]);
  assert.deepEqual([deltas.completed, deltas.failed, deltas.text], [false, null, "first half, second half"]);
  assert.match(deltas.incomplete, /^print_timeout: /);
});

test("review fix 3: a deny-rule denial followed by an empty or failed result is denied with the denial as the answer", () => {
  const events = fill(STREAMS.denied);
  const quiet = (e) => (e.event === "result" ? { ...e, result: { ...e.result, response: "" } } : e.step_update?.text_delta ? { ...e, step_update: { ...e.step_update, text_delta: undefined } } : e);
  const empty = read(events.map((l) => JSON.stringify(quiet(JSON.parse(l)))));
  assert.deepEqual([empty.completed, empty.failed, empty.denials.length], [true, null, 2]);
  assert.match(empty.text, /^agy denied write_file: permission check failed for write_file .*\nagy denied run_command: permission check failed for command "which node"/);
  const failed = read(events.map((l) => (l.startsWith('{"event":"result"') ? l.replace('"status":"SUCCESS"', '"status":"ERROR"') : l)));
  assert.deepEqual([failed.completed, failed.failed], [true, null]);
  assert.match(failed.text, /^Step 1: Failed/, "a response, when agy gave one, stays the answer");
  const deltasOnly = read(events.map((l) => (l.startsWith('{"event":"result"') ? JSON.stringify(quiet(JSON.parse(l))) : l)));
  assert.match(deltasOnly.text, /^Step 1: Failed/, "streamed text, when there was some, is the answer");
  assert.match(read(fill(STREAMS["effort-error"])).failed, /^agy status ERROR/, "without a denial, a failed result stays fatal");
});

test("review fix 2: an untracked path named __proto__ is a snapshot entry, so a read-only change to it is caught", async () => {
  const dir = repo();
  const job = jobIn(dir);
  const ctx = { job, request: {}, cwd: dir, env: { PATH: process.env.PATH } };
  await gemini.beforeTurn(ctx);
  fs.writeFileSync(path.join(dir, "__proto__"), "x\n");
  const after = snapshot(workspace(dir));
  assert.ok(Object.hasOwn(after.files, "__proto__"));
  assert.deepEqual(await gemini.afterTurn(ctx, {}), { coverage: "complete", incomplete: "the workspace changed during a read-only turn: __proto__" });
  const job2 = jobIn(dir);
  const ctx2 = { job: job2, request: {}, cwd: dir, env: { PATH: process.env.PATH } };
  await gemini.beforeTurn(ctx2);
  fs.writeFileSync(path.join(dir, "__proto__"), "changed\n");
  assert.match((await gemini.afterTurn(ctx2, {})).incomplete, /__proto__/, "an edit to it after a JSON round trip of the before snapshot");
});

// ---------------------------------------------------------------------------------------------------------------- S5.4

test("S5.4 review plan: agy enforces --json-schema (S1.2), so the schema travels by path; --adversarial picks its template", () => {
  assert.deepEqual(gemini.reviewPlan({ batches: [["u1"], ["u2"]], batch: { index: 1, total: 2 } }, { adversarial: false }), { native: false, batches: [["u1"], ["u2"]], promptTemplate: "review", schemaCarrier: "path" });
  assert.equal(gemini.reviewPlan({ snapshot: null }, { adversarial: true }).promptTemplate, "adversarial-review");
});

test("A8: on a qualified Windows buildTurn builds the turn", { skip: process.platform !== "win32" && "Windows only" }, () => {
  assert.ok(gemini.buildTurn(request()).args.includes("--sandbox"));
});

test("buildTurn: PWD is the realpath cwd on POSIX, so agy's workspace root matches the paths it resolves", { skip: process.platform === "win32" && "agy reads no PWD there" }, () => {
  const built = gemini.buildTurn(request({ home: home({}), cwd: "/private/tmp/real" }));
  assert.equal(built.env.PWD, "/private/tmp/real");
});

test("a review turn adds an explicit read_file rule for its saved input; other turns get no such rule", buildsHere, () => {
  const h = home({});
  const req = request({ home: h });
  const root = fs.realpathSync.native(req.jobDir);
  const input = path.join(root, "review-input");
  assert.deepEqual(settingsOf(gemini.buildTurn({ ...req, reviewInputRoot: input })).permissions.allow, [...READ_ONLY_COMMANDS, `read_file(${input})`]);
  assert.deepEqual(settingsOf(gemini.buildTurn({ ...req, reviewRoot: root, reviewInputRoot: input })).permissions.allow, [...READ_ONLY_COMMANDS, `read_file(${root})`, `read_file(${input})`]);
  assert.deepEqual(settingsOf(gemini.buildTurn(req)).permissions.allow, READ_ONLY_COMMANDS);
  assert.equal(reviewInputRule(null), null);
  assert.equal(reviewInputRule(path.join(root, "odd (name)")), null, "a parenthesis would break the rule");
});
