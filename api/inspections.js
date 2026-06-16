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
const { categorizePhoto } = require('../lib/enforcement/ai_vision');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Bedrock management company id — matches the seed in 001_foundation.sql and
// the constant used in lib/askEdTools.js, api/contacts.js, etc. Used to scope
// portfolio-wide queries (e.g., the bulk-geocode admin endpoint).
const BEDROCK_MGMT_CO_ID = '00000000-0000-0000-0000-000000000001';

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
    const validStatuses = ['in_progress', 'paused', 'captured', 'ai_analyzed', 'reviewed', 'closed', 'voided'];

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
// POST /api/inspections/:id/pause  — pause the drive (weather, lunch, etc.)
// Body: { reason?, notes?, paused_by? }
// Inserts a row into inspection_pause_segments with paused_at=now and
// flips inspections.status to 'paused'. Partial unique index on the table
// blocks double-pause.
// ---------------------------------------------------------------------------
router.post('/inspections/:id/pause', async (req, res) => {
  try {
    const { id } = req.params;
    const { reason, notes, paused_by } = req.body || {};
    const now = new Date().toISOString();

    // Open the pause segment first — if there's already an open one, this fails
    const { error: segErr } = await supabase
      .from('inspection_pause_segments')
      .insert({ inspection_id: id, paused_at: now, reason: reason || null, paused_by: paused_by || null, notes: notes || null });
    if (segErr) {
      // 23505 = unique violation = already paused
      if (segErr.code === '23505') return res.status(409).json({ error: 'already_paused' });
      throw segErr;
    }

    const { data, error: upErr } = await supabase
      .from('inspections')
      .update({ status: 'paused', updated_at: now })
      .eq('id', id)
      .select('*')
      .single();
    if (upErr) throw upErr;
    res.json({ ok: true, inspection: data, paused_at: now });
  } catch (err) {
    console.error('[inspections.pause]', err.message);
    res.status(500).json({ error: err.message || 'failed to pause' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/inspections/:id/resume — resume a paused drive
// Closes the open pause segment (resumed_at=now) and flips status back to
// 'in_progress'.
// ---------------------------------------------------------------------------
router.post('/inspections/:id/resume', async (req, res) => {
  try {
    const { id } = req.params;
    const now = new Date().toISOString();
    const { data: seg } = await supabase
      .from('inspection_pause_segments')
      .select('id')
      .eq('inspection_id', id)
      .is('resumed_at', null)
      .maybeSingle();
    if (!seg) return res.status(409).json({ error: 'not_paused' });

    await supabase
      .from('inspection_pause_segments')
      .update({ resumed_at: now })
      .eq('id', seg.id);

    const { data, error } = await supabase
      .from('inspections')
      .update({ status: 'in_progress', updated_at: now })
      .eq('id', id)
      .select('*')
      .single();
    if (error) throw error;
    res.json({ ok: true, inspection: data, resumed_at: now });
  } catch (err) {
    console.error('[inspections.resume]', err.message);
    res.status(500).json({ error: err.message || 'failed to resume' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/inspections/:id/time-on-drive — actual active time in seconds.
// Returns { total_seconds, paused_seconds, active_seconds, segments: [...] }
// active_seconds = (ended_at OR now) - started_at - sum(pause durations)
// ---------------------------------------------------------------------------
router.get('/inspections/:id/time-on-drive', async (req, res) => {
  try {
    const { id } = req.params;
    const { data: insp, error } = await supabase
      .from('inspections')
      .select('id, started_at, ended_at, status')
      .eq('id', id)
      .maybeSingle();
    if (error) throw error;
    if (!insp) return res.status(404).json({ error: 'inspection_not_found' });

    const { data: segs } = await supabase
      .from('inspection_pause_segments')
      .select('paused_at, resumed_at, reason')
      .eq('inspection_id', id)
      .order('paused_at', { ascending: true });

    const endRef = insp.ended_at ? new Date(insp.ended_at).getTime() : Date.now();
    const start = new Date(insp.started_at).getTime();
    const totalMs = Math.max(0, endRef - start);
    let pausedMs = 0;
    for (const s of (segs || [])) {
      const ps = new Date(s.paused_at).getTime();
      const pe = s.resumed_at ? new Date(s.resumed_at).getTime() : endRef;
      pausedMs += Math.max(0, pe - ps);
    }
    const activeMs = Math.max(0, totalMs - pausedMs);
    res.json({
      total_seconds: Math.round(totalMs / 1000),
      paused_seconds: Math.round(pausedMs / 1000),
      active_seconds: Math.round(activeMs / 1000),
      segments: segs || [],
      currently_paused: insp.status === 'paused',
    });
  } catch (err) {
    console.error('[inspections.time-on-drive]', err.message);
    res.status(500).json({ error: err.message || 'failed' });
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

    // Photo pairing — wide-shot establishes identity (which house), close-up
    // documents the issue. The pair travels together onto the violation
    // letter as the wrong-house insurance + evidence stack.
    //   'wide'     → identifying shot, no observation/AI categorization fires
    //   'close_up' → issue evidence, observation row + AI fires; links back
    //                to the wide via paired_wide_photo_id
    //   'single'   → backward-compat unpaired shot (existing behavior)
    const reqRole = (req.body.photo_role || '').toLowerCase();
    const photoRole = ['wide', 'close_up', 'single'].includes(reqRole) ? reqRole : 'single';
    const pairedWidePhotoId = req.body.paired_wide_photo_id && String(req.body.paired_wide_photo_id).trim()
      ? String(req.body.paired_wide_photo_id).trim()
      : null;

    // Wide shots can't themselves be paired to another wide.
    if (photoRole === 'wide' && pairedWidePhotoId) {
      return res.status(400).json({ error: 'wide-shot photo_role cannot have a paired_wide_photo_id' });
    }

    // ANOMALY DETECTION (Ed 2026-06-10 — sticky-property scar):
    // If the previous photo in this inspection was taken within 60 seconds
    // and within 20 meters AND had a property, but this new photo has no
    // property, log a warning so future regressions show up in Render logs.
    // This is the smoke-test for the sticky-property bug pattern.
    try {
      const { data: prevPhoto } = await supabase
        .from('inspection_photos')
        .select('id, captured_at, gps_lat, gps_lng, polygon_match_property_id, reviewer_confirmed_property_id')
        .eq('inspection_id', inspectionId)
        .order('captured_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      const incomingProp = userSelectedPropertyId || polygonMatchPropertyId;
      if (prevPhoto && !incomingProp) {
        const prevTs = new Date(prevPhoto.captured_at || 0).getTime();
        const thisTs = new Date(capturedAt || 0).getTime();
        const deltaSec = Math.abs(thisTs - prevTs) / 1000;
        const prevProp = prevPhoto.polygon_match_property_id || prevPhoto.reviewer_confirmed_property_id;
        if (prevProp && deltaSec < 60) {
          let nearGps = false;
          if (gpsLat != null && gpsLng != null && prevPhoto.gps_lat != null && prevPhoto.gps_lng != null) {
            const R = 6371000;
            const φ1 = prevPhoto.gps_lat * Math.PI/180, φ2 = gpsLat * Math.PI/180;
            const Δφ = (gpsLat - prevPhoto.gps_lat) * Math.PI/180;
            const Δλ = (gpsLng - prevPhoto.gps_lng) * Math.PI/180;
            const a = Math.sin(Δφ/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin(Δλ/2)**2;
            const distM = 2 * R * Math.asin(Math.sqrt(a));
            nearGps = distM < 20;
          } else {
            nearGps = true; // no GPS data — count time alone
          }
          if (nearGps) {
            console.warn(`[inspections.anomaly] photo ${prevPhoto.id} had property ${prevProp} ${Math.round(deltaSec)}s ago; new photo has NONE — looks like sticky-property bug regression. inspection=${inspectionId}`);
          }
        }
      }
    } catch (_) { /* anomaly check failure must not block upload */ }

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
      photo_role: photoRole,
      paired_wide_photo_id: pairedWidePhotoId,
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

    // Create the property_observations row if we know the property AND this
    // photo is evidence (close-up or single). Wide shots are identifying-only;
    // they don't get observation rows or AI categorization — they ride along
    // with the close-up's observation via paired_wide_photo_id.
    const resolvedPropertyId = userSelectedPropertyId || polygonMatchPropertyId;
    let observationId = null;
    if (resolvedPropertyId && photoRole !== 'wide') {
      const { data: obsRow, error: obsErr } = await supabase
        .from('property_observations')
        .insert({
          inspection_id:       inspectionId,
          inspection_photo_id: photo.id,
          property_id:         resolvedPropertyId,
          community_id:        insp.community_id,
          reviewer_status:     'pending',
        })
        .select('id')
        .single();
      if (!obsErr && obsRow) observationId = obsRow.id;
    }

    // Respond immediately — operator can keep capturing
    res.json({ photo, observation_id: observationId });

    // ---- Fire async AI categorization ----------------------------------
    // Runs after res.json so the field worker doesn't wait. If it succeeds,
    // observation row is updated with category + severity + description.
    // If it fails (no API key, network, parse error), observation stays
    // pending — full human review path still works.
    if (observationId) {
      setImmediate(async () => {
        try {
          // Load enforcement categories for the prompt
          const { data: cats } = await supabase
            .from('enforcement_categories')
            .select('id, slug, label, description')
            .order('display_order');
          // Build slug -> id lookup for resolving AI's category_slug
          const slugToId = new Map();
          (cats || []).forEach((c) => slugToId.set(c.slug, c.id));

          // Optionally pull property + community name for richer context
          let context = {};
          try {
            const { data: pv } = await supabase
              .from('v_current_property_owners')
              .select('street_address, unit, communities:community_id')
              .eq('property_id', resolvedPropertyId)
              .maybeSingle();
            if (pv) {
              context.property_address = `${pv.street_address || ''}${pv.unit ? ' #' + pv.unit : ''}`;
            }
            const { data: comm } = await supabase
              .from('communities')
              .select('name')
              .eq('id', insp.community_id)
              .maybeSingle();
            if (comm) context.community_name = comm.name;
          } catch (_) {}

          const result = await categorizePhoto({
            image_buffer:     req.file.buffer,
            image_media_type: req.file.mimetype || 'image/jpeg',
            categories:       cats || [],
            context,
          });
          if (!result) {
            console.log(`[ai_vision] observation ${observationId} got null result — staying pending`);
            return;
          }

          // NEW (Ed 2026-06-09): result is { is_clean, findings[] } — one
          // photo can produce MULTIPLE observations (one per finding).
          //
          // Strategy:
          //   - If is_clean: update seed observation to 'rejected' (no violation).
          //   - If 1 finding: update seed observation with finding[0] (no extra rows).
          //   - If N findings: update seed with findings[0], INSERT N-1 more rows.
          //
          // Each finding gets its own auto-draft consideration.
          const findings = result.findings || [];
          if (result.is_clean || findings.length === 0) {
            await supabase.from('property_observations')
              .update({
                severity:        'clean',
                ai_description:  'AI saw no violations in this photo.',
                ai_confidence:   'high',
                reviewer_status: 'rejected',
                reviewed_at:     new Date().toISOString(),
                reviewer_notes:  'AI: no violation visible — auto-filed for documentation only.',
              })
              .eq('id', observationId);
            console.log(`[ai_vision] observation ${observationId} → clean (no findings)`);
            return;
          }

          // Apply findings[0] to the seed observation
          const seedFinding = findings[0];
          const seedUpdate = {
            severity:               seedFinding.severity,
            ai_description:         seedFinding.description,
            ai_recommended_action:  seedFinding.recommended_action,
            ai_confidence:          seedFinding.confidence,
          };
          if (seedFinding.category_slug && slugToId.has(seedFinding.category_slug)) {
            seedUpdate.category_id = slugToId.get(seedFinding.category_slug);
          }
          if (seedFinding.notes || seedFinding.confidence === 'low') {
            seedUpdate.reviewer_notes = seedFinding.notes ||
              'AI low-confidence — recommend human review of the photo before any action.';
          }
          await supabase.from('property_observations').update(seedUpdate).eq('id', observationId);
          console.log(`[ai_vision] photo ${req.params.id} → ${findings.length} finding(s); seed observation ${observationId} categorized as ${seedFinding.category_slug || 'no-match'} / ${seedFinding.severity}`);

          // INSERT additional observations for findings[1..N]
          const extraObservationIds = [];
          for (let i = 1; i < findings.length; i++) {
            const f = findings[i];
            const extra = {
              property_id:        resolvedPropertyId,
              community_id:       insp.community_id,
              inspection_id:      insp.id,
              inspection_photo_id: req.params.id,
              observed_at:        new Date().toISOString(),
              severity:           f.severity,
              ai_description:     f.description,
              ai_recommended_action: f.recommended_action,
              ai_confidence:      f.confidence,
              reviewer_status:    'pending',
              reviewer_notes:     f.notes || null,
            };
            if (f.category_slug && slugToId.has(f.category_slug)) {
              extra.category_id = slugToId.get(f.category_slug);
            }
            try {
              const { data: row, error } = await supabase
                .from('property_observations')
                .insert(extra)
                .select('id')
                .single();
              if (error) throw error;
              extraObservationIds.push(row.id);
              console.log(`[ai_vision] extra observation ${row.id} (finding ${i + 1}/${findings.length}) ${f.category_slug || 'no-match'} / ${f.severity}`);
            } catch (e) {
              console.warn(`[ai_vision] extra observation insert failed (finding ${i}):`, e.message);
            }
          }

          // Auto-draft a letter for EACH high/medium-confidence finding (per
          // Ed: each violation gets its own draft so the operator can pick
          // which to send or merge).
          const findingsForDraft = findings
            .map((f, idx) => ({
              finding: f,
              observationId: idx === 0 ? observationId : extraObservationIds[idx - 1],
            }))
            .filter(x => x.observationId)
            .filter(x => ['medium', 'high'].includes(x.finding.confidence))
            .filter(x => x.finding.severity !== 'clean')
            .filter(x => x.finding.category_slug && slugToId.has(x.finding.category_slug));

          // For each high/medium-confidence finding with a known category,
          // open a violation + draft the letter. Loop over findingsForDraft.
          for (const { finding: result, observationId } of findingsForDraft) {
            try {
              const { decideEscalation } = require('../lib/enforcement/escalation');
              const categoryId = slugToId.get(result.category_slug);

              // Pull priority + prior violations for the engine
              const { data: prio } = await supabase
                .from('community_enforcement_priorities')
                .select('priority_weight')
                .eq('community_id', insp.community_id)
                .eq('category_id', categoryId)
                .is('end_date', null)
                .maybeSingle();
              const priorityWeight = (prio && prio.priority_weight) || 'standard';

              const cutoff = new Date();
              cutoff.setMonth(cutoff.getMonth() - 12);
              const { data: priors } = await supabase
                .from('violations')
                .select('id, opened_at, primary_category_id, current_stage, quality_status, confidence_weight, source')
                .eq('property_id', resolvedPropertyId)
                .eq('primary_category_id', categoryId)
                .gte('opened_at', cutoff.toISOString())
                .neq('quality_status', 'superseded');  // exclude corrected-out rows

              const decision = decideEscalation({
                prior_violations: priors || [],
                priority_weight: priorityWeight,
              });

              if (decision.should_open) {
                const cureEnd = decision.cure_days > 0
                  ? new Date(Date.now() + decision.cure_days * 24 * 60 * 60 * 1000).toISOString()
                  : null;

                // Insert violation row in 'draft' substate via notes — current_stage
                // matches what would be sent. The Drafts queue (Phase 6d) shows the
                // pending-approval letter; ACTUAL mail only happens after Approve.
                const { data: vio, error: vErr } = await supabase
                  .from('violations')
                  .insert({
                    property_id: resolvedPropertyId,
                    community_id: insp.community_id,
                    opened_from_observation_id: observationId,
                    primary_category_id: categoryId,
                    board_priority_at_open: priorityWeight === 'disabled' ? 'standard' : priorityWeight,
                    current_stage: decision.stage,
                    current_stage_started_at: new Date().toISOString(),
                    cure_period_ends_at: cureEnd,
                    opened_at: new Date().toISOString(),
                  })
                  .select('id')
                  .single();
                if (vErr) {
                  console.warn('[auto-draft] violation insert failed:', vErr.message);
                } else {
                  // Mark observation confirmed so it's tied to the violation
                  await supabase.from('property_observations').update({
                    reviewer_status: 'confirmed',
                    reviewed_at: new Date().toISOString(),
                  }).eq('id', observationId);

                  // Generate the letter PDF immediately — sits in storage with the
                  // interaction logged as 'letter_*' but tagged as DRAFT until approved.
                  // We reuse the existing /api/enforcement/generate-letter logic by
                  // calling the underlying library directly (no internal HTTP hop).
                  try {
                    const { renderViolationLetterPdf } = require('../lib/enforcement/violation_letter');
                    // Re-fetch the joined data the letter generator needs
                    const { data: pRow } = await supabase
                      .from('v_current_property_owners')
                      .select('street_address, unit, city, state, zip, lot_number, owner_name, owner_mailing_address')
                      .eq('property_id', resolvedPropertyId)
                      .maybeSingle();
                    const { data: catRow } = await supabase
                      .from('enforcement_categories')
                      .select('slug, label, description')
                      .eq('id', categoryId)
                      .maybeSingle();
                    const { data: commRow } = await supabase
                      .from('communities')
                      .select('name, legal_name, letter_sender_name, letter_sender_title, enforcement_authority_citation, letter_fee_courtesy_1_cents, letter_fee_courtesy_2_cents, letter_fee_certified_209_cents, letter_fee_fine_assessed_cents, letter_cure_days_courtesy_1, letter_cure_days_courtesy_2, letter_cure_days_certified_209')
                      .eq('id', insp.community_id)
                      .maybeSingle();

                    // Phase 7 — pull governing-doc reference + prior-violation history
                    // so the letter cites the actual CC&R section and (on §209)
                    // lists prior notices for this property + category. Manual
                    // override in community_enforcement_priorities wins; falls
                    // back to a semantic-search lookup of the community's CC&Rs.
                    let govDocForAuto = null;
                    try {
                      const { data: prioRow } = await supabase
                        .from('community_enforcement_priorities')
                        .select('governing_doc_reference, governing_doc_section_title, governing_doc_quote, governing_doc_page')
                        .eq('community_id', insp.community_id)
                        .eq('category_id', categoryId)
                        .is('end_date', null)
                        .maybeSingle();
                      if (prioRow && (prioRow.governing_doc_reference || prioRow.governing_doc_section_title || prioRow.governing_doc_quote)) {
                        govDocForAuto = {
                          reference:     prioRow.governing_doc_reference,
                          section_title: prioRow.governing_doc_section_title,
                          quote:         prioRow.governing_doc_quote,
                          page:          prioRow.governing_doc_page,
                        };
                      }
                    } catch (_) {}
                    if (!govDocForAuto) {
                      try {
                        const { lookupGoverningDoc } = require('../lib/enforcement/governing_doc_lookup');
                        const auto = await lookupGoverningDoc({
                          communityId:         insp.community_id,
                          categorySlug:        catRow && catRow.slug,
                          categoryLabel:       catRow && catRow.label,
                          categoryDescription: catRow && catRow.description,
                          aiDescription:       result.description,
                        });
                        if (auto) {
                          govDocForAuto = {
                            reference:      auto.reference,
                            section_title:  auto.section_title,
                            quote:          auto.quote,
                            page:           auto.page,
                            document_title: auto.document_title,
                          };
                        }
                      } catch (_) {}
                    }

                    // priors already pulled above for the engine; reuse
                    const priorsForLetter = (priors || []).filter((pv) => pv.id !== vio.id);

                    const pdfBuffer = await renderViolationLetterPdf({
                      violation: {
                        id: vio.id,
                        current_stage: decision.stage,
                        cure_period_ends_at: cureEnd,
                        opened_at: new Date().toISOString(),
                        category_label: catRow && catRow.label,
                        category_description: result.description,
                        board_priority_at_open: priorityWeight,
                      },
                      property: {
                        street_address: pRow.street_address,
                        unit:           pRow.unit,
                        city:           pRow.city,
                        state:          pRow.state,
                        zip:            pRow.zip,
                        lot_number:     pRow.lot_number,
                      },
                      owner: {
                        full_name:       pRow.owner_name,
                        mailing_address: pRow.owner_mailing_address,
                      },
                      community: {
                        name:       commRow && commRow.name,
                        legal_name: commRow && commRow.legal_name,
                        enforcement_authority_citation: commRow && commRow.enforcement_authority_citation,
                        letter_fee_courtesy_1_cents:    commRow && commRow.letter_fee_courtesy_1_cents,
                        letter_fee_courtesy_2_cents:    commRow && commRow.letter_fee_courtesy_2_cents,
                        letter_fee_certified_209_cents: commRow && commRow.letter_fee_certified_209_cents,
                        letter_fee_fine_assessed_cents: commRow && commRow.letter_fee_fine_assessed_cents,
                        letter_cure_days_courtesy_1:    commRow && commRow.letter_cure_days_courtesy_1,
                        letter_cure_days_courtesy_2:    commRow && commRow.letter_cure_days_courtesy_2,
                        letter_cure_days_certified_209: commRow && commRow.letter_cure_days_certified_209,
                      },
                      observation: {
                        ai_description: result.description,
                        severity: result.severity,
                        captured_at: capturedAt,
                      },
                      governing_doc:    govDocForAuto,
                      prior_violations: priorsForLetter,
                      photo_buffer:     req.file.buffer,
                      options: {
                        sender_name:  (commRow && commRow.letter_sender_name)  || null,
                        sender_title: (commRow && commRow.letter_sender_title) || null,
                      },
                    });

                    // Upload to letters bucket
                    const LETTERS_BUCKET = 'violation-letters';
                    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
                    const letterPath = `${vio.id}/${decision.stage}-${stamp}.pdf`;
                    const { error: upErr } = await supabase.storage
                      .from(LETTERS_BUCKET)
                      .upload(letterPath, pdfBuffer, { contentType: 'application/pdf', upsert: false });
                    if (upErr && !/already exists|duplicate/i.test(upErr.message)) {
                      // Try to create bucket if missing
                      try {
                        await supabase.storage.createBucket(LETTERS_BUCKET, { public: false });
                        await supabase.storage.from(LETTERS_BUCKET).upload(letterPath, pdfBuffer, { contentType: 'application/pdf' });
                      } catch (_) {}
                    }

                    // Log a DRAFT interaction — subject prefix '[DRAFT]' lets the
                    // Drafts queue filter it. When Phase 6d's Approve fires,
                    // it strips the prefix + sets sent_at to send time.
                    const stageToType = {
                      courtesy_1: 'letter_courtesy_1',
                      courtesy_2: 'letter_courtesy_2',
                      certified_209: 'letter_209',
                      fine_assessed: 'letter_209',
                    };
                    await supabase.from('interactions').insert({
                      community_id:    insp.community_id,
                      property_id:     resolvedPropertyId,
                      violation_id:    vio.id,
                      observation_id:  observationId,
                      inspection_id:   inspectionId,
                      type:            stageToType[decision.stage] || 'ai_draft',
                      direction:       'outbound',
                      subject:         `Violation letter (${decision.stage})`,
                      content:         letterPath,
                      delivery_method: (decision.mail_type === 'certified_mail') ? 'certified_mail' : 'first_class_mail',
                      status:          'draft',           // Phase 6d will flip to 'approved' or 'rejected'
                      ai_drafted:      true,
                      ai_model:        'claude-sonnet-4-5',
                      // sent_at left NULL — set when approved
                    });

                    console.log(`[auto-draft] violation ${vio.id} drafted as ${decision.stage} (${decision.mail_type}), ${decision.cure_days}d cure`);
                  } catch (letterErr) {
                    console.warn('[auto-draft] letter PDF generation failed:', letterErr.message);
                  }
                }
              }
            } catch (escErr) {
              console.warn('[auto-draft] escalation engine threw:', escErr.message);
            }
          }
        } catch (e) {
          console.error('[ai_vision] async categorization failed:', e.message);
        }
      });
    }
  } catch (err) {
    console.error('[inspections.upload-photo]', err);
    res.status(500).json({ error: err.message || 'failed to upload photo' });
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/inspections/photos/:id — remove a wrongly-captured photo
// Hard-deletes from inspection_photos + linked property_observations + storage.
// Rejects if the parent inspection has been closed/voided (audit hygiene).
// ---------------------------------------------------------------------------
router.delete('/inspections/photos/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { data: photo, error: phErr } = await supabase
      .from('inspection_photos')
      .select('id, inspection_id, storage_path, paired_wide_photo_id')
      .eq('id', id)
      .single();
    if (phErr || !photo) return res.status(404).json({ error: 'photo not found' });

    const { data: insp, error: inspErr } = await supabase
      .from('inspections')
      .select('id, status, total_photos')
      .eq('id', photo.inspection_id)
      .single();
    if (inspErr || !insp) return res.status(404).json({ error: 'inspection not found' });
    if (insp.status === 'closed' || insp.status === 'voided') {
      return res.status(409).json({ error: 'inspection is closed — cannot delete photos' });
    }

    // Any close-up paired to THIS photo (if this is a wide) needs the pair
    // pointer cleared so the close-up doesn't dangle.
    try {
      await supabase
        .from('inspection_photos')
        .update({ paired_wide_photo_id: null })
        .eq('paired_wide_photo_id', id);
    } catch (_) {}

    // Delete any property_observations rows tied to this photo. If a draft
    // letter has already been generated, the underlying violations row stays
    // (it has its own lifecycle); the observation evidence link drops.
    try {
      await supabase.from('property_observations').delete().eq('inspection_photo_id', id);
    } catch (_) {}

    // Delete the photo row
    const { error: delErr } = await supabase.from('inspection_photos').delete().eq('id', id);
    if (delErr) return res.status(500).json({ error: delErr.message });

    // Delete the storage object (best-effort — don't fail the request if storage
    // delete trips; the row is already gone so the orphan is fine)
    if (photo.storage_path) {
      try { await supabase.storage.from('documents').remove([photo.storage_path]); } catch (_) {}
    }

    // Decrement counter (floor at 0)
    const nextCount = Math.max(0, (insp.total_photos || 0) - 1);
    await supabase
      .from('inspections')
      .update({ total_photos: nextCount, updated_at: new Date().toISOString() })
      .eq('id', photo.inspection_id);

    res.json({ ok: true, deleted_photo_id: id, total_photos: nextCount });
  } catch (err) {
    console.error('[inspections.delete-photo]', err);
    res.status(500).json({ error: err.message || 'failed to delete photo' });
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/inspections/:id — discard an unfinalized inspection completely
// ----------------------------------------------------------------------------
// Hard-deletes the inspection and EVERY child row so it stops polluting
// property tiles (observation counts, inspection counts, draft interactions).
// This is the right behavior for test runs and abandoned walkthroughs.
//
// Refuses if:
//   - inspection.status = 'closed' (finalized = audit-grade, must survive)
//   - any property_observation here has spawned a violations row (audit trail)
//
// Cascade order (RESTRICT FKs from 050 require us to walk it manually):
//   1. delete draft interactions tied to this inspection or its observations
//   2. delete property_observations
//   3. delete inspection_photos + their storage objects
//   4. delete the inspection row (route_traces cascade automatically)
// ---------------------------------------------------------------------------
router.delete('/inspections/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { data: insp, error: inspErr } = await supabase
      .from('inspections')
      .select('id, status, community_id')
      .eq('id', id)
      .single();
    if (inspErr || !insp) return res.status(404).json({ error: 'inspection not found' });
    if (insp.status === 'closed') {
      return res.status(409).json({ error: 'inspection is finalized (closed) — cannot delete. Use Discard to void instead.' });
    }

    // Audit guard: refuse if any observation here opened a violation
    const { data: obsRows } = await supabase
      .from('property_observations')
      .select('id')
      .eq('inspection_id', id);
    const obsIds = (obsRows || []).map((o) => o.id);
    if (obsIds.length > 0) {
      const { data: openedVios } = await supabase
        .from('violations')
        .select('id')
        .in('opened_from_observation_id', obsIds)
        .limit(1);
      if (openedVios && openedVios.length > 0) {
        return res.status(409).json({
          error: 'This inspection opened one or more violations — cannot delete. Resolve or void the violations first, then retry.',
        });
      }
    }

    // 1) Delete draft AND approved-but-not-printed interactions tied to this
    // inspection or its observations. Without this, an approved letter from
    // a discarded inspection stays stranded in Mail Queue with no
    // underlying inspection / observation / photo to support it (Ed found
    // 2 such orphans during the 2026-05-20 pipeline audit).
    //
    // Truly-mailed interactions (printed_at NOT NULL) are audit-grade and
    // survive — their inspection_id/observation_id gets nulled by
    // ON DELETE SET NULL in step 4.
    try {
      const interactionFilter = `inspection_id.eq.${id}` + (obsIds.length ? `,observation_id.in.(${obsIds.join(',')})` : '');
      // Pull stale interactions so we can also delete their storage PDFs
      const { data: staleInter } = await supabase
        .from('interactions')
        .select('id, content, status, printed_at')
        .or(interactionFilter)
        .in('status', ['draft', 'approved']);
      const stalePdfPaths = (staleInter || [])
        .filter((i) => !i.printed_at && i.content && /\.pdf$/i.test(String(i.content)))
        .map((i) => i.content);
      if (stalePdfPaths.length > 0) {
        try { await supabase.storage.from('violation-letters').remove(stalePdfPaths); } catch (_) {}
      }
      await supabase
        .from('interactions')
        .delete()
        .or(interactionFilter)
        .in('status', ['draft', 'approved'])
        .is('printed_at', null);
    } catch (_) {}

    // 2) Delete property_observations
    if (obsIds.length > 0) {
      const { error: obsDelErr } = await supabase
        .from('property_observations')
        .delete()
        .eq('inspection_id', id);
      if (obsDelErr) return res.status(500).json({ error: `observations: ${obsDelErr.message}` });
    }

    // 3) Delete photos + storage objects
    const { data: photos } = await supabase
      .from('inspection_photos')
      .select('id, storage_path')
      .eq('inspection_id', id);
    const storagePaths = (photos || []).map((p) => p.storage_path).filter(Boolean);
    if (storagePaths.length > 0) {
      try { await supabase.storage.from('documents').remove(storagePaths); } catch (_) {}
    }
    if (photos && photos.length > 0) {
      const { error: phDelErr } = await supabase
        .from('inspection_photos')
        .delete()
        .eq('inspection_id', id);
      if (phDelErr) return res.status(500).json({ error: `photos: ${phDelErr.message}` });
    }

    // 4) Delete the inspection row (route_traces cascade)
    const { error: delErr } = await supabase.from('inspections').delete().eq('id', id);
    if (delErr) return res.status(500).json({ error: delErr.message });

    res.json({
      ok: true,
      deleted_inspection_id: id,
      deleted_observations: obsIds.length,
      deleted_photos: (photos || []).length,
    });
  } catch (err) {
    console.error('[inspections.delete]', err);
    res.status(500).json({ error: err.message || 'failed to delete inspection' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/inspections/:id/admin-force-delete
// Admin-only escape hatch that bypasses the two refusal gates on the regular
// DELETE handler (finalized-status + opened-violations). Same cascade
// pipeline — observations, photos, storage, draft/approved interactions —
// but ALSO voids any open violations the inspection opened and lets
// finalized inspections through.
//
// Body must include { confirm: 'DELETE' } so a fat-finger can't trigger it.
//
// Access scope (CLAUDE.md): the requireAdmin middleware reads the bearer
// JWT, fetches user_profiles.role, returns 403 unless role='admin'. Hiding
// the button on the frontend alone is not security — staff can hit the
// endpoint URL directly otherwise.
//
// Audit: printed interactions (printed_at IS NOT NULL) are NEVER deleted —
// once a letter is in the mail, the audit record survives the inspection
// deletion. Their inspection_id / observation_id get nulled via ON DELETE
// SET NULL on those columns.
// ---------------------------------------------------------------------------
router.post('/inspections/:id/admin-force-delete', express.json(), async (req, res) => {
  try {
    // Lazy require so test envs without users module can still load this file
    const { requireAdmin } = require('./users');
    const ctx = await requireAdmin(req, res);
    if (!ctx) return; // requireAdmin already wrote 403

    const { id } = req.params;
    const confirm = (req.body && req.body.confirm) || '';
    if (confirm !== 'DELETE') {
      return res.status(400).json({ error: 'must POST { "confirm": "DELETE" } to force-delete' });
    }

    const { data: insp, error: inspErr } = await supabase
      .from('inspections')
      .select('id, status, community_id, mode, started_at')
      .eq('id', id)
      .single();
    if (inspErr || !insp) return res.status(404).json({ error: 'inspection not found' });

    // Pull observations early so we can void + delete by id
    const { data: obsRows } = await supabase
      .from('property_observations')
      .select('id')
      .eq('inspection_id', id);
    const obsIds = (obsRows || []).map((o) => o.id);

    // 1) VOID any violations opened from this inspection's observations.
    // We don't hard-delete violations — they're audit data — but voiding
    // them removes them from active enforcement and clears the regular-
    // DELETE refusal gate's reason for existing.
    let voidedViolationIds = [];
    if (obsIds.length > 0) {
      const { data: openedVios } = await supabase
        .from('violations')
        .select('id, current_stage')
        .in('opened_from_observation_id', obsIds);
      const idsToVoid = (openedVios || [])
        .filter((v) => !['cured', 'closed', 'voided'].includes(v.current_stage))
        .map((v) => v.id);
      if (idsToVoid.length > 0) {
        const { error: voidErr } = await supabase
          .from('violations')
          .update({
            current_stage: 'voided',
            resolved_at:   new Date().toISOString(),
            resolved_via:  'voided',
            resolved_notes: `Voided by admin force-delete of inspection ${id} (operator: ${ctx.user?.email || 'unknown'})`,
          })
          .in('id', idsToVoid);
        if (voidErr) {
          console.error('[admin-force-delete] violation void failed:', voidErr.message);
          return res.status(500).json({ error: 'violations: ' + voidErr.message });
        }
        voidedViolationIds = idsToVoid;
      }
    }

    // 2) Delete draft + approved (not yet printed) interactions for this
    //    inspection. Same pattern as the regular DELETE handler. Printed
    //    interactions survive — they're audit-grade.
    let stalePdfPaths = [];
    let staleInterCount = 0;
    try {
      const interactionFilter = `inspection_id.eq.${id}` + (obsIds.length ? `,observation_id.in.(${obsIds.join(',')})` : '');
      const { data: staleInter } = await supabase
        .from('interactions')
        .select('id, content, status, printed_at')
        .or(interactionFilter)
        .in('status', ['draft', 'approved'])
        .is('printed_at', null);
      staleInterCount = (staleInter || []).length;
      stalePdfPaths = (staleInter || [])
        .filter((i) => i.content && /\.pdf$/i.test(String(i.content)))
        .map((i) => i.content);
      if (stalePdfPaths.length > 0) {
        try { await supabase.storage.from('violation-letters').remove(stalePdfPaths); } catch (_) {}
      }
      await supabase
        .from('interactions')
        .delete()
        .or(interactionFilter)
        .in('status', ['draft', 'approved'])
        .is('printed_at', null);
    } catch (_) { /* swallow — best-effort cleanup */ }

    // 3) Delete observations
    if (obsIds.length > 0) {
      const { error: obsDelErr } = await supabase
        .from('property_observations')
        .delete()
        .eq('inspection_id', id);
      if (obsDelErr) return res.status(500).json({ error: 'observations: ' + obsDelErr.message });
    }

    // 4) Delete photos + storage objects
    const { data: photos } = await supabase
      .from('inspection_photos')
      .select('id, storage_path')
      .eq('inspection_id', id);
    const storagePaths = (photos || []).map((p) => p.storage_path).filter(Boolean);
    if (storagePaths.length > 0) {
      try { await supabase.storage.from('documents').remove(storagePaths); } catch (_) {}
    }
    if (photos && photos.length > 0) {
      const { error: phDelErr } = await supabase
        .from('inspection_photos')
        .delete()
        .eq('inspection_id', id);
      if (phDelErr) return res.status(500).json({ error: 'photos: ' + phDelErr.message });
    }

    // 5) Delete the inspection row
    const { error: delErr } = await supabase.from('inspections').delete().eq('id', id);
    if (delErr) return res.status(500).json({ error: delErr.message });

    console.log('[admin-force-delete] inspection', id,
      'by', ctx.user?.email || ctx.user?.id || 'unknown',
      '· voided', voidedViolationIds.length, 'violations',
      '· deleted', obsIds.length, 'obs,', (photos || []).length, 'photos,',
      staleInterCount, 'draft/approved interactions');

    res.json({
      ok: true,
      deleted_inspection_id: id,
      prior_status: insp.status,
      voided_violations: voidedViolationIds.length,
      voided_violation_ids: voidedViolationIds,
      deleted_observations: obsIds.length,
      deleted_photos: (photos || []).length,
      deleted_pending_letters: staleInterCount,
      acted_by: ctx.user?.email || null,
    });
  } catch (err) {
    console.error('[admin-force-delete]', err);
    res.status(500).json({ error: err.message || 'force-delete failed' });
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
// ---------------------------------------------------------------------------
// GET /api/inspections/geocode-debug?address=<full address line>
// ---------------------------------------------------------------------------
// Diagnostic endpoint — bypasses the bulk loop, runs ONE address through
// both Mapbox and Census and returns the raw responses. Surfaces what the
// vendors actually return so we can stop guessing at "no match" failures.
//
// Usage from browser console (already inside the staff gate):
//   fetch('/api/inspections/geocode-debug?address=20010+Cape+Clover+Trail,+Richmond,+TX,+77407')
//     .then(r => r.json()).then(j => console.log(j))
// ---------------------------------------------------------------------------
router.get('/inspections/geocode-debug', async (req, res) => {
  const address = (req.query.address || '').toString().trim();
  if (!address) return res.status(400).json({ error: 'address query param required' });

  const out = {
    address,
    mapbox: { tried: false, status: null, error: null, raw: null, count: 0 },
    mapbox_no_filter: { tried: false, status: null, error: null, raw: null, count: 0 },
    census: { tried: false, status: null, error: null, raw: null, count: 0 },
  };

  // --- Mapbox WITH the original types=address filter (what bulk geocoder uses) ---
  const token = process.env.MAPBOX_TOKEN;
  if (!token) {
    out.mapbox.error = 'MAPBOX_TOKEN not set in Render environment';
    out.mapbox_no_filter.error = 'MAPBOX_TOKEN not set in Render environment';
  } else {
    out.mapbox.tried = true;
    try {
      const u = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(address)}.json?access_token=${encodeURIComponent(token)}&country=US&limit=5&types=address`;
      const r = await fetch(u);
      out.mapbox.status = r.status;
      const j = await r.json();
      out.mapbox.raw = j;
      out.mapbox.count = Array.isArray(j.features) ? j.features.length : 0;
    } catch (e) {
      out.mapbox.error = e.message || 'unknown';
    }

    // --- Mapbox WITHOUT the types=address filter (broader match) ---
    out.mapbox_no_filter.tried = true;
    try {
      const u = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(address)}.json?access_token=${encodeURIComponent(token)}&country=US&limit=5`;
      const r = await fetch(u);
      out.mapbox_no_filter.status = r.status;
      const j = await r.json();
      out.mapbox_no_filter.raw = j;
      out.mapbox_no_filter.count = Array.isArray(j.features) ? j.features.length : 0;
    } catch (e) {
      out.mapbox_no_filter.error = e.message || 'unknown';
    }
  }

  // --- Census Bureau geocoder ---
  out.census.tried = true;
  try {
    const u = `https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?address=${encodeURIComponent(address)}&benchmark=Public_AR_Current&format=json`;
    const r = await fetch(u);
    out.census.status = r.status;
    const j = await r.json();
    out.census.raw = j;
    out.census.count = (j && j.result && Array.isArray(j.result.addressMatches)) ? j.result.addressMatches.length : 0;
  } catch (e) {
    out.census.error = e.message || 'unknown';
  }

  res.json(out);
});

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

  // Track which fallback chain step found each property — useful for ops
  // visibility into "how dependent are we on Census today vs. Mapbox?"
  results.by_source = { mapbox: 0, census: 0 };

  for (const p of properties) {
    // Build a single address line. Census handles unindexed-by-Mapbox newer
    // subdivisions well because TIGER/Line data refreshes from county
    // appraisal districts directly. Mapbox is faster + more permissive
    // on partial addresses but has thinner coverage of new builds.
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

    let lat = null;
    let lng = null;
    let lastError = null;
    let usedSource = null;

    // ----- 1) Mapbox (primary — fast, generous free tier) -----
    try {
      const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(addrParts)}.json?access_token=${encodeURIComponent(token)}&country=US&limit=1&types=address`;
      const r = await fetch(url);
      if (!r.ok) throw new Error(`mapbox http ${r.status}`);
      const j = await r.json();
      if (j.features && j.features.length > 0) {
        const center = j.features[0].center;
        if (Array.isArray(center) && center.length === 2) {
          lng = center[0]; lat = center[1];
          usedSource = 'mapbox';
        }
      } else {
        lastError = 'mapbox: no match';
      }
    } catch (e) {
      lastError = `mapbox: ${e.message || 'unknown'}`;
    }

    // ----- 2) US Census Bureau (fallback — TIGER/Line data) -----
    // Coverage of newer subdivisions in Texas (Waterview, Still Creek, parts
    // of Eaglewood) is better than Mapbox because TIGER refreshes from FBCAD
    // / HCAD / county appraisal districts directly. Slower (~600ms typical)
    // and US-only, but free + no API key.
    if (lat == null) {
      try {
        const censusUrl = `https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?address=${encodeURIComponent(addrParts)}&benchmark=Public_AR_Current&format=json`;
        const r = await fetch(censusUrl);
        if (!r.ok) throw new Error(`census http ${r.status}`);
        const j = await r.json();
        const matches = j && j.result && j.result.addressMatches;
        if (Array.isArray(matches) && matches.length > 0) {
          // Census uses x = lng, y = lat (WGS84). Same as everywhere else.
          const coords = matches[0].coordinates;
          if (coords && coords.x != null && coords.y != null) {
            lng = Number(coords.x); lat = Number(coords.y);
            usedSource = 'census';
          }
        } else if (!lastError) {
          lastError = 'census: no match';
        }
      } catch (e) {
        // Don't overwrite the Mapbox error if Mapbox was the real problem;
        // append so the operator sees both failures.
        lastError = lastError ? `${lastError}; census: ${e.message || 'unknown'}` : `census: ${e.message || 'unknown'}`;
      }
    }

    // ----- 3) Persist or log failure -----
    if (lat != null && lng != null) {
      const { error: updateErr } = await supabase
        .from('properties')
        .update({ latitude: lat, longitude: lng, updated_at: new Date().toISOString() })
        .eq('id', p.id);
      if (updateErr) {
        results.failed++;
        results.errors.push({ property_id: p.id, address: addrParts, error: `update: ${updateErr.message}`, source: usedSource });
      } else {
        results.succeeded++;
        if (usedSource && results.by_source[usedSource] != null) results.by_source[usedSource]++;
      }
    } else {
      results.failed++;
      results.errors.push({ property_id: p.id, address: addrParts, error: lastError || 'no result from any geocoder' });
    }

    // 150ms between Mapbox calls keeps us under their 600/min ceiling. Census
    // has no documented rate limit but the same throttle is courteous + keeps
    // the batch wall-clock predictable.
    await sleep(150);
  }

  results.duration_ms = Date.now() - startMs;
  res.json(results);
});

// ---------------------------------------------------------------------------
// GET /api/inspections/geocode-status — per-community geocode coverage
// ---------------------------------------------------------------------------
// Powers the "Geocode all ungeocoded communities" admin button. Returns one
// row per active community with total_properties, geocoded, missing_geo. Lets
// the frontend show a confirmation listing exactly what will run and skip
// communities that are already done.
//
// Uses two grouped queries instead of a join so it stays under Supabase's
// implicit row caps even at full franchise scale (50+ communities × 1000+
// properties each).
// ---------------------------------------------------------------------------
router.get('/inspections/geocode-status', async (req, res) => {
  try {
    const { data: communities, error: cErr } = await supabase
      .from('communities')
      .select('id, name')
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .eq('active', true)
      .order('name');
    if (cErr) return res.status(500).json({ error: cErr.message });

    const ids = (communities || []).map((c) => c.id);
    if (ids.length === 0) return res.json({ communities: [] });

    // Pull just the geo flags we need — id + latitude — for every property
    // in scope. With a portfolio of 3500 properties this is ~3500 rows of
    // (uuid, numeric) which is well under any payload concern.
    const { data: props, error: pErr } = await supabase
      .from('properties')
      .select('community_id, latitude')
      .in('community_id', ids);
    if (pErr) return res.status(500).json({ error: pErr.message });

    const byCommunity = new Map(ids.map((id) => [id, { total: 0, geocoded: 0 }]));
    for (const p of (props || [])) {
      const bucket = byCommunity.get(p.community_id);
      if (!bucket) continue;
      bucket.total += 1;
      if (p.latitude !== null && p.latitude !== undefined) bucket.geocoded += 1;
    }

    const rows = communities.map((c) => {
      const b = byCommunity.get(c.id) || { total: 0, geocoded: 0 };
      return {
        community_id: c.id,
        community_name: c.name,
        total_properties: b.total,
        geocoded: b.geocoded,
        missing_geo: b.total - b.geocoded,
      };
    });
    res.json({ communities: rows });
  } catch (err) {
    console.error('[inspections/geocode-status]', err);
    res.status(500).json({ error: err.message || 'failed to compute geocode status' });
  }
});

router.get('/inspections/properties', async (req, res) => {
  try {
    const communityId = req.query.community_id;
    if (!communityId) return res.status(400).json({ error: 'community_id is required' });
    // include_history=1 attaches per-property aggregates (violations open/ytd/lifetime
    // + last_inspected_at) — slightly heavier query, used by the List view.
    // Map view skips it for speed.
    const includeHistory = req.query.include_history === '1';

    let q = supabase
      .from('v_current_property_owners')
      .select('property_id, street_address, unit, city, latitude, longitude, owner_name, owner_contact_id')
      .eq('community_id', communityId)
      .order('street_address', { ascending: true });
    if (req.query.include_no_geo !== '1') {
      q = q.not('latitude', 'is', null).not('longitude', 'is', null);
    }
    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });

    let properties = data || [];

    // Per-property history aggregates: violations (open/ytd/lifetime) + last inspected.
    // One query per aggregate, grouped by property_id in JS — cheaper than N+1.
    if (includeHistory && properties.length > 0) {
      const yearStart = `${new Date().getFullYear()}-01-01T00:00:00Z`;

      // NOTE: filter by community_id (NOT .in('property_id', [721 UUIDs])).
      // Scar: a 700+ property .in() list builds a ~30KB URL that exceeds the
      // PostgREST HTTP limit and silently returns 0 rows — every pin shows
      // navy, every history aggregate shows 0. Filtering by community_id is
      // an indexed equality and produces identical results because every
      // violation/observation row carries community_id by schema.
      const [vAllRes, vOpenRes, vYtdRes, insRes] = await Promise.all([
        supabase.from('violations').select('property_id').eq('community_id', communityId),
        // Include current_stage AND category slug so we can compute the
        // WORST open stage AND detect special categories (lawn force-mow)
        // that get distinctive map coloring.
        supabase.from('violations')
          .select('property_id, current_stage, primary_category_id, enforcement_categories!inner(slug)')
          .eq('community_id', communityId)
          .not('current_stage', 'in', '("cured","closed","voided")'),
        supabase.from('violations').select('property_id')
          .eq('community_id', communityId)
          .gte('opened_at', yearStart),
        // Last-inspected = max(inspection.ended_at) across observations that touched the property.
        supabase.from('property_observations').select('property_id, inspections!inner(ended_at)')
          .eq('community_id', communityId)
          .not('inspections.ended_at', 'is', null),
      ]);
      const vAll = vAllRes.data || [];
      const vOpen = vOpenRes.data || [];
      const vYtd = vYtdRes.data || [];
      const obs = insRes.data || [];

      const tally = (rows) => {
        const m = new Map();
        rows.forEach((r) => m.set(r.property_id, (m.get(r.property_id) || 0) + 1));
        return m;
      };
      const allMap  = tally(vAll);
      const openMap = tally(vOpen);
      const ytdMap  = tally(vYtd);
      const lastInsp = new Map();
      obs.forEach((o) => {
        const t = o.inspections && o.inspections.ended_at;
        if (!t) return;
        const cur = lastInsp.get(o.property_id);
        if (!cur || new Date(t) > new Date(cur)) lastInsp.set(o.property_id, t);
      });

      // Worst open stage per property — for map pin coloring during inspection.
      // Higher rank = more severe enforcement progression.
      const STAGE_RANK = {
        courtesy_1: 1, courtesy_2: 2, certified_209: 3,
        fine_assessed: 4, hearing_notice: 5,
        legal_referral: 6, lien_filed: 7,
      };
      // Special-track categories that override the stage-based coloring.
      // 'lawn_force_mow_10day' = Lawn 10-Day Certified Force Mow Notice path;
      // displays purple on the inspect map because it's a parallel enforcement
      // track (governed by CC&R + §202.018) not the standard §209 ramp.
      const SPECIAL_TRACK_SLUGS = new Set(['lawn_force_mow_10day']);

      const worstStageMap = new Map();
      const specialTrackMap = new Map();   // property_id → slug
      for (const v of vOpen) {
        const rank = STAGE_RANK[v.current_stage] || 0;
        const prev = worstStageMap.get(v.property_id);
        if (!prev || rank > prev.rank) {
          worstStageMap.set(v.property_id, { stage: v.current_stage, rank });
        }
        const catSlug = v.enforcement_categories && v.enforcement_categories.slug;
        if (catSlug && SPECIAL_TRACK_SLUGS.has(catSlug)) {
          specialTrackMap.set(v.property_id, catSlug);
        }
      }

      properties = properties.map((p) => ({
        ...p,
        violation_count_open:     openMap.get(p.property_id) || 0,
        violation_count_ytd:      ytdMap.get(p.property_id) || 0,
        violation_count_lifetime: allMap.get(p.property_id) || 0,
        worst_open_stage:         (worstStageMap.get(p.property_id) || {}).stage || null,
        special_track:            specialTrackMap.get(p.property_id) || null,
        last_inspected_at:        lastInsp.get(p.property_id) || null,
      }));
    }

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
      properties,
      total_count: totalCount || 0,
      geo_count: geoCount || 0,
      missing_geo_count: Math.max(0, (totalCount || 0) - (geoCount || 0)),
    });
  } catch (err) {
    console.error('[inspections.properties]', err);
    res.status(500).json({ error: err.message || 'failed to list properties' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/communities/:id/boundary — fetch saved polygon as GeoJSON
// POST /api/communities/:id/boundary — save polygon (body: { coords: [[lng,lat],...], notes? })
//
// Polygon stored as PostGIS GEOGRAPHY(POLYGON, 4326). The client sends a
// simple array of [lng, lat] coordinate pairs (first and last should be the
// same point to close the ring; we close it if needed).
// ---------------------------------------------------------------------------
router.get('/communities/:id/boundary', async (req, res) => {
  try {
    const communityId = req.params.id;
    // ST_AsGeoJSON returns the geometry in GeoJSON text form. Done via rpc-style
    // function call since supabase-js doesn't expose ST_* directly.
    const { data, error } = await supabase.rpc('community_boundary_geojson', { p_community_id: communityId });
    if (error) {
      // RPC not yet defined → fall back to a raw select of the GEOGRAPHY (Supabase
      // will encode it as WKB hex which the client can't easily parse). Return null
      // and we'll surface a hint in the UI.
      return res.json({ boundary: null, drawn_at: null, note: 'RPC community_boundary_geojson missing (migration 053 may not be applied)' });
    }
    res.json({ boundary: data || null });
  } catch (err) {
    console.error('[communities.boundary.get]', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/communities/:id/boundary', express.json({ limit: '1mb' }), async (req, res) => {
  try {
    const communityId = req.params.id;
    let coords = (req.body && req.body.coords) || [];
    const notes = (req.body && req.body.notes) || null;
    if (!Array.isArray(coords) || coords.length < 3) {
      return res.status(400).json({ error: 'coords must be an array of at least 3 [lng,lat] points' });
    }
    // Close the ring if open
    const first = coords[0];
    const last  = coords[coords.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) {
      coords = [...coords, first];
    }
    // Build WKT: POLYGON((lng lat, lng lat, ...))
    const wkt = `POLYGON((${coords.map((c) => `${c[0]} ${c[1]}`).join(', ')}))`;
    const { error } = await supabase.rpc('community_boundary_set', {
      p_community_id: communityId,
      p_wkt: wkt,
      p_notes: notes,
    });
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true, point_count: coords.length });
  } catch (err) {
    console.error('[communities.boundary.set]', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/inspections/:id/route-trace
// Batch-insert GPS pings for an active inspection. Body shape:
//   { pings: [{ captured_at, latitude, longitude, accuracy_m?, heading_deg?, speed_mps? }, ...] }
// Client polls every ~5s and POSTs in batches of ~6 pings (30s window). The
// PostGIS point column auto-populates from lat/lng via trigger (migration 052).
// ---------------------------------------------------------------------------
router.post('/inspections/:id/route-trace', express.json({ limit: '2mb' }), async (req, res) => {
  try {
    const inspectionId = req.params.id;
    const pings = (req.body && Array.isArray(req.body.pings)) ? req.body.pings : [];
    if (!inspectionId) return res.status(400).json({ error: 'inspection id required' });
    if (pings.length === 0) return res.json({ inserted: 0 });

    // Validate + normalize
    const rows = [];
    for (const p of pings) {
      if (typeof p.latitude !== 'number' || typeof p.longitude !== 'number') continue;
      if (!p.captured_at) continue;
      rows.push({
        inspection_id: inspectionId,
        captured_at:   p.captured_at,
        latitude:      p.latitude,
        longitude:     p.longitude,
        accuracy_m:    typeof p.accuracy_m === 'number' ? p.accuracy_m : null,
        heading_deg:   typeof p.heading_deg === 'number' ? p.heading_deg : null,
        speed_mps:     typeof p.speed_mps === 'number' ? p.speed_mps : null,
      });
    }
    if (rows.length === 0) return res.json({ inserted: 0 });

    const { error } = await supabase.from('inspection_route_traces').insert(rows);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ inserted: rows.length });
  } catch (err) {
    console.error('[inspections.route-trace]', err);
    res.status(500).json({ error: err.message || 'failed to save route trace' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/inspections/:id/route-trace
// Returns the full polyline + coverage stats for an inspection.
// ---------------------------------------------------------------------------
router.get('/inspections/:id/route-trace', async (req, res) => {
  try {
    const inspectionId = req.params.id;
    const { data: pings, error } = await supabase
      .from('inspection_route_traces')
      .select('captured_at, latitude, longitude, heading_deg, accuracy_m')
      .eq('inspection_id', inspectionId)
      .order('captured_at', { ascending: true });
    if (error) return res.status(500).json({ error: error.message });
    res.json({
      pings: pings || [],
      total_pings: (pings || []).length,
    });
  } catch (err) {
    console.error('[inspections.route-trace.get]', err);
    res.status(500).json({ error: err.message || 'failed to load route trace' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/inspections/:id/coverage
// Computes which community properties were/weren't within `radius_m` of any
// route trace ping during this inspection. Defaults to 50m (about 165ft —
// generous enough to catch tap-from-the-curb captures).
// ---------------------------------------------------------------------------
router.get('/inspections/:id/coverage', async (req, res) => {
  try {
    const inspectionId = req.params.id;
    const radiusM = Number(req.query.radius_m) || 50;

    // Get the inspection's community_id
    const { data: inspection, error: insErr } = await supabase
      .from('inspections')
      .select('id, community_id, started_at, ended_at')
      .eq('id', inspectionId)
      .maybeSingle();
    if (insErr || !inspection) return res.status(404).json({ error: 'inspection not found' });

    // Get every property in the community with lat/lng
    const { data: properties, error: pErr } = await supabase
      .from('properties')
      .select('id, street_address, unit, latitude, longitude')
      .eq('community_id', inspection.community_id)
      .not('latitude', 'is', null)
      .not('longitude', 'is', null);
    if (pErr) return res.status(500).json({ error: pErr.message });

    const { data: pings, error: tErr } = await supabase
      .from('inspection_route_traces')
      .select('latitude, longitude')
      .eq('inspection_id', inspectionId);
    if (tErr) return res.status(500).json({ error: tErr.message });

    if (!pings || pings.length === 0) {
      return res.json({
        total_properties: (properties || []).length,
        covered_count: 0,
        uncovered_count: (properties || []).length,
        uncovered_property_ids: (properties || []).map((p) => p.id),
        ping_count: 0,
        radius_m: radiusM,
      });
    }

    // Distance in meters between two lat/lng (haversine, good for short distances)
    const R = 6371000;
    const toRad = (d) => (d * Math.PI) / 180;
    const distM = (lat1, lng1, lat2, lng2) => {
      const dLat = toRad(lat2 - lat1);
      const dLng = toRad(lng2 - lng1);
      const a = Math.sin(dLat / 2) ** 2 +
                Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
                Math.sin(dLng / 2) ** 2;
      return 2 * R * Math.asin(Math.sqrt(a));
    };

    // For each property, find min distance to any ping. Within radius → covered.
    const uncovered = [];
    let coveredCount = 0;
    for (const p of properties || []) {
      let minD = Infinity;
      for (const ping of pings) {
        const d = distM(Number(p.latitude), Number(p.longitude),
                        Number(ping.latitude), Number(ping.longitude));
        if (d < minD) minD = d;
        if (minD <= radiusM) break;
      }
      if (minD <= radiusM) coveredCount++;
      else uncovered.push(p.id);
    }

    res.json({
      total_properties: (properties || []).length,
      covered_count: coveredCount,
      uncovered_count: uncovered.length,
      uncovered_property_ids: uncovered,
      ping_count: pings.length,
      radius_m: radiusM,
    });
  } catch (err) {
    console.error('[inspections.coverage]', err);
    res.status(500).json({ error: err.message || 'failed to compute coverage' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/inspections/property-detail/:property_id
// ---------------------------------------------------------------------------
// Full enforcement + ownership context for a single property — backs the
// property detail panel that opens when staff taps a row in the List view or
// a marker on the Map view. Everything we know "about this house" in one call.
//
// Returns:
//   {
//     property: { id, street_address, unit, city, zip, lat, lng, lot_number, type }
//     owner:    { contact_id, full_name, email, phone, mailing_address }
//     residency:{ residency_type, contact_name, lease_end_date }
//     violations: [{ id, opened_at, category_name, current_stage, ... }]  -- newest first
//     interactions: [{ id, type, subject, sent_at, delivery_method, direction }] -- newest first
//     inspections: [{ id, started_at, ended_at, mode, observation_count }]
//     observations_recent: [{ id, severity, ai_description, reviewer_status, captured_at, photo_url }]
//     counts: { violations_open, violations_ytd, violations_lifetime, inspections_lifetime, photos_lifetime }
//   }
// ---------------------------------------------------------------------------
router.get('/inspections/property-detail/:property_id', async (req, res) => {
  try {
    const propertyId = req.params.property_id;
    if (!propertyId) return res.status(400).json({ error: 'property_id is required' });
    const yearStart = `${new Date().getFullYear()}-01-01T00:00:00Z`;

    // Property + current owner via the view
    const { data: pRow, error: pErr } = await supabase
      .from('v_current_property_owners')
      .select('property_id, community_id, street_address, unit, city, state, zip, lot_number, property_type, latitude, longitude, owner_contact_id, owner_name, owner_email, owner_phone, owner_mailing_address, owned_since')
      .eq('property_id', propertyId)
      .maybeSingle();
    if (pErr) return res.status(500).json({ error: pErr.message });
    if (!pRow) return res.status(404).json({ error: 'property not found' });

    // Current residency
    const { data: residencyRow } = await supabase
      .from('v_current_residents')
      .select('residency_type, resident_name, resident_email, resident_phone, lease_end_date, resident_since')
      .eq('property_id', propertyId)
      .maybeSingle();

    // Run all the history queries in parallel
    const [violationsRes, interactionsRes, inspectionsRes, observationsRes] = await Promise.all([
      // Violations with category embed. NOTE: enforcement_categories has
      // columns (id, slug, label, description, default_priority_weight,
      // display_order) — NOT `code`. Selecting a non-existent column makes
      // PostgREST error → violationsRes.data falls to null → empty array →
      // silent "0 violations" on the detail panel even when the property
      // clearly has violations. (Scar: 6 hours chasing this 2026-05-28.)
      supabase.from('violations')
        .select('id, opened_at, resolved_at, current_stage, current_stage_started_at, cure_period_ends_at, board_priority_at_open, resolved_via, primary_category_id, quality_status, confidence_weight, source, reviewed_at, review_notes, enforcement_categories(id, slug, label)')
        .eq('property_id', propertyId)
        .order('opened_at', { ascending: false }),
      // Interactions — extended 2026-06-16 to include attachments JSONB and
      // follow_up_due_at so the staff timeline can render dropped email
      // files and overdue follow-up indicators.
      supabase.from('interactions')
        .select('id, type, direction, subject, sent_at, delivery_method, violation_id, content, attachments, follow_up_due_at, source, notes')
        .eq('property_id', propertyId)
        .order('sent_at', { ascending: false })
        .limit(50),
      // Inspections that touched this property (via observations)
      supabase.from('property_observations')
        .select('inspection_id, inspections(id, started_at, ended_at, mode, route_label, total_photos, status)')
        .eq('property_id', propertyId)
        .limit(200),
      // Recent observations (last 20)
      supabase.from('property_observations')
        .select('id, severity, ai_description, ai_recommended_action, reviewer_status, created_at, inspection_photo_id, inspection_photos(captured_at, storage_path)')
        .eq('property_id', propertyId)
        .order('created_at', { ascending: false })
        .limit(20),
    ]);

    // Loud-fail any silent error from the violations select rather than
    // defaulting to []. The detail panel rendering "0 violations" when the
    // DB has rows was the symptom of the `code`-vs-`slug` typo above; if
    // any FUTURE query failure causes data:null, we want to see it
    // immediately, not silently mask it. Same applies to inspections /
    // observations / interactions.
    if (violationsRes.error) {
      console.error('[inspections.property-detail] violations select error:', violationsRes.error.message);
      return res.status(500).json({ error: 'violations query failed', detail: violationsRes.error.message });
    }
    const violations = violationsRes.data || [];
    const interactions = interactionsRes.data || [];
    const obsRows = observationsRes.data || [];

    // De-dupe inspections (multiple observations per inspection)
    const inspectionMap = new Map();
    (inspectionsRes.data || []).forEach((row) => {
      const ins = row.inspections;
      if (!ins) return;
      const cur = inspectionMap.get(ins.id);
      if (!cur) inspectionMap.set(ins.id, { ...ins, observation_count: 1 });
      else cur.observation_count++;
    });
    const inspections = [...inspectionMap.values()].sort((a, b) =>
      new Date(b.started_at || 0) - new Date(a.started_at || 0)
    );

    // Counts (computed cheaply from the data we already have)
    const counts = {
      violations_lifetime:  violations.length,
      violations_open:      violations.filter((v) => !['cured','closed','voided'].includes(v.current_stage)).length,
      violations_ytd:       violations.filter((v) => v.opened_at && v.opened_at >= yearStart).length,
      violations_certified_lifetime: violations.filter((v) => v.current_stage === 'certified_209' || (v.resolved_via === 'fine')).length,
      inspections_lifetime: inspections.length,
      interactions_lifetime: interactions.length,
    };

    // Build observations_recent with signed URLs for thumbnails (best effort)
    const observationsRecent = await Promise.all(obsRows.map(async (o) => {
      const photo = o.inspection_photos;
      let signedUrl = null;
      if (photo && photo.storage_path) {
        try {
          const { data } = await supabase.storage
            .from('documents')
            .createSignedUrl(photo.storage_path, 60 * 60);
          signedUrl = data && data.signedUrl;
        } catch {}
      }
      return {
        id: o.id,
        severity: o.severity,
        ai_description: o.ai_description,
        ai_recommended_action: o.ai_recommended_action,
        reviewer_status: o.reviewer_status,
        captured_at: (photo && photo.captured_at) || o.created_at,
        photo_url: signedUrl,
      };
    }));

    res.json({
      property: {
        id:              pRow.property_id,
        community_id:    pRow.community_id,
        street_address:  pRow.street_address,
        unit:            pRow.unit,
        city:            pRow.city,
        state:           pRow.state,
        zip:             pRow.zip,
        lot_number:      pRow.lot_number,
        property_type:   pRow.property_type,
        latitude:        pRow.latitude,
        longitude:       pRow.longitude,
      },
      owner: pRow.owner_contact_id ? {
        contact_id:      pRow.owner_contact_id,
        full_name:       pRow.owner_name,
        email:           pRow.owner_email,
        phone:           pRow.owner_phone,
        mailing_address: pRow.owner_mailing_address,
        owned_since:     pRow.owned_since,
      } : null,
      residency: residencyRow ? {
        residency_type: residencyRow.residency_type,
        resident_name:  residencyRow.resident_name,
        resident_email: residencyRow.resident_email,
        resident_phone: residencyRow.resident_phone,
        lease_end_date: residencyRow.lease_end_date,
        resident_since: residencyRow.resident_since,
      } : null,
      violations: violations.map((v) => ({
        id:                v.id,
        opened_at:         v.opened_at,
        resolved_at:       v.resolved_at,
        resolved_via:      v.resolved_via,
        current_stage:     v.current_stage,
        cure_period_ends_at: v.cure_period_ends_at,
        board_priority_at_open: v.board_priority_at_open,
        // category_code is what the frontend display fallback expects;
        // in this schema the equivalent column is `slug` (no `code` column
        // on enforcement_categories — was a stale typo).
        category_code:     v.enforcement_categories && v.enforcement_categories.slug,
        category_label:    v.enforcement_categories && v.enforcement_categories.label,
        // Quality fields (Phase 7b)
        quality_status:    v.quality_status,
        confidence_weight: v.confidence_weight,
        source:            v.source,
        reviewed_at:       v.reviewed_at,
        review_notes:      v.review_notes,
      })),
      interactions: await Promise.all(interactions.map(async (i) => {
        // Pre-sign any attachment storage paths so the timeline can render
        // clickable links without a second round-trip per file. 1hr matches
        // builder_applications + observation thumbnails.
        const atts = Array.isArray(i.attachments) ? i.attachments : [];
        const signedAtts = await Promise.all(atts.map(async (a) => {
          if (!a || !a.storage_path) return a;
          try {
            const { data: sd } = await supabase.storage
              .from('homeowner-interactions')
              .createSignedUrl(a.storage_path, 60 * 60);
            return { ...a, signed_url: sd?.signedUrl || null };
          } catch (_) {
            return { ...a, signed_url: null };
          }
        }));
        return {
          id:              i.id,
          type:            i.type,
          direction:       i.direction,
          subject:         i.subject,
          sent_at:         i.sent_at,
          delivery_method: i.delivery_method,
          violation_id:    i.violation_id,
          preview:         i.content ? String(i.content).slice(0, 240) : null,
          attachments:     signedAtts,
          follow_up_due_at: i.follow_up_due_at,
          source:          i.source,
          logged_by_note:  i.notes,
        };
      })),
      inspections,
      observations_recent: observationsRecent,
      counts,
    });
  } catch (err) {
    console.error('[inspections.property-detail]', err);
    res.status(500).json({ error: err.message || 'failed to load property detail' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/inspections/:id/observations
// Returns every observation for an inspection with status + AI fields so the
// UI can show per-photo lifecycle ("AI categorizing", "drafted", "no
// violation", "failed"). Backs the per-photo status badge in the capture
// session view.
// ---------------------------------------------------------------------------
router.get('/inspections/:id/observations', async (req, res) => {
  try {
    const inspectionId = req.params.id;
    if (!inspectionId) return res.status(400).json({ error: 'inspection id required' });
    const { data, error } = await supabase
      .from('property_observations')
      .select(`
        id, inspection_photo_id, property_id, severity, ai_description,
        ai_recommended_action, ai_confidence, reviewer_status, reviewer_notes,
        created_at, reviewed_at, category_id,
        enforcement_categories ( label )
      `)
      .eq('inspection_id', inspectionId)
      .order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });

    // Also pull any drafted-letter interactions tied to this inspection so the UI
    // can show "✓ Draft letter created" per photo even before the draft queue
    // surfaces them. Exclude rejected/voided rows — without this the photo
    // tile keeps showing "✓ Draft ready" after a draft is rejected (stale UI).
    const { data: interactions } = await supabase
      .from('interactions')
      .select('id, observation_id, status, type')
      .eq('inspection_id', inspectionId)
      .in('type', ['letter_courtesy_1','letter_courtesy_2','letter_209'])
      .not('status', 'in', '("rejected","voided")');
    const byObs = new Map();
    (interactions || []).forEach((i) => {
      if (!i.observation_id) return;
      const cur = byObs.get(i.observation_id);
      if (!cur || i.status === 'approved' || i.status === 'sent') byObs.set(i.observation_id, i);
    });

    const observations = (data || []).map((o) => ({
      id: o.id,
      photo_id: o.inspection_photo_id,
      property_id: o.property_id,
      severity: o.severity,
      ai_description: o.ai_description,
      ai_confidence: o.ai_confidence,
      reviewer_status: o.reviewer_status,
      reviewer_notes: o.reviewer_notes,
      category_label: o.enforcement_categories && o.enforcement_categories.label,
      created_at: o.created_at,
      letter_status: byObs.get(o.id) ? byObs.get(o.id).status : null,
    }));
    res.json({ observations });
  } catch (err) {
    console.error('[inspections.observations]', err);
    res.status(500).json({ error: err.message });
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
router.get('/inspections/:id', async (req, res, next) => {
  // Reserved-word guard — Express matches routes in registration order, so
  // this dynamic /:id route was catching requests for the static routes
  // defined later (/inspections/active, /inspections/recent, /inspections/
  // offices, etc.) and 404ing on UUID lookup for "active" etc. Skip to
  // the next matching handler when the id is a known static path segment.
  const RESERVED = new Set([
    'active', 'recent', 'offices', 'observations', 'photos',
    'properties', 'geocode-debug', 'geocode-status', 'geocode-community',
  ]);
  if (RESERVED.has(req.params.id)) return next();
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

    // Also pull observations so the photo viewer can show AI verdict per
    // photo (flagged violation vs. AI said clean vs. pending). Bedrock
    // can audit AI misses and operator can Add Violation in-place.
    const { data: observations } = await supabase
      .from('property_observations')
      .select(`
        id, inspection_photo_id, property_id, category_id, severity,
        reviewer_status, ai_confidence, ai_description,
        reviewer_notes
      `)
      .eq('inspection_id', id);
    const obsByPhoto = new Map();
    for (const o of (observations || [])) {
      const pid = o.inspection_photo_id;
      if (!pid) continue;
      // Derive is_violation from severity (since the column might not exist
      // on all observation rows — multi-finding analyze sets severity per
      // finding and 'clean' severity marks no-violation rows).
      o.is_violation = (o.severity && o.severity !== 'clean' && o.reviewer_status !== 'rejected');
      if (!obsByPhoto.has(pid)) obsByPhoto.set(pid, []);
      obsByPhoto.get(pid).push(o);
    }

    // Hydrate property addresses for the photos so the UI can group by
    // house without a second round-trip. Use the canonical address column
    // on properties.
    const propertyIds = Array.from(new Set((photos || [])
      .map(p => p.polygon_match_property_id || p.reviewer_confirmed_property_id)
      .filter(Boolean)));
    const addressByPropId = new Map();
    if (propertyIds.length > 0) {
      for (let i = 0; i < propertyIds.length; i += 500) {
        const batch = propertyIds.slice(i, i + 500);
        const { data: props } = await supabase
          .from('properties')
          .select('id, street_address')
          .in('id', batch);
        for (const pr of (props || [])) addressByPropId.set(pr.id, pr.street_address);
      }
    }

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
      const obs = obsByPhoto.get(p.id) || [];
      // Derive a single ai_verdict.
      // Priority: observations (if any) > photo.ai_findings/ai_is_clean
      //           (set by analyze when no property matched) > 'pending'
      let ai_verdict = 'pending';
      if (obs.some(o => o.is_violation === true)) ai_verdict = 'violation';
      else if (obs.length > 0) ai_verdict = 'clean';
      else if (Array.isArray(p.ai_findings) && p.ai_findings.length > 0) ai_verdict = 'violation';
      else if (p.ai_is_clean === true) ai_verdict = 'clean';
      // ai_analyzed_at without findings OR clean flag means pending; not
      // reachable in practice because analyze always sets one of them.

      // For unmatched photos: synthesize "pseudo-observations" from
      // ai_findings so the review UI can list them with the same shape.
      // These pseudo-obs have NO id (can't be rejected through the
      // observations endpoint until the photo is linked to a property).
      let mergedObservations = obs;
      if (obs.length === 0 && Array.isArray(p.ai_findings) && p.ai_findings.length > 0) {
        mergedObservations = p.ai_findings.map((f, idx) => ({
          id: null,
          pseudo: true,
          pseudo_idx: idx,
          inspection_photo_id: p.id,
          severity: f.severity,
          ai_description: f.description,
          ai_confidence: f.confidence,
          ai_recommended_action: f.recommended_action,
          reviewer_status: 'pending',
          is_violation: f.severity && f.severity !== 'clean',
        }));
      }

      const propId = p.polygon_match_property_id || p.reviewer_confirmed_property_id || null;
      withUrls.push({
        ...p,
        signed_url: signedUrl,
        observations: mergedObservations,
        ai_verdict,
        property_id: propId,
        property_address: propId ? (addressByPropId.get(propId) || null) : null,
        is_unmatched: !propId,
      });
    }

    res.json({ inspection: insp, photos: withUrls });
  } catch (err) {
    console.error('[inspections.detail]', err);
    res.status(500).json({ error: err.message || 'failed to load inspection' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/inspections/:id/analyze — run AI analysis on all photos in this
// inspection that haven't been analyzed yet. Creates property_observation
// rows. Updates inspection.status='ai_analyzed' when done.
//
// Body: { force? } — when true, re-analyzes photos already linked to
//                    an existing observation (deletes + re-creates).
//
// Property matching here is intentionally simple — uses inspection_photos'
// existing polygon_match_property_id if set, otherwise leaves property_id
// NULL on the observation. Operator finishes the match in the reviewer
// queue. The 5-signal verification model (project_drv_module.md) is
// deferred to a later sprint; this gets the chain end-to-end working.
// ---------------------------------------------------------------------------
router.post('/inspections/:id/analyze', express.json(), async (req, res) => {
  try {
    const inspectionId = req.params.id;
    const force = (req.body && req.body.force) !== false;  // default TRUE — re-analyze always replaces

    const { data: insp, error: iErr } = await supabase
      .from('inspections')
      .select('id, community_id, status, communities(id, name)')
      .eq('id', inspectionId)
      .maybeSingle();
    if (iErr || !insp) return res.status(404).json({ error: 'inspection not found' });

    const { data: photos, error: pErr } = await supabase
      .from('inspection_photos')
      .select('id, storage_path, polygon_match_property_id, captured_at')
      .eq('inspection_id', inspectionId);
    if (pErr) return res.status(500).json({ error: pErr.message });
    if (!photos || photos.length === 0) {
      return res.json({ analyzed: 0, observations_created: 0, message: 'no photos in this inspection' });
    }

    const photoIds = photos.map((p) => p.id);
    const { data: existingObs } = await supabase
      .from('property_observations')
      .select('id, inspection_photo_id')
      .in('inspection_photo_id', photoIds);

    // Force mode (default): delete existing observations for these photos so
    // the new findings are the source of truth.
    if (force && existingObs && existingObs.length > 0) {
      await supabase.from('property_observations').delete().in('id', existingObs.map((o) => o.id));
    }
    const skipPhotoIds = !force && existingObs
      ? new Set(existingObs.map((o) => o.inspection_photo_id))
      : new Set();

    const { data: categories } = await supabase
      .from('enforcement_categories')
      .select('id, slug, label, description')
      .order('display_order');
    const slugToId = new Map();
    (categories || []).forEach((c) => slugToId.set(c.slug, c.id));

    let analyzedCount = 0;
    let observationsCreated = 0;
    let photosWithFindings = 0;
    let photosClean = 0;
    let photosUnmatched = 0;
    const failures = [];

    for (const photo of photos) {
      if (skipPhotoIds.has(photo.id)) continue;

      // Download bytes
      let imageBuffer = null;
      try {
        const { data: blob, error: dlErr } = await supabase.storage
          .from('documents')
          .download(photo.storage_path);
        if (dlErr) throw dlErr;
        imageBuffer = Buffer.from(await blob.arrayBuffer());
      } catch (e) {
        failures.push({ photo_id: photo.id, reason: 'download_failed', error: e.message });
        continue;
      }

      const result = await categorizePhoto({
        image_buffer: imageBuffer,
        image_media_type: 'image/jpeg',
        categories: categories || [],
        context: { community_name: insp.communities && insp.communities.name },
      });
      analyzedCount += 1;
      if (!result) {
        failures.push({ photo_id: photo.id, reason: 'ai_returned_null' });
        continue;
      }

      const findings = result.findings || [];
      const isClean = result.is_clean || findings.length === 0;

      // STEP 1 — always store findings ON THE PHOTO itself, regardless of
      // whether a property is matched. Migration 212. This is the audit
      // record. Observations are only created when a property exists.
      try {
        await supabase
          .from('inspection_photos')
          .update({
            ai_findings:    findings,
            ai_is_clean:    isClean,
            ai_analyzed_at: new Date().toISOString(),
          })
          .eq('id', photo.id);
      } catch (e) {
        console.warn('[analyze] photo update failed (non-fatal):', e.message);
      }

      // STEP 2 — observations need a property. Unmatched photos still get
      // their findings recorded on the photo above; the operator can link
      // them later (existing /photos-needing-link flow) and create
      // observations then.
      if (!photo.polygon_match_property_id) {
        photosUnmatched += 1;
        if (findings.length > 0) photosWithFindings += 1;
        else photosClean += 1;
        continue;
      }

      // STEP 3a — Clean photo with property: insert ONE "clean" observation
      if (isClean) {
        const { error } = await supabase.from('property_observations').insert({
          inspection_id:        inspectionId,
          inspection_photo_id:  photo.id,
          property_id:          photo.polygon_match_property_id,
          community_id:         insp.community_id,
          severity:             'clean',
          ai_description:       'AI saw no violations in this photo.',
          ai_confidence:        'high',
          reviewer_status:      'rejected',
          reviewed_at:          new Date().toISOString(),
          reviewer_notes:       'AI: no violation visible — auto-filed for documentation only.',
          observed_at:          photo.captured_at || new Date().toISOString(),
        });
        if (!error) {
          photosClean += 1;
          observationsCreated += 1;
        } else {
          failures.push({ photo_id: photo.id, reason: 'clean_insert_failed', error: error.message });
        }
        continue;
      }

      // STEP 3b — Findings: one observation row per finding
      photosWithFindings += 1;
      for (const f of findings) {
        const insertRow = {
          inspection_id:         inspectionId,
          inspection_photo_id:   photo.id,
          property_id:           photo.polygon_match_property_id,
          community_id:          insp.community_id,
          category_id:           (f.category_slug && slugToId.get(f.category_slug)) || null,
          severity:              f.severity || 'minor',
          ai_description:        f.description || null,
          ai_recommended_action: f.recommended_action || 'courtesy',
          ai_confidence:         f.confidence || 'low',
          reviewer_status:       'pending',
          reviewer_notes:        f.notes || null,
          observed_at:           photo.captured_at || new Date().toISOString(),
        };
        const { error: obsErr } = await supabase.from('property_observations').insert(insertRow);
        if (obsErr) {
          failures.push({ photo_id: photo.id, reason: 'insert_failed', error: obsErr.message });
          continue;
        }
        observationsCreated += 1;
      }
    }

    if (analyzedCount > 0) {
      await supabase
        .from('inspections')
        .update({ status: 'ai_analyzed', updated_at: new Date().toISOString() })
        .eq('id', inspectionId);
    }

    res.json({
      inspection_id: inspectionId,
      analyzed: analyzedCount,
      photos_with_findings: photosWithFindings,
      photos_clean: photosClean,
      photos_unmatched: photosUnmatched,
      observations_created: observationsCreated,
      photos_total: photos.length,
      photos_skipped_already_analyzed: skipPhotoIds.size,
      failures,
      mode: 'multi_violation',
    });
  } catch (err) {
    console.error('[inspections.analyze]', err);
    res.status(500).json({ error: err.message || 'analyze failed' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/inspections/:id/photos-needing-link
// Returns the close-up / single inspection_photos in this inspection that
// have no property linked yet AND no observation row. These are the photos
// the operator needs to manually link to a property before they can be
// turned into observations + drafts.
// ---------------------------------------------------------------------------
router.get('/inspections/:id/photos-needing-link', async (req, res) => {
  try {
    const inspectionId = req.params.id;

    // Pull the inspection's community so the front-end can populate its
    // property dropdown for the rescuer UI.
    const { data: insp } = await supabase
      .from('inspections')
      .select('community_id, communities(name)')
      .eq('id', inspectionId)
      .maybeSingle();
    const communityId = insp && insp.community_id;
    const communityName = insp && insp.communities && insp.communities.name;

    const { data: photos, error: pErr } = await supabase
      .from('inspection_photos')
      .select('id, storage_path, captured_at, gps_lat, gps_lng, compass_heading_deg, ai_detected_house_number, polygon_match_property_id, reviewer_confirmed_property_id, photo_role')
      .eq('inspection_id', inspectionId)
      .in('photo_role', ['close_up', 'single'])
      .order('captured_at', { ascending: true });
    if (pErr) return res.status(500).json({ error: pErr.message });

    if (!photos || photos.length === 0) return res.json({ photos: [], community_id: communityId, community_name: communityName });

    // Filter out photos that ALREADY have a property OR an observation
    const photoIds = photos.map((p) => p.id);
    const { data: existingObs } = await supabase
      .from('property_observations')
      .select('inspection_photo_id')
      .in('inspection_photo_id', photoIds);
    const obsPhotoIds = new Set((existingObs || []).map((o) => o.inspection_photo_id));

    const needsLink = photos.filter((p) =>
      !p.reviewer_confirmed_property_id && !p.polygon_match_property_id && !obsPhotoIds.has(p.id)
    );

    // Sign photo URLs
    const withUrls = await Promise.all(needsLink.map(async (p) => {
      let photo_url = null;
      try {
        const { data: sd } = await supabase.storage
          .from('documents')
          .createSignedUrl(p.storage_path, 60 * 60);
        photo_url = sd && sd.signedUrl;
      } catch (e) { /* no-op */ }
      return { ...p, photo_url };
    }));

    res.json({ photos: withUrls, community_id: communityId, community_name: communityName });
  } catch (err) {
    console.error('[inspections.photos-needing-link]', err);
    res.status(500).json({ error: err.message || 'failed' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/inspections/photos/:id/link-and-analyze
// Body: { property_id }
//
// Operator manually picks a property for an unlinked photo. We:
//   1. Stamp the photo with reviewer_confirmed_property_id
//   2. Run AI vision on the photo (categorize)
//   3. Create the property_observations row tagged pending review
//   4. Return the new observation_id so the reviewer queue can refresh
// ---------------------------------------------------------------------------
router.post('/inspections/photos/:id/link-and-analyze', express.json(), async (req, res) => {
  try {
    const photoId = req.params.id;
    const propertyId = (req.body && req.body.property_id) || null;
    if (!propertyId) return res.status(400).json({ error: 'property_id required' });

    // Fetch the photo + its inspection's community
    const { data: photo, error: phErr } = await supabase
      .from('inspection_photos')
      .select('id, storage_path, inspection_id, photo_role, inspections(community_id, communities(name))')
      .eq('id', photoId)
      .maybeSingle();
    if (phErr || !photo) return res.status(404).json({ error: 'photo not found' });
    if (photo.photo_role === 'wide') {
      return res.status(400).json({ error: 'wide-shot photos are identifying-only; link their paired close-up instead' });
    }

    // Verify the property belongs to this inspection's community
    const inspectionCommunityId = photo.inspections && photo.inspections.community_id;
    const { data: propCheck } = await supabase
      .from('properties')
      .select('id, community_id, street_address, unit')
      .eq('id', propertyId)
      .maybeSingle();
    if (!propCheck) return res.status(404).json({ error: 'property not found' });
    if (propCheck.community_id !== inspectionCommunityId) {
      return res.status(400).json({ error: 'property is in a different community than this inspection' });
    }

    // Update the photo with confirmed property
    await supabase
      .from('inspection_photos')
      .update({
        reviewer_confirmed_property_id: propertyId,
        polygon_match_property_id: propertyId,    // ensure substrate consumers see it
        reviewed_at: new Date().toISOString(),
      })
      .eq('id', photoId);

    // Download photo bytes + run AI
    let imageBuffer = null;
    try {
      const { data: blob, error: dlErr } = await supabase.storage.from('documents').download(photo.storage_path);
      if (dlErr) throw dlErr;
      imageBuffer = Buffer.from(await blob.arrayBuffer());
    } catch (e) {
      return res.status(500).json({ error: 'photo download failed: ' + e.message });
    }

    const { data: categories } = await supabase
      .from('enforcement_categories')
      .select('id, code, label, description')
      .eq('is_active', true);
    const result = await categorizePhoto({
      image_buffer: imageBuffer,
      image_media_type: 'image/jpeg',
      categories: categories || [],
      context: {
        community_name: photo.inspections && photo.inspections.communities && photo.inspections.communities.name,
        property_address: `${propCheck.street_address}${propCheck.unit ? ' #' + propCheck.unit : ''}`,
      },
    });

    if (!result) {
      return res.status(500).json({ error: 'AI analysis failed — try again or analyze the inspection in bulk' });
    }
    if (!result.is_violation) {
      return res.json({
        ok: true,
        observation_id: null,
        ai_result: result,
        message: 'AI didn\'t see a violation in this photo. No observation created.',
      });
    }

    const cat = result.category_slug && (categories || []).find((c) => c.code === result.category_slug);

    const { data: obs, error: obsErr } = await supabase
      .from('property_observations')
      .insert({
        inspection_id:         photo.inspection_id,
        inspection_photo_id:   photoId,
        property_id:           propertyId,
        community_id:          inspectionCommunityId,
        category_id:           cat ? cat.id : null,
        severity:              result.severity || 'minor',
        ai_description:        result.description || null,
        ai_recommended_action: result.recommended_action || 'courtesy',
        ai_confidence:         result.confidence || 'low',
        reviewer_status:       'pending',
      })
      .select('id')
      .single();
    if (obsErr) return res.status(500).json({ error: 'observation insert failed: ' + obsErr.message });

    res.json({
      ok: true,
      observation_id: obs.id,
      ai_result: result,
    });
  } catch (err) {
    console.error('[inspections.link-and-analyze]', err);
    res.status(500).json({ error: err.message || 'failed' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/inspections/observations/pending
// Reviewer queue — observations awaiting confirm/reject. Filter by community.
//
// Query: ?community_id=...
// ---------------------------------------------------------------------------
router.get('/inspections/observations/pending', async (req, res) => {
  try {
    let q = supabase
      .from('property_observations')
      .select(`
        id, severity, ai_description, ai_recommended_action, ai_confidence,
        reviewer_status, created_at, property_id, community_id, category_id,
        inspection_photo_id,
        enforcement_categories ( id, code, label ),
        properties ( id, street_address, unit ),
        inspection_photos ( id, storage_path, captured_at, gps_lat, gps_lng,
                            compass_heading, ai_detected_house_number )
      `)
      .eq('reviewer_status', 'pending')
      .order('created_at', { ascending: false });
    if (req.query.community_id) q = q.eq('community_id', req.query.community_id);

    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });

    // Sign URLs for the photos
    const withUrls = await Promise.all((data || []).map(async (o) => {
      let photo_url = null;
      if (o.inspection_photos && o.inspection_photos.storage_path) {
        try {
          const { data: sd } = await supabase.storage
            .from('documents')
            .createSignedUrl(o.inspection_photos.storage_path, 60 * 60);
          photo_url = sd && sd.signedUrl;
        } catch (e) { /* no-op */ }
      }
      return { ...o, photo_url };
    }));

    res.json({ observations: withUrls });
  } catch (err) {
    console.error('[inspections.observations.pending]', err);
    res.status(500).json({ error: err.message || 'failed' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/inspections/observations/:id/confirm
// Reviewer confirms the observation → opens a violation (via escalation
// engine) → triggers letter generation → draft appears in the Drafts queue.
//
// Body: { reviewer_user_id?, notes? }
// ---------------------------------------------------------------------------
router.post('/inspections/observations/:id/confirm', express.json(), async (req, res) => {
  try {
    const obsId = req.params.id;
    const reviewerNotes = (req.body && req.body.notes) || null;
    const reviewerUserId = (req.body && req.body.reviewer_user_id) || null;

    // Fetch the observation + related context
    const { data: obs, error: oErr } = await supabase
      .from('property_observations')
      .select(`
        id, property_id, community_id, category_id, severity, ai_description,
        ai_recommended_action, ai_confidence, reviewer_status,
        inspection_id, inspection_photo_id,
        properties ( id, street_address, unit, community_id ),
        enforcement_categories ( id, code, label )
      `)
      .eq('id', obsId)
      .maybeSingle();
    if (oErr || !obs) return res.status(404).json({ error: 'observation not found' });
    if (obs.reviewer_status === 'confirmed') {
      return res.status(409).json({ error: 'already confirmed' });
    }
    if (!obs.property_id) {
      return res.status(400).json({ error: 'observation has no property_id — link a property in the reviewer UI before confirming' });
    }
    if (!obs.category_id) {
      return res.status(400).json({ error: 'observation has no category — set a category before confirming' });
    }

    // CONTINUATION CHECK — if there's already an OPEN violation at this
    // (property, category) we do NOT open a new case or draft a new letter.
    // We log a continuation row instead (audit-trail proof that the violation
    // persists post-§209 cure period). See lib/enforcement/find_or_continue_violation.js
    // for the full rationale + caller list. Added 2026-06-13 per Ed.
    try {
      const { findOrContinueViolation } = require('../lib/enforcement/find_or_continue_violation');
      const cont = await findOrContinueViolation({
        propertyId:        obs.property_id,
        categoryId:        obs.category_id,
        observationId:     obs.id,
        inspectionPhotoId: obs.inspection_photo_id,
        inspectionId:      obs.inspection_id,
        userId:            reviewerUserId,
        source:            'inspection',
        notes:             reviewerNotes,
      });
      if (cont.type === 'continuation') {
        // Mark observation confirmed-as-continuation. Skip letter draft.
        await supabase
          .from('property_observations')
          .update({
            reviewer_status:  'confirmed',
            reviewer_notes:   reviewerNotes
              ? `[Continuation of open violation] ${reviewerNotes}`
              : '[Continuation of open violation — no new letter drafted]',
            reviewer_user_id: reviewerUserId,
            reviewed_at:      new Date().toISOString(),
          })
          .eq('id', obsId);
        return res.json({
          ok: true,
          opened: false,
          continuation: true,
          violation_id: cont.violation_id,
          continuation_id: cont.continuation_id,
          continuation_count: cont.continuation_count_after,
          reason: 'continuation_logged_existing_open_violation',
        });
      }
    } catch (contErr) {
      console.error('[confirm] continuation check failed:', contErr.message);
      // Fall through to normal open-violation path — don't block the
      // confirmation on a continuation-check failure. The duplicate-check
      // surface in the drafts queue is a second safety net.
    }

    // Compute prior violations for the escalation engine
    const { data: priorViolations } = await supabase
      .from('violations')
      .select('id, primary_category_id, opened_at, current_stage, resolved_via, quality_status, confidence_weight, source')
      .eq('property_id', obs.property_id)
      .eq('primary_category_id', obs.category_id)
      .gte('opened_at', new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString());

    // Pull the community + category priority + fine config
    const { data: communityRow } = await supabase
      .from('communities')
      .select('id, name, fines_enabled')
      .eq('id', obs.community_id)
      .maybeSingle();
    const { data: priorityRow } = await supabase
      .from('community_enforcement_priorities')
      .select('priority_weight, fines_enabled, fine_amount_cents')
      .eq('community_id', obs.community_id)
      .eq('category_id', obs.category_id)
      .maybeSingle();

    // Decide stage via the escalation engine. The library exports
    // decideEscalation, not decideOpenStage (the latter never existed —
    // earlier code imported a phantom name and threw silently in the
    // outer catch, which is why Confirm-button users got "✓ Confirmed"
    // badges but no drafts. Caught in Ed's pipeline audit 2026-05-20.).
    const { decideEscalation } = require('../lib/enforcement/escalation');
    const decision = decideEscalation({
      prior_violations: priorViolations || [],
      priority_weight:  priorityRow ? priorityRow.priority_weight : 'standard',
    });

    if (!decision.should_open) {
      return res.json({ ok: true, opened: false, reason: decision.rationale });
    }

    // Open the violation
    const cureEndsAt = decision.cure_days > 0
      ? new Date(Date.now() + decision.cure_days * 24 * 60 * 60 * 1000).toISOString()
      : null;

    const { data: violation, error: vErr } = await supabase
      .from('violations')
      .insert({
        property_id:              obs.property_id,
        community_id:             obs.community_id,
        opened_from_observation_id: obs.id,
        primary_category_id:      obs.category_id,
        board_priority_at_open:   priorityRow ? priorityRow.priority_weight : 'standard',
        current_stage:            decision.stage,
        cure_period_ends_at:      cureEndsAt,
      })
      .select('id, current_stage, cure_period_ends_at')
      .single();
    if (vErr) return res.status(500).json({ error: 'violation insert failed: ' + vErr.message });

    // Mark observation confirmed
    await supabase
      .from('property_observations')
      .update({
        reviewer_status: 'confirmed',
        reviewer_notes: reviewerNotes,
        reviewer_user_id: reviewerUserId,
        reviewed_at: new Date().toISOString(),
      })
      .eq('id', obsId);

    // Render the PDF + insert the DRAFT interaction so the Drafts queue
    // actually has something to show. Without this, the photo flips to
    // "✓ Confirmed" but the Drafts queue stays empty — exactly the bug
    // Ed flagged. Mirrors the auto-draft path in POST /photos so the
    // letter looks identical regardless of which entry point opened it.
    let letterResult = { error: 'letter not generated' };
    try {
      const { renderViolationLetterPdf } = require('../lib/enforcement/violation_letter');

      const { data: pRow } = await supabase
        .from('v_current_property_owners')
        .select('street_address, unit, city, state, zip, lot_number, owner_name, owner_mailing_address')
        .eq('property_id', obs.property_id)
        .maybeSingle();
      const { data: catRow } = await supabase
        .from('enforcement_categories')
        .select('slug, label, description')
        .eq('id', obs.category_id)
        .maybeSingle();
      const { data: commRow } = await supabase
        .from('communities')
        .select('name, legal_name, letter_sender_name, letter_sender_title, enforcement_authority_citation, letter_fee_courtesy_1_cents, letter_fee_courtesy_2_cents, letter_fee_certified_209_cents, letter_fee_fine_assessed_cents, letter_cure_days_courtesy_1, letter_cure_days_courtesy_2, letter_cure_days_certified_209')
        .eq('id', obs.community_id)
        .maybeSingle();

      // Governing doc — manual override wins, else semantic-search the CC&Rs
      let govDocForConfirm = null;
      try {
        const { data: prioRow } = await supabase
          .from('community_enforcement_priorities')
          .select('governing_doc_reference, governing_doc_section_title, governing_doc_quote, governing_doc_page')
          .eq('community_id', obs.community_id)
          .eq('category_id', obs.category_id)
          .is('end_date', null)
          .maybeSingle();
        if (prioRow && (prioRow.governing_doc_reference || prioRow.governing_doc_section_title || prioRow.governing_doc_quote)) {
          govDocForConfirm = {
            reference:     prioRow.governing_doc_reference,
            section_title: prioRow.governing_doc_section_title,
            quote:         prioRow.governing_doc_quote,
            page:          prioRow.governing_doc_page,
          };
        }
      } catch (_) {}
      if (!govDocForConfirm) {
        try {
          const { lookupGoverningDoc } = require('../lib/enforcement/governing_doc_lookup');
          const auto = await lookupGoverningDoc({
            communityId:         obs.community_id,
            categorySlug:        catRow && catRow.slug,
            categoryLabel:       catRow && catRow.label,
            categoryDescription: catRow && catRow.description,
            aiDescription:       obs.ai_description,
          });
          if (auto) {
            govDocForConfirm = {
              reference:      auto.reference,
              section_title:  auto.section_title,
              quote:          auto.quote,
              page:           auto.page,
              document_title: auto.document_title,
            };
          }
        } catch (_) {}
      }

      // Pull the close-up photo for the letter
      let photoBuffer = null;
      try {
        const { data: phRow } = await supabase
          .from('property_observations')
          .select('inspection_photos(storage_path, captured_at)')
          .eq('id', obs.id)
          .maybeSingle();
        const sp = phRow && phRow.inspection_photos && phRow.inspection_photos.storage_path;
        if (sp) {
          const { data: dl } = await supabase.storage.from('documents').download(sp);
          if (dl) photoBuffer = Buffer.from(await dl.arrayBuffer());
        }
      } catch (_) {}

      const yearAgo = new Date(); yearAgo.setMonth(yearAgo.getMonth() - 12);
      const { data: pv } = await supabase
        .from('violations')
        .select('opened_at, current_stage')
        .eq('property_id', obs.property_id)
        .eq('primary_category_id', obs.category_id)
        .neq('id', violation.id)
        .gte('opened_at', yearAgo.toISOString())
        .order('opened_at', { ascending: false })
        .limit(10);

      const pdfBuffer = await renderViolationLetterPdf({
        violation: {
          id: violation.id,
          current_stage: decision.stage,
          cure_period_ends_at: cureEndsAt,
          opened_at: new Date().toISOString(),
          category_label: catRow && catRow.label,
          category_description: catRow && catRow.description,
          board_priority_at_open: priorityRow ? priorityRow.priority_weight : 'standard',
        },
        property: pRow ? {
          street_address: pRow.street_address,
          unit:           pRow.unit,
          city:           pRow.city,
          state:          pRow.state,
          zip:            pRow.zip,
          lot_number:     pRow.lot_number,
        } : {},
        owner: pRow ? {
          full_name:       pRow.owner_name,
          mailing_address: pRow.owner_mailing_address,
        } : {},
        community: {
          name:       commRow && commRow.name,
          legal_name: commRow && commRow.legal_name,
          enforcement_authority_citation: commRow && commRow.enforcement_authority_citation,
          letter_fee_courtesy_1_cents:    commRow && commRow.letter_fee_courtesy_1_cents,
          letter_fee_courtesy_2_cents:    commRow && commRow.letter_fee_courtesy_2_cents,
          letter_fee_certified_209_cents: commRow && commRow.letter_fee_certified_209_cents,
          letter_fee_fine_assessed_cents: commRow && commRow.letter_fee_fine_assessed_cents,
          letter_cure_days_courtesy_1:    commRow && commRow.letter_cure_days_courtesy_1,
          letter_cure_days_courtesy_2:    commRow && commRow.letter_cure_days_courtesy_2,
          letter_cure_days_certified_209: commRow && commRow.letter_cure_days_certified_209,
        },
        observation: {
          ai_description: obs.ai_description,
          severity:       obs.severity,
          captured_at:    new Date().toISOString(),
        },
        governing_doc:    govDocForConfirm,
        prior_violations: pv || [],
        photo_buffer:     photoBuffer,
        options: {
          sender_name:  (commRow && commRow.letter_sender_name)  || null,
          sender_title: (commRow && commRow.letter_sender_title) || null,
        },
      });

      const LETTERS_BUCKET = 'violation-letters';
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const letterPath = `${violation.id}/${decision.stage}-${stamp}.pdf`;
      const { error: upErr } = await supabase.storage
        .from(LETTERS_BUCKET)
        .upload(letterPath, pdfBuffer, { contentType: 'application/pdf', upsert: false });
      if (upErr && !/already exists|duplicate/i.test(upErr.message)) {
        try {
          await supabase.storage.createBucket(LETTERS_BUCKET, { public: false });
          await supabase.storage.from(LETTERS_BUCKET).upload(letterPath, pdfBuffer, { contentType: 'application/pdf' });
        } catch (_) {}
      }

      const stageToType = {
        courtesy_1: 'letter_courtesy_1',
        courtesy_2: 'letter_courtesy_2',
        certified_209: 'letter_209',
        fine_assessed: 'letter_209',
      };
      const { data: inter } = await supabase.from('interactions').insert({
        community_id:    obs.community_id,
        property_id:     obs.property_id,
        violation_id:    violation.id,
        observation_id:  obs.id,
        type:            stageToType[decision.stage] || 'ai_draft',
        direction:       'outbound',
        subject:         `Violation letter (${decision.stage})`,
        content:         letterPath,
        delivery_method: (decision.mail_type === 'certified_mail') ? 'certified_mail' : 'first_class_mail',
        status:          'draft',
        ai_drafted:      true,
        ai_model:        'reviewer_confirm',
      }).select('id').single();

      letterResult = { interaction_id: inter && inter.id, letter_path: letterPath };
    } catch (letterErr) {
      console.warn('[inspections.confirm] letter draft failed:', letterErr.message);
      letterResult = { error: letterErr.message };
    }

    res.json({
      ok: true,
      opened: true,
      violation_id: violation.id,
      stage: violation.current_stage,
      cure_period_ends_at: violation.cure_period_ends_at,
      rationale: decision.rationale,
      letter: letterResult,
    });
  } catch (err) {
    console.error('[inspections.observations.confirm]', err);
    res.status(500).json({ error: err.message || 'confirm failed' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/inspections/observations/:id/reject — reviewer rejects (false
// positive, blurry, wrong house, etc.)
// ---------------------------------------------------------------------------
router.post('/inspections/observations/:id/reject', express.json(), async (req, res) => {
  try {
    const reason = (req.body && req.body.reason) || null;
    await supabase
      .from('property_observations')
      .update({
        reviewer_status: 'rejected',
        reviewer_notes: reason,
        reviewed_at: new Date().toISOString(),
      })
      .eq('id', req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message || 'reject failed' });
  }
});

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// POST /api/inspections/:id/backfill-orphan-photos
// Ed 2026-06-10 — recovery from the sticky-property bug. CRITICAL: wrong
// attribution = wrong violation letter = credibility hit. So:
//   - Default mode is dry_run (returns inferences for review, no writes).
//   - Apply mode requires explicit confirmation per inference via the body
//     (req.body.confirmed_inferences = [{orphan_id, property_id}, ...]).
//   - We do NOT materialize observations from back-filled photos. Photo
//     gets linked + a clear "BACK-FILLED — verify" note. Operator opens
//     each photo in View photos, sees the proposed address, and uses the
//     existing Add Violation flow to create observations from the
//     ai_findings once they've eyeballed the photo and confirmed.
//   - Conservative default thresholds: 60 seconds + 15 meters (was 180s
//     + 30m which produces too many false matches when walking).
//
// Body (all optional, all defaults conservative):
//   {
//     time_window_seconds: 60,
//     distance_meters: 15,
//     dry_run: true,                        // default true unless apply provided
//     confirmed_inferences: [{orphan_id, property_id}],  // explicit apply list
//   }
// ---------------------------------------------------------------------------
router.post('/inspections/:id/backfill-orphan-photos', express.json(), async (req, res) => {
  try {
    const inspectionId = req.params.id;
    const timeWindowSec = (req.body && req.body.time_window_seconds) || 60;
    const distMeters = (req.body && req.body.distance_meters) || 15;
    // dry_run defaults TRUE unless explicit confirmed list is passed
    const hasConfirmed = Array.isArray(req.body?.confirmed_inferences) && req.body.confirmed_inferences.length > 0;
    const dryRun = hasConfirmed ? false : (req.body?.dry_run !== false);

    const { data: insp } = await supabase
      .from('inspections')
      .select('id, community_id')
      .eq('id', inspectionId)
      .maybeSingle();
    if (!insp) return res.status(404).json({ error: 'inspection_not_found' });

    const { data: allPhotos, error } = await supabase
      .from('inspection_photos')
      .select('id, captured_at, gps_lat, gps_lng, polygon_match_property_id, reviewer_confirmed_property_id, ai_findings, ai_is_clean')
      .eq('inspection_id', inspectionId)
      .order('captured_at', { ascending: true });
    if (error) throw error;

    const matched = (allPhotos || []).filter(p =>
      p.polygon_match_property_id || p.reviewer_confirmed_property_id
    ).map(p => ({
      ...p,
      _property_id: p.polygon_match_property_id || p.reviewer_confirmed_property_id,
      _ts: p.captured_at ? new Date(p.captured_at).getTime() : 0,
    }));
    const orphans = (allPhotos || []).filter(p =>
      !(p.polygon_match_property_id || p.reviewer_confirmed_property_id)
    );
    if (orphans.length === 0) {
      return res.json({ ok: true, orphans: 0, linked: 0, message: 'no orphan photos found' });
    }
    if (matched.length === 0) {
      return res.json({ ok: true, orphans: orphans.length, linked: 0, message: 'no matched anchor photos to inherit from — link at least one photo per house manually first' });
    }

    // For each orphan, find nearest-in-time matched photo
    const haversineM = (lat1, lng1, lat2, lng2) => {
      if (lat1 == null || lng1 == null || lat2 == null || lng2 == null) return null;
      const R = 6371000;
      const φ1 = lat1 * Math.PI/180, φ2 = lat2 * Math.PI/180;
      const Δφ = (lat2 - lat1) * Math.PI/180, Δλ = (lng2 - lng1) * Math.PI/180;
      const a = Math.sin(Δφ/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin(Δλ/2)**2;
      return 2 * R * Math.asin(Math.sqrt(a));
    };

    // Hydrate signed URLs + addresses for the inferences so the review UI
    // can show photos and addresses side-by-side (no second fetch needed).
    const propertyIdsForAddresses = new Set();
    matched.forEach(m => propertyIdsForAddresses.add(m._property_id));
    let addressByPropId = new Map();
    if (propertyIdsForAddresses.size > 0) {
      const { data: props } = await supabase
        .from('properties')
        .select('id, street_address')
        .in('id', Array.from(propertyIdsForAddresses));
      for (const pr of (props || [])) addressByPropId.set(pr.id, pr.street_address);
    }

    let skippedFarTime = 0;
    let skippedFarDistance = 0;
    const inferences = [];

    for (const orph of orphans) {
      const ts = orph.captured_at ? new Date(orph.captured_at).getTime() : null;
      if (ts == null) { skippedFarTime++; continue; }
      const candidates = matched.filter(m => Math.abs(m._ts - ts) <= timeWindowSec * 1000);
      if (candidates.length === 0) { skippedFarTime++; continue; }
      let best = null;
      let bestDist = Infinity;
      let bestTimeDelta = Infinity;
      for (const c of candidates) {
        const d = (orph.gps_lat != null && c.gps_lat != null)
          ? haversineM(orph.gps_lat, orph.gps_lng, c.gps_lat, c.gps_lng)
          : null;
        const td = Math.abs(c._ts - ts);
        if (d != null && d > distMeters) continue;
        if (td < bestTimeDelta || (td === bestTimeDelta && (d || 0) < bestDist)) {
          best = c;
          bestTimeDelta = td;
          bestDist = d || 0;
        }
      }
      if (!best) { skippedFarDistance++; continue; }

      // Sign URLs for the orphan + the anchor so the review UI can show
      // both photos side-by-side
      let orphanUrl = null, anchorUrl = null;
      try {
        const { data: sa } = await supabase.storage
          .from('documents')
          .createSignedUrl(orph.storage_path || '', 60 * 60);
        orphanUrl = sa?.signedUrl || null;
      } catch (_) {}
      try {
        const { data: sb } = await supabase.storage
          .from('documents')
          .createSignedUrl(best.storage_path || '', 60 * 60);
        anchorUrl = sb?.signedUrl || null;
      } catch (_) {}

      inferences.push({
        orphan_id: orph.id,
        orphan_signed_url: orphanUrl,
        orphan_captured_at: orph.captured_at,
        anchor_id: best.id,
        anchor_signed_url: anchorUrl,
        anchor_captured_at: best.captured_at,
        proposed_property_id: best._property_id,
        proposed_address: addressByPropId.get(best._property_id) || null,
        time_delta_sec: Math.round(bestTimeDelta / 1000),
        distance_m: Math.round(bestDist),
      });
    }

    // DRY-RUN PATH — return inferences for review, no writes.
    if (dryRun) {
      return res.json({
        ok: true,
        dry_run: true,
        orphans_total: orphans.length,
        inferences_proposed: inferences.length,
        skipped_no_nearby_time: skippedFarTime,
        skipped_no_nearby_distance: skippedFarDistance,
        time_window_seconds: timeWindowSec,
        distance_meters: distMeters,
        inferences,
        message: 'Review each inference in the UI and confirm individually. No links written yet.',
      });
    }

    // APPLY PATH — only act on the explicit confirmed_inferences list.
    // Each entry must have orphan_id + property_id (operator may override
    // the inferred property if they spot a wrong match).
    let linkedCount = 0;
    const linked = [];
    for (const inf of (req.body.confirmed_inferences || [])) {
      if (!inf || !inf.orphan_id || !inf.property_id) continue;
      try {
        const { error: upErr } = await supabase
          .from('inspection_photos')
          .update({
            reviewer_confirmed_property_id: inf.property_id,
            polygon_match_property_id: inf.property_id,
            reviewed_at: new Date().toISOString(),
            notes: (`BACK-FILLED ${new Date().toISOString().slice(0,10)} — operator-confirmed. ${inf.note || ''}`).slice(0, 500),
          })
          .eq('id', inf.orphan_id);
        if (!upErr) {
          linkedCount += 1;
          linked.push({ orphan_id: inf.orphan_id, property_id: inf.property_id });
        }
      } catch (e) {
        console.warn('[backfill apply] link failed for', inf.orphan_id, e.message);
      }
    }

    res.json({
      ok: true,
      dry_run: false,
      linked: linkedCount,
      linked_details: linked,
      message: 'Links written. Open View photos and use Add Violation on each linked photo to materialize observations from the ai_findings — that confirmation step lives with the human so we never auto-attribute a violation letter.',
    });
  } catch (err) {
    console.error('[inspections.backfill-orphan-photos]', err.message);
    res.status(500).json({ error: err.message || 'failed' });
  }
});

// ============================================================================
// VOICE DRV CAPTURE (Ed 2026-06-10)
// ============================================================================
// POST /api/inspections/:id/voice-capture
// Hands-free inspection. Inspector drives, mounts phone on dashboard,
// speaks a command. The phone snaps a frame, captures GPS + heading,
// transcribes on-device, and posts here.
//
// We:
//   1. Parse the transcript with our tight command grammar (lib/voice/
//      drv_command_parser.js) — no LLM call needed for category extraction.
//   2. Save the photo to storage like any other inspection photo.
//   3. Resolve the property via the same polygon-match RPC the regular
//      capture endpoint uses (GPS + heading-aware property finder).
//   4. For each voice-supplied finding, create a property_observations
//      row pre-categorized + tagged with confidence='medium' (operator
//      spoke it) and source='voice_capture'.
//   5. Run categorizePhoto in the background to ALSO get AI's view — if
//      AI flags additional findings the operator missed, they show up.
//   6. Return a result the phone can speak back: confirmation message,
//      photo id, observation count.
//
// Multipart body:
//   photo                — file (jpeg)
//   transcript           — string (raw STT output)
//   parsed_action        — optional override, if client parsed locally
//   parsed_findings_json — optional, ditto
//   gps_lat, gps_lng     — required for property match
//   compass_heading_deg  — required for polygon match (heading + GPS)
//   gps_accuracy_m       — optional
//   captured_at          — ISO timestamp; defaults to now
// ============================================================================
router.post('/inspections/:id/voice-capture', upload.single('photo'), async (req, res) => {
  try {
    const inspectionId = req.params.id;
    if (!req.file || !req.file.buffer) return res.status(400).json({ error: 'photo_required' });

    const { data: insp, error: iErr } = await supabase
      .from('inspections')
      .select('id, community_id, status, communities(id, name)')
      .eq('id', inspectionId)
      .maybeSingle();
    if (iErr || !insp) return res.status(404).json({ error: 'inspection_not_found' });

    const transcript = String(req.body.transcript || '').trim();
    let parsed = null;
    if (req.body.parsed_action) {
      try {
        parsed = {
          action: req.body.parsed_action,
          findings: JSON.parse(req.body.parsed_findings_json || '[]'),
          note: req.body.parsed_note || null,
          raw_transcript: transcript,
        };
      } catch (_) { parsed = null; }
    }
    if (!parsed) {
      const { parseDrvCommand } = require('../lib/voice/drv_command_parser');
      parsed = parseDrvCommand(transcript);
    }

    // Non-capture commands (next_house, skip, end, note) — ack the
    // transcript without saving a photo. The client decided to send a
    // photo anyway (mic was open during a "next house" utterance), so
    // we acknowledge without writing.
    if (parsed.action !== 'capture' && parsed.action !== 'add_finding') {
      return res.json({
        ok: true,
        kind: parsed.action,
        say: parsed.action === 'next_house' ? 'Next house. Ready.'
           : parsed.action === 'skip' ? 'Skipped.'
           : parsed.action === 'end' ? 'Ending drive.'
           : 'Heard, but no action.',
        parsed,
      });
    }

    // ---- CAPTURE OR ADD_FINDING ----
    const gpsLat = req.body.gps_lat ? Number(req.body.gps_lat) : null;
    const gpsLng = req.body.gps_lng ? Number(req.body.gps_lng) : null;
    const headingDeg = req.body.compass_heading_deg ? Number(req.body.compass_heading_deg) : null;
    const gpsAccuracy = req.body.gps_accuracy_m ? Number(req.body.gps_accuracy_m) : null;
    const capturedAt = req.body.captured_at || new Date().toISOString();

    // Upload photo to storage
    const stamp = Date.now();
    const storagePath = `inspections/${inspectionId}/voice-${stamp}.jpg`;
    const { error: stErr } = await supabase.storage
      .from('documents')
      .upload(storagePath, req.file.buffer, { contentType: 'image/jpeg', upsert: false });
    if (stErr) return res.status(500).json({ error: 'storage_upload_failed', detail: stErr.message });

    // Polygon-match property (if RPC exists; falls through to NULL otherwise)
    let polygonMatchPropertyId = null;
    if (gpsLat != null && gpsLng != null) {
      try {
        const { data: matches } = await supabase.rpc('match_property_by_point', {
          p_community_id: insp.community_id,
          p_lng: gpsLng,
          p_lat: gpsLat,
        });
        if (matches && matches.length > 0) polygonMatchPropertyId = matches[0].property_id;
      } catch (_) { /* RPC missing — leave NULL, link later */ }
    }

    // Insert photo row
    const { data: photo, error: phErr } = await supabase
      .from('inspection_photos')
      .insert({
        inspection_id: inspectionId,
        storage_path: storagePath,
        captured_at: capturedAt,
        gps_lat: gpsLat,
        gps_lng: gpsLng,
        gps_accuracy_m: gpsAccuracy,
        compass_heading_deg: headingDeg,
        polygon_match_property_id: polygonMatchPropertyId,
        photo_role: 'single',
        notes: parsed.raw_transcript ? `voice: "${parsed.raw_transcript}"` : null,
      })
      .select('id')
      .single();
    if (phErr) return res.status(500).json({ error: 'photo_insert_failed', detail: phErr.message });

    // Resolve category slugs to ids
    const { data: cats } = await supabase
      .from('enforcement_categories')
      .select('id, slug, label');
    const slugToId = new Map();
    const slugToLabel = new Map();
    (cats || []).forEach(c => { slugToId.set(c.slug, c.id); slugToLabel.set(c.slug, c.label); });

    // Create observations from the voice findings
    const observationsCreated = [];
    if (polygonMatchPropertyId && parsed.findings.length > 0) {
      for (const f of parsed.findings) {
        const categoryId = slugToId.get(f.category_slug);
        if (!categoryId) continue;
        const { data: obs, error: oErr } = await supabase
          .from('property_observations')
          .insert({
            inspection_id:        inspectionId,
            inspection_photo_id:  photo.id,
            property_id:          polygonMatchPropertyId,
            community_id:         insp.community_id,
            category_id:          categoryId,
            severity:             'moderate', // operator can edit later
            ai_description:       `Operator-spoken: "${f.matched_phrase}" — review photo for specifics.`,
            ai_confidence:        f.confidence || 'medium',
            ai_recommended_action: 'courtesy',
            reviewer_status:      'pending',
            reviewer_notes:       `Voice capture. Transcript: "${parsed.raw_transcript}"`,
            observed_at:          capturedAt,
          })
          .select('id')
          .single();
        if (!oErr && obs) observationsCreated.push({ id: obs.id, category_slug: f.category_slug });
      }
    }

    // Fire the AI vision check in the background — high-recall mode will
    // pick up anything operator missed. We don't await it; the phone is
    // ready to drive on.
    setImmediate(async () => {
      try {
        const { categorizePhoto } = require('../lib/enforcement/ai_vision');
        const result = await categorizePhoto({
          image_buffer: req.file.buffer,
          image_media_type: 'image/jpeg',
          categories: cats || [],
          context: { community_name: insp.communities?.name },
        });
        if (result) {
          await supabase
            .from('inspection_photos')
            .update({
              ai_findings: result.findings || [],
              ai_is_clean: !!result.is_clean,
              ai_analyzed_at: new Date().toISOString(),
            })
            .eq('id', photo.id);
        }
      } catch (e) {
        console.warn('[voice-capture] background AI failed (non-fatal):', e.message);
      }
    });

    // Build a spoken confirmation the phone can read back
    const labels = parsed.findings.map(f => slugToLabel.get(f.category_slug) || f.matched_phrase);
    let say;
    if (!polygonMatchPropertyId) {
      say = labels.length > 0
        ? `Captured ${labels.length} finding${labels.length === 1 ? '' : 's'}. Property not auto-linked — review later.`
        : `Photo captured. Property not auto-linked — review later.`;
    } else if (labels.length === 0) {
      say = `Photo captured. AI is reviewing.`;
    } else if (labels.length === 1) {
      say = `Captured ${labels[0]}.`;
    } else {
      say = `Captured ${labels.length} findings: ${labels.join(', ')}.`;
    }

    res.json({
      ok: true,
      kind: parsed.action,
      photo_id: photo.id,
      property_id: polygonMatchPropertyId,
      observations: observationsCreated,
      findings_spoken: parsed.findings,
      say,
      parsed,
    });
  } catch (err) {
    console.error('[inspections.voice-capture]', err.message);
    res.status(500).json({ error: err.message || 'failed' });
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/inspections/photos/:id/link-property
// Ed 2026-06-10 — back-link an unmatched photo to a property after the fact.
// Sets reviewer_confirmed_property_id + polygon_match_property_id.
// If the photo has ai_findings stored, automatically materializes them into
// property_observations rows so the audit chain catches up.
// ---------------------------------------------------------------------------
router.patch('/inspections/photos/:id/link-property', express.json(), async (req, res) => {
  try {
    const photoId = req.params.id;
    const propertyId = req.body && req.body.property_id;
    if (!propertyId) return res.status(400).json({ error: 'property_id_required' });

    const { data: photo, error: phErr } = await supabase
      .from('inspection_photos')
      .select('id, inspection_id, captured_at, ai_findings, ai_is_clean, polygon_match_property_id, inspections(community_id)')
      .eq('id', photoId)
      .maybeSingle();
    if (phErr) throw phErr;
    if (!photo) return res.status(404).json({ error: 'photo_not_found' });

    // Update the photo with the property link
    const { error: upErr } = await supabase
      .from('inspection_photos')
      .update({
        reviewer_confirmed_property_id: propertyId,
        polygon_match_property_id: photo.polygon_match_property_id || propertyId,
        reviewed_at: new Date().toISOString(),
      })
      .eq('id', photoId);
    if (upErr) throw upErr;

    // If the photo already has ai_findings, materialize them as observations
    const communityId = photo.inspections?.community_id;
    const findings = Array.isArray(photo.ai_findings) ? photo.ai_findings : [];
    let observationsCreated = 0;

    if (photo.ai_is_clean && findings.length === 0) {
      // Insert a clean observation
      const { error } = await supabase.from('property_observations').insert({
        inspection_id:        photo.inspection_id,
        inspection_photo_id:  photoId,
        property_id:          propertyId,
        community_id:         communityId,
        severity:             'clean',
        ai_description:       'AI saw no violations in this photo.',
        ai_confidence:        'high',
        reviewer_status:      'rejected',
        reviewed_at:          new Date().toISOString(),
        reviewer_notes:       'AI: no violation visible — auto-filed for documentation only.',
        observed_at:          photo.captured_at || new Date().toISOString(),
      });
      if (!error) observationsCreated += 1;
    } else if (findings.length > 0) {
      // Resolve category slugs to ids
      const { data: cats } = await supabase
        .from('enforcement_categories')
        .select('id, slug');
      const slugToId = new Map();
      (cats || []).forEach(c => slugToId.set(c.slug, c.id));

      for (const f of findings) {
        const { error } = await supabase.from('property_observations').insert({
          inspection_id:         photo.inspection_id,
          inspection_photo_id:   photoId,
          property_id:           propertyId,
          community_id:          communityId,
          category_id:           (f.category_slug && slugToId.get(f.category_slug)) || null,
          severity:              f.severity || 'minor',
          ai_description:        f.description || null,
          ai_recommended_action: f.recommended_action || 'courtesy',
          ai_confidence:         f.confidence || 'low',
          reviewer_status:       'pending',
          reviewer_notes:        f.notes || null,
          observed_at:           photo.captured_at || new Date().toISOString(),
        });
        if (!error) observationsCreated += 1;
      }
    }

    res.json({
      ok: true,
      property_id: propertyId,
      observations_created: observationsCreated,
      findings_materialized: findings.length,
    });
  } catch (err) {
    console.error('[inspections.link-property]', err.message);
    res.status(500).json({ error: err.message || 'failed' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/inspections/photos/:photoId/add-violation
// Ed 2026-06-09 — operator override when AI missed a violation. Symmetric
// to the existing Reject button. Body:
//   { category_id, severity, property_id?, notes?, reviewer_email? }
// Steps:
//   1. If a property_observations row already exists for this photo, update
//      it: category_id, severity, reviewer_status='confirmed', is_violation=true.
//   2. Otherwise create one.
//   3. Open the violation row via the same escalation engine the AI path
//      uses (decideEscalation) so the stage + cure clock are consistent.
//
// NOTE on multiple violations per photo: today this endpoint adds ONE
// observation/violation. Multiple violations on the same photo = multiple
// calls to this endpoint with different category_ids. The operator clicks
// "Add violation" once per issue they spot.
// ---------------------------------------------------------------------------
router.post('/inspections/photos/:photoId/add-violation', express.json(), async (req, res) => {
  try {
    const photoId = req.params.photoId;
    const { category_id, severity, property_id, notes, reviewer_email } = req.body || {};
    if (!category_id) return res.status(400).json({ error: 'category_id_required' });
    if (!severity) return res.status(400).json({ error: 'severity_required' });

    // Load the photo + inspection context
    const { data: photo, error: phErr } = await supabase
      .from('inspection_photos')
      .select('id, inspection_id, polygon_match_property_id, captured_at, inspections(community_id)')
      .eq('id', photoId)
      .maybeSingle();
    if (phErr) throw phErr;
    if (!photo) return res.status(404).json({ error: 'photo_not_found' });

    const resolvedPropertyId = property_id || photo.polygon_match_property_id;
    if (!resolvedPropertyId) {
      return res.status(400).json({ error: 'property_id_required', message: 'No property linked to this photo. Pass property_id to specify.' });
    }
    const communityId = photo.inspections?.community_id;

    // Step 1 — operator-add ALWAYS creates a new observation row so the
    // operator can stack multiple findings on one photo (multi-violation
    // mode). Existing observations from AI stay untouched.
    const now = new Date().toISOString();
    const { data: created, error: insErr } = await supabase
      .from('property_observations')
      .insert({
        property_id:           resolvedPropertyId,
        community_id:          communityId,
        category_id,
        severity,
        reviewer_status:       'confirmed',
        reviewed_at:           now,
        reviewer_notes:        notes || '(operator override — AI missed this)',
        inspection_photo_id:   photoId,
        inspection_id:         photo.inspection_id,
        observed_at:           photo.captured_at || now,
        ai_confidence:         'manual',
        ai_description:        notes || 'Operator-added violation (AI did not flag).',
      })
      .select('id')
      .single();
    if (insErr) throw insErr;
    const observationId = created.id;

    // Step 2 — open the violation through the same escalation engine
    let violation = null;
    try {
      const { decideEscalation } = require('../lib/enforcement/escalation');
      const { data: prio } = await supabase
        .from('community_enforcement_priorities')
        .select('priority_weight')
        .eq('community_id', communityId)
        .eq('category_id', category_id)
        .is('end_date', null)
        .maybeSingle();
      const priorityWeight = (prio && prio.priority_weight) || 'standard';

      const cutoff = new Date();
      cutoff.setMonth(cutoff.getMonth() - 12);
      const { data: priors } = await supabase
        .from('violations')
        .select('id, opened_at, primary_category_id, current_stage, quality_status, confidence_weight, source')
        .eq('property_id', resolvedPropertyId)
        .eq('primary_category_id', category_id)
        .gte('opened_at', cutoff.toISOString());

      const decision = decideEscalation({
        severity,
        priorityWeight,
        priors: priors || [],
        confidenceWeight: 1.0, // operator override → full confidence
      });

      const { data: viol, error: vErr } = await supabase
        .from('violations')
        .insert({
          property_id: resolvedPropertyId,
          community_id: communityId,
          primary_category_id: category_id,
          current_stage: decision.stage,
          severity,
          source: 'operator_added',
          confidence_weight: 1.0,
          quality_status: 'confirmed',
          opened_at: now,
          opened_by_observation_id: observationId,
          opened_by_email: reviewer_email || null,
          opened_reason: notes || 'Operator-added: AI missed this violation',
        })
        .select('*')
        .single();
      if (vErr) throw vErr;
      violation = viol;

      // Link observation -> violation
      await supabase
        .from('property_observations')
        .update({ violation_id: viol.id })
        .eq('id', observationId);
    } catch (e) {
      console.warn('[inspections.add-violation] violation insert failed (observation saved):', e.message);
    }

    res.json({ ok: true, observation_id: observationId, violation });
  } catch (err) {
    console.error('[inspections.add-violation]', err.message);
    res.status(500).json({ error: err.message || 'failed' });
  }
});

// PATCH /api/inspections/observations/:id — reviewer edits property / category
// before confirming (manual link when GPS+heading didn't auto-match)
// ---------------------------------------------------------------------------
router.patch('/inspections/observations/:id', express.json(), async (req, res) => {
  try {
    const allowed = ['property_id', 'category_id', 'severity', 'ai_description', 'reviewer_notes'];
    const patch = {};
    for (const k of allowed) if (k in (req.body || {})) patch[k] = req.body[k];
    if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'no updatable fields' });

    const { data, error } = await supabase
      .from('property_observations')
      .update(patch)
      .eq('id', req.params.id)
      .select('*')
      .single();
    if (error) throw error;
    res.json({ observation: data });
  } catch (err) {
    res.status(500).json({ error: err.message || 'patch failed' });
  }
});

// ============================================================================
// LIVE TRACKING — multi-tablet inspector drive visibility (migration 165)
// ----------------------------------------------------------------------------
// The existing inspection flow above is built around: start a session, batch-
// upload pings/photos at the end, then analyze. The endpoints below add a LIVE
// layer on top: single-ping inserts every 30s while the drive is in progress,
// an active-drives query that powers the Home-tab dashboard tile + the board
// portal "Drive in Progress" surface, and a snapshot endpoint for live-map
// polling.
//
// Multi-tablet is intentional. The architecture is per-inspection (one drive
// = one inspector). Two tablets out at once = two `inspections` rows, both
// in_progress, both posting pings. The active-drives query returns both. UI
// renders Mary + Sam side-by-side. Same-community two-tablet runs get
// color-coded tracks by inspector on the community map (Phase 2 UI work).
//
// Phase 1 (this ship): manual Start/End from the tablet PWA at /inspector.html.
// Phase 2: auto-start when the staff member's tablet exits the office
// geofence (bedrock_offices table seeded in migration 165), auto-end when it
// returns.
// ============================================================================

// ---------------------------------------------------------------------------
// POST /api/inspections/:id/ping
// Single-ping live insert. The tablet PWA polls navigator.geolocation every
// 30s and POSTs the result here. Two writes happen atomically (best-effort):
//   1. Append row to inspection_route_traces (canonical ping history)
//   2. Update inspections.last_ping_at + device_label (cache for fast
//      active-drives query — without it, every active query would have to
//      JOIN to find the latest ping per inspection)
//
// Body: { lat, lng, heading_deg?, speed_mps?, accuracy_m?, captured_at?,
//         device_label? }
// captured_at defaults to server now() — tablet should send its own clock
// to preserve ordering when network is flaky and pings arrive out of order.
// ---------------------------------------------------------------------------
router.post('/inspections/:id/ping', express.json({ limit: '8kb' }), async (req, res) => {
  try {
    const { id } = req.params;
    const { lat, lng, heading_deg, speed_mps, accuracy_m, captured_at, device_label } = req.body || {};
    if (typeof lat !== 'number' || typeof lng !== 'number') {
      return res.status(400).json({ error: 'lat_lng_required' });
    }
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return res.status(400).json({ error: 'lat_lng_out_of_range' });
    }

    const capturedIso = captured_at || new Date().toISOString();

    // Verify the inspection exists + is in_progress. Refuse pings for
    // closed/voided drives (privacy boundary — once the operator taps
    // End Drive, the tablet stops broadcasting, period).
    const { data: insp } = await supabase
      .from('inspections')
      .select('id, status, community_id')
      .eq('id', id)
      .maybeSingle();
    if (!insp) return res.status(404).json({ error: 'inspection_not_found' });
    if (insp.status !== 'in_progress') {
      return res.status(409).json({ error: 'inspection_not_in_progress', status: insp.status });
    }

    // Append the ping.
    const { error: traceErr } = await supabase
      .from('inspection_route_traces')
      .insert({
        inspection_id: id,
        captured_at: capturedIso,
        latitude: lat,
        longitude: lng,
        accuracy_m: typeof accuracy_m === 'number' ? accuracy_m : null,
        heading_deg: typeof heading_deg === 'number' ? heading_deg : null,
        speed_mps: typeof speed_mps === 'number' ? speed_mps : null,
      });
    if (traceErr) {
      console.warn('[inspections.ping] route_trace insert failed:', traceErr.message);
      // Don't fail the whole ping if just the trace row failed — we still
      // want the last_ping_at cache update so the dashboard shows liveness.
    }

    // Update the cache on the parent inspection. device_label only writes
    // if provided AND the inspection doesn't already have one — first
    // tablet to ping wins (tablets should each have a stable label).
    const updatePatch = { last_ping_at: capturedIso };
    if (device_label && typeof device_label === 'string') {
      // Only write device_label if it's currently empty (first ping wins).
      // Subsequent pings with a different label are ignored to prevent
      // mid-drive identity confusion.
      const { data: cur } = await supabase
        .from('inspections')
        .select('device_label')
        .eq('id', id)
        .maybeSingle();
      if (cur && !cur.device_label) updatePatch.device_label = device_label.slice(0, 60);
    }
    const { error: upErr } = await supabase
      .from('inspections')
      .update(updatePatch)
      .eq('id', id);
    if (upErr) console.warn('[inspections.ping] inspections update failed:', upErr.message);

    res.json({ ok: true, captured_at: capturedIso });
  } catch (err) {
    console.error('[inspections.ping]', err);
    res.status(500).json({ error: err.message || 'ping failed' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/inspections/active
// Lists all currently-in-progress drives across the portfolio. Powers the
// Home-tab "Active Drives" tile and the per-community board portal tile.
//
// Decorates each row with:
//   - community name + slug
//   - operator display name (staff who started it)
//   - latest_ping {lat, lng, captured_at, heading_deg} for the live map dot
//   - minutes_idle (now - last_ping_at) — flag stale tablets (>5 min) in UI
// ---------------------------------------------------------------------------
router.get('/inspections/active', async (req, res) => {
  try {
    const { community_id } = req.query;
    let q = supabase
      .from('inspections')
      .select(`
        id, community_id, mode, route_label, device_label, operator_id,
        started_at, last_ping_at, status,
        communities ( id, name, slug )
      `)
      .eq('status', 'in_progress')
      .order('last_ping_at', { ascending: false, nullsFirst: false })
      .limit(50);
    if (community_id) q = q.eq('community_id', community_id);
    const { data: drives, error } = await q;
    if (error) throw error;

    if (!drives || drives.length === 0) return res.json({ active: [] });

    // Pull latest ping for each in one round-trip.
    // Pattern: one select per drive (small N — bounded to 50; fine).
    const decorated = await Promise.all(drives.map(async (d) => {
      const { data: latestPing } = await supabase
        .from('inspection_route_traces')
        .select('captured_at, latitude, longitude, heading_deg, speed_mps')
        .eq('inspection_id', d.id)
        .order('captured_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      const { count: pingCount } = await supabase
        .from('inspection_route_traces')
        .select('id', { count: 'exact', head: true })
        .eq('inspection_id', d.id);
      const idleMin = d.last_ping_at
        ? Math.round((Date.now() - new Date(d.last_ping_at).getTime()) / 60000)
        : null;
      return {
        id: d.id,
        community: d.communities ? { id: d.communities.id, name: d.communities.name, slug: d.communities.slug } : null,
        mode: d.mode,
        route_label: d.route_label,
        device_label: d.device_label,
        operator_id: d.operator_id,
        started_at: d.started_at,
        last_ping_at: d.last_ping_at,
        minutes_idle: idleMin,
        is_stale: idleMin != null && idleMin >= 5,
        ping_count: pingCount || 0,
        latest_ping: latestPing || null,
      };
    }));

    res.json({ active: decorated });
  } catch (err) {
    console.error('[inspections.active]', err);
    res.status(500).json({ error: err.message || 'failed to load active drives' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/inspections/:id/live
// Live snapshot for a single drive — used by the live-map polling loop on
// both the staff dashboard and the board portal tile. Returns the latest
// ping + ping count + minutes idle. Excludes the full trail (use the
// existing GET /inspections/:id/route-trace for that).
// ---------------------------------------------------------------------------
router.get('/inspections/:id/live', async (req, res) => {
  try {
    const { id } = req.params;
    const { data: insp } = await supabase
      .from('inspections')
      .select('id, community_id, status, last_ping_at, started_at, device_label, route_label, mode, communities(name, slug)')
      .eq('id', id)
      .maybeSingle();
    if (!insp) return res.status(404).json({ error: 'not_found' });

    const { data: latestPing } = await supabase
      .from('inspection_route_traces')
      .select('captured_at, latitude, longitude, heading_deg, speed_mps, accuracy_m')
      .eq('inspection_id', id)
      .order('captured_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    const { count: pingCount } = await supabase
      .from('inspection_route_traces')
      .select('id', { count: 'exact', head: true })
      .eq('inspection_id', id);

    const idleMin = insp.last_ping_at
      ? Math.round((Date.now() - new Date(insp.last_ping_at).getTime()) / 60000)
      : null;

    res.json({
      inspection: insp,
      latest_ping: latestPing || null,
      ping_count: pingCount || 0,
      minutes_idle: idleMin,
      is_stale: idleMin != null && idleMin >= 5,
    });
  } catch (err) {
    console.error('[inspections.live]', err);
    res.status(500).json({ error: err.message || 'failed to load live snapshot' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/inspections/offices
// Returns active Bedrock office geofences for the tablet PWA — needed by
// Phase 2 auto-start detection (tablet polls position; exits geofence →
// trigger Start banner). Phase 1 tablets ignore this; included now so the
// endpoint exists when the auto-start code lands.
// ---------------------------------------------------------------------------
router.get('/inspections/offices', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('bedrock_offices')
      .select('id, name, latitude, longitude, geofence_radius_m, address_line1, city, state')
      .eq('is_active', true)
      .order('name')
      .limit(50);
    if (error) throw error;
    res.json({ offices: data || [] });
  } catch (err) {
    console.error('[inspections.offices]', err);
    res.status(500).json({ error: err.message || 'failed to load offices' });
  }
});

module.exports = { router };
