// Job records (S2.3): ported from grok_plugin_for_codex 1.1.0 lib/jobs.mjs with codex-plugin-cc 2.3.2 lib/jobs.mjs
// (16-character ids, trash pruning) and lib/requests.mjs (request records). State root COUNCIL_CODEX_HOME →
// ~/.codex/council (A7.1); records carry `provider`, `session` and `threadId`; `candidates()` filters by cwd and
// session together (A7.2); request ids follow A7.4; thread queries take the provider (A7.3).
import { reservationRecord, readPublications, publishRequest, cleanupPublications, syncPublicationDirectory, linkReservation, releaseReservation } from "./request-publication.mjs";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { canonical, readJson, sleepSync, writeFileAtomic } from "./fs.mjs";
import { UsageError } from "./args.mjs";
import { STATE_ROOT_ENV, defaultStateRoot } from "./host.mjs";
import { claimPath, inspectClaim, ownedThreads, claimHeld as claimHeldIn } from "./claims.mjs";
import { touchBeat, BEAT_STALE_MS } from "./heartbeat.mjs";

export const KEEP_FINISHED = 100;
const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
export const JOB_ID = /^[a-z0-9]{1,16}$/;
export const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
/**
 * Output, scope and timing options; every other option changes what runs, so it is part of the request fingerprint. The
 * timers are not inputs (as the twin): a retry with a longer --deadline or --inactivity-timeout replays the first call.
 */
const NOT_INPUTS = new Set(["json", "request-id", "timeout", "deadline", "inactivity-timeout"]);
const BUSY = ["EBUSY", "EPERM", "EACCES"];
/** A fatal condition outside the user's input (exit 1), such as a state root inside the workspace. */
export class StateError extends Error {}
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/**
 * One canonical local state root. It is created before it is resolved: a root that did not exist yet would otherwise
 * keep its unresolved spelling (a symlink or junction) on first use.
 */
export function homeDir(env = process.env, { create = true } = {}) {
  const root = path.resolve(env[STATE_ROOT_ENV] || defaultStateRoot());
  if (create) try { fs.mkdirSync(root, { recursive: true }); } catch { /* a later write reports the error. */ }
  // Resolve the existing ancestor before admission, without creating a rejected root through a junction or symlink.
  let ancestor = root;
  const suffix = [];
  for (;;) {
    try { return path.join(fs.realpathSync.native(ancestor), ...suffix.slice().reverse()); }
    catch {
      const parent = path.dirname(ancestor);
      if (parent === ancestor) return canonical(root);
      suffix.push(path.basename(ancestor));
      ancestor = parent;
    }
  }
}
function isWithin(root, target) {
  const rel = path.relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}
/** State never lives inside the workspace (A7.1): repository-controlled state cannot grant itself permissions. */
export function assertStateOutsideWorkspace(home, cwd) {
  if (isWithin(canonical(cwd), home)) throw new StateError(`the state root ${home} lies inside the workspace ${cwd}; set ${STATE_ROOT_ENV} to a directory outside it`);
}
const jobsRoot = (home) => path.join(home, "jobs");
const requestsRoot = (home) => path.join(home, "requests");
const threadsRoot = (home) => path.join(home, "threads");

