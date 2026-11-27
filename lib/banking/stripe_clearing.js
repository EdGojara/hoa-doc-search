// ============================================================================
// lib/banking/stripe_clearing.js  (Ed 2026-11-27) - Stripe payouts in Kat's bank rec
// ----------------------------------------------------------------------------
// PURE. Used by lib/banking/monthly_rec.js reconcileAccountMonth for the bank
// account mapped to the community's operating_cash role, when the community has
// a stripe_clearing role (1090). Design: stripe-readiness/stripe_payout_reconciliation_design.md.
//
// The money: a settled online payment posts Dr 1090 / Cr 1300 (stripe:pay:<payment>);
// a full refund or chargeback posts the mirror (stripe:rev:<payment>). Stripe then
// pays the association's balance out to its bank. This module:
//
// 1. MATCH (planPayoutMatches). A payout staged from the webhook (bank_rec_payouts,
//    kind 'stripe', lib/payments/stripe_payouts.js) is matched to ONE bank deposit:
//    same amount as the payout's net, dated from the day before its arrival_date to
//    stripe_payout_window_days (default 5) after, on a line that names no other
//    payment channel, and the only such line. When every component ties to a posted
//    payment (or its posted reversal) and the components sum to the payout, Kat's
//    run PROPOSES Dr operating cash / Cr Stripe clearing, keyed stripe:payout:<po>
//    (unique under the migration 469 index). It posts only when the owner approves
//    the run (monthly_runs.postBankRec -> postProposals). Anything that does not tie
//    is an exception with the reason and no proposal.
//
// 2. TIE-OUT (tieOut). At period end, 1090 must equal its open items:
//      stripe:pay entries whose payment is not yet in a payout booked by then
//    - stripe:rev entries whose reversal is not yet in a payout booked by then.
//    Any other difference is 'stripe_clearing_untied' (open: the month cannot be
//    'reconciled'). Also open: a payment waiting on a payout longer than
//    stripe_payout_overdue_days (default 10), a payout that arrived with no bank
//    deposit matched, a payout that failed after it was booked, and any 1090 line
//    that is not a stripe:* entry. The position (balance, what is waiting, what is
//    unexplained) is reported every month as an info line.
// ============================================================================

