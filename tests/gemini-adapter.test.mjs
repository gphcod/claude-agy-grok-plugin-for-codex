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

const { configuredPolicy, sessionSettings, printTimeout, stdinMessage, snapshot, workspace, changes, allowCommandProblem, READ_ONLY_DENY, WINDOWS_UNSUPPORTED, LIMIT } = G;
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
  assert.deepEqual(gemini.resolveLauncher({ PATH: dir }, "darwin"), { command: path.join(dir, "agy"), args: [], path: path.join(dir, "agy"), kind: "native" });
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
  const env = (extra = {}, global) => ({ ...baseEnv, HOME: home(global), ...extra });
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
  assert.deepEqual((await gemini.probe(launcher(), env(), "win32")).warnings, [WINDOWS_UNSUPPORTED]);
  const out = await gemini.probe(launcher(), env({ COUNCIL_FAKE_LOGGED_OUT: "1" }), "darwin");
  assert.deepEqual([out.loggedIn, out.models], [false, null]);
});

test("S5.1 preflight: agy state (write), state root (write), loopback listener, process table, the two cold probes, network; none on win32", () => {
  const h = home();
  const list = gemini.preflight({ stateRoot: "/state", env: { HOME: h, COUNCIL_AGY_BIN: FAKE }, platform: "darwin", verb: "ask", cwd: h });
  assert.deepEqual(list.map((d) => d.kind), ["dir", "dir", "listener", "process-table", "exec", "exec", "network"]);
  assert.deepEqual([list[0].target, list[0].access, list[1].target, list[1].access, list[2].target], [path.join(h, ".gemini", "antigravity-cli"), "write", "/state", "write", "127.0.0.1"]);
  assert.deepEqual(list[4].target.args, [FAKE, "--version"]);
  assert.deepEqual(list[5].target.args, [FAKE, "models"]);
  for (const d of list) assert.ok(d.why && d.action, `${d.kind} carries why and an action line`);
  assert.equal(gemini.preflight({ stateRoot: "/s", env: { HOME: h, COUNCIL_AGY_LISTEN_HOST: "192.0.2.1", PATH: "" }, platform: "darwin" }).find((d) => d.kind === "listener").target, "192.0.2.1");
  assert.ok(!gemini.preflight({ stateRoot: "/s", env: { HOME: h, PATH: "" }, platform: "darwin" }).some((d) => d.kind === "exec"), "no binary, no probe descriptors");
  assert.deepEqual(gemini.preflight({ stateRoot: "/s", env: { HOME: h }, platform: "win32" }), [], "Windows: checkRequest refuses with exit 2 instead");
});

test("S5.1 checkRequest: Windows (A8), --web, --allow-command outside a task or malformed; a task's allow-command passes", () => {
  const r = (extra) => ({ verb: "ask", web: false, allowCommands: [], ...extra });
  assert.equal(gemini.checkRequest(r({}), {}, "win32"), WINDOWS_UNSUPPORTED);
  assert.equal(gemini.checkRequest(r({ verb: "task" }), {}, "win32"), WINDOWS_UNSUPPORTED);
  assert.equal(gemini.checkRequest(r({}), {}, "darwin"), null);
  assert.match(gemini.checkRequest(r({ web: true }), {}, "darwin"), /--web is not offered for gemini/);
  for (const verb of ["ask", "reply", "review"]) assert.match(gemini.checkRequest(r({ verb, allowCommands: ["node x"] }), {}, "darwin"), /applies only to task --to gemini/);
  assert.equal(gemini.checkRequest(r({ verb: "task", allowCommands: ["node check.mjs", "npm test"] }), {}, "linux"), null);
  assert.match(gemini.checkRequest(r({ verb: "task", allowCommands: ["node -e f()"] }), {}, "darwin"), /parentheses/);
  assert.match(allowCommandProblem("a\nb"), /one line/);
  assert.match(allowCommandProblem("  "), /non-empty/);
});

// ---------------------------------------------------------------------------------------------------------------- S5.2

test("S5.2 settings: read-only turns filter allow, add the six denies and keep global denies; strict is kept, anything else becomes request-review", () => {
  const global = { permissions: { allow: ["run_command(*)", "command(which)", "read_file(src/*)", "read_url(https://x/*)"], ask: ["mcp(foo)"], deny: ["read_file(secret/*)", "command(*)"] }, toolPermission: "always-proceed" };
  const ro = sessionSettings({ readOnly: true }, global);
  assert.deepEqual(ro, { permissions: { allow: ["read_file(src/*)", "read_url(https://x/*)"], ask: ["mcp(foo)"], deny: ["read_file(secret/*)", "command(*)", ...READ_ONLY_DENY.filter((r) => r !== "command(*)")] },
    agentMode: "", toolPermission: "request-review" });
  assert.equal(sessionSettings({ readOnly: true }, { ...global, toolPermission: "strict" }).toolPermission, "strict");
  assert.deepEqual(sessionSettings({ readOnly: true }, {}).permissions, { allow: [], ask: [], deny: READ_ONLY_DENY });
});

