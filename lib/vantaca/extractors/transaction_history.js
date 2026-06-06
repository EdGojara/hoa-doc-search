// ============================================================================
// lib/vantaca/extractors/transaction_history.js
// ----------------------------------------------------------------------------
// Extract Vantaca's "Transaction History — Association" report. This is the
// PER-OWNER FULL LEDGER from Vantaca — every charge, every payment, every
// adjustment for every property in the association. THIS IS THE MIGRATION
// UNLOCK: when Quail Ridge migrates, export this from Vantaca on cutover
// day → drop here → replay each transaction into trustEd's AR sub-ledger.
//
// Contract matches other Vantaca extractors:
//   exports.run({ importRow, fileBuffer, mime, filename, community, supabase })
//     → { extraction_raw, row_count, downstream_table, downstream_count, warnings }
//
// extraction_raw holds the full per-property transaction list. A separate
// migration tool (lib/accounting/ar_migration.js — Phase 2B+) reads this
// from vantaca_imports.extraction_raw and replays into ar_charges +
// ar_payments + ar_payment_applications using the §209.0063 engine.
//
// This extractor's job is to EXTRACT FAITHFULLY. It does NOT post or apply.
// ============================================================================

const Anthropic = require('@anthropic-ai/sdk');
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const PROMPT = `You are reading a Vantaca "Transaction History — Association" PDF.
This report shows the per-owner full transaction history across an HOA's portfolio:
every assessment, late fee, interest charge, payment, NSF return, fine, attorney fee,
etc. — chronologically per property/owner.

Return ONLY valid JSON, no preamble, no markdown fences:

{
  "community_name":          "string from header or empty",
  "report_period_start":     "YYYY-MM-DD or empty",
  "report_period_end":       "YYYY-MM-DD or empty",
  "as_of_date":              "YYYY-MM-DD — the 'as of' date for ending balances",
  "owners": [
    {
      "property_address":    "string — street address as written on the report",
      "unit":                "string or null",
      "homeowner_name":      "string — primary account holder name",
      "account_number":      "string or null — Vantaca account ID",
      "beginning_balance_cents":  <integer or null — period-opening balance>,
      "ending_balance_cents":     <integer or null — period-closing balance>,
      "transactions": [
        {
          "transaction_date":  "YYYY-MM-DD",
          "type":              "charge | payment | adjustment | nsf_return | refund | writeoff",
          "category":          "assessment_regular | assessment_special | late_fee | interest | attorney_fee_assessment | attorney_fee_other | records_request_fee | fine | transfer_fee | resale_certificate_fee | nsf_fee | payment | other",
          "description":       "string — verbatim from report",
          "amount_cents":      <integer — SIGNED. Charges/adjustments increasing balance are POSITIVE. Payments/credits decreasing balance are NEGATIVE.>,
          "balance_after_cents": <integer or null — running balance after this transaction if shown>,
          "reference":         "string or null — check #, ACH ref, JE ref, etc.",
          "due_date":          "YYYY-MM-DD or null — for charges only, when stated"
        }
      ]
    }
  ],
  "warnings": ["string"]
}

CRITICAL RULES:
- Money values are INTEGER CENTS. Never strings, never decimals. "$1,234.56" → 123456.
- amount_cents SIGN convention:
    * charges, fees, interest, NSF returns → POSITIVE (they increase the owner's AR balance)
    * payments, refunds, write-offs that reduce balance → NEGATIVE
    * adjustments → signed per the report (if balance went up, positive; down, negative)
- category mapping (force exact strings):
    * Anything labeled "Assessment", "Regular Assessment", "Monthly Assessment" → "assessment_regular"
    * "Special Assessment" / "SA" → "assessment_special"
    * "Late Fee", "LF" → "late_fee"
    * "Interest", "Int" → "interest"
    * "Attorney Fee" if assessment-collection related → "attorney_fee_assessment"; if other → "attorney_fee_other"
    * "Records Request" → "records_request_fee"
    * "Fine", "Violation Fee" → "fine"
    * "Transfer Fee" → "transfer_fee"
    * "Resale Certificate" → "resale_certificate_fee"
    * "NSF", "Returned Check" → "nsf_fee"
    * Any payment → "payment"
    * Unclear → "other"
- Extract EVERY transaction line per owner. Don't skip "running balance" headers or grouping rows.
- account_number: capture the Vantaca account ID exactly as printed (digits only if numeric, alphanumeric otherwise).
- If a transaction shows BOTH a payment AND its automatic application breakdown on separate lines, capture the payment line as type='payment' and skip the application rows (we re-derive applications from the §209.0063 engine on replay).
- warnings: array of plain-English notes when something looks off:
    * "Owner X transactions don't tie: beginning + sum(amount_cents) doesn't equal ending"
    * "Could not classify category for transaction Y"

Return ONLY the JSON.`;

