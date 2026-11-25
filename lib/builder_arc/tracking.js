// ============================================================================
// lib/builder_arc/tracking.js  (Ed 2026-11-25)
// ----------------------------------------------------------------------------
// Ownership, deadlines and escalation for builder lot submissions, on the
// existing operations work-item ledger (work_items / work_item_events, the
// Team Status and Mission Control backbone). One open item per application,
// keyed source_ref = 'builder_arc:<application id>' (unique among open items,
// migration 513).
//
// Who holds it:
//   Ed      Annie recommends approve, or the case needs his judgment.
//           Builder decisions are Ed's alone.
//   Annie   Annie needs something from the builder (request drafted for a
//           person to send) or a record fixed before a letter can issue.
//   Amanda  escalated: the Bedrock turnaround target passed, or the governing
//           documents' review period is within 7 days or past. Amanda chases;
//           the decision is still Ed's.
//
// Event-driven: opened at intake, updated by every Annie review, closed by the
// decision. The only timer is the business-day deadline sweep (escalate()),
// a genuine time-based need run by lib/scheduler.js.
// ============================================================================
const { computeDeadlines, STATE_LABEL } = require('./deadlines');

const REF = (appId) => `builder_arc:${appId}`;
const OPEN = ['new', 'in_progress', 'waiting'];
const ACTOR = 'Annie Reeves (AI architectural review)';

function ownerFor(rec, deadlines) {
  if (deadlines && ['target_missed', 'limit_near', 'limit_passed'].includes(deadlines.state)) return 'Amanda';
  if (rec === 'request_more_info') return 'Annie';
  if (rec === 'manual_review_fix') return 'Annie';
  return 'Ed';
}

function urgencyFor(deadlines) {
  if (!deadlines) return 'normal';
  if (deadlines.state === 'limit_passed' || deadlines.state === 'limit_near') return 'critical';
  if (deadlines.state === 'target_missed') return 'high';
  return 'normal';
}

function nextStepFor(rec, result) {
  if (rec === 'approve') return 'Ed: open the application, review Annie\'s findings, approve (individually or in a batch).';
  if (rec === 'request_more_info') return 'Send the drafted request to the builder (Annie drafted it; a person sends it).';
  if (rec === 'manual_review' && result && result.findings && result.findings.some((f) => f.severity === 'blocker' && f.fix_by === 'bedrock')) return 'Bedrock: fix the record Annie flagged so a letter can issue, then re-run her review.';
  return 'Ed: decide the guideline question Annie flagged.';
}

async function event(supabase, workItemId, ev, detail) {
  const { error } = await supabase.from('work_item_events').insert({ work_item_id: workItemId, event: ev, actor: ACTOR, detail: detail || {} });
  if (error) console.warn('[builder_arc.tracking] event insert failed:', error.message);
}

async function findOpen(supabase, appId) {
  const { data, error } = await supabase.from('work_items').select('*').eq('source_ref', REF(appId)).in('status', OPEN).limit(1);
  if (error) throw error;
  return data[0] || null;
}

/**
 * Open or refresh the application's work item. `result` is Annie's evaluate()
 * output or null (intake, before a review).
 */
async function upsertWorkItem(supabase, { app, community, standards, result }) {
  const deadlines = computeDeadlines(app, community || {}, standards || {});
  const blockerFix = result && result.findings && result.findings.some((f) => f.severity === 'blocker' && f.fix_by === 'bedrock');
  const rec = result ? (blockerFix ? 'manual_review_fix' : result.recommended_action) : null;
  const owner = result ? ownerFor(rec, deadlines) : (deadlines && deadlines.state !== 'on_track' ? 'Amanda' : 'Annie');
  const addr = String(app.street_address || '').split(',')[0];
  const why = [
    `${(community && community.name) || 'Community'} builder lot submission ${app.reference_number}, received ${String(app.submitted_at).slice(0, 10)}.`,
    deadlines ? `Bedrock target ${String(deadlines.target_due_at).slice(0, 10)}.` : null,
    deadlines && deadlines.limit_at ? `${deadlines.limit_days}-day review period ends ${String(deadlines.limit_at).slice(0, 10)}${standards && standards.legal_review_ref ? ` (${standards.legal_review_ref})` : ''}; not approved by then = deemed disapproved.` : null,
    'Builder decisions are Ed\'s.',
  ].filter(Boolean).join(' ');
  const row = {
    community_id: app.community_id, community_name: (community && community.name) || null,
    source_type: 'acc', item_type: 'builder_arc', workspace: 'operations', module_key: 'builder_arc', horizon: 'now',
    title: `Builder ARC: ${addr} (${app.reference_number})`,
    summary: result ? `Annie: ${result.summary}` : 'Received; Annie reviews it when the packet arrives.',
    assigned_to: owner, urgency: urgencyFor(deadlines),
    status: rec === 'request_more_info' ? 'waiting' : 'new',
    received_at: app.submitted_at, sla_due_at: deadlines ? deadlines.target_due_at : null,
    source_ref: REF(app.id), requested_by: 'Builder portal', why,
    next_step: result ? nextStepFor(result.recommended_action, result) : 'Annie reviews the packet.',
    action_url: `/builder-arc-review.html?id=${app.id}`, record_ownership: 'workpaper', created_by: ACTOR,
  };
  const open = await findOpen(supabase, app.id);
  if (open) {
    const patch = { ...row }; delete patch.created_by; delete patch.received_at;
    const { error } = await supabase.from('work_items').update(patch).eq('id', open.id);
    if (error) throw error;
    await event(supabase, open.id, 'agent_touch', { recommended_action: result && result.recommended_action, owner, deadline_state: deadlines && deadlines.state });
    return { id: open.id, owner, deadlines, action: 'updated' };
  }
  const { data, error } = await supabase.from('work_items').insert(row).select('id').single();
  if (error) {
    if (String(error.code) === '23505') return upsertWorkItem(supabase, { app, community, standards, result });
    throw error;
  }
  await event(supabase, data.id, 'created', { reference_number: app.reference_number, owner });
  return { id: data.id, owner, deadlines, action: 'created' };
}

