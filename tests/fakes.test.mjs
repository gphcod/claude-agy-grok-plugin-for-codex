// S1.5: every fake in every scenario, against the recorded streams; a non-conforming launch exits 99 before any output.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIX = path.join(ROOT, "tests", "fixtures");
const SCHEMA = path.join(ROOT, "plugins", "council", "schemas", "review-output.schema.json");
const streams = (p) => JSON.parse(fs.readFileSync(path.join(FIX, "streams", `${p}.json`), "utf8"));
const UUID = "11111111-1111-4111-8111-111111111111";
const DEPTH = { COUNCIL_DEPTH: "1", CLAUDE_PLUGIN_CODEX_DEPTH: "1", GROK_CODEX_DEPTH: "1", GROK_BUILD_DEPTH: "1", AGY_BRIDGE_DEPTH: "1" };
const COMPAT = { GROK_DISABLE_AUTOUPDATER: "1", GROK_CLAUDE_SKILLS_ENABLED: "0", GROK_CLAUDE_AGENTS_ENABLED: "0", GROK_CLAUDE_HOOKS_ENABLED: "0", GROK_CLAUDE_MCPS_ENABLED: "0" };
const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(COUNCIL|CLAUDE|CODEX|GROK|AGY)/.test(k) && k !== "CLAUDECODE"));
const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "council-fakes-")));
const contract = path.join(dir, "contract.md");
fs.writeFileSync(contract, "contract\n");
const readOnlySettings = path.join(dir, "settings-ro.json");
fs.writeFileSync(readOnlySettings, JSON.stringify({ permissions: { allow: ["read_file(*)"], ask: [], deny: ["write_file(*)", "edit_file(*)", "command(*)", "unsandboxed(*)", "mcp(*)", "execute_url(*)"] }, agentMode: "", toolPermission: "request-review" }));
const taskSettings = path.join(dir, "settings-task.json");
fs.writeFileSync(taskSettings, JSON.stringify({ permissions: { allow: ["command(node check.mjs)", "unsandboxed(node check.mjs)"], ask: [], deny: [] }, toolPermission: "request-review" }));
const promptFile = (text) => { const f = path.join(dir, `prompt-${Math.random().toString(36).slice(2)}.txt`); fs.writeFileSync(f, text); return f; };

function run(fake, args, { stdin = "", env = {}, scenario, timeout = 20000 } = {}) {
  const r = spawnSync(process.execPath, [path.join(FIX, fake), ...args], { cwd: dir, encoding: "utf8", input: stdin, timeout,
    env: { ...baseEnv, ...env, ...(scenario ? { COUNCIL_FAKE_SCENARIO: scenario } : {}) } });
  const events = r.stdout.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return { RAW: l }; } });
  return { ...r, events };
}
// Claude launches.
const claudeArgs = ({ resume = false, task = false, schema = false, effort = "low", model, web = false } = {}) => [
  "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", ...(resume ? ["--resume", UUID] : ["--session-id", UUID]),
  "--system-prompt-snapshot", "on", "--append-system-prompt-file", contract, "--max-turns", "2", "--effort", effort,
  ...(model ? ["--model", model] : []), "--permission-mode", task ? "acceptEdits" : "dontAsk", "--permission-prompts", "none", "--setting-sources", "user",
  "--tools", task ? "Read,Glob,Grep,Edit,Write,MultiEdit,NotebookEdit,Bash" : web ? "Read,Glob,Grep,WebFetch,WebSearch" : "Read,Glob,Grep",
  ...(task ? ["--allowedTools", "Edit,Write,MultiEdit,NotebookEdit,Bash"] : web ? ["--allowedTools", "WebFetch,WebSearch"] : []),
  "--mcp-config", '{"mcpServers":{}}', "--strict-mcp-config", "--settings", '{"disableAllHooks":true}', "--no-chrome",
  ...(schema ? ["--json-schema", fs.readFileSync(SCHEMA, "utf8")] : []),
  ...(task ? ["--disallowedTools", "Bash(git push*)", "Bash(git reset --hard*)", "Bash(rm -rf *)", "Bash(sudo *)"] : []),
];
const claudeStdin = (content, id = UUID) => `${JSON.stringify({ type: "user", session_id: id, message: { role: "user", content }, parent_tool_use_id: null })}\n`;
const claude = (scenario, opts = {}, content = "hello") => run("fake-claude.mjs", claudeArgs(opts), { stdin: claudeStdin(content), env: DEPTH, scenario });
const result = (events, type = "result") => events.filter((e) => e.type === type || e.event === type);

