// Review (S2.5): snapshot and batches over the shared review-input protocol, the batch prompt (A5.2
// `buildBatchReviewPrompt`), the prompt templates, the severity map and the normalized result with the A5.2 exit rules.
// Validation (review-validate.mjs) runs before any mapping. Ported from grok_plugin_for_codex 1.1.0 lib/review.mjs
// (`bound`, `reviewPrompt`, `renderReview`), its grok.mjs batch orchestration, and claude_plugin_for_codex 0.5.0
// envelope.mjs (ledger reconciliation with coverage, publication failure keeps the prior state).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { UsageError } from "./args.mjs";
import { digest, makeSnapshot, startReview, continueReview, coveragePrompt, reviewCoverage, selectBatch, NoPendingInputError } from "./review-input.mjs";
import { collectTarget } from "./git.mjs";
import { reviewProblem } from "./review-validate.mjs";
import { SEVERITY_RANK, reconcileFindings, priorFindingsNote } from "./findings.mjs";

/** Indexed text per batch (A5.2: at most 180,000 bytes). */
export const INLINE_CAP = 180000;
export const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const TEMPLATES = ["advice", "review", "adversarial-review", "task"];
const describeUnit = (unit) => `${unit.path} (${unit.kind === "text" ? "pending saved input batch" : `${unit.source === "untracked" ? "untracked, " : ""}${unit.kind}`})`;

/** How many text batches a snapshot yields from a set of completed units, packed exactly as selectBatch packs them. */
export function remainingTextBatches(snapshot, completed = []) {
  const done = new Set(completed);
  let batches = 0;
  for (;;) {
    let batch;
    try { batch = selectBatch(snapshot, { completed: [...done] }); } catch { break; }
    if (batch.active.includes("synthesis")) break;
    batches += 1;
    batch.active.forEach((id) => done.add(id));
  }
  return batches;
}
/** Batch i of n for a state: text batches, then one synthesis pass when the input needed more than one batch. */
export function batchPosition(snapshot, state) {
  const text = remainingTextBatches(snapshot, []);
  const total = text + (state.synthesisRequired ? 1 : 0);
  if (state.active?.includes("synthesis")) return { index: total, total };
  const left = remainingTextBatches(snapshot, state.completed);
  return { index: Math.max(1, Math.min(total, text - left + 1)), total: Math.max(total, 1) };
}

/** The review input of a target: the frozen snapshot, its first batch preview, and the units outside it. */
export function collectReview(cwd, options = {}, { inlineCap = INLINE_CAP } = {}) {
  const target = collectTarget(cwd, options);
  const snapshot = makeSnapshot(target.entries, inlineCap, { comparison: target.label, mode: target.mode, trackedDiffHash: digest(target.diff) });
  const first = startReview(snapshot, "pending", "");
  const active = new Set(first.state.active);
  return {
    label: target.label, mode: target.mode, root: target.root, snapshot, fullDiff: target.diff,
    omitted: [...new Set(snapshot.index.units.filter((unit) => !active.has(unit.id)).map(describeUnit))],
    unsupported: [...new Set(snapshot.index.units.filter((unit) => unit.kind !== "text").map(describeUnit))],
    batch: batchPosition(snapshot, first.state),
  };
}
/** Writes the immutable review input the continuation reads back and hash-checks. */
export function saveReviewInput(inputRoot, snapshot, fullDiff) {
  fs.mkdirSync(inputRoot, { recursive: true });
  fs.writeFileSync(path.join(inputRoot, "review.diff"), fullDiff);
  fs.writeFileSync(path.join(inputRoot, "index.json"), JSON.stringify(snapshot.index));
  fs.writeFileSync(path.join(inputRoot, "review.data"), snapshot.data);
}
/** The first batch of a new review, bound to its review reference (the job id) and saved input. */
export function startReviewTurn(review, reviewRef, inputRoot) {
  const first = startReview(review.snapshot, reviewRef, inputRoot);
  return { state: first.state, text: first.text, batch: batchPosition(review.snapshot, first.state) };
}
/** The next saved batch, then synthesis (`reply --next-input`); a tampered snapshot throws before any model work. */
export function continueReviewTurn(state, persist = false) {
  let next;
  try { next = continueReview(state, persist); }
  catch (error) {
    if (error instanceof NoPendingInputError) throw new UsageError("--next-input has nothing left to send: every saved batch and the synthesis pass are complete");
    throw error;
  }
  return { state: next.state, text: next.text, batch: batchPosition(next.snapshot, next.state) };
}

