'use strict';
// ============================================================================
// tests/test_tessa_threaded_reply.js  (Ed 2026-10-19) — Tessa answers IN the thread
// ----------------------------------------------------------------------------
// Fixture: Paul Grover's "RE: Tax return" (Oct 19), in tessa@ (Cc'd), from Paul,
// To Ed. Ed's approved reply ends "Best regards, / Tessa McCall / Bedrock
// Association Management". Pins, on the REAL POST /api/tessa/inbox/:id/send:
//   - it is a REAL reply in that conversation (Graph createReply on the message in
//     tessa@), from tessa@, addressed to Paul only, Cc nobody;
//   - the signature appears once (the typed name/company lines are dropped, the
//     closing kept);
//   - if the original is gone it refuses (409), never silently starts a new thread;
//     a transient error refuses too (502), nothing sent;
//   - owner-only; nothing filed, mailed or delegated by sending.
//   node tests/test_tessa_threaded_reply.js
// ============================================================================
const assert = require('node:assert/strict');
const http = require('http');
for (const k of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'SUPABASE_URL', 'SUPABASE_KEY']) process.env[k] = process.env[k] || (k === 'SUPABASE_URL' ? 'http://localhost:1' : 'test-key');
process.env.GRAPH_TENANT_ID = process.env.GRAPH_TENANT_ID || 't'; process.env.GRAPH_CLIENT_ID = process.env.GRAPH_CLIENT_ID || 'c'; process.env.GRAPH_CLIENT_SECRET = process.env.GRAPH_CLIENT_SECRET || 's';
let pass = 0, fail = 0; const pending = [];
const check = (name, fn) => pending.push(async () => { try { await fn(); pass++; console.log('  ✓', name); } catch (e) { fail++; console.log('  ✗', name, '\n     ', e.message); } });
const stub = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

// ---- in-memory tables (only what the send route touches) ----
const DB = { ea_inbox: [], email_messages: [], ea_followups: [], library_documents: [], ea_email_events: [], ea_contact_email_history: [], ea_contacts: [] };
function query(table) {
  const st = { op: 'select', f: [], single: false, payload: null };
  const rows = () => (DB[table] = DB[table] || []);
  const run = () => {
    if (st.op === 'insert') { const r = { id: 'x' + rows().length, ...st.payload }; rows().push(r); return { data: r, error: null }; }
    if (st.op === 'update') { const hit = rows().filter((r) => st.f.every((g) => g(r))); hit.forEach((r) => Object.assign(r, st.payload)); return { data: hit, error: null }; }
    const out = rows().filter((r) => st.f.every((g) => g(r)));
    return { data: st.single ? out[0] || null : out, error: st.single && !out[0] ? { message: 'not found' } : null };
  };
  const q = { select() { return q; }, insert(p) { st.op = 'insert'; st.payload = p; return q; }, update(p) { st.op = 'update'; st.payload = p; return q; },
    eq(c, v) { st.f.push((r) => r[c] === v); return q; }, in(c, v) { st.f.push((r) => v.includes(r[c])); return q; }, ilike(c, v) { st.f.push((r) => String(r[c] || '').toLowerCase() === String(v).toLowerCase()); return q; },
    order() { return q; }, limit() { return q; }, gte() { return q; }, not() { return q; }, or() { return q; },
    maybeSingle() { st.single = true; const p = q.then.bind(q); return { then: (a, b) => p((r) => a({ ...r, error: null }), b) }; }, single() { st.single = true; return q; },
    then(a, b) { return Promise.resolve(run()).then(a, b); } };
  return q;
}
const realSB = require('@supabase/supabase-js');
stub('@supabase/supabase-js', { ...realSB, createClient: () => ({ from: (t) => query(t), storage: { from: () => ({}) } }) });
const OWNER_EMAIL = 'egojara@bedrocktx.com';
const USERS = { owner: { user: { id: 'u1' }, role: 'admin', email: OWNER_EMAIL, full_name: 'Ed Gojara' }, staff: { user: { id: 'u3' }, role: 'staff', email: 'celina@bedrocktx.com', full_name: 'Celina Ruiz' } };
const userFor = (req) => USERS[String(req.headers['x-test-user'] || '')] || null;
const realAuth = require('../api/_require_admin');
stub('../api/_require_admin', { ...realAuth, OWNER_EMAIL, getAuthedUser: async (r) => userFor(r),
  requireOwner: async (req, res) => { const u = userFor(req); if (!u || u.email !== OWNER_EMAIL) { res.status(403).json({ error: 'owner_only' }); return null; } return u; },
  requireAdmin: async (req, res) => { const u = userFor(req); if (!u || u.role !== 'admin') { res.status(403).json({ error: 'admin_only' }); return null; } return u; },
  requireStaff: async (req, res) => { const u = userFor(req); if (!u) { res.status(403).json({ error: 'x' }); return null; } return u; } });
