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
const crypto = require('crypto');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');
const { requireStaff } = require('./_require_admin');
const { isValidSectionType, NEWSLETTER_SECTION_TYPES } = require('../lib/newsletters/section_types');
const { generateNewsletterDraft } = require('../lib/newsletters/generate');
const { renderNewsletterHTML } = require('../lib/newsletters/render');
const { sendEmail } = require('../lib/notifications/email');
const Anthropic = require('@anthropic-ai/sdk');
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const router = express.Router();

// Go-live guard (Ed 2026-08-03): flyer email blasts are STAFF-ONLY for testing
// until we go fully live off Vantaca. Flip to true to allow owner/resident sends.
const FLYER_MEMBER_SEND_ENABLED = false;

// Render a flyer/issue to BOTH a print PDF and a poster PNG in one browser.
async function renderFlyerAssets(bundle) {
  const puppeteer = require('puppeteer');
  const html = renderNewsletterHTML(bundle, { mode: 'print' });
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 816, height: 1056, deviceScaleFactor: 2 });
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 60000 });
    await page.emulateMediaType('print');
    const pdf = await page.pdf({ format: 'Letter', printBackground: true, preferCSSPageSize: true });
    let png;
    const el = await page.$('.fl-page');
    png = el ? await el.screenshot({ type: 'png' }) : await page.screenshot({ type: 'png', fullPage: true });
    return { pdf, png };
  } finally { try { await browser.close(); } catch (_) {} }
}

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

// --- AI writer + images -----------------------------------------------------

const uploadImg = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// POST /ai/write — write an article or spotlight blurb. body: { kind, prompt,
// community_id?, title? }. Returns { title, markdown }. For spotlights of real
// people/businesses the model uses ONLY the facts staff supply and flags gaps.
router.post('/ai/write', express.json({ limit: '256kb' }), async (req, res) => {
  try {
    if (!(await requireStaff(req, res))) return;
    const b = req.body || {};
    if (!b.prompt || !String(b.prompt).trim()) return res.status(400).json({ error: 'prompt required' });
    const kind = b.kind || 'article';
    let communityName = '';
    if (b.community_id) { try { const { data } = await supabase.from('communities').select('name').eq('id', b.community_id).maybeSingle(); communityName = (data && data.name) || ''; } catch (_) {} }

    const guidance = {
      article: 'Write a friendly, interesting community-newsletter article. Educational or fun is fine.',
      resident_spotlight: 'Write a warm "resident spotlight" featuring a neighbor. Use ONLY the facts provided — never invent details about a real person. If something is missing, write [STAFF REVIEW REQUIRED].',
      vendor_spotlight: 'Write a friendly "local business spotlight". Use ONLY the facts provided about the business — never invent hours, prices, or claims. Flag gaps with [STAFF REVIEW REQUIRED].',
      business_feature: 'Write a friendly feature on a local business. Use ONLY the supplied facts; never invent details. Flag gaps with [STAFF REVIEW REQUIRED].',
      in_the_news: 'Write a short, upbeat "community in the news" item. Use ONLY the supplied facts about real people/events; flag gaps with [STAFF REVIEW REQUIRED].',
    }[kind] || 'Write a friendly community-newsletter article.';

    const sys = `You are the editorial assistant for Bedrock Association Management writing for homeowners.
${guidance}
Rules: warm, welcoming, service-oriented; write for homeowners, not HOA professionals; no legal conclusions; do not describe covenant enforcement in an aggressive tone. NEVER invent dates, prices, names, statistics, or facts about real people or businesses beyond what is supplied. Return STRICT JSON only.`;
    const user = `Community: ${communityName || '(unspecified)'}
Topic / facts from staff: "${String(b.prompt).trim()}"
${b.title ? 'Suggested title: ' + b.title : ''}
Return JSON: { "title": "a short friendly title", "markdown": "the article body in simple markdown (paragraphs, and - bullet lists if useful), ~120-260 words" }`;
    const resp = await anthropic.messages.create({ model: 'claude-sonnet-4-5', max_tokens: 1200, system: sys, messages: [{ role: 'user', content: user }] });
    const text = (resp.content || []).map((c) => c.text || '').join('');
    console.log('[newsletter.ai-write] returned:', text.slice(0, 200));
    const a = text.indexOf('{'), z = text.lastIndexOf('}');
    const parsed = (a >= 0 && z > a) ? JSON.parse(text.slice(a, z + 1)) : {};
    res.json({ ok: true, title: parsed.title || b.title || '', markdown: parsed.markdown || '' });
  } catch (err) { console.error('[newsletter.ai-write]', err); res.status(500).json({ error: err.message }); }
});

