// S2.2/S2.6 through the entry: text handling (ported from grok_plugin_for_codex 1.1.0 tests/companion.test.mjs), the
// adapter hooks at their boundaries, the thread record of A7.6, and the child environment.
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { makeWorld, jobIdOf, footerOf, until } from "./helpers.mjs";
import { loadThread } from "../plugins/council/scripts/lib/core/jobs.mjs";
import { DEPTH_VARIABLES } from "../plugins/council/scripts/lib/core/host.mjs";

const ask = (w, args = [], extra = {}) => w.call(["ask", "--to", "null", ...args], extra);

test("stdin reaches the child unchanged apart from the final newline; a CRLF ending is dropped too", () => {
  const w = makeWorld();
  const prompt = "  Grüße, 世界 🌍\n\n    indented\ntrailing space ";
  assert.equal(ask(w, [], { input: `${prompt}\n` }).status, 0);
  assert.equal(w.fakeCalls().at(-1).prompt, prompt);
  assert.equal(ask(w, [], { input: "keep   spacing\r\n" }).status, 0);
  assert.equal(w.fakeCalls().at(-1).prompt, "keep   spacing", "a PowerShell pipe's CRLF ending is dropped like a heredoc's LF");
});

test("options come only from argv: text on stdin is never parsed for options, and after -- an option-looking token is text", () => {
  const w = makeWorld();
  assert.equal(ask(w, [], { input: "--tier deep --effort high review this\n" }).status, 0);
  const first = w.fakeCalls().at(-1);
  assert.equal(first.prompt, "--tier deep --effort high review this");
  assert.equal(first.argv[first.argv.indexOf("--effort") + 1], "high", "the default consult tier applied");
  assert.equal(ask(w, ["--tier", "deep", "--", "--text"]).status, 0);
  assert.equal(w.fakeCalls().at(-1).prompt, "--text");
  assert.equal(w.fakeCalls().at(-1).argv[w.fakeCalls().at(-1).argv.indexOf("--effort") + 1], "xhigh");
  const unknown = ask(w, ["--bogus"], { input: "x\n" });
  assert.equal(unknown.status, 2);
  assert.equal(w.fakeCalls().length, 2, "an invalid call never reaches the child");
});

test("--prompt-file reads UTF-8 without its BOM and is the only source; a missing file fails before any child starts", () => {
  const w = makeWorld();
  const file = path.join(w.dir, "prompt.txt");
  fs.writeFileSync(file, "﻿non-ASCII: Grüße, 世界");
  assert.equal(ask(w, ["--prompt-file", file]).status, 0);
  assert.equal(w.fakeCalls()[0].prompt, "non-ASCII: Grüße, 世界");
  for (const extra of [{ args: ["--", "more"] }, { input: "stdin text\n" }]) {
    const both = ask(w, ["--prompt-file", file, ...(extra.args ?? [])], { input: extra.input });
    assert.equal(both.status, 2, both.stderr);
    assert.match(both.stderr, /not more than one/);
  }
  const missing = ask(w, ["--prompt-file", path.join(w.dir, "missing.txt")]);
  assert.equal(missing.status, 1);
  assert.equal(w.fakeCalls().length, 1);
});

test("reply takes its first word as the thread; the text after it, or after --, is never parsed", () => {
  const w = makeWorld();
  const job = jobIdOf(ask(w, ["--", "q"]).stderr);
  assert.equal(w.call(["reply", job, "follow", "up"]).status, 0);
  assert.equal(w.fakeCalls().at(-1).prompt, "follow up");
  assert.equal(w.call(["reply", job, "--", "--model", "x"]).status, 0);
  assert.equal(w.fakeCalls().at(-1).prompt, "--model x");
  assert.equal(w.call(["reply", "--thread", job], { input: "via stdin\n" }).status, 0);
  assert.equal(w.fakeCalls().at(-1).prompt, "via stdin", "--thread is the positional's alias");
  const none = w.call(["reply", job], { input: "" });
  assert.equal(none.status, 2, "a reply needs text");
  assert.match(none.stderr, /reply needs text/);
});

