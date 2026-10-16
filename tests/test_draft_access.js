// Draft Queue authorization, search-input safety and the scoped board-list
// picker (Ed 2026-10-16, stacked on the New Email work). No network and NO REAL
// EMAIL: Supabase, storage, auth and Graph sendAs are in-memory fakes.
'use strict';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://fake.local';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'fake';
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'sk-test-not-used';
delete process.env.ANTHROPIC_API_KEY;

let pass = 0, fail = 0;
const check = (name, ok, info) => { if (ok) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name + (info ? ' :: ' + info : '')); } };
const PF = require('./helpers/postgrest_filter');

// ---- in-memory Supabase ---------------------------------------------------------
const CG = 'a0000000-0000-4000-8000-000000000003';
const EAGLE = 'a0000000-0000-4000-8000-0000000000e1';
const DEMO = 'a0000000-0000-4000-8000-0000000000d1';
const PROSPECT = 'a0000000-0000-4000-8000-0000000000c1';
const U = { owner: '10000000-0000-4000-8000-000000000001', admin2: '10000000-0000-4000-8000-000000000002', staffA: '10000000-0000-4000-8000-00000000000a', staffB: '10000000-0000-4000-8000-00000000000b' };
let seq = 0, clock = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;
const ts = () => new Date(Date.parse('2026-10-16T12:00:00Z') + (++clock) * 1000).toISOString();
const draft = (o) => ({ id: uuid(), status: 'draft', draft_kind: 'amanda_console', persona: 'amanda', to_email: 'president@canyongate.test', cc: null, subject: 'S', body_text: 'B', attachments: [], owner_user_id: null, created_at: ts(), updated_at: ts(), community_id: CG, community_name: 'Canyon Gate at Cinco Ranch', ...o });
const db = {
  failBoard: false,
  communities: [
    { id: CG, name: 'Canyon Gate at Cinco Ranch', management_status: 'active', is_demo: false },
    { id: EAGLE, name: 'Eaglewood', management_status: 'archived', is_demo: false },
    { id: DEMO, name: 'Drama Creek', management_status: 'active', is_demo: true },
    { id: PROSPECT, name: 'Covington Woods', management_status: 'prospect', is_demo: false },
  ],
  board_members: [
    { name: 'Hugh Durlam', email: 'president@canyongate.test', position: 'President', community_id: CG, community_name: 'Canyon Gate at Cinco Ranch', is_active: true },
    { name: 'Eve Eagle', email: 'eve@eaglewood.test', position: 'President', community_id: EAGLE, community_name: 'Eaglewood', is_active: true },
    { name: 'Dee Demo', email: 'dee@dramacreek.test', position: 'President', community_id: DEMO, community_name: 'Drama Creek', is_active: true },
    { name: 'Cora Covington', email: 'cora@covington.test', position: 'President', community_id: PROSPECT, community_name: 'Covington Woods', is_active: true },
  ],
  contacts: [
    { id: 'c1', full_name: "Mary O'Brien", primary_email: 'mary@x.test', secondary_email: null },
    { id: 'c2', full_name: 'Ann 100% Real', primary_email: 'ann@x.test', secondary_email: null },
    { id: 'c3', full_name: 'Under_Score Smith', primary_email: 'under@x.test', secondary_email: null },
    { id: 'c4', full_name: 'Comma, Person', primary_email: 'comma@x.test', secondary_email: null },
    { id: 'c5', full_name: 'Robert "Bob" Steady', primary_email: 'bob@x.test', secondary_email: null },
    { id: 'c6', full_name: 'Plain Neighbor', primary_email: 'plain@x.test', secondary_email: null },
  ],
  properties: [{ id: 'p1', street_address: '1 Canyon Gate Dr', community_id: CG }],
  property_ownerships: ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'].map((c) => ({ contact_id: c, property_id: 'p1', end_date: null })),
  user_profiles: [], vendors: [], community_contacts: [], email_messages: [], work_items: [], work_item_events: [],
  outbound_email_drafts: [],
};
const dA = draft({ draft_kind: 'compose', persona: 'claire', owner_user_id: U.staffA, subject: 'Staff A draft' });
const dB = draft({ draft_kind: 'compose', persona: 'amanda', owner_user_id: U.staffB, subject: 'Staff B draft' });
// Autonomous AI-agent drafts (no human starter), shaped like production's 38 open drafts.
const dAnnie = draft({ persona: 'annie', draft_kind: 'acknowledgment', created_by: 'annie-auto', subject: 'Annie ACC acknowledgment' });
const dAmanda = draft({ persona: 'amanda', draft_kind: 'reply', subject: 'Amanda reply' });
const dEmma = draft({ persona: 'emma', draft_kind: 'outbound', subject: 'Emma vendor note' });
const dKat = draft({ persona: 'kat', draft_kind: 'outbound', subject: 'Kat statement request' });
const dAuto = draft({ persona: 'amanda', draft_kind: 'acknowledgment', subject: 'Amanda automation draft' });
const dNoPersona = draft({ persona: null, draft_kind: 'reply', subject: 'No persona' });
// Ed-only, even though it has no human starter.
const dTessa = draft({ persona: 'tessa', draft_kind: 'reply', subject: 'Tessa private' });
// Human-started kinds saved before migration 533 stamped an owner: never "autonomous".
const dLegacyCompose = draft({ draft_kind: 'compose', persona: 'claire', subject: 'Pre-533 New Email draft' });
const dConsole = draft({ draft_kind: 'amanda_console', persona: 'amanda', created_by: 'b@bedrocktx.com', subject: 'Ask-Amanda draft' });
db.outbound_email_drafts.push(dA, dB, dAnnie, dAmanda, dEmma, dKat, dAuto, dNoPersona, dTessa, dLegacyCompose, dConsole);

