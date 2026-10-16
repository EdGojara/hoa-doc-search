// ============================================================================
// lib/accounting/data_confidence.js  (Ed 2026-10-16: "trustEd is still in transition")
// ----------------------------------------------------------------------------
// ONE place that decides how much a financial figure can be relied on, so every
// AI teammate (Amanda first) uses the books at the right confidence instead of
// either ignoring them or overstating them.
//
// Some books are unreconciled, months are not closed and migrations are still
// landing. The rule is: retrieve the data, assess its reliability, use it at the
// appropriate confidence, and state the limitation only where it is material to
// the decision. Never sprinkle disclaimers on every number; never say a funding
// source is definitively available when the balance behind it is provisional.
//
// Labels (worst first):
//   unavailable   the source failed or returned nothing usable
//   incomplete    the figure is known to be missing parts (e.g. a cash GL account
//                 that is not linked to any bank account, so it cannot be
//                 reconciled in trustEd at all)
//   stale         the last completed reconciliation is far behind (STALE_DAYS)
//   provisional   usable for preliminary judgment: no completed reconciliation
//                 through the latest month-end, or that month is not closed
//   verified      reconciled through the latest completed month AND that month
//                 is closed
//
// The control is CONFIGURABLE so it can be tightened, then retired, as the books
// become reliable:
//   DATA_CONFIDENCE_MODE       transition (default) | strict | off
//   DATA_CONFIDENCE_OVERRIDES  JSON {"<community_id>": "strict"|"off"|"transition"}
//   DATA_CONFIDENCE_STALE_DAYS default 95
//
//   transition  label figures; provisional figures are fine for preliminary
//               affordability, never for a definitive "funds are available"
//   strict      provisional/stale/incomplete figures may be reported but may not
//               support any affordability or funding conclusion
//   off         no labels, no certainty check (the books are trusted as-is)
// ============================================================================

const ORDER = ['verified', 'provisional', 'stale', 'incomplete', 'unavailable'];
const MODES = ['transition', 'strict', 'off'];

function confidenceMode(communityId, env = process.env) {
  let m = String(env.DATA_CONFIDENCE_MODE || 'transition').toLowerCase().trim();
  try {
    const o = JSON.parse(env.DATA_CONFIDENCE_OVERRIDES || '{}');
    if (communityId && o && typeof o === 'object' && o[communityId]) m = String(o[communityId]).toLowerCase().trim();
  } catch (e) { console.warn('[data_confidence] DATA_CONFIDENCE_OVERRIDES is not valid JSON, ignoring:', e.message); }
  return MODES.includes(m) ? m : 'transition';
}

/** Worst of a set of labels (unavailable beats everything). */
function worst(labels) {
  let w = 'verified';
  for (const l of labels || []) if (ORDER.indexOf(l) > ORDER.indexOf(w)) w = l;
  return w;
}

/** Last day of the month before `today` ('YYYY-MM-DD'). */
function latestMonthEnd(today) {
  const [y, m] = String(today).slice(0, 10).split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1, 0));   // day 0 of this month = last day of previous
  return d.toISOString().slice(0, 10);
}
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

/**
 * Assess how current the books are from records already in trustEd.
 * Pure: pass the rows in; nothing is read here.
 *   bankAccounts     [{id, gl_account_number, account_nickname, account_last4}]
 *   reconciliations  [{bank_account_id, period_end, status}]
 *   periods          [{period_end, status}]   (accounting_periods)
 *   errors           {bank, recs, periods} truthy when that source failed
 */
function assessBooks({ today, bankAccounts = [], reconciliations = [], periods = [], errors = {}, mode = 'transition', staleDays } = {}) {
  const stale = Number(staleDays || process.env.DATA_CONFIDENCE_STALE_DAYS || 95);
  const lme = latestMonthEnd(today);
  const lastClosed = (periods || []).filter((p) => ['closed', 'locked'].includes(p.status) && p.period_end <= today).map((p) => p.period_end).sort().pop() || null;
  const monthClosed = !!(lastClosed && lastClosed >= lme);
  const sourceDown = errors.bank || errors.recs || errors.periods;
  const byGl = {};
  for (const b of bankAccounts || []) {
    const gl = String(b.gl_account_number || '');
    const recThrough = (reconciliations || []).filter((r) => r.bank_account_id === b.id && r.status === 'reconciled').map((r) => r.period_end).sort().pop() || null;
    let label; let reason;
    if (sourceDown) { label = 'unavailable'; reason = 'reconciliation records could not be read'; }
    else if (recThrough && recThrough >= lme && monthClosed) { label = 'verified'; reason = `reconciled through ${recThrough}, month closed`; }
    else if (recThrough && daysBetween(recThrough, lme) > stale) { label = 'stale'; reason = `last reconciled ${recThrough}`; }
    else {
      label = 'provisional';
      reason = !recThrough ? 'no completed reconciliation on file'
        : recThrough < lme ? `reconciled only through ${recThrough}` : 'reconciled, but the month is not closed';
      if (!monthClosed && recThrough && recThrough < lme) reason += '; no month closed through ' + lme;
    }
    const name = `${b.account_nickname || gl || 'bank account'}${b.account_last4 && !String(b.account_nickname || '').includes(b.account_last4) ? ` ${b.account_last4}` : ''}`;
    (byGl[gl] = byGl[gl] || []).push({ bank_account_id: b.id, name, reconciled_through: recThrough, label, reason });
  }
  return { mode, today, latest_month_end: lme, last_closed: lastClosed, month_closed: monthClosed, source_unavailable: !!sourceDown, by_gl: byGl };
}

