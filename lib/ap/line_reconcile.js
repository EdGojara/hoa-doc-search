// ============================================================================
// lib/ap/line_reconcile.js  (Ed 2026-10-15)
// ----------------------------------------------------------------------------
// Do a bill's coded lines add up to what the bill says we owe?
//
// THE SCAR. Canyon Gate's September close (2026-10-15) found two bills that
// never reached the books:
//
//   Earthcare #1348     lines $8,862.58   total $9,593.75   gap $731.17 (8.25%)
//   Star Protection #30053  lines $2,272.36   total $2,459.84   gap $187.48 (8.25%)
//
// The extractor read both correctly, including tax_cents. Intake coded every
// line, then called the split accrual WITHOUT the tax, so the accrual saw
// "lines != total", logged one console line, and returned null. Nothing in the
// Payables screen said why: it read "Not posted, GL coding incomplete", which
// was false. The bills sat unbooked until Kat went hunting at close.
//
// The rule, one definition for intake, Post as coded, and a line re-code:
//
//   exact       lines == total (tax, if any, is already a line on the bill)
//   stated_tax  lines + the invoice's stated sales tax == total
//   derived_tax no stated tax, but the gap is exactly a Texas sales tax rate
//               (6.25% state + 0 to 2% local, in 1/8-point steps) on the lines.
//               NEVER posts on its own (allowDerived defaults to false): with
//               small lines almost any gap lands on some rate in that band (a
//               dropped $3 fee on a $40 bill "is" 7.5% tax). The bill is held
//               with the probable tax named, and posts only after a person
//               confirms it (Post as coded -> confirm). (PR #207 review.)
//   mismatch    anything else. Never posted; held with a plain-language reason.
//
// Tax is booked the way this ledger already books it when the vendor itemizes
// it: a "Sales Tax" line on the SAME expense account as the lines it taxes
// (Earthcare's monthly bills, Star's weekly bills). On a bill split across
// accounts, one Sales Tax line per account, in proportion to that account's
// share of the bill. Sales tax a vendor charges an association is part of the
// cost of what it bought; it is not a recoverable input tax.
// ============================================================================

const TOLERANCE_CENTS = 1;   // rounding on a per-line extraction
// The marker on a held bill's notes / approval reason. The Payables screen keys
// its "lines don't add up" banner off it, so keep the wording stable.
const LINES_HOLD_MARK = "LINES DON'T ADD UP";
// Texas: 6.25% state, local up to 2.00%, local rates set in 1/8-point steps.
const TX_RATES = []; for (let bp = 625; bp <= 825; bp += 12.5) TX_RATES.push(bp / 10000);

