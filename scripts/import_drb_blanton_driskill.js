// Direct import of DRB Landmark BLANTON (1610) and DRISKILL (1800) master
// plans. Bulk-upload UI failed on these two PDFs because they exceed the
// API's per-file size limit for the AI extractor. The data was extracted
// via the chunked inspect_blanton_pdf and inspect_driskill_pdf scripts.
//
// What this does:
//   1. Uploads each source PDF to supabase storage + creates a library_documents
//      row (catalog evidence — same pattern as the Lennar DEF Tier 5 and
//      Classic 4 Side imports).
//   2. Inserts 12 master_plans rows (6 elevations per plan) with status='approved'
//      and notes pointing back to the library_documents id for audit.
//   3. Idempotent: if the master_plan row exists, the insert skips
//      (master_plans has UNIQUE on builder + plan_number + elevation +
//      orientation).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const DRB_ID            = 'a4f4e33b-f9e8-48d5-813e-4b65759b2f5d';
const AUGUST_MEADOWS_ID = 'a0000000-0000-4000-8000-000000000007';
const BEDROCK_MGMT_ID   = '00000000-0000-0000-0000-000000000001';
const STORAGE_BUCKET    = 'documents';
const TEMP = 'C:\\Users\\edget\\AppData\\Local\\Temp';

const PLANS = [
  {
    name: 'BLANTON', planNumber: '1610', planName: 'Blanton', file: '1610 - BLANTON (1).pdf',
    elevations: [
      { code: 'A', sqft: 1606 }, { code: 'B', sqft: 1605 }, { code: 'C', sqft: 1605 },
      { code: 'M', sqft: 1606 }, { code: 'O', sqft: 1606 }, { code: 'P', sqft: 1605 },
    ],
  },
  {
    name: 'DRISKILL', planNumber: '1800', planName: 'Driskill', file: '1800 - DRISKILL.pdf',
    elevations: [
      { code: 'A', sqft: 1809 }, { code: 'B', sqft: 1809 }, { code: 'C', sqft: 1810 },
      { code: 'M', sqft: 1809 }, { code: 'O', sqft: 1810 }, { code: 'P', sqft: 1810 },
    ],
  },
];

async function uploadSourcePdf(filePath, planName) {
  const buf = fs.readFileSync(filePath);
  const hash = crypto.createHash('sha256').update(buf).digest('hex');

  // Dedup by content hash
  const { data: existing } = await s.from('library_documents')
    .select('id').eq('file_hash', hash).maybeSingle();
  if (existing) return { libDocId: existing.id, reused: true };

  const stamp = Date.now() + '-' + Math.floor(Math.random() * 10000);
  const safeName = path.basename(filePath).replace(/[^a-zA-Z0-9._-]/g, '_');
  const storagePath = `builders/${DRB_ID}/master-plans/${stamp}_${safeName}`;
  const up = await s.storage.from(STORAGE_BUCKET).upload(storagePath, buf, {
    contentType: 'application/pdf', upsert: false,
  });
  if (up.error) throw new Error('upload: ' + up.error.message);

  const { data: doc, error } = await s.from('library_documents').insert({
    management_company_id: BEDROCK_MGMT_ID,
    community_id: AUGUST_MEADOWS_ID,
    category: 'master_plan_pdf',
    title: 'DRB — August Meadows — ' + planName + ' Landmark Master Plan',
    file_path: storagePath,
    file_name_original: path.basename(filePath),
    file_name_normalized: 'DRB-AugustMeadows-Landmark-' + planName + '.pdf',
    file_hash: hash,
    status: 'current',
    index_status: 'pending',
    uploaded_at: new Date().toISOString(),
  }).select('id').single();
  if (error) throw new Error('library_documents insert: ' + error.message);
  return { libDocId: doc.id, reused: false };
}

(async () => {
  for (const plan of PLANS) {
    console.log('\n--- ' + plan.name + ' (Plan ' + plan.planNumber + ') ---');
    const fp = path.join(TEMP, plan.file);
    if (!fs.existsSync(fp)) {
      console.log('  ✗ PDF not found at ' + fp + ' — skipping source upload, importing master_plans only');
    }

    let libDocId = null;
    if (fs.existsSync(fp)) {
      const { libDocId: id, reused } = await uploadSourcePdf(fp, plan.name);
      libDocId = id;
      console.log('  source PDF: ' + (reused ? 'reused ' : 'uploaded ') + id);
    }

    let inserted = 0, skipped = 0;
    for (const e of plan.elevations) {
      const { error } = await s.from('master_plans').insert({
        builder_company_id: DRB_ID,
        plan_number: plan.planNumber,
        plan_name: plan.planName,
        elevation: e.code,
        elevation_orientation: 'standard',
        square_footage: e.sqft,
        stories: 1,
        default_materials: {},
        status: 'approved',
        notes: 'DRB Landmark series imported 2026-06-12 (bulk-upload UI failed on this PDF due to size; data sourced from chunked AI extraction). Library doc: ' + (libDocId || 'n/a'),
      });
      if (error) {
        if (error.code === '23505') skipped++;
        else console.log('    ✗ ' + e.code + ': ' + error.message);
      } else {
        inserted++;
      }
    }
    console.log('  master_plans: inserted ' + inserted + ', skipped ' + skipped + ' (already in catalog)');
  }
  console.log('\nDone.');
})();
