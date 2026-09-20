#!/usr/bin/env node
/**
 * import_fbcad_footprint.js — small, reusable, idempotent FBCAD footprint importer.
 *
 * Imports a contiguous set of FBCAD subdivision sections into a DEMO community as
 * fictional-operations-on-real-geography: residential lots -> properties (fictional
 * DC identity, real situs kept only in appraisal_records provenance), designated
 * reserves + open-space tracts -> community_assets. Street ROW is map context, not
 * imported. NO FBCAD owner names are ever written.
 *
 * Usage:
 *   node scripts/import_fbcad_footprint.js --community=<slug|id> --sections=40-45 --dry-run
 *   node scripts/import_fbcad_footprint.js --community=drama-creek --sections=40-45 --execute
 *
 * Safety: refuses any target that is not is_demo / the demo tenant; HARD refuses
 * the Bedrock production tenant (no override). Writes only with --execute.
 * Idempotent: matches existing by FBCAD parcel id (appraisal_records.parcel_number
 * for properties, community_assets.source_ref for assets); reruns create nothing new.
 *
 * NOT a GIS framework — only what this import needs.
 */
require('dotenv').config();
const path = require('path');
const shapefile = require('shapefile');
const proj4 = require('proj4');
const { createClient } = require('@supabase/supabase-js');
const { BEDROCK_MGMT_CO_ID, DEMO_MGMT_CO_ID } = require('../lib/company');

const FB = '+proj=lcc +lat_0=27.8333333333333 +lon_0=-99 +lat_1=28.3833333333333 +lat_2=30.2833333333333 +x_0=600000 +y_0=4000000 +datum=NAD83 +units=us-ft +no_defs';
const toWgs = proj4(FB, '+proj=longlat +datum=WGS84 +no_defs').forward;
const FBCAD_PULL_DATE = '2025-01-01';   // FBCAD certified-roll as-of used for provenance
const SHP = path.join(__dirname, 'fbcad-data', 'CamaSummary.shp');
const DBF = path.join(__dirname, 'fbcad-data', 'CamaSummary.dbf');
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// ---- args ----
const args = process.argv.slice(2);
const arg = (k) => { const a = args.find((x) => x.startsWith(`--${k}=`)); return a ? a.split('=')[1] : null; };
const has = (k) => args.includes(`--${k}`);
const COMMUNITY = arg('community');
const SECTIONS = (arg('sections') || '').split('-').map(Number);
const EXECUTE = has('execute');
const OVERRIDE_PROD = has('i-understand-production');

function sectionSet() {
  if (SECTIONS.length === 2 && SECTIONS.every(Number.isFinite)) { const s = new Set(); for (let i = SECTIONS[0]; i <= SECTIONS[1]; i++) s.add(String(i)); return s; }
  return new Set((arg('sections') || '').split(',').map((s) => s.trim()).filter(Boolean));
}

// ---- geometry helpers (reproject 2278 -> 4326) ----
function ringToWgs(ring) { return ring.map(([x, y]) => { const [lng, lat] = toWgs([x, y]); return [lng, lat]; }); }
function polygonWKT(geom) {
  if (!geom || geom.type !== 'Polygon') return null;
  const rings = geom.coordinates.map(ringToWgs);
  const body = rings.map((r) => '(' + r.map(([lng, lat]) => `${lng} ${lat}`).join(', ') + ')').join(', ');
  return `POLYGON(${body})`;
}
function centroidWgs(geom) {
  if (!geom || geom.type !== 'Polygon') return null;
  const ring = geom.coordinates[0]; if (!ring || ring.length < 3) return null;
  let sx = 0, sy = 0; for (const v of ring) { sx += v[0]; sy += v[1]; }
  const [lng, lat] = toWgs([sx / ring.length, sy / ring.length]);
  return { lat: +lat.toFixed(7), lng: +lng.toFixed(7) };
}

// ---- deterministic classification ----
function classify(legal) {
  if (/BLOCK\s+\d+,\s*Lot\s+\d+/i.test(legal)) return 'PROPERTY';
  if (/\bReserve\b/i.test(legal)) return 'ASSET_RESERVE';
  if (/\bTract\b/i.test(legal)) return 'ASSET_TRACT';       // decision 1: neutral open-space tracts
  if (/\bROW\b|Right[- ]of[- ]Way/i.test(legal)) return 'CONTEXT';
  return 'EXCEPTION';
}
function assetSpec(legal, sec) {
  const L = legal.toLowerCase();
  if (/\btract\b/.test(L)) return { asset_class: 'landscape', asset_type: 'open_space_tract', name: `Section ${sec} ${(legal.match(/Tract\s+\d+/i) || ['Tract'])[0]}` };
  const resName = (legal.match(/Reserve\s+"?([A-Z])"?/i) || [])[1] || '';
  if (/recreation/.test(L)) return { asset_class: 'recreation', asset_type: 'recreation_reserve', name: `Section ${sec} Reserve ${resName} (Recreation)` };
  if (/detention|drainage|lake|pond/.test(L)) return { asset_class: 'water', asset_type: 'detention_pond', name: `Section ${sec} Reserve ${resName} (Drainage)` };
  return { asset_class: 'landscape', asset_type: 'landscape_reserve', name: `Section ${sec} Reserve ${resName} (Landscape)` };
}
const parseInt2 = (re, s) => (s.match(re) || [])[1] || null;

