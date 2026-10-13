// ============================================================================
// lib/close/controls.js  (Ed 2026-10-09: month-end close, PR A)
// ----------------------------------------------------------------------------
// The month-end checklist, as pure functions of facts gathered from the books
// (lib/close/gather.js). No database, no AI, no clock: the same facts always give
// the same PASS / WARNING / BLOCK. Amanda or Kat may explain a result later; they
// never decide one.
//
// Every control returns:
//   { code, group, label, status: 'PASS'|'WARNING'|'BLOCK', amount_cents, count,
//     explanation, drill: {label, href} | null, action, evidence, evidence_hash }
// evidence_hash fingerprints what the control saw, so an owner override binds to
// exactly that evidence: if the numbers change, the override no longer applies.
//
// Rules Ed set (2026-10-09):
//   * Bank tolerance is exactly $0.00. Timing or rounding differences must be
//     explicit reconciling items, never tolerance.
//   * A balanced ledger is not enough: required source activity must be complete
//     through period end (Data Completeness). Missing required source = BLOCK.
//   * Variance is a warning, never a blocker (budget controls arrive in PR A2).
//   * A disclosed conversion reconciling item is a WARNING; an accounting error is
//     a BLOCK.
// ============================================================================
const crypto = require('crypto');

const ENGINE_VERSION = 'close-b.1';   // b: Kat's cutoff review (CUT-*, IF-01), Ed 2026-10-12
const STALE_CHECK_DAYS = 90;

const PASS = 'PASS'; const WARNING = 'WARNING'; const BLOCK = 'BLOCK';

function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  return JSON.stringify(v === undefined ? null : v);
}
const hash = (o) => crypto.createHash('sha256').update(stable(o)).digest('hex').slice(0, 32);

