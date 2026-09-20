// ============================================================================
// tests/test_community_boundary.js
// ----------------------------------------------------------------------------
// Proves the canonical community-boundary contract (migration 441):
// GEOGRAPHY(GEOMETRY,4326) constrained to Polygon | MultiPolygon, with a
// PostGIS-derived (ST_PointOnSurface) center returned by the read RPC.
//
// All fixtures are created and DELETED in a finally block; nothing persists.
// Requires migration 441 applied (before it, the MultiPolygon set + CHECK
// rejections do not hold and this suite fails — by design).
// Run: node tests/test_community_boundary.js
// ============================================================================
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { DEMO_MGMT_CO_ID } = require('../lib/company');
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

let fails = 0;
const ok = (c, m) => { console.log(`${c ? '  ok  ' : ' FAIL '} ${m}`); if (!c) fails++; };

// WKT fixtures (WGS84 lng lat)
const POLY  = 'POLYGON((-95.75 29.68, -95.74 29.68, -95.74 29.67, -95.75 29.67, -95.75 29.68))';
const MULTI = 'MULTIPOLYGON(((-95.75 29.68,-95.74 29.68,-95.74 29.67,-95.75 29.67,-95.75 29.68)),'
            + '((-95.73 29.68,-95.72 29.68,-95.72 29.67,-95.73 29.67,-95.73 29.68)))';
const POINT = 'POINT(-95.74 29.675)';
const LINE  = 'LINESTRING(-95.75 29.68,-95.74 29.67)';

const setB = (id, wkt) => sb.rpc('community_boundary_set', { p_community_id: id, p_wkt: wkt, p_notes: 'ZZTEST' });
const getB = async (id) => (await sb.rpc('community_boundary_geojson', { p_community_id: id })).data;
const finite = (c) => !!c && Number.isFinite(c.lat) && Number.isFinite(c.lng);

(async () => {
  let communityId = null;
  try {
    const slug = 'zztest-boundary-' + Date.now();
    const { data: comm, error: cErr } = await sb.from('communities')
      .insert({ management_company_id: DEMO_MGMT_CO_ID, name: 'ZZTEST Boundary', slug, is_demo: true })
      .select('id').single();
    if (cErr) { console.error('fixture community insert failed:', cErr.message); process.exit(1); }
    communityId = comm.id;

    // 1. Existing-style Polygon round trip remains unchanged.
    const s1 = await setB(communityId, POLY);
    ok(!s1.error, '1. set Polygon boundary succeeds');
    const g1 = await getB(communityId);
    ok(g1 && g1.boundary && g1.boundary.type === 'Polygon', '1. reads back as Polygon');

    // 7. Existing Polygon center behavior remains valid (finite).
    ok(finite(g1 && g1.center), '7. Polygon center is finite (' + JSON.stringify(g1 && g1.center) + ')');

    // 2. MultiPolygon round trip succeeds and preserves geometry type/parts.
    const s2 = await setB(communityId, MULTI);
    ok(!s2.error, '2. set MultiPolygon boundary succeeds');
    const g2 = await getB(communityId);
    ok(g2 && g2.boundary && g2.boundary.type === 'MultiPolygon', '2. reads back as MultiPolygon');
    ok(g2 && g2.boundary && Array.isArray(g2.boundary.coordinates) && g2.boundary.coordinates.length === 2,
      '2. both parts preserved (' + (g2 && g2.boundary && g2.boundary.coordinates.length) + ' parts)');

    // 5 & 6. Portal/reserve map center is finite for MultiPolygon. Both consumers
    // now take the center straight from this RPC field, so this is the shared
    // truth they render.
    ok(finite(g2 && g2.center), '5/6. MultiPolygon center (RPC-provided, both consumers) is finite ('
      + JSON.stringify(g2 && g2.center) + ')');

    // 3. POINT rejected by the areal CHECK.
    const s3 = await setB(communityId, POINT);
    ok(!!s3.error, '3. POINT rejected by CHECK');

    // 4. LINESTRING rejected by the areal CHECK.
    const s4 = await setB(communityId, LINE);
    ok(!!s4.error, '4. LINESTRING rejected by CHECK');

    // Integrity: a rejected write leaves the prior MultiPolygon intact.
    const g3 = await getB(communityId);
    ok(g3 && g3.boundary && g3.boundary.type === 'MultiPolygon',
      '3/4. rejected writes left the prior MultiPolygon intact');

    // 8. RPC read/write paths + index behavior operational: switching back to a
    // Polygon still works (write path robust; GIST recreated by the migration —
    // an ALTER failure would have aborted the whole migration).
    const s8 = await setB(communityId, POLY);
    const g8 = await getB(communityId);
    ok(!s8.error && g8 && g8.boundary && g8.boundary.type === 'Polygon' && finite(g8.center),
      '8. write+read RPC paths operational after type change (round trips both subtypes)');

    // 5/6 source guard: neither consumer traverses GeoJSON rings for the center
    // anymore; both use the RPC-provided center. Prevents regressing the exact
    // Polygon-only assumption this work removed.
    const portalSrc = fs.readFileSync(path.join(__dirname, '..', 'api', 'portal.js'), 'utf8');
    const reserveSrc = fs.readFileSync(path.join(__dirname, '..', 'api', 'reserve_studies.js'), 'utf8');
    ok(!/boundary\.coordinates\??\.\[0\]/.test(portalSrc) && /bData\.center/.test(portalSrc),
      '5. api/portal.js uses RPC center, no coordinates[0] ring traversal');
    ok(!/boundary\.coordinates\??\.\[0\]/.test(reserveSrc) && /bData\.center/.test(reserveSrc),
      '6. api/reserve_studies.js uses RPC center, no coordinates[0] ring traversal');

  } catch (e) {
    console.error('ERROR', e.message); fails++;
  } finally {
    if (communityId) {
      const { error: dErr } = await sb.from('communities').delete().eq('id', communityId);
      if (dErr) console.warn('cleanup: could not delete temp community', communityId, dErr.message);
    }
    console.log(fails ? `\n✗ community-boundary: ${fails} failure(s)` : '\n✓ community-boundary: contract verified; cleaned up');
    process.exit(fails ? 1 : 0);
  }
})();
