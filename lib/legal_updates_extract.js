// ============================================================================
// lib/legal_updates_extract.js
// ----------------------------------------------------------------------------
// AI extraction of structured metadata from a legal update / guidance PDF.
//
// Two-stage data flow per CLAUDE.md:
//   1. Extract — PDF binary -> Claude -> structured JSON metadata
//   2. Validate — caller (api/legal_updates.js) validates shape + clamps
//      to controlled vocab + persists to legal_updates sidecar table
//
// Always sends the PDF binary directly to Claude (never pre-extracted
// text) per the form-PDF scar in CLAUDE.md. Always logs raw model
// response. Always returns raw_extracted alongside the parsed shape so
// post-processing failures can be diagnosed without re-running the
// extraction.
// ============================================================================

const Anthropic = require('@anthropic-ai/sdk').default;

// Controlled vocabularies — the AI is told to use only these tags, and
// the caller clamps any out-of-vocab values to the closest match (or
// drops them with a warning) to keep the index tidy. Adding a topic
// here is a deliberate act, not a free-text drift.
const VALID_TOPICS = [
  // Fair Housing / Animals
  'esa', 'service_animals', 'fair_housing',
  // §209 procedural
  '209_cure_period', '209_notice_requirements', '209_hearing_rights',
  '209_foreclosure', '209_attorney_fees',
  // Enforcement / Compliance
  'drv_enforcement', 'fines', 'collections', 'towing',
  // Architectural
  'acc_review', 'modifications', 'covenants',
  // Governance
  'fiduciary_duty', 'open_meetings', 'elections', 'voting',
  'bylaws', 'ccrs', 'rules_regulations', 'amendments',
  // Financial
  'reserve_studies', 'assessments', 'special_assessments',
  'insurance', 'audits',
  // Property uses
  'boarding_houses', 'short_term_rentals', 'commercial_use',
  'rentals_long_term',
  // Common areas / amenities
  'amenities', 'common_areas', 'easements',
  // Privacy / records
  'homeowner_privacy', 'records_inspection',
  // Catchall
  'indemnification', 'liability', 'governance', 'misc',
];

const VALID_JURISDICTIONS = [
  'federal', 'texas',
  // Counties Bedrock currently operates in — keep the list aligned to
  // communities.* as new jurisdictions are added.
  'fort_bend_county', 'harris_county', 'montgomery_county', 'galveston_county',
];

const EXTRACTION_PROMPT = `You are reading a legal update, agency guidance, court opinion, or attorney newsletter article about HOA/POA management law in Texas. Extract structured metadata that will feed an HOA management AI system's legal lens.

Return ONLY a JSON object with these fields. Use null for any field you cannot determine confidently.

REQUIRED FIELDS:
- source_publisher: The law firm, agency, or court that published this. Examples: "RMWBH Law", "HUD Office of Fair Housing", "Texas Attorney General", "Texas Supreme Court", "U.S. District Court for Southern District of Texas", "Community Associations Institute", "Henry Oddo Austin & Fletcher".
- source_date: YYYY-MM-DD of publication. Look for byline date, article date, court opinion filing date.
- key_holding: A precise 1-2 sentence summary of the rule, guidance, or holding. This is what the AI will cite later. Must be quotable and specific (not generic). Example: "HUD has narrowed the definition of 'assistance animal' under the Fair Housing Act to align with the ADA's trained-service-animal standard, reducing the broad protections previously extended to emotional support animals."

OPTIONAL FIELDS:
- effective_date: YYYY-MM-DD when the rule takes effect, if different from source_date. Most newsletters: same as source_date. Court opinions: often effective immediately. Statutes: may have a forward-dated effective date.
- jurisdiction: array from this controlled list ONLY: ${JSON.stringify(VALID_JURISDICTIONS)}. Federal applies to anything from federal agencies/courts; texas to anything from Texas state sources; counties to anything county-specific.
- topics: array from this controlled list ONLY: ${JSON.stringify(VALID_TOPICS)}. Pick 1-5 most relevant.
- key_quote: A direct quote from the document (1-3 sentences max) that captures the rule. Use the EXACT WORDING from the document. If no clean quote available, leave null.
- supersedes_notice_ids: Array of any prior notices/cases/rules this document EXPLICITLY states it replaces or supersedes. Look for phrases like "supersedes FHEO-2020-01" or "overrules Tarr v. Timberwood on the X point". Just the identifiers — we'll resolve them on our side. Example: ["FHEO-2020-01", "FHEO-2013-01"].
- confidence: "high" | "medium" | "low" — your overall confidence in this extraction.

VOICE: Output ONLY the JSON object. No commentary, no markdown fences, no preamble. The receiving system parses your output directly.`;

// ----------------------------------------------------------------------------
// extractLegalUpdateMetadata
//
// Send the PDF binary to Claude and parse structured metadata.
// Returns { parsed, raw, modelMessage } where:
//   - parsed: the validated/clamped metadata ready to write to legal_updates
//   - raw: the unparsed model response (always preserved per CLAUDE.md)
//   - modelMessage: the full Anthropic response object for debugging
// ----------------------------------------------------------------------------
async function extractLegalUpdateMetadata(pdfBuffer) {
  if (!pdfBuffer || !pdfBuffer.length) {
    throw new Error('extractLegalUpdateMetadata: pdfBuffer required');
  }
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 2000,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data: pdfBuffer.toString('base64') },
        },
        { type: 'text', text: EXTRACTION_PROMPT },
      ],
    }],
  });
  const raw = response?.content?.[0]?.text || '';
  console.log('[legal_updates_extract] Claude raw response:', raw.slice(0, 2000));

  // Robust JSON parse — strip code fences, leading commentary, trailing
  // whitespace. The prompt asks for ONLY JSON but models occasionally
  // wrap or add a sentence; tolerate it.
  let parsed = null;
  try {
    const cleaned = raw
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```\s*$/, '')
      .trim();
    // Find the first { and the matching last } to handle preamble/trailers.
    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      parsed = JSON.parse(cleaned.slice(firstBrace, lastBrace + 1));
    } else {
      parsed = JSON.parse(cleaned);
    }
  } catch (e) {
    console.warn('[legal_updates_extract] JSON parse failed:', e.message, '— returning raw only.');
    return { parsed: null, raw, modelMessage: response };
  }

  // Clamp arrays to controlled vocab. Drop unknown values with a warn
  // so the operator can decide whether to extend the vocab or correct
  // the doc's tags manually.
  const clampedTopics = Array.isArray(parsed.topics)
    ? parsed.topics.filter((t) => {
        const ok = VALID_TOPICS.includes(t);
        if (!ok) console.warn('[legal_updates_extract] dropping out-of-vocab topic:', t);
        return ok;
      })
    : [];
  const clampedJurisdiction = Array.isArray(parsed.jurisdiction)
    ? parsed.jurisdiction.filter((j) => {
        const ok = VALID_JURISDICTIONS.includes(j);
        if (!ok) console.warn('[legal_updates_extract] dropping out-of-vocab jurisdiction:', j);
        return ok;
      })
    : [];

  parsed.topics = clampedTopics;
  parsed.jurisdiction = clampedJurisdiction;

  return { parsed, raw, modelMessage: response };
}

module.exports = {
  extractLegalUpdateMetadata,
  VALID_TOPICS,
  VALID_JURISDICTIONS,
};
