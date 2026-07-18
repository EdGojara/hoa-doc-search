// ============================================================================
// api/minutes.js — Minutes module (Ed 2026-07-02)
// ----------------------------------------------------------------------------
// Formal board / annual meeting minutes. The platform AI-DRAFTS a first version
// from what it already knows — the board roster (board_members), the decisions
// log (community_decisions), and annual-meeting attendance (meeting_attendance)
// — staff EDIT, then FINALIZE renders a Bedrock-branded PDF that files as an
// association record (library_documents) and feeds the board packet's Prior
// Minutes section.
//
// Endpoints (mounted at /api/minutes):
//   GET    /            ?community_id      list minutes (newest first)
//   POST   /            create a meeting shell
//   GET    /:id                            one record
//   PATCH  /:id                            edit (title/body/status/attendees/…)
//   DELETE /:id                            delete a draft
//   POST   /:id/ai-draft                   AI-draft the body from meeting data
//   POST   /:id/finalize                   render + file as association record
//   GET    /:id/pdf                        the rendered minutes PDF
// ============================================================================

const express = require('express');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');
const puppeteer = require('puppeteer');
const { safeErrorMessage } = require('./_safe_error');

const router = express.Router();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const BEDROCK_MGMT_CO_ID = '00000000-0000-0000-0000-000000000001';
const MODEL = 'claude-sonnet-4-5';

