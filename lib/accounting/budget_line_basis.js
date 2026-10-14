// ============================================================================
// lib/accounting/budget_line_basis.js  (Ed 2026-10-14)
// ----------------------------------------------------------------------------
// WHY a budget line's amount is what it is (migration 521 columns on
// budget_line_items): amount_basis, amount_calc, vendor_contract_id,
// source_document_id, needs_review, review_note.
//
// PURE. The basis is read off the working forecast line (lib/forecast/working_forecast.js),
// which already carries the bridge (assumption, evidence, source, confidence) for every
// driver. Nothing here computes an amount: a contract amount is the forecast's, which is
// lib/contracts/contract_terms.js contractCostForYear on the ONE verified contract bound
// to the line (vendor_contracts.forecast_account_id). The budget screen, the draft and the
// proposed-budget print all read the same contract amount from here.
// ============================================================================

const BASES = ['contract', 'historical_forecast', 'board_project', 'discretionary', 'assessment', 'transfer'];
const BASIS_LABEL = { contract: 'Contract', historical_forecast: 'Forecast from history', board_project: 'Board project', discretionary: 'Discretionary', assessment: 'Assessment', transfer: 'Interfund transfer' };
const BASIS_COLUMNS = 'amount_basis, amount_calc, vendor_contract_id, source_document_id, needs_review, review_note';
// PostgREST before migration 521: the columns do not exist yet.
const MISSING_COLUMN = /amount_basis|amount_calc|vendor_contract_id|source_document_id|needs_review|review_note|does not exist|schema cache/i;
// Words that say an amount is not settled: an estimate, a notice or quote not yet received,
// a provisional amount, a pending decision. Read from the assumption / reason the person wrote.
const UNSETTLED = /\bestimated?\b|\bestimates?\b|not yet (?:quoted|received|arrived|issued|known)|has not (?:arrived|been (?:quoted|received|issued))|\bpending\b|\bprovisional\b|needs? (?:a )?board decision|to be confirmed|\bunverified\b/i;
const ASSESSMENT_NAME = /assessment|dues|maintenance fee/i;   // the planner's own rule (public/accounting.html)

const int = (n) => Math.round(Number(n) || 0);
const fmt = (c) => { const n = int(c) / 100; const t = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); return n < 0 ? `($${t})` : `$${t}`; };
const clip = (s, n = 900) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const uniq = (a) => [...new Set(a.filter(Boolean))];
const empty = () => ({ amount_basis: null, amount_calc: null, vendor_contract_id: null, source_document_id: null, needs_review: false, review_note: null });

const isReserveExpense = (l) => l.account_type === 'expense' && l.fund_type === 'reserve' && !l.transfer;
const isAssessment = (l) => l.account_type === 'revenue' && !l.transfer && ASSESSMENT_NAME.test(l.account_name || '');

// The contract driver of a forecast line, in the shape the budget screen uses.
//   applied            a verified contract prices the line: proposed = the forecast's amount
//   needs_verification a contract is on file but not verified: never applied, shown with its would-be cost
//   needs_review       a verified contract is bound but cannot price the year (or several are bound)
function contractFromForecastLine(l) {
  const it = ((l && l.bridge) || []).find((i) => i.driver === 'contract' && ['applied', 'needs_verification', 'needs_review'].includes(i.status) && i.source === 'contract');
  if (!it) return null;
  const ev = it.evidence || {};
  const c = ev.contract || (ev.contracts || [])[0] || null;
  const doc = (c && c.document) || {};
  return {
    status: it.status,
    vendor: (c && c.vendor) || null,
    vendor_contract_id: (c && c.vendor_contract_id) || null,
    source_document_id: doc.source_document_id || null,
    file_path: doc.file_path || null,
    // applied: the forecast's model amount (contract months at the contract price, any
    // months the contract does not cover from the base year); never a renewal guess.
    proposed_cents: it.status === 'applied' ? int(l.recommendation_cents) : null,
    contract_cost_cents: it.status === 'applied' ? int(ev.contract_cost_cents) : (ev.would_be_cost_cents == null ? null : int(ev.would_be_cost_cents)),
    covered_months: Array.isArray(ev.months) ? ev.months.filter((m) => m != null).length : null,
    steps: ev.calculation || [],
    assumption: it.assumption || null,
    note: it.note || null,
    issues: (ev.issues || []).map((x) => x.text),
  };
}

