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

// Two different facts (Ed 2026-10-22), never merged:
//   bank_decision  the EXCEPTION decision: 'approved_for_payment' or 'returned' (legacy 'paid' =
//                  approved). From the portal (recorded by a person) or NewFirst's own email.
//   cleared_date   the check actually CLEARED, only from a bank statement transaction.
// An approval is not a clearing; nothing here marks a check cleared in the register or
// reconciles it. An item is settled for alerting once it has either one.
const decided = (i) => !!i.bank_decision && i.bank_decision !== 'unconfirmed';
const settled = (i) => decided(i) || !!i.cleared_date;

const LEAD_MIN = Number(process.env.POSITIVE_PAY_ALERT_LEAD_MIN || 60);
const REMIND_LEAD_MIN = Number(process.env.POSITIVE_PAY_REMINDER_LEAD_MIN || 90);
const TRACK_DAYS = Number(process.env.POSITIVE_PAY_TRACK_DAYS || 30);
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
  // Not proof the bank accepted anything: items still unconfirmed near the cutoff, and after it
  // (the bank may have applied its default), are flagged once each.
  const open = (review.items || []).filter((i) => !settled(i));
  const openList = open.map((i) => `${i.account_last4} #${i.check_number} ${(i.amount_cents / 100).toFixed(2)}`).join(', ');
  if (open.length && minsLeft !== null && minsLeft <= LEAD_MIN && minsLeft > 0 && !sent.has('undecided_near_cutoff')) out.push({ kind: 'undecided_near_cutoff', text: `Kat: Positive Pay items not yet decided (${openList}); cutoff ${when}, ${minsLeft} min. An authorized user decides them in the bank portal and records it on the notice.`.slice(0, 590) });
  if (open.length && minsLeft !== null && minsLeft <= -30 && !sent.has('cutoff_passed_unconfirmed')) out.push({ kind: 'cutoff_passed_unconfirmed', text: `Kat: the bank's cutoff (${when}) passed with no recorded decision for ${openList}. The bank may have applied its default; confirm in the portal what happened and record it.`.slice(0, 590) });
  if (review.notice && review.notice.reminder && minsLeft !== null && minsLeft <= REMIND_LEAD_MIN && minsLeft > -30 && !sent.has('reminder_near_cutoff')) {
    out.push({ kind: 'reminder_near_cutoff', text: `Kat: the bank says Positive Pay items are still undecided (${items}); cutoff ${when}, ${Math.max(minsLeft, 0)} min left. An authorized user must decide them in the bank portal.`.slice(0, 590) });
  }
  return out;
}

// Clearing is a separate fact from the exception decision: a presented item that CLEARED shows up
// as a check transaction on the account's imported statement. This records the clearing on the
// notice item only; it never touches the check register or a reconciliation.
async function confirmFromStatements(supabase, review) {
  let changed = false;
  for (const i of review.items || []) {
    if (i.cleared_date || !i.bank_account_id) continue;
    const { data: imps } = await supabase.from('bank_statement_imports').select('id').eq('bank_account_id', i.bank_account_id).limit(500);
    if (!imps || !imps.length) continue;
    const { data: hits } = await supabase.from('bank_statement_transactions').select('posting_date, amount_cents, check_number').in('bank_statement_import_id', imps.map((x) => x.id)).eq('check_number', i.check_number).limit(5);
    const hit = (hits || []).find((h) => Math.abs(Number(h.amount_cents)) === i.amount_cents);
    if (hit) { i.cleared_date = String(hit.posting_date).slice(0, 10); i.cleared_evidence = `check transaction on the bank statement, posted ${i.cleared_date}`; changed = true; }
  }
  return changed;
}

