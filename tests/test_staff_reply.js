'use strict';
// ============================================================================
// tests/test_staff_reply.js  (Ed 2026-10-18, PR #225) — Answered by Staff
// ----------------------------------------------------------------------------
// Offline: a fake Graph (shared-mailbox folders + the journal mailbox) and an
// in-memory database. Synthetic data only (the 11 real cases are checked read-only
// against production by scripts/staff_reply_dry_run.js, never written into a fixture).
//   node tests/test_staff_reply.js
// ============================================================================
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const SR = require('../lib/email/staff_reply');
const { createStaffReplyService, supabaseStore, hasOutsideRecipient } = SR;

let pass = 0, fail = 0; const pending = [];
const check = (name, fn) => pending.push(async () => { try { await fn(); pass++; console.log('  ✓', name); } catch (e) { fail++; console.log('  ✗', name, '\n     ', e.message); } });

const INFO = 'info@bedrocktx.com', WELCOME = 'welcome@bedrocktx.com', JOURNAL = 'archive1emails@bedrocktx.com';
const T = (h) => new Date(Date.UTC(2026, 9, 10, h)).toISOString();
const OWNER = { email: 'egojara@bedrocktx.com', is_owner: true };
const STAFF = { email: 'staffer@bedrocktx.com', is_owner: false };

// ---- fake Graph: Sent Items is a folder; /messages spans every folder ----
function fakeGraph({ msgs = {}, journal = {}, failSent = false, failJournal = false, pageSize = 2, badShape = false } = {}) {
  const calls = [];
  async function graphGet(p) {
    calls.push(p);
    const dec = decodeURIComponent(p);
    const mb = (dec.match(/^\/users\/([^/]+)\//) || [])[1];
    if (mb === JOURNAL) {
      if (failJournal) { const e = new Error('Graph GET failed (500)'); e.status = 500; throw e; }
      const id = (dec.match(/internetMessageId eq '([^']+)'/) || [])[1];
      const h = journal[id];
      return { value: h === undefined ? [] : [{ internetMessageHeaders: h }] };
    }
    if (failSent) { const e = new Error('Graph GET failed (503)'); e.status = 503; throw e; }
    if (badShape) return { error: 'weird' };
    let v = msgs[mb] || [];
    if (/mailFolders\('sentitems'\)/.test(dec)) v = v.filter((m) => (m.folder || 'sent') === 'sent');
    const cid = (dec.match(/conversationId eq '([^']+)'/) || [])[1];
    if (cid) v = v.filter((m) => m.conversationId === cid);
    const since = (dec.match(/sentDateTime ge (\S+?)(&|$)/) || [])[1];
    if (since) v = v.filter((m) => m.sentDateTime >= since);
    const skip = Number((dec.match(/\$skip=(\d+)/) || [])[1] || 0);
    const page = v.slice(skip, skip + pageSize);
    const next = skip + pageSize < v.length ? `https://graph.microsoft.com/v1.0${p.split('&$skip=')[0]}&$skip=${skip + pageSize}` : undefined;
    return { value: page, ...(next ? { '@odata.nextLink': next } : {}) };
  }
  return { graphGet, calls };
}

// ---- in-memory "Supabase" (enough PostgREST surface for the store and fetchAllQuery) ----
function memoryDb(tables) {
  const db = Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, v.map((r) => JSON.parse(JSON.stringify(r)))]));
  let clock = 1000;
  const writes = [];
  function from(table) {
    const st = { filters: [], patch: null, order: null, range: null, single: false, wantRows: false };
    const rows = () => (db[table] || []).filter((r) => st.filters.every((f) => f(r)));
    const api = {
      select() { st.wantRows = true; return api; },
      eq(k, v) { st.filters.push((r) => r[k] === v); return api; },
      is(k, v) { st.filters.push((r) => (r[k] === undefined ? null : r[k]) === v); return api; },
      in(k, vs) { st.filters.push((r) => vs.includes(r[k])); return api; },
      order(k, o = {}) { st.order = [k, o.ascending !== false]; return api; },
      range(a, b) { st.range = [a, b]; return api; },
      limit() { return api; },
      update(p) { st.patch = p; return api; },
      maybeSingle() { st.single = true; return api; },
      then(resolve, reject) {
        try {
          if (st.patch) {
            const hit = rows();
            for (const r of hit) { Object.assign(r, JSON.parse(JSON.stringify(st.patch))); r.updated_at = `t${++clock}`; writes.push({ table, id: r.id, patch: st.patch }); }
            return Promise.resolve({ data: st.wantRows ? hit.map((r) => ({ id: r.id })) : null, error: null }).then(resolve, reject);
          }
          let out = rows().map((r) => JSON.parse(JSON.stringify(r)));
          if (st.order) out.sort((a, b) => (a[st.order[0]] > b[st.order[0]] ? 1 : -1) * (st.order[1] ? 1 : -1));
          if (st.range) out = out.slice(st.range[0], st.range[1] + 1);
          return Promise.resolve({ data: st.single ? (out[0] || null) : out, error: null }).then(resolve, reject);
        } catch (e) { return Promise.reject(e).then(resolve, reject); }
      },
    };
    return api;
  }
  return { from, db, writes, touch(table, id, patch) { const r = db[table].find((x) => x.id === id); Object.assign(r, patch); r.updated_at = `t${++clock}`; } };
}
// A database where someone else changes the row just before every email_messages update.
function racingDb(db, change) {
  return { ...db, from: (t) => { const q = db.from(t); const orig = q.update; q.update = (p) => { if (t === 'email_messages') db.touch('email_messages', 'in-1', change); return orig.call(q, p); }; return q; } };
}