/**
 * The basis of a working-forecast line's FINAL amount (override included).
 * l: a line from buildWorkingForecast(...).lines; ctx: { base_year }.
 */
function basisFromForecastLine(l, ctx = {}) {
  const by = ctx.base_year || null;
  const out = empty();
  const reviews = [];
  const ovr = l.override || null;
  const items = l.bridge || [];
  const applied = items.filter((i) => i.status === 'applied' && int(i.amount_cents) !== 0);
  const c = contractFromForecastLine(l);
  const setBy = ovr ? `Set at ${fmt(ovr.amount_cents)} by ${ovr.actor || 'management'}: ${ovr.reason || 'no reason recorded'}${ovr.amount_cents !== int(l.recommendation_cents) ? ` (model ${fmt(l.recommendation_cents)})` : ''}` : null;
  const drivers = applied.map((i) => i.assumption || `${i.label} ${fmt(i.amount_cents)}`);

  if (l.transfer) {
    const t = l.transfer;
    out.amount_basis = 'transfer';
    out.amount_calc = setBy || `${t.from_fund_code} -> ${t.to_fund_code} ${fmt(Math.abs(int(l.final_cents)))}: the ${by || 'prior-year'} approved transfer, carried forward unchanged.`;
    if (t.status === 'needs_board_decision') reviews.push((l.flags || []).find((f) => f.code === 'transfer_provisional')?.text || 'Provisional funding assumption: needs board decision.');
  } else if (isReserveExpense(l)) {
    out.amount_basis = 'board_project';
    out.amount_calc = 'Planned capital projects for this account (Reserve Budget); prior-year reserve spending is never carried forward.';
  } else if (isAssessment(l)) {
    out.amount_basis = 'assessment';
    out.amount_calc = setBy || [l.base && l.base.note, ...drivers].filter(Boolean).join(' ');
  } else if (c && c.status === 'applied' && (!ovr || ovr.amount_cents === int(l.recommendation_cents))) {
    out.amount_basis = 'contract';
    out.vendor_contract_id = c.vendor_contract_id;
    out.source_document_id = c.source_document_id;
    const rest = c.covered_months != null && c.covered_months < 12 ? ` Other ${12 - c.covered_months} month(s): the ${by || 'prior-year'} base${applied.some((i) => i.driver === 'rate') ? ` + ${applied.find((i) => i.driver === 'rate').assumption}` : ''}.` : '';
    out.amount_calc = `${c.vendor || 'Contract'}: ${c.steps.join('; ')}.${rest}${setBy ? ` ${setBy}` : ''}`;
    if (c.issues.length) reviews.push(...c.issues);
  } else {
    out.amount_basis = 'historical_forecast';
    out.amount_calc = setBy || [l.base && l.base.note, ...drivers].filter(Boolean).join(' + ');
  }

  // needs_review: an unverified contract, an estimate or pending notice, or unresolved evidence.
  if (c && c.status === 'needs_verification') reviews.push(c.note || `${c.vendor || 'A contract'} is on file but not verified.`);
  if (c && c.status === 'needs_review') reviews.push(c.note || 'The bound contract cannot price the year.');
  if (ovr) {
    if (UNSETTLED.test(ovr.reason || '')) reviews.push(`Unsettled: ${clip(ovr.reason, 300)}`);
  } else if (!l.transfer && !isReserveExpense(l)) {
    for (const i of items) if (['needs_review', 'needs_evidence'].includes(i.status) && i.driver !== 'rate') reviews.push(i.note || `${i.label}: needs review.`);
    for (const f of l.flags || []) if (['no_post_cutover_activity', 'unbudgeted', 'normalization_needs_review'].includes(f.code)) reviews.push(f.text);
    for (const i of applied) if (UNSETTLED.test(`${i.assumption || ''} ${typeof i.evidence === 'string' ? i.evidence : ''}`)) reviews.push(`Unsettled: ${clip(i.assumption, 300)}`);
    if (applied.some((i) => (i.confidence || '') === 'low' && i.source !== 'management policy')) reviews.push('A driver on this line has low confidence.');
  }
  const r = uniq(reviews);
  out.needs_review = r.length > 0;
  out.review_note = r.length ? clip(r.join(' ')) : null;
  out.amount_calc = out.amount_calc ? clip(out.amount_calc) : null;
  return out;
}

