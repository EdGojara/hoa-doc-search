// ============================================================================
// lib/builder_arc/tracking.js  (Ed 2026-11-25)
// ----------------------------------------------------------------------------
// Ownership, deadlines, escalation and Ed's notifications for builder lot
// submissions, on the existing operations work-item ledger (work_items /
// work_item_events). One open item per application, source_ref
// 'builder_arc:<application id>' (unique among open items, migration 513).
//
// Who holds it (Ed 2026-11-25):
//   Annie   owns every open application from receipt until the decision is
//           communicated to the builder.
//   Amanda  oversees deadlines: an application at risk of missing Bedrock's
//           2-business-day standard (before it is overdue), past it, with an
//           info request to the builder overdue, or near / past the
//           association's review period is escalated to her (urgency, an
//           escalation event, Ed's alert). Ownership stays with Annie.
//   Ed      decides. Builder decisions are Ed's alone.
//
// The clocks are lib/builder_arc/deadlines.js. Event-driven: opened at intake,
// refreshed by every Annie review, kept open after a decision until the letter
// is emailed, closed when it is. The only timer is the business-day sweep
// (sweep()), run by lib/scheduler.js morning, midday and afternoon; the
// morning run also sends Ed's daily digest.
// ============================================================================
const { computeDeadlines, STATE_LABEL, STANDARD_LABEL } = require('./deadlines');

const REF = (appId) => `builder_arc:${appId}`;
const OPEN = ['new', 'in_progress', 'waiting'];
const ACTOR = 'Annie Reeves (AI architectural review)';
const TRACK_DECISIONS_FROM = '2026-11-25T00:00:00Z';
const OPEN_STATUSES = ['received', 'under_review', 'info_requested', 'approved', 'approved_with_conditions', 'denied'];

function ownerFor() { return 'Annie'; }
function overseerFor(d) { return d && d.levels && d.levels.length ? 'Amanda' : null; }
function urgencyFor(d) {
  if (!d) return 'normal';
  const L = d.levels || [];
  if (L.some((l) => ['governing:passed', 'governing:near', 'standard:missed', 'standard:info_request_overdue'].includes(l))) return 'critical';
  if (L.includes('standard:at_risk') || (d.standard && d.standard.state === 'info_request_due')) return 'high';
  return 'normal';
}

// ---------------------------------------------------------------------------
// Clock facts for a set of applications (one round trip per source).
//   last_info_at      latest packet upload AFTER the builder was asked for more
//   info_requested_at when the builder was told what is outstanding: a sent
//                     Draft Queue request for the application, or a recorded
//                     info request emailed to the builder
//   communicated_at   when the decision letter was emailed to the builder
// ---------------------------------------------------------------------------
async function clockFacts(supabase, apps) {
  const ids = apps.map((a) => a.id || a.application_id).filter(Boolean);
  const out = new Map(ids.map((id) => [id, { info_requested_at: null, last_info_at: null, communicated_at: null }]));
  if (!ids.length) return out;
  const [resp, drafts, atts, items] = await Promise.all([
    supabase.from('builder_application_responses').select('application_id, response_type, decided_at, email_sent_at').in('application_id', ids).limit(2000),
    supabase.from('outbound_email_drafts').select('related_id, status, sent_at').eq('related_type', 'builder_application').in('related_id', ids).eq('status', 'sent').limit(2000),
    supabase.from('builder_application_attachments').select('application_id, uploaded_at').in('application_id', ids).limit(5000),
    supabase.from('work_items').select('id, source_ref').in('source_ref', ids.map(REF)).limit(5000),
  ]);
  for (const r of [resp, drafts, atts, items]) if (r.error) throw r.error;
  // Info requests sent inside another email (e.g. one consolidated reply to the
  // builder covering several lots) are recorded as events on each application's
  // work item, with the actual send time (recordInfoRequestSent).
  const appByItem = new Map(items.data.map((w) => [w.id, w.source_ref.replace('builder_arc:', '')]));
  if (appByItem.size) {
    const ev = await supabase.from('work_item_events').select('work_item_id, detail').in('work_item_id', [...appByItem.keys()]).limit(5000);
    if (ev.error) throw ev.error;
    for (const e of ev.data) {
      const at = e.detail && e.detail.info_request_sent_at;
      const f = out.get(appByItem.get(e.work_item_id));
      if (f && at) f.info_requested_at = !f.info_requested_at || new Date(at) < new Date(f.info_requested_at) ? at : f.info_requested_at;
    }
  }
  const earliest = (a, b) => (!a ? b : !b ? a : (new Date(a) < new Date(b) ? a : b));
  const latest = (a, b) => (!a ? b : !b ? a : (new Date(a) > new Date(b) ? a : b));
  for (const r of resp.data) {
    const f = out.get(r.application_id); if (!f) continue;
    if (r.response_type === 'info_requested') { if (r.email_sent_at) f.info_requested_at = earliest(f.info_requested_at, r.email_sent_at); }
    else if (r.email_sent_at) f.communicated_at = latest(f.communicated_at, r.email_sent_at);
  }
  for (const d of drafts.data) { const f = out.get(d.related_id); if (f && d.sent_at) f.info_requested_at = earliest(f.info_requested_at, d.sent_at); }
  for (const a of atts.data) {
    const f = out.get(a.application_id);
    if (f && f.info_requested_at && new Date(a.uploaded_at) > new Date(f.info_requested_at)) f.last_info_at = latest(f.last_info_at, a.uploaded_at);
  }
  return out;
}