const inbound = (o = {}) => ({ id: o.id || 'in-1', mailbox: o.mailbox || INFO, direction: 'inbound', conversation_id: o.cid === undefined ? 'C1' : o.cid,
  internet_message_id: o.mid === undefined ? '<in-1@example.org>' : o.mid, sender_email: o.from || 'owner@example.org', body_full: o.body || 'Question about the pool.',
  received_at: o.at === undefined ? T(9) : o.at, triage_status: o.status || 'needs_review', reviewed_by: o.reviewed_by || null, reviewed_at: o.reviewed_at || null,
  updated_at: o.updated_at || 't1', extracted: o.extracted || { draft: { subject: 'Re: pool', body: 'AI draft text', status: 'pending' } } });
const reply = (o = {}) => ({ id: o.gid || 'g-' + (o.mid || 'r1'), internetMessageId: o.mid || '<r1@bedrocktx.com>', conversationId: o.cid || 'C1', subject: o.subject || 'Re: pool',
  from: { emailAddress: { address: o.fromMb || INFO } }, toRecipients: (o.to || ['owner@example.org']).map((a) => ({ emailAddress: { address: a } })),
  ccRecipients: (o.cc || []).map((a) => ({ emailAddress: { address: a } })), sentDateTime: o.at || T(11), isDraft: !!o.isDraft, folder: o.folder || 'sent' });
const irt = (...ids) => [{ name: 'In-Reply-To', value: ids[0] }, ...(ids.length > 1 ? [{ name: 'References', value: ids.join(' ') }] : [])];
const J1 = { '<r1@bedrocktx.com>': irt('<in-1@example.org>') };
const svcWith = (g, db, opts = {}) => createStaffReplyService({ graphGet: g.graphGet, store: db ? supabaseStore(db, opts.store || {}) : null, maxPages: opts.maxPages || 50 });

console.log('Answered by Staff (PR #225)');

// =============================== evidence rules ===============================
check('11 staff-replied messages with pending AI drafts -> all Answered by Staff, drafts superseded (text kept), precise change list', async () => {
  const subjects = ['Approval Request – Backup Battery Install', 'Hello', 'HOA Documents Request', 'Mosquito Control', 'Pool Access Cards', 'Foundation Repair', 'Proxy/Absentee vote', 'Approve tree removal', 'Canyon Gate message', 'HOA policy', 'Vehicle on cul de sac'];
  const rows = [], sent = [], journal = {};
  subjects.forEach((s, i) => {
    const mid = `<in-${i}@example.org>`, rid = `<r-${i}@bedrocktx.com>`, cid = `CONV-${i}`;
    rows.push(inbound({ id: `in-${i}`, cid, mid, from: `owner${i}@example.org`, at: T(1 + i), status: i % 2 ? 'linked' : 'needs_review', extracted: { draft: { subject: 'Re: ' + s, body: `AI draft ${i}`, status: 'pending' } } }));
    sent.push(reply({ mid: rid, cid, subject: 'Re: ' + s, to: [`owner${i}@example.org`], at: T(2 + i) }));
    journal[rid] = irt(mid);
  });
  const db = memoryDb({ email_messages: rows, outbound_email_drafts: [] });
  const svc = svcWith(fakeGraph({ msgs: { [INFO]: sent }, journal }), db);
  const replies = await svc.listSentReplies(INFO, T(0));
  assert.equal(replies.length, 11, 'every Sent Items page is read');
  const st = await svc.reconcileStored(INFO, replies);
  assert.equal(st.answered, 11); assert.equal(st.review, 0); assert.deepEqual(st.errors, []); assert.equal(st.changes.length, 11);
  for (const c of st.changes) { assert.equal(c.action, 'answered'); assert.equal(c.to_status, 'handled'); assert.equal(c.draft, 'superseded'); assert.ok(['needs_review', 'linked'].includes(c.from_status)); }
  for (const r of db.db.email_messages) {
    assert.equal(r.triage_status, 'handled'); assert.equal(r.reviewed_by, 'Answered by Staff');
    assert.equal(r.extracted.draft.status, 'superseded_by_staff'); assert.match(r.extracted.draft.body, /^AI draft \d+$/);
    assert.equal(r.extracted.draft.history.at(-1).event, 'superseded_by_staff'); assert.ok(r.extracted.staff_reply.prior.triage_status);
  }
});

