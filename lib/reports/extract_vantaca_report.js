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

const DRV_SUMMARY_PROMPT_LEGACY = `You are reading a Vantaca DRV (Deed Restriction Violation) summary report PDF. Extract every violation listed.

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

// Newsletter-aligned extraction prompt — matches Ed's gold-standard LOPF
// April 2026 layout. Pulls enforcement-step counts + top categories with
// percentages. Single-pass extraction, no per-row data needed (newsletter
// audience never sees individual violations).
const DRV_SUMMARY_PROMPT = `You are reading a Vantaca DRV (Deed Restriction Violation) report PDF for an HOA. The output will feed a Bedrock-branded community newsletter summary (homeowner audience, no PII).

Return ONLY a JSON object with these fields. No commentary, no markdown fences.

{
  "community_name": string,             // e.g., "Lakes of Pine Forest"
  "period_label": string,                // e.g., "April 2026"
  "period_start": "YYYY-MM-DD" | null,
  "period_end": "YYYY-MM-DD" | null,
  "metrics": {
    "first_notices_issued": number,     // count of First Notices issued in the period
    "second_notices_issued": number,    // count of Second Notices issued
    "violations_resolved": number,      // count of violations closed/resolved
    "certified_letters_sent": number,   // count of certified mailings sent
    "total_violations_in_period": number | null   // for percentage calculation if not given
  },
  "top_categories": [
    { "category": string, "percentage": number }  // % of total, integer 0-100
  ],
  "raw_category_counts": [                          // optional — for derivation if percentages aren't in source
    { "category": string, "count": number }
  ]
}

Extract counts directly from the report's totals/summary sections if present. If only per-row data is given, COMPUTE the four metric counts by counting action rows of each type. If percentages aren't given directly, compute them from the counts.

For top_categories, return the top 6-8 categories sorted by count desc, with percentage = (count / total_violations_in_period) * 100, rounded to nearest integer.

If a count cannot be determined, return 0 — never null in the metrics block.`;

async function extractDrvSummary(pdfBuffer) {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 4000,  // newsletter-style extraction is small (no per-row data)
    messages: [{
      role: 'user',
      content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBuffer.toString('base64') } },
        { type: 'text', text: DRV_SUMMARY_PROMPT },
      ],
    }],
  });
  const raw = response?.content?.[0]?.text || '';
  const stopReason = response?.stop_reason || 'unknown';
  console.log(`[extract_vantaca_report] DRV summary stop_reason=${stopReason} raw_length=${raw.length}`);
  console.log('[extract_vantaca_report] DRV raw (first 3000 chars):', raw.slice(0, 3000));
  if (raw.length > 3000) console.log('[extract_vantaca_report] DRV raw (last 1500 chars):', raw.slice(-1500));

  // Diagnostic flags so the caller can give the operator a meaningful
  // error UI instead of a generic "extraction_failed".
  const failureReason = (msg) => ({ parsed: null, raw, stop_reason: stopReason, failure_reason: msg });

  if (!raw || raw.trim().length === 0) {
    return failureReason('Claude returned empty response — PDF may be image-only / unreadable, or the model declined to extract.');
  }
  if (stopReason === 'max_tokens') {
    return failureReason('Claude hit max_tokens (16K). Report likely has too many violations to fit in one extraction pass — split the PDF or contact engineering.');
  }

  let parsed = null;
  try {
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    parsed = JSON.parse(firstBrace !== -1 && lastBrace > firstBrace ? cleaned.slice(firstBrace, lastBrace + 1) : cleaned);
  } catch (e) {
    console.warn('[extract_vantaca_report] DRV parse failed:', e.message);
    return failureReason(`JSON parse failed: ${e.message}. Model output was not valid JSON — first 200 chars: "${raw.slice(0, 200).replace(/\n/g, ' ')}"`);
  }

  // Newsletter shape: validate metrics block + top_categories.
  if (!parsed || !parsed.metrics || !Array.isArray(parsed.top_categories)) {
    return failureReason('Extracted JSON missing metrics or top_categories — Claude may not have recognized this PDF as a DRV summary, or the source doesn\'t carry enforcement-step counts.');
  }
  return { parsed, raw, stop_reason: stopReason };
}

// Generate the message paragraphs + top 3 things to watch for the
// newsletter, based on the extracted metrics + top categories. Separate
// Claude call (cheap) — keeps the extraction strictly data, the
// narrative strictly model-generated with tight controls.
async function generateDrvNewsletterCopy(community, periodLabel, metrics, topCategories) {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const monthOnly = String(periodLabel || '').split(' ')[0] || 'this month';
  const top3CatNames = (topCategories || []).slice(0, 3).map((c) => c.category).filter(Boolean);
  const prompt = `Write the "Message" section and "Top 3 Things to Watch" bullets for an HOA community newsletter's monthly Deed Restriction Violations summary.

