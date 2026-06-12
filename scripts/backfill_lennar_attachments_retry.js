const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const REFS = [
  ['SCR-BLD-2026-0001', 'C:\\Users\\edget\\AppData\\Local\\Temp\\5503 Twilight Thicket Lane ARC (1).pdf'],
  ['SCR-BLD-2026-0002', 'C:\\Users\\edget\\AppData\\Local\\Temp\\5507 Twilight Thicket Lane ARC.pdf'],
  ['SCR-BLD-2026-0003', 'C:\\Users\\edget\\AppData\\Local\\Temp\\5511 Twilight Thicket Lane ARC.pdf'],
  ['SCR-BLD-2026-0004', 'C:\\Users\\edget\\AppData\\Local\\Temp\\5515 Twilight Thicket Lane ARC.pdf'],
  ['SCR-BLD-2026-0005', 'C:\\Users\\edget\\AppData\\Local\\Temp\\5519 Twilight Thicket Lane ARC.pdf'],
  ['SCR-BLD-2026-0006', 'C:\\Users\\edget\\AppData\\Local\\Temp\\5523 TWILIGHT THICKET LANE ARC.pdf'],
  ['SCR-BLD-2026-0007', 'C:\\Users\\edget\\AppData\\Local\\Temp\\5527 TWILIGHT THICKET LANE ARC.pdf'],
];

(async () => {
  for (const [ref, pdfPath] of REFS) {
    const { data: app } = await s.from('builder_applications')
      .select('id').eq('reference_number', ref).single();
    if (!app) { console.log(ref + ': not found'); continue; }
    const buf = fs.readFileSync(pdfPath);
    const safeName = path.basename(pdfPath).replace(/[^\w.\-]+/g, '_');
    const sp = 'builders/still-creek-ranch/2026/' + ref + '/other/' + Date.now() + '_' + safeName;
    const up = await s.storage.from('documents').upload(sp, buf, { contentType: 'application/pdf', upsert: false });
    if (up.error) { console.log(ref + ': storage ' + up.error.message); continue; }
    const { error: ae } = await s.from('builder_application_attachments').insert({
      application_id: app.id,
      kind: 'other',
      storage_bucket: 'documents',
      storage_path: sp,
      original_filename: path.basename(pdfPath),
      mime_type: 'application/pdf',
      size_bytes: buf.length,
      uploaded_by: 'egojara@bedrocktx.com (backfill)',
    });
    console.log(ref + ': ' + (ae ? 'ERR ' + ae.message : '✓ attached (' + (buf.length/1024).toFixed(0) + ' KB)'));
  }
})();
