#!/usr/bin/env node
/**
 * Enrich properties.latitude/longitude with HCAD parcel centroids.
 *
 * Replaces curb-side address geocoding (Mapbox / Census TIGER) with the
 * geographic center of the parcel polygon from Harris County Appraisal
 * District. Net effect: every dot on the community map lands on the
 * actual rooftop instead of the road in front of it, and the inspector's
 * polygon-match for "what property is this photo of" gets meaningfully
 * more accurate.
 *
 * HCAD API is public + free, no key required. We self-throttle at
 * 1 request/sec out of courtesy — a 543-property community completes
 * in ~10 minutes, a 1000-property community in ~17 minutes.
 *
 * Usage:
 *   node scripts/enrich_parcel_centroids_hcad.js <community_id_or_slug> [--dry-run]
 *
 * Examples:
 *   node scripts/enrich_parcel_centroids_hcad.js lakes-of-pine-forest --dry-run
 *   node scripts/enrich_parcel_centroids_hcad.js eaglewood
 *
 * Only Harris County communities are valid input — see scripts/county_lookup.js
 * for the FBCAD pipeline.
 *
 * Per Ed-not-in-loop principle: this is a CLI script today but should be
 * wired into an admin UI button so staff can re-enrich a community on demand
 * (e.g., after annual HCAD data refresh) without escalating.
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const HCAD_BASE = 'https://www.gis.hctx.net/arcgis/rest/services/HCAD/Parcels/MapServer/0/query';

// Self-throttle. HCAD is a public county service — we won't rate-limit, but
// 1 req/sec keeps us a good citizen.
const RATE_LIMIT_MS = 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Compute polygon centroid as the arithmetic mean of the vertices. Good enough
// for rectangular suburban lots (which is 99% of HOA-managed properties).
// For irregular lots we could use PointOnSurface but the simple centroid is
// well within parcel boundary for normal residential geometry.
function polygonCentroid(coords) {
  // GeoJSON Polygon: coordinates is [[[lng, lat], ...]] — outer ring first
  const ring = coords[0];
  if (!ring || ring.length < 3) return null;
  let sx = 0, sy = 0;
  for (const v of ring) { sx += v[0]; sy += v[1]; }
  return { lat: sy / ring.length, lng: sx / ring.length };
}

// Parse a street address into (number, street_name) for HCAD's split-field
// query. HCAD uses site_str_num + site_str_name + site_str_sfx — we ignore
// the suffix here because LIKE matching tolerates "QUIET LOCH LN" vs "QUIET
// LOCH" cleanly.
function parseAddress(addr) {
  if (!addr) return null;
  const m = String(addr).trim().match(/^(\d+)\s+(.+?)(?:\s+(LN|LANE|DR|DRIVE|CT|COURT|RD|ROAD|WAY|BLVD|BOULEVARD|TRL|TRAIL|PATH|RDG|RIDGE|CIR|CIRCLE|PL|PLACE|PKWY|PARKWAY|AVE|AVENUE|ST|STREET))?$/i);
  if (!m) return null;
  const num = m[1];
  let street = m[2].trim().toUpperCase();
  return { num, street };
}

// Haversine distance in meters — used to report how much each property moved.
function distMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng/2)**2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

async function lookupParcel(parsedAddr) {
  const where = `site_str_num='${parsedAddr.num}' AND site_str_name LIKE '%${parsedAddr.street.replace(/'/g, "''")}%'`;
  const url = HCAD_BASE
    + '?where=' + encodeURIComponent(where)
    + '&outFields=HCAD_NUM,site_str_num,site_str_name'
    + '&returnGeometry=true&f=geojson';
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HCAD HTTP ${r.status}`);
  const j = await r.json();
  if (!j.features || j.features.length === 0) return { found: false };
  // Multiple features can match if the street name LIKE clause is too loose.
  // Take the exact-numeric match.
  const exact = j.features.find((f) => String(f.properties.site_str_num) === String(parsedAddr.num)) || j.features[0];
  if (!exact.geometry || exact.geometry.type !== 'Polygon') return { found: false };
  const c = polygonCentroid(exact.geometry.coordinates);
  if (!c) return { found: false };
  return {
    found: true,
    hcad_num: exact.properties.HCAD_NUM,
    centroid: c,
    matched_features: j.features.length,
  };
}

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error('Usage: node scripts/enrich_parcel_centroids_hcad.js <community_id_or_slug> [--dry-run]');
    process.exit(1);
  }
  const dryRun = process.argv.includes('--dry-run');
  // Optional --limit N for quick sample validation runs before a full enrichment.
  const limitArg = process.argv.find((a) => a.startsWith('--limit='));
  const limit = limitArg ? Number(limitArg.split('=')[1]) : null;

  // Resolve community by slug OR uuid
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(arg);
  let community = null;
  if (isUuid) {
    const { data } = await supabase.from('communities').select('id, name, slug').eq('id', arg).maybeSingle();
    community = data;
  } else {
    const { data } = await supabase.from('communities').select('id, name, slug').eq('slug', arg).maybeSingle();
    community = data;
  }
  if (!community) {
    console.error(`Community not found: ${arg}`);
    process.exit(1);
  }

  console.log(`\nEnriching parcel centroids for: ${community.name} (slug: ${community.slug})`);
  console.log(`Mode: ${dryRun ? 'DRY RUN — no updates' : 'LIVE — properties will be updated'}\n`);

  // Pull every property in the community via the paginated helper pattern.
  // (Just inline it here — Waterview-tier communities are the next test.)
  const properties = [];
  let offset = 0;
  const PAGE = 1000;
  while (true) {
    const { data, error } = await supabase
      .from('properties')
      .select('id, street_address, latitude, longitude')
      .eq('community_id', community.id)
      .range(offset, offset + PAGE - 1);
    if (error) { console.error('Page fetch error:', error.message); break; }
    const page = data || [];
    properties.push(...page);
    if (page.length < PAGE) break;
    offset += PAGE;
    if (properties.length > 50000) break;
  }
  console.log(`Found ${properties.length} properties to process${limit ? ` (limiting to first ${limit})` : ''}.\n`);
  const queue = limit ? properties.slice(0, limit) : properties;

  const stats = {
    processed: 0,
    matched: 0,
    not_found: 0,
    bad_address: 0,
    update_failed: 0,
    distances: [],
  };

  const startTime = Date.now();
  for (let i = 0; i < queue.length; i++) {
    const p = queue[i];
    stats.processed++;

    const parsed = parseAddress(p.street_address);
    if (!parsed) {
      stats.bad_address++;
      console.log(`  [${i+1}/${properties.length}] ✗ couldn't parse: "${p.street_address}"`);
      continue;
    }

    try {
      const result = await lookupParcel(parsed);
      if (!result.found) {
        stats.not_found++;
        console.log(`  [${i+1}/${properties.length}] ⊘ HCAD no match: ${p.street_address}`);
      } else {
        stats.matched++;
        const oldLat = Number(p.latitude);
        const oldLng = Number(p.longitude);
        const newLat = result.centroid.lat;
        const newLng = result.centroid.lng;
        const dist = (Number.isFinite(oldLat) && Number.isFinite(oldLng))
          ? distMeters(oldLat, oldLng, newLat, newLng)
          : null;
        if (dist != null) stats.distances.push(dist);

        const distLabel = dist != null ? `Δ${dist.toFixed(1)}m` : 'first-geo';
        if (!dryRun) {
          const { error: uErr } = await supabase
            .from('properties')
            .update({
              latitude: newLat,
              longitude: newLng,
              updated_at: new Date().toISOString(),
            })
            .eq('id', p.id);
          if (uErr) {
            stats.update_failed++;
            console.log(`  [${i+1}/${properties.length}] ✗ ${p.street_address} (${distLabel}, update err: ${uErr.message})`);
            continue;
          }
        }
        console.log(`  [${i+1}/${properties.length}] ✓ ${p.street_address} (${distLabel}, hcad=${result.hcad_num})`);
      }
    } catch (e) {
      stats.not_found++;
      console.log(`  [${i+1}/${properties.length}] ✗ ${p.street_address} (${e.message})`);
    }

    await sleep(RATE_LIMIT_MS);
  }

  // Summary
  const elapsed = Math.round((Date.now() - startTime) / 1000);
  stats.distances.sort((a, b) => a - b);
  const median = stats.distances.length ? stats.distances[Math.floor(stats.distances.length / 2)] : 0;
  const p90 = stats.distances.length ? stats.distances[Math.floor(stats.distances.length * 0.9)] : 0;
  const max = stats.distances.length ? stats.distances[stats.distances.length - 1] : 0;

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`Community: ${community.name}`);
  console.log(`Processed: ${stats.processed} in ${elapsed}s${dryRun ? ' (dry run)' : ''}`);
  console.log(`  Matched:        ${stats.matched}`);
  console.log(`  HCAD no match:  ${stats.not_found}`);
  console.log(`  Bad address:    ${stats.bad_address}`);
  console.log(`  Update failed:  ${stats.update_failed}`);
  if (stats.distances.length > 0) {
    console.log(`\nGeocode offset (how much each rooftop moved from prior curb point):`);
    console.log(`  Median: ${median.toFixed(1)}m  ·  p90: ${p90.toFixed(1)}m  ·  max: ${max.toFixed(1)}m`);
    const offsets10mPlus = stats.distances.filter((d) => d > 10).length;
    console.log(`  ${offsets10mPlus} properties (${(100 * offsets10mPlus / stats.matched).toFixed(1)}%) moved more than 10m`);
  }
  console.log('═'.repeat(60));
}

main().catch((e) => { console.error('Crashed:', e); process.exit(1); });
