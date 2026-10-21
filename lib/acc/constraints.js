// ============================================================================
// lib/acc/constraints.js  (Ed 2026-10-20)
// ----------------------------------------------------------------------------
// MEASURABLE GOVERNING-DOCUMENT RESTRICTIONS AS CONSTRAINTS WITH AN ALLOWABLE
// RANGE, and a deterministic comparison layer. No community-specific logic.
//
// Why: Annie read Waterview's "shall be eighteen feet (18') in width" as a
// MINIMUM, so a 25 or 30 ft driveway could look compliant. The fix is not a
// better prompt. A restriction becomes data:
//
//   { subject, measurement, unit, min: {value, inclusive} | null,
//     max: {value, inclusive} | null, mandatory, conditions[], exceptions[],
//     tolerance | null, source {document, section, page, quote, ...},
//     ambiguities[] }
//
// and code (not a model) compares a proposal to it.
//   "Shall be 18 feet"        min 18 max 18 (exact)
//   "Must be 18 feet"         min 18 max 18 (exact)
//   "At least 18 feet"        min 18, no max
//   "Not more than 18 feet"   no min, max 18
//   "Between 16 and 18 feet"  min 16 max 18 (inclusivity unstated -> flagged)
// "Shall" / "must" make a clause mandatory; they never decide exact vs minimum
// vs maximum. The whole clause does.
//
// Rules this layer enforces:
//   - No implied tolerance. Only a tolerance the documents state is applied.
//   - Exceeding an exact value is not compliance (30 ft against 18 ft fails).
//   - A proposal outside the range is NON-COMPLIANT; deviation authority is
//     evaluated separately and never widens the range. An authorized deviation
//     is reported as exactly that: non-compliant, deviation authorized.
//   - A missing fact needed to know whether a rule applies, or to compare, is
//     "needs_fact", never assumed.
//   - Conflicting provisions are reported with both sources; one wins only
//     when the documents themselves establish precedence (supersession).
//
// The model's job (engine, separate step) is to find the clauses and quote
// them; parseClause() turns a quote into constraints deterministically, and a
// model-proposed constraint is accepted only if it matches what the quote says.
// ============================================================================

