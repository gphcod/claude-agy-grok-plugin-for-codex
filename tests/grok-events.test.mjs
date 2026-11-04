// S4.3: parseEvent, the GROKX reader as the adapter's event mapping: the FORBIDDEN catalogue guard (fail closed on
// read-only turns), MCP calls, edit paths, session confirmation, stop reasons, cost and usage; thought events ignored.
import test from "node:test";
import assert from "node:assert/strict";
import grok, { FORBIDDEN } from "../plugins/council/scripts/lib/providers/grok.mjs";

const readOnlyState = (extra = {}) => ({ adapter: { readOnly: true, agent: "explore", ...extra } });

test("explicit failed-tool denial is reported without restricting available tools", () => {
  const state = readOnlyState();
  grok.parseEvent(JSON.stringify({ type: "tool_call", toolName: "write", toolCallId: "denied" }), state);
  const result = grok.parseEvent(JSON.stringify({ type: "tool_call_update", toolCallId: "denied",
    status: "failed", content: [{ type: "text", text: "write is not available to this agent" }] }), state);
  assert.equal(result.denied.tool, "write");
  assert.match(result.denied.reason, /not available/);
  assert.equal(result.fatal, undefined);
});

test("parseEvent: catalogue guard, tool calls before the catalogue, MCP calls, edits, stop reasons, max turns, thought and usage ignored", () => {
  const p = (ev, state) => grok.parseEvent(JSON.stringify(ev), state);
  let s = readOnlyState();
  assert.equal(p({ type: "tool_call", toolName: "read_file", toolCallId: "1" }, s).fatal, undefined);
  s = readOnlyState();
  assert.equal(p({ type: "end", stopReason: "end_turn", sessionId: "x" }, s).fatal, undefined);
  s = readOnlyState();
  assert.equal(p({ type: "available_commands", commands: ["compact"] }, s).fatal, undefined, "commands alone leave validation pending");
  assert.equal(p({ type: "available_commands", tools: "read_file" }, s).fatal, "malformed tool catalogue");
  for (const name of FORBIDDEN) assert.match(p({ type: "available_commands", tools: ["read_file", name] }, readOnlyState()).fatal, new RegExp(`read-only tool guard failed: ${name}`));
  s = readOnlyState();
  p({ type: "available_commands", tools: [{ name: "read_file" }, "grep"] }, s);
  assert.equal(p({ type: "tool_call", toolName: "github__create_issue", toolCallId: "2" }, s).fatal, undefined);
  assert.equal(p({ type: "tool_call", toolName: "write", toolCallId: "3" }, readOnlyState({ toolChecked: true })).fatal, undefined);
  assert.deepEqual(p({ type: "tool_call", toolName: "read_file", toolCallId: "4" }, s), { toolStep: "read_file", describe: "tool_call:read_file" });
  assert.equal(p({ type: "thought", data: "hmm", signature: "x" }, s).textDelta, undefined);
  assert.equal(p({ type: "usage", usage: { input_tokens: 1 } }, s).usage, undefined);
  assert.deepEqual(p({ type: "text", data: "hi" }, s), { textDelta: "hi", describe: "text" });
  const end = p({ type: "end", stopReason: "end_turn", sessionId: "S", total_cost_usd: 0.5, usage: { a: 1 }, modelUsage: { "grok-4.7-build": {} } }, s);
  assert.deepEqual(end, { completed: true, threadId: "S", costUsd: 0.5, usage: { a: 1 }, describe: "end" }, "no model from modelUsage");
  const cancelled = p({ type: "end", stopReason: "cancelled", sessionId: "S", total_cost_usd: 0.1 }, readOnlyState({ toolChecked: true }));
  assert.deepEqual([cancelled.completed, cancelled.threadId, cancelled.costUsd, cancelled.denied.stopReason, cancelled.fatal], [true, "S", 0.1, "cancelled", undefined]);
  assert.equal(cancelled.textDelta, "Grok cancelled the turn (a tool needed permission headless Grok cannot ask for)", "with no text so far, the refusal is the answer");
  assert.equal(grok.parseEvent(JSON.stringify({ type: "end", stopReason: "cancelled", sessionId: "S" }), { ...readOnlyState({ toolChecked: true }), hasText: true }).textDelta, undefined);
  const other = p({ type: "end", stopReason: "max_tokens", sessionId: "S", total_cost_usd: 0.2, usage: { o: 1 }, structuredOutput: { verdict: "approve" } }, readOnlyState({ toolChecked: true }));
  assert.deepEqual(other, { fatal: 'incomplete: Grok stopped with reason "max_tokens"', costUsd: 0.2, usage: { o: 1 }, structured: { verdict: "approve" }, describe: "end" });
  assert.equal(p({ type: "max_turns_reached" }, s).fatal, "incomplete: Grok stopped: max turns reached");
  assert.equal(p({ type: "error", message: "boom" }, s).fatal, undefined, "an error event is informational until the turn ends without end");
  assert.equal(grok.parseEvent("not json", s), null);
  // A write turn: the catalogue may advertise edit tools; completed edits are reported by path.
  const w = { adapter: { readOnly: false, agent: "default" } };
  assert.equal(p({ type: "available_commands", tools: ["read_file", "search_replace", "write", "run_terminal_command"] }, w).fatal, undefined);
  assert.equal(p({ type: "tool_call", toolName: "search_replace", toolCallId: "e1", rawInput: { file_path: "/w/a.js" } }, w).toolStep, "search_replace");
  assert.equal(p({ type: "tool_call_update", toolCallId: "e1", status: null }, w).edited, undefined);
  assert.equal(p({ type: "tool_call_update", toolCallId: "e1", status: "completed" }, w).edited, "/w/a.js");
  p({ type: "tool_call", toolName: "write", toolCallId: "e2", rawInput: {} }, w);
  assert.equal(p({ type: "tool_call_update", toolCallId: "e2", status: "completed", rawOutput: { EditsApplied: { absolute_path: "/w/b.js" } } }, w).edited, "/w/b.js");
  p({ type: "tool_call", toolName: "write", toolCallId: "e3", rawInput: { path: "/w/c.js" } }, w);
  assert.equal(p({ type: "tool_call_update", toolCallId: "e3", status: "failed" }, w).edited, undefined, "a failed edit is not an edit");
  assert.equal(p({ type: "end", stopReason: "end_turn", sessionId: "S" }, w).completed, true, "a write turn needs no catalogue check");
  // Fail closed: a scratch without a mode is read-only.
  assert.equal(p({ type: "available_commands", tools: ["write"] }, { adapter: {} }).fatal, undefined);
});

test("end: a missing session completes unconfirmed (no thread id), a non-string one is refused; structuredOutput is carried", () => {
  const ready = () => readOnlyState({ toolChecked: true });
  assert.deepEqual(grok.parseEvent(JSON.stringify({ type: "end", stopReason: "end_turn", total_cost_usd: 0.3 }), ready()), { completed: true, unconfirmed: "session not confirmed: start a new ask", costUsd: 0.3, describe: "end" });
  assert.match(grok.parseEvent(JSON.stringify({ type: "end", stopReason: "end_turn", sessionId: 7 }), ready()).fatal, /^Grok answered on session 7/);
  const structured = { verdict: "approve", summary: "ok", findings: [], next_steps: [] };
  assert.deepEqual(grok.parseEvent(JSON.stringify({ type: "end", stopReason: "end_turn", session_id: "S", structuredOutput: structured }), ready()).structured, structured);
});
