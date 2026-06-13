// ============================================================================
// lib/enforcement/find_or_continue_violation.js
// ----------------------------------------------------------------------------
// Ed 2026-06-13: when re-inspecting a community we cannot send a second
// letter for a violation that already has an open case. The §209 cure period
// was given; another courtesy notice signals the certified letter was a
// bluff. Instead, the system records the re-observation as a
// "continuation" — proof-of-continuity evidence that the violation persists.
//
// Single helper that every violation-creation path calls FIRST before
// inserting a new violations row. If an open violation already exists at
// the same (property_id, primary_category_id), the helper:
//   1. inserts a violation_continuations row pointing at the existing case
//   2. bumps violations.continuation_count + last_continued_at
//   3. returns { type: 'continuation', violation_id } so the caller skips
//      letter drafting
//
// If no open violation exists, returns { type: 'new', violation_id: null }
// and the caller proceeds with the normal new-violation path.
//
// "Open" = current_stage NOT IN ('cured','closed','voided').
//
// CALLED FROM (canonical paths — keep this list current if you add more):
//   - api/inspections.js POST /inspections/observations/:id/confirm  (per-photo confirm)
//   - api/enforcement.js POST /open-violation                        (operator manual)
//   - api/enforcement.js POST /violations/manual                     (with photos)
//   - api/enforcement.js POST /vantaca-violations/apply              (bulk import — TODO v2)
//
// If a caller skips this helper and inserts a violations row directly, you
// will create a duplicate case and re-issue a letter for an already-cited
// violation. That's the exact failure mode this helper exists to prevent.
// ============================================================================

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const OPEN_VIOLATION_STAGES_EXCLUDED = ['cured', 'closed', 'voided'];

/**
 * @typedef {Object} ContinuationInput
 * @property {string} propertyId          required
 * @property {string} categoryId          required (enforcement_categories.id)
 * @property {string|null} observationId  the property_observations.id that triggered this check
 * @property {string|null} inspectionPhotoId
 * @property {string|null} inspectionId
 * @property {string|null} userId         acting user (operator confirming)
 * @property {string} source              'inspection' | 'manual' | 'vantaca_import' | 'homeowner_report' | 'board_report'
 * @property {string|null} notes
 */

/**
 * @typedef {Object} ContinuationResult
 * @property {'continuation'|'new'} type
 * @property {string|null} violation_id   set if type='continuation'
 * @property {string|null} continuation_id set if type='continuation'
 * @property {number|null} continuation_count_after  set if type='continuation'
 */

/**
 * Find an existing open violation at (propertyId, categoryId). If found,
 * log a continuation and return { type: 'continuation' }. If not, return
 * { type: 'new' } so the caller creates a new violation.
 *
 * @param {ContinuationInput} input
 * @returns {Promise<ContinuationResult>}
 */
async function findOrContinueViolation(input) {
  const {
    propertyId,
    categoryId,
    observationId = null,
    inspectionPhotoId = null,
    inspectionId = null,
    userId = null,
    source = 'inspection',
    notes = null,
  } = input || {};

  if (!propertyId || !categoryId) {
    throw new Error('findOrContinueViolation: propertyId and categoryId required');
  }

  // 1. Look up the most recent open violation at this property+category.
  // The compound index idx_violations_community_open keeps this fast.
  const { data: existing, error: lookupErr } = await supabase
    .from('violations')
    .select('id, current_stage, continuation_count')
    .eq('property_id', propertyId)
    .eq('primary_category_id', categoryId)
    .not('current_stage', 'in', `(${OPEN_VIOLATION_STAGES_EXCLUDED.map((s) => `"${s}"`).join(',')})`)
    .order('opened_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (lookupErr) {
    throw new Error(`findOrContinueViolation lookup failed: ${lookupErr.message}`);
  }

  if (!existing) {
    return { type: 'new', violation_id: null, continuation_id: null, continuation_count_after: null };
  }

  // 2. Existing open case found — log continuation evidence.
  const { data: continuation, error: insertErr } = await supabase
    .from('violation_continuations')
    .insert({
      violation_id:        existing.id,
      observation_id:      observationId,
      inspection_photo_id: inspectionPhotoId,
      inspection_id:       inspectionId,
      noted_by_user_id:    userId,
      source,
      notes,
    })
    .select('id')
    .single();

  if (insertErr) {
    // Unique-index conflict on observation_id means the same observation was
    // already logged as a continuation for this same violation. Idempotent —
    // treat as success, fetch the existing continuation row.
    if (insertErr.code === '23505' && observationId) {
      const { data: existingCont } = await supabase
        .from('violation_continuations')
        .select('id')
        .eq('observation_id', observationId)
        .maybeSingle();
      return {
        type: 'continuation',
        violation_id: existing.id,
        continuation_id: existingCont?.id || null,
        continuation_count_after: existing.continuation_count || 0,
      };
    }
    throw new Error(`violation_continuations insert failed: ${insertErr.message}`);
  }

  // 3. Bump the denormalized counters on the violation row so the board
  // packet query doesn't have to aggregate every time.
  const newCount = (existing.continuation_count || 0) + 1;
  const { error: bumpErr } = await supabase
    .from('violations')
    .update({
      continuation_count: newCount,
      last_continued_at:  new Date().toISOString(),
    })
    .eq('id', existing.id);

  if (bumpErr) {
    // Don't fail the whole call — the continuation row is the truth source;
    // the counter is a convenience. Log so we can rebuild if it drifts.
    console.warn('[findOrContinueViolation] counter bump failed for violation', existing.id, bumpErr.message);
  }

  return {
    type: 'continuation',
    violation_id: existing.id,
    continuation_id: continuation.id,
    continuation_count_after: newCount,
  };
}

module.exports = { findOrContinueViolation };
