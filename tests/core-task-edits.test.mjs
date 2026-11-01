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

/** A `git` first on PATH that runs `script` (POSIX shell) and then the real git; returns the PATH to use. */
function gitShim(script) {
  const real = run("sh", ["-c", "command -v git"], {}).stdout.trim();
  const bin = tmp();
  fs.writeFileSync(path.join(bin, "git"), `#!/bin/sh\n${script}\nexec "${real}" "$@"\n`, { mode: 0o755 });
  return `${bin}${path.delimiter}${process.env.PATH}`;
}

test("R1: a cancel marker written during the before snapshot stops the turn with no provider spawn", { skip: process.platform === "win32" }, async () => {
  const w = makeWorld();
  const shimmed = gitShim(`for d in "${w.home}"/jobs/*/; do : > "$d/cancel"; done`);
  const turn = turnFor(w, { verb: "task", env: { PATH: shimmed } });
  let spawns = 0;
  const hooks = { spawn: () => { spawns += 1; throw new Error("no provider may start"); } };
  const { job } = await runManagedTurn({ ...ctxFor(w), env: { ...w.env, PATH: shimmed } }, adapter, turn, () => turn, { json: true, deadlineMs: 20000, inactivityMs: 20000 }, hooks);
  assert.equal(spawns, 0, "zero spawn attempts");
  assert.deepEqual([job.outcome, job.code, job.error, Boolean(job.spawnAttempted), w.fakeCalls().length], ["cancelled", 1, "cancelled", false, 0]);
  assert.ok(fs.existsSync(path.join(job.dir, "snapshot-before.json")), "the marker came during the snapshot, which finished");
});

test("X-A2: a staged rename counts both names; a copy's source did not change, so it stays out", () => {
  const w = makeWorld();
  commitFile(w.workspace, "old.txt", "o\n");
  assert.deepEqual(edited(task(w, { git: [["mv", "old.txt", "new.txt"]] })), [2, ["new.txt", "old.txt"]]);
  const copies = makeWorld();
  commitFile(copies.workspace, "src.txt", "s\n".repeat(20));
  run("git", ["config", "status.renames", "copies"], { cwd: copies.workspace });
  run("git", ["config", "diff.renames", "copies"], { cwd: copies.workspace });
  assert.deepEqual(edited(task(copies, { "copy.txt": "s\n".repeat(20), "src.txt": "s\n".repeat(20), git: [["add", "copy.txt"]] })), [1, ["copy.txt"]], "with status.renames=copies too");
  const moved = makeWorld();
  commitFile(moved.workspace, "a.txt", "a\n");
  fs.writeFileSync(path.join(moved.workspace, "b.txt"), "dirty before\n");
  run("git", ["add", "b.txt"], { cwd: moved.workspace });
  assert.deepEqual(edited(task(moved, { git: [["mv", "b.txt", "c.txt"]] })), [2, ["b.txt", "c.txt"]], "a rename of a file staged before the turn");
});

const RAW_NAME = Buffer.from([0x62, 0x61, 0x64, 0xff, 0xfe, 0x2e, 0x74, 0x78, 0x74]); // bad<ff><fe>.txt

test("R3: a raw-byte filename in a real repository: the listing is not whole, edited falls back to the events, and a read-only turn does not fail", async (t) => {
  const dir = repoWithFile();
  const raw = Buffer.concat([Buffer.from(`${dir}${path.sep}`), RAW_NAME]);
  try { fs.writeFileSync(raw, "one\n"); }
  catch (error) { t.skip(`this file system refuses the name (${error.code})`); return; }
  const before = snapshot(workspace(dir), env);
  assert.deepEqual([before.listed, before.coverage], [false, "partial"]);
  assert.equal(Object.keys(before.files).some((f) => f.startsWith("bad")), false, "no lossy entry");
  const job = jobIn(dir);
  snapshotBefore(job, dir, env);
  fs.writeFileSync(raw, "two\n");
  assert.equal(workspaceEdits(job, dir, env), null, "cannot tell, so the event count stands");
  const ro = jobIn(dir, { verb: "ask", readOnly: true });
  const ctx = { job: ro, request: {}, cwd: dir, env };
  await gemini.beforeTurn(ctx);
  assert.deepEqual(await gemini.afterTurn(ctx, { cleanupConfirmed: true }), { coverage: "unknown" }, "not complete, and no failure");
});

