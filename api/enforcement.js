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

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

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

module.exports = { router };
