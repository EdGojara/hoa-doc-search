// ============================================================================
// Enforcement API
// ----------------------------------------------------------------------------
// Endpoints under /api/enforcement/* — backs the escalation engine
// (lib/enforcement/escalation.js) and the observation → violation promotion
// flow.
//
//   POST /api/enforcement/decide
//     Preview-only. Body { property_id, category_id, community_id?,
//                          is_cure_lapse?, current_stage? }
//     Returns the escalation decision (stage, mail_type, cure_days,
//     requires_hearing, rationale) WITHOUT writing anything.
//     Used by the UI to show "if you opened a violation here, this is what
//     would happen" before staff commits.
//
//   POST /api/enforcement/open-violation
//     Creates an actual violations row + an interaction record. Body:
//       { observation_id }       — required; pulls property + category from it
//       override_stage?          — staff can override the engine's recommendation
//                                   (rare; logged in violation.notes)
//       override_rationale?      — required if override_stage is set
//     Returns { violation_id, decision, observation_updated }
//     Side effects: observation.reviewer_status set to 'confirmed' if pending;
//     interaction row of type 'observation_note' created to record the open.
//     Letter generation happens in Phase 5 (PDF + queue + mail-out).
//
// ============================================================================

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { decideEscalation, filterRecentSameCategory } = require('../lib/enforcement/escalation');
const { renderViolationLetterPdf } = require('../lib/enforcement/violation_letter');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Supabase storage bucket for generated violation letters. Created lazily —
// we attempt creation on first letter generation if missing.
const LETTERS_BUCKET = 'violation-letters';
let _bucketEnsured = false;
async function _ensureLettersBucket() {
  if (_bucketEnsured) return;
  try {
    const { data, error } = await supabase.storage.createBucket(LETTERS_BUCKET, { public: false });
    // If the bucket already exists, error.message contains 'already exists' or 'duplicate' — fine.
    if (error && !/already exists|duplicate/i.test(error.message || '')) {
      console.warn('[enforcement] bucket creation note:', error.message);
    }
  } catch (e) {
    console.warn('[enforcement] bucket creation threw:', e.message);
  }
  _bucketEnsured = true;
}

const router = express.Router();

// ---------------------------------------------------------------------------
// Helper: fetch the active priority weight for (community, category).
// Returns 'standard' if no row exists (sane default).
// ---------------------------------------------------------------------------
async function _getPriorityWeight(communityId, categoryId) {
  if (!communityId || !categoryId) return 'standard';
  const { data } = await supabase
    .from('community_enforcement_priorities')
    .select('priority_weight')
    .eq('community_id', communityId)
    .eq('category_id', categoryId)
    .is('end_date', null)
    .maybeSingle();
  return (data && data.priority_weight) || 'standard';
}

// ---------------------------------------------------------------------------
// Helper: fetch prior violations of a category on a property in the last
// N months. Returns the array shape decideEscalation expects.
// ---------------------------------------------------------------------------
async function _getRecentSameCategory(propertyId, categoryId, months = 12) {
  if (!propertyId || !categoryId) return [];
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - months);
  const { data } = await supabase
    .from('violations')
    .select('id, opened_at, primary_category_id, current_stage')
    .eq('property_id', propertyId)
    .eq('primary_category_id', categoryId)
    .gte('opened_at', cutoff.toISOString())
    .order('opened_at', { ascending: false });
  return data || [];
}

