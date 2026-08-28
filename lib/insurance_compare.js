// ============================================================================
// lib/insurance_compare.js  (Ed 2026-08-28)
// ----------------------------------------------------------------------------
// Diff two insurance programs (the normalized shape from insurance_extract /
// insurance_rfp.normalizeInsuranceProgram) and surface the findings a good
// community manager reads for. This encodes the judgment applied by hand on the
// Lakes of Pine Forest renewal: a lower premium is not a saving if it was bought
// by cutting coverage, and the single most dangerous cut is a building insured
// below its replacement cost under a coinsurance clause.
//
// The comparator is DELIBERATELY conservative: it reports what it can compute
// from structured fields and never invents. The reliable, structure-independent
// findings (premium delta + attribution, property/coinsurance from the schedule
// of values, standalone dropped lines) do not depend on the two programs being
// packaged the same way. Line-level limit matching is best-effort on top.
//
// Downstream (Amanda's renewal reply, an RFP-back email) renders prose from
// these findings; this module produces the structured facts, so the judgment is
// testable with a fixture and never freestyled. See test_insurance_compare.js.
// ============================================================================

function parseMoney(s) {
  if (s == null) return null;
  if (typeof s === 'number') return s;
  const cleaned = String(s).replace(/[,$\s]/g, '');
  const m = cleaned.match(/^(-?\d+(?:\.\d+)?)(m|k)?$/i);
  if (m) { let n = parseFloat(m[1]); if (m[2]) n *= (m[2].toLowerCase() === 'm' ? 1e6 : 1e3); return n; }
  const n = parseFloat(cleaned.replace(/[^0-9.\-]/g, ''));
  return Number.isNaN(n) ? null : n;
}

function money(n) {
  if (n == null) return 'n/a';
  return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const normLine = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '');
const normLabel = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '');

function sumPremium(coverages) {
  let any = false, total = 0;
  for (const c of coverages || []) {
    const v = parseMoney(c && c.annual_premium);
    if (v != null) { total += v; any = true; }
  }
  return any ? total : null;
}

function detectCoinsurance(program) {
  for (const c of (program.coverages || [])) {
    for (const t of (c.key_terms || [])) {
      const m = String(t).match(/(\d{1,3})\s*%\s*coins/i) || (/coins/i.test(t) ? String(t).match(/(\d{1,3})\s*%/) : null);
      if (m) return parseInt(m[1], 10);
    }
    for (const d of (c.deductibles || [])) {
      if (/coins/i.test((d && d.label) || '')) { const m = String((d.amount || d.label)).match(/(\d{1,3})\s*%/); if (m) return parseInt(m[1], 10); }
    }
  }
  return null;
}

function analyzeProperty(cur, prop) {
  // A schedule of values must carry INSURED VALUES, not rating bases. Real
  // policy-of-record data stores lines like "$0.040 per square foot" or "$1,000
  // per pool (premium basis)" — parseMoney would read those as $0.04/$1,000 and
  // poison the property total and the coinsurance test. Exclude any value that
  // is a rate/basis, so the analysis degrades to "no property finding" rather
  // than a confidently wrong one. (Ed 2026-08-28, caught on live LPF data.)
  const isRatingBasis = (v) => /\bper\b|basis|square\s*foot|per\s*acre|per\s*pool|%/i.test(String(v || ''));
  const sov = (p) => (p.statement_of_values || [])
    .filter((s) => s && !isRatingBasis(s.value))
    .map((s) => ({ desc: (s && s.description) || '', val: parseMoney(s && s.value) }))
    .filter((s) => s.val != null);
  const cs = sov(cur), ps = sov(prop);
  const total = (a) => a.reduce((x, s) => x + s.val, 0);
  const curTotal = cs.length ? total(cs) : null;
  const propTotal = ps.length ? total(ps) : null;
  const building = (a) => {
    const b = a.filter((s) => /building|clubhouse|structure|dwelling|amenit/i.test(s.desc));
    if (b.length) return Math.max(...b.map((s) => s.val));
    return a.length ? Math.max(...a.map((s) => s.val)) : null;
  };
  const curBldg = building(cs), propBldg = building(ps);
  const coinsurance = detectCoinsurance(cur) || detectCoinsurance(prop) || null;

  let coinsuranceExposure = false, coinsuranceDetail = '';
  if (curBldg != null && propBldg != null && coinsurance) {
    const required = (coinsurance / 100) * curBldg;
    if (propBldg < required) {
      coinsuranceExposure = true;
      coinsuranceDetail = `Proposed building limit ${money(propBldg)} is below ${coinsurance}% of the current insured value ${money(curBldg)} (${money(required)} is required to avoid a coinsurance penalty). A partial loss would be paid at roughly ${Math.round((propBldg / required) * 100)} percent after the deductible.`;
    }
  }
  const totalDelta = (curTotal != null && propTotal != null) ? (propTotal - curTotal) : null;
  return { curTotal, propTotal, totalDelta, curBldg, propBldg, coinsurance, coinsuranceExposure, coinsuranceDetail };
}

