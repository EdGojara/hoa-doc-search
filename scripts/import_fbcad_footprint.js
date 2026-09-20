#!/usr/bin/env node
/**
 * import_fbcad_footprint.js — small, reusable, idempotent FBCAD footprint importer.
 *
 * Imports a contiguous set of FBCAD subdivision sections into a DEMO community as
 * fictional-operations-on-real-geography: residential lots -> properties (fictional
 * DC identity, real situs kept only in appraisal_records provenance), designated
 * reserves + open-space tracts -> community_assets. Street ROW is map context, not
 * imported. NO FBCAD owner names are ever written. The community boundary is the
 * TRUE geometric dissolve of the parcels, computed in PostGIS (migration 442).
 *
 * Usage:
 *   node scripts/import_fbcad_footprint.js --community=<slug|id> --sections=40-45 --dry-run
 *   node scripts/import_fbcad_footprint.js --community=drama-creek --sections=40-45 --execute
 *
 * Safety: refuses any target that is not is_demo / the demo tenant; HARD refuses
 * the Bedrock production tenant (no override). Writes only with --execute.
 * Idempotent: existing properties match by DEMO street_address identity, provenance
 * by appraisal_records.parcel_number, assets by community_assets.source_ref; reruns
 * create nothing new. NOT a GIS framework — only what this import needs.
 */
require('dotenv').config();
const path = require('path');
const shapefile = require('shapefile');
const proj4 = require('proj4');
const { createClient } = require('@supabase/supabase-js');
const { BEDROCK_MGMT_CO_ID, DEMO_MGMT_CO_ID } = require('../lib/company');

const FB = '+proj=lcc +lat_0=27.8333333333333 +lon_0=-99 +lat_1=28.3833333333333 +lat_2=30.2833333333333 +x_0=600000 +y_0=4000000 +datum=NAD83 +units=us-ft +no_defs';
const toWgs = proj4(FB, '+proj=longlat +datum=WGS84 +no_defs').forward;
const FBCAD_PULL_DATE = '2025-01-01';   // FBCAD roll as-of recorded on provenance
const PROP_CITY = 'Richmond';           // regional context only; identity is the DC id
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

