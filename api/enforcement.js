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
    .select('id, opened_at, primary_category_id, current_stage, quality_status, confidence_weight, source')
    .eq('property_id', propertyId)
    .eq('primary_category_id', categoryId)
    .gte('opened_at', cutoff.toISOString())
    .neq('quality_status', 'superseded')   // exclude corrected-out rows
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
      sent_at: new Date().toISOString(),
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
      .select('id, subject, content, sent_at')
      .eq('violation_id', violationId)
      .eq('type', letterType)
      .order('sent_at', { ascending: false })
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

    // Phase 7 — enrich context for the new template
    //   - community.legal_name (HOA primary header)
    //   - community.letter_sender_name / _title (per-community sign-off override)
    //   - governing_doc (community_enforcement_priorities row for this category)
    //   - prior_violations (history list rendered on §209 letters)
    let commLegalName = null;
    let senderName = body.sender_name || null;
    let senderTitle = body.sender_title || null;
    try {
      const { data: comm } = await supabase
        .from('communities')
        .select('legal_name, letter_sender_name, letter_sender_title')
        .eq('id', violation.community_id)
        .maybeSingle();
      if (comm) {
        commLegalName = comm.legal_name || null;
        if (!senderName)  senderName  = comm.letter_sender_name || null;
        if (!senderTitle) senderTitle = comm.letter_sender_title || null;
      }
    } catch (_) {}

    let govDoc = null;
    try {
      const { data: prio } = await supabase
        .from('community_enforcement_priorities')
        .select('governing_doc_reference, governing_doc_section_title, governing_doc_quote, governing_doc_page')
        .eq('community_id', violation.community_id)
        .eq('category_id', violation.primary_category_id)
        .is('end_date', null)
        .maybeSingle();
      if (prio && (prio.governing_doc_reference || prio.governing_doc_section_title || prio.governing_doc_quote)) {
        govDoc = {
          reference:     prio.governing_doc_reference,
          section_title: prio.governing_doc_section_title,
          quote:         prio.governing_doc_quote,
          page:          prio.governing_doc_page,
        };
      }
    } catch (_) {}

    let priorViolations = [];
    try {
      const yearAgo = new Date(); yearAgo.setMonth(yearAgo.getMonth() - 12);
      const { data: pv } = await supabase
        .from('violations')
        .select('opened_at, current_stage')
        .eq('property_id', violation.property_id)
        .eq('primary_category_id', violation.primary_category_id)
        .neq('id', violation.id)
        .gte('opened_at', yearAgo.toISOString())
        .order('opened_at', { ascending: false })
        .limit(10);
      priorViolations = pv || [];
    } catch (_) {}

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
      community: {
        name:       violation.communities && violation.communities.name,
        legal_name: commLegalName,
      },
      observation,
      governing_doc:    govDoc,
      prior_violations: priorViolations,
      photo_buffer:     photoBuffer,
      options: {
        sender_name:  senderName,
        sender_title: senderTitle,
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
        sent_at:     new Date().toISOString(),
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
//   sent_at is bumped to the approval time, so the same interactions
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
        id, subject, content, type, delivery_method, sent_at, created_at, status,
        community_id, property_id, violation_id, observation_id, inspection_id
      `)
      .eq('status', 'draft')
      .order('created_at', { ascending: false })
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
        drafted_at:     d.created_at,
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
// Flips status from 'draft' to 'approved' + sets sent_at to NOW. From this
// point forward the interaction represents an actual sent letter. Mail Queue
// picks them up via status='approved' AND printed_at IS NULL.
// ---------------------------------------------------------------------------
router.post('/drafts/approve', express.json(), async (req, res) => {
  try {
    const ids = (req.body && req.body.interaction_ids) || [];
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'interaction_ids (array) required' });
    }
    const now = new Date().toISOString();
    const { error: upErr, count } = await supabase
      .from('interactions')
      .update({ status: 'approved', sent_at: now }, { count: 'exact' })
      .in('id', ids)
      .eq('status', 'draft');
    if (upErr) return res.status(500).json({ error: upErr.message });
    res.json({ approved: count || 0, requested: ids.length });
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
    // Flip the draft to status='rejected' so it disappears from the queue
    // but stays on the property timeline as an audit-trail record.
    await supabase.from('interactions')
      .update({
        status: 'rejected',
        notes: reason || 'Rejected from Drafts review',
      })
      .eq('id', interactionId);
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
      .in('status', ['approved', 'sent'])
      .is('printed_at', null);
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
      .select('id, content, type, subject, sent_at, community_id, property_id')
      .in('type', letterTypes)
      .eq('delivery_method', deliveryMethod)
      .in('status', ['approved', 'sent'])
      .is('printed_at', null)
      .order('sent_at', { ascending: true });
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

// ---------------------------------------------------------------------------
// AI DOC-REFERENCE EXTRACTOR
// ---------------------------------------------------------------------------
// Given a community + an enforcement category, scan the community's loaded
// governing documents (declaration_ccrs / bylaws / rules_and_regulations /
// design_document) and ask Claude to identify the specific section that
// addresses this category. Writes the result back to
// community_enforcement_priorities.governing_doc_* so the next letter for
// that (community, category) cites the actual section + quote.
//
// Two flavors:
//   POST /api/enforcement/extract-doc-references/:community_id/:category_id
//     One-shot for a specific pair (used by a UI "suggest reference" button).
//
//   POST /api/enforcement/extract-doc-references/:community_id
//     Batch — scans every category that has priority_weight != 'disabled' and
//     no governing_doc_reference yet (or force=true to redo all).
//
// Uses the existing knowledge_documents + knowledge_chunks vector-search
// infrastructure (migration 011). If the community's CC&Rs haven't been
// ingested as knowledge_documents (source_type='governing_document'),
// returns a hint to ingest first — no error.
// ---------------------------------------------------------------------------

async function _extractDocRefForCategory(communityId, categoryId, options = {}) {
  const Anthropic = require('@anthropic-ai/sdk');
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { ok: false, reason: 'ANTHROPIC_API_KEY not set' };

  // 1. Get the category + community context
  const { data: cat } = await supabase
    .from('enforcement_categories')
    .select('id, slug, label, description')
    .eq('id', categoryId)
    .maybeSingle();
  if (!cat) return { ok: false, reason: 'category not found' };

  const { data: comm } = await supabase
    .from('communities')
    .select('id, name, legal_name, management_company_id')
    .eq('id', communityId)
    .maybeSingle();
  if (!comm) return { ok: false, reason: 'community not found' };

  // 2. Find this community's governing-doc knowledge_chunks via vector search.
  //    Build the query embedding from the category label + description so the
  //    semantic search lands on the relevant section.
  const OpenAI = require('openai');
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  if (!process.env.OPENAI_API_KEY) {
    return { ok: false, reason: 'OPENAI_API_KEY not set (needed for embedding query)' };
  }

  const queryText = `${cat.label}. ${cat.description || ''} — covenant or rule for this in an HOA's CC&Rs, bylaws, or rules and regulations.`;
  let queryEmbedding;
  try {
    const embedResp = await openai.embeddings.create({
      model: 'text-embedding-ada-002',
      input: queryText,
    });
    queryEmbedding = embedResp.data[0].embedding;
  } catch (e) {
    return { ok: false, reason: 'embedding failed: ' + e.message };
  }

  // 3. Vector search the knowledge base for the most relevant chunks
  const { data: chunks, error: matchErr } = await supabase.rpc('match_knowledge_chunks', {
    query_embedding: queryEmbedding,
    mgmt_co_id:      comm.management_company_id,
    match_count:     6,
    source_filter:   ['governing_document'],
  });
  if (matchErr) return { ok: false, reason: 'search failed: ' + matchErr.message };
  if (!chunks || chunks.length === 0) {
    return { ok: false, reason: 'no governing docs found in knowledge base — ingest CC&Rs / Bylaws first (source_type=governing_document)' };
  }

  // 4. Ask Claude to identify the best section + extract a clean quote
  const client = new Anthropic({ apiKey });
  const chunkBlocks = chunks.map((c, i) =>
    `--- Chunk ${i + 1}  (${c.document_title}, page ${c.page_number || '?'}${c.section_heading ? ', ' + c.section_heading : ''}) ---\n${c.text}`
  ).join('\n\n');

  const systemPrompt = `You are reviewing excerpts from an HOA's governing documents to identify the most relevant section that addresses a specific enforcement category. Your job is to extract a clean citation + short verbatim quote that a violation letter can reference.

Voice: just return the JSON. No preamble, no commentary.

If no chunk clearly addresses the category, set "found": false and explain briefly in "notes".

Always respond with valid JSON:
{
  "found": true|false,
  "reference":     "DCC&Rs Article IV, Section 4.3",   // canonical citation
  "section_title": "Landscaping Standards",             // human-readable heading
  "quote":         "Each Owner shall maintain the Lot in a neat, clean...",  // 1-2 sentences max, verbatim
  "page":          14,                                  // page number from chunk metadata
  "chunk_index":   2,                                   // which provided chunk was used (1-based)
  "confidence":    "low|medium|high",
  "notes":         "optional"
}`;

  const userText = `Community: ${comm.name}
Enforcement category: ${cat.label}
${cat.description ? 'Description: ' + cat.description : ''}

Below are 6 excerpts from the community's governing documents (CC&Rs, Bylaws, or Rules & Regulations). Identify which excerpt most directly addresses this category and extract the citation + a brief verbatim quote.

${chunkBlocks}`;

  let raw;
  try {
    const resp = await client.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 500,
      system: systemPrompt,
      messages: [{ role: 'user', content: userText }],
    });
    raw = (resp.content || []).find((b) => b.type === 'text');
    raw = raw && raw.text || '';
  } catch (e) {
    return { ok: false, reason: 'Claude call failed: ' + e.message };
  }

  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return { ok: false, reason: 'no JSON in Claude response', raw };
  let parsed;
  try { parsed = JSON.parse(jsonMatch[0]); }
  catch (e) { return { ok: false, reason: 'JSON parse failed', raw }; }

  if (!parsed.found) return { ok: true, found: false, notes: parsed.notes, raw };

  // 5. Write back to community_enforcement_priorities (active row)
  const { error: upErr } = await supabase
    .from('community_enforcement_priorities')
    .update({
      governing_doc_reference:     parsed.reference || null,
      governing_doc_section_title: parsed.section_title || null,
      governing_doc_quote:         parsed.quote || null,
      governing_doc_page:          parsed.page || null,
      governing_doc_source:        'ai_extracted',
      governing_doc_extracted_at:  new Date().toISOString(),
    })
    .eq('community_id', communityId)
    .eq('category_id', categoryId)
    .is('end_date', null);
  if (upErr) return { ok: false, reason: 'update failed: ' + upErr.message };

  return {
    ok: true, found: true,
    reference:     parsed.reference,
    section_title: parsed.section_title,
    quote:         parsed.quote,
    page:          parsed.page,
    confidence:    parsed.confidence,
  };
}

