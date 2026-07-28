// ============================================================================
// api/operations.js  (Ed 2026-07-20)
// ----------------------------------------------------------------------------
// The Operations dashboard: community vendor/capital PROJECTS through their
// lifecycle (requested -> bid -> board -> contract -> work -> done) plus the
// action queue (approve scope / approve invoice / pay vendor). Answers the
// question a manager's inbox couldn't: "what's every project's stage, whose
// action is it waiting on, and for how long?" — so nothing sits 52 days like
// the Waterview soccer-field repair that motivated this.
//
// Owner-only during beta (like Communications); the API is the boundary. Widen
// to a manager role when it graduates.
// ============================================================================
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { safeErrorMessage } = require('./_safe_error');
const { requireAdmin } = require('./_require_admin');

const router = express.Router();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const BEDROCK_MGMT_CO_ID = '00000000-0000-0000-0000-000000000001';

router.use(async (req, res, next) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return; // 403 already sent
  req.admin = admin;
  next();
});

// The lifecycle, in order. Advancing moves to the next non-terminal stage.
const STAGE_ORDER = ['requested', 'bid_requested', 'bid_received', 'board_deciding', 'approved', 'contract_signed', 'work_started', 'work_complete', 'closed'];
const STAGE_LABEL = {
  requested: 'Requested', bid_requested: 'Bid requested', bid_received: 'Bid received',
  board_deciding: 'Board deciding', approved: 'Approved', contract_signed: 'Contract signed',
  work_started: 'Work started', work_complete: 'Work complete', closed: 'Closed',
  on_hold: 'On hold', cancelled: 'Cancelled',
};
const ACTION_LABEL = {
  request_bid: 'Request a bid', follow_up_bid: 'Follow up on bid', approve_scope: 'Approve scope',
  board_vote: 'Board vote needed', sign_contract: 'Sign contract', schedule_work: 'Schedule work',
  approve_invoice: 'Approve invoice', pay_vendor: 'Pay vendor', follow_up_vendor: 'Follow up with vendor',
  none: null,
};
// A sensible default action for a stage, when none is set explicitly.
const DEFAULT_ACTION = {
  requested: 'request_bid', bid_requested: 'follow_up_bid', bid_received: 'approve_scope',
  board_deciding: 'board_vote', approved: 'sign_contract', contract_signed: 'schedule_work',
  work_started: 'follow_up_vendor', work_complete: 'approve_invoice',
};
const OPEN_STAGES = ['requested', 'bid_requested', 'bid_received', 'board_deciding', 'approved', 'contract_signed', 'work_started', 'work_complete', 'on_hold'];

const daysSince = (ts) => { try { return Math.max(0, Math.floor((Date.now() - new Date(ts).getTime()) / 86400000)); } catch (_) { return null; } };

// Decorate a raw row with the computed fields the UI needs.
function decorate(p) {
  const dis = daysSince(p.stage_since);
  const action = (p.next_action && p.next_action !== 'none') ? p.next_action : (DEFAULT_ACTION[p.stage] || null);
  const isOpen = OPEN_STAGES.includes(p.stage);
  // "Waiting too long" — a soft SLA so stalls surface. Approvals/decisions are
  // the ones that quietly rot, so they get the tightest watch.
  const slaDays = { board_deciding: 7, bid_requested: 7, approved: 5, work_complete: 5, requested: 10 }[p.stage] || 14;
  return {
    ...p,
    stage_label: STAGE_LABEL[p.stage] || p.stage,
    days_in_stage: dis,
    next_action_effective: action,
    next_action_label: action ? ACTION_LABEL[action] : null,
    needs_action: isOpen && !!action,
    is_open: isOpen,
    stalled: isOpen && dis != null && dis >= slaDays,
    community_name: p.communities ? p.communities.name : (p.community_name || null),
    vendor_display: (p.vendors && p.vendors.name) || p.vendor_name || null,
  };
}

const SELECT = 'id, community_id, title, category, description, vendor_id, vendor_name, asset, stage, stage_since, next_action, next_action_note, next_action_owner, priority, estimated_cost_cents, approved_cost_cents, funding_source, target_date, started_at, completed_at, source, source_email_id, status_note, created_by, created_at, updated_at, communities:community_id(name), vendors:vendor_id(name)';

