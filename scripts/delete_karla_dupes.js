/*
 * One-shot cleanup for Karla's 2026-06-17 batch dupes.
 *
 * AM-BLD-2026-0011 is byte-identical to 0014 (14210 Beck Drive, Lot 13).
 * AM-BLD-2026-0010 is byte-identical to 0013 (14206 Beck Drive, Lot 12).
 *
 * Strategy: delete the HIGHER reference number in each pair. Lower ref
 * = created first = canonical. Use the DELETE endpoint logic via the
 * supabase client so cascade FKs handle children. Storage paths are
 * logged as orphans (consistent with router.delete behaviour).
 */
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const TO_DELETE = ['AM-BLD-2026-0014', 'AM-BLD-2026-0013'];
const KEEP = ['AM-BLD-2026-0011', 'AM-BLD-2026-0010'];

(async () => {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

  // 1. Pull both the keep and delete rows so we can prove the dupe pair
  //    before doing anything destructive.
  const all = [...TO_DELETE, ...KEEP];
  const { data: rows, error } = await supabase
    .from('builder_applications')
    .select('id, reference_number, street_address, lot_number, plan_number, elevation, builder_company_id, community_id, created_at')
    .in('reference_number', all);
  if (error) { console.error('lookup failed:', error.message); process.exit(1); }

  const byRef = Object.fromEntries(rows.map((r) => [r.reference_number, r]));

  // 2. Verify each delete-target has a corresponding keep row with identical
  //    address/lot/plan/elevation. Bail loudly on any mismatch.
  const pairs = [
    ['AM-BLD-2026-0014', 'AM-BLD-2026-0011'],
    ['AM-BLD-2026-0013', 'AM-BLD-2026-0010'],
  ];
  for (const [del, keep] of pairs) {
    const d = byRef[del], k = byRef[keep];
    if (!d) { console.error(`refusing: ${del} not found`); process.exit(2); }
    if (!k) { console.error(`refusing: ${keep} not found (would orphan history)`); process.exit(2); }
    const sameKey = (
      d.street_address === k.street_address
      && d.lot_number === k.lot_number
      && d.plan_number === k.plan_number
      && d.elevation === k.elevation
      && d.builder_company_id === k.builder_company_id
      && d.community_id === k.community_id
    );
    if (!sameKey) {
      console.error(`refusing: ${del} and ${keep} are NOT duplicates`);
      console.error('  delete row:', d);
      console.error('  keep   row:', k);
      process.exit(3);
    }
    console.log(`✓ confirmed pair: ${del} (delete) is byte-equivalent to ${keep} (keep) — ${k.street_address} Lot ${k.lot_number} ${k.plan_number}/${k.elevation}`);
  }

  // 3. Collect orphan storage paths so they go in the log (audit trail
  //    parity with the DELETE /:id endpoint).
  for (const refNo of TO_DELETE) {
    const row = byRef[refNo];
    const [attsRes, respsRes] = await Promise.all([
      supabase.from('builder_application_attachments').select('storage_path').eq('application_id', row.id),
      supabase.from('builder_application_responses').select('letter_pdf_path').eq('application_id', row.id),
    ]);
    const orphans = [];
    (attsRes.data || []).forEach((a) => { if (a.storage_path) orphans.push(a.storage_path); });
    (respsRes.data || []).forEach((r) => { if (r.letter_pdf_path) orphans.push(r.letter_pdf_path); });

    const { error: dErr } = await supabase
      .from('builder_applications')
      .delete()
      .eq('id', row.id);
    if (dErr) { console.error(`delete failed for ${refNo}:`, dErr.message); process.exit(4); }
    console.log(`✓ deleted ${refNo} — ${orphans.length} storage path${orphans.length === 1 ? '' : 's'} orphaned`);
    if (orphans.length) orphans.forEach((p) => console.log(`    orphan: ${p}`));
  }

  console.log('\nDone. Karla queue should now show 12 unique submissions, not 14.');
})();