// The bank's own written confirmation (Ed 2026-10-22): a NewFirst PERSON replying on a notice
// thread "We will make sure these items are paid" / "We will pay these items" is the bank stating
// its EXCEPTION DECISION (approved for payment) for the items quoted in that reply. It is not
// evidence the check cleared; clearing comes only from bank transaction activity. Only newfirst-domain senders count, only the
// reply's own text (above the quoted notice) is read, and only the quoted items are marked.
const CONFIRM_PAY = /\bwe will (?:make sure )?(?:that )?(?:these|the|all|those)?\s*items (?:are|will be) paid\b|\bwe will pay (?:these|the|all|those)?\s*items\b/i;
function bankConfirmations(messages, bankDomain = 'newfirst.com') {
  const out = new Map();   // `${last4}|${check}|${cents}` -> { at, quote }
  for (const m of messages || []) {
    if (!new RegExp(`@${bankDomain.replace('.', '\\.')}$`, 'i').test(String(m.sender_email || '').trim())) continue;
    const text = String(m.body_full || m.body_preview || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
    const own = text.split(/\bFrom:\s/)[0];
    const hit = own.match(CONFIRM_PAY);
    if (!hit) continue;
    for (const it of PP.parseNotice(m).items) out.set(`${it.account_last4}|${it.check_number}|${it.amount_cents}`, { at: m.received_at, quote: hit[0] });
  }
  return out;
}
function applyBankConfirmations(review, confirmations) {
  let changed = false;
  for (const i of review.items || []) {
    if (decided(i)) continue;
    const c = confirmations.get(`${i.account_last4}|${i.check_number}|${i.amount_cents}`);
    if (c) { i.bank_decision = 'approved_for_payment'; i.bank_decision_evidence = `exception approved for payment: NewFirst confirmed by email ${String(c.at).slice(0, 16).replace('T', ' ')} UTC: "${c.quote}"`; changed = true; }
  }
  return changed;
}

// Kat's Positive Pay EXCEPTION task (Ed 2026-10-22): one work item per notice day, separate from
// her general Communications queue. It lists each presented item with Kat's recommendation and
// the decision deadline, and closes by evidence once every item has a recorded bank decision.
// Kat investigates and recommends; an authorized person decides Pay or Return in NewFirst.
const EX_OPEN = ['new', 'in_progress', 'waiting'];
const money = (c) => `$${(Number(c || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
function exceptionTask(day, reviews) {
  const items = []; let deadline = null; let discrepancy = false;
  for (const r of reviews) {
    if (r.deadline && (!deadline || r.deadline.at < deadline.at)) deadline = r.deadline;
    for (const i of r.items || []) if (!items.some((x) => x.account_last4 === i.account_last4 && x.check_number === i.check_number)) items.push(i);
  }
  const open = items.filter((i) => !settled(i));
  if (!open.length) return null;
  const line = (i) => {
    const rec = i.verdict === 'matched' ? `matches our register (${i.community_name || ''}, ${i.payee || ''}, issued ${i.issue_date || ''}): Kat recommends Pay` : `${String(i.verdict || 'discrepancy').toUpperCase()}: ${(i.reasons || []).join('; ')}. Kat recommends Return unless the issuer confirms it`;
    if (i.verdict !== 'matched') discrepancy = true;
    return `${i.account_last4} #${i.check_number} ${money(i.amount_cents)}: ${rec}.`;
  };
  return {
    title: `Positive Pay exceptions (NewFirst) ${day}: ${open.length} item${open.length === 1 ? '' : 's'} to decide${deadline ? ` by ${deadline.central}` : ''}`.slice(0, 300),
    summary: open.map(line).join(' ').slice(0, 2000),
    next_step: `An authorized person decides Pay or Return for each item in NewFirst (Positive Pay, Review)${deadline ? ` before ${deadline.central}` : ''}, then records it on the notice in Communications (Paid in portal / Returned). Kat investigates and recommends; she does not decide.`,
    urgency: discrepancy ? 'critical' : 'high',
    sla_due_at: deadline ? deadline.at : null,
  };
}
async function syncExceptionTask(supabase, day, reviews, { now = new Date(), logger = console } = {}) {
  const ref = `positive-pay-exceptions:${day}`;
  const want = exceptionTask(day, reviews);
  const { data: rows, error } = await supabase.from('work_items').select('id, title, summary, urgency').eq('source_ref', ref).in('status', EX_OPEN).limit(1);
  if (error) { logger.warn(`[positive_pay_watch] exception task lookup failed: ${error.message}`); return { action: 'error' }; }
  const cur = (rows || [])[0];
  const ev = async (id, event, detail) => { const { error: e } = await supabase.from('work_item_events').insert({ work_item_id: id, event, actor: 'Kat Reed (AI accounting manager)', detail }); if (e) logger.warn(`[positive_pay_watch] task event not recorded: ${e.message}`); };
  if (!want) {
    if (!cur) return { action: 'none' };
    const { error: e } = await supabase.from('work_items').update({ status: 'done', completed_at: now.toISOString() }).eq('id', cur.id).in('status', EX_OPEN);
    if (e) { logger.warn(`[positive_pay_watch] exception task close failed: ${e.message}`); return { action: 'error' }; }
    await ev(cur.id, 'closed_by_evidence', { detail: 'every presented item has a recorded exception decision or cleared on a statement' });
    return { action: 'closed', id: cur.id };
  }
  if (cur) {
    if (cur.title === want.title && cur.summary === want.summary && cur.urgency === want.urgency) return { action: 'unchanged', id: cur.id };
    const { error: e } = await supabase.from('work_items').update({ title: want.title, summary: want.summary, next_step: want.next_step, urgency: want.urgency }).eq('id', cur.id);
    if (e) { logger.warn(`[positive_pay_watch] exception task update failed: ${e.message}`); return { action: 'error' }; }
    await ev(cur.id, 'agent_touch', { fields: ['title', 'summary', 'next_step', 'urgency'] });
    return { action: 'updated', id: cur.id };
  }
  const { data, error: ie } = await supabase.from('work_items').insert({
    source_type: 'agent', workspace: 'operations', item_type: 'task', module_key: 'positive_pay', horizon: 'now', status: 'new',
    assigned_to: 'Kat', requested_by: 'NewFirst Positive Pay notice', created_by: 'Kat Reed (AI accounting manager)', source_ref: ref, record_ownership: 'workpaper',
    action_url: '/communications.html', why: "NewFirst holds these checks until someone authorized approves or returns them; after the bank's cutoff it applies its default.", ...want,
  }).select('id').single();
  if (ie) { if (String(ie.code) === '23505') return { action: 'race' }; logger.warn(`[positive_pay_watch] exception task open failed: ${ie.message}`); return { action: 'error' }; }
  await ev(data.id, 'created', { source_ref: ref });
  return { action: 'opened', id: data.id };
}

