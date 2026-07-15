// ============================================================================
// lib/ap/credit_match.js  (Ed 2026-07-15)
// ----------------------------------------------------------------------------
// Ed: "there is a credit on the bill if you look at it — should say credit
// appears to be applied in your notes"
//
// He forwarded the pool-closure email so we'd make sure Waterview got credited
// for the lifeguard days. We recorded the expectation and put a hold on the
// bill. Then the vendor DID apply it — line 5 of invoice 7316, "credit for days
// closed in June", -$1,470.00 — and the system, which had never looked at the
// invoice's lines, told Ed to go chase a credit that was sitting on the bill in
// front of him. A control that cries wolf on a satisfied condition gets
// disabled, and then it protects nothing.
//
// So: when a bill carries a negative line and this vendor owes this community a
// credit, SAY SO. Deliberately "appears applied", never auto-resolved:
//   * The expected amount is often unknown (Matt agreed to credit "the lifeguard
//     time" — no figure), so we cannot verify the credit is the RIGHT size.
//   * Marking a credit collected is a money decision. The system's job is to put
//     the fact in front of the human, not to decide it was enough.
// The hold stays until a person resolves it. (See lib/ap/vendor_credits.js.)
// ============================================================================

const money = (c) => '$' + (Number(c || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * @param {Array<{line_number, description, amount_cents}>} lines  the invoice's own lines
 * @param {Array<{id, reason, expected_cents}>} openCredits        credits this vendor owes
 * @returns {{ applied:boolean, total_credit_cents:number, lines:Array, note:string|null,
 *             amount_matches:boolean|null }}
 */
function detectAppliedCredits(lines, openCredits) {
  const negatives = (Array.isArray(lines) ? lines : []).filter((l) => Number(l.amount_cents) < 0);
  const credits = Array.isArray(openCredits) ? openCredits : [];
  if (!negatives.length) {
    return { applied: false, total_credit_cents: 0, lines: [], note: null, amount_matches: null };
  }
  const total = negatives.reduce((n, l) => n + Math.abs(Number(l.amount_cents)), 0);
  const detail = negatives.map((l) => `${money(Math.abs(l.amount_cents))} — "${String(l.description || '').trim()}"`).join('; ');

  // No expectation on file: still worth saying out loud. A credit on a bill is
  // never noise.
  if (!credits.length) {
    return {
      applied: true, total_credit_cents: total, lines: negatives, amount_matches: null,
      note: `This bill already carries ${negatives.length === 1 ? 'a credit' : `${negatives.length} credits`} totalling ${money(total)} (${detail}). No expected credit was on file for this vendor — worth confirming it's the one you were owed.`,
    };
  }

  // We expected a credit AND the bill has one. Can we check the size?
  const expected = credits.filter((c) => Number.isFinite(Number(c.expected_cents)) && Number(c.expected_cents) > 0);
  const expectedTotal = expected.reduce((n, c) => n + Number(c.expected_cents), 0);
  if (!expected.length) {
    return {
      applied: true, total_credit_cents: total, lines: negatives, amount_matches: null,
      note: `A credit appears to be applied on this bill: ${detail}. That's what you were expecting — but the amount owed was never quantified, so confirm ${money(total)} is the full credit before releasing.`,
    };
  }
  const short = expectedTotal - total;
  if (Math.abs(short) <= 1) {
    return {
      applied: true, total_credit_cents: total, lines: negatives, amount_matches: true,
      note: `The credit appears to be applied in full: ${detail}, matching the ${money(expectedTotal)} expected.`,
    };
  }
  if (short > 0) {
    return {
      applied: true, total_credit_cents: total, lines: negatives, amount_matches: false,
      note: `A credit appears to be applied (${detail}) — but it's ${money(short)} SHORT of the ${money(expectedTotal)} expected. Confirm before releasing.`,
    };
  }
  return {
    applied: true, total_credit_cents: total, lines: negatives, amount_matches: false,
    note: `A credit appears to be applied (${detail}) — ${money(-short)} MORE than the ${money(expectedTotal)} expected. Worth a look before releasing.`,
  };
}

module.exports = { detectAppliedCredits };
