#!/usr/bin/env node
/**
 * seed_demo_lma_realgeo.js — trace Sterling Ridge assets onto ACTUAL visible
 * physical features. The primary assets get real footprints pulled from the same
 * OSM vectors that align to the satellite imagery (a real detention pond and real
 * landscaped greenway strips near Gleannloch, Spring TX — not a Bedrock client;
 * the fictional Sterling Ridge names stay). Child systems get small geometry co-
 * located on their parent and are hidden at the default map scale (shown on
 * select). GEOMETRY ONLY — asset rows, accounting, projects, and photos are keyed
 * by stable id and are untouched. Idempotent.
 *
 *   node scripts/seed_demo_lma_realgeo.js --execute
 */
require('dotenv').config({ quiet: true });
const { createClient } = require('@supabase/supabase-js');
const { blobWKT, lineWKT, multiPointWKT, pointWKT } = require('../lib/community/asset_geometry');
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const EXECUTE = process.argv.includes('--execute');
const A = (n) => `e011${String(n).padStart(4, '0')}-0000-4000-a000-000000000000`;

// Real traced footprints (OSM, simplified) — each follows a visible physical feature.
const REAL = {
  detention: 'POLYGON((-95.556963 30.059096,-95.556964 30.059183,-95.556909 30.059251,-95.556797 30.059279,-95.554485 30.059333,-95.554394 30.059314,-95.554343 30.059275,-95.554308 30.059200,-95.554235 30.056707,-95.554259 30.056619,-95.554308 30.056561,-95.554394 30.056545,-95.554517 30.056589,-95.556963 30.059096))', // real pond
  median7:  'POLYGON((-95.551376 30.057221,-95.550873 30.053629,-95.550832 30.053310,-95.550800 30.053118,-95.550781 30.053095,-95.550708 30.053052,-95.550645 30.053066,-95.550653 30.056811,-95.550661 30.056869,-95.550793 30.056993,-95.550830 30.057067,-95.550905 30.057157,-95.551019 30.057190,-95.551376 30.057221))', // real landscape strip
  median3:  'POLYGON((-95.552327 30.057351,-95.552308 30.057321,-95.552289 30.057301,-95.552273 30.057290,-95.552028 30.057305,-95.552000 30.057331,-95.551970 30.057384,-95.552285 30.059585,-95.552304 30.059609,-95.552327 30.059620,-95.552369 30.059625,-95.552566 30.059604,-95.552637 30.059534,-95.552327 30.057351))',
  median5:  'POLYGON((-95.552291 30.057102,-95.552270 30.057146,-95.552239 30.057169,-95.552017 30.057188,-95.551981 30.057179,-95.551937 30.057118,-95.551852 30.056505,-95.551565 30.054464,-95.551599 30.054433,-95.551644 30.054400,-95.551729 30.054391,-95.551819 30.054413,-95.552291 30.057102))',
  corridor: 'POLYGON((-95.550772 30.063355,-95.550645 30.063390,-95.550561 30.064023,-95.550743 30.064433,-95.551746 30.064652,-95.552018 30.064545,-95.551413 30.057395,-95.551146 30.057341,-95.551288 30.058086,-95.551336 30.063783,-95.551304 30.064368,-95.550917 30.064457,-95.550590 30.063745,-95.550772 30.063355))', // real greenway strip
};
// centroid of a WKT polygon (avg of ring vertices) — for placing child geometry.
function centroid(wkt) {
  const nums = wkt.match(/-?\d+\.\d+/g).map(Number); let sx = 0, sy = 0, k = 0;
  for (let i = 0; i < nums.length; i += 2) { sx += nums[i]; sy += nums[i + 1]; k++; }
  return [sx / k, sy / k];
}
const c7 = centroid(REAL.median7), c3 = centroid(REAL.median3), c5 = centroid(REAL.median5);

// [assetIdx, wkt, note]
const ASSIGN = [
  [16, REAL.detention, 'detention basin -> real pond'],
  [3,  REAL.median7,   'Median 7 -> real landscape strip'],
  [1,  REAL.median3,   'Median 3 -> real landscape strip'],
  [2,  REAL.median5,   'Median 5 -> real landscape strip'],
  [15, REAL.corridor,  'Parkway tree corridor -> real greenway strip'],
  // monuments: points at the entrance ends of the strips
  [4,  pointWKT(c7[0] + 0.00002, 30.05320), 'West monument -> south entrance point'],
  [5,  pointWKT(c3[0] - 0.00002, 30.05955), 'East monument -> north entrance point'],
  // parkway lighting: a run along the Median 7 strip
  [14, lineWKT([[c7[0] - 0.0002, 30.05330], [c7[0] - 0.00015, 30.05520], [c7[0] - 0.0001, 30.05700]]), 'Parkway lighting -> run'],
  // entrance beds: small footprints by the monuments
  [6,  blobWKT(c7[0] + 0.00004, 30.05330, 0.00006, 0.00004, 7, 31), 'West bed'],
  [7,  blobWKT(c3[0] - 0.00004, 30.05955, 0.00006, 0.00004, 7, 37), 'East bed'],
  // child systems of Median 7 (hidden at default scale; shown on select)
  [8,  blobWKT(c7[0], c7[1], 0.00008, 0.00010, 9, 41), 'Median 7 irrigation coverage'],
  [9,  blobWKT(c7[0] + 0.00006, c7[1] + 0.0004, 0.00004, 0.00003, 7, 43), 'Median 7 beds'],
  [10, multiPointWKT([[c7[0], c7[1] - 0.0006], [c7[0], c7[1]], [c7[0], c7[1] + 0.0006]]), 'Median 7 trees'],
  [11, lineWKT([[c7[0], c7[1] - 0.0008], [c7[0], c7[1] + 0.0008]]), 'Median 7 lighting'],
  // child systems of the other medians
  [12, blobWKT(c5[0], c5[1], 0.00007, 0.00009, 8, 47), 'Median 5 irrigation'],
  [13, multiPointWKT([[c3[0], c3[1] - 0.0005], [c3[0], c3[1] + 0.0005]]), 'Median 3 trees'],
];

async function main() {
  console.log(`\nSterling Ridge REAL geometry trace — ${EXECUTE ? 'EXECUTE' : 'DRY RUN'} — ${ASSIGN.length} assets\n`);
  ASSIGN.forEach(([idx, wkt, note]) => console.log(`  ${A(idx).slice(0, 8)}  ${wkt.split('(')[0].padEnd(12)} ${note}`));
  if (!EXECUTE) { console.log('\nDRY RUN — no writes.'); return; }
  let set = 0;
  for (const [idx, wkt] of ASSIGN) {
    const { data, error } = await sb.rpc('community_asset_set_geometry', { p_asset_id: A(idx), p_wkt: wkt });
    if (error) throw new Error('geom ' + A(idx) + ': ' + error.message);
    if (data && data.ok) set++;
  }
  console.log(`\ngeometries set via canonical RPC: ${set}/${ASSIGN.length} (accounting/projects/photos untouched).`);
}
main().catch((e) => { console.error('\nFAILED:', e.message); process.exit(1); });
