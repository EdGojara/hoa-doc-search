// ============================================================================
// api/legal.js — Legal Disclosures (Bedrock's own policies + notices)
// ----------------------------------------------------------------------------
// Stores Bedrock's privacy policy, disclosures, and standing legal notices as
// versioned, editable documents so they live in the platform, not a file on a
// desktop. Reads are behind the staff gate; writes require an admin session.
// Backed by migration 324 (legal_documents). (Ed 2026-07-21.)
// ============================================================================
const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
const { safeErrorMessage } = require('./_safe_error');
const { requireAdmin } = require('./_require_admin');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const LIST_COLS = 'id, slug, title, category, version, effective_date, status, updated_by, updated_at';
const _missing = (e) => /could not find|does not exist|42P01|42703|PGRST20[45]/i.test((e && (e.message || e.code) || '') + '');

// GET /api/legal — list documents (metadata only). Degrades to [] before mig 324.
router.get('/', async (req, res) => {
  try {
    const { data, error } = await supabase.from('legal_documents').select(LIST_COLS).order('title', { ascending: true });
    if (error) {
      if (_missing(error)) return res.json({ documents: [], not_ready: true });
      return res.status(500).json({ error: safeErrorMessage(error) });
    }
    res.json({ documents: data || [] });
  } catch (err) { console.error('[legal] list', err.message); res.status(500).json({ error: safeErrorMessage(err) }); }
});

// GET /api/legal/:slug — full document body
router.get('/:slug', async (req, res) => {
  try {
    const { data, error } = await supabase.from('legal_documents').select('*').eq('slug', req.params.slug).maybeSingle();
    if (error) { if (_missing(error)) return res.status(404).json({ error: 'not_ready' }); return res.status(500).json({ error: safeErrorMessage(error) }); }
    if (!data) return res.status(404).json({ error: 'not_found' });
    res.json({ document: data });
  } catch (err) { console.error('[legal] get', err.message); res.status(500).json({ error: safeErrorMessage(err) }); }
});

// PUT /api/legal/:slug — create or update (admin only). Bumps version on a body change.
router.put('/:slug', express.json({ limit: '512kb' }), async (req, res) => {
  try {
    const admin = await requireAdmin(req, res); if (!admin) return;
    const slug = String(req.params.slug || '').trim();
    if (!slug) return res.status(400).json({ error: 'slug required' });
    const b = req.body || {};
    if (b.status && !['draft', 'published', 'archived'].includes(b.status)) return res.status(400).json({ error: 'invalid status' });
    const effective_date = (b.effective_date === '' || b.effective_date == null) ? null : b.effective_date;

    const { data: existing, error: exErr } = await supabase.from('legal_documents').select('id, version, body_markdown').eq('slug', slug).maybeSingle();
    if (exErr) { if (_missing(exErr)) return res.status(503).json({ error: 'Legal storage not ready — apply migration 324 in the Supabase SQL editor, then try again.' }); return res.status(500).json({ error: safeErrorMessage(exErr) }); }

    if (existing) {
      const patch = { updated_by: admin.email || 'admin' };
      ['title', 'category', 'body_markdown', 'status'].forEach((k) => { if (b[k] !== undefined) patch[k] = b[k]; });
      if (b.effective_date !== undefined) patch.effective_date = effective_date;
      if (b.body_markdown !== undefined && b.body_markdown !== existing.body_markdown) patch.version = (existing.version || 1) + 1;
      const { data, error } = await supabase.from('legal_documents').update(patch).eq('id', existing.id).select('*').single();
      if (error) return res.status(500).json({ error: safeErrorMessage(error) });
      return res.json({ document: data });
    }
    if (!b.title) return res.status(400).json({ error: 'title required for a new document' });
    const ins = {
      slug, title: b.title, category: b.category || 'policy',
      body_markdown: b.body_markdown || '', effective_date, status: b.status || 'draft',
      updated_by: admin.email || 'admin',
    };
    const { data, error } = await supabase.from('legal_documents').insert(ins).select('*').single();
    if (error) return res.status(500).json({ error: safeErrorMessage(error) });
    res.json({ document: data });
  } catch (err) { console.error('[legal] put', err.message); res.status(500).json({ error: safeErrorMessage(err) }); }
});

module.exports = { router };
