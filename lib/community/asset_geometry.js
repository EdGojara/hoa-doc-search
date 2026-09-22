// ============================================================================
// lib/community/asset_geometry.js  (2026-09-21)
// ----------------------------------------------------------------------------
// Reusable WKT builders for real, organic asset footprints. trustEd stores an
// asset's actual physical shape in community_assets.geom GEOGRAPHY(GEOMETRY,4326)
// — ANY subtype — written via the community_asset_set_geometry(uuid, wkt) RPC and
// read back as GeoJSON (+ interior label point) via community_assets_geojson.
// These builders produce believable OPERATIONAL geometries (medians, entry
// landscape, detention, lighting/irrigation runs, tree clusters) rather than
// bounding rectangles. Generic: nothing here is CLMA-specific. A future GIS
// import (GeoJSON/KML/shapefile) would feed the SAME column + RPC, replacing
// these authored shapes with surveyed ones without any downstream change.
//
//   Points are [lng, lat]. All builders return an OGC WKT string.
// ============================================================================
const r6 = (n) => Math.round(n * 1e6) / 1e6;
const fmt = (a) => r6(a[0]) + ' ' + r6(a[1]);

// Tapered esplanade lozenge (rounded/pointed ends) — a median's real footprint.
function medianWKT(cx, cy, hl, hw, t) {
  const p = [[cx - hl, cy], [cx - hl + t, cy + hw * 0.6], [cx - hl + 2 * t, cy + hw], [cx + hl - 2 * t, cy + hw], [cx + hl - t, cy + hw * 0.6], [cx + hl, cy], [cx + hl - t, cy - hw * 0.6], [cx + hl - 2 * t, cy - hw], [cx - hl + 2 * t, cy - hw], [cx - hl + t, cy - hw * 0.6]];
  p.push(p[0]);
  return 'POLYGON((' + p.map(fmt).join(',') + '))';
}
// Irregular blob polygon (n-gon with seeded radius jitter) — entry landscape,
// monument beds, detention: a natural, non-rectangular area.
function blobWKT(cx, cy, rx, ry, n, seed) {
  let s = seed || 1; const rnd = () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };
  const pts = []; for (let i = 0; i < n; i++) { const ang = (i / n) * 2 * Math.PI; const jr = 0.72 + 0.55 * rnd(); pts.push([cx + Math.cos(ang) * rx * jr, cy + Math.sin(ang) * ry * jr]); }
  pts.push(pts[0]);
  return 'POLYGON((' + pts.map(fmt).join(',') + '))';
}
const lineWKT = (pts) => 'LINESTRING(' + pts.map(fmt).join(',') + ')';
const multiLineWKT = (lines) => 'MULTILINESTRING(' + lines.map((l) => '(' + l.map(fmt).join(',') + ')').join(',') + ')';
const multiPointWKT = (pts) => 'MULTIPOINT(' + pts.map(fmt).join(',') + ')';
const pointWKT = (x, y) => 'POINT(' + r6(x) + ' ' + r6(y) + ')';

module.exports = { medianWKT, blobWKT, lineWKT, multiLineWKT, multiPointWKT, pointWKT, r6 };
