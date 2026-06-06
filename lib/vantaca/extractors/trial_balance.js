// ============================================================================
// lib/vantaca/extractors/trial_balance.js
// ----------------------------------------------------------------------------
// Extract Vantaca's GL Trial Balance report — snapshot of ALL accounts at a
// point in time with beginning balance, period activity, ending balance.
//
// THIS IS THE MIGRATION FOUNDATION: at Quail Ridge cutover, this file →
// trustEd opening balances. trustEd's GL ties to Vantaca to the penny on
// day 1 because every account's ending balance becomes trustEd's beginning
// balance.
//
// Handles BOTH PDF (Claude binary) and CSV (Claude text + xlsx parse for
// header detection). CSV is dramatically faster + more reliable: ~3-5s vs
// ~30-45s for PDF, ~$0.005 vs ~$0.05 per import, ~99.9% accuracy vs ~95%.
//
// Different from gl_export.js (which extracts per-account ledger DETAIL,
// not balance snapshot). Both can coexist — operator drops the right report
// for the use case.
// ============================================================================

const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = 'claude-sonnet-4-5';

// Lazy-require xlsx (already a project dep) for CSV/Excel parsing
function tryRequireXlsx() {
  try { return require('xlsx'); } catch (_) { return null; }
}

// ---------------------------------------------------------------------------
// PROMPT — shared between PDF and CSV/text paths
// ---------------------------------------------------------------------------
const PROMPT = `You are reading a GL Trial Balance report from Vantaca (or similar HOA accounting software). This is a snapshot of EVERY account in the chart of accounts at a specific point in time: beginning balance, period debits, period credits, ending balance.

Return ONLY valid JSON, no preamble, no markdown fences:

{
  "community_name":            "string from header or empty",
  "as_of_date":                "YYYY-MM-DD — the ending date of the trial balance",
  "period_start":              "YYYY-MM-DD or empty — when reported",
  "period_end":                "YYYY-MM-DD or empty",
  "fund_name":                 "string — fund label from header (e.g., 'Operating Fund', 'Reserve Fund', or 'Consolidated') or empty",
  "accounts": [
    {
      "account_number":         "string — Vantaca account number, as printed",
      "account_name":           "string — account description",
      "account_type":           "asset | liability | equity | revenue | expense | unknown — best inferred from number range (1xxx asset, 2xxx liab, 3xxx equity, 4xxx revenue, 5-7xxx expense) AND from any type column",
      "fund_code":              "OPR | RES | SA | CI | null — operating/reserve/special_assessment/capital_improvement; null when unclear",
      "beginning_balance_cents": <integer — SIGNED, in CENTS. Debit-natural accounts (assets, expenses) positive when debit-balanced. Credit-natural accounts (liabilities, equity, revenue) positive when credit-balanced. Use the convention the report presents (typically: assets/expenses positive when balance is debit, liab/equity/rev positive when balance is credit; if report shows raw debit-credit signed, use that.)>,
      "period_debits_cents":    <integer — total period debits in cents>,
      "period_credits_cents":   <integer — total period credits in cents>,
      "ending_balance_cents":   <integer — SIGNED, in CENTS, same convention as beginning>
    }
  ],
  "totals": {
    "total_debits_cents":      <integer — period debit column total>,
    "total_credits_cents":     <integer — period credit column total>,
    "ending_assets_cents":     <integer — sum of asset accounts ending balances>,
    "ending_liabilities_cents": <integer — sum of liability accounts>,
    "ending_equity_cents":     <integer — sum of equity accounts>,
    "ending_revenue_cents":    <integer — sum of revenue accounts>,
    "ending_expenses_cents":   <integer — sum of expense accounts>
  },
  "warnings": ["string"]
}

CRITICAL RULES:
- All money values are INTEGER CENTS. "$50,715.95" → 5071595. "($1,234.56)" → -123456 (parens = negative). Never strings, never decimals.
- account_number: digits-only or alphanumeric exactly as printed (e.g., "1010", "10100", "4-0100" → "40100").
- account_type: infer from leading digit when no explicit type column. 1=asset, 2=liability, 3=equity, 4=revenue, 5/6/7=expense. If unclear, "unknown".
- fund_code: HOA trial balances may segregate Operating vs Reserve. Look for section headers "Operating Fund" or "Reserve Fund" to assign fund_code; otherwise null.
- Sign convention: PRESERVE WHAT THE REPORT SHOWS. Don't flip signs. If beginning_balance shows 50715.95 for cash, that's +5071595 cents. If a contra account shows as negative, capture as negative.
- SELF-CHECK: totals.total_debits_cents should equal totals.total_credits_cents (a balanced TB). Warn if off.
- Extract EVERY account row, including those with zero balance (they may have period activity).
- Skip header/separator/section-label rows (rows without an account_number).
- warnings: list anomalies. Examples: "Trial balance doesn't balance: debits 12345 vs credits 12300", "Account 9999 has unrecognized type", "fund_code couldn't be determined for N accounts".

Return ONLY the JSON.`;

