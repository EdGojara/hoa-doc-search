// ============================================================================
// lib/ap/recurring.js  (Ed 2026-07-15)
// ----------------------------------------------------------------------------
// "Or it's a regular expense that is recurring like landscaping — system should
// flag as recurring monthly expense." (Ed)
//
// Not every invoice deserves the same scrutiny. A first-time vendor asking for
// $11k and the 9th identical monthly landscaping bill are different risks, and
// treating them the same is how approval becomes rubber-stamping. So: read the
// community's own ledger and say plainly what this bill IS.
//
// The real payoff isn't "this is recurring" — it's "this recurring bill is NOT
// like the others." A landscaping invoice that runs $1,200 every month and
// shows up at $3,400 is exactly what Ed would catch by eye. The system has to
// catch it first, or the platform is just a faster way to approve a wrong
// number (encode-Ed lens).
//
// Reads the SAME history the GL classifier learns coding from, matched by the
// same coreVendorName, so "recurring" and "auto-coded" never disagree about
// which vendor this is.
// ============================================================================
const { createClient } = require('@supabase/supabase-js');
const { vendorSearchTerms } = require('../accounting/gl_classifier');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const median = (xs) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

// Every prior BILL from this vendor in this community: { date, cents, memos }.
//
// One bill = one journal entry. This used to return one row per expense LINE,
// so a weekly Star Protection bill posted as four lines (hours, supervisor,
// phone, sales tax) read as four "bills" and the profile told Ed it was
// "typically $326.01 per bill" (the median line) against a $4,275 bill. Every
// amount comparison downstream was against the wrong number. (Ed 2026-10-15.)
// excludeJournalEntryId: the bill being judged never counts as its own precedent
// (CLAUDE.md, "never let a record cite itself").
async function vendorHistory({ vendorId, vendorName, communityId, excludeJournalEntryId = null }) {
  const bills = new Map();   // journal_entry_id -> { date, cents, memos }
  const seenLine = new Set();
  // Only expense accounts: the AP and cash legs carry the vendor's name too and
  // would double every month.
  const { data: coa } = await supabase.from('chart_of_accounts')
    .select('id, account_type').eq('community_id', communityId);
  const expense = new Set((coa || []).filter((a) => a.account_type === 'expense').map((a) => a.id));
  if (!expense.size) return [];

  const collect = (rows) => (rows || []).forEach((l) => {
    if (!expense.has(l.account_id)) return;
    const je = l.journal_entry_id || null;
    if (excludeJournalEntryId && je === excludeJournalEntryId) return;
    const date = l.journal_entries && l.journal_entries.posting_date;
    if (!date || !l.debit_cents || l.debit_cents <= 0) return;
    const lineKey = l.id || `${je}|${date}|${l.debit_cents}|${l.memo || ''}`;
    if (seenLine.has(lineKey)) return;      // same line reached via two paths
    seenLine.add(lineKey);
    const key = je || `${String(date).slice(0, 10)}|${l.debit_cents}`;
    const b = bills.get(key) || { date: String(date).slice(0, 10), cents: 0, memos: [] };
    b.cents += l.debit_cents;
    if (l.memo) b.memos.push(String(l.memo));
    bills.set(key, b);
  });

  const SEL = 'id, journal_entry_id, account_id, debit_cents, memo, journal_entries!inner(community_id, posting_date)';
  if (vendorId) {
    const { data } = await supabase.from('journal_entry_lines')
      .select(SEL)
      .eq('vendor_id', vendorId).eq('journal_entries.community_id', communityId).gt('debit_cents', 0).limit(500);
    collect(data);
  }
  // Same progressive matching the classifier uses (full name -> first two words
  // -> distinctive first word), stopping at the first term that finds history.
  if (!bills.size) {
    for (const term of vendorSearchTerms(vendorName || '')) {
      const like = `%${term}%`;
      const [{ data: a }, { data: b }] = await Promise.all([
        supabase.from('journal_entry_lines')
          .select(SEL)
          .eq('journal_entries.community_id', communityId).gt('debit_cents', 0).ilike('memo', like).limit(500),
        supabase.from('journal_entry_lines')
          .select('id, journal_entry_id, account_id, debit_cents, memo, journal_entries!inner(community_id, posting_date, description)')
          .eq('journal_entries.community_id', communityId).gt('debit_cents', 0).ilike('journal_entries.description', like).limit(500),
      ]);
      collect(a); collect(b);
      if (bills.size) break;
    }
  }
  return [...bills.values()];
}