check('an inbound with no staff reply is left exactly as it was', async () => {
  const db = memoryDb({ email_messages: [inbound()], outbound_email_drafts: [] });
  const svc = svcWith(fakeGraph(), db);
  assert.equal((await svc.evaluateInbound(inbound(), [])).status, 'none');
  const st = await svc.reconcileStored(INFO, []);
  assert.equal(st.changes.length, 0); assert.equal(db.writes.length, 0);
});

check('staff reply that already exists when the Pull ingests the inbound -> answered before any draft is made', async () => {
  const v = await svcWith(fakeGraph({ journal: J1 })).evaluateInbound(inbound({ extracted: {} }), [reply()]);
  assert.equal(v.status, 'answered'); assert.equal(v.evidence.mailbox, INFO); assert.equal(v.evidence.sent_at, T(11));
});

check('staff reply sent AFTER an earlier Pull -> stored row answered, its pending draft superseded', async () => {
  const db = memoryDb({ email_messages: [inbound()], outbound_email_drafts: [] });
  const svc = svcWith(fakeGraph({ msgs: { [INFO]: [reply()] }, journal: J1 }), db);
  const st = await svc.reconcileStored(INFO, await svc.listSentReplies(INFO, T(0)));
  assert.equal(st.answered, 1);
  const r = db.db.email_messages[0];
  assert.equal(r.extracted.draft.status, 'superseded_by_staff'); assert.equal(r.extracted.draft.body, 'AI draft text');
});

check('multiple messages in one conversation: a reply answers only the message it names', async () => {
  const a = inbound({ id: 'A', mid: '<a@x.org>', at: T(8) }), b = inbound({ id: 'B', mid: '<b@x.org>', at: T(12) });
  const rA = reply({ mid: '<rA@b.com>', at: T(10) }), rLate = reply({ mid: '<rLate@b.com>', at: T(13) });
  const journal = { '<rA@b.com>': irt('<a@x.org>'), '<rLate@b.com>': irt('<a@x.org>') };
  const svc = svcWith(fakeGraph({ journal }));
  assert.equal((await svc.evaluateInbound(a, [rA, rLate])).status, 'answered');
  assert.equal((await svc.evaluateInbound(b, [rA, rLate])).status, 'review', 'a later reply naming another message: Needs Review, not answered');
  const svc2 = svcWith(fakeGraph({ journal: { ...journal, '<rB@b.com>': irt('<b@x.org>', '<a@x.org>', '<b@x.org>') } }));
  assert.equal((await svc2.evaluateInbound(b, [rA, rLate, reply({ mid: '<rB@b.com>', at: T(14) })])).status, 'answered');
});

check('matching header (In-Reply-To or References) -> answered; mismatched header -> Needs Review', async () => {
  assert.equal((await svcWith(fakeGraph({ journal: J1 })).evaluateInbound(inbound(), [reply()])).status, 'answered');
  assert.equal((await svcWith(fakeGraph({ journal: { '<r1@bedrocktx.com>': [{ name: 'References', value: '<old@x.org> <in-1@example.org>' }] } })).evaluateInbound(inbound(), [reply()])).status, 'answered');
  const v = await svcWith(fakeGraph({ journal: { '<r1@bedrocktx.com>': irt('<someone-else@example.org>') } })).evaluateInbound(inbound(), [reply()]);
  assert.equal(v.status, 'review'); assert.ok(v.evidence.reasons.includes('no_verified_reply_reference'));
});

check('missing journal evidence -> Needs Review (never answered on conversation or subject alone)', async () => {
  const v = await svcWith(fakeGraph({ journal: {} })).evaluateInbound(inbound(), [reply({ subject: 'Re: pool' })]);
  assert.equal(v.status, 'review'); assert.ok(v.evidence.reasons.includes('journal_headers_unavailable'));
});

