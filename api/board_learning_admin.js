// ============================================================================
// api/board_learning_admin.js  — staff review + editing for Board Learning.
// ----------------------------------------------------------------------------
// Mounted at /api/admin/board-learning. The board-facing read/tutor endpoints
// live in api/board_portal.js; this is the staff side: read every module (incl.
// unpublished), edit content, create modules, and publish/unpublish.
//
// No attorney-sign-off workflow (Ed 2026-08-25): firms won't blanket-review
// evolving content, so every board surface carries a standing disclaimer
// instead. Publishing simply means "boards can see it".
//
// Gate: requireStaff (any active staffer can prepare and manage this content).
// Record ownership: workpaper (Bedrock IP) — same as the modules themselves.
// ============================================================================
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { requireStaff } = require('./_require_admin');
const { safeErrorMessage } = require('./_safe_error');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const router = express.Router();

const CATEGORIES = ['fiduciary', 'meetings', 'records', 'enforcement', 'finance', 'architectural', 'elections', 'general'];

// Fields a staffer may edit through this surface. slug is immutable after
// create (it is the stable key the board portal links to).
const EDITABLE = ['title', 'summary', 'body', 'category', 'key_points', 'statute_refs', 'source_note', 'read_minutes', 'display_order', 'is_published'];

function cleanArray(v) {
  if (Array.isArray(v)) return v.map((s) => String(s).trim()).filter(Boolean);
  if (typeof v === 'string') return v.split('\n').map((s) => s.trim()).filter(Boolean);
  return [];
}

// GET /  — every module, all fields, for the staff list.
router.get('/', async (req, res) => {
  try {
    const staff = await requireStaff(req, res); if (!staff) return;
    const { data, error } = await supabase.from('board_learning_modules')
      .select('*').order('display_order', { ascending: true });
    if (error) {
      if (/does not exist|schema cache/i.test(error.message || '')) return res.json({ modules: [], pending_migration: true });
      throw error;
    }
    res.json({ modules: data || [] });
  } catch (err) {
    console.error('[board_learning_admin] list failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// POST /  — create a new module.
router.post('/', express.json({ limit: '128kb' }), async (req, res) => {
  try {
    const staff = await requireStaff(req, res); if (!staff) return;
    const b = req.body || {};
    const slug = String(b.slug || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    if (!slug) return res.status(400).json({ error: 'slug_required' });
    if (!b.title || !String(b.title).trim()) return res.status(400).json({ error: 'title_required' });
    const category = CATEGORIES.includes(b.category) ? b.category : 'general';
    const row = {
      slug, category,
      title: String(b.title).trim(),
      summary: String(b.summary || '').trim() || String(b.title).trim(),
      body: String(b.body || '').trim(),
      key_points: cleanArray(b.key_points),
      statute_refs: cleanArray(b.statute_refs),
      source_note: b.source_note ? String(b.source_note).trim() : null,
      read_minutes: Number.isFinite(+b.read_minutes) ? Math.max(1, Math.round(+b.read_minutes)) : 3,
      display_order: Number.isFinite(+b.display_order) ? Math.round(+b.display_order) : 100,
      is_published: b.is_published !== false,
    };
    const { data, error } = await supabase.from('board_learning_modules').insert(row).select().maybeSingle();
    if (error) {
      if (/duplicate key|unique/i.test(error.message || '')) return res.status(409).json({ error: 'slug_taken' });
      throw error;
    }
    res.json({ module: data });
  } catch (err) {
    console.error('[board_learning_admin] create failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// PATCH /:id  — edit an existing module (allowlisted fields only).
router.patch('/:id', express.json({ limit: '128kb' }), async (req, res) => {
  try {
    const staff = await requireStaff(req, res); if (!staff) return;
    const b = req.body || {};
    const patch = {};
    for (const k of EDITABLE) {
      if (!(k in b)) continue;
      if (k === 'key_points' || k === 'statute_refs') patch[k] = cleanArray(b[k]);
      else if (k === 'category') patch[k] = CATEGORIES.includes(b[k]) ? b[k] : 'general';
      else if (k === 'read_minutes') patch[k] = Math.max(1, Math.round(+b[k] || 3));
      else if (k === 'display_order') patch[k] = Math.round(+b[k] || 100);
      else if (k === 'is_published') patch[k] = b[k] !== false;
      else patch[k] = b[k] == null ? null : String(b[k]);
    }
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'no_editable_fields' });
    const { data, error } = await supabase.from('board_learning_modules')
      .update(patch).eq('id', req.params.id).select().maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'module_not_found' });
    res.json({ module: data });
  } catch (err) {
    console.error('[board_learning_admin] update failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

module.exports = router;
