// ============================================================================
// lib/banking/extractors/bank_statement.js
// ----------------------------------------------------------------------------
// Extract a bank statement PDF (Bank of America, Chase, Wells Fargo, etc.)
// into structured data: beginning + ending balances, period dates, and
// every transaction line.
//
// Strategy: Claude binary-PDF read. Bank statements are PDF-form-overlay
// heavy and pdf-parse fails on most of them (Swim Houston scar in CLAUDE.md).
// Claude reads the whole statement reliably across vendors.
//
// Public API:
//   exports.extract(fileBuffer, mime, filename)
//     → {
//         period_start, period_end,
//         beginning_balance_cents, ending_balance_cents,
//         total_deposits_cents, total_withdrawals_cents,
//         total_fees_cents, total_interest_cents,
//         transactions: [{posting_date, amount_cents, description, check_number, transaction_type}],
//         bank_name, account_last4,
//         extraction_raw, warnings
//       }
// ============================================================================

const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = 'claude-sonnet-4-5';

const PROMPT = `You are reading a bank statement PDF for a property management company's HOA operating or reserve account.

Return ONLY valid JSON, no preamble, no markdown fences:

{
  "bank_name":               "string — bank name from statement header (e.g., 'Bank of America', 'Chase')",
  "account_last4":           "string — last 4 digits of the account number, or empty string",
  "period_start":            "YYYY-MM-DD — statement period start",
  "period_end":              "YYYY-MM-DD — statement period end",
  "beginning_balance_cents": <integer — period-opening balance in cents>,
  "ending_balance_cents":    <integer — period-closing balance in cents>,
  "total_deposits_cents":    <integer — sum of all credits/deposits in cents>,
  "total_withdrawals_cents": <integer — sum of all debits/withdrawals in cents>,
  "total_fees_cents":        <integer — sum of bank fees in cents>,
  "total_interest_cents":    <integer — sum of interest credits in cents>,
  "transactions": [
    {
      "posting_date":     "YYYY-MM-DD",
      "amount_cents":     <integer — SIGNED — positive for deposits/credits/interest, negative for checks/withdrawals/fees>,
      "description":      "string — line description as written on statement",
      "check_number":     "string or empty — digits only, e.g. '1234'; empty when not a check",
      "transaction_type": "one of: deposit, check, withdrawal, fee, interest, ach_in, ach_out, wire_in, wire_out, transfer, nsf, adjustment, other"
    }
  ],
  "warnings": ["string"]
}

CRITICAL RULES:
- Money values must be INTEGER CENTS (e.g. 250000 for "$2,500.00"). Never strings, never decimals.
- amount_cents is SIGNED. A check of $250 is -25000. A deposit of $1000 is 100000. Bank fee of $25 is -2500. Interest credit of $5 is 500.
- Check numbers must be DIGITS ONLY ("1234" not "Check #1234").
- transaction_type rules:
  * "check" — paper check clearing (has check_number)
  * "deposit" — direct deposit, OTC deposit, or batch deposit credit
  * "ach_in" / "ach_out" — ACH electronic transfers
  * "wire_in" / "wire_out" — wire transfers
  * "fee" — bank service fees, returned item fees, NSF fees, maintenance fees
  * "interest" — interest credit
  * "transfer" — internal account-to-account transfers
  * "nsf" — non-sufficient funds returns (homeowner check bounced)
  * "withdrawal" — generic debit when no other category fits
  * "other" — when truly unclassifiable
- Extract EVERY transaction line, including small fees and interest.
- If a field is not visible in the PDF, return null for that field — DO NOT guess.
- warnings: array of plain-English notes when something looks off (e.g., "ending balance per statement does not equal beginning + deposits - withdrawals — check for missing transactions").

Return ONLY the JSON. No markdown fences. No preamble.`;

async function extract(fileBuffer, mime, filename) {
  const t0 = Date.now();
  if (mime !== 'application/pdf') {
    throw new Error(`Bank statement extractor expects PDF; got mime=${mime}`);
  }

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 16000,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data: fileBuffer.toString('base64') },
        },
        { type: 'text', text: PROMPT },
      ],
    }],
  });

  const raw = (response.content || []).map((b) => b.text || '').join('').trim();
  // Diagnostic-first per CLAUDE.md
  console.log(`[bank_statement_extractor] raw (first 1200 chars): ${raw.slice(0, 1200)}`);

  let parsed;
  try {
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    parsed = JSON.parse(cleaned);
  } catch (err) {
    const stopReason = response.stop_reason;
    const hint = stopReason === 'max_tokens'
      ? ' Model hit max_tokens — bump cap or split statement.'
      : '';
    throw new Error(`Bank statement extraction returned malformed JSON.${hint} Parse: ${err.message}`);
  }

  // Defensive coercions — model occasionally returns strings for money fields.
  const moneyFields = [
    'beginning_balance_cents', 'ending_balance_cents',
    'total_deposits_cents', 'total_withdrawals_cents',
    'total_fees_cents', 'total_interest_cents',
  ];
  for (const k of moneyFields) {
    if (parsed[k] != null && typeof parsed[k] !== 'number') {
      const n = Number(String(parsed[k]).replace(/[$,]/g, ''));
      parsed[k] = Number.isFinite(n) ? Math.round(n) : null;
    }
  }
  parsed.transactions = (parsed.transactions || []).map((t) => {
    let amt = t.amount_cents;
    if (amt != null && typeof amt !== 'number') {
      const n = Number(String(amt).replace(/[$,]/g, ''));
      amt = Number.isFinite(n) ? Math.round(n) : null;
    }
    return {
      posting_date: t.posting_date || null,
      amount_cents: amt,
      description: t.description || '',
      check_number: t.check_number && String(t.check_number).trim() ? String(t.check_number).replace(/\D/g, '') : null,
      transaction_type: t.transaction_type || 'other',
    };
  });
  parsed.warnings = parsed.warnings || [];

  // Self-check: bank statement math should reconcile.
  if (parsed.beginning_balance_cents != null && parsed.ending_balance_cents != null) {
    const expectedEnding = parsed.beginning_balance_cents
      + (parsed.total_deposits_cents || 0)
      + (parsed.total_interest_cents || 0)
      - Math.abs(parsed.total_withdrawals_cents || 0)
      - Math.abs(parsed.total_fees_cents || 0);
    const diff = Math.abs(expectedEnding - parsed.ending_balance_cents);
    if (diff > 50) {   // tolerate < 50¢ rounding noise
      parsed.warnings.push(`Bank statement totals don't tie: beginning + deposits + interest - withdrawals - fees differs from ending by ${(diff / 100).toFixed(2)}. Likely a category mis-classification or a missing transaction.`);
    }
  }

  return {
    ...parsed,
    duration_ms: Date.now() - t0,
  };
}

module.exports = { extract };
