// Generic event reader (S2.4), ported from grok_plugin_for_codex 1.1.0 lib/reader.mjs: chunk-bounded line splitting with
// the adapter's `maxLineBytes`, each line handed to `adapter.parseEvent(line, state)`, the first fatal latched so a later
// success event never clears it. The Grok FORBIDDEN catalogue check lives in the grok adapter's parseEvent (S4.3).
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

export const LINE_CAP = 1024 * 1024;
const PATH_CAP = 10000;

/**
 * `callbacks`: onText(delta), onFailure(message), onThread(id) (a discovered id, before it is published: `false` refuses
 * it, and `state.threadId` stays null), onEvent(line).
 * `state` accumulates: threadId, model (the first observed model), completed, failed, denials[], incomplete, structured,
 * edited (Set), failedCommands[], costUsd, usage, toolSteps, hasText, lastEvent, adapter (the adapter's per-turn scratch).
 */
export function createReader(adapter, { cwd = process.cwd(), expectedThreadId = null, maxLineBytes = adapter.maxLineBytes ?? LINE_CAP, onText, onFailure, onThread, onEvent } = {}) {
  const state = { threadId: null, model: null, completed: false, failed: null, denials: [], incomplete: null, unconfirmed: null, structured: null, edited: new Set(), failedCommands: [],
    costUsd: null, usage: null, toolSteps: 0, hasText: false, lastEvent: null, events: 0, adapter: {} };
  const decoder = new StringDecoder("utf8");
  let buffer = "", bytes = 0, broken = false, separate = false, refused = null;
  const fail = (message) => {
    if (broken) return;
    broken = true;
    state.failed = message;
    buffer = ""; bytes = 0;
    onFailure?.(message);
  };
  const relative = (p) => {
    const rel = path.relative(cwd, path.resolve(cwd, p));
    return (rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : p).replace(/\\/g, "/");
  };
  function apply(result) {
    if (!result) return;
    if (result.fatal) {
      // A fatal event may carry the turn's cost, usage and structured output: they are kept with the failure.
      if (typeof result.costUsd === "number") state.costUsd = result.costUsd;
      if (result.usage) state.usage = result.usage;
      if (result.structured !== undefined) state.structured = result.structured;
      fail(result.fatal); return;
    }
    if (result.threadId !== undefined && result.threadId !== null) {
      if (expectedThreadId && String(result.threadId).toLowerCase() !== String(expectedThreadId).toLowerCase()) { fail(`the provider answered on thread ${JSON.stringify(result.threadId)}, expected ${expectedThreadId}`); return; }
      if (state.threadId === null && refused === null) {
        if (onThread?.(result.threadId) === false) refused = result.threadId; // never published
        else state.threadId = result.threadId;
      }
    }
    if (typeof result.model === "string" && result.model && state.model === null) state.model = result.model;
    if (result.toolStep) { state.toolSteps += 1; separate = state.hasText; }
    if (typeof result.textDelta === "string" && result.textDelta) {
      if (separate) { onText?.("\n\n"); separate = false; }
      onText?.(result.textDelta);
      state.hasText = true;
    }
    if (result.denied) state.denials.push(result.denied);
    if (result.incomplete) state.incomplete = result.incomplete;
    // The turn finished but the provider never confirmed its thread: the answer stands, the thread is not resumable.
    if (result.unconfirmed) state.unconfirmed ??= typeof result.unconfirmed === "string" ? result.unconfirmed : "thread not confirmed: start a new ask";
    if (result.structured !== undefined) state.structured = result.structured;
    if (result.edited) {
      for (const p of [].concat(result.edited)) { state.edited.add(relative(p)); if (state.edited.size > PATH_CAP) { fail("too many edited paths in event stream"); return; } }
    }
    if (result.failedCommand) state.failedCommands.push(result.failedCommand);
    if (typeof result.costUsd === "number") state.costUsd = result.costUsd;
    if (result.usage) state.usage = result.usage;
    if (result.completed) {
      if (state.completed) { fail("duplicate completion event"); return; }
      state.completed = true;
    }
  }
  function line(text) {
    state.events += 1;
    onEvent?.(text);
    let result;
    try { result = adapter.parseEvent(text, state); }
    catch (error) { fail(error.message); return true; }
    if (result && typeof result === "object") state.lastEvent = result.describe ?? state.lastEvent;
    apply(result);
    return true;
  }
  function feedText(text) {
    if (broken) return 0;
    let count = 0, start = 0;
    for (;;) {
      const end = text.indexOf("\n", start);
      const part = text.slice(start, end < 0 ? text.length : end);
      const nextBytes = bytes + Buffer.byteLength(part, "utf8");
      if (nextBytes > maxLineBytes) { fail(`the provider emitted a JSONL line over ${maxLineBytes} bytes`); return count; }
      buffer += part;
      bytes = nextBytes;
      if (end < 0) return count;
      if (buffer.trim()) count += line(buffer) ? 1 : 0;
      buffer = ""; bytes = 0;
      if (broken) return count;
      start = end + 1;
    }
  }
  return {
    state,
    feed(chunk) { return feedText(Buffer.isBuffer(chunk) ? decoder.write(chunk) : String(chunk)); },
    end() {
      feedText(decoder.end());
      if (!broken && buffer.trim()) line(buffer);
      buffer = ""; bytes = 0;
    },
  };
}
