#!/usr/bin/env node
// A stand-in for the Antigravity CLI (agy 1.4.12). Adapted from gemini-plugin-for-codex 0.1.2 test/fake-agy.mjs; the
// streams come from the S1.2 probes (tests/fixtures/streams/agy.json carries the provenance). It validates the A5.1
// launch contract (argv, the settings file, stdin, guard variables) before emitting and plays COUNCIL_FAKE_SCENARIO:
// ok, resume, denied, denied-prompt, effort-error, effort-conflict, review-findings, review-malformed, large-review,
// print-timeout, task, web, slow, hold-pipes; and, for the S5.5 entry tests, task-edit (writes edited.txt in its cwd),
// duplicate-result, missing-result and empty-response (synthetic mutations of ok), host-denied (ok plus a backend
// persistence error on stderr, AGYX docs/P0.md's sandbox finding), touch (a read-only turn during which the workspace changes), language-server (a long-lived child in agy's process
// group, then no answer until stopped) and language-server-orphan (the child outlives agy, reparented to pid 1).
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { batchOf, checkArgv, deepEqual, emitJson, expect, fileExists, flagValue, holdPipes, log, mismatch, readStdin, repoSchema, requireDepth,
  scenario, sleep, spikeText, streams, SLOW_MS } from "./fake-common.mjs";

const argv = process.argv.slice(2);
const which = scenario();
const READ_ONLY_DENY = ["write_file(*)", "edit_file(*)", "command(*)", "unsandboxed(*)", "mcp(*)", "execute_url(*)"];

if (argv.includes("--version")) { log({ probe: "version", argv }); console.log("1.4.12"); process.exit(0); }
if (argv[0] === "models") { log({ probe: "models", argv }); process.stdout.write(spikeText("agy-models.txt")); process.exit(process.env.COUNCIL_FAKE_LOGGED_OUT ? 1 : 0); }

expect(flagValue(argv, "--input-format") === "stream-json" && flagValue(argv, "--output-format") === "stream-json", "stream-json in and out");
expect(argv.includes("--disable-slash-commands"), "--disable-slash-commands");
expect(/^\d+(\.\d+)?s$/.test(flagValue(argv, "--print-timeout") ?? ""), "--print-timeout <n>s", flagValue(argv, "--print-timeout"));
expect(argv.includes("--sandbox"), "--sandbox");
expect(!argv.includes("--allow-command"), "--allow-command is a council flag, never forwarded to agy");
expect(!argv.includes("--dangerously-skip-permissions"), "never --dangerously-skip-permissions");
const settingsPath = flagValue(argv, "--settings");
expect(fileExists(settingsPath), "--settings names an existing file", settingsPath);
let settings;
try { settings = JSON.parse(fs.readFileSync(settingsPath, "utf8")); } catch { mismatch("settings file is not JSON"); }
const edit = flagValue(argv, "--mode") === "accept-edits";
expect(flagValue(argv, "--mode") === undefined || edit, "--mode is accept-edits or absent", flagValue(argv, "--mode"));
const deny = settings.permissions?.deny ?? [], allow = settings.permissions?.allow ?? [];
if (!edit) {
  for (const rule of READ_ONLY_DENY) expect(deny.includes(rule), `read-only settings deny ${rule}`, deny);
  expect(allow.every((r) => /^(read_file|read_url)\(.*\)$/.test(r)), "read-only allow list holds only read_file/read_url rules", allow);
  expect(settings.agentMode === "" && ["strict", "request-review"].includes(settings.toolPermission), "read-only settings: agentMode \"\" and toolPermission strict|request-review", settings);
} else {
  // Tasks keep the user's global lists (a global write_file(*)/edit_file(*) deny stays and the scenario carries the
  // denial). A task with --allow-command (the command(X)/unsandboxed(X) pair) must run under request-review or strict.
  const pair = allow.some((r) => /^unsandboxed\(.+\)$/.test(r));
  if (pair) expect(["request-review", "strict"].includes(settings.toolPermission), "a task with an allow pair sets toolPermission request-review (or keeps strict)", settings.toolPermission);
}
const model = flagValue(argv, "--model");
expect(model, "--model is required");
const suffix = /-(low|medium|high)$/.exec(model)?.[1];
const effort = flagValue(argv, "--effort");
if (suffix) expect(effort === undefined, "an effort-suffixed id travels alone (no --effort)", { model, effort });
else expect(["low", "medium", "high"].includes(effort) || which === "effort-error", "--effort low|medium|high with a family id", { model, effort });
const conversation = flagValue(argv, "--conversation");
if (which === "resume") expect(conversation, "resume needs --conversation");
const schemaPath = flagValue(argv, "--json-schema");
if (schemaPath !== undefined) {
  expect(fileExists(schemaPath), "--json-schema names an existing file", schemaPath);
  let carried;
  try { carried = JSON.parse(fs.readFileSync(schemaPath, "utf8")); } catch { mismatch("--json-schema file is not JSON", schemaPath); }
  expect(deepEqual(carried, repoSchema()), "--json-schema file must be the repository review schema", schemaPath);
}
if (which.startsWith("review") || which === "large-review") expect(schemaPath, `${which} needs --json-schema`);
if (which === "task") expect(edit, "task scenario needs --mode accept-edits");
checkArgv(argv, { boolean: ["--sandbox", "--disable-slash-commands"],
  value: ["--input-format", "--output-format", "--print-timeout", "--settings", "--mode", "--model", "--effort", "--conversation", "--json-schema", "--add-dir"] });
