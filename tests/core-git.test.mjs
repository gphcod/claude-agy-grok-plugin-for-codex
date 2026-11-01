// S2.5: the three collection modes of A5.2 over PATCH_FLAGS (S2.5 list) and the collector cases ported from
// grok_plugin_for_codex 1.1.0 tests/review.test.mjs and review-batches.test.mjs and claude_plugin_for_codex 0.5.0
// tests/runtime.test.mjs and review-batches.test.mjs (see docs/test-port.md).
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { PATCH_FLAGS, collectTarget, gitRoot, oidOf, recordedParents, unquotePath, untrackedEntries, worktreeBase, readRegular } from "../plugins/council/scripts/lib/core/git.mjs";
import { collectReview, INLINE_CAP } from "../plugins/council/scripts/lib/core/review.mjs";
import { SNAPSHOT_CAP } from "../plugins/council/scripts/lib/core/review-input.mjs";
import { UsageError } from "../plugins/council/scripts/lib/core/args.mjs";
import * as repos from "./fixtures/build-repos.mjs";

const { git, init, write, commit, tmp } = repos;
const units = (review) => review.snapshot.index.units;
const usage = (re) => (e) => e instanceof UsageError && re.test(e.message);
const posixOnly = { skip: process.platform === "win32" && "needs POSIX symlinks or a POSIX git wrapper" };
function repo() {
  const dir = init(path.join(tmp(), "repo"));
  commit(dir, { "a.txt": "one\ntwo\n", "gone.txt": "bye\n" }, "base");
  return dir;
}

test("PATCH_FLAGS are the decoder's flags: raw metadata, NUL framing, full ids, fixed prefixes, no external tools", () => {
  for (const flag of ["--raw", "-z", "--patch", "--full-index", "--no-abbrev", "--no-relative", "--no-ext-diff", "--no-textconv", "--src-prefix=a/", "--dst-prefix=b/", "--submodule=short"]) {
    assert.ok(PATCH_FLAGS.includes(flag), flag);
  }
});

test("--commit on a root commit yields its whole tree as additions through diff-tree --root", () => {
  const { dir, oid } = repos.rootCommitRepo();
  const target = collectTarget(dir, { commit: oid });
  assert.equal(target.mode, "commit");
  assert.match(target.label, /^root commit [0-9a-f]{12}$/);
  assert.deepEqual(target.entries.map((e) => [e.path, e.status]).sort(), [["a.txt", "A"], ["docs/b.md", "A"]]);
  assert.match(target.diff.toString(), /diff --git a\/a\.txt b\/a\.txt\nnew file mode 100644/);
  assert.deepEqual(recordedParents(dir, oid), []);
  const review = collectReview(dir, { commit: "HEAD" });
  assert.deepEqual(review.unsupported, []);
  assert.deepEqual(review.batch, { index: 1, total: 1 });
});

test("--commit on an ordinary commit reviews only that commit's change; untracked files are not part of it", () => {
  const { dir, commits } = repos.threeCommitRepo();
  write(dir, "untracked.txt", "not part of any commit\n");
  write(dir, "a.txt", "dirty working tree\n");
  const target = collectTarget(dir, { commit: commits[1] });
  assert.equal(target.label, `commit ${commits[1].slice(0, 12)}`);
  assert.deepEqual(target.entries.map((e) => e.path), ["a.txt"]);
  assert.match(target.diff.toString(), /\n 1\n\+2\n$/);
  assert.doesNotMatch(target.diff.toString(), /dirty working tree|not part of any commit/);
});

test("--commit on a merge yields the first-parent diff and says so in the label", () => {
  const { dir, merge, main, topic } = repos.mergeRepo();
  assert.deepEqual(recordedParents(dir, merge), [main, topic]);
  const target = collectTarget(dir, { commit: merge });
  assert.match(target.label, new RegExp(`^commit ${merge.slice(0, 12)} against its first parent ${main.slice(0, 12)} \\(merge, first-parent diff\\)$`));
  assert.deepEqual(target.entries.map((e) => e.path), ["topic.txt"], "the topic side is the change relative to main");
});