Community: ${community || '(community)'}
Period: ${periodLabel || ''} (month name: ${monthOnly})
Metrics this month:
  - First notices issued: ${metrics.first_notices_issued ?? 0}
  - Second notices issued: ${metrics.second_notices_issued ?? 0}
  - Violations resolved: ${metrics.violations_resolved ?? 0}
  - Certified letters sent: ${metrics.certified_letters_sent ?? 0}
Top violation categories (in order):
${(topCategories || []).slice(0, 6).map((c, i) => `  ${i+1}. ${c.category} (${c.percentage}%)`).join('\n')}

Voice: warm, appreciative, non-shaming, conversational. Homeowners read this — never make them feel scolded. Reference the actual numbers and category names (don't invent any).

Output a JSON object with these exact fields (no commentary, no fences):

{
  "message_paragraphs": [
    string,   // Paragraph 1: Open warmly. Reference the resolved number ("${metrics.violations_resolved ?? 0} violations were closed") as a positive sign that homeowners respond quickly to notices.
    string,   // Paragraph 2: Name the top 2-3 actual category themes from the list above. Tie to seasonal context if relevant (April = warmer months / spring growth; October = leaf cleanup; etc.). Keep it specific to ${community || 'the community'}.
    string    // Paragraph 3: Use this exact text — "If you receive a notice, please don't be alarmed — it is simply a reminder to address an item that may have been overlooked. If you have any questions or need additional time, feel free to reach out to management."
  ],
  "top_3_to_watch": [
    string,   // Bullet 1: Tied to top category #1 — actionable homeowner advice (e.g., "Store trash cans out of view after pickup days")
    string,   // Bullet 2: Tied to top category #2 — actionable
    string    // Bullet 3: Tied to top category #3 — actionable
  ]
}

Each bullet should be a single sentence, action-oriented, ~6-15 words, written as instruction. Each paragraph 2-4 sentences max.`;

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 2000,
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
  });
  const raw = response?.content?.[0]?.text || '';
  console.log('[extract_vantaca_report] generateDrvNewsletterCopy raw:', raw.slice(0, 1000));
  try {
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    const parsed = JSON.parse(firstBrace !== -1 && lastBrace > firstBrace ? cleaned.slice(firstBrace, lastBrace + 1) : cleaned);
    if (!Array.isArray(parsed.message_paragraphs) || !Array.isArray(parsed.top_3_to_watch)) {
      throw new Error('shape invalid');
    }
    return { parsed, raw };
  } catch (e) {
    console.warn('[extract_vantaca_report] copy generation parse failed:', e.message);
    // Fallback: synthesize basic copy from the data so the renderer can
    // still produce a usable PDF rather than failing the whole convert.
    const fallbackCats = (topCategories || []).slice(0, 3).map((c) => c.category);
    return {
      parsed: {
        message_paragraphs: [
          `We continue to appreciate everyone's efforts in maintaining the community. ${monthOnly} brought strong resolution numbers — ${metrics.violations_resolved ?? 0} violations were closed, which reflects most homeowners addressing items quickly once notified.`,
          fallbackCats.length > 0
            ? `The most common items this month were ${fallbackCats.join(', ').toLowerCase()}. A quick check around your property can help keep ${community || 'the community'} looking its best.`
            : `A quiet month overall — thank you for keeping the community looking great.`,
          `If you receive a notice, please don't be alarmed — it is simply a reminder to address an item that may have been overlooked. If you have any questions or need additional time, feel free to reach out to management.`,
        ],
        top_3_to_watch: fallbackCats.length > 0
          ? fallbackCats.map((c) => `Keep an eye on ${c.toLowerCase()}.`)
          : ['Maintain landscaping as the season progresses.', 'Store trash bins out of view between pickup days.', 'Reach out to management with any questions about a notice.'],
      },
      raw,
      fallback: true,
    };
  }
}


