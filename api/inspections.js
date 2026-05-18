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

    // Try polygon match if both GPS coords are present and the community has
    // properties with boundary polygons. Uses PostGIS ST_Contains via the
    // capture_geo POINT. If no polygon match, polygon_match_property_id stays
    // NULL — gets resolved in reviewer queue.
    let polygonMatchPropertyId = null;
    let captureGeoSql = null;
    if (gpsLat != null && gpsLng != null) {
      captureGeoSql = `SRID=4326;POINT(${gpsLng} ${gpsLat})`;
      try {
        // ST_Contains takes (polygon, point) — finds the parcel polygon that
        // contains this GPS point, scoped to the inspection's community.
        const { data: matches, error: matchErr } = await supabase.rpc('match_property_by_point', {
          p_community_id: insp.community_id,
          p_lng: gpsLng,
          p_lat: gpsLat,
        });
        // The RPC doesn't exist yet — falls through silently. Once we add the
        // RPC (or run a direct query), this lights up. For now polygon match
        // just stays NULL until reviewer-queue confirmation.
        if (!matchErr && matches && matches.length > 0) {
          polygonMatchPropertyId = matches[0].property_id;
        }
      } catch (_) {
        // RPC missing or boundary data not loaded — fine, leave NULL.
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
      polygon_match_property_id: polygonMatchPropertyId,
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
router.get('/inspections/recent', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
    let q = supabase
      .from('inspections')
      .select('id, community_id, mode, route_label, started_at, ended_at, total_photos, total_observations, status, notes, communities(name)')
      .order('started_at', { ascending: false })
      .limit(limit);
    if (req.query.community_id) q = q.eq('community_id', req.query.community_id);
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
