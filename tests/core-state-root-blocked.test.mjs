// S1.4 host probes: under Codex `workspace-write` the companion cannot write its state root (~/.codex/council, EPERM).
// A turn must then stop with `preflight_blocked` and the state-root action line before it writes anything, the
// request-id reservation included, and start no provider process.
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { makeWorld } from "./helpers.mjs";

const posixUser = process.platform !== "win32" && process.getuid?.() !== 0;

test("a state root the sandbox will not let council write blocks every turn with preflight_blocked and the state-root action line, request id or not", { skip: !posixUser && "needs POSIX permissions and a non-root user" }, (t) => {
  const w = makeWorld();
  fs.mkdirSync(w.home, { recursive: true });
  fs.chmodSync(w.home, 0o555);
  t.after(() => fs.chmodSync(w.home, 0o755));
  for (const args of [["ask", "--to", "null", "--", "q"], ["ask", "--to", "null", "--request-id", "r1", "--", "q"], ["task", "--to", "null", "--request-id", "t1", "--", "edit"]]) {
    const r = w.call(args);
    assert.equal(r.status, 1, `${args.join(" ")}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, new RegExp(`^council: preflight_blocked: council job records \\(dir ${w.home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\): write access is missing \\(EACCES\\)\\naction: Grant write access to the council state root `, "m"), args.join(" "));
    assert.match(r.stderr, /under Codex workspace-write, add it as a writable root or run with danger-full-access/);
    const json = JSON.parse(w.call([...args.slice(0, -2), "--json", ...args.slice(-2)]).stdout);
    assert.deepEqual([json.status, json.exit], ["preflight_blocked", 1]);
  }
  assert.deepEqual([w.fakeCalls().length, w.probes().length], [0, 0], "no provider process, not even a probe");
  assert.deepEqual(fs.readdirSync(w.home), [], "nothing was written under the state root");
});