check('internal forwards (no outside recipient) never count and never flag the inbound', async () => {
  const fwd = reply({ mid: '<fw@b.com>', subject: 'Fw: pool', to: ['emma@bedrocktx.com'] });
  assert.equal(hasOutsideRecipient(fwd), false);
  assert.equal((await svcWith(fakeGraph({ journal: { '<fw@b.com>': irt('<in-1@example.org>') } })).evaluateInbound(inbound(), [fwd])).status, 'none');
});

check('reply to a different outside person in the thread -> Needs Review (recipient not proven)', async () => {
  const v = await svcWith(fakeGraph({ journal: J1 })).evaluateInbound(inbound(), [reply({ to: ['vendor@landscaping.example'] })]);
  assert.equal(v.status, 'review'); assert.ok(v.evidence.reasons.includes('recipient_not_proven'));
});

check('website form relay: a reply to the form submitter (named in the body) is answered', async () => {
  const form = inbound({ from: 'website@bedrocktxai.com', body: 'New Bedrock website inquiry\nName: Pat Example\nEmail: pat@example.com\nPhone: 555-0100\nMessage: pool hours', extracted: {} });
  assert.equal((await svcWith(fakeGraph({ journal: J1 })).evaluateInbound(form, [reply({ to: ['pat@example.com'] })])).status, 'answered');
});

check('website form relayed from notifications@bedrocktxai.com: a reply to the SUBMITTER answers it; a reply to the RELAY address never does', async () => {
  const formBody = ['New Bedrock website inquiry', 'Purpose: prospective', 'Name: Pat Example', 'Email: pat@example.com', 'Phone: 555-0100', 'Community: —', 'Message: learn more'].join(String.fromCharCode(10));
  const form = inbound({ from: 'notifications@bedrocktxai.com', body: formBody, extracted: {} });
  const svc = svcWith(fakeGraph({ journal: J1 }));
  assert.equal((await svc.evaluateInbound(form, [reply({ to: ['pat@example.com'] })])).status, 'answered');
  const relay = await svc.evaluateInbound(form, [reply({ to: ['notifications@bedrocktxai.com'] })]);
  assert.equal(relay.status, 'review'); assert.ok(relay.evidence.reasons.includes('recipient_not_proven'));
});

check('Read, Archive and Filed are never evidence; a reply sent before the inbound never answers it', async () => {
  const svc = svcWith(fakeGraph({ journal: J1 }));
  assert.equal((await svc.evaluateInbound({ ...inbound(), isRead: true, parentFolderId: 'ARCHIVE', triage_status: 'linked' }, [])).status, 'none');
  assert.equal((await svc.evaluateInbound(inbound({ at: T(12) }), [reply({ at: T(11) })])).status, 'none');
});

check('unsent drafts in the shared mailbox are never treated as replies', async () => {
  const svc = svcWith(fakeGraph({ msgs: { [INFO]: [reply({ isDraft: true, folder: 'drafts' })] }, journal: J1 }));
  assert.equal((await svc.repliesInConversation(INFO, 'C1')).length, 0);
  assert.equal((await svc.guardBeforeSend(inbound())).allow, true);
});

check('a reply from a different shared mailbox does not answer mail that landed in this one', async () => {
  assert.notEqual((await svcWith(fakeGraph({ journal: J1 })).evaluateInbound(inbound({ mailbox: WELCOME }), [reply({ fromMb: INFO })])).status, 'answered');
});

// =============================== pagination ===============================
check('PAGINATION: the send-time check reads every page; a verified reply on the LAST page still blocks', async () => {
  const filler = Array.from({ length: 9 }, (_, i) => reply({ mid: `<f${i}@b.com>`, to: ['emma@bedrocktx.com'], at: T(10) }));
  const g = fakeGraph({ msgs: { [INFO]: [...filler, reply({ at: T(11) })] }, journal: J1, pageSize: 2 });
  const res = await svcWith(g).guardBeforeSend(inbound());
  assert.equal(res.allow, false); assert.equal(res.error, 'answered_by_staff');
  assert.ok(g.calls.filter((c) => /conversationId/.test(decodeURIComponent(c))).length >= 5, 'followed @odata.nextLink to the end');
});