// What this vendor's prior bills on this community SAID: their line
// descriptions (ap_invoice_lines) and posted memos. Feeds the description test.
async function priorBillTexts({ vendorId, communityId, excludeInvoiceId = null, hist = [] }) {
  // Grouped per prior BILL, so precedent can be counted in bills, not lines.
  // The vendor's own ap_invoice_lines are the bills when we have them; the
  // posted memos stand in only for history that never went through intake
  // (the same bill is never counted from both).
  const bills = [];
  if (vendorId) {
    let q = supabase.from('ap_invoices').select('id, ap_invoice_lines(description)')
      .eq('community_id', communityId).eq('vendor_id', vendorId).neq('status', 'voided')
      .order('invoice_date', { ascending: false }).limit(60);
    if (excludeInvoiceId) q = q.neq('id', excludeInvoiceId);
    const { data, error } = await q;
    if (error) console.warn('[ap/recurring] prior bill lines unavailable:', error.message);
    for (const inv of data || []) {
      const t = (inv.ap_invoice_lines || []).map((l) => l.description).filter(Boolean);
      if (t.length) bills.push(t);
    }
  }
  if (!bills.length) hist.forEach((h) => { if ((h.memos || []).length) bills.push(h.memos); });
  return bills;
}

/**
 * What IS this bill, per the community's own books?
 * @returns {{
 *   recurring: boolean, cadence: 'monthly'|'quarterly'|'irregular'|null,
 *   occurrences: number, months_covered: number, typical_cents: number|null,
 *   last_seen: string|null, amount_flag: 'normal'|'high'|'low'|null,
 *   variance_pct: number|null, summary: string|null
 * }}
 */
