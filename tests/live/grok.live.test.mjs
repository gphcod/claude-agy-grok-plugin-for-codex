// S4.6 live tests against the installed Grok CLI (paid; run only through `npm run test:live`, once per qualification).
// Each turn runs at --effort low with a one-line prompt, in a throwaway Git repository with its own state root; login stays
// in the real HOME. Results are recorded in docs/qualification/grok-macos.md.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ENTRY = path.join(ROOT, "plugins", "council", "scripts", "council.mjs");
const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "council-live-grok-")));
const repo = path.join(dir, "repo");
// The host's own session variables (a Claude Code or Codex parent) must not leak into the child.
const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE|CODEX|COUNCIL|GROK|AGY)/.test(k))), COUNCIL_CODEX_HOME: path.join(dir, "state") };
const git = (...args) => spawnSync("git", args, { cwd: repo, encoding: "utf8" });
fs.mkdirSync(repo);
git("init", "-q", "-b", "main");
for (const [k, v] of [["user.name", "Council Live"], ["user.email", "live@example.com"], ["commit.gpgsign", "false"]]) git("config", k, v);
fs.writeFileSync(path.join(repo, "sum.mjs"), "export const sum = (xs) => { let t = 0; for (const x of xs) t += x; return t; };\n");
git("add", "."); git("commit", "-qm", "init");
const council = (args, input = "") => spawnSync(process.execPath, [ENTRY, ...args], { cwd: repo, env, input, encoding: "utf8", timeout: 600000 });
const footer = (r) => r.stdout.trimEnd().split("\n").at(-1);
const record = (name, r) => { console.log(`[live] ${name}: exit ${r.status} · ${footer(r)}`); return r; };

test("grok --version is the qualified build", () => {
  const r = spawnSync("grok", ["--version"], { env, encoding: "utf8" });
  assert.equal(r.status, 0);
  console.log(`[live] version: ${r.stdout.trim()}`);
  assert.match(r.stdout, /^grok 1\.0\.70 /);
});

test("models prints the static catalog; models --refresh --to grok re-reads `grok models`", () => {
  const plain = record("models", council(["models", "--to", "grok"]));
  assert.equal(plain.status, 0, plain.stderr);
  assert.match(plain.stdout, /^grok \(static catalog\)\n {2}grok-4\.7: low, medium, high, xhigh/);
  const r = record("models --refresh", council(["models", "--to", "grok", "--refresh"]));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^grok \(refreshed [^)]+\)\n[\s\S]* {2}grok-4\.7: low, medium, high, xhigh/);
});

test("setup --to grok: binary, version, logged in, tiers, preflight ok, no tier warning", () => {
  const r = record("setup", council(["setup", "--to", "grok"]));
  assert.equal(r.status, 0, r.stderr);
  console.log(`[live] setup: ${r.stdout.trim()}`);
  assert.match(r.stdout, /^grok: \S+ \(native\) · grok 1\.0\.70 .* · logged in · tiers consult=grok-4\.7\/high .* · preflight ok/);
  assert.doesNotMatch(r.stdout, /warning:/);
});

let askJob = null;
test("ask at --effort low answers pong; the footer keeps the requested model id", () => {
  const r = record("ask", council(["ask", "--to", "grok", "--effort", "low", "--json", "--", "Reply with pong and nothing else."]));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const out = JSON.parse(r.stdout);
  console.log(`[live] ask: model ${out.model} · cost $${out.costUsd} · ${out.answer.trim().slice(0, 40)}`);
  assert.match(out.answer, /pong/i);
  assert.equal(out.model, "grok-4.7");
  askJob = out.job;
  const text = council(["wait", askJob]);
  assert.match(footer(text), /^council grok ok · job [a-z0-9]{16} · grok-4\.7\/low · /);
});

test("reply continues the same session", () => {
  assert.ok(askJob, "needs the ask");
  const r = record("reply", council(["reply", askJob, "--effort", "low", "--json", "--", "Reply with the single word you answered before, then the digit 2."]));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const out = JSON.parse(r.stdout);
  console.log(`[live] reply: round ${out.round}/${out.rounds} · cost $${out.costUsd} · ${out.answer.trim().slice(0, 40)}`);
  assert.match(out.answer, /pong/i);
  assert.equal(out.round, 2);
});

test("review --uncommitted on a one-line change returns a schema-valid structured review", () => {
  fs.writeFileSync(path.join(repo, "sum.mjs"), "export const sum = (xs) => { let t = 0; for (let i = 1; i < xs.length; i++) t += xs[i]; return t; };\n");
  const r = record("review", council(["review", "--to", "grok", "--uncommitted", "--effort", "low", "--json"]));
  assert.ok([0, 10].includes(r.status), r.stdout + r.stderr);
  const out = JSON.parse(r.stdout);
  console.log(`[live] review: verdict ${out.verdict} · findings ${JSON.stringify((out.findings ?? []).map((f) => [f.id, f.severity, f.file, f.line]))} · cost $${out.costUsd}`);
  assert.ok(["approve", "needs-attention"].includes(out.verdict), `a schema-valid verdict, not incomplete: ${out.verdict} ${out.error ?? ""}`);
  assert.equal(out.coverage.status, "complete");
});

test("cancel stops a running turn and confirms cleanup", async () => {
  const child = spawn(process.execPath, [ENTRY, "ask", "--to", "grok", "--effort", "low", "--", "List every file in this repository, then explain each one in detail."], { cwd: repo, env, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "", stdout = "";
  child.stderr.setEncoding("utf8").on("data", (c) => { stderr += c; });
  child.stdout.setEncoding("utf8").on("data", (c) => { stdout += c; });
  const exited = new Promise((resolve) => child.on("close", resolve));
  for (const end = Date.now() + 60000; !/job=([a-z0-9]{16})/.test(stderr) && Date.now() < end;) await new Promise((r) => setTimeout(r, 100));
  const job = /job=([a-z0-9]{16})/.exec(stderr)?.[1];
  assert.ok(job, stderr);
  await new Promise((r) => setTimeout(r, 1500));
  const c = record("cancel", council(["cancel", job]));
  console.log(`[live] cancel: ${c.stdout.trim()}`);
  const code = await exited;
  console.log(`[live] cancelled turn: exit ${code} · ${stdout.trimEnd().split("\n").at(-1)}`);
  assert.equal(c.status, 0, c.stdout + c.stderr);
  assert.ok([0, 1].includes(code), "the turn either finished before the cancel landed or was cancelled");
  if (code === 1) assert.match(stdout, /council grok cancelled · /);
});