// GET / — the board. Filters: community_id, stage, category, view=attention|open|all, q.
router.get('/', async (req, res) => {
  try {
    const { community_id, stage, category, q } = req.query;
    const view = req.query.view || 'open';
    let query = supabase.from('vendor_projects').select(SELECT).order('stage_since', { ascending: true }).limit(1000);
    if (community_id) query = query.eq('community_id', community_id);
    if (stage) query = query.in('stage', String(stage).split(','));
    if (category) query = query.eq('category', category);
    if (q) query = query.or(`title.ilike.%${q}%,vendor_name.ilike.%${q}%,asset.ilike.%${q}%`);
    const { data, error } = await query;
    if (error) throw error;
    let rows = (data || []).map(decorate);
    if (view === 'attention') rows = rows.filter((r) => r.needs_action);
    else if (view === 'open') rows = rows.filter((r) => r.is_open);
    // Attention first, then stalled, then oldest-in-stage.
    rows.sort((a, b) => (b.needs_action - a.needs_action) || (b.stalled - a.stalled) || ((b.days_in_stage || 0) - (a.days_in_stage || 0)));
    // Attach the same board-accountability view staff+board both see (budget vs
    // live actual, health, milestones). Milestones batched; AP is per-project
    // (fine at current scale — revisit if a community runs dozens of live projects).
    try {
      const { boardProjectView } = require('../lib/projects/board_view');
      const todayISO = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
      const ids = rows.map((r) => r.id);
      const msByProj = {};
      if (ids.length) {
        const { data: ms } = await supabase.from('project_milestones').select('*').in('project_id', ids).order('sort_order', { ascending: true });
        for (const m of (ms || [])) (msByProj[m.project_id] = msByProj[m.project_id] || []).push(m);
      }
      for (const r of rows) { try { r.board = await boardProjectView(supabase, r, msByProj[r.id] || [], todayISO); } catch (_) {} }
    } catch (_) { /* board-view is additive; never break the list */ }
    res.json({ projects: rows });
  } catch (err) {
    console.error('[operations] list failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// GET /summary — header counts by stage + attention + pipeline value.
router.get('/summary', async (req, res) => {
  try {
    const { community_id } = req.query;
    let query = supabase.from('vendor_projects').select('stage, stage_since, next_action, estimated_cost_cents, approved_cost_cents').limit(2000);
    if (community_id) query = query.eq('community_id', community_id);
    const { data, error } = await query;
    if (error) throw error;
    const byStage = {}; let attention = 0, open = 0, stalledCt = 0, pipelineCents = 0;
    for (const p of (data || [])) {
      byStage[p.stage] = (byStage[p.stage] || 0) + 1;
      const dp = decorate(p);
      if (dp.is_open) { open += 1; pipelineCents += Number(p.approved_cost_cents || p.estimated_cost_cents || 0); }
      if (dp.needs_action) attention += 1;
      if (dp.stalled) stalledCt += 1;
    }
    res.json({ by_stage: byStage, attention, open, stalled: stalledCt, pipeline_cents: pipelineCents, total: (data || []).length });
  } catch (err) {
    console.error('[operations] summary failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// GET /year?community_id=&year=YYYY — the annual project roadmap for staff:
// active projects (dates + health) + expected projects from the reserve study.
// Same compute the board portal uses (lib/projects/board_view.js). Must be
// registered before '/:id' so 'year' isn't matched as an id.
router.get('/year', async (req, res) => {
  try {
    const communityId = req.query.community_id;
    if (!communityId) return res.status(400).json({ error: 'community_id_required' });
    const year = parseInt(req.query.year, 10) || new Date().getFullYear();
    const { data: community } = await supabase.from('communities').select('id, name').eq('id', communityId).maybeSingle();
    const { data: projects, error: pErr } = await supabase.from('vendor_projects')
      .select('*').eq('community_id', communityId).neq('stage', 'cancelled').order('target_date', { ascending: true }).limit(500);
    if (pErr) throw pErr;
    const ids = (projects || []).map((p) => p.id);
    const byProj = {};
    if (ids.length) {
      const { data: ms } = await supabase.from('project_milestones').select('*').in('project_id', ids).order('sort_order', { ascending: true });
      for (const m of (ms || [])) (byProj[m.project_id] = byProj[m.project_id] || []).push(m);
    }
    const { boardProjectView } = require('../lib/projects/board_view');
    const todayISO = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
    const active = [];
    for (const p of (projects || [])) active.push(await boardProjectView(supabase, p, byProj[p.id] || [], todayISO));
    let planned = [];
    try {
      const { data: rc } = await supabase.from('reserve_components')
        .select('component_name, future_cost_estimate_cents, current_cost_estimate_cents, next_scheduled_replacement_year')
        .eq('community_id', communityId).eq('next_scheduled_replacement_year', year).order('component_name', { ascending: true }).limit(300);
      planned = (rc || []).map((r) => ({ name: r.component_name, cost_cents: (r.future_cost_estimate_cents != null ? r.future_cost_estimate_cents : r.current_cost_estimate_cents), year }));
    } catch (_) {}
    const sum = (a, k) => a.reduce((s, x) => s + (Number(x[k]) || 0), 0);
    res.json({ community: community || { id: communityId, name: '' }, year, active, planned, summary: { active: active.length, planned: planned.length, planned_cost_cents: sum(planned, 'cost_cents'), active_budget_cents: sum(active, 'budget_cents') } });
  } catch (err) {
    console.error('[operations] year failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// GET /communities — picker (management-company scoped, A-Z).
router.get('/communities', async (req, res) => {
  try {
    const { data, error } = await supabase.from('communities').select('id, name').eq('management_company_id', BEDROCK_MGMT_CO_ID).order('name');
    if (error) throw error;
    res.json({ communities: data || [] });
  } catch (err) { res.status(500).json({ error: safeErrorMessage(err) }); }
});

// GET /:id — one project + its timeline.
router.get('/:id', async (req, res) => {
  try {
    const { data, error } = await supabase.from('vendor_projects').select(SELECT).eq('id', req.params.id).maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'not_found' });
    const { data: events } = await supabase.from('vendor_project_events').select('*').eq('project_id', req.params.id).order('created_at', { ascending: false }).limit(200);
    res.json({ project: decorate(data), events: events || [] });
  } catch (err) {
    console.error('[operations] get failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

const CREATE_FIELDS = ['title', 'category', 'description', 'vendor_id', 'vendor_name', 'asset', 'stage', 'next_action', 'next_action_note', 'next_action_owner', 'priority', 'estimated_cost_cents', 'approved_cost_cents', 'funding_source', 'target_date', 'source', 'source_email_id', 'status_note'];

// POST / — create a project.
router.post('/', express.json(), async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.community_id) return res.status(400).json({ error: 'community_required' });
    if (!b.title || !String(b.title).trim()) return res.status(400).json({ error: 'title_required' });
    const { data: comm } = await supabase.from('communities').select('name, management_company_id').eq('id', b.community_id).maybeSingle();
    if (!comm) return res.status(400).json({ error: 'unknown_community' });
    const row = { management_company_id: comm.management_company_id || BEDROCK_MGMT_CO_ID, community_id: b.community_id, created_by: b.created_by || 'staff' };
    for (const k of CREATE_FIELDS) if (k in b) row[k] = b[k];
    if (!row.stage) row.stage = 'requested';
    row.stage_since = new Date().toISOString();
    const { data, error } = await supabase.from('vendor_projects').insert(row).select(SELECT).single();
    if (error) throw error;
    await supabase.from('vendor_project_events').insert({ project_id: data.id, community_id: data.community_id, event_type: 'created', to_stage: data.stage, note: `Project created (${STAGE_LABEL[data.stage] || data.stage})`, by_user: b.created_by || 'staff' });
    res.json({ project: decorate(data) });
  } catch (err) {
    console.error('[operations] create failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

const PATCH_FIELDS = ['title', 'category', 'description', 'vendor_id', 'vendor_name', 'asset', 'stage', 'next_action', 'next_action_note', 'next_action_owner', 'priority', 'estimated_cost_cents', 'approved_cost_cents', 'funding_source', 'target_date', 'started_at', 'completed_at', 'status_note', 'percent_complete'];

// PATCH /:id — update fields. A stage change resets the days-waiting clock and
// writes a timeline event; a note/status writes one too.
router.patch('/:id', express.json(), async (req, res) => {
  try {
    const b = req.body || {};
    const { data: cur, error: curErr } = await supabase.from('vendor_projects').select('id, community_id, stage, status_note, next_action').eq('id', req.params.id).maybeSingle();
    if (curErr) throw curErr;
    if (!cur) return res.status(404).json({ error: 'not_found' });
    const patch = {};
    for (const k of PATCH_FIELDS) if (k in b) patch[k] = b[k];
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'nothing_to_update' });
    const stageChanged = 'stage' in patch && patch.stage !== cur.stage;
    if (stageChanged) {
      patch.stage_since = new Date().toISOString();
      if (patch.stage === 'work_started' && !('started_at' in patch)) patch.started_at = new Date().toISOString().slice(0, 10);
      if ((patch.stage === 'work_complete' || patch.stage === 'closed') && !('completed_at' in patch)) patch.completed_at = new Date().toISOString().slice(0, 10);
    }
    const { data, error } = await supabase.from('vendor_projects').update(patch).eq('id', req.params.id).select(SELECT).single();
    if (error) throw error;
    const who = b.by_user || 'staff';
    if (stageChanged) await supabase.from('vendor_project_events').insert({ project_id: cur.id, community_id: cur.community_id, event_type: 'stage_change', from_stage: cur.stage, to_stage: patch.stage, note: b.note || `Moved to ${STAGE_LABEL[patch.stage] || patch.stage}`, by_user: who });
    else if (b.note) await supabase.from('vendor_project_events').insert({ project_id: cur.id, community_id: cur.community_id, event_type: 'note', note: b.note, by_user: who });
    res.json({ project: decorate(data) });
  } catch (err) {
    console.error('[operations] patch failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// POST /:id/advance — move to the next lifecycle stage in one click.
router.post('/:id/advance', express.json(), async (req, res) => {
  try {
    const { data: cur } = await supabase.from('vendor_projects').select('id, community_id, stage').eq('id', req.params.id).maybeSingle();
    if (!cur) return res.status(404).json({ error: 'not_found' });
    const i = STAGE_ORDER.indexOf(cur.stage);
    if (i < 0 || i >= STAGE_ORDER.length - 1) return res.status(400).json({ error: 'cannot_advance', detail: 'This project is already at the end of the lifecycle.' });
    const next = STAGE_ORDER[i + 1];
    const patch = { stage: next, stage_since: new Date().toISOString(), next_action: DEFAULT_ACTION[next] || 'none' };
    if (next === 'work_started') patch.started_at = new Date().toISOString().slice(0, 10);
    if (next === 'work_complete' || next === 'closed') patch.completed_at = new Date().toISOString().slice(0, 10);
    const { data, error } = await supabase.from('vendor_projects').update(patch).eq('id', cur.id).select(SELECT).single();
    if (error) throw error;
    await supabase.from('vendor_project_events').insert({ project_id: cur.id, community_id: cur.community_id, event_type: 'stage_change', from_stage: cur.stage, to_stage: next, note: `Advanced to ${STAGE_LABEL[next] || next}`, by_user: (req.body || {}).by_user || 'staff' });
    res.json({ project: decorate(data) });
  } catch (err) {
    console.error('[operations] advance failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// POST /:id/events — add a note to the timeline.
router.post('/:id/events', express.json(), async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.note || !String(b.note).trim()) return res.status(400).json({ error: 'note_required' });
    const { data: cur } = await supabase.from('vendor_projects').select('id, community_id').eq('id', req.params.id).maybeSingle();
    if (!cur) return res.status(404).json({ error: 'not_found' });
    const { data, error } = await supabase.from('vendor_project_events').insert({ project_id: cur.id, community_id: cur.community_id, event_type: 'note', note: String(b.note), by_user: b.by_user || 'staff' }).select('*').single();
    if (error) throw error;
    // Mirror the latest note onto the project so the card shows it at a glance.
    await supabase.from('vendor_projects').update({ status_note: String(b.note).slice(0, 400) }).eq('id', cur.id);
    res.json({ event: data });
  } catch (err) {
    console.error('[operations] event failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ---- Milestones (deadlines with an owner + status) -------------------------
// GET /:id/milestones — list for one project.
router.get('/:id/milestones', async (req, res) => {
  try {
    const { data, error } = await supabase.from('project_milestones')
      .select('*').eq('project_id', req.params.id).order('sort_order', { ascending: true }).limit(500);
    if (error) throw error;
    res.json({ milestones: data || [] });
  } catch (err) { console.error('[operations] milestones list failed:', err.message); res.status(500).json({ error: safeErrorMessage(err) }); }
});

// POST /:id/milestones — add one.
router.post('/:id/milestones', express.json(), async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.title || !String(b.title).trim()) return res.status(400).json({ error: 'title_required' });
    const { data: proj } = await supabase.from('vendor_projects').select('id').eq('id', req.params.id).maybeSingle();
    if (!proj) return res.status(404).json({ error: 'not_found' });
    const row = {
      project_id: req.params.id, title: String(b.title).slice(0, 300),
      due_date: b.due_date || null, owner: b.owner ? String(b.owner).slice(0, 120) : null,
      status: ['pending', 'in_progress', 'done', 'blocked'].includes(b.status) ? b.status : 'pending',
      sort_order: Number.isInteger(b.sort_order) ? b.sort_order : 0,
    };
    const { data, error } = await supabase.from('project_milestones').insert(row).select('*').single();
    if (error) throw error;
    res.json({ milestone: data });
  } catch (err) { console.error('[operations] milestone add failed:', err.message); res.status(500).json({ error: safeErrorMessage(err) }); }
});

// PATCH /milestones/:mid — update status/date/owner/title/sort.
router.patch('/milestones/:mid', express.json(), async (req, res) => {
  try {
    const b = req.body || {};
    const patch = {};
    for (const k of ['title', 'due_date', 'owner', 'sort_order']) if (k in b) patch[k] = b[k];
    if ('status' in b) {
      if (!['pending', 'in_progress', 'done', 'blocked'].includes(b.status)) return res.status(400).json({ error: 'bad_status' });
      patch.status = b.status;
      patch.completed_at = b.status === 'done' ? new Date().toISOString() : null;
    }
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'nothing_to_update' });
    const { data, error } = await supabase.from('project_milestones').update(patch).eq('id', req.params.mid).select('*').single();
    if (error) throw error;
    res.json({ milestone: data });
  } catch (err) { console.error('[operations] milestone patch failed:', err.message); res.status(500).json({ error: safeErrorMessage(err) }); }
});

// DELETE /milestones/:mid
router.delete('/milestones/:mid', async (req, res) => {
  try {
    const { error } = await supabase.from('project_milestones').delete().eq('id', req.params.mid);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) { console.error('[operations] milestone delete failed:', err.message); res.status(500).json({ error: safeErrorMessage(err) }); }
});

// GET /:id/board-view — the same computed board card (budget/actual/health) staff see.
router.get('/:id/board-view', async (req, res) => {
  try {
    const { data: p, error } = await supabase.from('vendor_projects').select('*').eq('id', req.params.id).maybeSingle();
    if (error) throw error;
    if (!p) return res.status(404).json({ error: 'not_found' });
    const { data: ms } = await supabase.from('project_milestones').select('*').eq('project_id', p.id).order('sort_order', { ascending: true });
    const { boardProjectView } = require('../lib/projects/board_view');
    const todayISO = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
    res.json({ view: await boardProjectView(supabase, p, ms || [], todayISO) });
  } catch (err) { console.error('[operations] board-view failed:', err.message); res.status(500).json({ error: safeErrorMessage(err) }); }
});

module.exports = router;
