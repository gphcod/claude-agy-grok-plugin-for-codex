// S5.6: the Gemini adapter against the installed agy (paid; run once with `npm run test:live` or
// `node --test tests/live/agy.live.test.mjs`). Every turn runs at the lowest effort with a short prompt on a throwaway
// Git repository; the state root is a scratch directory. The record of a run is docs/qualification/gemini-macos.md.
// Skipped when agy is not on PATH. Paid turns: ask, reply, review, three effort cases, the cancelled turn (7).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ENTRY = path.join(ROOT, "plugins", "council", "scripts", "council.mjs");
const which = spawnSync("sh", ["-c", "command -v agy"], { encoding: "utf8" });
const skip = which.status !== 0 ? "agy is not on PATH" : false;
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "council-agy-live-")));
const repo = path.join(scratch, "repo");
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(COUNCIL|CODEX|CLAUDE_PLUGIN|GROK|AGY)/.test(k)));
Object.assign(env, { COUNCIL_CODEX_HOME: path.join(scratch, "state") });
const footer = (text) => text.trimEnd().split("\n").at(-1);
const jobOf = (text) => /job=([a-z0-9]{16})/.exec(text)?.[1] ?? /job ([a-z0-9]{16})/.exec(text)?.[1];
const council = (args, { input = "", timeout = 300000 } = {}) => {
  const started = Date.now();
  const r = spawnSync(process.execPath, [ENTRY, ...args], { cwd: repo, env, input, encoding: "utf8", timeout });
  const record = { args: args.join(" "), status: r.status, footer: footer(r.stdout || r.stderr), seconds: Math.round((Date.now() - started) / 100) / 10 };
  console.log(`# live ${JSON.stringify(record)}`);
  return r;
};