function compareLimits(c, p) {
  const idx = (cov) => { const m = new Map(); for (const l of (cov.limits || [])) if (l && l.label) m.set(normLabel(l.label), l); return m; };
  const cm = idx(c), pm = idx(p);
  const reductions = [];
  for (const [label, cl] of cm) {
    if (!pm.has(label)) continue;
    const cv = parseMoney(cl.amount), pv = parseMoney(pm.get(label).amount);
    if (cv != null && pv != null && pv < cv) reductions.push({ label: cl.label, current: cl.amount, proposed: pm.get(label).amount });
  }
  return reductions;
}

/**
 * compareInsurancePrograms(current, proposed)
 * Returns { premium, lines, dropped, added, limitReductions, property, findings }.
 * findings: [{ severity:'high'|'medium'|'info', category, title, detail }], most
 * severe first, ready for a renderer to turn into prose.
 */
function compareInsurancePrograms(current, proposed) {
  const cur = current || {}, prop = proposed || {};
  const curCov = cur.coverages || [], propCov = prop.coverages || [];
  const findings = [];

  const curPrem = sumPremium(curCov), propPrem = sumPremium(propCov);
  const premium = {
    current: curPrem, proposed: propPrem,
    delta: (curPrem != null && propPrem != null) ? (propPrem - curPrem) : null,
    pct: (curPrem) ? ((propPrem - curPrem) / curPrem) * 100 : null,
  };

  const byLine = (arr) => { const m = new Map(); for (const c of arr) if (c && c.line) m.set(normLine(c.line), c); return m; };
  const cm = byLine(curCov), pm = byLine(propCov);
  const lines = [], dropped = [], added = [], limitReductions = [];
  for (const [key, c] of cm) {
    const p = pm.get(key);
    if (!p) { dropped.push(c.line); lines.push({ line: c.line, status: 'dropped' }); continue; }
    const reds = compareLimits(c, p);
    if (reds.length) limitReductions.push({ line: c.line, reductions: reds });
    lines.push({ line: c.line, status: 'present', reductions: reds });
  }
  for (const [key, p] of pm) if (!cm.has(key)) { added.push(p.line); lines.push({ line: p.line, status: 'added' }); }

  const property = analyzeProperty(cur, prop);
  const coverageCut = dropped.length > 0 || limitReductions.length > 0 || (property.totalDelta != null && property.totalDelta < 0);

  // Most-severe first. Coinsurance/ITV is the headline when present.
  if (property.coinsuranceExposure) {
    findings.push({ severity: 'high', category: 'coinsurance', title: 'Building insured below replacement cost (coinsurance penalty)', detail: property.coinsuranceDetail });
  }
  if (property.totalDelta != null && property.totalDelta < -1) {
    findings.push({ severity: property.totalDelta < -50000 ? 'high' : 'medium', category: 'property_reduction', title: `Insured property reduced by ${money(-property.totalDelta)}`, detail: `Total insured property is ${money(property.curTotal)} current vs ${money(property.propTotal)} proposed.` });
  }
  for (const d of dropped) {
    findings.push({ severity: 'medium', category: 'dropped_line', title: `${d} not in the proposal`, detail: `The current program carries ${d}; the proposal does not. Confirm it is folded in or add it.` });
  }
  for (const lr of limitReductions) for (const r of lr.reductions) {
    findings.push({ severity: 'medium', category: 'limit_reduction', title: `${lr.line}: ${r.label} reduced`, detail: `${r.label} drops from ${r.current} to ${r.proposed}.` });
  }
  if (premium.delta != null && premium.delta < 0) {
    findings.push({
      severity: coverageCut ? 'high' : 'info', category: 'premium',
      title: `Proposed premium ${money(-premium.delta)} lower (${premium.pct.toFixed(1)}%)`,
      detail: coverageCut
        ? 'The lower premium is bought by reduced coverage, not a like-for-like saving. Re-quote at parity before comparing on price.'
        : 'Lower premium with no coverage reduction detected in the structured fields.',
    });
  } else if (premium.delta != null && premium.delta > 0) {
    findings.push({ severity: 'info', category: 'premium', title: `Proposed premium ${money(premium.delta)} higher (${premium.pct.toFixed(1)}%)`, detail: 'Confirm the added premium buys added coverage.' });
  }

  const order = { high: 0, medium: 1, info: 2 };
  findings.sort((a, b) => order[a.severity] - order[b.severity]);
  return { premium, lines, dropped, added, limitReductions, property, findings };
}

module.exports = { compareInsurancePrograms, parseMoney, analyzeProperty, sumPremium };
