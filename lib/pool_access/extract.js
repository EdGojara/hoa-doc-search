// ============================================================================
// lib/pool_access/extract.js  (Ed 2026-07-07)
// ----------------------------------------------------------------------------
// Extract structured pool-access forms from an uploaded PDF. Two form types:
//   * fob_registration — homeowner registers pool key-fobs; each fob has a tag
//     number. One PDF may hold several forms (a scanned batch), and one form
//     may list several fobs.
//   * extended_hours   — approval for a household to swim during extended /
//     after-hours windows, usually per season.
//
// DISCIPLINE (CLAUDE.md): send the PDF binary to Claude, never pdf-parse —
// these are scanned/Adobe forms where the values sit as overlays. Always keep
// raw_extracted for debugging, and a heuristic fallback so an API outage or a
// malformed response degrades to "operator fills it in" instead of a crash.
// ============================================================================
const Anthropic = require('@anthropic-ai/sdk');

const MODEL = 'claude-sonnet-4-5';

const PROMPT = `You are reading a scanned PDF of one or more HOA POOL ACCESS forms.
There are two kinds of form:

  1. POOL FOB / KEY-TAG REGISTRATION — a homeowner registers pool access
     fobs/key-tags. Each fob has a printed TAG NUMBER (a.k.a. fob #, tag #,
     card #, transponder #). The form lists the household members allowed to
     use the pool.
  2. EXTENDED-HOURS / AFTER-HOURS SWIM form — approval for a household to swim
     during extended hours, usually for a stated season (year).

A single PDF may contain SEVERAL forms (a scanned stack). Return EVERY form.

Return ONLY a JSON object of this exact shape (no markdown, no preamble):

{
  "forms": [
    {
      "form_type": "fob_registration" | "extended_hours" | "unknown",
      "property_address": "string — the lot/street address on the form, or null",
      "primary_homeowner_name": "string — the account holder / applicant, or null",
      "authorized_persons": [
        { "name": "string", "relationship": "string or null (spouse, child, tenant, guest, etc.)" }
      ],
      "fobs": [
        { "tag_number": "string — the printed fob/tag number", "issued_to": "string or null" }
      ],
      "season_year": <integer or null — only for extended_hours, e.g. 2026>,
      "extended_hours_detail": "string or null — verbatim approved-hours text",
      "form_signed_date": "YYYY-MM-DD or null",
      "notes": "string or null — anything else worth keeping (deposit paid, # fobs issued, staff note)"
    }
  ]
}

RULES:
- Tag numbers are STRINGS exactly as printed (keep leading zeros; do not do math on them).
- A fob_registration with 3 tag numbers has 3 entries in "fobs".
- "authorized_persons" is every human named as allowed to use the pool (include the homeowner).
- If you cannot tell the form type, use "unknown" and still extract what you can.
- If a field is not present, use null (or [] for the lists). Never invent an address or a name.
- season_year: only set for extended_hours; a fob registration usually has none.`;

// Best-effort heuristic when the API is unavailable or returns junk. It cannot
// read a scanned image, so it returns a single empty 'unknown' form that the
// operator completes in the review step — degrade, don't crash.
function heuristicForms(filename) {
  return [{
    form_type: 'unknown',
    property_address: null,
    primary_homeowner_name: null,
    authorized_persons: [],
    fobs: [],
    season_year: null,
    extended_hours_detail: null,
    form_signed_date: null,
    notes: `Auto-extraction unavailable for ${filename || 'this file'} — fill in manually.`,
    _heuristic: true,
  }];
}

function normalizeForm(f) {
  const type = ['fob_registration', 'extended_hours'].includes(f.form_type) ? f.form_type : 'unknown';
  const persons = Array.isArray(f.authorized_persons)
    ? f.authorized_persons.map((p) => (typeof p === 'string' ? { name: p, relationship: null } : { name: p.name || null, relationship: p.relationship || null })).filter((p) => p.name)
    : [];
  const fobs = Array.isArray(f.fobs)
    ? f.fobs.map((x) => (typeof x === 'string' ? { tag_number: x, issued_to: null } : { tag_number: x.tag_number != null ? String(x.tag_number).trim() : null, issued_to: x.issued_to || null })).filter((x) => x.tag_number)
    : [];
  let year = f.season_year != null ? parseInt(f.season_year, 10) : null;
  if (!Number.isFinite(year) || year < 2000 || year > 2100) year = null;
  return {
    form_type: type,
    property_address: f.property_address ? String(f.property_address).trim() : null,
    primary_homeowner_name: f.primary_homeowner_name ? String(f.primary_homeowner_name).trim() : null,
    authorized_persons: persons,
    fobs,
    season_year: year,
    extended_hours_detail: f.extended_hours_detail || null,
    form_signed_date: /^\d{4}-\d{2}-\d{2}$/.test(f.form_signed_date || '') ? f.form_signed_date : null,
    notes: f.notes || null,
  };
}

// Returns { forms: [...normalized], raw_extracted, model, degraded }
async function extractPoolForms(pdfBuffer, filename) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return { forms: heuristicForms(filename), raw_extracted: null, model: null, degraded: true };
  }
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  let text = '';
  try {
    const completion = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 8000,
      messages: [{
        role: 'user',
        content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBuffer.toString('base64') } },
          { type: 'text', text: PROMPT },
        ],
      }],
    });
    text = completion.content?.[0]?.text || '';
  } catch (err) {
    console.warn('[pool_access] extraction API failed:', err.message);
    return { forms: heuristicForms(filename), raw_extracted: null, model: MODEL, degraded: true };
  }

  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  console.log('[pool_access] Claude returned:', cleaned.slice(0, 1500));
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    console.warn('[pool_access] malformed JSON:', err.message);
    return { forms: heuristicForms(filename), raw_extracted: cleaned, model: MODEL, degraded: true };
  }
  const forms = Array.isArray(parsed.forms) ? parsed.forms.map(normalizeForm) : [];
  return {
    forms: forms.length ? forms : heuristicForms(filename),
    raw_extracted: parsed,
    model: MODEL,
    degraded: forms.length === 0,
  };
}

module.exports = { extractPoolForms, normalizeForm };
