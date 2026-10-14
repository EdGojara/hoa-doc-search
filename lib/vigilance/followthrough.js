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
  // the prepared inquiry was approved and sent (or someone wrote): record it and wait on the answer
  if (!refs.contacted && d.address) {
    const c = await V.alreadyContacted(supabase, d.address, d.first_seen || o.opened_at);
    if (c) {
      refs.contacted = c; refs.correspondence_to = c.to || refs.correspondence_to;
      const due = new Date(new Date(c.at).getTime() + 86400000).toISOString();
      await supabase.from('objectives').update({ subject_refs: refs, status: 'waiting_third_party', next_action: `Await ${c.to || 'the counterparty'}'s answer to the ${String(c.at).slice(0, 10)} inquiry`, next_action_due: due, updated_at: now.toISOString() }).eq('id', o.id);
      Object.assign(o, { subject_refs: refs, status: 'waiting_third_party', next_action_due: due });
      await event(supabase, o.id, 'message_out', `Inquiry sent to ${c.to || 'the counterparty'} by ${c.from} on ${String(c.at).slice(0, 16)} ("${c.subject}"). Waiting for the answer.`, c.message_id);
    }
  }
  // resolved by evidence: the series' newest message after the case opened no longer carries the address
  if (refs.detector === 'recipient_change' && (d.sender || cp.domain) && d.address) {
    const { data: later } = await supabase.from('email_messages').select('id, subject, received_at, recipients').ilike('sender_email', d.sender || `%@${cp.domain}`).gt('received_at', d.first_seen || o.opened_at).order('received_at', { ascending: false }).limit(50);
    // Only a GENUINE next message in the series counts: the same sending address, the same subject
    // family, and not a person's reply (a "RE:" from a shared bank mailbox can drop CCs).
    const series = (later || []).filter((m) => D.seriesSubject(m.subject) === d.series && !/^\s*(re|fw|fwd)\s*:/i.test(m.subject || ''));
    if (series.length && !(series[0].recipients || []).map(D.addr).includes(d.address)) {
      await supabase.from('objectives').update({ status: 'resolved', closed_at: now.toISOString(), closed_reason: `${d.address} is no longer on "${series[0].subject}" of ${String(series[0].received_at).slice(0, 10)}`, updated_at: now.toISOString() }).eq('id', o.id);
      await event(supabase, o.id, 'closed', `Resolved by evidence: ${d.address} is not on the ${String(series[0].received_at).slice(0, 10)} message in this series. Keep the bank's written explanation with the case.`, series[0].id);
      return 'resolved';
    }
  }
  // a reply from the contact the case wrote to
  if (refs.correspondence_to && !had(/^Reply received/)) {
    const { data: rep } = await supabase.from('email_messages').select('id, subject, received_at').eq('direction', 'inbound').ilike('sender_email', refs.correspondence_to).gt('received_at', (refs.contacted && refs.contacted.at) || o.opened_at).order('received_at', { ascending: true }).limit(1);
    if (rep && rep[0]) {
      // The answer is in; it is reviewed by a person, and the case still closes only on evidence
      // (the next genuine message in the series), never on the reply itself.
      const next = refs.detector === 'recipient_change' ? `${refs.correspondence_to} answered ("${rep[0].subject}"): review it against the questions asked. The case closes when the next genuine "${d.series_label || 'notice'}" from ${d.sender || cp.domain} no longer includes ${d.address}.` : `Review ${refs.correspondence_to}'s reply ("${rep[0].subject}") against the questions asked`;
      const due = new Date(now.getTime() + 2 * 86400000).toISOString();
      await supabase.from('objectives').update({ status: 'waiting_human', next_action: next, next_action_due: due, updated_at: now.toISOString() }).eq('id', o.id);
      Object.assign(o, { status: 'waiting_human', next_action: next, next_action_due: due });
      await event(supabase, o.id, 'message_in', `Reply received from ${refs.correspondence_to}: "${rep[0].subject}" ${String(rep[0].received_at).slice(0, 10)}.`, rep[0].id);
      return 'reply';
    }
  }
  // overdue with no answer: the owner follows up herself. A follow-up on a restricted topic
  // (banking, payment change, security) is PREPARED for approval; Ed hears once.
  if (o.next_action_due && new Date(o.next_action_due) < now && !had(/^Overdue/)) {
    const P = require('./permissions');
    const who = (o.owner_persona || 'Team').replace(/^./, (c) => c.toUpperCase());
    let prepared = null;
    const answered = had(/^Reply received/);
    if (!answered && refs.contacted && refs.correspondence_to && P.can(o.owner_persona, 'follow_up')) {   // only after something was sent and nothing came back
      const since = String((refs.contacted && refs.contacted.at) || o.opened_at).slice(0, 10);
      const about = d.address ? `the addition of ${d.address} to our ${/positive pay/i.test(d.series_label || '') ? 'Positive Pay notifications' : 'notifications'}` : o.title;
      const topic = P.topicFor(refs.detector, cp.type);
      const draft = { subject: `Following up: ${(refs.contacted && refs.contacted.subject) || o.title}`.slice(0, 200),
        body: ['Good morning,', '', `Following up on our email of ${new Date(since + 'T12:00:00Z').toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long', day: 'numeric', year: 'numeric' })} about ${about}.`, '', 'Could you please confirm the status of our questions and whether the address has been removed?', '', 'Thank you,'].join('\n'),
        to: refs.correspondence_to, careful: true, status: 'pending', persona: o.owner_persona, bank_inquiry: cp.type === 'bank', topic, send_policy: P.sendDecision({ topic }), review_hint: `${who}'s follow-up: no answer since ${since}. Prepared for your approval.` };
      const src = refs.source_message_id || o.source_message_id;
      if (src) {
        const { data: m } = await supabase.from('email_messages').select('extracted').eq('id', src).limit(1);
        if (m && m[0] && !(m[0].extracted && m[0].extracted.draft)) { await supabase.from('email_messages').update({ extracted: { ...(m[0].extracted || {}), draft } }).eq('id', src); prepared = draft; }
      }
    }
    const text = `${who}: ${answered ? 'past due' : 'no answer'} on "${o.title}".${prepared ? ` Follow-up to ${prepared.to} prepared for your approval in Communications.` : ` Waiting for: ${o.next_action}`}`.slice(0, 590);
    let r = { ok: false }; try { r = await notify(text); } catch (e) { r = { ok: false, error: e.message }; }
    await event(supabase, o.id, 'escalated', `Overdue: ${prepared ? `follow-up to ${prepared.to} prepared for approval; ` : ''}told Ed${r && r.ok ? '' : ' (text not delivered; on his queue)'}. ${o.next_action}`);
    await supabase.from('objectives').update({ next_action_due: new Date(now.getTime() + 86400000).toISOString() }).eq('id', o.id);
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
