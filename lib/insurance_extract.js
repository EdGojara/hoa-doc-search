// ============================================================================
// lib/insurance_extract.js  (Ed 2026-07-01)
// ----------------------------------------------------------------------------
// EXTRACT stage of the insurance policy-of-record capability, shared by the API
// (api/insurance.js /program/upload) and the CLI (scripts/extract_insurance_
// program.js). Sends each policy PDF to Claude's document API (never pdf-parse
// — CLAUDE.md Swim Houston scar) and merges the per-file results into one raw
// `insurance_program` shape. The caller normalizes/dedupes via
// lib/insurance_rfp.normalizeInsuranceProgram before rendering or persisting.
// ============================================================================

const EXTRACTION_MODEL = 'claude-sonnet-4-5';

const SCHEMA_PROMPT = `You are an HOA insurance analyst preparing a renewal RFP. From THIS policy document, extract ONLY the underwriting facts a broker needs to quote a renewal. Return STRICT JSON only (no prose, no markdown fence):

{
  "entity": {
    "named_insured": "<legal name of the association exactly as shown>",
    "additional_named_insureds": ["<any>"],
    "mailing_address": "<full>",
    "property_location": "<physical location(s) of insured property, if shown>",
    "association_type": "<single-family HOA | condominium | townhome | mixed | unknown>",
    "units_or_lots": <number or null>,
    "year_built_or_established": "<if shown, else null>",
    "management_company": "<if shown, else null>"
  },
  "coverages": [
    {
      "line": "<Property | General Liability | Directors & Officers | Crime/Fidelity | Umbrella/Excess Liability | Equipment Breakdown | Ordinance or Law | Flood | Workers Compensation | Hired/Non-Owned Auto | Cyber | Other>",
      "carrier": "<insurer name>",
      "policy_number": "<if shown>",
      "effective_date": "<YYYY-MM-DD if shown>",
      "expiration_date": "<YYYY-MM-DD if shown>",
      "limits": [ { "label": "<e.g. Each Occurrence / General Aggregate / Blanket Building / Employee Theft / Each D&O Claim>", "amount": "<as shown, e.g. $1,000,000>" } ],
      "deductibles": [ { "label": "<e.g. All Other Perils / Wind-Hail / Retention>", "amount": "<as shown>" } ],
      "annual_premium": "<as shown, e.g. $12,345 — or null>",
      "key_terms": ["<notable endorsements/conditions a broker must match: replacement cost, agreed value, retro date, per-location, blanket, coinsurance %, etc.>"]
    }
  ],
  "statement_of_values": [
    { "description": "<common-area structure: clubhouse, pool, fencing, monument sign, playground, mailbox kiosk, etc.>", "value": "<$ replacement cost as shown>", "construction": "<if shown>", "year_built": "<if shown>", "square_feet": "<if shown>" }
  ],
  "notes": ["<anything a broker would flag: loss history mentioned, prior claims, coverage gaps, high wind/hail deductible, etc.>"]
}

Rules: include EVERY coverage line and EVERY limit/deductible this document shows. If a field isn't in the document, use null or []. Do NOT invent values. Amounts EXACTLY as printed. Output ONLY the JSON object.`;

// Extract one PDF buffer -> parsed program fragment. `anthropic` is a live SDK client.
async function extractOne(anthropic, buffer) {
  const r = await anthropic.messages.create({
    model: EXTRACTION_MODEL, max_tokens: 8000,
    messages: [{ role: 'user', content: [
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buffer.toString('base64') } },
      { type: 'text', text: SCHEMA_PROMPT },
    ] }],
  });
  const raw = r.content.map((c) => c.text || '').join('').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  return { parsed: JSON.parse(raw), raw };
}

// Extract + merge a set of files: [{ name, buffer, documentId? }] -> raw program.
// entity: first-non-empty per field. coverages: concatenated (dedupe happens in
// normalizeInsuranceProgram). Tags each coverage with its _source file + _documentId
// so the caller can link a line back to its PDF.
async function extractInsuranceProgram(anthropic, files, { onProgress } = {}) {
  const merged = { entity: {}, coverages: [], statement_of_values: [], notes: [], _sources: [] };
  for (const f of files) {
    let ex, raw;
    try { const r = await extractOne(anthropic, f.buffer); ex = r.parsed; raw = r.raw; }
    catch (e) {
      merged._sources.push({ file: f.name, documentId: f.documentId || null, error: e.message });
      if (onProgress) onProgress({ file: f.name, error: e.message });
      continue;
    }
    for (const [k, v] of Object.entries(ex.entity || {})) {
      if (v != null && v !== '' && (merged.entity[k] == null || merged.entity[k] === '')) merged.entity[k] = v;
    }
    (ex.coverages || []).forEach((c) => merged.coverages.push({ ...c, _source: f.name, _documentId: f.documentId || null }));
    (ex.statement_of_values || []).forEach((s) => merged.statement_of_values.push(s));
    (ex.notes || []).forEach((n) => merged.notes.push(n));
    merged._sources.push({ file: f.name, documentId: f.documentId || null, coverages: (ex.coverages || []).map((c) => c.line) });
    if (onProgress) onProgress({ file: f.name, coverages: (ex.coverages || []).length });
  }
  return merged;
}

module.exports = { extractInsuranceProgram, extractOne, SCHEMA_PROMPT, EXTRACTION_MODEL };
