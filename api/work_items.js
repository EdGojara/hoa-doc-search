// ============================================================================
// api/work_items.js — the operational work-item ledger + Status board API
// ----------------------------------------------------------------------------
// Mounted at /api/work-items. Backs the team Status page. Every tracked thing
// (scanned mail, inbound email, project/task) is a work_items row with owner,
// status, and an SLA due-date from the Operations Standard matrix (lib/ops/sla).
//
//   createWorkItem(opts)            helper other modules call (Mail Scan, etc.)
//   GET    /                        list/filter (status, owner, community, overdue)
//   GET    /summary                 board header counts (open, overdue, by owner)
//   POST   /                        manual create (project/task)
//   PATCH  /:id                     update status / owner / due (done -> stamps completed_at)
// ============================================================================

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { safeErrorMessage } = require('./_safe_error');
const { slaDueAt, defaultRoute, resolveUrgency } = require('../lib/ops/sla');
const { excludeDemo } = require('../lib/demo/demo_guard');
const { requireStaff } = require('./_require_admin');
// Platform Buildout items (workspace 'platform', migration 513) are engineering
// records: admin only, even through this legacy board (Issue #7 authorization).
const visibleTo = (u) => (r) => u.role === 'admin' || (r.workspace || 'operations') !== 'platform';
async function auditEvent(work_item_id, event, actor, detail) {
  const { error } = await supabase.from('work_item_events').insert({ work_item_id, event, actor, detail });
  if (error && !/work_item_events|does not exist|schema cache/i.test(error.message)) console.warn('[work_items] audit event not recorded', JSON.stringify({ work_item_id, error: error.message }));
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const router = express.Router();

// ---------------------------------------------------------------------------
// Helper other modules import to drop an item onto the board. SAFE: never
// throws (returns null) so a caller like Mail Scan /log doesn't fail if the
// work_items table isn't there yet (migration 256 pending).
// ---------------------------------------------------------------------------
async function createWorkItem(opts = {}) {
  try {
    const receivedAt = opts.received_at || new Date().toISOString();
    const route = defaultRoute(opts.item_type || opts.title || '');
    const urgency = resolveUrgency(opts.urgency, opts.item_type || opts.title || '');
    const row = {
      community_id: opts.community_id || null,
      community_name: opts.community_name || null,
      source_type: opts.source_type || 'manual',
      item_type: opts.item_type || route.item_type,
      urgency,
      title: (opts.title || 'Untitled item').slice(0, 300),
      summary: opts.summary || null,
      assigned_to: opts.assigned_to || route.owner,
      status: opts.status || 'new',
      received_at: receivedAt,
      sla_due_at: opts.sla_due_at || slaDueAt(receivedAt, urgency),
      library_document_id: opts.library_document_id || null,
      interaction_id: opts.interaction_id || null,
      source_ref: opts.source_ref || null,
      notes: opts.notes || null,
      created_by: opts.created_by || 'system',
    };
    const { data, error } = await supabase.from('work_items').insert(row).select('id').single();
    if (error) { console.warn('[work_items] createWorkItem failed:', error.message); return null; }
    return data.id;
  } catch (e) { console.warn('[work_items] createWorkItem exception:', e.message); return null; }
}

const OPEN_STATUSES = ['new', 'in_progress', 'waiting'];
const URGENCY_RANK = { critical: 3, high: 2, normal: 1, low: 0 };

function decorate(rows) {
  const now = Date.now();
  return (rows || []).map((r) => {
    const open = OPEN_STATUSES.includes(r.status);
    const overdue = open && r.sla_due_at && new Date(r.sla_due_at).getTime() < now;
    return { ...r, is_open: open, is_overdue: overdue };
  }).sort((a, b) => {
    if (a.is_overdue !== b.is_overdue) return a.is_overdue ? -1 : 1;
    const u = (URGENCY_RANK[b.urgency] || 0) - (URGENCY_RANK[a.urgency] || 0);
    if (u) return u;
    return new Date(a.sla_due_at || 0) - new Date(b.sla_due_at || 0);
  });
}

// GET / — the board
router.get('/', async (req, res) => {
  try {
    const u = await requireStaff(req, res); if (!u) return;
    const { status, assigned_to, community_id, source_type, overdue, limit } = req.query;
    const lim = Math.min(parseInt(limit, 10) || 300, 1000);
    let q = supabase.from('work_items').select('*, communities(name)').order('sla_due_at', { ascending: true, nullsFirst: false }).limit(lim);
    if (community_id) q = q.eq('community_id', community_id);   // explicit community view (staff may open a demo org)
    else q = await excludeDemo(q, 'community_id');              // default board excludes the demo tenant
    if (assigned_to) q = q.eq('assigned_to', assigned_to);
    if (source_type) q = q.eq('source_type', source_type);
    if (status === 'open') q = q.in('status', OPEN_STATUSES);
    else if (status) q = q.eq('status', status);
    const { data, error } = await q;
    if (error) throw error;
    let items = decorate((data || []).filter(visibleTo(u)));
    if (overdue === '1' || overdue === 'true') items = items.filter((i) => i.is_overdue);
    res.json({ items, count: items.length });
  } catch (err) {
    console.error('[work_items] list failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// GET /summary — board header counts
router.get('/summary', async (req, res) => {
  try {
    const u = await requireStaff(req, res); if (!u) return;
    let sq = supabase.from('work_items').select('*').limit(5000);
    sq = await excludeDemo(sq, 'community_id');   // portfolio counts never include the demo tenant
    const { data, error } = await sq;
    if (error) throw error;
    const now = Date.now();
    const open = (data || []).filter(visibleTo(u)).filter((r) => OPEN_STATUSES.includes(r.status));
    const overdue = open.filter((r) => r.sla_due_at && new Date(r.sla_due_at).getTime() < now);
    const byOwner = {};
    for (const r of open) {
      const k = r.assigned_to || 'Unassigned';
      if (!byOwner[k]) byOwner[k] = { open: 0, overdue: 0 };
      byOwner[k].open += 1;
      if (r.sla_due_at && new Date(r.sla_due_at).getTime() < now) byOwner[k].overdue += 1;
    }
    res.json({
      open: open.length, overdue: overdue.length,
      critical_open: open.filter((r) => r.urgency === 'critical').length,
      by_owner: byOwner,   // { owner: { open, overdue } }
    });
  } catch (err) {
    console.error('[work_items] summary failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// POST / — manual create (a project or task)
router.post('/', express.json({ limit: '32kb' }), async (req, res) => {
  try {
    const u = await requireStaff(req, res); if (!u) return;
    const b = req.body || {};
    if (!b.title) return res.status(400).json({ error: 'title_required' });
    const id = await createWorkItem({ ...b, source_type: b.source_type || 'project', created_by: u.full_name || u.email || 'staff' });
    if (!id) return res.status(500).json({ error: 'create_failed' });
    const { data } = await supabase.from('work_items').select('*').eq('id', id).single();
    res.json({ item: data });
  } catch (err) {
    console.error('[work_items] create failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// PATCH /:id — update status / owner / due
router.patch('/:id', express.json({ limit: '32kb' }), async (req, res) => {
  try {
    const u = await requireStaff(req, res); if (!u) return;
    const { data: cur, error: ce } = await supabase.from('work_items').select('*').eq('id', req.params.id).maybeSingle();
    if (ce) throw ce;
    if (!cur) return res.status(404).json({ error: 'not_found' });
    if (!visibleTo(u)(cur)) return res.status(403).json({ error: 'admin_only' });
    // A drafted-email task follows its draft's owner rule (lib/email/draft_access).
    const ta = await require('../lib/email/compose_drafts').taskAccess(u, cur.source_ref);
    if (ta && !ta.allowed) return res.status(ta.status).json({ error: ta.error, detail: ta.detail });
    const allowed = ['status', 'assigned_to', 'urgency', 'item_type', 'title', 'summary', 'notes', 'sla_due_at', 'completed_at', 'community_id'];
    const patch = {};
    for (const k of allowed) if (k in (req.body || {})) patch[k] = req.body[k];
    if (patch.status === 'done' && !('completed_at' in patch)) patch.completed_at = new Date().toISOString();
    if (patch.status && patch.status !== 'done') patch.completed_at = null;
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'no_fields_to_update' });
    const { data, error } = await supabase.from('work_items').update(patch).eq('id', req.params.id).select('*').single();
    if (error) throw error;
    if (patch.status && patch.status !== cur.status) await auditEvent(cur.id, OPEN_STATUSES.includes(patch.status) && !OPEN_STATUSES.includes(cur.status) ? 'reopened' : 'status_changed', u.full_name || u.email, { from: cur.status, to: patch.status, via: 'team status board' });
    res.json({ item: data });
  } catch (err) {
    console.error('[work_items] patch failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

module.exports = { router, createWorkItem };