const calls = [];
let replyBehavior = 'ok';
stub('../lib/email/graph_search', { searchMailbox: async () => [] });   // the bounced-address check: no network in tests
const realGS = require('../lib/email/graph_send');
const { graphSendError } = require('../lib/email/graph_errors');
stub('../lib/email/graph_send', { ...realGS, isConfigured: () => true,
  sendAs: async (o) => { calls.push({ kind: 'sendAs', ...o }); return { ok: true }; },
  sendReplyAs: async (o) => {
    if (replyBehavior === 'gone') throw graphSendError('createReply', 404, JSON.stringify({ error: { code: 'ErrorItemNotFound', message: 'The specified object was not found in the store.' } }));
    if (replyBehavior === 'outage') throw graphSendError('createReply', 503, 'Service Unavailable');
    calls.push({ kind: 'sendReplyAs', ...o }); return { sent: true };
  } });

const PAUL = { id: 'a1e9e3e9-7c46-4234-9dac-97f0e1cf7fea', graph_id: 'AAMk-paul-reply', from_email: 'paulgrover@ventanaland.com', from_name: 'paulgrover ventanaland.com',
  subject: 'RE: Tax return', received_at: '2026-10-19T16:22:34+00:00', status: 'dismissed', addressed_as: 'cc', to_recipients: ['egojara@bedrocktx.com'], cc_recipients: ['tessa@bedrocktx.com'],
  body_full: 'From: Ed Gojara <egojara@bedrocktx.com>\nSubject: Tax return\n\nHi Paul, Please print, sign and scan back to me...' };
const ED_TEXT = 'Hi Paul,\n\nThank you for sending this over. We\'ll take care of getting it filed with the IRS.\n\nBest regards,\nTessa McCall\nBedrock Association Management';
const reset = () => { DB.ea_inbox = [{ ...PAUL }]; DB.email_messages = []; DB.ea_followups = []; DB.library_documents = []; calls.length = 0; replyBehavior = 'ok'; };

