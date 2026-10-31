#!/usr/bin/env node
// A stand-in for the Grok CLI (1.0.70). Adapted from grok_plugin_for_codex 1.1.0 tests/fake-grok.mjs; the streams come
// from the S1.3 probes (tests/fixtures/streams/grok.json carries the provenance). It validates the A5.1 launch contract
// (recipe flags, prompt file, rules or schema carrier, compatEnv and guard variables) before emitting and plays
// COUNCIL_FAKE_SCENARIO: ok, resume, denied, effort-error, review-findings, review-malformed, large-review, slow, hold-pipes.
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { UUID, batchOf, checkArgv, deepEqual, emitJson, expect, fileExists, flagValue, flagValues, holdPipes, log, mismatch, readStdin, repoSchema,
  requireDepth, scenario, sleep, spikeText, streams, SLOW_MS } from "./fake-common.mjs";

const argv = process.argv.slice(2);
const which = scenario();
const HOSTILE = ["Agent", "ask_user_question", "enter_plan_mode", "exit_plan_mode", "image_gen", "image_edit", "image_to_video", "reference_to_video"];
const RESUME_DENY_MARKERS = ["search_replace", "write", "run_terminal_cmd", "search_tool", "use_tool"];

if (argv[0] === "--version" || argv[0] === "version" || argv[0] === "-v") { log({ probe: "version", argv }); console.log("grok 1.0.70 (f50904eaee6c) [stable]"); process.exit(0); }
if (argv[0] === "models") {
  log({ probe: "models", argv });
  process.stdout.write(process.env.COUNCIL_FAKE_LOGGED_OUT ? "You are not logged in.\n" : spikeText("grok-models.txt"));
  process.exit(0);
}
if (argv.includes("--help")) { log({ probe: "help", argv }); process.stdout.write(spikeText("grok-help.txt")); process.exit(0); }

checkArgv(argv, { boolean: ["--no-auto-update", "--always-approve", "--no-subagents", "--disable-web-search"],
  value: ["--prompt-file", "--output-format", "--model", "--effort", "--agent", "--disallowed-tools", "--deny", "--rules", "--json-schema", "--session-id", "-r", "--resume", "--add-dir"] });
const promptFile = flagValue(argv, "--prompt-file");
expect(fileExists(promptFile), "--prompt-file names an existing file", promptFile);
const prompt = fs.readFileSync(promptFile, "utf8");
expect(prompt.length > 0, "prompt file is not empty");
expect(flagValue(argv, "--output-format") === "streaming-json", "--output-format streaming-json");
expect(flagValue(argv, "--model"), "--model is required");
expect(["low", "medium", "high", "xhigh"].includes(flagValue(argv, "--effort")) || which === "effort-error", "--effort low|medium|high|xhigh", flagValue(argv, "--effort"));
expect(argv.includes("--no-auto-update") && argv.includes("--always-approve") && argv.includes("--no-subagents"), "--no-auto-update --always-approve --no-subagents");
expect(!argv.includes("--add-dir"), "--add-dir is not supported by a grok session");
const disallowed = (flagValue(argv, "--disallowed-tools") ?? "").split(",").filter(Boolean);
expect(HOSTILE.every((t) => disallowed.includes(t)), "--disallowed-tools carries the HOSTILE list", disallowed);
const denies = flagValues(argv, "--deny");
const explore = flagValue(argv, "--agent") === "explore";
const resumeDeny = RESUME_DENY_MARKERS.every((t) => disallowed.includes(t));
const readOnly = explore || resumeDeny;
if (readOnly) {
  expect(denies.includes("MCPTool(*)"), "read-only turns deny MCPTool(*)", denies);
  expect(process.env.GROK_CLAUDE_RULES_ENABLED === "0", "read-only turns set GROK_CLAUDE_RULES_ENABLED=0");
} else {
  expect(denies.includes("Bash(git push*)") && denies.includes("Bash(rm -rf *)"), "write turns deny Bash(git push*) and Bash(rm -rf *)", denies);
  expect(process.env.GROK_CLAUDE_RULES_ENABLED === undefined, "write turns leave GROK_CLAUDE_RULES_ENABLED unset");
}
const sessionId = flagValue(argv, "--session-id"), resumeId = flagValue(argv, "-r") ?? flagValue(argv, "--resume");
expect((sessionId === undefined) !== (resumeId === undefined), "exactly one of --session-id or -r");
if (sessionId) expect(UUID.test(sessionId), "--session-id is a uuid", sessionId);
if (which === "resume") expect(resumeId, "resume needs -r");
const schemaText = flagValue(argv, "--json-schema");
let schema = null;
if (schemaText !== undefined) {
  try { schema = JSON.parse(schemaText); } catch { mismatch("--json-schema must be inline JSON"); }
  expect(deepEqual(schema, repoSchema()), "--json-schema must be the repository review schema");
}
if (schema) expect(!argv.includes("--rules"), "reviews carry --json-schema and no --rules");
else expect(fileExists(flagValue(argv, "--rules")), "non-review turns carry --rules <contract file>", flagValue(argv, "--rules"));
if (which.startsWith("review") || which === "large-review") expect(schema, `${which} needs --json-schema`);
const web = !argv.includes("--disable-web-search");
for (const [k, v] of Object.entries({ GROK_DISABLE_AUTOUPDATER: "1", GROK_CLAUDE_SKILLS_ENABLED: "0", GROK_CLAUDE_AGENTS_ENABLED: "0", GROK_CLAUDE_HOOKS_ENABLED: "0", GROK_CLAUDE_MCPS_ENABLED: "0" })) {
  expect(process.env[k] === v, `compatEnv sets ${k}=${v}`, process.env[k]);
}
requireDepth();
const stdin = await readStdin();
expect(stdin.length === 0, "grok reads no stdin: the prompt is the --prompt-file operand", stdin.length);
const session = sessionId ?? resumeId;
log({ argv, cwd: process.cwd(), prompt, session, agent: explore ? "explore" : "default", readOnly, web, env: Object.fromEntries(Object.entries(process.env).filter(([k]) => /^GROK_|DEPTH$/.test(k))) });

const fixtures = streams("grok");
const fill = (events) => events.map((e) => JSON.parse(JSON.stringify(e).replaceAll("<SESSION>", session).replaceAll("<CWD>", process.cwd()).replaceAll("<REQUEST>", randomUUID())));
let exitCode = 0;
const play = (events) => { for (const e of events) { emitJson(e); if (e.type === "error") exitCode = 1; } };
switch (which) {
  case "ok": case "slow": case "hold-pipes": {
    if (which === "slow") await sleep(SLOW_MS);
    play(fill(fixtures.ok));
    if (which === "hold-pipes") holdPipes();
    break;
  }
  case "resume": play(fill(fixtures.resume)); break;
  case "denied": play(fill(fixtures.denied)); break;
  case "effort-error": play(fill(fixtures["effort-error"])); process.stderr.write(`${fixtures["effort-error-stderr"]}\n`); break;
  case "review-findings": play(fill(fixtures["review-findings"])); break;
  case "review-malformed": play(fill(fixtures["review-malformed"])); break;
  case "large-review": { const b = batchOf(prompt); play(fill(b && b.index >= b.total ? fixtures["structured-clean"] : fixtures["review-findings"])); break; }
  default: mismatch(`unknown scenario ${which}`);
}
process.exit(exitCode);