test("--commit decodes a commit touching many entry classes (add, modify, delete, rename, mode, binary, symlink, nested)", () => {
  const { dir, oid, symlinks } = repos.manyClassesRepo();
  const review = collectReview(dir, { commit: oid });
  const byPath = Object.fromEntries(units(review).map((u) => [u.path, u]));
  assert.equal(byPath["keep.txt"].status, "M");
  assert.equal(byPath["gone.txt"].status, "D");
  assert.equal(byPath["moved.txt"].oldPath, "move-me.txt");
  assert.match(byPath["moved.txt"].status, /^R/);
  assert.equal(byPath["script.sh"].status, "M");
  assert.equal(byPath["bin.dat"].kind, "binary");
  assert.equal(byPath["deep/nested/new.txt"].status, "A");
  if (symlinks) assert.equal(byPath.alias.newMode, "120000");
  assert.deepEqual(review.unsupported, ["bin.dat (binary)"]);
});

test("--commit in a shallow clone whose parent is missing exits 2, never a root-style patch; a bad ref exits 2", () => {
  const { shallow, commits } = repos.threeCommitRepo();
  assert.equal(git(shallow, ["rev-parse", "--is-shallow-repository"]).trim(), "true");
  assert.deepEqual(recordedParents(shallow, commits[2]), [commits[1]], "the object still records its parent");
  assert.throws(() => collectTarget(shallow, { commit: "HEAD" }), usage(/has a parent this clone does not have \(shallow history\)/));
  assert.throws(() => collectTarget(shallow, { base: commits[1] }), usage(/invalid review ref/), "the missing parent is not a usable base either");
  const full = repos.threeCommitRepo().dir;
  for (const ref of ["nope", "-p", "", "main\nx", "HEAD~9"]) assert.throws(() => collectTarget(full, { commit: ref }), usage(/invalid review ref/), JSON.stringify(ref));
  assert.equal(oidOf(full, "--output=/tmp/x"), null, "a ref that reads as an option is refused before git sees it");
});

test("--base reviews from the merge base with the working tree and untracked files; a bad ref and unrelated histories exit 2", () => {
  const dir = repo();
  git(dir, ["checkout", "-q", "-b", "topic"]);
  commit(dir, { "topic.txt": "topic\n" }, "topic");
  git(dir, ["checkout", "-q", "main"]);
  commit(dir, { "later-on-main.txt": "main\n" }, "main moves on");
  git(dir, ["checkout", "-q", "topic"]);
  write(dir, "a.txt", "one\ntwo\ndirty\n");
  write(dir, "untracked.txt", "included with --base\n");
  const target = collectTarget(dir, { base: "main" });
  assert.match(target.label, /^branch against main \(merge base [0-9a-f]{12}\), with the working tree and untracked files$/);
  const text = Buffer.concat(target.entries.map((e) => e.body ?? Buffer.alloc(0))).toString();
  assert.match(text, /\+topic/);
  assert.match(text, /\+dirty/);
  assert.match(text, /included with --base/);
  assert.doesNotMatch(text, /later-on-main|\+main/, "only the branch's own side of the merge base");
  for (const base of ["", "-p", "nope", "main\nx"]) assert.throws(() => collectTarget(dir, { base }), usage(/invalid review ref/));
  const orphan = init(path.join(tmp(), "orphan"));
  commit(orphan, { "x.txt": "x\n" }, "x");
  git(orphan, ["checkout", "-q", "--orphan", "other"]);
  git(orphan, ["rm", "-rfq", "."]);
  commit(orphan, { "y.txt": "y\n" }, "y");
  assert.throws(() => collectTarget(orphan, { base: "main" }), usage(/no merge base between main and HEAD/));
});

