// Output grammar (A3.4) and the answer scan, ported from grok_plugin_for_codex 1.1.0 lib/output.mjs and lib/answer.mjs
// (S2.2). The start line goes to stderr, suppressed under --json; the footer is one stdout line; cost and counters
// live in --json. The answer preview is capped at 24 KiB and the full answer named by `full: <file>`.
// Footer: `council <provider> <status> · job <id> · <model>/<effort>[<=requested] · <duration>[ · round N/M][ · edited N]
// [ · unreviewed N][ · batch i/n][ · model unverified][ · full: <file>][ · error: <msg> | · attention: <reason>][ · <recovery hint>]`.
import fs from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

export const ANSWER_CAP = 24 * 1024;
const LABELS = { ok: "ok", attention: "needs attention", failed: "failed", cancelled: "cancelled" };

/** UTF-8 prefix without an incomplete code point or removal of a genuine replacement character. */
export function utf8Prefix(text, cap) {
  const bytes = Buffer.from(String(text), "utf8");
  if (bytes.length <= cap) return String(text);
  let end = cap;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}
const collapsed = (text, max) => utf8Prefix(String(text).replace(/\s+/g, " ").trim(), max);
/**
 * One footer value: provider text cannot fake a token or drive the terminal. Control characters (C0, ESC, DEL, C1) go, and
 * a free-standing `·` becomes `-`, also at the ends, where a footer's own space would complete the delimiter.
 */
const freeDot = (text) => text.replace(/(?<=^|\s)·(?=\s|$)/g, "-");
// Clipping can leave a new trailing ` ·`, so the check runs again on the clipped value.
const oneLine = (text, max = 200) => freeDot(collapsed(freeDot(String(text).replace(/\s+/g, " ").replace(/[\u0000-\u001f\u007f-\u009f]/g, "")), max));
export const pendingCleanup = (job) => Boolean((job.cleanupPending && !job.stopped) || job.claimHeld);
const bytes = (text) => Buffer.byteLength(text, "utf8");
/** The input fields that say what a denied call was trying to do, across the providers' tool shapes. */
const DENIED_DETAIL = ["command", "CommandLine", "file_path", "TargetFile", "AbsolutePath", "FilePath", "Path", "path", "notebook_path", "url", "Url", "pattern", "query"];
function deniedDetail(input) {
  if (!input || typeof input !== "object") return null;
  const value = DENIED_DETAIL.map((key) => input[key]).find((v) => typeof v === "string" && v) ?? Object.values(input).find((v) => typeof v === "string" && v);
  return value ?? null;
}
/** One denial as `<tool>(<what it tried>)`; a provider that names no tool (Grok's permission stop) gives its reason. */
function denialSummary(denial) {
  if (!denial?.tool) return `a tool call: ${denial?.reason ?? "permission refused"}`;
  const detail = denial.path ?? deniedDetail(denial.input ?? denial.parameters);
  return detail ? `${denial.tool}(${oneLine(detail, 120)})` : String(denial.tool);
}
/**
 * The footer's `attention: <reason>` (A3.4): why a turn needs attention, one line, at most 200 B, cause first. The first
 * denial with ` (+N more)`, the incomplete message as is, or the open questions of an answer. Null otherwise: a review's
 * plain findings, coverage and batches have their own output and tokens.
 */
export function attentionReason({ denied = [], incomplete = null, questions = false } = {}) {
  const denials = denied.flatMap((d) => (Array.isArray(d?.denials) ? d.denials : [d]));
  if (denials.length) {
    const more = denials.length > 1 ? ` (+${denials.length - 1} more)` : "";
    return `${oneLine(`denied ${denialSummary(denials[0])}`, 200 - bytes(more))}${more}`;
  }
  if (incomplete) return oneLine(incomplete);
  return questions ? "open questions in the answer" : null;
}
const attentionOf = (job) => (job.outcome === "attention" ? job.attention ?? null : null);

