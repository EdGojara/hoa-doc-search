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
const { expandCategoryToAliases } = require('./category_aliases');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const OPEN_VIOLATION_STAGES_EXCLUDED = ['cured', 'closed', 'voided'];
// Furthest-advanced open case wins as the continuation target — never continue
// a courtesy case when a certified one is already open for the same issue.
const STAGE_RANK = { courtesy_1: 1, courtesy_2: 2, certified_209: 3, fine_assessed: 4 };

// Statutory repeat window — Tex. Prop. Code §209.006(d): no new cure period for a
// same/similar violation within the preceding six months. Days, not months, so
// the boundary is deterministic.
const RECURRENCE_LOOKBACK_DAYS = 183;

// Pure decision: given a flagged category and the prior CURED date, is this a
// within-window recurrence? Extracted so it's unit-testable without the DB.
function isRecurrence({ escalates, priorResolvedAt, nowMs = Date.now(), lookbackDays = RECURRENCE_LOOKBACK_DAYS }) {
  if (!escalates || !priorResolvedAt) return false;
  const t = new Date(priorResolvedAt).getTime();
  if (!Number.isFinite(t)) return false;
  return (nowMs - t) <= lookbackDays * 864e5 && t <= nowMs;
}

// Look up whether a fresh observation is an escalation-eligible recurrence:
// the category (or any confirmed alias) is flagged recurrence_escalates AND a
// prior case in that alias group was CURED within the lookback window. Returns
// null when it isn't (so the caller opens a normal fresh courtesy). Best-effort:
// any failure returns null (default to the safe, non-escalating path).
async function detectRecurrence({ propertyId, categoryId, groupIds }) {
  try {
    const ids = (groupIds && groupIds.length) ? groupIds : [categoryId];
    const { data: cats } = await supabase
      .from('enforcement_categories').select('recurrence_escalates').in('id', ids);
    const escalates = (cats || []).some((c) => c && c.recurrence_escalates === true);
    if (!escalates) return null;

    let priorQ = supabase
      .from('violations')
      .select('id, current_stage, resolved_at')
      .eq('property_id', propertyId)
      .eq('current_stage', 'cured')
      .not('resolved_at', 'is', null)
      .gte('resolved_at', new Date(Date.now() - RECURRENCE_LOOKBACK_DAYS * 864e5).toISOString())
      .order('resolved_at', { ascending: false })
      .limit(1);
    priorQ = (groupIds && groupIds.length > 1)
      ? priorQ.in('primary_category_id', groupIds)
      : priorQ.eq('primary_category_id', categoryId);
    const { data: priors, error } = await priorQ;
    if (error) { console.warn('[detectRecurrence] prior lookup failed:', error.message); return null; }
    const prior = (priors || [])[0];
    if (!prior || !isRecurrence({ escalates: true, priorResolvedAt: prior.resolved_at })) return null;

    return {
      is_repeat: true,
      escalates: true,
      lookback_days: RECURRENCE_LOOKBACK_DAYS,
      prior_violation_id: prior.id,
      prior_stage: prior.current_stage,
      prior_resolved_at: prior.resolved_at,
    };
  } catch (e) {
    console.warn('[detectRecurrence] skipped:', e.message);
    return null;
  }
}

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

// Find the single OPEN case a re-observation at (property, category) belongs to
// — ALIAS-AWARE and furthest-advanced-wins. A confirmed category alias (Vantaca
// "Trash Cans/Recycling Containers" == trustEd "trash_visible") means an open
// case under ANY sibling label is the SAME real-world violation; keying on the
// raw categoryId missed those and opened duplicates (Ed 2026-07-01, 7610 Wolf
// Creek). Read-only — the single source of "which case is this" for BOTH the
// continuation log (findOrContinueViolation) and the re-inspection preview.
// Returns the open violation row, or null when the case is genuinely new.
async function findOpenCaseForCategory({ propertyId, categoryId, groupIds }) {
  const ids = groupIds || await expandCategoryToAliases(categoryId);
  let lookup = supabase
    .from('violations')
    .select('id, current_stage, continuation_count, current_stage_started_at, cure_period_ends_at, primary_category_id')
    .eq('property_id', propertyId)
    .not('current_stage', 'in', `(${OPEN_VIOLATION_STAGES_EXCLUDED.map((s) => `"${s}"`).join(',')})`)
    .is('resolved_at', null);
  lookup = (ids && ids.length > 1)
    ? lookup.in('primary_category_id', ids)
    : lookup.eq('primary_category_id', categoryId);
  const { data: openRows, error: lookupErr } = await lookup
    .order('opened_at', { ascending: false })
    .limit(20);
  if (lookupErr) throw new Error(`findOpenCaseForCategory lookup failed: ${lookupErr.message}`);
  // Continue the FURTHEST-ADVANCED open case; ties broken by newest (openRows is
  // already opened_at-desc, and Array.sort is stable).
  return (openRows || []).slice().sort(
    (a, b) => (STAGE_RANK[b.current_stage] || 0) - (STAGE_RANK[a.current_stage] || 0),
  )[0] || null;
}

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

  // 1. Look up the open violation at this property+category — ALIAS-AWARE.
  const groupIds = await expandCategoryToAliases(categoryId);
  const existing = await findOpenCaseForCategory({ propertyId, categoryId, groupIds });

  if (!existing) {
    // No OPEN case. Before declaring a fresh 'new', check for a RECURRENCE:
    // a movable/concealable violation (recurrence_escalates) whose prior case was
    // CURED within the statutory 6-month window. Under Tex. Prop. Code §209.006(d)
    // a same/similar violation within 6 months needs no new cure period, so a
    // repeat of a movable violation (trailer moved out for the notice, then rolled
    // back) is escalation-eligible — while natural-cadence categories (grass,
    // trash cans; not flagged) always get a fresh courtesy. DETECTION ONLY: the
    // caller decides how to escalate + fires the repeat notice. (Ed 2026-07-25.)
    const recurrence = await detectRecurrence({ propertyId, categoryId, groupIds });
    return { type: 'new', violation_id: null, continuation_id: null, continuation_count_after: null, recurrence };
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
        existing_stage: existing.current_stage,
        existing_stage_started_at: existing.current_stage_started_at || null,
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
    existing_stage: existing.current_stage,
    existing_stage_started_at: existing.current_stage_started_at || null,
  };
}

module.exports = { findOrContinueViolation, findOpenCaseForCategory, isRecurrence, detectRecurrence, RECURRENCE_LOOKBACK_DAYS };
