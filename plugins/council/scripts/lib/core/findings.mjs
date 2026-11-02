// Identified findings ledger (S2.5), ported from claude_plugin_for_codex 0.5.0 lib/review-findings.mjs `reconcileFindings`,
// with the A5.2 shape: critical/high are blockers (medium major, low minor), findings are matched by `file:line_start`,
// and the ledger survives a failed turn unchanged (publication is atomic with coverage in lifecycle/review).
export const SEVERITY_RANK = { critical: "BLOCKER", high: "BLOCKER", medium: "MAJOR", low: "MINOR" };
export const location = (finding) => `${finding.file}:${finding.line_start}`;
const isBlocking = (item) => item.decision !== "REJECT" && ["critical", "high"].includes(item.severity);

/**
 * Keep unmentioned findings, and resolve only an identified finding on a successful response. `state.active[0]` scopes
 * new ids to the batch (`u1-F1`); a decision on a known id updates it; a decision on an unknown short id resolves to a
 * ledger entry whose id ends with `-<id>` at the same location when exactly one matches.
 */
export function reconcileFindings(state, output, jobId) {
  const ledger = new Map((state.findingsLedger || []).map((item) => [item.id, item]));
  const scope = state.active?.[0];
  const findings = output.findings.map((finding) => {
    let id = finding.id;
    if (!ledger.has(id) && finding.decision) {
      const matches = [...ledger.values()].filter((item) => item.id.endsWith(`-${id}`) && item.location === location(finding));
      if (matches.length === 1) id = matches[0].id;
    }
    if (state.synthesisRequired) {
      const explicitUpdate = ledger.has(id) && finding.decision;
      if (scope && scope !== "synthesis" && !explicitUpdate) {
        if (!id.startsWith(`${scope}-`)) id = `${scope}-${id}`;
      } else if (!ledger.has(id)) {
        id = `${scope || `discussion-${jobId}`}-${id}`;
      }
    }
    ledger.set(id, { id, location: location(finding), severity: finding.severity, decision: finding.decision || "AGREE", title: finding.title });
    return { ...finding, id };
  });
  const findingsLedger = [...ledger.values()];
  const blocking = findingsLedger.some(isBlocking);
  const reportedBlocking = findings.some((item) => isBlocking(ledger.get(item.id)));
  return { state: { ...state, findingsLedger, blocking }, output: { ...output, findings }, reportedBlocking };
}
/** Open blockers and majors of a ledger, for the footer and the prior-findings note. */
export function summarizeFindings(ledger = []) {
  const open = ledger.filter((item) => item.decision !== "REJECT");
  const blocking = open.filter(isBlocking);
  return { open: open.length, blocking: blocking.length, rejected: ledger.length - open.length, ids: blocking.map((item) => item.id) };
}
/** The note a batch 2+ prompt carries about earlier findings, or "" on the first batch. */
export function priorFindingsNote(ledger = []) {
  if (!ledger.length) return "";
  const lines = ledger.map((item) => `- ${item.id} ${SEVERITY_RANK[item.severity] ?? item.severity} ${item.location} ${item.decision}: ${item.title ?? ""}`.trimEnd());
  return `Earlier batches reported these findings; keep their ids, update one only with a decision (AGREE, CHANGE or REJECT) and new evidence, never repeat an unchanged one:\n${lines.join("\n")}`;
}
