#!/usr/bin/env node
// ===========================================================================
// extract_insurance_program.js  (Ed 2026-07-01)
// ---------------------------------------------------------------------------
// The EXTRACT stage of the Bedrock Insurance RFP capability. Sends each policy
// PDF (declarations, GL/D&O, umbrella, crime, etc.) to Claude's document API
// and pulls the coverage specs a broker needs to quote a renewal — WITHOUT
// exposing the full policy forms. Merges the per-file results into one
// structured `insurance_program` JSON, deduping the named-insured/entity block.
//
// Purely a read/extract tool — writes JSON to the scratchpad for review before
// anything renders or persists. This is the same document-API pattern as
// load_budget_pdf.js (never pdf-parse on policy PDFs — CLAUDE.md scar).
//
//   node -r dotenv/config scripts/extract_insurance_program.js <out.json> <pdf1> [pdf2 ...]
// ===========================================================================

const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const outPath = process.argv[2];
const pdfs = process.argv.slice(3);

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

async function extractOne(path) {
  const b64 = fs.readFileSync(path).toString('base64');
  const r = await client.messages.create({
    model: 'claude-sonnet-4-5', max_tokens: 8000,
    messages: [{ role: 'user', content: [
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } },
      { type: 'text', text: SCHEMA_PROMPT },
    ] }],
  });
  const raw = r.content.map((c) => c.text || '').join('').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  return JSON.parse(raw);
}

(async () => {
  if (!outPath || !pdfs.length) { console.error('usage: <out.json> <pdf1> [pdf2 ...]'); process.exit(1); }

  const merged = { entity: {}, coverages: [], statement_of_values: [], notes: [], _sources: [] };
  for (const p of pdfs) {
    const name = p.split(/[\\/]/).pop();
    process.stderr.write(`extracting ${name} ...\n`);
    let ex;
    try { ex = await extractOne(p); }
    catch (e) { console.error(`  ⚠ ${name}: ${e.message}`); merged._sources.push({ file: name, error: e.message }); continue; }
    // entity: keep the most complete block (first non-empty wins per field)
    for (const [k, v] of Object.entries(ex.entity || {})) {
      if (v != null && v !== '' && (merged.entity[k] == null || merged.entity[k] === '')) merged.entity[k] = v;
    }
    (ex.coverages || []).forEach((c) => merged.coverages.push({ ...c, _source: name }));
    (ex.statement_of_values || []).forEach((s) => merged.statement_of_values.push(s));
    (ex.notes || []).forEach((n) => merged.notes.push(n));
    merged._sources.push({ file: name, coverages: (ex.coverages || []).map((c) => c.line) });
    fs.writeFileSync(outPath, JSON.stringify(merged, null, 2)); // incremental — protect each API call
    process.stderr.write(`  saved (${merged.coverages.length} coverage lines so far)\n`);
  }

  fs.writeFileSync(outPath, JSON.stringify(merged, null, 2));
  console.log('\n=== EXTRACTED INSURANCE PROGRAM ===');
  console.log('Named insured:', merged.entity.named_insured);
  console.log('Type:', merged.entity.association_type, '| units/lots:', merged.entity.units_or_lots);
  console.log('\nCoverage lines:');
  for (const c of merged.coverages) {
    const lim = (c.limits || []).map((l) => `${l.label} ${l.amount}`).join('; ');
    console.log(`  • ${c.line} — ${c.carrier || '?'} | ${lim || 'no limits parsed'} | premium ${c.annual_premium || '?'} | eff ${c.effective_date || '?'}→${c.expiration_date || '?'}`);
  }
  console.log(`\nSOV items: ${merged.statement_of_values.length} | notes: ${merged.notes.length}`);
  console.log('written:', outPath);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
