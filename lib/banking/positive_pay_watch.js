// ============================================================================
// lib/banking/positive_pay_watch.js — Kat watches the bank's Positive Pay cutoff
// (Ed 2026-10-14)
// ----------------------------------------------------------------------------
// Every scheduler tick on a business day, for each Positive Pay notice received
// today that nobody has marked decided:
//   * an EXCEPTION (unmatched or discrepant item, unexpected recipient, notice
//     from the wrong domain) texts Ed once, at once;
//   * an exception still open within LEAD_MIN of the bank's cutoff texts him again;
//   * a bank REMINDER (items still undecided) within REMIND_LEAD_MIN of the cutoff
//     is itself an exception: the cutoff may be missed. Texts Ed once.
// Routine matched items do not text Ed: they are decided Pay in the bank portal by
// an authorized user (there is no bank API), and Kat's review on the notice says so.
// Alerts are recorded on the notice (extracted.positive_pay.alerts) so each one goes
// once. Reads email_messages; writes only that record; never touches a bank.
// ============================================================================
const PP = require('./positive_pay_notice');

const LEAD_MIN = Number(process.env.POSITIVE_PAY_ALERT_LEAD_MIN || 60);
const REMIND_LEAD_MIN = Number(process.env.POSITIVE_PAY_REMINDER_LEAD_MIN || 90);
const centralDay = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(d));

// Pure: which alerts are due for one notice now. review = extracted.positive_pay.
function dueAlerts(review, now = new Date()) {
  if (!review || review.decided_at) return [];
  const sent = new Set((review.alerts || []).map((a) => a.kind));
  const out = [];
  const deadline = review.deadline && new Date(review.deadline.at);
  const minsLeft = deadline ? Math.round((deadline - now) / 60000) : null;
  const items = (review.items || []).map((i) => `${i.account_last4} #${i.check_number} $${(i.amount_cents / 100).toFixed(2)}`).join(', ');
  const when = review.deadline ? review.deadline.central : 'the bank cutoff';
  // Unexpected recipients are the vigilance engine's case (lib/vigilance): one case, one escalation.
  const ex = (review.escalate || []).filter((e) => !/^unexpected recipient/.test(e));
  if (ex.length) {
    if (!sent.has('exception')) out.push({ kind: 'exception', text: `Kat: Positive Pay exception needs you (${when}). ${ex.join(' ')}`.slice(0, 590) });
    else if (minsLeft !== null && minsLeft <= LEAD_MIN && minsLeft > -30 && !sent.has('exception_deadline')) out.push({ kind: 'exception_deadline', text: `Kat: Positive Pay exception still open, cutoff ${when} (${Math.max(minsLeft, 0)} min). ${ex[0]}`.slice(0, 590) });
  }
  if (review.notice && review.notice.reminder && minsLeft !== null && minsLeft <= REMIND_LEAD_MIN && minsLeft > -30 && !sent.has('reminder_near_cutoff')) {
    out.push({ kind: 'reminder_near_cutoff', text: `Kat: the bank says Positive Pay items are still undecided (${items}); cutoff ${when}, ${Math.max(minsLeft, 0)} min left. An authorized user must decide them in the bank portal.`.slice(0, 590) });
  }
  return out;
}

async function tick({ supabase, now = new Date(), notify = null, logger = console } = {}) {
  const textOwner = notify || ((body) => require('../notifications/notify_owner').textOwner(body, { force: true }));
  const since = new Date(now.getTime() - 36 * 3600 * 1000).toISOString();
  const { data, error } = await supabase.from('email_messages').select('id, subject, sender_email, recipients, received_at, body_full, body_preview, direction, extracted')
    .ilike('subject', '%positive pay%').gte('received_at', since).order('received_at', { ascending: true }).limit(200);
  if (error) throw new Error(`positive pay notices: ${error.message}`);
  const today = centralDay(now); let alerted = 0, reviewed = 0;
  for (const m of data || []) {
    if (centralDay(m.received_at) !== today || !PP.isPositivePayNotice(m)) continue;
    let review = m.extracted && m.extracted.positive_pay; let fresh = false;
    if (!review || review.pending_review) { review = await PP.reviewNotice(supabase, m); reviewed += 1; fresh = true; }
    const due = dueAlerts(review, now);
    if (!due.length && !fresh) continue;
    const alerts = [...(review.alerts || [])];
    for (const a of due) {
      const r = await textOwner(a.text);
      alerts.push({ kind: a.kind, at: now.toISOString(), delivered: !!(r && r.ok), detail: r && (r.error || r.sid) || null });
      if (r && r.ok) alerted += 1; else logger.warn(`[positive_pay_watch] owner alert not delivered (${a.kind}): ${(r && r.error) || 'unknown'}`);
    }
    const { error: ue } = await supabase.from('email_messages').update({ persona: 'kat', extracted: { ...(m.extracted || {}), positive_pay: { ...review, alerts } } }).eq('id', m.id);
    if (ue) logger.warn(`[positive_pay_watch] could not record review on ${m.id}: ${ue.message}`);
  }
  return { reviewed, alerted };
}

module.exports = { tick, dueAlerts, LEAD_MIN, REMIND_LEAD_MIN };