export function elapsed(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const [h, m, s] = [Math.floor(total / 3600), Math.floor((total % 3600) / 60), total % 60];
  const pad = (n) => String(n).padStart(2, "0");
  return h ? `${h}h${pad(m)}m` : m ? `${m}m${pad(s)}s` : `${s}s`;
}
export const elapsedOf = (job) => (job.endedAt ? Date.parse(job.endedAt) : Date.now()) - (Date.parse(job.spawnedAt) || 0);
export function capAnswer(text) {
  return { text: utf8Prefix(text, ANSWER_CAP), clipped: Buffer.byteLength(text, "utf8") > ANSWER_CAP };
}

/** `[council] provider=<p> job=<id> thread=<native id|?>[ target=<t>]`, stderr. */
export const startLine = (job) => `[council] provider=${job.provider} job=${job.id} thread=${job.threadId ?? job.requestedThreadId ?? "?"}${job.target ? ` target=${oneLine(job.target)}` : ""}`;

const THREADED = new Set(["ask", "reply", "task"]);
/** The `<model>/<effort>[<=requested]` token; `model unverified` is a separate token. */
export function modelToken(job) {
  const effort = job.effort ?? "?";
  const clamp = job.requestedEffort && job.requestedEffort !== job.effort ? `<=${job.requestedEffort}` : "";
  return `${oneLine(job.model ?? "default")}/${oneLine(effort)}${clamp}`;
}
/** The recovery hint that closes a footer, or null. */
export function recoveryHint(job) {
  if (job.threadLocked) return `thread locked; next: cancel ${job.id} --confirm-ended after checking the process table; do not resume`;
  if (pendingCleanup(job)) return `cleanup pending; next: cancel ${job.id}; do not resume`;
  // The provider finished without confirming its thread (Grok's end without a session id): the thread is not resumable.
  if (job.unconfirmed) return oneLine(job.unconfirmed);
  if (job.outcome === "failed" && job.admitted && !job.threadId && job.requestedThreadId) return "thread not confirmed; start a new ask";
  const pendingReview = job.reviewState?.pending || job.reviewState?.synthesisPending ? `next: reply ${job.id} --next-input` : null;
  // An adapter that checks the workspace around a turn (Gemini's snapshots) could not tell whether it changed.
  if (job.mutationCoverage === "unknown") return ["coverage unknown", pendingReview].filter(Boolean).join("; ");
  return pendingReview;
}
export function footer(job, clipped) {
  const parts = [`council ${job.provider} ${LABELS[job.outcome] ?? job.outcome}`, `job ${job.id}`, modelToken(job), elapsed(elapsedOf(job))];
  if (THREADED.has(job.verb) && job.rounds) parts.push(`round ${job.round ?? 0}/${job.rounds}`);
  if (job.verb === "task") parts.push(`edited ${(job.edited ?? []).length}`);
  const reviewLike = job.verb === "review" || job.nextInput;
  if (reviewLike && job.unreviewed?.length) parts.push(`unreviewed ${job.unreviewed.length}`);
  if (reviewLike && job.batch?.total > 1) parts.push(`batch ${job.batch.index}/${job.batch.total}`);
  if (job.modelVerified === false) parts.push("model unverified");
  if (clipped || job.answerClipped) parts.push(`full: ${path.join(job.dir, "answer.md")}`);
  if (job.error) parts.push(`error: ${oneLine(job.error)}`);
  else if (attentionOf(job)) parts.push(`attention: ${oneLine(attentionOf(job))}`);
  const hint = recoveryHint(job);
  if (hint) parts.push(hint);
  return parts.join(" · ");
}
export function renderResult(job, answer) {
  const { text, clipped } = capAnswer(answer);
  const body = text.trimEnd();
  return `${body ? `${body}\n` : ""}${footer(job, clipped)}\n`;
}
/** The --json object (A3.4). */
export function resultJson(job, answer) {
  const { text, clipped } = capAnswer(answer);
  const coverage = job.verb !== "task" && job.reviewState ? { reviewRef: job.reviewState.reviewRef, snapshotId: job.reviewState.snapshotId, status: job.reviewState.status,
    total: job.reviewState.total, pending: job.reviewState.pending, reviewed: job.reviewState.completed?.length ?? 0,
    unreviewed: (job.unreviewed ?? []).slice(0, 20).map((u) => collapsed(u, 200)), unsupportedCount: job.reviewState.unsupportedCount,
    synthesisPending: job.reviewState.synthesisPending, blocking: job.reviewState.blocking } : null;
  return {
    provider: job.provider, job: job.id, thread: job.threadId ?? null, requestedThread: job.requestedThreadId ?? null, session: job.session ?? null,
    status: job.outcome, exit: job.code, verb: job.verb, tier: job.tier ?? null, model: oneLine(job.model ?? "default"), modelVerified: job.modelVerified !== false,
    effort: job.effort ?? null, requestedEffort: job.requestedEffort ?? job.effort ?? null, round: job.round ?? null, rounds: job.rounds ?? null,
    verdict: job.verdict ?? null, findings: job.findings ?? null, coverage, batch: job.batch ?? null,
    edited: (job.edited ?? []).slice(0, 10).map((p) => collapsed(p, 200)), editedCount: (job.edited ?? []).length,
    failedCommands: (job.failedCommands ?? []).slice(0, 10).map((c) => collapsed(c, 200)), failedCommandCount: (job.failedCommands ?? []).length,
    costUsd: job.cost ?? null, elapsedMs: elapsedOf(job), error: job.error ? oneLine(job.error, 2000) : null, attention: attentionOf(job),
    cleanupPending: pendingCleanup(job), threadLocked: Boolean(job.threadLocked), answer: text, clipped: clipped || Boolean(job.answerClipped),
    answerFile: path.join(job.dir, "answer.md"),
  };
}

