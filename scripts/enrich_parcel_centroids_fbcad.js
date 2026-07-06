#!/usr/bin/env node
/**
 * FBCAD (Fort Bend County Appraisal District) parcel-centroid enrichment.
 *
 * Counterpart to enrich_parcel_centroids_hcad.js. FBCAD doesn't publish a
 * live address-query REST API, so we work from the bulk shapefile they
 * post annually at https://www.fbcad.org/gis-data/.
 *
 * Setup (one-time):
 *   1. Download FBCAD-{year}-Preliminary-or-Certified-GIS-Data-Parcels-and-Shapefiles.zip
 *      from https://www.fbcad.org/gis-data/
 *   2. Unzip to scripts/fbcad-data/, keeping at minimum:
 *        CamaSummary.shp
 *        CamaSummary.dbf
 *        CamaSummary.shx
 *        CamaSummary.prj
 *      (other files in the bundle are ignored)
 *
 * Usage:
 *   node scripts/enrich_parcel_centroids_fbcad.js <community_slug_or_id> [--dry-run] [--limit=N]
 *   node scripts/enrich_parcel_centroids_fbcad.js --all [--dry-run]
 *
 * --all enriches every Fort Bend community in one pass. The shapefile
 * is read ONCE, so processing all 5 FB communities at once is
 * dramatically faster than 5 separate runs.
 *
 * The shapefile is ~120 MB and has ~400,000 features (all parcels in
 * Fort Bend County). We stream it via the `shapefile` npm package and
 * match against a hashmap of target addresses — single pass, low memory.
 *
 * Address matching uses Situs_Stre (street number) + normalized
 * Situs_St_1 (street name). FBCAD stores street names in mixed case so
 * we normalize on both sides.
 *
 * Per Ed-not-in-loop principle: should be wired into the admin UI as a
 * "↻ Re-enrich coordinates" button per community. Today it's a CLI;
 * the staff workflow is "run after FBCAD's annual data refresh."
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const shapefile = require('shapefile');
const proj4 = require('proj4');
const { createClient } = require('@supabase/supabase-js');

// FBCAD ships parcel coordinates in NAD83 / Texas South Central State Plane
// (US Feet) — confirmed from CamaSummary.prj. We reproject to WGS84
// (EPSG:4326) to match properties.latitude/longitude. EPSG:2278 = the
// projected coordinate system identifier. Without this every centroid lands
// about 10 million meters off the planet's surface.
const FBCAD_PROJ = '+proj=lcc +lat_0=27.8333333333333 +lon_0=-99 +lat_1=28.3833333333333 +lat_2=30.2833333333333 +x_0=600000 +y_0=4000000 +datum=NAD83 +units=us-ft +no_defs';
const WGS84_PROJ = '+proj=longlat +datum=WGS84 +no_defs';
proj4.defs('EPSG:2278', FBCAD_PROJ);
proj4.defs('EPSG:4326', WGS84_PROJ);
const reprojectToWgs84 = proj4(FBCAD_PROJ, WGS84_PROJ).forward;

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const FBCAD_DATA_DIR = path.join(__dirname, 'fbcad-data');
const SHP_PATH = path.join(FBCAD_DATA_DIR, 'CamaSummary.shp');
const DBF_PATH = path.join(FBCAD_DATA_DIR, 'CamaSummary.dbf');

// Communities Bedrock manages that are in Fort Bend County. Identified by
// ZIP code prefix. Source: scripts/county_lookup output.
const FB_ZIPS = new Set([
  '77407', '77417', '77423', '77441', '77444', '77450', '77451', '77459',
  '77461', '77464', '77469', '77471', '77476', '77477', '77478', '77479',
  '77481', '77485', '77489', '77494', '77498', '77545', '77583',
]);

// Normalize a street name for matching. Strips suffixes (Ln, Dr, Ct, ...)
// since FBCAD splits them off into Situs_St_2 and we want the core street
// name only. Upper-cases everything. Collapses multiple spaces.
function normStreet(s) {
  if (!s) return '';
  return String(s).toUpperCase()
    .replace(/\s+(LN|LANE|DR|DRIVE|CT|COURT|RD|ROAD|WAY|BLVD|BOULEVARD|TRL|TRAIL|PATH|RDG|RIDGE|CIR|CIRCLE|PL|PLACE|PKWY|PARKWAY|AVE|AVENUE|ST|STREET)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Parse trustEd's properties.street_address into (number, normalized street).
function parseTrustedAddress(addr) {
  if (!addr) return null;
  const m = String(addr).trim().match(/^(\d+)\s+(.+)$/);
  if (!m) return null;
  return { num: String(m[1]), street: normStreet(m[2]) };
}

// Compute polygon centroid as the arithmetic mean of outer ring vertices.
// Good enough for residential lots (>99% rectangular). For irregular shapes
// we could use ST_PointOnSurface but the simple centroid stays inside for
// suburban geometry.
function polygonCentroid(geom) {
  if (!geom) return null;
  const rings = (geom.type === 'Polygon') ? [geom.coordinates[0]]
              : (geom.type === 'MultiPolygon') ? geom.coordinates.map((p) => p[0]).filter(Boolean)
              : null;
  if (!rings || rings.length === 0) return null;
  // Take the largest ring by vertex count (the main parcel for multi-part lots)
  rings.sort((a, b) => b.length - a.length);
  const ring = rings[0];
  if (!ring || ring.length < 3) return null;
  let sx = 0, sy = 0;
  for (const v of ring) { sx += v[0]; sy += v[1]; }
  // Centroid in FBCAD's source coordinate system (Texas State Plane US Feet).
  const planeX = sx / ring.length;
  const planeY = sy / ring.length;
  // Reproject to WGS84 (lng, lat) before returning so it matches
  // properties.latitude / longitude.
  const [lng, lat] = reprojectToWgs84([planeX, planeY]);
  return { lat, lng };
}

// Haversine in meters.
function distMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng/2)**2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

async function loadFbCommunityProperties() {
  const { data: comms } = await supabase.from('communities').select('id, name, slug');
  const fbCommunities = [];
  for (const c of comms || []) {
    // Pull all properties via paginated range to dodge the 1000-row cap
    const props = [];
    let offset = 0;
    while (true) {
      const { data } = await supabase
        .from('properties')
        .select('id, street_address, latitude, longitude, zip')
        .eq('community_id', c.id)
        .range(offset, offset + 999);
      if (!data || data.length === 0) break;
      props.push(...data);
      if (data.length < 1000) break;
      offset += 1000;
    }
    // Skip community if no Fort Bend ZIPs present
    const fbProps = props.filter((p) => FB_ZIPS.has(String(p.zip)));
    if (fbProps.length === 0) continue;
    fbCommunities.push({ ...c, properties: fbProps });
  }
  return fbCommunities;
}

async function main() {
  const arg = process.argv[2];
  const dryRun = process.argv.includes('--dry-run');
  const allFb = process.argv.includes('--all');
  const limitArg = process.argv.find((a) => a.startsWith('--limit='));
  const limit = limitArg ? Number(limitArg.split('=')[1]) : null;

  if (!arg) {
    console.error('Usage: node scripts/enrich_parcel_centroids_fbcad.js <slug_or_id> [--dry-run] [--limit=N]');
    console.error('   or: node scripts/enrich_parcel_centroids_fbcad.js --all [--dry-run]');
    process.exit(1);
  }

  if (!fs.existsSync(SHP_PATH) || !fs.existsSync(DBF_PATH)) {
    console.error(`\nFBCAD shapefile not found in ${FBCAD_DATA_DIR}/`);
    console.error('Download + extract from https://www.fbcad.org/gis-data/');
    console.error('Required files: CamaSummary.shp, CamaSummary.dbf, CamaSummary.shx, CamaSummary.prj');
    process.exit(1);
  }

  // Resolve target communities
  const fbCommunities = await loadFbCommunityProperties();
  let targetComms;
  if (allFb) {
    targetComms = fbCommunities;
  } else {
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(arg);
    targetComms = fbCommunities.filter((c) => isUuid ? c.id === arg : c.slug === arg);
    if (targetComms.length === 0) {
      console.error(`Community "${arg}" not found among Fort Bend communities.`);
      console.error('Available FB communities:', fbCommunities.map((c) => c.slug).join(', '));
      process.exit(1);
    }
  }

  // Build target lookup: "STREETNUM|NORMALIZEDSTREET" → { propId, oldLat, oldLng, commName, addr }
  const targetByKey = new Map();
  for (const c of targetComms) {
    let propsForComm = c.properties;
    if (limit) propsForComm = propsForComm.slice(0, limit);
    for (const p of propsForComm) {
      const parsed = parseTrustedAddress(p.street_address);
      if (!parsed) continue;
      const key = `${parsed.num}|${parsed.street}`;
      targetByKey.set(key, {
        propId: p.id,
        oldLat: Number(p.latitude),
        oldLng: Number(p.longitude),
        commName: c.name,
        addr: p.street_address,
      });
    }
  }
  // Per-community coordinate cluster (median of existing good coords). Used to
  // REJECT a matched parcel that sits nowhere near the community — the
  // recurrence guard. Fort Bend County has multiple streets with the same name;
  // a blind number|street match once wrote 4 Canyon Gate houses to a different
  // "Canyon Chase Drive" 10 miles south (2026-07-05, blocked a field crew). A
  // parcel centroid > MAX_CLUSTER_M from the community's cluster is a
  // wrong-parcel match — skip it, never overwrite with it. Median is robust to
  // the handful of already-bad coords. Communities with < 5 existing coords
  // (first-ever enrichment) have no cluster yet, so the guard no-ops for them.
  const MAX_CLUSTER_M = 5000;
  const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  const commCluster = {};
  for (const c of targetComms) {
    const lats = c.properties.map((p) => Number(p.latitude)).filter(Number.isFinite);
    const lngs = c.properties.map((p) => Number(p.longitude)).filter(Number.isFinite);
    commCluster[c.name] = lats.length >= 5 ? { lat: med(lats), lng: med(lngs) } : null;
  }

  console.log(`\nLoaded ${targetByKey.size} target properties across ${targetComms.length} FB community(ies).`);
  console.log(`Mode: ${dryRun ? 'DRY RUN' : 'LIVE'}`);
  console.log(`Streaming FBCAD shapefile…\n`);

  // Stream the shapefile, match each feature against the target hashmap.
  const matched = [];
  const rejected = []; // wrong-parcel matches caught by the cluster guard
  let featuresRead = 0;
  let lastReport = Date.now();
  const src = await shapefile.open(SHP_PATH, DBF_PATH);
  while (true) {
    const r = await src.read();
    if (r.done) break;
    featuresRead++;
    if (Date.now() - lastReport > 5000) {
      console.log(`  scanned ${featuresRead.toLocaleString()} parcels · ${matched.length} matched so far…`);
      lastReport = Date.now();
    }
    const props = r.value.properties;
    const num = props.Situs_Stre;
    const street1 = props.Situs_St_1;
    const street2 = props.Situs_St_2;
    if (num == null || !street1) continue;
    // FBCAD splits compound street names: "Persimmon Pass" → Situs_St_1="Persimmon",
    // Situs_St_2="PASS". Standard streets put suffix-only in St_2 ("Lane", "Drive",
    // etc.). We try matching against BOTH "<St_1>" and "<St_1> <St_2>" so the
    // compound-name case works without false-positive matching on the suffix.
    // Ed 2026-06-11: this was the gap that left 169 Waterview properties
    // unenriched on the first FBCAD pass.
    const street1Only = normStreet(street1);
    const street1And2 = street2 ? normStreet(`${street1} ${street2}`) : street1Only;
    const target = targetByKey.get(`${num}|${street1And2}`) || targetByKey.get(`${num}|${street1Only}`);
    if (!target) continue;
    const centroid = polygonCentroid(r.value.geometry);
    if (!centroid) continue;
    // Cluster-sanity guard: a centroid far from the community's own cluster is a
    // same-name-different-street mismatch (see MAX_CLUSTER_M note). Reject it.
    const cluster = commCluster[target.commName];
    if (cluster) {
      const d = distMeters(cluster.lat, cluster.lng, centroid.lat, centroid.lng);
      if (d > MAX_CLUSTER_M) { rejected.push({ ...target, newLat: centroid.lat, newLng: centroid.lng, km: d / 1000 }); continue; }
    }
    matched.push({ ...target, newLat: centroid.lat, newLng: centroid.lng });
  }
  console.log(`\nShapefile scan complete: ${featuresRead.toLocaleString()} parcels read · ${matched.length} matched.`);
  if (rejected.length) {
    console.log(`\n⚠ REJECTED ${rejected.length} wrong-parcel match(es) — centroid > ${MAX_CLUSTER_M / 1000}km from the community cluster (same-name-different-street). NOT written:`);
    rejected.slice(0, 25).forEach((m) => console.log(`   ${m.addr} (${m.commName}) — matched parcel ${m.km.toFixed(1)}km away`));
    if (rejected.length > 25) console.log(`   …and ${rejected.length - 25} more`);
  }

  // Update properties in batches
  const distances = [];
  let updateFailed = 0;
  if (!dryRun) {
    for (const m of matched) {
      const { error } = await supabase
        .from('properties')
        .update({
          latitude: m.newLat,
          longitude: m.newLng,
          updated_at: new Date().toISOString(),
        })
        .eq('id', m.propId);
      if (error) updateFailed++;
    }
  }
  for (const m of matched) {
    if (Number.isFinite(m.oldLat) && Number.isFinite(m.oldLng)) {
      distances.push(distMeters(m.oldLat, m.oldLng, m.newLat, m.newLng));
    }
  }

  distances.sort((a, b) => a - b);
  const median = distances.length ? distances[Math.floor(distances.length / 2)] : 0;
  const p90 = distances.length ? distances[Math.floor(distances.length * 0.9)] : 0;
  const max = distances.length ? distances[distances.length - 1] : 0;

  console.log('\n' + '═'.repeat(60));
  console.log(`Target properties:  ${targetByKey.size}`);
  console.log(`Matched in FBCAD:   ${matched.length}  (${(100 * matched.length / targetByKey.size).toFixed(1)}%)`);
  console.log(`Not found in FBCAD: ${targetByKey.size - matched.length}`);
  if (!dryRun) console.log(`Update failed:      ${updateFailed}`);
  if (distances.length > 0) {
    console.log(`\nGeocode offset (curb point → parcel centroid):`);
    console.log(`  Median: ${median.toFixed(1)}m  ·  p90: ${p90.toFixed(1)}m  ·  max: ${max.toFixed(1)}m`);
    const offsets10mPlus = distances.filter((d) => d > 10).length;
    console.log(`  ${offsets10mPlus} properties (${(100 * offsets10mPlus / matched.length).toFixed(1)}%) moved more than 10m`);
  }
  console.log('═'.repeat(60));

  // List the unmatched so staff can investigate (one-by-one for high-value
  // communities like Waterview).
  if (!allFb && matched.length < targetByKey.size) {
    const matchedKeys = new Set(matched.map((m) => `${m.propId}`));
    const unmatched = [...targetByKey.values()].filter((t) => !matched.some((m) => m.propId === t.propId));
    if (unmatched.length > 0 && unmatched.length <= 25) {
      console.log('\nUnmatched (first 25):');
      for (const u of unmatched.slice(0, 25)) {
        console.log(`  ${u.addr}  (community: ${u.commName})`);
      }
    } else if (unmatched.length > 25) {
      console.log(`\n${unmatched.length} unmatched — examples:`);
      for (const u of unmatched.slice(0, 10)) console.log(`  ${u.addr}`);
      console.log(`  …and ${unmatched.length - 10} more`);
    }
  }
}

main().catch((e) => { console.error('Crashed:', e); process.exit(1); });