const express = require('express');
const app = express(); app.use('/api/tessa', require('../api/tessa').router);
let base;
async function send(user, body) {
  const r = await fetch(`${base}/api/tessa/inbox/${PAUL.id}/send`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(user ? { 'x-test-user': user } : {}) }, body: JSON.stringify(body) });
  let j = null; try { j = await r.json(); } catch (_) {} return { status: r.status, j };
}
const count = (s, n) => (String(s).match(new RegExp(n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;

console.log('Tessa replies in the thread');
const { stripDuplicateSignOff } = require('../lib/ea/tessa_reply_body');
const ID = require('../lib/email/persona_signature').identity('tessa');

check('SIGN-OFF: the typed name and company are dropped; the closing and the message stay word for word', () => {
  const r = stripDuplicateSignOff(ED_TEXT, ID);
  assert.equal(r.body, 'Hi Paul,\n\nThank you for sending this over. We\'ll take care of getting it filed with the IRS.\n\nBest regards,');
  assert.deepEqual(r.removed, ['Tessa McCall', 'Bedrock Association Management']);
});
check('SIGN-OFF: only TRAILING repeats go; a mention inside the message is kept; nothing to strip is a no-op', () => {
  assert.equal(stripDuplicateSignOff('Bedrock Association Management will file it.\n\nThanks,', ID).body, 'Bedrock Association Management will file it.\n\nThanks,');
  assert.equal(stripDuplicateSignOff('Hi Paul,\n\nGot it.\n\nBest,\nTessa', ID).body, 'Hi Paul,\n\nGot it.\n\nBest,');
  assert.equal(stripDuplicateSignOff('Hi Paul,\n\nGot it.', ID).body, 'Hi Paul,\n\nGot it.');
});
check('SEND: a real reply in Paul\'s conversation, from tessa@, to Paul ONLY, Cc nobody', async () => {
  reset();
  const r = await send('owner', { to: 'paulgrover@ventanaland.com', cc: '', subject: 'RE: Tax return', body: ED_TEXT });
  assert.equal(r.status, 200, JSON.stringify(r.j)); assert.equal(r.j.in_thread, true);
  assert.equal(calls.length, 1); const c = calls[0];
  assert.equal(c.kind, 'sendReplyAs', 'createReply on the original, not a new message');
  assert.equal(c.from, 'tessa@bedrocktx.com'); assert.equal(c.sourceMailbox, 'tessa@bedrocktx.com'); assert.equal(c.sourceGraphId, PAUL.graph_id);
  assert.deepEqual(c.to, ['paulgrover@ventanaland.com']); assert.deepEqual(c.cc || [], []);
  assert.ok(!JSON.stringify(c).includes('egojara@bedrocktx.com'), 'Ed is not added automatically');
});
check('SEND: Tessa\'s signature appears exactly once (no doubled name or company)', async () => {
  reset();
  await send('owner', { to: 'paulgrover@ventanaland.com', body: ED_TEXT });
  const html = calls[0].html;
  const sigOnly = require('../lib/email/tessa_signature').buildTessaEmail('Hi Paul,', null, '').html;
  assert.equal(count(html, 'Tessa McCall'), count(sigOnly, 'Tessa McCall'));
  assert.equal(count(html, 'Bedrock Association Management'), count(sigOnly, 'Bedrock Association Management'));
  assert.ok(html.includes('Best regards,') && html.includes('getting it filed with the IRS'));
  assert.ok(!html.includes('Please print, sign and scan'), 'no second copy of the history: Outlook quotes it in the reply');
});
check('SEND: with no To given it still goes to Paul alone (the sender), never to Ed or the Cc list', async () => {
  reset();
  await send('owner', { body: ED_TEXT });
  assert.deepEqual(calls[0].to, ['paulgrover@ventanaland.com']); assert.deepEqual(calls[0].cc || [], []);
});
check('SEND: original gone -> 409, nothing sent, no silent new thread; only an explicit choice sends a fresh message', async () => {
  reset(); replyBehavior = 'gone';
  const r = await send('owner', { to: 'paulgrover@ventanaland.com', body: ED_TEXT });
  assert.equal(r.status, 409); assert.equal(r.j.error, 'thread_unavailable'); assert.equal(calls.length, 0);
  assert.equal(DB.ea_inbox[0].status, 'dismissed', 'not marked replied');
  const f = await send('owner', { to: 'paulgrover@ventanaland.com', body: ED_TEXT, allow_new_thread: true });
  assert.equal(f.status, 200); assert.equal(calls[0].kind, 'sendAs'); assert.equal(f.j.in_thread, false);
});
check('SEND: a temporary Microsoft error -> 502, nothing sent, no fallback', async () => {
  reset(); replyBehavior = 'outage';
  const r = await send('owner', { to: 'paulgrover@ventanaland.com', body: ED_TEXT, allow_new_thread: true });
  assert.equal(r.status, 502); assert.equal(calls.length, 0); assert.equal(DB.ea_inbox[0].status, 'dismissed');
});
check('SEND: only Ed can send; staff and signed-out callers are refused', async () => {
  reset();
  assert.equal((await send('staff', { body: ED_TEXT })).status, 403);
  assert.equal((await send(null, { body: ED_TEXT })).status, 403);
  assert.equal(calls.length, 0);
});
check('SEND: replying marks the email replied and logs it; it files, mails and delegates nothing', async () => {
  reset();
  await send('owner', { to: 'paulgrover@ventanaland.com', body: ED_TEXT });
  assert.equal(DB.ea_inbox[0].status, 'replied');
  assert.equal(DB.email_messages.length, 1); assert.equal(DB.email_messages[0].persona, 'tessa');
  assert.equal(DB.ea_followups.length, 0); assert.equal(DB.library_documents.length, 0);
});

(async () => {
  const server = http.createServer(app); await new Promise((r) => server.listen(0, r)); base = 'http://127.0.0.1:' + server.address().port;
  for (const t of pending) await t();
  // Close sockets and let Node exit on its own: a forced exit with open keep-alive
  // sockets has crashed Node on Windows (exit 0xC0000409) after all checks passed.
  server.closeAllConnections(); server.close();
  console.log(`\n${pass} passed, ${fail} failed`); process.exitCode = fail ? 1 : 0;
})();
