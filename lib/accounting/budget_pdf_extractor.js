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
const XLSX = require('xlsx');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const EXCEL_MIMES = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
  'application/vnd.ms-excel', // .xls
  'text/csv', // .csv
  'application/csv',
]);

// Flatten every sheet of a workbook into a tab-delimited text grid Claude can
// read. Excel can't be passed as a `document` content block, so we hand the
// model the same tabular data as plain text and run the identical prompt.
function workbookToText(fileBuffer) {
  const wb = XLSX.read(fileBuffer, { type: 'buffer', cellDates: false });
  const parts = [];
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    if (!ws) continue;
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' });
    const nonEmpty = rows.filter((r) => (r || []).some((c) => String(c).trim() !== ''));
    if (!nonEmpty.length) continue;
    parts.push(`### SHEET: ${name}`);
    parts.push(nonEmpty.map((r) => r.map((c) => String(c).replace(/\t/g, ' ')).join('\t')).join('\n'));
  }
  return parts.join('\n\n');
}

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
  "reserve_projects": [
    {
      "project_name":              "string — the project/item name as printed (e.g. 'Tennis Court Fence/Resurface')",
      "category":                  "string or null — a short grouping if obvious (Pool, Gates, Landscape, Signage)",
      "planned_amount_cents":      <integer — planned cost in cents>,
      "note":                      "string or null — any note printed next to the item"
    }
  ],
  "warnings": ["string"]
}

CRITICAL RULES:
- All money values are INTEGER CENTS. "$1,200.00" → 120000. "$72,000" → 7200000. Never strings, never decimals.
- account_number: digits only, as printed ("40100" stays "40100"; "4-0100" becomes "40100").
- monthly_amounts_cents: ALWAYS a 12-element array. If the budget shows only annual totals (no monthly column), evenly distribute the annual amount across 12 months (annual_amount_cents / 12, rounded; put any rounding residue in December's slot so the sum equals annual_amount_cents).
- MULTI-YEAR COLUMNS: many "proposed budget" PDFs show two or more years side by side (e.g. columns "2026" and "2025"), often with a "% Variance" column. Extract ONLY the column for the budget/proposed year named in the document title or heading (usually the NEWEST year, e.g. the "2026 Proposed" column). NEVER take the prior-year column, and NEVER mix years across line items. Column order on the page is NOT reliable — the proposed year is sometimes the first number, sometimes the second. When a "% Variance" column is present, use it to DISAMBIGUATE which number is the proposed year: variance = (proposed − prior) / prior. Pick the pairing of the two numbers that reproduces the printed variance percent. Set fiscal_year to that proposed year and add a warning naming which value you used for a sample account (e.g. "4000 proposed=X, prior=Y, variance Z% confirms proposed column").
- If the budget shows quarterly totals, distribute each quarter across its 3 months.
- account_type inference: anything that's INCOME / REVENUE / FEES / ASSESSMENTS → "revenue". Anything that's EXPENSE / COST / SPENDING / OUTLAY → "expense". When unclear, use the section heading context.
- fund_hint: Operating accounts typically include management fees, landscaping, insurance, utilities, repairs. Reserve accounts are explicitly labeled "Reserve" or "Capital" or appear under a Reserve section heading. Use "OPR" by default for revenue + operating expenses; use "RES" only when the line item is clearly a reserve allocation.
- RESERVE / CAPITAL PROJECT SHEET: a workbook often has a SEPARATE sheet (labeled "Reserve", "Reserves", "Capital", "Reserve Expenses", or similar) listing planned capital PROJECTS as named items — e.g. "Pool Area", "Tennis Court Fence/Resurface", "Entry Monument", "Gate Spike Strips" — usually WITHOUT GL account numbers, each with a dollar amount and sometimes a note. Put EVERY such project in "reserve_projects" (NOT in line_items). Do not force a project into line_items just because it lacks an account number, and do not drop it. The reserve CONTRIBUTION / transfer-to-reserves line (which DOES have a GL account) stays in line_items with fund_hint "RES". If there is no reserve project sheet, return reserve_projects as [].
- Extract EVERY line item shown. Don't skip subtotals or rolled-up categories unless they're clearly just visual summary rows with no own budget value. Ignore a reserve sheet's grand-total row (it's the sum of the projects, not a project).
- warnings: array of plain-English notes for anomalies (totals don't add, missing accounts, ambiguous fund attribution).

Return ONLY the JSON. No markdown fences.`;

async function extractBudget(fileBuffer, mime, filename) {
  const isExcel = EXCEL_MIMES.has(mime) || /\.(xlsx|xls|csv)$/i.test(filename || '');
  const isPdf = mime === 'application/pdf' || /\.pdf$/i.test(filename || '');
  if (!isExcel && !isPdf) {
    throw new Error(`Budget extractor expects a PDF or Excel file; got mime=${mime}`);
  }
  const t0 = Date.now();

  let content;
  if (isExcel) {
    const grid = workbookToText(fileBuffer);
    if (!grid.trim()) {
      throw new Error('Budget spreadsheet had no readable rows on any sheet.');
    }
    content = [{ type: 'text', text: `${PROMPT}\n\nHere is the budget spreadsheet as a tab-delimited grid (one block per sheet):\n\n${grid}` }];
  } else {
    content = [
      {
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: fileBuffer.toString('base64') },
      },
      { type: 'text', text: PROMPT },
    ];
  }

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 16000,
    messages: [{ role: 'user', content }],
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
  // Reserve capital-project lines (named projects, usually no GL account).
  const coerceCents = (v) => {
    if (v == null || v === '') return 0;
    if (typeof v === 'number') return Math.round(v);
    const n = Number(String(v).replace(/[$,\s]/g, ''));
    return Number.isFinite(n) ? Math.round(n) : 0;
  };
  parsed.reserve_projects = (parsed.reserve_projects || [])
    .map((p) => ({
      project_name: String(p.project_name || '').trim(),
      category: p.category ? String(p.category).trim() : null,
      planned_amount_cents: coerceCents(p.planned_amount_cents),
      note: p.note ? String(p.note).trim() : null,
    }))
    .filter((p) => p.project_name && p.planned_amount_cents !== 0);
  parsed.warnings = parsed.warnings || [];

  return { ...parsed, duration_ms: Date.now() - t0 };
}

module.exports = { extractBudget };