const $ = (c) => {
  const n = Number(c || 0) / 100;
  const s = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return n < 0 ? `($${s})` : `$${s}`;
};
const monthLabel = (iso) => new Date(`${String(iso).slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const dayLabel = (iso) => new Date(`${String(iso).slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const daysBetween = (a, b) => Math.round((Date.parse(`${String(b).slice(0, 10)}T00:00:00Z`) - Date.parse(`${String(a).slice(0, 10)}T00:00:00Z`)) / 86400000);
const sum = (rows, k) => rows.reduce((s, r) => s + Number(r[k] || 0), 0);

function control(code, group, label, status, { amount_cents = null, count = null, explanation, drill = null, action = null, evidence = {} }) {
  if (![PASS, WARNING, BLOCK].includes(status)) throw new Error(`bad status ${status}`);
  return { code, group, label, status, amount_cents, count, explanation, drill, action: status === PASS ? null : action, evidence,
    evidence_hash: hash({ code, status, amount_cents, count, evidence }) };
}

function links(cid, periodEnd) {
  const base = `/accounting.html?community_id=${encodeURIComponent(cid)}`;
  return {
    trial: { label: 'Trial Balance', href: `${base}&view=trial` },
    je: { label: 'Journal Entries', href: `${base}&view=je` },
    periods: { label: 'Periods', href: `${base}&view=periods` },
    bankrec: { label: 'Bank Reconciliation', href: `${base}&view=bankrec` },
    ar: { label: 'AR Aging', href: `${base}&view=ar` },
    ap: { label: 'AP Aging', href: `${base}&view=ap` },
    bills: { label: 'Bills', href: `/ap-invoices.html?community_id=${encodeURIComponent(cid)}` },
    tieout: { label: 'Tie-Out', href: `${base}&view=tieout` },
    owners: { label: 'Homeowner accounts', href: `${base}&view=owners` },
    periodEnd,
  };
}

// --------------------------------------------------------------------- GL
function glControls(f, L) {
  const out = [];
  const thr = Number(f.through_debits_cents) - Number(f.through_credits_cents);
  const per = Number(f.period_debits_cents) - Number(f.period_credits_cents);
  out.push(control('GL-01', 'General ledger', 'Debits equal credits', thr === 0 && per === 0 ? PASS : BLOCK, {
    amount_cents: thr || per,
    explanation: thr === 0 && per === 0
      ? `Through ${dayLabel(f.period_end)} the ledger's ${Number(f.counted_lines).toLocaleString('en-US')} counted lines balance: debits ${$(f.through_debits_cents)} = credits ${$(f.through_credits_cents)}.`
      : `The ledger does not balance: through ${dayLabel(f.period_end)} debits ${$(f.through_debits_cents)} vs credits ${$(f.through_credits_cents)} (difference ${$(thr)}); within the month the difference is ${$(per)}.`,
    drill: L.trial, action: 'Find the entry whose lines do not balance (see GL-02) and correct it; a ledger that does not balance cannot close.',
    evidence: { through_debits_cents: f.through_debits_cents, through_credits_cents: f.through_credits_cents, period_debits_cents: f.period_debits_cents, period_credits_cents: f.period_credits_cents },
  }));
  const broken = f.broken_entries || [];
  out.push(control('GL-02', 'General ledger', 'No broken journal entries', broken.length ? BLOCK : PASS, {
    count: broken.length,
    explanation: broken.length
      ? `${broken.length} posted ${broken.length === 1 ? 'entry does' : 'entries do'} not match ${broken.length === 1 ? 'its' : 'their'} own lines: ${broken.slice(0, 6).map((b) => `${b.reference} (${b.posting_date}, ${b.problem === 'no_lines' ? `no lines; header ${$(b.header_debits_cents)}` : b.problem === 'lines_unbalanced' ? `lines debit ${$(b.line_debits_cents)} vs credit ${$(b.line_credits_cents)}` : `header ${$(b.header_debits_cents)} vs lines ${$(b.line_debits_cents)}`})`).join('; ')}${broken.length > 6 ? `; and ${broken.length - 6} more` : ''}.`
      : 'Every counted entry through period end has lines, its lines balance, and they equal its header.',
    drill: L.je, action: 'Restore or correct the entry so its lines match what was posted. Never delete an entry\'s lines to change the books; reverse it instead.',
    evidence: { entries: broken.map((b) => ({ ref: b.reference, d: b.posting_date, p: b.problem, h: b.header_debits_cents, l: b.line_debits_cents })) },
  }));
  const drafts = f.draft_entries || [];
  out.push(control('GL-03', 'General ledger', 'No unposted entries dated in the month', drafts.length ? BLOCK : PASS, {
    count: drafts.length, amount_cents: sum(drafts, 'amount_cents'),
    explanation: drafts.length ? `${drafts.length} draft ${drafts.length === 1 ? 'entry is' : 'entries are'} dated in ${monthLabel(f.period_end)}: ${drafts.slice(0, 6).map((d) => `${d.reference} ${$(d.amount_cents)}`).join('; ')}.` : `No draft entries are dated in ${monthLabel(f.period_end)}.`,
    drill: L.je, action: 'Post or delete each draft so the month holds only final entries.',
    evidence: { drafts: drafts.map((d) => d.reference) },
  }));
  const dates = f.invalid_dates || [];
  out.push(control('GL-04', 'General ledger', 'Valid posting dates', dates.length ? BLOCK : PASS, {
    count: dates.length,
    explanation: dates.length ? `${dates.length} ${dates.length === 1 ? 'entry is' : 'entries are'} filed under a period that does not contain ${dates.length === 1 ? 'its' : 'their'} posting date: ${dates.slice(0, 6).map((d) => `${d.reference} (${d.posting_date}, ${d.problem.replace(/_/g, ' ')})`).join('; ')}.` : 'Every entry dated in the month is filed under the period that contains its date.',
    drill: L.je, action: 'Correct the entry so its posting date and period agree.',
    evidence: { entries: dates.map((d) => ({ ref: d.reference, d: d.posting_date, p: d.problem })) },
  }));
  const back = f.backdated_into_closed || [];
  out.push(control('GL-05', 'General ledger', 'Nothing recorded into a closed month after it closed', back.length ? BLOCK : PASS, {
    count: back.length,
    explanation: back.length ? `${back.length} ${back.length === 1 ? 'entry was' : 'entries were'} recorded after the month ${back.length === 1 ? 'it is' : 'they are'} dated in had closed: ${back.slice(0, 6).map((b) => `${b.reference} (${b.posting_date}, recorded ${String(b.created_at).slice(0, 10)})`).join('; ')}.` : 'No entry dated in a closed month was recorded after that month closed.',
    drill: L.periods, action: 'Reverse the entry and re-post it in an open month, or reopen the closed month with a reason.',
    evidence: { entries: back.map((b) => b.reference) },
  }));
  const funds = f.unbalanced_funds || [];
  out.push(control('GL-06', 'General ledger', 'Every fund balances', funds.length ? BLOCK : PASS, {
    count: funds.length, amount_cents: sum(funds, 'difference_cents'),
    explanation: funds.length ? `Debits and credits differ within ${funds.length === 1 ? 'one fund' : `${funds.length} funds`}: ${funds.map((x) => `${x.fund_code || 'no fund'} ${$(x.difference_cents)}`).join('; ')}.` : 'Operating, reserve and every other fund balance independently through period end.',
    drill: L.trial, action: 'Find the entry posted to one fund without its interfund bridge and correct it.',
    evidence: { funds: funds.map((x) => ({ f: x.fund_code, d: x.difference_cents })) },
  }));
  const vnr = f.voided_without_reversal || [];
  if (vnr.length) {
    out.push(control('GL-07', 'General ledger', 'Voided entries carry their reversal', WARNING, {
      count: vnr.length, amount_cents: sum(vnr, 'amount_cents'),
      explanation: `${vnr.length} voided ${vnr.length === 1 ? 'entry has' : 'entries have'} no reversal recorded, so ${vnr.length === 1 ? 'it is' : 'they are'} excluded from the books: ${vnr.slice(0, 6).map((v) => `${v.reference} ${$(v.amount_cents)}`).join('; ')}.`,
      drill: L.je, action: 'Confirm each was never meant to count; otherwise post its reversal properly.',
      evidence: { entries: vnr.map((v) => v.reference) },
    }));
  }
  return out;
}

// --------------------------------------------------------------------- Cash
function cashControls(bank, f, L) {
  const out = [];
  const accts = (bank.accounts || []).filter((a) => a.is_active !== false);
  const recFor = (a) => (bank.recs || []).filter((r) => r.bank_account_id === a.id && r.status !== 'voided'
    && String(r.period_end) >= String(f.period_start) && String(r.period_end) <= String(f.period_end))
    .sort((x, y) => String(y.period_end).localeCompare(String(x.period_end)) || String(y.updated_at || '').localeCompare(String(x.updated_at || '')))[0] || null;

  const notDone = []; const done = [];
  for (const a of accts) {
    const r = recFor(a);
    if (!r) notDone.push({ account: a.account_nickname, gl: a.gl_account_number, problem: 'no reconciliation for the month' });
    else if (r.status !== 'reconciled') notDone.push({ account: a.account_nickname, gl: a.gl_account_number, problem: `reconciliation is ${String(r.status).replace(/_/g, ' ')}` });
    else if (r.difference_cents == null || Number(r.difference_cents) !== 0) notDone.push({ account: a.account_nickname, gl: a.gl_account_number, problem: `unreconciled difference ${$(r.difference_cents)}` });
    else done.push({ a, r });
  }
  out.push(control('CASH-01', 'Cash', 'Every bank and investment account reconciled to $0.00', !accts.length ? WARNING : notDone.length ? BLOCK : PASS, {
    count: notDone.length,
    explanation: !accts.length ? 'No bank or investment accounts are set up for this community, so no reconciliation can be checked.'
      : notDone.length ? `${notDone.length} of ${accts.length} accounts are not reconciled through ${dayLabel(f.period_end)} with a $0.00 difference: ${notDone.map((n) => `${n.account} (${n.problem})`).join('; ')}.`
        : `All ${accts.length} accounts are reconciled for ${monthLabel(f.period_end)} with a $0.00 unreconciled difference.`,
    drill: L.bankrec, action: 'Complete the reconciliation. A timing or rounding difference becomes an explicit reconciling item; tolerance is $0.00.',
    evidence: { accounts: accts.map((a) => { const r = recFor(a); return { a: a.id, r: r && r.id, s: r && r.status, d: r && r.difference_cents }; }) },
  }));

  // Book balance ties GL: the reconciled book balance per GL account equals the GL
  // balance at period end (accounts sharing a GL account are summed and flagged).
  const byGl = {};
  for (const { a, r } of done) { const k = a.gl_account_number || '?'; (byGl[k] = byGl[k] || []).push({ a, r }); }
  const ties = []; const shared = [];
  for (const [gl, rows] of Object.entries(byGl)) {
    const book = rows.reduce((s, x) => s + Number(x.r.gl_ending_balance_cents || 0), 0);
    const glBal = (bank.gl_balances || {})[gl];
    ties.push({ gl, book, gl_cents: glBal == null ? null : glBal, diff: glBal == null ? null : book - glBal });
    if (rows.length > 1) shared.push({ gl, accounts: rows.map((x) => x.a.account_nickname) });
  }
  const off = ties.filter((t) => t.diff !== 0);
  out.push(control('CASH-02', 'Cash', 'Reconciled book balance ties the GL', !done.length ? (accts.length ? BLOCK : WARNING) : off.length ? BLOCK : PASS, {
    count: off.length, amount_cents: off.reduce((s, t) => s + (t.diff || 0), 0),
    explanation: !done.length ? 'No completed reconciliation to tie to the GL yet (see CASH-01).'
      : off.length ? `The reconciled book balance differs from the GL at ${dayLabel(f.period_end)}: ${off.map((t) => `${t.gl} book ${$(t.book)} vs GL ${t.gl_cents == null ? 'no such GL account' : $(t.gl_cents)}`).join('; ')}.`
        : `Each reconciled book balance equals its GL cash account at ${dayLabel(f.period_end)}.`,
    drill: L.tieout, action: 'Find the GL entry dated after the reconciliation was prepared, or the cash entry missing from the GL, and correct it.',
    evidence: { ties },
  }));
  if (shared.length) {
    out.push(control('CASH-03', 'Cash', 'Each physical account has its own GL cash account', WARNING, {
      count: shared.length,
      explanation: `${shared.map((s) => `${s.accounts.join(' and ')} both reconcile against GL ${s.gl}`).join('; ')}. They may roll up together on the statements, but each needs its own GL account for reconciliation.`,
      drill: L.bankrec, action: 'Give each physical account its own GL cash account (proposed reclass and opening balance shown before anything posts).',
      evidence: { shared },
    }));
  }

  // Reconciling items: listed; stale checks and unusual items are warnings.
  const items = (bank.rec_items || []).filter((i) => done.some((x) => x.r.id === i.reconciliation_id));
  const oc = items.filter((i) => i.category === 'outstanding_check');
  const dit = items.filter((i) => i.category === 'deposit_in_transit');
  const stale = oc.filter((i) => i.date_ref && daysBetween(i.date_ref, f.period_end) > STALE_CHECK_DAYS);
  const unusual = items.filter((i) => ['bank_only', 'gl_only', 'manual_adjustment'].includes(i.category));
  const warn = stale.length || unusual.length;
  out.push(control('CASH-04', 'Cash', 'Reconciling items listed; none stale or unusual', warn ? WARNING : PASS, {
    count: oc.length + dit.length + unusual.length, amount_cents: sum(oc, 'amount_cents') + sum(dit, 'amount_cents') + sum(unusual, 'amount_cents'),
    explanation: `${oc.length} outstanding ${oc.length === 1 ? 'check' : 'checks'} (${$(sum(oc, 'amount_cents'))}), ${dit.length} ${dit.length === 1 ? 'deposit' : 'deposits'} in transit (${$(sum(dit, 'amount_cents'))})`
      + `${unusual.length ? `, ${unusual.length} other reconciling ${unusual.length === 1 ? 'item' : 'items'} (${$(sum(unusual, 'amount_cents'))})` : ''}.`
      + `${stale.length ? ` ${stale.length} outstanding ${stale.length === 1 ? 'check is' : 'checks are'} more than ${STALE_CHECK_DAYS} days old: ${stale.slice(0, 5).map((s) => `#${s.check_number || '?'} ${$(s.amount_cents)} (${s.date_ref})`).join('; ')}.` : ''}`,
    drill: L.bankrec, action: 'Follow up stale checks (void and reissue, or escheat) and document each bank-only, GL-only or manual item.',
    evidence: { oc: oc.map((i) => [i.check_number, i.amount_cents, i.date_ref]), dit: dit.map((i) => [i.amount_cents, i.date_ref]), unusual: unusual.map((i) => [i.category, i.amount_cents]) },
  }));
  return out;
}

// --------------------------------------------------------------------- AR
function arControls(ar, L) {
  const out = [];
  if (!ar || ar.error) {
    out.push(control('AR-01', 'Homeowners', 'GL 1300 ties owner receivables', BLOCK, {
      explanation: `The AR aging could not be computed${ar && ar.error ? `: ${ar.error}` : ''}.`, drill: L.ar, action: 'Open the AR aging and resolve the error.', evidence: { error: ar && ar.error },
    }));
    return out;
  }
  const r = ar.reconciliation || {};
  const tied = r.tied === true && r.difference_cents === 0;
  out.push(control('AR-01', 'Homeowners', 'GL 1300 ties owner receivables', tied ? PASS : BLOCK, {
    amount_cents: r.difference_cents,
    explanation: tied ? `Owner receivables tie GL 1300 at ${dayLabel(ar.as_of)}: ${$(r.gl_ar_cents)}. (The aging shows each owner's net position, ${$(ar.aging_total_cents)}; owners in credit are listed separately and their credits sit in 2400.)`
      : r.gl_ar_cents == null ? 'This community has no GL 1300 account, so the owner receivables cannot be tied.'
        : `The owner-level receivables do not tie GL 1300 at ${dayLabel(ar.as_of)}: difference ${$(r.difference_cents)} (GL 1300 ${$(r.gl_ar_cents)}).`,
    drill: L.ar, action: 'Use the aging’s "Ties to the general ledger" card to find the owner rows or GL entries that differ. Do not post to make it tie.',
    evidence: { gl: r.gl_ar_cents, diff: r.difference_cents, aging: ar.aging_total_cents, matches: r.aging_matches_ledger },
  }));
  // Owner credits: current owners in credit + former owners' credits = GL 2400 + 2410.
  const p = r.prepaid || null;
  if (!p) {
    out.push(control('AR-02', 'Homeowners', 'Owner credits tie GL 2400 / 2410', PASS, {
      explanation: 'No owner credit detail to tie (native receivables: credits are held as unapplied payments).', evidence: { p: null } }));
  } else {
    const detail = Number(p.subledger_cents || 0) + Number(ar.former_credit_cents || 0);
    const glc = p.gl_cents == null && ar.gl_2410_cents == null ? null : Number(p.gl_cents || 0) + Number(ar.gl_2410_cents || 0);
    const diff = glc == null ? null : detail - glc;
    out.push(control('AR-02', 'Homeowners', 'Owner credits tie GL 2400 / 2410', diff === 0 ? PASS : BLOCK, {
      amount_cents: diff,
      explanation: `Current owners' credits ${$(p.subledger_cents)} + former owners' credits ${$(ar.former_credit_cents || 0)} (${ar.former_credit_count || 0}) = ${$(detail)}; `
        + `GL 2400 ${$(p.gl_cents)}${ar.gl_2410_cents != null ? ` + 2410 ${$(ar.gl_2410_cents)}` : ''} = ${glc == null ? 'n/a' : $(glc)}. ${diff === 0 ? 'Tied.' : `Difference ${$(diff)}.`}`,
      drill: L.ar, action: 'Find the owner credit rows or the 2400 / 2410 entries that differ (the former-owner list is on the AR aging).',
      evidence: { cur: p.subledger_cents, former: ar.former_credit_cents || 0, g2400: p.gl_cents, g2410: ar.gl_2410_cents, diff },
    }));
  }
  const credits = r.owners_in_credit || [];
  out.push(control('AR-03', 'Homeowners', 'Owner credit balances shown separately', PASS, {
    count: credits.length, amount_cents: credits.reduce((s, o) => s + Number(o.net_cents || o.cents || 0), 0),
    explanation: credits.length ? `${credits.length} ${credits.length === 1 ? 'owner is' : 'owners are'} in credit; they are listed separately, not netted silently against receivables.` : 'No owner is in credit.',
    drill: L.ar, evidence: { n: credits.length },
  }));
  return out;
}

// --------------------------------------------------------------------- AP
function apControls(ap, L) {
  const out = [];
  const open = sum(ap.open_rows || [], 'balance_cents');
  const gl = ap.gl_ap_cents;   // credit-normal: positive = payable
  const diff = gl == null ? null : open - gl;
  out.push(control('AP-01', 'Bills (AP)', `GL ${ap.ap_account_number || '2000'} ties open AP invoices`, gl != null && diff === 0 ? PASS : BLOCK, {
    amount_cents: diff, count: (ap.open_rows || []).length,
    explanation: gl == null ? 'This community has no AP GL account, so open invoices cannot be tied.'
      : diff === 0 ? `${(ap.open_rows || []).length} open ${(ap.open_rows || []).length === 1 ? 'invoice' : 'invoices'} total ${$(open)}, equal to GL ${ap.ap_account_number} at period end.`
        : `Open invoices total ${$(open)} but GL ${ap.ap_account_number} is ${$(gl)} at period end: difference ${$(diff)}.`,
    drill: L.ap, action: 'Find the invoice whose accrual or payment entry is missing, duplicated or dated differently. Do not post to make it tie.',
    evidence: { open, gl, diff, n: (ap.open_rows || []).length },
  }));
  const held = ap.held || [];
  out.push(control('AP-02', 'Bills (AP)', 'Held and exception invoices identified', held.length ? WARNING : PASS, {
    count: held.length, amount_cents: sum(held, 'total_cents'),
    explanation: held.length ? `${held.length} ${held.length === 1 ? 'invoice is' : 'invoices are'} on hold, disputed or flagged for review: ${held.slice(0, 6).map((h) => `${h.vendor || 'vendor'} #${h.vendor_invoice_number || '?'} ${$(h.total_cents)} (${String(h.status).replace(/_/g, ' ')})`).join('; ')}.` : 'No invoice is on hold, disputed or flagged for review.',
    drill: L.bills, action: 'Resolve or document each before the month is presented as final.',
    evidence: { held: held.map((h) => [h.id, h.status, h.total_cents]) },
  }));
  return out;
}

// --------------------------------------------------------------------- Recognition
function recognitionControls(rec, f, L) {
  const out = [];
  const behind = (rec.schedules || []).filter((s) => s.status && s.status.overdue);
  const missingCents = behind.reduce((x, s) => x + Number(s.status.missing_cents || 0), 0);
  out.push(control('REC-01', 'Recognition', 'Every recognition due through period end is posted', behind.length ? BLOCK : PASS, {
    count: behind.length, amount_cents: missingCents,
    explanation: behind.length ? `${behind.length} ${behind.length === 1 ? 'schedule is' : 'schedules are'} behind through ${monthLabel(f.period_end)} (${$(missingCents)} not posted): ${behind.slice(0, 6).map((s) => `${s.description} (${s.status.missing_months.map((m) => m.slice(0, 7)).join(', ')})`).join('; ')}.`
      : `All ${(rec.schedules || []).length} active recognition ${(rec.schedules || []).length === 1 ? 'schedule is' : 'schedules are'} posted through ${monthLabel(f.period_end)}.`,
    drill: L.trial, action: 'Post the due recognition for each missing month (deferred assessments, prepaid insurance and other schedules). Only the owner can close with this outstanding.',
    evidence: { behind: behind.map((s) => [s.id, s.status.missing_months, s.status.missing_cents]) },
  }));
  return out;
}

// --------------------------------------------------------------------- Cutoff review
// Ed 2026-10-12 (lib/close/policy.js): accrual basis; Kat's month-end cutoff review.
const billLabel = (b) => `${b.vendor} #${b.invoice_number || '?'} ${$(b.total_cents)}${b.service_period_start || b.service_period_end ? ` (service ${b.service_period_start || '?'} to ${b.service_period_end || '?'})` : ` (invoice ${b.invoice_date})`}`;

function cutoffControls(cut, f, L) {
  const out = [];
  if (!cut) return out;
  const late = cut.late_bills || [];
  const unbooked = late.filter((b) => !b.posting_date);
  const booked = late.filter((b) => b.posting_date);
  const proposals = late.map((b) => ({ bill_id: b.id, kind: b.posting_date ? 'move_accrual_to_incurred_month' : 'accrue_in_incurred_month', amount_cents: b.total_cents, posting_date: f.period_end,
    text: b.posting_date
      ? `${billLabel(b)} was booked ${b.posting_date}${b.journal_reference ? ` (${b.journal_reference})` : ''}; recognize it in ${monthLabel(f.period_end)}: accrue it dated ${f.period_end} (Dr its expense account / Cr accounts payable) and take it out of the later month, through the bill correction workflow (a correcting entry; the original entry stays).`
      : `${billLabel(b)} is ${String(b.status || 'not booked').replace(/_/g, ' ')} and not yet booked; when approved, book it dated in ${monthLabel(f.period_end)}, not the month it arrived.` }));
  out.push(control('CUT-01', 'Cutoff review', 'Expenses recorded in the period incurred (late-arriving bills evaluated)', unbooked.length ? BLOCK : booked.length ? WARNING : PASS, {
    count: late.length, amount_cents: sum(late, 'total_cents'),
    explanation: !late.length ? `Every bill for service in ${monthLabel(f.period_end)} is booked in ${monthLabel(f.period_end)}.`
      : `${late.length} ${late.length === 1 ? 'bill' : 'bills'} for ${monthLabel(f.period_end)} ${late.length === 1 ? 'is' : 'are'} booked later or not yet booked (${$(sum(late, 'total_cents'))}): ${late.slice(0, 6).map((b) => `${billLabel(b)}${b.posting_date ? ` booked ${b.posting_date}` : ' not booked'}`).join('; ')}${late.length > 6 ? '; ...' : ''}.`,
    drill: L.bills, action: 'Recognize each in the month incurred (Kat\'s proposals in the readiness report), or record why it belongs to the later month. Kat posts nothing.',
    evidence: { late: late.map((b) => [b.id, b.total_cents, b.posting_date, b.service_period_end || b.invoice_date]), proposals },
  }));

  const runs = (cut.interest && cut.interest.runs) || [];
  const run = runs[0] || null;
  let st = PASS; let expl; let act = null;
  if (!cut.interest || !cut.interest.enabled) {
    st = cut.homeowner_ledger ? WARNING : PASS;
    expl = cut.homeowner_ledger ? 'No monthly delinquent-interest process is set up for this community; confirm no interest is due for the month under its collection policy.' : 'No homeowner ledger: no delinquent interest applies.';
    act = 'Set up the interest run (Kat) or record that the collection policy charges none.';
  } else if (!run) { st = BLOCK; expl = `No delinquent-interest run exists for ${monthLabel(f.period_end)}.`; act = 'Have Kat prepare the month\'s interest run, then approve it in Kat\'s accounting runs.'; }
  else if (run.status === 'posted') expl = `Delinquent interest for ${monthLabel(f.period_end)} is posted (${run.journal_reference || 'run ' + run.id.slice(0, 8)}): ${run.totals.owners || 0} owners.`;
  else {
    st = BLOCK;
    const t = run.totals || {};
    expl = `The ${monthLabel(f.period_end)} interest run is ${run.status}${run.held_reason ? ` (${run.held_reason})` : ''}: ${$(t.clean_interest_cents || 0)} for ${t.clean_owners || 0} owners ready, ${$(t.exception_interest_cents || 0)} for ${t.exception_owners || 0} held exception owners. Interest is not recognized in the month until it is approved and posted.`;
    act = 'Review and approve (or hold with a reason) the interest run in Kat\'s accounting runs. Assessment revenue recognition is checked by REC-01 and DATA-01.';
  }
  out.push(control('CUT-02', 'Cutoff review', 'Delinquent assessment interest recognized in the period', st, {
    count: run ? (run.totals.owners || 0) : 0, amount_cents: run ? (run.totals.interest_cents || 0) : null, explanation: expl, drill: L.owners, action: act,
    evidence: { enabled: !!(cut.interest && cut.interest.enabled), run: run ? [run.id, run.status, run.totals.interest_cents || 0, run.totals.clean_interest_cents || 0] : null },
  }));

  const pre = cut.prepaid_bills || [];
  out.push(control('CUT-03', 'Cutoff review', 'Prepaid expenses not expensed early', pre.length ? WARNING : PASS, {
    count: pre.length, amount_cents: sum(pre, 'total_cents'),
    explanation: pre.length ? `${pre.length} ${pre.length === 1 ? 'bill' : 'bills'} booked in ${monthLabel(f.period_end)} ${pre.length === 1 ? 'is' : 'are'} for service after it (${$(sum(pre, 'total_cents'))}): ${pre.slice(0, 6).map(billLabel).join('; ')}. If expensed, the expense belongs to the service months (prepaid asset with a recognition schedule).`
      : `No bill booked in ${monthLabel(f.period_end)} is for service entirely after it. Prepaid and deferred balances are checked by DATA-03 and REC-01.`,
    drill: L.bills, action: 'Confirm each was booked to a prepaid account with a recognition schedule, or propose the reclass.',
    evidence: { prepaid: pre.map((b) => [b.id, b.total_cents, b.posting_date, b.service_period_start]) },
  }));
  return out;
}

function interfundControls(inter, L) {
  if (!inter) return [];
  if (inter.error) return [control('IF-01', 'Interfund', 'Interfund balances mirror between funds', BLOCK, { explanation: `The interfund accounts could not be read: ${inter.error}`, drill: L.trial, action: 'Fix the read and run the review again.', evidence: { error: true } })];
  const pairs = inter.pairs || [];
  const bad = pairs.filter((p) => p.fund_owes_operating_cents !== p.operating_owed_cents);
  const unresolved = inter.unresolved || [];
  const status = bad.length ? BLOCK : unresolved.length ? WARNING : PASS;
  const owes = (p) => (p.fund_owes_operating_cents >= 0 ? `${p.fund_name || p.fund_code} owes Operating ${$(p.fund_owes_operating_cents)}` : `Operating owes ${p.fund_name || p.fund_code} ${$(-p.fund_owes_operating_cents)}`);
  return [control('IF-01', 'Interfund', 'Interfund balances mirror between funds and transfers are classified', status, {
    count: pairs.length, amount_cents: bad.length ? sum(bad.map((p) => ({ d: p.fund_owes_operating_cents - p.operating_owed_cents })), 'd') : null,
    explanation: !inter.applies ? 'Single-fund community: no interfund balances.'
      : bad.length ? `Due To / Due From do not mirror: ${bad.map((p) => `${p.fund_code} shows ${$(p.fund_owes_operating_cents)} owed to Operating but Operating shows ${$(p.operating_owed_cents)}`).join('; ')}.`
        : `${pairs.length ? pairs.map(owes).join('; ') : 'No interfund balances'}${pairs.length ? ' (each side agrees)' : ''}.${unresolved.length ? ` Interfund accounts are incomplete for ${unresolved.join(', ')}, so those funds cannot be reconciled.` : ''} Transfers are presented below net income and offset association-wide (statement model); unsettled balances stay as Due To / Due From until a documented transfer settles them.`,
    drill: L.trial, action: bad.length ? 'Find the entry that booked one side only. Do not post to make it tie.' : 'Complete the interfund accounts for the listed funds.',
    evidence: { pairs: pairs.map((p) => [p.fund_code, p.fund_owes_operating_cents, p.operating_owed_cents]), unresolved },
  })];
}

// --------------------------------------------------------------------- Conversion
function conversionControls(conv, L) {
  const out = [];
  const g = conv.gate || {};
  out.push(control('CONV-01', 'Conversion', 'Community onboarded; books kept in trustEd', g.allowed ? PASS : BLOCK, {
    explanation: g.allowed ? (g.basis === 'demo' ? 'Demo community (synthetic data).' : `Conversion ${g.conversion || ''} is posted and the books are kept in trustEd.`.replace('  ', ' ')) : (g.reason || 'This community is not onboarded.'),
    drill: L.tieout, action: 'Complete the community\'s onboarding conversion before closing its months.',
    evidence: { allowed: !!g.allowed, basis: g.basis || null },
  }));
  const items = conv.open_items || [];
  out.push(control('CONV-02', 'Conversion', 'Conversion reconciling items disclosed', items.length ? WARNING : PASS, {
    count: items.length, amount_cents: sum(items, 'amount_cents'),
    explanation: items.length ? `${items.length} conversion reconciling ${items.length === 1 ? 'item remains' : 'items remain'} open and will be disclosed: ${items.slice(0, 6).map((i) => `${i.kind.replace(/_/g, ' ')} ${i.account_number || ''} ${$(i.amount_cents)}`).join('; ')}.` : 'No open conversion reconciling items.',
    drill: L.tieout, action: 'Resolve each item with a note (and an entry if needed), or accept it as a disclosed reconciling item.',
    evidence: { items: items.map((i) => [i.id, i.amount_cents]) },
  }));
  return out;
}

// --------------------------------------------------------------------- Data completeness
// Required source activity must be complete through period end. Each required
// source is its own control so an override names exactly what was missing.
function dataControls(src, bank, rec, f, L) {
  const out = [];
  const end = String(f.period_end); const start = String(f.period_start);
  const req = (key) => (src.requirements || []).filter((r) => r.source_key === key);
  const isOff = (key) => req(key).some((r) => r.required === false);

  // Homeowner billing/receipt feed.
  const ho = src.homeowner || {};
  if (!ho.applies || isOff('homeowner_feed')) {
    out.push(control('DATA-01', 'Data completeness', 'Homeowner billing and receipt feed complete', PASS, {
      explanation: !ho.applies ? 'This community has no homeowner ledger, so no homeowner feed is required.' : `Not required for this community: ${req('homeowner_feed').find((r) => r.required === false).set_reason}`,
      evidence: { applies: !!ho.applies, off: isOff('homeowner_feed') },
    }));
  } else {
    const covering = (ho.batches || []).filter((b) => b.status === 'committed' && b.source_format !== 'manual' && String(b.as_of_date) >= end);
    const native = ho.mode === 'native';
    const nativeOk = native && Number(ho.assessment_revenue_cents || 0) !== 0 && Number(ho.receipt_entries || 0) > 0;
    const ok = covering.length > 0 || nativeOk;
    const latest = (ho.batches || []).filter((b) => b.status === 'committed' && b.source_format !== 'manual').map((b) => String(b.as_of_date)).sort().pop() || null;
    out.push(control('DATA-01', 'Data completeness', 'Homeowner billing and receipt feed complete', ok ? PASS : BLOCK, {
      explanation: ok ? (covering.length ? `The homeowner ledger import ${covering[0].period_label || ''} covers through ${dayLabel(covering[0].as_of_date)}.`.replace('  ', ' ')
        : `trustEd bills and receives natively: ${$(ho.assessment_revenue_cents)} assessment revenue and ${ho.receipt_entries} receipt ${Number(ho.receipt_entries) === 1 ? 'entry' : 'entries'} posted in ${monthLabel(end)}.`)
        : native ? `Homeowner activity is incomplete for ${monthLabel(end)}: ${Number(ho.assessment_revenue_cents || 0) === 0 ? 'no assessment revenue is posted' : `${$(ho.assessment_revenue_cents)} assessment revenue posted`}, ${Number(ho.receipt_entries || 0)} homeowner receipt ${Number(ho.receipt_entries) === 1 ? 'entry' : 'entries'}.`
          : `No homeowner billing/receipt feed covers ${monthLabel(end)}. ${latest ? `The latest full homeowner ledger import is as of ${dayLabel(latest)}.` : 'No full homeowner ledger import exists.'} Manual one-off rows and the conversion opening balances are not a feed.`,
      drill: L.owners, action: 'Load the homeowner billing and receipts for the month (or switch the community to native billing once the permanent feed is live). Without it, receivables and revenue are incomplete.',
      evidence: { covering: covering.map((b) => b.id), native, rev: ho.assessment_revenue_cents || 0, receipts: ho.receipt_entries || 0, latest },
    }));
  }

  // Bank and investment statements.
  const accts = (bank.accounts || []).filter((a) => a.is_active !== false);
  if (isOff('bank_statements')) {
    out.push(control('DATA-02', 'Data completeness', 'Bank and investment statements received', PASS, { explanation: `Not required: ${req('bank_statements').find((r) => r.required === false).set_reason}`, evidence: { off: true } }));
  } else {
    const has = (a) => (bank.statements || []).some((s) => s.bank_account_id === a.id && s.status === 'completed'
      && String(s.statement_period_end) >= start && String(s.statement_period_end) <= end);
    const missing = accts.filter((a) => !has(a));
    out.push(control('DATA-02', 'Data completeness', 'Bank and investment statements received', !accts.length ? BLOCK : missing.length ? BLOCK : PASS, {
      count: missing.length,
      explanation: !accts.length ? 'No bank or investment accounts are set up, so no statement can be confirmed.'
        : missing.length ? `${missing.length} of ${accts.length} accounts have no statement for ${monthLabel(end)}: ${missing.map((a) => `${a.account_nickname}${a.account_last4 ? ` ••${a.account_last4}` : ''}`).join('; ')}.`
          : `A completed statement for ${monthLabel(end)} is on file for all ${accts.length} accounts.`,
      drill: L.bankrec, action: 'Upload each missing statement (bank and investment).',
      evidence: { missing: missing.map((a) => a.id), n: accts.length },
    }));
  }

  // Recognition schedules back every deferred/prepaid balance.
  if (isOff('recognition')) {
    out.push(control('DATA-03', 'Data completeness', 'Deferred and prepaid balances have schedules', PASS, { explanation: `Not required: ${req('recognition').find((r) => r.required === false).set_reason}`, evidence: { off: true } }));
  } else {
    const bare = (rec.balance_accounts || []).filter((b) => Number(b.gl_balance_cents || 0) !== 0 && !b.has_schedule);
    out.push(control('DATA-03', 'Data completeness', 'Deferred and prepaid balances have schedules', bare.length ? BLOCK : PASS, {
      count: bare.length, amount_cents: sum(bare, 'gl_balance_cents'),
      explanation: bare.length ? `${bare.length} deferred or prepaid ${bare.length === 1 ? 'balance has' : 'balances have'} no active recognition schedule at ${dayLabel(end)}: ${bare.map((b) => `${b.account_number} ${b.account_name} ${$(b.gl_balance_cents)}`).join('; ')}.`
        : 'Every deferred-revenue and prepaid balance at period end is backed by an active recognition schedule.',
      drill: L.trial, action: 'Set up the recognition schedule for each balance (what it is, its term) so the month recognizes it.',
      evidence: { bare: bare.map((b) => [b.account_number, b.gl_balance_cents]) },
    }));
  }

  // AP feed: bills received but not booked.
  if (isOff('ap_feed')) {
    out.push(control('DATA-04', 'Data completeness', 'Every bill received is booked', PASS, { explanation: `Not required: ${req('ap_feed').find((r) => r.required === false).set_reason}`, evidence: { off: true } }));
  } else {
    const pend = (src.ap_exceptions || []);
    out.push(control('DATA-04', 'Data completeness', 'Every bill received is booked', pend.length ? BLOCK : PASS, {
      count: pend.length, amount_cents: sum(pend, 'total_cents'),
      explanation: pend.length ? `${pend.length} ${pend.length === 1 ? 'bill was' : 'bills were'} received but not booked (intake exceptions dated on/before ${dayLabel(end)}): ${pend.slice(0, 6).map((p) => `${p.vendor_name || 'unknown vendor'} ${p.invoice_number ? `#${p.invoice_number} ` : ''}${$(p.total_cents)} (${String(p.reason).replace(/_/g, ' ')})`).join('; ')}.`
        : 'No bill received through period end is waiting in AP intake exceptions.',
      drill: L.bills, action: 'Resolve each intake exception (assign community and vendor) so the bill is booked in its month.',
      evidence: { pend: pend.map((p) => [p.id, p.total_cents]) },
    }));
    const gaps = src.recurring_gaps || [];
    if (gaps.length) {
      out.push(control('DATA-05', 'Data completeness', 'Recurring vendors billed this month', WARNING, {
        count: gaps.length,
        explanation: `${gaps.length} ${gaps.length === 1 ? 'vendor that bills' : 'vendors that bill'} every month ${gaps.length === 1 ? 'has' : 'have'} no invoice dated in ${monthLabel(end)}: ${gaps.slice(0, 8).map((g) => g.vendor).join('; ')}.`,
        drill: L.bills, action: 'Confirm each bill was not received, or accrue it.',
        evidence: { gaps: gaps.map((g) => g.vendor_id) },
      }));
    }
  }

  // Other configured required sources: each needs evidence for the period.
  for (const r of req('other').filter((x) => x.required !== false)) {
    const ev = (src.other_evidence || []).filter((e) => e.requirement_id === r.id);
    out.push(control(`DATA-OTHER-${r.id.slice(0, 8)}`, 'Data completeness', `${r.label} received`, ev.length ? PASS : BLOCK, {
      count: ev.length,
      explanation: ev.length ? `${r.label} for ${monthLabel(end)} provided by ${ev[0].provided_by} (${ev[0].document_ref}).` : `${r.label} for ${monthLabel(end)} has not been provided.`,
      drill: null, action: `Provide the ${r.label} for the month.`,
      evidence: { ev: ev.map((e) => e.id) },
    }));
  }
  return out;
}

/**
 * Evaluate the whole checklist from gathered facts.
 * @returns {{ results: object[], summary: {pass, warning, block, total}, engine_version }}
 */
function evaluateClose(input) {
  const f = input.facts;
  const L = links(input.community.id, f.period_end);
  const results = [
    ...glControls(f, L),
    ...cashControls(input.bank || {}, f, L),
    ...arControls(input.ar, L),
    ...apControls(input.ap || {}, L),
    ...recognitionControls(input.recognition || {}, f, L),
    ...cutoffControls(input.cutoff ? { ...input.cutoff, homeowner_ledger: !!(input.sources && input.sources.homeowner && input.sources.homeowner.applies) } : null, f, L),
    ...interfundControls(input.interfund, L),
    ...conversionControls(input.conversion || {}, L),
    ...dataControls(input.sources || {}, input.bank || {}, input.recognition || {}, f, L),
  ];
  const summary = { pass: 0, warning: 0, block: 0, total: results.length };
  for (const r of results) summary[r.status.toLowerCase()] += 1;
  return { results, summary, engine_version: ENGINE_VERSION };
}

module.exports = { evaluateClose, ENGINE_VERSION, STALE_CHECK_DAYS, hash, _test: { glControls, cashControls, arControls, apControls, recognitionControls, conversionControls, dataControls, cutoffControls, interfundControls } };
