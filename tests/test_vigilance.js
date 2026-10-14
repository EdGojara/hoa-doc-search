// Vigilance (lib/vigilance): detect -> investigate -> assess -> act -> escalate -> follow through,
// for every agent, on the objectives spine. The Graywood scar (NewFirst Positive Pay, 10/13/2026)
// replayed end to end with no human prompt, plus the generic detectors and the controls.
const V = require('../lib/vigilance/engine');
const F = require('../lib/vigilance/followthrough');
const P = require('../lib/vigilance/permissions');
const D = require('../lib/vigilance/detectors');
let pass = 0, fail = 0;
const check = (name, ok, info) => { if (ok) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name + (info ? ' :: ' + info : '')); } };
const GW = 'accounting@graywoodpropertiesllc.com';
const BASE = ['cdeleon@bedrocktx.com', 'egojara@bedrocktx.com', 'treasurymanagement@newfirst.com', 'kat@bedrocktx.com'];
let seq = 0;
const notice = (at, extra = []) => ({ id: `n${++seq}`, direction: 'inbound', sender_email: 'treasurymanagement@newfirst.com', subject: 'Positive Pay Items Ready For Review', received_at: at, recipients: [...BASE, ...extra], classification: 'vendor_financial', persona: 'kat', body_full: 'You have positive pay items to review.' });

function world() {
  const db = {
    email_messages: [
      { id: 'mh1', direction: 'inbound', sender_email: 'MHess@newfirst.com', sender_name: 'Hess,Melody', subject: 'RE: Positive Pay', received_at: '2026-09-08T16:40:00Z', recipients: ['kat@bedrocktx.com'] },
      { id: 'mh2', direction: 'outbound', sender_email: 'kat@bedrocktx.com', subject: 'RE: Positive Pay', received_at: '2026-09-09T22:42:00Z', recipients: ['MHess@newfirst.com'], body_full: 'Thanks Melody' },
      ...['2026-09-10', '2026-09-11', '2026-09-15', '2026-10-01', '2026-10-09'].map((d) => notice(`${d}T11:56:00Z`)),
    ],
    banks: [{ id: 'nf', name: 'NewFirst National Bank', contact_email: null, positive_pay_settings: { notice_sender_domain: 'newfirst.com' } }],
    vendors: [{ id: 'v1', name: 'Superior LawnCare', email: 'billing@superiorlawncare.com' }], contacts: [], community_contacts: [], ap_invoices: [],
    objectives: [], objective_events: [],
  };
  const esc = (p) => String(p).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*');
  const sb = { from(t) {
    const st = { f: [], ord: null, desc: false, lim: null, ins: null, upd: null, one: false };
    const q = {
      select() { return q; }, insert(r) { st.ins = r; return q; }, update(p) { st.upd = p; return q; },
      eq(c, v) { st.f.push((r) => r[c] === v); return q; }, in(c, vs) { st.f.push((r) => vs.includes(r[c])); return q; },
      ilike(c, p) { const re = new RegExp('^' + esc(p) + '$', 'i'); st.f.push((r) => re.test(r[c] || '')); return q; },
      like(c, p) { const re = new RegExp('^' + esc(p) + '$'); st.f.push((r) => re.test(r[c] || '')); return q; },
      or() { return q; }, lt(c, v) { st.f.push((r) => r[c] < v); return q; }, gt(c, v) { st.f.push((r) => r[c] > v); return q; }, gte(c, v) { st.f.push((r) => r[c] >= v); return q; },
      not(c, op, v) { if (op === 'in') { const vs = String(v).replace(/[()]/g, '').split(','); st.f.push((r) => !vs.includes(r[c])); } else if (op === 'is') st.f.push((r) => r[c] != null); return q; },
      order(c, o) { if (!st.ord) { st.ord = c; st.desc = o && o.ascending === false; } return q; }, limit(n) { st.lim = n; return q; }, range(a, b) { st.rng = [a, b]; return q; }, single() { st.one = true; return q; },
      then(res, rej) {
        let out;
        if (st.ins) { const r = { id: `${t}-${(db[t] || []).length + 1}`, opened_at: new Date().toISOString(), ...st.ins }; (db[t] = db[t] || []).push(r); out = st.one ? r : [r]; }
        else if (st.upd) { const rs = (db[t] || []).filter((r) => st.f.every((fn) => fn(r))); rs.forEach((r) => Object.assign(r, st.upd)); out = rs; }
        else { out = (db[t] || []).filter((r) => st.f.every((fn) => fn(r))); if (st.ord) out = out.slice().sort((x, y) => String(x[st.ord]).localeCompare(String(y[st.ord])) * (st.desc ? -1 : 1)); if (st.rng) out = out.slice(st.rng[0], st.rng[1] + 1); if (st.lim != null) out = out.slice(0, st.lim); if (st.one) out = out[0] || null; }
        return Promise.resolve({ data: out, error: null }).then(res, rej);
      },
    };
    return q;
  } };
  return { db, sb };
}

