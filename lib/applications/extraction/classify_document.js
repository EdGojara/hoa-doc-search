// ============================================================================
// lib/applications/extraction/classify_document.js
// ----------------------------------------------------------------------------
// Pass A.1 — classify each uploaded file into a document_type.
// Uses Claude multimodal so the classifier sees the page, not the filename.
// (Brief rule: "the file name is never a data source.")
//
// Single Claude call per file. Returns { documentType, confidence,
// rationale, pageCount }.
//
// Cost: Claude haiku (cheap+fast) for classification. Sonnet is reserved for
// the per-type extraction in extract_document.js.
// ============================================================================

const Anthropic = require('@anthropic-ai/sdk');
const { DOCUMENT_TYPES } = require('./schema');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const CLASSIFIER_MODEL = 'claude-haiku-4-5-20251001';

const ALLOWED_LIST = Array.from(DOCUMENT_TYPES).join(', ');

const PROMPT = `You are classifying a single file uploaded as part of a Texas HOA Architectural Control Committee (ACC) homeowner application packet. Look at the page(s) and decide which ONE document_type best describes the file as a whole.

Allowed document_type values (return exactly one):
- "application_form": the homeowner-completed ARC application form (typically titled "Architectural Review Application" or similar, with fields like Name/Address/Phone/Email/Project description)
- "survey_plot_plan": a property survey or plot plan showing lot boundaries, building footprint, setbacks, easements (typically signed/stamped by a surveyor)
- "order_summary": the homeowner's actual purchase order or itemized order confirmation showing the specific items they ordered with quantities + dimensions + colors (e.g., Pella/Renewal by Andersen order confirmation, Home Depot kitchen order PDF). This is the AUTHORITATIVE source of THIS order's specs.
- "contractor_estimate": a contractor's job estimate or proposal showing scope of work + line items + pricing (e.g., "Job Estimate" or "Proposal" from a contractor, with description + quantity + rate + cost)
- "product_brochure": a generic manufacturer marketing catalog or product family brochure showing ALL available options (sizes, colors, styles) — NOT a record of what this homeowner ordered. Pages from a Pella catalog showing every available color, or a roofing manufacturer's full color chart.
- "property_photo": a photograph of the homeowner's existing property/home (front, back, side, current condition shots — used as existing-condition reference)
- "elevation_or_rendering": an architectural elevation drawing, 3D rendering, or proposed-condition mockup showing what the modification will look like once complete
- "unknown": none of the above clearly applies (e.g., a random document, a screenshot of unclear content, a single-page snippet without enough context)

Critical distinctions:
- order_summary vs product_brochure: order_summary references THIS order ("Order #XXX confirmed"); brochure is generic marketing showing every option. If the page lists every available color/style with no quantity tied to this order → brochure.
- elevation_or_rendering vs property_photo: rendering/elevation is a drawing of the PROPOSED state; photo is a real-world photograph of the EXISTING state.
- survey_plot_plan vs elevation: survey shows the LOT (top-down, boundaries, footprint); elevation shows the BUILDING (side view, dimensions).

Return ONLY a JSON object (no markdown fences, no commentary):
{
  "documentType": one of [${ALLOWED_LIST}],
  "confidence": 0.0..1.0,
  "rationale": "1-2 sentence reason citing what you saw"
}`;

/**
 * Classify a single file. Accepts a Buffer + mime type.
 * Returns { documentType, confidence, rationale, pageCount, error? }.
 *
 * @param {object} args
 * @param {Buffer} args.buffer
 * @param {string} args.mimeType
 * @param {string} [args.originalName]
 * @param {object} [opts]
 * @param {object} [opts.logger=console]
 */
async function classifyDocument({ buffer, mimeType, originalName }, opts = {}) {
  const logger = opts.logger || console;

  if (!buffer || !Buffer.isBuffer(buffer)) {
    return { documentType: 'unknown', confidence: 0, rationale: 'no_buffer', error: 'no_buffer' };
  }

  // Build the content block based on mime type
  let mediaBlock;
  if (mimeType === 'application/pdf') {
    mediaBlock = {
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: buffer.toString('base64') },
    };
  } else if (mimeType && mimeType.startsWith('image/')) {
    mediaBlock = {
      type: 'image',
      source: { type: 'base64', media_type: mimeType, data: buffer.toString('base64') },
    };
  } else {
    return {
      documentType: 'unknown',
      confidence: 0,
      rationale: `unsupported_mime_type: ${mimeType}`,
      error: 'unsupported_mime_type',
    };
  }

  let resp;
  try {
    resp = await anthropic.messages.create({
      model: CLASSIFIER_MODEL,
      max_tokens: 400,
      messages: [{ role: 'user', content: [mediaBlock, { type: 'text', text: PROMPT }] }],
    });
  } catch (err) {
    logger.warn(`[classify_document] Claude call failed for ${originalName || '(file)'}: ${err.message}`);
    return { documentType: 'unknown', confidence: 0, rationale: `api_error: ${err.message}`, error: 'api_error' };
  }

  const text = (resp.content?.[0]?.text || '').trim();
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    logger.warn(`[classify_document] parse failed for ${originalName || '(file)'}: ${err.message}; raw: ${cleaned.slice(0, 200)}`);
    return { documentType: 'unknown', confidence: 0, rationale: 'parse_failed', error: 'parse_failed' };
  }

  // Validate + normalize
  if (!DOCUMENT_TYPES.has(parsed.documentType)) {
    return {
      documentType: 'unknown',
      confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || 0)),
      rationale: `model returned invalid type "${parsed.documentType}": ${parsed.rationale || ''}`,
      error: 'invalid_type',
    };
  }

  return {
    documentType: parsed.documentType,
    confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || 0)),
    rationale: String(parsed.rationale || ''),
    usage: { input_tokens: resp.usage?.input_tokens, output_tokens: resp.usage?.output_tokens, model: CLASSIFIER_MODEL },
  };
}

module.exports = { classifyDocument, CLASSIFIER_MODEL };
