#!/usr/bin/env node
// Kat's banking mail (Ed 2026-10-22): kat@ only is ingested automatically, every 15-minute tick
// 6:00-10:00 am Central on business days and about hourly otherwise; the Positive Pay watch runs
// right after it; NewFirst's own "we will pay these items" reply is evidence of the bank's
// decision; one exception task per notice day carries Kat's recommendation; alerts are for
// today's notices only (no backlog of stale texts) and never duplicated. Offline.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://offline.invalid';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'offline';
const K = require('../lib/banking/kat_banking_mail');
const W = require('../lib/banking/positive_pay_watch');
let pass = 0, fail = 0;
const check = (name, ok, info) => { if (ok) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name + (info ? ' :: ' + info : '')); } };

// Minimal PostgREST stand-in: select/eq/in/ilike/gte/order/limit/single, insert, update.
function store(T) {
  let n = 0;
  return { T, from(table) {
    let op = 'select', payload = null, one = false, sel = false; const f = [];
    const api = {
      select() { sel = true; return api; }, eq(c, v) { f.push((r) => r[c] === v); return api; }, in(c, v) { f.push((r) => v.includes(r[c])); return api; },
      ilike() { return api; }, gte() { return api; }, order() { return api; }, limit() { return api; }, single() { one = true; return api; }, not() { return api; },
      insert(rows) { op = 'insert'; payload = Array.isArray(rows) ? rows : [rows]; return api; }, update(p) { op = 'update'; payload = p; return api; },
      then(res, rej) { return Promise.resolve(run()).then(res, rej); },
    };
    function run() {
      const t = T[table] || (T[table] = []);
      if (op === 'insert') {
        const rows = payload.map((r) => ({ id: `${table}-${++n}`, ...r }));
        if (table === 'work_items' && rows.some((r) => t.some((w) => w.source_ref === r.source_ref && ['new', 'in_progress', 'waiting'].includes(w.status)))) return { data: null, error: { code: '23505', message: 'dup' } };
        t.push(...rows); return { data: sel ? (one ? rows[0] : rows) : null, error: null };
      }
      const rows = t.filter((r) => f.every((g) => g(r)));
      if (op === 'update') { rows.forEach((r) => Object.assign(r, JSON.parse(JSON.stringify(payload)))); return { data: sel ? rows : null, error: null }; }
      return { data: one ? rows[0] || null : rows.map((r) => JSON.parse(JSON.stringify(r))), error: null };
    }
    return api;
  } };
}

const rowsHtml = (rows) => `<table><tr><td>Account Number</td><td>Date</td><td>Item Number</td><td>Amount</td></tr>${rows.map((r) => `<tr><td>DDA-XX${r[0]}</td><td>October 22, 2026</td><td>${r[1]}</td><td>$${r[2]}</td></tr>`).join('')}</table>`;
const item = (last4, check, cents, verdict = 'matched', extra = {}) => ({ account_last4: last4, presented_date: '2026-10-21', check_number: check, amount_cents: cents, verdict, bank_decision: 'unconfirmed', reasons: verdict === 'matched' ? [] : ['check 9999 is not in the issued-check register'], community_name: 'Waterview Estates', payee: 'Versatex Commercial Services LLC', issue_date: '2026-10-01', ...extra });
const deadline = { at: '2026-10-22T15:00:00.000Z', central: '10:00 Central on 2026-10-22', source: 'bank configuration' };
const review = (items, extra = {}) => ({ items, deadline, notice: { reminder: false, replied_by_person: false }, escalate: items.filter((i) => i.verdict !== 'matched').map((i) => `${i.account_last4} check ${i.check_number}: ${i.reasons.join('; ')}`), alerts: [], ...extra });

