// ============================================================================
// lib/vault/statement_extract.js  (Ed 2026-08-14)
// ----------------------------------------------------------------------------
// The reconstruction engine's front door: read a bank OR credit-card statement
// PDF and return every transaction, plus the statement's period and balances so
// we can reconcile. Owner-vault only. Follows the house rules: send the PDF
// binary to the model (never pre-parsed text — Adobe-form scar), return the raw
// extraction for debugging, and surface a balance cross-check.
// ============================================================================
const Anthropic = require('@anthropic-ai/sdk');
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const PROMPT = `You are reading ONE bank or credit-card statement (PDF) for a small
company's bookkeeping. Extract EVERYTHING printed, exactly. Return ONLY strict
JSON of this shape (no prose, no markdown fence):

{
  "statement_kind": "bank" | "credit_card",
  "institution": "string — the bank/card issuer name, or null",
  "account_last4": "string — last 4 of the account/card number, or null",
  "period_start": "YYYY-MM-DD or null",
  "period_end":   "YYYY-MM-DD or null",
  "opening_balance": <number dollars, or null>,
  "closing_balance": <number dollars, or null>,
  "transactions": [
    { "date": "YYYY-MM-DD", "description": "string exactly as printed", "amount": <number dollars> }
  ]
}

Rules:
- Amounts are plain dollars, no $ or commas. SIGN: money OUT is NEGATIVE
  (withdrawals, debits, purchases, card charges, fees), money IN is POSITIVE
  (deposits, credits, refunds, card payments received).
- Include EVERY line: every purchase, deposit, transfer, fee, interest, and
  payment. Do not summarize, do not skip small ones, do not merge.
- Use the transaction (posting) date. If only MM/DD is printed, infer the year
  from the statement period.
- Never invent a transaction or an amount. If a value isn't printed, omit it.
- For a credit-card statement: charges are NEGATIVE, payments/credits to the
  card are POSITIVE.`;

const toCents = (n) => (n == null || isNaN(Number(n))) ? null : Math.round(Number(n) * 100);

async function extractStatement(pdfBuffer) {
  const t0 = Date.now();
  const completion = await anthropic.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 8000,
    messages: [{
      role: 'user',
      content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBuffer.toString('base64') } },
        { type: 'text', text: PROMPT },
      ],
    }],
  });
  const text = completion.content?.[0]?.text || '';
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  let p;
  try { p = JSON.parse(cleaned); } catch (err) { throw new Error(`Statement extraction returned malformed JSON: ${err.message}`); }

  const txns = (Array.isArray(p.transactions) ? p.transactions : [])
    .map((t) => ({
      date: /^\d{4}-\d{2}-\d{2}/.test(t.date || '') ? t.date.slice(0, 10) : null,
      description: (t.description || '').toString().replace(/\s+/g, ' ').trim() || null,
      amount_cents: toCents(t.amount),
    }))
    .filter((t) => t.date && t.amount_cents != null);

  // Balance cross-check: opening + sum(txns) should equal closing. Surfaced so
  // the operator (and the review UI) can trust the extraction or spot a gap —
  // the same "prove the count against truth" discipline used elsewhere.
  const sum = txns.reduce((s, t) => s + t.amount_cents, 0);
  const opening = toCents(p.opening_balance);
  const closing = toCents(p.closing_balance);
  let reconciles = null, off_by_cents = null;
  if (opening != null && closing != null) {
    off_by_cents = closing - (opening + sum);
    reconciles = Math.abs(off_by_cents) < 1;
  }

  return {
    statement_kind: p.statement_kind === 'credit_card' ? 'credit_card' : 'bank',
    institution: p.institution || null,
    account_last4: (p.account_last4 || '').toString().replace(/\D/g, '').slice(-4) || null,
    period_start: /^\d{4}-\d{2}-\d{2}/.test(p.period_start || '') ? p.period_start.slice(0, 10) : null,
    period_end: /^\d{4}-\d{2}-\d{2}/.test(p.period_end || '') ? p.period_end.slice(0, 10) : null,
    opening_balance_cents: opening,
    closing_balance_cents: closing,
    transactions: txns,
    reconciles,
    off_by_cents,
    _raw: p,
    _duration_ms: Date.now() - t0,
  };
}

module.exports = { extractStatement, toCents };
