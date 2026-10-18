'use strict';
// ============================================================================
// tests/test_staff_reply.js  (Ed 2026-10-18, PR #225) — Answered by Staff
// ----------------------------------------------------------------------------
// Offline: a fake Graph (shared-mailbox Sent Items + the journal mailbox) and a fake
// store. Synthetic data only (the 11 real cases are checked read-only against
// production by scripts/staff_reply_dry_run.js, never written into a fixture).
//   node tests/test_staff_reply.js
// ============================================================================
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createStaffReplyService, supabaseStore, hasOutsideRecipient } = require('../lib/email/staff_reply');

let pass = 0, fail = 0; const pending = [];
const check = (name, fn) => pending.push(async () => { try { await fn(); pass++; console.log('  ✓', name); } catch (e) { fail++; console.log('  ✗', name, '\n     ', e.message); } });

const INFO = 'info@bedrocktx.com', WELCOME = 'welcome@bedrocktx.com', JOURNAL = 'archive1emails@bedrocktx.com';
const T = (h) => new Date(Date.UTC(2026, 9, 10, h)).toISOString();

// ---- fakes ------------------------------------------------------------------
function fakeGraph({ sent = {}, journal = {}, failSent = false, failJournal = false } = {}) {
  const calls = [];
  async function graphGet(p) {
    calls.push(p);
    const dec = decodeURIComponent(p);
    const mb = (dec.match(/^\/users\/([^/]+)\//) || [])[1];
    if (/mailFolders\('sentitems'\)/.test(dec)) {
      if (failSent) { const e = new Error('Graph GET failed (503)'); e.status = 503; throw e; }
      let v = sent[mb] || [];
      const cid = (dec.match(/conversationId eq '([^']+)'/) || [])[1];
      if (cid) v = v.filter((m) => m.conversationId === cid);
      const since = (dec.match(/sentDateTime ge (\S+?)(&|$)/) || [])[1];
      if (since) v = v.filter((m) => m.sentDateTime >= since);
      // paginate in pages of 2 to exercise @odata.nextLink
      const skip = Number((dec.match(/\$skip=(\d+)/) || [])[1] || 0);
      const page = v.slice(skip, skip + 2);
      const next = skip + 2 < v.length ? `https://graph.microsoft.com/v1.0/users/${mb}/mailFolders('sentitems')/messages?x=1${since ? '&$filter=sentDateTime ge ' + since : ''}&$skip=${skip + 2}` : undefined;
      return { value: page, ...(next ? { '@odata.nextLink': next } : {}) };
    }
    if (mb === JOURNAL) {
      if (failJournal) { const e = new Error('Graph GET failed (500)'); e.status = 500; throw e; }
      const id = (dec.match(/internetMessageId eq '([^']+)'/) || [])[1];
      const h = journal[id];
      return { value: h === undefined ? [] : [{ internetMessageHeaders: h }] };
    }
    throw new Error('unexpected Graph path ' + p);
  }
  return { graphGet, calls };
}
function fakeStore(rows = []) {
  const byId = new Map(rows.map((r) => [r.id, JSON.parse(JSON.stringify(r))]));
  const log = { answered: [], review: [] };
  return {
    rows: byId, log,
    async inboundInConversation(mailbox, cid) { return [...byId.values()].filter((r) => r.mailbox === mailbox && r.conversation_id === cid).map((r) => JSON.parse(JSON.stringify(r))); },
    async markAnswered(row, ev) { log.answered.push({ id: row.id, ev }); const r = byId.get(row.id); if (r) { r.extracted = { ...(r.extracted || {}), staff_reply: ev }; if (r.extracted.draft) r.extracted.draft = { ...r.extracted.draft, status: 'superseded_by_staff' }; r.triage_status = 'handled'; } },
    async markReview(row, ev) { log.review.push({ id: row.id, ev }); const r = byId.get(row.id); if (r) r.extracted = { ...(r.extracted || {}), staff_reply: ev }; },
  };
}
const inbound = (o = {}) => ({ id: o.id || 'in-1', mailbox: o.mailbox || INFO, conversation_id: o.cid || 'C1', internet_message_id: o.mid || '<in-1@example.org>',
  sender_email: o.from || 'owner@example.org', body_full: o.body || 'Question about the pool.', received_at: o.at || T(9), triage_status: o.status || 'needs_review',
  extracted: o.extracted || { draft: { subject: 'Re: pool', body: 'AI draft text', status: 'pending' } } });
const reply = (o = {}) => ({ id: o.gid || 'g-' + (o.mid || 'r1'), internetMessageId: o.mid || '<r1@bedrocktx.com>', conversationId: o.cid || 'C1', subject: o.subject || 'Re: pool',
  from: { emailAddress: { address: o.fromMb || INFO } }, toRecipients: (o.to || ['owner@example.org']).map((a) => ({ emailAddress: { address: a } })),
  ccRecipients: (o.cc || []).map((a) => ({ emailAddress: { address: a } })), sentDateTime: o.at || T(11) });
const irt = (...ids) => [{ name: 'In-Reply-To', value: ids[0] }, ...(ids.length > 1 ? [{ name: 'References', value: ids.join(' ') }] : [])];

console.log('Answered by Staff (PR #225)');

// ---- the 11 staff-replied messages with pending AI drafts (synthetic, same shape) ----
check('11 staff-replied messages with pending AI drafts -> all Answered by Staff, every draft superseded, none left open', async () => {
  const subjects = ['Approval Request – Backup Battery Install', 'Hello', 'HOA Documents Request', 'Request for Community-Wide Mosquito Control', 'Request for Pool Access Cards',
    'Foundation Repair', 'Proxy/Absentee vote', 'URGENT: Request to approve permission', 'Message from Canyon Gate', 'HOA policy', 'Random vehicle parked on cul de sac'];
  const rows = [], sent = [], journal = {};
  subjects.forEach((s, i) => {
    const mid = `<in-${i}@example.org>`, rid = `<r-${i}@bedrocktx.com>`, cid = `CONV-${i}`;
    rows.push(inbound({ id: `in-${i}`, cid, mid, from: `owner${i}@example.org`, at: T(1 + i), status: i % 2 ? 'linked' : 'needs_review', extracted: { draft: { subject: 'Re: ' + s, body: `AI draft ${i}`, status: 'pending' } } }));
    sent.push(reply({ mid: rid, cid, subject: 'Re: ' + s, to: [`owner${i}@example.org`], at: T(2 + i) }));
    journal[rid] = irt(mid);
  });
  const store = fakeStore(rows);
  const svc = createStaffReplyService({ graphGet: fakeGraph({ sent: { [INFO]: sent }, journal }).graphGet, store });
  const replies = await svc.listSentReplies(INFO, T(0));
  assert.equal(replies.length, 11, 'pagination must return every reply');
  const st = await svc.reconcileStored(INFO, replies);
  assert.equal(st.answered, 11); assert.equal(st.review, 0); assert.deepEqual(st.errors, []);
  for (const r of store.rows.values()) {
    assert.equal(r.triage_status, 'handled'); assert.equal(r.extracted.staff_reply.status, 'answered');
    assert.equal(r.extracted.staff_reply.method, 'journal_in_reply_to'); assert.equal(r.extracted.draft.status, 'superseded_by_staff');
  }
});

check('an inbound with no staff reply is left exactly as it was', async () => {
  const store = fakeStore([inbound()]);
  const svc = createStaffReplyService({ graphGet: fakeGraph({ sent: { [INFO]: [] } }).graphGet, store });
  assert.equal((await svc.evaluateInbound(inbound(), [])).status, 'none');
  const st = await svc.reconcileStored(INFO, []);
  assert.equal(st.answered + st.review, 0);
  assert.equal(store.rows.get('in-1').extracted.draft.status, 'pending');
});

check('staff reply that already exists when the Pull ingests the inbound -> answered before any draft is made', async () => {
  const svc = createStaffReplyService({ graphGet: fakeGraph({ journal: { '<r1@bedrocktx.com>': irt('<in-1@example.org>') } }).graphGet });
  const v = await svc.evaluateInbound(inbound({ extracted: {} }), [reply()]);
  assert.equal(v.status, 'answered'); assert.equal(v.evidence.mailbox, INFO); assert.equal(v.evidence.sent_at, T(11));
});

check('staff reply sent AFTER the inbound was ingested (next Pull) -> stored row answered, its pending draft superseded', async () => {
  const store = fakeStore([inbound()]);
  const svc = createStaffReplyService({ graphGet: fakeGraph({ sent: { [INFO]: [reply()] }, journal: { '<r1@bedrocktx.com>': irt('<in-1@example.org>') } }).graphGet, store });
  const st = await svc.reconcileStored(INFO, await svc.listSentReplies(INFO, T(0)));
  assert.equal(st.answered, 1);
  const r = store.rows.get('in-1');
  assert.equal(r.extracted.draft.status, 'superseded_by_staff'); assert.equal(r.extracted.draft.body, 'AI draft text');
});

check('multiple messages in one conversation: a reply answers only the message it names; a newer unanswered message is never marked answered', async () => {
  const a = inbound({ id: 'A', mid: '<a@x.org>', at: T(8) }), b = inbound({ id: 'B', mid: '<b@x.org>', at: T(12) });
  const rA = reply({ mid: '<rA@b.com>', at: T(10) });             // replies to A (before B arrived)
  const rLate = reply({ mid: '<rLate@b.com>', at: T(13) });       // sent after B, but In-Reply-To A
  const journal = { '<rA@b.com>': irt('<a@x.org>'), '<rLate@b.com>': irt('<a@x.org>') };
  const svc = createStaffReplyService({ graphGet: fakeGraph({ journal }).graphGet });
  assert.equal((await svc.evaluateInbound(a, [rA, rLate])).status, 'answered');
  const vb = await svc.evaluateInbound(b, [rA, rLate]);
  assert.equal(vb.status, 'review', 'B has a later reply in the thread that does not name it: Needs Review, not answered');
  // a reply that names B (References carries the chain) answers B
  const rB = reply({ mid: '<rB@b.com>', at: T(14) });
  const svc2 = createStaffReplyService({ graphGet: fakeGraph({ journal: { ...journal, '<rB@b.com>': irt('<b@x.org>', '<a@x.org>', '<b@x.org>') } }).graphGet });
  assert.equal((await svc2.evaluateInbound(b, [rA, rLate, rB])).status, 'answered');
});

check('matching header (In-Reply-To or References) -> answered; mismatched header -> Needs Review', async () => {
  const ok1 = createStaffReplyService({ graphGet: fakeGraph({ journal: { '<r1@bedrocktx.com>': irt('<in-1@example.org>') } }).graphGet });
  assert.equal((await ok1.evaluateInbound(inbound(), [reply()])).status, 'answered');
  const ok2 = createStaffReplyService({ graphGet: fakeGraph({ journal: { '<r1@bedrocktx.com>': [{ name: 'References', value: '<old@x.org> <in-1@example.org>' }] } }).graphGet });
  assert.equal((await ok2.evaluateInbound(inbound(), [reply()])).status, 'answered');
  const bad = createStaffReplyService({ graphGet: fakeGraph({ journal: { '<r1@bedrocktx.com>': irt('<someone-else@example.org>') } }).graphGet });
  const v = await bad.evaluateInbound(inbound(), [reply()]);
  assert.equal(v.status, 'review'); assert.ok(v.evidence.reasons.includes('no_verified_reply_reference'));
});

check('missing journal evidence -> Needs Review (never answered on conversation or subject alone)', async () => {
  const svc = createStaffReplyService({ graphGet: fakeGraph({ journal: {} }).graphGet });
  const v = await svc.evaluateInbound(inbound(), [reply({ subject: 'Re: pool' })]);
  assert.equal(v.status, 'review'); assert.ok(v.evidence.reasons.includes('journal_headers_unavailable'));
});

check('internal forwards (no outside recipient) never count and never flag the inbound', async () => {
  const fwd = reply({ mid: '<fw@b.com>', subject: 'Fw: pool', to: ['emma@bedrocktx.com'] });
  assert.equal(hasOutsideRecipient(fwd), false);
  const svc = createStaffReplyService({ graphGet: fakeGraph({ journal: { '<fw@b.com>': irt('<in-1@example.org>') } }).graphGet });
  assert.equal((await svc.evaluateInbound(inbound(), [fwd])).status, 'none');
});

check('reply to a different outside person in the thread -> Needs Review (recipient not proven), not answered', async () => {
  const svc = createStaffReplyService({ graphGet: fakeGraph({ journal: { '<r1@bedrocktx.com>': irt('<in-1@example.org>') } }).graphGet });
  const v = await svc.evaluateInbound(inbound(), [reply({ to: ['vendor@landscaping.example'] })]);
  assert.equal(v.status, 'review'); assert.ok(v.evidence.reasons.includes('recipient_not_proven'));
});

check('website form relay: a reply to the form submitter (named in the body) is answered', async () => {
  const form = inbound({ from: 'website@bedrocktxai.com', body: 'New Bedrock website inquiry\nName: Pat Example\nEmail: pat@example.com\nPhone: 555-0100\nMessage: pool hours', extracted: {} });
  const svc = createStaffReplyService({ graphGet: fakeGraph({ journal: { '<r1@bedrocktx.com>': irt('<in-1@example.org>') } }).graphGet });
  assert.equal((await svc.evaluateInbound(form, [reply({ to: ['pat@example.com'] })])).status, 'answered');
});

check('Read, Archive and Filed are never evidence: a read, archived inbound with no reply stays unanswered', async () => {
  const svc = createStaffReplyService({ graphGet: fakeGraph().graphGet });
  const v = await svc.evaluateInbound({ ...inbound(), isRead: true, parentFolderId: 'ARCHIVE', triage_status: 'linked' }, []);
  assert.equal(v.status, 'none');
});

check('a reply sent BEFORE the inbound arrived never answers it', async () => {
  const svc = createStaffReplyService({ graphGet: fakeGraph({ journal: { '<r1@bedrocktx.com>': irt('<in-1@example.org>') } }).graphGet });
  assert.equal((await svc.evaluateInbound(inbound({ at: T(12) }), [reply({ at: T(11) })])).status, 'none');
});

check('duplicate ingestion / repeated Pulls: an answered row is marked once and left alone afterwards', async () => {
  const store = fakeStore([inbound()]);
  const g = fakeGraph({ sent: { [INFO]: [reply()] }, journal: { '<r1@bedrocktx.com>': irt('<in-1@example.org>') } });
  const svc = createStaffReplyService({ graphGet: g.graphGet, store });
  const replies = await svc.listSentReplies(INFO, T(0));
  await svc.reconcileStored(INFO, replies);
  const second = await svc.reconcileStored(INFO, replies);
  assert.equal(store.log.answered.length, 1); assert.equal(second.answered, 0); assert.equal(second.unchanged, 1);
});

check('rows already decided in this Pull are not re-decided by the reconcile pass', async () => {
  const store = fakeStore([inbound()]);
  const svc = createStaffReplyService({ graphGet: fakeGraph({ journal: { '<r1@bedrocktx.com>': irt('<in-1@example.org>') } }).graphGet, store });
  const st = await svc.reconcileStored(INFO, [reply()], { skipIds: new Set(['in-1']) });
  assert.equal(st.answered, 0); assert.equal(store.log.answered.length, 0);
});

check('staff reply arriving between AI draft creation and approval -> send blocked (409) and the row marked answered', async () => {
  const store = fakeStore([inbound()]);
  const svc = createStaffReplyService({ graphGet: fakeGraph({ sent: { [INFO]: [reply()] }, journal: { '<r1@bedrocktx.com>': irt('<in-1@example.org>') } }).graphGet, store });
  const g = await svc.guardBeforeSend(inbound());
  assert.equal(g.allow, false); assert.equal(g.status, 409); assert.equal(g.error, 'answered_by_staff'); assert.match(g.message, /Nothing was sent/);
  assert.equal(store.log.answered.length, 1);
});

check('send guard: a stored verified staff reply blocks without any Graph call', async () => {
  const g0 = fakeGraph();
  const svc = createStaffReplyService({ graphGet: g0.graphGet });
  const g = await svc.guardBeforeSend(inbound({ extracted: { staff_reply: { status: 'answered', mailbox: INFO, sent_at: T(11) } } }));
  assert.equal(g.allow, false); assert.equal(g.error, 'answered_by_staff'); assert.equal(g0.calls.length, 0);
});

check('send guard: ambiguous match needs explicit confirmation; confirmed sends; no reply allows', async () => {
  const svc = createStaffReplyService({ graphGet: fakeGraph({ sent: { [INFO]: [reply()] }, journal: {} }).graphGet });
  const g = await svc.guardBeforeSend(inbound());
  assert.equal(g.allow, false); assert.equal(g.status, 409); assert.equal(g.needs_confirmation, true);
  assert.equal((await svc.guardBeforeSend(inbound(), { confirmed: true })).allow, true);
  const none = createStaffReplyService({ graphGet: fakeGraph({ sent: { [INFO]: [] } }).graphGet });
  assert.equal((await none.guardBeforeSend(inbound())).allow, true);
});

check('send guard fails CLOSED: Graph Sent Items failure -> 503; journal failure -> 503 (even with confirm)', async () => {
  const s1 = createStaffReplyService({ graphGet: fakeGraph({ failSent: true }).graphGet });
  const g1 = await s1.guardBeforeSend(inbound(), { confirmed: true });
  assert.equal(g1.allow, false); assert.equal(g1.status, 503);
  const s2 = createStaffReplyService({ graphGet: fakeGraph({ sent: { [INFO]: [reply()] }, failJournal: true }).graphGet });
  const g2 = await s2.guardBeforeSend(inbound(), { confirmed: true });
  assert.equal(g2.allow, false); assert.equal(g2.status, 503);
});

check('Pull reconcile reports database failures instead of hiding them', async () => {
  const svc = createStaffReplyService({ graphGet: fakeGraph({ journal: { '<r1@bedrocktx.com>': irt('<in-1@example.org>') } }).graphGet,
    store: { async inboundInConversation() { throw new Error('db down'); }, async markAnswered() {}, async markReview() {} } });
  const st = await svc.reconcileStored(INFO, [reply()]);
  assert.equal(st.errors.length, 1); assert.match(st.errors[0].error, /db down/);
  const svc2 = createStaffReplyService({ graphGet: fakeGraph({ journal: { '<r1@bedrocktx.com>': irt('<in-1@example.org>') } }).graphGet,
    store: { async inboundInConversation() { return [inbound()]; }, async markAnswered() { throw new Error('write failed'); }, async markReview() {} } });
  const st2 = await svc2.reconcileStored(INFO, [reply()]);
  assert.equal(st2.answered, 0); assert.equal(st2.errors.length, 1);
});

check('Sent Items read failure surfaces as an error from listSentReplies (ingest marks affected mail Needs Review)', async () => {
  const svc = createStaffReplyService({ graphGet: fakeGraph({ failSent: true }).graphGet });
  await assert.rejects(() => svc.listSentReplies(INFO, T(0)), /503/);
});

check('welcome@ behaves exactly like info@; a non-staff mailbox (claire@) is not checked', async () => {
  const w = inbound({ mailbox: WELCOME });
  const svc = createStaffReplyService({ graphGet: fakeGraph({ sent: { [WELCOME]: [reply({ fromMb: WELCOME })] }, journal: { '<r1@bedrocktx.com>': irt('<in-1@example.org>') } }).graphGet });
  assert.equal((await svc.evaluateInbound(w, [reply({ fromMb: WELCOME })])).status, 'answered');
  assert.equal((await svc.guardBeforeSend(w)).error, 'answered_by_staff');
  const c = await createStaffReplyService({ graphGet: fakeGraph().graphGet }).guardBeforeSend(inbound({ mailbox: 'claire@bedrocktx.com' }));
  assert.equal(c.allow, true); assert.equal(c.reason, 'not_a_staff_reply_mailbox');
});

check('a reply from a different shared mailbox does not answer mail that landed in this one', async () => {
  const svc = createStaffReplyService({ graphGet: fakeGraph({ journal: { '<r1@bedrocktx.com>': irt('<in-1@example.org>') } }).graphGet });
  assert.notEqual((await svc.evaluateInbound(inbound({ mailbox: WELCOME }), [reply({ fromMb: INFO })])).status, 'answered');
});

// ---- the Supabase store: what "Answered by Staff" writes ----
function fakeSupabase() {
  const updates = [];
  const q = (table) => { const st = { table, patch: null, eqs: [] }; const api = {
    update(p) { st.patch = p; return api; }, eq(k, v) { st.eqs.push([k, v]); return api; },
    then(res) { updates.push(st); return Promise.resolve({ error: null }).then(res); } }; return api; };
  return { from: q, updates };
}
check('store: answered keeps the AI draft text, appends history, sets handled; outbound drafts flagged; sent drafts and dismissed/spam rows untouched', async () => {
  const sb = fakeSupabase(); const store = supabaseStore(sb, { now: () => new Date(T(20)) });
  const ev = { status: 'answered', mailbox: INFO, sent_at: T(11), reply_internet_message_id: '<r1@bedrocktx.com>' };
  await store.markAnswered(inbound(), ev);
  const em = sb.updates.find((u) => u.table === 'email_messages').patch;
  assert.equal(em.triage_status, 'handled'); assert.equal(em.reviewed_by, 'Answered by Staff');
  assert.equal(em.extracted.draft.status, 'superseded_by_staff'); assert.equal(em.extracted.draft.body, 'AI draft text');
  assert.equal(em.extracted.draft.history[0].event, 'superseded_by_staff');
  assert.ok(sb.updates.find((u) => u.table === 'outbound_email_drafts' && /Superseded by staff reply/.test(u.patch.send_error)));
  const sb2 = fakeSupabase(); await supabaseStore(sb2).markAnswered(inbound({ status: 'dismissed', extracted: { draft: { body: 'x', status: 'sent' } } }), ev);
  const em2 = sb2.updates.find((u) => u.table === 'email_messages').patch;
  assert.equal(em2.triage_status, undefined, 'a dismissed row is not reopened as handled'); assert.equal(em2.extracted.draft.status, 'sent');
});

// ---- wiring (static): ingest and both send paths use the engine in the right order ----
const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
check('ingest: staff sends are never processed as inbound; answered mail gets no AI draft; earlier mail reconciled', () => {
  const src = read('lib/email/graph_ingest.js');
  assert.ok(/sender_email\.toLowerCase\(\) === mailbox\.toLowerCase\(\)\) return \{ r: 'skipped' \}/.test(src), 'own sent items must still be skipped as inbound');
  assert.ok(/if \(!draft && !ppNotice && !staffAnswered\)/.test(src), 'front-office draft must be gated');
  assert.ok(/staffAnswered\) \{\s*\/\/ Staff already answered: no AI draft/.test(src), 'Miranda draft must be gated (DRV logging kept)');
  assert.ok(/vr\.draft && !draft && !staffAnswered/.test(src), 'vigilance draft must be gated');
  assert.ok(/isCompletionAck\(email\) && !\(draft && draft\.persona === 'amanda'\) && !staffAnswered/.test(src), 'thank-you draft must be gated');
  assert.ok(/reconcileStored\(mailbox, staffReplies/.test(src), 'earlier mail must be reconciled');
});
check('both send paths run the staff-reply guard BEFORE the Graph send', () => {
  const t = read('api/email_triage.js'); const i = t.indexOf("router.post('/:id/send'");
  const body = t.slice(i, t.indexOf('router.', i + 30));
  assert.ok(body.indexOf('guardBeforeSend') > 0 && body.indexOf('guardBeforeSend') < body.indexOf('sendReplyAs('), 'Communications send');
  const d = read('api/email_drafts.js'); const j = d.indexOf("router.post('/:id/send'");
  const dbody = d.slice(j, d.indexOf("router.post('/:id/redraft'"));
  assert.ok(dbody.indexOf('guardBeforeSend') > 0 && dbody.indexOf('guardBeforeSend') < dbody.indexOf('sendReplyAs('), 'outbound drafts send');
  assert.ok(/staff_reply_check_failed/.test(dbody), 'a failed source lookup blocks the draft send');
});

(async () => { for (const t of pending) await t(); console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0); })();