// One account can sit in more than one fund in the forecast; a budget line is one per account.
function forecastByAccount(model) {
  const m = new Map();
  for (const l of (model && model.lines) || []) { if (!m.has(l.account_id)) m.set(l.account_id, []); m.get(l.account_id).push(l); }
  return m;
}

/**
 * The basis to RECORD on a saved draft line, from the forecast, without touching its amount.
 * The forecast's explanation is recorded only when it explains the saved amount; otherwise the
 * line is marked needs_review with both amounts (a draft amount is never silently re-explained).
 */
function basisForSavedLine(saved, lines, ctx = {}) {
  const ls = lines || [];
  if (!ls.length) return { ...empty(), needs_review: true, review_note: 'Not in the working forecast, so its basis is not recorded. Record why this amount is what it is.' };
  const total = ls.reduce((t, l) => t + int(l.final_cents), 0);
  const main = [...ls].sort((a, b) => Math.abs(int(b.final_cents)) - Math.abs(int(a.final_cents)))[0];
  const b = basisFromForecastLine(main, ctx);
  if (ls.length > 1) { b.needs_review = true; b.review_note = clip([`The forecast carries this account in ${ls.length} funds (${ls.map((l) => `${l.fund_code || 'no fund'} ${fmt(l.final_cents)}`).join(', ')}); the basis shown is the largest.`, b.review_note].filter(Boolean).join(' ')); }
  if (b.amount_basis === 'board_project' || int(saved.annual_amount_cents) === total) return b;
  return { ...empty(), needs_review: true,
    review_note: clip(`The saved amount ${fmt(saved.annual_amount_cents)} is not the working forecast's ${fmt(total)} (${BASIS_LABEL[b.amount_basis] || 'forecast'}: ${b.amount_calc || 'no calculation'}). Record why the saved amount is what it is.`) };
}

// One line of text for a print column or a tooltip.
function basisText(b, { withReview = true } = {}) {
  if (!b || !b.amount_basis) return b && b.needs_review && withReview ? `Basis not recorded. Needs review${b.review_note ? `: ${b.review_note}` : ''}` : '';
  return `${BASIS_LABEL[b.amount_basis] || b.amount_basis}${b.amount_calc ? `: ${b.amount_calc}` : ''}${withReview && b.needs_review ? ` Needs review${b.review_note ? `: ${b.review_note}` : ''}` : ''}`;
}
const pickBasis = (row) => (row ? { amount_basis: row.amount_basis || null, amount_calc: row.amount_calc || null, vendor_contract_id: row.vendor_contract_id || null, source_document_id: row.source_document_id || null, needs_review: !!row.needs_review, review_note: row.review_note || null } : null);
const hasBasis = (b) => !!(b && (b.amount_basis || b.needs_review));

// Read budget lines with the basis columns when migration 521 is applied, without them before.
// run(cols) returns a PostgREST builder (a thenable) selecting cols.
async function selectWithBasis(run, baseCols) {
  const r = await run(`${baseCols}, ${BASIS_COLUMNS}`);
  if (r.error && MISSING_COLUMN.test(r.error.message || '')) { const r2 = await run(baseCols); return { data: r2.data, error: r2.error, basis_available: false }; }
  return { data: r.data, error: r.error, basis_available: !r.error };
}

module.exports = { BASES, BASIS_LABEL, BASIS_COLUMNS, MISSING_COLUMN, UNSETTLED, contractFromForecastLine, basisFromForecastLine, basisForSavedLine, forecastByAccount, basisText, pickBasis, hasBasis, selectWithBasis };
