// S2.4: the generic reader (ported from grok_plugin_for_codex tests/reader.test.mjs onto adapter.parseEvent).
import assert from "node:assert/strict";
import test from "node:test";
import { createReader, LINE_CAP } from "../plugins/council/scripts/lib/core/reader.mjs";
import adapter from "./fixtures/null-adapter.mjs";

const line = (e) => `${JSON.stringify(e)}\n`;
const start = (thread = "t-1") => line({ type: "start", thread });
const end = (extra = {}) => line({ type: "end", thread: "t-1", cost: 0.01, ...extra });
function read(chunks, options = {}) {
  const text = [], failures = [], threads = [];
  const r = createReader(adapter, { cwd: "/work", expectedThreadId: "t-1", onText: (t) => text.push(t), onFailure: (m) => failures.push(m), onThread: (id) => threads.push(id), ...options });
  for (const chunk of chunks) r.feed(chunk);
  r.end();
  return { state: r.state, text: text.join(""), failures, threads };
}

test("a normal turn reports the thread, completion, cost and the spooled answer", () => {
  const { state, text, threads } = read([start(), line({ type: "text", data: "Hello " }), line({ type: "text", data: "world" }), end()]);
  assert.equal(text, "Hello world");
  assert.deepEqual([state.completed, state.threadId, state.costUsd, state.failed, state.events, state.hasText], [true, "t-1", 0.01, null, 4, true]);
  assert.deepEqual(threads, ["t-1"], "the thread is announced once, on discovery");
});

test("maxLineBytes bounds apply while chunks arrive, with or without a newline, and fail closed before parseEvent", () => {
  for (const suffix of ["", "\n"]) {
    let parsed = 0;
    const spy = { ...adapter, parseEvent: (l, s) => { parsed += 1; return adapter.parseEvent(l, s); } };
    const r = createReader(spy, { cwd: "/work", maxLineBytes: 100 });
    r.feed("a".repeat(90)); r.feed(`${"b".repeat(11)}${suffix}`);
    r.feed(end()); r.end();
    assert.match(r.state.failed, /over 100 bytes/);
    assert.deepEqual([r.state.completed, parsed], [false, 0], "the oversize line never reaches the adapter");
  }
  assert.equal(LINE_CAP, 1024 * 1024);
  assert.equal(adapter.maxLineBytes, LINE_CAP, "the default comes from the adapter");
});

test("UTF-8 split across chunks is decoded once, including a final line without LF", () => {
  const b = Buffer.from(start() + line({ type: "text", data: "日本😀" }) + end().trimEnd());
  const text = [];
  const r = createReader(adapter, { cwd: "/work", onText: (t) => text.push(t) });
  for (let i = 0; i < b.length; i++) r.feed(b.subarray(i, i + 1));
  r.end();
  assert.equal(text.join(""), "日本😀");
  assert.equal(r.state.completed, true);
});

test("text on either side of a tool step stays in separate paragraphs, without a trailing gap", () => {
  const tool = line({ type: "tool", name: "read", ok: true });
  const { text, state } = read([start(), line({ type: "text", data: "Before." }), tool, line({ type: "text", data: "After." }), tool, end()]);
  assert.equal(text, "Before.\n\nAfter.");
  assert.equal(state.toolSteps, 2);
});

test("the first fatal latches: a later completion never clears it, and a thrown parseEvent is a fatal", () => {
  const capped = read([start(), "not json\n", end()]);
  assert.match(capped.state.failed, /malformed event/);
  assert.deepEqual([capped.state.completed, capped.failures], [false, [capped.state.failed]]);
  const throwing = { ...adapter, parseEvent: () => { throw new Error("adapter exploded"); } };
  const r = createReader(throwing, { cwd: "/work" });
  r.feed(start()); r.feed(end()); r.end();
  assert.equal(r.state.failed, "adapter exploded");
  const duplicate = read([start(), end(), end()]);
  assert.match(duplicate.state.failed, /duplicate completion/);
});

test("a thread that differs from the expected one fails the turn; a missing id leaves it unconfirmed", () => {
  const other = read([line({ type: "start", thread: "other" }), end({ thread: "other" })]);
  assert.match(other.state.failed, /answered on thread "other", expected t-1/);
  assert.equal(read([line({ type: "start", thread: "T-1" }), end({ thread: "T-1" })]).state.failed, null, "case-insensitive");
  const none = read([line({ type: "text", data: "x" }), line({ type: "end" })], { expectedThreadId: null });
  assert.deepEqual([none.state.failed, none.state.threadId, none.state.completed], [null, null, true]);
});

test("a new turn pins its first discovered thread and refuses a later different thread", () => {
  for (const changed of [start("t-2"), end({ thread: "t-2" })]) {
    const result = read([start(), line({ type: "text", data: "kept" }), changed, end()], { expectedThreadId: null });
    assert.match(result.state.failed, /answered on thread "t-2", expected t-1/);
    assert.equal(result.state.threadId, "t-1");
    assert.equal(result.state.completed, false);
    assert.equal(result.text, "kept");
    assert.deepEqual(result.threads, ["t-1"], "the conflicting thread is never published or claimed");
  }
  const same = read([start(), end({ thread: "T-1" })], { expectedThreadId: null });
  assert.equal(same.state.failed, null);
  assert.equal(same.state.completed, true);
});

test("edited paths are recorded once each, relative to cwd; failed commands and denials are collected", () => {
  const { state } = read([start(), line({ type: "tool", name: "edit", path: "/work/a.js", ok: true }), line({ type: "tool", name: "edit", path: "b.js", ok: true }),
    line({ type: "tool", name: "edit", path: "/work/a.js", ok: true }), line({ type: "tool", name: "edit", path: "/elsewhere/d.js", ok: true }),
    line({ type: "tool", name: "shell", command: "make", ok: false }), line({ type: "tool", name: "edit", path: "c.js", ok: false, denied: true }), end()]);
  assert.deepEqual([...state.edited], ["a.js", "b.js", "/elsewhere/d.js"]);
  assert.deepEqual(state.failedCommands, ["make"]);
  assert.deepEqual(state.denials, [{ tool: "edit", path: "c.js" }]);
  const many = Array.from({ length: 10001 }, (_, i) => line({ type: "tool", name: "edit", path: `f${i}.js`, ok: true })).join("");
  assert.match(read([start(), many, end()]).state.failed, /too many edited paths/);
});

test("structured output, incomplete and usage flow through the state; unknown events are ignored", () => {
  const { state } = read([start(), line({ type: "unknown-event" }), end({ structured: { verdict: "approve" } })]);
  assert.deepEqual(state.structured, { verdict: "approve" });
  assert.equal(state.events, 3);
  const incomplete = { ...adapter, parseEvent: (l) => (JSON.parse(l).type === "end" ? { completed: true, incomplete: "workspace changed" } : { usage: { tokens: 1 } }) };
  const r = createReader(incomplete, { cwd: "/work" });
  r.feed(start()); r.feed(end()); r.end();
  assert.deepEqual([r.state.incomplete, r.state.usage, r.state.completed], ["workspace changed", { tokens: 1 }, true]);
});

test("onEvent sees every raw line and blank lines are skipped", () => {
  const seen = [];
  const r = createReader(adapter, { cwd: "/work", onEvent: (l) => seen.push(l) });
  r.feed(`\n${start()}\n\n${end()}`); r.end();
  assert.equal(seen.length, 2);
  assert.equal(r.state.events, 2);
});
