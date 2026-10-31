#!/usr/bin/env node
// A stand-in for the Claude Code CLI (2.1.314). Adapted from claude_plugin_for_codex 0.5.0 tests/fixtures/fake-claude.mjs
// and streams.json; the streams come from the S1.1 probes (tests/fixtures/streams/claude.json carries the provenance).
// It validates the A5.1 launch contract before emitting, answers the four cold preflight probes, and plays
// COUNCIL_FAKE_SCENARIO: ok, resume, denied, tool-absent, effort-error, review-findings, review-malformed, large-review,
// task, slow, hold-pipes, missing-result, duplicate-result, wrong-session, is-error, turn-limit.
import fs from "node:fs";
import { UUID, batchOf, emitJson, expect, fileExists, flagValue, holdPipes, log, mismatch, readStdin, requireDepth,
  scenario, sleep, spikeText, streams, SLOW_MS } from "./fake-common.mjs";

const argv = process.argv.slice(2);
const which = scenario();
const READ_ONLY_TOOLS = new Set(["Read", "Glob", "Grep", "WebFetch", "WebSearch"]);
const EDIT_TOOLS = ["Edit", "Write", "MultiEdit", "NotebookEdit", "Bash"];

// Cold preflight probes (A1): --version, auth status --json, --help, the missing-file capability probe.
if (argv.includes("--version")) { log({ probe: "version", argv }); console.log("2.1.314 (Claude Code)"); process.exit(0); }
if (argv[0] === "auth" && argv[1] === "status") {
  log({ probe: "auth", argv });
  console.log(JSON.stringify({ loggedIn: process.env.COUNCIL_FAKE_LOGGED_OUT ? false : true, authMethod: "claude.ai", apiProvider: "firstParty",
    configDirectory: process.env.COUNCIL_FAKE_CONFIG_DIR || "/nonexistent/.claude", subscriptionType: "max" }));
  process.exit(process.env.COUNCIL_FAKE_LOGGED_OUT ? 1 : 0);
}
if (argv.includes("--help")) { log({ probe: "help", argv }); process.stdout.write(spikeText("claude-help.txt")); process.exit(0); }
if (argv.includes("--append-system-prompt-file") && !fileExists(flagValue(argv, "--append-system-prompt-file"))) {
  log({ probe: "capability", argv });
  console.error(`Error: Append system prompt file not found: ${flagValue(argv, "--append-system-prompt-file")}`);
  process.exit(1);
}
if (argv.includes("models") && !argv.includes("--input-format")) mismatch("`claude models` is not a subcommand: it would run a paid prompt");

// Launch contract (A5.1 claude).
expect(argv[0] === "-p", "first argument must be -p", argv[0]);
expect(flagValue(argv, "--input-format") === "stream-json" && flagValue(argv, "--output-format") === "stream-json" && argv.includes("--verbose"), "stream-json in, stream-json out, --verbose");
const sessionId = flagValue(argv, "--session-id"), resumeId = flagValue(argv, "--resume");
expect((sessionId === undefined) !== (resumeId === undefined), "exactly one of --session-id or --resume");
const session = sessionId ?? resumeId;
expect(UUID.test(session), "session uuid", session);
expect(flagValue(argv, "--system-prompt-snapshot") === "on", "--system-prompt-snapshot on");
expect(fileExists(flagValue(argv, "--append-system-prompt-file")), "--append-system-prompt-file names an existing file");
const maxTurns = Number(flagValue(argv, "--max-turns"));
expect(Number.isInteger(maxTurns) && maxTurns >= 1 && maxTurns <= 100, "--max-turns in 1..100", flagValue(argv, "--max-turns"));
expect(["low", "medium", "high", "xhigh", "max"].includes(flagValue(argv, "--effort")) || which === "effort-error", "--effort low|medium|high|xhigh|max", flagValue(argv, "--effort"));
const mode = flagValue(argv, "--permission-mode");
expect(["dontAsk", "acceptEdits"].includes(mode), "--permission-mode dontAsk|acceptEdits", mode);
expect(flagValue(argv, "--permission-prompts") === "none", "--permission-prompts none");
expect(flagValue(argv, "--setting-sources") === "user", "--setting-sources user");
expect(argv.includes("--no-chrome"), "--no-chrome");
expect(flagValue(argv, "--settings") === '{"disableAllHooks":true}', "--settings disables hooks", flagValue(argv, "--settings"));
if (!process.env.COUNCIL_FAKE_ALLOW_MCP) expect(flagValue(argv, "--mcp-config") === '{"mcpServers":{}}' && argv.includes("--strict-mcp-config"), "MCP off: --mcp-config {\"mcpServers\":{}} --strict-mcp-config");
const tools = (flagValue(argv, "--tools") ?? "").split(",").filter(Boolean);
// --allowedTools and --disallowedTools are variadic: their values run until the next option.
const variadic = (name) => { const i = argv.indexOf(name); if (i < 0) return []; const out = []; for (let j = i + 1; j < argv.length && !argv[j].startsWith("-"); j += 1) out.push(...argv[j].split(",")); return out; };
const disallowed = variadic("--disallowedTools");
const allowed = variadic("--allowedTools");
if (mode === "dontAsk") {
  expect(tools.length > 0 && tools.every((t) => READ_ONLY_TOOLS.has(t)), "read-only turns carry only Read,Glob,Grep(,WebFetch,WebSearch)", tools);
  for (const web of ["WebFetch", "WebSearch"]) if (tools.includes(web)) expect(allowed.includes(web), `${web} needs --allowedTools too`);
} else {
  expect(EDIT_TOOLS.every((t) => tools.includes(t)) && ["Read", "Glob", "Grep"].every((t) => tools.includes(t)), "task turns carry Read,Glob,Grep plus the edit tools", tools);
  expect(EDIT_TOOLS.every((t) => allowed.includes(t)), "task turns allow the edit tools", allowed);
  for (const rule of ["Bash(git push*)", "Bash(git reset --hard*)", "Bash(rm -rf *)", "Bash(sudo *)"]) expect(disallowed.includes(rule), `task turns disallow ${rule}`, disallowed);
}
const schemaText = flagValue(argv, "--json-schema");
let schema = null;
if (schemaText !== undefined) {
  try { schema = JSON.parse(schemaText); } catch { mismatch("--json-schema must be inline JSON"); }
  expect(schema.$schema === "http://json-schema.org/draft-07/schema#", "--json-schema must be draft-07", schema.$schema);
}
// Every bare token must be the value of an option: the prompt never travels on argv.
const VALUE_OPTIONS = new Set(["--input-format", "--output-format", "--session-id", "--resume", "--system-prompt-snapshot", "--append-system-prompt-file",
  "--max-turns", "--effort", "--model", "--permission-mode", "--permission-prompts", "--setting-sources", "--tools", "--mcp-config", "--settings", "--json-schema",
  "--max-budget-usd", "--add-dir"]);