test("--uncommitted on a clean tree exits 2 and never falls back to a default branch; it excludes committed changes", () => {
  const { dir } = repos.threeCommitRepo();
  assert.throws(() => collectTarget(dir, { uncommitted: true }), usage(/nothing to review: no changes in the working tree/));
  assert.throws(() => collectTarget(dir, {}), usage(/nothing to review/), "a bare review is --uncommitted");
  write(dir, "a.txt", "1\n2\n3\n4\n");
  const target = collectTarget(dir, { uncommitted: true });
  assert.deepEqual(target.entries.map((e) => e.path), ["a.txt"]);
  assert.match(target.diff.toString(), /\n 3\n\+4\n$/, "only the uncommitted line, not the committed history");
  assert.throws(() => collectTarget(dir, { uncommitted: true, base: "main" }), usage(/give one of --base, --commit or --uncommitted/));
  assert.throws(() => collectTarget(tmp(), {}), usage(/inside a Git repository/));
});

test("a dirty tree reviews staged and unstaged edits, deletions and untracked text files together; binary untracked input is unsupported", () => {
  const dir = repo();
  write(dir, "a.txt", "one\nstaged\n");
  git(dir, ["add", "a.txt"]);
  write(dir, "a.txt", "one\nstaged\nunstaged\n");
  git(dir, ["rm", "-q", "gone.txt"]);
  write(dir, "new file.txt", "fresh");
  write(dir, "blob.bin", Buffer.from([1, 0, 2]));
  const review = collectReview(dir);
  assert.equal(review.label, "working tree (staged, unstaged and untracked)");
  const text = review.snapshot.data.toString();
  assert.match(text, /\+staged\n\+unstaged\n/, "one diff against HEAD covers both");
  assert.match(text, /diff --git a\/gone\.txt b\/gone\.txt\ndeleted file mode/);
  assert.match(text, /fresh/);
  assert.deepEqual(review.unsupported, ["blob.bin (untracked, binary)"]);
});

test("a repository without commits reviews staged and later worktree edits against the empty tree", () => {
  const dir = init(path.join(tmp(), "empty"));
  write(dir, "first.txt", "hello\n");
  git(dir, ["add", "first.txt"]);
  write(dir, "first.txt", "hello\nedited after staging\n");
  assert.match(worktreeBase(dir), /^[0-9a-f]{40,64}$/, "the empty tree object");
  const target = collectTarget(dir, {});
  assert.match(target.diff.toString(), /\+hello\n\+edited after staging\n/);
});