// POST /images — upload an image (multipart 'file'); returns a hosted URL to
// drop into a section. Stored in the documents bucket under newsletters/images.
router.post('/images', uploadImg.single('file'), async (req, res) => {
  try {
    if (!(await requireStaff(req, res))) return;
    if (!req.file) return res.status(400).json({ error: 'file required' });
    const ext = (req.file.originalname || '').split('.').pop().toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
    const path = `newsletters/images/${crypto.randomUUID()}.${ext}`;
    const { error } = await supabase.storage.from('documents').upload(path, req.file.buffer, { contentType: req.file.mimetype || 'image/jpeg', upsert: false });
    if (error) return res.status(500).json({ error: error.message });
    const { data: signed } = await supabase.storage.from('documents').createSignedUrl(path, 60 * 60 * 24 * 365);
    res.json({ ok: true, url: (signed && signed.signedUrl) || null });
  } catch (err) { console.error('[newsletter.images]', err); res.status(500).json({ error: err.message }); }
});

// GET /photo-url?photo_id= — re-sign a community photo with a long-lived URL so
// it can be used as a flyer/newsletter image (the library's own list uses a
// 10-min preview URL that would expire on the published piece).
router.get('/photo-url', async (req, res) => {
  try {
    if (!(await requireStaff(req, res))) return;
    const photoId = req.query.photo_id;
    if (!photoId) return res.status(400).json({ error: 'photo_id required' });
    const { data: photo, error } = await supabase.from('community_photos').select('storage_path, storage_bucket').eq('id', photoId).maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!photo) return res.status(404).json({ error: 'photo not found' });
    const { data: signed } = await supabase.storage.from(photo.storage_bucket || 'documents').createSignedUrl(photo.storage_path, 60 * 60 * 24 * 365);
    res.json({ ok: true, url: (signed && signed.signedUrl) || null });
  } catch (err) { console.error('[newsletter.photo-url]', err); res.status(500).json({ error: err.message }); }
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

// --- Flyers -----------------------------------------------------------------

// POST /flyers/generate — create a flyer (a one-section 'flyer' issue). If a
// free-text prompt is given, the AI polishes ONLY the copy (headline / tagline /
// blurb); the factual fields (date, time, location, links) are used verbatim.
router.post('/flyers/generate', express.json(), async (req, res) => {
  try {
    const u = await requireStaff(req, res); if (!u) return;
    const b = req.body || {};
    if (!b.community_id) return res.status(400).json({ error: 'community_id required' });
    const fields = b.fields || {};
    let community = { name: '' };
    try { const { data } = await supabase.from('communities').select('name').eq('id', b.community_id).maybeSingle(); if (data) community = data; } catch (_) {}

    let copy = { headline: fields.headline || '', tagline: fields.tagline || '', description: fields.description || '', kicker: fields.kicker || '' };
    if (b.prompt && String(b.prompt).trim()) {
      try {
        const sys = `You write short, punchy, friendly copy for a community event flyer. Return STRICT JSON only.
Rules: warm and inviting; NEVER invent dates, times, prices, or locations (those are supplied separately); keep it celebratory and community-oriented; no legal or enforcement tone.`;
        const user = `Event description from staff: "${String(b.prompt).trim()}"
Known facts (do not restate literally unless natural): community=${community.name}, date=${fields.event_date || ''}, time=${fields.event_time || ''}, location=${[fields.location_name, fields.location_address].filter(Boolean).join(' ')}.
Return JSON: { "kicker": "<= 4 words, e.g. community name or 'You're invited'", "headline": "the big flyer title, <= 5 words, exciting", "tagline": "one inviting line, <= 16 words", "description": "1-2 warm sentences about the event" }`;
        const resp = await anthropic.messages.create({ model: 'claude-sonnet-4-5', max_tokens: 600, system: sys, messages: [{ role: 'user', content: user }] });
        const text = (resp.content || []).map((c) => c.text || '').join('');
        const a = text.indexOf('{'), z = text.lastIndexOf('}');
        if (a >= 0 && z > a) { const p = JSON.parse(text.slice(a, z + 1)); copy = { headline: p.headline || copy.headline, tagline: p.tagline || copy.tagline, description: p.description || copy.description, kicker: p.kicker || copy.kicker }; }
      } catch (e) { console.warn('[flyer.generate] AI polish failed:', e.message); }
    }

    const headline = copy.headline || fields.headline || 'Community Event';
    const bodyJson = {
      headline, tagline: copy.tagline || fields.tagline || '', kicker: copy.kicker || fields.kicker || '',
      description: copy.description || fields.description || '',
      event_date: fields.event_date || '', event_time: fields.event_time || '',
      location_name: fields.location_name || '', location_address: fields.location_address || '',
      cta_label: fields.cta_label || '', cta_url: fields.cta_url || '',
      theme: fields.theme || 'summer', image_url: fields.image_url || '',
    };
    const month = (b.event_month ? String(b.event_month).slice(0, 7) : new Date().toISOString().slice(0, 7));
    const { data: issue, error: ie } = await supabase.from('newsletter_issues').insert({
      community_id: b.community_id, title: headline, slug: `${month}-${slugify(headline)}-flyer`,
      issue_month: `${month}-01`, format_key: 'flyer', template_key: 'flyer',
      created_by: u.user.id, created_by_name: u.full_name || null,
    }).select().single();
    if (ie) return res.status(500).json({ error: ie.message });
    const { error: se } = await supabase.from('newsletter_sections').insert({
      newsletter_issue_id: issue.id, section_type: 'flyer', title: headline, body_json: bodyJson, display_order: 0, ai_generated: !!b.prompt,
    });
    if (se) return res.status(500).json({ error: se.message });
    res.json({ ok: true, issue_id: issue.id, copy });
  } catch (err) { console.error('[flyer.generate]', err); res.status(500).json({ error: err.message }); }
});

// POST /flyers/polish — AI copy only (headline/tagline/description/kicker),
// creates nothing. Lets staff iterate wording before saving.
router.post('/flyers/polish', express.json(), async (req, res) => {
  try {
    if (!(await requireStaff(req, res))) return;
    const b = req.body || {}; const fields = b.fields || {};
    if (!b.prompt || !String(b.prompt).trim()) return res.status(400).json({ error: 'prompt required' });
    let communityName = '';
    if (b.community_id) { try { const { data } = await supabase.from('communities').select('name').eq('id', b.community_id).maybeSingle(); communityName = (data && data.name) || ''; } catch (_) {} }
    const sys = `You write short, punchy, friendly copy for a community event flyer. Return STRICT JSON only.
Rules: warm and inviting; NEVER invent dates, times, prices, or locations (supplied separately); celebratory, community-oriented; no legal/enforcement tone.`;
    const user = `Event description from staff: "${String(b.prompt).trim()}"
Known facts: community=${communityName}, date=${fields.event_date || ''}, time=${fields.event_time || ''}, location=${[fields.location_name, fields.location_address].filter(Boolean).join(' ')}.
Return JSON: { "kicker": "<= 4 words", "headline": "big title <= 5 words", "tagline": "one inviting line <= 16 words", "description": "1-2 warm sentences" }`;
    const resp = await anthropic.messages.create({ model: 'claude-sonnet-4-5', max_tokens: 600, system: sys, messages: [{ role: 'user', content: user }] });
    const text = (resp.content || []).map((c) => c.text || '').join('');
    const a = text.indexOf('{'), z = text.lastIndexOf('}');
    const copy = (a >= 0 && z > a) ? JSON.parse(text.slice(a, z + 1)) : {};
    res.json({ ok: true, copy: { headline: copy.headline || '', tagline: copy.tagline || '', description: copy.description || '', kicker: copy.kicker || '' } });
  } catch (err) { console.error('[flyer.polish]', err); res.status(500).json({ error: err.message }); }
});

// GET /issues/:id/png — poster PNG (staff). Used for the email embed + download.
router.get('/issues/:id/png', async (req, res) => {
  try {
    if (!(await requireStaff(req, res))) return;
    const bundle = await loadIssueBundle(req.params.id);
    if (!bundle) return res.status(404).json({ error: 'not found' });
    const { png } = await renderFlyerAssets(bundle);
    res.set('Content-Type', 'image/png');
    res.set('Content-Disposition', `inline; filename="flyer.png"`);
    res.send(png);
  } catch (err) { console.error('[flyer.png]', err); res.status(500).json({ error: 'PNG generation failed' }); }
});

// POST /issues/:id/send-email — blast the flyer. STAFF-ONLY during go-live
// testing. Sends custom verbiage + the flyer embedded as an image + the flyer
// PDF attached. Body: { audience, subject, verbiage }.
router.post('/issues/:id/send-email', express.json({ limit: '1mb' }), async (req, res) => {
  try {
    const u = await requireStaff(req, res); if (!u) return;
    const b = req.body || {};
    const audience = b.audience || 'staff';
    if (audience !== 'staff' && !FLYER_MEMBER_SEND_ENABLED) {
      return res.status(403).json({ error: 'member_send_disabled', detail: 'Flyer blasts are staff-only while we test the go-live. Ask Ed to enable owner/resident sends.' });
    }
    const bundle = await loadIssueBundle(req.params.id);
    if (!bundle) return res.status(404).json({ error: 'not found' });

    // Recipients.
    let recipients = [];
    if (audience === 'staff') {
      const { data, error } = await supabase.from('user_profiles').select('email, full_name, is_active').limit(500);
      if (error) return res.status(500).json({ error: error.message });
      recipients = (data || []).filter((x) => x && x.is_active !== false && x.email).map((x) => ({ email: x.email, name: x.full_name || '' }));
    } else {
      const { resolveRecipients } = require('./email_campaigns');
      recipients = await resolveRecipients({ scope: 'single_community', target_community_id: bundle.issue.community_id, audience });
    }
    // Dedupe by email.
    const seen = new Set(); recipients = recipients.filter((r) => r.email && !seen.has(r.email.toLowerCase()) && seen.add(r.email.toLowerCase()));
    if (!recipients.length) return res.status(400).json({ error: 'no_recipients', detail: 'No active recipients found for that audience.' });

    // Render assets once.
    const { pdf, png } = await renderFlyerAssets(bundle);

    // Host the PNG so email clients can display it inline (data URIs are often
    // stripped). Long-lived signed URL so the email keeps rendering.
    let imgUrl = null;
    try {
      const path = `newsletters/flyers/${bundle.issue.id}.png`;
      await supabase.storage.from('documents').upload(path, png, { contentType: 'image/png', upsert: true });
      const { data: signed } = await supabase.storage.from('documents').createSignedUrl(path, 60 * 60 * 24 * 365);
      imgUrl = signed && signed.signedUrl ? signed.signedUrl : null;
    } catch (e) { console.warn('[flyer.email] png host failed:', e.message); }

    const subject = (b.subject || '').trim() || bundle.issue.title || 'Community Flyer';
    const verbiageHtml = (b.verbiage || '').trim()
      ? '<div style="font-size:15px;line-height:1.6;color:#20303f;margin:0 0 18px;">' + String(b.verbiage).trim().split(/\n{2,}/).map((p) => '<p style="margin:0 0 12px;">' + p.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br>') + '</p>').join('') + '</div>'
      : '';
    const imgHtml = imgUrl ? `<img src="${imgUrl}" alt="${subject.replace(/"/g, '')}" style="width:100%;max-width:600px;border-radius:10px;display:block;margin:0 auto;">` : '<p style="color:#5f7488;">(Flyer attached as PDF.)</p>';
    const html = `<div style="max-width:640px;margin:0 auto;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;padding:8px;">
      ${verbiageHtml}${imgHtml}
      <p style="font-size:12.5px;color:#5f7488;text-align:center;margin:18px 0 0;">The full flyer is attached as a PDF. Sent by Bedrock Association Management.</p>
    </div>`;
    const attachments = [{ filename: `${slugify(subject)}.pdf`, content: Buffer.from(pdf).toString('base64') }];

    // Send with small concurrency.
    let sent = 0, failed = 0;
    for (let i = 0; i < recipients.length; i += 5) {
      const batch = recipients.slice(i, i + 5);
      const results = await Promise.all(batch.map((r) => sendEmail({ to: r.email, subject, html, attachments }).then(() => true).catch((e) => { console.warn('[flyer.email] send failed', r.email, e.message); return false; })));
      sent += results.filter(Boolean).length; failed += results.filter((x) => !x).length;
    }
    res.json({ ok: true, audience, recipients: recipients.length, sent, failed, staff_only: audience === 'staff' });
  } catch (err) { console.error('[flyer.send-email]', err); res.status(500).json({ error: err.message }); }
});

module.exports = router;
