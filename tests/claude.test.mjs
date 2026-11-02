// S3.1–S3.3: the Claude adapter's members in isolation (launcher, ownership, probes, preflight descriptors, the launch
// argv and input, the event parser and the review finalizer). Entry-level flows against fake-claude: claude-entry.test.mjs.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import adapter, { EFFORTS, MAX_TURNS, REQUIRED_FLAGS, TASK_DISALLOWED, buildArgs, claudeStorage, requestLine, sentinelOf, turnInput } from "../plugins/council/scripts/lib/providers/claude.mjs";
import { assertAdapter } from "../plugins/council/scripts/lib/core/types.mjs";
import { hasFlagOperand } from "../plugins/council/scripts/lib/core/execution.mjs";
import { runPreflight, PreflightBlocked } from "../plugins/council/scripts/lib/core/preflight.mjs";
import { createReader } from "../plugins/council/scripts/lib/core/reader.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FAKE = path.join(ROOT, "tests", "fixtures", "fake-claude.mjs");
const PLUGIN = path.join(ROOT, "plugins", "council");
const CONTRACT = path.join(PLUGIN, "contract.md");
const SCHEMA = path.join(PLUGIN, "schemas", "review-output.schema.json");
const STREAMS = JSON.parse(fs.readFileSync(path.join(ROOT, "tests", "fixtures", "streams", "claude.json"), "utf8"));
const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "council-claude-")));
const UUID = "11111111-1111-4111-8111-111111111111";
const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(COUNCIL|CLAUDE|CODEX|GROK|AGY|ANTHROPIC)/.test(k) && !/proxy/i.test(k)));

// ---- S3.1 skeleton ----

test("the module implements the frozen adapter interface with Claude's identity", () => {
  assert.equal(assertAdapter(adapter, "claude"), adapter);
  assert.equal(adapter.binEnv, "COUNCIL_CLAUDE_BIN");
  assert.equal(adapter.catalog.listing, false, "no model listing: aliases plus pass-through");
  assert.ok(adapter.maxLineBytes >= 16 * 1024 * 1024, "a structured review result is one line");
  assert.equal(adapter.trustsCleanExit({ kind: "native" }), false);
  assert.equal(adapter.trustsCleanExit({ kind: "node-script" }), false);
});

test("launcher: PATH must give the native executable; a configured COUNCIL_CLAUDE_BIN may name a JS entry", () => {
  const dir = tmp();
  const configured = adapter.resolveLauncher({ COUNCIL_CLAUDE_BIN: FAKE, PATH: "" });
  assert.deepEqual([configured.command, configured.args, configured.kind], [process.execPath, [FAKE], "node-script"]);
  const native = path.join(dir, "claude");
  fs.writeFileSync(native, "#!/bin/sh\n"); fs.chmodSync(native, 0o755);
  if (process.platform !== "win32") assert.deepEqual(adapter.resolveLauncher({ PATH: dir }), { command: native, args: [], path: native, kind: "native" });
  assert.equal(adapter.resolveLauncher({ PATH: path.join(dir, "none") }), null);
  const win = path.join(dir, "win");
  fs.mkdirSync(win);
  fs.writeFileSync(path.join(win, "claude.cmd"), '@"%~dp0\\cli.js" %*\r\n');
  fs.writeFileSync(path.join(win, "cli.js"), "");
  assert.throws(() => adapter.resolveLauncher({ PATH: win, PATHEXT: ".CMD" }, "win32"), /without a shell; install the native claude executable or set COUNCIL_CLAUDE_BIN/);
  const script = path.join(dir, "claude.mjs");
  fs.writeFileSync(script, "");
  assert.equal(adapter.resolveLauncher({ COUNCIL_CLAUDE_BIN: script }, "win32").kind, "node-script", "the configured JS exception holds on Windows");
});

test("ownership: the recorded --session-id or --resume uuid operand, never another job's", () => {
  const job = { childArgs: ["-p", "--session-id", UUID, "--max-turns", "2"], threadId: null, requestedThreadId: UUID };
  const row = (argv) => ({ argv });
  assert.equal(adapter.ownsProcess(row(["claude", "-p", "--session-id", UUID]), job, "linux", hasFlagOperand), true);
  assert.equal(adapter.ownsProcess(row(["claude", "-p", "--session-id", UUID.replace(/1$/, "2")]), job, "linux", hasFlagOperand), false);
  assert.equal(adapter.ownsProcess(row(["claude", "-p", "--resume", UUID]), job, "linux", hasFlagOperand), false, "only the flag the launch used");
  assert.equal(adapter.ownsProcess(row(["claude", "-p", "--model", UUID]), job, "linux", hasFlagOperand), false, "the uuid as another flag's operand is no evidence");
  assert.equal(adapter.ownsProcess({ raw: `/usr/local/bin/claude -p --resume ${UUID} --max-turns 20` }, { childArgs: ["-p", "--resume", UUID] }, "darwin", hasFlagOperand), true);
  assert.equal(adapter.ownsProcess({ raw: `/usr/local/bin/claude -p --resume ${UUID}x` }, { childArgs: ["-p", "--resume", UUID] }, "darwin", hasFlagOperand), false, "whole-word operand only");
  assert.equal(adapter.ownsProcess(row(["claude", "--resume", UUID]), { threadId: UUID }, "linux", hasFlagOperand), true, "an older record without child arguments falls back to the thread");
  assert.equal(adapter.ownsProcess(row(["claude", "--resume", UUID]), {}, "linux", hasFlagOperand), false);
});

