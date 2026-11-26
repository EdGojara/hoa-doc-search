// ============================================================================
// lib/acc/tracking.js  (Ed 2026-11-26)
// ----------------------------------------------------------------------------
// Ownership, both clocks and escalation for resident architectural applications,
// on the existing operations work-item ledger (work_items / work_item_events),
// the same shape as builder ARC (lib/builder_arc/tracking). One open item per
// application, source_ref 'acc:<id>'.
//
//   Annie   owns every current application from receipt until the outcome is
//           communicated.
//   Amanda  oversees: Bedrock's service clock (lib/acc/service_clock) and the
//           governing-document clock (lib/acc/review_periods). A missed service
//           stage, an association deadline near or passed, a decision owed by
//           Ed / the Committee / the developer (escalated within 1 business day,
//           followed up every 2 business days) is recorded on the item with the
//           reason, the owner of the next action and when it is due, and Ed is
//           told once per new escalation. Ownership stays with Annie.
//
// The only timer is the business-day sweep (8 AM, noon, 4 PM Central), run by
// lib/scheduler.js. The historical backlog is not swept here (it is Ed's hold and
// shows in the historical view); nothing in this file writes to a homeowner.
// ============================================================================
const DA = require('./decision_authority');
const BH = require('./backlog_hold');
const SC = require('./service_clock');
const RP = require('./review_periods');

