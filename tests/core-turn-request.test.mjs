// S2.7: the frozen TurnRequest (core/types.mjs) as the entry builds it for every verb, the BuiltTurn handling (guard variables
// added to whatever environment the adapter returns), and the request fields each verb sets.
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { makeWorld, jobIdOf } from "./helpers.mjs";
import { DEPTH_VARIABLES } from "../plugins/council/scripts/lib/core/host.mjs";

const KEYS = ["verb", "nextInput", "text", "prompt", "instructions", "contractPath", "model", "effort", "resume", "threadId", "cwd", "reviewRoot", "reviewInputRoot", "schemaPath", "structured", "readOnly", "web",
  "allowCommands", "maxTurns", "maxBudgetUsd", "agent", "jobDir", "envKeys", "policy", "launcherKind", "deadlineMs"].sort();
function world() {
  const w = makeWorld();
  const log = path.join(w.dir, "requests.jsonl");
  w.env.COUNCIL_FAKE_REQUEST_LOG = log;
  w.requests = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  return w;
}

test("ask: a new read-only thread with the advice instructions, the text as prompt, the resolved model and effort, the contract path", () => {
  const w = world();
  assert.equal(w.call(["ask", "--to", "null", "--effort", "medium", "--", "what is x?"]).status, 0);
  const requests = w.requests();
  assert.equal(requests.length, 1, "buildTurn runs once, after admission, when the job directory exists");
  const r = requests.at(-1);
  assert.deepEqual(Object.keys(r).sort(), KEYS);
  assert.deepEqual([r.verb, r.nextInput, r.text, r.prompt, r.resume, r.threadId, r.readOnly, r.structured, r.schemaPath, r.model, r.effort, r.web], ["ask", false, "what is x?", "what is x?", false, null, true, false, null, "null-model", "medium", false]);
  assert.match(r.instructions, /^Instructions for this turn \(advice, read-only\)/);
  assert.equal(r.contractPath, path.join(process.cwd(), "plugins", "council", "contract.md"));
  assert.deepEqual([r.allowCommands, r.maxTurns, r.maxBudgetUsd, r.agent], [[], null, null, null]);
  assert.equal(r.deadlineMs, 14400 * 1000, "the default execution deadline reaches the adapter (agy --print-timeout, A3.3)");
  assert.equal(r.cwd, fs.realpathSync(w.workspace));
  assert.equal(path.dirname(r.jobDir), path.join(fs.realpathSync(w.home), "jobs"));
  assert.deepEqual([r.policy.web, r.policy.allowMcp, r.policy.readRoots], [false, true, []]);
  assert.ok(r.envKeys > 0);
  for (const name of DEPTH_VARIABLES) assert.equal(w.fakeCalls().at(-1).depth[name], "1", `the entry adds ${name} to the adapter's environment`);
});

test("reply: resume on the thread, read-only, the delta as text; --web persists on the thread", () => {
  const w = world();
  const job = jobIdOf(w.call(["ask", "--to", "null", "--web", "--", "q"]).stderr);
  assert.equal(w.requests().at(-1).web, true);
  assert.equal(w.call(["reply", job, "--", "and then?"]).status, 0);
  const r = w.requests().at(-1);
  assert.deepEqual([r.verb, r.resume, r.threadId, r.text, r.readOnly, r.web], ["reply", true, w.job(job).threadId, "and then?", true, true]);
  assert.match(r.instructions, /advice, read-only/, "per-turn instructions travel with every turn, not only the first");
});

test("task: edit mode with the task instructions; task --thread resumes; the reply after it is read-only again", () => {
  const w = world();
  const job = jobIdOf(w.call(["task", "--to", "null", "--", "fix it"]).stderr);
  const task = w.requests().at(-1);
  assert.deepEqual([task.verb, task.readOnly, task.resume, task.model], ["task", false, false, "null-fast"]);
  assert.match(task.instructions, /^Instructions for this turn \(task: edits are authorized/);
  w.call(["task", "--to", "null", "--thread", job, "--", "more"]);
  assert.deepEqual([w.requests().at(-1).resume, w.requests().at(-1).readOnly, w.requests().at(-1).threadId], [true, false, w.job(job).threadId]);
  w.call(["reply", job, "--", "check"]);
  assert.deepEqual([w.requests().at(-1).verb, w.requests().at(-1).readOnly], ["reply", true]);
});

test("review and --next-input: structured, the schema path, the batch prompt as prompt, no separate instructions", () => {
  const w = world();
  for (let i = 0; i < 3; i++) fs.writeFileSync(path.join(w.workspace, `part${i}.txt`), "snapshot\n".repeat(18000));
  const job = jobIdOf(w.call(["review", "--to", "null", "--", "focus"]).stderr);
  const r = w.requests().at(-1);
  assert.deepEqual([r.verb, r.structured, r.readOnly, r.instructions, r.text, r.nextInput], ["review", true, true, null, "focus", false]);
  assert.equal(r.schemaPath, path.join(process.cwd(), "plugins", "council", "schemas", "review-output.schema.json"));
  assert.equal(r.reviewRoot, fs.realpathSync(w.workspace));
  assert.equal(r.reviewInputRoot, path.join(w.home, "jobs", job, "review-input"));
  assert.match(r.prompt, /^Instructions for this turn \(structured code review, read-only\)[\s\S]*User focus: focus\n[\s\S]*Batch units: u1/);
  w.call(["reply", job, "--next-input"]);
  const next = w.requests().at(-1);
  assert.deepEqual([next.verb, next.nextInput, next.structured, next.resume, next.text], ["reply", true, true, true, ""]);
  assert.match(next.prompt, /User focus: focus\n/, "the review's focus is carried to every batch");
  assert.match(next.prompt, /Batch units: u\d/);
  assert.equal(next.reviewRoot, r.reviewRoot);
  assert.equal(next.reviewInputRoot, r.reviewInputRoot);
  w.call(["reply", job, "--", "F1 AGREE"]);
  const discussion = w.requests().at(-1);
  assert.equal(discussion.reviewRoot, r.reviewRoot);
  assert.equal(discussion.reviewInputRoot, r.reviewInputRoot, "discussion retains the saved-input read permission");
});

test("a stored policy reaches the adapter; provider-scoped values are passed through only where accepted", () => {
  const w = world();
  const file = path.join(w.dir, "policy.json");
  fs.writeFileSync(file, JSON.stringify({ web: true, allowMcp: true }));
  assert.equal(w.call(["setup", "--to", "null", "--set", file]).status, 0);
  assert.equal(w.call(["ask", "--to", "null", "--", "q"]).status, 0);
  const r = w.requests().at(-1);
  assert.deepEqual([r.policy.web, r.policy.allowMcp], [true, true]);
  assert.match(r.policy.version, /^[0-9a-f]{16}$/);
  assert.equal(w.call(["ask", "--to", "null", "--max-budget-usd", "1", "--", "q"]).status, 2, "a Claude-only value never reaches another adapter");
});

test("--deadline reaches the adapter as deadlineMs, and stays out of the request fingerprint", () => {
  const w = world();
  assert.equal(w.call(["ask", "--to", "null", "--deadline", "90", "--request-id", "d1", "--", "q"]).status, 0);
  assert.equal(w.requests().at(-1).deadlineMs, 90000);
  assert.equal(w.call(["ask", "--to", "null", "--deadline", "120", "--request-id", "d1", "--", "q"]).status, 0, "a replay with another deadline is the same request");
  assert.equal(w.requests().length, 1, "the replay built no second turn");
});