test("probe: version and login from the two non-billable probes; no model listing; the account fields are not returned", async () => {
  const launcher = adapter.resolveLauncher({ COUNCIL_CLAUDE_BIN: FAKE });
  const probe = await adapter.probe(launcher, baseEnv);
  assert.deepEqual(probe, { version: "2.1.314 (Claude Code)", loggedIn: true, models: null, warnings: [] });
  const out = await adapter.probe(launcher, { ...baseEnv, COUNCIL_FAKE_LOGGED_OUT: "1" });
  assert.equal(out.loggedIn, false);
  const dir = tmp();
  const old = path.join(dir, "old.mjs");
  fs.writeFileSync(old, "if (process.argv.includes('--version')) console.log('2.1.300 (Claude Code)'); else console.log('{\"loggedIn\":true,\"email\":\"x@example.com\"}');");
  const warned = await adapter.probe({ command: process.execPath, args: [old], path: old, kind: "node-script" }, baseEnv);
  assert.match(warned.warnings[0], /2\.1\.300 is untested/);
  assert.ok(!JSON.stringify(warned).includes("example.com"));
});

test("preflight descriptors: state root, Claude storage, four cold probes and the network, in the S3.1 order", () => {
  const env = { ...baseEnv, COUNCIL_CLAUDE_BIN: FAKE, HOME: "/home/u", CLAUDE_CONFIG_DIR: "" };
  const d = adapter.preflight({ stateRoot: "/state", env, platform: "linux", verb: "ask", cwd: "/w" });
  assert.deepEqual(d.map((x) => [x.kind, x.access ?? null]), [["dir", "write"], ["dir", "write"], ["exec", null], ["exec", null], ["exec", null], ["exec", null], ["network", null]]);
  assert.equal(d[0].target, "/state");
  assert.equal(d[1].target, path.resolve("/home/u", ".claude", "projects"));
  assert.equal(claudeStorage({ CLAUDE_CONFIG_DIR: "/cfg" }), path.resolve("/cfg", "projects"));
  const exec = d.filter((x) => x.kind === "exec");
  assert.deepEqual(exec.map((x) => x.target.args.slice(1, 4)), [["--version"], ["auth", "status", "--json"], ["--help"], ["-p", "--append-system-prompt-file", sentinelOf("/state")]]);
  assert.ok(exec.every((x) => x.target.command === process.execPath && x.target.args[0] === FAKE), "probes run through the resolved launcher");
  assert.equal(exec[1].target.recordOutput, false, "the account status is never cached");
  assert.deepEqual([exec[3].target.expectStatus, exec[3].target.expectText], [1, "Append system prompt file not found"]);
  assert.equal(d[6].target, "https://api.anthropic.com");
  assert.equal(adapter.preflight({ stateRoot: "/s", env: { ...env, ANTHROPIC_BASE_URL: "https://gw.example" }, platform: "linux" }).at(-1).target, "https://gw.example");
  assert.ok(d.every((x) => x.why && x.action), "every descriptor names its resource and its action line");
});

