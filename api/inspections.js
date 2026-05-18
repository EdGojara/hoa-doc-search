// ============================================================================
// Inspections API
// ----------------------------------------------------------------------------
// Endpoints under /api/inspections/* for the inspection capture flow.
// Backs the DRV + memory-layer foundation (migration 050).
//
// V1 scope (this file):
//   POST   /api/inspections                       — start a new inspection session
//   POST   /api/inspections/:id/photos            — upload one photo with metadata
//                                                    (GPS, heading, etc.)
//   PATCH  /api/inspections/:id                   — update status/notes/ended_at
//   GET    /api/inspections/recent                — list recent (by community)
//   GET    /api/inspections/:id                   — detail + photos
//
// V1 deliberately does NOT include:
//   - Polygon-match property linking (needs Harris County parcel data import)
//   - AI vision analysis (next build — populates property_observations)
//   - Reviewer queue actions (next build — confirms photo→property linkage)
//   - Letter generation from observations (after AI + reviewer)
//
// V1 photo flow: photos upload with GPS + heading; if a property polygon
// match is possible (boundary data exists), it's attempted server-side.
// Otherwise polygon_match_property_id stays NULL and gets resolved in the
// reviewer queue.
// ============================================================================

const express = require('express');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Photos can be large from modern phones — 25MB ceiling matches existing
// AI vision pipelines elsewhere in the codebase.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

const router = express.Router();

