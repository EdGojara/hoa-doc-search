// ============================================================================
// Newsletter Studio API  (Ed 2026-08-03)
// ----------------------------------------------------------------------------
// Mounts at /api/newsletters. A newsletter is an ISSUE (newsletter_issues) made
// of ordered SECTIONS (newsletter_sections). Sections are assembled from
// platform data by the generator, then edited by staff, then the issue renders
// to web / print from one source.
//
// Auth: staff-tier for all editing + draft reads (requireStaff). The public
// web view of a PUBLISHED issue is served separately (server.js) without auth.
// ============================================================================

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { requireStaff } = require('./_require_admin');
const { isValidSectionType, NEWSLETTER_SECTION_TYPES } = require('../lib/newsletters/section_types');
const { generateNewsletterDraft } = require('../lib/newsletters/generate');
const { renderNewsletterHTML } = require('../lib/newsletters/render');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const router = express.Router();

function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'issue';
}
function monthLabel(isoMonth) {
  try {
    const d = new Date(String(isoMonth).slice(0, 7) + '-01T12:00:00');
    return d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  } catch (_) { return isoMonth; }
}

// GET /section-types — the section library for the Studio's Add dropdown.
router.get('/section-types', async (req, res) => {
  try {
    if (!(await requireStaff(req, res))) return;
    res.json({ types: NEWSLETTER_SECTION_TYPES });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- Issues -----------------------------------------------------------------

// GET /issues?community_id= — list issues (newest first).
router.get('/issues', async (req, res) => {
  try {
    if (!(await requireStaff(req, res))) return;
    let q = supabase.from('newsletter_issues')
      .select('id, community_id, title, slug, issue_month, status, format_key, cover_image_url, published_at, updated_at')
      .order('issue_month', { ascending: false }).limit(500);
    if (req.query.community_id) q = q.eq('community_id', req.query.community_id);
    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    res.json({ issues: data || [] });
  } catch (err) { console.error('[newsletters.issues]', err); res.status(500).json({ error: err.message }); }
});

// GET /issues/:id — one issue with its ordered sections.
router.get('/issues/:id', async (req, res) => {
  try {
    if (!(await requireStaff(req, res))) return;
    const { data: issue, error } = await supabase.from('newsletter_issues').select('*').eq('id', req.params.id).maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!issue) return res.status(404).json({ error: 'not found' });
    const { data: sections, error: se } = await supabase.from('newsletter_sections')
      .select('*').eq('newsletter_issue_id', issue.id).order('display_order', { ascending: true });
    if (se) return res.status(500).json({ error: se.message });
    let community = null;
    try {
      const { data: c } = await supabase.from('communities').select('id, name').eq('id', issue.community_id).maybeSingle();
      community = c || null;
    } catch (_) {}
    res.json({ issue, sections: sections || [], community });
  } catch (err) { console.error('[newsletters.issue]', err); res.status(500).json({ error: err.message }); }
});

// POST /issues — create an empty issue manually.
router.post('/issues', express.json(), async (req, res) => {
  try {
    const u = await requireStaff(req, res); if (!u) return;
    const b = req.body || {};
    if (!b.community_id) return res.status(400).json({ error: 'community_id required' });
    if (!b.issue_month) return res.status(400).json({ error: 'issue_month required' });
    const month = String(b.issue_month).slice(0, 7);
    const title = (b.title || '').trim() || `${monthLabel(month)} Newsletter`;
    const format = ['community_update', 'community_magazine', 'announcement'].includes(b.format_key) ? b.format_key : 'community_update';
    const row = {
      community_id: b.community_id, title, slug: `${month}-${slugify(title)}`,
      issue_month: `${month}-01`, format_key: format, template_key: b.template_key || 'community-update',
      introduction: (b.introduction || '').trim() || null,
      created_by: u.user.id, created_by_name: u.full_name || null,
    };
    const { data, error } = await supabase.from('newsletter_issues').insert(row).select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true, issue: data });
  } catch (err) { console.error('[newsletters.create]', err); res.status(500).json({ error: err.message }); }
});

