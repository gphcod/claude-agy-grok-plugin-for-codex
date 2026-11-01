// S3.5 live tests against the installed Claude Code (paid; run only through `npm run test:live`, once per qualification).
// Each turn runs at --effort low with a two-turn cap and a one-line prompt, in a throwaway Git repository with its own
// state root. The authorized task and its denied read-only follow-up are a [user] action (PLAN.md S3.5): skipped here
// unless COUNCIL_LIVE_TASK=1 is set by the user. Results are recorded in docs/qualification/claude-macos.md.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ENTRY = path.join(ROOT, "plugins", "council", "scripts", "council.mjs");
const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "council-live-claude-")));
const repo = path.join(dir, "repo");
// The host's own session variables (a Claude Code or Codex parent) must not leak into the child; login stays in HOME.
const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE|CODEX|COUNCIL|GROK|AGY)/.test(k))), COUNCIL_CODEX_HOME: path.join(dir, "state") };
const git = (...args) => spawnSync("git", args, { cwd: repo, encoding: "utf8" });
fs.mkdirSync(repo);
git("init", "-q", "-b", "main");
for (const [k, v] of [["user.name", "Council Live"], ["user.email", "live@example.com"], ["commit.gpgsign", "false"]]) git("config", k, v);
fs.writeFileSync(path.join(repo, "sum.mjs"), "export const sum = (xs) => { let t = 0; for (const x of xs) t += x; return t; };\n");
git("add", "."); git("commit", "-qm", "init");
const council = (args, input = "") => spawnSync(process.execPath, [ENTRY, ...args], { cwd: repo, env, input, encoding: "utf8", timeout: 300000 });
const footer = (r) => r.stdout.trimEnd().split("\n").at(-1);
const jobOf = (r) => /job=([a-z0-9]{16})/.exec(r.stderr)?.[1];
const record = (name, r) => { console.log(`[live] ${name}: exit ${r.status} · ${footer(r)}`); return r; };

test("claude --version is the qualified build", () => {
  const r = spawnSync("claude", ["--version"], { env, encoding: "utf8" });
  assert.equal(r.status, 0);
  console.log(`[live] version: ${r.stdout.trim()}`);
  assert.match(r.stdout, /^\d+\.\d+\.\d+ \(Claude Code\)/);
});

let askJob = null;
test("ask at --effort low --max-turns 2 answers pong with the init-reported model", () => {
  const r = record("ask", council(["ask", "--to", "claude", "--effort", "low", "--max-turns", "2", "--json", "--", "Reply with pong and nothing else."]));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const out = JSON.parse(r.stdout);
  console.log(`[live] ask: model ${out.model} · cost $${out.costUsd} · ${out.answer.trim().slice(0, 40)}`);
  assert.match(out.answer, /pong/i);
  assert.match(out.model, /^claude-/, "default was requested; the footer shows the model init reported");
  askJob = out.job;
});

test("reply continues the same session", { skip: false }, () => {
  assert.ok(askJob, "needs the ask");
  const r = record("reply", council(["reply", askJob, "--effort", "low", "--max-turns", "2", "--json", "--", "Reply with the single word you answered before."]));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const out = JSON.parse(r.stdout);
  console.log(`[live] reply: round ${out.round}/${out.rounds} · cost $${out.costUsd}`);
  assert.match(out.answer, /pong/i);
  assert.equal(out.round, 2);
});

test("review --uncommitted on a one-line change returns a schema-valid structured review", () => {
  fs.writeFileSync(path.join(repo, "sum.mjs"), "export const sum = (xs) => { let t = 0; for (let i = 1; i < xs.length; i++) t += xs[i]; return t; };\n");
  const r = record("review", council(["review", "--to", "claude", "--uncommitted", "--effort", "low", "--json"]));
  assert.ok([0, 10].includes(r.status), r.stdout + r.stderr);
  const out = JSON.parse(r.stdout);
  console.log(`[live] review: verdict ${out.verdict} · findings ${out.findings?.length} · coverage ${out.coverage?.status} · cost $${out.costUsd}`);
  assert.ok(["approve", "needs-attention"].includes(out.verdict), `a validated verdict, not incomplete: ${out.error}`);
  assert.equal(out.coverage.status, "complete");
});

test("[user] an authorized task, then a read-only reply that is denied an edit", { skip: process.env.COUNCIL_LIVE_TASK === "1" ? false : "[user] task edits a working tree: set COUNCIL_LIVE_TASK=1 to run it" }, () => {
  const task = record("task", council(["task", "--to", "claude", "--effort", "low", "--request-id", "live-task", "--", "In sum.mjs, start the loop at index 0. Then run node -e \"import('./sum.mjs').then(m => process.exit(m.sum([1,2]) === 3 ? 0 : 1))\"."]));
  assert.equal(task.status, 0, task.stdout + task.stderr);
  assert.match(footer(task), /edited [1-9]/);
  const reply = record("read-only reply", council(["reply", jobOf(task), "--effort", "low", "--", "Now use the Edit tool to append a comment line to sum.mjs."]));
  assert.equal(reply.status, 10, reply.stdout + reply.stderr);
});

test("cancel stops a running turn and confirms cleanup", async () => {
  const child = spawn(process.execPath, [ENTRY, "ask", "--to", "claude", "--effort", "low", "--max-turns", "2", "--", "Count from 1 to 400, one number per line."], { cwd: repo, env, stdio: ["pipe", "pipe", "pipe"] });
  child.stdin.end();
  let stderr = "", stdout = "";
  child.stderr.on("data", (c) => { stderr += c; });
  child.stdout.on("data", (c) => { stdout += c; });
  for (const end = Date.now() + 60000; !/job=([a-z0-9]{16})/.test(stderr) && Date.now() < end;) await new Promise((r) => setTimeout(r, 100));
  const job = /job=([a-z0-9]{16})/.exec(stderr)?.[1];
  assert.ok(job, stderr);
  await new Promise((r) => setTimeout(r, 2000));
  const started = Date.now();
  const cancel = spawnSync(process.execPath, [ENTRY, "cancel", job], { cwd: repo, env, encoding: "utf8", timeout: 120000 });
  console.log(`[live] cancel: exit ${cancel.status} · ${cancel.stdout.trim()} · ${Date.now() - started} ms`);
  const code = await new Promise((resolve) => child.on("close", resolve));
  console.log(`[live] cancelled turn: exit ${code} · ${stdout.trimEnd().split("\n").at(-1)}`);
  assert.equal(cancel.status, 0, cancel.stdout + cancel.stderr);
  assert.ok([0, 1].includes(code), "the turn ends, cancelled (1) or finished first (0)");
});
