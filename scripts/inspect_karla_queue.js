require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

(async () => {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
  const { data, error } = await supabase
    .from('builder_applications')
    .select('reference_number, street_address, lot_number, plan_number, elevation, submitter_name, status, created_at')
    .like('reference_number', 'AM-BLD-2026-%')
    .order('reference_number', { ascending: true });
  if (error) { console.error(error); process.exit(1); }

  console.log(`Total: ${data.length}\n`);
  // Group by (address+lot+plan+elevation) to find dupes.
  const groups = {};
  for (const r of data) {
    const key = `${r.street_address || ''} | Lot ${r.lot_number || ''} | ${r.plan_number || ''}/${r.elevation || ''}`;
    (groups[key] ||= []).push(r);
  }
  console.log('All rows:');
  for (const r of data) {
    console.log(`  ${r.reference_number} ${r.status.padEnd(10)} ${r.street_address} Lot ${r.lot_number} ${r.plan_number}/${r.elevation} (${r.created_at})`);
  }
  console.log('\nDuplicate groups (same address+lot+plan+elevation):');
  let dupeFound = false;
  for (const [key, rows] of Object.entries(groups)) {
    if (rows.length > 1) {
      dupeFound = true;
      console.log(`  ${key}`);
      rows.forEach((r) => console.log(`    - ${r.reference_number} (${r.created_at})`));
    }
  }
  if (!dupeFound) console.log('  (none)');
})();
