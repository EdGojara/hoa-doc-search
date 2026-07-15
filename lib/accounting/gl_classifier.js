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

const median = (xs) => { const a = xs.slice().sort((x, y) => x - y); const m = a.length >> 1; return a.length % 2 ? a[m] : Math.round((a[m - 1] + a[m]) / 2); };
const money = (c) => '$' + (Number(c || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * @param {number|null} totalCents            this bill's amount — AMOUNT IS SIGNAL (see branch 3)
 * @param {string|null} excludeJournalEntryId this invoice's own accrual, so a bill can't cite itself
 */
async function suggestClassification({ communityId, vendorId, vendorName, description, isPaymentLeg, totalCents = null, excludeJournalEntryId = null }) {
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
    // Collect the vendor's expense lines from BOTH signals, deduped by line id.
    // They are complementary, not alternatives: vendor_id tags what we post,
    // the name carries imported history. The old code ran the name search ONLY
    // when the vendor_id tag found nothing — so the first accrual we posted
    // (tagged) SHADOWED all the imported history, and the classifier's evidence
    // got WORSE as we used it while its confidence went UP. (Ed 2026-07-15.)
    const rows = new Map();
    const take = (data) => (data || []).forEach((l) => {
      // A bill must never cite its own accrual as precedent for its own coding.
      if (excludeJournalEntryId && l.journal_entry_id === excludeJournalEntryId) return;
      const a = byId[l.account_id];
      if (!a || a.account_type !== 'expense') return;   // AP/cash legs carry the vendor too — they must not dilute the vote
      rows.set(l.id, l);
    });
    const SEL = 'id, account_id, debit_cents, journal_entry_id, journal_entries!inner(community_id)';
    if (vObj.id) {
      const { data } = await supabase.from('journal_entry_lines').select(SEL)
        .eq('vendor_id', vObj.id).eq('journal_entries.community_id', communityId).gt('debit_cents', 0).limit(1000);
      take(data);
    }
    // Name-based history. A vendor's display name ("Engie Resources Billing") is
    // often longer than the ledger memo ("Engie"), so try progressively shorter
    // terms — full core name, first two words, then the distinctive first word —
    // and stop at the first that ADDS history, so we don't widen into a
    // different vendor once we've found this one.
    if (vObj.name && vObj.name.length >= 3) {
      for (const term of vendorSearchTerms(vObj.name)) {
        if (term.length < 3) continue;
        const like = `%${term}%`;
        const before = rows.size;
        const [{ data: memoLns }, { data: descLns }] = await Promise.all([
          supabase.from('journal_entry_lines').select(SEL)
            .eq('journal_entries.community_id', communityId).gt('debit_cents', 0).ilike('memo', like).limit(1000),
          supabase.from('journal_entry_lines').select('id, account_id, debit_cents, journal_entry_id, journal_entries!inner(community_id, description)')
            .eq('journal_entries.community_id', communityId).gt('debit_cents', 0).ilike('journal_entries.description', like).limit(1000),
        ]);
        take(memoLns); take(descLns);
        if (rows.size > before) break; // found history at this specificity — stop widening
      }
    }

    const all = [...rows.values()];
    if (all.length) {
      const per = {};
      all.forEach((l) => { const p = per[l.account_id] || (per[l.account_id] = { n: 0, amounts: [] }); p.n += 1; p.amounts.push(l.debit_cents); });
      const total = all.length;
      const stats = Object.entries(per).map(([aid, p]) => ({ aid, n: p.n, median: median(p.amounts) })).sort((a, b) => b.n - a.n);
      const top = stats[0];
      let chosen = top, forceReview = false, note = '';

      // AMOUNT IS SIGNAL. A vendor who does BOTH a big monthly contract AND
      // frequent small repairs will always have MORE repair lines, so a pure
      // count vote systematically mis-codes the big recurring bill into the
      // small-ticket account — the exact bill where being wrong costs the most.
      // Swim Houston at Waterview: 18 splash-pad repairs (median ~$1.3k)
      // outvoted 10 pool-management bills (median ~$9.7k), and an $11,064.87
      // management bill auto-coded to Splash Pad Repair at "medium" confidence
      // with needs_review OFF. Ed found it only because he asked to SEE the
      // account behind "✓ coded". Ask which of this vendor's JOBS the bill looks
      // like, not just who they are. (Ed 2026-07-15.)
      const amt = Number(totalCents);
      if (Number.isFinite(amt) && amt > 0) {
        const dist = (st) => Math.abs(Math.log(amt / Math.max(1, st.median)));
        const nearest = stats.slice().sort((a, b) => dist(a) - dist(b))[0];
        if (stats.length > 1 && nearest.aid !== top.aid && dist(top) > Math.log(2.5) && dist(nearest) < Math.log(1.5)) {
          chosen = nearest; forceReview = true;
          note = ` But this bill is ${money(amt)} — that looks like the ${money(nearest.median)} typical of ${byId[nearest.aid].account_number} ${byId[nearest.aid].account_name}, not the ${money(top.median)} typical of ${byId[top.aid].account_number} ${byId[top.aid].account_name}. Suggested on amount rather than the count — please confirm.`;
        } else if (dist(chosen) > Math.log(2.5)) {
          forceReview = true;
          note = ` This bill is ${money(amt)}, well outside the ${money(chosen.median)} typical of that account for this vendor — please confirm.`;
        }
      }

      const share = chosen.n / total;
      // Sample size is part of confidence: one prior entry at 100% share is not
      // a pattern, it's an anecdote.
      const confidence = (share >= 0.8 && total >= 3) ? 'high' : (share >= 0.5 && total >= 2) ? 'medium' : 'low';
      const why = forceReview && chosen !== top
        ? `${top.n} of ${total} prior ${vObj.name} entries were coded to ${byId[top.aid].account_number} ${byId[top.aid].account_name}.${note}`
        : `Coded to this account on ${chosen.n} of ${total} prior ${vObj.name} ${total === 1 ? 'entry' : 'entries'} in this community.${note}`;
      const out = withFit(shape(byId[chosen.aid], confidence, why));
      if (forceReview) out.needs_review = true;
      return out;
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
