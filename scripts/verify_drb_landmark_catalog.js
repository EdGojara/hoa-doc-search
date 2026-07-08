// Re-verify the DRB Landmark catalog after cleanup.
const fetch = global.fetch || require('node-fetch');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const DRB_ID = 'a4f4e33b-f9e8-48d5-813e-4b65759b2f5d';

const landmark = ['1610', '1800', '1960', '2080', '2380', '2550', '2740'];
const expectedElevs = ['A', 'B', 'C', 'M', 'O', 'P'];
const REAL_ELEVS = new Set(['A','B','C','D','E','F','G','H','L','M','N','O','P','Q','R','S','X','Y']);

(async () => {
  const issues = [];

  // 1. Catalog state per Landmark plan
  for (const pn of landmark) {
    const { data: rows } = await s.from('master_plans')
      .select('elevation, square_footage, elevation_orientation')
      .eq('builder_company_id', DRB_ID)
      .eq('plan_number', pn);
    const elevs = (rows || []).map((r) => r.elevation).sort();
    const expected = expectedElevs.slice().sort();
    if (rows.length !== 6 || JSON.stringify(elevs) !== JSON.stringify(expected)) {
      issues.push(pn + ': has ' + rows.length + ' rows, elevations=[' + elevs.join(',') + '], expected ' + expectedElevs.join(','));
    } else {
      console.log('[✓] ' + pn + ': 6 rows · A,B,C,M,O,P');
    }
  }

  // 2. No noise rows anywhere in DRB catalog (elevations with parens, dots, multi-char beyond standard codes)
  const { data: drbAll } = await s.from('master_plans')
    .select('plan_number, elevation, plan_name')
    .eq('builder_company_id', DRB_ID);
  const noise = (drbAll || []).filter((r) =>
    /\\(|\\)|\\./.test(r.elevation) ||
    (r.elevation.length > 2 && !['1.5','2.5'].includes(r.elevation))
  );
  if (noise.length) {
    console.log('[X] noise rows in catalog:');
    for (const n of noise) console.log('    ' + n.plan_number + '-' + n.elevation + ' | ' + (n.plan_name || ''));
    issues.push(noise.length + ' noise rows present');
  } else {
    console.log('[✓] no noise rows in catalog');
  }

  // 3. Public API returns the Landmark plans for Karla's dropdown
  const r = await fetch('https://my.bedrocktxai.com/api/builder-applications/public/master-plans?community=August%20Meadows&builder=DRB%20Group');
  const j = await r.json();
  const total = j.master_plans?.length || 0;
  console.log('\\nPublic API: ' + total + ' total plans visible to DRB form');
  for (const pn of landmark) {
    const rows = (j.master_plans || []).filter((p) => p.plan_number === pn);
    const elevs = rows.map((r) => r.elevation).sort();
    if (rows.length !== 6 || JSON.stringify(elevs) !== JSON.stringify(expectedElevs.slice().sort())) {
      issues.push('Public API ' + pn + ': has ' + rows.length + ' rows, elevations=[' + elevs.join(',') + ']');
    } else {
      console.log('  [✓] ' + pn + ': 6 elevs visible · A,B,C,M,O,P');
    }
  }

  console.log('\\n=================================');
  if (issues.length === 0) {
    console.log('PASSED: catalog is clean. Karla sees all 7 Landmark plans (42 plan-elevation entries) plus the rest of the DRB catalog.');
  } else {
    console.log('ISSUES (' + issues.length + '):');
    for (const i of issues) console.log('  - ' + i);
  }
})();
