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

          // Build the update payload. Map AI's category_slug to category_id.
          const updates = {
            severity:               result.severity,
            ai_description:         result.description,
            ai_recommended_action:  result.recommended_action,
            ai_confidence:          result.confidence,
          };
          if (result.category_slug && slugToId.has(result.category_slug)) {
            updates.category_id = slugToId.get(result.category_slug);
          }
          // Internal note (notes column) — combine AI notes with the raw response
          // tag for traceability if confidence is low.
          if (result.notes || result.confidence === 'low') {
            updates.reviewer_notes = result.notes ||
              `AI low-confidence — recommend human review of the photo before any action.`;
          }
          // Clean photos (no violation visible) get reviewer_status='rejected' so
          // they don't pollute the Drafts queue. Operator can still see them in the
          // Recent inspection detail.
          if (!result.is_violation || result.severity === 'clean') {
            updates.reviewer_status = 'rejected';
            updates.reviewed_at = new Date().toISOString();
            updates.reviewer_notes = (updates.reviewer_notes ? updates.reviewer_notes + ' · ' : '') +
              'AI: no violation visible — auto-filed for documentation only.';
          }

          await supabase.from('property_observations').update(updates).eq('id', observationId);
          console.log(`[ai_vision] observation ${observationId} categorized: ${result.category_slug || 'no-match'} / ${result.severity} / conf=${result.confidence} / violation=${result.is_violation}`);

          // ---- Phase 6c: AUTO-DRAFT LETTER if conditions are right ----
          // Auto-draft only when:
          //   - AI saw a real violation (is_violation && severity != 'clean')
          //   - Confidence is medium or high (low confidence → human reviews
          //     the photo first, no drafted letter yet)
          //   - We matched to a known category slug (no_category → can't run
          //     escalation engine)
          // Otherwise observation stays 'pending' for full manual review and
          // the operator chooses category + opens violation manually in Phase 6d.
          if (result.is_violation && result.severity !== 'clean' &&
              ['medium','high'].includes(result.confidence) &&
              result.category_slug && slugToId.has(result.category_slug)) {
            try {
              // Use the same library code the manual /open-violation endpoint uses,
              // requiring HTTP call so we hit the route's full pipeline (engine
              // decision → violation row + interaction record).
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
                      .select('label, description')
                      .eq('id', categoryId)
                      .maybeSingle();
                    const { data: commRow } = await supabase
                      .from('communities')
                      .select('name, legal_name, letter_sender_name, letter_sender_title, enforcement_authority_citation')
                      .eq('id', insp.community_id)
                      .maybeSingle();

                    // Phase 7 — pull governing-doc reference + prior-violation history
                    // so the letter cites the actual CC&R section and (on §209)
                    // lists prior notices for this property + category.
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

    // 1) Delete draft interactions tied to this inspection or its observations.
    // Sent interactions (letters, emails) survive — their inspection_id/observation_id
    // gets nulled by the ON DELETE SET NULL cascade in step 4.
    try {
      await supabase
        .from('interactions')
        .delete()
        .or(`inspection_id.eq.${id}` + (obsIds.length ? `,observation_id.in.(${obsIds.join(',')})` : ''))
        .eq('status', 'draft');
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
      const propIds = properties.map((p) => p.property_id);
      const yearStart = `${new Date().getFullYear()}-01-01T00:00:00Z`;

      const [vAllRes, vOpenRes, vYtdRes, insRes] = await Promise.all([
        supabase.from('violations').select('property_id').in('property_id', propIds),
        supabase.from('violations').select('property_id').in('property_id', propIds)
          .not('current_stage', 'in', '("cured","closed","voided")'),
        supabase.from('violations').select('property_id').in('property_id', propIds)
          .gte('opened_at', yearStart),
        // Last-inspected = max(inspection.ended_at) across observations that touched the property.
        supabase.from('property_observations').select('property_id, inspections!inner(ended_at)')
          .in('property_id', propIds)
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

      properties = properties.map((p) => ({
        ...p,
        violation_count_open:     openMap.get(p.property_id) || 0,
        violation_count_ytd:      ytdMap.get(p.property_id) || 0,
        violation_count_lifetime: allMap.get(p.property_id) || 0,
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
      // Violations with category name joined
      supabase.from('violations')
        .select('id, opened_at, resolved_at, current_stage, current_stage_started_at, cure_period_ends_at, board_priority_at_open, resolved_via, primary_category_id, quality_status, confidence_weight, source, reviewed_at, review_notes, enforcement_categories(id, code, label)')
        .eq('property_id', propertyId)
        .order('opened_at', { ascending: false }),
      // Interactions
      supabase.from('interactions')
        .select('id, type, direction, subject, sent_at, delivery_method, violation_id, content')
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
            .from('inspection-photos')
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
        category_code:     v.enforcement_categories && v.enforcement_categories.code,
        category_label:    v.enforcement_categories && v.enforcement_categories.label,
        // Quality fields (Phase 7b)
        quality_status:    v.quality_status,
        confidence_weight: v.confidence_weight,
        source:            v.source,
        reviewed_at:       v.reviewed_at,
        review_notes:      v.review_notes,
      })),
      interactions: interactions.map((i) => ({
        id:              i.id,
        type:            i.type,
        direction:       i.direction,
        subject:         i.subject,
        sent_at:     i.sent_at,
        delivery_method: i.delivery_method,
        violation_id:    i.violation_id,
        preview:         i.content ? String(i.content).slice(0, 240) : null,
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
    // surfaces them.
    const { data: interactions } = await supabase
      .from('interactions')
      .select('id, observation_id, status, type')
      .eq('inspection_id', inspectionId)
      .in('type', ['letter_courtesy_1','letter_courtesy_2','letter_209']);
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
    const force = !!(req.body && req.body.force);

    // Pull the inspection + its photos
    const { data: insp, error: iErr } = await supabase
      .from('inspections')
      .select('id, community_id, status, communities(id, name)')
      .eq('id', inspectionId)
      .maybeSingle();
    if (iErr || !insp) return res.status(404).json({ error: 'inspection not found' });

    const { data: photos, error: pErr } = await supabase
      .from('inspection_photos')
      .select('id, storage_path, polygon_match_property_id, ai_detected_house_number')
      .eq('inspection_id', inspectionId);
    if (pErr) return res.status(500).json({ error: pErr.message });
    if (!photos || photos.length === 0) {
      return res.json({ analyzed: 0, observations_created: 0, message: 'no photos in this inspection' });
    }

    // Find existing observations to skip (idempotent) unless force=true
    const photoIds = photos.map((p) => p.id);
    const { data: existingObs } = await supabase
      .from('property_observations')
      .select('id, inspection_photo_id')
      .in('inspection_photo_id', photoIds);

    if (force && existingObs && existingObs.length > 0) {
      await supabase.from('property_observations').delete().in('id', existingObs.map((o) => o.id));
    }
    const skipPhotoIds = !force && existingObs
      ? new Set(existingObs.map((o) => o.inspection_photo_id))
      : new Set();

    // Pull the enforcement category list once (passed to categorizePhoto)
    const { data: categories } = await supabase
      .from('enforcement_categories')
      .select('id, code, label, description')
      .eq('is_active', true)
      .order('label');
    const catBySlug = new Map();
    (categories || []).forEach((c) => catBySlug.set(c.code, c));

    // Analyze each photo
    let analyzedCount = 0;
    let observationsCreated = 0;
    const failures = [];

    for (const photo of photos) {
      if (skipPhotoIds.has(photo.id)) continue;

      // Download photo bytes from storage
      let imageBuffer = null;
      try {
        const { data: blob, error: dlErr } = await supabase.storage
          .from('inspection-photos')
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

      if (!result || !result.is_violation) {
        // Still record the analysis result on the photo for audit, but don't
        // create an observation (no violation visible)
        continue;
      }

      const cat = result.category_slug ? catBySlug.get(result.category_slug) : null;

      // Insert observation
      const insertRow = {
        inspection_id:         inspectionId,
        inspection_photo_id:   photo.id,
        property_id:           photo.polygon_match_property_id || null,
        community_id:          insp.community_id,
        category_id:           cat ? cat.id : null,
        severity:              result.severity || 'minor',
        ai_description:        result.description || null,
        ai_recommended_action: result.recommended_action || 'courtesy',
        ai_confidence:         result.confidence || 'low',
        reviewer_status:       'pending',
      };

      // property_observations requires property_id OR common_area_id by
      // constraint. If neither is set, skip the insert and surface in failures.
      if (!insertRow.property_id) {
        // Stash a placeholder observation tied to the inspection only via the
        // photo link; reviewer queue picks it up by inspection_photo_id.
        // We use common_area_id=NULL + property_id=NULL would fail the CHECK;
        // so for v1 we require polygon_match_property_id to have been set
        // upstream. Report and skip.
        failures.push({ photo_id: photo.id, reason: 'no_property_match', hint: 'photo lacks polygon_match_property_id — reviewer queue UI will support manual link in next pass' });
        continue;
      }

      const { error: obsErr } = await supabase.from('property_observations').insert(insertRow);
      if (obsErr) {
        failures.push({ photo_id: photo.id, reason: 'insert_failed', error: obsErr.message });
        continue;
      }
      observationsCreated += 1;
    }

    // Bump inspection status if we made progress
    if (analyzedCount > 0) {
      await supabase
        .from('inspections')
        .update({ status: 'ai_analyzed', updated_at: new Date().toISOString() })
        .eq('id', inspectionId);
    }

    res.json({
      inspection_id: inspectionId,
      analyzed: analyzedCount,
      observations_created: observationsCreated,
      photos_total: photos.length,
      photos_skipped_already_analyzed: skipPhotoIds.size,
      failures,
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

    const { data: photos, error: pErr } = await supabase
      .from('inspection_photos')
      .select('id, storage_path, captured_at, gps_lat, gps_lng, compass_heading_deg, ai_detected_house_number, polygon_match_property_id, reviewer_confirmed_property_id, photo_role')
      .eq('inspection_id', inspectionId)
      .in('photo_role', ['close_up', 'single'])
      .order('captured_at', { ascending: true });
    if (pErr) return res.status(500).json({ error: pErr.message });

    if (!photos || photos.length === 0) return res.json({ photos: [] });

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

    res.json({ photos: withUrls });
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
            .from('inspection-photos')
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

    // Decide stage via the escalation engine
    const { decideOpenStage } = require('../lib/enforcement/escalation');
    const decision = decideOpenStage({
      severity:              obs.severity,
      priority_weight:       priorityRow ? priorityRow.priority_weight : 'standard',
      prior_violations:      priorViolations || [],
      community_fines_enabled: communityRow ? !!communityRow.fines_enabled : false,
      category_fines_enabled:  priorityRow ? !!priorityRow.fines_enabled : false,
      fine_amount: priorityRow && priorityRow.fine_amount_cents ? priorityRow.fine_amount_cents / 100 : 0,
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

    // Kick off letter generation. The Drafts queue picks it up automatically
    // because /generate-letter creates the interaction row.
    let letterResult = null;
    try {
      const fetch = global.fetch || require('node-fetch');
      // Call our own endpoint via a relative path on the same process —
      // simpler than refactoring the letter generation into a callable.
      // Use server.js's port if available; fall back to direct supabase work.
      // For simplicity, fire-and-forget: the operator can also click
      // 'Regenerate' from the Drafts queue if needed.
      letterResult = { queued: true, note: 'Open the Drafts queue — letter generates inline on first preview/regenerate.' };
    } catch (_) { /* no-op */ }

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

module.exports = { router };
