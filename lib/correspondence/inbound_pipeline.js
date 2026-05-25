// ============================================================================
// lib/correspondence/inbound_pipeline.js
// ----------------------------------------------------------------------------
// Orchestrates classify → context-gather → draft for every inbound
// interaction. Called fire-and-forget from inbound write paths:
//   - lib/voice/call_log.js (after the call summary writes to interactions)
//   - api/email_intake.js   (when an inbound email lands — migration pending)
//   - api/portal.js         (when a homeowner submits a portal request — migration pending)
//
// Two-stage pipeline:
//   1. Classify — Haiku, cheap+fast, ALWAYS runs (populates
//      interactions.ai_classification)
//   2. Draft    — Sonnet, expensive+slow, CONDITIONAL on classification
//      (skips low-urgency + spam + compliments + broadcast_acknowledgment)
//
// Drafts are written as child interactions (type='ai_draft',
// parent_interaction_id pointing to inbound, status='draft'). Staff opens
// the Homeowner Profile interactions stream → sees the inbound + the
// AI draft attached → edits + approves + sends via dual_rail helper.
//
// Failure handling: each stage failure is non-fatal. Classification failure
// leaves ai_classification NULL (visible via idx_interactions_ai_unclassified_inbound
// for backfill). Draft failure leaves the inbound un-drafted; staff drafts
// manually as usual.
// ============================================================================

const { classifyInteraction } = require('./classify');
const { draftResponseForInteraction } = require('./draft_response');

// Categories/urgencies that DON'T warrant an auto-draft. Saves cost +
// avoids cluttering the operator inbox with low-value drafts.
const SKIP_DRAFT_CATEGORIES = new Set([
  'spam',
  'compliment',
  'broadcast_acknowledgment',
]);
const SKIP_DRAFT_URGENCIES = new Set(['low']);

/**
 * Run the inbound pipeline for a freshly-written interaction. Fire-and-forget
 * from callers — does its own logging + persistence; returns a summary for
 * tests / debugging.
 *
 * @param {object} supabase
 * @param {object} interaction — must have id, community_id, content, subject, type
 * @param {object} [opts]
 * @param {object} [opts.logger=console]
 * @param {boolean} [opts.draftEnabled=true] — set false to skip the draft step entirely
 * @returns {Promise<{classification: object|null, draft_id: string|null, skipped_draft_reason: string|null}>}
 */