check('PAGINATION: incomplete results (page cap reached with more pages left) FAIL CLOSED at send time, even when confirmed', async () => {
  const many = Array.from({ length: 7 }, (_, i) => reply({ mid: `<f${i}@b.com>`, to: ['emma@bedrocktx.com'] }));
  const res = await svcWith(fakeGraph({ msgs: { [INFO]: many }, pageSize: 2 }), null, { maxPages: 2 }).guardBeforeSend(inbound(), { confirmed: true });
  assert.equal(res.allow, false); assert.equal(res.status, 503); assert.equal(res.error, 'staff_reply_check_failed'); assert.match(res.message, /whole conversation/);
});

check('PAGINATION: the Pull Sent Items read refuses a truncated list (incomplete_results), never a silent partial', async () => {
  const many = Array.from({ length: 9 }, (_, i) => reply({ mid: `<s${i}@b.com>`, cid: `C${i}`, at: T(10) }));
  await assert.rejects(() => svcWith(fakeGraph({ msgs: { [INFO]: many }, pageSize: 2 }), null, { maxPages: 3 }).listSentReplies(INFO, T(0)), (e) => e.code === 'incomplete_results');
  assert.equal((await svcWith(fakeGraph({ msgs: { [INFO]: many }, pageSize: 2 })).listSentReplies(INFO, T(0))).length, 9);
});

check('PAGINATION: an unexpected Graph response shape fails closed (503), never "no reply"', async () => {
  const res = await svcWith(fakeGraph({ badShape: true })).guardBeforeSend(inbound(), { confirmed: true });
  assert.equal(res.allow, false); assert.equal(res.status, 503);
});

check('send-time check finds a staff reply someone moved OUT of Sent Items (all folders are searched)', async () => {
  const res = await svcWith(fakeGraph({ msgs: { [INFO]: [reply({ folder: 'archive' })] }, journal: J1 })).guardBeforeSend(inbound());
  assert.equal(res.allow, false); assert.equal(res.error, 'answered_by_staff');
});

check('PAGINATION: the stored-row lookup reads past 1,000 rows (fetchAll), not a fixed limit', async () => {
  const rows = Array.from({ length: 1205 }, (_, i) => inbound({ id: `x-${String(i).padStart(5, '0')}`, mid: `<x${i}@e.org>`, at: T(1) }));
  const got = await supabaseStore(memoryDb({ email_messages: rows, outbound_email_drafts: [] })).inboundInConversation(INFO, 'C1');
  assert.equal(got.length, 1205);
});

// =============================== send-time guard ===============================
check('staff reply arriving between AI draft creation and approval -> 409, nothing sent, row marked answered', async () => {
  const db = memoryDb({ email_messages: [inbound()], outbound_email_drafts: [] });
  const res = await svcWith(fakeGraph({ msgs: { [INFO]: [reply()] }, journal: J1 }), db).guardBeforeSend(inbound());
  assert.equal(res.allow, false); assert.equal(res.status, 409); assert.equal(res.error, 'answered_by_staff'); assert.equal(res.overridable, false); assert.match(res.message, /Nothing was sent/);
  assert.equal(db.db.email_messages[0].triage_status, 'handled');
});

check('a VERIFIED staff reply can never be overridden (owner + reason still blocked)', async () => {
  const res = await svcWith(fakeGraph({ msgs: { [INFO]: [reply()] }, journal: J1 })).guardBeforeSend(inbound(), { confirmed: true, override: { reason: 'I want to send anyway, really.' }, actor: OWNER });
  assert.equal(res.allow, false); assert.equal(res.error, 'answered_by_staff');
  const stored = await svcWith(fakeGraph()).guardBeforeSend(inbound({ extracted: { staff_reply: { status: 'answered', mailbox: INFO, sent_at: T(11) } } }), { override: { reason: 'I want to send anyway, really.' }, actor: OWNER });
  assert.equal(stored.allow, false);
});

check('ambiguous match: blocked until explicitly confirmed; the confirmation is returned as an audit entry', async () => {
  const svc = svcWith(fakeGraph({ msgs: { [INFO]: [reply()] }, journal: {} }));
  const g = await svc.guardBeforeSend(inbound());
  assert.equal(g.allow, false); assert.equal(g.status, 409); assert.equal(g.needs_confirmation, true);
  const ok = await svc.guardBeforeSend(inbound(), { confirmed: true, actor: STAFF });
  assert.equal(ok.allow, true); assert.equal(ok.audit.kind, 'confirmed_after_review'); assert.equal(ok.audit.by, STAFF.email); assert.ok(ok.audit.candidate_replies.length);
  assert.equal((await svcWith(fakeGraph({ msgs: { [INFO]: [] } })).guardBeforeSend(inbound())).allow, true);
});

