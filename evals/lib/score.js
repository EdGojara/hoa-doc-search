// evals/lib/score.js — deterministic rubric scoring, severity-weighted.
// ---------------------------------------------------------------------------
// A rubric is a list of weighted, SEVERITY-TAGGED checks run against the model's
// output TEXT. Two things come out:
//   1. score  — weighted fraction of checks passed (the old number).
//   2. gate   — the answer to the question that actually matters for autonomous
//               management: "would I let trustEd EXECUTE this workflow on its
//               own?" Driven by the WORST failed check's severity, not the
//               average — because getting the reconciled cash balance wrong and
//               missing an adjective in a summary are not both "an 8-point miss."
//
// Severity classes (low -> high): informational, operational, financial,
// compliance, catastrophic. Gate policy on the worst FAILED check:
//   catastrophic | compliance -> BLOCK   (never autonomous; human required)
//   financial                 -> REVIEW  (a human signs off before executing)
//   operational | informational (or none failed) -> EXECUTE
//
// Programmatic grading (not an LLM judge) so the score is reproducible and free.
// Check types: number {value,tolerance?}, regex {pattern,flags?}, absent {pattern,flags?}.
// Each check: { id, weight?, sev?, desc, type, ... }  (sev defaults 'operational').

const SEVERITY_RANK = { informational: 1, operational: 2, financial: 3, compliance: 4, catastrophic: 5 };

function _hasNumber(text, value, tolerance) {
  const tol = tolerance || 0;
  const nums = (text.match(/\$?\s?-?[\d,]+(?:\.\d+)?/g) || [])
    .map((s) => parseFloat(s.replace(/[$,\s]/g, '')))
    .filter((n) => !Number.isNaN(n));
  return nums.some((n) => Math.abs(n - value) <= tol);
}

function _checkOk(body, c) {
  if (c.type === 'number') return _hasNumber(body, c.value, c.tolerance);
  if (c.type === 'regex') return new RegExp(c.pattern, c.flags || 'i').test(body);
  if (c.type === 'absent') return !new RegExp(c.pattern, c.flags || 'i').test(body);
  return false;
}

// Worst failed severity -> execution verdict.
function _gate(failedSeverities) {
  if (!failedSeverities.length) return { verdict: 'EXECUTE', worst: null };
  const worst = failedSeverities.reduce((a, b) => (SEVERITY_RANK[b] > SEVERITY_RANK[a] ? b : a));
  let verdict;
  if (worst === 'catastrophic' || worst === 'compliance') verdict = 'BLOCK';
  else if (worst === 'financial') verdict = 'REVIEW';
  else verdict = 'EXECUTE';
  return { verdict, worst };
}

function scoreOutput(text, rubric) {
  const body = String(text || '');
  const results = [];
  let earned = 0, max = 0;
  const failedSeverities = [];
  const bySeverity = {};
  for (const c of rubric) {
    const w = c.weight == null ? 1 : c.weight;
    const sev = c.sev || 'operational';
    max += w;
    const ok = _checkOk(body, c);
    if (ok) earned += w;
    else { failedSeverities.push(sev); bySeverity[sev] = (bySeverity[sev] || 0) + 1; }
    results.push({ id: c.id, ok, desc: c.desc, weight: w, sev });
  }
  const gate = _gate(failedSeverities);
  return { score: max ? earned / max : 0, max, earned, results, gate: gate.verdict, worst_fail: gate.worst, failed_by_severity: bySeverity };
}

module.exports = { scoreOutput, SEVERITY_RANK };
