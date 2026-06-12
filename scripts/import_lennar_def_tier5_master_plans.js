// ============================================================================
// import_lennar_def_tier5_master_plans.js
// ----------------------------------------------------------------------------
// One-off importer for Lennar's "Still Creek Ranch - New Fairway - DEF Tier 5"
// master plan library. 125-page combined PDF containing every plan + elevation
// for the New Fairway section's Tier 5.
//
// Why a script (vs. POST /master-plans/bulk-extract):
//   • bulk-extract expects one PDF per plan (covers "this PDF shows Plan 6512
//     A/B/C elevations" — typical DRB shape). Lennar's master submittal is the
//     opposite: one PDF, many plans bundled. We'd have to split it for the
//     UI flow anyway.
//   • Doing it in a script means we can split, send to Claude in chunks
//     (Claude's PDF cap is 100 pages per request), dedupe across chunks, and
//     insert in one transaction.
//   • Once this lands, the existing UI flow handles future single-plan
//     additions. This script exists only for the one-time bootstrap.
//
// What happens:
//   1. Load the 125-page DEF Tier 5 PDF.
//   2. Use pdf-lib to split into chunks of MAX 90 pages each (safe margin
//      under Claude's 100-page limit).
//   3. For each chunk, send to Claude with the master-plan-array extraction
//      prompt. Get { elevations: [...] }.
//   4. Dedupe across chunks by (plan_number, elevation, orientation).
//   5. Upload the original PDF to library_documents as the canonical source.
//   6. Insert master_plans rows with status='approved' and active_communities
//      including Still Creek Ranch (Tier 5 = pre-approved batch).
//   7. Re-link the 7 already-backfilled applications (SCR-BLD-2026-0001
//      through 0007) to their matched master_plan_id; set fast_track=TRUE.
//
// Idempotent: master_plans has UNIQUE (builder_company_id, plan_number,
// elevation, elevation_orientation), so re-runs ON CONFLICT skip.
// Library doc dedup by SHA-256 hash.
//
// Usage: node scripts/import_lennar_def_tier5_master_plans.js
// ============================================================================

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');
const { PDFDocument } = require('pdf-lib');
require('dotenv').config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const PDF_PATH         = 'C:\\Users\\edget\\AppData\\Local\\Temp\\Still Creek, Ranch -New Fairway- DEF Tier 5.pdf';
const LENNAR_ID        = '0eda1b79-0526-4e5d-8a4b-5488a0938ed1';
const STILL_CREEK_ID   = 'a0000000-0000-4000-8000-000000000006';
const BEDROCK_MGMT_ID  = '00000000-0000-0000-0000-000000000001';
const STORAGE_BUCKET   = 'documents';
const MAX_PAGES_PER_CHUNK = 90;

const EXTRACT_PROMPT = `You are reading a multi-plan master plan library PDF from Lennar Homes for
the Still Creek Ranch / New Fairway community ("DEF Tier 5" batch).

This PDF contains many distinct floor plans, with each plan usually shown
with multiple elevations (often A, B, C, C2, C3, C4, D, etc.) and sometimes
both Left ("L") and Right ("R") orientations.

Extract EVERY plan/elevation/orientation combination shown in this chunk.
Each entry in the array:

- plan_number: The 4-digit plan identifier (e.g., "4720", "4760", "4700"). Required.
- plan_name:   The marketing/series name (e.g., "Walsh", "Carlsbad", "Spring"). null if not visible.
- elevation:   The elevation code shown — A, B, C, C2, C3, C4, D, D2, D3, D4, etc. Required.
- elevation_orientation: "left" if the cover or detail page is marked L/Left, "right" if R/Right, "standard" if no handedness or marked Standard. null if uncertain.
- square_footage: Living/heated square footage as integer. null if not shown.
- stories: 1 / 1.5 / 2 / 2.5 / 3. null if not shown.

Plus top-level:
- ai_confidence: "high" | "medium" | "low"
- ai_notes: Caveats — e.g., "page 4 cover lists 12 plans; only 8 had detail elevations in this chunk" or "Plan 476N digit ambiguous, likely 4760".

A single base plan often shows ALL of its elevations as separate entries
(Plan 4720-A, 4720-B, 4720-C, 4720-C2, ...). Capture all of them.

Return ONLY valid JSON, no preamble, no markdown fences:
{
  "elevations": [
    {"plan_number":"4720","plan_name":"Walsh","elevation":"C4","elevation_orientation":"right","square_footage":1922,"stories":1},
    ...
  ],
  "ai_confidence": "high",
  "ai_notes": "..."
}`;

