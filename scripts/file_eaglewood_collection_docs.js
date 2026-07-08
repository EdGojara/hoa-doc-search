// ============================================================================
// scripts/file_eaglewood_collection_docs.js  (Ed 2026-07-08)
// ----------------------------------------------------------------------------
// File the 9 PDFs from Winstead's 2026-07-07 Eaglewood collections email onto
// the accounts they pertain to, so that pulling up a property in Homeowner 360
// shows a clickable "View" link to the actual document.
//
// Mechanism (zero code change — reuses the violation-letter link path):
//   - upload each PDF to the 'violation-letters' bucket
//   - log an `interactions` row (type 'letter_other', direction 'inbound',
//     content = the storage path). The 360 timeline renders a "View" link for
//     any interaction whose type matches /letter/ and whose content ends .pdf,
//     served via /api/homeowner/file?kind=letter.
//
// 4 lien letters + 4 legal-fee invoices -> their 4 specific properties (+owner).
// The 20-account status report -> community/board level (property null); it is
// NOT put on an individual owner's account (it lists 19 other owners).
// Idempotent: skips a doc whose storage path is already logged.
//
//   node scripts/file_eaglewood_collection_docs.js [--apply]
// ============================================================================
require('dotenv').config();
const fs = require('fs');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const APPLY = process.argv.includes('--apply');
const CID = 'a0000000-0000-4000-8000-000000000004';
const BUCKET = 'violation-letters';
const DIR = 'C:/Users/edget/AppData/Local/Temp/claude/C--Users-edget/971c1094-3ef4-428e-b6fc-234ba9442e66/scratchpad/eaglewood_collections';
const RECEIVED = '2026-07-07T22:17:39Z'; // Winstead email time

const norm = (a) => String(a || '').toLowerCase()
  .replace(/\bdrive\b/g, 'dr').replace(/\bcourt\b/g, 'ct').replace(/\blane\b/g, 'ln')
  .replace(/\bshadows\b/g, 'shadow').replace(/[^a-z0-9]+/g, ' ').trim();

// file, address (null = community/board level), subject, note
const DOCS = [
  ['Eaglewood HOA - Lien Enforcement Notice - Hernandez - 16319 Dryberry Court.pdf', '16319 Dryberry Court', 'Winstead lien enforcement notice w/ draft petition (45-day demand)', 'Winstead #71335-5'],
  ['Eaglewood HOA - Lien Enforcement Notice - Eliazar - Nyangabire - 9235 Hodges Bend Drive.pdf', '9235 Hodges Bend Drive', 'Winstead lien enforcement notice w/ draft petition (45-day demand)', 'Winstead #71335-19'],
  ['Eaglewood HOA - Lien Notice - Turner-Fountain - 16102 Williwaw Drive.pdf', '16102 Williwaw Drive', 'Winstead lien notice letter w/ recorded lien', 'Winstead #71335-12'],
  ['Eaglewood HOA - Lien Enforcement Notice - Perry - 9331 Floral Crest Drive.pdf', '9331 Floral Crest Drive', 'Winstead lien enforcement notice w/ draft petition (45-day demand)', 'Winstead #71335-14'],
  ['71335-5.05.pdf', '16319 Dryberry Court', 'Winstead legal-fee invoice #71335-5', 'Attorney fee $175.00'],
  ['71335-19.05.pdf', '9235 Hodges Bend Drive', 'Winstead legal-fee invoice #71335-19', 'Attorney fee $175.00'],
  ['71335-12.03.pdf', '16102 Williwaw Drive', 'Winstead legal-fee invoice #71335-12', 'Attorney fee $250.00'],
  ['71335-14.05.pdf', '9331 Floral Crest Drive', 'Winstead legal-fee invoice #71335-14', 'Attorney fee $175.00'],
  ['Eaglewood HOA - Status Report.pdf', null, 'Winstead collections status report (20 matters, as of 2026-07-01)', 'Board-level portfolio collections snapshot'],
];

(async () => {
  // Resolve the 4 target properties + their active owner.
  let props = [], pf = 0;
  while (true) { const { data } = await s.from('properties').select('id, street_address').eq('community_id', CID).range(pf, pf + 999); props.push(...(data || [])); if (!data || data.length < 1000) break; pf += 1000; }
  const byNorm = new Map(props.map((p) => [norm(p.street_address), p]));

  async function ownerOf(propertyId) {
    const { data } = await s.from('property_ownerships').select('contact_id').eq('property_id', propertyId).is('end_date', null).limit(1);
    return data && data.length ? data[0].contact_id : null;
  }

  let uploaded = 0, logged = 0, skipped = 0;
  for (const [file, addr, subject, note] of DOCS) {
    const path = `${DIR}/${file}`;
    if (!fs.existsSync(path)) { console.warn('  MISSING FILE:', file); continue; }
    let propertyId = null, contactId = null;
    if (addr) {
      const p = byNorm.get(norm(addr));
      if (!p) { console.warn('  MISS property:', addr, '—', file); continue; }
      propertyId = p.id; contactId = await ownerOf(p.id);
    }
    const buf = fs.readFileSync(path);
    const hash = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 12);
    const safe = file.replace(/[^a-zA-Z0-9._\-]/g, '_');
    const storagePath = `eaglewood-collections/${hash}_${safe}`;

    // Idempotency: already logged?
    const { data: exist } = await s.from('interactions').select('id').eq('content', storagePath).limit(1);
    if (exist && exist.length) { console.log('  SKIP (already filed):', file); skipped++; continue; }

    console.log(`  ${addr ? addr.padEnd(24).slice(0,24) : 'BOARD (community)'.padEnd(24)}  ${file}`);
    if (!APPLY) continue;

    const up = await s.storage.from(BUCKET).upload(storagePath, buf, { contentType: 'application/pdf', upsert: true });
    if (up.error) { console.error('   upload failed:', up.error.message); continue; }
    uploaded++;

    const { error: iErr } = await s.from('interactions').insert({
      type: 'letter_other', direction: 'inbound',
      community_id: CID, property_id: propertyId, contact_id: contactId,
      subject, content: storagePath,
      source: 'manual', notes: note,
      attachments: [{ type: 'collections_document', label: subject, storage_path: storagePath, bucket: BUCKET }],
      received_at: RECEIVED,
    });
    if (iErr) { console.error('   interaction insert failed:', iErr.message); continue; }
    logged++;
  }

  console.log(`\n${APPLY ? 'APPLIED' : 'DRY RUN'} — uploaded ${uploaded}, logged ${logged}, skipped ${skipped}.`);
  if (!APPLY) console.log('Pass --apply to upload + link.');
})().catch((e) => { console.error(e.message); process.exit(1); });
