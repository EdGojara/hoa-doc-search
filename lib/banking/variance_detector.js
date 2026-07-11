// ============================================================================
// lib/banking/variance_detector.js  (Ed 2026-07-11) — Phase 3 of the AI-CPA
// ----------------------------------------------------------------------------
// Post-processes the matcher's output to find VARIANCES: the same transaction
// present on BOTH sides but for a DIFFERENT amount. Without this, a check that
// cleared for the wrong amount (or an auto-posted bill that didn't match the
// bank draft) shows up as two unrelated residual lines — one bank_only, one
// gl_only — and a human has to notice they're the same item. This pairs them
// and reports the delta, so the rec surfaces "$X variance on check 1042"
// instead of two mystery lines.
//
// PURE + additive: takes the matcher's `items` array, returns variances +
// the residuals that are genuinely one-sided. Does NOT touch matcher.js.
// ============================================================================

const norm = (s) => String(s || '').replace(/[^0-9]/g, '').replace(/^0+/, '');

// A bank line is one side of a variance; a book line the other. Bank residuals
// are category 'bank_only'; book residuals are 'gl_only' / 'outstanding_check'.
function detectVariances(items, opts = {}) {
  const dateWindowDays = opts.dateWindowDays != null ? opts.dateWindowDays : 10;
  const relTolerance = opts.relTolerance != null ? opts.relTolerance : 0.25; // pair if within 25% (they're "the same-ish" amount)
  const list = Array.isArray(items) ? items : [];
  const bank = list.filter((i) => i.category === 'bank_only').map((i, k) => ({ ...i, _k: 'b' + k, _used: false }));
  const book = list.filter((i) => i.category === 'gl_only' || i.category === 'outstanding_check').map((i, k) => ({ ...i, _k: 'k' + k, _used: false }));

  const amt = (i) => Math.abs(Number(i.amount_cents || i.amount_signed_cents || 0));
  const dt = (s) => { const d = new Date(String(s || '').slice(0, 10)); return isNaN(d) ? null : d; };
  const daysApart = (a, b) => (a && b) ? Math.abs((a - b) / 86400000) : 999;

  const variances = [];

  // Pass 1 — same check number, different amount (strongest signal).
  for (const bk of bank) {
    if (bk._used) continue;
    const bn = norm(bk.check_number);
    if (!bn) continue;
    const m = book.find((k) => !k._used && norm(k.check_number) === bn && amt(k) !== amt(bk));
    if (m) {
      bk._used = true; m._used = true;
      variances.push(buildVariance(bk, m, 'check_number'));
    }
  }

  // Pass 2 — close amount + close date, not exact (same item, amount drifted).
  for (const bk of bank) {
    if (bk._used) continue;
    const ab = amt(bk); if (!ab) continue;
    let best = null, bestDelta = Infinity;
    for (const k of book) {
      if (k._used) continue;
      const ak = amt(k); if (!ak || ak === ab) continue;                 // exact matches are the matcher's job, not a variance
      const rel = Math.abs(ak - ab) / Math.max(ak, ab);
      if (rel > relTolerance) continue;
      if (daysApart(dt(bk.date_ref), dt(k.date_ref)) > dateWindowDays) continue;
      const delta = Math.abs(ak - ab);
      if (delta < bestDelta) { bestDelta = delta; best = k; }
    }
    if (best) { bk._used = true; best._used = true; variances.push(buildVariance(bk, best, 'amount_date_proximity')); }
  }

  return {
    variances,
    unmatched_bank: bank.filter((b) => !b._used).map(strip),
    unmatched_book: book.filter((k) => !k._used).map(strip),
    variance_total_cents: variances.reduce((s, v) => s + v.variance_cents, 0),
  };
}

function buildVariance(bankItem, bookItem, method) {
  const ba = Math.abs(Number(bankItem.amount_cents || bankItem.amount_signed_cents || 0));
  const ka = Math.abs(Number(bookItem.amount_cents || bookItem.amount_signed_cents || 0));
  return {
    category: 'variance',
    check_number: bankItem.check_number || bookItem.check_number || null,
    description: bankItem.description || bookItem.description || '',
    bank_amount_cents: ba,
    book_amount_cents: ka,
    variance_cents: ba - ka,          // + = bank cleared for MORE than the books say
    match_method: method,
    bank_date: bankItem.date_ref || null,
    book_date: bookItem.date_ref || null,
    bank_ref: bankItem.bank_transaction_idx || null,
    book_ref: bookItem.gl_ref || bookItem.check_register_ref || null,
    needs_review: true,
  };
}
function strip({ _k, _used, ...i }) { return i; }

module.exports = { detectVariances };
