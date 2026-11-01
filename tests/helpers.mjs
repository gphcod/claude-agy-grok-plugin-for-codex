// Shared fixtures for the core tests: an isolated state root and workspace, the null adapter, and turn builders.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import adapter, { FAKE_CHILD } from "./fixtures/null-adapter.mjs";

// A suite started from inside a Codex or Claude Code session inherits that session's variables; drop them.
for (const name of Object.keys(process.env)) if (/^(CLAUDE|CODEX|GROK|AGY|COUNCIL)/i.test(name)) delete process.env[name];

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const PLUGIN_ROOT = path.join(ROOT, "plugins", "council");
export const ENTRY = path.join(PLUGIN_ROOT, "scripts", "council.mjs");
export { adapter, FAKE_CHILD };
export const tmp = (prefix = "council-test-") => fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
export const run = (command, args, options = {}) => spawnSync(command, args, { cwd: options.cwd, env: options.env, input: options.input, encoding: "utf8", shell: false, windowsHide: true, timeout: options.timeout ?? 60000 });
export function initGitRepo(cwd) {
  run("git", ["init", "-q", "-b", "main"], { cwd });
  for (const [k, v] of [["user.name", "Council Tests"], ["user.email", "tests@example.com"], ["commit.gpgsign", "false"], ["core.autocrlf", "false"]]) run("git", ["config", k, v], { cwd });
}
export function commitFile(cwd, name, content, message = `add ${name}`) {
  fs.mkdirSync(path.dirname(path.join(cwd, name)), { recursive: true });
  fs.writeFileSync(path.join(cwd, name), content);
  run("git", ["add", name], { cwd });
  run("git", ["commit", "-qm", message], { cwd });
}
export const jobIdOf = (text) => /job=([a-z0-9]{16})/.exec(text)?.[1] ?? /job ([a-z0-9]{16})/.exec(text)?.[1];

/** An isolated world: its own state root and Git workspace; `call`/`start` run the entry with the null adapter. */
export function makeWorld({ git = true } = {}) {
  const dir = tmp();
  const workspace = path.join(dir, "work");
  fs.mkdirSync(workspace);
  if (git) { initGitRepo(workspace); commitFile(workspace, "README.md", "# work\n"); }
  const env = { ...process.env, COUNCIL_CODEX_HOME: path.join(dir, "state"), COUNCIL_TEST_NULL_ADAPTER: "1", COUNCIL_FAKE_LOG: path.join(dir, "fake.log"),
    COUNCIL_FAKE_HOOKS: path.join(dir, "hooks.log"), COUNCIL_STDIN_DEADLINE_MS: "2000", HOME: dir, USERPROFILE: dir, TMPDIR: dir, TEMP: dir, TMP: dir };
  const world = {
    dir, workspace, env, home: path.join(dir, "state"),
    call(args, { input, cwd = workspace, env: extra = {}, timeout = 60000 } = {}) {
      return spawnSync(process.execPath, [ENTRY, ...args], { cwd, env: { ...env, ...extra }, input: input ?? "", encoding: "utf8", windowsHide: true, timeout });
    },
    start(args, { input, cwd = workspace, env: extra = {} } = {}) {
      const child = spawn(process.execPath, [ENTRY, ...args], { cwd, env: { ...env, ...extra }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      let stdout = "", stderr = "";
      child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
      child.stdout.on("data", (c) => { stdout += c; });
      child.stderr.on("data", (c) => { stderr += c; });
      child.stdin.end(input ?? "");
      const exited = new Promise((resolve) => child.on("close", (code) => resolve({ code, stdout, stderr })));
      const waitFor = async (pattern, ms = 15000) => {
        for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 25))) {
          const match = pattern.exec(stdout + stderr);
          if (match) return match;
        }
        throw new Error(`timed out waiting for ${pattern}; output so far: ${stdout}${stderr}`);
      };
      return { child, exited, waitFor, stdout: () => stdout, stderr: () => stderr };
    },
    /** What the fake child logged for each launch (argv, cwd, prompt, depth variables); probes are left out. */
    fakeCalls() { return fs.existsSync(env.COUNCIL_FAKE_LOG) ? fs.readFileSync(env.COUNCIL_FAKE_LOG, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((c) => "argv" in c) : []; },
    hooks() { return fs.existsSync(env.COUNCIL_FAKE_HOOKS) ? fs.readFileSync(env.COUNCIL_FAKE_HOOKS, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []; },
    job(id) { return JSON.parse(fs.readFileSync(path.join(world.home, "jobs", id, "meta.json"), "utf8")); },
    ageBeat(id, ms = 60000) { const then = new Date(Date.now() - ms); fs.utimesSync(path.join(world.home, "jobs", id, "beat"), then, then); },
  };
  return world;
}

/** A turn object as the entry hands it to runManagedTurn, built from the null adapter. */
export function turnFor(world, { verb = "ask", prompt = "q", thread = randomUUID(), confirmed = false, env = {}, cwd = world.workspace, model = "null-model", effort = "low", rounds = 9, round = verb === "reply" ? 1 : 0, extra = {} } = {}) {
  const childEnv = { ...world.env, ...env };
  const request = { verb, prompt, model, effort, env: childEnv, resume: confirmed, threadId: thread };
  return { verb, cwd, tier: "consult", model, effort, requestedEffort: effort, modelVerified: true, thread, confirmed, round, rounds, roundsSet: false, prompt,
    launcher: adapter.resolveLauncher(childEnv), build: (jobDir) => adapter.buildTurn({ ...request, jobDir }), ...extra };
}
export const ctxFor = (world, extra = {}) => ({ home: world.home, env: world.env, cwd: world.workspace, session: null, ...extra });
/** Is a process with this pid running? A zombie counts as gone. */
export function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); } catch (error) { return error?.code === "EPERM"; }
  if (process.platform === "win32") return true;
  const ps = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" });
  return ps.status === 0 && !ps.stdout.trim().startsWith("Z");
}
export async function until(check, timeout = 15000) {
  for (const end = Date.now() + timeout; Date.now() < end; await new Promise((r) => setTimeout(r, 25))) {
    const value = check(); if (value) return value;
  }
  throw new Error("timed out waiting for the fixture condition");
}