test.before(() => {
  if (skip) return;
  fs.mkdirSync(repo);
  const git = (...a) => spawnSync("git", a, { cwd: repo, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  for (const [k, v] of [["user.name", "council live"], ["user.email", "live@example.com"], ["commit.gpgsign", "false"]]) git("config", k, v);
  fs.writeFileSync(path.join(repo, "sum.mjs"), "export const sum = (items) => { let s = 0; for (const x of items) s += x; return s; };\n");
  git("add", "."); git("commit", "-qm", "sum");
});

test("version and models: the probes the preflight caches", { skip }, () => {
  const version = spawnSync("agy", ["--version"], { encoding: "utf8", env });
  console.log(`# live agy --version: ${version.stdout.trim()}`);
  assert.match(version.stdout, /^\d+\.\d+\.\d+/);
  const models = spawnSync("agy", ["models"], { encoding: "utf8", env, timeout: 60000 });
  assert.equal(models.status, 0, models.stderr);
  assert.match(models.stdout, /gemini-4-argon-low\t/);
  assert.match(models.stdout, /gemini-3\.8-flash-low\t/);
});

test("setup and models --refresh --to gemini", { skip }, () => {
  const setup = council(["setup", "--to", "gemini"]);
  assert.equal(setup.status, 0, setup.stdout + setup.stderr);
  assert.match(setup.stdout, /^gemini: \S+agy \(native\) · 1\.4\.\d+ · logged in · tiers consult=gemini-4-argon\/high/);
  assert.match(setup.stdout, /warning: Gemini read-only turns can search the web/);
  console.log(`# live setup: ${setup.stdout.trim().replace(/\n/g, " | ")}`);
  const refresh = council(["models", "--to", "gemini", "--refresh"]);
  assert.equal(refresh.status, 0, refresh.stderr);
  assert.match(refresh.stdout, /^gemini \(refreshed [^)]+\)\n[\s\S]*  gemini-4-argon: low, medium, high\n/);
});

test("ask at --effort low, then reply on the same conversation", { skip }, () => {
  const ask = council(["ask", "--to", "gemini", "--effort", "low", "--request-id", "live-ask", "--", "Reply with exactly: pong"]);
  assert.equal(ask.status, 0, ask.stdout + ask.stderr);
  assert.match(ask.stdout, /pong/i);
  assert.match(footer(ask.stdout), /^council gemini ok · job [a-z0-9]{16} · gemini-4-argon\/low · \d+s · round 1\/9$/);
  const job = jobOf(ask.stderr);
  const reply = council(["reply", job, "--effort", "low", "--", "Reply with exactly: pong2"]);
  assert.equal(reply.status, 0, reply.stdout + reply.stderr);
  assert.match(reply.stdout, /pong2/i);
  assert.match(footer(reply.stdout), /^council gemini ok · job [a-z0-9]{16} · gemini-4-argon\/low · \d+s · round 2\/9$/);
});

test("review --uncommitted at --effort low", { skip }, () => {
  fs.writeFileSync(path.join(repo, "sum.mjs"), "export const sum = (items) => { let s = 0; for (let i = 1; i < items.length; i++) s += items[i]; return s; };\n");
  const review = council(["review", "--to", "gemini", "--uncommitted", "--effort", "low", "--model", "flash"]);
  assert.ok([0, 10].includes(review.status), review.stdout + review.stderr);
  assert.match(review.stdout, /^Verdict: (approve|needs attention|incomplete)\./);
  assert.match(footer(review.stdout), /^council gemini (ok|needs attention) · job [a-z0-9]{16} · gemini-3\.8-flash\/low · \d+s$/);
  spawnSync("git", ["checkout", "--", "sum.mjs"], { cwd: repo });
});

test("the four effort cases: suffix conflict exits 2 for free; a suffixed id alone; xhigh and max clamp to high", { skip }, () => {
  const conflict = council(["ask", "--to", "gemini", "--model", "gemini-3.8-flash-low", "--effort", "high", "--", "Reply with ok"]);
  assert.equal(conflict.status, 2);
  assert.match(conflict.stderr, /conflicts with --effort high/);
  const suffixed = council(["ask", "--to", "gemini", "--model", "gemini-3.8-flash-low", "--", "Reply with exactly: ok"]);
  assert.equal(suffixed.status, 0, suffixed.stdout + suffixed.stderr);
  assert.match(footer(suffixed.stdout), / · gemini-3\.8-flash-low\/low · /);
  for (const effort of ["xhigh", "max"]) {
    const clamped = council(["ask", "--to", "gemini", "--model", "flash", "--effort", effort, "--", "Reply with exactly: ok"]);
    // At high effort the model may explore and hit the read-only deny rules: a denial is exit 10, still a clamped turn (2026-10-31 run).
    assert.ok([0, 10].includes(clamped.status), clamped.stdout + clamped.stderr);
    assert.match(footer(clamped.stdout), new RegExp(` · gemini-3\\.8-flash/high<=${effort} · `));
  }
});

test("cancel stops a running turn and leaves nothing behind", { skip }, async () => {
  const child = spawn(process.execPath, [ENTRY, "ask", "--to", "gemini", "--model", "flash", "--effort", "low", "--",
    "Count slowly from 1 to 400, one number per line, with a one-sentence remark after every tenth number."], { cwd: repo, env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "", err = "";
  child.stdout.on("data", (c) => { out += c; });
  child.stderr.on("data", (c) => { err += c; });
  const exited = new Promise((resolve) => child.on("close", resolve));
  const jobs = path.join(env.COUNCIL_CODEX_HOME, "jobs");
  const before = new Set(fs.existsSync(jobs) ? fs.readdirSync(jobs) : []);
  let id = null;
  for (const end = Date.now() + 60000; !id && Date.now() < end; await new Promise((r) => setTimeout(r, 250))) {
    id = (fs.existsSync(jobs) ? fs.readdirSync(jobs) : []).find((j) => !before.has(j) && fs.existsSync(path.join(jobs, j, "events.jsonl")) && fs.statSync(path.join(jobs, j, "events.jsonl")).size > 0) ?? null;
  }
  assert.ok(id, "the turn started");
  const cancel = council(["cancel", id]);
  const code = await exited;
  console.log(`# live cancel: ${cancel.stdout.trim()} | turn exit ${code} | ${footer(out)}`);
  assert.equal(cancel.status, 0, cancel.stdout + cancel.stderr);
  assert.match(cancel.stdout, new RegExp(`^(cancelled|finished) · gemini · job ${id}`));
  const meta = JSON.parse(fs.readFileSync(path.join(jobs, id, "meta.json"), "utf8"));
  assert.equal(meta.cleanupPending, false);
  const ps = spawnSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" });
  assert.ok(!ps.stdout.includes(path.join(jobs, id, "settings.json")), "no agy process carries the job's settings path");
  void err;
});