const day = (d) => String(d || '').slice(0, 10);
const days = (a, b) => (new Date(day(a)) - new Date(day(b))) / 864e5;
const addDays = (d, n) => { const x = new Date(`${day(d)}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const money = (c) => { const v = Math.abs(Number(c || 0)) / 100; const s = v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); return Number(c) < 0 ? `(${s})` : s; };
const OTHER_CHANNEL_RE = /PROPAY|LOCKBOX|VANTACA/i;
const REF_RE = /^stripe:(pay|rev|payout):(.+)$/;

const DEFAULTS = { stripe_payout_window_days: 5, stripe_payout_overdue_days: 10 };

// payouts rows -> [{ id, rows, net, arrival, status, payout_amount_cents }]
function groupPayouts(rows) {
  const m = new Map();
  for (const r of rows || []) {
    if (r.kind && r.kind !== 'stripe') continue;
    if (!r.processor_payout_id) continue;
    if (!m.has(r.processor_payout_id)) m.set(r.processor_payout_id, []);
    m.get(r.processor_payout_id).push(r);
  }
  return [...m.entries()].map(([id, rs]) => ({
    id, rows: rs, net: rs.reduce((s, r) => s + Number(r.amount_cents), 0),
    arrival: day(rs[0].arrival_date || rs[0].payout_date),
    status: rs.some((r) => r.payout_status === 'failed') ? 'failed' : 'paid',
    payout_amount_cents: rs[0].payout_amount_cents == null ? null : Number(rs[0].payout_amount_cents),
  })).sort((a, b) => a.arrival.localeCompare(b.arrival) || a.id.localeCompare(b.id));
}

function clearingRefs(lines) {
  const pay = new Map(); const rev = new Map(); const payout = new Map(); const foreign = [];
  for (const l of lines || []) {
    const m = REF_RE.exec(String(l.source_reference || ''));
    if (!m) { foreign.push(l); continue; }
    const map = m[1] === 'pay' ? pay : m[1] === 'rev' ? rev : payout;
    map.set(m[2], [...(map.get(m[2]) || []), l]);
  }
  return { pay, rev, payout, foreign };
}

// Why a payout cannot be proposed (empty = it ties).
function payoutProblems(p, sc) {
  const problems = [];
  const P = sc.payments || {};
  if (p.payout_amount_cents != null && p.payout_amount_cents !== p.net) problems.push(`its components total ${money(p.net)} but Stripe reports the payout as ${money(p.payout_amount_cents)}`);
  if (p.net <= 0) problems.push(`the payout nets ${money(p.net)}, not a deposit`);
  for (const r of p.rows) {
    const pay = r.payment_id ? P[r.payment_id] : null;
    const who = pay && pay.confirmation_number ? ` (confirmation ${pay.confirmation_number})` : '';
    if (r.resolution !== 'tied') { problems.push(`${money(r.amount_cents)} ${r.txn_type || 'item'} is not tied to an online payment: ${r.resolution_note || 'untraced'}`); continue; }
    if (!pay) { problems.push(`${money(r.amount_cents)} names a payment that could not be read`); continue; }
    if (Number(r.amount_cents) > 0 && !['posted', 'reversed'].includes(pay.posting_state)) problems.push(`payment${who} of ${money(r.amount_cents)} is in the payout but not posted to the GL (${pay.posting_state || 'not posted'})`);
    if (Number(r.amount_cents) < 0 && pay.posting_state !== 'reversed') problems.push(`a ${money(r.amount_cents)} refund or reversal of payment${who} is in the payout but no reversal is posted`);
  }
  return problems;
}

// -> { byBank: Map(bankTxnId -> { payout, problems }), ambiguous: [{payout, lines}], proposedIds: Set }
function planPayoutMatches({ bank, asOf, periodEnd, sc, settings = {} }) {
  const S = { ...DEFAULTS, ...settings };
  const refs = clearingRefs(sc.clearingLines);
  const byBank = new Map(); const ambiguous = [];
  // Daily payouts of the same amount are normal ($1,425 a lot), so payouts are taken in
  // arrival order and each takes the unclaimed deposit NEAREST its arrival date (earlier
  // date on a tie). One deposit, one payout. It is ambiguous only when an unclaimed
  // deposit of a DIFFERENT date is just as near: then nothing is proposed for that payout.
  const open = groupPayouts(sc.payouts).filter((p) => p.status === 'paid' && !refs.payout.has(p.id) && p.arrival);
  const windowOf = (p) => [addDays(p.arrival, -1), addDays(p.arrival, S.stripe_payout_window_days)];
  for (const p of open) {
    const [lo, hi] = windowOf(p);
    const lines = bank.filter((t) => !t.used && !byBank.has(t.id) && t.amount_cents === p.net && t.posting_date > asOf && t.posting_date <= periodEnd
      && t.posting_date >= lo && t.posting_date <= hi && !OTHER_CHANNEL_RE.test(String(t.description || '')))
      .sort((a, b) => Math.abs(days(a.posting_date, p.arrival)) - Math.abs(days(b.posting_date, p.arrival)) || a.posting_date.localeCompare(b.posting_date));
    if (!lines.length) continue;
    const best = lines[0];
    const dist = Math.abs(days(best.posting_date, p.arrival));
    const tie = lines.find((l) => l !== best && l.posting_date !== best.posting_date && Math.abs(days(l.posting_date, p.arrival)) === dist);
    if (tie) { ambiguous.push({ payout: p, lines: [best, tie] }); continue; }
    byBank.set(best.id, { payout: p, problems: payoutProblems(p, sc) });
  }
  return { byBank, ambiguous };
}

// The proposal for one matched payout (bank line t). The cash side is the bank account's own
// GL account; the clearing side is the community's stripe_clearing role.
function payoutProposal({ t, payout, sc, cashAcct, label, ev }) {
  const P = sc.payments || {};
  const pays = payout.rows.filter((r) => Number(r.amount_cents) > 0);
  const revs = payout.rows.filter((r) => Number(r.amount_cents) < 0);
  const conf = (rs) => rs.map((r) => (P[r.payment_id] && P[r.payment_id].confirmation_number) || r.account_ref || '?').join(', ');
  const id = `stripe_payout:${payout.id}`;
  return {
    id, kind: 'journal_entry', posting_date: t.posting_date, amount_cents: payout.net, source_reference: `stripe:payout:${payout.id}`,
    description: (`Stripe payout ${payout.id}: ${pays.length} online payment(s)${revs.length ? `, ${revs.length} reversal(s)` : ''} deposited (${label} ${t.posting_date})`).slice(0, 300),
    lines: [
      { account_number: cashAcct, debit_cents: payout.net, credit_cents: 0, memo: `Stripe payout ${payout.id} ${t.posting_date}` },
      { account_number: sc.clearing_account_number, debit_cents: 0, credit_cents: payout.net, memo: `Stripe payout ${payout.id} arrived ${payout.arrival}` },
    ],
    payout_id: payout.id,
    evidence: { ...ev, basis: `Stripe payout ${payout.id} arrived ${payout.arrival} for ${money(payout.net)}; its ${payout.rows.length} component(s) each tie to a posted online payment${revs.length ? ' or its posted reversal' : ''} `
      + `(payments ${conf(pays)}${revs.length ? `; reversals ${conf(revs)}` : ''}), and they total the payout. Moves the deposit from Stripe clearing to cash.` },
  };
}

// Month-end position of the clearing account. -> { summary, exceptions }
function tieOut({ periodEnd, sc, settings = {}, proposedPayoutIds = new Set() }) {
  const S = { ...DEFAULTS, ...settings };
  const P = sc.payments || {};
  const lines = (sc.clearingLines || []).filter((l) => day(l.posting_date) <= periodEnd).map((l) => ({ ...l, posting_date: day(l.posting_date), amount_cents: Number(l.amount_cents) }));
  const balance = lines.reduce((s, l) => s + l.amount_cents, 0);
  const refs = clearingRefs(lines);
  const payouts = groupPayouts(sc.payouts);
  const exceptions = [];
  const exc = (e) => exceptions.push({ severity: 'open', ...e });

  const booked = new Set([...refs.payout.keys()]);
  const clearedPay = new Set(); const clearedRev = new Set(); const inPayout = new Map();
  for (const p of payouts) {
    for (const r of p.rows) {
      if (!r.payment_id || r.resolution !== 'tied') continue;
      if (Number(r.amount_cents) > 0) inPayout.set(r.payment_id, p);
      if (!booked.has(p.id)) continue;
      (Number(r.amount_cents) > 0 ? clearedPay : clearedRev).add(r.payment_id);
    }
  }
  const sum = (ls) => ls.reduce((s, l) => s + l.amount_cents, 0);
  const openPay = [...refs.pay.entries()].filter(([pid]) => !clearedPay.has(pid));
  const openRev = [...refs.rev.entries()].filter(([pid]) => !clearedRev.has(pid));
  const awaiting = openPay.filter(([pid]) => !inPayout.has(pid));
  const inTransit = openPay.filter(([pid]) => inPayout.has(pid));
  const openTotal = openPay.reduce((s, [, ls]) => s + sum(ls), 0) + openRev.reduce((s, [, ls]) => s + sum(ls), 0);
  const untied = balance - openTotal;

  for (const l of refs.foreign) exc({ code: 'stripe_clearing_foreign_entry', amount_cents: l.amount_cents, date: l.posting_date, gl_ref: l.reference,
    text: `${l.reference || 'An entry'} on ${l.posting_date} (${money(l.amount_cents)}) is in Stripe clearing but is not a Stripe payment, reversal or payout entry. Only those belong in this account.` });
  if (untied !== 0) exc({ code: 'stripe_clearing_untied', amount_cents: untied,
    text: `Stripe clearing does not tie at ${periodEnd}: the account is ${money(balance)} but its open payments and reversals total ${money(openTotal)}, leaving ${money(untied)} unexplained. A booked payout that does not equal the payments it contains, a payment in a payout that was not posted, or an entry that is not a Stripe entry causes this.` });
  for (const [pid, ls] of awaiting) {
    const d = ls.map((l) => l.posting_date).sort()[0];
    if (days(periodEnd, d) > S.stripe_payout_overdue_days) {
      const who = P[pid] && P[pid].confirmation_number ? `confirmation ${P[pid].confirmation_number}` : `payment ${pid}`;
      exc({ code: 'stripe_payout_overdue', amount_cents: sum(ls), date: d, text: `Online payment ${who} (${money(sum(ls))}, posted ${d}) is not in any Stripe payout after ${Math.round(days(periodEnd, d))} days. Check the association's Stripe balance and payout schedule.` });
    }
  }
  for (const p of payouts) {
    if (p.status === 'failed' && booked.has(p.id)) exc({ code: 'stripe_payout_failed_after_posting', amount_cents: p.net, date: p.arrival,
      text: `Stripe payout ${p.id} (${money(p.net)}, ${p.arrival}) failed after it was booked to cash. Reverse its entry (Dr Stripe clearing / Cr cash) once the bank confirms the money did not arrive.` });
    if (p.status === 'paid' && !booked.has(p.id) && !proposedPayoutIds.has(p.id) && p.arrival && addDays(p.arrival, S.stripe_payout_window_days) < periodEnd) exc({ code: 'stripe_payout_not_matched', amount_cents: p.net, date: p.arrival,
      text: `Stripe payout ${p.id} arrived ${p.arrival} for ${money(p.net)}, but no single bank deposit of that amount was found within ${S.stripe_payout_window_days} days, so it is not booked to cash.` });
  }
  const summary = { clearing_account_number: sc.clearing_account_number, balance_cents: balance, open_cents: openTotal, untied_cents: untied,
    awaiting_payout: { count: awaiting.length, cents: awaiting.reduce((s, [, ls]) => s + sum(ls), 0) },
    in_payouts_not_booked: { count: inTransit.length, cents: inTransit.reduce((s, [, ls]) => s + sum(ls), 0) },
    reversals_open: { count: openRev.length, cents: openRev.reduce((s, [, ls]) => s + sum(ls), 0) } };
  exceptions.push({ code: 'stripe_clearing_position', severity: 'info', amount_cents: balance,
    text: `Stripe clearing ${sc.clearing_account_number} at ${periodEnd}: ${money(balance)}. Awaiting a payout ${money(summary.awaiting_payout.cents)} (${awaiting.length} payment(s)); in payouts not yet booked to cash ${money(summary.in_payouts_not_booked.cents)} (${inTransit.length}); reversals not yet netted in a payout ${money(summary.reversals_open.cents)} (${openRev.length}); unexplained ${money(untied)}.${balance === 0 && untied === 0 ? ' Back to zero.' : ''}` });
  return { summary, exceptions };
}

module.exports = { planPayoutMatches, payoutProposal, payoutProblems, tieOut, groupPayouts, DEFAULTS };