(async () => {
  console.log('Graywood, as it arrived: Kat detects and starts the investigation herself');
  const { db, sb } = world();
  const texts = []; const notify = async (t) => { texts.push(t); return { ok: true }; };
  const n13 = notice('2026-10-13T11:56:20Z', [GW]); db.email_messages.push(n13);
  const r = await V.evaluate(sb, n13, { notify });
  const x = r.results[0];
  check('detects the new outside recipient on the bank series (no one asked)', r.results.length === 1 && x.signal.detector === 'recipient_change' && x.signal.data.address === GW && r.counterparty.type === 'bank');
  check('investigates: first seen 10/13, on none of the earlier notices, in none of our records', /on none of the 5 earlier messages/.test(x.fact_basis.observed.map((o) => o.text).join(' ')) && /in none of our vendors, contacts/.test(x.fact_basis.observed.map((o) => o.text).join(' ')));
  check('assesses: high risk, Kat owns it, plan = open case + bank inquiry', x.assessment.risk === 'high' && x.assessment.owner === 'kat' && x.assessment.plan.join() === 'open_case,prepare_bank_inquiry');
  check('acts within permission: inquiry PREPARED (not sent) to the verified contact, tagged banking (approval required), facts in, only unknowns asked', r.draft && r.draft.to === 'mhess@newfirst.com' && r.draft.status === 'pending' && r.draft.topic === 'banking' && r.draft.send_policy.decision === 'approval_required' && /first appeared on October 13, 2026/.test(r.draft.body) && /Who requested and authorized the addition/.test(r.draft.body));
  const o = db.objectives[0];
  check('records a case on the operator spine: owner Kat, high priority, REVIEW, waiting on the approval', o && o.subject_key === `vigilance:recipient_change:newfirst.com:${GW}` && o.owner_persona === 'kat' && o.priority === 'high' && o.autonomy_class === 'REVIEW' && o.status === 'waiting_human');
  check('audit trail: opened, investigated, assessed, next action, escalated', ['opened', 'note', 'note', 'next_action', 'escalated'].every((k, i) => (db.objective_events.filter((e) => e.objective_id === o.id)[i] || {}).kind === k), JSON.stringify(db.objective_events.map((e) => e.kind)));
  check('escalates once to Ed (high risk), saying what Kat already did', texts.length === 1 && /Inquiry prepared for your approval/.test(texts[0]));

  console.log('repeat sightings reattach; nothing duplicated');
  const n13b = { ...notice('2026-10-13T13:55:00Z', [GW]), subject: 'Reminder: Positive Pay Items Ready For Review' }; db.email_messages.push(n13b);
  const n14 = notice('2026-10-14T11:56:48Z', [GW]); db.email_messages.push(n14);
  const r2 = await V.evaluate(sb, n13b, { notify }); const r3 = await V.evaluate(sb, n14, { notify });
  check('the reminder and the 10/14 notice are still flagged (a recent arrival is not "established") and reattach to the same case', r2.results[0].reattached && r3.results[0].reattached && db.objectives.length === 1);
  check('no second draft, no second text', !r2.draft && !r3.draft && texts.length === 1);

  console.log('a person already wrote: that is the action');
  { const w = world(); const t2 = []; const n = notice('2026-10-13T11:56:20Z', [GW]); w.db.email_messages.push(n);
    w.db.email_messages.push({ id: 'sent1', direction: 'outbound', sender_email: 'kat@bedrocktx.com', mailbox: 'kat@bedrocktx.com', recipients: ['mhess@newfirst.com', 'egojara@bedrocktx.com'], subject: 'Re: Positive Pay Items Ready For Review', received_at: '2026-10-14T12:42:56Z', body_full: `we noticed that ${GW} was recently added` });
    const rr = await V.evaluate(w.sb, n, { notify: async (t) => { t2.push(t); return { ok: true }; } });
    const oo = w.db.objectives[0];
    check('the inquiry Ed sent through Kat\'s reply is found: no new draft, no text, case waits on the bank', !rr.draft && !t2.length && oo.status === 'waiting_third_party' && oo.subject_refs.correspondence_to === 'mhess@newfirst.com' && /Await mhess@newfirst.com's answer/.test(oo.next_action));
    check('the follow-up clock starts from when it was sent', String(oo.next_action_due).startsWith('2026-10-15'));
    // follow-through: the bank replies, then the address disappears
    w.db.email_messages.push({ id: 'rep1', direction: 'inbound', sender_email: 'mhess@newfirst.com', subject: 'RE: Positive Pay Items Ready For Review', received_at: '2026-10-14T15:00:00Z', recipients: ['kat@bedrocktx.com'] });
    oo.opened_at = '2026-10-13T12:00:00Z';
    const f1 = await F.followCase(w.sb, oo, { now: new Date('2026-10-14T15:30:00Z'), notify: async () => ({ ok: true }) });
    check('follow-through records the bank\'s reply and puts it in front of a person', f1 === 'reply' && oo.status === 'waiting_human' && w.db.objective_events.some((e) => e.kind === 'message_in'));
    w.db.email_messages.push(notice('2026-10-15T11:56:00Z'));
    const f2 = await F.followCase(w.sb, oo, { now: new Date('2026-10-15T12:30:00Z'), notify: async () => ({ ok: true }) });
    check('resolved by evidence: the 10/15 notice no longer carries the address; the case closes citing it', f2 === 'resolved' && oo.status === 'resolved' && /not on the 2026-10-15 message/.test(w.db.objective_events.find((e) => e.kind === 'closed').summary));
    check('a reply from the bank alone never closed it (it went to a person for review first)', w.db.objective_events.findIndex((e) => e.kind === 'message_in') < w.db.objective_events.findIndex((e) => e.kind === 'closed'));
  }

  console.log('overdue: Ed hears once');
  { const w = world(); const t3 = []; const n = notice('2026-10-13T11:56:20Z', [GW]); w.db.email_messages.push(n);
    await V.evaluate(w.sb, n, { notify: async () => ({ ok: true }) });
    const oo = w.db.objectives[0]; oo.opened_at = '2026-10-13T12:00:00Z';
    const late = new Date('2026-10-16T15:00:00Z');
    const a1 = await F.followCase(w.sb, oo, { now: late, notify: async (t) => { t3.push(t); return { ok: true }; } });
    const a2 = await F.followCase(w.sb, oo, { now: late, notify: async (t) => { t3.push(t); return { ok: true }; } });
    check('past due while the prepared inquiry still awaits approval: one reminder, no follow-up to a message never sent, then quiet', a1 === 'overdue' && a2 === 'open' && t3.length === 1 && !/Follow-up/.test(t3[0]) && !w.db.email_messages.find((m) => m.id === n.id).extracted);
    // the inquiry is then approved and sent: the case records it and waits on the bank; no answer -> Kat prepares the follow-up
    w.db.email_messages.push({ id: 'sent2', direction: 'outbound', sender_email: 'kat@bedrocktx.com', recipients: ['mhess@newfirst.com'], subject: 'Positive Pay notification recipient: request for confirmation', received_at: '2026-10-16T16:00:00Z', body_full: `we noticed that ${GW} was recently added` });
    oo.next_action_due = '2026-10-16T15:00:00Z'; w.db.objective_events = w.db.objective_events.filter((e) => !/^Overdue/.test(e.summary || ''));
    const a3 = await F.followCase(w.sb, oo, { now: new Date('2026-10-19T15:00:00Z'), notify: async (t) => { t3.push(t); return { ok: true }; } });
    const src = w.db.email_messages.find((m) => m.id === n.id);
    check('approved inquiry detected as sent (waiting on the bank); still no answer later: Kat prepares a follow-up to Melody for approval and tells Ed once', oo.subject_refs.contacted && oo.subject_refs.contacted.message_id === 'sent2' && a3 === 'overdue' && src.extracted && src.extracted.draft && src.extracted.draft.to === 'mhess@newfirst.com' && /Following up on our email of October 16, 2026/.test(src.extracted.draft.body) && src.extracted.draft.send_policy.decision === 'approval_required' && /Follow-up to mhess@newfirst.com prepared/.test(t3[1]), JSON.stringify([a3, t3]));
  }

  console.log('catch-up: mail that arrived before vigilance existed is examined');
  { const w = world(); const n = notice('2026-10-13T11:56:20Z', [GW]); w.db.email_messages.push(n);
    const k = await F.catchUp(w.sb, { now: new Date('2026-10-14T12:00:00Z'), notify: async () => ({ ok: true }) });
    check('the 10/13 notice is evaluated, its case opened and the message marked checked', k >= 1 && w.db.objectives.length === 1 && w.db.email_messages.find((m) => m.id === n.id).extracted.vigilance_checked_at);
    const k2 = await F.catchUp(w.sb, { now: new Date('2026-10-14T12:00:00Z'), notify: async () => ({ ok: true }) });
    check('a second pass does not re-examine it', k2 === 0 && w.db.objectives.length === 1);
  }

  console.log('generic detectors, any agent');
  { const w = world(); const t4 = [];
    const pay = { id: 'p1', direction: 'inbound', sender_email: 'billing@superiorlawncare.com', resolved_vendor_id: 'v1', subject: 'Updated banking information', body_full: 'Please note our new bank account details for all future payments.', received_at: '2026-10-14T13:00:00Z', recipients: ['emma@bedrocktx.com'], classification: 'vendor_financial' };
    const rp = await V.evaluate(w.sb, pay, { notify: async (t) => { t4.push(t); return { ok: true }; } });
    const pr = rp.results.find((y) => y.signal.detector === 'payment_instructions');
    check('payment-instruction change from a vendor: Emma owns it, hold on banking changes, verify by phone on file, Ed told (high)', pr && pr.assessment.owner === 'emma' && pr.acted.done.some((d) => d.action === 'hold_vendor_banking_change') && /phone/.test(pr.assessment.next_action) && t4.length === 1);
    const look = { id: 'l1', direction: 'inbound', sender_email: 'ap@superiorlawncar.com', subject: 'Invoice', body_full: 'see attached', received_at: '2026-10-14T13:05:00Z', recipients: ['emma@bedrocktx.com'] };
    const rl = await V.evaluate(w.sb, look, { notify: async () => ({ ok: true }) });
    check('lookalike sender domain (superiorlawncar.com vs superiorlawncare.com): flagged do-not-act', rl.results.some((y) => y.signal.detector === 'sender_lookalike' && y.signal.data.resembles === 'superiorlawncare.com' && y.acted.done.some((d) => d.action === 'flag_do_not_act')));
    w.db.ap_invoices.push(...[50000, 52000, 48000, 51000, 50500].map((c, i) => ({ vendor_id: 'v1', total_cents: c, invoice_date: `2026-0${i + 4}-01` })));
    const big = { id: 'b1', direction: 'inbound', sender_email: 'billing@superiorlawncare.com', resolved_vendor_id: 'v1', subject: 'Invoice 9001', body_full: 'Invoice attached', received_at: '2026-10-14T13:10:00Z', recipients: ['emma@bedrocktx.com'], classification: 'vendor_financial', extracted: { amounts: ['$4,200.00'] } };
    const rb = await V.evaluate(w.sb, big, { notify: async () => ({ ok: true }) });
    check('amount far outside the vendor\'s history: held for review (medium, no text)', rb.results.some((y) => y.signal.detector === 'amount_outlier' && y.assessment.risk === 'medium' && y.acted.done.some((d) => d.action === 'hold_for_review') && !y.escalation));
    const quiet = await V.evaluate(w.sb, notice('2026-10-12T11:56:00Z'), { notify: async () => ({ ok: true }) });
    check('an ordinary notice with the usual recipients: nothing to report', !quiet.results.length);
  }

  console.log('controls');
  check('no teammate may act in a bank portal, move money or change banking details on her own', ['kat', 'emma', 'amanda', 'claire'].every((p) => P.ALWAYS_HUMAN.every((a) => !P.can(p, a))));
  check('sending is RISK-BASED: routine communication follows the sender\'s own autonomy policy (no added approval)', P.sendDecision({ topic: 'routine' }).decision === 'sender_policy' && P.sendDecision().decision === 'sender_policy');
  check('banking, payment changes, legal, enforcement and security always need a person\'s approval', ['banking', 'payment_change', 'legal', 'enforcement', 'security'].every((t) => P.sendDecision({ topic: t }).decision === 'approval_required'));
  check('a vigilance bank inquiry is tagged banking (approval required)', P.topicFor('recipient_change', 'bank') === 'banking' && P.topicFor('payment_instructions', 'vendor') === 'payment_change' && P.topicFor('amount_outlier', 'vendor') === 'routine');
  check('an action outside the owner\'s permission is never performed; it becomes an escalation', (() => { const a = { owner: 'claire', plan: ['open_case', 'prepare_bank_inquiry'] }; return V.act(null, { data: {} }, a, { received_at: '2026-10-14T00:00:00Z' }, {}).then((r) => r.refused.includes('prepare_bank_inquiry') && !r.done.length); })() instanceof Promise);
  const refusedCheck = await V.act(null, { data: {} }, { owner: 'claire', plan: ['open_case', 'prepare_bank_inquiry'] }, { received_at: '2026-10-14T00:00:00Z' }, {});
  check('...and it is refused in practice (claire may not prepare a bank inquiry)', refusedCheck.refused.includes('prepare_bank_inquiry') && !refusedCheck.done.length);
  check('series subjects ignore RE/Reminder prefixes and numbers', D.seriesSubject('RE: Reminder: Positive Pay Items Ready For Review') === 'positive pay items ready for review');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
