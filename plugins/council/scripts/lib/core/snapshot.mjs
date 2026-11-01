// Bounded Git snapshots of a workspace, ported from gemini-plugin-for-codex 0.1.2 lib/snapshot.mjs (MIT, NOTICE) and made
// synchronous: HEAD, the porcelain status, the staged and unstaged diffs, and the hash of each listed file, every git call
// bounded in time and bytes. Gemini compares them around every turn (mutation coverage); the lifecycle compares them around
// every task (S7.1), so an edit made through a shell is counted. Stored in the job directory, so a deferred afterTurn in
// a later `cancel` compares the same files.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { writeFileAtomic } from "./fs.mjs";

/** Bounds: dirty paths listed (past it a snapshot is not listed whole), bytes hashed and per git call, ms per git call. */
export const SNAPSHOT = Object.freeze({ maxFiles: 5000, maxBytes: 4 * 1024 * 1024, timeoutMs: 2500 });
const sha = (data) => createHash("sha256").update(data).digest("hex");
const uniq = (list) => [...new Set(list)];

function git(root, args, env, { timeoutMs = SNAPSHOT.timeoutMs, cap = SNAPSHOT.maxBytes } = {}) {
  const r = spawnSync("git", args, { cwd: root, env: { ...env, LC_ALL: "C", TZ: "UTC", GIT_OPTIONAL_LOCKS: "0" }, encoding: null, shell: false, windowsHide: true,
    timeout: timeoutMs, maxBuffer: cap, stdio: ["ignore", "pipe", "pipe"] });
  return { code: r.error ? null : r.status, output: r.stdout ?? Buffer.alloc(0), limited: Boolean(r.error) };
}
/** The Git scope of a workspace: its realpath and repository root, or `git: false` outside Git. */
export function workspace(cwd, env = {}) {
  const real = fs.realpathSync(cwd);
  const r = git(real, ["rev-parse", "--show-toplevel"], env);
  return { cwd: real, root: r.code === 0 ? fs.realpathSync(r.output.toString("utf8").trim()) : real, git: r.code === 0 };
}
function readBounded(file, remaining) {
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);
  const fd = fs.openSync(file, flags);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return null;
    const buffer = Buffer.alloc(Math.min(stat.size + 1, remaining + 1));
    const read = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const data = buffer.subarray(0, read);
    return data.length > remaining || data.length !== stat.size || fs.fstatSync(fd).size !== stat.size ? null : data;
  } finally { fs.closeSync(fd); }
}
const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
/** `git -z` output as strings; an item that is not valid UTF-8 is null, never a lossy string. */
function nulSeparated(output) {
  const items = [];
  for (let at = 0; at < output.length;) {
    const end = output.indexOf(0, at);
    const stop = end < 0 ? output.length : end;
    try { items.push(UTF8.decode(output.subarray(at, stop))); } catch { items.push(null); }
    at = stop + 1;
  }
  return items;
}
/** One snapshot: coverage `tracked-and-unignored` (complete), `partial` (a bound was hit) or `unchecked` (outside Git). */
export function snapshot(scope, env = {}, { maxFiles = SNAPSHOT.maxFiles, maxBytes = SNAPSHOT.maxBytes, timeoutMs = SNAPSHOT.timeoutMs } = {}) {
  const start = Date.now();
  if (!scope.git) return { coverage: "unchecked", reason: "outside Git", files: {} };
  const opts = { timeoutMs, cap: maxBytes };
  const head = git(scope.root, ["rev-parse", "--verify", "HEAD"], env, opts);
  const status = git(scope.root, ["--no-optional-locks", "status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"], env, opts);
  const staged = git(scope.root, ["diff", "--cached", "--no-ext-diff", "--no-textconv", "--binary"], env, opts);
  const diff = git(scope.root, ["diff", "--no-ext-diff", "--no-textconv", "--binary", ...(head.code === 0 ? ["HEAD"] : [])], env, opts);
  let partial = [status, diff, staged].some((r) => r.code !== 0 || r.limited);
  // `listed`: the status names every dirty path, so a comparison of the entries is sound even when some hash is missing.
  let listed = status.code === 0 && !status.limited && !head.limited;
  const entries = status.output.length ? nulSeparated(status.output) : [];
  const files = Object.create(null); // a path named __proto__ is an entry, never the prototype (AGYX)
  let bytes = 0;
  for (const entry of entries) {
    // A path Node's string APIs cannot name would read as deleted in both snapshots and compare equal: no claim about it.
    if (entry === null) { partial = true; listed = false; continue; }
    if (!entry) continue;
    const state = entry.slice(0, 2), name = entry.slice(3);
    if (Object.keys(files).length >= maxFiles || Date.now() - start > timeoutMs * 4) { partial = true; listed = false; break; }
    const file = path.resolve(scope.root, name);
    if (!file.startsWith(scope.root + path.sep)) { partial = true; continue; }
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() && !stat.isSymbolicLink()) { partial = true; files[name] = { state, kind: "non-file" }; continue; }
      const measured = { state, size: stat.size, mtimeMs: stat.mtimeMs, executable: Boolean(stat.mode & 0o111) };
      if (stat.size + bytes > maxBytes) { partial = true; files[name] = { ...measured, hash: null }; continue; }
      let data;
      if (stat.isSymbolicLink()) data = Buffer.from(fs.readlinkSync(file));
      else {
        data = readBounded(file, maxBytes - bytes);
        if (!data) { partial = true; files[name] = { ...measured, hash: null }; continue; }
      }
      bytes += data.length;
      files[name] = { ...measured, hash: sha(data), ...(stat.isSymbolicLink() ? { symlink: true } : {}) };
    } catch (error) {
      if (error.code === "ENOENT") files[name] = { state, deleted: true };
      else { partial = true; files[name] = { state, error: error.code }; }
    }
  }
  return { coverage: partial ? "partial" : "tracked-and-unignored", listed, root: scope.root, head: head.code === 0 ? head.output.toString("utf8").trim() : null,
    diff: sha(diff.output), staged: sha(staged.output), files, bytes, ms: Date.now() - start };
}
/** Same content and state. An entry past the byte budget on either side (which side depends on the other dirty files) compares by size, mtime and mode; two hashes ignore a mere touch, not a chmod. */
function sameEntry(a, b) {
  if (!a || !b) return a === b;
  const plain = ({ size, mtimeMs, ...rest }) => JSON.stringify(rest);
  if (a.hash === null || b.hash === null) return a.state === b.state && a.size === b.size && a.mtimeMs === b.mtimeMs && a.executable === b.executable;
  return plain(a) === plain(b);
}
/** What changed between two snapshots (AGYX `changes`); `coverage` is complete only when both snapshots were. */
export function changes(before, after) {
  const names = uniq([...Object.keys(before.files ?? {}), ...Object.keys(after.files ?? {})])
    .filter((file) => !sameEntry(before.files?.[file], after.files?.[file])).sort();
  const changed = before.head !== after.head || before.diff !== after.diff || before.staged !== after.staged || names.length > 0;
  const coverage = before.coverage === "tracked-and-unignored" && after.coverage === "tracked-and-unignored" ? "complete" : "partial";
  return { changed, files: names, coverage };
}
const snapshotFile = (job, which) => path.join(job.dir, `snapshot-${which}.json`);
function take(cwd, env) {
  try { return snapshot(workspace(cwd, env), env); }
  catch (error) { return { coverage: "unavailable", reason: error.message, files: {} }; }
}
/** A stored snapshot, or null. */
export function snapshotOf(job, which) { try { return JSON.parse(fs.readFileSync(snapshotFile(job, which), "utf8")); } catch { return null; } }
/** Stores the before snapshot once; never replaces one. A failed write reads later as no before snapshot. */
export function snapshotBefore(job, cwd, env = {}) {
  const file = snapshotFile(job, "before");
  if (fs.existsSync(file)) return;
  try { writeFileAtomic(file, JSON.stringify(take(cwd, env))); } catch { /* compared as missing */ }
}
/** The after snapshot, taken once: a re-run compares the same files, not the user's later work. */
export function snapshotAfter(job, cwd, env = {}) {
  let after = snapshotOf(job, "after");
  if (!after) {
    after = take(cwd, env);
    try { writeFileAtomic(snapshotFile(job, "after"), JSON.stringify(after)); } catch { /* recomputed on a re-run */ }
  }
  return after;
}
/** The files two commits differ in, relative to the root; an unborn side lists the other's whole tree. Null when git fails or a name is not UTF-8. */
function headChanges(root, from, to, env) {
  const args = from && to ? ["diff", "--name-only", "-z", "--no-renames", "--no-ext-diff", from, to] : ["ls-tree", "-r", "--name-only", "-z", to ?? from];
  const r = git(root, args, env);
  if (r.code !== 0 || r.limited) return null;
  const names = nulSeparated(r.output);
  return names.includes(null) ? null : names.filter(Boolean);
}
/**
 * The paths a turn changed in the working tree, relative to `cwd` (`../x` outside it): whose listed state differs between
 * the snapshots, plus what differs between the two HEADs when HEAD moved. Null when it cannot tell (outside Git, a failed
 * git call, a listing past the cap, a path that is not valid UTF-8, no before snapshot): the caller keeps the event-reported edits.
 */
export function workspaceEdits(job, cwd, env = {}) {
  const before = snapshotOf(job, "before");
  if (!before?.listed) return null;
  const after = snapshotAfter(job, cwd, env);
  if (!after?.listed || after.root !== before.root) return null;
  const names = new Set(changes(before, after).files);
  if (before.head !== after.head) {
    const moved = headChanges(after.root, before.head, after.head, env);
    if (!moved) return null;
    for (const name of moved) names.add(name);
  }
  const base = fs.realpathSync(cwd);
  return [...names].sort().map((name) => path.relative(base, path.join(after.root, name)).split(path.sep).join("/"));
}
