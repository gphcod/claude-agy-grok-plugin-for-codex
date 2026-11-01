// Milestone 4 review (items 3 and 7): test-port cases that had no council test. `wait <job>` on a lost job (AGYX "result
// wait stops on unresolved ownership"; GROKX lost-job wait), a transient process-query failure during a live turn (AGYX "a
// transient ps failure does not cancel live paid work"), and a review batch whose done marker fails (GROKX "a batch
// without a durable done marker retries from its admission coverage").
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { makeWorld, jobIdOf, footerOf, until, alive, adapter, turnFor, ctxFor } from "./helpers.mjs";
import { runManagedTurn } from "../plugins/council/scripts/lib/core/lifecycle.mjs";
import { executionController } from "../plugins/council/scripts/lib/core/execution.mjs";
import { inspectClaim } from "../plugins/council/scripts/lib/core/claims.mjs";

const WORKER = fileURLToPath(new URL("./fixtures/entry-worker.mjs", import.meta.url));
const timers = { json: false, deadlineMs: 30000, inactivityMs: 30000 };

test("wait <job> on a lost job reports it lost with the cancel hint (exit 1), starts nothing and changes nothing; while its beat is fresh it is still running (20)", { skip: process.platform === "win32" }, async () => {
  const w = makeWorld();
  const running = w.start(["ask", "--to", "null", "--", "q"], { env: { COUNCIL_FAKE_HANG: "1" } });
  const [, id] = await running.waitFor(/job=([a-z0-9]{16})/);
  await until(() => w.job(id).pid);
  const events = path.join(w.home, "jobs", id, "events.jsonl");
  await until(() => fs.existsSync(events) && fs.readFileSync(events, "utf8").split("\n").filter((l) => l.includes('"type":"text"')).length === 2);
  const child = w.job(id).pid;
  running.child.kill("SIGKILL");
  await running.exited;
  const fresh = w.call(["wait", id, "--timeout", "1"]);
  assert.equal(fresh.status, 20, "a fresh beat still reads running");
  assert.match(fresh.stdout, new RegExp(`^still running · null · job ${id} · `));
  w.ageBeat(id, 60000);
  const before = fs.readFileSync(path.join(w.home, "jobs", id, "meta.json"), "utf8");
  const calls = w.fakeCalls().length;
  const lost = w.call(["wait", id, "--timeout", "1"]);
  assert.equal(lost.status, 1, lost.stdout + lost.stderr);
  assert.match(footerOf(lost.stdout), new RegExp(`^council null failed · job ${id} · .* · error: companion lost; run cancel before resuming · cleanup pending; next: cancel ${id}; do not resume$`));
  const json = JSON.parse(w.call(["wait", id, "--json"]).stdout);
  assert.deepEqual([json.status, json.exit, json.cleanupPending], ["failed", 1, true]);
  assert.equal(fs.readFileSync(path.join(w.home, "jobs", id, "meta.json"), "utf8"), before, "wait changes no record");
  assert.equal(w.fakeCalls().length, calls, "wait starts no provider process");
  assert.ok(alive(child), "wait never stops the lost job's child");
  assert.equal(inspectClaim(w.home, "null", w.job(id).requestedThreadId).job, id, "the thread stays claimed until cancel confirms");
  assert.equal(w.call(["cancel", id, "--timeout", "15"]).status, 0);
  await until(() => !alive(child), 5000);
});

test("a transient process-query failure during a live turn changes nothing: the heartbeats query, fail, and the turn still finishes ok with cleanup confirmed", { skip: process.platform === "win32" }, async () => {
  const w = makeWorld();
  const real = executionController({ adapter });
  let failing = true, queries = 0, failed = 0;
  // Every query fails while the child runs (processSnapshot reports a failed `ps` as state unknown; it never throws);
  // once the child is about to exit, queries succeed again.
  const control = { ...real, snapshot: (...args) => {
    queries += 1;
    if (!failing) return real.snapshot(...args);
    failed += 1;
    return { state: "unknown", rows: [] };
  } };
  const turn = turnFor(w, { env: { COUNCIL_FAKE_SCENARIO: "slow", COUNCIL_FAKE_SLOW_MS: "3000" } });
  let jobId = null;
  const result = runManagedTurn(ctxFor(w), adapter, turn, null, timers, { beatMs: 50, control, beforeSpawn: (job) => { jobId = job.id; } });
  await until(() => jobId && failed >= 3, 10000);
  assert.equal(fs.existsSync(path.join(w.home, "jobs", jobId, "cancel")), false, "no stop was requested");
  failing = false;
  const { job } = await result;
  assert.ok(failed >= 3 && queries > failed, `the live turn queried the process table on its heartbeats (${failed} failed of ${queries})`);
  assert.deepEqual([job.outcome, job.code, job.cleanupPending, Boolean(job.cancelRequested)], ["ok", 0, false, false], job.error);
  assert.equal(job.error ?? null, null);
});

test("a review batch whose done marker fails keeps its admission coverage; after cancel, --next-input re-sends the same batch", () => {
  const w = makeWorld();
  for (let i = 0; i < 3; i++) fs.writeFileSync(path.join(w.workspace, `part${i}.txt`), "snapshot\n".repeat(18000));
  const first = w.call(["review", "--to", "null"]);
  assert.equal(first.status, 10, "batches pending: " + first.stdout + first.stderr);
  const review = jobIdOf(first.stderr);
  const admitted = w.job(review).reviewState;
  const [, , total] = /batch (\d+)\/(\d+)/.exec(footerOf(first.stdout));
  const worker = spawnSync(process.execPath, [WORKER, JSON.stringify({ argv: ["reply", review, "--next-input"], cwd: w.workspace, failFinalize: true })],
    { cwd: w.workspace, env: w.env, input: "", encoding: "utf8", timeout: 60000 });
  assert.equal(worker.status, 1, worker.stdout + worker.stderr);
  const failedId = jobIdOf(worker.stderr);
  assert.match(footerOf(worker.stdout), new RegExp(`error: finalization failed: fixture marker failure · cleanup pending; next: cancel ${failedId}; do not resume$`));
  const failed = w.job(failedId);
  assert.equal(fs.existsSync(path.join(w.home, "jobs", failedId, "done")), false, "no done marker");
  assert.deepEqual(failed.reviewState.completed, admitted.completed, "the failed batch earned no coverage: the admission state stands");
  assert.equal(failed.reviewState.pending, admitted.pending);
  const sent = w.fakeCalls().at(-1).prompt;
  assert.equal(w.call(["cancel", failedId, "--timeout", "15"]).status, 0, "the companion is gone, so cancel confirms and releases");
  const retry = w.call(["reply", review, "--next-input"]);
  assert.equal(retry.status, 10, "batches still pending: " + retry.stdout + retry.stderr);
  assert.equal(w.fakeCalls().at(-1).prompt, sent, "the same batch, byte for byte");
  assert.match(footerOf(retry.stdout), new RegExp(`batch 2/${total} · next: reply ${jobIdOf(retry.stderr)} --next-input$`));
  assert.equal(w.job(jobIdOf(retry.stderr)).reviewState.completed.length, admitted.completed.length + 1, "the redelivered batch earns its coverage once");
});