check('lookup failures FAIL CLOSED and cannot be overridden (Sent Items 503; journal 500)', async () => {
  for (const g of [fakeGraph({ failSent: true }), fakeGraph({ msgs: { [INFO]: [reply()] }, failJournal: true })]) {
    const res = await svcWith(g).guardBeforeSend(inbound(), { confirmed: true, override: { reason: 'Owner says send regardless.' }, actor: OWNER });
    assert.equal(res.allow, false); assert.equal(res.status, 503); assert.equal(res.overridable, false);
  }
});

// =============================== missing identifiers ===============================
check('MISSING IDENTIFIERS: blocked (409 unverifiable); an ordinary "confirm" does NOT bypass it', async () => {
  const svc = svcWith(fakeGraph());
  for (const bad of [{ cid: null }, { mid: null }, { at: null }]) {
    const r1 = await svc.guardBeforeSend(inbound(bad));
    assert.equal(r1.allow, false); assert.equal(r1.status, 409); assert.equal(r1.error, 'staff_reply_unverifiable'); assert.equal(r1.overridable, 'owner_with_reason');
    const r2 = await svc.guardBeforeSend(inbound(bad), { confirmed: true, actor: OWNER });
    assert.equal(r2.allow, false, 'confirm alone must not bypass verification');
  }
});

check('MISSING IDENTIFIERS: override is owner-only (403 for staff or unknown) and needs a real written reason (400 when short)', async () => {
  const svc = svcWith(fakeGraph());
  const s = await svc.guardBeforeSend(inbound({ cid: null }), { override: { reason: 'Customer called, verified by phone today.' }, actor: STAFF });
  assert.equal(s.allow, false); assert.equal(s.status, 403);
  const anon = await svc.guardBeforeSend(inbound({ cid: null }), { override: { reason: 'Customer called, verified by phone today.' } });
  assert.equal(anon.allow, false); assert.equal(anon.status, 403);
  const short = await svc.guardBeforeSend(inbound({ cid: null }), { override: { reason: 'ok' }, actor: OWNER });
  assert.equal(short.allow, false); assert.equal(short.status, 400);
});

check('MISSING IDENTIFIERS: the owner override with a reason is allowed and returns an auditable record (who, when, why)', async () => {
  const r = await svcWith(fakeGraph()).guardBeforeSend(inbound({ cid: null }), { override: { reason: 'Checked info@ Sent Items: no staff reply exists.' }, actor: OWNER });
  assert.equal(r.allow, true); assert.equal(r.audit.kind, 'owner_override_unverifiable'); assert.equal(r.audit.by, OWNER.email);
  assert.match(r.audit.reason, /Sent Items/); assert.ok(r.audit.at);
});

check('the audit entry is appended on the email (history kept); if it cannot be recorded, it throws (the route then sends nothing)', async () => {
  const db = memoryDb({ email_messages: [inbound({ extracted: { staff_reply_audit: [{ kind: 'earlier' }] } })], outbound_email_drafts: [] });
  await supabaseStore(db).appendAudit({ id: 'in-1' }, { kind: 'owner_override_unverifiable', by: OWNER.email, reason: 'x'.repeat(20) });
  assert.deepEqual(db.db.email_messages[0].extracted.staff_reply_audit.map((a) => a.kind), ['earlier', 'owner_override_unverifiable']);
  await assert.rejects(() => supabaseStore(racingDb(db, {})).appendAudit({ id: 'in-1' }, { kind: 'k' }), /could not record/);
});

check('welcome@ behaves exactly like info@; a non-staff mailbox (claire@) is not checked', async () => {
  const w = inbound({ mailbox: WELCOME });
  const svc = svcWith(fakeGraph({ msgs: { [WELCOME]: [reply({ fromMb: WELCOME })] }, journal: J1 }));
  assert.equal((await svc.evaluateInbound(w, [reply({ fromMb: WELCOME })])).status, 'answered');
  assert.equal((await svc.guardBeforeSend(w)).error, 'answered_by_staff');
  const c = await svcWith(fakeGraph()).guardBeforeSend(inbound({ mailbox: 'claire@bedrocktx.com', cid: null }));
  assert.equal(c.allow, true); assert.equal(c.reason, 'not_a_staff_reply_mailbox');
});