test("fake-claude answers the four cold preflight probes without a model turn", () => {
  assert.match(run("fake-claude.mjs", ["--version"]).stdout, /^2\.1\.314 \(Claude Code\)/);
  const auth = run("fake-claude.mjs", ["auth", "status", "--json"]);
  assert.equal(JSON.parse(auth.stdout).loggedIn, true);
  assert.match(run("fake-claude.mjs", ["--help"]).stdout, /--permission-mode <mode>/);
  const cap = run("fake-claude.mjs", ["-p", "--append-system-prompt-file", path.join(dir, "missing.md"), "--max-turns", "1", "--tools", ""]);
  assert.equal(cap.status, 1);
  assert.match(cap.stderr, /Append system prompt file not found: .*missing\.md/);
  assert.equal(run("fake-claude.mjs", ["models"]).status, 99, "`claude models` is a paid prompt, never a probe");
});

test("fake-claude plays every scenario against the recorded streams", () => {
  const fx = streams("claude");
  const ok = claude("ok");
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual(ok.events.map((e) => e.type), fx.ok.map((e) => e.type));
  assert.equal(result(ok.events)[0].result, "pong");
  assert.equal(result(ok.events)[0].session_id, UUID);
  assert.equal(ok.events[0].session_id, UUID, "init carries the launched uuid");
  const resume = claude("resume", { resume: true, model: "sonnet" });
  assert.equal(resume.status, 0, resume.stderr);
  assert.equal(resume.events[0].model, "claude-sonnet-5-5");
  assert.match(result(resume.events)[0].result, /MARKER alpha/, "the snapshot keeps the first system prompt");
  const denied = claude("denied");
  assert.equal(denied.events[0].type, "permission_denied");
  assert.equal(result(denied.events)[0].permission_denials.length, 1);
  const absent = claude("tool-absent", { resume: true });
  assert.ok(absent.events.some((e) => e.type === "assistant" && e.message.content.some((c) => c.type === "tool_use" && c.name === "Edit")));
  assert.ok(absent.events.some((e) => e.type === "user" && JSON.stringify(e.message.content).includes("No such tool available: Edit")));
  assert.deepEqual(result(absent.events)[0].permission_denials, []);
  const effort = claude("effort-error", { effort: "ultra" });
  assert.equal(effort.status, 0);
  assert.match(effort.stderr, /Unknown --effort value 'ultra'/);
  const review = claude("review-findings", { schema: true });
  const structured = result(review.events)[0].structured_output;
  assert.equal(structured.verdict, "needs-attention");
  assert.ok(structured.findings.every((f) => typeof f.id === "string"));
  const malformed = claude("review-malformed", { schema: true });
  assert.ok(result(malformed.events)[0].structured_output.findings.every((f) => f.id === undefined));
  const batch1 = claude("large-review", { schema: true }, "review batch 1/2");
  assert.equal(result(batch1.events)[0].structured_output.verdict, "needs-attention");
  const batch2 = claude("large-review", { schema: true }, "review batch 2/2");
  assert.equal(result(batch2.events)[0].structured_output.verdict, "approve");
  const task = claude("task", { task: true });
  const tools = task.events.filter((e) => e.type === "assistant").flatMap((e) => e.message.content.filter((c) => c.type === "tool_use").map((c) => c.name));
  assert.deepEqual(tools, ["Read", "Edit", "Bash"]);
  assert.equal(result(task.events)[0].result, "edited and ran 0");
  const missing = claude("missing-result");
  assert.equal(result(missing.events).length, 0);
  assert.equal(missing.status, 1);
  assert.equal(result(claude("duplicate-result").events).length, 2);
  assert.equal(result(claude("wrong-session").events)[0].session_id, "00000000-0000-4000-8000-000000000099");
  const isError = claude("is-error", { model: "gpt-6.1-sol" });
  assert.equal(isError.status, 1);
  assert.deepEqual([result(isError.events)[0].is_error, result(isError.events)[0].subtype, result(isError.events)[0].terminal_reason], [true, "success", "api_error"]);
  const limit = claude("turn-limit");
  assert.equal(limit.status, 1);
  assert.equal(result(limit.events)[0].subtype, "error_max_turns");
  const slowStart = Date.now();
  const slow = run("fake-claude.mjs", claudeArgs(), { stdin: claudeStdin("x"), env: { ...DEPTH, COUNCIL_FAKE_SLOW_MS: "600" }, scenario: "slow" });
  assert.equal(slow.status, 0);
  assert.ok(Date.now() - slowStart >= 600);
});