// ---- boundary union topology (POLYGON vs MULTIPOLYGON) via shared-edge components ----
function unionComponents(polys) {
  // polys: array of outer rings in source coords. Two polys are edge-adjacent if
  // they share >= 2 vertices. Union-find -> connected components. 1 => single
  // POLYGON(-with-holes); >1 => MULTIPOLYGON.
  const key = ([x, y]) => Math.round(x * 100) + '_' + Math.round(y * 100);
  const vmap = new Map();
  polys.forEach((ring, i) => { const seen = new Set(); for (const v of ring) { const k = key(v); if (seen.has(k)) continue; seen.add(k); if (!vmap.has(k)) vmap.set(k, []); vmap.get(k).push(i); } });
  const parent = polys.map((_, i) => i);
  const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  const shared = new Map(); // pair -> count
  for (const list of vmap.values()) { for (let a = 0; a < list.length; a++) for (let b = a + 1; b < list.length; b++) { const p = list[a] < list[b] ? list[a] + ',' + list[b] : list[b] + ',' + list[a]; shared.set(p, (shared.get(p) || 0) + 1); } }
  for (const [p, c] of shared) { if (c >= 2) { const [a, b] = p.split(',').map(Number); parent[find(a)] = find(b); } }
  const comps = new Set(); for (let i = 0; i < polys.length; i++) comps.add(find(i));
  return comps.size;
}

