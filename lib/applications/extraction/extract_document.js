// ============================================================================
// lib/applications/extraction/extract_document.js
// ----------------------------------------------------------------------------
// Pass A.2 — per-document raw extraction.
// Reads each (already-classified) file into a permissive, document-shaped
// intermediate. Each extracted field carries source page + confidence.
//
// Per the brief: ABSENT IS NOT A GUESS. If a field is not visible on the
// page, return null + a low confidence; the extractor must never invent.
//
// Model: claude-sonnet-4-5 (CLAUDE.md standard). Higher-quality reads matter
// here because the order_summary extraction is the source of truth for
// spec values that flow into ACC decisions.
// ============================================================================

const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const EXTRACTOR_MODEL = 'claude-sonnet-4-5';

// ---- Per-type prompts ------------------------------------------------------
// Each prompt explicitly tells Claude what fields to look for AND when to
// return null. Discipline: a brochure prompt explicitly forbids returning
// spec values as if they were ordered.

const PROMPTS = {
  application_form: `This is an HOA architectural review application form completed by a homeowner.
Extract the following fields verbatim where visible. Return null for anything you don't see — DO NOT INVENT.

{
  "homeowner_name": string | null,
  "homeowner_email": string | null,
  "homeowner_phone": string | null,
  "property_address": string | null,
  "request_summary": string | null,           // the homeowner's free-text description of what they want
  "estimated_completion_text": string | null,  // as written, e.g., "1 week" or "3-4 days" or "07/06/2026"
  "project_start_date": string | null,         // if separately specified
  "project_completion_date": string | null,    // if separately specified
  "checked_attachments": [                     // checkboxes from the "complete without..." list
    {"item": string, "checked": boolean}
  ],
  "_provenance": {"page_seen": number}
}`,

  survey_plot_plan: `This is a property survey or plot plan. Extract verifiable identifiers ONLY.

{
  "surveyor_or_firm": string | null,
  "property_street_address": string | null,
  "property_city_state_zip": string | null,
  "lot_block_section": string | null,
  "survey_date": string | null,
  "_provenance": {"page_seen": number}
}`,

  order_summary: `This is a homeowner's PURCHASE ORDER or order confirmation — the AUTHORITATIVE record of what was ordered.
Extract every line item with the specs as written. DO NOT INFER missing details — return null.

{
  "vendor_or_supplier": string | null,
  "order_number": string | null,
  "order_date": string | null,
  "line_items": [
    {
      "item_type": string,                  // e.g., "double_hung_window", "entry_door", "patio_door"
      "quantity": number | null,
      "location_on_property": string | null, // e.g., "front elevation", "kitchen", "master bedroom"
      "dimensions_as_stated": string | null, // verbatim — e.g., "30 x 48"
      "exterior_color": string | null,       // CRITICAL — must be FROM this order, not generic catalog
      "interior_color": string | null,
      "material": string | null,             // e.g., "fiberglass", "vinyl", "wood"
      "glass_type_or_grille": string | null, // e.g., "Low-E", "Colonial 6-Lite grille"
      "raw_line": string                     // verbatim text of the line for audit
    }
  ],
  "_provenance": {"page_seen": number}
}`,

  contractor_estimate: `This is a contractor's job estimate or proposal. Extract scope + line items.

{
  "contractor_name": string | null,
  "contractor_phone": string | null,
  "estimate_date": string | null,
  "customer_name": string | null,
  "service_address": string | null,
  "scope_summary": string | null,
  "line_items": [
    {
      "description": string,
      "quantity": number | null,
      "unit_rate": number | null,
      "total_cost": number | null
    }
  ],
  "total_amount": number | null,
  "_provenance": {"page_seen": number}
}`,

  product_brochure: `This is a generic product brochure or marketing catalog — NOT a record of what this homeowner ordered.
The brochure shows every available option (color, size, style) regardless of what was ordered.

Extract ONLY the catalog identification — do NOT extract specific values as if they were chosen for this order.

{
  "manufacturer": string | null,
  "product_line_or_family": string | null,
  "catalog_title": string | null,
  "page_topic": string | null,            // e.g., "Window color options", "Exterior finishes"
  "is_definitely_brochure": true,
  "_provenance": {"page_seen": number}
}

CRITICAL: do NOT return any "selected_color" or "chosen_dimension" fields. A brochure cannot tell you what THIS homeowner picked.`,

  property_photo: `This is a photograph of the homeowner's existing property. Describe the visible current condition.

{
  "vantage_point": string | null,           // e.g., "front elevation", "rear yard, looking at house"
  "visible_features": string | null,        // brief: what's in the photo
  "existing_condition_summary": string | null,  // e.g., "Two windows visible — current grille pattern not clearly readable"
  "items_relevant_to_application": string | null, // e.g., "front-facing windows on second story"
  "_provenance": {"page_seen": number}
}`,

  elevation_or_rendering: `This is an architectural elevation drawing or 3D rendering showing the PROPOSED modification.

{
  "view_label": string | null,             // e.g., "East Elevation", "Front View"
  "structure_dimensions": string | null,   // any labeled dimensions visible
  "materials_called_out": string | null,   // material/finish notes if labeled
  "proposed_condition_summary": string | null,
  "_provenance": {"page_seen": number}
}`,

  unknown: `Best-effort observation. Don't fabricate.
{
  "observed_content": string,
  "_provenance": {"page_seen": number}
}`,
};

/**
 * Extract per-document fields. Accepts the file buffer + classified type.
 * Returns { extracted, pageCount, usage, error? }.
 */
async function extractDocument({ buffer, mimeType, documentType, originalName }, opts = {}) {
  const logger = opts.logger || console;
  if (!buffer || !Buffer.isBuffer(buffer)) {
    return { extracted: {}, pageCount: 0, error: 'no_buffer' };
  }
  const prompt = PROMPTS[documentType] || PROMPTS.unknown;

  let mediaBlock;
  if (mimeType === 'application/pdf') {
    mediaBlock = { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buffer.toString('base64') } };
  } else if (mimeType && mimeType.startsWith('image/')) {
    mediaBlock = { type: 'image', source: { type: 'base64', media_type: mimeType, data: buffer.toString('base64') } };
  } else {
    return { extracted: {}, pageCount: 0, error: 'unsupported_mime_type' };
  }

  let resp;
  try {
    resp = await anthropic.messages.create({
      model: EXTRACTOR_MODEL,
      max_tokens: 2000,
      messages: [{
        role: 'user',
        content: [
          mediaBlock,
          { type: 'text', text: prompt + '\n\nReturn ONLY the JSON object. No markdown fences.' },
        ],
      }],
    });
  } catch (err) {
    logger.warn(`[extract_document] Claude call failed (${documentType}, ${originalName || '?'}): ${err.message}`);
    return { extracted: {}, pageCount: 0, error: 'api_error', errorMessage: err.message };
  }

  const text = (resp.content?.[0]?.text || '').trim();
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    logger.warn(`[extract_document] parse failed (${documentType}): ${err.message}; raw: ${cleaned.slice(0, 300)}`);
    return { extracted: {}, pageCount: 0, error: 'parse_failed', raw: cleaned.slice(0, 1000) };
  }

  return {
    extracted: parsed,
    pageCount: parsed?._provenance?.page_seen || 1,
    usage: { input_tokens: resp.usage?.input_tokens, output_tokens: resp.usage?.output_tokens, model: EXTRACTOR_MODEL },
  };
}

module.exports = { extractDocument, EXTRACTOR_MODEL, PROMPTS };