async function processInboundInteraction(supabase, interaction, opts = {}) {
  const logger = opts.logger || console;
  const draftEnabled = opts.draftEnabled !== false;

  if (!interaction || !interaction.id) {
    logger.warn('[inbound_pipeline] missing interaction.id — abort');
    return { classification: null, draft_id: null, skipped_draft_reason: 'no_interaction_id' };
  }

  // Enrich with names for the classifier prompt (lookup is cheap; helps the
  // classifier reason about routing)
  let enriched = { ...interaction };
  try {
    if (interaction.contact_id && !enriched.contact_name) {
      const { data: c } = await supabase
        .from('contacts').select('full_name').eq('id', interaction.contact_id).maybeSingle();
      if (c) enriched.contact_name = c.full_name;
    }
    if (interaction.community_id && !enriched.community_name) {
      const { data: comm } = await supabase
        .from('communities').select('name').eq('id', interaction.community_id).maybeSingle();
      if (comm) enriched.community_name = comm.name;
    }
  } catch (_) { /* enrichment failures are non-fatal */ }

  // ---- Step 1: classify ----
  let classification = null;
  try {
    classification = await classifyInteraction(enriched, { logger });
  } catch (err) {
    logger.warn(`[inbound_pipeline ${interaction.id}] classify threw: ${err.message}`);
  }

  if (classification) {
    try {
      await supabase
        .from('interactions')
        .update({ ai_classification: classification })
        .eq('id', interaction.id);
    } catch (err) {
      logger.warn(`[inbound_pipeline ${interaction.id}] classification persist failed: ${err.message}`);
    }
  }

  // ---- Step 2: should we draft? ----
  if (!draftEnabled) {
    return { classification, draft_id: null, skipped_draft_reason: 'draft_disabled' };
  }
  if (!classification) {
    return { classification, draft_id: null, skipped_draft_reason: 'no_classification' };
  }
  if (SKIP_DRAFT_CATEGORIES.has(classification.category)) {
    return { classification, draft_id: null, skipped_draft_reason: `category=${classification.category}` };
  }
  if (SKIP_DRAFT_URGENCIES.has(classification.urgency)) {
    return { classification, draft_id: null, skipped_draft_reason: `urgency=${classification.urgency}` };
  }

  // ---- Step 3: gather drafting context ----
  const context = {
    community_name: enriched.community_name,
    homeowner_name: enriched.contact_name,
  };
  try {
    const [tagsRes, arRes, threadRes] = await Promise.all([
      interaction.contact_id
        ? supabase.from('homeowner_tags').select('tag_key').eq('contact_id', interaction.contact_id).is('revoked_at', null)
        : Promise.resolve({ data: [] }),
      interaction.property_id
        ? supabase.from('owner_ar_snapshots')
            .select('balance_total, enforcement_stage, at_legal, in_collections')
            .eq('property_id', interaction.property_id)
            .order('snapshot_date', { ascending: false })
            .limit(1)
            .maybeSingle()
        : Promise.resolve({ data: null }),
      interaction.thread_id
        ? supabase.from('interactions')
            .select('direction, subject, content, sent_at')
            .eq('thread_id', interaction.thread_id)
            .neq('id', interaction.id)
            .order('sent_at', { ascending: false, nullsFirst: false })
            .limit(5)
        : Promise.resolve({ data: [] }),
    ]);
    context.homeowner_tags = tagsRes.data || [];
    context.latest_ar = arRes.data || null;
    context.thread_interactions = threadRes.data || [];
  } catch (err) {
    logger.warn(`[inbound_pipeline ${interaction.id}] context gather failed: ${err.message}`);
  }

  // ---- Step 4: draft ----
  let draft = null;
  try {
    draft = await draftResponseForInteraction(enriched, context, { logger });
  } catch (err) {
    logger.warn(`[inbound_pipeline ${interaction.id}] draft threw: ${err.message}`);
  }
  if (!draft) {
    return { classification, draft_id: null, skipped_draft_reason: 'draft_failed' };
  }

  // ---- Step 5: persist draft as child interaction ----
  try {
    const { data: draftRow, error: dErr } = await supabase
      .from('interactions')
      .insert({
        community_id: interaction.community_id,
        contact_id: interaction.contact_id || null,
        property_id: interaction.property_id || null,
        violation_id: interaction.violation_id || null,
        type: 'ai_draft',
        direction: 'outbound',
        subject: draft.subject,
        content: draft.content,
        status: 'draft',
        ai_drafted: true,
        ai_model: draft.drafted_by_model,
        parent_interaction_id: interaction.id,
        thread_id: interaction.thread_id || interaction.id,
        source: 'forward',
        notes: `auto-drafted; tone=${draft.tone_notes || 'n/a'}; needs_human_review=${draft.needs_human_review_before_send}${draft.needs_review_reason ? '; reason=' + draft.needs_review_reason : ''}`,
      })
      .select('id')
      .single();
    if (dErr) {
      logger.warn(`[inbound_pipeline ${interaction.id}] draft insert failed: ${dErr.message}`);
      return { classification, draft_id: null, skipped_draft_reason: 'draft_insert_failed' };
    }
    logger.log(`[inbound_pipeline ${interaction.id}] classified=${classification.category} drafted=${draftRow.id} review=${draft.needs_human_review_before_send}`);
    return { classification, draft_id: draftRow.id, skipped_draft_reason: null };
  } catch (err) {
    logger.warn(`[inbound_pipeline ${interaction.id}] draft persistence threw: ${err.message}`);
    return { classification, draft_id: null, skipped_draft_reason: 'draft_persist_exception' };
  }
}

module.exports = {
  processInboundInteraction,
  SKIP_DRAFT_CATEGORIES,
  SKIP_DRAFT_URGENCIES,
};
