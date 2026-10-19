'use strict';
// ============================================================================
// lib/ea/delegation_store.js  (Ed 2026-10-19) — persistence for lib/ea/delegation.js
// ----------------------------------------------------------------------------
// The workflow rules live in delegation.js (pure, tested). This file reads and
// writes Tessa's owner-only ledger: ea_followups (kind 'signed_return') and its
// append-only audit, ea_followup_events. Every audit write fails LOUDLY: a step
// whose audit entry did not save is reported, never silently kept.
// ============================================================================
const D = require('./delegation');

const OPEN = ['open', 'waiting'];
const OURS = /@bedrocktx(ai)?\.com$/i;

async function recordEvent(supabase, followupId, event, actor, detail = {}) {
  const { error } = await supabase.from('ea_followup_events').insert({ followup_id: followupId, event, actor: String(actor || 'tessa').slice(0, 200), detail });
  if (error) { console.error('[tessa.delegation] audit write failed', JSON.stringify({ followupId, event, error: error.message })); throw Object.assign(new Error(`audit_write_failed: ${error.message}`), { code: 'audit_write_failed' }); }
}

async function saveSteps(supabase, d, steps, extra = {}) {
  const patch = { steps, status: D.followupStatus(steps), waiting_on: D.currentStep(steps) === 'received' ? (steps.meta && steps.meta.expected_from) || null : null, updated_at: new Date().toISOString(), ...extra };
  const { error } = await supabase.from('ea_followups').update(patch).eq('id', d.id);
  if (error) throw error;
  return { ...d, ...patch };
}

// Who Ed is waiting on: the person he wrote to (his own request), or the sender.
function expectedFromFor(item, edMailbox) {
  const ed = String(edMailbox || '').toLowerCase();
  const from = String(item.from_email || '').toLowerCase();
  if (from && from !== ed && !OURS.test(from)) return from;
  const to = (item.to_recipients || []).map((x) => String(x || '').toLowerCase()).filter((x) => x && x !== ed && !OURS.test(x));
  return to.length === 1 ? to[0] : null;   // more than one outside recipient: Ed names the person
}

// Build the plan Ed confirms. Nothing is saved.
async function planFromInbox(item, { proposal = {}, edMailbox, communityForThread }) {
  const found = communityForThread ? await communityForThread(item) : { community: null };
  return {
    kind: D.KIND,
    title: proposal.title || `Signed ${proposal.document_label || 'document'} back${found.community ? ` (${found.community.name})` : ''}`,
    document_label: proposal.document_label || null,
    tax_year: proposal.tax_year || null,
    due_date: proposal.due_date || null,
    deadline: proposal.deadline || null,
    expected_from: proposal.expected_from || expectedFromFor(item, edMailbox),
    community: found.community ? { id: found.community.id, name: found.community.name, how: found.how, confident: !!found.confident } : null,
    source_inbox_id: item.id,
    source_subject: item.subject || '',
  };
}

// Create the delegation Ed confirmed, then look for a reply that already came in.
async function createDelegation(supabase, { item, plan, by }) {
  if (!plan || !plan.community_id) throw Object.assign(new Error('Choose the association this belongs to.'), { code: 'community_required' });
  if (!plan.expected_from) throw Object.assign(new Error('Say who is sending it back (their email).'), { code: 'expected_from_required' });
  const { data: dup, error: de } = await supabase.from('ea_followups').select('id').eq('kind', D.KIND).eq('source_inbox_id', item.id).in('status', OPEN).limit(1);
  if (de) throw de;
  if (dup && dup.length) throw Object.assign(new Error('Tessa is already tracking this one.'), { code: 'already_delegated', id: dup[0].id });
  let steps = D.newSteps({ requestedBy: by, sourceInboxId: item.id, sourceSubject: item.subject || '', expectedFrom: plan.expected_from, documentLabel: plan.document_label, taxYear: plan.tax_year, deadline: plan.deadline });
  steps.meta.source_conversation_id = item.conversation_id || null;
  const row = {
    kind: D.KIND, title: String(plan.title || 'Signed document').slice(0, 200), category: 'admin',
    detail: `Delegated by ${by} from "${item.subject || '(no subject)'}" (${item.from_name || item.from_email || 'unknown'}).`,
    status: D.followupStatus(steps), waiting_on: plan.expected_from, due_date: plan.due_date || null,
    community_id: plan.community_id, source_inbox_id: item.id, steps, created_by: by,
  };
  const { data, error } = await supabase.from('ea_followups').insert(row).select('*').single();
  if (error) throw error;
  await recordEvent(supabase, data.id, 'delegated', by, { source_inbox_id: item.id, community_id: plan.community_id, expected_from: plan.expected_from, document_label: plan.document_label, due_date: plan.due_date, deadline: plan.deadline });
  // Catch up: the document may already be in Tessa's inbox (Paul replied on the 19th).
  const { data: later, error: le } = await supabase.from('ea_inbox').select('id, from_email, subject, conversation_id, attachment_names, received_at')
    .ilike('from_email', plan.expected_from).gte('received_at', item.received_at || '1970-01-01').order('received_at', { ascending: true }).limit(50);
  if (le) throw le;
  let d = data;
  for (const msg of later || []) {
    if (msg.id === item.id || !D.matchesReturn(d.steps, msg)) continue;
    d = await markReceived(supabase, d, msg);
    break;
  }
  return d;
}

