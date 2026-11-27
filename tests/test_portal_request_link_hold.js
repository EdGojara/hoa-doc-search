// Public launch hold (Ed 2026-11-27): an account created silently for an association
// whose portal is off must not receive a sign-in email. Same answer as "not on file".
// An open association (or the owner's pilot) still gets the link. Board members keep theirs.
'use strict';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1:9';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'x';
const assert = require('assert');
const path = require('path');

const db = {
  portal_users: [
    { id: 'u-closed', email: 'closed@example.com', role: 'homeowner', status: 'invited', management_company_id: '00000000-0000-0000-0000-000000000001' },
    { id: 'u-open', email: 'open@example.com', role: 'homeowner', status: 'active', management_company_id: '00000000-0000-0000-0000-000000000001' },
    { id: 'u-pilot', email: 'pilot@example.com', role: 'homeowner', status: 'active', management_company_id: '00000000-0000-0000-0000-000000000001' },
    { id: 'u-board', email: 'board@example.com', role: 'board_member', status: 'active', management_company_id: '00000000-0000-0000-0000-000000000001' },
  ],
  portal_user_properties: [
    { portal_user_id: 'u-closed', property_id: 'p-closed', revoked_at: null },
    { portal_user_id: 'u-open', property_id: 'p-open', revoked_at: null },
    { portal_user_id: 'u-pilot', property_id: 'p-closed', revoked_at: null },
  ],
  properties: [
    { id: 'p-closed', communities: { portal_active: false, is_demo: false, portal_module_config: { portal_pilot: { user_ids: ['u-pilot'] } } } },
    { id: 'p-open', communities: { portal_active: true, is_demo: false, portal_module_config: {} } },
  ],
  portal_magic_links: [],
};
function from(table) {
  const f = {}; let op = 'select'; let payload = null;
  const q = {
    select() { return q; }, eq(c, v) { f[c] = v; return q; }, is(c, v) { f[c] = v; return q; },
    in(c, v) { f[c] = { in: v }; return q; }, limit() { return q; },
    insert(p) { op = 'insert'; payload = p; return q; },
    maybeSingle() { return run().then((r) => ({ data: (r.data || [])[0] || null, error: null })); },
    then(ok, bad) { return run().then(ok, bad); },
  };
  function run() {
    if (op === 'insert') { db[table].push(payload); return Promise.resolve({ data: null, error: null }); }
    const rows = (db[table] || []).filter((r) => Object.entries(f).every(([c, v]) => (v && v.in ? v.in.includes(r[c]) : (v === null ? r[c] == null : r[c] === v))));
    return Promise.resolve({ data: rows, error: null });
  }
  return q;
}
const fake = { from, rpc: async () => ({ data: null, error: null }) };
const sbPath = require.resolve('@supabase/supabase-js');
require.cache[sbPath] = { id: sbPath, filename: sbPath, loaded: true, exports: { createClient: () => fake } };
const sent = [];
const emailPath = require.resolve(path.join(__dirname, '..', 'lib/notifications/email.js'));
require.cache[emailPath] = { id: emailPath, filename: emailPath, loaded: true, exports: { sendEmail: async (m) => { sent.push(m.to); return { ok: true }; }, isConfigured: () => true } };

const express = require('express');
const router = require('../api/portal');
(async () => {
  const app = express(); app.use('/api/portal', router.router || router);
  const server = app.listen(0); const port = server.address().port;
  const ask = async (email) => {
    const r = await fetch(`http://127.0.0.1:${port}/api/portal/request-link`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) });
    return { status: r.status, body: await r.json() };
  };
  try {
    const closed = await ask('closed@example.com');
    assert.deepStrictEqual(closed, { status: 200, body: { ok: true } }, 'same answer as not on file');
    assert.ok(!sent.includes('closed@example.com'), 'a portal-off account gets no sign-in email');
    assert.ok(!db.portal_magic_links.some((l) => l.portal_user_id === 'u-closed'), 'and no link is issued');
    await ask('open@example.com');
    assert.ok(sent.includes('open@example.com'), 'an open association still gets its link');
    await ask('pilot@example.com');
    assert.ok(sent.includes('pilot@example.com'), "the owner's pilot homeowner still gets a link");
    await ask('board@example.com');
    assert.ok(sent.includes('board@example.com'), 'board members are unaffected');
    console.log('test_portal_request_link_hold: ok');
  } finally { server.close(); }
})().catch((e) => { console.error(e); process.exit(1); });
