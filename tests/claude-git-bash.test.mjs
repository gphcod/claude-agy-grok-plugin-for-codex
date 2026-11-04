// 1.1.6: started from a Git Bash shell, the first git on PATH is the mingw copy, Claude misses Git Bash and drops Bash
// without saying so. A task then names Git Bash for the child, and one that still has no Bash ends in attention, not ok.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { makeWorld, footerOf, jobIdOf, ROOT, PLUGIN_ROOT } from "./helpers.mjs";
import adapter, { NO_SHELL, gitBashEnv } from "../plugins/council/scripts/lib/providers/claude.mjs";
import { createReader } from "../plugins/council/scripts/lib/core/reader.mjs";

const FAKE = fileURLToPath(new URL("./fixtures/fake-claude.mjs", import.meta.url));
const STREAMS = JSON.parse(fs.readFileSync(path.join(ROOT, "tests", "fixtures", "streams", "claude.json"), "utf8"));
const UUID = "00000000-0000-4000-8000-000000000001";

/** A throwaway Git for Windows layout; `dirs` are the folders that hold a git.exe, listed on PATH in this order. */
function layout(dirs, { bash = true } = {}) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "council-gitbash-")));
  const full = dirs.map((d) => path.join(root, d));
  for (const dir of full) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, "git.exe"), ""); }
  if (bash) { fs.mkdirSync(path.join(root, "bin"), { recursive: true }); fs.writeFileSync(path.join(root, "bin", "bash.exe"), ""); }
  return { root, bash: path.join(root, "bin", "bash.exe"), env: { PATH: full.join(";"), PATHEXT: ".EXE" }, done: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("the mingw copy first on PATH names that install's Git Bash, for every mingw flavour", () => {
  for (const flavour of ["mingw64", "mingw32", "clangarm64", "ucrt64", "MINGW64"]) {
    const l = layout([path.join(flavour, "bin"), "cmd"]);
    try { assert.deepEqual(gitBashEnv(l.env, "win32"), { CLAUDE_CODE_GIT_BASH_PATH: l.bash }, flavour); } finally { l.done(); }
  }
});

test("a normal Windows PATH, a set value, a missing bash.exe, no git and other platforms change nothing", () => {
  const cmd = layout(["cmd", path.join("mingw64", "bin")]);
  const missing = layout([path.join("mingw64", "bin")], { bash: false });
  const mingw = layout([path.join("mingw64", "bin")]);
  try {
    assert.deepEqual(gitBashEnv(cmd.env, "win32"), {}, "only the first git decides");
    assert.deepEqual(gitBashEnv(missing.env, "win32"), {}, "no such bash.exe");
    assert.deepEqual(gitBashEnv({ ...mingw.env, CLAUDE_CODE_GIT_BASH_PATH: "C:\\mine\\bash.exe" }, "win32"), {}, "the caller's value stands");
    assert.deepEqual(gitBashEnv(mingw.env, "linux"), {}, "Windows only");
    assert.deepEqual(gitBashEnv(mingw.env, "darwin"), {}, "Windows only");
    assert.deepEqual(gitBashEnv({ PATH: "", PATHEXT: ".EXE" }, "win32"), {}, "no git at all");
  } finally { cmd.done(); missing.done(); mingw.done(); }
});

const request = (env, extra = {}) => ({ verb: "ask", prompt: "q", instructions: "ADVICE", contractPath: path.join(PLUGIN_ROOT, "contract.md"), model: null, effort: "low", resume: false, threadId: null, env,
  schemaPath: null, structured: false, web: false, maxTurns: null, maxBudgetUsd: null, policy: { readRoots: [], web: false, allowMcp: false }, ...extra });

test("only a task's child gets the variable; every other verb's environment is unchanged", () => {
  const l = layout([path.join("mingw64", "bin")]);
  try {
    for (const verb of ["ask", "reply", "review"]) assert.equal(adapter.buildTurn(request(l.env, { verb, ...(verb === "reply" ? { resume: true, threadId: UUID } : {}) })).env.CLAUDE_CODE_GIT_BASH_PATH, undefined, verb);
    const task = adapter.buildTurn(request(l.env, { verb: "task" })).env.CLAUDE_CODE_GIT_BASH_PATH;
    assert.equal(task, process.platform === "win32" ? l.bash : undefined);
  } finally { l.done(); }
});

function play(events, readOnly = false) {
  let text = "";
  const reader = createReader(adapter, { cwd: "/scratch/repo", expectedThreadId: UUID, onText: (t) => { text += t; } });
  Object.assign(reader.state.adapter, { readOnly, agent: null });
  for (const e of events) reader.feed(`${JSON.stringify(e).replaceAll("<SESSION>", UUID).replaceAll("<SCRATCH>", "/scratch")}\n`);
  reader.end();
  return { ...reader.state, text };
}
const withTools = (events, tools) => events.map((e) => (e.type === "system" && e.subtype === "init" ? { ...e, tools } : e));
const noBash = STREAMS.task[0].tools.filter((t) => t !== "Bash");

test("init: a task without Bash reports it and keeps its thread, model and answer", () => {
  const seen = play(withTools(STREAMS.task, noBash));
  assert.equal(seen.incomplete, NO_SHELL);
  assert.deepEqual([seen.failed, seen.completed, seen.threadId], [null, true, UUID]);
  assert.ok(seen.model);
  assert.ok(seen.text.trim());
});

test("init: a task with Bash, a read-only turn without it, and an init with no tools list report nothing", () => {
  assert.equal(play(STREAMS.task).incomplete, null);
  assert.equal(play(STREAMS.ok, true).incomplete, null);
  const { tools: _dropped, ...bare } = STREAMS.task[0];
  assert.equal(play([bare, ...STREAMS.task.slice(1)]).incomplete, null);
});

test("no shell never hides a failure: an error result and a malformed stream still fail", () => {
  const error = withTools(STREAMS.task, noBash).map((e) => (e.type === "result" ? { ...e, is_error: true, subtype: "error_during_execution" } : e));
  assert.match(play(error).failed, /^claude /);
  const missing = withTools(STREAMS.task, noBash).map((e) => (e.type === "result" ? { ...e, session_id: undefined } : e));
  assert.match(play(missing).failed, /no session id/);
});

function world() {
  const w = makeWorld();
  Object.assign(w.env, { COUNCIL_CLAUDE_BIN: FAKE, HTTPS_PROXY: "http://127.0.0.1:9" });
  return w;
}

test("end to end: a finished task with no shell exits 10, keeps its answer and says why", () => {
  const w = world();
  const r = w.call(["task", "--to", "claude", "--model", "sonnet", "--effort", "low", "--", "edit value.mjs"], { env: { COUNCIL_FAKE_SCENARIO: "task-no-shell" } });
  assert.equal(r.status, 10, r.stdout + r.stderr);
  assert.match(footerOf(r.stdout), /^council claude needs attention · .*attention: Claude offered no shell tool, so this task cannot run commands; install Git for Windows or set CLAUDE_CODE_GIT_BASH_PATH/);
  const job = w.job(jobIdOf(r.stderr));
  assert.deepEqual([job.outcome, job.code, job.cleanupPending], ["attention", 10, false]);
  assert.ok(r.stdout.split("\n").length > 1, "the answer is printed");
});

test("end to end: a task with no shell that also fails exits 1 and reports the failure", () => {
  const w = world();
  const r = w.call(["task", "--to", "claude", "--model", "sonnet", "--effort", "low", "--", "edit value.mjs"], { env: { COUNCIL_FAKE_SCENARIO: "task-no-shell-error" } });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.doesNotMatch(footerOf(r.stdout), /no shell tool/);
});
