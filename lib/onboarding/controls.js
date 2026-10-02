// ============================================================================
// lib/onboarding/controls.js  (Issue #15) — Stage 2: control / assertion framework
// ----------------------------------------------------------------------------
// A control compares two independently derived amounts and returns a
// machine-readable result: PASS, FAIL or BLOCKED (an input it needs is
// missing). There is deliberately NO way to make a control pass by adding a
// balancing amount: the only knob is an explicit, declared tolerance, which is
// recorded on the result and defaults to zero.
//
// Rule from the issue: a parser mismatch is an extraction defect, not evidence
// the source books are wrong. Adapter-level controls (parsed rows vs the
// report's own printed totals) run first; a FAIL there means "fix the adapter".
// ============================================================================

const STATUS = Object.freeze({ PASS: 'PASS', FAIL: 'FAIL', BLOCKED: 'BLOCKED' });
const LEVEL = Object.freeze({ EXTRACTION: 'extraction', SOURCE: 'source', CROSS: 'cross_source' });

function equals(code, { label, left, right, leftLabel, rightLabel, level = LEVEL.SOURCE, tolerance_cents = 0, tolerance_reason = null, detail = {} }) {
  if (!code || !label) throw new Error('control code and label required');
  if (tolerance_cents !== 0 && !tolerance_reason) throw new Error(`${code}: a non-zero tolerance needs a declared reason`);
  if (left === null || left === undefined || right === null || right === undefined) {
    return blocked(code, { label, level, reason: `missing input: ${left == null ? leftLabel || 'left' : rightLabel || 'right'}`, detail });
  }
  if (!Number.isInteger(left) || !Number.isInteger(right)) throw new Error(`${code}: amounts must be integer cents`);
  const difference = left - right;
  return Object.freeze({
    code, label, level, status: Math.abs(difference) <= tolerance_cents ? STATUS.PASS : STATUS.FAIL,
    left_label: leftLabel || 'left', right_label: rightLabel || 'right',
    left_cents: left, right_cents: right, difference_cents: difference,
    tolerance_cents, tolerance_reason, detail,
  });
}

function blocked(code, { label, level = LEVEL.SOURCE, reason, needs = null, detail = {} }) {
  return Object.freeze({ code, label, level, status: STATUS.BLOCKED, reason, needs, detail });
}

// A boolean assertion (e.g. "every account rolls forward") with failing items listed.
function holds(code, { label, failures = [], level = LEVEL.SOURCE, detail = {} }) {
  return Object.freeze({ code, label, level, status: failures.length ? STATUS.FAIL : STATUS.PASS, failures, detail });
}

function summarize(results) {
  const counts = { PASS: 0, FAIL: 0, BLOCKED: 0 };
  for (const r of results) counts[r.status]++;
  const overall = counts.FAIL ? STATUS.FAIL : counts.BLOCKED ? STATUS.BLOCKED : STATUS.PASS;
  return { overall, counts, total: results.length };
}

module.exports = { STATUS, LEVEL, equals, blocked, holds, summarize };