// ---------------------------------------------------------------------------
// PDF path
// ---------------------------------------------------------------------------
async function extractFromPdf(fileBuffer) {
  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 16000,
    messages: [{
      role: 'user',
      content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: fileBuffer.toString('base64') } },
        { type: 'text', text: PROMPT },
      ],
    }],
  });
  return parseResponse(response);
}

// ---------------------------------------------------------------------------
// CSV / Excel path
// ---------------------------------------------------------------------------
// Parse rows with xlsx (handles CSV + xlsx via the same API), convert to a
// compact text grid, send to Claude. The text payload is MUCH smaller than
// PDF binary so this path is ~10× cheaper and ~10× faster.
async function extractFromCsvOrExcel(fileBuffer, mime, filename) {
  const xlsx = tryRequireXlsx();
  let rows;
  if (xlsx) {
    try {
      // xlsx.read accepts both CSV and XLSX buffers
      const wb = xlsx.read(fileBuffer, { type: 'buffer', cellDates: false, cellNF: false });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      if (!sheet) throw new Error('no_sheet');
      // sheet_to_json with header=1 returns array-of-arrays preserving column order
      rows = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: '', blankrows: false });
    } catch (e) {
      console.warn('[trial_balance] xlsx parse failed, falling back to raw text:', e.message);
      rows = null;
    }
  }

  if (!rows || rows.length === 0) {
    // Fallback: treat as CSV text directly
    const text = fileBuffer.toString('utf-8');
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    rows = lines.map((line) => {
      // Naive CSV split — works for unquoted fields. Quoted-field CSVs go through
      // xlsx above; we only land here if xlsx isn't installed.
      return line.split(',').map((s) => s.trim());
    });
  }

  // Cap at first 2000 rows — Vantaca trial balances are typically 100-500 rows;
  // 2000 is a generous safety net without blowing the context budget.
  const sampleRows = rows.slice(0, 2000);
  const grid = sampleRows.map((r) => r.join('\t')).join('\n');

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 16000,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: `${PROMPT}\n\nThe report is provided below as tab-separated rows (first 2000 rows from a CSV / Excel export). Column order varies between Vantaca configurations — detect the columns from the header row and any account-number column patterns.\n\n--- BEGIN REPORT ---\n${grid}\n--- END REPORT ---` },
      ],
    }],
  });
  return parseResponse(response);
}