async function extractTransactionHistory(fileBuffer) {
  const t0 = Date.now();
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-5',
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
  console.log(`[transaction_history_extractor] raw first 1200: ${raw.slice(0, 1200)}`);

  let parsed;
  try {
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    parsed = JSON.parse(cleaned);
  } catch (err) {
    const stopReason = response.stop_reason;
    const hint = stopReason === 'max_tokens'
      ? ' Model hit max_tokens — split the report by date range or by half the properties.'
      : '';
    throw new Error(`Transaction history extraction returned malformed JSON.${hint} Parse: ${err.message}`);
  }

  // Defensive coercions
  parsed.owners = (parsed.owners || []).map((o) => {
    const txCoerce = (t) => {
      const coerceM = (v) => {
        if (v == null || v === '') return null;
        if (typeof v === 'number') return Math.round(v);
        const n = Number(String(v).replace(/[$,\s]/g, ''));
        return Number.isFinite(n) ? Math.round(n) : null;
      };
      return {
        transaction_date: t.transaction_date || null,
        type: t.type || 'other',
        category: t.category || 'other',
        description: t.description || '',
        amount_cents: coerceM(t.amount_cents) ?? 0,
        balance_after_cents: coerceM(t.balance_after_cents),
        reference: t.reference || null,
        due_date: t.due_date || null,
      };
    };
    return {
      property_address: o.property_address || '',
      unit: o.unit || null,
      homeowner_name: o.homeowner_name || '',
      account_number: o.account_number ? String(o.account_number) : null,
      beginning_balance_cents: o.beginning_balance_cents ?? null,
      ending_balance_cents: o.ending_balance_cents ?? null,
      transactions: (o.transactions || []).map(txCoerce),
    };
  });
  parsed.warnings = parsed.warnings || [];

  // Self-check per owner: beginning + sum(amount_cents) should equal ending
  for (const o of parsed.owners) {
    if (o.beginning_balance_cents != null && o.ending_balance_cents != null) {
      const sum = (o.transactions || []).reduce((acc, t) => acc + (t.amount_cents || 0), 0);
      const computed = o.beginning_balance_cents + sum;
      const diff = Math.abs(computed - o.ending_balance_cents);
      if (diff > 1) {
        parsed.warnings.push(`Owner '${o.homeowner_name || o.property_address || o.account_number || 'unknown'}' transactions don't tie: beginning + sum differs from ending by ${(diff / 100).toFixed(2)}`);
      }
    }
  }

  return { ...parsed, duration_ms: Date.now() - t0 };
}

async function run({ importRow, fileBuffer, mime, filename, community, supabase }) {
  if (mime !== 'application/pdf') {
    throw new Error(`Transaction history extractor expects PDF; got mime=${mime}`);
  }
  console.log(`[vantaca/transaction_history] extracting ${filename || '(unnamed)'} for community=${community?.name}`);
  const extracted = await extractTransactionHistory(fileBuffer);

  // Total transaction count across all owners
  const totalTransactions = (extracted.owners || []).reduce((acc, o) => acc + (o.transactions?.length || 0), 0);

  return {
    extraction_raw: extracted,
    row_count: totalTransactions,
    downstream_table: null,   // consumed in-place — migration tool replays from extraction_raw
    downstream_count: extracted.owners?.length || 0,
    warnings: extracted.warnings || [],
  };
}

module.exports = { run, extractTransactionHistory };