function qb(table) {
  const st = { filters: [], op: 'select', single: false, maybe: false, select: '', limit: null, order: null, head: false };
  const rowsOf = () => (db[table] || []).filter((r) => st.filters.every((f) => f(r)));
  const q = {
    select(c, o) { st.select = c || '*'; if (o && o.head) st.head = true; if (st.op !== 'select') st.returning = true; return q; },
    eq(k, v) { st.filters.push((r) => r[k] === v); return q; }, neq(k, v) { st.filters.push((r) => r[k] != null && r[k] !== v); return q; },
    in(k, v) { st.filters.push((r) => v.includes(r[k])); return q; }, is(k, v) { st.filters.push((r) => (r[k] ?? null) === v); return q; },
    not(k, op, v) { st.filters.push((r) => !((r[k] ?? null) === v)); return q; },
    ilike(k, v) { const re = PF.likeToRegex(v); st.filters.push((r) => re.test(String(r[k] || ''))); return q; },
    like(k, v) { const re = PF.likeToRegex(v, ''); st.filters.push((r) => re.test(String(r[k] || ''))); return q; },
    or(expr) { if (db.no533 && table === 'outbound_email_drafts' && /owner_user_id/.test(expr)) st.err = 'column outbound_email_drafts.owner_user_id does not exist'; st.filters.push(PF.parseOr(expr)); return q; },
    order(k, o) { st.order = st.order || { k, asc: !(o && o.ascending === false) }; return q; }, limit(n) { st.limit = n; return q; }, range() { return q; },
    gte() { return q; }, lt() { return q; },
    insert(row) { st.op = 'insert'; st.rows = Array.isArray(row) ? row : [row]; return q; },
    update(p) { st.op = 'update'; st.patch = p; return q; },
    single() { st.single = true; return q; }, maybeSingle() { st.maybe = true; return q; },
    then(res, rej) { return Promise.resolve().then(run).then(res, rej); },
  };
  const out = (rows) => { const c = rows.map((r) => { const o = { ...r }; if (db.no533 && table === 'outbound_email_drafts') delete o.owner_user_id; if (table === 'property_ownerships' && /properties:property_id/.test(st.select)) o.properties = db.properties.find((p) => p.id === r.property_id) || null; return JSON.parse(JSON.stringify(o)); }); return { data: st.single || st.maybe ? (c[0] || null) : c, error: null }; };
  function run() {
    if (st.err) return { data: null, error: { code: '42703', message: st.err } };
    if (table === 'board_members' && db.failBoard) return { data: null, error: { message: 'relation "board_members" permission denied for schema public (SQLSTATE 42501)' } };
    if (st.op === 'insert') {
      const made = [];
      for (const r of st.rows) {
        if (table === 'work_items' && r.source_ref && db.work_items.some((x) => x.source_ref === r.source_ref && ['new', 'in_progress', 'waiting'].includes(x.status))) return { data: null, error: { message: 'duplicate key value violates unique constraint "ux_work_items_open_source_ref"' } };
        const t = ts(); const row = { id: uuid(), created_at: t, updated_at: t, ...(table === 'work_items' ? { workspace: 'operations', blocks: [], links: [] } : {}), ...(table === 'outbound_email_drafts' ? { compose_state: null, work_item_id: null, sent_email_message_id: null, owner_user_id: null, attachments: [] } : {}), ...r };
        (db[table] = db[table] || []).push(row); made.push(row);
      }
      return out(made);
    }
    if (st.op === 'update') { const hit = rowsOf(); for (const r of hit) Object.assign(r, st.patch, { updated_at: ts() }); return st.returning ? out(hit) : { data: null, error: null }; }
    let rows = rowsOf();
    if (st.head) return { count: rows.length, error: null };
    if (st.order) rows = rows.slice().sort((a, b) => (String(a[st.order.k]) < String(b[st.order.k]) ? -1 : 1) * (st.order.asc ? 1 : -1));
    if (st.limit != null) rows = rows.slice(0, st.limit);
    return out(rows);
  }
  return q;
}
const storage = new Map();
const fakeSb = { from: qb, auth: { getUser: async () => ({ data: { user: null } }) }, rpc: async () => ({ data: null, error: null }),
  storage: { from: (b) => ({ upload: async (p, buf) => { storage.set(b + '/' + p, Buffer.from(buf)); return { error: null }; }, download: async (p) => { const x = storage.get(b + '/' + p); return x ? { data: { arrayBuffer: async () => x }, error: null } : { data: null, error: { message: 'missing' } }; }, remove: async () => ({ error: null }) }) } };
