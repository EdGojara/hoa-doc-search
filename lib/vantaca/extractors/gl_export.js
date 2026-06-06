// ============================================================================
// lib/vantaca/extractors/gl_export.js
// ----------------------------------------------------------------------------
// Extract a Vantaca GL export PDF — focused on the CASH account ledger
// (operating or reserve) for use in bank reconciliation. Generic GL
// extraction (full trial balance) can use a different shape later — this
// one optimizes for "ledger of a single cash account for one period."
//
// Contract:
//   exports.run({ importRow, fileBuffer, mime, filename, community, supabase })
//     → { extraction_raw, row_count, downstream_table, downstream_count, warnings }
//
// GL data lives in vantaca_imports.extraction_raw — the bank rec workflow
// consumes it via the import_id link. A future Phase 2 will fan out to a
// proper gl_snapshots table when board-packet financials need it.
// ============================================================================

const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = 'claude-sonnet-4-5';

const PROMPT = `You are reading a Vantaca general ledger export PDF, focused on a single CASH account (operating or reserve) for a single period. This data feeds a bank reconciliation.

Return ONLY valid JSON, no preamble, no markdown fences:

{
  "period_start":              "YYYY-MM-DD or empty",
  "period_end":                "YYYY-MM-DD or empty",
  "gl_account_number":         "string — GL account number from header (e.g., '1010')",
  "gl_account_name":           "string — account name (e.g., 'Cash — Operating BoA')",
  "beginning_balance_cents":   <integer — period-opening GL balance in cents (signed)>,
  "ending_balance_cents":      <integer — period-closing GL balance in cents (signed)>,
  "total_debits_cents":        <integer — sum of period debits in cents>,
  "total_credits_cents":       <integer — sum of period credits in cents>,
  "entries": [
    {
      "posting_date":  "YYYY-MM-DD",
      "ref":           "string — Vantaca journal/entry ref (e.g., 'CD12345', 'CR-9876') or empty",
      "description":   "string — entry description",
      "debit_cents":   <integer — debit amount in cents, 0 if credit>,
      "credit_cents":  <integer — credit amount in cents, 0 if debit>,
      "amount_signed_cents": <integer — POSITIVE for debits (increase to cash), NEGATIVE for credits (decrease to cash). This is the convention bank reconciliation uses; cash account is an asset so debits increase it.>,
      "check_number":  "string — digits only if entry references a check; empty otherwise",
      "entry_type":    "deposit | check | bank_fee | interest | journal | transfer | ach | wire | other"
    }
  ],
  "warnings": ["string"]
}

CRITICAL RULES:
- Money values are INTEGER CENTS. Never strings, never decimals.
- amount_signed_cents convention: cash is an asset. DEBITS increase cash (deposits → positive amount_signed_cents). CREDITS decrease cash (checks, fees → negative amount_signed_cents). This makes the bank rec math consistent with bank statement transaction signing.
- Check entries: capture check_number as digits only. Match the entry_type to "check".
- entry_type guidance:
  * "deposit" — homeowner payments, miscellaneous deposits posted to cash
  * "check" — check disbursements
  * "bank_fee" — bank service charges posted from bank to GL
  * "interest" — interest credits
  * "journal" — manual journal entries
  * "transfer" — internal transfers between Bedrock-managed accounts
  * "ach" / "wire" — electronic in/out
- If the same GL line shows both a debit AND a credit, that's unusual — flag in warnings.
- warnings: notes for anomalies (out-of-period entries, missing references, balance mismatches).

Return ONLY the JSON.`;

async function extractGlExport(fileBuffer) {
  const t0 = Date.now();
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
  console.log(`[gl_export_extractor] raw (first 1000 chars): ${raw.slice(0, 1000)}`);

  let parsed;
  try {
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new Error(`GL extraction returned malformed JSON. Parse: ${err.message}`);
  }

  parsed.entries = (parsed.entries || []).map((e) => {
    const coerce = (v) => {
      if (v == null || v === '') return 0;
      if (typeof v === 'number') return Math.round(v);
      const n = Number(String(v).replace(/[$,]/g, ''));
      return Number.isFinite(n) ? Math.round(n) : 0;
    };
    return {
      posting_date: e.posting_date || null,
      ref: e.ref || '',
      description: e.description || '',
      debit_cents: coerce(e.debit_cents),
      credit_cents: coerce(e.credit_cents),
      amount_signed_cents: coerce(e.amount_signed_cents),
      check_number: e.check_number ? String(e.check_number).replace(/\D/g, '') : null,
      entry_type: e.entry_type || 'other',
    };
  });
  parsed.warnings = parsed.warnings || [];

  // Self-check
  if (parsed.beginning_balance_cents != null && parsed.ending_balance_cents != null) {
    const computedEnd = parsed.beginning_balance_cents
      + (parsed.total_debits_cents || 0)
      - (parsed.total_credits_cents || 0);
    const diff = Math.abs(computedEnd - parsed.ending_balance_cents);
    if (diff > 50) {
      parsed.warnings.push(`GL totals don't tie: beginning + debits - credits differs from ending by ${(diff / 100).toFixed(2)}. Possible missing entries or extraction error.`);
    }
  }

  return { ...parsed, duration_ms: Date.now() - t0 };
}

async function run({ importRow, fileBuffer, mime, filename, community, supabase }) {
  if (mime !== 'application/pdf') {
    throw new Error(`GL extractor expects PDF; got mime=${mime}`);
  }
  console.log(`[vantaca/gl_export] extracting ${filename || '(unnamed)'} for community=${community?.name}`);
  const extracted = await extractGlExport(fileBuffer);
  return {
    extraction_raw: extracted,
    row_count: extracted.entries?.length || 0,
    downstream_table: null,
    downstream_count: extracted.entries?.length || 0,
    warnings: extracted.warnings || [],
  };
}

module.exports = { run, extractGlExport };