test("R3 where the file system refuses such a name: a status that lists one, from a git shim", { skip: process.platform === "win32" }, async () => {
  // printf with octal bytes stands in for a repository cloned onto a file system that keeps raw names.
  const dir = repoWithFile();
  const shimmed = { PATH: gitShim(`case " $* " in *" status "*) printf '?? bad\\377\\376.txt\\000'; exit 0;; esac`) };
  const listing = snapshot(workspace(dir, shimmed), shimmed);
  assert.deepEqual([listing.listed, listing.coverage, Object.keys(listing.files)], [false, "partial", []]);
  const job = jobIn(dir);
  snapshotBefore(job, dir, shimmed);
  fs.writeFileSync(path.join(dir, "real.txt"), "r\n");
  assert.equal(workspaceEdits(job, dir, shimmed), null, "edited falls back to the events");
  const ro = jobIn(dir, { verb: "ask", readOnly: true });
  const ctx = { job: ro, request: {}, cwd: dir, env: shimmed };
  await gemini.beforeTurn(ctx);
  const result = await gemini.afterTurn(ctx, { cleanupConfirmed: true });
  assert.deepEqual([result.coverage, result.incomplete, ro.mutationCoverage], ["unknown", undefined, "unknown"], "a read-only turn does not fail merely because such a file exists");
  const task = jobIn(dir);
  const taskCtx = { job: task, request: {}, cwd: dir, env: shimmed };
  await gemini.beforeTurn(taskCtx);
  const taskResult = await gemini.afterTurn(taskCtx, { cleanupConfirmed: true });
  assert.deepEqual(taskResult, { coverage: "unknown" });
});

test("R3: a commit naming a raw-byte path cannot be listed, so HEAD moving gives the event count", { skip: process.platform === "win32" }, () => {
  const dir = repoWithFile();
  const job = jobIn(dir);
  snapshotBefore(job, dir, env);
  commitFile(dir, "next.txt", "n\n");
  const shimmed = { PATH: gitShim(`case " $* " in *" --name-only "*) printf 'bad\\377.txt\\000'; exit 0;; esac`) };
  assert.equal(workspaceEdits(job, dir, shimmed), null);
  const job2 = jobIn(dir);
  snapshotBefore(job2, dir, env);
  commitFile(dir, "after.txt", "a\n");
  assert.deepEqual(workspaceEdits(job2, dir, env), ["after.txt"], "a valid name is reported");
});

test("R4: the snapshot comparison sees chmod +x on a dirty file, also past the byte budget", { skip: process.platform === "win32" }, () => {
  const dir = repoWithFile();
  fs.writeFileSync(path.join(dir, "dirty.sh"), "x".repeat(2000));
  const before = snapshot(workspace(dir), env);
  const overBudget = snapshot(workspace(dir), env, { maxBytes: 1000 });
  fs.chmodSync(path.join(dir, "dirty.sh"), 0o755);
  const stamp = fs.statSync(path.join(dir, "dirty.sh"));
  assert.ok(stamp.mode & 0o100);
  const after = snapshot(workspace(dir), env);
  assert.deepEqual(changes(before, after).files, ["dirty.sh"], "same content and state, new mode");
  assert.deepEqual(changes(overBudget, snapshot(workspace(dir), env, { maxBytes: 1000 })).files, ["dirty.sh"], "past the byte budget too");
  assert.deepEqual(changes(after, snapshot(workspace(dir), env)).files, [], "no change, no difference");
});

test("R4: the owner's execute bit is the one that counts, as in Git's own mode", { skip: process.platform === "win32" }, () => {
  const dir = repoWithFile();
  fs.writeFileSync(path.join(dir, "dirty.sh"), "dirty\n");
  fs.chmodSync(path.join(dir, "dirty.sh"), 0o755);
  const before = snapshot(workspace(dir), env);
  fs.chmodSync(path.join(dir, "dirty.sh"), 0o655);
  const cleared = snapshot(workspace(dir), env);
  assert.deepEqual(changes(before, cleared).files, ["dirty.sh"], "0755 to 0655 clears Git's execute bit");
  fs.chmodSync(path.join(dir, "dirty.sh"), 0o645);
  assert.deepEqual(changes(cleared, snapshot(workspace(dir), env)).files, [], "a group bit is no change to Git");
});