async function tick({ supabase, now = new Date(), notify = null, logger = console } = {}) {
  const textOwner = notify || ((body) => require('../notifications/notify_owner').textOwner(body, { force: true }));
  const since = new Date(now.getTime() - TRACK_DAYS * 86400000).toISOString();
  const { data, error } = await supabase.from('email_messages').select('id, subject, sender_email, recipients, received_at, body_full, body_preview, direction, extracted')
    .ilike('subject', '%positive pay%').gte('received_at', since).order('received_at', { ascending: true }).limit(200);
  if (error) throw new Error(`positive pay notices: ${error.message}`);
  const today = centralDay(now); let alerted = 0, reviewed = 0;
  const confirmations = bankConfirmations(data || []);
  const todays = [];
  for (const m of data || []) {
    if (!PP.isPositivePayNotice(m)) continue;
    let review = m.extracted && m.extracted.positive_pay; let fresh = false;
    const isToday = centralDay(m.received_at) === today;
    if (!review || review.pending_review) {
      if (!isToday) continue;   // only today's notices are reviewed for the first time here
      review = await PP.reviewNotice(supabase, m); reviewed += 1; fresh = true;
    }
    // A bank person's reply quoting the notice is the same items again, not a new notice: it
    // carries evidence (above) but never its own alerts or task (no duplicates).
    const followUp = !!(review.notice && review.notice.replied_by_person);
    if (isToday && !followUp) todays.push(review);
    if ((review.items || []).every(settled) && (review.items || []).every((i) => i.cleared_date || !i.bank_account_id)) continue;
    // evidence from the bank itself: its written confirmation, or a cleared check on a statement
    if (applyBankConfirmations(review, confirmations)) fresh = true;
    if (await confirmFromStatements(supabase, review)) fresh = true;
    // Alerts are for TODAY's notices only: an older notice (the watch first runs with a month of
    // history) is brought up to date quietly, never texted (no backlog of stale alerts).
    const due = isToday && !followUp ? dueAlerts(review, now) : [];
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
  // The task is bookkeeping for Kat: a failure here never stops the alerts above.
  let exception_task = { action: 'none' };
  if (todays.length) {
    try { exception_task = await syncExceptionTask(supabase, today, todays, { now, logger }); }
    catch (e) { logger.warn(`[positive_pay_watch] exception task not synced: ${e.message}`); exception_task = { action: 'error' }; }
  }
  return { reviewed, alerted, exception_task: exception_task.action };
}

module.exports = { tick, dueAlerts, confirmFromStatements, bankConfirmations, applyBankConfirmations, exceptionTask, syncExceptionTask, CONFIRM_PAY, LEAD_MIN, REMIND_LEAD_MIN, TRACK_DAYS };