/** The decision closes the item (approve / conditions / deny). */
async function closeWorkItem(supabase, appId, { status_label, decided_by }) {
  const open = await findOpen(supabase, appId);
  if (!open) return null;
  const { error } = await supabase.from('work_items').update({ status: 'done', completed_at: new Date().toISOString(), next_step: `Decided: ${status_label} by ${decided_by}.` }).eq('id', open.id);
  if (error) throw error;
  await event(supabase, open.id, 'status_changed', { to: 'done', decision: status_label, decided_by });
  return open.id;
}

/**
 * Business-day deadline sweep. Escalates to Amanda any open builder
 * application past Bedrock's target or near / past the review period, once per
 * level (recorded on the item's events), and emails Ed one digest of the new
 * escalations. Returns a summary for cron_runs.
 */
async function escalate(supabase, { now = new Date(), send = null } = {}) {
  const { loadStandards } = require('./standards');
  const { data: apps, error } = await supabase.from('builder_applications')
    .select('id, community_id, reference_number, street_address, status, submitted_at, fast_track, assessment_recommended_action')
    .in('status', ['received', 'under_review']).order('submitted_at').limit(1000);
  if (error) throw error;
  const cache = new Map(); const newly = [];
  for (const app of apps) {
    if (!cache.has(app.community_id)) cache.set(app.community_id, await loadStandards(supabase, app.community_id));
    const { community, standards } = cache.get(app.community_id);
    const d = computeDeadlines(app, community || {}, standards || {}, now);
    if (!d || d.state === 'on_track') continue;
    let item = await findOpen(supabase, app.id);
    if (!item) { await upsertWorkItem(supabase, { app, community, standards, result: null }); item = await findOpen(supabase, app.id); }
    const { data: evs, error: ee } = await supabase.from('work_item_events').select('detail').eq('work_item_id', item.id).limit(200);
    if (ee) throw ee;
    const already = (evs || []).some((e) => e.detail && e.detail.escalation === d.state);
    if (already) continue;
    const { error: ue } = await supabase.from('work_items').update({ assigned_to: 'Amanda', urgency: urgencyFor(d) }).eq('id', item.id);
    if (ue) throw ue;
    await event(supabase, item.id, 'updated', { escalation: d.state, to: 'Amanda', days_to_limit: d.days_to_limit, target_due_at: d.target_due_at });
    newly.push({ app, community, d });
  }
  let emailed = false;
  if (newly.length && send) {
    const lines = newly.map(({ app, community, d }) => `${app.reference_number}  ${String(app.street_address || '').split(',')[0]}  (${community && community.name}): ${STATE_LABEL[d.state]}${d.limit_at ? `; review period ends ${String(d.limit_at).slice(0, 10)}` : ''}; Annie: ${String(app.assessment_recommended_action || 'not reviewed').replace(/_/g, ' ')}`);
    const r = await send({
      subject: `Builder ARC: ${newly.length} application${newly.length === 1 ? '' : 's'} escalated to Amanda`,
      text: `These builder applications are past Bedrock's turnaround target or near the end of the review period. Amanda now owns the follow-up; the decisions are still yours.\n\n${lines.join('\n')}\n\nOpen trustEd: /builder-arc-review.html`,
    });
    emailed = !!(r && r.ok);
  }
  return { checked: apps.length, escalated: newly.length, emailed };
}

module.exports = { upsertWorkItem, closeWorkItem, escalate, ownerFor, urgencyFor, REF };