test("fake-claude refuses a non-conforming launch with exit 99 and no output", () => {
  const cases = [
    ["prompt on argv", claudeArgs().concat(["hello"]), claudeStdin("hello"), DEPTH],
    ["both --session-id and --resume", claudeArgs().concat(["--resume", UUID]), claudeStdin("x"), DEPTH],
    ["missing guard variable", claudeArgs(), claudeStdin("x"), { ...DEPTH, AGY_BRIDGE_DEPTH: "" }],
    ["stdin session mismatch", claudeArgs(), claudeStdin("x", "22222222-2222-4222-8222-222222222222"), DEPTH],
    ["edit tool on a read-only turn", claudeArgs().map((a) => (a === "Read,Glob,Grep" ? "Read,Glob,Grep,Edit" : a)), claudeStdin("x"), DEPTH],
    ["task without the disallow list", claudeArgs({ task: true }).slice(0, -5), claudeStdin("x"), DEPTH],
    ["hooks not disabled", claudeArgs().map((a) => (a === '{"disableAllHooks":true}' ? "{}" : a)), claudeStdin("x"), DEPTH],
    ["draft 2020-12 schema", claudeArgs({ schema: true }).map((a) => a.replace("http://json-schema.org/draft-07/schema#", "https://json-schema.org/draft/2020-12/schema")), claudeStdin("x"), DEPTH],
    ["web tool without --allowedTools", claudeArgs({ web: true }).filter((a, i, all) => a !== "--allowedTools" && all[i - 1] !== "--allowedTools"), claudeStdin("x"), DEPTH],
    ["--tools Read alone", claudeArgs().map((a) => (a === "Read,Glob,Grep" ? "Read" : a)), claudeStdin("x"), DEPTH],
    ["unknown flag --dangerously-skip-permissions", claudeArgs().concat(["--dangerously-skip-permissions"]), claudeStdin("x"), DEPTH],
    ["--allowedTools wider than the web tools", claudeArgs({ web: true }).map((a) => (a === "WebFetch,WebSearch" ? "WebFetch,WebSearch,Bash" : a)), claudeStdin("x"), DEPTH],
    ["--allowedTools on a plain read-only turn", claudeArgs().concat(["--allowedTools", "Read"]), claudeStdin("x"), DEPTH],
    ["task tools missing NotebookEdit", claudeArgs({ task: true }).map((a) => (a === "Read,Glob,Grep,Edit,Write,MultiEdit,NotebookEdit,Bash" ? "Read,Glob,Grep,Edit,Write,MultiEdit,Bash" : a)), claudeStdin("x"), DEPTH],
    ["schema with only $schema", claudeArgs().concat(["--json-schema", '{"$schema":"http://json-schema.org/draft-07/schema#"}']), claudeStdin("x"), DEPTH],
    ["schema with one property changed", claudeArgs().concat(["--json-schema", fs.readFileSync(SCHEMA, "utf8").replace('"minimum": 0', '"minimum": 0.5')]), claudeStdin("x"), DEPTH],
    ["two stdin lines", claudeArgs(), claudeStdin("a") + claudeStdin("b"), DEPTH],
    ["stdin without the trailing LF plus junk", claudeArgs(), claudeStdin("a").trimEnd() + " trailing", DEPTH],
    ["value option without a value", claudeArgs().concat(["--model"]), claudeStdin("x"), DEPTH],
  ];
  for (const [label, args, stdin, env] of cases) {
    const r = run("fake-claude.mjs", args, { stdin, env });
    assert.equal(r.status, 99, `${label}: ${r.stderr}`);
    assert.equal(r.stdout, "", `${label}: no output before the contract check`);
    assert.match(r.stderr, /fake launch contract violated/);
  }
});