const REF = (id) => `acc:${id}`;
const OPEN_ITEM = ['new', 'in_progress', 'waiting'];
const OPEN_CASE = ['pending_review', 'awaiting_info', 'finalizing'];
const ACTOR = 'Annie Reeves (AI architectural review)';
const DAY = 86400000;
const d10 = (x) => (x ? new Date(x).toLocaleString('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');

function governing(row, community, now) {
  const period = RP.reviewPeriodFor(row.community_name, community);
  const limit = RP.deadlineFrom(row.received_at || row.created_at, period);
  const left = limit ? Date.parse(limit) - now.getTime() : null;
  const state = left == null ? 'unknown' : left < 0 ? 'passed' : left < 5 * DAY ? 'near' : 'open';
  return { limit_at: limit, state, basis: period.label };
}

function levelsFor(clock, gov) {
  const L = [...clock.levels];
  if (gov.state === 'near') L.push('governing:near');
  if (gov.state === 'passed') L.push('governing:passed');
  return L;
}
function urgencyFor(levels) {
  if (levels.some((l) => l.startsWith('governing:passed') || l === 'governing:near')) return 'critical';
  return levels.length ? 'high' : 'normal';
}
// Amanda's resolution plan for one escalation level: why, who, by when.
function planFor(level, row, clock, gov) {
  const stage = clock.stages.find((s) => level === `service:${s.key}_missed`);
  if (stage) return `${stage.label} was due ${d10(stage.due_at)}. ${clock.complex ? `Complex: ${clock.complexity_reasons.join('; ')}. ` : ''}Owner: ${stage.owner}. Next action: ${clock.next ? `${clock.next.label} (owner ${clock.next.owner}, due ${d10(clock.next.due_at)})` : 'close it out'}.`;
  if (level === 'governing:near') return `The association's review period ends ${d10(gov.limit_at)} (${gov.basis}). A decision must be issued before then.`;
  if (level === 'governing:passed') return `The association's review period ended ${d10(gov.limit_at)} (${gov.basis}). Ed decides how to proceed; nothing is sent to the homeowner without him.`;
  return level;
}

async function event(supabase, itemId, ev, detail) {
  const { error } = await supabase.from('work_item_events').insert({ work_item_id: itemId, event: ev, actor: ACTOR, detail: detail || {} });
  if (error) console.warn('[acc.tracking] event insert failed:', error.message);
}
async function findOpen(supabase, id) {
  const { data, error } = await supabase.from('work_items').select('*').eq('source_ref', REF(id)).in('status', OPEN_ITEM).limit(1);
  if (error) throw error;
  return data[0] || null;
}
async function eventsOf(supabase, itemId) {
  const { data, error } = await supabase.from('work_item_events').select('detail, created_at').eq('work_item_id', itemId).order('created_at', { ascending: true }).limit(500);
  if (error) throw error;
  return data || [];
}

// The next action, its owner and when it is due, for every open application
// (Ed 2026-11-26: "Assign each outstanding application an owner, next action and
// internal completion deadline"). Waiting on the homeowner names what is missing
// and carries the association deadline; a case on Ed's historical hold names Ed
// and sends nothing; no applicant email means a person contacts the homeowner.
function nextAction(row, clock, gov, { held = false, owner = null } = {}) {
  const govDue = gov.limit_at || null;
  const waiting = row.decision_type === 'request_more_info' && !(row.last_document_added_at && Date.parse(row.last_document_added_at) > Date.parse(row.updated_at || 0));
  if (waiting) return { text: `Waiting on the homeowner for the requested information (asked ${d10(row.updated_at)}); Annie re-reviews within the service standard when it arrives${held ? "; any decision stays on Ed's historical hold" : ''}. Association deadline ${gov.limit_at ? d10(gov.limit_at) : 'unknown'}.`, due: govDue, who: 'Homeowner' };
  if (held) return { text: `On Ed's historical communication hold: Ed decides whether Annie proceeds (nothing is sent to the homeowner meanwhile). Association deadline ${gov.limit_at ? d10(gov.limit_at) : 'unknown'}.`, due: govDue, who: 'Ed' };
  if (!row.submitter_email && clock.next && clock.next.key === 'acknowledgment') return { text: 'No applicant email on file: a person contacts the homeowner by phone or mail to acknowledge receipt' + (owner ? `; the decision is ${owner}'s` : '') + '.', due: clock.next.due_at, who: 'Annie (with staff)' };
  if (clock.next) return { text: `${clock.next.label} (owner ${clock.next.owner}, due ${d10(clock.next.due_at)})`, due: clock.next.due_at, who: clock.next.owner };
  if (owner) return { text: `Decision by ${owner}; Amanda follows up every 2 business days.`, due: govDue, who: owner };
  return { text: 'Annie completes the review and responds.', due: govDue, who: 'Annie' };
}

async function upsertItem(supabase, { row, community, clock, gov, levels, held = false, owner = null }) {
  const addr = String(row.homeowner_address || '').split(',')[0];
  const na = nextAction(row, clock, gov, { held, owner });
  const why = [
    `${row.community_name || 'Community'} architectural application ${row.reference_number || ''}, received ${d10(row.received_at || row.created_at)}.`,
    clock.complex ? `Complex: ${clock.complexity_reasons.join('; ')}.` : 'Routine.',
    clock.next ? `Bedrock standard: ${clock.next.label}, owner ${clock.next.owner}, due ${d10(clock.next.due_at)}.` : null,
    gov.limit_at ? `Association review period ends ${d10(gov.limit_at)} (${gov.basis}).` : null,
  ].filter(Boolean).join(' ');
  const waiting = row.decision_type === 'request_more_info' && !(row.last_document_added_at && Date.parse(row.last_document_added_at) > Date.parse(row.updated_at || 0));
  const item = {
    community_id: row.community_id, community_name: row.community_name || null,
    source_type: 'acc', item_type: 'acc_application', workspace: 'operations', module_key: 'acc', horizon: 'now',
    title: `ACC: ${addr} (${row.reference_number || 'no reference'})`,
    summary: row.project_summary ? `Annie: ${String(row.project_summary).slice(0, 200)}` : 'Architectural application',
    assigned_to: 'Annie', urgency: urgencyFor(levels), status: waiting || held ? 'waiting' : 'new',
    received_at: row.received_at || row.created_at, sla_due_at: na.due,
    source_ref: REF(row.id), requested_by: 'Homeowner application', why,
    next_step: `${na.text} Next action owner: ${na.who}.` + (levels.length ? ' Amanda is overseeing the deadline.' : ''),
    action_url: '/#acc', record_ownership: 'workpaper', created_by: ACTOR,
  };
  const open = await findOpen(supabase, row.id);
  if (open) {
    const patch = { ...item }; delete patch.created_by; delete patch.received_at;
    const { error } = await supabase.from('work_items').update(patch).eq('id', open.id);
    if (error) throw error;
    return open;
  }
  const { data, error } = await supabase.from('work_items').insert(item).select('*').single();
  if (error) { if (String(error.code) === '23505') return findOpen(supabase, row.id); throw error; }
  await event(supabase, data.id, 'created', { reference_number: row.reference_number, owner: 'Annie' });
  return data;
}

// Escalation to the decision owner (complex, reviewed, waiting on Ed / Committee /
// developer): recorded once, then followed up every 2 business days.
function decisionOwner(row, a) {
  if (a.route === 'owner_review_required') return 'Ed';
  if (a.route === 'committee_or_board_required') return row.acc_delegation && row.acc_delegation.reserved_to === 'developer' ? 'the developer (Ed coordinates)' : 'the Committee or Board (Ed obtains it)';
  return null;
}

async function sweep(supabase, { now = new Date(), send = null } = {}) {
  if (!require('../builder_arc/deadlines').isBusinessDay(now)) return { skipped: 'bedrock_holiday' };
  const { data: rows, error } = await supabase.from('acc_decisions').select('*').in('status', OPEN_CASE).order('created_at').limit(1000);
  if (error) throw error;
  const cids = [...new Set(rows.map((r) => r.community_id).filter(Boolean))];
  const comms = new Map();
  if (cids.length) {
    const { data: cs, error: ce } = await supabase.from('communities').select('id, name, management_status, management_end_date, acc_delegation').in('id', cids);
    if (ce) throw ce;
    for (const c of cs) comms.set(c.id, c);
  }
  const lifecycle = require('../community/lifecycle');
  const newly = []; let tracked = 0;
  for (const r of rows) {
    const comm = comms.get(r.community_id) || null;
    if (comm && lifecycle.isEnded(comm, now)) continue;
    const held = BH.isBacklogHeld(r);
    const row = { ...r, acc_delegation: comm && comm.acc_delegation };
    const a = DA.authorityFor(row);
    let item = await findOpen(supabase, r.id);
    const evs = item ? await eventsOf(supabase, item.id) : [];
    const escalatedAt = (evs.find((e) => e.detail && e.detail.decision_escalated_at) || {}).detail?.decision_escalated_at || null;
    const clock = SC.serviceClock(row, { authority: a, now, facts: { escalated_at: escalatedAt } });
    const gov = governing(row, comm, now);
    // Held (historical) cases: the association clock only; Bedrock's service
    // stages do not apply while Ed's hold is in place, and nothing is sent.
    const levels = held ? levelsFor({ levels: [] }, gov) : levelsFor(clock, gov);
    item = await upsertItem(supabase, { row, community: comm, clock, gov, levels, held, owner: decisionOwner(row, a) });
    if (!item) continue;
    tracked += 1;
    const done = new Set(evs.map((e) => e.detail && e.detail.escalation_level).filter(Boolean));
    const fresh = [];
    // Escalate a decision owed by someone else once Annie has reviewed it.
    const owner = decisionOwner(row, a);
    if (!held && owner && DA.reviewAt(row) && !escalatedAt) {
      await event(supabase, item.id, 'updated', { escalation_level: 'decision_escalated', decision_escalated_at: now.toISOString(), decision_owner: owner, overseer: 'Amanda', reason: clock.complexity_reasons.join('; ') });
      fresh.push(`decision needed from ${owner}`);
    }
    const followup = clock.stages.find((s) => s.followup);
    if (!held && followup && Date.parse(followup.due_at) - now.getTime() < 2 * DAY && !done.has(`followup:${followup.followup}`) && followup.followup > 1) {
      await event(supabase, item.id, 'updated', { escalation_level: `followup:${followup.followup}`, decision_owner: owner, overseer: 'Amanda' });
      fresh.push(`follow-up #${followup.followup - 1}: decision still outstanding from ${owner}`);
    }
    for (const l of levels.filter((x) => !done.has(x))) {
      await event(supabase, item.id, 'updated', { escalation_level: l, overseer: 'Amanda', owner: 'Annie', plan: planFor(l, row, clock, gov), next_due_at: clock.next && clock.next.due_at, association_limit_at: gov.limit_at });
      fresh.push(planFor(l, row, clock, gov));
    }
    if (fresh.length) newly.push({ row, notes: fresh });
  }
  // Items whose application is no longer open (decided, archived, withdrawn) close.
  const { data: items, error: ie } = await supabase.from('work_items').select('id, source_ref').like('source_ref', 'acc:%').in('status', OPEN_ITEM).limit(1000);
  if (ie) throw ie;
  const openIds = new Set(rows.map((r) => REF(r.id)));
  for (const it of items || []) {
    if (openIds.has(it.source_ref)) continue;
    const { error: ce } = await supabase.from('work_items').update({ status: 'done', completed_at: now.toISOString(), next_step: 'Application closed (decided, archived or withdrawn).' }).eq('id', it.id);
    if (ce) console.warn('[acc.tracking] close failed:', ce.message); else await event(supabase, it.id, 'status_changed', { to: 'done' });
  }
  let emailed = null;
  if (send && newly.length) {
    const text = [
      `Architectural applications: ${newly.length} need attention. Annie owns each one; Amanda is overseeing the deadlines below.`, '',
      ...newly.map((n) => `- ${n.row.reference_number || ''} ${String(n.row.homeowner_address || '').split(',')[0]} (${n.row.community_name || ''}):\n  ${n.notes.join('\n  ')}`),
      '', 'Open trustEd: ACC > Requests',
    ].join('\n');
    const r = await send({ subject: `ACC: ${newly.length} application${newly.length === 1 ? '' : 's'} escalated (deadlines / decisions)`, text });
    emailed = !!(r && r.ok);
  }
  return { tracked, escalated: newly.length, emailed };
}

// AMANDA'S COMMUNICATION CHECK (Ed 2026-11-26): every teammate email approved
// but not delivered on time (a release overdue by 10+ minutes) and every send the
// delivery window held (the recipient wrote again, the draft changed) is reported
// once to Ed with the reason, so nothing waits silently. Read-only.
async function communicationCheck(supabase, { now = new Date(), send = null } = {}) {
  const DW = require('../email/delivery_window');
  const late = await DW.overdue(supabase, { now });
  const since = new Date(now.getTime() - 26 * 3600000).toISOString();
  const { data: held, error } = await supabase.from('outbound_email_drafts').select('id, persona, to_email, subject, policy').eq('status', 'draft').not('policy->delivery_hold', 'is', null).limit(200);
  if (error) throw error;
  const fresh = (held || []).filter((d) => d.policy && d.policy.delivery_hold && d.policy.delivery_hold.at >= since && !d.policy.delivery_hold.reported_at);
  if (send && (late.length || fresh.length)) {
    const line = (d) => `- ${d.persona || 'teammate'} to ${d.to_email}: "${String(d.subject || '').slice(0, 80)}"`;
    const text = [
      'Teammate email delivery: Amanda is flagging these for review.', '',
      late.length ? `Approved but not delivered on time (${late.length}):\n${late.map((d) => `${line(d)} (was due ${new Date(d.policy.scheduled_send.send_at).toLocaleString('en-US', { timeZone: 'America/Chicago' })})`).join('\n')}\n` : '',
      fresh.length ? `Held at the end of the delivery window (${fresh.length}):\n${fresh.map((d) => `${line(d)}: ${d.policy.delivery_hold.reason}`).join('\n')}\n` : '',
      'Open trustEd: Draft Queue',
    ].filter(Boolean).join('\n');
    const r = await send({ subject: `Teammate email: ${late.length + fresh.length} item(s) need attention`, text });
    if (r && r.ok) {
      for (const d of fresh) await supabase.from('outbound_email_drafts').update({ policy: { ...d.policy, delivery_hold: { ...d.policy.delivery_hold, reported_at: now.toISOString() } } }).eq('id', d.id).eq('status', 'draft');
    }
  }
  return { overdue: late.length, held: fresh.length };
}

module.exports = { sweep, communicationCheck, nextAction, governing, levelsFor, planFor, urgencyFor, decisionOwner, REF };