// ---------------------------------------------------------------------------
// POST /api/inspections — start a new inspection session
// Body: { community_id, mode, route_label?, notes?, operator_id? }
// Returns: the created inspection row
// ---------------------------------------------------------------------------
router.post('/inspections', async (req, res) => {
  try {
    const { community_id, mode, route_label, notes, operator_id } = req.body || {};
    if (!community_id) return res.status(400).json({ error: 'community_id is required' });

    const validModes = ['foot', 'drive_by', 'mounted_camera', 'spot_check'];
    const modeNorm = (mode || 'foot').toString().toLowerCase();
    if (!validModes.includes(modeNorm)) {
      return res.status(400).json({ error: `mode must be one of: ${validModes.join(', ')}` });
    }

    const { data, error } = await supabase
      .from('inspections')
      .insert({
        community_id,
        mode: modeNorm,
        route_label: route_label || null,
        operator_id: operator_id || null,
        notes: notes || null,
        status: 'in_progress',
      })
      .select('*')
      .single();

    if (error) return res.status(500).json({ error: error.message });
    res.json({ inspection: data });
  } catch (err) {
    console.error('[inspections.create]', err);
    res.status(500).json({ error: err.message || 'failed to create inspection' });
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/inspections/:id — update status / notes / ended_at
// Body: { status?, notes?, ended_at? }
// ---------------------------------------------------------------------------
router.patch('/inspections/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { status, notes, ended_at } = req.body || {};
    const validStatuses = ['in_progress', 'captured', 'ai_analyzed', 'reviewed', 'closed', 'voided'];

    const patch = { updated_at: new Date().toISOString() };
    if (status !== undefined) {
      if (!validStatuses.includes(status)) {
        return res.status(400).json({ error: `status must be one of: ${validStatuses.join(', ')}` });
      }
      patch.status = status;
    }
    if (notes !== undefined) patch.notes = notes;
    if (ended_at !== undefined) patch.ended_at = ended_at;

    const { data, error } = await supabase
      .from('inspections')
      .update(patch)
      .eq('id', id)
      .select('*')
      .single();

    if (error) return res.status(500).json({ error: error.message });
    res.json({ inspection: data });
  } catch (err) {
    console.error('[inspections.patch]', err);
    res.status(500).json({ error: err.message || 'failed to update inspection' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/inspections/:id/photos — upload one photo with metadata
// multipart/form-data:
//   photo (file)
//   captured_at (ISO string)
//   gps_lat, gps_lng (numbers, optional)
//   gps_accuracy_m (number, optional)
//   compass_heading_deg (number, optional)
//   notes (string, optional)
// Returns: the created inspection_photos row (with polygon-match attempt
// if boundary data exists for any property in the community).
// ---------------------------------------------------------------------------
router.post('/inspections/:id/photos', upload.single('photo'), async (req, res) => {
  try {
    const { id: inspectionId } = req.params;
    if (!req.file) return res.status(400).json({ error: 'photo file is required' });

    // Verify the inspection exists and is open
    const { data: insp, error: inspErr } = await supabase
      .from('inspections')
      .select('id, community_id, status, total_photos')
      .eq('id', inspectionId)
      .single();
    if (inspErr || !insp) return res.status(404).json({ error: 'inspection not found' });
    if (insp.status === 'closed' || insp.status === 'voided') {
      return res.status(409).json({ error: 'inspection is closed' });
    }

    // Upload the photo to Supabase storage
    const safeName = (req.file.originalname || 'photo.jpg')
      .replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80) || 'photo.jpg';
    const storagePath = `inspections/${inspectionId}/${Date.now()}_${safeName}`;
    const { error: stErr } = await supabase.storage
      .from('documents')
      .upload(storagePath, req.file.buffer, {
        contentType: req.file.mimetype || 'image/jpeg',
        upsert: false,
      });
    if (stErr) return res.status(500).json({ error: `storage: ${stErr.message}` });

    // Parse metadata
    const capturedAt = req.body.captured_at || new Date().toISOString();
    const gpsLat = req.body.gps_lat != null && req.body.gps_lat !== '' ? Number(req.body.gps_lat) : null;
    const gpsLng = req.body.gps_lng != null && req.body.gps_lng !== '' ? Number(req.body.gps_lng) : null;
    const gpsAccuracy = req.body.gps_accuracy_m != null && req.body.gps_accuracy_m !== ''
      ? Number(req.body.gps_accuracy_m) : null;
    const headingDeg = req.body.compass_heading_deg != null && req.body.compass_heading_deg !== ''
      ? Number(req.body.compass_heading_deg) : null;

    // User-selected property from the map tap-to-select flow. If present,
    // treat it as authoritative — operator confirmed the property by tapping
    // it on the map before capture. Skip the polygon-match guessing and
    // pre-fill reviewer_confirmed_property_id at capture time.
    const userSelectedPropertyId = req.body.property_id && String(req.body.property_id).trim() ? String(req.body.property_id).trim() : null;

    // Try polygon match if (a) no map-tap selection, AND (b) both GPS coords
    // are present, AND (c) the community has properties with boundary
    // polygons. Uses PostGIS ST_Contains via the capture_geo POINT. If no
    // polygon match, polygon_match_property_id stays NULL — gets resolved in
    // reviewer queue.
    let polygonMatchPropertyId = null;
    let captureGeoSql = null;
    if (gpsLat != null && gpsLng != null) {
      captureGeoSql = `SRID=4326;POINT(${gpsLng} ${gpsLat})`;
      if (!userSelectedPropertyId) {
        try {
          const { data: matches, error: matchErr } = await supabase.rpc('match_property_by_point', {
            p_community_id: insp.community_id,
            p_lng: gpsLng,
            p_lat: gpsLat,
          });
          // The RPC doesn't exist yet — falls through silently. Once we add
          // the RPC (or run a direct query), this lights up. For now polygon
          // match just stays NULL until reviewer-queue confirmation.
          if (!matchErr && matches && matches.length > 0) {
            polygonMatchPropertyId = matches[0].property_id;
          }
        } catch (_) {
          // RPC missing or boundary data not loaded — fine, leave NULL.
        }
      }
    }

    // Insert the photo row
    const photoRow = {
      inspection_id: inspectionId,
      storage_path: storagePath,
      captured_at: capturedAt,
      gps_lat: gpsLat,
      gps_lng: gpsLng,
      gps_accuracy_m: gpsAccuracy,
      compass_heading_deg: headingDeg,
      polygon_match_property_id: userSelectedPropertyId || polygonMatchPropertyId,
      reviewer_confirmed_property_id: userSelectedPropertyId,
      // If user-selected, also mark the photo as reviewer-confirmed now
      reviewed_at: userSelectedPropertyId ? new Date().toISOString() : null,
      notes: req.body.notes || null,
    };

    // capture_geo is a generated-ish field — set via raw SQL since the JS
    // client doesn't speak PostGIS geometry literals well. We update it
    // after insert if GPS is present.
    const { data: photo, error: phErr } = await supabase
      .from('inspection_photos')
      .insert(photoRow)
      .select('*')
      .single();
    if (phErr) return res.status(500).json({ error: phErr.message });

    // Set capture_geo via raw SQL (PostGIS POINT literal)
    if (captureGeoSql) {
      try {
        await supabase.rpc('set_inspection_photo_geo', {
          p_photo_id: photo.id,
          p_lng: gpsLng,
          p_lat: gpsLat,
        });
      } catch (_) {
        // RPC may not exist yet — capture_geo can be backfilled later.
      }
    }

    // Bump inspection total_photos counter
    await supabase
      .from('inspections')
      .update({ total_photos: (insp.total_photos || 0) + 1, updated_at: new Date().toISOString() })
      .eq('id', inspectionId);

    res.json({ photo });
  } catch (err) {
    console.error('[inspections.upload-photo]', err);
    res.status(500).json({ error: err.message || 'failed to upload photo' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/inspections/recent — list recent inspections (optional ?community_id=&limit=)
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// GET /api/inspections/properties — list properties for a community with the
// fields the map view needs (lat/lng, address, current owner). Used to draw
// property markers + power the tap-to-select-property capture flow.
//
// Query params:
//   community_id (required)
//   include_no_geo=1     include properties without lat/lng (default: exclude)
//
// Properties without lat/lng are excluded by default because they can't be
// rendered on the map. The Inspect tab UI surfaces a count of un-geo'd
// properties separately so we know how much backfill work remains per
// community.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// POST /api/inspections/geocode-community — backfill latitude + longitude on
// every property in a community using Mapbox's Geocoding API. Idempotent by
// default (skips properties that already have lat/lng); pass force=true to
// re-geocode everything.
//
// Body: { community_id, force?: boolean, limit?: number }
//
// Returns: {
//   community_id, total, succeeded, failed, skipped_already_geocoded,
//   errors: [{ property_id, address, error }], duration_ms
// }
//
// Rate-limited at ~6 req/sec to stay well under Mapbox's 600/min free-tier
// ceiling. A 500-property community takes ~80-90 seconds. Communities larger
// than ~600 properties should pass ?limit= and run in batches to avoid
// Render's ~100s HTTP timeout.
//
// Mapbox Geocoding API free tier: 100k requests/month — Bedrock's full
// 3500-property book is one-time ~3500 requests + occasional re-geocodes,
// well within free tier.
// ---------------------------------------------------------------------------
router.post('/inspections/geocode-community', express.json({ limit: '1mb' }), async (req, res) => {
  const token = process.env.MAPBOX_TOKEN;
  if (!token) return res.status(400).json({ error: 'MAPBOX_TOKEN not set in Render environment' });

  const { community_id, force, limit } = req.body || {};
  if (!community_id) return res.status(400).json({ error: 'community_id is required' });

  // Fetch the community (for the city/state fallback if a property's own city is missing)
  const { data: community, error: commErr } = await supabase
    .from('communities')
    .select('id, name, state')
    .eq('id', community_id)
    .single();
  if (commErr || !community) return res.status(404).json({ error: 'community not found' });

  // Fetch properties — exclude already-geocoded unless force=true
  let q = supabase
    .from('properties')
    .select('id, street_address, unit, city, state, zip, latitude, longitude')
    .eq('community_id', community_id);
  if (!force) q = q.or('latitude.is.null,longitude.is.null');
  if (limit && Number(limit) > 0) q = q.limit(Math.min(Number(limit), 1000));
  const { data: properties, error: propErr } = await q;
  if (propErr) return res.status(500).json({ error: propErr.message });

  const results = {
    community_id,
    community_name: community.name,
    total: properties.length,
    succeeded: 0,
    failed: 0,
    skipped_no_address: 0,
    errors: [],
  };
  const startMs = Date.now();

  // Throttle helper — 150ms between Mapbox calls = ~6.6 req/sec
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  for (const p of properties) {
    // Build a single address line. Mapbox handles partial addresses well; the
    // street+state combo is usually enough for Texas residential.
    if (!p.street_address) {
      results.skipped_no_address++;
      continue;
    }
    const addrParts = [
      p.street_address + (p.unit ? ' #' + p.unit : ''),
      p.city || '',
      p.state || community.state || 'TX',
      p.zip || '',
    ].filter((s) => s && s.trim()).join(', ');

    try {
      const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(addrParts)}.json?access_token=${encodeURIComponent(token)}&country=US&limit=1&types=address`;
      const r = await fetch(url);
      if (!r.ok) throw new Error(`mapbox http ${r.status}`);
      const j = await r.json();
      if (!j.features || j.features.length === 0) {
        results.failed++;
        results.errors.push({ property_id: p.id, address: addrParts, error: 'no geocode results' });
      } else {
        const [lng, lat] = j.features[0].center;
        const { error: updateErr } = await supabase
          .from('properties')
          .update({ latitude: lat, longitude: lng, updated_at: new Date().toISOString() })
          .eq('id', p.id);
        if (updateErr) {
          results.failed++;
          results.errors.push({ property_id: p.id, address: addrParts, error: `update: ${updateErr.message}` });
        } else {
          results.succeeded++;
        }
      }
    } catch (e) {
      results.failed++;
      results.errors.push({ property_id: p.id, address: addrParts, error: e.message || 'unknown' });
    }

    await sleep(150);
  }

  results.duration_ms = Date.now() - startMs;
  res.json(results);
});

router.get('/inspections/properties', async (req, res) => {
  try {
    const communityId = req.query.community_id;
    if (!communityId) return res.status(400).json({ error: 'community_id is required' });

    let q = supabase
      .from('v_current_property_owners')
      .select('property_id, street_address, unit, latitude, longitude, owner_name, owner_contact_id')
      .eq('community_id', communityId)
      .order('street_address', { ascending: true });
    if (req.query.include_no_geo !== '1') {
      q = q.not('latitude', 'is', null).not('longitude', 'is', null);
    }
    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });

    // Also surface how many properties in this community are missing geo
    // data, so the UI can show "X properties have no map position yet"
    // without a second query.
    const { count: totalCount } = await supabase
      .from('properties')
      .select('id', { count: 'exact', head: true })
      .eq('community_id', communityId);
    const { count: geoCount } = await supabase
      .from('properties')
      .select('id', { count: 'exact', head: true })
      .eq('community_id', communityId)
      .not('latitude', 'is', null)
      .not('longitude', 'is', null);

    res.json({
      properties: data || [],
      total_count: totalCount || 0,
      geo_count: geoCount || 0,
      missing_geo_count: Math.max(0, (totalCount || 0) - (geoCount || 0)),
    });
  } catch (err) {
    console.error('[inspections.properties]', err);
    res.status(500).json({ error: err.message || 'failed to list properties' });
  }
});

router.get('/inspections/recent', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
    let q = supabase
      .from('inspections')
      .select('id, community_id, mode, route_label, started_at, ended_at, total_photos, total_observations, status, notes, communities(name)')
      .order('started_at', { ascending: false })
      .limit(limit);
    if (req.query.community_id) q = q.eq('community_id', req.query.community_id);
    // Hide voided rows by default — they're audit records, not user-facing
    // entries. Pass ?include_voided=1 to see them.
    if (req.query.include_voided !== '1') q = q.neq('status', 'voided');
    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    res.json({ inspections: data || [] });
  } catch (err) {
    console.error('[inspections.recent]', err);
    res.status(500).json({ error: err.message || 'failed to list inspections' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/inspections/:id — detail with photos
// Photos include a signed URL for viewing in the reviewer queue.
// ---------------------------------------------------------------------------
router.get('/inspections/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { data: insp, error: inspErr } = await supabase
      .from('inspections')
      .select('*, communities(name)')
      .eq('id', id)
      .single();
    if (inspErr || !insp) return res.status(404).json({ error: 'inspection not found' });

    const { data: photos, error: phErr } = await supabase
      .from('inspection_photos')
      .select('*')
      .eq('inspection_id', id)
      .order('captured_at', { ascending: true });
    if (phErr) return res.status(500).json({ error: phErr.message });

    // Generate signed URLs for the storage paths so the frontend can render
    // them in the reviewer queue. 1-hour expiry is plenty for a review session.
    const withUrls = [];
    for (const p of (photos || [])) {
      let signedUrl = null;
      try {
        const { data: signed } = await supabase.storage
          .from('documents')
          .createSignedUrl(p.storage_path, 60 * 60);
        signedUrl = signed?.signedUrl || null;
      } catch (_) { /* leave null */ }
      withUrls.push({ ...p, signed_url: signedUrl });
    }

    res.json({ inspection: insp, photos: withUrls });
  } catch (err) {
    console.error('[inspections.detail]', err);
    res.status(500).json({ error: err.message || 'failed to load inspection' });
  }
});

module.exports = { router };