// =============================== reconciliation safety ===============================
check('RECONCILE: only open rows change status; prior status/reviewer recorded; draft text, history and other fields kept', async () => {
  const db = memoryDb({ email_messages: [inbound({ status: 'linked', extracted: { draft: { body: 'keep me', status: 'pending', history: [{ event: 'drafted' }] }, other_key: 42 } })], outbound_email_drafts: [] });
  const st = await svcWith(fakeGraph({ journal: J1 }), db).reconcileStored(INFO, [reply()]);
  const r = db.db.email_messages[0];
  assert.deepEqual(st.changes.map((c) => [c.action, c.from_status, c.to_status, c.draft]), [['answered', 'linked', 'handled', 'superseded']]);
  assert.equal(r.extracted.other_key, 42, 'unrelated extracted fields survive');
  assert.equal(r.extracted.draft.body, 'keep me'); assert.deepEqual(r.extracted.draft.history.map((h) => h.event), ['drafted', 'superseded_by_staff']);
  assert.equal(r.extracted.staff_reply.prior.triage_status, 'linked');
});

check('RECONCILE: an already-handled row (e.g. trustEd replied) keeps its status, reviewer and draft; evidence is only noted', async () => {
  const db = memoryDb({ email_messages: [inbound({ status: 'handled', reviewed_by: 'staff', reviewed_at: '2026-10-10T12:00:00Z', extracted: { draft: { body: 'sent text', status: 'sent' } } })], outbound_email_drafts: [] });
  const st = await svcWith(fakeGraph({ journal: J1 }), db).reconcileStored(INFO, [reply()]);
  const r = db.db.email_messages[0];
  assert.equal(st.noted, 1); assert.equal(st.answered, 0);
  assert.equal(r.triage_status, 'handled'); assert.equal(r.reviewed_by, 'staff'); assert.equal(r.reviewed_at, '2026-10-10T12:00:00Z');
  assert.equal(r.extracted.draft.status, 'sent'); assert.equal(r.extracted.draft.body, 'sent text');
});

check('RECONCILE: dismissed and spam rows are never touched', async () => {
  const db = memoryDb({ email_messages: [inbound({ id: 'd', status: 'dismissed' }), inbound({ id: 's', status: 'spam', mid: '<s@e.org>' })], outbound_email_drafts: [] });
  const st = await svcWith(fakeGraph({ journal: J1 }), db).reconcileStored(INFO, [reply()]);
  assert.equal(st.skipped_closed, 2); assert.equal(db.writes.length, 0);
});

check('RECONCILE: newer work is never overwritten (row changed between read and write -> conflict, nothing written)', async () => {
  const db = memoryDb({ email_messages: [inbound()], outbound_email_drafts: [] });
  const st = await svcWith(fakeGraph({ journal: J1 }), racingDb(db, { triage_status: 'handled', reviewed_by: 'Ed' })).reconcileStored(INFO, [reply()]);
  assert.equal(st.conflicts, 1); assert.equal(st.answered, 0);
  const r = db.db.email_messages[0];
  assert.equal(r.reviewed_by, 'Ed', "Ed's newer change is kept"); assert.equal(r.extracted.draft.status, 'pending');
});

check('RECONCILE: idempotent: a second Pull changes nothing (answered and Needs Review alike)', async () => {
  const db = memoryDb({ email_messages: [inbound({ id: 'A' }), inbound({ id: 'B', mid: '<b@e.org>', cid: 'C2' })], outbound_email_drafts: [] });
  const replies = [reply(), reply({ mid: '<rb@b.com>', cid: 'C2' })];
  const first = await svcWith(fakeGraph({ journal: J1 }), db).reconcileStored(INFO, replies);   // B: no journal copy -> Needs Review
  assert.equal(first.answered, 1); assert.equal(first.review, 1);
  const n = db.writes.length;
  const second = await svcWith(fakeGraph({ journal: J1 }), db).reconcileStored(INFO, replies);
  assert.equal(second.changes.length, 0); assert.equal(db.writes.length, n, 'no rewrites on a repeat Pull');
});

check('RECONCILE: Needs Review never re-opens closed work (a handled row stays handled)', async () => {
  const db = memoryDb({ email_messages: [inbound({ status: 'handled' })], outbound_email_drafts: [] });
  const st = await svcWith(fakeGraph({ journal: {} }), db).reconcileStored(INFO, [reply()]);
  assert.equal(st.review, 0); assert.equal(db.writes.length, 0);
});