// POST /issues/generate — AI-assemble a draft from platform data.
router.post('/issues/generate', express.json(), async (req, res) => {
  try {
    const u = await requireStaff(req, res); if (!u) return;
    const b = req.body || {};
    if (!b.community_id) return res.status(400).json({ error: 'community_id required' });
    if (!b.issue_month) return res.status(400).json({ error: 'issue_month required' });
    const month = String(b.issue_month).slice(0, 7);
    const format = ['community_update', 'community_magazine', 'announcement'].includes(b.format_key) ? b.format_key : 'community_update';

    const draft = await generateNewsletterDraft({
      supabase, communityId: b.community_id, issueMonth: month, formatKey: format,
    });

    const title = draft.title || `${monthLabel(month)} Newsletter`;
    const { data: issue, error: ie } = await supabase.from('newsletter_issues').insert({
      community_id: b.community_id, title, slug: `${month}-${slugify(title)}`,
      issue_month: `${month}-01`, format_key: format, template_key: 'community-update',
      introduction: draft.introduction || null, cover_image_url: draft.cover_image_url || null,
      created_by: u.user.id, created_by_name: u.full_name || null,
    }).select().single();
    if (ie) return res.status(500).json({ error: ie.message });

    const rows = (draft.sections || []).map((s, i) => ({
      newsletter_issue_id: issue.id,
      section_type: isValidSectionType(s.section_type) ? s.section_type : 'custom_article',
      title: s.title || null, subtitle: s.subtitle || null,
      body_json: s.body_json || {}, image_url: s.image_url || null,
      display_order: i, ai_generated: !!s.ai_generated, needs_review: !!s.needs_review,
      source_metadata: s.source_metadata || {},
    }));
    if (rows.length) {
      const { error: se } = await supabase.from('newsletter_sections').insert(rows);
      if (se) return res.status(500).json({ error: se.message });
    }
    res.json({ ok: true, issue_id: issue.id, section_count: rows.length, notes: draft.notes || [] });
  } catch (err) { console.error('[newsletters.generate]', err); res.status(500).json({ error: err.message }); }
});

// PATCH /issues/:id — edit issue-level fields.
router.patch('/issues/:id', express.json(), async (req, res) => {
  try {
    if (!(await requireStaff(req, res))) return;
    const b = req.body || {};
    const patch = {};
    for (const f of ['title', 'introduction', 'cover_image_url', 'template_key']) if (f in b) patch[f] = b[f];
    if ('status' in b && ['draft', 'review', 'approved', 'published', 'archived'].includes(b.status)) patch.status = b.status;
    if ('format_key' in b && ['community_update', 'community_magazine', 'announcement'].includes(b.format_key)) patch.format_key = b.format_key;
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'no editable fields' });
    const { data, error } = await supabase.from('newsletter_issues').update(patch).eq('id', req.params.id).select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true, issue: data });
  } catch (err) { console.error('[newsletters.patch]', err); res.status(500).json({ error: err.message }); }
});

// POST /issues/:id/publish — mark published + stamp published_at.
router.post('/issues/:id/publish', express.json(), async (req, res) => {
  try {
    if (!(await requireStaff(req, res))) return;
    const { data, error } = await supabase.from('newsletter_issues')
      .update({ status: 'published', published_at: new Date().toISOString() })
      .eq('id', req.params.id).select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true, issue: data });
  } catch (err) { console.error('[newsletters.publish]', err); res.status(500).json({ error: err.message }); }
});

// DELETE /issues/:id — remove an issue (sections cascade).
router.delete('/issues/:id', async (req, res) => {
  try {
    if (!(await requireStaff(req, res))) return;
    const { error } = await supabase.from('newsletter_issues').delete().eq('id', req.params.id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true });
  } catch (err) { console.error('[newsletters.delete]', err); res.status(500).json({ error: err.message }); }
});

// --- Sections ---------------------------------------------------------------

// POST /issues/:id/sections — add a section (appended to the end).
router.post('/issues/:id/sections', express.json(), async (req, res) => {
  try {
    if (!(await requireStaff(req, res))) return;
    const b = req.body || {};
    if (!isValidSectionType(b.section_type)) return res.status(400).json({ error: 'invalid section_type' });
    const { data: last } = await supabase.from('newsletter_sections')
      .select('display_order').eq('newsletter_issue_id', req.params.id)
      .order('display_order', { ascending: false }).limit(1).maybeSingle();
    const nextOrder = (last && typeof last.display_order === 'number') ? last.display_order + 1 : 0;
    const row = {
      newsletter_issue_id: req.params.id, section_type: b.section_type,
      title: b.title || null, subtitle: b.subtitle || null,
      body_json: b.body_json || {}, image_url: b.image_url || null,
      display_order: nextOrder,
      visibility: Array.isArray(b.visibility) ? b.visibility : ['web', 'email', 'pdf'],
    };
    const { data, error } = await supabase.from('newsletter_sections').insert(row).select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true, section: data });
  } catch (err) { console.error('[newsletters.section.add]', err); res.status(500).json({ error: err.message }); }
});

