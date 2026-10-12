// ============================================================================
// api/mission_control.js — Mission Control (mounted at /api/mission-control)
// ----------------------------------------------------------------------------
// One place to see what is holding work up. It is a VIEW over the authoritative
// systems plus the existing work-item ledger, not a second task system:
//   GET  /?workspace=operations|platform|mine[&refresh=1]
//        operations : any active staff (Kat's runs, the close checklist, budget
//                     decisions, balance-sheet decisions, operations work items)
//        platform   : admin only (module registry + evidence, platform work items)
//        mine       : admin only, only what needs the viewer's own action
//   POST /items                 create a work item (operations: staff; platform: admin)
//   PATCH /items/:id            edit status / owner / horizon / due / dependencies
//   GET  /items/:id/events      audit trail
//   POST /decide                record the decision on a derived decision item (owner)
// upsertAgentTask(opts): agents (Kat, Emma, Amanda, engineering) create or update
// THE task for an issue, keyed by a stable source_ref, never a duplicate.
// No polling and no AI: everything is read when the page is opened or refreshed.
// ============================================================================
'use strict';

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { safeErrorMessage } = require('./_safe_error');
const { requireStaff, requireAdmin, requireOwner, getAuthedUser } = require('./_require_admin');
const G = require('../lib/mission_control/graph');
const OPS = require('../lib/mission_control/operations');
const MODS = require('../lib/mission_control/modules');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const router = express.Router();

// Small TTL cache for the expensive reads (budget model, balance sheet, evidence checks).
const TTL = 10 * 60 * 1000;
const store = new Map();
const cache = { get: (k) => { const v = store.get(k); if (!v || v.exp < Date.now()) { store.delete(k); return undefined; } return v.val; }, set: (k, val) => store.set(k, { val, exp: Date.now() + TTL }), clear: () => store.clear() };

const OPEN = ['new', 'in_progress', 'waiting'];
const KINDS = ['capability', 'feature', 'bug', 'improvement', 'task'];
const ALLOWED = ['title', 'summary', 'why', 'next_step', 'evidence_required', 'assigned_to', 'requested_by', 'status', 'urgency', 'sla_due_at', 'blocks', 'action_url', 'module_key', 'horizon', 'links', 'item_type', 'community_id', 'community_name', 'notes'];

// Names a viewer answers to in "owner" fields (the owner account is "Ed").
function ownerNames(u) {
  const first = String((u && u.full_name) || '').split(/\s+/)[0];
  const names = new Set([first, u && u.full_name].filter(Boolean));
  if (u && u.role === 'admin' && String(u.email || '').toLowerCase() === (process.env.OWNER_EMAIL || 'egojara@bedrocktx.com').toLowerCase()) names.add('Ed');
  return names;
}

async function columnsReady() {
  const { error } = await supabase.from('work_items').select('workspace, horizon, links').limit(1);
  return !error;
}

async function logEvent(work_item_id, event, actor, detail = {}) {
  const { error } = await supabase.from('work_item_events').insert({ work_item_id, event, actor, detail });
  if (error) console.warn('[mission_control] event not recorded', JSON.stringify({ work_item_id, event, error: error.message }));
}

function platformNodes(rows) {
  return OPS.workItemNodes(rows, 'platform').map((n) => {
    const w = rows.find((r) => `wi:${r.id}` === n.key) || {};
    return { ...n, kind: 'task', platform_kind: w.item_type || 'task', horizon: w.horizon || null, links: Array.isArray(w.links) ? w.links : [] };
  });
}