check('RECONCILE: outbound drafts flagged only when they carry no existing message; sent drafts untouched', async () => {
  const db = memoryDb({ email_messages: [inbound()], outbound_email_drafts: [
    { id: 'o1', source_email_ref: 'in-1', status: 'draft', send_error: null }, { id: 'o2', source_email_ref: 'in-1', status: 'draft', send_error: 'earlier note' },
    { id: 'o3', source_email_ref: 'in-1', status: 'sent', send_error: null }] });
  const st = await svcWith(fakeGraph({ journal: J1 }), db).reconcileStored(INFO, [reply()]);
  const o = Object.fromEntries(db.db.outbound_email_drafts.map((d) => [d.id, d.send_error]));
  assert.match(o.o1, /Superseded by staff reply/); assert.equal(o.o2, 'earlier note'); assert.equal(o.o3, null);
  assert.equal(st.changes[0].outbound_drafts_flagged, 1);
});

check('RECONCILE: rows outside the replies\' conversations and other mailboxes are never changed', async () => {
  const db = memoryDb({ email_messages: [inbound(), inbound({ id: 'other', cid: 'ZZ', mid: '<z@e.org>' }), inbound({ id: 'w', mailbox: WELCOME, mid: '<w@e.org>' })], outbound_email_drafts: [] });
  await svcWith(fakeGraph({ journal: J1 }), db).reconcileStored(INFO, [reply()]);
  assert.deepEqual(db.writes.filter((w) => w.table === 'email_messages').map((w) => w.id), ['in-1']);
});

check('RECONCILE: database failures are reported, not hidden', async () => {
  const svc = createStaffReplyService({ graphGet: fakeGraph({ journal: J1 }).graphGet,
    store: { async inboundInConversation() { throw new Error('db down'); }, async applyAnswered() {}, async applyReview() {} } });
  const st = await svc.reconcileStored(INFO, [reply()]);
  assert.equal(st.errors.length, 1); assert.match(st.errors[0].error, /db down/);
});

check('DRY RUN: the planning store reports the exact change and writes nothing', async () => {
  const db = memoryDb({ email_messages: [inbound()], outbound_email_drafts: [{ id: 'o1', source_email_ref: 'in-1', status: 'draft', send_error: null }] });
  const st = await svcWith(fakeGraph({ journal: J1 }), db, { store: { dryRun: true } }).reconcileStored(INFO, [reply()]);
  assert.equal(st.changes.length, 1); assert.equal(st.changes[0].dry_run, true); assert.equal(st.changes[0].to_status, 'handled');
  assert.equal(db.writes.length, 0); assert.equal(db.db.email_messages[0].triage_status, 'needs_review');
});

// =============================== wiring (static) ===============================
const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
check('ingest: staff sends are never processed as inbound; answered mail gets no AI draft; earlier mail reconciled; changes reported', () => {
  const src = read('lib/email/graph_ingest.js');
  assert.ok(/sender_email\.toLowerCase\(\) === mailbox\.toLowerCase\(\)\) return \{ r: 'skipped' \}/.test(src));
  assert.ok(/if \(!draft && !ppNotice && !staffAnswered\)/.test(src));
  assert.ok(/staffAnswered\) \{\s*\/\/ Staff already answered: no AI draft/.test(src));
  assert.ok(/vr\.draft && !draft && !staffAnswered/.test(src));
  assert.ok(/isCompletionAck\(email\) && !\(draft && draft\.persona === 'amanda'\) && !staffAnswered/.test(src));
  assert.ok(/reconcileStored\(mailbox, staffReplies/.test(src)); assert.ok(/stats\.staff_changes\.push\(\.\.\.rs\.changes\)/.test(src));
});
check('both send paths: guard BEFORE the Graph send; owner check; exception recorded before sending or nothing is sent', () => {
  const t = read('api/email_triage.js'); const i = t.indexOf("router.post('/:id/send'");
  const body = t.slice(i, t.indexOf('router.', i + 30));
  const g = body.indexOf('guardBeforeSend'), a = body.indexOf('appendAudit'), s = body.indexOf('sendReplyAs(');
  assert.ok(g > 0 && a > g && s > a, 'Communications: guard -> audit -> send');
  assert.ok(/is_owner: !!actorEmail && actorEmail === OWNER_EMAIL/.test(body)); assert.ok(/staff_reply_audit_failed/.test(body));
  const d = read('api/email_drafts.js'); const j = d.indexOf("router.post('/:id/send'");
  const dbody = d.slice(j, d.indexOf("router.post('/:id/redraft'"));
  const dg = dbody.indexOf('guardBeforeSend'), da = dbody.indexOf('appendAudit'), ds = dbody.indexOf('sendReplyAs(');
  assert.ok(dg > 0 && da > dg && ds > da, 'outbound drafts: guard -> audit -> send');
  assert.ok(/staff_reply_check_failed/.test(dbody) && /staff_reply_audit_failed/.test(dbody));
});

(async () => { for (const t of pending) await t(); console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0); })();