function anthropic() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// --- GET / — list -----------------------------------------------------------
router.get('/', async (req, res) => {
  try {
    let q = supabase.from('meeting_minutes')
      .select('id, community_id, meeting_date, meeting_type, title, status, ai_drafted, rendered_document_id, finalized_at, updated_at, communities:community_id(name)')
      .order('meeting_date', { ascending: false, nullsFirst: false })
      .order('updated_at', { ascending: false })
      .limit(500);
    if (req.query.community_id) q = q.eq('community_id', req.query.community_id);
    const { data, error } = await q;
    if (error) throw error;
    res.json({ minutes: (data || []).map((m) => ({ ...m, community_name: m.communities ? m.communities.name : null })) });
  } catch (err) {
    console.error('[minutes] list failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// --- POST / — create a shell ------------------------------------------------
router.post('/', express.json(), async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.community_id) return res.status(400).json({ error: 'community_id_required' });
    const type = ['regular', 'annual', 'special', 'executive', 'organizational'].includes(b.meeting_type) ? b.meeting_type : 'regular';
    const { data: comm } = await supabase.from('communities').select('name, management_company_id').eq('id', b.community_id).maybeSingle();
    const { data, error } = await supabase.from('meeting_minutes').insert({
      management_company_id: (comm && comm.management_company_id) || BEDROCK_MGMT_CO_ID,
      community_id: b.community_id,
      meeting_date: b.meeting_date || null,
      meeting_type: type,
      title: b.title || `${type[0].toUpperCase() + type.slice(1)} Board Meeting Minutes`,
      location: b.location || null,
      status: 'draft',
      created_by: b.created_by || 'staff',
    }).select('*').single();
    if (error) throw error;
    res.json({ minutes: data });
  } catch (err) {
    console.error('[minutes] create failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// --- GET /:id ---------------------------------------------------------------
router.get('/:id', async (req, res) => {
  try {
    const { data, error } = await supabase.from('meeting_minutes')
      .select('*, communities:community_id(name)').eq('id', req.params.id).maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'not_found' });
    res.json({ minutes: { ...data, community_name: data.communities ? data.communities.name : null } });
  } catch (err) {
    console.error('[minutes] get failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// --- PATCH /:id — edit ------------------------------------------------------
router.patch('/:id', express.json(), async (req, res) => {
  try {
    const allowed = ['title', 'body_markdown', 'status', 'attendees', 'meeting_date', 'meeting_type', 'location', 'called_to_order_at', 'adjourned_at'];
    const patch = {};
    for (const k of allowed) if (k in (req.body || {})) patch[k] = req.body[k];
    if (patch.status && !['draft', 'in_review', 'final'].includes(patch.status)) return res.status(400).json({ error: 'bad_status' });
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'nothing_to_update' });
    const { data, error } = await supabase.from('meeting_minutes').update(patch).eq('id', req.params.id).select('*').single();
    if (error) throw error;
    res.json({ minutes: data });
  } catch (err) {
    console.error('[minutes] patch failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// --- DELETE /:id ------------------------------------------------------------
router.delete('/:id', async (req, res) => {
  try {
    const { error } = await supabase.from('meeting_minutes').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    console.error('[minutes] delete failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// --- POST /:id/ai-draft — draft the body from meeting data ------------------
router.post('/:id/ai-draft', express.json(), async (req, res) => {
  try {
    const client = anthropic();
    if (!client) return res.status(503).json({ error: 'ai_not_configured' });
    const { data: m } = await supabase.from('meeting_minutes').select('*, communities:community_id(name)').eq('id', req.params.id).maybeSingle();
    if (!m) return res.status(404).json({ error: 'not_found' });
    const communityName = (m.communities && m.communities.name) || 'the Association';
    const mtgDate = m.meeting_date || null;

    // Gather the sources the platform already holds.
    const { data: board } = await supabase.from('board_members')
      .select('name, position, is_active').eq('community_id', m.community_id).eq('is_active', true).order('position');
    // Decisions: board-visible, within ~90 days up to the meeting date (or latest).
    let decQ = supabase.from('community_decisions')
      .select('decision_summary, category, decided_at, decided_by, board_visible')
      .eq('community_id', m.community_id).order('decided_at', { ascending: false }).limit(40);
    if (mtgDate) {
      const from = new Date(mtgDate); from.setDate(from.getDate() - 120);
      decQ = decQ.gte('decided_at', from.toISOString()).lte('decided_at', new Date(mtgDate + 'T23:59:59Z').toISOString());
    }
    const { data: decisions } = await decQ;
    // Annual-meeting attendance (only meaningful for annual meetings).
    let attendance = [];
    if (m.meeting_type === 'annual') {
      const { data: att } = await supabase.from('meeting_attendance')
        .select('owner_name, checked_in_at, vote_weight').eq('community_id', m.community_id).limit(1000);
      attendance = att || [];
    }

    const roster = (board || []).map((b) => `${b.name}${b.position ? ` (${b.position})` : ''}`);
    const decisionLines = (decisions || []).map((d) => `- ${d.decision_summary}${d.category ? ` [${d.category}]` : ''}${d.decided_at ? ` (${String(d.decided_at).slice(0, 10)})` : ''}`);

    const prompt = `You are drafting FORMAL board meeting minutes for a Texas HOA. Produce a clean, neutral, professional first draft in Markdown that staff will review and edit. Minutes are a factual record — do NOT invent motions, votes, dollar amounts, or discussion that isn't supported below. Where the record is thin, use clear placeholders in [brackets] for staff to fill (e.g. "[Motion by ___, seconded by ___]"). Do not editorialize.

MEETING
- Association: ${communityName}
- Type: ${m.meeting_type} meeting
- Date: ${mtgDate || '[meeting date]'}
- Location: ${m.location || '[location]'}

BOARD ROSTER (likely attendees / officers):
${roster.length ? roster.map((r) => '- ' + r).join('\n') : '- [roster not on file]'}

DECISIONS ON RECORD in the period (from the platform decisions log — reflect these as approved actions where relevant):
${decisionLines.length ? decisionLines.join('\n') : '- [no decisions logged for this period]'}
${m.meeting_type === 'annual' && attendance.length ? `\nATTENDANCE: ${attendance.length} owners checked in (annual meeting).` : ''}

Structure the minutes with these Markdown sections (## headings), omitting any that truly don't apply:
## Call to Order
## Roll Call / Establishment of Quorum
## Approval of Prior Minutes
## Officer & Committee Reports
## Old Business
## New Business
## Decisions & Actions
## Action Items
## Adjournment

Return ONLY the Markdown minutes body — no preamble, no code fences.`;

    const r = await client.messages.create({ model: MODEL, max_tokens: 2500, messages: [{ role: 'user', content: prompt }] });
    let body = r.content.map((c) => c.text || '').join('').trim().replace(/^```(?:markdown)?\s*/i, '').replace(/\s*```$/i, '');

    const attendees = (board || []).map((b) => ({ name: b.name, role: b.position || null, present: true }));
    const { data: updated, error: uErr } = await supabase.from('meeting_minutes')
      .update({ body_markdown: body, attendees, ai_drafted: true, ai_model: MODEL, status: m.status === 'final' ? 'final' : 'in_review' })
      .eq('id', m.id).select('*').single();
    if (uErr) throw uErr;
    res.json({ minutes: updated, sources: { roster: roster.length, decisions: (decisions || []).length, attendance: attendance.length } });
  } catch (err) {
    console.error('[minutes] ai-draft failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// --- Minimal, safe Markdown → HTML (headings, bold, lists, paragraphs) ------
function mdToHtml(md) {
  const lines = String(md || '').split(/\r?\n/);
  let html = '', inUl = false;
  const inline = (t) => esc(t).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\[(.+?)\]/g, '<span style="color:#b45309;">[$1]</span>');
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (/^##\s+/.test(line)) { if (inUl) { html += '</ul>'; inUl = false; } html += `<h2>${inline(line.replace(/^##\s+/, ''))}</h2>`; continue; }
    if (/^#\s+/.test(line)) { if (inUl) { html += '</ul>'; inUl = false; } html += `<h1>${inline(line.replace(/^#\s+/, ''))}</h1>`; continue; }
    if (/^[-*]\s+/.test(line)) { if (!inUl) { html += '<ul>'; inUl = true; } html += `<li>${inline(line.replace(/^[-*]\s+/, ''))}</li>`; continue; }
    if (!line.trim()) { if (inUl) { html += '</ul>'; inUl = false; } continue; }
    if (inUl) { html += '</ul>'; inUl = false; }
    html += `<p>${inline(line)}</p>`;
  }
  if (inUl) html += '</ul>';
  return html;
}

function renderMinutesHtml(m, communityName) {
  const typeLabel = { annual: 'Annual', regular: 'Regular', special: 'Special', executive: 'Executive Session', organizational: 'Organizational' }[m.meeting_type] || 'Board';
  const dateLabel = m.meeting_date ? new Date(m.meeting_date + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }) : '[meeting date]';
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    @page { size: Letter; margin: 0.9in 0.85in; }
    body { font-family: Georgia, 'Times New Roman', serif; color: #1a1a1a; font-size: 11.5pt; line-height: 1.5; }
    .hdr { border-bottom: 3px solid #D4AF37; padding-bottom: 10px; margin-bottom: 18px; }
    .hdr .co { font-family: Inter, Arial, sans-serif; font-size: 9pt; letter-spacing: .18em; text-transform: uppercase; color: #0B1D34; font-weight: 700; }
    .hdr h1 { font-family: Inter, Arial, sans-serif; font-size: 18pt; color: #0B1D34; margin: 6px 0 2px; }
    .hdr .meta { color: #555; font-size: 10.5pt; }
    h2 { font-family: Inter, Arial, sans-serif; font-size: 12.5pt; color: #0B1D34; border-bottom: 1px solid #e5e7eb; padding-bottom: 3px; margin: 18px 0 6px; }
    ul { margin: 4px 0 8px 0; } li { margin: 2px 0; } p { margin: 5px 0; }
    .foot { margin-top: 26px; border-top: 1px solid #e5e7eb; padding-top: 8px; font-size: 8.5pt; color: #94a3b8; font-family: Inter, Arial, sans-serif; }
  </style></head><body>
    <div class="hdr">
      <div class="co">${esc(communityName)}</div>
      <h1>${typeLabel} Meeting Minutes</h1>
      <div class="meta">${dateLabel}${m.location ? ' &middot; ' + esc(m.location) : ''}</div>
    </div>
    ${mdToHtml(m.body_markdown || '_No content._')}
    <div class="foot">Minutes prepared by Bedrock Association Management on behalf of ${esc(communityName)}. Official record of the Association.</div>
  </body></html>`;
}

// --- POST /:id/finalize — render + file as association record ---------------
router.post('/:id/finalize', express.json(), async (req, res) => {
  let browser;
  try {
    const { data: m } = await supabase.from('meeting_minutes').select('*, communities:community_id(name, management_company_id)').eq('id', req.params.id).maybeSingle();
    if (!m) return res.status(404).json({ error: 'not_found' });
    if (!m.body_markdown || m.body_markdown.trim().length < 20) return res.status(400).json({ error: 'empty_minutes', hint: 'Draft or write the minutes before finalizing.' });
    const communityName = (m.communities && m.communities.name) || 'the Association';
    const mgmtCoId = (m.communities && m.communities.management_company_id) || BEDROCK_MGMT_CO_ID;

    const html = renderMinutesHtml(m, communityName);
    browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 30000 });
    const pdfBuffer = Buffer.from(await page.pdf({ format: 'Letter', printBackground: true, preferCSSPageSize: true }));
    await browser.close(); browser = null;

    const sha = crypto.createHash('sha256').update(pdfBuffer).digest('hex');
    const safe = `minutes-${(m.meeting_date || 'undated')}-${m.meeting_type}.pdf`;
    const storagePath = `minutes/${m.community_id}/${sha.slice(0, 12)}-${safe}`;
    const { error: upErr } = await supabase.storage.from('documents').upload(storagePath, pdfBuffer, { contentType: 'application/pdf', upsert: true });
    if (upErr && !/already exists/i.test(upErr.message)) throw upErr;

    // File as an association record in the document library.
    const category = m.meeting_type === 'annual' ? 'annual_board_meeting_minutes' : 'regular_meeting_minutes';
    const title = `${communityName} — ${m.title || 'Meeting Minutes'}${m.meeting_date ? ' (' + m.meeting_date + ')' : ''}`;
    let docId = m.rendered_document_id;
    const { data: existing } = await supabase.from('library_documents').select('id').eq('file_hash', sha).maybeSingle();
    if (existing) docId = existing.id;
    else {
      const { data: doc, error: dErr } = await supabase.from('library_documents').insert({
        management_company_id: mgmtCoId, community_id: m.community_id, category, title,
        file_name_original: safe, file_path: storagePath, file_hash: sha, file_size_bytes: pdfBuffer.length,
        created_by_mgmt_company: 'Bedrock', source_origin: 'minutes_module', uploaded_at: new Date().toISOString(),
      }).select('id').single();
      if (dErr) throw dErr;
      docId = doc.id;
    }

    const { data: updated, error: uErr } = await supabase.from('meeting_minutes')
      .update({ status: 'final', finalized_at: new Date().toISOString(), finalized_by: (req.body && req.body.finalized_by) || 'staff', rendered_document_id: docId })
      .eq('id', m.id).select('*').single();
    if (uErr) throw uErr;

    // Seal an immutable, hash-verified copy of exactly what was finalized, and
    // log it — minutes are an association record that must not change once
    // filed. Reopen is admin-only via /api/records/minutes/:id/reopen.
    // (Ed 2026-07-18) Non-fatal; degrades gracefully before migration 312.
    const version = (Number(m.finalized_version) || 0) + 1;
    try {
      const { sealFinalizedRecord } = require('../lib/record_archive');
      const sealed = await sealFinalizedRecord(supabase, {
        record_type: 'minutes', record_id: m.id, community_id: m.community_id || null,
        archive_path: `minutes/${m.community_id || 'unknown'}/${m.id}-v${version}.pdf`,
        buffer: pdfBuffer, sent_at: new Date().toISOString(), metadata: { version, title },
      });
      await supabase.from('meeting_minutes').update({ finalized_version: version }).eq('id', m.id);
      await supabase.from('record_finalization_log').insert({
        record_type: 'minutes', record_id: m.id, community_id: m.community_id || null,
        action: 'finalize', version, archive_path: sealed && sealed.archive_path,
        sha256: (sealed && sealed.sha256) || sha, actor_email: (req.body && req.body.finalized_by) || 'staff',
      });
    } catch (sealErr) { console.warn('[minutes] seal/log failed (non-fatal):', sealErr.message); }

    res.json({ ok: true, minutes: updated, library_document_id: docId, finalized_version: version });
  } catch (err) {
    if (browser) { try { await browser.close(); } catch (_) {} }
    console.error('[minutes] finalize failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// --- GET /:id/pdf — the rendered minutes ------------------------------------
router.get('/:id/pdf', async (req, res) => {
  let browser;
  try {
    const { data: m } = await supabase.from('meeting_minutes').select('*, communities:community_id(name)').eq('id', req.params.id).maybeSingle();
    if (!m) return res.status(404).json({ error: 'not_found' });
    const communityName = (m.communities && m.communities.name) || 'the Association';
    const html = renderMinutesHtml(m, communityName);
    browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 30000 });
    const pdfBuffer = Buffer.from(await page.pdf({ format: 'Letter', printBackground: true, preferCSSPageSize: true }));
    await browser.close(); browser = null;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `${req.query.inline === '1' ? 'inline' : 'attachment'}; filename="minutes-${m.meeting_date || 'draft'}.pdf"`);
    res.end(pdfBuffer);
  } catch (err) {
    if (browser) { try { await browser.close(); } catch (_) {} }
    console.error('[minutes] pdf failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

module.exports = { router };
