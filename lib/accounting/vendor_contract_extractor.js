// ============================================================================
// lib/accounting/vendor_contract_extractor.js
// ----------------------------------------------------------------------------
// Extract structured terms from a vendor SERVICE contract PDF (security,
// landscaping, pool, management, etc.) so the living budget can propose that
// line at the CONTRACTED amount + real escalation instead of a trend guess —
// and link the signed PDF as evidence.
//
// Writes into the existing `vendor_contracts` table (migration 015), which was
// purpose-built for this and already carries extraction fields. Amounts are
// DOLLARS (NUMERIC), matching that table — the living-budget layer converts to
// cents when it consumes them.
//
// Claude binary-PDF read (Swim Houston scar) — never pdf-parse on form PDFs.
// ============================================================================

const Anthropic = require('@anthropic-ai/sdk');
const XLSX = require('xlsx');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Must match the vendor_service_categories CHECK set (constraint scar).
const SERVICE_CATEGORIES = [
  'landscape_maintenance', 'landscape_construction', 'tree_service', 'pool_management',
  'janitorial', 'pressure_washing', 'painting', 'repair', 'security', 'pest_control',
  'irrigation', 'insurance', 'legal', 'accounting', 'reserve_study',
  'engineer_inspection', 'management', 'other',
];
const ESCALATOR_KINDS = ['max_cpi_or_pct', 'fixed_pct', 'cpi_only', 'none'];

const PROMPT = `You are reading a vendor SERVICE contract for an HOA (e.g. security patrol, landscaping, pool management, janitorial, management). Extract the commercial terms a budget analyst needs.

Return ONLY valid JSON, no preamble, no markdown fences:

{
  "vendor_name":          "string — the service provider's company name",
  "service_category":     "one of: ${SERVICE_CATEGORIES.join(', ')}",
  "service_description":  "1-2 sentence plain summary of the scope",
  "total_amount":         <number in DOLLARS — the contract total as written, or 0 if not a fixed total>,
  "annual_amount":        <number in DOLLARS — cost normalized to 12 months. If billed monthly, monthly x 12. If a multi-year total, total / years.>,
  "term_months":          <integer or null>,
  "effective_date":       "YYYY-MM-DD or null",
  "end_date":             "YYYY-MM-DD or null (null if open-ended / auto-renewing)",
  "escalator_kind":       "one of: ${ESCALATOR_KINDS.join(', ')}",
  "escalator_pct":        <number — annual escalation percent, e.g. 3.5 for 3.5%, or null if none>,
  "payment_terms":        "string or null (e.g. 'Net 30', 'monthly in advance')",
  "auto_renews":          <true|false>,
  "renewal_notice_days":  <integer or null>,
  "warnings":             ["string — anomalies: unclear amount, multiple fee schedules, missing dates"]
}

RULES:
- Amounts are DOLLARS as numbers (not cents, not strings). "$4,250.00/month" -> annual_amount 51000. "$84,829.44/yr" -> annual_amount 84829.44.
- annual_amount is the single most important field — always produce your best 12-month figure. If the contract lists monthly, multiply by 12. If a total over a term, divide by the term years. If truly unknown, use 0 and add a warning.
- service_category MUST be exactly one value from the allowed list. Security patrol -> "security". Landscaping/mowing -> "landscape_maintenance". Pool -> "pool_management". If none fit, "other".
- escalator_kind: a fixed annual % increase -> "fixed_pct" with escalator_pct set. CPI-based -> "cpi_only". "greater of CPI or X%" -> "max_cpi_or_pct". None stated -> "none" with escalator_pct null.
- Dates as YYYY-MM-DD. If only a year is given, use YYYY-01-01 and add a warning.
- If the document is clearly NOT a vendor service contract (it's an invoice, a form, a management agreement between the HOA and its manager), set vendor_name to "" and add a warning saying what it actually is.

Return ONLY the JSON.`;

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

async function extractVendorContract(fileBuffer, mime, filename) {
  const isExcel = /spreadsheet|excel|csv/i.test(mime || '') || /\.(xlsx|xls|csv)$/i.test(filename || '');
  const isPdf = mime === 'application/pdf' || /\.pdf$/i.test(filename || '');
  if (!isExcel && !isPdf) throw new Error(`Vendor contract extractor expects a PDF or Excel file; got mime=${mime}`);

  let content;
  if (isExcel) {
    const grid = workbookToText(fileBuffer);
    if (!grid.trim()) throw new Error('Contract spreadsheet had no readable rows.');
    content = [{ type: 'text', text: `${PROMPT}\n\nHere is the document as a tab-delimited grid:\n\n${grid}` }];
  } else {
    content = [
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: fileBuffer.toString('base64') } },
      { type: 'text', text: PROMPT },
    ];
  }

  const t0 = Date.now();
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-5', max_tokens: 3000,
    messages: [{ role: 'user', content }],
  });
  const raw = (response.content || []).map((b) => b.text || '').join('').trim();
  console.log(`[vendor_contract_extractor] raw first 900: ${raw.slice(0, 900)}`);

  let p;
  try { p = JSON.parse(raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()); }
  catch (err) { throw new Error(`Contract extraction returned malformed JSON. Parse: ${err.message}`); }

  const num = (v) => { if (v == null || v === '') return null; const n = Number(String(v).replace(/[$,\s]/g, '')); return Number.isFinite(n) ? n : null; };
  const date = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? v : null);

  return {
    vendor_name: String(p.vendor_name || '').trim(),
    service_category: SERVICE_CATEGORIES.includes(p.service_category) ? p.service_category : 'other',
    service_description: p.service_description || '',
    total_amount: num(p.total_amount) || 0,
    annual_amount: num(p.annual_amount) || 0,
    term_months: Number.isFinite(Number(p.term_months)) ? parseInt(p.term_months, 10) : null,
    effective_date: date(p.effective_date),
    end_date: date(p.end_date),
    escalator_kind: ESCALATOR_KINDS.includes(p.escalator_kind) ? p.escalator_kind : 'none',
    escalator_pct: num(p.escalator_pct),
    payment_terms: p.payment_terms || null,
    auto_renews: !!p.auto_renews,
    renewal_notice_days: Number.isFinite(Number(p.renewal_notice_days)) ? parseInt(p.renewal_notice_days, 10) : null,
    warnings: Array.isArray(p.warnings) ? p.warnings : [],
    duration_ms: Date.now() - t0,
  };
}

module.exports = { extractVendorContract, SERVICE_CATEGORIES };