// agy launches.
const agyArgs = ({ task = false, model = "gemini-4-argon", effort = "low", conversation, schema = false } = {}) => [
  "--input-format", "stream-json", "--output-format", "stream-json", "--disable-slash-commands", "--print-timeout", "120s", "--sandbox",
  "--settings", task ? taskSettings : readOnlySettings, ...(task ? ["--mode", "accept-edits"] : []), "--model", model, ...(effort ? ["--effort", effort] : []),
  ...(conversation ? ["--conversation", conversation] : []), ...(schema ? ["--json-schema", SCHEMA] : []),
];
const agyStdin = (content) => `${JSON.stringify({ event: "user", message: { content } })}\n`;
const agy = (scenario, opts = {}, content = "hello") => run("fake-agy.mjs", agyArgs(opts), { stdin: agyStdin(content), env: DEPTH, scenario });

test("fake-agy answers its probes and plays every scenario", () => {
  assert.equal(run("fake-agy.mjs", ["--version"]).stdout.trim(), "1.4.12");
  assert.match(run("fake-agy.mjs", ["models"]).stdout, /^gemini-4-argon-medium\t/m);
  const fx = streams("agy");
  const ok = agy("ok");
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual(ok.events.map((e) => e.event), fx.ok.map((e) => e.event));
  assert.equal(result(ok.events)[0].result.response, "pong\n");
  assert.equal(ok.events[0].conversation_id, result(ok.events)[0].result.conversation_id);
  const resume = agy("resume", { conversation: "0f53cdde-c4c6-43aa-8087-355ae12cb09f" });
  assert.equal(result(resume.events)[0].result.conversation_id, "0f53cdde-c4c6-43aa-8087-355ae12cb09f");
  assert.equal(result(resume.events)[0].result.num_turns, 2);
  const denied = agy("denied");
  const errors = denied.events.filter((e) => e.step_update?.state === "ERROR").map((e) => [e.step_update.tool_name, e.step_update.tool_info.error.message]);
  assert.deepEqual(errors.map((e) => e[0]), ["write_file", "run_command"]);
  assert.ok(errors.every((e) => /permission check failed|Matches user-configured deny rule/.test(e[1])));
  assert.equal(result(denied.events)[0].result.denied_actions, undefined, "a deny-rule denial leaves denied_actions unset");
  const prompted = agy("denied-prompt", { task: true });
  assert.deepEqual(result(prompted.events)[0].result.denied_actions, [{ action: "command", display_name: "RunCommand" }]);
  assert.match(prompted.stderr, /headless mode cannot prompt for/);
  const effort = agy("effort-error", { model: "gemini-3.8-flash", effort: "xhigh" });
  assert.equal(effort.status, 1);
  assert.equal(result(effort.events)[0].result.status, "ERROR");
  assert.match(result(effort.events)[0].result.error, /invalid model selection/);
  const conflict = agy("effort-conflict", { model: "gemini-3.8-flash-low", effort: null });
  assert.match(result(conflict.events)[0].result.error, /conflicts with --effort=high/);
  const review = agy("review-findings", { schema: true });
  const r = result(review.events)[0].result;
  assert.equal(r.structured_output.verdict, "needs-attention");
  assert.ok("json_schema" in r);
  assert.ok(result(agy("review-malformed", { schema: true }).events)[0].result.structured_output.findings.every((f) => f.id === undefined));
  assert.equal(result(agy("large-review", { schema: true }, "batch 1/2").events)[0].result.structured_output.verdict, "needs-attention");
  assert.equal(result(agy("large-review", { schema: true }, "batch 2/2").events)[0].result.structured_output.verdict, "approve");
  const timeout = agy("print-timeout");
  assert.equal(timeout.status, 0);
  assert.equal(result(timeout.events)[0].result.finished_reason, "print_timeout");
  assert.equal(result(timeout.events)[0].result.response, "");
  const task = agy("task", { task: true, model: "gemini-3.8-flash" });
  assert.equal(task.events.filter((e) => e.step_update?.step_type === "tool" && e.step_update.state === "DONE").length, 2);
  assert.ok(agy("web").events.some((e) => e.step_update?.tool_name === "search_web"));
  const slow = run("fake-agy.mjs", agyArgs(), { stdin: agyStdin("x"), env: { ...DEPTH, COUNCIL_FAKE_SLOW_MS: "500" }, scenario: "slow" });
  assert.equal(slow.status, 0);
});

