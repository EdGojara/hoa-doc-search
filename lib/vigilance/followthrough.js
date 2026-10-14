// ============================================================================
// lib/vigilance/followthrough.js — manage it to completion (Ed 2026-10-14)
// ----------------------------------------------------------------------------
// Each scheduler tick:
//   1. catch-up: recent inbound mail not yet evaluated (ingested before this
//      existed, or while it was off) goes through the engine, so nothing that
//      arrived is left unexamined;
//   2. for every open vigilance case (objectives.subject_key 'vigilance:%'):
//      * RESOLVED by evidence: a recipient_change case closes when a newer message
//        in the same series no longer carries the address (the bank removed it),
//        with that message cited;
//      * REPLY: an inbound message from the contact the case wrote to, after the
//        case opened, is recorded and the case moves to waiting_human for review;
//      * OVERDUE: the next action's due time passing without either tells Ed once.
// Every step is an objective_events row. Read + case updates only; sends nothing.
// ============================================================================
const V = require('./engine');
const D = require('./detectors');

async function catchUp(supabase, { now, hours = 72, limit = 200, notify } = {}) {
  const since = new Date(now.getTime() - hours * 3600000).toISOString();
  const { data, error } = await supabase.from('email_messages').select('*').eq('direction', 'inbound').gte('received_at', since).order('received_at', { ascending: true }).limit(limit);
  if (error) throw new Error(`catch-up: ${error.message}`);
  let n = 0;
  for (const m of data || []) {
    if (m.extracted && m.extracted.vigilance_checked_at) continue;
    const r = await V.evaluate(supabase, m, { notify });
    const patch = { ...(m.extracted || {}), vigilance_checked_at: r.checked_at, vigilance: r.results.map((x) => ({ detector: x.signal.detector, case_id: x.case_id, reattached: !!x.reattached })) };
    if (r.draft && !(m.extracted && m.extracted.draft)) patch.draft = r.draft;
    await supabase.from('email_messages').update({ extracted: patch }).eq('id', m.id);
    n += 1;
  }
  return n;
}

async function event(supabase, id, kind, summary, ref = null) {
  await supabase.from('objective_events').insert({ objective_id: id, actor: 'system', kind, summary: String(summary).slice(0, 2000), ref_message_id: ref });
  await supabase.from('objectives').update({ last_activity_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', id);
}

async function followCase(supabase, o, { now, notify }) {
  const refs = o.subject_refs || {}; const d = refs.data || {}; const cp = refs.counterparty || {};
  const { data: evs } = await supabase.from('objective_events').select('kind, summary').eq('objective_id', o.id).limit(200);
  const had = (re) => (evs || []).some((e) => re.test(e.summary || ''));
  // resolved by evidence: the series' newest message after the case opened no longer carries the address
  if (refs.detector === 'recipient_change' && (d.sender || cp.domain) && d.address) {
    const { data: later } = await supabase.from('email_messages').select('id, subject, received_at, recipients').ilike('sender_email', d.sender || `%@${cp.domain}`).gt('received_at', o.opened_at).order('received_at', { ascending: false }).limit(50);
    const series = (later || []).filter((m) => D.seriesSubject(m.subject) === d.series);
    if (series.length && !(series[0].recipients || []).map(D.addr).includes(d.address)) {
      await supabase.from('objectives').update({ status: 'resolved', closed_at: now.toISOString(), closed_reason: `${d.address} is no longer on "${series[0].subject}" of ${String(series[0].received_at).slice(0, 10)}`, updated_at: now.toISOString() }).eq('id', o.id);
      await event(supabase, o.id, 'closed', `Resolved by evidence: ${d.address} is not on the ${String(series[0].received_at).slice(0, 10)} message in this series. Keep the bank's written explanation with the case.`, series[0].id);
      return 'resolved';
    }
  }
  // a reply from the contact the case wrote to
  if (refs.correspondence_to && !had(/^Reply received/)) {
    const { data: rep } = await supabase.from('email_messages').select('id, subject, received_at').eq('direction', 'inbound').ilike('sender_email', refs.correspondence_to).gt('received_at', o.opened_at).order('received_at', { ascending: true }).limit(1);
    if (rep && rep[0]) {
      await supabase.from('objectives').update({ status: 'waiting_human', next_action: `Review ${refs.correspondence_to}'s reply ("${rep[0].subject}") against the questions asked; close when removal is confirmed`, updated_at: now.toISOString() }).eq('id', o.id);
      await event(supabase, o.id, 'message_in', `Reply received from ${refs.correspondence_to}: "${rep[0].subject}" ${String(rep[0].received_at).slice(0, 10)}.`, rep[0].id);
      return 'reply';
    }
  }
  // overdue: tell Ed once
  if (o.next_action_due && new Date(o.next_action_due) < now && !had(/^Overdue/)) {
    const text = `${(o.owner_persona || 'Team').replace(/^./, (c) => c.toUpperCase())}: overdue on "${o.title}". Waiting for: ${o.next_action}`.slice(0, 590);
    let r = { ok: false }; try { r = await notify(text); } catch (e) { r = { ok: false, error: e.message }; }
    await event(supabase, o.id, 'escalated', `Overdue: told Ed${r && r.ok ? '' : ' (text not delivered; on his queue)'}. ${o.next_action}`);
    return 'overdue';
  }
  return 'open';
}

async function tick({ supabase, now = new Date(), notify = null, logger = console } = {}) {
  const send = notify || ((t) => require('../notifications/notify_owner').textOwner(t, { force: true }));
  const evaluated = await catchUp(supabase, { now, notify: send });
  const { data: open, error } = await supabase.from('objectives').select('*').like('subject_key', 'vigilance:%').not('status', 'in', '(resolved,closed)').limit(500);
  if (error) throw new Error(`open cases: ${error.message}`);
  const tally = {};
  for (const o of open || []) { try { const s = await followCase(supabase, o, { now, notify: send }); tally[s] = (tally[s] || 0) + 1; } catch (e) { logger.warn(`[vigilance] case ${o.id}: ${e.message}`); } }
  return { evaluated, cases: (open || []).length, ...tally };
}

module.exports = { tick, catchUp, followCase };
