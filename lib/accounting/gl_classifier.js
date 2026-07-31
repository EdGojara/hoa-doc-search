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

// Score a description against the expense account NAMES on this community's own
// chart. One definition, used by both the line-item branch (2.5) and the weak
// description fallback (4) — the same scoring must not exist twice.
// Returns the best account, how many distinct words matched, and whether another
// account matched equally well (a tie is a human call, never a silent pick).
function matchAccountByName(description, accts) {
  const words = [...new Set(norm(description).split(' ').filter((w) => w.length > 3))];
  if (!words.length) return null;
  const scored = accts.filter((a) => a.account_type === 'expense').map((a) => {
    const an = norm(a.account_name);
    return { acct: a, score: words.reduce((n, w) => n + (an.includes(w) ? 1 : 0), 0) };
  }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score);
  if (!scored.length) return null;
  const top = scored[0];
  const tied = scored.filter((x) => x.score === top.score && x.acct.id !== top.acct.id);
  return { acct: top.acct, score: top.score, tie: tied.length ? tied.map((t) => `${t.acct.account_number} ${t.acct.account_name}`).join(' / ') : null };
}

// Domain lexicon: line vocabulary -> the account CONCEPT it names, even when the
// words don't lexically match the account name. A vendor who does BOTH
// landscaping and irrigation (Superior LawnCare) bills irrigation PARTS —
// "Sprays Head Rain Bird", "Nozzle RainBird", "Valve PEB", "Bubbler" — none of
// which contain the words "irrigation / repair / maintenance", so name-matching
// scores zero and the line defaults to the vendor's most-common account (5200
// Landscape). That's the count-vs-content scar: the line's own words should win,
// but only if the system knows RainBird == irrigation. Each concept maps
// distinctive part/service terms to a keyword that finds the right account on
// THIS community's chart. Order matters: most specific first. (Ed 2026-07-28.)
const CONCEPT_LEXICON = [
  {
    concept: 'irrigation',
    accountKeyword: /irrigation|sprinkler/i,
    termRx: /\b(rain\s?bird|sprinkler|irrigation|spray\s?head|sprays?\s?heads?|bubblers?|\bpeb\b|drip\b|backflow|solenoid|rotor\b|risers?\b|valve\s?box|anti-?siphon|nozzles?|\bvalves?\b)\b/i,
  },
  {
    concept: 'landscaping',
    accountKeyword: /landscap|grounds\s?maintenance|lawn/i,
    termRx: /\b(mow(ing)?|mulch|sod\b|fertiliz|landscap|edg(e|ing)|shrubs?|prun(e|ing)|weed(ing)?|turf|flower\s?beds?|plant(ing)?\s?beds?|seasonal\s?color)\b/i,
  },
];

// Return the concept account for a line whose vocabulary names a job the account
// name doesn't spell out. Only fires when the concept's account actually exists
// on this chart — no account, no guess. Returns { acct, concept, term } or null.
function matchAccountByConcept(description, accts) {
  const d = String(description || '');
  if (!d.trim()) return null;
  for (const c of CONCEPT_LEXICON) {
    const m = d.match(c.termRx);
    if (!m) continue;
    const acct = accts.find((a) => a.account_type === 'expense' && c.accountKeyword.test(a.account_name || ''));
    if (acct) return { acct, concept: c.concept, term: m[0] };
  }
  return null;
}

