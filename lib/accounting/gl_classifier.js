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

  // 3) Vendor history — most-common account on this community's posted lines.
  if (vendor && vendor.id) {
    const { data: lns } = await supabase.from('journal_entry_lines')
      .select('account_id, journal_entries!inner(community_id)')
      .eq('vendor_id', vendor.id).eq('journal_entries.community_id', communityId).limit(1000);
    const counts = {};
    (lns || []).forEach((l) => { if (byId[l.account_id]) counts[l.account_id] = (counts[l.account_id] || 0) + 1; });
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    if (total > 0) {
      const [bestId, n] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
      const share = n / total;
      const confidence = share >= 0.8 ? 'high' : share >= 0.5 ? 'medium' : 'low';
      return withFit(shape(byId[bestId], confidence, `Matches ${n} of ${total} prior ${vendor.name} entries in this community.`));
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

module.exports = { suggestClassification };