// ---------------------------------------------------------------------------
// GET /api/enforcement/categories — list of canonical enforcement categories.
// Used by UI dropdowns (manual prior-violation entry, category override, etc.)
// ---------------------------------------------------------------------------
router.get('/categories', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('enforcement_categories')
      .select('id, slug, label, description, default_priority_weight, display_order')
      .order('display_order', { ascending: true });
    if (error) return res.status(500).json({ error: error.message });
    res.json({ categories: data || [] });
  } catch (err) {
    console.error('[enforcement.categories]', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// VIOLATION QUALITY ACTIONS
// ---------------------------------------------------------------------------
// PATCH /api/enforcement/violations/:id/quality
//   Body: { quality_status: 'verified' | 'unreviewed' | 'disputed_by_owner' |
//                            'flagged_internal',
//           confidence_weight?: 0-1,
//           review_notes?: string,
//           user_id?: string }
//   Updates the violation's quality fields + records reviewer + timestamp.
//   For 'superseded' (which means "this is being corrected"), use the
//   /violations/:id/correct endpoint instead so an audit row is created.
// ---------------------------------------------------------------------------
router.patch('/violations/:id/quality', express.json(), async (req, res) => {
  try {
    const violationId = req.params.id;
    const body = req.body || {};
    const allowedStatuses = ['verified', 'unreviewed', 'disputed_by_owner', 'flagged_internal'];
    if (body.quality_status && !allowedStatuses.includes(body.quality_status)) {
      return res.status(400).json({ error: 'invalid quality_status (use /correct for superseded)' });
    }
    const patch = { reviewed_at: new Date().toISOString() };
    if (body.quality_status) patch.quality_status = body.quality_status;
    if (typeof body.confidence_weight === 'number') {
      patch.confidence_weight = Math.max(0, Math.min(1, body.confidence_weight));
    } else if (body.quality_status === 'verified') {
      patch.confidence_weight = 1.0;   // verified always promotes to full weight
    }
    if (body.review_notes != null) patch.review_notes = body.review_notes;
    if (body.user_id) patch.reviewed_by_user_id = body.user_id;

    const { data, error } = await supabase
      .from('violations')
      .update(patch)
      .eq('id', violationId)
      .select('id, quality_status, confidence_weight, reviewed_at, reviewed_by_user_id, review_notes')
      .single();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true, violation: data });
  } catch (err) {
    console.error('[violations.quality]', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/enforcement/violations/:id/correct
// Body: { correction_type, reason, replacement: {...} | null, user_id? }
//   Records a correction row + sets the original to status='superseded'
//   (which makes confidence_weight=0 effective for escalation math).
//   If correction_type is 'reclassified' / 'wrong_property' and the body
//   includes a replacement object, creates a new violation with the
//   corrected fields and links it via replacement_violation_id.
// ---------------------------------------------------------------------------
router.post('/violations/:id/correct', express.json(), async (req, res) => {
  try {
    const originalId = req.params.id;
    const body = req.body || {};
    const validTypes = ['voided','reclassified','wrong_property','duplicate',
                        'resolved_at_inspection','reissued','merged_into','split_from'];
    if (!validTypes.includes(body.correction_type)) {
      return res.status(400).json({ error: 'invalid correction_type', allowed: validTypes });
    }
    if (!body.reason) {
      return res.status(400).json({ error: 'reason is required for any correction' });
    }
    // Fetch original for snapshot
    const { data: original, error: oErr } = await supabase
      .from('violations')
      .select('*')
      .eq('id', originalId)
      .maybeSingle();
    if (oErr || !original) return res.status(404).json({ error: 'violation not found' });

    // Optionally create a replacement violation
    let replacementId = null;
    if (body.replacement && (body.correction_type === 'reclassified' ||
                              body.correction_type === 'wrong_property' ||
                              body.correction_type === 'reissued')) {
      const r = body.replacement;
      const { data: created, error: cErr } = await supabase
        .from('violations')
        .insert({
          property_id:         r.property_id || original.property_id,
          community_id:        r.community_id || original.community_id,
          primary_category_id: r.primary_category_id || original.primary_category_id,
          board_priority_at_open: r.board_priority_at_open || original.board_priority_at_open,
          current_stage:       r.current_stage || original.current_stage,
          opened_at:           r.opened_at || original.opened_at,
          opened_from_observation_id: original.opened_from_observation_id,
          source:              'manual_entry',
          confidence_weight:   1.0,
          quality_status:      'verified',
          review_notes:        `Replacement for corrected violation ${originalId}. Reason: ${body.reason}`,
        })
        .select('id')
        .single();
      if (cErr) return res.status(500).json({ error: 'failed to create replacement: ' + cErr.message });
      replacementId = created.id;
    }

    // Mark original superseded
    await supabase.from('violations')
      .update({
        quality_status: 'superseded',
        confidence_weight: 0,
        reviewed_at: new Date().toISOString(),
        reviewed_by_user_id: body.user_id || null,
        review_notes: `Superseded via ${body.correction_type}: ${body.reason}`,
      })
      .eq('id', originalId);

    // Drop a correction row
    const { data: correction, error: corrErr } = await supabase
      .from('violation_corrections')
      .insert({
        original_violation_id: originalId,
        correction_type: body.correction_type,
        replacement_violation_id: replacementId,
        reason: body.reason,
        corrected_by_user_id: body.user_id || null,
        original_state: original,
        notes: body.notes || null,
      })
      .select()
      .single();
    if (corrErr) return res.status(500).json({ error: 'failed to record correction: ' + corrErr.message });

    res.json({
      ok: true,
      correction,
      replacement_violation_id: replacementId,
    });
  } catch (err) {
    console.error('[violations.correct]', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/enforcement/violations/manual
// Body: { property_id, category_id, opened_at, current_stage, source?,
//         confidence_weight?, notes?, user_id? }
//   Manually creates a prior violation. Used to backfill known-existing
//   violations that aren't in trustEd (e.g., Vantaca records not yet imported,
//   verbal history from a homeowner). Defaults to source='manual_entry',
//   confidence_weight=0.8, quality_status='verified'.
// ---------------------------------------------------------------------------
router.post('/violations/manual', express.json(), async (req, res) => {
  try {
    const body = req.body || {};
    if (!body.property_id || !body.category_id || !body.opened_at) {
      return res.status(400).json({ error: 'property_id, category_id, opened_at required' });
    }
    const validStages = ['courtesy_1','courtesy_2','certified_209','fine_assessed','cured','closed','voided'];
    const stage = body.current_stage || 'courtesy_1';
    if (!validStages.includes(stage)) {
      return res.status(400).json({ error: 'invalid current_stage' });
    }
    // Look up community_id from property
    const { data: prop } = await supabase
      .from('properties')
      .select('community_id')
      .eq('id', body.property_id)
      .maybeSingle();
    if (!prop) return res.status(404).json({ error: 'property not found' });

    const source = body.source || 'manual_entry';
    const sourceDefaults = {
      manual_entry:        0.8,
      vantaca_import:      0.5,
      predecessor_import:  0.3,
      legacy_unknown:      0.4,
      trustEd_native:      1.0,
    };
    const weight = (typeof body.confidence_weight === 'number')
      ? Math.max(0, Math.min(1, body.confidence_weight))
      : sourceDefaults[source] || 0.8;

    const { data, error } = await supabase
      .from('violations')
      .insert({
        property_id:        body.property_id,
        community_id:       prop.community_id,
        primary_category_id: body.category_id,
        board_priority_at_open: body.board_priority_at_open || 'standard',
        current_stage:      stage,
        cure_period_ends_at: body.cure_period_ends_at || null,
        opened_at:          body.opened_at,
        resolved_at:        body.resolved_at || null,
        resolved_via:       body.resolved_via || null,
        resolved_notes:     body.resolved_notes || null,
        source,
        confidence_weight:  weight,
        quality_status:     body.quality_status || 'verified',
        reviewed_at:        new Date().toISOString(),
        reviewed_by_user_id: body.user_id || null,
        review_notes:       body.notes || 'Manually entered prior violation',
      })
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });

    res.json({ ok: true, violation: data });
  } catch (err) {
    console.error('[violations.manual]', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/extract-doc-references/:community_id/:category_id', async (req, res) => {
  try {
    const result = await _extractDocRefForCategory(req.params.community_id, req.params.category_id);
    return res.json(result);
  } catch (err) {
    console.error('[extract-doc-references.single]', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/extract-doc-references/:community_id', express.json(), async (req, res) => {
  try {
    const communityId = req.params.community_id;
    const force = !!(req.body && req.body.force);

    // List active enforcement priorities for this community + their current state
    const { data: prios, error: prioErr } = await supabase
      .from('community_enforcement_priorities')
      .select('category_id, priority_weight, governing_doc_reference, enforcement_categories(label)')
      .eq('community_id', communityId)
      .is('end_date', null);
    if (prioErr) return res.status(500).json({ error: prioErr.message });

    const targets = (prios || []).filter((p) => p.priority_weight !== 'disabled' &&
                                                 (force || !p.governing_doc_reference));
    if (targets.length === 0) {
      return res.json({ processed: 0, skipped: (prios || []).length, message: 'Nothing to extract (all categories have references already, or pass force=true).' });
    }

    const results = [];
    for (const t of targets) {
      const r = await _extractDocRefForCategory(communityId, t.category_id);
      results.push({
        category: t.enforcement_categories && t.enforcement_categories.label,
        category_id: t.category_id,
        ...r,
      });
      // gentle pacing to keep Claude + OpenAI happy
      await new Promise((r) => setTimeout(r, 300));
    }
    const found = results.filter((r) => r.ok && r.found).length;
    const notFound = results.filter((r) => r.ok && !r.found).length;
    const errored = results.filter((r) => !r.ok).length;
    res.json({ processed: results.length, found, not_found: notFound, errored, results });
  } catch (err) {
    console.error('[extract-doc-references.batch]', err);
    res.status(500).json({ error: err.message });
  }
});

// ===========================================================================
// FINE SCHEDULE + FINE ASSESSMENT (Phase 7c)
// ---------------------------------------------------------------------------
// Most TX HOAs have a fine schedule in their CC&Rs but the board has
// historically declined to fine. The schema is built to default-OFF: a
// community must explicitly turn fines_enabled = TRUE (with board minutes
// reference) before auto-fines fire. Per-category overrides let boards
// fine for some things but not others.
// ===========================================================================

// ---------------------------------------------------------------------------
// GET /api/enforcement/fine-schedule/:community_id
//   Returns the resolved per-(category) schedule for the community plus the
//   community-level toggle state. Backs the Fine Schedule UI.
// ---------------------------------------------------------------------------
router.get('/fine-schedule/:community_id', async (req, res) => {
  try {
    const communityId = req.params.community_id;
    const { data: comm } = await supabase
      .from('communities')
      .select('id, name, fines_enabled, fines_enabled_set_by_board_date, fines_enabled_board_minutes_ref, fines_disabled_reason')
      .eq('id', communityId)
      .maybeSingle();
    if (!comm) return res.status(404).json({ error: 'community not found' });

    const { data: resolved, error: rErr } = await supabase
      .from('v_resolved_fine_schedule')
      .select('*')
      .eq('community_id', communityId);
    if (rErr) return res.status(500).json({ error: rErr.message });

    res.json({ community: comm, schedule: resolved || [] });
  } catch (err) {
    console.error('[fine-schedule.get]', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/enforcement/fine-schedule/:community_id/community-toggle
//   Body: { fines_enabled, board_minutes_ref?, board_vote_date?, disabled_reason? }
//   Master toggle for the community. Records who/when/why.
// ---------------------------------------------------------------------------
router.patch('/fine-schedule/:community_id/community-toggle', express.json(), async (req, res) => {
  try {
    const communityId = req.params.community_id;
    const body = req.body || {};
    if (typeof body.fines_enabled !== 'boolean') {
      return res.status(400).json({ error: 'fines_enabled (boolean) required' });
    }
    const patch = {
      fines_enabled: body.fines_enabled,
    };
    if (body.fines_enabled) {
      patch.fines_enabled_board_minutes_ref = body.board_minutes_ref || null;
      patch.fines_enabled_set_by_board_date = body.board_vote_date || new Date().toISOString().slice(0, 10);
      patch.fines_disabled_reason = null;
    } else {
      patch.fines_disabled_reason = body.disabled_reason || 'Board has not authorized fine enforcement';
    }
    const { data, error } = await supabase
      .from('communities')
      .update(patch)
      .eq('id', communityId)
      .select('id, fines_enabled, fines_enabled_set_by_board_date, fines_enabled_board_minutes_ref, fines_disabled_reason')
      .single();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true, community: data });
  } catch (err) {
    console.error('[fine-schedule.community-toggle]', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// PUT /api/enforcement/fine-schedule/:community_id/row
//   Body: { category_id?: null|uuid, fines_enabled, first_offense_amount,
//           second_offense_amount, third_offense_amount, recurring_offense_amount,
//           board_minutes_ref?, board_vote_date?, notes? }
//   Upserts a per-(category-or-default) schedule row. Time-bounded: ends the
//   active row (if any) and inserts the new one so history is preserved.
//   category_id = null means this is the COMMUNITY-DEFAULT row.
// ---------------------------------------------------------------------------
router.put('/fine-schedule/:community_id/row', express.json(), async (req, res) => {
  try {
    const communityId = req.params.community_id;
    const body = req.body || {};
    const categoryId = body.category_id || null;
    const today = new Date().toISOString().slice(0, 10);

    // End-date any active row for this (community, category) pair
    let endQ = supabase.from('community_category_fine_schedule')
      .update({ effective_end_date: today, updated_at: new Date().toISOString() })
      .eq('community_id', communityId)
      .is('effective_end_date', null);
    if (categoryId) endQ = endQ.eq('category_id', categoryId);
    else            endQ = endQ.is('category_id', null);
    await endQ;

    // Insert the new active row
    const { data: created, error: cErr } = await supabase
      .from('community_category_fine_schedule')
      .insert({
        community_id: communityId,
        category_id: categoryId,
        fines_enabled: body.fines_enabled !== false,   // default true if the row exists
        first_offense_amount:     body.first_offense_amount   != null ? Number(body.first_offense_amount)   : null,
        second_offense_amount:    body.second_offense_amount  != null ? Number(body.second_offense_amount)  : null,
        third_offense_amount:     body.third_offense_amount   != null ? Number(body.third_offense_amount)   : null,
        recurring_offense_amount: body.recurring_offense_amount != null ? Number(body.recurring_offense_amount) : null,
        set_by_board_vote_date:   body.board_vote_date || null,
        board_meeting_minutes_ref: body.board_minutes_ref || null,
        notes: body.notes || null,
      })
      .select()
      .single();
    if (cErr) return res.status(500).json({ error: cErr.message });
    res.json({ ok: true, schedule_row: created });
  } catch (err) {
    console.error('[fine-schedule.row]', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Helper — resolve the fine amount for a (community, category, offense_count)
// triple. Returns { amount, source, community_enabled, category_enabled } so
// the engine and the manual-assess flow can both reason about it.
// ---------------------------------------------------------------------------
async function _resolveFineAmount(communityId, categoryId, offenseCount) {
  const { data: rows } = await supabase
    .from('v_resolved_fine_schedule')
    .select('community_fines_enabled, effective_fines_enabled, first_offense_amount, second_offense_amount, third_offense_amount, recurring_offense_amount, source_row')
    .eq('community_id', communityId)
    .eq('category_id', categoryId);
  if (!rows || rows.length === 0) {
    return { amount: null, source: 'no_schedule', community_enabled: false, category_enabled: false };
  }
  const r = rows[0];
  const amt = (offenseCount <= 1) ? r.first_offense_amount
            : (offenseCount === 2) ? r.second_offense_amount
            : (offenseCount === 3) ? r.third_offense_amount
            : r.recurring_offense_amount;
  return {
    amount: amt,
    source: r.source_row,
    community_enabled: r.community_fines_enabled,
    category_enabled:  r.effective_fines_enabled,
  };
}

// ---------------------------------------------------------------------------
// POST /api/enforcement/violations/:id/assess-fine
//   Body: { amount?, board_resolution_ref?, override_reason?, user_id? }
//   Assesses a fine on a violation. If amount is omitted, looks up the
//   schedule based on the offense count for this (property, category, 12mo).
//   Required if fines are disabled: board_resolution_ref + override_reason
//   (since this is a one-off override of board policy).
//   Side effects:
//     - violation.current_stage = 'fine_assessed'
//     - violation.cure_period_ends_at = NULL (cure window has passed)
//     - fine_posting_queue row created (status='queued')
//     - interactions row created (type='internal_note' for the assessment record)
// ---------------------------------------------------------------------------
router.post('/violations/:id/assess-fine', express.json(), async (req, res) => {
  try {
    const violationId = req.params.id;
    const body = req.body || {};
    const { data: v, error: vErr } = await supabase
      .from('violations')
      .select('id, property_id, community_id, primary_category_id, current_stage, quality_status')
      .eq('id', violationId)
      .maybeSingle();
    if (vErr || !v) return res.status(404).json({ error: 'violation not found' });
    if (v.quality_status === 'superseded') {
      return res.status(400).json({ error: 'violation is superseded; cannot assess fine on corrected record' });
    }
    if (v.current_stage === 'cured' || v.current_stage === 'closed' || v.current_stage === 'voided') {
      return res.status(400).json({ error: `violation is in terminal stage '${v.current_stage}'; cannot fine` });
    }

    // Count prior violations same property + category in last 12mo (this one counts as the current offense)
    const cutoff = new Date(); cutoff.setMonth(cutoff.getMonth() - 12);
    const { data: priors } = await supabase
      .from('violations')
      .select('id, opened_at, current_stage, quality_status, confidence_weight')
      .eq('property_id', v.property_id)
      .eq('primary_category_id', v.primary_category_id)
      .gte('opened_at', cutoff.toISOString())
      .neq('quality_status', 'superseded');
    const offenseCount = (priors || []).filter((p) => p.id !== v.id).length + 1;

    // Resolve amount + permission
    const resolved = await _resolveFineAmount(v.community_id, v.primary_category_id, offenseCount);
    let amount = (typeof body.amount === 'number' && body.amount > 0)
      ? Number(body.amount)
      : resolved.amount;

    const finesAreOff = !resolved.community_enabled || !resolved.category_enabled;
    const overriding = finesAreOff || (typeof body.amount === 'number' && body.amount !== resolved.amount);
    if (overriding) {
      if (!body.board_resolution_ref || !body.override_reason) {
        return res.status(400).json({
          error: 'board_resolution_ref + override_reason required when assessing fine that overrides schedule or with fines disabled',
          schedule_state: resolved,
        });
      }
    }
    if (amount == null || amount <= 0) {
      return res.status(400).json({
        error: 'No fine amount could be resolved (no schedule for this category, and no explicit amount provided).',
        schedule_state: resolved,
        offense_count: offenseCount,
      });
    }

    // Update violation
    await supabase.from('violations').update({
      current_stage: 'fine_assessed',
      current_stage_started_at: new Date().toISOString(),
      cure_period_ends_at: null,
    }).eq('id', violationId);

    // Insert fine queue entry
    const { data: queueEntry, error: qErr } = await supabase
      .from('fine_posting_queue')
      .insert({
        violation_id: violationId,
        property_id: v.property_id,
        community_id: v.community_id,
        amount: amount,
        assessed_by_user_id: body.user_id || null,
        notes: overriding
          ? `Override assessment. Board res: ${body.board_resolution_ref}. Reason: ${body.override_reason}`
          : `Auto-assessed per ${resolved.source} schedule (offense ${offenseCount}).`,
      })
      .select()
      .single();
    if (qErr) return res.status(500).json({ error: 'fine_posting_queue insert failed: ' + qErr.message });

    // Audit interaction (internal note — not customer-facing)
    await supabase.from('interactions').insert({
      community_id: v.community_id,
      property_id: v.property_id,
      violation_id: violationId,
      type: 'internal_note',
      direction: 'internal',
      subject: `Fine assessed: $${amount.toFixed(2)} (offense #${offenseCount})`,
      content: overriding
        ? `Override assessment. Board resolution: ${body.board_resolution_ref}. Reason: ${body.override_reason}. Source: ${resolved.source}.`
        : `Auto-assessed per ${resolved.source} schedule.`,
      sent_at: new Date().toISOString(),
      status: 'sent',
    });

    res.json({
      ok: true,
      violation_id: violationId,
      fine_amount: amount,
      offense_count: offenseCount,
      queue_entry_id: queueEntry.id,
      schedule_state: resolved,
      override: overriding,
    });
  } catch (err) {
    console.error('[violations.assess-fine]', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/enforcement/fine-queue?community_id=&status=
//   Lists fines in the posting queue. Default: queued + recently posted.
// ---------------------------------------------------------------------------
router.get('/fine-queue', async (req, res) => {
  try {
    const communityId = req.query.community_id;
    const status = req.query.status || 'queued';
    let q = supabase
      .from('fine_posting_queue')
      .select(`
        id, violation_id, property_id, community_id, amount, status,
        assessed_at, posted_to_vantaca_at, vantaca_charge_ref, notes,
        violations:violation_id ( primary_category_id, current_stage,
          enforcement_categories ( label ) ),
        communities:community_id ( name )
      `)
      .order('assessed_at', { ascending: false })
      .limit(200);
    if (communityId) q = q.eq('community_id', communityId);
    if (status !== 'all') q = q.eq('status', status);
    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });

    // Fetch property addresses in one round trip
    const propIds = [...new Set((data || []).map((d) => d.property_id))];
    let propMap = new Map();
    if (propIds.length > 0) {
      const { data: props } = await supabase
        .from('v_current_property_owners')
        .select('property_id, street_address, unit, owner_name, owner_mailing_address')
        .in('property_id', propIds);
      (props || []).forEach((p) => propMap.set(p.property_id, p));
    }
    const enriched = (data || []).map((q) => ({
      ...q,
      property: propMap.get(q.property_id) || null,
      category_label: q.violations && q.violations.enforcement_categories
        && q.violations.enforcement_categories.label,
    }));
    res.json({ queue: enriched });
  } catch (err) {
    console.error('[fine-queue.list]', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/enforcement/fine-queue/:id
//   Body: { status, vantaca_charge_ref?, notes? }
//   Mark a queued fine as posted to Vantaca (status='posted') or reversed.
// ---------------------------------------------------------------------------
router.patch('/fine-queue/:id', express.json(), async (req, res) => {
  try {
    const id = req.params.id;
    const body = req.body || {};
    const allowedStatuses = ['queued', 'posted', 'reversed', 'error'];
    if (body.status && !allowedStatuses.includes(body.status)) {
      return res.status(400).json({ error: 'invalid status' });
    }
    const patch = { updated_at: new Date().toISOString() };
    if (body.status) {
      patch.status = body.status;
      if (body.status === 'posted') patch.posted_to_vantaca_at = new Date().toISOString();
    }
    if (body.vantaca_charge_ref !== undefined) patch.vantaca_charge_ref = body.vantaca_charge_ref;
    if (body.notes !== undefined) patch.notes = body.notes;
    if (body.user_id) patch.posted_by_user_id = body.user_id;
    const { data, error } = await supabase
      .from('fine_posting_queue')
      .update(patch)
      .eq('id', id)
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true, queue_entry: data });
  } catch (err) {
    console.error('[fine-queue.patch]', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = { router };