test("preflight cold runs the four probes (no model call, no account line cached), warm runs none; a missing flag or logout blocks", async () => {
  const dir = tmp();
  const log = path.join(dir, "fake.log");
  const env = { ...baseEnv, COUNCIL_CLAUDE_BIN: FAKE, HOME: dir, HTTPS_PROXY: "http://127.0.0.1:9", COUNCIL_FAKE_LOG: log };
  const launcher = adapter.resolveLauncher(env);
  const home = path.join(dir, "state");
  const descriptors = adapter.preflight({ stateRoot: home, env, platform: process.platform });
  const cold = await runPreflight({ home, provider: "claude", launcher, descriptors, env });
  const probes = () => fs.readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.deepEqual(probes().map((p) => p.probe), ["version", "auth", "help", "capability"]);
  assert.ok(probes().every((p) => p.probe), "no launch: the capability probe stops at the missing file");
  assert.equal(cold.cached, false);
  assert.ok(!fs.readdirSync(path.join(home, "preflight")).some((f) => fs.readFileSync(path.join(home, "preflight", f), "utf8").includes("firstParty")), "auth output stays out of the cache");
  const warm = await runPreflight({ home, provider: "claude", launcher, descriptors, env });
  assert.equal(warm.cached, true);
  assert.equal(probes().length, 4, "warm: zero probes");
  await assert.rejects(runPreflight({ home: path.join(dir, "s2"), provider: "claude", launcher, descriptors: adapter.preflight({ stateRoot: path.join(dir, "s2"), env, platform: process.platform }),
    env: { ...env, COUNCIL_FAKE_LOGGED_OUT: "1" } }), (e) => e instanceof PreflightBlocked && /Run claude auth login/.test(e.action));
  const bare = path.join(dir, "bare.mjs");
  fs.writeFileSync(bare, "console.log(process.argv.includes('--help') ? 'Usage: claude --verbose' : '2.1.314 (Claude Code)'); if (process.argv.includes('auth')) console.log('{\"loggedIn\": true}');");
  const bareLauncher = { command: process.execPath, args: [bare], path: bare, kind: "node-script" };
  await assert.rejects(runPreflight({ home: path.join(dir, "s3"), provider: "claude", launcher: bareLauncher, env,
    descriptors: adapter.preflight({ stateRoot: path.join(dir, "s3"), env: { ...env, COUNCIL_CLAUDE_BIN: bare }, platform: process.platform }) }), (e) => e instanceof PreflightBlocked && /Claude flags/.test(e.message));
  assert.ok(REQUIRED_FLAGS.every((f) => fs.readFileSync(path.join(ROOT, "docs", "spike", "claude-help.txt"), "utf8").includes(f)), "the recorded 2.1.314 help lists every required flag");
});

test("checkRequest refuses before any job record: unknown effort (the CLI would ignore it), flag-like model ids, a non-uuid resume", () => {
  const ok = { verb: "ask", effort: "max", model: "claude-opus-5-5", allowCommands: [], resume: false, threadId: null };
  assert.equal(adapter.checkRequest(ok), null);
  for (const effort of EFFORTS) assert.equal(adapter.checkRequest({ ...ok, effort }), null);
  assert.match(adapter.checkRequest({ ...ok, effort: "ultra" }), /claude accepts --effort low\|medium\|high\|xhigh\|max; got ultra/);
  assert.match(adapter.checkRequest({ ...ok, model: "--dangerously-skip-permissions" }), /invalid claude model id/);
  assert.match(adapter.checkRequest({ ...ok, model: "opus x" }), /invalid claude model id/);
  assert.equal(adapter.checkRequest({ ...ok, model: null }), null, "default: no --model");
  assert.match(adapter.checkRequest({ ...ok, allowCommands: ["npm test"] }), /only to gemini/);
  assert.match(adapter.checkRequest({ ...ok, resume: true, threadId: "abc" }), /full session uuid/);
  assert.equal(adapter.checkRequest({ ...ok, resume: true, threadId: UUID }), null);
});

// ---- S3.2 buildTurn ----

const request = (extra = {}) => ({ verb: "ask", nextInput: false, text: "q", prompt: "q", instructions: "ADVICE", contractPath: CONTRACT, model: null, effort: "low", resume: false, threadId: null,
  cwd: ROOT, env: { ...baseEnv, COUNCIL_CLAUDE_BIN: FAKE }, schemaPath: null, structured: false, readOnly: true, web: false, allowCommands: [], maxTurns: null, maxBudgetUsd: null,
  policy: { version: "default-v1", readRoots: [], web: false, allowMcp: false }, agent: null, jobDir: "/tmp/job", ...extra });
const value = (args, flag) => args[args.indexOf(flag) + 1];
const variadic = (args, flag) => { const i = args.indexOf(flag); if (i < 0) return null; const out = []; for (let j = i + 1; j < args.length && !args[j].startsWith("-"); j += 1) out.push(args[j]); return out; };
const input = (built) => JSON.parse(built.stdin);

