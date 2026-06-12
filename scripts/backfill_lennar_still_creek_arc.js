// ============================================================================
// backfill_lennar_still_creek_arc.js
// ----------------------------------------------------------------------------
// One-off backfill of Lennar's pre-portal ARC submissions at Still Creek
// Ranch (Twilight Thicket Lane series). Richelle Hearitige forwarded these
// via email last week. We're getting them into the system now so they show
// up in Richelle's portal dashboard the moment she signs in.
//
// What this does for each PDF:
//   1. Read the PDF binary
//   2. Send to Claude (binary, not pdf-parse text) for structured extraction
//      — Adobe form-field PDFs only render correctly via the binary path
//      (CLAUDE.md scar from 2026-05-21 Swim Houston contract debug).
//   3. Insert a builder_applications row with source='manual_entry'
//      (matches the prior 5503 manually-received submittal pattern).
//   4. Upload the original PDF to storage as the submission_packet attachment.
//   5. Print the reference number minted so we can confirm in the UI.
//
// Idempotency: the script checks each (street_address, builder_company_id,
// community_id) tuple before insert. Re-runs are safe — no duplicates.
//
// Usage:  node scripts/backfill_lennar_still_creek_arc.js
// ============================================================================

const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');
require('dotenv').config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const STILL_CREEK_ID    = 'a0000000-0000-4000-8000-000000000006';
const STILL_CREEK_SLUG  = 'still-creek-ranch';
const LENNAR_ID         = '0eda1b79-0526-4e5d-8a4b-5488a0938ed1';
const RICHELLE_USER_ID  = 'c75161cf-86e5-4e7a-b2df-98d9408cabc8';
const STORAGE_BUCKET    = 'documents';

const PDFS = [
  'C:\\Users\\edget\\AppData\\Local\\Temp\\5503 Twilight Thicket Lane ARC (1).pdf',
  'C:\\Users\\edget\\AppData\\Local\\Temp\\5507 Twilight Thicket Lane ARC.pdf',
  'C:\\Users\\edget\\AppData\\Local\\Temp\\5511 Twilight Thicket Lane ARC.pdf',
  'C:\\Users\\edget\\AppData\\Local\\Temp\\5515 Twilight Thicket Lane ARC.pdf',
  'C:\\Users\\edget\\AppData\\Local\\Temp\\5519 Twilight Thicket Lane ARC.pdf',
  'C:\\Users\\edget\\AppData\\Local\\Temp\\5523 TWILIGHT THICKET LANE ARC.pdf',
  'C:\\Users\\edget\\AppData\\Local\\Temp\\5527 TWILIGHT THICKET LANE ARC.pdf',
];

const EXTRACT_PROMPT = `You are reading a Still Creek Ranch ARC (Architectural Review) application
submitted by Lennar Homes. The PDF has two relevant pages: (1) the
Architectural Review Application form with handwritten/typed values
overlaid on form fields, and (2) the ARCXIS engineering plot plan with
LOT QUANTITIES tables.

Extract the values exactly as they appear visually (form-field overlays,
not the underlying underscores). Return JSON only — no commentary, no
markdown fences.

Schema:
{
  "submitter_name": string,
  "submitter_email": string,
  "submitter_phone": string,
  "street_address": string,
  "lot_number": string,
  "block_number": string,
  "section_number": string,
  "plan_number": string,             // e.g. "4720"
  "plan_name": string,               // e.g. "Walsh"
  "elevation": string,               // e.g. "C4", "A", "B"
  "elevation_orientation": "left" | "right" | "standard",
  "stories": number,
  "living_sqft": integer,            // "LIVING SQ" on the form
  "total_under_roof_sqft": integer,  // "TOTAL UNDER ROOF SQ FT"
  "construction_timeline": string,   // free text e.g. "4 months"
  "material_brick": string,          // e.g. "Claymex - Germantown"
  "material_paint": string,          // exterior paint color
  "material_shingles": string,       // shingle color
  "slab_sqft": integer | null,
  "lot_area_sqft": integer | null,
  "impervious_coverage_pct": number | null,
  "submission_date_iso": string      // signature date from the form, formatted YYYY-MM-DD
}

For any field not visible or blank on the form, return null. If the
elevation reads "C4 Right" treat that as elevation="C4" and
elevation_orientation="right". Phone numbers as digits only with dashes.`;

async function extractPdf(pdfPath) {
  const buf = fs.readFileSync(pdfPath);
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 1500,
    messages: [{
      role: 'user',
      content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buf.toString('base64') } },
        { type: 'text', text: EXTRACT_PROMPT },
      ],
    }],
  });
  let raw = (response.content?.[0]?.text || '').trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenced) raw = fenced[1].trim();
  return { extracted: JSON.parse(raw), pdfBuffer: buf };
}

async function mintReferenceNumber() {
  const year = new Date().getFullYear();
  const { data: row } = await supabase
    .from('application_reference_counters')
    .select('counter')
    .eq('community_id', STILL_CREEK_ID)
    .eq('service_type', 'builder_arc')
    .eq('year', year)
    .maybeSingle();
  const next = (row?.counter || 0) + 1;
  await supabase.from('application_reference_counters').upsert({
    community_id: STILL_CREEK_ID,
    service_type: 'builder_arc',
    year,
    counter: next,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'community_id,service_type,year' });
  return `SCR-BLD-${year}-${String(next).padStart(4, '0')}`;
}