export function loadTemplate(name, root = PLUGIN_ROOT) {
  if (!TEMPLATES.includes(name)) throw new Error(`unknown prompt template ${name}`);
  return fs.readFileSync(path.join(root, "prompts", `${name}.md`), "utf8");
}
/** Fills `{{NAME}}` placeholders; an unresolved placeholder, or a value the template does not use, is an error. */
export function interpolate(template, values) {
  const used = new Set();
  const text = template.replace(/\{\{([A-Z_]+)\}\}/g, (_, key) => {
    if (!Object.hasOwn(values, key)) throw new Error(`unresolved placeholder {{${key}}}`);
    used.add(key);
    return String(values[key] ?? "");
  });
  for (const key of Object.keys(values)) if (!used.has(key)) throw new Error(`template has no placeholder {{${key}}}`);
  return text;
}
/**
 * The per-turn review instructions (A5.2): the review or adversarial template, the user's focus, the prior-findings note
 * on batch 2 and later, the coverage prompt for this batch, and the schema text when `embedSchema` is set.
 */
export function buildBatchReviewPrompt({ adversarial = false, focus = "", ledger = [], batchText = "", embedSchema = null, label = "", unsupported = [], state = null, root = PLUGIN_ROOT }) {
  const template = loadTemplate(adversarial ? "adversarial-review" : "review", root);
  const rootNote = state?.workspaceRoot ? `Repository root: ${JSON.stringify(state.workspaceRoot)}. Diff paths are relative to this directory; resolve context reads against it.\n` : "";
  const coverage = rootNote + (state ? coveragePrompt(state, batchText) : batchText);
  const outside = unsupported.length
    ? ["These changes are not shown and are outside this review; do not approve them:", ...unsupported.slice(0, 20).map((o) => `- ${o}`),
      ...(unsupported.length > 20 ? [`${unsupported.length} unsupported paths in total; see the saved index.`] : [])].join("\n")
    : "Every collected change is reviewable text.";
  const schema = embedSchema
    ? `Answer with one JSON object and nothing else, matching this draft-07 schema exactly:\n${typeof embedSchema === "string" ? embedSchema : JSON.stringify(embedSchema)}`
    : "Answer in the structured-output schema the harness enforces.";
  return interpolate(template, {
    TARGET_LABEL: label || "the supplied changes", USER_FOCUS: focus.trim() || "none given",
    PRIOR_FINDINGS: priorFindingsNote(ledger) || "First batch: no earlier findings.", UNSUPPORTED: outside, SCHEMA: schema, REVIEW_INPUT: coverage.trimEnd(),
  });
}

/**
 * The normalized result (A5.2): {verdict: approve|changes|incomplete, findings, coverage, incomplete, exit}. critical/high
 * map to BLOCKER, medium to MAJOR, low to MINOR; needs-attention is `changes`; an approval that keeps open findings is
 * `changes`. Coverage comes from the review state (the snapshot index), never from model output. Exit 10 when findings
 * exist, coverage is unreviewed or pending, the ledger still blocks, or the output is malformed or missing.
 */
export function normalizeReview(structured, { state = null, unreviewed = [] } = {}) {
  const coverage = { reviewed: state?.completed?.length ?? 0, unreviewed: unreviewed.length, pending: (state?.pending ?? 0) + (state?.synthesisPending ? 1 : 0) };
  const problem = reviewProblem(structured);
  if (problem) return { verdict: "incomplete", findings: [], coverage, incomplete: problem, exit: 10, summary: null, nextSteps: [] };
  const findings = structured.findings.map((f) => ({ id: f.id, severity: SEVERITY_RANK[f.severity], file: f.file, line: f.line_start, title: f.title, text: f.body,
    ...(f.recommendation ? { recommendation: f.recommendation } : {}), ...(f.decision ? { decision: f.decision } : {}) }));
  const open = findings.filter((f) => f.decision !== "REJECT");
  const verdict = structured.verdict === "needs-attention" || open.length ? "changes" : "approve";
  const attention = verdict === "changes" || coverage.unreviewed > 0 || coverage.pending > 0 || Boolean(state?.blocking);
  return { verdict, findings, coverage, incomplete: null, exit: attention ? 10 : 0, summary: structured.summary, nextSteps: structured.next_steps };
}
const stripState = (state) => { const { unreviewed, omissions, ...rest } = state; return rest; };
/** Unreviewed means left out of the review (unsupported input); pending saved batches are counted as pending, not here (A5.2). */
const unreviewedOf = (state) => (state.unreviewed ?? []).filter((u) => !u.endsWith("(pending saved input batch)"));

