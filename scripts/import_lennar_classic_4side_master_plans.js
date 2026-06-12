// Second-batch import for the Lennar 4700-series master submittal ("Lennar
// Classic 4 Side Still Creek Ranch"). Sister script to the DEF Tier 5 import.
// Same pattern: split → Claude extract → dedupe → insert master_plans →
// re-link any pending applications.
//
// This is the master library that matches the 7 backfilled lots Richelle
// forwarded 2026-06-10 (plans 4700/4710/4720/4740/4760/476N).
//
// Usage: node scripts/import_lennar_classic_4side_master_plans.js

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');
const { PDFDocument } = require('pdf-lib');
require('dotenv').config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const PDF_PATH         = 'C:\\Users\\edget\\AppData\\Local\\Temp\\Lennar Classic 4 Side Still Creek Ranch.pdf';
const LENNAR_ID        = '0eda1b79-0526-4e5d-8a4b-5488a0938ed1';
const STILL_CREEK_ID   = 'a0000000-0000-4000-8000-000000000006';
const BEDROCK_MGMT_ID  = '00000000-0000-0000-0000-000000000001';
const STORAGE_BUCKET   = 'documents';
const MAX_PAGES_PER_CHUNK = 90;

const EXTRACT_PROMPT = `You are reading the "Lennar Classic 4 Side" master plan submittal PDF for
Still Creek Ranch. This PDF contains multiple home plans bundled together,
each typically shown with several elevation variants.

Lennar plan numbers in this series are 4-digit (e.g., 4700, 4710, 4720, 4740,
4760, sometimes with a letter suffix like 476N). Elevation codes are compound
(e.g., "C4", "D4") and may have orientation handedness (Right "R" / Left "L").

Extract EVERY plan/elevation/orientation combination shown.

Each entry in the array:
- plan_number: 4-digit plan identifier as TEXT, preserving any letter suffix
  exactly as printed (e.g., "4720", "476N"). Do not normalize. Required.
- plan_name: Marketing/series name (e.g., "Walsh", "Carlsbad"). null if missing.
- elevation: Compound elevation code exactly as printed (e.g., "C4", "D4",
  "A", "B", "C", "D"). Required.
- elevation_orientation: "left" / "right" / "standard". Look for L/R suffix
  on cover sheet table OR detail sheet header. null if uncertain.
- square_footage: Living/heated square footage as integer. null if not shown.
- stories: 1 / 1.5 / 2 / 2.5 / 3. null if not shown.

Plus top-level:
- ai_confidence: "high" | "medium" | "low"
- ai_notes: caveats about what you saw vs. couldn't

Return ONLY valid JSON:
{
  "elevations": [
    {"plan_number":"4720","plan_name":"Walsh","elevation":"C4","elevation_orientation":"right","square_footage":1922,"stories":1}
  ],
  "ai_confidence":"high",
  "ai_notes":"..."
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
  }
  return chunks;
}

async function extractChunk(buffer, label) {
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 8000,
    messages: [{
      role: 'user',
      content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buffer.toString('base64') } },
        { type: 'text', text: EXTRACT_PROMPT },
      ],
    }],
  });
  let raw = (response.content?.[0]?.text || '').trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenced) raw = fenced[1].trim();
  try {
    const parsed = JSON.parse(raw);
    console.log(`  [${label}] confidence=${parsed.ai_confidence} · ${parsed.elevations?.length || 0} entries · notes: ${parsed.ai_notes || ''}`);
    return parsed.elevations || [];
  } catch (e) {
    console.log(`  [${label}] PARSE FAILED — raw: ${raw.slice(0, 400)}`);
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
  if (existing) { console.log(`  source PDF already in library (${existing.id})`); return existing.id; }
  const stamp = Date.now() + '-' + Math.floor(Math.random() * 10000);
  const filename = path.basename(PDF_PATH).replace(/[^a-zA-Z0-9._-]/g, '_');
  const storagePath = `builders/${LENNAR_ID}/master-plans/${stamp}_${filename}`;
  const up = await supabase.storage.from(STORAGE_BUCKET).upload(storagePath, pdfBuffer, {
    contentType: 'application/pdf', upsert: false,
  });
  if (up.error) throw new Error('upload: ' + up.error.message);
  const { data: libDoc, error: libErr } = await supabase
    .from('library_documents')
    .insert({
      management_company_id: BEDROCK_MGMT_ID,
      community_id: STILL_CREEK_ID,
      category: 'master_plan_pdf',
      title: 'Lennar — Still Creek Ranch — Classic 4 Side Master Submittal',
      file_path: storagePath,
      file_name_original: path.basename(PDF_PATH),
      file_name_normalized: 'Lennar-Still-Creek-Classic-4-Side.pdf',
      file_hash: hash,
      status: 'current',
      index_status: 'pending',
      uploaded_at: new Date().toISOString(),
    })
    .select('id')
    .single();
  if (libErr) throw new Error('library insert: ' + libErr.message);
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
        notes: 'Imported from Lennar Classic 4 Side master submittal 2026-06-11 as pre-approved batch (4700-series).',
      });
    if (error) {
      if (error.code === '23505') skipped++;
      else console.log(`  insert error for ${p.plan_number}-${p.elevation}: ${error.message}`);
    } else inserted++;
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
    let match = (matches || []).find((m) => m.elevation_orientation === lot.elevation_orientation)
              || (matches || [])[0];
    if (!match) { console.log(`  ${lot.reference_number}: no master match for ${lot.plan_number}-${lot.elevation} ${lot.elevation_orientation || ''}`); continue; }
    const { error } = await supabase
      .from('builder_applications')
      .update({
        master_plan_id: match.id,
        fast_track: true,
        fast_track_reason: 'Matched Lennar Classic 4 Side pre-approved master plan at import time (2026-06-11)',
      })
      .eq('id', lot.id);
    if (error) console.log(`  ${lot.reference_number}: update — ${error.message}`);
    else { relinked++; console.log(`  ${lot.reference_number} → master_plan ${match.plan_number}-${match.elevation}-${match.elevation_orientation || 'std'}`); }
  }
  return relinked;
}

(async () => {
  if (!fs.existsSync(PDF_PATH)) { console.log('PDF not found: ' + PDF_PATH); return; }
  const pdfBuffer = fs.readFileSync(PDF_PATH);
  const hash = crypto.createHash('sha256').update(pdfBuffer).digest('hex');
  console.log(`Loaded Classic 4 Side: ${(pdfBuffer.length / 1024 / 1024).toFixed(1)} MB · sha256 ${hash.slice(0, 12)}`);

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
  console.log(`\n  raw extractions: ${all.length}`);

  console.log('\nStep 3 — dedupe');
  const seen = new Map();
  for (const p of all) {
    const k = dedupKey(p);
    if (!seen.has(k)) seen.set(k, p);
  }
  const unique = [...seen.values()];
  console.log(`  unique entries: ${unique.length}`);

  console.log('\nStep 4 — upload source PDF');
  await uploadSourcePdf(pdfBuffer, hash);

  console.log('\nStep 5 — insert master_plans');
  const { inserted, skipped } = await insertMasterPlans(unique);
  console.log(`  inserted ${inserted} · skipped ${skipped} duplicates`);

  console.log('\nStep 6 — relink the 7 backfilled lots');
  const relinked = await relinkBackfilledLots();
  console.log(`  relinked ${relinked} lots`);

  console.log('\nDone.');
})().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