requireDepth();

const stdin = await readStdin();
const lines = stdin.split("\n");
expect(lines.length === 2 && lines[0] && lines[1] === "", "stdin is exactly one NDJSON user message ending in LF", stdin.length);
let input;
try { input = JSON.parse(lines[0]); } catch { mismatch("stdin line is not JSON"); }
expect(input.event === "user" && typeof input.message?.content === "string", "stdin line is {event:user, message:{content}}");
log({ argv, cwd: process.cwd(), prompt: input.message.content, settings, model, effort, conversation, edit, env: Object.fromEntries(Object.entries(process.env).filter(([k]) => /DEPTH$/.test(k))) });

const fixtures = streams("agy");
const id = conversation ?? randomUUID();
const fill = (events) => events.map((e) => JSON.parse(JSON.stringify(e).replaceAll("<CONVERSATION>", id)));
let exitCode = 0;
const play = (events) => { for (const e of events) { emitJson(e); if (e.event === "result" && e.result?.status === "ERROR") exitCode = 1; } };
switch (which) {
  case "ok": case "slow": case "hold-pipes": {
    if (which === "slow") await sleep(SLOW_MS);
    play(fill(fixtures.ok));
    if (which === "hold-pipes") holdPipes();
    break;
  }
  case "resume": play(fill(fixtures.resume)); break;
  case "denied": play(fill(fixtures.denied)); break;
  case "denied-prompt": play(fill(fixtures["denied-prompt"])); process.stderr.write(`${fixtures["denied-prompt-stderr"]}\n`); break;
  case "effort-error": play(fill(fixtures["effort-error"])); process.stderr.write(`${fixtures["effort-error-stderr"]}\n`); break;
  case "effort-conflict": play(fill(fixtures["effort-conflict"])); process.stderr.write(`${fixtures["effort-conflict-stderr"]}\n`); break;
  case "review-findings": play(fill(fixtures["review-findings"])); break;
  case "review-malformed": play(fill(fixtures["review-malformed"])); break;
  case "large-review": { const b = batchOf(input.message.content); play(fill(b && b.index >= b.total ? fixtures["structured-clean"] : fixtures["review-findings"])); break; }
  case "print-timeout": play(fill(fixtures["print-timeout"])); process.stderr.write(`${fixtures["print-timeout-stderr"]}\n`); break;
  case "task": play(fill(fixtures.task)); break;
  case "web": play(fill(fixtures.web)); break;
  case "duplicate-result": { const events = fill(fixtures.ok); play([...events, events.at(-1)]); break; }
  case "missing-result": play(fill(fixtures.ok).filter((e) => e.event !== "result")); break;
  case "empty-response": play(fill(fixtures.ok).map((e) => (e.event === "result" ? { ...e, result: { ...e.result, response: "" } } : e))); break;
  case "host-denied": play(fill(fixtures.ok)); process.stderr.write("backend: attempt to write a readonly database\n"); break;
  case "task-edit": fs.writeFileSync(path.join(process.cwd(), "edited.txt"), "written by the fake task\n"); play(fill(fixtures.task)); break;
  case "touch": fs.writeFileSync(path.join(process.cwd(), "touched.txt"), "changed during a read-only turn\n"); play(fill(fixtures.ok)); break;
  case "language-server": case "language-server-orphan": {
    // agy's language server stands in as a child in the same process group (not detached), holding no pipes.
    const server = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)", "language_server"], { stdio: "ignore" });
    log({ languageServer: server.pid });
    if (which === "language-server") { emitJson(fill(fixtures.ok)[0]); await sleep(60000); break; }
    server.unref();
    await sleep(Number(process.env.COUNCIL_FAKE_ORPHAN_MS || 800)); // long enough for a heartbeat to record the child
    play(fill(fixtures.ok));
    break;
  }
  default: mismatch(`unknown scenario ${which}`);
}
process.exit(exitCode);
