// ============================================================================
// lib/vantaca/extractors/check_register.js
// ----------------------------------------------------------------------------
// Extract a Vantaca check register PDF — list of all checks issued from
// a community bank account during a period. Used by the bank reconciliation
// workflow to identify outstanding checks (issued but not yet cleared).
//
// Contract matches other Vantaca extractors:
//   exports.run({ importRow, fileBuffer, mime, filename, community, supabase })
//     → { extraction_raw, row_count, downstream_table, downstream_count, warnings }
//
// Unlike AR Aging which fans out to its own snapshot table, check register
// data lives ONLY in the vantaca_imports.extraction_raw JSONB field —
// it's input for the bank rec workflow, not a queryable surface on its own.
// The bank rec workflow reads it from extraction_raw via the import_id link.
// ============================================================================

const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = 'claude-sonnet-4-5';

const PROMPT = `You are reading a Vantaca check register PDF for an HOA. The check register lists every check issued from a community bank account during a period.

Return ONLY valid JSON, no preamble, no markdown fences:

{
  "period_start":           "YYYY-MM-DD or empty",
  "period_end":             "YYYY-MM-DD or empty",
  "bank_account_label":     "string — account name/nickname from report header (e.g., 'Operating BoA #1234') or empty",
  "gl_account_number":      "string — GL account number from header (e.g., '1010') or empty",
  "total_checks_issued":    <integer count>,
  "total_amount_cents":     <integer — sum of all check amounts in cents>,
  "checks": [
    {
      "check_number":  "string — digits only, e.g. '1234'",
      "issue_date":    "YYYY-MM-DD",
      "amount_cents":  <integer — POSITIVE integer cents (checks are listed as positive amounts in a register)>,
      "payee":         "string — payee name",
      "memo":          "string or empty — payment memo/description if shown",
      "status":        "outstanding | cleared | voided | stopped — if the register indicates status; otherwise 'outstanding'",
      "cleared_date":  "YYYY-MM-DD or empty — if status='cleared'"
    }
  ],
  "warnings": ["string"]
}

CRITICAL RULES:
- Money values are INTEGER CENTS (5000 for "$50.00"). Never strings, never decimals.
- Check numbers DIGITS ONLY ("1234" not "Check #1234" and not "#1234").
- Extract EVERY check row, including voided ones.
- status defaults to "outstanding" when register doesn't specify (most registers don't — they list checks issued, status is inferred by absence on bank statement).
- voided checks have amount_cents = 0 (or the original amount with status='voided' — capture whichever the register shows).
- warnings: array of plain-English notes for anomalies (gaps in check sequence, voided checks needing follow-up, etc.).

Return ONLY the JSON. No markdown fences.`;

async function extractCheckRegister(fileBuffer) {
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
  console.log(`[check_register_extractor] raw (first 1000 chars): ${raw.slice(0, 1000)}`);

  let parsed;
  try {
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new Error(`Check register extraction returned malformed JSON. Parse: ${err.message}`);
  }

  // Defensive coercions
  parsed.checks = (parsed.checks || []).map((c) => {
    let amt = c.amount_cents;
    if (amt != null && typeof amt !== 'number') {
      const n = Number(String(amt).replace(/[$,]/g, ''));
      amt = Number.isFinite(n) ? Math.round(n) : null;
    }
    return {
      check_number: c.check_number ? String(c.check_number).replace(/\D/g, '') : null,
      issue_date: c.issue_date || null,
      amount_cents: amt,
      payee: c.payee || '',
      memo: c.memo || '',
      status: ['outstanding', 'cleared', 'voided', 'stopped'].includes(c.status) ? c.status : 'outstanding',
      cleared_date: c.cleared_date || null,
    };
  });
  parsed.warnings = parsed.warnings || [];

  return { ...parsed, duration_ms: Date.now() - t0 };
}

// Vantaca extractor contract — the orchestrator calls this.
async function run({ importRow, fileBuffer, mime, filename, community, supabase }) {
  if (mime !== 'application/pdf') {
    throw new Error(`Check register extractor expects PDF; got mime=${mime}`);
  }
  console.log(`[vantaca/check_register] extracting ${filename || '(unnamed)'} for community=${community?.name}`);
  const extracted = await extractCheckRegister(fileBuffer);

  // The check register doesn't need a per-row downstream table — the bank
  // rec workflow consumes the JSON directly from vantaca_imports.extraction_raw
  // via the import_id link. We still record row_count for the dashboard.
  return {
    extraction_raw: extracted,
    row_count: extracted.checks?.length || 0,
    downstream_table: null,                  // consumed in-place from extraction_raw
    downstream_count: extracted.checks?.length || 0,
    warnings: extracted.warnings || [],
  };
}

module.exports = { run, extractCheckRegister };