test("fake-agy accepts task settings that keep a global write_file/edit_file deny and plays the denial (A5.1 keeps the global lists)", () => {
  const retained = path.join(dir, "settings-task-global-deny.json");
  fs.writeFileSync(retained, JSON.stringify({ permissions: { allow: ["command(git status)"], ask: [], deny: ["write_file(*)", "edit_file(*)"] }, toolPermission: "always-proceed" }));
  const r = run("fake-agy.mjs", agyArgs({ task: true }).map((a) => (a === taskSettings ? retained : a)), { stdin: agyStdin("edit value.txt"), env: DEPTH, scenario: "denied" });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.events.some((e) => e.step_update?.state === "ERROR" && e.step_update.tool_name === "write_file"), "the retained deny produces the denial");
  const plain = run("fake-agy.mjs", agyArgs({ task: true }).map((a) => (a === taskSettings ? retained : a)), { stdin: agyStdin("x"), env: DEPTH, scenario: "task" });
  assert.equal(plain.status, 0, "a task without --allow-command keeps the global always-proceed");
});

test("fake-agy refuses a non-conforming launch", () => {
  const emptySchema = path.join(dir, "schema-empty.json");
  fs.writeFileSync(emptySchema, "");
  const wrongSchema = path.join(dir, "schema-wrong.json");
  fs.writeFileSync(wrongSchema, fs.readFileSync(SCHEMA, "utf8").replace('"needs-attention"', '"changes"'));
  const proceedSettings = path.join(dir, "settings-task-proceed.json");
  fs.writeFileSync(proceedSettings, JSON.stringify({ permissions: { allow: ["command(node check.mjs)", "unsandboxed(node check.mjs)"], ask: [], deny: [] }, toolPermission: "always-proceed" }));
  const badSettings = path.join(dir, "settings-bad.json");
  fs.writeFileSync(badSettings, JSON.stringify({ permissions: { allow: ["run_command(*)"], ask: [], deny: ["write_file(*)"] }, agentMode: "", toolPermission: "request-review" }));
  const cases = [
    ["--allow-command forwarded", agyArgs().concat(["--allow-command", "node x"]), DEPTH],
    ["read-only settings without the deny list", agyArgs().map((a) => (a === readOnlySettings ? badSettings : a)), DEPTH],
    ["suffixed id with --effort", agyArgs({ model: "gemini-4-argon-high", effort: "high" }), DEPTH],
    ["family id without --effort", agyArgs({ effort: null }), DEPTH],
    ["no --sandbox", agyArgs().filter((a) => a !== "--sandbox"), DEPTH],
    ["guard variable missing", agyArgs(), { ...DEPTH, COUNCIL_DEPTH: "" }],
    ["two stdin lines", agyArgs(), DEPTH, agyStdin("a") + agyStdin("b")],
    ["unknown flag", agyArgs().concat(["--dangerously-skip-permissions"]), DEPTH],
    ["bare positional", agyArgs().concat(["hello"]), DEPTH],
    ["empty schema file", agyArgs({ schema: true }).map((a) => (a === SCHEMA ? emptySchema : a)), DEPTH],
    ["schema file with a changed enum", agyArgs({ schema: true }).map((a) => (a === SCHEMA ? wrongSchema : a)), DEPTH],
    ["task allow pair under always-proceed", agyArgs({ task: true }).map((a) => (a === taskSettings ? proceedSettings : a)), DEPTH],
  ];
  for (const [label, args, env, stdin = agyStdin("x")] of cases) {
    const r = run("fake-agy.mjs", args, { stdin, env });
    assert.equal(r.status, 99, `${label}: ${r.stderr}`);
    assert.equal(r.stdout, "", label);
  }
});