test("every child gets all five guard variables, and the child environment otherwise inherits the companion's", () => {
  const w = makeWorld();
  assert.equal(ask(w, ["--", "q"], { env: { SOME_SETTING: "kept" } }).status, 0);
  const call = w.fakeCalls().at(-1);
  for (const name of DEPTH_VARIABLES) assert.equal(call.depth[name], "1", name);
  const nested = w.call(["ask", "--to", "null", "--", "q"], { env: { GROK_BUILD_DEPTH: "1" } });
  assert.equal(nested.status, 1, "and a child that calls council back is refused");
});

test("beforeTurn and afterTurn run once each on success, denial, timeout, cancellation and spawn failure, afterTurn after cleanup", async () => {
  const w = makeWorld();
  const outcomes = [];
  const count = () => w.hooks().map((h) => h.hook).join(",");
  assert.equal(ask(w, ["--", "q"]).status, 0);
  outcomes.push(count());
  assert.equal(ask(w, ["--", "q"], { env: { COUNCIL_FAKE_DENY: "secret.txt" } }).status, 10);
  assert.equal(ask(w, ["--deadline", ".3", "--", "q"], { env: { COUNCIL_FAKE_HANG: "1" } }).status, 1);
  const running = w.start(["ask", "--to", "null", "--", "q"], { env: { COUNCIL_FAKE_HANG: "1" } });
  const [, id] = await running.waitFor(/job=([a-z0-9]{16})/);
  await until(() => w.job(id).pid);
  w.call(["cancel", id]);
  await running.exited;
  const missing = ask(w, ["--", "q"], { env: { COUNCIL_NULL_BIN: path.join(w.dir, "gone.mjs") } });
  assert.equal(missing.status, 1);
  const hooks = w.hooks();
  assert.equal(hooks.filter((h) => h.hook === "beforeTurn").length, 4, "the missing binary fails before admission, so no hook runs for it");
  assert.equal(hooks.filter((h) => h.hook === "afterTurn").length, 4);
  for (let i = 0; i < hooks.length; i += 2) assert.deepEqual([hooks[i].hook, hooks[i + 1].hook, hooks[i].job === hooks[i + 1].job], ["beforeTurn", "afterTurn", true]);
  assert.ok(hooks.filter((h) => h.hook === "afterTurn").every((h) => h.outcome.cleanupConfirmed), "afterTurn after verified cleanup");
  assert.deepEqual(hooks.filter((h) => h.hook === "afterTurn").map((h) => h.outcome.reason), [null, null, "wall-clock deadline passed", "cancelled"]);
  assert.deepEqual(outcomes, ["beforeTurn,afterTurn"]);
});

test("the thread record (A7.6) holds provider, thread, cwd, session, model, effort, tier, rounds and the last job, and is updated per turn", () => {
  const w = makeWorld();
  const first = ask(w, ["--tier", "deep", "--", "q"], { env: { CODEX_THREAD_ID: "s9" } });
  const job = w.job(jobIdOf(first.stderr));
  const record = loadThread(w.home, "null", job.threadId);
  assert.deepEqual([record.provider, record.threadId, record.cwd, record.session, record.model, record.modelInput, record.effort, record.tier, record.round, record.rounds, record.lastJob],
    ["null", job.threadId, fs.realpathSync(w.workspace), "s9", "null-model", "null-model", "xhigh", "deep", 1, 9, job.id]);
  const reply = w.call(["reply", job.id, "--rounds", "5", "--", "more"], { env: { CODEX_THREAD_ID: "s9" } });
  const updated = loadThread(w.home, "null", job.threadId);
  assert.deepEqual([updated.round, updated.rounds, updated.lastJob], [2, 5, jobIdOf(reply.stderr)]);
  assert.match(footerOf(reply.stdout), /round 2\/5$/);
});