function deadlinesFor(app, community, standards, facts, now) {
  return computeDeadlines(app, community || {}, standards || {}, now || new Date(), { ...(facts || {}), recommended_action: app.assessment_recommended_action || null });
}

function nextStepFor(app, result, d) {
  if (d && d.standard.state === 'info_request_due') return `Send the builder Annie's request for the missing items by ${String(d.standard.info_request_due_at).slice(0, 10)} (it is waiting in the Draft Queue).`;
  if (d && d.standard.state === 'info_request_overdue') return 'Overdue: send the builder Annie\'s request for the missing items now (Draft Queue).';
  if (d && d.standard.state === 'waiting_on_builder') return 'Waiting on the builder for the missing items; Annie re-reviews when they arrive.';
  if (String(app.status || '').startsWith('approved') || app.status === 'denied') return 'Decided: email the decision letter to the builder (Send to builder).';
  const rec = result ? result.recommended_action : app.assessment_recommended_action;
  if (result && result.findings && result.findings.some((f) => f.severity === 'blocker' && f.fix_by === 'bedrock')) return 'Bedrock: fix the record Annie flagged so a letter can issue, then re-run her review.';
  if (rec === 'approve') return `Ed: approve (Annie found it ready)${d && d.standard.due_at ? `; decision due to the builder by ${String(d.standard.due_at).slice(0, 10)}` : ''}.`;
  if (rec === 'manual_review') return `Ed: decide the guideline question Annie flagged${d && d.standard.due_at ? `; decision due to the builder by ${String(d.standard.due_at).slice(0, 10)}` : ''}.`;
  return 'Annie reviews the packet.';
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

/** Open or refresh the application's work item. `result` = Annie's evaluate() output or null. */
async function upsertWorkItem(supabase, { app, community, standards, result, facts }) {
  const f = facts || (await clockFacts(supabase, [app])).get(app.id);
  const appNow = result ? { ...app, assessment_recommended_action: result.recommended_action } : app;
  const d = deadlinesFor(appNow, community, standards, f);
  const owner = ownerFor();
  const overseer = overseerFor(d);
  const addr = String(app.street_address || '').split(',')[0];
  const why = [
    `${(community && community.name) || 'Community'} builder lot submission ${app.reference_number}, received ${String(app.submitted_at).slice(0, 10)}.`,
    d && d.standard.due_at ? `Bedrock standard: decision approved and communicated by ${String(d.standard.due_at).slice(0, 10)} (2 business days from the complete application).` : null,
    d && d.standard.info_request_due_at ? `Incomplete: the builder must be told what is outstanding by ${String(d.standard.info_request_due_at).slice(0, 10)}.` : null,
    d && d.governing.limit_at ? `Association review period (governing documents): ends ${String(d.governing.limit_at).slice(0, 10)}${standards && standards.legal_review_ref ? ` (${standards.legal_review_ref})` : ''}; not approved by then = deemed disapproved.` : null,
    'Builder decisions are Ed\'s.',
  ].filter(Boolean).join(' ');
  const row = {
    community_id: app.community_id, community_name: (community && community.name) || null,
    source_type: 'acc', item_type: 'builder_arc', workspace: 'operations', module_key: 'builder_arc', horizon: 'now',
    title: `Builder ARC: ${addr} (${app.reference_number})`,
    summary: result ? `Annie: ${result.summary}` : (app.assessment_recommended_action ? `Annie: ${String(app.assessment_recommended_action).replace(/_/g, ' ')}` : 'Received; Annie reviews it when the packet arrives.'),
    assigned_to: owner, urgency: urgencyFor(d),
    status: d && d.standard.state === 'waiting_on_builder' ? 'waiting' : 'new',
    received_at: app.submitted_at, sla_due_at: d ? (d.standard.due_at || d.standard.info_request_due_at) : null,
    source_ref: REF(app.id), requested_by: 'Builder submission', why,
    next_step: nextStepFor(appNow, result, d) + (overseer ? ' Amanda is overseeing the deadline.' : ''),
    action_url: `/builder-arc-review.html?id=${app.id}`, record_ownership: 'workpaper', created_by: ACTOR,
  };
  const open = await findOpen(supabase, app.id);
  if (open) {
    const patch = { ...row }; delete patch.created_by; delete patch.received_at;
    const { error } = await supabase.from('work_items').update(patch).eq('id', open.id);
    if (error) throw error;
    await event(supabase, open.id, 'agent_touch', { recommended_action: appNow.assessment_recommended_action || null, owner, overseer, standard: d && d.standard.state, governing: d && d.governing.state });
    return { id: open.id, owner, overseer, deadlines: d, action: 'updated' };
  }
  const { data, error } = await supabase.from('work_items').insert(row).select('id').single();
  if (error) {
    if (String(error.code) === '23505') return upsertWorkItem(supabase, { app, community, standards, result, facts: f });
    throw error;
  }
  await event(supabase, data.id, 'created', { reference_number: app.reference_number, owner });
  return { id: data.id, owner, overseer, deadlines: d, action: 'created' };
}

/**
 * An information request reached the builder inside another email (a
 * consolidated reply). For each application: record the actual send time on its
 * work item (the info-request clock reads it), discard Annie's now-redundant
 * per-lot request drafts, and refresh the item (waiting on the builder).
 */
async function recordInfoRequestSent(supabase, applicationIds, { sent_at, via, message_ref, sent_by }) {
  const { loadStandards } = require('./standards');
  const results = [];
  for (const id of [...new Set((applicationIds || []).filter(Boolean))]) {
    const { data: app, error } = await supabase.from('builder_applications')
      .select('id, community_id, reference_number, street_address, status, submitted_at, decided_at, fast_track, assessment_recommended_action').eq('id', id).maybeSingle();
    if (error) throw error;
    if (!app) { results.push({ id, error: 'not found' }); continue; }
    const { community, standards } = await loadStandards(supabase, app.community_id);
    let item = await findOpen(supabase, app.id);
    if (!item) { await upsertWorkItem(supabase, { app, community, standards, result: null }); item = await findOpen(supabase, app.id); }
    await event(supabase, item.id, 'updated', { info_request_sent_at: sent_at, via, message_ref: message_ref || null, sent_by: sent_by || null });
    const { data: dropped, error: de } = await supabase.from('outbound_email_drafts')
      .update({ status: 'discarded', disposition_reason: `Sent to the builder in ${via} at ${sent_at}` })
      .eq('related_type', 'builder_application').eq('related_id', app.id).eq('status', 'draft').select('id');
    if (de) throw de;
    const w = await upsertWorkItem(supabase, { app, community, standards, result: null });
    results.push({ id: app.id, reference_number: app.reference_number, discarded_drafts: (dropped || []).length, standard: w.deadlines && w.deadlines.standard.state });
  }
  return results;
}

/** Decision recorded: the item stays open (Annie) until the letter is emailed. */
async function decisionRecorded(supabase, appId, { status_label, decided_by }) {
  const open = await findOpen(supabase, appId);
  if (!open) return null;
  const { error } = await supabase.from('work_items').update({ next_step: `Decided (${status_label}) by ${decided_by}: email the decision letter to the builder (Send to builder).` }).eq('id', open.id);
  if (error) throw error;
  await event(supabase, open.id, 'updated', { decision: status_label, decided_by });
  return open.id;
}

/** The decision was communicated (letter emailed): the item closes. */
async function closeWorkItem(supabase, appId, { status_label, decided_by }) {
  const open = await findOpen(supabase, appId);
  if (!open) return null;
  const { error } = await supabase.from('work_items').update({ status: 'done', completed_at: new Date().toISOString(), next_step: `Decided (${status_label}) by ${decided_by} and emailed to the builder.` }).eq('id', open.id);
  if (error) throw error;
  await event(supabase, open.id, 'status_changed', { to: 'done', decision: status_label, decided_by });
  return open.id;
}

// ---------------------------------------------------------------------------
// The business-day sweep: escalate each new level once (Amanda oversees),
// alert Ed about new escalations, and (morning run) send Ed the daily digest.
// ---------------------------------------------------------------------------
function digestText(rows, newly, { dateLabel }) {
  const line = (r) => `${r.app.reference_number}  ${String(r.app.street_address || '').split(',')[0]} (${r.community && r.community.name})`;
  const due = (r) => (r.d.standard.due_at ? `decision due ${String(r.d.standard.due_at).slice(0, 10)}` : '');
  const gov = (r) => (r.d.governing.limit_at ? `association period ${r.d.governing.state === 'passed' ? 'ended' : 'ends'} ${String(r.d.governing.limit_at).slice(0, 10)}` : '');
  const sec = (title, list, fmt) => (list.length ? `${title} (${list.length})\n${list.map((r) => `- ${line(r)}: ${fmt(r)}`).join('\n')}\n` : '');
  const ready = rows.filter((r) => r.app.status === 'received' && r.app.assessment_recommended_action === 'approve');
  const decide = rows.filter((r) => r.app.status === 'received' && r.app.assessment_recommended_action === 'manual_review');
  const infoSend = rows.filter((r) => ['info_request_due', 'info_request_overdue'].includes(r.d.standard.state));
  const waiting = rows.filter((r) => r.d.standard.state === 'waiting_on_builder');
  const toSend = rows.filter((r) => String(r.app.status).startsWith('approved') || r.app.status === 'denied');
  const atRisk = rows.filter((r) => ['at_risk', 'missed'].includes(r.d.standard.state));
  const govern = rows.filter((r) => ['near', 'passed'].includes(r.d.governing.state));
  return [
    `Builder ARC, ${dateLabel}. Annie owns each application; Amanda is overseeing the deadlines below; the decisions are yours.`,
    '',
    newly.length ? `Newly escalated to Amanda (${newly.length})\n${newly.map((n) => `- ${line(n)}: ${n.levels.map((l) => l.replace('standard:', 'Bedrock standard ').replace('governing:', 'association period ').replace(/_/g, ' ')).join(', ')}`).join('\n')}\n` : '',
    sec('Ready for your approval', ready, (r) => [STANDARD_LABEL[r.d.standard.state], due(r)].filter(Boolean).join('; ')),
    sec('Your decision (Annie flagged a question)', decide, (r) => [STANDARD_LABEL[r.d.standard.state], due(r)].filter(Boolean).join('; ')),
    sec('Decided, letter not yet emailed', toSend, (r) => due(r)),
    sec('Info request to send to the builder', infoSend, (r) => `${STANDARD_LABEL[r.d.standard.state]} (by ${String(r.d.standard.info_request_due_at).slice(0, 10)})`),
    sec('Waiting on the builder', waiting, (r) => `asked ${String(r.d.standard.info_requested_at).slice(0, 10)}`),
    sec('At risk or past the 2-business-day standard', atRisk, (r) => `${STANDARD_LABEL[r.d.standard.state]}; ${due(r)}`),
    sec('Association review period ending or passed', govern, (r) => gov(r)),
    'Open trustEd: /builder-arc-review.html',
  ].filter(Boolean).join('\n');
}

async function sweep(supabase, { now = new Date(), send = null, digest = false } = {}) {
  // Bedrock holidays are not business days (the scheduler only skips weekends).
  if (!require('./deadlines').isBusinessDay(now)) return { skipped: 'bedrock_holiday' };
  const { loadStandards } = require('./standards');
  let { data: apps, error } = await supabase.from('builder_applications')
    .select('id, community_id, reference_number, street_address, status, submitted_at, decided_at, fast_track, assessment_recommended_action')
    .in('status', OPEN_STATUSES).order('submitted_at').limit(1000);
  if (error) throw error;
  // Decisions made before this tracking existed were communicated outside it
  // (portal letters, Outlook); only decisions from TRACK_DECISIONS_FROM on are
  // held open until their letter is emailed.
  apps = apps.filter((a) => !a.decided_at || new Date(a.decided_at) >= new Date(TRACK_DECISIONS_FROM));
  const facts = await clockFacts(supabase, apps);
  const cache = new Map(); const rows = []; const newly = [];
  for (const app of apps) {
    const f = facts.get(app.id);
    if (f.communicated_at) continue; // decided and emailed: done
    if (!cache.has(app.community_id)) cache.set(app.community_id, await loadStandards(supabase, app.community_id));
    const { community, standards } = cache.get(app.community_id);
    const d = deadlinesFor(app, community, standards, f, now);
    rows.push({ app, community, d });
    let item = await findOpen(supabase, app.id);
    if (!item) { await upsertWorkItem(supabase, { app, community, standards, result: null, facts: f }); item = await findOpen(supabase, app.id); }
    if (!item || !d.levels.length) continue;
    const { data: evs, error: ee } = await supabase.from('work_item_events').select('detail').eq('work_item_id', item.id).limit(300);
    if (ee) throw ee;
    const done = new Set((evs || []).map((e) => e.detail && e.detail.escalation_level).filter(Boolean));
    const fresh = d.levels.filter((l) => !done.has(l));
    if (!fresh.length) continue;
    const { error: ue } = await supabase.from('work_items').update({ urgency: urgencyFor(d) }).eq('id', item.id);
    if (ue) throw ue;
    for (const l of fresh) await event(supabase, item.id, 'updated', { escalation_level: l, overseer: 'Amanda', owner: 'Annie', standard_due_at: d.standard.due_at, info_request_due_at: d.standard.info_request_due_at, association_limit_at: d.governing.limit_at });
    newly.push({ app, community, d, levels: fresh });
  }
  let emailed = null;
  if (send && (digest ? rows.length : newly.length)) {
    const dateLabel = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', weekday: 'long', month: 'long', day: 'numeric' }).format(now);
    const subject = digest
      ? `Builder ARC daily digest: ${rows.filter((r) => r.app.status === 'received' && ['approve', 'manual_review'].includes(r.app.assessment_recommended_action)).length} for your decision${newly.length ? `, ${newly.length} newly escalated` : ''}`
      : `Builder ARC: ${newly.length} application${newly.length === 1 ? '' : 's'} escalated to Amanda`;
    const r = await send({ subject, text: digestText(digest ? rows : newly.map((n) => ({ app: n.app, community: n.community, d: n.d })), newly, { dateLabel }) });
    emailed = !!(r && r.ok);
  }
  return { open: rows.length, escalated: newly.length, digest, emailed };
}

// Back-compat name used by the scheduler before 2026-11-25 (afternoon).
const escalate = (supabase, opts) => sweep(supabase, opts);

module.exports = { upsertWorkItem, recordInfoRequestSent, decisionRecorded, closeWorkItem, sweep, escalate, clockFacts, deadlinesFor, digestText, ownerFor, overseerFor, urgencyFor, REF, STATE_LABEL };