// ---------------------------------------------------------------------------
// POST /api/enforcement/decide — preview-only
// ---------------------------------------------------------------------------
router.post('/decide', express.json(), async (req, res) => {
  try {
    const body = req.body || {};
    const propertyId = body.property_id;
    const categoryId = body.category_id;
    if (!propertyId || !categoryId) {
      return res.status(400).json({ error: 'property_id and category_id required' });
    }

    // Look up community_id from the property if not provided
    let communityId = body.community_id;
    if (!communityId) {
      const { data: prop } = await supabase
        .from('properties')
        .select('community_id')
        .eq('id', propertyId)
        .maybeSingle();
      communityId = prop && prop.community_id;
    }

    const [priorityWeight, priorViolations] = await Promise.all([
      _getPriorityWeight(communityId, categoryId),
      _getRecentSameCategory(propertyId, categoryId, 12),
    ]);

    const decision = decideEscalation({
      prior_violations: priorViolations,
      priority_weight: priorityWeight,
      is_cure_lapse: !!body.is_cure_lapse,
      current_stage: body.current_stage || null,
    });

    res.json({
      decision,
      priority_weight: priorityWeight,
      prior_count_12mo: priorViolations.length,
      prior_violations: priorViolations.map((v) => ({
        id: v.id, opened_at: v.opened_at, current_stage: v.current_stage,
      })),
    });
  } catch (err) {
    console.error('[enforcement.decide]', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/enforcement/open-violation
// ---------------------------------------------------------------------------
router.post('/open-violation', express.json(), async (req, res) => {
  try {
    const body = req.body || {};
    const observationId = body.observation_id;
    if (!observationId) return res.status(400).json({ error: 'observation_id required' });

    // Pull the observation + its photo + AI metadata + property + category
    const { data: obs, error: obsErr } = await supabase
      .from('property_observations')
      .select('id, property_id, community_id, category_id, inspection_id, inspection_photo_id, severity, ai_description, ai_recommended_action, reviewer_status')
      .eq('id', observationId)
      .maybeSingle();
    if (obsErr || !obs) return res.status(404).json({ error: 'observation not found' });
    if (!obs.property_id) {
      return res.status(400).json({ error: 'observation has no property_id; resolve property linkage before opening violation' });
    }
    if (!obs.category_id) {
      return res.status(400).json({ error: 'observation has no category_id; staff must assign category before opening violation' });
    }

    // Fetch context for the engine
    const [priorityWeight, priorViolations] = await Promise.all([
      _getPriorityWeight(obs.community_id, obs.category_id),
      _getRecentSameCategory(obs.property_id, obs.category_id, 12),
    ]);

    let decision = decideEscalation({
      prior_violations: priorViolations,
      priority_weight: priorityWeight,
      is_cure_lapse: false,
    });

    if (!decision.should_open) {
      return res.status(400).json({
        error: 'engine decided not to open violation',
        decision,
        priority_weight: priorityWeight,
      });
    }

    // Allow staff override (very rare; logged for auditability)
    const overrideStage = body.override_stage;
    const overrideRationale = body.override_rationale;
    if (overrideStage) {
      if (!overrideRationale) {
        return res.status(400).json({ error: 'override_rationale required when override_stage is set' });
      }
      // Update the decision payload to reflect the override (so the persisted
      // violation reflects what was actually done)
      const validStages = ['courtesy_1','courtesy_2','certified_209','fine_assessed'];
      if (!validStages.includes(overrideStage)) {
        return res.status(400).json({ error: 'invalid override_stage' });
      }
      decision = {
        ...decision,
        stage: overrideStage,
        // Override certified-mail flag when stage requires it
        mail_type: overrideStage === 'certified_209' || overrideStage === 'fine_assessed' ? 'certified_mail' : 'first_class_mail',
        rationale: `Engine recommended ${decision.stage} (${decision.rationale}). Staff override → ${overrideStage}. Reason: ${overrideRationale}`,
      };
    }

    const cureEnd = decision.cure_days > 0
      ? new Date(Date.now() + decision.cure_days * 24 * 60 * 60 * 1000).toISOString()
      : null;

    // Insert the violation row
    const { data: violation, error: vErr } = await supabase
      .from('violations')
      .insert({
        property_id: obs.property_id,
        community_id: obs.community_id,
        opened_from_observation_id: obs.id,
        primary_category_id: obs.category_id,
        board_priority_at_open: priorityWeight === 'disabled' ? 'standard' : priorityWeight,
        current_stage: decision.stage,
        current_stage_started_at: new Date().toISOString(),
        cure_period_ends_at: cureEnd,
        opened_at: new Date().toISOString(),
        opened_by_user_id: body.opened_by_user_id || null,
      })
      .select()
      .single();
    if (vErr) return res.status(500).json({ error: vErr.message });

    // Update observation status to confirmed (if still pending)
    let observationUpdated = false;
    if (obs.reviewer_status === 'pending') {
      const { error: oErr } = await supabase
        .from('property_observations')
        .update({
          reviewer_status: 'confirmed',
          reviewed_at: new Date().toISOString(),
          reviewer_user_id: body.opened_by_user_id || null,
        })
        .eq('id', obs.id);
      if (!oErr) observationUpdated = true;
    }

    // Drop an interaction record so the property timeline shows the open event.
    // Letter generation (Phase 5) will create a separate letter_* interaction
    // when the actual mail goes out — this one is just the operational record.
    await supabase.from('interactions').insert({
      community_id: obs.community_id,
      property_id: obs.property_id,
      violation_id: violation.id,
      observation_id: obs.id,
      inspection_id: obs.inspection_id,
      type: 'observation_note',
      direction: 'internal',
      subject: `Violation opened: ${decision.stage}`,
      content: decision.rationale,
      occurred_at: new Date().toISOString(),
    });

    res.json({
      ok: true,
      violation_id: violation.id,
      decision,
      priority_weight: priorityWeight,
      prior_count_12mo: priorViolations.length,
      observation_updated: observationUpdated,
    });
  } catch (err) {
    console.error('[enforcement.open-violation]', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/enforcement/generate-letter
// Body: { violation_id, sender_name?, sender_title? }
//
// Generates a Bedrock-branded PDF for an open violation, uploads to Supabase
// storage, creates the corresponding interaction record (letter_courtesy_1 /
// letter_courtesy_2 / letter_209), and returns a signed URL the UI can open
// in a new tab. Idempotent-ish: if a letter for THIS violation at THIS stage
// already exists, return the existing signed URL instead of generating a new one.
// ---------------------------------------------------------------------------
router.post('/generate-letter', express.json(), async (req, res) => {
  try {
    const body = req.body || {};
    const violationId = body.violation_id;
    if (!violationId) return res.status(400).json({ error: 'violation_id required' });

    // Fetch violation + property + community + category in one round trip
    const { data: violation, error: vErr } = await supabase
      .from('violations')
      .select(`
        id, property_id, community_id, current_stage, cure_period_ends_at,
        opened_at, opened_from_observation_id, primary_category_id, board_priority_at_open,
        enforcement_categories ( label, description ),
        communities ( name )
      `)
      .eq('id', violationId)
      .maybeSingle();
    if (vErr || !violation) return res.status(404).json({ error: 'violation not found' });

    // Map stage to interaction type
    const stageToType = {
      courtesy_1:    'letter_courtesy_1',
      courtesy_2:    'letter_courtesy_2',
      certified_209: 'letter_209',
      fine_assessed: 'letter_209',  // fines piggyback on §209 letter shell
    };
    const letterType = stageToType[violation.current_stage];
    if (!letterType) {
      return res.status(400).json({ error: `violation is in stage '${violation.current_stage}' — no letter applies` });
    }

    // Check for an existing letter interaction at this stage — return its URL
    // instead of regenerating.
    const { data: priorLetter } = await supabase
      .from('interactions')
      .select('id, subject, content, occurred_at')
      .eq('violation_id', violationId)
      .eq('type', letterType)
      .order('occurred_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (priorLetter && priorLetter.content) {
      // content stores the storage path; create a signed URL
      const { data: sd } = await supabase.storage.from(LETTERS_BUCKET).createSignedUrl(priorLetter.content, 60 * 60);
      if (sd && sd.signedUrl) {
        return res.json({ ok: true, regenerated: false, letter_url: sd.signedUrl, interaction_id: priorLetter.id });
      }
    }

    // Fetch property + owner from the view
    const { data: pRow, error: pErr } = await supabase
      .from('v_current_property_owners')
      .select('property_id, street_address, unit, city, state, zip, lot_number, owner_name, owner_email, owner_phone, owner_mailing_address')
      .eq('property_id', violation.property_id)
      .maybeSingle();
    if (pErr || !pRow) return res.status(404).json({ error: 'property not found' });

    // Latest confirmed observation for evidence photo
    let observation = null;
    let photoBuffer = null;
    if (violation.opened_from_observation_id) {
      const { data: obs } = await supabase
        .from('property_observations')
        .select('id, ai_description, severity, created_at, inspection_photo_id, inspection_photos(captured_at, storage_path)')
        .eq('id', violation.opened_from_observation_id)
        .maybeSingle();
      if (obs) {
        observation = {
          ai_description: obs.ai_description,
          severity: obs.severity,
          captured_at: (obs.inspection_photos && obs.inspection_photos.captured_at) || obs.created_at,
        };
        if (obs.inspection_photos && obs.inspection_photos.storage_path) {
          try {
            const { data: dl } = await supabase.storage
              .from('inspection-photos')
              .download(obs.inspection_photos.storage_path);
            if (dl) {
              const ab = await dl.arrayBuffer();
              photoBuffer = Buffer.from(ab);
            }
          } catch (e) {
            console.warn('[letter] photo download failed:', e.message);
          }
        }
      }
    }

    // Generate the PDF
    const pdfBuffer = await renderViolationLetterPdf({
      violation: {
        id: violation.id,
        current_stage: violation.current_stage,
        cure_period_ends_at: violation.cure_period_ends_at,
        opened_at: violation.opened_at,
        category_label: violation.enforcement_categories && violation.enforcement_categories.label,
        category_description: violation.enforcement_categories && violation.enforcement_categories.description,
        board_priority_at_open: violation.board_priority_at_open,
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
      community: { name: violation.communities && violation.communities.name },
      observation,
      photo_buffer: photoBuffer,
      options: {
        sender_name:  body.sender_name  || 'Bedrock Association Management',
        sender_title: body.sender_title || null,
      },
    });

    // Upload to storage bucket. Path: violation_id/stage-yyyymmdd-HHMMSS.pdf
    await _ensureLettersBucket();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const storagePath = `${violation.id}/${violation.current_stage}-${stamp}.pdf`;
    const { error: upErr } = await supabase.storage
      .from(LETTERS_BUCKET)
      .upload(storagePath, pdfBuffer, { contentType: 'application/pdf', upsert: false });
    if (upErr) return res.status(500).json({ error: 'upload failed: ' + upErr.message });

    // Record the interaction. Mail method depends on stage.
    const isCertified = violation.current_stage === 'certified_209' || violation.current_stage === 'fine_assessed';
    const { data: inter, error: iErr } = await supabase
      .from('interactions')
      .insert({
        community_id:    violation.community_id,
        property_id:     violation.property_id,
        violation_id:    violation.id,
        observation_id:  violation.opened_from_observation_id,
        type:            letterType,
        direction:       'outbound',
        subject:         `Violation letter (${violation.current_stage})`,
        content:         storagePath,         // canonical storage location; signed URLs derived on demand
        delivery_method: isCertified ? 'certified_mail' : 'first_class_mail',
        occurred_at:     new Date().toISOString(),
      })
      .select()
      .single();
    if (iErr) return res.status(500).json({ error: 'interaction insert failed: ' + iErr.message });

    // Signed URL for immediate download
    const { data: sd } = await supabase.storage.from(LETTERS_BUCKET).createSignedUrl(storagePath, 60 * 60);

    res.json({
      ok: true,
      regenerated: true,
      violation_id: violation.id,
      interaction_id: inter.id,
      letter_url: sd && sd.signedUrl,
      letter_type: letterType,
      delivery_method: isCertified ? 'certified_mail' : 'first_class_mail',
      mailed_to: pRow.owner_mailing_address || `${pRow.street_address || ''}${pRow.unit ? ' #' + pRow.unit : ''}, ${pRow.city || ''} ${pRow.state || 'TX'} ${pRow.zip || ''}`,
    });
  } catch (err) {
    console.error('[enforcement.generate-letter]', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/enforcement/drafts
//   Query params: ?community_id=  ?inspection_id=  ?limit=50
//   Returns DRAFT interactions (subject starts with '[DRAFT]') + joined
//   violation + property + photo data, ready for the review UI.
//
//   Subject prefix '[DRAFT]' is the gate set in Phase 6c. When a letter is
//   approved + sent (POST /approve-draft below), the prefix is removed and
//   occurred_at is bumped to the approval time, so the same interactions
//   row represents the actual send event.
// ---------------------------------------------------------------------------
router.get('/drafts', async (req, res) => {
  try {
    const communityId = req.query.community_id;
    const inspectionId = req.query.inspection_id;
    const limit = Math.min(200, Number(req.query.limit) || 50);

    let q = supabase
      .from('interactions')
      .select(`
        id, subject, content, type, delivery_method, occurred_at,
        community_id, property_id, violation_id, observation_id, inspection_id
      `)
      .like('subject', '[DRAFT]%')
      .order('occurred_at', { ascending: false })
      .limit(limit);
    if (communityId) q = q.eq('community_id', communityId);
    if (inspectionId) q = q.eq('inspection_id', inspectionId);
    const { data: drafts, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    if (!drafts || drafts.length === 0) return res.json({ drafts: [] });

    // Bulk-fetch violations, properties, observations, photos so we can join
    // in JS (Supabase's nested-select can't handle this many cross-table joins
    // cleanly).
    const violationIds = [...new Set(drafts.map((d) => d.violation_id).filter(Boolean))];
    const propertyIds  = [...new Set(drafts.map((d) => d.property_id).filter(Boolean))];
    const observationIds = [...new Set(drafts.map((d) => d.observation_id).filter(Boolean))];

    const [vRes, pRes, oRes] = await Promise.all([
      supabase.from('violations')
        .select('id, primary_category_id, current_stage, cure_period_ends_at, board_priority_at_open, enforcement_categories(label)')
        .in('id', violationIds.length ? violationIds : ['00000000-0000-0000-0000-000000000000']),
      supabase.from('v_current_property_owners')
        .select('property_id, street_address, unit, city, owner_name, owner_mailing_address')
        .in('property_id', propertyIds.length ? propertyIds : ['00000000-0000-0000-0000-000000000000']),
      supabase.from('property_observations')
        .select('id, severity, ai_description, ai_confidence, reviewer_notes, inspection_photo_id, inspection_photos(captured_at, storage_path)')
        .in('id', observationIds.length ? observationIds : ['00000000-0000-0000-0000-000000000000']),
    ]);
    const violationById = new Map((vRes.data || []).map((v) => [v.id, v]));
    const propertyById  = new Map((pRes.data || []).map((p) => [p.property_id, p]));
    const observationById = new Map((oRes.data || []).map((o) => [o.id, o]));

    // Generate signed URLs for both letter PDFs and observation photos (in parallel)
    const enrichedAll = await Promise.all(drafts.map(async (d) => {
      const v = violationById.get(d.violation_id);
      const p = propertyById.get(d.property_id);
      const o = observationById.get(d.observation_id);
      const photoPath = o && o.inspection_photos && o.inspection_photos.storage_path;
      let photoUrl = null;
      if (photoPath) {
        try {
          const { data: sd } = await supabase.storage.from('documents').createSignedUrl(photoPath, 60 * 60);
          if (sd) photoUrl = sd.signedUrl;
        } catch (_) {}
      }
      let letterUrl = null;
      if (d.content) {
        try {
          const { data: sd } = await supabase.storage.from('violation-letters').createSignedUrl(d.content, 60 * 60);
          if (sd) letterUrl = sd.signedUrl;
        } catch (_) {}
      }
      return {
        interaction_id: d.id,
        violation_id:   d.violation_id,
        property_id:    d.property_id,
        observation_id: d.observation_id,
        inspection_id:  d.inspection_id,
        drafted_at:     d.occurred_at,
        letter_type:    d.type,
        delivery_method: d.delivery_method,
        letter_url:     letterUrl,
        violation: v ? {
          current_stage: v.current_stage,
          cure_period_ends_at: v.cure_period_ends_at,
          board_priority_at_open: v.board_priority_at_open,
          category_label: v.enforcement_categories && v.enforcement_categories.label,
        } : null,
        property: p ? {
          street_address: p.street_address,
          unit:           p.unit,
          city:           p.city,
        } : null,
        owner: p ? {
          full_name: p.owner_name,
          mailing_address: p.owner_mailing_address,
        } : null,
        observation: o ? {
          severity: o.severity,
          ai_description: o.ai_description,
          ai_confidence: o.ai_confidence,
          reviewer_notes: o.reviewer_notes,
          captured_at: o.inspection_photos && o.inspection_photos.captured_at,
          photo_url: photoUrl,
        } : null,
      };
    }));

    res.json({ drafts: enrichedAll });
  } catch (err) {
    console.error('[enforcement.drafts]', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/enforcement/drafts/approve
// Body: { interaction_ids: [uuid, ...] }
// Strips '[DRAFT]' prefix from subject + sets occurred_at to NOW so each
// interaction represents an actual send event. Returns count + list.
// ---------------------------------------------------------------------------
router.post('/drafts/approve', express.json(), async (req, res) => {
  try {
    const ids = (req.body && req.body.interaction_ids) || [];
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'interaction_ids (array) required' });
    }
    const { data: rows, error: getErr } = await supabase
      .from('interactions')
      .select('id, subject')
      .in('id', ids);
    if (getErr) return res.status(500).json({ error: getErr.message });
    let approved = 0;
    for (const r of rows || []) {
      const cleanSubject = String(r.subject || '').replace(/^\[DRAFT\]\s*/i, '').trim() || 'Violation letter';
      const { error: upErr } = await supabase
        .from('interactions')
        .update({ subject: cleanSubject, occurred_at: new Date().toISOString() })
        .eq('id', r.id);
      if (!upErr) approved += 1;
    }
    res.json({ approved, requested: ids.length });
  } catch (err) {
    console.error('[enforcement.drafts.approve]', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/enforcement/drafts/reject
// Body: { interaction_id, reason? }
// Soft-discard: deletes the draft interaction + closes the violation as
// 'voided' (no letter sent, observation stays for audit trail).
// ---------------------------------------------------------------------------
router.post('/drafts/reject', express.json(), async (req, res) => {
  try {
    const interactionId = req.body && req.body.interaction_id;
    const reason = (req.body && req.body.reason) || null;
    if (!interactionId) return res.status(400).json({ error: 'interaction_id required' });
    const { data: inter } = await supabase
      .from('interactions')
      .select('id, violation_id, observation_id')
      .eq('id', interactionId)
      .maybeSingle();
    if (!inter) return res.status(404).json({ error: 'draft not found' });

    // Void the violation
    if (inter.violation_id) {
      await supabase.from('violations')
        .update({
          current_stage: 'voided',
          resolved_via: 'voided',
          resolved_at: new Date().toISOString(),
          resolved_notes: reason || 'Rejected from Drafts review',
        })
        .eq('id', inter.violation_id);
    }
    // Mark the observation rejected
    if (inter.observation_id) {
      await supabase.from('property_observations')
        .update({
          reviewer_status: 'rejected',
          reviewer_notes: reason || 'Rejected from Drafts review',
          reviewed_at: new Date().toISOString(),
        })
        .eq('id', inter.observation_id);
    }
    // Delete the draft interaction row entirely
    await supabase.from('interactions').delete().eq('id', interactionId);
    res.json({ ok: true });
  } catch (err) {
    console.error('[enforcement.drafts.reject]', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// MAIL QUEUE
// ---------------------------------------------------------------------------
// GET  /api/enforcement/mail-queue/summary
//   Counts of pending (approved but not yet printed) letters by delivery
//   method + community.
//
// POST /api/enforcement/mail-queue/batch-pdf
//   Body: { delivery_method, community_id?, interaction_ids? }
//   Merges all pending letter PDFs for that delivery_method (optionally
//   filtered to a community OR a specific set of interaction IDs) into a
//   single multi-page PDF, returns it as application/pdf with
//   Content-Disposition: attachment. Sets printed_at = NOW on the included
//   interactions so they don't re-export next time.
// ---------------------------------------------------------------------------
router.get('/mail-queue/summary', async (req, res) => {
  try {
    const communityId = req.query.community_id;
    const letterTypes = ['letter_courtesy_1', 'letter_courtesy_2', 'letter_209'];
    let q = supabase
      .from('interactions')
      .select('id, delivery_method, community_id, communities:community_id(name)')
      .in('type', letterTypes)
      .is('printed_at', null)
      .not('subject', 'like', '[DRAFT]%');
    if (communityId) q = q.eq('community_id', communityId);
    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    const summary = { first_class_mail: 0, certified_mail: 0, by_community: {} };
    (data || []).forEach((row) => {
      if (row.delivery_method === 'first_class_mail') summary.first_class_mail += 1;
      if (row.delivery_method === 'certified_mail')   summary.certified_mail   += 1;
      const cName = (row.communities && row.communities.name) || 'Unknown community';
      if (!summary.by_community[cName]) summary.by_community[cName] = { first_class: 0, certified: 0 };
      if (row.delivery_method === 'first_class_mail') summary.by_community[cName].first_class += 1;
      if (row.delivery_method === 'certified_mail')   summary.by_community[cName].certified  += 1;
    });
    res.json({ summary, total_pending: (data || []).length });
  } catch (err) {
    console.error('[mail-queue.summary]', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/mail-queue/batch-pdf', express.json(), async (req, res) => {
  try {
    const body = req.body || {};
    const deliveryMethod = body.delivery_method;
    const communityId = body.community_id || null;
    const explicitIds = Array.isArray(body.interaction_ids) ? body.interaction_ids : null;
    if (!deliveryMethod || !['first_class_mail', 'certified_mail'].includes(deliveryMethod)) {
      return res.status(400).json({ error: "delivery_method must be 'first_class_mail' or 'certified_mail'" });
    }
    const letterTypes = ['letter_courtesy_1', 'letter_courtesy_2', 'letter_209'];

    let q = supabase
      .from('interactions')
      .select('id, content, type, subject, occurred_at, community_id, property_id')
      .in('type', letterTypes)
      .eq('delivery_method', deliveryMethod)
      .is('printed_at', null)
      .not('subject', 'like', '[DRAFT]%')
      .order('occurred_at', { ascending: true });
    if (communityId) q = q.eq('community_id', communityId);
    if (explicitIds) q = q.in('id', explicitIds);
    const { data: letters, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    if (!letters || letters.length === 0) {
      return res.status(404).json({ error: 'No pending letters match those filters.' });
    }

    // Download all the PDFs from storage
    const { PDFDocument } = require('pdf-lib');
    const out = await PDFDocument.create();
    let included = [];
    let skipped = [];
    for (const L of letters) {
      if (!L.content) { skipped.push({ id: L.id, reason: 'no storage path' }); continue; }
      try {
        const { data: blob } = await supabase.storage.from('violation-letters').download(L.content);
        if (!blob) { skipped.push({ id: L.id, reason: 'storage missing' }); continue; }
        const ab = await blob.arrayBuffer();
        const src = await PDFDocument.load(ab);
        const copied = await out.copyPages(src, src.getPageIndices());
        copied.forEach((page) => out.addPage(page));
        included.push(L.id);
      } catch (e) {
        skipped.push({ id: L.id, reason: e.message });
      }
    }
    if (included.length === 0) {
      return res.status(500).json({ error: 'Could not load any letter PDFs.', skipped });
    }
    const mergedBytes = await out.save();

    // Mark all included letters as printed
    const stamp = new Date().toISOString();
    await supabase
      .from('interactions')
      .update({ printed_at: stamp })
      .in('id', included);

    // Stream the PDF back to the browser
    const filenameStamp = stamp.replace(/[:.]/g, '-').slice(0, 19);
    const methodLabel = deliveryMethod === 'certified_mail' ? 'CERTIFIED' : 'first-class';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="bedrock-mail-batch-${methodLabel}-${filenameStamp}.pdf"`);
    res.setHeader('X-Bedrock-Included', included.length);
    res.setHeader('X-Bedrock-Skipped', skipped.length);
    res.end(Buffer.from(mergedBytes));
  } catch (err) {
    console.error('[mail-queue.batch-pdf]', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = { router };
