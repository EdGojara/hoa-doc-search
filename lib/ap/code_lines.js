// ============================================================================
// lib/ap/code_lines.js  (Ed 2026-07-15)
// ----------------------------------------------------------------------------
// Code a bill LINE BY LINE, from what the invoice actually says.
//
// Ed, on Swim Houston invoice 7316 ($11,064.87): "if you look at this bill you
// can tell its for monthly service — can you look at invoice to code properly.
// very sloppy. also there is a credit on the bill if you look at it."
//
// He was right, and the failure was worse than mis-coding: the extractor had
// already read all five lines correctly — including the -$1,470 credit — and
// intake THREW THEM AWAY. It joined the descriptions into one string, coded the
// whole $11,064.87 to a single account by vendor-level history, and never wrote
// an ap_invoice_lines row. So the GL saw one lump on one account, the credit Ed
// asked about was invisible, and the system told him to go chase a credit that
// was already applied on the bill in front of him.
//
//   1. August Pool Monthly Maintenance          $1,617.87
//   2. August Splash Pad Monthly Maintenance      $557.00   <- splash pad IS here
//   3. August Lifeguard Service                $10,290.00   <- and this is the bill
//   4. Chemical Storage Sign                       $70.00
//   5. credit for days closed in June          -$1,470.00   <- the credit, on the bill
//
// One bill, four different expense accounts. No single-account answer is right.
// The vendor-level question ("what is Swim Houston?") can't be answered; the
// LINE-level question ("what is 'August Splash Pad Monthly Maintenance'?")
// answers itself.
// ============================================================================
const { suggestClassification } = require('../accounting/gl_classifier');

/**
 * @param {Array<{description:string, amount:number}>} lineItems  dollars, as extracted
 * @returns {Array<{line_number, description, amount_cents, gl_account_id, confidence,
 *                  reason, needs_review, is_credit}>}
 */
async function codeInvoiceLines({ lineItems, communityId, vendorId, vendorName }) {
  const items = (Array.isArray(lineItems) ? lineItems : [])
    .map((l) => ({ description: String(l.description || '').trim(), cents: Math.round(Number(l.amount) * 100) }))
    .filter((l) => l.description && Number.isFinite(l.cents) && l.cents !== 0);
  if (!items.length) return [];

  const out = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    // Negative lines are handled after the positives — a credit is coded to what
    // it CREDITS, which we only know once the charges are coded.
    if (it.cents < 0) { out.push({ line_number: i + 1, description: it.description, amount_cents: it.cents, is_credit: true, gl_account_id: null, confidence: 'low', reason: null, needs_review: true }); continue; }
    const r = await suggestClassification({
      communityId, vendorId: vendorId || null, vendorName: vendorName || null,
      // The LINE's own words, not the vendor's name. This is the whole point.
      description: it.description,
      descriptionIsLineItem: true,
      totalCents: it.cents,
    });
    out.push({
      line_number: i + 1, description: it.description, amount_cents: it.cents, is_credit: false,
      gl_account_id: (r && r.account_id) || null,
      confidence: (r && r.confidence) || 'low',
      reason: (r && r.reason) || null,
      needs_review: !(r && r.account_id) || !!(r && r.needs_review),
    });
  }

  // A credit line belongs against the charge it reverses. "credit for days closed
  // in June" is a lifeguard credit, so it must land on the lifeguard account —
  // NOT on whatever account this vendor is most often coded to (which for Swim
  // Houston is splash-pad repair, and would park a $1,470 lifeguard credit in the
  // wrong account forever). Best available signal: the largest charge on the same
  // bill that shares a word with the credit line; failing that, the largest charge.
  const charges = out.filter((l) => !l.is_credit && l.gl_account_id);
  if (charges.length) {
    const biggest = charges.slice().sort((a, b) => b.amount_cents - a.amount_cents)[0];
    const words = (s) => new Set(String(s).toLowerCase().replace(/[^a-z ]/g, ' ').split(/\s+/).filter((w) => w.length > 3));
    for (const c of out) {
      if (!c.is_credit) continue;
      const cw = words(c.description);
      let best = null, bestHits = 0;
      for (const ch of charges) {
        let hits = 0; words(ch.description).forEach((w) => { if (cw.has(w)) hits += 1; });
        if (hits > bestHits) { bestHits = hits; best = ch; }
      }
      const target = best || biggest;
      c.gl_account_id = target.gl_account_id;
      c.reason = best
        ? `Credit applied against "${best.description}" on this same bill (matched on the line's own wording). Confirm the account.`
        : `Credit — coded against the largest charge on this bill ("${biggest.description}") because its wording doesn't name what it credits. Confirm the account.`;
      c.needs_review = true;   // a credit's account is always a judgment — never silent
    }
  }
  return out;
}

module.exports = { codeInvoiceLines };
