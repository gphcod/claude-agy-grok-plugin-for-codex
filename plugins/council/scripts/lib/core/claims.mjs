// Thread claims (S2.3): ported from grok_plugin_for_codex 1.1.0 lib/claims.mjs with codex-plugin-cc 2.3.2's `claimHeld`
// and `claimLeft` marker. Paths are `claims/<provider>/<threadId>`: every thread lookup is namespaced by provider (A7.3).
import fs from "node:fs";
import path from "node:path";

const THREAD = /^[a-zA-Z0-9_.:-]{1,128}$/;
const PROVIDER = /^[a-z][a-z0-9-]{0,31}$/;
const TOKEN = /^[a-f0-9]{32}$/;
export class BusyError extends Error {}

export function claimPath(home, provider, thread) {
  if (!PROVIDER.test(provider ?? "")) throw new Error("invalid provider id");
  if (!THREAD.test(thread ?? "") || thread === "." || thread === "..") throw new Error("invalid native thread id");
  return path.join(home, "claims", provider, thread.toLowerCase());
}
function ownerName(job) {
  if (!TOKEN.test(job.ownerToken ?? "")) throw new Error("job has no valid claim owner token; reconcile the old job first");
  return `owner-${job.ownerToken}`;
}

/** Inspect a claim without changing it. Empty/unreadable claims are occupied, never stale. */
export function inspectClaim(home, provider, thread, io = fs) {
  const dir = claimPath(home, provider, thread);
  try {
    const names = io.readdirSync(dir);
    if (names.length !== 1 || !/^owner-[a-f0-9]{32}$/.test(names[0])) return { state: "unknown", dir };
    const job = io.readFileSync(path.join(dir, names[0]), "utf8").trim();
    return /^[a-z0-9]{1,16}$/.test(job) ? { state: "owned", dir, job, token: names[0].slice(6) } : { state: "unknown", dir };
  } catch (error) {
    return { state: error.code === "ENOENT" && !io.existsSync(dir) ? "absent" : "unknown", dir };
  }
}

/** Nonblocking admission. Save the initialized job before calling; spawn only after success. */
export function claimThread(home, provider, thread, job, io = fs) {
  const dir = claimPath(home, provider, thread);
  const owner = ownerName(job);
  io.mkdirSync(path.dirname(dir), { recursive: true });
  try { io.mkdirSync(dir); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    const found = inspectClaim(home, provider, thread, io);
    if (found.state === "owned" && found.token === job.ownerToken && found.job === job.id) return; // the same turn can receive its requested id again
    throw Object.assign(new BusyError(`thread ${thread} is busy${found.job ? ` as job ${found.job}; wait or cancel ${found.job}` : "; unidentified claim: quiesce this state root before manual recovery"}`), { job: found.job ?? null });
  }
  // A failed publication intentionally leaves an empty/unreadable claim. Never reclaim by age.
  try { io.writeFileSync(path.join(dir, owner), `${job.id}\n`, { flag: "wx" }); }
  catch (error) { throw Object.assign(error, { claimLeft: true }); }
}

/**
 * Only the successful unlinker may try rmdir, exactly once. A delayed second releaser must not remove a replacement
 * owner's directory. No recursive deletion and no retry after ENOENT.
 */
export function releaseThread(home, provider, thread, job, io = fs) {
  const dir = claimPath(home, provider, thread);
  try { io.unlinkSync(path.join(dir, ownerName(job))); }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
  try { io.rmdirSync(dir); }
  catch (error) { if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code)) throw error; }
  return true;
}

/** Every thread this job owns under its provider; also finds a claim published just before its owner crashed. */
export function ownedThreads(home, job, io = fs) {
  if (!job.ownerToken || !PROVIDER.test(job.provider ?? "")) return [];
  const owner = ownerName(job);
  let names;
  try { names = io.readdirSync(path.join(home, "claims", job.provider)); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
  return names.filter((thread) => {
    if (!THREAD.test(thread)) return false;
    try { return io.statSync(path.join(home, "claims", job.provider, thread, owner)).isFile(); }
    catch (error) { if (error.code === "ENOENT") return false; throw error; }
  });
}

/** A job holds a claim when it owns a thread, or when one of its threads carries an empty/unreadable claim. */
export function claimHeld(home, job, io = fs) {
  if (ownedThreads(home, job, io).length) return true;
  return (job.threadIds ?? []).some((id) => job.provider && inspectClaim(home, job.provider, id, io).state === "unknown");
}
export function releaseClaims(home, job, io = fs) {
  for (const thread of ownedThreads(home, job, io)) releaseThread(home, job.provider, thread, job, io);
}
