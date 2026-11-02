// S4.2: buildTurn, with GROKX's recipe() and compatEnv() ported whole: the A5.1 argv per verb (explore, RESUME_DENY after a
// default-agent turn, the write recipe on tasks), the prompt file composed from the turn's instructions and the text, the
// --rules contract text or the inline --json-schema, --session-id / -r, --web, and checkRequest's repository-root rule.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { ROOT, tmp, initGitRepo, commitFile } from "./helpers.mjs";
import grok, { HOSTILE, RESUME_DENY, compatEnv, framePrompt, parseModels, recipe } from "../plugins/council/scripts/lib/providers/grok.mjs";

const CONTRACT = path.join(ROOT, "plugins", "council", "contract.md");
const SCHEMA_PATH = path.join(ROOT, "plugins", "council", "schemas", "review-output.schema.json");
const CONTRACT_LINE = fs.readFileSync(CONTRACT, "utf8").replace(/\s*\r?\n\s*/g, " ").trim();
const flag = (argv, name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const request = (extra = {}) => ({ verb: "ask", nextInput: false, text: "q", prompt: "q", instructions: "Instructions for this turn (advice, read-only).\n", contractPath: CONTRACT,
  model: "grok-4.7", effort: "low", resume: false, threadId: null, cwd: os.tmpdir(), env: { PATH: "/bin", HOME: "/h" }, schemaPath: null, structured: false, readOnly: true, web: false,
  allowCommands: [], maxTurns: null, maxBudgetUsd: null, policy: {}, agent: null, jobDir: "/state/jobs/abcdefghijklmnop", launcher: null, ...extra });

test("ask: the A5.1 argv in order, a fresh session uuid claimed before spawn, the prompt file composed, agent explore", () => {
  const b = grok.buildTurn(request());
  assert.deepEqual(b.args.slice(0, 10), ["--prompt-file", path.join("/state/jobs/abcdefghijklmnop", "prompt.md"), "--output-format", "streaming-json", "--model", "grok-4.7", "--effort", "low", "--no-auto-update", "--agent"]);
  assert.deepEqual(b.args.slice(9, 18), ["--agent", "explore", "--always-approve", "--no-subagents", "--disable-web-search", "--disallowed-tools", HOSTILE.join(","), "--deny", "MCPTool(*)"]);
  assert.deepEqual(b.args.slice(18, 20), ["--rules", CONTRACT_LINE]);
  assert.equal(b.args[20], "--session-id");
  assert.equal(b.args[21], b.requestedThreadId);
  assert.equal(b.args.length, 22);
  assert.deepEqual([b.promptFile, b.promptText, b.stdin, b.readOnly, b.agent, b.answerFile], [path.join("/state/jobs/abcdefghijklmnop", "prompt.md"), "Instructions for this turn (advice, read-only).\n\nq", undefined, true, "explore", null]);
  assert.deepEqual([b.env.PATH, b.env.GROK_CLAUDE_RULES_ENABLED, b.env.GROK_CODEX_DEPTH], ["/bin", "0", "1"]);
  assert.notEqual(grok.buildTurn(request()).requestedThreadId, b.requestedThreadId);
});

test("reply and task --thread resume with -r; the recipe follows the session's agent; a task uses the write recipe", () => {
  const reply = grok.buildTurn(request({ verb: "reply", resume: true, threadId: "S1", agent: "explore" }));
  assert.deepEqual([flag(reply.args, "-r"), reply.args.includes("--session-id"), reply.requestedThreadId, reply.agent, flag(reply.args, "--agent")], ["S1", false, null, "explore", "explore"]);
  const afterTask = grok.buildTurn(request({ verb: "reply", resume: true, threadId: "S1", agent: "default" }));
  assert.deepEqual([afterTask.agent, afterTask.args.includes("--agent"), flag(afterTask.args, "--disallowed-tools"), flag(afterTask.args, "--deny")], ["default", false, RESUME_DENY.join(","), "MCPTool(*)"]);
  const task = grok.buildTurn(request({ verb: "task", readOnly: false, resume: true, threadId: "S1", agent: "explore", instructions: "Instructions for this turn (task).\n" }));
  assert.deepEqual([task.readOnly, task.agent, task.args.includes("--agent"), flag(task.args, "-r")], [false, "default", false, "S1"]);
  assert.deepEqual(task.args.filter((a, i) => task.args[i - 1] === "--deny"), ["Bash(git push*)", "Bash(rm -rf *)"]);
  assert.equal(Object.hasOwn(task.env, "GROK_CLAUDE_RULES_ENABLED"), false);
  assert.match(task.promptText, /^Instructions for this turn \(task\)\.\n\nq$/);
  const fresh = grok.buildTurn(request({ agent: "default" }));
  assert.equal(fresh.agent, "explore", "a new thread never inherits an agent");
});

test("structured turns carry the repository schema inline and no --rules; the batch prompt is not framed", () => {
  const prompt = "Instructions for this turn (structured code review, read-only).\n<review_input>…</review_input>\n";
  const b = grok.buildTurn(request({ verb: "review", prompt, instructions: null, structured: true, schemaPath: SCHEMA_PATH }));
  assert.equal(flag(b.args, "--json-schema"), JSON.stringify(JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf8"))));
  assert.equal(b.args.includes("--rules"), false);
  assert.deepEqual([b.promptText, b.agent, b.contractCarrier], [prompt, "explore", "none"]);
  const next = grok.buildTurn(request({ verb: "reply", nextInput: true, resume: true, threadId: "S", prompt, instructions: null, structured: true, schemaPath: SCHEMA_PATH, agent: "explore" }));
  assert.ok(next.args.includes("--json-schema") && !next.args.includes("--rules"));
});

test("--web drops --disable-web-search; text with edge whitespace is framed after the instructions", () => {
  assert.equal(grok.buildTurn(request({ web: true })).args.includes("--disable-web-search"), false);
  assert.equal(grok.buildTurn(request({ prompt: "  indented\n", instructions: "I.\n" })).promptText, "I.\n\n<r-abcdefghijklmnop>\n  indented\n\n</r-abcdefghijklmnop>");
});

test("checkRequest: a review must run at the repository root; other verbs and the root itself pass", () => {
  const repo = tmp();
  initGitRepo(repo);
  commitFile(repo, "a.txt", "a\n");
  fs.mkdirSync(path.join(repo, "sub"));
  assert.equal(grok.checkRequest(request({ verb: "review", cwd: repo }), { PATH: process.env.PATH }), null);
  assert.match(grok.checkRequest(request({ verb: "review", cwd: path.join(repo, "sub") }), { PATH: process.env.PATH }), /^grok reviews run at the repository root/);
  assert.equal(grok.checkRequest(request({ verb: "ask", cwd: path.join(repo, "sub") }), { PATH: process.env.PATH }), null);
});

test("framePrompt, recipe and compatEnv are GROKX's", () => {
  assert.equal(framePrompt("plain", "j"), "plain");
  assert.equal(framePrompt(" lead", "j"), "<r-j>\n lead\n</r-j>");
  assert.equal(framePrompt("trail\n", "j"), "<r-j>\ntrail\n\n</r-j>");
  assert.deepEqual(recipe("read-only").args, ["--agent", "explore", "--always-approve", "--no-subagents", "--disable-web-search", "--disallowed-tools", HOSTILE.join(","), "--deny", "MCPTool(*)"]);
  assert.deepEqual(recipe("read-only", { web: true, defaultAgent: true }).args, ["--always-approve", "--no-subagents", "--disallowed-tools", RESUME_DENY.join(","), "--deny", "MCPTool(*)"]);
  assert.deepEqual(recipe("write").args.slice(-4), ["--deny", "Bash(git push*)", "--deny", "Bash(rm -rf *)"]);
  assert.throws(() => recipe("other"), /unknown recipe/);
  const ro = compatEnv({ GROK_CLAUDE_RULES_ENABLED: "1", X: "y" }, true), rw = compatEnv({ GROK_CLAUDE_RULES_ENABLED: "0" }, false);
  assert.deepEqual([ro.GROK_CLAUDE_RULES_ENABLED, ro.X, ro.GROK_CODEX_DEPTH, ro.GROK_BUILD_DEPTH, ro.COUNCIL_DEPTH, ro.GROK_DISABLE_AUTOUPDATER], ["0", "y", "1", "1", "1", "1"]);
  assert.equal(Object.hasOwn(rw, "GROK_CLAUDE_RULES_ENABLED"), false);
  assert.deepEqual(parseModels("You are not logged in.\n"), { models: [], loggedIn: false, denied: "You are not logged in." });
});