/** Only the job's companion writes metadata. Marker/read-time fields never enter that record. */
export function saveJob(job) {
  const { dir, done, beatMs, stopped, stoppedAt, cancelRequested, claimHeld, ...meta } = job;
  writeFileAtomic(path.join(dir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
}
export function markDone(job) {
  fs.writeFileSync(path.join(job.dir, "done"), "");
  job.done = true;
}
/** Recovery's only terminal artifact: it never rewrites a slow/dead companion's result. */
export function markStopped(job) {
  try { fs.writeFileSync(path.join(job.dir, "stopped"), "", { flag: "wx" }); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
}

/** Creates a job directory, or returns false when it exists: its id is reserved from here on, before any record. */
function claimDir(home, id) {
  fs.mkdirSync(jobsRoot(home), { recursive: true });
  try { fs.mkdirSync(path.join(jobsRoot(home), id)); return true; }
  catch (error) { if (error.code === "EEXIST") return false; throw error; }
}
/** A fresh 16-character id: long enough that the id of a deleted job is never issued again. */
export function reserveJob(home) {
  for (;;) {
    const id = Array.from(randomBytes(16), (b) => ID_ALPHABET[b % ID_ALPHABET.length]).join("");
    if (claimDir(home, id)) return id;
  }
}
/** The 16-character job id of a request: derived from provider, host session, realpath(cwd) and the request id (A3.3). */
export const requestJobId = (provider, session, cwd, requestId) => hash([provider, session ?? null, cwd, requestId]).slice(0, 16);

export function createJob(home, fields, id = reserveJob(home)) {
  const job = { id, ownerToken: randomBytes(16).toString("hex"), ...fields, dir: path.join(jobsRoot(home), id), done: false };
  // The heartbeat before the record: a job a reader can load always has one.
  touchBeat(job);
  saveJob(job);
  try { prune(home); } catch { /* housekeeping must never abort admission of a new, unrelated job */ }
  return job;
}

// Request lifecycle (A7.4). The record under requests/<key>.json is the lookup index: its key is session, cwd and the
// request id, provider-neutral, so one exclusive reservation is taken before any provider is resolved (two identical
// calls whose --last would resolve differently still reserve once). It stores the fingerprint, then the provider and job
// once bound, becomes a tombstone once preparation completes, and is never removed or reused unless nothing ran.
export function requestKey(session, cwd, requestId) {
  if (typeof requestId !== "string" || !REQUEST_ID.test(requestId)) throw new UsageError("--request-id needs 1 to 128 letters, digits, '.', '_', ':' or '-', starting with a letter or digit");
  return hash([session ?? null, cwd, requestId]).slice(0, 40);
}
/** The fingerprint of the raw inputs, taken before any resolution: verb, every input option, the text. */
export function requestFingerprint(verb, options, text) {
  const inputs = Object.keys(options).filter((key) => !NOT_INPUTS.has(key)).sort().map((key) => [key, options[key]]);
  return hash([verb, inputs, text]);
}
const requestFile = (home, key) => path.join(requestsRoot(home), `${key}.json`);
/** The recorded request, or null. A record that stays unreadable is never absent. */
export function lookupRequest(home, key, { waitMs = 1000 } = {}) {
  const file = requestFile(home, key);
  for (const end = Date.now() + waitMs; ; sleepSync(20)) {
    let text;
    try { text = fs.readFileSync(file, "utf8"); }
    catch (error) {
      if (error.code === "ENOENT") return null;
      if (!BUSY.includes(error.code) || Date.now() >= end) throw error;
      continue;
    }
    let record;
    try { record = JSON.parse(text); } catch { /* Not yet complete. */ }
    const bound = JOB_ID.test(record?.job ?? "") && record.provider;
    if (typeof record?.fingerprint === "string" && (bound || (record.state === "reserved" && record.job === null))) return readPublications(file, record);
    if (Date.now() >= end) throw new Error(`request ${key} has an unreadable record (${file}); nothing was started. Retry with a new request id`);
  }
}
/**
 * Exclusive reservation: one job ever holds a request id. Returns {fresh: true, record} when this call owns it, else
 * {fresh: false, record} with the existing record. Without a provider and job id the reservation is unbound until
 * `bindRequest`; with them the job directory is claimed in the same step.
 */
export function claimRequest(home, { key, requestId, provider = null, session, cwd, fingerprint, jobId = null, companionPid = process.pid, companionIdentity = null }) {
  const file = requestFile(home, key);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const existing = () => {
    const record = lookupRequest(home, key);
    if (!record) throw new Error(`request ${requestId}: its record disappeared; nothing was started`);
    return { fresh: false, record };
  };
  if (fs.existsSync(file)) return existing();
  const record = { state: "reserved", recordToken: randomBytes(16).toString("hex"), id: requestId, key, provider, job: jobId, session: session ?? null, cwd, fingerprint, companionPid, companionIdentity, reservedAt: new Date().toISOString() };
  // The reservation appears whole or not at all: written to a private file, then linked into place exclusively. No reader
  // sees an empty or partial reservation, and a failed write (ENOSPC) leaves nothing behind, so an identical retry runs.
  // An unparseable record can then only be damage; it is never treated as abandoned (lookupRequest reports it).
  const temp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  let claimedDir = false;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(reservationRecord(record))}\n`, { flag: "wx", flush: true });
    if (jobId) { if (!claimDir(home, jobId)) throw new Error(`request ${requestId}: its job directory ${jobId} already exists`); claimedDir = true; }
    try { linkReservation(temp, file, record); syncPublicationDirectory(file); }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (claimedDir) { fs.rmSync(path.join(jobsRoot(home), jobId), { recursive: true, force: true }); claimedDir = false; }
      return existing();
    }
  } catch (error) {
    if (claimedDir) fs.rmSync(path.join(jobsRoot(home), jobId), { recursive: true, force: true });
    throw error;
  } finally {
    try { fs.rmSync(temp, { force: true }); } catch { /* best effort: a published reservation stands; a stray temp file is harmless */ }
  }
  return { fresh: true, record };
}
/** Binds an unbound reservation to the resolved provider and its job, claiming the job directory. */
export function bindRequest(home, key, { provider, jobId, recordToken = null }) {
  const record = lookupRequest(home, key);
  if (!record || record.job !== null || (recordToken && record.recordToken !== recordToken)) throw new Error("request record changed before its provider was bound");
  if (!claimDir(home, jobId)) throw new Error(`request ${record.id}: its job directory ${jobId} already exists`);
  publishRequest(requestFile(home, key), record, "binding", { provider, job: jobId });
  return { ...record, provider, job: jobId };
}
/** Preparation completed: the reservation becomes a tombstone that outlives the job body (`result expired`). */
export function markRequestPrepared(home, key, recordToken = null) {
  const record = lookupRequest(home, key);
  if (!record || (recordToken && record.recordToken !== recordToken)) throw new Error("request record changed before preparation completed");
  publishRequest(requestFile(home, key), record, "prepared", { state: "tombstone", preparedAt: new Date().toISOString() });
}
/** Frees a claimed id whose call failed before preparation completed: nothing ran, so a retry may run. */
export function releaseRequest(home, key, jobId, recordToken = null) {
  if (!releaseReservation(requestFile(home, key), recordToken)) return false;
  if (jobId) fs.rmSync(path.join(jobsRoot(home), jobId), { recursive: true, force: true });
  return true;
}
export const requestReserved = (home, key) => fs.existsSync(requestFile(home, key));

export function loadJob(home, id) {
  if (!JOB_ID.test(id ?? "")) return null;
  const dir = path.join(jobsRoot(home), id);
  let names;
  for (const deadline = Date.now() + 5000; ;) {
    try { names = new Set(fs.readdirSync(dir)); break; }
    catch (error) {
      if (error.code === "ENOENT") return null;
      if (BUSY.includes(error.code) && Date.now() < deadline) { sleepSync(20); continue; }
      throw new StateError(`cannot read job directory ${dir}: ${error.message}; leave it intact and restore access, or use a separate COUNCIL_CODEX_HOME for new work`);
    }
  }
  const mtime = (file) => { try { return fs.statSync(file).mtime; } catch (error) { if (error.code === "ENOENT") return null; throw error; } };
  // Markers first: metadata read after done was seen is final.
  const done = names.has("done");
  const stoppedAt = names.has("stopped") ? mtime(path.join(dir, "stopped"))?.toISOString() ?? null : null;
  const meta = readJson(path.join(dir, "meta.json"), { strict: true });
  const beatMs = names.has("beat") ? mtime(path.join(dir, "beat"))?.getTime() ?? 0 : 0;
  return meta && { ...meta, dir, done, beatMs, stopped: stoppedAt !== null, stoppedAt, cancelRequested: names.has("cancel") };
}
/** Every readable job, newest first. A failed directory query is not an empty job list. */
export function listJobs(home) {
  let names;
  try { names = fs.readdirSync(jobsRoot(home)); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
  return names.map((name) => loadJob(home, name)).filter(Boolean)
    .sort((a, b) => String(b.admittedAt ?? b.spawnedAt).localeCompare(String(a.admittedAt ?? a.spawnedAt)));
}
export function stateOf(job) {
  if (job.done) return job.status;
  if (job.stopped) return job.cancelRequested ? "cancelled" : "failed";
  return Date.now() - job.beatMs < BEAT_STALE_MS ? "running" : "lost";
}
/** A finalized failure can still own execution. Recovery, not age, removes that obstruction. */
export function cleanupNeeded(job) {
  return !job.stopped && (!job.done || Boolean(job.cleanupPending) || /may still be running/.test(job.error ?? ""));
}
/** A review whose saved input still has pending batches or synthesis (A7.7: never pruned). */
export const reviewInputPending = (job) => Boolean(job.reviewState && (job.reviewState.pending > 0 || job.reviewState.synthesisPending));
export function claimHeld(home, job) { return claimHeldIn(home, job); }
export function jobView(home, job) { return { ...job, cleanupPending: cleanupNeeded(job), claimHeld: claimHeld(home, job) }; }

/**
 * Finished jobs beyond the newest KEEP_FINISHED are deleted whole through trash/ (one rename, then removal); a job that
 * is running, lost, needs cleanup, holds a claim or has review input pending is never deleted (A7.7).
 */
export function prune(home) {
  let jobs;
  try { jobs = listJobs(home); }
  catch { return; } // An unreadable record may reference any snapshot: keep everything until it can be inspected.
  const reviewKey = (job) => job.reviewState ? `${job.provider}:${job.reviewState.reviewRef ?? job.reviewState.inputRoot ?? job.id}` : null;
  const latestReviews = new Map();
  for (const job of jobs) {
    const key = reviewKey(job);
    if (key && job.admitted !== false && !latestReviews.has(key)) latestReviews.set(key, job);
  }
  const finished = jobs.filter((j) => (j.done || j.stopped) && !cleanupNeeded(j) && !reviewInputPending(latestReviews.get(reviewKey(j)) ?? j));
  const expired = new Map();
  for (const job of finished.slice(KEEP_FINISHED)) {
    try { if (!claimHeld(home, job)) expired.set(job.id, job); }
    catch { /* Unreadable ownership evidence keeps this job and its review dependencies. */ }
  }
  // Retained discussion and continuation jobs still need the root job's immutable snapshot. Keep dependencies too,
  // even when that root's old metadata says complete; conversely, an old pending state is retired by newer coverage.
  const retained = jobs.filter((job) => !expired.has(job.id));
  for (const job of retained) for (const state of [job.reviewState, job.reviewStateBase]) {
    if (typeof state?.inputRoot !== "string") continue;
    const relative = path.relative(jobsRoot(home), path.resolve(state.inputRoot));
    const owner = relative.split(path.sep)[0];
    if (!path.isAbsolute(relative) && JOB_ID.test(owner) && expired.has(owner)) {
      retained.push(expired.get(owner));
      expired.delete(owner);
    }
  }
  const trash = path.join(home, "trash");
  for (const job of expired.values()) {
    try {
      if (claimHeld(home, job)) continue; // Recheck after dependency collection: another companion may have resumed it.
      fs.mkdirSync(trash, { recursive: true });
      fs.renameSync(job.dir, path.join(trash, `${job.id}-${randomBytes(4).toString("hex")}`));
    } catch { /* Unreadable claims, another companion or a failed rename: a later turn tries again. */ }
  }
  let left;
  try { left = fs.readdirSync(trash); } catch { return; }
  for (const name of left) { try { fs.rmSync(path.join(trash, name), { recursive: true, force: true }); } catch { /* Next turn. */ } }
}

/** Jobs for implicit selection (reply --last, bare wait, bare cancel): this cwd and this host session, both (A7.2). */
export function candidates(home, { cwd, session = null }) {
  return listJobs(home).filter((job) => job.cwd === cwd && (job.session ?? null) === (session ?? null));
}
export function onThread(job, provider, ref) {
  return typeof ref === "string" && (!provider || job.provider === provider) && [job.threadId, job.requestedThreadId, ...(job.threadIds ?? [])]
    .some((id) => typeof id === "string" && id.toLowerCase() === ref.toLowerCase());
}
/** A rejected/unadmitted attempt must not change reply inheritance or round counts. */
export function latestOnThread(home, provider, threadId, excludeId = null) {
  return listJobs(home).find((job) => job.id !== excludeId && job.admitted !== false && job.providerStarted !== false && onThread(job, provider, threadId)) ?? null;
}
/** The providers whose jobs name this native thread id. */
export function providersOf(home, threadId) {
  return [...new Set(listJobs(home).filter((job) => onThread(job, null, threadId)).map((job) => job.provider))];
}
/** A job by id (any session), or the latest job on a native thread; a bare native id matching several providers exits 2. */
export function findJob(home, ref, provider = null) {
  const byId = loadJob(home, ref);
  if (byId) return byId;
  if (!provider) {
    const providers = providersOf(home, ref);
    if (providers.length > 1) throw new UsageError(`thread ${ref} exists for ${providers.join(" and ")}; add --to <provider>`);
    provider = providers[0] ?? null;
  }
  // Control verbs must still find an active preparation; start evidence only filters settings inheritance.
  return provider ? listJobs(home).find((job) => job.admitted !== false && onThread(job, provider, ref)) ?? null : null;
}

/** Render a recovered failure without changing the original metadata or an already-finalized result. */
export function resultRecord(job) {
  if (job.done) return job;
  return {
    ...job, outcome: job.stopped && job.cancelRequested ? "cancelled" : "failed", code: 1, endedAt: job.stoppedAt ?? null,
    error: job.stopped ? "recovered after the companion stopped" : "companion lost; run cancel before resuming", cleanupPending: !job.stopped,
  };
}
/** One line naming an event, adapter-neutral: its `type` or `event`, and a tool name when the event carries one. */
export function describeEvent(ev) {
  const type = ev?.type ?? ev?.event;
  if (typeof type !== "string") return null;
  const tool = ev.toolName ?? ev.tool_name ?? ev.name ?? ev.step_update?.tool_name ?? ev.message?.content?.find?.((c) => c?.type === "tool_use")?.name ?? null;
  return tool ? `${type}:${tool}` : ev.subtype ? `${type}/${ev.subtype}` : type;
}
/** Read only the tail; unfinished JSON and non-JSON diagnostics are ignored. */
export function lastEvent(job) {
  try {
    const fd = fs.openSync(path.join(job.dir, "events.jsonl"), "r");
    try {
      const size = fs.fstatSync(fd).size;
      const length = Math.min(size, 8192);
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, size - length);
      for (const text of buffer.toString("utf8").split("\n").reverse()) {
        try { const described = describeEvent(JSON.parse(text)); if (described) return described; } catch { /* partial or diagnostic line */ }
      }
    } finally { fs.closeSync(fd); }
  } catch { /* No event stream yet. */ }
  return null;
}

// Thread records (A7.6): threads/<provider>-<threadId>.json, never pruned.
const threadFile = (home, provider, threadId) => path.join(threadsRoot(home), `${provider}-${String(threadId).toLowerCase()}.json`);
export function saveThread(home, record) {
  if (!record.provider || !record.threadId) throw new Error("a thread record needs provider and threadId");
  claimPath(home, record.provider, record.threadId); // Validate ids before any path is read or written.
  fs.mkdirSync(threadsRoot(home), { recursive: true });
  writeFileAtomic(threadFile(home, record.provider, record.threadId), `${JSON.stringify({ ...record, updatedAt: new Date().toISOString() }, null, 2)}\n`);
}
export function loadThread(home, provider, threadId) {
  try { claimPath(home, provider, threadId); } catch { return null; }
  return readJson(threadFile(home, provider, threadId), { strict: true });
}
/** The providers that hold a thread record for this native id. */
export function threadProviders(home, threadId) {
  let names;
  try { names = fs.readdirSync(threadsRoot(home)); } catch { return []; }
  const suffix = `-${String(threadId).toLowerCase()}.json`;
  return names.filter((n) => n.endsWith(suffix)).map((n) => n.slice(0, -suffix.length));
}