/** Label for one GL cash/investment account. */
function labelAccount(assessment, glNumber) {
  if (!assessment) return { label: 'unavailable', reason: 'books status not assessed' };
  if (assessment.source_unavailable) return { label: 'unavailable', reason: 'reconciliation records could not be read' };
  const banks = assessment.by_gl[String(glNumber)] || [];
  if (!banks.length) return { label: 'incomplete', reason: 'not linked to a bank account in trustEd, so it cannot be reconciled here' };
  const w = worst(banks.map((b) => b.label));
  const pick = banks.find((b) => b.label === w) || banks[0];
  return { label: w, reason: `${pick.name}: ${pick.reason}` };
}

/** Label for activity-based figures (budget actuals, open payables). */
function labelActivity(assessment, what = 'actuals') {
  if (!assessment) return { label: 'unavailable', reason: 'books status not assessed' };
  if (assessment.source_unavailable) return { label: 'unavailable', reason: 'period records could not be read' };
  if (assessment.month_closed) return { label: 'verified', reason: `books closed through ${assessment.last_closed}` };
  return { label: 'provisional', reason: `${what} include months that are not closed (last closed: ${assessment.last_closed || 'none yet'})` };
}

/** Short inline tag for the facts block, e.g. "[provisional: Operating 5313 reconciled only through 2026-07-31]". */
function tag(l, mode) {
  if (mode === 'off' || !l) return '';
  return ` [${l.label}${l.label === 'verified' ? '' : `: ${l.reason}`}]`;
}

/** How Amanda may use the figures, given the mode and the worst decision-driving label. */
function usageGuidance(mode, worstLabel) {
  if (mode === 'off') return '';
  if (worstLabel === 'verified') return 'DATA CONFIDENCE: the decision-driving balances are reconciled and the month is closed. State them as fact.';
  if (mode === 'strict') return `DATA CONFIDENCE (strict): the decision-driving balances are ${worstLabel}. Report them as unverified figures; do not draw an affordability or funding conclusion from them. Make "confirm funding once the books are reconciled" an open item, and say so once.`;
  return `DATA CONFIDENCE (transition): the decision-driving balances are ${worstLabel}. Use them for a preliminary affordability view and name the funding source you recommend, but never write that funds are definitively available, confirmed or fully funded. State the limitation once, where it bears on the decision (for example "the reserve balance is provisional until the September reconciliation is complete"), not on every number.`;
}

// Claims of certainty about money that a provisional balance cannot support.
const CERTAIN_FUNDS = [
  /\bdefinitive(?:ly)?\s+(?:available|funded|covered|affordable)/i,
  /\b(?:funds?|cash|money|reserves?|the money|operating cash)\s+(?:is|are)\s+(?:definitely |definitively |confirmed |fully |readily |clearly |certainly )?(?:available|on hand|sufficient|there)\b/i,
  /\b(?:fully|confirmed)\s+funded\b/i,
  /\bwe (?:have|hold) (?:more than )?(?:sufficient|enough|ample|plenty of) (?:cash|funds?|money|reserves?)\b/i,
  /\bthere (?:is|are) (?:sufficient|enough|ample|plenty of) (?:cash|funds?|money|reserves?)\b/i,
  /\b(?:can|will) be (?:fully )?funded (?:now|today|immediately|in full|without (?:issue|difficulty|concern))/i,
  /\bconfirm(?:ed)? (?:that )?(?:the )?(?:funds?|cash|money|funding) (?:is|are) (?:available|in place)/i,
  /\b(?:easily|comfortably) (?:afford|cover|fund)/i,
];
const HEDGE = /\b(provisional|preliminar|unreconciled|not yet reconciled|subject to|pending|appears|appear to|once the (?:books|reconciliation)|before (?:the )?(?:reconciliation|close)|unverified|not yet verified|estimate)/i;

/**
 * Sentences claiming certainty about available funds when the balances behind
 * them are not verified. Returns [] in mode 'off' or when the balances are verified.
 * In strict mode a hedge does not excuse an affordability conclusion.
 */
function certaintyIssues(sentences, { mode = 'transition', cashLabel = 'verified' } = {}) {
  if (mode === 'off' || cashLabel === 'verified') return [];
  const out = [];
  for (const s of sentences) {
    if (!CERTAIN_FUNDS.some((re) => re.test(s))) continue;
    if (mode !== 'strict' && HEDGE.test(s)) continue;
    out.push({ code: 'overstated_certainty', text: s });
  }
  return out;
}

module.exports = {
  ORDER, MODES, confidenceMode, worst, latestMonthEnd, assessBooks, labelAccount, labelActivity, tag, usageGuidance, certaintyIssues, CERTAIN_FUNDS,
};
