// ============================================================================
// lib/vendors/w9_extract.js  (Ed 2026-07-10)
// ----------------------------------------------------------------------------
// Read a vendor's IRS Form W-9 to capture what we need for 1099 filing: legal
// name, business/DBA name, federal tax classification, and the TIN (EIN/SSN).
// The classification drives a SUGGESTED 1099-required flag — the operator still
// confirms (per-vendor toggle), because the attorney/medical exceptions can't be
// read off the form alone.
//
// PDF binary goes straight to Claude (never pdf-parse — W-9s are Adobe forms
// whose field values are overlays pdf-parse can't see; CLAUDE.md scar).
// ============================================================================
const Anthropic = require('@anthropic-ai/sdk');
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// W-9 line-3 federal tax classifications. Corporations are generally 1099-exempt
// (box 1099-NEC/MISC instructions); everyone else generally gets a 1099.
const CLASSIFICATIONS = [
  'individual_sole_proprietor', 'c_corporation', 's_corporation',
  'partnership', 'trust_estate', 'llc_c', 'llc_s', 'llc_p', 'other',
];
// Classifications that are generally 1099-EXEMPT (corporations). Everything else
// defaults to 1099-required. (Legal + medical payments are 1099-able even for
// corps — the operator overrides via the per-vendor toggle.)
const EXEMPT = new Set(['c_corporation', 's_corporation', 'llc_c', 'llc_s']);

function suggest1099(classification) {
  const c = String(classification || '').toLowerCase();
  if (!CLASSIFICATIONS.includes(c)) return true; // unknown -> assume required (safer)
  return !EXEMPT.has(c);
}

const PROMPT = `You are reading an IRS Form W-9 (Request for Taxpayer Identification Number and Certification) that a vendor gave the association. Extract the fields for 1099 preparation.

Return ONLY a JSON object of this exact shape (no prose, no markdown fence):

{
  "legal_name":       "string — Line 1, the name as shown on their tax return",
  "business_name":    "string — Line 2 business/DBA/disregarded-entity name, or null",
  "tax_classification": "one of: individual_sole_proprietor, c_corporation, s_corporation, partnership, trust_estate, llc_c, llc_s, llc_p, other — read Line 3 (for an LLC, use the tax-classification letter in the box: C/S/P -> llc_c/llc_s/llc_p)",
  "tin":              "string — the TIN digits from Part I (EIN xx-xxxxxxx or SSN xxx-xx-xxxx), digits and dashes only, or null if blank",
  "tin_type":         "one of: ein, ssn, null",
  "address":          "string — the vendor's address (Lines 5-6), or null",
  "signed":           <true|false — is Part II signed/dated?>
}

Read the actual field values, including handwritten or typed entries and checkboxes. Use null for anything genuinely blank. Never invent a TIN.`;

async function extractW9(pdfBuffer) {
  const t0 = Date.now();
  const completion = await anthropic.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 1500,
    messages: [{
      role: 'user',
      content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBuffer.toString('base64') } },
        { type: 'text', text: PROMPT },
      ],
    }],
  });
  const text = completion.content?.[0]?.text || '';
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    // Degrade gracefully: the W-9 still gets stored + flagged on file; the
    // operator fills the tax fields by hand. Never block the upload on a parse.
    return { parsed: null, degraded: true, raw: text, duration_ms: Date.now() - t0 };
  }
  const classification = CLASSIFICATIONS.includes(String(parsed.tax_classification || '').toLowerCase())
    ? String(parsed.tax_classification).toLowerCase() : 'other';
  return {
    parsed: {
      legal_name: parsed.legal_name || null,
      business_name: parsed.business_name || null,
      tax_classification: classification,
      tin: parsed.tin ? String(parsed.tin).replace(/[^0-9\-]/g, '') : null,
      tin_type: ['ein', 'ssn'].includes(String(parsed.tin_type || '').toLowerCase()) ? String(parsed.tin_type).toLowerCase() : null,
      address: parsed.address || null,
      signed: !!parsed.signed,
    },
    suggested_1099: suggest1099(classification),
    degraded: false,
    usage: completion.usage,
    duration_ms: Date.now() - t0,
  };
}

module.exports = { extractW9, suggest1099, CLASSIFICATIONS };