const dollars = (c) => '$' + (Number(c || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = (r) => `${(r * 100).toFixed(3).replace(/0+$/, '').replace(/\.$/, '')}%`;

/**
 * @param {{ lineCents: number[], totalCents: number, statedTaxCents?: number, allowDerived?: boolean }} a
 *   allowDerived: only true when a PERSON has confirmed the derived tax.
 * @returns {{ ok: boolean, kind: 'exact'|'stated_tax'|'derived_tax'|'mismatch'|'no_lines',
 *             net_cents: number, gap_cents: number, tax_cents: number, rate: number|null, message: string }}
 */
function reconcileLines({ lineCents, totalCents, statedTaxCents = 0, allowDerived = false } = {}) {
  const lines = (Array.isArray(lineCents) ? lineCents : []).map(Number).filter((c) => Number.isFinite(c) && c !== 0);
  const total = Number(totalCents);
  const stated = Number.isFinite(Number(statedTaxCents)) ? Math.round(Number(statedTaxCents)) : 0;
  const net = lines.reduce((s, c) => s + c, 0);
  const gap = Number.isFinite(total) ? total - net : 0;
  const base = { net_cents: net, gap_cents: gap, tax_cents: 0, rate: null };
  if (!lines.length) return { ok: false, kind: 'no_lines', ...base, message: 'The bill has no line items to post.' };
  if (!Number.isFinite(total)) return { ok: true, kind: 'exact', ...base, message: 'No invoice total to check against.' };

  if (Math.abs(gap) <= TOLERANCE_CENTS) {
    return { ok: true, kind: 'exact', ...base, message: `Lines add up to the bill total ${dollars(total)}.` };
  }
  if (stated > 0 && Math.abs(gap - stated) <= TOLERANCE_CENTS) {
    const rate = net > 0 ? stated / net : null;
    return { ok: true, kind: 'stated_tax', ...base, tax_cents: gap, rate,
      message: `Lines ${dollars(net)} plus the invoice's stated sales tax ${dollars(stated)} equal the total ${dollars(total)}.` };
  }
  if (stated <= 0 && gap > 0 && net > 0) {
    const rate = TX_RATES.find((r) => Math.abs(Math.round(net * r) - gap) <= TOLERANCE_CENTS);
    if (rate) {
      const what = `Lines ${dollars(net)} are ${dollars(gap)} short of the total ${dollars(total)}; that is exactly ${pct(rate)} Texas sales tax on the lines, but the invoice does not state the tax.`;
      return allowDerived
        ? { ok: true, kind: 'derived_tax', ...base, tax_cents: gap, rate, confirmed: true, message: `${what} Confirmed as sales tax by a person.` }
        : { ok: false, kind: 'derived_tax', ...base, tax_cents: gap, rate, confirmed: false, message: `${what} Not posted: if the ${dollars(gap)} is sales tax, confirm it with Post as coded; if not, correct the lines against the invoice.` };
    }
  }
  const taxBit = stated > 0 ? ` The invoice states ${dollars(stated)} sales tax, which does not explain the difference.` : '';
  return { ok: false, kind: 'mismatch', ...base,
    message: `Lines add up to ${dollars(net)} but the bill total is ${dollars(total)} (${gap > 0 ? 'short' : 'over'} by ${dollars(Math.abs(gap))}).${taxBit} Not posted: correct the lines against the invoice, then Post as coded.` };
}

/**
 * Sales Tax lines for a reconciled bill: one per expense account, proportional
 * to that account's share of the bill, remainder cents to the largest share.
 * Lines with no account yet share one uncoded Sales Tax line, so a person codes
 * it with them (it never posts uncoded).
 * @param {Array<{amount_cents:number, gl_account_id:string|null}>} codedLines
 * @param {{kind:string, tax_cents:number, rate:number|null}} recon
 * @returns {Array<{description, amount_cents, gl_account_id, reason, needs_review, is_tax:true}>}
 */
function salesTaxLines(codedLines, recon) {
  if (!recon || !recon.ok || !['stated_tax', 'derived_tax'].includes(recon.kind) || !(recon.tax_cents > 0)) return [];
  const byAcct = new Map();
  for (const l of codedLines || []) {
    const k = l.gl_account_id || '';
    byAcct.set(k, (byAcct.get(k) || 0) + Number(l.amount_cents || 0));
  }
  const shares = [...byAcct.entries()].filter(([, c]) => c > 0);
  const base = shares.reduce((s, [, c]) => s + c, 0);
  if (!base) return [];
  const out = shares.map(([acct, c]) => ({ acct, cents: Math.floor((recon.tax_cents * c) / base), share: c }));
  let rem = recon.tax_cents - out.reduce((s, o) => s + o.cents, 0);
  out.sort((a, b) => b.share - a.share);
  for (let i = 0; rem > 0; i = (i + 1) % out.length, rem -= 1) out[i].cents += 1;
  const how = recon.kind === 'stated_tax' ? 'Sales tax stated on the invoice' : `Sales tax derived from the invoice total (${pct(recon.rate)} of the lines)`;
  return out.filter((o) => o.cents > 0).map((o) => ({
    description: 'Sales Tax',
    amount_cents: o.cents,
    gl_account_id: o.acct || null,
    reason: o.acct
      ? `${how}, coded to the same account as the lines it taxes${out.length > 1 ? ` (${Math.round((o.share / base) * 100)}% of the bill)` : ''}.`
      : `${how}. Code it with the lines it taxes.`,
    needs_review: !o.acct || recon.kind === 'derived_tax',
    is_tax: true,
  }));
}

module.exports = { reconcileLines, salesTaxLines, TX_RATES, LINES_HOLD_MARK };