const stub = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
stub('@supabase/supabase-js', { createClient: () => fakeSb });
const USERS = {
  owner: { role: 'admin', full_name: 'Ed Gojara', email: 'egojara@bedrocktx.com', user: { id: U.owner } },
  admin2: { role: 'admin', full_name: 'Second Admin', email: 'admin2@bedrocktx.com', user: { id: U.admin2 } },
  staffA: { role: 'staff', full_name: 'Staff A', email: 'a@bedrocktx.com', user: { id: U.staffA } },
  staffB: { role: 'staff', full_name: 'Staff B', email: 'b@bedrocktx.com', user: { id: U.staffB } },
};
const who = (req) => USERS[req.headers['x-test-user']] || null;
stub('../api/_require_admin', {
  getAuthedUser: async (req) => who(req),
  requireStaff: async (req, res) => who(req) || (res.status(403).json({ error: 'sign_in_required' }), null),
  requireAdmin: async (req, res) => { const u = who(req); if (!u || u.role !== 'admin') { res.status(403).json({ error: 'admin_only' }); return null; } return u; },
  requireOwner: async (req, res) => { const u = who(req); if (!u || u.email !== 'egojara@bedrocktx.com') { res.status(403).json({ error: 'owner_only' }); return null; } return u; },
  OWNER_EMAIL: 'egojara@bedrocktx.com',
});
stub('../lib/email/proofread', { proofreadEmailBody: async (b) => ({ text: b, changed: false }) });
stub('../lib/demo/demo_guard', Object.assign({}, require('../lib/demo/demo_guard'), { demoCommunityIds: async () => [DEMO], isDemoCommunity: async (id) => id === DEMO }));
const graphSend = require('../lib/email/graph_send');
const sent = [];
graphSend.isConfigured = () => true;
graphSend.sendAs = async (m) => { sent.push(JSON.parse(JSON.stringify({ from: m.from, to: m.to, subject: m.subject }))); return { sent: true }; };
graphSend.sendReplyAs = async () => { throw new Error('not used'); };
graphSend.getToken = async () => { throw new Error('no network in tests'); };

const express = require('express');
const SF = require('../lib/db/search_filter');
const DA = require('../lib/email/draft_access');
const CD = require('../lib/email/compose_drafts');

