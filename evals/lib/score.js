// evals/lib/score.js — deterministic rubric scoring.
// A rubric is a list of weighted checks run against the model's output TEXT.
// Programmatic grading (not an LLM judge) so the score is reproducible and free
// — the right call for a first case whose ground truth is factual (numbers,
// insurance pass/fail, a named scope gap). Check types:
//   number  { value, tolerance? }  — the output states this number (tolerant of
//                                     $, commas, and +/- tolerance)
//   regex   { pattern, flags? }     — a required finding is present
//   absent  { pattern, flags? }     — something must NOT appear (e.g. a
//                                     fabricated single recommendation)
// Each check: { id, weight, desc, type, ... }. Returns { score (0..1), max,
// earned, results:[{id, ok, desc}] }.

function _hasNumber(text, value, tolerance) {
  const tol = tolerance || 0;
  // Pull every number-like token (with optional $ and thousands commas) and
  // compare numerically, so "$69,600" / "69600" / "69,600.00" all match.
  const nums = (text.match(/\$?\s?-?[\d,]+(?:\.\d+)?/g) || [])
    .map((s) => parseFloat(s.replace(/[$,\s]/g, '')))
    .filter((n) => !Number.isNaN(n));
  return nums.some((n) => Math.abs(n - value) <= tol);
}

function scoreOutput(text, rubric) {
  const body = String(text || '');
  const results = [];
  let earned = 0, max = 0;
  for (const c of rubric) {
    const w = c.weight == null ? 1 : c.weight;
    max += w;
    let ok = false;
    if (c.type === 'number') ok = _hasNumber(body, c.value, c.tolerance);
    else if (c.type === 'regex') ok = new RegExp(c.pattern, c.flags || 'i').test(body);
    else if (c.type === 'absent') ok = !new RegExp(c.pattern, c.flags || 'i').test(body);
    if (ok) earned += w;
    results.push({ id: c.id, ok, desc: c.desc, weight: w });
  }
  return { score: max ? earned / max : 0, max, earned, results };
}

module.exports = { scoreOutput };
