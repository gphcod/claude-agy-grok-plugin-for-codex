// Heartbeat (S2.3): extracted from grok_plugin_for_codex 1.1.0 lib/jobs.mjs `touchBeat` and lib/lifecycle.mjs `BEAT_MS`.
// A heartbeat is evidence of recent progress, not proof of process identity or death.
import fs from "node:fs";
import path from "node:path";

/** Refresh interval during a turn, and the age past which an unfinished job reads as lost. */
export const BEAT_MS = 10000;
export const BEAT_STALE_MS = 30000;
export const beatFile = (job) => path.join(job.dir, "beat");

export function touchBeat(job, io = fs) {
  const file = beatFile(job);
  const now = new Date();
  try { io.utimesSync(file, now, now); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    io.writeFileSync(file, "");
  }
}
/** A refresh that changes no outcome when storage fails (the interval reports failures; see lifecycle). */
export function refreshBeat(job, io = fs) {
  try { const now = new Date(); io.utimesSync(beatFile(job), now, now); return true; } catch { return false; }
}
/** The heartbeat's age in milliseconds, or Infinity when it is missing. */
export function beatAgeMs(job, io = fs) {
  try { return Date.now() - io.statSync(beatFile(job)).mtimeMs; } catch { return Infinity; }
}