// PATCH /sections/:id — edit a section.
router.patch('/sections/:id', express.json(), async (req, res) => {
  try {
    if (!(await requireStaff(req, res))) return;
    const b = req.body || {};
    const patch = {};
    for (const f of ['title', 'subtitle', 'body_json', 'image_url', 'page_break_before', 'visibility']) if (f in b) patch[f] = b[f];
    if ('section_type' in b) { if (!isValidSectionType(b.section_type)) return res.status(400).json({ error: 'invalid section_type' }); patch.section_type = b.section_type; }
    if ('approval_status' in b && ['draft', 'approved', 'rejected'].includes(b.approval_status)) patch.approval_status = b.approval_status;
    if ('needs_review' in b) patch.needs_review = !!b.needs_review;
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'no editable fields' });
    const { data, error } = await supabase.from('newsletter_sections').update(patch).eq('id', req.params.id).select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true, section: data });
  } catch (err) { console.error('[newsletters.section.patch]', err); res.status(500).json({ error: err.message }); }
});

// DELETE /sections/:id — remove a section.
router.delete('/sections/:id', async (req, res) => {
  try {
    if (!(await requireStaff(req, res))) return;
    const { error } = await supabase.from('newsletter_sections').delete().eq('id', req.params.id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true });
  } catch (err) { console.error('[newsletters.section.delete]', err); res.status(500).json({ error: err.message }); }
});

// POST /issues/:id/reorder — body { order: [sectionId, ...] } sets display_order.
router.post('/issues/:id/reorder', express.json(), async (req, res) => {
  try {
    if (!(await requireStaff(req, res))) return;
    const order = (req.body && req.body.order) || [];
    if (!Array.isArray(order)) return res.status(400).json({ error: 'order[] required' });
    for (let i = 0; i < order.length; i++) {
      const { error } = await supabase.from('newsletter_sections')
        .update({ display_order: i }).eq('id', order[i]).eq('newsletter_issue_id', req.params.id);
      if (error) return res.status(500).json({ error: error.message });
    }
    res.json({ ok: true });
  } catch (err) { console.error('[newsletters.reorder]', err); res.status(500).json({ error: err.message }); }
});

// --- Rendering --------------------------------------------------------------

async function loadIssueBundle(id) {
  const { data: issue, error } = await supabase.from('newsletter_issues').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  if (!issue) return null;
  const { data: sections, error: se } = await supabase.from('newsletter_sections')
    .select('*').eq('newsletter_issue_id', id).order('display_order', { ascending: true });
  if (se) throw se;
  let community = null;
  try { const { data: c } = await supabase.from('communities').select('id, name, slug').eq('id', issue.community_id).maybeSingle(); community = c || null; } catch (_) {}
  return { issue, sections: sections || [], community };
}

// GET /issues/:id/html?mode=web|print — rendered HTML (staff; Studio fetches
// this with auth and drops it into a preview iframe via srcdoc).
router.get('/issues/:id/html', async (req, res) => {
  try {
    if (!(await requireStaff(req, res))) return;
    const bundle = await loadIssueBundle(req.params.id);
    if (!bundle) return res.status(404).send('Not found');
    const mode = req.query.mode === 'print' ? 'print' : 'web';
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(renderNewsletterHTML(bundle, { mode }));
  } catch (err) { console.error('[newsletters.html]', err); res.status(500).send('Render failed'); }
});

// GET /issues/:id/pdf — print-ready PDF via puppeteer. Self-contained HTML is
// set directly on the page (setContent), so no auth cookie / preview URL dance.
router.get('/issues/:id/pdf', async (req, res) => {
  let browser;
  try {
    if (!(await requireStaff(req, res))) return;
    const bundle = await loadIssueBundle(req.params.id);
    if (!bundle) return res.status(404).json({ error: 'not found' });
    const html = renderNewsletterHTML(bundle, { mode: 'print' });
    const puppeteer = require('puppeteer');
    browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 60000 });
    await page.emulateMediaType('print');
    const pdf = await page.pdf({ format: 'Letter', printBackground: true, preferCSSPageSize: true });
    await browser.close(); browser = null;
    const fname = `${(bundle.community && bundle.community.name) || 'community'}-newsletter`.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `inline; filename="${fname}.pdf"`);
    res.send(pdf);
  } catch (err) {
    console.error('[newsletters.pdf]', err);
    res.status(500).json({ error: 'PDF generation failed' });
  } finally { if (browser) { try { await browser.close(); } catch (_) {} } }
});

// GET /public/:id — resident-facing web view. NO auth, but ONLY published
// issues are served (drafts stay staff-only). This is the link residents open.
router.get('/public/:id', async (req, res) => {
  try {
    const bundle = await loadIssueBundle(req.params.id);
    if (!bundle || bundle.issue.status !== 'published') return res.status(404).send('<h1>Newsletter not found</h1>');
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(renderNewsletterHTML(bundle, { mode: 'web' }));
  } catch (err) { console.error('[newsletters.public]', err); res.status(500).send('Error'); }
});

module.exports = router;
