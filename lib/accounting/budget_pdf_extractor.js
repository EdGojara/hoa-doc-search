// ============================================================================
// lib/accounting/budget_pdf_extractor.js
// ----------------------------------------------------------------------------
// Extract a community's annual budget from a Vantaca (or similar HOA
// accounting platform) projected budget PDF.
//
// Output shape:
//   {
//     community_name,
//     fiscal_year,
//     line_items: [{
//       account_number,
//       account_name,
//       account_type,            // 'revenue' | 'expense' (inferred)
//       fund_hint,                // 'OPR' | 'RES' | null — inferred from heading
//       annual_amount_cents,
//       monthly_amounts_cents: [12 numbers, or evenly-split when only annual shown]
//     }],
//     warnings: []
//   }
//
// Claude binary-PDF read (Swim Houston scar). pdf-parse fails on Vantaca's
// form-overlay PDFs.
// ============================================================================

const Anthropic = require('@anthropic-ai/sdk');
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const PROMPT = `You are reading an HOA's annual projected budget PDF. The budget breaks down revenue and expenses for the fiscal year by account, often with monthly breakouts.

Return ONLY valid JSON, no preamble:

{
  "community_name":           "string from header or empty",
  "fiscal_year":              <4-digit integer>,
  "line_items": [
    {
      "account_number":            "string — account number as printed (digits as string)",
      "account_name":              "string — account name as printed",
      "account_type":              "revenue | expense",
      "fund_hint":                 "OPR | RES | null — Operating, Reserve, or null if unclear",
      "annual_amount_cents":       <integer — total annual budgeted amount in cents>,
      "monthly_amounts_cents":     [<12 integers in cents — index 0=Jan ... 11=Dec>]
    }
  ],
  "warnings": ["string"]
}

CRITICAL RULES:
- All money values are INTEGER CENTS. "$1,200.00" → 120000. "$72,000" → 7200000. Never strings, never decimals.
- account_number: digits only, as printed ("40100" stays "40100"; "4-0100" becomes "40100").
- monthly_amounts_cents: ALWAYS a 12-element array. If the budget shows only annual totals (no monthly column), evenly distribute the annual amount across 12 months (annual_amount_cents / 12, rounded; put any rounding residue in December's slot so the sum equals annual_amount_cents).
- If the budget shows quarterly totals, distribute each quarter across its 3 months.
- account_type inference: anything that's INCOME / REVENUE / FEES / ASSESSMENTS → "revenue". Anything that's EXPENSE / COST / SPENDING / OUTLAY → "expense". When unclear, use the section heading context.
- fund_hint: Operating accounts typically include management fees, landscaping, insurance, utilities, repairs. Reserve accounts are explicitly labeled "Reserve" or "Capital" or appear under a Reserve section heading. Use "OPR" by default for revenue + operating expenses; use "RES" only when the line item is clearly a reserve allocation.
- Extract EVERY line item shown. Don't skip subtotals or rolled-up categories unless they're clearly just visual summary rows with no own budget value.
- warnings: array of plain-English notes for anomalies (totals don't add, missing accounts, ambiguous fund attribution).

Return ONLY the JSON. No markdown fences.`;

async function extractBudget(fileBuffer, mime, filename) {
  if (mime !== 'application/pdf') {
    throw new Error(`Budget extractor expects PDF; got mime=${mime}`);
  }
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
  console.log(`[budget_extractor] raw first 1200: ${raw.slice(0, 1200)}`);

  let parsed;
  try {
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new Error(`Budget extraction returned malformed JSON. Parse: ${err.message}`);
  }

  // Defensive coercions
  parsed.line_items = (parsed.line_items || []).map((it) => {
    const coerce = (v) => {
      if (v == null || v === '') return 0;
      if (typeof v === 'number') return Math.round(v);
      const n = Number(String(v).replace(/[$,\s]/g, ''));
      return Number.isFinite(n) ? Math.round(n) : 0;
    };
    let monthly = Array.isArray(it.monthly_amounts_cents)
      ? it.monthly_amounts_cents.map(coerce)
      : [];
    if (monthly.length !== 12) {
      // Even-split fallback if model didn't comply
      const annual = coerce(it.annual_amount_cents);
      const each = Math.floor(annual / 12);
      monthly = Array(12).fill(each);
      monthly[11] += annual - each * 12; // residue → December
    }
    return {
      account_number: String(it.account_number || '').replace(/\D/g, ''),
      account_name: it.account_name || '',
      account_type: it.account_type === 'revenue' ? 'revenue' : 'expense',
      fund_hint: ['OPR', 'RES'].includes(it.fund_hint) ? it.fund_hint : null,
      annual_amount_cents: coerce(it.annual_amount_cents),
      monthly_amounts_cents: monthly,
    };
  });
  parsed.warnings = parsed.warnings || [];

  return { ...parsed, duration_ms: Date.now() - t0 };
}

module.exports = { extractBudget };