async function getRecurrenceProfile({ vendorId, vendorName, communityId, totalCents, lines = null, accountNumber = null, excludeInvoiceId = null, excludeJournalEntryId = null } = {}) {
  const none = { recurring: false, cadence: null, occurrences: 0, months_covered: 0, typical_cents: null, last_seen: null, amount_flag: null, variance_pct: null, summary: null };
  if (!communityId || (!vendorId && !vendorName)) return none;
  try {
    const hist = await vendorHistory({ vendorId, vendorName, communityId, excludeJournalEntryId });
    if (hist.length < 3) return { ...none, occurrences: hist.length };

    // Group by month for CADENCE. Keep the per-month posting count too: if a
    // vendor bills several times a month, comparing ONE invoice against the
    // month's TOTAL is apples-to-oranges and produces a confidently wrong
    // verdict (GreenScape's normal $6,164 bill read "25% below usual" against
    // an $8,219 monthly total). Only judge the amount when the history is
    // genuinely one-bill-per-month.
    const byMonth = new Map();
    const countByMonth = new Map();
    for (const h of hist) {
      const mo = h.date.slice(0, 7);
      byMonth.set(mo, (byMonth.get(mo) || 0) + h.cents);
      countByMonth.set(mo, (countByMonth.get(mo) || 0) + 1);
    }
    const oneBillPerMonth = [...countByMonth.values()].every((n) => n === 1);
    const months = [...byMonth.keys()].sort();
    const monthsCovered = months.length;
    if (monthsCovered < 3) return { ...none, occurrences: hist.length };

    // Monthly = it shows up in most of the months it spans. (Gaps happen —
    // a skipped month shouldn't demote a 10-month landscaping contract.)
    const span = (Number(months[months.length - 1].slice(0, 4)) * 12 + Number(months[months.length - 1].slice(5, 7)))
               - (Number(months[0].slice(0, 4)) * 12 + Number(months[0].slice(5, 7))) + 1;
    const density = monthsCovered / Math.max(span, 1);
    const cadence = density >= 0.6 ? 'monthly' : (monthsCovered >= 3 && density >= 0.25 ? 'quarterly' : 'irregular');
    const recurring = cadence === 'monthly' || cadence === 'quarterly';

    const amounts = [...byMonth.values()];
    const typical = median(amounts);
    const lastSeen = months[months.length - 1];

    // Is THIS bill like the others? Compare against INDIVIDUAL prior bills —
    // one invoice posts one journal entry (vendorHistory sums its expense
    // lines), so bill-to-bill is the like-for-like comparison. (Comparing one invoice to a MONTH'S TOTAL called
    // GreenScape's normal $6,164 bill "25% below usual" against an $8,219
    // multi-bill month. Wrong question.)
    let postings = hist.map((h) => h.cents).sort((a, b) => a - b);
    // A vendor billing several ACCOUNTS (a MUD's seven meters, an electric
    // provider's five) is judged against the same account's prior bills: a $39
    // meter and a $1,218 meter are both normal, just not for each other.
    let byAccount = null;
    if (accountNumber && vendorId) {
      let q = supabase.from('ap_invoices').select('id, total_cents')
        .eq('community_id', communityId).eq('vendor_id', vendorId).eq('account_number', accountNumber).neq('status', 'voided')
        .order('invoice_date', { ascending: false }).limit(60);
      if (excludeInvoiceId) q = q.neq('id', excludeInvoiceId);
      const { data: acct, error: aerr } = await q;
      if (aerr) console.warn('[ap/recurring] account history unavailable:', aerr.message);
      const amts = (acct || []).map((r) => Number(r.total_cents)).filter((c) => c > 0);
      if (amts.length >= 2) { postings = amts.sort((a, b) => a - b); byAccount = accountNumber; }
    }
    const perBill = median(postings);

    let amountFlag = null, variancePct = null, amountPrecedent = 0;
    if (recurring && perBill > 0 && Number.isFinite(totalCents) && totalCents > 0) {
      const diff = totalCents - perBill;
      variancePct = Math.round((diff / perBill) * 100);
      // MATERIALITY FLOOR. A $79 swing on a $127 security bill is not a finding;
      // demanding a second signature over it is exactly how a control becomes
      // ridiculous and teaches people to click through. Percentage alone flags
      // noise on small bills. Ed wouldn't blink at $127 -> $206; he WOULD blink
      // at landscaping going $6k -> $20k. (project_risk_proportionate_controls.)
      const MATERIALITY_CENTS = 25000;   // $250 — below this, the % doesn't matter
      // ALSO NORMAL if this amount simply isn't unusual for this vendor: a
      // variable biller (utilities, multi-meter) legitimately swings, and having
      // billed about this much before IS the evidence. "About this much" means a
      // prior bill within 10%, not "somewhere between the 10th and 90th
      // percentile": Star's $58 patrol add-ons stretched that range down so far
      // that a half-size $2,459.84 weekly bill (usual $4,275) read as normal.
      // (Ed 2026-10-15.)
      // PRECEDENT is counted in bills, never one: n=1 is an anecdote (CLAUDE.md,
      // "learning from history"). The vendor's single largest bill is set aside
      // first, so one outlier can't vouch for the next. (PR #207 review.)
      const pool = postings.length >= 3 ? postings.slice(0, -1) : postings;   // postings is sorted ascending
      amountPrecedent = pool.filter((c) => Math.abs(totalCents - c) <= 0.1 * c).length;
      const billedAboutThisBefore = amountPrecedent >= 1;
      if (Math.abs(diff) < MATERIALITY_CENTS || billedAboutThisBefore) amountFlag = 'normal';
      else if (variancePct >= 25) amountFlag = 'high';
      else if (variancePct <= -25) amountFlag = 'low';
      else amountFlag = 'normal';
    }

    const dollars = (c) => '$' + (c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    // Same kind of bill? Only asked when the bill's own lines are known and it
    // would otherwise be judged consistent (lib/ap/bill_pattern).
    let descriptionMatch = null;
    if (recurring && Array.isArray(lines) && lines.length) {
      try {
        const priorBills = await priorBillTexts({ vendorId, communityId, excludeInvoiceId, hist });
        const { data: comm } = await supabase.from('communities').select('name').eq('id', communityId).maybeSingle();
        descriptionMatch = require('./bill_pattern').descriptionMatch({
          lines, priorTexts: priorBills.flat(), priorBills, ignoreText: `${(comm && comm.name) || ''} ${vendorName || ''}`,
        });
      } catch (e) { console.warn('[ap/recurring] description check skipped:', e.message); }
    }

    let summary = null;
    if (recurring) {
      summary = `Recurring ${cadence} — ${monthsCovered} prior month${monthsCovered === 1 ? '' : 's'} on this community's books, typically ${dollars(perBill)} per bill${byAccount ? ` on account ${byAccount}` : ''} (last ${lastSeen}).`;
      if (amountFlag === 'high') summary += ` This one is ${variancePct}% ABOVE the usual — worth a look before releasing.`;
      else if (amountFlag === 'low') summary += ` This one is ${Math.abs(variancePct)}% below the usual.`;
      if (descriptionMatch && descriptionMatch.checked && !descriptionMatch.matched) summary += ` But ${descriptionMatch.summary}`;
    }
    return {
      recurring, cadence, occurrences: hist.length, months_covered: monthsCovered,
      typical_cents: perBill, monthly_total_cents: typical, last_seen: lastSeen,
      one_bill_per_month: oneBillPerMonth, amount_flag: amountFlag, variance_pct: variancePct, summary,
      description_match: descriptionMatch, compared_account: byAccount, amount_precedent: amountPrecedent,
    };
  } catch (e) {
    console.warn('[ap/recurring] profile failed:', e.message);
    return none;
  }
}

module.exports = { getRecurrenceProfile, vendorHistory };