async function processOne(pdfPath) {
  const file = path.basename(pdfPath);
  console.log(`\n[${file}]`);

  // 1) Extract
  let extracted, pdfBuffer;
  try {
    const r = await extractPdf(pdfPath);
    extracted = r.extracted;
    pdfBuffer = r.pdfBuffer;
    console.log(`  extracted: ${extracted.street_address} · Plan ${extracted.plan_number}-${extracted.elevation}${extracted.elevation_orientation ? ' ' + extracted.elevation_orientation : ''} · ${extracted.plan_name || ''}`);
  } catch (e) {
    console.log(`  ✗ extraction failed: ${e.message}`);
    return;
  }

  // 2) Idempotency check — already in DB?
  const { data: existing } = await supabase
    .from('builder_applications')
    .select('id, reference_number')
    .eq('community_id', STILL_CREEK_ID)
    .eq('builder_company_id', LENNAR_ID)
    .ilike('street_address', extracted.street_address)
    .limit(1);
  if (existing && existing.length > 0) {
    console.log(`  ↻ already exists: ${existing[0].reference_number} — skipping`);
    return;
  }

  // 3) Mint reference + insert application
  const referenceNumber = await mintReferenceNumber();
  const submittedAt = extracted.submission_date_iso
    ? new Date(extracted.submission_date_iso + 'T12:00:00Z').toISOString()
    : new Date().toISOString();

  const { data: app, error: insErr } = await supabase
    .from('builder_applications')
    .insert({
      community_id: STILL_CREEK_ID,
      builder_company_id: LENNAR_ID,
      portal_user_id: RICHELLE_USER_ID,
      reference_number: referenceNumber,
      submitter_email: extracted.submitter_email || 'richelle.hearitige@lennar.com',
      submitter_name:  extracted.submitter_name  || 'Richelle Hearitige',
      submitter_phone: extracted.submitter_phone || '281-874-8577',
      source: 'manual_entry',
      lot_number:     extracted.lot_number || '',
      block_number:   extracted.block_number || null,
      section_number: extracted.section_number || null,
      street_address: extracted.street_address,
      plan_number:    String(extracted.plan_number || ''),
      plan_name:      extracted.plan_name || null,
      elevation:      extracted.elevation || '',
      elevation_orientation: extracted.elevation_orientation || null,
      square_footage: extracted.living_sqft || null,
      stories:        extracted.stories || null,
      application_data: {
        brick: extracted.material_brick || null,
        paint: extracted.material_paint || null,
        shingles: extracted.material_shingles || null,
        total_under_roof_sqft: extracted.total_under_roof_sqft || null,
        construction_timeline: extracted.construction_timeline || null,
        slab_sqft: extracted.slab_sqft || null,
        lot_area_sqft: extracted.lot_area_sqft || null,
        impervious_coverage_pct: extracted.impervious_coverage_pct || null,
        original_source: 'email_to_info@bedrocktx.com_2026-06-10',
        backfilled_from_pdf: file,
      },
      builder_acknowledgments: {
        backfilled: true,
        notes: 'Pre-portal manual entry. Acknowledgments captured via paper form signature on the original PDF (page 2).',
        acknowledged_at: submittedAt,
      },
      status: 'received',
      submitted_at: submittedAt,
    })
    .select('id, reference_number')
    .single();

  if (insErr) {
    console.log(`  ✗ insert failed: ${insErr.message}`);
    return;
  }
  console.log(`  ✓ created: ${app.reference_number} (id ${app.id})`);

  // 4) Upload PDF as submission_packet attachment
  const safeName = file.replace(/[^\w.\-]+/g, '_');
  const storagePath = `builders/${STILL_CREEK_SLUG}/${new Date().getFullYear()}/${app.reference_number}/submission_packet/${Date.now()}_${safeName}`;
  const up = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(storagePath, pdfBuffer, { contentType: 'application/pdf', upsert: false });
  if (up.error) {
    console.log(`  ⚠ storage upload failed: ${up.error.message}`);
    return;
  }
  const { error: attErr } = await supabase
    .from('builder_application_attachments')
    .insert({
      application_id: app.id,
      kind: 'submission_packet',
      storage_bucket: STORAGE_BUCKET,
      storage_path: storagePath,
      original_filename: file,
      mime_type: 'application/pdf',
      size_bytes: pdfBuffer.length,
      uploaded_by: 'egojara@bedrocktx.com (backfill)',
    });
  if (attErr) console.log(`  ⚠ attachment row failed: ${attErr.message}`);
  else console.log(`  ✓ attached PDF (${(pdfBuffer.length / 1024).toFixed(0)} KB)`);
}

(async () => {
  console.log(`Backfilling ${PDFS.length} Lennar / Still Creek Ranch ARC submissions...`);
  for (const p of PDFS) {
    if (!fs.existsSync(p)) {
      console.log(`\n[${path.basename(p)}] — file not found at ${p}, skipping`);
      continue;
    }
    await processOne(p);
  }
  console.log('\nDone.');
})();
