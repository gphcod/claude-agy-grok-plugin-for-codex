// Milestone 4 review item 7: GROKX's open-tool-call bound (tests/reader.test.mjs "open tool calls are bounded and leave
// the map on every terminal status"; tests/lifecycle-integration.test.mjs "more open tool calls than the cap stop Grok
// through the CLI and release the session"), at module level and through the entry against fake-grok.
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { makeWorld, jobIdOf, footerOf, ROOT } from "./helpers.mjs";
import grok from "../plugins/council/scripts/lib/providers/grok.mjs";
import { inspectClaim } from "../plugins/council/scripts/lib/core/claims.mjs";

const CAP = 10000; // providers/grok.mjs PATH_CAP (GROKX)
const FAKE = path.join(ROOT, "tests", "fixtures", "fake-grok.mjs");
const call = (state, id, name = "read_file") => grok.parseEvent(JSON.stringify({ type: "tool_call", toolName: name, toolCallId: String(id) }), state);
const update = (state, id, status) => grok.parseEvent(JSON.stringify({ type: "tool_call_update", toolCallId: String(id), ...(status === undefined ? {} : { status }) }), state);

test("open tool calls are bounded at the cap and leave the map on every terminal status, never on a progress update", () => {
  const state = { adapter: { readOnly: false, agent: "default" } };
  for (let i = 0; i < CAP; i++) assert.equal(call(state, i).fatal, undefined, `call ${i}`);
  assert.equal(state.adapter.calls.size, CAP);
  assert.equal(call(state, "over").fatal, "too many open tool calls in event stream");
  for (const status of ["pending", "in_progress", null, undefined]) {
    update(state, 0, status);
    assert.equal(state.adapter.calls.size, CAP, `a ${status} update keeps the call open`);
  }
  for (const [i, status] of ["completed", "failed", "cancelled"].entries()) {
    update(state, i, status);
    assert.equal(state.adapter.calls.size, CAP - 1, `${status} ends the call`);
    assert.equal(call(state, `again-${status}`).fatal, undefined, `a slot is free after ${status}`);
    assert.equal(call(state, `over-${status}`).fatal, "too many open tool calls in event stream");
  }
});

test("more open tool calls than the cap stop Grok through the entry: exit 1 with the reason, cleanup confirmed, the session released", () => {
  const w = makeWorld();
  delete w.env.COUNCIL_TEST_NULL_ADAPTER;
  fs.mkdirSync(path.join(w.dir, ".grok"));
  fs.writeFileSync(path.join(w.dir, ".grok", "auth.json"), "{}", { mode: 0o600 });
  const stream = path.join(w.dir, "flood-stream.mjs");
  // The fake checks the launch contract and plays its stream; the wrapper inserts CAP + 1 open calls before the end event.
  fs.writeFileSync(stream, `import { spawnSync } from "node:child_process";
const r = spawnSync(process.execPath, [${JSON.stringify(FAKE)}, ...process.argv.slice(2)], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], maxBuffer: 1 << 26 });
if (r.status !== 0 || !process.argv.includes("--prompt-file")) { process.stdout.write(r.stdout); process.exit(r.status); }
const lines = r.stdout.trim().split("\\n"), end = lines.pop();
for (let i = 0; i <= ${CAP}; i++) lines.push(JSON.stringify({ type: "tool_call", toolName: "write", toolCallId: "c" + i }));
process.stdout.write(lines.concat(end).join("\\n") + "\\n");
`);
  w.env.COUNCIL_GROK_BIN = stream;
  const r = w.call(["task", "--to", "grok", "--", "edit"]);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  const id = jobIdOf(r.stderr);
  assert.match(footerOf(r.stdout), /^council grok failed · .* · error: too many open tool calls in event stream/);
  assert.doesNotMatch(footerOf(r.stdout), /cleanup pending|thread locked/);
  const job = w.job(id);
  assert.equal(job.cleanupPending, false);
  assert.equal(inspectClaim(w.home, "grok", job.requestedThreadId).state, "absent", "the session's claim is released");
});
