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
