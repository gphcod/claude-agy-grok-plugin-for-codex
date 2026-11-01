// core (S4): the two BuiltTurn seams a prompt-file adapter needs. `promptText` sets the prompt file's content without piping
// stdin (Grok carries the per-turn instructions in its prompt file and reads no stdin); `state.adapter` is seeded with the
// BuiltTurn's `{ readOnly, agent }`, so parseEvent can fail closed on a read-only turn (Grok's FORBIDDEN catalogue check).
import test from "node:test";
import assert from "node:assert/strict";
import { makeWorld, turnFor, ctxFor, adapter } from "./helpers.mjs";
import { runManagedTurn } from "../plugins/council/scripts/lib/core/lifecycle.mjs";

const timers = { json: true, deadlineMs: 20000, inactivityMs: 20000 };
/** The null adapter recording what parseEvent sees; `extra` is merged into the BuiltTurn the turn builds. */
function seamAdapter(seen) {
  return { ...adapter, parseEvent: (line, state) => { seen.push({ ...state.adapter }); return adapter.parseEvent(line, state); } };
}
function withBuilt(turn, extra) {
  const build = turn.build;
  return { ...turn, build: (jobDir) => ({ ...build(jobDir), ...extra }) };
}

test("promptText becomes the prompt file's content (no stdin is set)", async () => {
  const w = makeWorld();
  const seen = [];
  const turn = withBuilt(turnFor(w, { prompt: "the user's text", env: { COUNCIL_NULL_INPUT: "prompt-file" } }), { promptText: "INSTRUCTIONS\n\nthe user's text" });
  const result = await runManagedTurn(ctxFor(w), seamAdapter(seen), turn, () => turn, timers);
  assert.equal(result.job.code, 0, result.job.error);
  assert.equal(w.fakeCalls().at(-1).prompt, "INSTRUCTIONS\n\nthe user's text");
  assert.equal(result.answer, "fake answer to: INSTRUCTIONS\n\nthe user's text");
});

test("without promptText the prompt file still carries the request prompt", async () => {
  const w = makeWorld();
  const turn = turnFor(w, { prompt: "plain", env: { COUNCIL_NULL_INPUT: "prompt-file" } });
  const result = await runManagedTurn(ctxFor(w), seamAdapter([]), turn, () => turn, timers);
  assert.equal(result.job.code, 0, result.job.error);
  assert.equal(w.fakeCalls().at(-1).prompt, "plain");
});

test("parseEvent sees the turn's mode and agent in state.adapter from the first event on", async () => {
  for (const [extra, expected] of [[{ readOnly: true, agent: "explore" }, { readOnly: true, agent: "explore" }], [{ readOnly: false, agent: "default" }, { readOnly: false, agent: "default" }], [{ agent: undefined }, { readOnly: true, agent: null }]]) {
    const w = makeWorld();
    const seen = [];
    const turn = withBuilt(turnFor(w), extra);
    const result = await runManagedTurn(ctxFor(w), seamAdapter(seen), turn, () => turn, timers);
    assert.equal(result.job.code, 0, result.job.error);
    assert.ok(seen.length >= 2);
    for (const s of seen) assert.deepEqual({ readOnly: s.readOnly, agent: s.agent }, expected);
  }
});