test("ask: a new uuid, the read-only flag set, the contract as the snapshot system prompt, advice plus text in the input", () => {
  const built = adapter.buildTurn(request());
  const a = built.args;
  assert.deepEqual(a.slice(0, 6), ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"]);
  const session = value(a, "--session-id");
  assert.match(session, /^[0-9a-f-]{36}$/);
  assert.equal(built.requestedThreadId, session, "claimed before spawn");
  assert.ok(!a.includes("--resume"));
  assert.deepEqual([value(a, "--system-prompt-snapshot"), value(a, "--append-system-prompt-file")], ["on", CONTRACT]);
  assert.deepEqual([value(a, "--max-turns"), value(a, "--effort"), value(a, "--permission-mode"), value(a, "--permission-prompts"), value(a, "--setting-sources")], ["20", "low", "dontAsk", "none", "user"]);
  assert.equal(value(a, "--tools"), "Read,Glob,Grep");
  assert.deepEqual([variadic(a, "--allowedTools"), variadic(a, "--disallowedTools")], [null, null]);
  assert.deepEqual([value(a, "--mcp-config"), a.includes("--strict-mcp-config"), value(a, "--settings"), a.includes("--no-chrome")], ['{"mcpServers":{}}', true, '{"disableAllHooks":true}', true]);
  assert.ok(!a.includes("--model"), "default: the user's configured model, no flag");
  assert.ok(!a.includes("--json-schema") && !a.includes("--max-budget-usd") && !a.includes("--add-dir"));
  assert.deepEqual(input(built), { type: "user", session_id: session, message: { role: "user", content: "ADVICE\n\nq" }, parent_tool_use_id: null });
  assert.ok(built.stdin.endsWith("}\n") && built.stdin.split("\n").length === 2, "one NDJSON line, then EOF");
  assert.equal(built.readOnly, true);
  assert.equal(built.contractCarrier, "append-system-prompt-file");
  for (const name of ["COUNCIL_DEPTH", "CLAUDE_PLUGIN_CODEX_DEPTH", "GROK_CODEX_DEPTH", "GROK_BUILD_DEPTH", "AGY_BRIDGE_DEPTH"]) assert.equal(built.env[name], "1");
  assert.equal(built.env.NO_COLOR, "1");
  assert.notEqual(value(adapter.buildTurn(request()).args, "--session-id"), session, "every new thread gets its own uuid");
  assert.deepEqual(value(adapter.buildTurn(request({ model: "sonnet" })).args, "--model"), "sonnet");
});

test("reply resumes read-only with the delta in the input; task and task --thread take the S1.1 launch and the task template", () => {
  const reply = adapter.buildTurn(request({ verb: "reply", resume: true, threadId: UUID.toUpperCase(), prompt: "F1 AGREE" }));
  assert.equal(value(reply.args, "--resume", UUID), UUID, "the lowercased uuid");
  assert.ok(!reply.args.includes("--session-id"));
  assert.deepEqual([value(reply.args, "--permission-mode"), value(reply.args, "--tools"), value(reply.args, "--max-turns")], ["dontAsk", "Read,Glob,Grep", "20"]);
  assert.equal(input(reply).message.content, "ADVICE\n\nF1 AGREE");
  assert.equal(input(reply).session_id, UUID);
  for (const resume of [false, true]) {
    const task = adapter.buildTurn(request({ verb: "task", readOnly: false, instructions: "TASK", prompt: "edit it", resume, threadId: resume ? UUID : null }));
    const a = task.args;
    assert.equal(a.includes("--resume"), resume);
    assert.deepEqual([value(a, "--permission-mode"), value(a, "--permission-prompts"), value(a, "--max-turns")], ["acceptEdits", "none", "30"]);
    assert.equal(value(a, "--tools"), "Read,Glob,Grep,Edit,Write,MultiEdit,NotebookEdit,Bash");
    assert.deepEqual(variadic(a, "--allowedTools"), ["Edit,Write,MultiEdit,NotebookEdit,Bash"]);
    assert.deepEqual(variadic(a, "--disallowedTools"), TASK_DISALLOWED);
    assert.deepEqual(a.slice(-5), ["--disallowedTools", ...TASK_DISALLOWED], "the variadic lists close the argv");
    assert.deepEqual([value(a, "--mcp-config"), value(a, "--settings")], ['{"mcpServers":{}}', '{"disableAllHooks":true}'], "hooks and MCP stay off on tasks");
    assert.equal(input(task).message.content, "TASK\n\nedit it");
    assert.equal(task.readOnly, false);
  }
});

test("review: read-only set, the repository schema inline as one line, enough turns for context reads, the batch prompt as the whole input", () => {
  const built = adapter.buildTurn(request({ verb: "review", instructions: null, prompt: "REVIEW PROMPT batch", schemaPath: SCHEMA, structured: true }));
  const a = built.args;
  assert.deepEqual(JSON.parse(value(a, "--json-schema")), JSON.parse(fs.readFileSync(SCHEMA, "utf8")));
  assert.ok(!value(a, "--json-schema").includes("\n"), "one argv line, so the macOS process row stays matchable");
  assert.deepEqual([value(a, "--max-turns"), value(a, "--permission-mode"), value(a, "--tools")], ["20", "dontAsk", "Read,Glob,Grep"]);
  assert.equal(input(built).message.content, "REVIEW PROMPT batch");
  const discussion = adapter.buildTurn(request({ verb: "reply", resume: true, threadId: UUID, instructions: null, prompt: "F1 REJECT", schemaPath: SCHEMA, structured: true }));
  assert.ok(discussion.args.includes("--json-schema"), "a discussion reply on a review thread is structured");
  assert.equal(value(discussion.args, "--max-turns"), "20");
  assert.equal(MAX_TURNS.review, 20);
  const roots = adapter.buildTurn(request({ verb: "review", reviewRoot: "/repo", reviewInputRoot: "/state/input", policy: { readRoots: ["/repo"] } })).args;
  assert.deepEqual(roots.flatMap((token, i) => token === "--add-dir" ? [roots[i + 1]] : []), ["/repo", "/state/input"]);
});

test("--web adds WebFetch,WebSearch to --tools and --allowedTools on read-only and task turns; the policy sets MCP, read roots and web", () => {
  const web = adapter.buildTurn(request({ web: true })).args;
  assert.equal(value(web, "--tools"), "Read,Glob,Grep,WebFetch,WebSearch");
  assert.deepEqual(variadic(web, "--allowedTools"), ["WebFetch,WebSearch"]);
  const task = adapter.buildTurn(request({ verb: "task", readOnly: false, web: true })).args;
  assert.equal(value(task, "--tools"), "Read,Glob,Grep,Edit,Write,MultiEdit,NotebookEdit,Bash,WebFetch,WebSearch");
  assert.deepEqual(variadic(task, "--allowedTools"), ["Edit,Write,MultiEdit,NotebookEdit,Bash,WebFetch,WebSearch"]);
  const policy = adapter.buildTurn(request({ policy: { version: "p1", readRoots: ["/data/a", "/data/b"], web: true, allowMcp: true } })).args;
  assert.ok(!policy.includes("--mcp-config") && !policy.includes("--strict-mcp-config"), "MCP only when the stored policy allows it");
  assert.deepEqual(policy.flatMap((t, i) => (t === "--add-dir" ? [policy[i + 1]] : [])), ["/data/a", "/data/b"]);
  assert.equal(value(policy, "--tools"), "Read,Glob,Grep,WebFetch,WebSearch", "policy web enables the pair too");
  const limits = adapter.buildTurn(request({ maxTurns: 7, maxBudgetUsd: 0.5, effort: "max", model: "claude-opus-5-5" })).args;
  assert.deepEqual([value(limits, "--max-turns"), value(limits, "--max-budget-usd"), value(limits, "--effort"), value(limits, "--model")], ["7", "0.5", "max", "claude-opus-5-5"]);
});

test("the input line is capped at 8,000,000 bytes, as CLAUDEX's requestLine", () => {
  assert.equal(turnInput({ instructions: null, prompt: "p" }), "p");
  assert.equal(requestLine("x", UUID), `{"type":"user","session_id":"${UUID}","message":{"role":"user","content":"x"},"parent_tool_use_id":null}\n`);
  assert.throws(() => adapter.buildTurn(request({ prompt: "é".repeat(4_000_000) })), /exceeds 8000000 UTF-8 bytes/);
});

test("every launch buildTurn produces passes fake-claude's complete launch contract (exit 99 on any mismatch)", async () => {
  const { spawnSync } = await import("node:child_process");
  const cases = [["ok", request()], ["resume", request({ verb: "reply", resume: true, threadId: UUID })], ["task", request({ verb: "task", readOnly: false })],
    ["task", request({ verb: "task", readOnly: false, resume: true, threadId: UUID, web: true })], ["review-findings", request({ verb: "review", instructions: null, schemaPath: SCHEMA, structured: true })],
    ["ok", request({ web: true, maxBudgetUsd: 1, model: "opus", policy: { version: "p", readRoots: [ROOT], web: false, allowMcp: false } })]];
  for (const [scenario, req] of cases) {
    const built = adapter.buildTurn(req);
    const r = spawnSync(process.execPath, [FAKE, ...built.args], { input: built.stdin, encoding: "utf8", env: { ...built.env, COUNCIL_FAKE_SCENARIO: scenario }, timeout: 20000 });
    assert.equal(r.status, 0, `${scenario}: ${r.stderr}`);
  }
});

// ---- S3.3 parseEvent and finalizeReview ----

/** Feeds a recorded stream through the core reader, seeded as the lifecycle seeds it. */
function play(events, { readOnly = true, session = UUID, expected = session, cwd = "/scratch/repo" } = {}) {
  let text = "";
  const reader = createReader(adapter, { cwd, expectedThreadId: expected, onText: (t) => { text += t; } });
  Object.assign(reader.state.adapter, { readOnly, agent: null });
  for (const e of events) reader.feed(`${typeof e === "string" ? e : JSON.stringify(e).replaceAll("<SESSION>", session).replaceAll("<SCRATCH>", "/scratch")}\n`);
  reader.end();
  return { ...reader.state, text, edited: [...reader.state.edited] };
}
const fx = (name) => STREAMS[name];
const resultOf = (name) => fx(name).find((e) => e.type === "result");
const init = (extra = {}) => ({ ...fx("ok")[0], ...extra });

test("ok and resume: the thread from init, the observed model, the answer only from the result, cost and usage", () => {
  const ok = play(fx("ok"));
  assert.deepEqual([ok.failed, ok.threadId, ok.model, ok.text, ok.completed, ok.costUsd], [null, UUID, "claude-opus-5-5", "pong", true, 0.0272304]);
  assert.equal(ok.usage.turns, 1);
  assert.equal(ok.usage.retries, 0);
  const resume = play(fx("resume"));
  assert.equal(resume.model, "claude-sonnet-5-5");
  assert.match(resume.text, /MARKER alpha/);
  const chatty = play([fx("ok")[0], { type: "assistant", message: { content: [{ type: "text", text: "intermediate" }] }, session_id: "<SESSION>" }, resultOf("ok")]);
  assert.equal(chatty.text, "pong", "assistant text is never the answer");
  const retried = play([fx("ok")[0], { type: "system", subtype: "api_retry", category: "overloaded" }, { type: "system", subtype: "thinking_tokens" }, { type: "rate_limit_event" }, resultOf("ok")]);
  assert.deepEqual([retried.failed, retried.usage.retries], [null, 1]);
});

test("terminal checks: missing, duplicate, wrong-session, malformed, is_error, turn limit, empty or absent answer", () => {
  const missing = play(fx("ok").filter((e) => e.type !== "result"));
  assert.deepEqual([missing.completed, missing.failed], [false, null], "EOF without result: the lifecycle fails the turn (exit 1)");
  assert.match(play([...fx("ok"), resultOf("ok")]).failed, /duplicate Claude result event/);
  assert.match(play(fx("ok").map((e) => JSON.stringify(e).replaceAll("<SESSION>", "00000000-0000-4000-8000-000000000099"))).failed, /answered on thread .*expected/);
  assert.match(play([init(), { ...resultOf("ok"), session_id: "00000000-0000-4000-8000-000000000099" }]).failed, /names session 00000000/);
  assert.match(play([init(), { ...resultOf("ok"), session_id: undefined }]).failed, /malformed_result: the Claude result has no session id/);
  assert.match(play([init(), { ...resultOf("ok"), subtype: undefined }]).failed, /malformed_result: .*subtype or is_error/);
  assert.match(play([init(), { ...resultOf("ok"), is_error: "false" }]).failed, /malformed_result/);
  const unknown = play(fx("is-error"));
  assert.match(unknown.failed, /^claude api_error: There's an issue with the selected model \(gpt-6\.1-sol\)/);
  assert.equal(unknown.text, "", "the synthetic assistant text is not an answer");
  assert.match(play(fx("turn-limit")).failed, /^claude max_turns: \["error_max_turns"\]/);
  assert.match(play([init(), { ...resultOf("ok"), subtype: "error_max_budget_usd", is_error: false, terminal_reason: undefined }]).failed, /^claude error_max_budget_usd/);
  assert.match(play([init(), { ...resultOf("ok"), result: "  " }]).failed, /the Claude result is empty/);
  assert.match(play([init(), { ...resultOf("ok"), result: undefined }]).failed, /no answer text/);
  assert.match(play(["{not json"]).failed, /malformed JSON in the Claude event stream/);
  assert.match(play([{ subtype: "init" }]).failed, /malformed Claude event/);
  assert.match(play([{ ...init(), session_id: undefined }]).failed, /init event without a session id/);
});

test("init must confirm the launched mode, and a read-only launch must advertise no mutating tool", () => {
  assert.match(play(fx("ok"), { readOnly: false }).failed, /permission mode "dontAsk", not the launched acceptEdits/);
  assert.match(play(fx("task"), { readOnly: true }).failed, /permission mode "acceptEdits", not the launched dontAsk/);
  assert.match(play([init({ tools: ["Read", "Edit", "Bash"] }), resultOf("ok")]).failed, /a read-only Claude turn advertised Edit, Bash/);
  assert.equal(play([init({ tools: ["Read", "Glob", "Grep", "StructuredOutput", "WebFetch", "WebSearch", "mcp__x__y"] }), resultOf("ok")]).failed, null);
});

test("denials: permission_denied events merged with result.permission_denials, deduplicated → denied (exit 10)", () => {
  const denied = play(fx("denied"));
  assert.deepEqual([denied.failed, denied.text, denied.denials.length], [null, "Partial answer.", 1]);
  assert.deepEqual(denied.denials[0], { count: 1, denials: [{ tool: "Read", path: "/restricted/private.txt", input: { file_path: "/restricted/private.txt" } }] });
  const two = play([{ type: "permission_denied", tool_name: "WebFetch", tool_input: { url: "https://x" } }, ...fx("denied")]);
  assert.equal(two.denials[0].count, 2);
  assert.equal(play(fx("ok")).denials.length, 0);
});

test("tool-absent: an edit attempted on a read-only turn comes back as an error tool result → denied, never edited", () => {
  const absent = play(fx("tool-absent"));
  assert.deepEqual([absent.failed, absent.text, absent.edited], [null, "denied", []]);
  assert.equal(absent.denials.length, 1);
  assert.equal(absent.denials[0].denials[0].tool, "Edit");
  assert.equal(absent.denials[0].denials[0].path, "/scratch/repo/value.mjs");
  assert.match(absent.denials[0].denials[0].reason, /No such tool available: Edit/);
  const succeeded = fx("tool-absent").map((e) => (e.type === "user" ? { ...e, message: { ...e.message, content: [{ ...e.message.content[0], is_error: false, content: "updated" }] } } : e));
  assert.match(play(succeeded).failed, /a read-only Claude turn ran Edit on \/scratch\/repo\/value\.mjs/, "an edit that succeeds on a read-only turn fails closed");
  const readAttempt = [init(), { type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/nope" } }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: "ENOENT" }] } }, resultOf("ok")];
  assert.equal(play(readAttempt).denials.length, 0, "a failed read is not a denial");
});

test("task: edited paths from confirmed Edit/Write/MultiEdit/NotebookEdit results; a failed edit is left out; a failed Bash is a failed command", () => {
  const task = play(fx("task"), { readOnly: false });
  assert.deepEqual([task.failed, task.text, task.edited, task.failedCommands, task.toolSteps], [null, "edited and ran 0", ["value.mjs"], [], 3]);
  const broken = play(fx("task").map((e) => {
    if (e.type !== "user") return e;
    const block = e.message.content[0];
    if (block.tool_use_id === "toolu_01KUE2RkdHpbpsDu54j1e2g6") return { ...e, message: { ...e.message, content: [{ ...block, is_error: true, content: "String to replace not found" }] } };
    if (block.tool_use_id === "toolu_01UYeVHYP1sN7JMBbE6D74V3") return { ...e, message: { ...e.message, content: [{ ...block, is_error: true, content: "Exit code 1" }] } };
    return e;
  }), { readOnly: false });
  assert.deepEqual([broken.failed, broken.edited, broken.failedCommands, broken.denials.length], [null, [], ['node -e "process.exit(0)"; echo $?'], 0]);
  const taskInit = fx("task")[0];
  const many = play([taskInit,
    { type: "assistant", message: { content: [{ type: "tool_use", id: "w", name: "Write", input: { file_path: "<SCRATCH>/repo/new.txt" } }, { type: "tool_use", id: "m", name: "MultiEdit", input: { file_path: "<SCRATCH>/repo/a.js" } },
      { type: "tool_use", id: "n", name: "NotebookEdit", input: { notebook_path: "<SCRATCH>/repo/n.ipynb" } }, { type: "tool_use", id: "u", name: "Edit", input: { file_path: "<SCRATCH>/repo/pending.js" } }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "w", content: "ok" }, { type: "tool_result", tool_use_id: "m", content: "ok" }, { type: "tool_result", tool_use_id: "n", content: "ok" }] } },
    resultOf("task")], { readOnly: false });
  assert.deepEqual(many.edited.sort(), ["a.js", "n.ipynb", "new.txt", "pending.js"], "an edit whose result never arrived may have happened: reported");
});

test("structured output is the answer on reviews; finalizeReview prefers it and falls back to the answer text; reviewPlan carries the schema by flag", () => {
  const review = play(fx("review-findings"));
  assert.equal(review.failed, null);
  assert.equal(review.structured.verdict, "needs-attention");
  assert.deepEqual(JSON.parse(review.text), review.structured, "the spooled answer is the structured JSON");
  assert.deepEqual(adapter.finalizeReview({ answerText: "junk", structured: review.structured, unreviewed: ["x"] }), { structured: review.structured, unreviewed: ["x"] });
  assert.deepEqual(adapter.finalizeReview({ answerText: review.text, structured: null, unreviewed: [] }).structured, review.structured);
  assert.equal(adapter.finalizeReview({ answerText: "not json", structured: null, unreviewed: [] }).structured, null, "the core reports it incomplete (exit 10)");
  assert.equal(adapter.finalizeReview({ answerText: "[1]", structured: null, unreviewed: [] }).structured, null);
  const malformed = play(fx("review-malformed"));
  assert.equal(malformed.failed, null, "schema problems are the validator's: incomplete (10), not a failed turn");
  assert.deepEqual(adapter.reviewPlan({ batches: [1] }, { adversarial: true }), { native: false, batches: [1], promptTemplate: "adversarial-review", schemaCarrier: "flag" });
  assert.equal(adapter.reviewPlan({ snapshot: null }, { adversarial: false }).promptTemplate, "review");
});

// ---- S3.7 review fixes (milestone 3: Codex gpt-6.1-sol, Gemini 4 Argon) ----

const use = (id, name, input) => ({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] }, session_id: "<SESSION>" });
const toolResult = (id, content, isError = true) => ({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, is_error: isError, content }] }, session_id: "<SESSION>" });