// Grok launches.
const HOSTILE = "Agent,ask_user_question,enter_plan_mode,exit_plan_mode,image_gen,image_edit,image_to_video,reference_to_video";
const grokArgs = ({ prompt = "hello", resume = false, write = false, review = false, effort = "low", web = false } = {}) => [
  "--prompt-file", promptFile(prompt), "--output-format", "streaming-json", "--model", "grok-4.7", "--effort", effort, "--no-auto-update",
  ...(write ? [] : ["--agent", "explore"]), "--always-approve", "--no-subagents", ...(web ? [] : ["--disable-web-search"]), "--disallowed-tools", HOSTILE,
  ...(write ? ["--deny", "Bash(git push*)", "--deny", "Bash(rm -rf *)"] : ["--deny", "MCPTool(*)"]),
  ...(review ? ["--json-schema", fs.readFileSync(SCHEMA, "utf8")] : ["--rules", contract]), ...(resume ? ["-r", UUID] : ["--session-id", UUID]),
];
const grokEnv = (write = false) => ({ ...DEPTH, ...COMPAT, ...(write ? {} : { GROK_CLAUDE_RULES_ENABLED: "0" }) });
const grok = (scenario, opts = {}) => run("fake-grok.mjs", grokArgs(opts), { env: grokEnv(opts.write), scenario });

test("fake-grok answers its probes and plays every scenario", () => {
  assert.match(run("fake-grok.mjs", ["--version"]).stdout, /^grok 1\.0\.70/);
  assert.match(run("fake-grok.mjs", ["models"]).stdout, /\* grok-4\.6 \(default\)/);
  assert.match(run("fake-grok.mjs", ["--help"]).stdout, /--prompt-file <PATH>/);
  const fx = streams("grok");
  const ok = grok("ok");
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual(ok.events.map((e) => e.type), fx.ok.map((e) => e.type));
  assert.deepEqual(ok.events[0].tools, ["read_file", "list_dir", "grep"]);
  const end = result(ok.events, "end")[0];
  assert.deepEqual([end.sessionId, end.stopReason, Object.keys(end.modelUsage)], [UUID, "end_turn", ["grok-4.7-build"]]);
  assert.equal(end.cwd, dir);
  const resume = grok("resume", { resume: true });
  assert.equal(result(resume.events, "end")[0].sessionId, UUID);
  assert.equal(resume.events.filter((e) => e.type === "text").map((e) => e.data).join(""), "pong 2");
  const denied = grok("denied");
  assert.ok(denied.events[0].tools.includes("write"), "the catalogue advertises an edit tool: the reader fails closed");
  const effort = grok("effort-error", { effort: "max" });
  assert.equal(effort.status, 1);
  assert.match(effort.events[0].message, /unknown effort level 'max'/);
  const review = grok("review-findings", { review: true });
  const structured = result(review.events, "end")[0].structuredOutput;
  assert.equal(structured.verdict, "needs-attention");
  assert.ok(structured.findings.every((f) => typeof f.id === "string"));
  assert.ok(result(grok("review-malformed", { review: true }).events, "end")[0].structuredOutput.findings.every((f) => f.id === undefined));
  assert.equal(result(grok("large-review", { review: true, prompt: "review batch 1/2" }).events, "end")[0].structuredOutput.verdict, "needs-attention");
  assert.equal(result(grok("large-review", { review: true, prompt: "review batch 2/2" }).events, "end")[0].structuredOutput.verdict, "approve");
  const slow = run("fake-grok.mjs", grokArgs(), { env: { ...grokEnv(), COUNCIL_FAKE_SLOW_MS: "500" }, scenario: "slow" });
  assert.equal(slow.status, 0);
});