// Generic billing words that don't distinguish ONE kind of line from another —
// dropped before line-to-line similarity so "Monthly Water Management Fee"
// matches a prior "Water Management" and NOT a "Monthly Service Charge".
const LINE_STOP = new Set(['monthly', 'month', 'annual', 'charge', 'charges', 'fee', 'fees', 'invoice', 'service', 'services', 'current', 'previous', 'balance', 'payment', 'amount', 'total', 'due', 'for', 'the', 'and', 'per', 'each', 'new', 'bill', 'billing', 'account', 'number', 'date', 'tax', 'sales',
  // Month names + dates vary bill to bill and must not dilute "same kind of
  // line" matching ("Water Management Fee - August" vs "...- September").
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december', 'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec']);
// Distinctive words only: drop the boilerplate above AND any purely-numeric
// token (dates, years, amounts, invoice numbers) — none of which say what KIND
// of line this is.
const lineToks = (str) => new Set(String(str || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !LINE_STOP.has(w) && !/^\d+$/.test(w)));

// LINE-ITEM HISTORY — how was THIS vendor's prior line with a SIMILAR description
// coded? A vendor that bills different kinds of work (WaterLogic: monthly water
// management AND one-off irrigation repair) codes each KIND to its own account.
// Matching the new line to prior lines of the SAME kind — by description, per
// vendor — is how Emma learns "usual vs different" from real decisions, including
// staff-directed and human-corrected codings (they're all in the line history).
// Fires only once a real PATTERN exists (>= 2 agreeing prior lines) and it's a
// clear plurality — a single one-off (e.g. a staff exception) never becomes the
// rule; the majority vote sorts usual from exception as the history grows, and
// humans review the thin cases. (Ed 2026-07-31.)
async function matchByLineHistory({ communityId, vendorId, vendorName, description, byId, excludeInvoiceId = null }) {
  const cur = lineToks(description);
  if (cur.size === 0 || (!vendorId && !vendorName)) return null;
  // This vendor's invoices in this community (id-tagged; name-history has no line
  // table to join, so it's the tagged bills that carry codeable line items).
  if (!vendorId) return null;
  const { data: invs } = await supabase.from('ap_invoices').select('id').eq('community_id', communityId).eq('vendor_id', vendorId).limit(2000);
  const invIds = (invs || []).map((i) => i.id).filter((id) => id !== excludeInvoiceId);
  if (!invIds.length) return null;
  const lines = [];
  for (let i = 0; i < invIds.length; i += 200) {
    const { data } = await supabase.from('ap_invoice_lines').select('description, gl_account_id')
      .in('invoice_id', invIds.slice(i, i + 200)).not('gl_account_id', 'is', null).not('description', 'is', null);
    lines.push(...(data || []));
  }
  if (!lines.length) return null;
  // Token-overlap similarity; keep only decently-similar prior lines, vote by account.
  const byAcct = new Map(); // account_id -> { n, simSum }
  let matched = 0;
  for (const l of lines) {
    const p = lineToks(l.description);
    if (!p.size) continue;
    let inter = 0; for (const w of cur) if (p.has(w)) inter++;
    const sim = inter / Math.max(cur.size, p.size);
    if (sim < 0.6) continue;
    const a = byId[l.gl_account_id];
    if (!a || a.account_type !== 'expense') continue;   // AP/cash legs never count
    const cell = byAcct.get(l.gl_account_id) || { n: 0, simSum: 0 };
    cell.n += 1; cell.simSum += sim; byAcct.set(l.gl_account_id, cell);
    matched += 1;
  }
  if (!byAcct.size) return null;
  let best = null; for (const [aid, v] of byAcct) if (!best || v.n > best.n || (v.n === best.n && v.simSum > best.simSum)) best = { aid, ...v };
  // Need a real pattern AND a clear plurality — not a single exception, not a split.
  if (best.n < 2 || best.n / matched < 0.6) return null;
  const acct = byId[best.aid];
  const confidence = best.n >= 4 ? 'high' : 'medium';
  const reason = `${best.n} prior ${vendorName || 'vendor'} line${best.n === 1 ? '' : 's'} like "${description}" ${best.n === 1 ? 'was' : 'were'} coded to ${acct.account_number} ${acct.account_name} — learned from this vendor's line history.`;
  return { acct, confidence, reason };
}

const median = (xs) => { const a = xs.slice().sort((x, y) => x - y); const m = a.length >> 1; return a.length % 2 ? a[m] : Math.round((a[m - 1] + a[m]) / 2); };
const money = (c) => '$' + (Number(c || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * @param {number|null} totalCents            this bill's amount — AMOUNT IS SIGNAL (see branch 3)
 * @param {string|null} excludeJournalEntryId this invoice's own accrual, so a bill can't cite itself
 */
async function suggestClassification({ communityId, vendorId, vendorName, description, isPaymentLeg, totalCents = null, excludeJournalEntryId = null, excludeInvoiceId = null, descriptionIsLineItem = false }) {
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

  // 2.4) LINE-ITEM HISTORY — how was this vendor's prior line LIKE this one coded?
  // Learned per line kind (usual vs different), so it beats the semantic name
  // guess below: real prior decisions (incl. staff-directed + human-corrected)
  // outrank a lexical match. Only fires on a repeated pattern, never a one-off.
  {
    const lh = await matchByLineHistory({ communityId, vendorId: (vendor && vendor.id) || vendorId, vendorName: (vendor && vendor.name) || vendorName, description, byId, excludeInvoiceId });
    if (lh) return withFit(shape(lh.acct, lh.confidence, lh.reason));
  }

  // 2.5) A LINE's own words beat vendor history — but only for a real line item.
  //
  // "What is Swim Houston?" is unanswerable: they bill pool management, splash-pad
  // repair, supplies and lifeguards on ONE invoice. "What is 'August Splash Pad
  // Monthly Maintenance'?" answers itself — the line names its own account. When
  // history ran first, every line on invoice 7316 inherited the vendor's most-
  // common account and $11k landed in splash-pad repair.
  //
  // Gated behind descriptionIsLineItem so INVOICE-level coding is unchanged: at
  // that level `description` is usually just the vendor's name, and a vendor whose
  // NAME happens to echo an account name ("Swim Houston Pool Management LLC" vs
  // "Pool Management Service") must not out-rank what the books actually show.
  if (descriptionIsLineItem && description) {
    const m = matchAccountByName(description, accts);
    if (m && m.score >= 2) {
      // 2 words is a real match but not proof; 3+ is decisive. A tie means two
      // accounts fit the same words — always a human call.
      const confident = m.score >= 3 && !m.tie;
      return withFit({
        ...shape(m.acct, confident ? 'high' : 'medium',
          `The line reads "${description}" — matched to this account by name.${m.tie ? ` It fits ${m.tie} equally well; confirm which.` : ''}`),
        needs_review: !confident,
      });
    }
    // The line names a job (irrigation part, mowing) whose vocabulary the
    // account name doesn't spell out. Encode the domain lexicon so a vendor who
    // does BOTH landscaping and irrigation gets each line on the account it
    // belongs to, instead of defaulting to their most-common account below.
    // Always needs_review — it's a heuristic, but it SUGGESTS the right account
    // (5125 Irrigation) instead of the wrong one (5200 Landscape). (Ed 2026-07-28.)
    const cm = matchAccountByConcept(description, accts);
    if (cm) {
      return withFit({
        ...shape(cm.acct, 'medium',
          `The line reads "${description}" — that's ${cm.concept} work (matched "${cm.term}"), so it's coded to ${cm.acct.account_number} ${cm.acct.account_name} rather than this vendor's most-common account. Confirm.`),
        needs_review: true,
      });
    }
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

  // 4) Description keyword -> expense account name (weak: one word, or a vendor
  //    name that happens to echo an account). Always needs_review.
  if (description) {
    const m = matchAccountByName(description, accts);
    if (m) return withFit({ ...shape(m.acct, 'low', 'Guessed from the description — please confirm.'), needs_review: true });
  }

  return { account_id: null, confidence: 'low', reason: 'No confident match — classify manually.', needs_review: true, budget_fit: false };
}

// coreVendorName is exported so the recurrence profiler matches a vendor to its
// ledger history the SAME way the classifier does — one definition of "is this
// the same vendor", not two that drift.
module.exports = { suggestClassification, coreVendorName, vendorSearchTerms, matchAccountByConcept, lineToks };
