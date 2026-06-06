// ============================================================================
// lib/vantaca/extractors/bank_reconciliation.js
// ----------------------------------------------------------------------------
// Extract Vantaca's "Bank Reconciliation" report PDF — the rec output from
// Vantaca's books. Used as MIGRATION INPUT for communities moving from
// Vantaca to trustEd: tells us what outstanding checks + deposits in
// transit + bank-side adjustments existed at the cutover date.
//
// Without this data, the cutover GL would be missing the floating items
// (uncashed checks from Vantaca's pre-cutover disbursements still pending
// at the bank). Extract it -> seed trustEd's bank_reconciliations on day 1
// -> first month-end rec ties cleanly.
//
// Contract matches other Vantaca extractors:
//   exports.run({ importRow, fileBuffer, mime, filename, community, supabase })
//     → { extraction_raw, row_count, downstream_table, downstream_count, warnings }
//
// extraction_raw holds the full rec data. The Quail Ridge migration tool
// (Phase 2B) reads from vantaca_imports.extraction_raw and seeds the
// trustEd bank_reconciliations + bank_reconciliation_items with the
// outstanding-check + DIT lists.
// ============================================================================

const Anthropic = require('@anthropic-ai/sdk');
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const PROMPT = `You are reading a Vantaca "Bank Reconciliation" report PDF for an HOA's
community bank account. The report shows the rec output: bank ending balance,
outstanding checks, deposits in transit, bank-side adjustments, and the
reconciled balance tying back to the GL.

Return ONLY valid JSON, no preamble, no markdown fences:

{
  "community_name":              "string from header or empty",
  "bank_name":                   "string — bank from header or empty",
  "bank_account_label":          "string — account nickname / GL account name or empty",
  "bank_account_last4":          "string — last 4 of account number or empty",
  "gl_account_number":           "string — GL account this rec ties to (e.g. '10100')",
  "statement_period_start":      "YYYY-MM-DD or empty",
  "statement_period_end":        "YYYY-MM-DD",

  "bank_ending_balance_cents":   <integer in cents>,
  "gl_ending_balance_cents":     <integer in cents>,

  "deposits_in_transit_total_cents":  <integer>,
  "outstanding_checks_total_cents":   <integer — POSITIVE absolute total>,
  "bank_only_adjustments_total_cents": <integer — signed>,
  "reconciled_balance_cents":    <integer>,
  "difference_cents":            <integer — reconciled minus GL; zero = balanced>,
  "balanced":                    <boolean — true if difference within $0.01>,

  "outstanding_checks": [
    {
      "check_number":   "string — digits only",
      "issue_date":     "YYYY-MM-DD or empty",
      "payee":          "string",
      "amount_cents":   <integer — POSITIVE absolute amount>,
      "memo":           "string or empty"
    }
  ],
  "deposits_in_transit": [
    {
      "deposit_date":   "YYYY-MM-DD or empty",
      "description":    "string",
      "amount_cents":   <integer — POSITIVE>
    }
  ],
  "bank_only_adjustments": [
    {
      "posting_date":   "YYYY-MM-DD or empty",
      "description":    "string — e.g. 'Bank fee', 'Interest income', 'NSF return'",
      "amount_cents":   <integer — SIGNED. Bank-side credits (interest in) POSITIVE; debits (fees, NSF) NEGATIVE>,
      "category":       "fee | interest | nsf | adjustment | other"
    }
  ],

  "warnings": ["string"]
}

CRITICAL RULES:
- All money values are INTEGER CENTS. "$1,234.56" → 123456. "$ (250.00)" → -25000 (parens = negative).
- Outstanding check totals are POSITIVE absolute numbers. The rec math (bank ending - outstanding + DIT = reconciled) handles the sign.
- check_number: digits only ("1234" not "Check #1234").
- gl_account_number: capture the GL account # this rec ties to. Vantaca typically prints it in the header (e.g. "1010 - Cash - Operating"). If only the name is shown (no number), return empty string.
- Extract EVERY outstanding check and DIT line — do not summarize.
- bank_only_adjustments are bank-side items not on GL (fees, interest, NSF returns). Vantaca rec usually lists these separately. category should be inferred from the description.
- If the rec shows total counts (e.g. "12 outstanding checks totaling $X"), use those as a SELF-CHECK: warn if sum of extracted line items doesn't match the stated total.
- warnings examples:
    * "Outstanding checks list count differs from header total by N"
    * "GL ending balance not stated — only bank side present"
    * "Reconciliation is not balanced — difference of $X"

Return ONLY the JSON.`;

