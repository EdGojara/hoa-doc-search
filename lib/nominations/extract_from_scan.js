// ============================================================================
// extract_from_scan.js
// ----------------------------------------------------------------------------
// OCR / structured extraction for scanned or photographed paper nomination
// forms. Used in two paths:
//
//   1) Staff manual-entry — staff has a paper form mailed in, drops the
//      scan into the modal, hits "Extract from scanned form", the modal
//      fields pre-fill, staff verifies and saves.
//
//   2) Public-form attachments — when a homeowner uploads a scanned form,
//      we can OCR it in the background and surface any discrepancies vs.
//      what they typed.
//
// Uses the AI Sonnet 4.6 vision API. Prompt asks for the canonical fields
// the nomination row needs; returns structured JSON the caller can drop
// straight into the form.
// ============================================================================

const Anthropic = require('@anthropic-ai/sdk');

let _anthropic = null;
function getAnthropic() {
  if (!_anthropic) _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _anthropic;
}

const MODEL = 'claude-sonnet-4-6';

const EXTRACTION_PROMPT =
`You are looking at a scanned or photographed HOA board-nomination form. Extract the fields below into structured JSON. If a field is not present or not legible, return null for that field — do not guess. Names and addresses must be transcribed exactly as written.

Return ONLY a JSON object with these keys (no commentary, no markdown fences):

{
  "nominee_name": string | null,
  "nominee_address": string | null,
  "nominee_email": string | null,
  "nominee_phone": string | null,
  "years_in_community": string | null,
  "nominee_bio": string | null,
  "signature_name": string | null,
  "is_self_nomination": boolean | null,
  "nominator_name": string | null,
  "nominator_email": string | null,
  "nominator_phone": string | null,
  "nominator_address": string | null,
  "confidence": "high" | "medium" | "low",
  "notes": string | null
}

Field guidance:
- "years_in_community" is a free-form string ("10 years", "since 2014", etc.) if mentioned.
- "is_self_nomination" is true when the form indicates the signer is the same person as the nominee (e.g., same name in nominee and signature fields, or explicit checkbox).
- "nominator_*" fields apply only when someone is nominating a neighbor (not self-nomination).
- "confidence": "high" if the form is clearly legible and all required fields are present; "medium" if minor ambiguity (hard-to-read handwriting on one field); "low" if multiple fields are illegible or the form looks incomplete.
- "notes" is a one-sentence summary of anything the staff reviewer should double-check before saving.`;

// extractNominationFieldsFromScan
// ----------------------------------------------------------------------------
// Input: { buffer, mimetype } — a single scanned form (PDF or image).
// Output: parsed JSON object matching the schema above, or { error } on failure.
async function extractNominationFieldsFromScan({ buffer, mimetype }) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return { error: 'ANTHROPIC_API_KEY missing — OCR unavailable.' };
  }
  if (!buffer) return { error: 'No file buffer provided.' };

  const isPdf = (mimetype || '').toLowerCase() === 'application/pdf' ||
                buffer.slice(0, 4).toString('latin1') === '%PDF';
  const base64 = buffer.toString('base64');
  const contentBlock = isPdf
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } }
    : { type: 'image',    source: { type: 'base64', media_type: mimetype || 'image/jpeg', data: base64 } };

  try {
    const resp = await getAnthropic().messages.create({
      model: MODEL,
      max_tokens: 2000,
      messages: [{
        role: 'user',
        content: [
          contentBlock,
          { type: 'text', text: EXTRACTION_PROMPT },
        ],
      }],
    });
    const raw = (resp.content || []).map((b) => b.text || '').join('').trim();
    // Strip accidental markdown fences if the model added any.
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim();
    let parsed;
    try { parsed = JSON.parse(cleaned); }
    catch (e) {
      return { error: 'OCR returned non-JSON output.', raw: cleaned.slice(0, 500) };
    }
    return { fields: parsed };
  } catch (e) {
    console.warn('[extract_from_scan] failed:', e.message);
    return { error: e.message };
  }
}

module.exports = { extractNominationFieldsFromScan };