// ----------------------------------------------------------------------------
// Vantaca violation detail extractor — single-violation drilldown including
// the full enforcement-action timeline (courtesy notice / 1st / 2nd /
// fine / hearing), homeowner contact, cure deadline, inspector notes.
// ----------------------------------------------------------------------------

const VIOLATION_DETAIL_PROMPT = `You are reading a Vantaca single-violation detail PDF. Extract the full case record into structured form.

Return ONLY a JSON object with these fields. No commentary, no fences.

{
  "community_name": string,
  "property_address": string,                    // physical lot address
  "lot_number": string | null,
  "owner_name": string | null,
  "owner_mailing_address": string | null,        // if different from property
  "owner_phone": string | null,
  "owner_email": string | null,
  "violation_type": string,                       // e.g. "Unapproved fence", "Trash cans visible from street"
  "violation_description": string | null,        // free-text detail from the report
  "current_status": "open" | "closed" | "courtesy" | "first_notice" | "second_notice" | "fine_pending" | "fine_assessed" | "hearing_scheduled" | "hearing_held" | "resolved" | "unknown",
  "date_opened": "YYYY-MM-DD" | null,
  "date_last_action": "YYYY-MM-DD" | null,
  "date_closed": "YYYY-MM-DD" | null,
  "cure_deadline": "YYYY-MM-DD" | null,
  "fine_amount": number | null,                  // total assessed if any
  "actions": [
    {
      "date": "YYYY-MM-DD",
      "action_type": "inspection" | "courtesy_notice" | "first_notice" | "second_notice" | "fine_assessed" | "hearing_scheduled" | "hearing_held" | "homeowner_contact" | "photo_documented" | "resolved" | "note_added" | "other",
      "actor": string | null,                     // who took the action (staff name / system)
      "notes": string | null                      // what happened
    }
  ],
  "photo_count": number | null,
  "letter_count": number | null,
  "current_notes": string | null                  // any "next step" / pending action text
}

Extract every action in the history, in chronological order (oldest first). If a field is genuinely missing, use null — don't invent values.`;

async function extractViolationDetail(pdfBuffer) {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 8000,
    messages: [{
      role: 'user',
      content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBuffer.toString('base64') } },
        { type: 'text', text: VIOLATION_DETAIL_PROMPT },
      ],
    }],
  });
  const raw = response?.content?.[0]?.text || '';
  const stopReason = response?.stop_reason || 'unknown';
  console.log(`[extract_vantaca_report] violation_detail stop_reason=${stopReason} raw_length=${raw.length}`);
  console.log('[extract_vantaca_report] violation_detail raw (first 3000):', raw.slice(0, 3000));

  const failureReason = (msg) => ({ parsed: null, raw, stop_reason: stopReason, failure_reason: msg });
  if (!raw || raw.trim().length === 0) return failureReason('Claude returned empty response.');
  if (stopReason === 'max_tokens') return failureReason('Claude hit max_tokens (8K). Violation history may be very long.');

  let parsed = null;
  try {
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    parsed = JSON.parse(firstBrace !== -1 && lastBrace > firstBrace ? cleaned.slice(firstBrace, lastBrace + 1) : cleaned);
  } catch (e) {
    return failureReason(`JSON parse failed: ${e.message}. First 200 chars: "${raw.slice(0, 200).replace(/\n/g, ' ')}"`);
  }

  if (!parsed || !parsed.property_address) {
    return failureReason('Extracted JSON has no property_address — Claude may not have recognized this PDF as a violation detail.');
  }
  if (!Array.isArray(parsed.actions)) parsed.actions = [];
  return { parsed, raw, stop_reason: stopReason };
}

module.exports = {
  detectReportType,
  extractDrvSummary,
  extractViolationDetail,
  generateDrvNewsletterCopy,
};
