// ============================================================================
// lib/vantaca/extractors/ap_ledger.js
// ----------------------------------------------------------------------------
// Extract Vantaca's AP Ledger / AP Aging report — per-vendor open invoices
// with aging buckets. This is the AP equivalent of the AR aging extractor.
//
// MIGRATION VALUE: at Quail Ridge cutover, this file tells trustEd which
// vendor invoices are open and how aged. The migration replay tool reads
// this and creates ap_invoices rows in 'approved' status (they were
// approved in Vantaca; we trust that history), with the GL posting
// coming from the trial balance's AP account opening balance — no
// double-counting because the AP account net opening already reflects
// these invoices.
//
// Handles PDF (Claude binary) + CSV / Excel (text via xlsx). Same dual-path
// pattern as trial_balance.js.
//
// Contract:
//   exports.run({ importRow, fileBuffer, mime, filename, community, supabase })
//     → { extraction_raw, row_count, downstream_table, downstream_count, warnings }
// ============================================================================

const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = 'claude-sonnet-4-5';

function tryRequireXlsx() {
  try { return require('xlsx'); } catch (_) { return null; }
}

const PROMPT = `You are reading an Accounts Payable Aging / AP Ledger report from Vantaca (or similar HOA accounting software). This is a snapshot of EVERY open vendor invoice at a specific point in time, organized by vendor with aging buckets (Current, 1-30, 31-60, 61-90, Over 90 days past due).

Return ONLY valid JSON, no preamble, no markdown fences:

{
  "community_name":            "string from header or empty",
  "as_of_date":                "YYYY-MM-DD — aging-as-of date",
  "report_totals": {
    "total_open_ap_cents":     <integer in cents>,
    "current_cents":           <integer>,
    "bucket_1_30_cents":       <integer>,
    "bucket_31_60_cents":      <integer>,
    "bucket_61_90_cents":      <integer>,
    "over_90_cents":           <integer>,
    "vendor_count":            <integer>,
    "open_invoice_count":      <integer>
  },
  "vendors": [
    {
      "vendor_name":           "string — vendor name as printed",
      "vendor_account_number": "string or empty — Vantaca vendor account ID if shown",
      "vendor_subtotal_cents": <integer — total open balance for this vendor>,
      "vendor_aging": {
        "current_cents":       <integer>,
        "bucket_1_30_cents":   <integer>,
        "bucket_31_60_cents":  <integer>,
        "bucket_61_90_cents":  <integer>,
        "over_90_cents":       <integer>
      },
      "invoices": [
        {
          "vendor_invoice_number": "string — invoice # as printed",
          "invoice_date":          "YYYY-MM-DD",
          "due_date":              "YYYY-MM-DD or empty",
          "original_amount_cents": <integer — original invoice amount>,
          "amount_paid_cents":     <integer — already paid to date; 0 if untouched>,
          "balance_remaining_cents": <integer — open balance>,
          "days_past_due":         <integer — negative if not yet due>,
          "aging_bucket":          "current | 1_30 | 31_60 | 61_90 | over_90",
          "po_number":             "string or empty",
          "memo":                  "string or empty — description / GL coding hint"
        }
      ]
    }
  ],
  "warnings": ["string"]
}

CRITICAL RULES:
- All money values are INTEGER CENTS. Never strings, never decimals.
- Extract EVERY invoice row per vendor — do not summarize.
- vendor_subtotal_cents should equal sum of that vendor's invoice balance_remaining_cents — warn if off >1¢.
- report_totals.total_open_ap_cents should equal sum of all vendor_subtotal_cents — warn if off >1¢.
- aging_bucket choices: current = balance not yet due (days_past_due ≤ 0); 1_30 = 1-30 days late; 31_60; 61_90; over_90.
- Skip subtotal/section-label rows (rows without an invoice number per vendor).
- warnings: list anomalies. Examples: "Vendor X subtotal doesn't tie to sum of invoices by \$Y", "Aging buckets don't sum to total open AP by \$Z".

Return ONLY the JSON.`;

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

