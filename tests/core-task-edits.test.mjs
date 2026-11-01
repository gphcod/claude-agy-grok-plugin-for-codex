// S7.1 X2: every task counts working-tree changes from a Git snapshot around the turn, unioned with the event-reported
// edits, so an edit made through a shell is counted. Outside Git or past the cap the event count stands.
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { commitFile, ctxFor, footerOf, jobIdOf, makeWorld, adapter, run, tmp, turnFor } from "./helpers.mjs";
import { SNAPSHOT, changes, snapshot, snapshotAfter, snapshotBefore, workspace, workspaceEdits } from "../plugins/council/scripts/lib/core/snapshot.mjs";
import { runManagedTurn } from "../plugins/council/scripts/lib/core/lifecycle.mjs";
import gemini from "../plugins/council/scripts/lib/providers/gemini.mjs";

const task = (w, writes, { env = {}, args = [], cwd } = {}) => {
  const r = w.call(["task", "--to", "null", ...args, "--json", "--", "do it"], { cwd, env: { ...(writes ? { COUNCIL_FAKE_WRITES: JSON.stringify(writes) } : {}), ...env } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  return JSON.parse(r.stdout);
};
const edited = (result) => [result.editedCount, result.edited];

test("a shell-style edit (no edit event) is counted", () => {
  const w = makeWorld();
  assert.deepEqual(edited(task(w, { "README.md": "# shell edit\n" })), [1, ["README.md"]]);
  const plain = w.call(["task", "--to", "null", "--", "do it"], { env: { COUNCIL_FAKE_WRITES: JSON.stringify({ "README.md": "# again\n" }) } });
  assert.match(footerOf(plain.stdout), / · edited 1$/, "the footer says so");
});

test("an event edit and a shell edit of the same file are one edit; other event edits still count", () => {
  const w = makeWorld();
  assert.deepEqual(edited(task(w, { "README.md": "# both\n" }, { env: { COUNCIL_FAKE_EDITS: "README.md" } })), [1, ["README.md"]]);
  assert.deepEqual(edited(task(w, null, { env: { COUNCIL_FAKE_EDITS: "gone.js" } })), [1, ["gone.js"]], "an event edit no snapshot sees stays (edited, then reverted or ignored)");
  fs.mkdirSync(path.join(w.workspace, "sub"));
  assert.deepEqual(edited(task(w, { "../README.md": "# up\n" }, { cwd: path.join(w.workspace, "sub"), env: { COUNCIL_FAKE_EDITS: path.join(w.workspace, "README.md") } })), [1, [path.join(w.workspace, "README.md")]], "one file named two ways, outside the cwd");
});

test("a new untracked file is counted, also in a new directory", () => {
  const w = makeWorld();
  assert.deepEqual(edited(task(w, { "new.txt": "n\n" })), [1, ["new.txt"]]);
  fs.mkdirSync(path.join(w.workspace, "dir"));
  fs.rmSync(path.join(w.workspace, "new.txt"));
  assert.deepEqual(edited(task(w, { "dir/inner.txt": "i\n" })), [1, ["dir/inner.txt"]]);
});

test("a file already dirty before: unchanged is not an edit, changed again is", () => {
  const w = makeWorld();
  fs.writeFileSync(path.join(w.workspace, "README.md"), "# mine\n");
  assert.deepEqual(edited(task(w, null)), [0, []], "the user's own dirty file is not the task's edit");
  assert.deepEqual(edited(task(w, { "README.md": "# mine, then the task's\n" })), [1, ["README.md"]]);
});

test("a file reverted to clean and a deleted file are counted", () => {
  const w = makeWorld();
  fs.writeFileSync(path.join(w.workspace, "README.md"), "# dirty\n");
  assert.deepEqual(edited(task(w, { "README.md": "# work\n" })), [1, ["README.md"]], "the committed content again: no longer in the status");
  assert.deepEqual(edited(task(w, { "README.md": null })), [1, ["README.md"]]);
});

test("HEAD moving counts what the commits changed, with no dirty path left", () => {
  const w = makeWorld();
  const commit = { git: [["add", "-A"], ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "task"]] };
  assert.deepEqual(edited(task(w, { "README.md": "# committed\n", "c.txt": "c\n", ...commit })), [2, ["README.md", "c.txt"]]);
  const unborn = makeWorld({ git: false });
  run("git", ["init", "-q", "-b", "main"], { cwd: unborn.workspace });
  assert.deepEqual(edited(task(unborn, { "first.txt": "f\n", ...commit })), [1, ["first.txt"]], "the first commit of an unborn branch");
});

test("from a subdirectory: paths are relative to the job's cwd", () => {
  const w = makeWorld();
  fs.mkdirSync(path.join(w.workspace, "sub"));
  assert.deepEqual(edited(task(w, { "here.txt": "h\n", "../up.txt": "u\n" }, { cwd: path.join(w.workspace, "sub") })), [2, ["here.txt", "../up.txt"]]);
});

test("outside Git the event-only count stands, and the turn does not fail", () => {
  const w = makeWorld({ git: false });
  assert.deepEqual(edited(task(w, { "x.txt": "x\n" })), [0, []]);
  assert.deepEqual(edited(task(w, { "y.txt": "y\n" }, { env: { COUNCIL_FAKE_EDITS: "y.txt" } })), [1, ["y.txt"]]);
});

test("read-only turns take no snapshot", () => {
  const w = makeWorld();
  const r = w.call(["ask", "--to", "null", "--", "q"], { env: { COUNCIL_FAKE_WRITES: JSON.stringify({ "README.md": "# sneaky\n" }) } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const dir = path.join(w.home, "jobs", jobIdOf(r.stderr));
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.startsWith("snapshot-")), []);
  const t = task(w, null);
  assert.deepEqual(fs.readdirSync(path.join(w.home, "jobs", t.job)).filter((f) => f.startsWith("snapshot-")).sort(), ["snapshot-after.json", "snapshot-before.json"]);
});

const jobIn = (dir, fields = {}) => { const jobDir = path.join(tmp(), "job"); fs.mkdirSync(jobDir); return { dir: jobDir, cwd: dir, verb: "task", readOnly: false, ...fields }; };
function repoWithFile() {
  const dir = tmp();
  run("git", ["init", "-q", "-b", "main"], { cwd: dir });
  for (const [k, v] of [["user.name", "t"], ["user.email", "t@example.com"], ["commit.gpgsign", "false"]]) run("git", ["config", k, v], { cwd: dir });
  commitFile(dir, "a.txt", "a\n");
  return dir;
}
const env = { PATH: process.env.PATH };

test("workspaceEdits: null when it cannot tell, a stored after snapshot is compared once, and a listing past the cap is not compared", () => {
  assert.equal(SNAPSHOT.maxFiles, 5000);
  const dir = repoWithFile();
  const job = jobIn(dir);
  assert.equal(workspaceEdits(job, dir, env), null, "no before snapshot");
  snapshotBefore(job, dir, env);
  fs.writeFileSync(path.join(dir, "during.txt"), "d");
  assert.deepEqual(workspaceEdits(job, dir, env), ["during.txt"]);
  fs.writeFileSync(path.join(dir, "later.txt"), "l");
  assert.deepEqual(workspaceEdits(job, dir, env), ["during.txt"], "the user's later work is not the turn's");
  const outside = jobIn(tmp());
  snapshotBefore(outside, outside.cwd, env);
  assert.equal(workspaceEdits(outside, outside.cwd, env), null, "outside Git");
  // Past the file cap: not listed whole, so no comparison.
  const many = repoWithFile();
  for (let i = 0; i < 4; i++) fs.writeFileSync(path.join(many, `f${i}.txt`), "x");
  const capped = snapshot(workspace(many), env, { maxFiles: 2 });
  assert.deepEqual([capped.coverage, capped.listed], ["partial", false]);
  const job2 = jobIn(many);
  fs.writeFileSync(path.join(job2.dir, "snapshot-before.json"), JSON.stringify(capped));
  assert.equal(workspaceEdits(job2, many, env), null);
  // A failed git call: the status is not usable.
  const broken = jobIn(many);
  snapshotBefore(broken, many, { PATH: path.join(many, "no-git-here") });
  assert.equal(workspaceEdits(broken, many, env), null, "no git on PATH");
});

test("past the byte budget a file compares by size and mtime: its change shows, and another file's new budget use is no change", () => {
  const dir = repoWithFile();
  fs.writeFileSync(path.join(dir, "big.bin"), "b".repeat(2000));
  const opts = { maxBytes: 1000 };
  const before = snapshot(workspace(dir), env, opts);
  assert.deepEqual([before.files["big.bin"].hash, before.listed, before.coverage], [null, true, "partial"]);
  assert.deepEqual(changes(before, snapshot(workspace(dir), env, opts)).files, [], "untouched");
  fs.writeFileSync(path.join(dir, "big.bin"), "c".repeat(2100));
  assert.deepEqual(changes(before, snapshot(workspace(dir), env, opts)).files, ["big.bin"]);
  const hashed = snapshot(workspace(dir), env);
  const over = snapshot(workspace(dir), env, opts);
  assert.ok(hashed.files["big.bin"].hash && over.files["big.bin"].hash === null);
  assert.deepEqual(changes(hashed, over).files, [], "the same file, hashed in one snapshot and over budget in the other");
  fs.utimesSync(path.join(dir, "big.bin"), new Date(), new Date(Date.now() + 5000));
  assert.deepEqual(changes(hashed, snapshot(workspace(dir), env)).files, [], "two hashes ignore a mere touch");
});

test("a Gemini task reuses the core's snapshots: one pair, and its coverage comes from them", async () => {
  const dir = repoWithFile();
  const job = jobIn(dir);
  const ctx = { job, request: {}, cwd: dir, env };
  snapshotBefore(job, dir, env);
  const stored = fs.readFileSync(path.join(job.dir, "snapshot-before.json"), "utf8");
  await gemini.beforeTurn(ctx);
  assert.equal(fs.readFileSync(path.join(job.dir, "snapshot-before.json"), "utf8"), stored, "beforeTurn keeps it");
  fs.writeFileSync(path.join(dir, "made.txt"), "m");
  snapshotAfter(job, dir, env);
  fs.writeFileSync(path.join(dir, "later.txt"), "l");
  assert.deepEqual(await gemini.afterTurn(ctx, { cleanupConfirmed: true }), { coverage: "complete", edited: ["made.txt"] });
});

test("a before snapshot that went missing never fails the turn", async () => {
  const w = makeWorld();
  const turn = turnFor(w, { verb: "task", env: { COUNCIL_FAKE_EDITS: "e.js", COUNCIL_FAKE_WRITES: JSON.stringify({ "s.js": "s" }) } });
  const losing = { ...adapter, beforeTurn(ctx) { fs.rmSync(path.join(ctx.job.dir, "snapshot-before.json"), { force: true }); } };
  const { job } = await runManagedTurn(ctxFor(w), losing, turn, () => turn, { json: true, deadlineMs: 20000, inactivityMs: 20000 });
  assert.deepEqual([job.code, job.edited], [0, ["e.js"]], "no before snapshot: the event count");
});
