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

// ---------------------------------------------------------------------------
// Real (organic) operational geometry. trustEd stores each asset's actual
// physical footprint as GEOGRAPHY(GEOMETRY,4326) of ANY subtype (POINT / MULTI-
// POINT / LINESTRING / MULTILINESTRING / POLYGON), written through the canonical
// community_asset_set_geometry RPC. These are OPERATIONAL map geometries (they
// follow the road axis and the real greenspace), not survey plats — so shapes
// are believable footprints, not bounding rectangles. Parametric generators
// below keep them reusable and non-rectangular. Aligned to the developed
// Northpointe corridor (axis lat ~30.0505; detention in the real greenspace).
// Asset keys/ids/types/conditions/hierarchy are unchanged, so the accounting
// chain in seed_demo_lma_ops.js is untouched.
const { medianWKT, blobWKT, lineWKT, multiLineWKT, multiPointWKT, pointWKT } = require('../lib/community/asset_geometry');
const CL = 30.05050; // boulevard axis

// key, name, class, type, condition, geometry WKT (WGS84 lng lat), parentKey, location_description
const A = [
  ['median-3', 'Median 3', 'landscape', 'median', 'good',
    medianWKT(-95.56280, CL, 0.00030, 0.00004, 0.00008), null, 'Sterling Ridge Pkwy at Willow'],
  ['median-5', 'Median 5', 'landscape', 'median', 'good',
    medianWKT(-95.56030, CL, 0.00030, 0.00004, 0.00008), null, 'Sterling Ridge Pkwy mid'],
  ['median-7', 'Median 7', 'landscape', 'median', 'poor',
    medianWKT(-95.55790, CL, 0.00030, 0.00004, 0.00008), null, 'Sterling Ridge Pkwy at Oak (recurring irrigation issues)'],
  ['mon-west', 'West Entrance Monument', 'structure', 'monument', 'excellent',
    blobWKT(-95.56370, 30.05052, 0.00011, 0.00007, 9, 11), null, 'West entrance, Sterling Ridge Pkwy'],
  ['mon-east', 'East Entrance Monument', 'structure', 'monument', 'good',
    blobWKT(-95.55700, 30.05052, 0.00011, 0.00007, 9, 23), null, 'East entrance, Sterling Ridge Pkwy'],
  ['bed-west', 'West Entrance Landscape Bed', 'landscape', 'landscape_bed', 'good',
    blobWKT(-95.56345, 30.05060, 0.00006, 0.000035, 7, 31), null, 'West entrance color bed'],
  ['bed-east', 'East Entrance Landscape Bed', 'landscape', 'landscape_bed', 'fair',
    blobWKT(-95.55725, 30.05060, 0.00006, 0.000035, 7, 37), null, 'East entrance color bed'],
  ['m7-irrig', 'Median 7 Irrigation', 'utility', 'irrigation_zone', 'poor',
    medianWKT(-95.55790, CL, 0.00026, 0.000028, 0.00007), 'median-7', 'Irrigation coverage under Median 7'],
  ['m7-beds', 'Median 7 Landscape Beds', 'landscape', 'landscape_bed', 'fair',
    blobWKT(-95.55780, 30.05053, 0.00006, 0.000022, 7, 41), 'median-7', 'Planting beds on Median 7'],
  ['m7-trees', 'Median 7 Trees', 'landscape', 'tree_area', 'good',
    multiPointWKT([[-95.55812,30.05050],[-95.55798,30.050515],[-95.55784,30.05050],[-95.55772,30.050515]]), 'median-7', 'Live oaks on Median 7'],
  ['m7-light', 'Median 7 Lighting', 'utility', 'lighting_run', 'good',
    lineWKT([[-95.55818,30.050505],[-95.55790,30.05051],[-95.55763,30.050505]]), 'median-7', 'Uplighting along Median 7'],
  ['m5-irrig', 'Median 5 Irrigation', 'utility', 'irrigation_zone', 'good',
    medianWKT(-95.56030, CL, 0.00026, 0.000028, 0.00007), 'median-5', 'Irrigation coverage under Median 5'],
  ['m3-trees', 'Median 3 Trees', 'landscape', 'tree_area', 'good',
    multiPointWKT([[-95.56302,30.05050],[-95.56282,30.050515],[-95.56262,30.05050]]), 'median-3', 'Crape myrtles on Median 3'],
  ['pkwy-light', 'Sterling Ridge Parkway Lighting Run', 'utility', 'lighting_run', 'good',
    lineWKT([[-95.56390,30.050575],[-95.56200,30.05059],[-95.56030,30.050585],[-95.55860,30.05059],[-95.55690,30.050575]]), null, 'Parkway street lighting circuit'],
  ['pkwy-trees', 'Parkway Tree Corridor', 'landscape', 'tree_corridor', 'fair',
    multiLineWKT([[[-95.56390,30.05061],[-95.56030,30.050615],[-95.55690,30.05061]],[[-95.56390,30.05044],[-95.56030,30.050435],[-95.55690,30.05044]]]), null, 'Parkway tree lines, both sides'],
  ['detention', 'Sterling Ridge Detention Basin', 'water', 'detention_basin', 'fair',
    blobWKT(-95.55990, 30.05078, 0.00028, 0.00016, 12, 53), null, 'Regional detention basin, north greenspace'],
];
const BOUNDARY = 'POLYGON((-95.56430 30.05100,-95.55650 30.05100,-95.55650 30.05030,-95.56430 30.05030,-95.56430 30.05100))';
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
