// Add the New Fairway Series ABC elevations to the master plan catalog for
// Lennar @ Still Creek. Idempotent — skips any plan/elevation already present.
// Ed 2026-06-19. --apply to write.
require('dotenv').config();
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const APPLY = process.argv.includes('--apply');

(async () => {
  const ext = JSON.parse(fs.readFileSync('scripts/_fairway_extracted.json', 'utf8'));
  const { data: lennar } = await s.from('builder_companies').select('id').ilike('company_name', '%lennar%').maybeSingle();
  const BID = lennar.id;

  // Existing Lennar entries for these plans → dedup + pull canonical plan_name.
  const nums = [...new Set(ext.plans.map((p) => p.plan_number))];
  const { data: existing } = await s.from('master_plans').select('plan_number, plan_name, elevation').eq('builder_company_id', BID).in('plan_number', nums);
  const have = new Set((existing || []).map((m) => m.plan_number + '|' + (m.elevation || '').toUpperCase()));
  const nameByNum = {};
  for (const m of (existing || [])) { if (m.plan_name && !nameByNum[m.plan_number]) nameByNum[m.plan_number] = m.plan_name; }

  const rows = [];
  for (const p of ext.plans) {
    const num = p.plan_number;
    const elev = (p.elevation || '').toUpperCase();
    if (!num || !elev) continue;
    if (have.has(num + '|' + elev)) continue; // already in catalog
    rows.push({
      builder_company_id: BID,
      plan_number: num,
      plan_name: nameByNum[num] || p.plan_name || null,
      elevation: elev,
      elevation_orientation: 'standard',
      square_footage: p.square_footage || null,
      stories: p.stories || null,
      default_materials: {},
      status: 'approved',
      notes: 'Added from New Fairway Series ABC package on 2026-06-19.',
      first_approval_application_id: null,
    });
  }

  console.log(`To add: ${rows.length} plan/elevation entries`);
  rows.forEach((r) => console.log('  ', r.plan_number, '/', r.elevation, '·', r.plan_name || '(no name)'));
  if (!APPLY) { console.log('\nDRY RUN — pass --apply to write.'); return; }

  const { data, error } = await s.from('master_plans').insert(rows).select('id');
  if (error) { console.error('insert failed:', error.message); process.exit(1); }
  console.log(`\nINSERTED ${data.length} master plan entries.`);

  // Re-check the Serene Meadow B-lots now match.
  const lots = ['SCR-BLD-2026-0017', 'SCR-BLD-2026-0019', 'SCR-BLD-2026-0013'];
  const { data: apps } = await s.from('builder_applications').select('reference_number, street_address, plan_number, elevation').in('reference_number', lots);
  console.log('\nSerene Meadow B-lots vs catalog now:');
  for (const a of (apps || [])) {
    const { data: match } = await s.from('master_plans').select('id')
      .eq('builder_company_id', BID).eq('plan_number', a.plan_number).ilike('elevation', a.elevation).maybeSingle();
    console.log('  ', a.reference_number, a.street_address, '·', a.plan_number + '/' + a.elevation, match ? '✓ MATCHES master plan now' : '✗ still no match');
  }
})();
