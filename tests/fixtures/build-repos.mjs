// Repository fixtures for the review tests (S2.5), built on demand in a temporary directory: a root-commit repository, a
// three-commit repository and its shallow clone, a merge commit, a symlink change, an untracked symlink to a file outside
// the repository, a renamed file with a space in its name, and a 500 KB change set.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

export function git(cwd, args, { input } = {}) {
  const r = spawnSync("git", args, { cwd, input, encoding: "utf8", windowsHide: true, env: { ...process.env, GIT_AUTHOR_DATE: "2026-10-31T12:00:00Z", GIT_COMMITTER_DATE: "2026-10-31T12:00:00Z" } });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.error?.message}`);
  return r.stdout;
}
export const tmp = (prefix = "council-repo-") => fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
export function init(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main"]);
  for (const [k, v] of [["user.name", "Council Fixture"], ["user.email", "fixture@example.invalid"], ["commit.gpgsign", "false"], ["core.autocrlf", "false"], ["core.symlinks", "true"]]) git(dir, ["config", k, v]);
  return dir;
}
export function write(dir, name, content) {
  const file = path.join(dir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}
export function commit(dir, files, message) {
  for (const [name, content] of Object.entries(files)) write(dir, name, content);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", message]);
  return git(dir, ["rev-parse", "HEAD"]).trim();
}
export const head = (dir) => git(dir, ["rev-parse", "HEAD"]).trim();
const symlinks = process.platform !== "win32";

/** A repository whose only commit is a root commit with two files. */
export function rootCommitRepo() {
  const dir = init(path.join(tmp(), "root"));
  const oid = commit(dir, { "a.txt": "one\ntwo\n", "docs/b.md": "# b\n" }, "root");
  return { dir, oid };
}
/** Three commits on main, and a depth-1 clone of it whose HEAD is a shallow boundary. */
export function threeCommitRepo() {
  const outer = tmp();
  const dir = init(path.join(outer, "full"));
  const commits = [commit(dir, { "a.txt": "1\n" }, "c1"), commit(dir, { "a.txt": "1\n2\n" }, "c2"), commit(dir, { "a.txt": "1\n2\n3\n" }, "c3")];
  const shallow = path.join(outer, "shallow");
  git(outer, ["clone", "-q", "--depth", "1", `file://${dir.split(path.sep).join("/")}`, shallow]);
  git(shallow, ["config", "user.name", "Council Fixture"]);
  git(shallow, ["config", "user.email", "fixture@example.invalid"]);
  return { dir, shallow, commits };
}
/** main with a merged topic branch: the merge commit's first parent is main's own commit. */
export function mergeRepo() {
  const dir = init(path.join(tmp(), "merge"));
  const base = commit(dir, { "shared.txt": "base\n" }, "base");
  git(dir, ["checkout", "-q", "-b", "topic"]);
  const topic = commit(dir, { "topic.txt": "from topic\n" }, "topic work");
  git(dir, ["checkout", "-q", "main"]);
  const main = commit(dir, { "main.txt": "from main\n" }, "main work");
  git(dir, ["merge", "-q", "--no-ff", "-m", "merge topic", "topic"]);
  return { dir, base, topic, main, merge: head(dir) };
}
/** A tracked symlink whose target changes in the second commit. */
export function symlinkRepo() {
  const dir = init(path.join(tmp(), "symlink"));
  write(dir, "target-a.txt", "a\n");
  write(dir, "target-b.txt", "b\n");
  if (symlinks) fs.symlinkSync("target-a.txt", path.join(dir, "link"));
  else write(dir, "link", "target-a.txt");
  git(dir, ["add", "-A"]); git(dir, ["commit", "-qm", "link to a"]);
  fs.rmSync(path.join(dir, "link"));
  if (symlinks) fs.symlinkSync("target-b.txt", path.join(dir, "link"));
  else write(dir, "link", "target-b.txt");
  git(dir, ["add", "-A"]); git(dir, ["commit", "-qm", "link to b"]);
  return { dir, oid: head(dir), symlinks };
}
/** An untracked symlink pointing at a private file outside the repository, beside one ordinary change. */
export function outsideSymlinkRepo(sentinel = "OUTSIDE-PRIVATE-SENTINEL-7f3a") {
  const outer = tmp();
  const dir = init(path.join(outer, "repo"));
  commit(dir, { "a.txt": "one\n" }, "base");
  write(outer, "outside-private.txt", `${sentinel}\n`);
  write(dir, "a.txt", "one\nchanged\n");
  if (symlinks) {
    fs.symlinkSync("../outside-private.txt", path.join(dir, "link.txt"));
    fs.symlinkSync("missing-target", path.join(dir, "dangling.txt"));
  }
  return { dir, outer, sentinel, symlinks };
}
/** A committed rename to a name with a space, and a second commit renaming it again in the working tree. */
export function renameRepo() {
  const dir = init(path.join(tmp(), "rename"));
  commit(dir, { "old name.txt": "line one\nline two\nline three\n" }, "base");
  git(dir, ["mv", "old name.txt", "new name.txt"]);
  git(dir, ["commit", "-qm", "rename"]);
  return { dir, oid: head(dir) };
}
/** A working tree with about 500 KB of new text across five files (several 180,000-byte batches). */
export function largeChangeRepo({ files = 5, lines = 10000 } = {}) {
  const dir = init(path.join(tmp(), "large"));
  commit(dir, { "README.md": "# large\n" }, "base");
  for (let i = 0; i < files; i++) write(dir, `part${i}.txt`, `snapshot-${i}\n`.repeat(lines));
  return { dir };
}
/** One commit touching many entry classes: add, modify, delete, rename, mode change, binary, symlink, nested path. */
export function manyClassesRepo() {
  const dir = init(path.join(tmp(), "classes"));
  commit(dir, { "keep.txt": "1\n", "gone.txt": "bye\n", "move-me.txt": "same body\nfor rename detection\n", "script.sh": "echo hi\n", "bin.dat": Buffer.from([0, 1, 2]) }, "base");
  write(dir, "keep.txt", "1\n2\n");
  fs.rmSync(path.join(dir, "gone.txt"));
  fs.renameSync(path.join(dir, "move-me.txt"), path.join(dir, "moved.txt"));
  fs.chmodSync(path.join(dir, "script.sh"), 0o755);
  write(dir, "bin.dat", Buffer.from([0, 9, 9]));
  write(dir, "deep/nested/new.txt", "nested\n");
  if (symlinks) fs.symlinkSync("keep.txt", path.join(dir, "alias"));
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "many classes"]);
  return { dir, oid: head(dir), symlinks };
}
