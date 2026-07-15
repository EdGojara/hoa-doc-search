// ============================================================================
// lib/accounting/gl_classifier.js  (Ed 2026-07-11) — Phase 2 of the AI-CPA GL
// ----------------------------------------------------------------------------
// Suggest the GL account for a transaction the way a CPA would: look at how the
// vendor has been coded before, whether it fits the budget, and fall back to
// the description. Returns a suggestion + confidence + a plain "why", plus a
// needs_review flag when it isn't sure or the account isn't budgeted.
//
// Learns from live data with zero extra plumbing:
//   * vendors.default_gl_account_id       — an explicit "always code here"
//   * journal_entry_lines (by vendor_id)  — historical coding. Because Phase 1
//     edits update lines IN PLACE, this history already reflects Ed's
//     corrections, so the classifier compounds every time he fixes one.
//   * budget_line_items                   — budget fit
// Payment/cash legs default to 1000 Operating Cash (feedback_payments_to_operating_cash).
// ============================================================================
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

// The legal-entity suffix ("Associates, LLC" / "Inc." / "Corp") almost never
// appears in a ledger memo — the memo says "GreenScape Associates - ...". Match
// history on the vendor's CORE name (suffix stripped) or it silently finds
// nothing for every vendor with an LLC/Inc/Corp on the invoice. (Ed 2026-07-14.)
function coreVendorName(name) {
  let s = String(name || '').trim();
  const suffix = /[\s,]+(l\.?l\.?c\.?|inc\.?|incorporated|corp\.?|corporation|co\.?|company|ltd\.?|limited|l\.?p\.?|l\.?l\.?p\.?|pllc|p\.?c\.?)\.?\s*$/i;
  for (let i = 0; i < 3 && suffix.test(s); i++) s = s.replace(suffix, '').trim();
  return s.replace(/[\s,]+$/, '').trim();
}

// Ledger-search terms for a vendor, most specific first — full core name, first
// two words, then the distinctive first word. Callers try each until one finds
// history, because a vendor's display name ("Engie Resources Billing") is
// routinely longer than the ledger memo ("Engie").
// Exported so the recurrence profiler answers "is this the same vendor?" the
// SAME way the classifier does. Two copies of this logic drift, and the copy
// that drifts is the one that silently finds nothing and reports "not
// recurring" about a bill that's been paid monthly for two years.
function vendorSearchTerms(name) {
  const core = coreVendorName(name);
  const words = core.split(/\s+/).filter(Boolean);
  const terms = [];
  if (core.length >= 3) terms.push(core);
  if (words.length >= 3) terms.push(words.slice(0, 2).join(' '));
  if (words.length >= 2 && words[0].length >= 4) terms.push(words[0]);
  return [...new Set(terms)].filter((t) => t.length >= 3);
}

