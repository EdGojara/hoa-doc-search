// New Email compose: drafts stay on the creating agent's to-do list until
// resolved, attachments survive and go out with the email, and To/Cc
// autocomplete is scoped and bounded. Acceptance test from Ed (2026-10-16), run
// for Claire and for Amanda. No network and NO REAL EMAIL: Supabase, storage,
// the auth gate, the proofreader and Graph sendAs are in-memory fakes.
'use strict';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://fake.local';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'fake';
delete process.env.ANTHROPIC_API_KEY;
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'sk-test-not-used';   // clients are constructed at load; never called here

let pass = 0, fail = 0;
const check = (name, ok, info) => { if (ok) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name + (info ? ' :: ' + info : '')); } };

// ---- in-memory Supabase ---------------------------------------------------------
const CG = 'a0000000-0000-4000-8000-000000000003';
const EAGLE = 'a0000000-0000-4000-8000-0000000000e1';
const DEMO = 'a0000000-0000-4000-8000-0000000000d1';
const now0 = Date.parse('2026-10-16T12:00:00Z');
let clock = 0; const ts = () => new Date(now0 + (++clock) * 1000).toISOString();
let seq = 0; const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;
const db = {
  no532: false,
  communities: [
    { id: CG, name: 'Canyon Gate at Cinco Ranch', management_status: 'active', is_demo: false },
    { id: EAGLE, name: 'Eaglewood', management_status: 'archived', is_demo: false },
    { id: DEMO, name: 'Drama Creek', management_status: 'active', is_demo: true },
  ],
  board_members: [
    { name: 'Hugh Durlam', email: 'president@canyongateatcincoranch.com', position: 'President', community_id: CG, community_name: 'Canyon Gate at Cinco Ranch', is_active: true },
    { name: 'Maria Celestine', email: 'treasurer@canyongateatcincoranch.com', position: 'Treasurer', community_id: CG, community_name: 'Canyon Gate at Cinco Ranch', is_active: true },
    { name: 'Hugh Eagle', email: 'hugh@eaglewood.example.org', position: 'President', community_id: EAGLE, community_name: 'Eaglewood', is_active: true },
    { name: 'Hugh Demo', email: 'hugh@dramacreekhoa.org', position: 'President', community_id: DEMO, community_name: 'Drama Creek', is_active: true },
  ],
  contacts: [
    { id: 'c-hugh', full_name: 'Hugh Durlam', primary_email: 'hughdurlam@yahoo.com', secondary_email: null },
    { id: 'c-old', full_name: 'Hughes Former', primary_email: 'former@x.com', secondary_email: null },
  ],
  properties: [{ id: 'p1', street_address: '1 Canyon Gate Dr', community_id: CG }, { id: 'p2', street_address: '9 Gone Ln', community_id: CG }],
  property_ownerships: [{ contact_id: 'c-hugh', property_id: 'p1', end_date: null }, { contact_id: 'c-old', property_id: 'p2', end_date: '2025-01-01' }],
  user_profiles: [{ full_name: 'Celina Ramos', email: 'celina@bedrocktx.com', role: 'staff', is_active: true }, { full_name: 'Ed Gojara', email: 'egojara@bedrocktx.com', role: 'admin', is_active: true }],
  vendors: [{ name: 'iTech Monitoring', dba: null, email: null, account_manager_email: 'accounting@itechmonitoring.com', category: 'security', status: 'active' },
    { name: 'Hugh Lawn Co', dba: null, email: 'mbravo@bedrocktx.com', account_manager_email: null, category: 'landscape', status: 'active' }],
  community_contacts: [],
  email_messages: [{ id: uuid(), direction: 'inbound', sender_name: 'Hugo Writer', sender_email: 'hugo@example.net', community_id: null, received_at: ts() }],
  outbound_email_drafts: [], work_items: [], work_item_events: [],
};
const COLS532 = { outbound_email_drafts: ['compose_state', 'work_item_id', 'sent_email_message_id'], email_messages: ['outbound_draft_id'] };
function parseOr(expr) {
  return expr.split(',').map((part) => {
    const m = part.match(/^([\w]+)\.(ilike|eq)\.(.*)$/); if (!m) throw new Error('bad or: ' + part);
    const [, col, op, val] = m;
    if (op === 'eq') return (r) => String(r[col]) === val;
    const re = new RegExp('^' + val.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*') + '$', 'i');
    return (r) => r[col] != null && re.test(String(r[col]));
  });
}
function qb(table) {
  const st = { filters: [], op: 'select', patch: null, rows: null, single: false, maybe: false, select: '', limit: null, order: null };
  const rowsOf = () => (db[table] || []).filter((r) => st.filters.every((f) => f(r)));
  const q = {
    select(cols) { st.select = cols || '*'; if (st.op === 'select') st.op = 'select'; else st.returning = true; return q; },
    eq(k, v) { st.filters.push((r) => r[k] === v); return q; }, neq(k, v) { st.filters.push((r) => r[k] !== v); return q; },
    in(k, v) { st.filters.push((r) => v.includes(r[k])); return q; }, is(k, v) { st.filters.push((r) => (r[k] ?? null) === v); return q; },
    not(k, op, v) { st.filters.push((r) => !((r[k] ?? null) === v)); return q; },
    ilike(k, v) { const re = new RegExp('^' + v.replace(/%/g, '.*') + '$', 'i'); st.filters.push((r) => re.test(String(r[k] || ''))); return q; },
    like(k, v) { const re = new RegExp('^' + v.replace(/%/g, '.*') + '$'); st.filters.push((r) => re.test(String(r[k] || ''))); return q; },
    or(expr) { const fs = parseOr(expr); st.filters.push((r) => fs.some((f) => f(r))); return q; },
    order(k, o) { st.order = { k, asc: !(o && o.ascending === false) }; return q; }, limit(n) { st.limit = n; return q; }, range() { return q; },
    insert(row) { st.op = 'insert'; st.rows = Array.isArray(row) ? row : [row]; return q; },
    update(patch) { st.op = 'update'; st.patch = patch; return q; },
    single() { st.single = true; return q; }, maybeSingle() { st.maybe = true; return q; },
    then(res, rej) { return Promise.resolve(run()).then(res, rej); },
  };
  const missing = (obj) => db.no532 && (COLS532[table] || []).some((c) => obj && Object.prototype.hasOwnProperty.call(obj, c));
  const shape = (r) => {
    let o = { ...r };
    if (db.no532) for (const c of COLS532[table] || []) delete o[c];
    if (table === 'property_ownerships' && /properties:property_id/.test(st.select)) o.properties = db.properties.find((p) => p.id === r.property_id) || null;
    return JSON.parse(JSON.stringify(o));
  };
  const out = (rows) => { const c = rows.map(shape); return { data: st.single || st.maybe ? (c[0] || null) : c, error: null }; };
  function run() {
    if (st.op === 'insert') {
      if (st.rows.some(missing)) return { data: null, error: { code: '42703', message: `column of ${table} does not exist` } };
      const made = [];
      for (const r of st.rows) {
        if (table === 'work_items' && r.source_ref && db.work_items.some((x) => x.source_ref === r.source_ref && ['new', 'in_progress', 'waiting'].includes(x.status)))
          return { data: null, error: { message: 'duplicate key value violates unique constraint "ux_work_items_open_source_ref"' } };
        const t = ts();
        const row = { id: uuid(), created_at: t, updated_at: t, ...(table === 'outbound_email_drafts' && !db.no532 ? { compose_state: null, work_item_id: null, sent_email_message_id: null } : {}), ...r };
        (db[table] = db[table] || []).push(row); made.push(row);
      }
      return out(made);
    }
    if (st.op === 'update') {
      if (missing(st.patch)) return { data: null, error: { code: '42703', message: `column of ${table} does not exist` } };
      const hit = rowsOf(); for (const r of hit) Object.assign(r, st.patch, { updated_at: ts() });
      return st.returning ? out(hit) : { data: null, error: null };
    }
    let rows = rowsOf();
    if (st.order) rows = rows.slice().sort((a, b) => (String(a[st.order.k]) < String(b[st.order.k]) ? -1 : 1) * (st.order.asc ? 1 : -1));
    if (st.limit != null) rows = rows.slice(0, st.limit);
    return out(rows);
  }
  return q;
}
const storage = new Map();
const fakeSb = {
  from: qb,
  auth: { getUser: async () => ({ data: { user: null }, error: null }) },
  storage: { from: (bucket) => ({
    upload: async (path, buf, opts) => { const k = bucket + '/' + path; if (storage.has(k) && !(opts && opts.upsert)) return { error: { message: 'exists' } }; storage.set(k, Buffer.from(buf)); return { data: { path }, error: null }; },
    download: async (path) => { const b = storage.get(bucket + '/' + path); return b ? { data: { arrayBuffer: async () => b }, error: null } : { data: null, error: { message: 'Object not found' } }; },
    remove: async (paths) => { for (const p of paths) storage.delete(bucket + '/' + p); return { data: [], error: null }; },
    createSignedUrl: async () => ({ data: { signedUrl: 'https://signed' }, error: null }),
  }) },
  rpc: async () => ({ data: null, error: null }),
};
const stub = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
stub('@supabase/supabase-js', { createClient: () => fakeSb });
const USERS = { owner: { role: 'admin', full_name: 'Ed Gojara', email: 'egojara@bedrocktx.com' }, staff: { role: 'staff', full_name: 'Martha Staff', email: 'martha@bedrocktx.com' } };
const who = (req) => USERS[req.headers['x-test-user']] || null;
stub('../api/_require_admin', {
  getAuthedUser: async (req) => who(req),
  requireStaff: async (req, res) => { const u = who(req); if (!u) { res.status(403).json({ error: 'sign_in_required' }); return null; } return u; },
  requireAdmin: async (req, res) => { const u = who(req); if (!u || u.role !== 'admin') { res.status(403).json({ error: 'admin_only' }); return null; } return u; },
  requireOwner: async (req, res) => { const u = who(req); if (!u || u.email !== 'egojara@bedrocktx.com') { res.status(403).json({ error: 'owner_only' }); return null; } return u; },
  OWNER_EMAIL: 'egojara@bedrocktx.com',
});
stub('../lib/email/proofread', { proofreadEmailBody: async (b) => ({ text: b, changed: false }) });
stub('../lib/demo/demo_guard', Object.assign({}, require('../lib/demo/demo_guard'), { demoCommunityIds: async () => [DEMO], isDemoCommunity: async (id) => id === DEMO }));

// Graph: the ONLY send path, replaced. Every "send" is recorded, nothing leaves.
const graphSend = require('../lib/email/graph_send');
const sent = [];
let sendMode = 'ok';
graphSend.isConfigured = () => true;
graphSend.sendAs = async (msg) => {
  if (sendMode === 'throw') throw Object.assign(new Error('Graph 503'), { userMessage: 'Microsoft did not accept the email.' });
  if (sendMode === 'suppress') return { sent: false, suppressed: true, reason: 'demo_recipient' };
  sent.push(JSON.parse(JSON.stringify(msg))); return { sent: true, from: msg.from, to: msg.to };
};
graphSend.sendReplyAs = async () => { throw new Error('not used'); };
graphSend.getToken = async () => { throw new Error('no network in tests'); };

const express = require('express');
const { router: triage } = require('../api/email_triage');
const draftsRouter = require('../api/email_drafts');
const CD = require('../lib/email/compose_drafts');
const RS = require('../lib/email/recipient_search');

async function main() {
  const app = express();
  app.use('/api/email-triage', triage);
  app.use('/api/email-drafts', express.json(), draftsRouter);
  const srv = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (method, url, user, body) => {
    const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(user ? { 'x-test-user': user } : {}) }, body: body ? JSON.stringify(body) : undefined });
    let j = null; try { j = await r.json(); } catch (_) {} return { status: r.status, body: j };
  };
  const upload = async (draftId, name, bytes, type, user = 'owner') => {
    const fd = new FormData(); fd.append('file', new Blob([bytes], { type }), name);
    const r = await fetch(`${base}/api/email-triage/compose/drafts/${draftId}/attachments`, { method: 'POST', headers: user ? { 'x-test-user': user } : {}, body: fd });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const tasksFor = (draftId) => db.work_items.filter((w) => w.source_ref === `compose_draft:${draftId}`);
  const PDF = Buffer.from('%PDF-1.4\n% Canyon Gate camera proposal\n%%EOF');

  try {
    console.log('access');
    check('signed-out callers get nothing: search, drafts, attachments, send', (await call('GET', '/api/email-triage/compose/recipients?q=hugh', null)).status === 403
      && (await call('POST', '/api/email-triage/compose/drafts', null, { subject: 'x' })).status === 403
      && (await upload('00000000-0000-4000-8000-000000000999', 'a.pdf', PDF, 'application/pdf', null)).status === 403
      && (await call('POST', '/api/email-triage/compose', null, { to: 'a@b.com', body: 'x' })).status === 403);
    check('a non-admin staff user is refused (Communications is owner-only in beta)', (await call('GET', '/api/email-triage/compose/recipients?q=hugh', 'staff')).status === 403);

    console.log('autocomplete');
    const s1 = (await call('GET', `/api/email-triage/compose/recipients?q=Hugh&community_id=${CG}`, 'owner')).body;
    const names = s1.results.map((r) => `${r.name}|${r.email}`);
    check('"Hugh" finds Hugh Durlam as board president and as homeowner, with role and community', s1.results[0].name === 'Hugh Durlam' && s1.results[0].community_name === 'Canyon Gate at Cinco Ranch'
      && names.includes('Hugh Durlam|president@canyongateatcincoranch.com') && names.includes('Hugh Durlam|hughdurlam@yahoo.com')
      && s1.results.some((r) => /Board President/.test(r.role)) && s1.results.some((r) => /Homeowner, 1 Canyon Gate Dr/.test(r.role)));
    check('archived and demo communities never appear (Eaglewood, Drama Creek)', !names.some((n) => /eaglewood|dramacreek/i.test(n)));
    check('a former owner (ownership ended) is not offered as a homeowner', !(await call('GET', '/api/email-triage/compose/recipients?q=Hughes', 'owner')).body.results.some((r) => r.email === 'former@x.com'));
    check('a staff address on a vendor record is never offered as the vendor', !s1.results.some((r) => r.email === 'mbravo@bedrocktx.com'));
    check('correspondents who have emailed us are searchable', (await call('GET', '/api/email-triage/compose/recipients?q=hugo', 'owner')).body.results.some((r) => r.email === 'hugo@example.net' && r.source === 'correspondent'));
    const sGlobal = (await call('GET', '/api/email-triage/compose/recipients?q=Hugh', 'owner')).body;
    check('with Community blank the search is global', sGlobal.results.some((r) => r.email === 'president@canyongateatcincoranch.com'));
    const sInj = await call('GET', '/api/email-triage/compose/recipients?q=' + encodeURIComponent('hugh),id.eq.x,(name.ilike.*'), 'owner');
    check('filter syntax in the query cannot change the search (sanitized)', sInj.status === 200 && Array.isArray(sInj.body.results));
    const sList = (await call('GET', '/api/email-triage/compose/recipients?q=canyon%20board', 'owner')).body;
    const bl = sList.results.find((r) => r.kind === 'list');
    check('"canyon board" offers the Canyon Gate board list with its addresses', bl && bl.label === 'Canyon Gate at Cinco Ranch Board' && bl.emails.length === 2);
    check('the AI team is searchable', (await call('GET', '/api/email-triage/compose/recipients?q=amanda', 'owner')).body.results.some((r) => r.email === 'amanda@bedrocktx.com' && r.source === 'agent'));
    check('one-letter queries return nothing (bounded)', (await call('GET', '/api/email-triage/compose/recipients?q=h', 'owner')).body.results.length === 0);
    check('an out-of-scope community id is ignored for ranking, never used to widen scope', (await call('GET', `/api/email-triage/compose/recipients?q=Hugh&community_id=${EAGLE}`, 'owner')).body.community_ignored === true);

    for (const persona of ['claire', 'amanda']) {
      const Agent = persona === 'claire' ? 'Claire' : 'Amanda';
      console.log(`acceptance flow: ${Agent}`);
      const hugh = s1.results.find((r) => r.email === 'president@canyongateatcincoranch.com');
      const cel = (await call('GET', `/api/email-triage/compose/recipients?q=Celes&community_id=${CG}`, 'owner')).body.results.find((r) => r.name === 'Maria Celestine');
      check('a partial name for Cc ("Celes") finds Maria Celestine', !!cel);
      const save1 = await call('POST', '/api/email-triage/compose/drafts', 'owner', { persona, community_id: CG, to: [hugh], cc: [cel, hugh], subject: `Camera proposal (${Agent})`, body: 'Hugh, the camera proposal is attached.' });
      const id = save1.body && save1.body.draft_id;
      check('saving the draft puts a task on the agent\'s list', save1.status === 200 && save1.body.task && save1.body.task.created === true && tasksFor(id).length === 1 && tasksFor(id)[0].assigned_to === Agent);
      const t0 = tasksFor(id)[0];
      check('the task shows recipient, subject and community, and links back to the draft', /Hugh Durlam/.test(t0.title) && t0.title.includes(`Camera proposal (${Agent})`) && /Community: Canyon Gate at Cinco Ranch/.test(t0.summary) && t0.action_url === `/admin/communications?compose_draft=${id}` && t0.community_id === CG);
      const d0 = db.outbound_email_drafts.find((d) => d.id === id);
      check('To and Cc never repeat an address (Hugh on both stays on To only)', d0.to_email === 'president@canyongateatcincoranch.com' && d0.cc === 'treasurer@canyongateatcincoranch.com');
      const up = await upload(id, 'CG camera proposal.pdf', PDF, 'application/pdf');
      check('a PDF attaches and is stored with the draft', up.status === 200 && up.body.attachments.length === 1 && storage.has('documents/' + up.body.attachment.storage_path) && up.body.attachment.storage_path.startsWith(`email_outbound_attachments/compose/${id}/`));
      const bad = await upload(id, 'run.exe', Buffer.from('MZ'), 'application/octet-stream');
      check('an unsupported file is refused with a reason, and nothing is stored', bad.status === 400 && /not a supported file type/.test(bad.body.detail) && [...storage.keys()].filter((k) => k.includes(id)).length === 1);
      const xls = await upload(id, 'budget.xlsx', Buffer.from('PK..'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      const rm = await call('DELETE', `/api/email-triage/compose/drafts/${id}/attachments`, 'owner', { storage_path: xls.body.attachment.storage_path });
      check('a second file can be removed before sending (bytes deleted too)', xls.status === 200 && rm.status === 200 && rm.body.attachments.length === 1 && !storage.has('documents/' + xls.body.attachment.storage_path));
      check('closing without sending sends nothing', sent.length === (persona === 'claire' ? 0 : 1));
      const re = (await call('GET', `/api/email-triage/compose/drafts/${id}`, 'owner')).body.draft;
      check('reopening restores recipients (with names), subject, community, attachments and body', re.to[0].name === 'Hugh Durlam' && re.cc[0].name === 'Maria Celestine' && re.subject === `Camera proposal (${Agent})`
        && re.community_id === CG && re.attachments.length === 1 && re.attachments[0].name === 'CG camera proposal.pdf' && re.body === 'Hugh, the camera proposal is attached.' && re.persona === persona);
      const save2 = await call('POST', '/api/email-triage/compose/drafts', 'owner', { draft_id: id, persona, community_id: CG, to: re.to, cc: re.cc, subject: re.subject, body: re.body + '\n\nThanks.' });
      check('reopening and saving again never creates a second task', save2.status === 200 && save2.body.task.created === false && tasksFor(id).length === 1 && tasksFor(id)[0].status === 'new');
      check('the task lists the attachment', /Attachments: CG camera proposal\.pdf/.test(tasksFor(id)[0].summary));
      const evBefore = db.work_item_events.length;
      await call('POST', '/api/email-triage/compose/drafts', 'owner', { draft_id: id, persona, community_id: CG, to: re.to, cc: re.cc, subject: re.subject, body: re.body + ' Thanks!' });
      check('an autosave that changes nothing on the task writes no audit event', db.work_item_events.length === evBefore);
      check('the draft is listed under Unsent drafts', (await call('GET', '/api/email-triage/compose/drafts', 'owner')).body.drafts.some((d) => d.id === id && d.attachment_count === 1));

      // Send.
      const before = sent.length;
      const s = await call('POST', '/api/email-triage/compose', 'owner', { draft_id: id, persona, community_id: CG, to: re.to, cc: re.cc, subject: re.subject, body: re.body + '\n\nThanks.' });
      const msg = sent[sent.length - 1];
      check('it sends exactly once, from the agent\'s mailbox, to the chosen recipients', s.status === 200 && s.body.sent && sent.length === before + 1
        && msg.from === (persona === 'claire' ? graphSend.CLAIRE_MAILBOX : graphSend.AMANDA_MAILBOX) && msg.to.join() === 'president@canyongateatcincoranch.com' && msg.cc.join() === 'treasurer@canyongateatcincoranch.com');
      const fileAtt = (msg.attachments || []).find((a) => a.name === 'CG camera proposal.pdf');
      check('the attachment goes out with the email, bytes intact', !!fileAtt && Buffer.from(fileAtt.contentBytes, 'base64').equals(PDF) && fileAtt.contentType === 'application/pdf');
      const dSent = db.outbound_email_drafts.find((d) => d.id === id);
      const em = db.email_messages.find((m) => m.id === s.body.email_message_id);
      check('the sent email links back to the draft, and the draft to the sent email', em && em.outbound_draft_id === id && dSent.sent_email_message_id === em.id && dSent.status === 'sent' && dSent.record_ownership === 'association_record');
      const tDone = tasksFor(id)[0];
      check('the task closes, with the sent email as evidence', s.body.task_closed === true && tDone.status === 'done' && db.work_item_events.some((e) => e.work_item_id === tDone.id && e.event === 'closed_by_evidence' && e.detail.email_message_id === em.id && e.detail.draft_id === id));
      const again = await call('POST', '/api/email-triage/compose', 'owner', { draft_id: id, persona, community_id: CG, to: re.to, subject: re.subject, body: 'again' });
      check('sending the same draft again is refused; still one email', again.status === 409 && sent.length === before + 1 && tasksFor(id).length === 1);
      check('a sent draft cannot be edited back open', (await call('POST', '/api/email-triage/compose/drafts', 'owner', { draft_id: id, persona, to: re.to, subject: 'x', body: 'y' })).status === 409);
    }

    console.log('failure paths');
    {
      const sv = await call('POST', '/api/email-triage/compose/drafts', 'owner', { persona: 'claire', to: ['hugo@example.net'], subject: 'Failure test', body: 'Body' });
      const id = sv.body.draft_id; const n = sent.length;
      await upload(id, 'photo.jpg', Buffer.from([0xff, 0xd8, 0xff]), 'image/jpeg');
      sendMode = 'throw';
      const f1 = await call('POST', '/api/email-triage/compose', 'owner', { draft_id: id, persona: 'claire', to: ['hugo@example.net'], subject: 'Failure test', body: 'Body' });
      check('a Graph failure keeps the draft and its task open, and says so', f1.status === 502 && /Nothing went out/.test(f1.body.detail) && db.outbound_email_drafts.find((d) => d.id === id).status === 'draft' && tasksFor(id)[0].status === 'new' && sent.length === n);
      sendMode = 'suppress';
      const f2 = await call('POST', '/api/email-triage/compose', 'owner', { draft_id: id, persona: 'claire', to: ['hugo@example.net'], subject: 'Failure test', body: 'Body' });
      check('a blocked (suppressed) send keeps the draft open, never marks it sent', f2.status === 409 && db.outbound_email_drafts.find((d) => d.id === id).status === 'draft' && tasksFor(id)[0].status === 'new');
      sendMode = 'ok';
      const att = db.outbound_email_drafts.find((d) => d.id === id).attachments[0];
      const saved = storage.get('documents/' + att.storage_path); storage.delete('documents/' + att.storage_path);
      const f3 = await call('POST', '/api/email-triage/compose', 'owner', { draft_id: id, persona: 'claire', to: ['hugo@example.net'], subject: 'Failure test', body: 'Body' });
      check('an attachment that cannot be read stops the send (never sent without it)', f3.status === 502 && /photo\.jpg/.test(f3.body.detail) && sent.length === n && db.outbound_email_drafts.find((d) => d.id === id).status === 'draft');
      storage.set('documents/' + att.storage_path, saved);
      check('an invalid address is reported, not dropped', (await call('POST', '/api/email-triage/compose/drafts', 'owner', { draft_id: id, persona: 'claire', to: ['hugo@example.net', 'not-an-email'], subject: 'x', body: 'y' })).body.detail.includes('not-an-email'));
      check('a community outside scope is refused', (await call('POST', '/api/email-triage/compose/drafts', 'owner', { draft_id: id, persona: 'claire', community_id: EAGLE, to: ['hugo@example.net'], subject: 'x', body: 'y' })).status === 400);
      check('an empty window does not create a draft', (await call('POST', '/api/email-triage/compose/drafts', 'owner', { persona: 'claire', to: [], subject: '', body: '' })).status === 400);

      // A person marks the task complete; the draft is edited again: same task reopens.
      const t = tasksFor(id)[0]; t.status = 'done';
      const r2 = await call('POST', '/api/email-triage/compose/drafts', 'owner', { draft_id: id, persona: 'claire', to: ['hugo@example.net'], subject: 'Failure test v2', body: 'Body' });
      check('editing a draft whose task was closed reopens that task (no duplicate)', r2.body.task.reopened === true && tasksFor(id).length === 1 && tasksFor(id)[0].status === 'in_progress' && db.work_item_events.some((e) => e.work_item_id === t.id && e.event === 'reopened'));
      const dis = await call('POST', `/api/email-triage/compose/drafts/${id}/discard`, 'owner', {});
      check('discarding the draft takes it off the list (task dismissed), nothing sent', dis.status === 200 && tasksFor(id)[0].status === 'dismissed' && db.outbound_email_drafts.find((d) => d.id === id).status === 'discarded' && sent.length === n);
    }

    console.log('double-click: two sends at the same moment');
    {
      const sv = await call('POST', '/api/email-triage/compose/drafts', 'owner', { persona: 'claire', to: ['hugo@example.net'], subject: 'Race', body: 'Body' });
      const id = sv.body.draft_id; const n = sent.length;
      const body = { draft_id: id, persona: 'claire', to: ['hugo@example.net'], subject: 'Race', body: 'Body' };
      const [a, b] = await Promise.all([call('POST', '/api/email-triage/compose', 'owner', body), call('POST', '/api/email-triage/compose', 'owner', body)]);
      check('exactly one of two simultaneous sends goes out; the other gets 409', sent.length === n + 1 && [a.status, b.status].sort().join() === '200,409');
      const sv2 = await call('POST', '/api/email-triage/compose/drafts', 'owner', { persona: 'claire', to: ['hugo@example.net'], subject: 'Claim', body: 'Body' });
      const claims = await Promise.all([CD.claimForSend(sv2.body.draft_id), CD.claimForSend(sv2.body.draft_id)]);
      check('the send claim is compare-and-set: only one of two claims wins', claims.filter(Boolean).length === 1);
    }

    console.log('draft queue send path (outbox) follows the same rules');
    {
      const sv = await call('POST', '/api/email-triage/compose/drafts', 'owner', { persona: 'amanda', community_id: CG, to: ['president@canyongateatcincoranch.com'], subject: 'From the outbox', body: 'Body' });
      const id = sv.body.draft_id; await upload(id, 'memo.docx', Buffer.from('PK'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      const n = sent.length;
      const r = await call('POST', `/api/email-drafts/${id}/send`, 'owner', { approved_by: 'owner' });
      const msg = sent[sent.length - 1];
      check('sending a compose draft from the Draft Queue sends once with its attachment and closes the task', r.status === 200 && sent.length === n + 1 && (msg.attachments || []).some((a) => a.name === 'memo.docx') && tasksFor(id)[0].status === 'done'
        && db.email_messages.some((m) => m.outbound_draft_id === id));
      check('a second Draft Queue send is refused', (await call('POST', `/api/email-drafts/${id}/send`, 'owner', {})).status === 409 && sent.length === n + 1);
    }

    console.log('before migration 532');
    {
      db.no532 = true;
      const sv = await call('POST', '/api/email-triage/compose/drafts', 'owner', { persona: 'claire', to: [{ email: 'hugo@example.net', name: 'Hugo Writer' }], subject: 'Pre-532', body: 'Body' });
      check('the draft and its task are still saved without the new columns', sv.status === 200 && tasksFor(sv.body.draft_id).length === 1);
      const re = (await call('GET', `/api/email-triage/compose/drafts/${sv.body.draft_id}`, 'owner')).body.draft;
      check('reopening falls back to the stored addresses', re.to[0].email === 'hugo@example.net');
      const n = sent.length;
      const s = await call('POST', '/api/email-triage/compose', 'owner', { draft_id: sv.body.draft_id, persona: 'claire', to: re.to, subject: 'Pre-532', body: 'Body' });
      check('it still sends once and closes the task', s.status === 200 && sent.length === n + 1 && tasksFor(sv.body.draft_id)[0].status === 'done');
      db.no532 = false;
    }

    console.log('every "Send as" choice sends as that teammate');
    {
      const sv = await call('POST', '/api/email-triage/compose/drafts', 'owner', { persona: 'isabella', to: ['hugo@example.net'], subject: 'Hola', body: 'Hola' });
      check('an Isabella draft is on Isabella’s list', tasksFor(sv.body.draft_id)[0].assigned_to === 'Isabella');
      const n = sent.length;
      const s = await call('POST', '/api/email-triage/compose', 'owner', { draft_id: sv.body.draft_id, persona: 'isabella', to: ['hugo@example.net'], subject: 'Hola', body: 'Hola' });
      check('and it sends from isabella@, not Claire', s.status === 200 && sent.length === n + 1 && sent[sent.length - 1].from === graphSend.ISABELLA_MAILBOX);
    }

    console.log('helpers');
    check('normalizeRecipients de-dupes case-insensitively and reports bad entries', (() => { const r = CD.normalizeRecipients(['A@x.com', 'a@X.com', 'bad', { email: 'b@y.com', name: 'B' }]); return r.list.length === 2 && r.invalid[0] === 'bad'; })());
    check('cleanQuery strips PostgREST syntax', RS.cleanQuery('a,b(c)*%d') === 'a b c d');
    check('attachment rules: PDF/Word/Excel/images only, 15 MB per file', CD.attachmentCheck('x.pdf', 10) === null && CD.attachmentCheck('x.docx', 10) === null && CD.attachmentCheck('x.xlsx', 10) === null && CD.attachmentCheck('x.png', 10) === null
      && /not a supported/.test(CD.attachmentCheck('x.zip', 10)) && /15 MB/.test(CD.attachmentCheck('x.pdf', 16 * 1024 * 1024)));
    check('no real email was sent: every send went to the in-memory fake', sent.every((m) => m && m.from));
  } finally { await new Promise((r) => srv.close(r)); }
}

main().then(() => { console.log(`\n${pass} passed, ${fail} failed`); process.exitCode = fail ? 1 : 0; })
  .catch((e) => { console.error(e.stack); process.exit(1); });