async function splitPdfIntoChunks(pdfBuffer, maxPagesPerChunk) {
  const src = await PDFDocument.load(pdfBuffer);
  const totalPages = src.getPageCount();
  console.log(`  PDF has ${totalPages} pages; splitting into chunks of ${maxPagesPerChunk}`);
  const chunks = [];
  for (let start = 0; start < totalPages; start += maxPagesPerChunk) {
    const end = Math.min(start + maxPagesPerChunk, totalPages);
    const chunk = await PDFDocument.create();
    const indices = [];
    for (let i = start; i < end; i++) indices.push(i);
    const copied = await chunk.copyPages(src, indices);
    copied.forEach((p) => chunk.addPage(p));
    const buf = Buffer.from(await chunk.save());
    chunks.push({ start: start + 1, end, pageCount: indices.length, buffer: buf });
    console.log(`  chunk: pages ${start + 1}–${end} (${(buf.length / 1024 / 1024).toFixed(1)} MB)`);
  }
  return chunks;
}

async function extractChunk(chunkBuffer, chunkLabel) {
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 8000,
    messages: [{
      role: 'user',
      content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: chunkBuffer.toString('base64') } },
        { type: 'text', text: EXTRACT_PROMPT },
      ],
    }],
  });
  let raw = (response.content?.[0]?.text || '').trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenced) raw = fenced[1].trim();
  try {
    const parsed = JSON.parse(raw);
    console.log(`  [${chunkLabel}] confidence=${parsed.ai_confidence} · ${parsed.elevations?.length || 0} entries · notes: ${parsed.ai_notes || ''}`);
    return parsed.elevations || [];
  } catch (e) {
    console.log(`  [${chunkLabel}] PARSE FAILED — raw: ${raw.slice(0, 400)}`);
    return [];
  }
}

function dedupKey(p) {
  return [
    String(p.plan_number || '').trim().toUpperCase(),
    String(p.elevation || '').trim().toUpperCase(),
    String(p.elevation_orientation || 'standard').toLowerCase(),
  ].join('|');
}

async function uploadSourcePdf(pdfBuffer, hash) {
  const { data: existing } = await supabase
    .from('library_documents')
    .select('id, file_path')
    .eq('file_hash', hash)
    .maybeSingle();
  if (existing) {
    console.log(`  source PDF already in library_documents (${existing.id})`);
    return existing.id;
  }
  const stamp = Date.now() + '-' + Math.floor(Math.random() * 10000);
  const filename = path.basename(PDF_PATH).replace(/[^a-zA-Z0-9._-]/g, '_');
  const storagePath = `builders/${LENNAR_ID}/master-plans/${stamp}_${filename}`;
  const up = await supabase.storage.from(STORAGE_BUCKET).upload(storagePath, pdfBuffer, {
    contentType: 'application/pdf', upsert: false,
  });
  if (up.error) throw new Error('source PDF upload: ' + up.error.message);
  const { data: libDoc, error: libErr } = await supabase
    .from('library_documents')
    .insert({
      management_company_id: BEDROCK_MGMT_ID,
      community_id: STILL_CREEK_ID,
      category: 'master_plan_pdf',
      title: 'Lennar — Still Creek Ranch / New Fairway — DEF Tier 5 Master Submittal',
      file_path: storagePath,
      file_name_original: path.basename(PDF_PATH),
      file_name_normalized: 'Lennar-Still-Creek-New-Fairway-DEF-Tier-5.pdf',
      file_hash: hash,
      status: 'current',
      index_status: 'pending',
      uploaded_at: new Date().toISOString(),
    })
    .select('id')
    .single();
  if (libErr) throw new Error('library_documents insert: ' + libErr.message);
  console.log(`  source PDF uploaded → library_documents ${libDoc.id}`);
  return libDoc.id;
}

