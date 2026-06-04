// ============================================================================
// lib/reports/extract_vantaca_report.js
// ----------------------------------------------------------------------------
// AI extraction of structured data from a Vantaca-format report PDF. Two-
// step pipeline per CLAUDE.md two-stage data flow rule:
//   1. Auto-detect the report type from the PDF body (extract_report_type).
//   2. Extract structured data using the type-specific schema.
//
// First report type supported: vantaca_drv_summary (DRV monthly summary —
// the "APRIL 2026 DRV SUMMARY LOPF.pdf" + "Violation (7).pdf" examples
// Ed sent 2026-06-04). Other types are stubbed and can plug in as needed.
//
// PDF binary always goes directly to Claude per the form-PDF rule —
// never pre-extracted text.
// ============================================================================

const Anthropic = require('@anthropic-ai/sdk').default;

const DETECT_PROMPT = `You are reading a PDF report exported from Vantaca, an HOA management software platform. Identify which type of report this is.

Possible types:
- vantaca_drv_summary: monthly deed restriction violation (DRV) summary listing properties with violations, status, dates. Often titled "DRV SUMMARY" or "VIOLATION SUMMARY" or community name + month.
- vantaca_violation_detail: per-violation detail — single violation with full history, photos, letters sent.
- vantaca_ar_aging: accounts receivable aging report showing balances by aging bucket (current / 30 / 60 / 90+).
- vantaca_work_order_summary: work order list with status, assigned vendor, dates.
- vantaca_other: any other Vantaca-style report not matching above.
- unknown: not a Vantaca report or cannot determine.

Return ONLY a JSON object with these fields. No commentary, no markdown fences.
{
  "type": "vantaca_drv_summary" | "vantaca_violation_detail" | "vantaca_ar_aging" | "vantaca_work_order_summary" | "vantaca_other" | "unknown",
  "community_name": string | null,
  "period_label": string | null,   // e.g., "April 2026" or null
  "period_start": "YYYY-MM-DD" | null,
  "period_end": "YYYY-MM-DD" | null,
  "confidence": "high" | "medium" | "low",
  "detection_evidence": string  // 1 sentence on what tipped you off
}`;

const DRV_SUMMARY_PROMPT = `You are reading a Vantaca DRV (Deed Restriction Violation) summary report PDF. Extract every violation listed.

Return ONLY a JSON object with these fields. No commentary, no markdown fences.

{
  "community_name": string,            // the HOA name, e.g., "Lakes of Pine Forest"
  "period_label": string,              // e.g., "April 2026"
  "period_start": "YYYY-MM-DD" | null,
  "period_end": "YYYY-MM-DD" | null,
  "summary": {
    "total_violations": number,        // total count in the report
    "open_count": number | null,       // open / active violations
    "closed_count": number | null,     // closed / resolved violations
    "new_this_period": number | null,  // newly opened during the period
  },
  "by_category": [
    { "category": string, "count": number }
  ],
  "violations": [
    {
      "property_address": string,        // street address of the violating property
      "lot_number": string | null,
      "owner_name": string | null,
      "violation_type": string,          // e.g., "Trash cans left out", "Unapproved fence"
      "status": "open" | "closed" | "courtesy" | "first_notice" | "second_notice" | "fine_pending" | "fine_assessed" | "resolved" | "unknown",
      "date_opened": "YYYY-MM-DD" | null,
      "date_last_action": "YYYY-MM-DD" | null,
      "date_closed": "YYYY-MM-DD" | null,
      "next_action": string | null,      // e.g., "Re-inspect 5/15", "Send second notice"
      "notes": string | null              // any free-text the report carries about this violation
    }
  ]
}

If you can't determine a field, use null. Extract EVERY violation listed in the report, even if there are dozens.

CRITICAL: Numbers go in the summary block. Don't double-count by listing each violation twice. The "violations" array is the per-row list; the "summary" is the totals.`;

async function detectReportType(pdfBuffer) {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 500,
    messages: [{
      role: 'user',
      content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBuffer.toString('base64') } },
        { type: 'text', text: DETECT_PROMPT },
      ],
    }],
  });
  const raw = response?.content?.[0]?.text || '';
  console.log('[extract_vantaca_report] detect raw:', raw.slice(0, 1000));
  try {
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    const parsed = JSON.parse(firstBrace !== -1 && lastBrace > firstBrace ? cleaned.slice(firstBrace, lastBrace + 1) : cleaned);
    return { parsed, raw };
  } catch (e) {
    console.warn('[extract_vantaca_report] detect parse failed:', e.message);
    return { parsed: { type: 'unknown', confidence: 'low' }, raw };
  }
}

async function extractDrvSummary(pdfBuffer) {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 8000,  // DRV summaries can be 50+ rows
    messages: [{
      role: 'user',
      content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBuffer.toString('base64') } },
        { type: 'text', text: DRV_SUMMARY_PROMPT },
      ],
    }],
  });
  const raw = response?.content?.[0]?.text || '';
  console.log('[extract_vantaca_report] DRV summary raw (first 2000 chars):', raw.slice(0, 2000));
  let parsed = null;
  try {
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    parsed = JSON.parse(firstBrace !== -1 && lastBrace > firstBrace ? cleaned.slice(firstBrace, lastBrace + 1) : cleaned);
  } catch (e) {
    console.warn('[extract_vantaca_report] DRV parse failed:', e.message);
    return { parsed: null, raw };
  }
  // Light validation — if violations array missing, return null
  if (!parsed || !Array.isArray(parsed.violations)) {
    console.warn('[extract_vantaca_report] DRV extraction missing violations array');
    return { parsed: null, raw };
  }
  return { parsed, raw };
}

module.exports = {
  detectReportType,
  extractDrvSummary,
};