/** Puts a git first on PATH that exits with `status` when its arguments contain `args`. POSIX only. */
function failingGit(t, args, status) {
  const bin = tmp(), real = repos.git(process.cwd(), ["--exec-path"]).trim();
  const gitBinary = path.join(path.dirname(real), "..", "..", "bin", "git");
  const realGit = fs.existsSync(gitBinary) ? gitBinary : "git";
  fs.writeFileSync(path.join(bin, "git"), `#!/bin/sh\ncase " $* " in *" ${args} "*) echo "fatal: simulated failure" >&2; exit ${status};; esac\nPATH="${process.env.PATH}" exec ${realGit === "git" ? "git" : `"${realGit}"`} "$@"\n`, { mode: 0o755 });
  const saved = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${saved}`;
  t.after(() => { process.env.PATH = saved; });
}

test("a failed git diff is an error, never a smaller review", posixOnly, (t) => {
  const dir = repo();
  write(dir, "a.txt", "one\nchanged\n");
  failingGit(t, "diff HEAD", 128);
  assert.throws(() => collectTarget(dir, {}), /git diff failed: fatal: simulated failure/);
});

test("only a branch without commits is compared with the empty tree; any other HEAD failure is an error", posixOnly, async (t) => {
  for (const [status, error] of [[128, /git rev-parse HEAD failed: fatal: simulated failure/], [1, /git could not resolve HEAD/]]) {
    const dir = repo();
    git(dir, ["rm", "-q", "gone.txt"]);
    await t.test(`rev-parse exits ${status}`, (sub) => {
      failingGit(sub, "rev-parse --verify --quiet HEAD^{commit}", status);
      assert.throws(() => collectTarget(dir, {}), error);
    });
  }
});

const childProcess = createRequire(import.meta.url)("node:child_process");
/** Answers the named git calls (arguments after the -c pairs) with fixed results; others run. */
function stubGit(answers) {
  const real = childProcess.spawnSync;
  childProcess.spawnSync = (command, args, options) => {
    let start = 0;
    while (args[start] === "-c") start += 2;
    const key = command === "git" ? args.slice(start).join(" ") : null;
    return Object.hasOwn(answers, key) ? { stdout: "", stderr: "", ...answers[key] } : real(command, args, options);
  };
  syncBuiltinESMExports();
  return () => { childProcess.spawnSync = real; syncBuiltinESMExports(); };
}
const timedOut = (status) => ({ status, error: Object.assign(new Error("spawnSync git ETIMEDOUT"), { code: "ETIMEDOUT" }) });

test("a timed-out HEAD or branch probe is an error even when it reports exit 1", () => {
  const looksUnborn = { "rev-parse --verify --quiet HEAD^{commit}": { status: 1 } };
  for (const [answers, error] of [
    [{ "rev-parse --verify --quiet HEAD^{commit}": timedOut(1) }, /git rev-parse HEAD failed: spawnSync git ETIMEDOUT/],
    [{ ...looksUnborn, "symbolic-ref --quiet HEAD": { ...timedOut(0), stdout: "refs/heads/main\n" } }, /git could not resolve HEAD/],
    [{ ...looksUnborn, "rev-parse --verify --quiet refs/heads/main": timedOut(1) }, /git could not resolve HEAD/],
  ]) {
    const dir = repo();
    git(dir, ["rm", "-q", "gone.txt"]);
    const restore = stubGit(answers);
    try { assert.throws(() => collectTarget(dir, {}), error, JSON.stringify(Object.keys(answers))); }
    finally { restore(); }
  }
});

test("Git runs in the C locale with quotepath off and index refresh on, so binary classification does not depend on the host", () => {
  const dir = repo();
  commit(dir, { binary: Buffer.from([0, 1]) }, "binary");
  write(dir, "binary", Buffer.from([0, 2]));
  const original = childProcess.spawnSync;
  let checked = 0;
  childProcess.spawnSync = (command, args, options) => {
    if (command === "git") {
      assert.equal(options.env?.LC_ALL, "C");
      assert.equal(options.env?.LANG, "C");
      assert.deepEqual(args.slice(0, 4), ["-c", "core.quotepath=false", "-c", "diff.autoRefreshIndex=true"]);
      checked++;
    }
    return original(command, args, options);
  };
  syncBuiltinESMExports();
  try {
    assert.ok(units(collectReview(dir)).some((unit) => unit.kind === "binary"));
    assert.ok(checked > 0);
  } finally { childProcess.spawnSync = original; syncBuiltinESMExports(); }
});

test("a stat-only tracked change with autoRefreshIndex disabled creates no phantom patch", () => {
  const dir = repo();
  git(dir, ["config", "diff.autoRefreshIndex", "false"]);
  const later = new Date(Date.now() + 10000);
  fs.utimesSync(path.join(dir, "a.txt"), later, later);
  write(dir, "new.txt", "actual change\n");
  const lock = path.join(dir, ".git", "index.lock");
  fs.writeFileSync(lock, "");
  try {
    const review = collectReview(dir);
    assert.ok(!units(review).some((unit) => unit.path === "a.txt"));
    assert.ok(units(review).some((unit) => unit.path === "new.txt"));
  } finally { fs.unlinkSync(lock); }
});

test("an untracked symlink to a file outside the repository contributes its link text only", posixOnly, () => {
  const { dir, sentinel } = repos.outsideSymlinkRepo();
  const review = collectReview(dir);
  assert.ok(!review.snapshot.data.toString().includes(sentinel), "the target's bytes never enter the review");
  const link = units(review).find((u) => u.path === "link.txt");
  assert.deepEqual([link.kind, link.symlink, link.source], ["text", true, "untracked"]);
  assert.equal(review.snapshot.data.subarray(link.offset, link.offset + link.length).toString(), "../outside-private.txt");
  assert.ok(units(review).some((u) => u.path === "dangling.txt" && u.kind === "text"), "a dangling link is reviewed as its text too");
  assert.deepEqual(review.unsupported, []);
  const withBase = collectTarget(dir, { base: "main" });
  assert.ok(withBase.entries.some((e) => e.path === "link.txt" && e.symlink), "--base includes untracked symlinks as link text");
  assert.ok(!Buffer.concat(withBase.entries.map((e) => e.body ?? Buffer.alloc(0))).toString().includes(sentinel));
});

test("a tracked symlink change is decoded as mode-120000 entries; a renamed file with a space keeps its identity", () => {
  const { dir, oid, symlinks } = repos.symlinkRepo();
  const link = collectTarget(dir, { commit: oid }).entries.find((e) => e.path === "link");
  if (symlinks) assert.deepEqual([link.oldMode, link.newMode], ["120000", "120000"]);
  assert.match(link.body.toString(), /-target-a\.txt\n\\ No newline at end of file\n\+target-b\.txt/);
  const renamed = repos.renameRepo();
  const target = collectTarget(renamed.dir, { commit: renamed.oid });
  assert.deepEqual(target.entries.map((e) => [e.oldPath, e.path, e.status]), [["old name.txt", "new name.txt", "R"]]);
  assert.match(target.diff.toString(), /diff --git a\/old name\.txt b\/new name\.txt\nsimilarity index 100%/);
});

test("rename identity and deleted content survive hostile user diff configuration", () => {
  const dir = repo();
  git(dir, ["mv", "a.txt", "renamed.txt"]);
  git(dir, ["rm", "-q", "gone.txt"]);
  git(dir, ["config", "diff.renames", "copies"]);
  git(dir, ["config", "diff.noprefix", "true"]);
  git(dir, ["config", "diff.relative", "true"]);
  git(dir, ["config", "diff.external", "false"]);
  const review = collectReview(dir);
  assert.ok(units(review).some((u) => u.path === "renamed.txt" && u.oldPath === "a.txt"));
  assert.ok(units(review).some((u) => u.path === "gone.txt" && u.status === "D"));
  assert.match(review.fullDiff.toString(), /diff --git a\//);
});

test("diff.relative never narrows a review run from a subdirectory, dirty or against a base", () => {
  const dir = repo();
  commit(dir, { "src/a.txt": "a\n" }, "src");
  git(dir, ["config", "diff.relative", "true"]);
  const src = path.join(dir, "src");
  write(dir, "a.txt", "root change\n");
  write(dir, "src/a.txt", "sub change\n");
  assert.equal(gitRoot(src), dir);
  const dirty = collectTarget(src, {});
  assert.deepEqual(dirty.entries.map((e) => e.path).sort(), ["a.txt", "src/a.txt"]);
  git(dir, ["checkout", "-q", "-b", "topic"]);
  git(dir, ["commit", "-qam", "both"]);
  assert.deepEqual(collectTarget(src, { base: "main" }).entries.map((e) => e.path).sort(), ["a.txt", "src/a.txt"]);
  assert.deepEqual(collectTarget(src, { commit: "HEAD" }).entries.map((e) => e.path).sort(), ["a.txt", "src/a.txt"]);
});

test("type changes and submodule display settings stay reviewable and keep raw-path ownership", () => {
  const dir = repo();
  git(dir, ["switch", "-qc", "topic"]);
  write(dir, "link-blob", "target\n");
  const oid = git(dir, ["hash-object", "-w", "link-blob"]).trim();
  fs.unlinkSync(path.join(dir, "link-blob"));
  git(dir, ["update-index", "--cacheinfo", `120000,${oid},a.txt`]);
  git(dir, ["commit", "-qm", "type change"]);
  assert.ok(collectTarget(dir, { commit: "HEAD" }).entries.some((e) => e.status === "T"));
  git(dir, ["checkout", "-q", "--", "."]);
  git(dir, ["update-index", "--add", "--cacheinfo", `160000,${"1".repeat(40)},sub`]);
  git(dir, ["commit", "-qm", "submodule baseline"]);
  git(dir, ["update-index", "--cacheinfo", `160000,${"2".repeat(40)},sub`]);
  git(dir, ["commit", "-qm", "submodule change"]);
  for (const format of ["log", "diff"]) {
    git(dir, ["config", "diff.submodule", format]);
    const review = collectReview(dir, { commit: "HEAD" });
    assert.ok(units(review).some((u) => u.path === "sub" && u.kind === "submodule"), format);
    assert.deepEqual(review.unsupported, ["sub (submodule)"]);
  }
});

test("an oversized single line is retained and unsupported; an untracked file over the snapshot cap is listed from its size and never read", (t) => {
  const dir = repo();
  write(dir, "a.txt", "small change\n");
  write(dir, "huge.txt", "x".repeat(INLINE_CAP));
  const review = collectReview(dir);
  assert.deepEqual(review.unsupported, ["huge.txt (untracked, oversize_line)"]);
  assert.ok(units(review).some((u) => u.path === "a.txt" && u.kind === "text"));
  fs.rmSync(path.join(dir, "huge.txt"));
  write(dir, "small.log", "kept\n");
  fs.closeSync(fs.openSync(path.join(dir, "big.log"), "w"));
  fs.truncateSync(path.join(dir, "big.log"), SNAPSHOT_CAP + 1024);
  const open = fs.openSync, seen = [];
  fs.openSync = (file, ...rest) => { seen.push(path.basename(String(file))); return open(file, ...rest); };
  t.after(() => { fs.openSync = open; });
  const capped = untrackedEntries(dir, 0);
  fs.openSync = open;
  assert.deepEqual(capped.map((e) => [e.path, e.kind]).sort(), [["big.log", "snapshot_cap"], ["small.log", "text"]]);
  assert.ok(seen.includes("small.log") && !seen.includes("big.log"), `read: ${seen.join(", ")}`);
});

test("binary and non-UTF-8 inputs are kept in the index as unsupported; Git never lists a FIFO, so none is opened", posixOnly, () => {
  const dir = repo();
  commit(dir, { blob: Buffer.from([0, 1]) }, "binary");
  write(dir, "blob", Buffer.from([0, 2]));
  write(dir, "latin1", Buffer.from([0xff, 10]));
  childProcess.spawnSync("mkfifo", [path.join(dir, "pipe")]);
  const review = collectReview(dir);
  assert.ok(review.unsupported.includes("blob (binary)"));
  assert.ok(review.unsupported.includes("latin1 (untracked, non_utf8)"));
  assert.ok(!units(review).some((u) => u.path === "pipe"), "the review finished without blocking on the FIFO");
});

test("Git-quoted names decode back to their bytes, including characters outside the BMP", () => {
  assert.equal(unquotePath('tab\\tname \\"q\\" back\\\\slash \\303\\251'), 'tab\tname "q" back\\slash é');
  assert.equal(unquotePath("😀\\t\\360\\237\\230\\200.txt"), "😀\t😀.txt");
  const dir = repo();
  const names = process.platform === "win32" ? ["é.txt", "😀.txt"] : ["é.txt", "😀.txt", "tab\tname.txt"];
  for (const name of names) write(dir, name, "new\n");
  assert.deepEqual(collectTarget(dir, {}).entries.map((e) => e.path).filter((p) => names.includes(p)).sort(), [...names].sort());
});

test("readRegular reads a stable regular file once and refuses a changed or swapped one", posixOnly, () => {
  const dir = tmp();
  const file = write(dir, "f.txt", "stable\n");
  const stat = fs.lstatSync(file);
  assert.equal(readRegular(file, stat).toString(), "stable\n");
  fs.writeFileSync(file, "grown since the stat\n");
  assert.equal(readRegular(file, stat), null);
  fs.rmSync(file);
  fs.symlinkSync(path.join(dir, "elsewhere"), file);
  assert.equal(readRegular(file, stat), null, "a symlink is never followed");
});

test("a 500 KB change set is collected whole into a snapshot of several 180,000-byte batches plus synthesis", () => {
  const { dir } = repos.largeChangeRepo();
  const review = collectReview(dir);
  assert.ok(review.snapshot.data.length >= 500000);
  assert.equal(review.snapshot.index.cap, INLINE_CAP);
  assert.ok(review.batch.total >= 4, JSON.stringify(review.batch));
  assert.equal(review.batch.index, 1);
  assert.ok(review.omitted.every((o) => o.endsWith("(pending saved input batch)")), "the rest is delivery bookkeeping, not unsupported input");
  assert.deepEqual(review.unsupported, []);
});