// Chunked insert (avoids oversized single requests; returns selected rows).
async function insertChunked(table, rows, selectCols) {
  const out = [];
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200);
    const { data, error } = await sb.from(table).insert(chunk).select(selectCols || 'id');
    if (error) throw new Error(`${table} insert failed: ${error.message}`);
    if (data) out.push(...data);
  }
  return out;
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
  if (comm.management_company_id !== DEMO_MGMT_CO_ID) { console.error(`REFUSAL: "${comm.name}" is not on the DEMO management-company tenant.`); process.exit(2); }
  const DC = comm.id;

  const mode = EXECUTE ? 'LIVE (--execute)' : 'DRY RUN';
  console.log(`\nFBCAD footprint import  ·  target: ${comm.name} (${comm.slug})  ·  sections ${[...SECS].join(',')}  ·  ${mode}`);
  console.log(`Tenant: DEMO  ·  is_demo=${comm.is_demo}\n`);

  // ---- stream + classify ----
  const plan = { properties: [], assets: [], context: 0, exceptions: [] };
  const boundaryWkts = [];   // WGS84 WKT of every PROPERTY + ASSET (excludes ROW)
  let scanned = 0, source = 0;
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
    const wkt = polygonWKT(g);
    if (cls === 'PROPERTY') {
      plan.properties.push({ sec, pid, block: parseInt2(/BLOCK\s+(\d+)/i, legal), lot: parseInt2(/Lot\s+(\d+)/i, legal),
        situs: [p.Situs_Stre, p.Situs_St_1, p.Situs_St_2].filter(Boolean).join(' ') || null, legal,
        year_built: Number(p.Year_Built) || null, lot_sqft: Number(p.Land_Size1) || null,
        centroid: centroidWgs(g), wkt });
      if (wkt) boundaryWkts.push(wkt);
    } else if (cls === 'ASSET_RESERVE' || cls === 'ASSET_TRACT') {
      const spec = assetSpec(legal, sec);
      plan.assets.push({ sec, pid, legal, acres: +(parseInt2(/ACRES\s+([\d.]+)/i, legal) || 0), ...spec, wkt, centroid: centroidWgs(g) });
      if (wkt) boundaryWkts.push(wkt);
    } else if (cls === 'CONTEXT') { plan.context++; }
    else { plan.exceptions.push({ pid, legal: legal.slice(0, 80) }); }
    // Owner_Name is NEVER read into any planned write.
  }

  // ---- deterministic DEMO identity: DC-<sec>-<seq>, seq by parcel id within section ----
  const bySec = {};
  plan.properties.sort((a, b) => (a.sec - b.sec) || String(a.pid).localeCompare(String(b.pid)));
  plan.properties.forEach((pr) => { bySec[pr.sec] = (bySec[pr.sec] || 0) + 1; pr.dcid = `DC-${pr.sec}-${String(bySec[pr.sec]).padStart(3, '0')}`; });

  // ---- reconciliation (must hold before any write) ----
  const P = plan.properties.length, A = plan.assets.length, C = plan.context, E = plan.exceptions.length;
  const assetByType = plan.assets.reduce((m, a) => { m[a.asset_type] = (m[a.asset_type] || 0) + 1; return m; }, {});
  console.log('CLASSIFICATION');
  console.log(`  PROPERTY: ${P}`);
  console.log(`  ASSET:    ${A}  ${JSON.stringify(assetByType)}`);
  console.log(`  CONTEXT:  ${C} (ROW, not imported)`);
  console.log(`  EXCEPTION:${E}`);
  const reconOk = source === P + A + C + E && E === 0;
  console.log(`\nRECONCILIATION: source ${source} = P ${P} + A ${A} + C ${C} + E ${E}  =>  ${P + A + C + E}  ${reconOk ? 'OK (no remainder, 0 exception)' : 'MISMATCH'}`);

  console.log('\nFORMERLY-REVIEW TRACTS (decision 1 — neutral classification):');
  plan.assets.filter((a) => a.asset_type === 'open_space_tract').forEach((a) => console.log(`  ${a.name}  class=${a.asset_class} type=${a.asset_type}  (${a.acres}ac)`));
  console.log('\nDEMO IDENTITY per section:', JSON.stringify(bySec));
  console.log('Sample:', plan.properties.slice(0, 3).map((pr) => `${pr.dcid} lot=${pr.lot} situs->provenance`).join('  ·  '));

  if (!reconOk) { console.error('\nBLOCKED: reconciliation must be exactly 424 = 376 + 17 + 31 with 0 exception before any write.'); process.exit(1); }

  if (!EXECUTE) {
    // Read-only idempotency preview: how many would be created vs already present.
    const { data: xp } = await sb.from('properties').select('street_address').eq('community_id', DC).limit(2000);
    const addrSet = new Set((xp || []).map((r) => r.street_address));
    const { data: xa } = await sb.from('appraisal_records').select('parcel_number').eq('community_id', DC).eq('county_source', 'FBCAD').limit(2000);
    const pSet = new Set((xa || []).map((r) => r.parcel_number));
    const { data: xs } = await sb.from('community_assets').select('source_ref').eq('community_id', DC).eq('source_system', 'fbcad').limit(2000);
    const sSet = new Set((xs || []).map((r) => r.source_ref));
    const wouldProps = plan.properties.filter((pr) => !addrSet.has(pr.dcid)).length;
    const wouldAppr = plan.properties.filter((pr) => !pSet.has(pr.pid)).length;
    const wouldAssets = plan.assets.filter((a) => !sSet.has(a.pid)).length;
    console.log('\nIDEMPOTENCY (read-only preview):');
    console.log(`  properties would create: ${wouldProps}  (already present: ${P - wouldProps})`);
    console.log(`  provenance would create: ${wouldAppr}  (already present: ${P - wouldAppr})`);
    console.log(`  assets     would create: ${wouldAssets}  (already present: ${A - wouldAssets})`);
    console.log('\n=== DRY RUN complete — no writes performed. ===');
    console.log('Boundary: TRUE PostGIS dissolve of', boundaryWkts.length, 'parcel polygons via community_boundary_dissolve_from_wkts (migration 442).');
    process.exit(0);
  }

  // ==========================================================================
  // LIVE EXECUTE — Drama Creek DEMO tenant only. Idempotent.
  // ==========================================================================
  console.log('\n=== LIVE EXECUTE ===');

  // Idempotency preload (DC is small — well under the 1000-row cap).
  const { data: exProps, error: e1 } = await sb.from('properties').select('id, street_address').eq('community_id', DC).limit(2000);
  if (e1) throw new Error('preload properties failed: ' + e1.message);
  const propByAddr = new Map((exProps || []).map((r) => [r.street_address, r.id]));
  const { data: exApp, error: e2 } = await sb.from('appraisal_records').select('parcel_number').eq('community_id', DC).eq('county_source', 'FBCAD').limit(2000);
  if (e2) throw new Error('preload appraisal_records failed: ' + e2.message);
  const parcelSet = new Set((exApp || []).map((r) => r.parcel_number));
  const { data: exAssets, error: e3 } = await sb.from('community_assets').select('source_ref').eq('community_id', DC).eq('source_system', 'fbcad').limit(2000);
  if (e3) throw new Error('preload community_assets failed: ' + e3.message);
  const assetRefSet = new Set((exAssets || []).map((r) => r.source_ref));

  // 1) PROPERTIES — insert those whose DEMO identity does not yet exist.
  const propsToInsert = plan.properties.filter((pr) => !propByAddr.has(pr.dcid));
  const propRows = propsToInsert.map((pr) => ({
    community_id: DC, street_address: pr.dcid, city: PROP_CITY, state: 'TX',
    property_type: 'sfh', lot_number: pr.lot,
    latitude: pr.centroid ? pr.centroid.lat : null, longitude: pr.centroid ? pr.centroid.lng : null,
  }));
  const insertedProps = await insertChunked('properties', propRows, 'id, street_address');
  insertedProps.forEach((r) => propByAddr.set(r.street_address, r.id));
  console.log(`properties: ${insertedProps.length} created, ${P - insertedProps.length} already present`);

  // 2) PROVENANCE — one appraisal_records row per property; no owner names.
  const apprToInsert = [];
  for (const pr of plan.properties) {
    if (parcelSet.has(pr.pid)) continue;
    const propertyId = propByAddr.get(pr.dcid);
    if (!propertyId) throw new Error('missing property id for ' + pr.dcid);
    apprToInsert.push({
      management_company_id: DEMO_MGMT_CO_ID, community_id: DC, property_id: propertyId,
      county_source: 'FBCAD', parcel_number: pr.pid, pull_date: FBCAD_PULL_DATE,
      raw_extraction: {
        situs: pr.situs, section: pr.sec, block: pr.block, lot: pr.lot, legal: pr.legal,
        acres: pr.lot_sqft ? +(pr.lot_sqft / 43560).toFixed(4) : null,
        year_built: pr.year_built, lot_sqft: pr.lot_sqft,
        source_srid: 'EPSG:2278', geometry_wkt_4326: pr.wkt,
      },
    });
  }
  const insertedAppr = await insertChunked('appraisal_records', apprToInsert, 'id');
  console.log(`provenance: ${insertedAppr.length} appraisal records created, ${P - insertedAppr.length} already present`);

  // 3) ASSETS — canonical community_assets + PostGIS polygon geometry.
  let assetsCreated = 0, geomSet = 0;
  for (const a of plan.assets) {
    if (assetRefSet.has(a.pid)) continue;
    const { data: ins, error: aErr } = await sb.from('community_assets').insert({
      management_company_id: DEMO_MGMT_CO_ID, community_id: DC, name: a.name, description: a.legal,
      asset_class: a.asset_class, asset_type: a.asset_type, status: 'active', condition: 'unknown',
      member_scope: 'not_applicable', source_system: 'fbcad', source_ref: a.pid,
      location_description: `Long Meadow Farms Sec ${a.sec}`,
    }).select('id').single();
    if (aErr) throw new Error('asset insert failed (' + a.name + '): ' + aErr.message);
    assetsCreated++;
    if (a.wkt) {
      const { data: gRes, error: gErr } = await sb.rpc('community_asset_set_geometry', { p_asset_id: ins.id, p_wkt: a.wkt });
      if (gErr) throw new Error('asset geometry RPC failed (' + a.name + '): ' + gErr.message);
      if (gRes && gRes.ok) geomSet++;
    }
  }
  console.log(`assets: ${assetsCreated} created (${geomSet} geometries set), ${A - assetsCreated} already present`);

  // 4) BOUNDARY — TRUE PostGIS dissolve of the 393 parcel polygons (mig 442).
  console.log('\nBOUNDARY (true geometric dissolve of', boundaryWkts.length, 'parcels, ROW excluded):');
  const { data: bRes, error: bErr } = await sb.rpc('community_boundary_dissolve_from_wkts', { p_community_id: DC, p_wkts: boundaryWkts });
  if (bErr) {
    if (bErr.code === 'PGRST202' || /function|does not exist|schema cache/i.test(bErr.message || '')) {
      console.log('  BLOCKED: community_boundary_dissolve_from_wkts not found — migration 442 not applied yet.');
      console.log('  No approximation written. Re-run --execute after applying 442 to compute the boundary (properties/assets are idempotent).');
    } else {
      throw new Error('boundary dissolve RPC failed: ' + bErr.message);
    }
  } else if (bRes && bRes.ok) {
    console.log(`  ${bRes.geometry_type}  ·  ${bRes.num_parts} part(s)  ·  valid=${bRes.is_valid}  ·  written to communities.boundary`);
  } else {
    console.log('  NOT WRITTEN:', JSON.stringify(bRes), '(no approximation — reporting for decision)');
  }

  console.log('\n=== EXECUTE complete ===');
  console.log('Owner names written: 0 (excluded by design).');
  process.exit(0);
}
main().catch((e) => { console.error('Crashed:', e.message); process.exit(1); });