test("fake-grok refuses a non-conforming launch", () => {
  const cases = [
    ["explore without MCPTool deny", grokArgs().filter((a, i, all) => a !== "MCPTool(*)" && all[i + 1] !== "MCPTool(*)"), grokEnv()],
    ["write recipe without the Bash denies", grokArgs({ write: true }).filter((a, i, all) => !a.startsWith("Bash(") && !all[i + 1]?.startsWith("Bash(")), grokEnv(true)],
    ["review with --rules", grokArgs({ review: true }).concat(["--rules", contract]), grokEnv()],
    ["missing prompt file", grokArgs().map((a) => (a.includes("prompt-") ? path.join(dir, "nope.txt") : a)), grokEnv()],
    ["compatEnv missing", grokArgs(), { ...grokEnv(), GROK_CLAUDE_MCPS_ENABLED: "1" }],
    ["rules enabled on a read-only turn", grokArgs(), { ...grokEnv(), GROK_CLAUDE_RULES_ENABLED: "1" }],
    ["--add-dir", grokArgs().concat(["--add-dir", dir]), grokEnv()],
    ["effort max outside the error scenario", grokArgs({ effort: "max" }), grokEnv()],
    ["bare positional prompt", grokArgs().concat(["hello"]), grokEnv()],
    ["unknown flag", grokArgs().concat(["--dangerously-skip-permissions"]), grokEnv()],
    ["inline schema {}", grokArgs({ review: true }).map((a) => (a.startsWith("{") && a.includes("$schema") ? "{}" : a)), grokEnv()],
    ["inline schema with a changed severity enum", grokArgs({ review: true }).map((a) => (a.startsWith("{") && a.includes("$schema") ? a.replace('"critical"', '"blocker"') : a)), grokEnv()],
    ["non-empty stdin", grokArgs(), grokEnv(), "hello\n"],
  ];
  for (const [label, args, env, stdin = ""] of cases) {
    const r = run("fake-grok.mjs", args, { env, stdin });
    assert.equal(r.status, 99, `${label}: ${r.stderr}`);
    assert.equal(r.stdout, "", label);
  }
});

test("hold-pipes: every fake exits with its result while a grandchild keeps stdout open", async () => {
  const launches = [
    ["fake-claude.mjs", claudeArgs(), claudeStdin("x"), DEPTH],
    ["fake-agy.mjs", agyArgs(), agyStdin("x"), DEPTH],
    ["fake-grok.mjs", grokArgs(), "", grokEnv()],
  ];
  for (const [fake, args, stdin, env] of launches) {
    const child = spawn(process.execPath, [path.join(FIX, fake), ...args], { cwd: dir, env: { ...baseEnv, ...env, COUNCIL_FAKE_SCENARIO: "hold-pipes", COUNCIL_FAKE_HOLD_MS: "1200" }, stdio: ["pipe", "pipe", "pipe"] });
    child.stdin.end(stdin);
    let out = "";
    child.stdout.on("data", (c) => { out += c; });
    const exited = await new Promise((resolve) => child.on("exit", (code) => resolve({ code, at: Date.now() })));
    const closed = await new Promise((resolve) => child.on("close", () => resolve(Date.now())));
    assert.equal(exited.code, 0, `${fake} exit`);
    assert.ok(closed - exited.at >= 900, `${fake}: stdout closed ${closed - exited.at} ms after exit; a held pipe must outlive the process`);
    assert.ok(/"type":"result"|"event":"result"|"type":"end"/.test(out), `${fake} emitted its terminal event`);
  }
});

test("the stream fixtures carry provenance and no scratch paths", () => {
  for (const p of ["claude", "agy", "grok"]) {
    const fx = streams(p);
    assert.ok(fx._provenance.recorded, p);
    for (const key of Object.keys(fx)) if (key !== "_provenance" && !key.endsWith("-stderr")) assert.ok(fx._provenance[key] || key === "structured-clean", `${p}.${key} needs provenance`);
    assert.ok(!JSON.stringify(fx).includes("/private/tmp/"), `${p}: scratch paths sanitized`);
  }
});
