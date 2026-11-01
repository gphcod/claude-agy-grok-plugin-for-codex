// Git collection (S2.5): the three A5.2 modes over the review-input decoder's PATCH_FLAGS. Ported from
// claude_plugin_for_codex 0.5.0 lib/review.mjs (`gatherReview`, the git runner) and grok_plugin_for_codex 1.1.0
// lib/review.mjs (`worktreeBase`, `unquotePath`, `readRegular`, untracked link text). The repository root is resolved
// lazily, only for reviews and task snapshots.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { UsageError } from "./args.mjs";
import { SNAPSHOT_CAP, trackedInput, untrackedPaths, utf8 } from "./review-input.mjs";

const DIFF_BUFFER = 64 * 1024 * 1024;
/** Everything the decoder needs: raw metadata, patch, full ids, fixed prefixes, no external tools (A5.2). */
export const PATCH_FLAGS = ["--raw", "-z", "--patch", "--full-index", "--no-abbrev", "--no-relative", "--no-color", "--no-ext-diff", "--no-textconv",
  "--find-renames=50%", "--src-prefix=a/", "--dst-prefix=b/", "--submodule=short", "--ignore-submodules=none"];
const OID = /^[0-9a-f]{40,64}$/i;

/** The core git runner: C locale, quotepath off, autoRefreshIndex on, bounded. Every git call the review makes goes through it. */
export function git(cwd, args, { input, binary = false, timeoutMs = 30000 } = {}) {
  return spawnSync("git", ["-c", "core.quotepath=false", "-c", "diff.autoRefreshIndex=true", ...args], {
    cwd, input, encoding: binary ? null : "utf8", shell: false, env: { ...process.env, LC_ALL: "C", LANG: "C" }, windowsHide: true, timeout: timeoutMs, maxBuffer: DIFF_BUFFER,
  });
}
/** A failed git call is an error, never a smaller review. */
export function checked(result, what) {
  if (result.error?.code === "ENOBUFS") throw new Error(`${what} exceeds ${DIFF_BUFFER} bytes; review a smaller range`);
  if (result.error || result.status !== 0) throw new Error(`${what} failed: ${String(result.stderr || result.error?.message || "").trim().split(/\r?\n/)[0]}`);
  return result.stdout;
}
/** The repository root of `cwd`, or null outside Git. */
export function gitRoot(cwd) {
  const r = git(cwd, ["rev-parse", "--show-toplevel"], { timeoutMs: 15000 });
  return !r.error && r.status === 0 ? r.stdout.trim() : null;
}
/** `<ref>^{commit}` as a full object id, or null; a ref that could be read as an option is refused. */
export function oidOf(cwd, ref) {
  if (typeof ref !== "string" || !ref || ref.startsWith("-") || /[\r\n\0]/.test(ref)) return null;
  const r = git(cwd, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`]);
  return !r.error && r.status === 0 && OID.test(r.stdout.trim()) ? r.stdout.trim() : null;
}
/** Whether a commit object is present in this repository (a shallow boundary's parent is not). */
const hasCommit = (cwd, oid) => { const r = git(cwd, ["cat-file", "-e", `${oid}^{commit}`]); return !r.error && r.status === 0; };
/** The parents a commit object records, read from the object itself so a shallow graft cannot hide them. */
export function recordedParents(cwd, oid) {
  return checked(git(cwd, ["cat-file", "commit", oid]), "git cat-file").split("\n\n")[0].split("\n").filter((l) => l.startsWith("parent ")).map((l) => l.slice(7).trim());
}
/** HEAD, or the empty tree when HEAD names a branch with no commits yet. Any other failure is an error. */
export function worktreeBase(root) {
  const head = git(root, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  if (!head.error && head.status === 0) return "HEAD";
  if (head.error || head.status !== 1) checked(head, "git rev-parse HEAD");
  // Every probe must finish cleanly: a timed-out child can still report exit 1.
  const branch = git(root, ["symbolic-ref", "--quiet", "HEAD"]);
  const probe = !branch.error && branch.status === 0 ? git(root, ["rev-parse", "--verify", "--quiet", branch.stdout.trim()]) : null;
  if (!probe || probe.error || probe.status !== 1) throw new Error("git could not resolve HEAD");
  return checked(git(root, ["hash-object", "-t", "tree", "--stdin"], { input: "" }), "git hash-object").trim();
}
const ESCAPES = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 };
/** A path as Git C-quotes it, decoded; plain runs stay whole, so characters outside the BMP survive. */
export function unquotePath(quoted) {
  const parts = (quoted.match(/\\[0-7]{1,3}|\\.|[^\\]+/gsu) ?? []).map((t) => t[0] !== "\\" ? Buffer.from(t)
    : /[0-7]/.test(t[1]) ? Buffer.from([parseInt(t.slice(1), 8)]) : ESCAPES[t[1]] !== undefined ? Buffer.from([ESCAPES[t[1]]]) : Buffer.from(t.slice(1)));
  return Buffer.concat(parts).toString("utf8");
}
/** Read one stable regular file without following a symlink or blocking on a swapped FIFO. */
export function readRegular(file, expected) {
  const { O_RDONLY, O_NOFOLLOW = 0, O_NONBLOCK = 0 } = fs.constants;
  let fd;
  try {
    fd = fs.openSync(file, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    const same = (stat) => stat.isFile() && stat.dev === expected.dev && stat.ino === expected.ino && stat.size === expected.size
      && stat.mtimeMs === expected.mtimeMs && stat.ctimeMs === expected.ctimeMs;
    if (!same(fs.fstatSync(fd))) return null;
    const bytes = Buffer.alloc(expected.size + 1);
    let length = 0, read;
    while (length < bytes.length && (read = fs.readSync(fd, bytes, length, bytes.length - length, null)) > 0) length += read;
    return length === expected.size && same(fs.fstatSync(fd)) ? bytes.subarray(0, length) : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * Untracked entries: a symlink is its mode-120000 link text, never its target; binary, non-UTF-8, non-regular, changed
 * and over-cap files are kept in the index and marked so the review cannot approve them.
 */
export function untrackedEntries(root, total = 0) {
  const bytes = checked(git(root, ["ls-files", "--others", "--exclude-standard", "-z"], { binary: true }), "git ls-files");
  const entries = [];
  for (const named of untrackedPaths(bytes)) {
    const name = named.path;
    const entry = { ...named, oldPath: name, status: "A", source: "untracked", kind: named.pathBase64 ? "non_utf8_path" : "unreadable" };
    entries.push(entry);
    if (named.pathBase64) continue;
    try {
      const file = path.join(root, name);
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) {
        entry.body = fs.readlinkSync(file, { encoding: "buffer" });
        entry.kind = utf8(entry.body) ? "text" : "non_utf8";
        entry.symlink = true;
        entry.newMode = "120000";
        total += entry.body.length;
        continue;
      }
      if (!stat.isFile()) { entry.kind = "not_regular"; continue; }
      if (total + stat.size > SNAPSHOT_CAP) { entry.kind = "snapshot_cap"; continue; }
      const content = readRegular(file, stat);
      if (content === null) { entry.kind = "changed_or_unreadable"; continue; }
      entry.body = content;
      total += content.length;
      entry.kind = content.includes(0) ? "binary" : !utf8(content) ? "non_utf8" : "text";
    } catch { /* The unavailable input stays declared in the index. */ }
  }
  return entries;
}

/**
 * The review target (A5.2), always collected from the repository root:
 * - `--uncommitted` or bare: `git diff <HEAD or empty tree> PATCH_FLAGS --` plus untracked files; exit 2 when empty;
 * - `--base <ref>`: merge-base of the ref and HEAD, then `git diff <MB> PATCH_FLAGS --` plus untracked files;
 * - `--commit <sha>`: `git diff-tree --no-commit-id --root PATCH_FLAGS <oid>` for a non-merge commit and
 *   `git diff <parent1> <oid> PATCH_FLAGS --` for a merge (first-parent semantics, in the label); no untracked files.
 * A bad ref, a missing merge base or a parent this clone does not have (shallow history) exits 2, never a clean review.
 */
export function collectTarget(cwd, { base, commit, uncommitted } = {}) {
  const root = gitRoot(cwd);
  if (!root) throw new UsageError("review must run inside a Git repository");
  if ([base !== undefined, commit !== undefined, Boolean(uncommitted)].filter(Boolean).length > 1) throw new UsageError("give one of --base, --commit or --uncommitted");
  if (commit !== undefined) {
    const oid = oidOf(root, commit);
    if (!oid) throw new UsageError(`invalid review ref ${JSON.stringify(commit)}`);
    const parents = recordedParents(root, oid);
    const missing = parents.filter((p) => !hasCommit(root, p));
    if (missing.length) throw new UsageError(`commit ${oid.slice(0, 12)} has a parent this clone does not have (shallow history); fetch its ancestry or review with --base`);
    let raw, label;
    if (parents.length > 1) {
      label = `commit ${oid.slice(0, 12)} against its first parent ${parents[0].slice(0, 12)} (merge, first-parent diff)`;
      raw = checked(git(root, ["diff", parents[0], oid, ...PATCH_FLAGS, "--"], { binary: true }), "git diff");
    } else {
      label = parents.length ? `commit ${oid.slice(0, 12)}` : `root commit ${oid.slice(0, 12)}`;
      raw = checked(git(root, ["diff-tree", "--no-commit-id", "--root", ...PATCH_FLAGS, oid], { binary: true }), "git diff-tree");
    }
    const tracked = trackedInput(raw);
    if (!tracked.entries.length) throw new UsageError(`nothing to review: ${label} changes no file`);
    return { root, label, mode: "commit", oid, diff: tracked.diff, entries: tracked.entries };
  }
  let raw, label, mode;
  if (base !== undefined) {
    const oid = oidOf(root, base);
    if (!oid) throw new UsageError(`invalid review ref ${JSON.stringify(base)}`);
    const head = oidOf(root, "HEAD");
    if (!head) throw new UsageError("--base needs a HEAD commit to compare with");
    const mb = git(root, ["merge-base", oid, head]);
    const mergeBase = !mb.error && mb.status === 0 ? mb.stdout.trim() : "";
    if (!OID.test(mergeBase)) throw new UsageError(`no merge base between ${base} and HEAD (shallow history or unrelated histories); fetch the ancestry or choose another --base`);
    label = `branch against ${base} (merge base ${mergeBase.slice(0, 12)}), with the working tree and untracked files`;
    mode = "base";
    raw = checked(git(root, ["diff", mergeBase, ...PATCH_FLAGS, "--"], { binary: true }), "git diff");
  } else {
    label = "working tree (staged, unstaged and untracked)";
    mode = "uncommitted";
    raw = checked(git(root, ["diff", worktreeBase(root), ...PATCH_FLAGS, "--"], { binary: true }), "git diff");
  }
  const tracked = trackedInput(raw);
  const entries = [...tracked.entries, ...untrackedEntries(root, tracked.diff.length)];
  if (!entries.length) throw new UsageError(`nothing to review: no changes in the ${label}`);
  return { root, label, mode, diff: tracked.diff, entries };
}