async function extractFromCsvOrExcel(fileBuffer, mime, filename) {
  const xlsx = tryRequireXlsx();
  let rows;
  if (xlsx) {
    try {
      const wb = xlsx.read(fileBuffer, { type: 'buffer', cellDates: false, cellNF: false });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      if (!sheet) throw new Error('no_sheet');
      rows = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: '', blankrows: false });
    } catch (e) {
      console.warn('[ap_ledger] xlsx parse failed, falling back to raw text:', e.message);
      rows = null;
    }
  }
  if (!rows || rows.length === 0) {
    const text = fileBuffer.toString('utf-8');
    rows = text.split(/\r?\n/).filter((l) => l.trim()).map((line) => line.split(',').map((s) => s.trim()));
  }
  const sampleRows = rows.slice(0, 4000);
  const grid = sampleRows.map((r) => r.join('\t')).join('\n');

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 16000,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: `${PROMPT}\n\nThe AP aging report is provided below as tab-separated rows from a CSV / Excel export. Vendor names typically appear as section headers; individual invoice rows follow each vendor. Column order varies — detect from the header row.\n\n--- BEGIN REPORT ---\n${grid}\n--- END REPORT ---` },
      ],
    }],
  });
  return parseResponse(response);
}

function parseResponse(response) {
  const raw = (response.content || []).map((b) => b.text || '').join('').trim();
  console.log('[ap_ledger] raw first 1200:', raw.slice(0, 1200));

  let parsed;
  try {
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    parsed = JSON.parse(cleaned);
  } catch (err) {
    const hint = response.stop_reason === 'max_tokens'
      ? ' Model hit max_tokens — try splitting by vendor letter range or by aging bucket.'
      : '';
    throw new Error(`AP ledger extraction returned malformed JSON.${hint} Parse: ${err.message}`);
  }

  const coerceM = (v) => {
    if (v == null || v === '') return null;
    if (typeof v === 'number') return Math.round(v);
    const s = String(v).replace(/[$,\s]/g, '').replace(/^\((.+)\)$/, '-$1');
    const n = Number(s);
    return Number.isFinite(n) ? Math.round(n) : null;
  };

  // Coerce report_totals
  const rt = parsed.report_totals || {};
  parsed.report_totals = {
    total_open_ap_cents: coerceM(rt.total_open_ap_cents) ?? 0,
    current_cents: coerceM(rt.current_cents) ?? 0,
    bucket_1_30_cents: coerceM(rt.bucket_1_30_cents) ?? 0,
    bucket_31_60_cents: coerceM(rt.bucket_31_60_cents) ?? 0,
    bucket_61_90_cents: coerceM(rt.bucket_61_90_cents) ?? 0,
    over_90_cents: coerceM(rt.over_90_cents) ?? 0,
    vendor_count: Number(rt.vendor_count) || 0,
    open_invoice_count: Number(rt.open_invoice_count) || 0,
  };

  // Coerce vendors + their invoices
  parsed.vendors = (parsed.vendors || []).map((v) => {
    const va = v.vendor_aging || {};
    const invs = (v.invoices || []).map((inv) => ({
      vendor_invoice_number: inv.vendor_invoice_number || null,
      invoice_date: inv.invoice_date || null,
      due_date: inv.due_date || null,
      original_amount_cents: coerceM(inv.original_amount_cents) ?? 0,
      amount_paid_cents: coerceM(inv.amount_paid_cents) ?? 0,
      balance_remaining_cents: coerceM(inv.balance_remaining_cents) ?? 0,
      days_past_due: inv.days_past_due == null ? null : Math.round(Number(inv.days_past_due)),
      aging_bucket: ['current', '1_30', '31_60', '61_90', 'over_90'].includes(inv.aging_bucket) ? inv.aging_bucket : null,
      po_number: inv.po_number || '',
      memo: inv.memo || '',
    }));
    return {
      vendor_name: v.vendor_name || '',
      vendor_account_number: v.vendor_account_number || '',
      vendor_subtotal_cents: coerceM(v.vendor_subtotal_cents) ?? 0,
      vendor_aging: {
        current_cents: coerceM(va.current_cents) ?? 0,
        bucket_1_30_cents: coerceM(va.bucket_1_30_cents) ?? 0,
        bucket_31_60_cents: coerceM(va.bucket_31_60_cents) ?? 0,
        bucket_61_90_cents: coerceM(va.bucket_61_90_cents) ?? 0,
        over_90_cents: coerceM(va.over_90_cents) ?? 0,
      },
      invoices: invs,
    };
  });
  parsed.warnings = parsed.warnings || [];

  // Self-checks
  // 1) Each vendor's subtotal should equal sum of invoice balances
  for (const v of parsed.vendors) {
    const sum = (v.invoices || []).reduce((s, i) => s + (i.balance_remaining_cents || 0), 0);
    const diff = Math.abs(sum - (v.vendor_subtotal_cents || 0));
    if (diff > 1) {
      parsed.warnings.push(
        `Vendor '${v.vendor_name}' subtotal ${(v.vendor_subtotal_cents / 100).toFixed(2)} doesn't tie to invoice sum ${(sum / 100).toFixed(2)} (diff ${(diff / 100).toFixed(2)})`
      );
    }
  }
  // 2) report total should equal sum of vendor subtotals
  const vendorsSum = parsed.vendors.reduce((s, v) => s + (v.vendor_subtotal_cents || 0), 0);
  const totalDiff = Math.abs(vendorsSum - parsed.report_totals.total_open_ap_cents);
  if (parsed.report_totals.total_open_ap_cents && totalDiff > 1) {
    parsed.warnings.push(
      `Total open AP ${(parsed.report_totals.total_open_ap_cents / 100).toFixed(2)} doesn't tie to sum of vendor subtotals ${(vendorsSum / 100).toFixed(2)} (diff ${(totalDiff / 100).toFixed(2)})`
    );
  }
  // 3) bucket totals should sum to total open AP
  const bucketSum = parsed.report_totals.current_cents + parsed.report_totals.bucket_1_30_cents
    + parsed.report_totals.bucket_31_60_cents + parsed.report_totals.bucket_61_90_cents
    + parsed.report_totals.over_90_cents;
  const bDiff = Math.abs(bucketSum - parsed.report_totals.total_open_ap_cents);
  if (parsed.report_totals.total_open_ap_cents && bDiff > 1) {
    parsed.warnings.push(
      `Aging bucket totals sum ${(bucketSum / 100).toFixed(2)} doesn't tie to total open AP ${(parsed.report_totals.total_open_ap_cents / 100).toFixed(2)} (diff ${(bDiff / 100).toFixed(2)})`
    );
  }

  return parsed;
}

