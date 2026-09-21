#!/usr/bin/env node
/**
 * seed_demo_lma.js — permanent fictional Demo LMA geography (Sterling Ridge
 * Landscape District), under the DEMO tenant. Common-area assets with real
 * canonical geometry (POINT/LINESTRING/POLYGON) and parent/child hierarchy,
 * written through the production `community_asset_set_geometry` RPC — no
 * parallel coordinate store. Idempotent (stable UUIDs). Geography only;
 * operations (projects/vendors/invoices) live in seed_demo_lma_ops.js.
 *
 *   node scripts/seed_demo_lma.js --dry-run
 *   node scripts/seed_demo_lma.js --execute
 */
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { DEMO_MGMT_CO_ID } = require('../lib/company');
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const EXECUTE = process.argv.includes('--execute');

const LMA = 'e0100000-0000-4000-a000-000000000000';                 // Sterling Ridge LMA community
const uid = (n) => `e011${String(n).padStart(4, '0')}-0000-4000-a000-000000000000`;

// key, name, class, type, condition, geometry WKT (WGS84 lng lat), parentKey, location_description
const A = [
  ['median-3', 'Median 3', 'landscape', 'median', 'good',
    'POLYGON((-95.55475 30.05005,-95.55425 30.05005,-95.55425 30.04995,-95.55475 30.04995,-95.55475 30.05005))', null, 'Sterling Ridge Pkwy at Willow'],
  ['median-5', 'Median 5', 'landscape', 'median', 'good',
    'POLYGON((-95.55225 30.05005,-95.55175 30.05005,-95.55175 30.04995,-95.55225 30.04995,-95.55225 30.05005))', null, 'Sterling Ridge Pkwy mid'],
  ['median-7', 'Median 7', 'landscape', 'median', 'poor',
    'POLYGON((-95.54975 30.05005,-95.54925 30.05005,-95.54925 30.04995,-95.54975 30.04995,-95.54975 30.05005))', null, 'Sterling Ridge Pkwy at Oak (recurring irrigation issues)'],
  ['mon-west', 'West Entrance Monument', 'structure', 'monument', 'excellent',
    'POINT(-95.55605 30.05000)', null, 'West entrance, Sterling Ridge Pkwy'],
  ['mon-east', 'East Entrance Monument', 'structure', 'monument', 'good',
    'POINT(-95.54795 30.05000)', null, 'East entrance, Sterling Ridge Pkwy'],
  ['bed-west', 'West Entrance Landscape Bed', 'landscape', 'landscape_bed', 'good',
    'POLYGON((-95.55600 30.05025,-95.55580 30.05025,-95.55580 30.05015,-95.55600 30.05015,-95.55600 30.05025))', null, 'West entrance color bed'],
  ['bed-east', 'East Entrance Landscape Bed', 'landscape', 'landscape_bed', 'fair',
    'POLYGON((-95.54820 30.05025,-95.54800 30.05025,-95.54800 30.05015,-95.54820 30.05015,-95.54820 30.05025))', null, 'East entrance color bed'],
  ['m7-irrig', 'Median 7 Irrigation', 'utility', 'irrigation_zone', 'poor',
    'POLYGON((-95.54970 30.05003,-95.54930 30.05003,-95.54930 30.04997,-95.54970 30.04997,-95.54970 30.05003))', 'median-7', 'Irrigation zone under Median 7'],
  ['m7-beds', 'Median 7 Landscape Beds', 'landscape', 'landscape_bed', 'fair',
    'POLYGON((-95.54950 30.05004,-95.54925 30.05004,-95.54925 30.04996,-95.54950 30.04996,-95.54950 30.05004))', 'median-7', 'Planting beds on Median 7'],
  ['m7-trees', 'Median 7 Trees', 'landscape', 'tree_area', 'good',
    'POINT(-95.54960 30.05000)', 'median-7', 'Live oaks on Median 7'],
  ['m7-light', 'Median 7 Lighting', 'utility', 'lighting_run', 'good',
    'LINESTRING(-95.54975 30.05000,-95.54925 30.05000)', 'median-7', 'Uplighting along Median 7'],
  ['m5-irrig', 'Median 5 Irrigation', 'utility', 'irrigation_zone', 'good',
    'POLYGON((-95.55220 30.05003,-95.55180 30.05003,-95.55180 30.04997,-95.55220 30.04997,-95.55220 30.05003))', 'median-5', 'Irrigation zone under Median 5'],
  ['m3-trees', 'Median 3 Trees', 'landscape', 'tree_area', 'good',
    'POINT(-95.55450 30.05000)', 'median-3', 'Crape myrtles on Median 3'],
  ['pkwy-light', 'Sterling Ridge Parkway Lighting Run', 'utility', 'lighting_run', 'good',
    'LINESTRING(-95.55600 30.05010,-95.55200 30.05010,-95.54800 30.05010)', null, 'Parkway street lighting circuit'],
  ['pkwy-trees', 'Parkway Tree Corridor', 'landscape', 'tree_corridor', 'fair',
    'LINESTRING(-95.55600 30.04990,-95.55200 30.04990,-95.54800 30.04990)', null, 'Parkway tree line, south side'],
  ['detention', 'Sterling Ridge Detention Basin', 'water', 'detention_basin', 'fair',
    'POLYGON((-95.55560 30.04960,-95.55500 30.04960,-95.55500 30.04930,-95.55560 30.04930,-95.55560 30.04960))', null, 'Regional detention basin, SW corner'],
];
const BOUNDARY = 'POLYGON((-95.55650 30.05060,-95.54750 30.05060,-95.54750 30.04900,-95.55650 30.04900,-95.55650 30.05060))';
const keyIndex = Object.fromEntries(A.map(([k], i) => [k, i + 1]));