async function markReceived(supabase, d, msg) {
  const r = D.applyReceived(d.steps, { inboxId: msg.id, attachments: msg.attachment_names || [], at: msg.received_at || new Date() });
  if (!r.changed) return d;
  await recordEvent(supabase, d.id, 'document_received', 'tessa', { inbox_id: msg.id, attachments: (msg.attachment_names || []).filter(D.isPdfName), received_at: msg.received_at, verified: false });
  return saveSteps(supabase, d, r.steps);
}

// Called by the inbox poll for each NEW message: is it a document someone is waiting on?
async function onInboxMessage(supabase, msg) {
  if (!msg || !Array.isArray(msg.attachment_names) || !msg.attachment_names.some(D.isPdfName)) return [];
  const { data, error } = await supabase.from('ea_followups').select('*').eq('kind', D.KIND).in('status', OPEN).ilike('waiting_on', String(msg.from_email || '')).limit(50);
  if (error) { console.warn('[tessa.delegation] open delegations lookup failed:', error.message); return []; }
  const hit = [];
  for (const d of data || []) {
    if (!d.steps || !D.matchesReturn(d.steps, msg)) continue;
    try { hit.push((await markReceived(supabase, d, msg)).id); } catch (e) { console.warn('[tessa.delegation] could not record a returned document:', e.message); }
  }
  return hit;
}

async function loadDelegation(supabase, id) {
  const { data, error } = await supabase.from('ea_followups').select('*').eq('id', id).eq('kind', D.KIND).maybeSingle();
  if (error) throw error;
  if (!data) throw Object.assign(new Error('not_found'), { code: 'not_found' });
  return data;
}

// The staff task's state, and the PERSON who closed it (from its audit).
async function mailingTaskState(supabase, workItemId) {
  const { data: task, error } = await supabase.from('work_items').select('id, status, completed_at, notes, assigned_to').eq('id', workItemId).maybeSingle();
  if (error) throw error;
  if (!task || task.status !== 'done') return { task, closedBy: null };
  const { data: ev, error: ee } = await supabase.from('work_item_events').select('event, actor, created_at').eq('work_item_id', workItemId).in('event', ['status_changed', 'closed_by_evidence']).order('created_at', { ascending: false }).limit(1);
  if (ee) throw ee;
  return { task, closedBy: ev && ev[0] ? ev[0].actor : null };
}

// One pass over open delegations: alert Ed about anything late or stuck,
// including a mailing task closed without a mailing record. Sends nothing to anyone but Ed's own phone.
async function tick(supabase, { now = new Date(), textOwner = null } = {}) {
  const out = { checked: 0, alerts: 0 };
  const { data, error } = await supabase.from('ea_followups').select('*').eq('kind', D.KIND).in('status', OPEN).order('created_at', { ascending: true }).limit(200);
  if (error) throw error;
  for (let d of data || []) {
    out.checked += 1;
    try {
      // Mailing is confirmed ONLY by the explicit mailing record (api/tessa_mailing.js).
      // A task closed without one is reported to Ed and is NOT counted as mailed.
      let taskClosed = false;
      if (d.steps.mail_assigned.state === 'assigned' && d.steps.mailed.state !== 'confirmed_by_staff') {
        const { task } = await mailingTaskState(supabase, d.steps.mail_assigned.work_item_id);
        taskClosed = !!(task && task.status === 'done');
      }
      const alerts = D.dueAlerts(d.steps, { dueDate: d.due_date, now, taskClosed });
      if (!alerts.length) continue;
      let sent = false;
      if (textOwner) { try { const r = await textOwner(`Tessa: ${alerts.map((a) => a.text).join(' ')}`); sent = !r || r.ok !== false; } catch (e) { console.warn('[tessa.delegation] owner text failed:', e.message); } }
      await recordEvent(supabase, d.id, 'alert_sent', 'tessa', { kinds: alerts.map((a) => a.kind), texts: alerts.map((a) => a.text), texted: sent });
      d = await saveSteps(supabase, d, D.markAlerted(d.steps, alerts.map((a) => a.kind), now));
      out.alerts += alerts.length;
    } catch (e) { console.warn('[tessa.delegation] tick skipped one', JSON.stringify({ id: d.id, error: e.message })); }
  }
  return out;
}

module.exports = { recordEvent, saveSteps, expectedFromFor, planFromInbox, createDelegation, markReceived, onInboxMessage, loadDelegation, mailingTaskState, tick, OPEN };