(async () => {
  console.log('cadence: kat@ only, every tick in the morning window');
  const at = (iso) => K.pollDue(new Date(iso));
  check('Thursday 7:20 am Central: due (morning window, every 15-minute tick)', at('2026-10-22T12:20:00Z').due && at('2026-10-22T12:20:00Z').mode === 'morning_window');
  check('Thursday 6:00 and 9:59 am Central: due; 10:00 am: falls back to hourly', at('2026-10-22T11:00:00Z').due && at('2026-10-22T14:59:00Z').due && at('2026-10-22T15:20:00Z').mode === 'hourly');
  check('outside the window: about hourly (the first tick of each hour)', at('2026-10-22T18:05:00Z').due && !at('2026-10-22T18:20:00Z').due);
  check('Saturday morning: hourly, not every tick (no notices on weekends)', !at('2026-10-24T12:20:00Z').due && at('2026-10-24T12:05:00Z').due);
  const calls = [];
  const r = await K.tick({ supabase: {}, now: new Date('2026-10-22T12:20:00Z'), ingest: async (mbx, o) => { calls.push({ mbx, o }); return { scanned: 3, kept: 1 }; }, watch: async () => ({ reviewed: 1, alerted: 0 }), logger: { warn() {} } });
  check('ingests ONLY kat@bedrocktx.com, current mail, no Inbox filing sweep, never stacking on a running pull', calls.length === 1 && calls[0].mbx === 'kat@bedrocktx.com' && calls[0].o.fileBacklog === false && calls[0].o.light === false && calls[0].o.skipIfBusy === true && r.kept === 1);
  let watched = false;
  const r2 = await K.tick({ supabase: {}, now: new Date('2026-10-22T12:20:00Z'), ingest: async () => { throw new Error('graph 503'); }, watch: async () => { watched = true; return {}; }, logger: { warn() {} } });
  check('an ingest failure is reported and the watch still runs (notices already in trustEd keep their escalation)', watched && r2.errors.includes('graph 503'));
  const skip = await K.tick({ supabase: {}, now: new Date('2026-10-22T18:20:00Z'), ingest: async () => { throw new Error('should not run'); }, watch: async () => { throw new Error('should not run'); } });
  check('not due: nothing runs', skip.fired === false && skip.reason === 'not_due');

  console.log("NewFirst's own confirmation is evidence of its decision");
  const reply = { direction: 'inbound', sender_email: 'TreasuryManagement@newfirst.com', subject: 'RE: Positive Pay Items Ready For Review', received_at: '2026-10-22T13:45:00Z',
    body_full: `Thank you, Celina! We will pay these items, and I will update you soon regarding your Positive Pay issue. From: Celina Deleon Sent: Thursday 8:40 AM Subject: Re: Positive Pay Items Ready For Review I have reviewed and approved all these below. From: treasurymanagement@newfirst.com Subject: Positive Pay Items Ready For Review You have positive pay items to review. Please review these by 11:00AM. Account Number Date Item Number Amount ${rowsHtml([['5961', '1024', '6300.16'], ['5961', '1032', '3250.00']])}` };
  const conf = W.bankConfirmations([reply]);
  check('a NewFirst person writing "We will pay these items" confirms exactly the quoted items', conf.size === 2 && conf.has('5961|1024|630016') && conf.has('5961|1032|325000'));
  check('the other wording NewFirst uses also counts ("We will make sure these items are paid")', W.bankConfirmations([{ ...reply, body_full: `Thank you, Celina. We will make sure these items are paid. From: x ${rowsHtml([['5961', '1038', '895.00']])}` }]).has('5961|1038|89500'));
  check('only the bank: the same words from anyone else are not the bank\'s decision', !W.bankConfirmations([{ ...reply, sender_email: 'cdeleon@bedrocktx.com' }]).size && !W.bankConfirmations([{ ...reply, sender_email: 'someone@newfirst.com.evil.test' }]).size);
  check('the automated notice itself is not a confirmation', !W.bankConfirmations([{ ...reply, body_full: `You have positive pay items to review. ${rowsHtml([['5961', '1024', '6300.16']])}` }]).size);
  check('words quoted from an EARLIER message do not count (only the reply\'s own text, above "From:")', !W.bankConfirmations([{ ...reply, body_full: `Following up. From: Treasury Subject: RE We will pay these items ${rowsHtml([['5961', '1024', '6300.16']])}` }]).size);

  console.log("Kat's exception task: recommend, never decide");
  const t1 = W.exceptionTask('2026-10-22', [review([item('5961', '1024', 630016), item('5313', '9999', 1000, 'unmatched')])]);
  check('one task lists every item with Kat\'s recommendation and the 10:00 deadline', /2 items to decide by 10:00 Central/.test(t1.title) && /1024 \$6,300\.16: matches our register .*Kat recommends Pay/.test(t1.summary) && /9999 \$10\.00: UNMATCHED: .*Kat recommends Return unless the issuer confirms it/.test(t1.summary) && t1.sla_due_at === deadline.at);
  check('the decision is a person\'s, in NewFirst; Kat does not decide', /An authorized person decides Pay or Return/.test(t1.next_step) && /she does not decide/.test(t1.next_step) && t1.urgency === 'critical');
  check('every item decided: no task', W.exceptionTask('2026-10-22', [review([item('5961', '1024', 630016, 'matched', { bank_decision: 'paid' })])]) === null);

  console.log('the watch end to end');
  const now = new Date('2026-10-22T12:30:00Z');   // 7:30 am Central
  const notice = (id, received, items, extra = {}) => ({ id, direction: 'inbound', sender_email: 'treasurymanagement@newfirst.com', subject: 'Positive Pay Items Ready For Review', received_at: received, recipients: [],
    body_full: `You have positive pay items to review. Please review these by 11:00AM. Account Number Date Item Number Amount ${rowsHtml(items.map((i) => [i.account_last4, i.check_number, (i.amount_cents / 100).toFixed(2)]))}`, extracted: { positive_pay: review(items) }, ...extra });
  const db = store({ email_messages: [
    notice('old', '2026-10-09T11:56:00Z', [item('5961', '1033', 74000)]),              // a stale notice from before the watch ever ran
    notice('today', '2026-10-22T11:55:00Z', [item('5961', '1024', 630016), item('5313', '9999', 1000, 'unmatched')]),
  ], work_items: [], work_item_events: [], bank_statement_imports: [] });
  const texts = [];
  const notify = async (b) => { texts.push(b); return { ok: true, sid: 'SM' }; };
  const a = await W.tick({ supabase: db, now, notify, logger: { warn() {} } });
  const tasks = () => db.T.work_items.filter((w) => /^positive-pay-exceptions:/.test(w.source_ref) && w.status !== 'done');
  check('the unmatched item texts Ed once, at once; the stale October 9 notice texts nobody', texts.length === 1 && /9999/.test(texts[0]) && !texts.some((t) => /1033/.test(t)), JSON.stringify(texts));
  check('one exception task for today, in Kat\'s queue', tasks().length === 1 && tasks()[0].assigned_to === 'Kat' && tasks()[0].source_ref === 'positive-pay-exceptions:2026-10-22' && a.exception_task === 'opened');
  await W.tick({ supabase: db, now: new Date('2026-10-22T12:45:00Z'), notify, logger: { warn() {} } });
  check('the next tick: no duplicate text, no second task', texts.length === 1 && tasks().length === 1);
  db.T.email_messages.push({ ...reply, id: 'bankreply', body_full: reply.body_full.replace(rowsHtml([['5961', '1024', '6300.16'], ['5961', '1032', '3250.00']]), rowsHtml([['5961', '1024', '6300.16'], ['5313', '9999', '10.00']])) });
  await W.tick({ supabase: db, now: new Date('2026-10-22T13:50:00Z'), notify, logger: { warn() {} } });
  const rec = db.T.email_messages.find((m) => m.id === 'today').extracted.positive_pay;
  check('NewFirst replies "We will pay these items": both items recorded APPROVED FOR PAYMENT, with the bank\'s words as evidence', rec.items.every((i) => i.bank_decision === 'approved_for_payment' && /exception approved for payment: NewFirst confirmed by email/.test(i.bank_decision_evidence)));
  check('an approval email never marks a check cleared (clearing comes only from bank transaction activity)', rec.items.every((i) => !i.cleared_date && !i.cleared_evidence));
  { const fs2 = require('fs'); const p2 = require('path'); const src2 = fs2.readFileSync(p2.join(__dirname, '..', 'lib', 'banking', 'positive_pay_watch.js'), 'utf8');
    check('nothing in the Positive Pay watch writes the check register or a reconciliation', !/from\('check_register'\)\.update|from\('bank_rec|cleared_date:\s*[^,]*register/.test(src2) && !/check_register/.test(src2.replace(/\/\/[^\n]*/g, ''))); }
  check('the task closes by evidence and the reply opened nothing of its own', !tasks().length && db.T.work_item_events.some((e) => e.event === 'closed_by_evidence') && texts.length === 1);
  await W.tick({ supabase: db, now: new Date('2026-10-22T14:15:00Z'), notify, logger: { warn() {} } });
  check('9:15 am: decided items raise no "still undecided" text', texts.length === 1);

  console.log('a routine day with no bank reply: one reminder before the cutoff');
  const db2 = store({ email_messages: [notice('r', '2026-10-22T11:55:00Z', [item('5961', '1024', 630016)])], work_items: [], work_item_events: [], bank_statement_imports: [] });
  const t2 = [];
  await W.tick({ supabase: db2, now: new Date('2026-10-22T12:30:00Z'), notify: async (b) => { t2.push(b); return { ok: true }; }, logger: { warn() {} } });
  check('matched items only: no text at 7:30 (nothing for Ed yet), but the task is in Kat\'s queue', !t2.length && db2.T.work_items.length === 1 && db2.T.work_items[0].urgency === 'high');
  await W.tick({ supabase: db2, now: new Date('2026-10-22T14:05:00Z'), notify: async (b) => { t2.push(b); return { ok: true }; }, logger: { warn() {} } });
  check('9:05 am, still undecided: one text with an hour to spare', t2.length === 1 && /not yet decided/.test(t2[0]) && /55 min/.test(t2[0]));

  const fs = require('fs'); const path = require('path');
  const sched = fs.readFileSync(path.join(__dirname, '..', 'lib', 'scheduler.js'), 'utf8');
  check('wired: kat_banking_mail registered on the scheduler; the standalone watch defers to it (never both)', /name: 'kat_banking_mail'/.test(sched) && /minIntervalMin: 10/.test(sched) && /run by kat_banking_mail/.test(sched));
  check('wired: no other mailbox is auto-ingested (the general job is still manual unless EMAIL_INGEST_AUTO)', /if \(process\.env\.EMAIL_INGEST_AUTO !== 'true'\) return \{ fired: false, reason: 'manual_only' \}/.test(sched));

  console.log(`\nkat_banking_mail: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