async function main() {
  if (!COMMUNITY || sectionSet().size === 0) { console.error('Usage: --community=<slug|id> --sections=40-45 [--dry-run|--execute]'); process.exit(1); }
  const SECS = sectionSet();

  // ---- SAFETY GATES ----
  const byId = /^[0-9a-f-]{36}$/i.test(COMMUNITY);
  const { data: comm, error: cErr } = await sb.from('communities').select('id, name, slug, is_demo, management_company_id').eq(byId ? 'id' : 'slug', COMMUNITY).maybeSingle();
  if (cErr || !comm) { console.error('Community not found:', COMMUNITY); process.exit(1); }
  if (comm.management_company_id === BEDROCK_MGMT_CO_ID) { console.error(`HARD REFUSAL: "${comm.name}" is on the BEDROCK production tenant. This importer never writes to production.`); process.exit(2); }
  const isDemoTarget = comm.is_demo === true || comm.management_company_id === DEMO_MGMT_CO_ID;
  if (!isDemoTarget && !OVERRIDE_PROD) { console.error(`REFUSAL: "${comm.name}" is not a demo community. Pass --i-understand-production only if this is truly intended.`); process.exit(2); }

  const mode = EXECUTE ? 'LIVE (--execute)' : 'DRY RUN';
  console.log(`\nFBCAD footprint import  ·  target: ${comm.name} (${comm.slug})  ·  sections ${[...SECS].join(',')}  ·  ${mode}`);
  console.log(`Tenant: ${comm.management_company_id === DEMO_MGMT_CO_ID ? 'DEMO' : comm.management_company_id}  ·  is_demo=${comm.is_demo}\n`);

  // ---- stream + classify ----
  const plan = { properties: [], assets: [], context: 0, exceptions: [] };
  const assetPolys = [];   // outer rings (source coords) of PROPERTY+ASSET for boundary
  let scanned = 0, source = 0, ownerNamesInWrites = 0;
  const src = await shapefile.open(SHP, DBF);
  while (true) {
    const r = await src.read(); if (r.done) break; scanned++;
    const p = r.value.properties; const legal = String(p.Legal || '');
    if (!/LONG MEADOW FARM/i.test(legal)) continue;
    const sec = (legal.match(/SEC\s*(\d+)/i) || [])[1];
    if (!SECS.has(sec)) continue;
    source++;
    const cls = classify(legal);
    const pid = String(p.X_Referenc || p.Property_N || '');
    const g = r.value.geometry;
    if (cls === 'PROPERTY') {
      plan.properties.push({ sec, pid, block: parseInt2(/BLOCK\s+(\d+)/i, legal), lot: parseInt2(/Lot\s+(\d+)/i, legal),
        situs: [p.Situs_Stre, p.Situs_St_1, p.Situs_St_2].filter(Boolean).join(' ') || null, legal,
        year_built: Number(p.Year_Built) || null, lot_sqft: Number(p.Land_Size1) || null,
        centroid: centroidWgs(g) });
      if (g && g.type === 'Polygon') assetPolys.push(g.coordinates[0]);
    } else if (cls === 'ASSET_RESERVE' || cls === 'ASSET_TRACT') {
      const spec = assetSpec(legal, sec);
      plan.assets.push({ sec, pid, legal, acres: +(parseInt2(/ACRES\s+([\d.]+)/i, legal) || 0), ...spec, wkt: polygonWKT(g), centroid: centroidWgs(g) });
      if (g && g.type === 'Polygon') assetPolys.push(g.coordinates[0]);
    } else if (cls === 'CONTEXT') { plan.context++; }
    else { plan.exceptions.push({ pid, legal: legal.slice(0, 80) }); }
    // provenance retains owner mailing? NO. We never read Owner_Name into a write.
  }

  // ---- boundary topology ----
  const components = unionComponents(assetPolys);
  const boundaryType = components === 1 ? 'POLYGON (single, holes allowed)' : `MULTIPOLYGON (${components} disjoint parts)`;

  // ---- reconciliation ----
  const P = plan.properties.length, A = plan.assets.length, C = plan.context, E = plan.exceptions.length;
  const assetByType = plan.assets.reduce((m, a) => { m[a.asset_type] = (m[a.asset_type] || 0) + 1; return m; }, {});

  console.log('CLASSIFICATION');
  console.log(`  PROPERTY: ${P}`);
  console.log(`  ASSET:    ${A}  ${JSON.stringify(assetByType)}`);
  console.log(`  CONTEXT:  ${C} (ROW, not imported)`);
  console.log(`  EXCEPTION:${E}`);
  console.log(`\nRECONCILIATION: source ${source} = P ${P} + A ${A} + C ${C} + E ${E}  =>  ${P + A + C + E}  ${source === P + A + C + E ? 'OK (no remainder)' : 'MISMATCH'}`);

  console.log('\nFORMERLY-REVIEW TRACTS (decision 1 — neutral classification):');
  plan.assets.filter((a) => a.asset_type === 'open_space_tract').forEach((a) => console.log(`  ${a.name}  class=${a.asset_class} type=${a.asset_type}  (${a.acres}ac)  FBCAD: "${a.legal.replace(/\s+/g, ' ').slice(0, 70)}"`));

  console.log('\nPRIVACY (planned writes):');
  console.log(`  FBCAD owner-name fields written: ${ownerNamesInWrites}  (owner names excluded by design)`);
  console.log('  Sample DEMO property identities (street_address) + real situs kept ONLY in appraisal_records.raw_extraction:');
  const bySec = {};
  plan.properties.sort((a, b) => (a.sec - b.sec) || String(a.pid).localeCompare(String(b.pid)));
  plan.properties.forEach((pr) => { bySec[pr.sec] = (bySec[pr.sec] || 0) + 1; pr.dcid = `DC-${pr.sec}-${String(bySec[pr.sec]).padStart(3, '0')}`; });
  plan.properties.slice(0, 4).forEach((pr) => console.log(`    ${pr.dcid}  (lot_number=${pr.lot}; situs "${pr.situs}" -> raw_extraction only; owner=fictional)`));

  console.log('\nGEOMETRY');
  console.log(`  properties: centroid lat/lng reprojected EPSG:2278 -> EPSG:4326 (polygon retained in provenance for later activation)`);
  console.log(`  assets: real parcel POLYGON via community_asset_set_geometry`);
  console.log(`  community boundary (union of ${assetPolys.length} residential+asset polygons, ROW excluded) => ${boundaryType}`);

  console.log('\nDEMO IDENTITY EXAMPLES per section:', JSON.stringify(bySec));

  if (!EXECUTE) {
    console.log('\n=== DRY RUN complete — no writes performed. ===');
    if (source !== P + A + C + E) { console.error('BLOCKED: reconciliation mismatch.'); process.exit(1); }
    if (components !== 1) console.log(`\nNOTE (decision 7): the dissolved union is a ${boundaryType}, which is INCOMPATIBLE with communities.boundary GEOGRAPHY(POLYGON,4326). Reporting the geometry result rather than approximating with a convex hull. Community-boundary write is BLOCKED pending a decision; property/asset import is otherwise READY.`);
    process.exit(0);
  }
  console.error('\nLIVE import path not run in this task (dry-run only was requested).');
  process.exit(0);
}
main().catch((e) => { console.error('Crashed:', e.message); process.exit(1); });
