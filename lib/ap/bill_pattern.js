// ============================================================================
// lib/ap/bill_pattern.js  (Ed 2026-10-15)
// ----------------------------------------------------------------------------
// Is this bill the SAME KIND of bill this vendor usually sends?
//
// THE SCAR. Earthcare bills Canyon Gate $8,842.68 a month for landscape
// maintenance. On 9/30 it sent #1348, $9,593.75 of irrigation repairs: 57 lines
// of "Clock A Zone 5 - Replace 2in valve", nothing like the monthly bill. The
// approval path called it "Recurring monthly and consistent with expectations"
// and routed it to release, because the only test was the AMOUNT, and $9,593
// sits within 25% of $8,842. A vendor's one-off job that happens to cost about
// what its contract costs is exactly the bill a manager should look at.
//
// Ed's rule is "recurring AND consistent". Consistent has to mean the bill is
// for the same work, not merely a similar number. So: compare the words on this
// bill's lines with the words on the vendor's prior bills on this community's
// books. Most of the money on this bill must sit on lines that describe the
// vendor's usual work, or it goes to manager review.
//
// Deliberately simple and explainable (shared words, weighted by dollars).
// Words that carry no meaning about the WORK are ignored: the community's and
// vendor's own names, months, generic invoice words, numbers.
// ============================================================================

const STOP = new Set(('invoice invoices sales total subtotal amount balance service services monthly month ' +
  'january february march april june july august september sept october november december ' +
  'with that this from were when have will your each hours hour rate regular includes including ' +
  'labor provided following during period date dates week weekly charge charges item items ' +
  'please thank payment paid credit').split(/\s+/));

const words = (s) => String(s || '').toLowerCase().replace(/[^a-z]+/g, ' ').split(' ').filter((w) => w.length >= 4 && !STOP.has(w));

/**
 * @param {{ lines: Array<{description:string, amount_cents?:number, amount?:number}>,
 *           priorTexts: string[], ignoreText?: string, threshold?: number }} a
 * @returns {{ checked: boolean, matched: boolean|null, share: number|null, unmatched: string[], summary: string|null }}
 *   checked=false when either side has no meaningful words (no verdict; the
 *   amount test alone applies, as before).
 */
function descriptionMatch({ lines, priorTexts, priorBills = null, ignoreText = '', threshold = 0.5 } = {}) {
  const ignore = new Set(words(ignoreText));
  const sig = (s) => words(s).filter((w) => !ignore.has(w));
  const prior = new Set();
  for (const t of priorTexts || []) sig(t).forEach((w) => prior.add(w));
  const bill = (Array.isArray(lines) ? lines : []).map((l) => ({
    description: String(l.description || ''),
    cents: l.amount_cents != null ? Number(l.amount_cents) : Math.round(Number(l.amount) * 100),
  })).filter((l) => Number.isFinite(l.cents) && l.cents > 0 && sig(l.description).length);
  const none = { checked: false, matched: null, share: null, unmatched: [], summary: null };
  if (!prior.size || !bill.length) return none;

  let matchedCents = 0, totalCents = 0;
  const unmatched = [];
  for (const l of bill) {
    totalCents += l.cents;
    // A line matches on two shared words, or on half its words: one shared
    // street name ("Marina Canyon Way") is a location, not the same work.
    const w = [...new Set(sig(l.description))];
    const shared = w.filter((x) => prior.has(x)).length;
    if (shared >= 2 || shared / w.length >= 0.5) matchedCents += l.cents;
    else if (unmatched.length < 3) unmatched.push(l.description.slice(0, 80));
  }
  const share = totalCents ? matchedCents / totalCents : 0;
  const matched = share >= threshold;
  // How many prior BILLS describe this same work (the most-dollar line of this
  // bill matched against each prior bill's own words)? Precedent for release
  // needs more than one. (PR #207 review.)
  let matchedBills = 0;
  if (Array.isArray(priorBills) && matched) {
    const main = [...bill].sort((a, b) => b.cents - a.cents)[0];
    const mw = [...new Set(sig(main.description))];
    for (const pb of priorBills) {
      const vocab = new Set(); (pb || []).forEach((t) => sig(t).forEach((x) => vocab.add(x)));
      const sh = mw.filter((x) => vocab.has(x)).length;
      if (sh >= 2 || (mw.length && sh / mw.length >= 0.5)) matchedBills += 1;
    }
  }
  return {
    checked: true, matched, share: Math.round(share * 100) / 100, unmatched, matched_bills: matchedBills,
    summary: matched ? null : `${Math.round((1 - share) * 100)}% of this bill is for work that doesn't appear on this vendor's prior bills here (e.g. "${unmatched[0] || ''}").`,
  };
}

module.exports = { descriptionMatch, words };
