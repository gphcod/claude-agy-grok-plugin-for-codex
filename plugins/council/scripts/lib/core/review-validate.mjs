// Dependency-free validator for schemas/review-output.schema.json (A5.2). Adapted from grok_plugin_for_codex
// 1.1.0 lib/review.mjs `reviewProblem`, extended for the required finding `id`, the optional `decision`, and the
// schema's additionalProperties:false at the root and the item level. It runs before any mapping (S2.5).
export const VERDICTS = ["approve", "needs-attention"];
export const SEVERITIES = ["critical", "high", "medium", "low"];
export const DECISIONS = ["AGREE", "CHANGE", "REJECT"];
const ROOT_KEYS = new Set(["verdict", "summary", "findings", "next_steps"]);
const FINDING_KEYS = new Set(["id", "severity", "title", "body", "file", "line_start", "line_end", "confidence", "recommendation", "decision"]);
const nonempty = (v) => typeof v === "string" && v.trim() !== "";
const position = (v) => Number.isInteger(v) && v >= 1;

/** Validates structured review output against the schema; returns the first problem as text, or null. */
export function reviewProblem(out) {
  if (!out || typeof out !== "object" || Array.isArray(out)) return "missing structured review output";
  const extra = Object.keys(out).filter((k) => !ROOT_KEYS.has(k));
  if (extra.length) return `review output has unknown property ${extra[0]}`;
  if (!VERDICTS.includes(out.verdict)) return "review verdict must be approve or needs-attention";
  if (!nonempty(out.summary)) return "review summary is empty";
  if (!Array.isArray(out.findings)) return "review findings must be an array";
  const ids = new Set();
  for (const [i, f] of out.findings.entries()) {
    const at = `review finding ${i + 1}`;
    if (!f || typeof f !== "object" || Array.isArray(f)) return `${at} is not an object`;
    const unknown = Object.keys(f).filter((k) => !FINDING_KEYS.has(k));
    if (unknown.length) return `${at} has unknown property ${unknown[0]}`;
    if (!nonempty(f.id)) return `${at} needs an id`;
    if (ids.has(f.id)) return `${at} repeats id ${f.id}`;
    ids.add(f.id);
    if (!SEVERITIES.includes(f.severity)) return `${at} has an unknown severity`;
    if (![f.title, f.body, f.file].every(nonempty)) return `${at} needs title, body and file`;
    if (!position(f.line_start) || !position(f.line_end) || f.line_end < f.line_start) return `${at} has an invalid line range`;
    if (typeof f.confidence !== "number" || !Number.isFinite(f.confidence) || f.confidence < 0 || f.confidence > 1) return `${at} confidence must be 0 to 1`;
    if (typeof f.recommendation !== "string") return `${at} needs a recommendation`;
    if (f.decision !== undefined && !DECISIONS.includes(f.decision)) return `${at} decision must be AGREE, CHANGE or REJECT`;
  }
  if (!Array.isArray(out.next_steps) || !out.next_steps.every(nonempty)) return "review next_steps must be non-empty strings";
  return null;
}