async function main() {
  console.log('search_filter (unit)');
  check('LIKE wildcards and backslash become literals', SF.escapeLike('100%_a\\b') === '100\\%\\_a\\\\b');
  check('or() values are double-quoted, so commas and parentheses stay inside one value', SF.orIlike(['full_name', 'primary_email'], 'x,id.not.is.null)') === 'full_name.ilike."%x,id.not.is.null)%",primary_email.ilike."%x,id.not.is.null)%"');
  check('quotes and backslashes are escaped inside the quoted value', SF.orIlike(['n'], 'a"b\\c') === 'n.ilike."%a\\"b\\\\\\\\c%"');
  check('* (PostgREST wildcard alias), control characters and runs of spaces are neutralized', SF.normalizeQuery(' a*\u0000b   c ') === 'a b c');
  check('column names are never taken from input', (() => { try { SF.orIlike(['name; drop'], 'x'); return false; } catch (_) { return true; } })());
  check('exact email match escapes wildcards (a_b does not match axb)', PF.parseOr(SF.orIlikeExact(['e'], 'a_b@x.test'))({ e: 'axb@x.test' }) === false && PF.parseOr(SF.orIlikeExact(['e'], 'A_B@x.test'))({ e: 'a_b@x.test' }) === true);

  const app = express();
  app.use(express.json());
  app.use('/api/email-drafts', require('../api/email_drafts'));
  app.use('/api/email-triage', require('../api/email_triage').router);
  app.use('/api/mission-control', require('../api/mission_control').router);
  app.use('/api/work-items', require('../api/work_items').router);
  const srv = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (method, url, user, body) => { const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(user ? { 'x-test-user': user } : {}) }, body: body ? JSON.stringify(body) : undefined }); let j = null; try { j = await r.json(); } catch (_) {} return { status: r.status, body: j }; };
  const row = (d) => db.outbound_email_drafts.find((x) => x.id === d.id);

  try {
    console.log('Draft Queue: signed out');
    check('signed-out callers are refused on every route', (await call('GET', '/api/email-drafts', null)).status === 403 && (await call('GET', '/api/email-drafts/personas', null)).status === 403
      && (await call('POST', `/api/email-drafts/${dA.id}/send`, null, {})).status === 403 && (await call('POST', `/api/email-drafts/${dA.id}/discard`, null, {})).status === 403 && sent.length === 0);

    console.log('Draft Queue: Staff A vs Staff B');
    const a = {
      open: await call('GET', `/api/email-drafts/${dB.id}`, 'staffA'),
      edit: await call('PUT', `/api/email-drafts/${dB.id}`, 'staffA', { subject: 'hijacked' }),
      send: await call('POST', `/api/email-drafts/${dB.id}/send`, 'staffA', { approved_by: 'Ed' }),
      discard: await call('POST', `/api/email-drafts/${dB.id}/discard`, 'staffA', {}),
      redraft: await call('POST', `/api/email-drafts/${dB.id}/redraft`, 'staffA', { notes: 'x', body_text: 'y' }),
      forward: await call('POST', `/api/email-drafts/${dB.id}/forward`, 'staffA', { to_email: 'a@bedrocktx.com' }),
    };
    check('Staff A cannot open, edit, send, discard, redraft or forward Staff B’s draft (clean 403 each)', Object.values(a).every((r) => r.status === 403 && r.body.error === 'draft_forbidden' && /started by someone else/.test(r.body.detail)), JSON.stringify(Object.fromEntries(Object.entries(a).map(([k, v]) => [k, v.status]))));
    check('and nothing changed: Staff B’s draft is untouched and nothing was sent', row(dB).subject === 'Staff B draft' && row(dB).status === 'draft' && sent.length === 0);
    check('a human draft with no stamped owner (pre-533 New Email, Ask-Amanda desk) is not treated as autonomous', (await call('POST', `/api/email-drafts/${dLegacyCompose.id}/send`, 'staffA', {})).status === 403 && (await call('POST', `/api/email-drafts/${dConsole.id}/discard`, 'staffA', {})).status === 403 && sent.length === 0);
    const listA = (await call('GET', '/api/email-drafts?status=draft', 'staffA')).body.drafts.map((d) => d.id).sort();
    const expectA = [dA, dAnnie, dAmanda, dEmma, dKat, dAuto, dNoPersona].map((d) => d.id).sort();
    check('Staff A’s list: own drafts plus autonomous agent drafts; never Staff B’s, Tessa’s or an unstamped human draft (filtered in the query)', JSON.stringify(listA) === JSON.stringify(expectA), String(listA.length));
    const countsA = (await call('GET', '/api/email-drafts/counts', 'staffA')).body.counts;
    check('Staff A’s counts follow the same rule', JSON.stringify(countsA) === JSON.stringify({ claire: 1, annie: 1, amanda: 2, emma: 1, kat: 1, unassigned: 1 }), JSON.stringify(countsA));
    check('Staff A can open and edit their own draft', (await call('GET', `/api/email-drafts/${dA.id}`, 'staffA')).status === 200 && (await call('PUT', `/api/email-drafts/${dA.id}`, 'staffA', { subject: 'Staff A draft v2' })).status === 200 && row(dA).subject === 'Staff A draft v2');
    check('Staff A cannot move their own draft into the owner’s private (Tessa) outbox', (await call('PUT', `/api/email-drafts/${dA.id}`, 'staffA', { persona: 'tessa' })).status === 403 && row(dA).persona === 'claire');
    const sA = await call('POST', `/api/email-drafts/${dA.id}/send`, 'staffA', { approved_by: 'Ed Gojara' });
    check('Staff A can send their own draft, once; the approver is the signed-in person, not a name the browser sent', sA.status === 200 && sent.length === 1 && row(dA).status === 'sent' && row(dA).approved_by === 'Staff A');

    console.log('Draft Queue: autonomous AI-agent drafts');
    for (const [who, d] of [['Annie', dAnnie], ['Amanda', dAmanda], ['Emma', dEmma], ['Kat', dKat]]) {
      const n = sent.length;
      const o = await call('GET', `/api/email-drafts/${d.id}`, 'staffB');
      const e = await call('PUT', `/api/email-drafts/${d.id}`, 'staffB', { subject: d.subject + ' (reviewed)' });
      const r = await call('POST', `/api/email-drafts/${d.id}/send`, 'staffB', {});
      check(`a staff member can open, edit and send ${who}’s autonomous draft (once; approver = that staff member)`, o.status === 200 && e.status === 200 && r.status === 200 && sent.length === n + 1 && row(d).status === 'sent' && row(d).approved_by === 'Staff B', `${o.status}/${e.status}/${r.status}`);
    }
    check('a staff member can discard an autonomous agent draft', (await call('POST', `/api/email-drafts/${dNoPersona.id}/discard`, 'staffA', {})).status === 200 && row(dNoPersona).status === 'discarded');
    check('an admin can open and edit any staff, agent or unstamped human draft', (await call('GET', `/api/email-drafts/${dB.id}`, 'admin2')).status === 200 && (await call('PUT', `/api/email-drafts/${dAuto.id}`, 'admin2', { subject: 'Edited by admin' })).status === 200 && (await call('GET', `/api/email-drafts/${dConsole.id}`, 'admin2')).status === 200);
    const listAdmin = (await call('GET', '/api/email-drafts?status=all', 'admin2')).body.drafts.map((d) => d.id);
    check('an admin sees every draft except the owner’s private outbox; drafts with no persona are not lost', listAdmin.includes(dB.id) && listAdmin.includes(dAuto.id) && listAdmin.includes(dNoPersona.id) && listAdmin.includes(dLegacyCompose.id) && !listAdmin.includes(dTessa.id));
    const nT = sent.length;
    const tStaff = [await call('GET', `/api/email-drafts/${dTessa.id}`, 'staffA'), await call('PUT', `/api/email-drafts/${dTessa.id}`, 'staffA', { subject: 'x' }), await call('POST', `/api/email-drafts/${dTessa.id}/send`, 'staffA', {}), await call('POST', `/api/email-drafts/${dTessa.id}/discard`, 'staffA', {})];
    const tAdmin = [await call('GET', `/api/email-drafts/${dTessa.id}`, 'admin2'), await call('POST', `/api/email-drafts/${dTessa.id}/send`, 'admin2', {})];
    check('a Tessa draft with no human starter is NOT staff-actionable: open, edit, send, discard all 403', tStaff.every((r) => r.status === 403) && row(dTessa).status === 'draft' && row(dTessa).subject === 'Tessa private' && sent.length === nT);
    check('Tessa drafts stay Ed-only: another admin 403, Ed 200, and only Ed’s list shows them', tAdmin.every((r) => r.status === 403) && (await call('GET', `/api/email-drafts/${dTessa.id}`, 'owner')).status === 200
      && (await call('GET', '/api/email-drafts?status=draft', 'owner')).body.drafts.some((d) => d.id === dTessa.id) && sent.length === nT);
    const sAuto = await call('POST', `/api/email-drafts/${dAuto.id}/send`, 'admin2', {});
    check('an admin can send an autonomous agent draft (approver recorded as that admin)', sAuto.status === 200 && row(dAuto).status === 'sent' && row(dAuto).approved_by === 'Second Admin');

    console.log('before migration 533 (no owner column)');
    db.no533 = true;
    const preRes = await call('GET', '/api/email-drafts?status=all', 'staffA');
    const pre = (preRes.body.drafts || []).map((d) => d.id);
    check('staff still see autonomous drafts (fallback filter) and never human-started or Tessa drafts', preRes.status === 200 && pre.includes(dAnnie.id) && !pre.includes(dB.id) && !pre.includes(dLegacyCompose.id) && !pre.includes(dTessa.id) && !pre.includes(dConsole.id), JSON.stringify(preRes.body).slice(0, 200));
    db.no533 = false;

    console.log('compose drafts and their Mission Control tasks');
    const t = await CD.syncComposeTask(row(dB), 'Staff B');
    check('Staff B\'s Amanda compose draft has a task on Amanda\'s list', t && t.id && db.work_items.find((w) => w.id === t.id).assigned_to === 'Amanda');
    check('Staff A cannot close or edit that task (Mission Control or the team board)', (await call('PATCH', `/api/mission-control/items/${t.id}`, 'staffA', { status: 'done' })).status === 403
      && (await call('PATCH', `/api/work-items/${t.id}`, 'staffA', { status: 'done' })).status === 403 && db.work_items.find((w) => w.id === t.id).status === 'new');
    check('Staff B (the starter) can update it, and so can an admin', (await call('PATCH', `/api/mission-control/items/${t.id}`, 'staffB', { notes: 'checking with the board' })).status === 200
      && (await call('PATCH', `/api/mission-control/items/${t.id}`, 'admin2', { urgency: 'high' })).status === 200);
    const dis = await call('POST', `/api/email-drafts/${dB.id}/discard`, 'staffB', {});
    check('Staff B can discard their own draft; its task closes', dis.status === 200 && row(dB).status === 'discarded' && db.work_items.find((w) => w.id === t.id).status === 'dismissed');
    const sv = await call('POST', '/api/email-triage/compose/drafts', 'owner', { persona: 'claire', to: ['plain@x.test'], subject: 'Owned compose', body: 'b' });
    check('a New Email draft records who started it', sv.status === 200 && row({ id: sv.body.draft_id }).owner_user_id === U.owner);
    check('the compose routes refuse staff (Communications is admin-only) and signed-out callers', (await call('GET', `/api/email-triage/compose/drafts/${sv.body.draft_id}`, 'staffA')).status === 403 && (await call('GET', `/api/email-triage/compose/drafts/${sv.body.draft_id}`, null)).status === 403);
    check('the same rule is applied inside the compose helpers (a staff caller is refused even if a route forgot)', await CD.saveComposeDraft({ draft_id: sv.body.draft_id, persona: 'claire', to: ['plain@x.test'], subject: 'x', body: 'y' }, { user: USERS.staffA }).then(() => false, (e) => e.status === 403));
    const tSv = db.work_items.find((w) => w.source_ref === `compose_draft:${sv.body.draft_id}`);
    check('a staff user cannot close an admin\'s compose task', (await call('PATCH', `/api/mission-control/items/${tSv.id}`, 'staffA', { status: 'done' })).status === 403);
    check('decide(): signed out / missing draft / owner-only persona are refused', !DA.decide(null, dA).allowed && DA.decide(USERS.owner, null).status === 404 && !DA.decide(USERS.admin2, { persona: 'tessa' }).allowed && DA.decide(USERS.owner, { persona: 'tessa' }).allowed);

    console.log('search safety (routes)');
    const cs = async (q) => (await call('GET', '/api/email-triage/contact-search?q=' + encodeURIComponent(q), 'owner'));
    const rs = async (q) => (await call('GET', '/api/email-triage/compose/recipients?q=' + encodeURIComponent(q), 'owner'));
    const names = (r) => (r.body.items || r.body.results || []).map((x) => x.name).sort().join(' | ');
    check('apostrophes: "o\'b" finds Mary O\'Brien', names(await cs("o'b")) === "Mary O'Brien" && names(await rs("o'b")) === "Mary O'Brien");
    check('% is literal: "100%" and "% r" find only Ann; "%%" matches nobody (it used to match everyone)', names(await cs('100%')) === 'Ann 100% Real' && names(await cs('% r')) === 'Ann 100% Real' && names(await cs('%%')) === '' && names(await rs('%%')) === '');
    check('_ is literal: "r_s" finds only Under_Score; "__" matches nobody (it used to match everyone)', names(await cs('r_s')) === 'Under_Score Smith' && names(await rs('r_s')) === 'Under_Score Smith' && names(await cs('__')) === '' && names(await rs('__')) === '');
    check('one-character queries return nothing (bounded)', names(await cs('%')) === '' && names(await cs('_')) === '');
    check('commas stay inside the search: "Comma, P" finds Comma, Person', names(await cs('Comma, P')) === 'Comma, Person' && names(await rs('comma, p')) === 'Comma, Person');
    check('double quotes: "\\"Bob\\"" finds Robert "Bob" Steady', names(await cs('"Bob"')) === 'Robert "Bob" Steady');
    for (const inj of ['x%,id.not.is.null', 'a),or(full_name.ilike.*', '%,full_name.ilike.%', "' OR 1=1 --", '\\', 'plain") ,primary_email.ilike."%']) {
      const r1 = await cs(inj); const r2 = await rs(inj);
      check(`injection-like input ${JSON.stringify(inj)} matches nothing extra and does not error`, r1.status === 200 && r2.status === 200 && (r1.body.items || []).length === 0 && (r2.body.results || []).length === 0, `${r1.status}/${r2.status} ${names(r1)} ${names(r2)}`);
    }
    check('partial name and partial email still work', names(await cs('neigh')) === 'Plain Neighbor' && names(await cs('plain@x')) === 'Plain Neighbor' && names(await rs('neigh')) === 'Plain Neighbor');

    console.log('board-list picker');
    const bl = await call('GET', '/api/email-triage/compose/board-lists', 'owner');
    check('only currently managed communities: Canyon Gate yes; Eaglewood (archived), Drama Creek (demo), Covington Woods (prospect) no', bl.status === 200 && bl.body.lists.map((g) => g.community).join() === 'Canyon Gate at Cinco Ranch' && bl.body.lists[0].members[0].name === 'Hugh Durlam');
    const pres = (await rs('president')).body.results;
    check('autocomplete applies the same scope (no Eaglewood, demo or prospect board members)', pres.some((r) => r.name === 'Hugh Durlam') && !pres.some((r) => /eaglewood|dramacreek|covington/i.test(r.email || '')) && !(await rs('eve eagle')).body.results.length && !(await rs('cora')).body.results.length, JSON.stringify(pres.map((r) => r.email)));
    check('the board-list picker refuses signed-out and staff callers', (await call('GET', '/api/email-triage/compose/board-lists', null)).status === 403 && (await call('GET', '/api/email-triage/compose/board-lists', 'staffA')).status === 403);
    db.failBoard = true;
    const blErr = await call('GET', '/api/email-triage/compose/board-lists', 'owner');
    db.failBoard = false;
    check('a database error gives a friendly message, never the raw error', blErr.status === 500 && blErr.body.error === 'board_lists_unavailable' && !/permission|SQLSTATE|relation/i.test(JSON.stringify(blErr.body)));

    check('no real email: every send went to the in-memory fake', sent.length === 6 && sent.every((m) => m.from));
  } finally { await new Promise((r) => srv.close(r)); }
}

main().then(() => { console.log(`\n${pass} passed, ${fail} failed`); process.exitCode = fail ? 1 : 0; })
  .catch((e) => { console.error(e.stack); process.exit(1); });