async function run({ importRow, fileBuffer, mime, filename, community, supabase }) {
  const t0 = Date.now();
  const lowerName = (filename || '').toLowerCase();
  const isPdf = mime === 'application/pdf' || lowerName.endsWith('.pdf');
  const isCsv = mime === 'text/csv' || lowerName.endsWith('.csv');
  const isExcel = /spreadsheet|excel/i.test(mime || '') || lowerName.endsWith('.xlsx') || lowerName.endsWith('.xls');

  console.log(`[vantaca/ap_ledger] extracting ${filename || '(unnamed)'} (mime=${mime}) for community=${community?.name}`);

  let extracted;
  if (isPdf) extracted = await extractFromPdf(fileBuffer);
  else if (isCsv || isExcel) extracted = await extractFromCsvOrExcel(fileBuffer, mime, filename);
  else throw new Error(`AP ledger extractor: unsupported mime=${mime}, filename=${filename}. Expected PDF, CSV, or Excel.`);

  const invoiceCount = (extracted.vendors || []).reduce((s, v) => s + (v.invoices?.length || 0), 0);

  return {
    extraction_raw: extracted,
    row_count: invoiceCount,
    downstream_table: null,
    downstream_count: extracted.vendors?.length || 0,
    warnings: extracted.warnings || [],
    duration_ms: Date.now() - t0,
  };
}

module.exports = { run, extractFromPdf, extractFromCsvOrExcel };