async function extractBankReconciliation(fileBuffer) {
  const t0 = Date.now();
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 12000,
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
  console.log(`[bank_reconciliation_extractor] raw first 1200: ${raw.slice(0, 1200)}`);

  let parsed;
  try {
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new Error(`Bank reconciliation extraction returned malformed JSON. Parse: ${err.message}`);
  }

  // Defensive coercions
  const coerceM = (v) => {
    if (v == null || v === '') return null;
    if (typeof v === 'number') return Math.round(v);
    const n = Number(String(v).replace(/[$,\s]/g, '').replace(/^\((.+)\)$/, '-$1'));
    return Number.isFinite(n) ? Math.round(n) : null;
  };

  const moneyFields = [
    'bank_ending_balance_cents', 'gl_ending_balance_cents',
    'deposits_in_transit_total_cents', 'outstanding_checks_total_cents',
    'bank_only_adjustments_total_cents', 'reconciled_balance_cents', 'difference_cents',
  ];
  for (const f of moneyFields) parsed[f] = coerceM(parsed[f]);

  parsed.outstanding_checks = (parsed.outstanding_checks || []).map((c) => ({
    check_number: c.check_number ? String(c.check_number).replace(/\D/g, '') : null,
    issue_date: c.issue_date || null,
    payee: c.payee || '',
    amount_cents: coerceM(c.amount_cents) ?? 0,
    memo: c.memo || '',
  }));
  parsed.deposits_in_transit = (parsed.deposits_in_transit || []).map((d) => ({
    deposit_date: d.deposit_date || null,
    description: d.description || '',
    amount_cents: coerceM(d.amount_cents) ?? 0,
  }));
  parsed.bank_only_adjustments = (parsed.bank_only_adjustments || []).map((a) => ({
    posting_date: a.posting_date || null,
    description: a.description || '',
    amount_cents: coerceM(a.amount_cents) ?? 0,
    category: ['fee', 'interest', 'nsf', 'adjustment', 'other'].includes(a.category) ? a.category : 'other',
  }));
  parsed.warnings = parsed.warnings || [];

  // Self-checks
  const sumOC = parsed.outstanding_checks.reduce((s, c) => s + Math.abs(c.amount_cents || 0), 0);
  if (parsed.outstanding_checks_total_cents != null) {
    const diff = Math.abs(sumOC - Math.abs(parsed.outstanding_checks_total_cents));
    if (diff > 1) {
      parsed.warnings.push(`Outstanding checks sum (${(sumOC / 100).toFixed(2)}) differs from stated total (${(parsed.outstanding_checks_total_cents / 100).toFixed(2)}) by ${(diff / 100).toFixed(2)}`);
    }
  }
  const sumDIT = parsed.deposits_in_transit.reduce((s, d) => s + (d.amount_cents || 0), 0);
  if (parsed.deposits_in_transit_total_cents != null) {
    const diff = Math.abs(sumDIT - parsed.deposits_in_transit_total_cents);
    if (diff > 1) {
      parsed.warnings.push(`DIT sum (${(sumDIT / 100).toFixed(2)}) differs from stated total (${(parsed.deposits_in_transit_total_cents / 100).toFixed(2)}) by ${(diff / 100).toFixed(2)}`);
    }
  }
  // Math tie-out: bank_ending - outstanding + DIT + bank_only = reconciled
  if (parsed.bank_ending_balance_cents != null && parsed.reconciled_balance_cents != null) {
    const computed = parsed.bank_ending_balance_cents
      - Math.abs(parsed.outstanding_checks_total_cents || 0)
      + (parsed.deposits_in_transit_total_cents || 0)
      + (parsed.bank_only_adjustments_total_cents || 0);
    const diff = Math.abs(computed - parsed.reconciled_balance_cents);
    if (diff > 100) {  // tolerate $1 of rounding noise
      parsed.warnings.push(`Reconciliation math doesn't tie: bank_ending - outstanding + DIT + adj differs from stated reconciled by ${(diff / 100).toFixed(2)}`);
    }
  }

  return { ...parsed, duration_ms: Date.now() - t0 };
}

async function run({ importRow, fileBuffer, mime, filename, community, supabase }) {
  if (mime !== 'application/pdf') {
    throw new Error(`Bank reconciliation extractor expects PDF; got mime=${mime}`);
  }
  console.log(`[vantaca/bank_reconciliation] extracting ${filename || '(unnamed)'} for community=${community?.name}`);
  const extracted = await extractBankReconciliation(fileBuffer);
  return {
    extraction_raw: extracted,
    row_count: (extracted.outstanding_checks?.length || 0) + (extracted.deposits_in_transit?.length || 0) + (extracted.bank_only_adjustments?.length || 0),
    downstream_table: null,
    downstream_count: (extracted.outstanding_checks?.length || 0) + (extracted.deposits_in_transit?.length || 0),
    warnings: extracted.warnings || [],
  };
}

module.exports = { run, extractBankReconciliation };
