// S7.1 X3: the footer cuts `error:` and `attention:` at 200 B. Every message a footer can carry with an action in it fits,
// or keeps the action in front of whatever a long id or path pushes out.
import test from "node:test";
import assert from "node:assert/strict";
import { makeWorld } from "./helpers.mjs";
import { attentionReason, footer, recoveryHint } from "../plugins/council/scripts/lib/core/output.mjs";
import { lockedThreadMessage } from "../plugins/council/scripts/lib/core/lifecycle.mjs";
import { BusyError, claimThread } from "../plugins/council/scripts/lib/core/claims.mjs";
import { createJob, resultRecord } from "../plugins/council/scripts/lib/core/jobs.mjs";
import { UNCONFIRMED, PERMISSION_STOP } from "../plugins/council/scripts/lib/providers/grok.mjs";
import { hostNotice } from "../plugins/council/scripts/lib/providers/gemini.mjs";

const JOB = "k3f9k3f9k3f9k3f9";
const UUID = "4443bbfb-dab9-4088-9647-a8fc31c98ac2";
const bytes = (s) => Buffer.byteLength(s, "utf8");
const base = { id: JOB, dir: `/state/jobs/${JOB}`, provider: "claude", verb: "reply", outcome: "failed", code: 1, model: "m", effort: "high", requestedEffort: "high",
  spawnedAt: "2026-10-31T10:00:00.000Z", endedAt: "2026-10-31T10:00:38.000Z", round: 1, rounds: 9, threadId: "t", admitted: true, edited: [] };
const tokenOf = (line, name) => new RegExp(` · ${name}: (.*?)(?: · |$)`).exec(line)?.[1];

function busyMessage(w) {
  const holder = createJob(w.home, { provider: "null", status: "running", cwd: w.workspace, spawnedAt: new Date().toISOString(), threadIds: [] });
  const other = createJob(w.home, { provider: "null", status: "running", cwd: w.workspace, spawnedAt: new Date().toISOString(), threadIds: [] });
  claimThread(w.home, "null", UUID, holder);
  try { claimThread(w.home, "null", UUID, other); } catch (error) { assert.ok(error instanceof BusyError); return error.message; }
  throw new Error("no busy error");
}

test("every action-bearing footer message with a UUID thread and a 16-character job fits in 200 B", () => {
  const w = makeWorld();
  const messages = {
    locked: lockedThreadMessage(UUID, JOB),
    busy: busyMessage(w),
    lost: resultRecord({ id: JOB }).error,
    "unconfirmed hint": UNCONFIRMED,
    "permission stop": attentionReason({ denied: [{ reason: PERMISSION_STOP, stopReason: "cancelled" }] }),
    "denied host access": hostNotice("operation not permitted"),
    "permission notice": hostNotice("tool approval requires a prompt"),
    "open questions": attentionReason({ questions: true }),
  };
  for (const [name, message] of Object.entries(messages)) {
    assert.ok(message, name);
    assert.ok(bytes(message) <= 200, `${name}: ${bytes(message)} B: ${message}`);
    assert.equal(tokenOf(footer({ ...base, error: message }, false), "error"), message, `${name} prints whole`);
  }
  assert.ok(bytes(recoveryHint({ ...base, threadLocked: true })) <= 200);
});

test("the locked-thread message keeps both ways out in front, also when a long thread id clips it", () => {
  const long = "t".repeat(128); // the longest id a claim accepts
  for (const thread of [UUID, long]) {
    const shown = tokenOf(footer({ ...base, error: lockedThreadMessage(thread, JOB) }, false), "error");
    assert.ok(shown.startsWith(`start a new ask, or cancel ${JOB} --confirm-ended after checking the process table`), shown);
    assert.ok(bytes(shown) <= 200);
  }
  assert.ok(tokenOf(footer({ ...base, error: lockedThreadMessage(UUID, JOB) }, false), "error").endsWith("that job's output"), "the whole message with a UUID");
});
