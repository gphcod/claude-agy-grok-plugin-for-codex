// S1.4 host probes: under Codex `workspace-write` the companion cannot write its state root (~/.codex/council, EPERM).
// A turn must then stop with `preflight_blocked` and the state-root action line before it writes anything, the
// request-id reservation included, and start no provider process.
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { makeWorld, until, alive, ROOT } from "./helpers.mjs";
import { main } from "../plugins/council/scripts/council.mjs";
import { requestKey } from "../plugins/council/scripts/lib/core/jobs.mjs";
import { WINDOWS_QUALIFIED, WINDOWS_UNSUPPORTED } from "../plugins/council/scripts/lib/providers/gemini.mjs";

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

/** The whole state tree read-only, as Codex's workspace-write sandbox leaves it (reads work, writes fail). */
function lockTree(t, root) {
  const dirs = [];
  const walk = (dir) => { dirs.push(dir); for (const e of fs.readdirSync(dir, { withFileTypes: true })) if (e.isDirectory()) walk(path.join(dir, e.name)); };
  walk(root);
  for (const dir of dirs.reverse()) fs.chmodSync(dir, 0o555);
  const unlock = () => { for (const dir of dirs.reverse()) { try { fs.chmodSync(dir, 0o755); } catch { /* gone */ } } };
  t.after(unlock);
  return unlock;
}
const blockedLine = (home) => new RegExp(`^council: preflight_blocked: council job records \\(dir ${home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\): write access is missing`, "m");

test("a recorded request replays its stored answer from a read-only state root (A7.4: replay first, nothing written); a fresh id is blocked", { skip: !posixUser && "needs POSIX permissions and a non-root user" }, (t) => {
  const w = makeWorld();
  const first = w.call(["ask", "--to", "null", "--request-id", "kept", "--", "q"]);
  assert.equal(first.status, 0, first.stdout + first.stderr);
  lockTree(t, w.home);
  const calls = w.fakeCalls().length;
  const again = w.call(["ask", "--to", "null", "--request-id", "kept", "--", "q"]);
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.equal(again.stdout, first.stdout, "the stored answer and footer");
  const fresh = w.call(["ask", "--to", "null", "--request-id", "fresh", "--", "q"]);
  assert.equal(fresh.status, 1);
  assert.match(fresh.stderr, blockedLine(w.home));
  assert.equal(w.fakeCalls().length, calls, "nothing started");
});

test("models --refresh, setup --set and cancel name the blocked state root (exit 1) before they write; read-only verbs still work", { skip: !posixUser && "needs POSIX permissions and a non-root user" }, async (t) => {
  const w = makeWorld();
  const running = w.start(["ask", "--to", "null", "--", "q"], { env: { COUNCIL_FAKE_HANG: "1" } });
  const [, id] = await running.waitFor(/job=([a-z0-9]{16})/);
  await until(() => w.job(id).pid);
  const events = path.join(w.home, "jobs", id, "events.jsonl");
  await until(() => fs.existsSync(events) && fs.readFileSync(events, "utf8").split("\n").filter((l) => l.includes('"type":"text"')).length === 2);
  const child = w.job(id).pid;
  running.child.kill("SIGKILL");
  await running.exited;
  const policy = path.join(w.dir, "policy.json");
  fs.writeFileSync(policy, JSON.stringify({ web: true }));
  const unlock = lockTree(t, w.home);
  const probes = w.probes().length;
  for (const args of [["models", "--refresh"], ["setup", "--set", policy], ["cancel", id, "--timeout", "5"]]) {
    const r = w.call(args);
    assert.equal(r.status, 1, `${args.join(" ")}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, blockedLine(w.home), args.join(" "));
    assert.match(r.stderr, /\naction: Grant write access to the council state root /);
  }
  assert.equal(w.probes().length, probes, "models --refresh probed nothing");
  assert.ok(alive(child), "cancel touched nothing");
  assert.equal(w.call(["models"]).status, 0, "plain models only reads");
  assert.equal(w.call(["wait"]).status, 0, "wait only reads");
  unlock();
  assert.equal(w.call(["cancel", id, "--timeout", "15"]).status, 0, "with the root writable again, cancel recovers the job");
  await until(() => !alive(child), 5000);
});

test("invalid input still exits 2 when the state root is blocked: an unknown provider, a provider-scoped flag, and Gemini's Windows refusal (A8)", { skip: !posixUser && "needs POSIX permissions and a non-root user" }, async (t) => {
  const w = makeWorld();
  fs.mkdirSync(w.home, { recursive: true });
  lockTree(t, w.home);
  for (const [args, pattern] of [[["ask", "--to", "nope", "--", "q"], /unknown provider/], [["task", "--to", "null", "--allow-command", "x", "--request-id", "a1", "--", "q"], /--allow-command applies only to gemini/]]) {
    const r = w.call(args);
    assert.equal(r.status, 2, `${args.join(" ")}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, pattern);
  }
  let stderr = "";
  const io = { stdout: { write: () => true }, stderr: { write: (s) => { stderr += s; return true; } }, stdin: Readable.from([]) };
  const env = { ...w.env, COUNCIL_AGY_BIN: path.join(ROOT, "tests", "fixtures", "fake-agy.mjs") };
  const code = await main(["ask", "--to", "gemini", "--request-id", "g1", "--", "q"], env, io, { cwd: w.workspace, platform: "win32" });
  if (WINDOWS_QUALIFIED) { assert.notEqual(code, 0, "the state root check still stops it"); assert.ok(!stderr.includes(WINDOWS_UNSUPPORTED), stderr); return; }
  assert.equal(code, 2, stderr);
  assert.ok(stderr.includes(WINDOWS_UNSUPPORTED), stderr);
  assert.deepEqual(w.fakeCalls(), []);
});

test("an abandoned reservation is not released from a read-only state root: the replay exits 1 with the state-root line and keeps the record", { skip: !posixUser && "needs POSIX permissions and a non-root user" }, (t) => {
  const w = makeWorld();
  const cwd = fs.realpathSync(w.workspace);
  assert.equal(w.call(["ask", "--to", "null", "--request-id", "done", "--", "q"]).status, 0);
  const fingerprint = JSON.parse(fs.readFileSync(path.join(w.home, "requests", `${requestKey(null, cwd, "done")}.json`), "utf8")).fingerprint;
  const key = requestKey(null, cwd, "gone");
  const file = path.join(w.home, "requests", `${key}.json`);
  // A reservation whose companion died before it prepared: nothing ran, and a writable root would release it.
  fs.writeFileSync(file, JSON.stringify({ state: "reserved", id: "gone", key, provider: null, job: null, session: null, cwd, fingerprint,
    companionPid: 999999, companionIdentity: { pid: 999999, stamp: "1" } }));
  const before = fs.readFileSync(file, "utf8");
  lockTree(t, w.home);
  const r = w.call(["ask", "--to", "null", "--request-id", "gone", "--", "q"]);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, blockedLine(w.home));
  assert.doesNotMatch(r.stderr, /EACCES: permission denied/);
  assert.equal(fs.readFileSync(file, "utf8"), before, "the reservation stays");
});