async function suggestClassification({ communityId, vendorId, vendorName, description, isPaymentLeg }) {
  if (!communityId) return { account_id: null, confidence: 'low', reason: 'community required', needs_review: true, budget_fit: false };

  const { data: coa } = await supabase.from('chart_of_accounts')
    .select('id, account_number, account_name, account_type, is_summary, is_active')
    .eq('community_id', communityId);
  const accts = (coa || []).filter((a) => a.is_active && !a.is_summary);
  const byId = Object.fromEntries(accts.map((a) => [a.id, a]));
  const findByNum = (n) => accts.find((a) => String(a.account_number) === String(n));
  const shape = (acct, confidence, reason, override) => (acct
    ? { account_id: acct.id, account_number: acct.account_number, account_name: acct.account_name, confidence, reason, needs_review: confidence === 'low', ...override }
    : { account_id: null, confidence: 'low', reason, needs_review: true, ...override });

  // Budget accounts for fit.
  const { data: bud } = await supabase.from('community_budgets').select('id').eq('community_id', communityId).order('fiscal_year', { ascending: false }).limit(1).maybeSingle();
  let budgetAccts = new Set();
  if (bud) { const { data: bl } = await supabase.from('budget_line_items').select('account_id').eq('budget_id', bud.id); budgetAccts = new Set((bl || []).map((x) => x.account_id)); }
  const withFit = (r) => ({ ...r, budget_fit: r.account_id ? budgetAccts.has(r.account_id) : false, needs_review: r.needs_review || (r.account_id ? !budgetAccts.has(r.account_id) && r.confidence !== 'high' : true) });

  // 1) Payment / cash leg -> 1000 Operating Cash.
  if (isPaymentLeg) {
    const cash = findByNum('1000');
    return { ...shape(cash, cash ? 'high' : 'low', cash ? 'Payments default to 1000 Operating Cash.' : 'No 1000 Operating Cash on this chart.'), budget_fit: false, needs_review: !cash };
  }

  // Resolve the vendor.
  let vendor = null;
  if (vendorId) ({ data: vendor } = await supabase.from('vendors').select('id, name, default_gl_account_id').eq('id', vendorId).maybeSingle());
  else if (vendorName) ({ data: vendor } = await supabase.from('vendors').select('id, name, default_gl_account_id').ilike('name', vendorName).maybeSingle());

  // 2) Vendor's explicit default account (only if it lives on THIS community's chart).
  if (vendor && vendor.default_gl_account_id && byId[vendor.default_gl_account_id]) {
    return withFit(shape(byId[vendor.default_gl_account_id], 'high', `${vendor.name} is set to code to this account.`));
  }

  // 3) Vendor history — most-common EXPENSE account on this community's posted
  //    lines. Two signals, because coding lives in two shapes:
  //      (a) journal_entry_lines.vendor_id — the sub-ledger tag (newer postings).
  //      (b) the vendor's name in the line memo or the entry description — how
  //          Vantaca-imported history carries the vendor (no vendor_id tag). This
  //          is where a recurring bill's real coding sits before anyone teaches it.
  //    Only expense accounts count — the AP + cash legs of an accrual/payment
  //    also carry the vendor's name, and must not dilute the vote.
  const vObj = vendor || (vendorName ? { name: vendorName } : null);
  if (vObj && (vObj.id || (vObj.name && vObj.name.length >= 3))) {
    const counts = {};
    const bump = (aid) => { if (byId[aid] && byId[aid].account_type === 'expense') counts[aid] = (counts[aid] || 0) + 1; };
    if (vObj.id) {
      const { data: lns } = await supabase.from('journal_entry_lines')
        .select('account_id, journal_entries!inner(community_id)')
        .eq('vendor_id', vObj.id).eq('journal_entries.community_id', communityId).gt('debit_cents', 0).limit(1000);
      (lns || []).forEach((l) => bump(l.account_id));
    }
    // Name-based history. A vendor's email display name ("Engie Resources
    // Billing") is often longer than the ledger memo ("Engie"), so try
    // progressively shorter terms — full core name, first two words, then the
    // distinctive first word — and stop at the first that finds history. Runs
    // only when the vendor_id tag found nothing (imported/untagged history).
    if (!Object.keys(counts).length) {
      for (const term of vendorSearchTerms(vObj.name)) {
        if (term.length < 3) continue;
        const like = `%${term}%`;
        const [{ data: memoLns }, { data: descLns }] = await Promise.all([
          supabase.from('journal_entry_lines').select('account_id, journal_entries!inner(community_id)')
            .eq('journal_entries.community_id', communityId).gt('debit_cents', 0).ilike('memo', like).limit(1000),
          supabase.from('journal_entry_lines').select('account_id, journal_entries!inner(community_id, description)')
            .eq('journal_entries.community_id', communityId).gt('debit_cents', 0).ilike('journal_entries.description', like).limit(1000),
        ]);
        (memoLns || []).forEach((l) => bump(l.account_id));
        (descLns || []).forEach((l) => bump(l.account_id));
        if (Object.keys(counts).length) break; // found history at this specificity — stop widening
      }
    }
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    if (total > 0) {
      const [bestId, n] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
      const share = n / total;
      const confidence = share >= 0.8 ? 'high' : share >= 0.5 ? 'medium' : 'low';
      return withFit(shape(byId[bestId], confidence, `Coded to this account on ${n} of ${total} prior ${vObj.name} ${total === 1 ? 'entry' : 'entries'} in this community.`));
    }
  }

  // 4) Description keyword -> expense account name.
  if (description) {
    const words = norm(description).split(' ').filter((w) => w.length > 3);
    let best = null, bestScore = 0;
    accts.filter((a) => a.account_type === 'expense').forEach((a) => {
      const an = norm(a.account_name);
      let score = 0; words.forEach((w) => { if (an.includes(w)) score += 1; });
      if (score > bestScore) { bestScore = score; best = a; }
    });
    if (best && bestScore > 0) return withFit({ ...shape(best, 'low', `Guessed from the description — please confirm.`), needs_review: true });
  }

  return { account_id: null, confidence: 'low', reason: 'No confident match — classify manually.', needs_review: true, budget_fit: false };
}

// coreVendorName is exported so the recurrence profiler matches a vendor to its
// ledger history the SAME way the classifier does — one definition of "is this
// the same vendor", not two that drift.
module.exports = { suggestClassification, coreVendorName, vendorSearchTerms };
