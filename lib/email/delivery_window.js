// ============================================================================
// lib/email/delivery_window.js  (Ed 2026-11-26)
// ----------------------------------------------------------------------------
// THE SHARED COMMUNICATION WINDOW for AI teammates' routine outbound email.
// Ed: "Establish a configurable two-minute minimum delivery delay for routine
// outbound email responses across all AI teammates. Perform the underlying work
// immediately, but use the communication window to consolidate related
// responses, avoid redundant emails and account for additional incoming
// correspondence. Do not introduce artificial delays into live conversations,
// urgent communications or time-sensitive matters. Where a workflow has a
// specific communication window (Annie's 30-minute ACC window), that workflow's
// rules take precedence."
//
// How it works (one place, every teammate):
//   * the work is done at once (the reply is drafted, reviewed and approved);
//   * delivery waits AI_EMAIL_MIN_DELAY_SECONDS (120) after approval;
//   * at the end of the window the message goes only if nothing changed:
//       - the recipient (or the thread) wrote again during the window: it is
//         HELD for review with the reason, never sent blindly over a newer
//         message (the person, or the teammate, answers both together);
//       - a newer message from us to the same recipient on the same thread was
//         scheduled: the older one is superseded (one email, not two);
//       - the draft changed after approval: held for re-review.
//   * no window for urgent or time-sensitive mail (urgent subject, policy.urgent,
//     an explicit "send now"), or where the workflow sets its own window
//     (policy.delivery_window_seconds).
// Durable: the schedule lives on the draft (policy.scheduled_send); a one-shot
// timer releases it, and a restart re-arms every pending schedule (no polling).
// Amanda oversees: a schedule overdue by more than 10 minutes, or a hold, is
// reported by the communication check (lib/email/delivery_window.overdue()).
// ============================================================================

const URGENT = /\b(urgent|emergency|asap|immediately|time[- ]sensitive|today only|same[- ]day|due today|final notice|deadline (?:is )?today)\b/i;

function minDelayMs() {
  const v = Number(process.env.AI_EMAIL_MIN_DELAY_SECONDS);
  return (Number.isFinite(v) && v >= 0 ? v : 120) * 1000;
}

// How long this draft waits before delivery (ms). 0 = send now.
function windowFor(d = {}, { sendNow = false } = {}) {
  if (sendNow) return 0;
  const p = d.policy || {};
  if (p.urgent === true || p.time_sensitive === true) return 0;
  // Tessa (executive assistant) handles scheduling and time-bound coordination
  // for Ed: time-sensitive by nature, never delayed.
  if (String(d.persona || '').toLowerCase() === 'tessa') return 0;
  if (URGENT.test(String(d.subject || ''))) return 0;
  if (p.delivery_window_seconds != null && Number.isFinite(Number(p.delivery_window_seconds))) return Math.max(0, Number(p.delivery_window_seconds)) * 1000;
  return minDelayMs();
}

const norm = (e) => String(e || '').trim().toLowerCase();
const list = (v) => String(v || '').split(/[,;]/).map(norm).filter(Boolean);

// Did the recipient (or anyone on the thread) write to us after `since`?
async function newerInbound(supabase, { to, conversationId = null, since }) {
  const who = list(to);
  if (!since || (!who.length && !conversationId)) return null;
  let q = supabase.from('email_messages').select('id, sender_email, subject, received_at, conversation_id').eq('direction', 'inbound').gt('received_at', since).order('received_at', { ascending: true }).limit(5);
  q = conversationId && who.length ? q.or(`conversation_id.eq.${conversationId},sender_email.in.(${who.map((w) => `"${w}"`).join(',')})`)
    : conversationId ? q.eq('conversation_id', conversationId) : q.in('sender_email', who);
  const { data, error } = await q;
  if (error) throw Object.assign(new Error(`newer-message check failed: ${error.message}`), { code: 'newer_check_failed' });
  return (data || [])[0] || null;
}

// A newer scheduled message from us to the same recipient on the same thread?
async function supersededBy(supabase, d) {
  const sched = d.policy && d.policy.scheduled_send;
  if (!sched) return null;
  let q = supabase.from('outbound_email_drafts').select('id, policy, to_email, source_email_ref, persona').eq('status', 'draft').neq('id', d.id).limit(50);
  q = d.source_email_ref ? q.eq('source_email_ref', d.source_email_ref) : q.eq('to_email', d.to_email);
  const { data, error } = await q;
  if (error) throw Object.assign(new Error(`superseded check failed: ${error.message}`), { code: 'superseded_check_failed' });
  return (data || []).find((o) => o.persona === d.persona && o.policy && o.policy.scheduled_send && Date.parse(o.policy.scheduled_send.approved_at) > Date.parse(sched.approved_at)) || null;
}

const timers = new Map();
function arm(id, atIso, release) {
  if (timers.has(id)) clearTimeout(timers.get(id));
  const h = setTimeout(() => { timers.delete(id); release(id).catch((e) => console.error(`[delivery_window] release of ${id} failed: ${e.message}`)); }, Math.max(0, Date.parse(atIso) - Date.now()));
  if (h.unref) h.unref();
  timers.set(id, h);
}
function disarm(id) { if (timers.has(id)) { clearTimeout(timers.get(id)); timers.delete(id); } }

// Pending schedules (for restart recovery and Amanda's oversight).
async function pending(supabase) {
  const { data, error } = await supabase.from('outbound_email_drafts').select('id, persona, to_email, subject, policy, status').eq('status', 'draft').not('policy->scheduled_send', 'is', null).limit(500);
  if (error) throw error;
  return (data || []).filter((d) => d.policy && d.policy.scheduled_send && d.policy.scheduled_send.send_at);
}
// Schedules overdue by more than `graceMs` (a missed release) and recent holds.
async function overdue(supabase, { now = new Date(), graceMs = 10 * 60000 } = {}) {
  const p = await pending(supabase);
  return p.filter((d) => Date.parse(d.policy.scheduled_send.send_at) + graceMs < now.getTime());
}

module.exports = { windowFor, minDelayMs, newerInbound, supersededBy, arm, disarm, pending, overdue, URGENT, _timers: timers };
