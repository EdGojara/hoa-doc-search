// ============================================================================
// lib/banking/extractors/vantaca_pay_payouts.js
// ----------------------------------------------------------------------------
// Parse a Vantaca "Pay Payout Contents" .xls — the authoritative settlement
// detail for online (Vantaca Pay) payments. Each row is one settled item:
//   Trxn Date | Payout Date | Description (account# + Card/eCheck) | Type | Amount
// Type is Payment (gross, positive), Fee (negative) or Refund (negative). The
// bank's "VANTACA - PAYOUT" ACH credit on a given payout date equals the NET of
// that date's items — this is what explains payouts that aren't a clean sum of
// dues (e.g. a $20 dispute fee or a $608.74 refund netted out).
//
// This is the ground-truth batch key: it replaces subset-sum guessing for the
// online side of a bank reconciliation, and classifies each online payment as
// cleared (payout_date within period) or in-transit (payout_date after period).
//
//   parseVantacaPayPayouts(buffer) -> { payments:[{trxn_date, payout_date,
//       account_ref, kind('Card'|'eCheck'|null), type, amount_cents(signed),
//       description}], association, warnings }
//   groupByPayoutDate(payments) -> [{payout_date, net_cents, items:[...]}]
// ============================================================================

const XLSX = require('xlsx');

function toIso(s) {
  const m = String(s).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  return m ? `${m[3]}-${String(m[1]).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}` : null;
}

// Signed cents: "$260.00" → +26000; "-20.00" / "-608.74" → negative; "(x)" → negative.
function toSignedCents(a) {
  const str = String(a).trim();
  if (!/[\d]/.test(str)) return null;
  const neg = /^[(-]/.test(str) || /-/.test(str.replace(/[^-\d]/g, '').slice(0, 1));
  const n = Number(str.replace(/[()$,\s]/g, '').replace(/-/g, ''));
  if (!Number.isFinite(n)) return null;
  return (neg ? -1 : 1) * Math.round(n * 100);
}

function parseRows(rows) {
  const payments = [];
  const warnings = [];
  let association = null;
  let inData = false;

  for (const raw of rows) {
    const cells = (raw || []).map((c) => (c == null ? '' : String(c).trim()));
    const [trxn, payout, description, type, amount] = cells;

    if (/^assoc:/i.test(trxn)) { association = trxn.replace(/^assoc:\s*/i, '').trim(); continue; }
    if (/^trxn date$/i.test(trxn)) { inData = true; continue; }
    if (!inData) continue;

    const trxnIso = toIso(trxn);
    const payoutIso = toIso(payout);
    const amount_cents = toSignedCents(amount);
    // a data row has at least an amount and a type
    if (amount_cents == null || !type) continue;

    const account_ref = (String(description).match(/\b(\d{6,})\b/) || [])[1] || null;
    const kind = /card/i.test(description) ? 'Card' : (/echeck/i.test(description) ? 'eCheck' : null);
    payments.push({
      trxn_date: trxnIso,
      payout_date: payoutIso,
      account_ref,
      kind,
      type: type || null,
      amount_cents,
      description,
    });
  }
  return { association, payments, warnings };
}

function parseVantacaPayPayouts(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' });
  return parseRows(rows);
}

// Group settled items by payout date; net_cents is the ACH credit the bank
// should show on that date (payments minus fees/refunds).
function groupByPayoutDate(payments) {
  const by = {};
  for (const p of payments || []) {
    if (!p.payout_date) continue;
    (by[p.payout_date] = by[p.payout_date] || []).push(p);
  }
  return Object.keys(by).sort().map((d) => ({
    payout_date: d,
    net_cents: by[d].reduce((s, x) => s + x.amount_cents, 0),
    items: by[d],
  }));
}

module.exports = { parseVantacaPayPayouts, parseRows, groupByPayoutDate, toSignedCents };