async function main() {
  console.log(`\nDemo LMA geography seed — Sterling Ridge Landscape District — ${EXECUTE ? 'EXECUTE' : 'DRY RUN'}\n`);

  // 1) Community (DEMO tenant, is_demo)
  const community = {
    id: LMA, management_company_id: DEMO_MGMT_CO_ID,
    name: 'Sterling Ridge Landscape District', legal_name: 'Sterling Ridge Landscape District',
    slug: 'sterling-ridge-lma', county: 'Fictional County', state: 'TX', total_lots: 0,
    is_demo: true, active: true,
    notes: 'Permanent fictional Demo LMA (landscape/infrastructure district) for the Visual Operating Map. Seeded by seed_demo_lma.js. No real client data.',
  };
  console.log('community:', community.name, '(', community.slug, ') tenant=DEMO');
  console.log(`assets: ${A.length}  |  hierarchy: median-7 -> 4 children, median-5 -> 1, median-3 -> 1`);
  A.forEach(([k, name, cls, type, cond, wkt, parent]) => console.log(`  ${k.padEnd(11)} ${type.padEnd(16)} ${cond.padEnd(10)} ${wkt.split('(')[0].padEnd(11)}${parent ? ' child of ' + parent : ''}`));

  if (!EXECUTE) { console.log('\nDRY RUN — no writes.'); return; }

  // upsert community
  const { error: cErr } = await sb.from('communities').upsert(community, { onConflict: 'id' });
  if (cErr) throw new Error('community upsert: ' + cErr.message);

  // 2) assets (insert row, then set geometry via canonical RPC)
  let created = 0, geomSet = 0;
  for (const [k, name, cls, type, cond, wkt, parentKey, locDesc] of A) {
    const id = uid(keyIndex[k]);
    const parent_asset_id = parentKey ? uid(keyIndex[parentKey]) : null;
    const row = {
      id, management_company_id: DEMO_MGMT_CO_ID, community_id: LMA, parent_asset_id,
      name, asset_class: cls, asset_type: type, status: 'active', condition: cond,
      member_scope: 'not_applicable', source_system: 'demo_lma', source_ref: k,
      location_description: locDesc,
    };
    const { error: aErr } = await sb.from('community_assets').upsert(row, { onConflict: 'id' });
    if (aErr) throw new Error(`asset ${k}: ${aErr.message}`);
    created++;
    const { data: g, error: gErr } = await sb.rpc('community_asset_set_geometry', { p_asset_id: id, p_wkt: wkt });
    if (gErr) throw new Error(`geometry ${k}: ${gErr.message}`);
    if (g && g.ok) geomSet++;
  }
  console.log(`\nassets upserted: ${created}  |  geometries set via RPC: ${geomSet}`);

  // 3) community boundary (perimeter) via canonical RPC
  const { error: bErr } = await sb.rpc('community_boundary_set', { p_community_id: LMA, p_wkt: BOUNDARY, p_notes: 'Demo LMA district perimeter' });
  if (bErr) throw new Error('boundary: ' + bErr.message);
  console.log('boundary set (district perimeter).');
  console.log('\nEXECUTE complete. Operations (projects/vendors/invoices) seed separately after migrations 443-445.');
}
main().catch((e) => { console.error('\nFAILED:', e.message); process.exit(1); });
