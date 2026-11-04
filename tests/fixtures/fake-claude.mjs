#!/usr/bin/env node
// A stand-in for the Claude Code CLI (2.1.314). Adapted from claude_plugin_for_codex 0.5.0 tests/fixtures/fake-claude.mjs
// and streams.json; the streams come from the S1.1 probes (tests/fixtures/streams/claude.json carries the provenance).
// It validates the A5.1 launch contract before emitting, answers the four cold preflight probes, and plays
// COUNCIL_FAKE_SCENARIO: ok, resume, denied, denied-error, tool-absent, effort-error, review-findings, review-malformed, review-reject, large-review,
// task, task-no-shell, task-no-shell-error, task-edit-error, slow, hold-pipes, missing-result, duplicate-result, wrong-session, is-error, turn-limit.
import fs from "node:fs";
import { UUID, batchOf, checkArgv, deepEqual, emitJson, expect, fileExists, flagValue, holdPipes, log, mismatch, readStdin, repoSchema,
  requireDepth, sameSet, scenario, sleep, spikeText, streams, SLOW_MS } from "./fake-common.mjs";

const argv = process.argv.slice(2);
const which = scenario();
const READ_TOOLS = ["Read", "Glob", "Grep"], WEB_TOOLS = ["WebFetch", "WebSearch"];
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
  const web = tools.some((t) => WEB_TOOLS.includes(t));
  expect(sameSet(tools, web ? [...READ_TOOLS, ...WEB_TOOLS] : READ_TOOLS), "read-only turns carry exactly Read,Glob,Grep (plus WebFetch,WebSearch under --web)", tools);
  expect(sameSet(allowed, web ? WEB_TOOLS : []), "read-only --allowedTools is exactly the web tools under --web, otherwise absent", allowed);
  expect(disallowed.length === 0, "read-only turns carry no --disallowedTools", disallowed);
} else {
  // --web on a task adds the web pair to both lists (A3.3), as on read-only turns.
  const web = tools.some((t) => WEB_TOOLS.includes(t));
  expect(sameSet(tools, [...READ_TOOLS, ...EDIT_TOOLS, ...(web ? WEB_TOOLS : [])]), "task turns carry exactly Read,Glob,Grep,Edit,Write,MultiEdit,NotebookEdit,Bash (plus WebFetch,WebSearch under --web)", tools);
  expect(sameSet(allowed, [...EDIT_TOOLS, ...(web ? WEB_TOOLS : [])]), "task turns allow exactly the edit tools (plus the web pair under --web)", allowed);
  for (const rule of ["Bash(git push*)", "Bash(git reset --hard*)", "Bash(rm -rf *)", "Bash(sudo *)"]) expect(disallowed.includes(rule), `task turns disallow ${rule}`, disallowed);
}
const schemaText = flagValue(argv, "--json-schema");
let schema = null;
if (schemaText !== undefined) {
  try { schema = JSON.parse(schemaText); } catch { mismatch("--json-schema must be inline JSON"); }
  expect(deepEqual(schema, repoSchema()), "--json-schema must be the repository review schema (draft-07)");
}
// Exact arity: only the A5.1 flags, each with its value; unknown flags and bare tokens are violations.
checkArgv(argv.slice(1), { boolean: ["--verbose", "--strict-mcp-config", "--no-chrome"], variadic: ["--allowedTools", "--disallowedTools"],
  value: ["--input-format", "--output-format", "--session-id", "--resume", "--system-prompt-snapshot", "--append-system-prompt-file", "--max-turns", "--effort",
    "--model", "--permission-mode", "--permission-prompts", "--setting-sources", "--tools", "--mcp-config", "--settings", "--json-schema", "--max-budget-usd", "--add-dir"] });
requireDepth();
if (which === "resume" || which === "tool-absent") expect(resumeId, `${which} needs --resume`);
if (which.startsWith("task")) expect(mode === "acceptEdits", `${which} scenario needs the acceptEdits launch`);
if (which === "tool-absent") expect(mode === "dontAsk", "tool-absent scenario is a read-only resume");
if (which.startsWith("review") || which === "large-review") expect(schema, `${which} needs --json-schema`);

const stdin = await readStdin();
const lines = stdin.split("\n");
expect(lines.length === 2 && lines[0] && lines[1] === "", "stdin is exactly one NDJSON line ending in LF", stdin.length);
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
  case "denied-error": { // Synthetic (S3.7): the donor's denied stream whose result is is_error, so the CLI exits 1.
    const events = fill(fixtures.denied).map((e) => (e.type === "result" ? { ...e, is_error: true, subtype: "error_during_execution" } : e));
    play(events);
    break;
  }
  case "tool-absent": play(fill(fixtures["tool-absent"])); break;
  case "task": play(fill(fixtures.task)); break;
  // Synthetic (1.1.6): Claude dropped Bash, as it does when it cannot find Git Bash; the second also ends in an error result.
  case "task-no-shell": case "task-no-shell-error": {
    const events = fill(fixtures.task).map((e) => (e.type === "system" && e.tools ? { ...e, tools: e.tools.filter((t) => t !== "Bash") } : e));
    play(which === "task-no-shell" ? events : events.map((e) => (e.type === "result" ? { ...e, is_error: true, subtype: "error_during_execution" } : e)));
    break;
  }
  case "task-edit-error": {
    // Synthetic mutation of `task` (S3.4): the Edit's tool result is an error and the Bash command exits 1.
    const events = fill(fixtures.task).map((e) => {
      if (e.type !== "user") return e;
      const block = e.message.content[0];
      if (block.tool_use_id === "toolu_01KUE2RkdHpbpsDu54j1e2g6") return { ...e, message: { ...e.message, content: [{ ...block, is_error: true, content: "<tool_use_error>String to replace not found in file.</tool_use_error>" }] } };
      if (block.tool_use_id === "toolu_01UYeVHYP1sN7JMBbE6D74V3") return { ...e, message: { ...e.message, content: [{ ...block, is_error: true, content: "Exit code 1" }] } };
      return e;
    });
    play(events);
    break;
  }
  case "review-findings": play(fill(fixtures["review-findings"])); break;
  case "review-malformed": play(fill(fixtures["review-malformed"])); break;
  case "large-review": {
    const batch = batchOf(input.message.content);
    const last = batch ? batch.index >= batch.total : input.message.content.includes("Final synthesis:");
    play(fill(last ? fixtures["structured-clean"] : fixtures["review-findings"]));
    break;
  }
  case "review-reject": {
    // Synthetic (S3.4): a discussion reply that REJECTs, by id and location, every finding the prompt's prior-findings note lists.
    const listed = [...input.message.content.matchAll(/^- (\S+) (BLOCKER|MAJOR|MINOR) (.+):(\d+) /gm)];
    const severity = { BLOCKER: "high", MAJOR: "medium", MINOR: "low" };
    const findings = listed.map(([, id, rank, file, line]) => ({ id, severity: severity[rank], title: "Rejected", body: "Not a defect: the caller guarantees it.", file,
      line_start: Number(line), line_end: Number(line), confidence: 0.9, recommendation: "None.", decision: "REJECT" }));
    const output = { verdict: "approve", summary: "Every earlier finding is rejected with evidence.", findings, next_steps: [] };
    play(fill(fixtures["structured-clean"]).map((e) => (e.type === "result" ? { ...e, result: JSON.stringify(output), structured_output: output } : e)));
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
