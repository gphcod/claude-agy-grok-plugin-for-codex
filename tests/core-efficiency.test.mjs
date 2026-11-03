import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { makeWorld, jobIdOf, ctxFor, ENTRY } from "./helpers.mjs";
import { createJob, loadJob, saveJob } from "../plugins/council/scripts/lib/core/jobs.mjs";
import { loadAdapter, planTurn, resolveThread } from "../plugins/council/scripts/lib/cli/plan.mjs";

test("reused speculative reply history is refreshed under admission before inheriting rounds", async () => {
  const world = makeWorld();
  const first = world.call(["ask", "--to", "null", "--", "q"]);
  assert.equal(first.status, 0, first.stderr);
  const id = jobIdOf(first.stderr), ctx = ctxFor(world), options = { to: "null", thread: id };
  const resolvedThread = resolveThread(ctx, "reply", options);
  const adapter = await loadAdapter("null", world.env);
  const plan = planTurn(ctx, adapter, "reply", options, "delta", { resolvedThread });
  assert.equal(plan.prepare(null).round, 2);
  const changed = loadJob(world.home, id);
  changed.round = 4;
  saveJob(changed);
  assert.equal(plan.prepare("ffffffffffffffff").round, 5, "the optimization must not reuse old history after admission");
});

test("Claude refuses an unavailable process query before starting even a non-billable CLI probe", { skip: process.platform === "linux" ? "Linux reads /proc directly; hiding the ps/PowerShell executable does not block it" : false }, () => {
  const world = makeWorld();
  const fake = fileURLToPath(new URL("./fixtures/fake-claude.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [ENTRY, "ask", "--to", "claude", "--json", "--", "q"], {
    cwd: world.workspace, env: { ...world.env, COUNCIL_CLAUDE_BIN: fake, PATH: "", SystemRoot: world.dir }, input: "", encoding: "utf8", windowsHide: true, timeout: 30000,
  });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, "preflight_blocked");
  assert.match(report.error, /process identity and cleanup/);
  assert.equal(world.fakeCalls().length, 0, "a denied process table must never lead to a model submission");
  assert.equal(world.probes().length, 0, "capability failure precedes all CLI probes");
});

test("an early Gemini recovery handle explains that the native thread is not confirmed yet", () => {
  const world = makeWorld();
  const job = createJob(world.home, { provider: "gemini", verb: "ask", status: "running", admitted: true, cwd: world.workspace, session: null, threadId: null, requestedThreadId: null });
  assert.throws(() => resolveThread(ctxFor(world), "reply", { thread: job.id }), new RegExp(`has not confirmed a thread; wait ${job.id} or cancel ${job.id}`));
  const fake = fileURLToPath(new URL("./fixtures/fake-agy.mjs", import.meta.url));
  const result = world.call(["reply", job.id, "--", "delta"], { env: { COUNCIL_AGY_BIN: fake } });
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stderr, new RegExp(`has not confirmed a thread; wait ${job.id} or cancel ${job.id}`));
  assert.equal(world.fakeCalls().length, 0);
  assert.equal(world.probes().length, 0);
});