/** Scan the complete answer without retaining it in memory. Its file remains authoritative. */
export function readAnswer(file) {
  const fd = fs.openSync(file, "r");
  const decoder = new StringDecoder("utf8");
  const buffer = Buffer.alloc(64 * 1024);
  let preview = "", line = "", lineBytes = 0, total = 0;
  let nonempty = false, active = false, body = "", questions = false;
  const label = /^[\s>*_#-]*open questions\b[\s*_]*:/i;
  const next = /^[\s>*_#-]*(next|verification|outcome|summary|changes)\b[\s*_]*:/i;
  const finishSection = () => { questions ||= active && !["", "none", "na", "no"].includes(body); active = false; body = ""; };
  const acceptLine = (text) => {
    if (label.test(text)) { finishSection(); active = true; text = text.replace(label, ""); }
    else if (active && next.test(text)) finishSection();
    if (active) body = (body + text.replace(/[\s*_.`\-/]/g, "").toLowerCase()).slice(0, 32);
  };
  const accept = (text) => {
    nonempty ||= Boolean(text.trim());
    if (Buffer.byteLength(preview) <= ANSWER_CAP) preview += text.slice(0, ANSWER_CAP + 4);
    let at = 0;
    for (;;) {
      const end = text.indexOf("\n", at);
      const part = text.slice(at, end < 0 ? text.length : end);
      lineBytes += Buffer.byteLength(part);
      if (lineBytes > 1024 * 1024) throw new Error("answer line exceeds 1 MiB; full answer retained");
      line += part;
      if (end < 0) break;
      acceptLine(line); line = ""; lineBytes = 0; at = end + 1;
    }
  };
  try {
    for (;;) {
      const size = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (!size) break;
      total += size; accept(decoder.write(buffer.subarray(0, size)));
    }
    accept(decoder.end()); acceptLine(line); finishSection();
    return { answer: capAnswer(preview).text, answerClipped: total > ANSWER_CAP, nonempty, questions };
  } finally { fs.closeSync(fd); }
}