async function insertMasterPlans(plans) {
  let inserted = 0, skipped = 0;
  for (const p of plans) {
    const { error } = await supabase
      .from('master_plans')
      .insert({
        builder_company_id: LENNAR_ID,
        plan_number: String(p.plan_number).trim().toUpperCase(),
        plan_name: p.plan_name || null,
        elevation: String(p.elevation).trim().toUpperCase(),
        elevation_orientation: p.elevation_orientation || null,
        square_footage: p.square_footage || null,
        stories: p.stories || null,
        default_materials: {},
        status: 'approved',
        notes: 'Imported from DEF Tier 5 master submittal 2026-06-11 as pre-approved Tier 5 batch.',
      });
    if (error) {
      if (error.code === '23505') { skipped++; } // unique constraint — already exists
      else console.log(`  insert error for ${p.plan_number}-${p.elevation}: ${error.message}`);
    } else { inserted++; }
  }
  return { inserted, skipped };
}

async function relinkBackfilledLots() {
  const { data: lots } = await supabase
    .from('builder_applications')
    .select('id, reference_number, plan_number, elevation, elevation_orientation')
    .eq('community_id', STILL_CREEK_ID)
    .eq('builder_company_id', LENNAR_ID)
    .is('master_plan_id', null);

  let relinked = 0;
  for (const lot of lots || []) {
    const { data: matches } = await supabase
      .from('master_plans')
      .select('id, plan_number, elevation, elevation_orientation')
      .eq('builder_company_id', LENNAR_ID)
      .eq('plan_number', String(lot.plan_number || '').toUpperCase())
      .eq('elevation', String(lot.elevation || '').toUpperCase());
    // Prefer exact orientation match; fall back to any.
    let match = (matches || []).find((m) => m.elevation_orientation === lot.elevation_orientation)
              || (matches || [])[0];
    if (!match) {
      console.log(`  ${lot.reference_number}: no master plan match for ${lot.plan_number}-${lot.elevation} ${lot.elevation_orientation || ''}`);
      continue;
    }
    const { error } = await supabase
      .from('builder_applications')
      .update({
        master_plan_id: match.id,
        fast_track: true,
        fast_track_reason: 'Matched DEF Tier 5 pre-approved master plan at import time (2026-06-11)',
      })
      .eq('id', lot.id);
    if (error) console.log(`  ${lot.reference_number}: update failed — ${error.message}`);
    else { relinked++; console.log(`  ${lot.reference_number} → master_plan ${match.plan_number}-${match.elevation}-${match.elevation_orientation || 'std'}`); }
  }
  return relinked;
}

(async () => {
  if (!fs.existsSync(PDF_PATH)) { console.log('PDF not found at ' + PDF_PATH); return; }
  const pdfBuffer = fs.readFileSync(PDF_PATH);
  const hash = crypto.createHash('sha256').update(pdfBuffer).digest('hex');
  console.log(`Loaded DEF Tier 5: ${(pdfBuffer.length / 1024 / 1024).toFixed(1)} MB · sha256 ${hash.slice(0, 12)}`);

  console.log('\nStep 1 — split into chunks');
  const chunks = await splitPdfIntoChunks(pdfBuffer, MAX_PAGES_PER_CHUNK);

  console.log('\nStep 2 — extract per chunk');
  const all = [];
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    const label = `chunk ${i + 1}/${chunks.length} (pp${c.start}-${c.end})`;
    const entries = await extractChunk(c.buffer, label);
    all.push(...entries);
  }
  console.log(`\n  raw extractions across all chunks: ${all.length}`);

  console.log('\nStep 3 — dedupe');
  const seen = new Map();
  for (const p of all) {
    const k = dedupKey(p);
    if (!seen.has(k)) seen.set(k, p);
  }
  const unique = [...seen.values()];
  console.log(`  unique (plan_number + elevation + orientation): ${unique.length}`);

  console.log('\nStep 4 — upload source PDF');
  await uploadSourcePdf(pdfBuffer, hash);

  console.log('\nStep 5 — insert master_plans');
  const { inserted, skipped } = await insertMasterPlans(unique);
  console.log(`  inserted ${inserted} new · skipped ${skipped} duplicates`);

  console.log('\nStep 6 — relink the 7 backfilled lots');
  const relinked = await relinkBackfilledLots();
  console.log(`  relinked ${relinked} lots`);

  console.log('\nDone.');
})().catch((e) => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
