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

// Every prior EXPENSE debit for this vendor in this community: { date, cents }.
async function vendorHistory({ vendorId, vendorName, communityId }) {
  const out = [];
  const seen = new Set();
  const push = (date, cents) => {
    if (!date || !cents || cents <= 0) return;
    const k = `${String(date).slice(0, 10)}|${cents}`;
    if (seen.has(k)) return;               // same posting reached via two paths
    seen.add(k);
    out.push({ date: String(date).slice(0, 10), cents });
  };

  // Only expense accounts — the AP and cash legs carry the vendor's name too and
  // would double every month.
  const { data: coa } = await supabase.from('chart_of_accounts')
    .select('id, account_type').eq('community_id', communityId);
  const expense = new Set((coa || []).filter((a) => a.account_type === 'expense').map((a) => a.id));
  if (!expense.size) return out;

  const collect = (rows) => (rows || []).forEach((l) => {
    if (expense.has(l.account_id)) push(l.journal_entries && l.journal_entries.posting_date, l.debit_cents);
  });

  if (vendorId) {
    const { data } = await supabase.from('journal_entry_lines')
      .select('account_id, debit_cents, journal_entries!inner(community_id, posting_date)')
      .eq('vendor_id', vendorId).eq('journal_entries.community_id', communityId).gt('debit_cents', 0).limit(500);
    collect(data);
  }
  // Same progressive matching the classifier uses (full name -> first two words
  // -> distinctive first word), stopping at the first term that finds history.
  if (!out.length) {
    for (const term of vendorSearchTerms(vendorName || '')) {
      const like = `%${term}%`;
      const [{ data: a }, { data: b }] = await Promise.all([
        supabase.from('journal_entry_lines')
          .select('account_id, debit_cents, journal_entries!inner(community_id, posting_date)')
          .eq('journal_entries.community_id', communityId).gt('debit_cents', 0).ilike('memo', like).limit(500),
        supabase.from('journal_entry_lines')
          .select('account_id, debit_cents, journal_entries!inner(community_id, posting_date, description)')
          .eq('journal_entries.community_id', communityId).gt('debit_cents', 0).ilike('journal_entries.description', like).limit(500),
      ]);
      collect(a); collect(b);
      if (out.length) break;
    }
  }
  return out;
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
async function getRecurrenceProfile({ vendorId, vendorName, communityId, totalCents } = {}) {
  const none = { recurring: false, cadence: null, occurrences: 0, months_covered: 0, typical_cents: null, last_seen: null, amount_flag: null, variance_pct: null, summary: null };
  if (!communityId || (!vendorId && !vendorName)) return none;
  try {
    const hist = await vendorHistory({ vendorId, vendorName, communityId });
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

    // Is THIS one like the others? Only answerable when the comparison is
    // like-for-like — otherwise say nothing rather than something wrong.
    let amountFlag = null, variancePct = null;
    if (recurring && oneBillPerMonth && typical > 0 && Number.isFinite(totalCents) && totalCents > 0) {
      variancePct = Math.round(((totalCents - typical) / typical) * 100);
      if (variancePct >= 25) amountFlag = 'high';
      else if (variancePct <= -25) amountFlag = 'low';
      else amountFlag = 'normal';
    }

    const dollars = (c) => '$' + (c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    let summary = null;
    if (recurring) {
      summary = `Recurring ${cadence} — ${monthsCovered} prior month${monthsCovered === 1 ? '' : 's'} on this community's books`;
      summary += oneBillPerMonth ? `, typically ${dollars(typical)} (last ${lastSeen}).` : `, about ${dollars(typical)}/month across multiple bills (last ${lastSeen}).`;
      if (amountFlag === 'high') summary += ` This one is ${variancePct}% ABOVE the usual — worth a look before releasing.`;
      else if (amountFlag === 'low') summary += ` This one is ${Math.abs(variancePct)}% below the usual.`;
    }
    return { recurring, cadence, occurrences: hist.length, months_covered: monthsCovered, typical_cents: typical, last_seen: lastSeen, one_bill_per_month: oneBillPerMonth, amount_flag: amountFlag, variance_pct: variancePct, summary };
  } catch (e) {
    console.warn('[ap/recurring] profile failed:', e.message);
    return none;
  }
}

module.exports = { getRecurrenceProfile };
