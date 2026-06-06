// ============================================================================
// lib/vantaca/extractors/ar_aging.js
// ----------------------------------------------------------------------------
// AR Aging extractor — runs against a Vantaca AR Aging PDF (or Excel — PDF
// shipped first; Excel hook ready), produces per-property snapshot rows in
// owner_ar_snapshots, links each row back to the parent vantaca_imports
// record via vantaca_import_id.
//
// Built on the existing Owner AR extraction prompt and entity-resolution
// pipeline. Single-source-of-truth: the central Vantaca Imports module
// calls THIS extractor; the legacy POST /api/owner-ar/ingest endpoint still
// works for now (back-compat) and writes the same downstream snapshot rows.
//
// Contract for any Vantaca extractor:
//   exports.run({ importRow, fileBuffer, mime, filename, community, supabase })
//     → { extraction_raw, row_count, downstream_table, downstream_count, warnings }
//
// The Vantaca Imports orchestrator handles state transitions
// (processing → completed/failed); the extractor focuses on doing the work.
// ============================================================================

const Anthropic = require('@anthropic-ai/sdk');
const { resolveProperty } = require('../../entity_resolution');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const AR_EXTRACTION_PROMPT = `You are reviewing a Vantaca (or similar HOA accounting) AR Aging report PDF.
Extract per-account current balances broken into aging buckets, plus dunning status flags.

Return ONLY valid JSON in this exact shape:

{
  "snapshot_date":     "YYYY-MM-DD — the AS-OF date claimed by the report header (look for 'Aging as of', 'Run date', or similar)",
  "community_name":    "string — community/HOA name from the report header, or null if not visible",
  "report_totals": {
    "total_ar":        <number — total receivable across all accounts>,
    "delinquent_count":<integer — accounts with balance > 0, if reported>,
    "current_count":   <integer — accounts at zero, if reported>
  },
  "rows": [
    {
      "property_address": "string — street address as written on the report",
      "unit":             "string or null",
      "homeowner_name":   "string — primary account holder name",
      "account_number":   "string or null",
      "balance_total":    <number>,
      "bucket_0_30":      <number>,
      "bucket_31_60":     <number>,
      "bucket_61_90":     <number>,
      "bucket_91_120":    <number>,
      "bucket_over_120":  <number>,
      "at_legal":         <boolean — true if 'with attorney' / 'at legal' / 'WA' indicator>,
      "in_collections":   <boolean>,
      "payment_plan_active": <boolean>,
      "payment_plan_terms": "string or null",
      "enforcement_stage": "reminder|courtesy_1|courtesy_2|certified_209|at_legal|with_attorney|in_collections|judgment|lien_filed|null",
      "notes":            "string or null"
    }
  ]
}

EXTRACTION RULES:
- Money values are NUMBERS not strings (no dollar signs, no commas, parens for negatives → negative number)
- Zero balances are still extracted
- Unit numbers stay separate from street address
- If multiple owners listed, use the primary (usually first) name
- Status flags inferred from typical Vantaca indicators: 'WA' = with attorney, 'IC' = in collections, 'PP' = payment plan
- enforcement_stage: choose the highest-severity stage indicated
- If snapshot_date is not clearly stated, use NULL

Return ONLY the JSON. No preamble, no markdown fences.`;

async function extractArFromPdf(pdfBuffer) {
  const t0 = Date.now();
  const completion = await anthropic.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 16000,
    messages: [{
      role: 'user',
      content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBuffer.toString('base64') } },
        { type: 'text', text: AR_EXTRACTION_PROMPT },
      ],
    }],
  });
  const text = completion.content?.[0]?.text || '';
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    const stopReason = completion.stop_reason;
    const hint = stopReason === 'max_tokens'
      ? ' Model hit max_tokens; output truncated. Bump the cap or split the report.'
      : '';
    throw new Error(`AR extraction returned malformed JSON.${hint} Parse: ${err.message}`);
  }
  return { parsed, duration_ms: Date.now() - t0 };
}

async function run({ importRow, fileBuffer, mime, filename, community, supabase }) {
  if (mime !== 'application/pdf') {
    // Excel AR extraction is Phase 2 — currently PDF only.
    throw new Error(`AR Aging extractor currently supports PDF only; got mime=${mime}. Excel hook is next ship.`);
  }
  if (!community || !community.id) {
    throw new Error('AR Aging extractor requires a community_id (cannot resolve properties without it).');
  }

  console.log(`[vantaca/ar_aging] extracting ${filename || '(unnamed)'} for community=${community.name}`);
  const { parsed, duration_ms } = await extractArFromPdf(fileBuffer);
  // Diagnostic-first per CLAUDE.md: log the headline result before parsing.
  console.log(`[vantaca/ar_aging] extracted snapshot_date=${parsed.snapshot_date} rows=${(parsed.rows || []).length} in ${duration_ms}ms`);

  const snapshotDate = parsed.snapshot_date || importRow.as_of_date || null;
  if (!snapshotDate) {
    // No date in PDF AND no as_of_date on the import row. Operator must
    // set one before we persist — return a structured warning so the UI
    // surfaces a "Set as-of date" affordance.
    return {
      extraction_raw: parsed,
      row_count: (parsed.rows || []).length,
      downstream_table: 'owner_ar_snapshots',
      downstream_count: 0,
      warnings: ['snapshot_date not detected in PDF header — set it manually before this import will populate owner_ar_snapshots'],
    };
  }

  const rows = Array.isArray(parsed.rows) ? parsed.rows : [];
  const warnings = [];
  let inserted = 0;
  let unmatchedCount = 0;

  for (const row of rows) {
    if (!row.property_address) {
      unmatchedCount += 1;
      continue;
    }
    let propertyId = null;
    try {
      const m = await resolveProperty(supabase, community.id, row.property_address);
      if (m && m.id) propertyId = m.id;
    } catch (e) {
      // per-row resolution failures don't kill the whole import
    }
    if (!propertyId) {
      unmatchedCount += 1;
      continue;
    }
    const { error: insErr } = await supabase
      .from('owner_ar_snapshots')
      .insert({
        management_company_id: importRow.management_company_id,
        community_id: community.id,
        property_id: propertyId,
        snapshot_date: snapshotDate,
        source_filename: filename || null,
        source_storage_path: importRow.source_storage_path || null,
        vantaca_import_id: importRow.id,
        balance_total: row.balance_total ?? null,
        bucket_0_30: row.bucket_0_30 ?? null,
        bucket_31_60: row.bucket_31_60 ?? null,
        bucket_61_90: row.bucket_61_90 ?? null,
        bucket_91_120: row.bucket_91_120 ?? null,
        bucket_over_120: row.bucket_over_120 ?? null,
        at_legal: !!row.at_legal,
        in_collections: !!row.in_collections,
        payment_plan_active: !!row.payment_plan_active,
        payment_plan_terms_text: row.payment_plan_terms || null,
        enforcement_stage: row.enforcement_stage || null,
      });
    if (insErr) {
      warnings.push(`Insert failed for ${row.property_address}: ${insErr.message}`);
    } else {
      inserted += 1;
    }
  }

  if (unmatchedCount > 0) {
    warnings.push(`${unmatchedCount} rows could not be matched to a property in this community — review property addresses or import properties first.`);
  }

  return {
    extraction_raw: parsed,
    row_count: rows.length,
    downstream_table: 'owner_ar_snapshots',
    downstream_count: inserted,
    warnings,
  };
}

module.exports = { run };