test("R4: through a task, chmod +x on an already dirty file is an edit", { skip: process.platform === "win32" }, () => {
  const w = makeWorld();
  const script = path.join(w.workspace, "tool.sh");
  commitFile(w.workspace, "tool.sh", "#!/bin/sh\n");
  fs.writeFileSync(script, "#!/bin/sh\necho dirty\n");
  // The fake runs git commands only; `git -c alias.x=!chmod` is the plain shell step a provider would run.
  const r = task(w, { git: [["-c", "alias.modex=!chmod +x tool.sh", "modex"]] });
  assert.ok(fs.statSync(script).mode & 0o100, "the fake ran chmod");
  assert.deepEqual(edited(r), [1, ["tool.sh"]]);
});

function dirtyRepo() {
  const dir = repoWithFile();
  for (const name of ["keep1.txt", "keep2.txt", "keep3.txt"]) fs.writeFileSync(path.join(dir, name), "dirty before the turn\n");
  return dir;
}
const failingStatus = () => ({ PATH: gitShim(`case " $* " in *" status "*) echo 'fatal: index unreadable' >&2; exit 128;; esac`) });

test("X-A1: a Gemini task whose git status fails after the turn reports no untouched dirty file as edited", { skip: process.platform === "win32" }, async () => {
  const dir = dirtyRepo();
  const job = jobIn(dir);
  await gemini.beforeTurn({ job, request: {}, cwd: dir, env });
  const after = await gemini.afterTurn({ job, request: {}, cwd: dir, env: failingStatus() }, { cleanupConfirmed: true });
  assert.equal(after.edited, undefined);
  assert.equal(after.coverage, "partial");
  assert.equal(workspaceEdits(job, dir, env), null, "the core agrees: event-only");
});

test("X-A1: a Gemini task over maxFiles reports no untouched dirty file as edited, whichever snapshot hit the cap", async () => {
  for (const capped of ["before", "after"]) {
    const dir = dirtyRepo();
    const job = jobIn(dir);
    const ctx = { job, request: {}, cwd: dir, env };
    const small = snapshot(workspace(dir), env, { maxFiles: 2 });
    assert.equal(small.listed, false);
    if (capped === "before") fs.writeFileSync(path.join(job.dir, "snapshot-before.json"), JSON.stringify(small));
    else { await gemini.beforeTurn(ctx); fs.writeFileSync(path.join(job.dir, "snapshot-after.json"), JSON.stringify(small)); }
    const after = await gemini.afterTurn(ctx, { cleanupConfirmed: true });
    assert.equal(after.edited, undefined, capped);
  }
});

test("X-A1: a listed Gemini task still reports its edits, and a read-only turn keeps its behaviour on the same snapshots", { skip: process.platform === "win32" }, async () => {
  const dir = dirtyRepo();
  const job = jobIn(dir);
  const ctx = { job, request: {}, cwd: dir, env };
  await gemini.beforeTurn(ctx);
  fs.writeFileSync(path.join(dir, "made.txt"), "m\n");
  assert.deepEqual(await gemini.afterTurn(ctx, { cleanupConfirmed: true }), { coverage: "complete", edited: ["made.txt"] });
  const failing = jobIn(dir, { verb: "ask", readOnly: true });
  await gemini.beforeTurn({ job: failing, request: {}, cwd: dir, env });
  const shown = await gemini.afterTurn({ job: failing, request: {}, cwd: dir, env: failingStatus() }, {});
  assert.match(shown.incomplete, /^the workspace changed during a read-only turn: /, "a read-only turn still fails closed on a listing it cannot read");
  const capped = jobIn(dir, { verb: "ask", readOnly: true });
  const cctx = { job: capped, request: {}, cwd: dir, env };
  await gemini.beforeTurn(cctx);
  fs.writeFileSync(path.join(capped.dir, "snapshot-after.json"), JSON.stringify(snapshot(workspace(dir), env, { maxFiles: 2 })));
  assert.match((await gemini.afterTurn(cctx, {})).incomplete, /^the workspace changed during a read-only turn: /);
});