for (let i = 1; i < argv.length; i += 1) {
  const token = argv[i];
  if (token === "--allowedTools" || token === "--disallowedTools") { while (i + 1 < argv.length && !argv[i + 1].startsWith("-")) i += 1; continue; }
  if (token.startsWith("-")) { if (VALUE_OPTIONS.has(token)) i += 1; continue; }
  mismatch("bare token on argv: the prompt must travel on stdin", token);
}
requireDepth();
if (which === "resume" || which === "tool-absent") expect(resumeId, `${which} needs --resume`);
if (which === "task") expect(mode === "acceptEdits", "task scenario needs the acceptEdits launch");
if (which === "tool-absent") expect(mode === "dontAsk", "tool-absent scenario is a read-only resume");
if (which.startsWith("review") || which === "large-review") expect(schema, `${which} needs --json-schema`);

const stdin = await readStdin();
const lines = stdin.split("\n").filter(Boolean);
expect(lines.length === 1, "stdin carries exactly one NDJSON line", lines.length);
let input;
try { input = JSON.parse(lines[0]); } catch { mismatch("stdin line is not JSON"); }
expect(input.type === "user" && input.session_id === session && input.message?.role === "user" && typeof input.message.content === "string" && input.parent_tool_use_id === null,
  "stdin line is {type:user, session_id:<uuid>, message:{role:user, content}, parent_tool_use_id:null}");
log({ argv, cwd: process.cwd(), prompt: input.message.content, session, mode, tools, env: Object.fromEntries(Object.entries(process.env).filter(([k]) => /DEPTH$/.test(k))) });

const fixtures = streams("claude");
const fill = (events, id = session) => events.map((e) => JSON.parse(JSON.stringify(e).replaceAll("<SESSION>", id)));
let exitCode = 0;
const play = (events) => { for (const e of events) { emitJson(e); if (e.type === "result" && e.is_error) exitCode = 1; } };
switch (which) {
  case "ok": case "slow": case "hold-pipes": case "effort-error": {
    if (which === "effort-error") process.stderr.write(`${fixtures["effort-error-stderr"]}\n`);
    if (which === "slow") await sleep(SLOW_MS);
    play(fill(fixtures.ok));
    if (which === "hold-pipes") holdPipes();
    break;
  }
  case "resume": play(fill(fixtures.resume)); break;
  case "denied": play(fill(fixtures.denied)); break;
  case "tool-absent": play(fill(fixtures["tool-absent"])); break;
  case "task": play(fill(fixtures.task)); break;
  case "review-findings": play(fill(fixtures["review-findings"])); break;
  case "review-malformed": play(fill(fixtures["review-malformed"])); break;
  case "large-review": {
    const batch = batchOf(input.message.content);
    play(fill(batch && batch.index >= batch.total ? fixtures["structured-clean"] : fixtures["review-findings"]));
    break;
  }
  case "missing-result": play(fill(fixtures.ok.filter((e) => e.type !== "result"))); exitCode = 1; break;
  case "duplicate-result": { const ok = fill(fixtures.ok); play(ok); play(ok.filter((e) => e.type === "result")); break; }
  case "wrong-session": play(fill(fixtures.ok, "00000000-0000-4000-8000-000000000099")); break;
  case "is-error": play(fill(fixtures["is-error"])); break;
  case "turn-limit": play(fill(fixtures["turn-limit"])); break;
  default: mismatch(`unknown scenario ${which}`);
}
process.exit(exitCode);
