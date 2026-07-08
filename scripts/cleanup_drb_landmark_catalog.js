// Clean up the DRB Landmark catalog:
//   1. Remove the duplicate BLANTON rows my import_drb_blanton_driskill
//      script added (elevation_orientation='standard'). The pre-existing
//      rows with elevation_orientation=NULL stay.
//   2. Remove the 6 MEYERSON noise rows where elevation was committed as
//      "A (1)", "B (2)", etc. — the bulk-upload UI's duplicate-detection
//      suffix leaked into the elevation field.
//   3. Insert real MEYERSON A, B, C, M, O, P rows at 2740 sqft, 2 story.

const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const DRB_ID = 'a4f4e33b-f9e8-48d5-813e-4b65759b2f5d';

(async () => {
  // 1. Delete the BLANTON duplicates I added (elevation_orientation='standard')
  console.log('--- Cleaning BLANTON duplicates ---');
  const { data: delBlanton, error: e1 } = await s.from('master_plans')
    .delete()
    .eq('builder_company_id', DRB_ID)
    .eq('plan_number', '1610')
    .eq('elevation_orientation', 'standard')
    .select('id, elevation');
  console.log('  removed: ' + (delBlanton?.length || 0) + (e1 ? ' (err ' + e1.message + ')' : ''));

  // 2. Delete MEYERSON noise rows (elevation contains parens or is multi-char)
  console.log('\\n--- Cleaning MEYERSON noise rows ---');
  const { data: meyersonAll } = await s.from('master_plans')
    .select('id, elevation')
    .eq('builder_company_id', DRB_ID)
    .eq('plan_number', '2740');
  const noiseIds = (meyersonAll || [])
    .filter((r) => /\\(|\\)/.test(r.elevation) || r.elevation.length > 2)
    .map((r) => r.id);
  console.log('  noise rows found: ' + noiseIds.length);
  if (noiseIds.length) {
    const { error: e2 } = await s.from('master_plans').delete().in('id', noiseIds);
    console.log('  removed: ' + (e2 ? 'ERR ' + e2.message : noiseIds.length));
  }

  // 3. Insert proper MEYERSON entries
  console.log('\\n--- Inserting MEYERSON A/B/C/M/O/P ---');
  let inserted = 0, skipped = 0;
  for (const code of ['A', 'B', 'C', 'M', 'O', 'P']) {
    const { error } = await s.from('master_plans').insert({
      builder_company_id: DRB_ID,
      plan_number: '2740',
      plan_name: 'Meyerson',
      elevation: code,
      elevation_orientation: 'standard',
      square_footage: 2740,
      stories: 2,
      default_materials: {},
      status: 'approved',
      notes: 'DRB Landmark Meyerson — cleanup pass 2026-06-12 after bulk-upload UI committed noise rows.',
    });
    if (error) {
      if (error.code === '23505') skipped++;
      else console.log('  ✗ ' + code + ': ' + error.message);
    } else {
      inserted++;
    }
  }
  console.log('  inserted: ' + inserted + ', skipped (already in catalog): ' + skipped);

  console.log('\\nDone.');
})();