test("item 1: a Bash attempt on a read-only turn (tool absent) is denied like an edit; one that ran fails closed", () => {
  const bash = play([init(), use("b1", "Bash", { command: "npm test" }), toolResult("b1", "<tool_use_error>Error: No such tool available: Bash</tool_use_error>"), resultOf("ok")]);
  assert.deepEqual([bash.failed, bash.completed, bash.failedCommands], [null, true, []]);
  assert.equal(bash.denials.length, 1);
  assert.deepEqual([bash.denials[0].denials[0].tool, bash.denials[0].denials[0].input], ["Bash", { command: "npm test" }]);
  assert.match(bash.denials[0].denials[0].reason, /No such tool available: Bash/);
  assert.match(play([init(), use("b1", "Bash", { command: "rm x" }), toolResult("b1", "done", false), resultOf("ok")]).failed, /a read-only Claude turn ran Bash/);
});

test("item 2: on a task a Bash call refused by a permission rule is a denial only, never also a failed command", () => {
  const task = fx("task")[0];
  const refusedText = [task, use("p1", "Bash", { command: "git push origin main" }), toolResult("p1", "Permission to use Bash with command git push origin main has been denied."),
    { ...resultOf("task"), permission_denials: [{ tool_name: "Bash", tool_use_id: "p1", tool_input: { command: "git push origin main" } }] }];
  const a = play(refusedText, { readOnly: false });
  assert.deepEqual([a.failed, a.failedCommands, a.denials[0].count], [null, [], 1], "the tool result and permission_denials name one denial");
  const streamed = [task, use("p2", "Bash", { command: "sudo ls" }), { type: "permission_denied", tool_name: "Bash", tool_use_id: "p2", tool_input: { command: "sudo ls" } },
    toolResult("p2", "refused"), resultOf("task")];
  const b = play(streamed, { readOnly: false });
  assert.deepEqual([b.failedCommands, b.denials[0].count], [[], 1], "a streamed permission_denied for the call makes its error a denial");
  const plain = play([task, use("p3", "Bash", { command: "npm test" }), toolResult("p3", "Exit code 1\nfailing test"), resultOf("task")], { readOnly: false });
  assert.deepEqual([plain.failedCommands, plain.denials.length], [["npm test"], 0], "an ordinary non-zero exit stays a failed command");
});

test("item 3: an is_error result after a recorded denial is denied (exit 10) with the error text as the answer; without a denial it fails", () => {
  const failing = { ...resultOf("ok"), is_error: true, subtype: "error_during_execution", terminal_reason: "tool_denied", result: "Stopped: the edit was refused.", total_cost_usd: 0.01 };
  const denied = play([init(), use("e1", "Edit", { file_path: "/scratch/repo/a.js" }), toolResult("e1", "No such tool available: Edit"), failing]);
  assert.deepEqual([denied.failed, denied.completed, denied.denials.length, denied.costUsd], [null, true, 1, 0.01]);
  assert.equal(denied.text, "claude tool_denied: Stopped: the edit was refused.");
  const fromResult = play([init(), { ...failing, permission_denials: [{ tool_name: "Read", tool_input: { file_path: "/etc/x" } }] }]);
  assert.deepEqual([fromResult.failed, fromResult.denials[0].count], [null, 1], "denials reported only in the result count too");
  assert.match(play([init(), failing]).failed, /^claude tool_denied: Stopped/, "no denial: the turn failed (exit 1)");
});