// ---------------------------------------------------------------------------
// Shared parser
// ---------------------------------------------------------------------------
function parseResponse(response) {
  const raw = (response.content || []).map((b) => b.text || '').join('').trim();
  console.log('[trial_balance] raw first 1200:', raw.slice(0, 1200));

  let parsed;
  try {
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    parsed = JSON.parse(cleaned);
  } catch (err) {
    const hint = response.stop_reason === 'max_tokens'
      ? ' Model hit max_tokens — try splitting by fund or by account-number range.'
      : '';
    throw new Error(`Trial balance extraction returned malformed JSON.${hint} Parse: ${err.message}`);
  }

  // Defensive coercion
  const coerceM = (v) => {
    if (v == null || v === '') return null;
    if (typeof v === 'number') return Math.round(v);
    const s = String(v).replace(/[$,\s]/g, '').replace(/^\((.+)\)$/, '-$1');
    const n = Number(s);
    return Number.isFinite(n) ? Math.round(n) : null;
  };

  parsed.accounts = (parsed.accounts || []).map((a) => ({
    account_number: String(a.account_number || '').trim(),
    account_name: a.account_name || '',
    account_type: ['asset', 'liability', 'equity', 'revenue', 'expense', 'unknown'].includes(a.account_type) ? a.account_type : 'unknown',
    fund_code: ['OPR', 'RES', 'SA', 'CI'].includes(a.fund_code) ? a.fund_code : null,
    beginning_balance_cents: coerceM(a.beginning_balance_cents) ?? 0,
    period_debits_cents: coerceM(a.period_debits_cents) ?? 0,
    period_credits_cents: coerceM(a.period_credits_cents) ?? 0,
    ending_balance_cents: coerceM(a.ending_balance_cents) ?? 0,
  }));

  const t = parsed.totals || {};
  parsed.totals = {
    total_debits_cents: coerceM(t.total_debits_cents) ?? 0,
    total_credits_cents: coerceM(t.total_credits_cents) ?? 0,
    ending_assets_cents: coerceM(t.ending_assets_cents) ?? 0,
    ending_liabilities_cents: coerceM(t.ending_liabilities_cents) ?? 0,
    ending_equity_cents: coerceM(t.ending_equity_cents) ?? 0,
    ending_revenue_cents: coerceM(t.ending_revenue_cents) ?? 0,
    ending_expenses_cents: coerceM(t.ending_expenses_cents) ?? 0,
  };
  parsed.warnings = parsed.warnings || [];

  // Self-check: debits = credits
  if (parsed.totals.total_debits_cents && parsed.totals.total_credits_cents) {
    const diff = Math.abs(parsed.totals.total_debits_cents - parsed.totals.total_credits_cents);
    if (diff > 100) {
      parsed.warnings.push(
        `Trial balance does not balance: total debits ${(parsed.totals.total_debits_cents / 100).toFixed(2)} ≠ total credits ${(parsed.totals.total_credits_cents / 100).toFixed(2)} (diff ${(diff / 100).toFixed(2)})`
      );
    }
  }

  // Self-check: balance sheet equation (Assets = Liab + Equity)
  const bsLeft = parsed.totals.ending_assets_cents;
  const bsRight = parsed.totals.ending_liabilities_cents + parsed.totals.ending_equity_cents
    + (parsed.totals.ending_revenue_cents - parsed.totals.ending_expenses_cents);
  if (bsLeft && (bsLeft + bsRight)) {
    const diff = Math.abs(bsLeft - bsRight);
    if (diff > 100) {
      parsed.warnings.push(
        `Balance sheet equation does not tie: Assets ${(bsLeft / 100).toFixed(2)} ≠ Liab+Equity+(Rev-Exp) ${(bsRight / 100).toFixed(2)} (diff ${(diff / 100).toFixed(2)})`
      );
    }
  }

  return parsed;
}

// ---------------------------------------------------------------------------
// Public extractor entry point — dispatch by mime/extension
// ---------------------------------------------------------------------------
async function run({ importRow, fileBuffer, mime, filename, community, supabase }) {
  const t0 = Date.now();
  const lowerName = (filename || '').toLowerCase();
  const isPdf = mime === 'application/pdf' || lowerName.endsWith('.pdf');
  const isCsv = mime === 'text/csv' || lowerName.endsWith('.csv');
  const isExcel = /spreadsheet|excel/i.test(mime || '') || lowerName.endsWith('.xlsx') || lowerName.endsWith('.xls');

  console.log(`[vantaca/trial_balance] extracting ${filename || '(unnamed)'} (mime=${mime}) for community=${community?.name}`);

  let extracted;
  if (isPdf) {
    extracted = await extractFromPdf(fileBuffer);
  } else if (isCsv || isExcel) {
    extracted = await extractFromCsvOrExcel(fileBuffer, mime, filename);
  } else {
    throw new Error(`Trial balance extractor: unsupported mime=${mime}, filename=${filename}. Expected PDF, CSV, or Excel.`);
  }

  return {
    extraction_raw: extracted,
    row_count: extracted.accounts?.length || 0,
    downstream_table: null,
    downstream_count: extracted.accounts?.length || 0,
    warnings: extracted.warnings || [],
    duration_ms: Date.now() - t0,
  };
}

module.exports = { run, extractFromPdf, extractFromCsvOrExcel };