// ---- numbers and units -------------------------------------------------------
const WORDS = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100 };
const FRACTIONS = { '½': 0.5, '¼': 0.25, '¾': 0.75 };
const UNIT_ALIASES = [
  [/^(?:feet|foot|ft\.?|'|’)$/i, 'ft'],
  [/^(?:inches|inch|in\.?|"|”)$/i, 'in'],
  [/^(?:percent|per\s*cent|%)$/i, 'pct'],
  [/^(?:square\s+feet|square\s+foot|sq\.?\s*ft\.?|sf)$/i, 'sqft'],
  [/^(?:stories|story)$/i, 'stories'],
  [/^(?:days?)$/i, 'days'],
];
const TO_BASE = { ft: ['ft', 1], in: ['ft', 1 / 12], pct: ['pct', 1], sqft: ['sqft', 1], stories: ['stories', 1], days: ['days', 1] };
function normUnit(u) {
  const s = String(u || '').trim();
  for (const [re, n] of UNIT_ALIASES) if (re.test(s)) return n;
  return null;
}
function toBase(value, unit) {
  const t = TO_BASE[unit];
  return t ? { value: value * t[1], unit: t[0] } : { value, unit };
}

// A number, written as digits ("18", "6.5", "16½", "2'6\"") or words with an
// optional parenthetical numeral ("eighteen feet (18')").
const NUM_WORD = Object.keys(WORDS).join('|');
const QUANTITY = new RegExp(
  `(?:(${NUM_WORD})(?:[\\s-]+(${NUM_WORD}))?\\s*(?:\\(\\s*(\\d+(?:\\.\\d+)?)\\s*[½¼¾]?\\s*(?:'|’|"|”|ft|feet|%)?\\s*\\)\\s*)?|(\\d+(?:\\.\\d+)?)\\s*([½¼¾])?)` +
  `\\s*(feet|foot|ft\\.?|inches|inch|in\\.?|percent|per\\s*cent|%|square\\s+feet|sq\\.?\\s*ft\\.?|stories|story|days?|'|’|"|”)`, 'i');
function readQuantity(text) {
  const m = String(text || '').match(QUANTITY);
  if (!m) return null;
  let value;
  if (m[3]) value = parseFloat(m[3]);                                   // parenthetical numeral wins
  else if (m[1]) value = (WORDS[m[1].toLowerCase()] || 0) + (m[2] ? WORDS[m[2].toLowerCase()] : 0);
  else value = parseFloat(m[4]) + (m[5] ? FRACTIONS[m[5]] : 0);
  // 2'6" (feet + inches)
  const unit = normUnit(m[6]);
  const after = String(text).slice(m.index + m[0].length);
  const inches = unit === 'ft' && after.match(/^\s*(\d+(?:\.\d+)?)\s*(?:"|”|in\b)/);
  if (inches) value += parseFloat(inches[1]) / 12;
  return { value, unit, index: m.index, length: m[0].length + (inches ? inches[0].length : 0), text: m[0] };
}
function readQuantities(text) {
  const out = []; let rest = String(text || ''); let offset = 0;
  for (;;) {
    const q = readQuantity(rest);
    if (!q) break;
    out.push({ ...q, index: q.index + offset });
    rest = rest.slice(q.index + q.length); offset += q.index + q.length;
  }
  return out;
}

// ---- the bound a clause expresses -----------------------------------------
// Ordered: the first matching qualifier immediately before the quantity decides.
// NEGATED forms come first: "not more than" ends in "more than", and reading it
// as "more than" turns a maximum into a minimum (caught 2026-10-20). The plain
// comparatives also refuse a preceding not/no.
const QUALIFIERS = [
  { re: /\b(?:between)\s*$/i, kind: 'between' },
  { re: /\b(?:not\s+more\s+than|no\s+more\s+than|a\s+maximum\s+of|maximum\s+of|maximum|not\s+to\s+exceed|shall\s+not\s+exceed|must\s+not\s+exceed|may\s+not\s+exceed|not\s+exceed(?:ing)?|no\s+greater\s+than|not\s+greater\s+than|up\s+to|no\s+(?:taller|higher|wider|longer|larger)\s+than|not\s+(?:taller|higher|wider|longer|larger)\s+than)\s*$/i, kind: 'max', inclusive: true },
  { re: /\b(?:at\s+least|a\s+minimum\s+of|minimum\s+of|minimum|not\s+less\s+than|no\s+less\s+than|no\s+fewer\s+than|not\s+fewer\s+than|no\s+closer\s+than|not\s+closer\s+than|no\s+nearer\s+than|not\s+nearer\s+than)\s*$/i, kind: 'min', inclusive: true },
  { re: /(?<!\b(?:not|no)\s+)\b(?:more\s+than|greater\s+than|in\s+excess\s+of|over)\s*$/i, kind: 'min', inclusive: false },
  { re: /(?<!\b(?:not|no)\s+)\b(?:less\s+than|fewer\s+than|under|below)\s*$/i, kind: 'max', inclusive: false },
];
// After the quantity: "... or more" / "... or less".
const TRAILING = [
  { re: /^\s*(?:or\s+more|or\s+greater|and\s+(?:over|above|larger|greater|more))\b/i, kind: 'min', inclusive: true },
  { re: /^\s*(?:or\s+less|or\s+fewer|or\s+smaller|and\s+(?:under|below|smaller|less))\b/i, kind: 'max', inclusive: true },
];
const MANDATORY = /\b(?:shall|must|is\s+required|are\s+required|required\s+to|will\s+be|are\s+to\s+be|is\s+to\s+be)\b/i;
const ADVISORY = /\b(?:should|encouraged|recommended|preferably|discouraged)\b/i;
const PROHIBITIVE = /\b(?:shall\s+not|must\s+not|may\s+not|no\b[^.]{0,40}\bshall|prohibited|not\s+permitted)\b/i;

function boundFor(clause, q) {
  const before = clause.slice(0, q.index);
  const after = clause.slice(q.index + q.length);
  for (const t of TRAILING) if (t.re.test(after)) return { kind: t.kind, inclusive: t.inclusive };
  const lead = before.slice(-60);
  for (const Q of QUALIFIERS) if (Q.re.test(lead)) return { kind: Q.kind, inclusive: Q.inclusive };
  return { kind: 'exact', inclusive: true };
}

// ---- conditions ("for lots greater than fifty-five feet (55') wide") --------
// A condition is { fact, op, value, unit }. The fact name comes from the
// caller's subject map so the parser stays community- and subject-neutral.
function parseConditionText(text, factFor) {
  const t = String(text || '');
  const q = readQuantity(t);
  if (!q) return null;
  const before = t.slice(0, q.index); const after = t.slice(q.index + q.length);
  let op = null;
  if (/\b(?:greater\s+than|more\s+than|over|wider\s+than|larger\s+than|exceeding)\s*$/i.test(before)) op = 'gt';
  else if (/\b(?:less\s+than|under|narrower\s+than|smaller\s+than|below)\s*$/i.test(before)) op = 'lt';
  else if (/\b(?:at\s+least|or\s+more|not\s+less\s+than)\s*$/i.test(before)) op = 'gte';
  else if (/\b(?:not\s+more\s+than|no\s+more\s+than|up\s+to)\s*$/i.test(before)) op = 'lte';
  if (!op && /^\s*(?:\w+\s+){0,2}(?:and|or)\s+(?:smaller|less|narrower|under)\b/i.test(after)) op = 'lte';
  if (!op && /^\s*(?:\w+\s+){0,2}(?:and|or)\s+(?:larger|greater|more|wider|over)\b/i.test(after)) op = 'gte';
  if (!op) return null;
  const fact = factFor ? factFor(t) : null;
  if (!fact) return null;
  const b = toBase(q.value, q.unit);
  return { fact, op, value: b.value, unit: b.unit, text: t.trim() };
}

// Parse one quoted clause into constraints. opts:
//   subject, measurement      what is measured (e.g. 'driveway', 'width')
//   factFor(text) -> fact     maps condition wording to a fact name
//   conditions[]              conditions that apply to the whole clause (e.g. garage type)
//   source {document, section, page, quote, ...}
// Returns { ok, constraints[], ambiguities[], reason? }.
function parseClause(quote, opts = {}) {
  const clause = String(quote || '').replace(/\s+/g, ' ').trim();
  const qs = readQuantities(clause);
  if (!qs.length) return { ok: false, constraints: [], ambiguities: [], reason: 'no measurable quantity in the clause' };
  const mandatory = MANDATORY.test(clause) || PROHIBITIVE.test(clause);
  const advisory = !mandatory && ADVISORY.test(clause);
  const base = { subject: opts.subject || null, measurement: opts.measurement || null, mandatory: mandatory || !advisory ? mandatory : false,
    advisory, conditions: (opts.conditions || []).slice(), exceptions: [], tolerance: null, source: { ...(opts.source || {}), quote: clause } };
  const out = []; const ambiguities = [];

  // "between N and M"
  const between = clause.match(/\bbetween\s+(.+?)\s+and\s+(.+?)(?=[,.;]|$)/i);
  if (between) {
    const a = readQuantity(between[1] + (readQuantity(between[1]) ? '' : ' ' + (readQuantity(between[2]) || {}).text)); const b = readQuantity(between[2]);
    if (a && b) {
      const lo = toBase(a.value, a.unit || b.unit); const hi = toBase(b.value, b.unit);
      const inclusiveStated = /\binclusive\b/i.test(clause); const exclusiveStated = /\bexclusive\b/i.test(clause);
      const inc = exclusiveStated ? false : true;
      if (!inclusiveStated && !exclusiveStated) ambiguities.push('between_inclusivity_unstated');
      out.push({ ...base, unit: hi.unit, min: { value: Math.min(lo.value, hi.value), inclusive: inc }, max: { value: Math.max(lo.value, hi.value), inclusive: inc },
        ambiguities: inclusiveStated || exclusiveStated ? [] : ['between_inclusivity_unstated'] });
      return { ok: true, constraints: out, ambiguities };
    }
  }

  // Segments: "X ... for <condition> and Y ... for <condition>"
  const forSplit = clause.split(/\band\s+(?=(?:\w+\s+){0,6}?\(?\d|\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty)\b)/i);
  const segments = forSplit.length > 1 ? forSplit : [clause];
  for (const seg of segments) {
    const forIdx = seg.search(/\bfor\s+(?:lots?|homes?|residences?|structures?|properties|parcels?)\b/i);
    const valuePart = forIdx >= 0 ? seg.slice(0, forIdx) : seg;
    const condPart = forIdx >= 0 ? seg.slice(forIdx) : '';
    const q = readQuantity(valuePart);
    if (!q) continue;
    const bound = boundFor(valuePart, q);
    const b = toBase(q.value, q.unit);
    const c = { ...base, conditions: base.conditions.slice(), unit: b.unit, min: null, max: null, ambiguities: [] };
    if (bound.kind === 'exact') { c.min = { value: b.value, inclusive: true }; c.max = { value: b.value, inclusive: true }; }
    else if (bound.kind === 'min') c.min = { value: b.value, inclusive: bound.inclusive };
    else if (bound.kind === 'max') c.max = { value: b.value, inclusive: bound.inclusive };
    // "shall not be more than" style negation on a min-qualifier flips it.
    if (bound.kind === 'min' && /\b(?:shall|must|may)\s+not\s+be\s*$/i.test(valuePart.slice(0, q.index).replace(/\b(?:more|greater)\s+than\s*$/i, ''))) {
      c.max = { value: b.value, inclusive: true }; c.min = null;
    }
    if (condPart) {
      const cond = parseConditionText(condPart, opts.factFor);
      if (cond) c.conditions.push(cond);
      else { c.ambiguities.push('condition_not_understood'); ambiguities.push(`condition not understood: "${condPart.trim()}"`); }
    }
    out.push(c);
  }
  if (!out.length) return { ok: false, constraints: [], ambiguities, reason: 'quantity found but no bound could be read' };
  return { ok: true, constraints: out, ambiguities };
}

// A model-proposed constraint is accepted only when it matches the quote.
function verifyAgainstQuote(proposed, opts = {}) {
  const parsed = parseClause(proposed && proposed.source && proposed.source.quote, opts);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };
  const same = (a, b) => (a == null && b == null) || (a && b && Math.abs(a.value - b.value) < 1e-9 && !!a.inclusive === !!b.inclusive);
  const match = parsed.constraints.find((c) => same(c.min, proposed.min) && same(c.max, proposed.max));
  return match ? { ok: true } : { ok: false, reason: 'the proposed range does not match what the quoted language says', parsed: parsed.constraints.map((c) => ({ min: c.min, max: c.max, conditions: c.conditions })) };
}

// ---- comparison ----------------------------------------------------------------
function testCondition(cond, facts) {
  const f = facts[cond.fact];
  if (f == null || (typeof f === 'object' && f.value == null)) return { known: false };
  const v = typeof f === 'object' ? f.value : f;
  if (cond.op === 'eq') return { known: true, ok: v === cond.value };
  if (cond.op === 'in') return { known: true, ok: (cond.value || []).includes(v) };
  const n = Number(v);
  return { known: true, ok: { gt: n > cond.value, gte: n >= cond.value, lt: n < cond.value, lte: n <= cond.value }[cond.op] };
}

// Evaluate one constraint against facts. facts: { [fact]: value | {value, unit, source} }
// opts.valueFact: the fact holding the proposed measurement.
// Results: not_applicable | needs_fact | exception_applies | complies |
//          does_not_comply (with direction) | ambiguous | advisory_not_met
function evaluate(constraint, facts = {}, opts = {}) {
  const res = { constraint, result: null, direction: null, missing: [], detail: null };
  for (const cond of constraint.conditions || []) {
    const t = testCondition(cond, facts);
    if (!t.known) res.missing.push(cond.fact);
    else if (!t.ok) { res.result = 'not_applicable'; res.detail = `condition not met: ${cond.text || cond.fact}`; return res; }
  }
  if (res.missing.length) { res.result = 'needs_fact'; res.detail = 'whether this rule applies depends on: ' + res.missing.join(', '); return res; }
  for (const ex of constraint.exceptions || []) {
    if ((ex.conditions || []).every((c) => { const t = testCondition(c, facts); return t.known && t.ok; })) { res.result = 'exception_applies'; res.detail = ex.note || 'a stated exception applies'; return res; }
  }
  const pf = facts[opts.valueFact];
  if (pf == null || (typeof pf === 'object' && pf.value == null)) { res.result = 'needs_fact'; res.missing.push(opts.valueFact); res.detail = 'the proposed measurement is not established'; return res; }
  const raw = typeof pf === 'object' ? pf : { value: pf, unit: constraint.unit };
  const v = toBase(Number(raw.value), normUnit(raw.unit) || raw.unit || constraint.unit);
  if (v.unit !== constraint.unit) { res.result = 'needs_fact'; res.detail = `units do not match (${v.unit} vs ${constraint.unit})`; return res; }
  // Only a tolerance the documents state.
  const tol = constraint.tolerance && constraint.tolerance.source ? toBase(constraint.tolerance.value, constraint.tolerance.unit || constraint.unit).value : 0;
  const lo = constraint.min; const hi = constraint.max;
  const below = lo && (lo.inclusive ? v.value < lo.value - tol : v.value <= lo.value - tol);
  const above = hi && (hi.inclusive ? v.value > hi.value + tol : v.value >= hi.value + tol);
  const exact = lo && hi && lo.value === hi.value;
  if (below || above) {
    res.direction = exact ? (above ? 'exceeds_required_value' : 'below_required_value') : (above ? 'exceeds_maximum' : 'below_minimum');
    res.result = constraint.mandatory === false && constraint.advisory ? 'advisory_not_met' : 'does_not_comply';
    res.detail = `${v.value} ${v.unit} vs allowed ${lo ? (lo.inclusive ? '>=' : '>') + lo.value : '(no minimum)'} and ${hi ? (hi.inclusive ? '<=' : '<') + hi.value : '(no maximum)'} ${constraint.unit}${tol ? ` (stated tolerance ${tol})` : ''}`;
    return res;
  }
  const onBoundary = (lo && v.value === lo.value) || (hi && v.value === hi.value);
  if (onBoundary && (constraint.ambiguities || []).includes('between_inclusivity_unstated')) { res.result = 'ambiguous'; res.detail = 'the measurement is on a boundary whose inclusivity the document does not state'; return res; }
  res.result = 'complies';
  return res;
}

// ---- conflicts ---------------------------------------------------------------
// Two constraints conflict when they measure the same thing, can both apply to
// the same case (no condition on the same fact that excludes the other), and
// allow different ranges.
function rangesEqual(a, b) {
  const eq = (x, y) => (x == null && y == null) || (x && y && x.value === y.value && !!x.inclusive === !!y.inclusive);
  return eq(a.min, b.min) && eq(a.max, b.max);
}
function conditionsExclusive(a, b) {
  for (const ca of a.conditions || []) for (const cb of b.conditions || []) {
    if (ca.fact !== cb.fact) continue;
    const sat = (c, v) => ({ gt: v > c.value, gte: v >= c.value, lt: v < c.value, lte: v <= c.value, eq: v === c.value })[c.op];
    if (typeof ca.value !== 'number' || typeof cb.value !== 'number') { if (ca.op === 'eq' && cb.op === 'eq' && ca.value !== cb.value) return true; continue; }
    const probes = [ca.value, cb.value, ca.value - 0.5, ca.value + 0.5, cb.value - 0.5, cb.value + 0.5];
    if (!probes.some((v) => sat(ca, v) && sat(cb, v))) return true;
  }
  return false;
}
function detectConflicts(constraints = []) {
  const out = [];
  for (let i = 0; i < constraints.length; i++) for (let j = i + 1; j < constraints.length; j++) {
    const a = constraints[i]; const b = constraints[j];
    if (a.subject !== b.subject || a.measurement !== b.measurement || a.unit !== b.unit) continue;
    if (conditionsExclusive(a, b) || rangesEqual(a, b)) continue;
    out.push({ a, b, detail: `${a.source.document || 'document'} ${a.source.section || ''} and ${b.source.document || 'document'} ${b.source.section || ''} set different ranges for ${a.subject} ${a.measurement} where both can apply` });
  }
  return out;
}
// Resolve a conflict ONLY on precedence the documents establish
// (source.superseded_by / source.supersedes, by document id). Otherwise it stays
// unresolved and must go to a person.
function resolveConflict(conflict) {
  const { a, b } = conflict;
  if (a.source.superseded_by && a.source.superseded_by === b.source.document_id) return { resolved: true, controlling: b, basis: `${a.source.document} is superseded by ${b.source.document}` };
  if (b.source.superseded_by && b.source.superseded_by === a.source.document_id) return { resolved: true, controlling: a, basis: `${b.source.document} is superseded by ${a.source.document}` };
  return { resolved: false, basis: 'no documented precedence between these provisions; a person must decide which controls' };
}

// ---- deviations ----------------------------------------------------------------
// authorities: [{ covers: [measurement|subject...], source, requires: 'written_instrument'|... }]
// authorization: { constraint_ref?, deviation_granted, deviation_statement, body, decided_on, evidence_reference }
function evaluateDeviation(result, authorities = [], authorization = null) {
  if (result.result !== 'does_not_comply') return { needed: false };
  const c = result.constraint;
  const authority = authorities.find((a) => (a.covers || []).some((k) => k === c.measurement || k === c.subject || k === 'size' || k === 'location'));
  if (!authority) return { needed: true, available: false, outcome: 'not_permitted_as_submitted', detail: 'outside the allowable range and no deviation authority covers it' };
  const granted = authorization && authorization.deviation_granted === true && String(authorization.deviation_statement || '').trim().length >= 10
    && authorization.evidence_reference && authorization.decided_on;
  return granted
    ? { needed: true, available: true, outcome: 'deviation_authorized', authority, authorization, detail: 'non-compliant; a documented deviation authorizes it (the allowable range is unchanged)' }
    : { needed: true, available: true, outcome: 'deviation_required', authority, detail: 'non-compliant; only a documented deviation under the cited authority could permit it' };
}

// ---- the dimensional assessment the evaluation uses --------------------------
// checks: [{ constraint, valueFact }]. Returns per-check results and a summary
// that never says "compliant" while anything is unresolved.
function assess(checks = [], facts = {}, { deviationAuthorities = [], authorization = null } = {}) {
  const constraints = checks.map((c) => c.constraint);
  const conflicts = detectConflicts(constraints).map((cf) => ({ ...cf, resolution: resolveConflict(cf) }));
  const results = checks.map((c) => {
    const r = evaluate(c.constraint, facts, { valueFact: c.valueFact });
    r.deviation = evaluateDeviation(r, deviationAuthorities, authorization);
    return r;
  });
  const unresolved = conflicts.filter((c) => !c.resolution.resolved);
  const statuses = results.map((r) => r.result);
  let summary = 'compliant';
  if (unresolved.length) summary = 'conflicting_provisions';
  else if (statuses.includes('needs_fact')) summary = 'needs_facts';
  else if (statuses.includes('ambiguous')) summary = 'ambiguous';
  else if (results.some((r) => r.result === 'does_not_comply')) {
    const devs = results.filter((r) => r.result === 'does_not_comply').map((r) => r.deviation.outcome);
    summary = devs.every((d) => d === 'deviation_authorized') ? 'noncompliant_deviation_authorized'
      : devs.includes('not_permitted_as_submitted') ? 'noncompliant_not_permitted' : 'noncompliant_deviation_required';
  } else if (statuses.includes('advisory_not_met')) summary = 'advisory_judgment_required';
  return { summary, may_recommend_approval: summary === 'compliant', results, conflicts };
}

module.exports = { parseClause, readQuantity, readQuantities, parseConditionText, verifyAgainstQuote, evaluate, detectConflicts, resolveConflict, evaluateDeviation, assess, toBase, normUnit };