/**
 * Settles one review turn: validation before mapping, then the findings ledger and the coverage published together.
 * A failed turn or invalid output grants no coverage and resolves no finding; a discussion turn (no active batch) updates
 * the ledger but grants no delivery coverage; a failed publication leaves the prior ledger and coverage unchanged and
 * reports `review integrity`. Returns what the lifecycle records: {error?, verdict, findings, reviewState, unreviewed,
 * text, attention, normalized}.
 */
export function finalizeReviewTurn({ state, structured, success = true, resultPath = null, jobId = "job" }) {
  const problem = success ? reviewProblem(structured) : "the turn did not complete";
  const discussion = !state.active?.length;
  if (problem) {
    const base = reviewCoverage(state, false);
    const normalized = normalizeReview(null, { state: base, unreviewed: unreviewedOf(base) });
    normalized.incomplete = problem;
    return { verdict: "incomplete", findings: [], reviewState: stripState(base), unreviewed: unreviewedOf(base), normalized, attention: true, incomplete: problem,
      text: renderReview(normalized) };
  }
  const reconciled = reconcileFindings(state, structured, jobId);
  let next;
  try {
    next = reviewCoverage(reconciled.state, !discussion, false, discussion ? null : resultPath, structured, reconciled.reportedBlocking);
  } catch (error) {
    let base = state;
    try { base = reviewCoverage(state, false); } catch { /* keep the admission state */ }
    return { error: `review integrity: ${error.message}`, reviewState: stripState(base), unreviewed: unreviewedOf(base) };
  }
  const normalized = normalizeReview(reconciled.output, { state: next, unreviewed: unreviewedOf(next) });
  return { verdict: normalized.verdict === "changes" ? "needs-attention" : "approve", findings: normalized.findings, reviewState: stripState(next), unreviewed: unreviewedOf(next),
    normalized, attention: normalized.exit === 10, text: renderReview(normalized, next) };
}

/** The text rendering of a normalized review for the answer file. */
export function renderReview(normalized, state = null) {
  const word = { approve: "approve", changes: "needs attention", incomplete: "incomplete" }[normalized.verdict];
  const lines = [`Verdict: ${word}.${normalized.summary ? ` ${normalized.summary.trim()}` : ""}`];
  if (normalized.incomplete) lines.push(`Incomplete: ${normalized.incomplete}`);
  for (const f of normalized.findings) {
    lines.push("", `${f.id} ${f.severity} ${f.file}:${f.line}${f.decision ? ` ${f.decision}` : ""}: ${f.title.trim()}`, f.text.trim());
    if (f.recommendation?.trim()) lines.push(`Fix: ${f.recommendation.trim()}`);
  }
  if (state?.blocking && !normalized.findings.some((f) => ["BLOCKER"].includes(f.severity) && f.decision !== "REJECT")) {
    const open = (state.findingsLedger ?? []).filter((item) => item.decision !== "REJECT" && ["critical", "high"].includes(item.severity)).map((item) => item.id);
    lines.push("", `Earlier review responses reported blocking findings that remain open: ${open.join(", ")}.`);
  }
  if (normalized.nextSteps?.length) lines.push("", "Next steps:", ...normalized.nextSteps.map((s) => `- ${s.trim()}`));
  const c = normalized.coverage;
  if (c.unreviewed || c.pending) lines.push("", `Coverage: ${c.reviewed} unit(s) reviewed, ${c.unreviewed} unreviewed, ${c.pending} pending.`);
  return `${lines.join("\n")}\n`;
}
