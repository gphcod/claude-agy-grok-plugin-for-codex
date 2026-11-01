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
  assert.equal(d[1].target, path.join("/home/u", ".claude", "projects"));
  assert.equal(claudeStorage({ CLAUDE_CONFIG_DIR: "/cfg" }), path.join("/cfg", "projects"));
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

test("review: read-only set, the repository schema inline as one line, max-turns 2, the batch prompt as the whole input", () => {
  const built = adapter.buildTurn(request({ verb: "review", instructions: null, prompt: "REVIEW PROMPT batch", schemaPath: SCHEMA, structured: true }));
  const a = built.args;
  assert.deepEqual(JSON.parse(value(a, "--json-schema")), JSON.parse(fs.readFileSync(SCHEMA, "utf8")));
  assert.ok(!value(a, "--json-schema").includes("\n"), "one argv line, so the macOS process row stays matchable");
  assert.deepEqual([value(a, "--max-turns"), value(a, "--permission-mode"), value(a, "--tools")], ["2", "dontAsk", "Read,Glob,Grep"]);
  assert.equal(input(built).message.content, "REVIEW PROMPT batch");
  const discussion = adapter.buildTurn(request({ verb: "reply", resume: true, threadId: UUID, instructions: null, prompt: "F1 REJECT", schemaPath: SCHEMA, structured: true }));
  assert.ok(discussion.args.includes("--json-schema"), "a discussion reply on a review thread is structured");
  assert.equal(value(discussion.args, "--max-turns"), "20");
  assert.equal(MAX_TURNS.review, 2);
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