test("S5.2 settings: tasks keep the global lists; --allow-command adds the pair and forces request-review unless strict; without it the global value stays", () => {
  const global = { permissions: { allow: ["command(which)"], ask: [], deny: ["write_file(*.lock)"] }, toolPermission: "always-proceed" };
  assert.deepEqual(sessionSettings({ readOnly: false }, global), { permissions: { allow: ["command(which)"], ask: [], deny: ["write_file(*.lock)"] }, toolPermission: "always-proceed" });
  assert.deepEqual(sessionSettings({ readOnly: false, allowCommands: ["node check.mjs"] }, global),
    { permissions: { allow: ["command(which)", "command(node check.mjs)", "unsandboxed(node check.mjs)"], ask: [], deny: ["write_file(*.lock)"] }, toolPermission: "request-review" });
  assert.equal(sessionSettings({ readOnly: false, allowCommands: ["x"] }, { ...global, toolPermission: "strict" }).toolPermission, "strict");
  assert.equal(sessionSettings({ readOnly: false }, { permissions: {} }).toolPermission, undefined, "no global value: agy's own default");
  assert.equal(sessionSettings({ readOnly: false }, {}).agentMode, undefined, "agentMode is set only on read-only turns");
});

test("S5.2 configuredPolicy reads only permissions and toolPermission; a broken global file stops the turn", () => {
  const h = home({ permissions: { allow: ["command(ls)"] }, toolPermission: "strict", apiKey: "secret", model: "x" });
  assert.deepEqual(configuredPolicy(path.join(h, ".gemini", "antigravity-cli", "settings.json")), { permissions: { allow: ["command(ls)"], ask: [], deny: [] }, toolPermission: "strict" });
  assert.deepEqual(configuredPolicy(path.join(tmp(), "missing.json")), {});
  assert.throws(() => configuredPolicy(path.join(home("[1]"), ".gemini", "antigravity-cli", "settings.json")), /must contain a JSON object/);
  assert.throws(() => configuredPolicy(path.join(home({ permissions: { deny: "x" } }), ".gemini", "antigravity-cli", "settings.json")), /permissions\.deny must be a string array/);
  assert.throws(() => gemini.buildTurn(request({ home: home("{") })), /invalid JSON; no turn submitted/);
});

test("S5.2 buildTurn: a read-only ask carries the exact A5.1 flag set, the job's settings file and one NDJSON message", () => {
  const h = home({ permissions: { allow: ["run_command(*)"], deny: ["read_file(.env)"] }, toolPermission: "always-proceed" });
  const req = request({ home: h, deadlineMs: 90000 });
  const built = gemini.buildTurn(req);
  const settingsPath = path.join(req.jobDir, "settings.json");
  assert.deepEqual(built.args, ["--input-format", "stream-json", "--output-format", "stream-json", "--disable-slash-commands", "--print-timeout", "87s", "--sandbox", "--settings", settingsPath,
    "--model", "gemini-4-argon", "--effort", "high"]);
  assert.deepEqual(settingsOf(built), { permissions: { allow: [], ask: [], deny: ["read_file(.env)", ...READ_ONLY_DENY] }, agentMode: "", toolPermission: "request-review" });
  assert.equal(fs.statSync(settingsPath).mode & 0o777, 0o600);
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

test("S5.2 buildTurn: model and effort rules, --conversation on resumes, --json-schema on structured turns, --mode only on tasks", () => {
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
  assert.deepEqual(settingsOf(task).permissions.allow, ["command(node check.mjs)", "unsandboxed(node check.mjs)"]);
  assert.ok(!task.args.includes("--allow-command"), "--allow-command is never forwarded to agy");
  assert.ok(gemini.buildTurn(request({ verb: "task", readOnly: false })).args.includes("--sandbox"), "--sandbox on every turn");
});

test("S5.2 the print timeout follows the deadline less a margin; the review prompt carries no separate instructions", () => {
  assert.deepEqual([printTimeout(90000), printTimeout(6000), printTimeout(14400000), printTimeout(100)], ["87s", "4s", "14397s", "0.1s"]);
  assert.equal(printTimeout(), "14397s");
  const content = JSON.parse(stdinMessage({ contractPath: CONTRACT, instructions: null, prompt: "Instructions for this turn (structured code review" })).message.content;
  assert.ok(content.endsWith("\n\nInstructions for this turn (structured code review"));
});