// Attach GitHub state (snapshot) to a platform item's links; never changes priority or status.
function withGithub(nodes, snapshot) {
  for (const n of nodes) {
    n.links = (n.links || []).map((l) => {
      const num = Number(String(l.ref || '').replace(/^#/, ''));
      const s = l.kind === 'issue' ? snapshot.issues[num] : l.kind === 'pr' ? snapshot.pulls[num] : null;
      return s ? { ...l, url: l.url || s.url, github_state: s.state, github_title: s.title } : l;
    });
    const prs = n.links.filter((l) => l.kind === 'pr' && l.github_state);
    n.dev_status = prs.length ? (prs.every((l) => l.github_state === 'merged') ? 'merged' : prs.some((l) => l.github_state === 'open') ? 'pr open' : 'pr closed') : null;
  }
  return nodes;
}

router.get('/', async (req, res) => {
  try {
    const ws = String(req.query.workspace || 'operations');
    if (!['operations', 'platform', 'mine'].includes(ws)) return res.status(400).json({ error: 'workspace_invalid' });
    const u = ws === 'operations' ? await requireStaff(req, res) : await requireAdmin(req, res);
    if (!u) return;
    const refresh = req.query.refresh === '1' && u.role === 'admin';
    if (refresh) cache.clear();
    const now = new Date();
    const out = { workspace: ws, generated_at: now.toISOString(), viewer: { name: u.full_name, role: u.role }, migration_513: await columnsReady(), problems: [] };
    let nodes = [];
    if (ws === 'operations' || ws === 'mine') {
      const ops = await OPS.loadOperations(supabase, { now, cache, refresh, actor: u.full_name });
      nodes.push(...ops.nodes); out.problems.push(...ops.problems);
    }
    if (ws === 'platform' || ws === 'mine') {
      const wiR = await supabase.from('work_items').select('*').eq('workspace', 'platform').order('received_at', { ascending: false }).limit(500);
      const rows = wiR.error ? [] : wiR.data;
      if (wiR.error && out.migration_513) out.problems.push({ source: 'platform work items', message: wiR.error.message });
      const snap = MODS.loadSnapshot();
      const items = withGithub(platformNodes(rows), snap);
      const acc = await supabase.from('work_items').select('source_ref').like('source_ref', 'module:%:complete').eq('status', 'done').limit(200);
      const accepted = new Set((acc.data || []).map((r) => String(r.source_ref).split(':')[1]));
      const mods = await MODS.evaluateModules(supabase, { platformItems: items, cache, accepted });
      out.github = mods.snapshot; out.deployed_commit = mods.deployed_commit;
      if (ws === 'platform') out.modules = mods.modules;
      // Module nodes so platform items can block a module and show their impact.
      for (const m of mods.modules) nodes.push({ key: `module:${m.key}`, kind: 'module', workspace: 'platform', title: m.name, owner: m.owner, state: m.state === 'COMPLETE' ? 'done' : 'open', status_label: m.state, weight: 4, blocks: [] });
      nodes.push(...items.filter((n) => n.state !== 'done' || ws === 'platform'));
    }
    const g = G.buildGraph(nodes);
    let annotated = G.annotate(g, now);
    if (ws === 'mine') { const me = ownerNames(u); annotated = annotated.filter((n) => n.kind === 'task' && G.isOpen(n) && me.has(n.owner)); }
    out.nodes = annotated;
    out.dangling = g.dangling;
    res.json(out);
  } catch (err) {
    console.error('[mission_control] load failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

function clean(body) {
  const row = {};
  for (const k of ALLOWED) if (body[k] !== undefined) row[k] = body[k];
  if (row.title !== undefined) row.title = String(row.title || '').trim().slice(0, 300);
  if (row.blocks !== undefined && !Array.isArray(row.blocks)) row.blocks = String(row.blocks || '').split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
  if (row.links !== undefined && !Array.isArray(row.links)) row.links = [];
  if (row.links) row.links = row.links.filter((l) => l && ['issue', 'pr', 'deploy', 'doc'].includes(l.kind) && (l.ref || l.url)).map((l) => ({ kind: l.kind, ref: l.ref ? String(l.ref).slice(0, 60) : null, url: l.url && /^https:\/\//.test(l.url) ? String(l.url).slice(0, 500) : null }));
  if (row.horizon !== undefined && row.horizon !== null && !['now', 'next', 'later'].includes(row.horizon)) delete row.horizon;
  if (row.item_type && row.workspace === 'platform' && !KINDS.includes(row.item_type)) row.item_type = 'task';
  if (row.status !== undefined && !['new', 'in_progress', 'waiting', 'done', 'dismissed'].includes(row.status)) delete row.status;
  if (row.urgency !== undefined && !['critical', 'high', 'normal', 'low'].includes(row.urgency)) delete row.urgency;
  return row;
}

// Create, or (same open source_ref) update: the agent de-duplication rule.
async function upsertTask(opts, actor) {
  const workspace = opts.workspace === 'platform' ? 'platform' : 'operations';
  const row = { ...clean({ ...opts, workspace }), workspace };
  if (!row.title) throw Object.assign(new Error('title_required'), { status: 400 });
  if (opts.source_ref) {
    const { data: open, error } = await supabase.from('work_items').select('id').eq('source_ref', String(opts.source_ref)).in('status', OPEN).limit(1);
    if (error) throw error;
    if (open && open.length) {
      const patch = { ...row }; delete patch.status;
      const { error: ue } = await supabase.from('work_items').update(patch).eq('id', open[0].id);
      if (ue) throw ue;
      await logEvent(open[0].id, 'agent_touch', actor, { fields: Object.keys(patch) });
      return { id: open[0].id, created: false };
    }
  }
  const insert = { source_type: opts.source_type === 'agent' ? 'agent' : workspace === 'platform' ? 'platform' : 'manual', item_type: row.item_type || (workspace === 'platform' ? 'task' : 'task'),
    urgency: row.urgency || 'normal', status: 'new', created_by: actor, source_ref: opts.source_ref ? String(opts.source_ref).slice(0, 300) : null, ...row };
  const { data, error } = await supabase.from('work_items').insert(insert).select('id').single();
  if (error) {
    if (/ux_work_items_open_source_ref|duplicate key/i.test(error.message)) return upsertTask(opts, actor);   // raced another writer: update it
    throw error;
  }
  await logEvent(data.id, 'created', actor, { workspace, source_ref: insert.source_ref });
  return { id: data.id, created: true };
}

// For agents: never throws; returns { id, created } or null (logged).
async function upsertAgentTask(opts) {
  try {
    if (!opts || !opts.source_ref) throw new Error('an agent task needs a stable source_ref');
    return await upsertTask({ ...opts, source_type: 'agent' }, opts.requested_by || 'agent');
  } catch (e) { console.warn('[mission_control] agent task not recorded', JSON.stringify({ source_ref: opts && opts.source_ref, error: e.message })); return null; }
}

router.post('/items', express.json({ limit: '32kb' }), async (req, res) => {
  try {
    const body = req.body || {};
    const u = body.workspace === 'platform' ? await requireAdmin(req, res) : await requireStaff(req, res);
    if (!u) return;
    if (!(await columnsReady())) return res.status(409).json({ error: 'migration_513_required', detail: 'Mission Control tasks need migration 513 (Documents → Migration status). Nothing was saved.' });
    const r = await upsertTask(body, u.full_name || u.email);
    cache.clear();
    res.json(r);
  } catch (err) {
    console.error('[mission_control] create failed:', err.message);
    res.status(err.status || 500).json({ error: err.status ? err.message : safeErrorMessage(err) });
  }
});

router.patch('/items/:id', express.json({ limit: '32kb' }), async (req, res) => {
  try {
    const u = await requireStaff(req, res); if (!u) return;
    const { data: cur, error: ce } = await supabase.from('work_items').select('*').eq('id', req.params.id).maybeSingle();
    if (ce) throw ce;
    if (!cur) return res.status(404).json({ error: 'not_found' });
    if ((cur.workspace || 'operations') === 'platform' && u.role !== 'admin') return res.status(403).json({ error: 'admin_only' });
    const patch = clean(req.body || {});
    delete patch.workspace;
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'nothing_to_update' });
    const ready = await columnsReady();
    if (!ready) for (const k of ['why', 'next_step', 'evidence_required', 'requested_by', 'blocks', 'action_url', 'module_key', 'horizon', 'links']) delete patch[k];
    if (patch.status === 'done' && cur.status !== 'done') patch.completed_at = new Date().toISOString();
    if (patch.status && OPEN.includes(patch.status) && !OPEN.includes(cur.status)) patch.completed_at = null;
    const changed = Object.keys(patch).filter((k) => JSON.stringify(cur[k] ?? null) !== JSON.stringify(patch[k] ?? null));
    const { error } = await supabase.from('work_items').update(patch).eq('id', cur.id);
    if (error) throw error;
    if (ready) await logEvent(cur.id, patch.status && patch.status !== cur.status ? (OPEN.includes(patch.status) && !OPEN.includes(cur.status) ? 'reopened' : 'status_changed') : 'updated', u.full_name || u.email,
      { changed, from: Object.fromEntries(changed.map((k) => [k, cur[k] ?? null])), to: Object.fromEntries(changed.map((k) => [k, patch[k]])) });
    cache.clear();
    res.json({ updated: true, changed });
  } catch (err) {
    console.error('[mission_control] update failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

router.get('/items/:id/events', async (req, res) => {
  try {
    const u = await requireStaff(req, res); if (!u) return;
    const { data: cur } = await supabase.from('work_items').select('workspace').eq('id', req.params.id).maybeSingle();
    if (cur && cur.workspace === 'platform' && u.role !== 'admin') return res.status(403).json({ error: 'admin_only' });
    const { data, error } = await supabase.from('work_item_events').select('event, actor, detail, created_at').eq('work_item_id', req.params.id).order('created_at').limit(200);
    if (error) return res.json({ events: [], unavailable: true });
    res.json({ events: data });
  } catch (err) { res.status(500).json({ error: safeErrorMessage(err) }); }
});

// A derived decision with no system record (e.g. "no reserve projects in 2027"): the
// owner records it; the item then shows as decided, with who, when and the note.
router.post('/decide', express.json({ limit: '16kb' }), async (req, res) => {
  try {
    const u = await requireOwner(req, res); if (!u) return;
    const { key, title, note } = req.body || {};
    if (!key || !/^[a-z]+:[\w:.\-/]+$/i.test(String(key))) return res.status(400).json({ error: 'key_required' });
    if (!note || String(note).trim().length < 10) return res.status(400).json({ error: 'note_required', detail: 'Say what was decided (at least 10 characters).' });
    const ready = await columnsReady();
    const row = { source_type: 'manual', item_type: 'decision', urgency: 'normal', status: 'done', completed_at: new Date().toISOString(), title: String(title || key).slice(0, 300),
      notes: String(note).trim().slice(0, 2000), assigned_to: 'Ed', created_by: u.full_name || u.email, source_ref: String(key).slice(0, 300), ...(ready ? { workspace: 'operations', requested_by: 'Mission Control' } : {}) };
    const { data, error } = await supabase.from('work_items').insert(row).select('id').single();
    if (error) throw error;
    if (ready) await logEvent(data.id, 'closed_by_evidence', u.full_name || u.email, { decision: row.notes, key: row.source_ref });
    cache.clear();
    res.json({ recorded: true, id: data.id });
  } catch (err) {
    console.error('[mission_control] decide failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

module.exports = { router, upsertAgentTask, upsertTask, ownerNames, withGithub, _cache: cache };
