// ============================================================================
// api/amanda_email.js  (Ed 2026-10-06) — Amanda's email desk, mounted at /api/amanda/email
// ----------------------------------------------------------------------------
// Kept apart from api/amanda.js on purpose: that file is the Amanda REQUEST
// contract (POST only, proposals only, never touches mail) and its tests pin it.
// This router prepares and lists Amanda's email; it still never sends. Release
// goes through POST /api/email-drafts/:id/send (Amanda's signature, recorded).
// Admin-gated, same audience as the Amanda Operations card.
// ============================================================================
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { requireAdmin } = require('./_require_admin');
const { safeErrorMessage } = require('./_safe_error');

const router = express.Router();
router.use(express.json({ limit: '64kb' }));
let _sb = null;
const sb = () => (_sb || (_sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY)));

// Model calls cost money: at most 20 drafts / asks per person per 10 minutes.
const WINDOW_MS = 10 * 60 * 1000; const MAX_PER_WINDOW = 20;
const hits = new Map();
function rateLimited(key, now = Date.now()) {
  const arr = (hits.get(key) || []).filter((t) => now - t < WINDOW_MS);
  if (arr.length >= MAX_PER_WINDOW) { hits.set(key, arr); return true; }
  arr.push(now); hits.set(key, arr); return false;
}

// ---------------------------------------------------------------------------
// Amanda's email desk (Ed 2026-10-06). Same audience as the card (requireAdmin).
// Prepares and lists only: nothing here sends. A prepared email is staged in
// outbound_email_drafts and released through POST /api/email-drafts/:id/send,
// which builds it with Amanda's existing signature and records the result
// (success, or send_error that keeps it visible). See lib/amanda/email_console.js.
// ---------------------------------------------------------------------------
const desk = require('../lib/amanda/email_console');
// Amanda resolves people from the company directory (staff, vendors, community
// contacts, homeowners, correspondents), not from Ed's private address book.
const AMANDA_LOOKUP = { addressBook: false, staff: true };

// GET /api/amanda/email — outbox + reconciled recent activity (prepared, sent,
// blocked, failed). Source failures come back in source_errors, never hidden.
router.get('/', async (req, res) => {
  const u = await requireAdmin(req, res); if (!u) return;
  try {
    const days = Math.min(60, Math.max(1, Number(req.query.days) || 14));
    res.json({ ok: true, ...(await desk.loadEmailDesk(sb(), { days })) });
  } catch (e) {
    console.error('[amanda.email] load failed:', e.message);
    res.status(500).json({ ok: false, error: safeErrorMessage(e) });
  }
});

// POST /api/amanda/email/draft { to, cc?, recipient_name?, thought }
// Amanda writes it in her voice and stages it in her outbox for review.
router.post('/draft', async (req, res) => {
  const u = await requireAdmin(req, res); if (!u) return;
  const b = req.body || {};
  if (rateLimited(u.email)) return res.status(429).json({ ok: false, error: 'rate_limited' });
  const to = desk.parseAddresses(b.to);
  if (!to.length) return res.status(400).json({ ok: false, error: 'recipient_required', detail: 'Add at least one valid To address.' });
  if (!String(b.thought || '').trim()) return res.status(400).json({ ok: false, error: 'thought_required', detail: 'Tell Amanda what to say.' });
  try {
    const d = await desk.draftAmandaEmail({ thought: b.thought, recipientName: b.recipient_name || null });
    if (d.degraded) return res.status(503).json({ ok: false, error: 'draft_failed', detail: 'Amanda could not draft that one. Nothing was staged.' });
    const row = await desk.stageDraft(sb(), { to, cc: b.cc, toName: b.recipient_name, subject: d.subject, body: d.body, createdBy: u.email,
      reason: `Drafted from ${u.full_name || u.email}'s note; waiting for review.` });
    res.json({ ok: true, draft: { ...row, body_text: d.body } });
  } catch (e) {
    console.error('[amanda.email.draft] failed:', e.message);
    res.status(500).json({ ok: false, error: safeErrorMessage(e) });
  }
});

// POST /api/amanda/email/ask { text } — "Email Martha and Alisha about ...".
// Shared request runner (lib/ea/tessa_request.js runRequest): one parse, people
// resolved from the directory, anything unclear comes back as a question, never a
// guess. When every recipient resolves, the draft is staged for review.
router.post('/ask', async (req, res) => {
  const u = await requireAdmin(req, res); if (!u) return;
  const text = String((req.body || {}).text || '').trim();
  if (!text) return res.status(400).json({ ok: false, error: 'empty', detail: 'Tell Amanda who to email and what about.' });
  if (text.length > 2000) return res.status(400).json({ ok: false, error: 'too_long' });
  if (rateLimited(u.email)) return res.status(429).json({ ok: false, error: 'rate_limited' });
  try {
    const { runRequest } = require('../lib/ea/tessa_request');
    const { searchMailbox } = require('../lib/email/graph_search');
    const { resolveRecipient } = require('./tessa');
    const graphSend = require('../lib/email/graph_send');
    const out = await runRequest(text, {
      resolveRecipient: (h) => resolveRecipient(h, AMANDA_LOOKUP),
      searchMailbox,
      mailboxes: graphSend.isConfigured() ? [graphSend.AMANDA_MAILBOX] : [],
      draft: desk.draftAmandaEmail,
      onEdsBehalf: false,
    });
    if (out.degraded) return res.status(503).json({ ok: false, error: 'not_understood', detail: 'Amanda could not work that one out. Try saying it a different way.' });
    const people = (list) => (list || []).map((p) => ({ name: p.name || null, email: p.email || null }));
    const base = { to: people(out.to), cc: people(out.cc), questions: out.questions || [] };
    if (out.questions && out.questions.length) return res.json({ ok: true, staged: false, ...base, reply: 'Amanda needs a little more before she can prepare this.' });
    if (!out.to.length) return res.json({ ok: true, staged: false, ...base, reply: 'Amanda could not tell who this should go to. Name the people or paste their addresses.' });
    if (!out.draft) return res.status(503).json({ ok: false, ...base, error: 'draft_failed', detail: 'Amanda found the recipients but could not draft the email. Nothing was staged.' });
    const row = await desk.stageDraft(sb(), {
      to: out.to.map((p) => p.email), cc: out.cc.map((p) => p.email),
      toName: out.to.length === 1 ? out.to[0].name : null,
      subject: out.draft.subject, body: out.draft.body, createdBy: u.email,
      reason: `Asked by ${u.full_name || u.email}: "${text.slice(0, 300)}"`,
    });
    res.json({ ok: true, staged: true, ...base, draft: { ...row, body_text: out.draft.body }, reply: 'Prepared and waiting in Amanda’s outbox for review. Nothing was sent.' });
  } catch (e) {
    console.error('[amanda.email.ask] failed:', e.message);
    res.status(500).json({ ok: false, error: safeErrorMessage(e) });
  }
});

// ---------------------------------------------------------------------------
// Inbox: mail delivered to Amanda's mailbox, and Reply as Amanda (staged, never
// sent from here). Reads the same email_messages rows Communications reads; no
// second ingestion. See lib/amanda/email_inbox.js.
// ---------------------------------------------------------------------------
const inbox = require('../lib/amanda/email_inbox');

// GET /api/amanda/email/inbox — recent mail addressed to Amanda + reply status.
router.get('/inbox', async (req, res) => {
  const u = await requireAdmin(req, res); if (!u) return;
  try {
    const days = Math.min(90, Math.max(1, Number(req.query.days) || 30));
    res.json({ ok: true, ...(await inbox.loadInbox(sb(), { days })) });
  } catch (e) {
    console.error('[amanda.email.inbox] load failed:', e.message);
    res.status(500).json({ ok: false, error: safeErrorMessage(e) });
  }
});

// GET /api/amanda/email/inbox/:id — the full thread + reply prefill (to, subject, reply-all CC).
router.get('/inbox/:id', async (req, res) => {
  const u = await requireAdmin(req, res); if (!u) return;
  try {
    const t = await inbox.loadThread(sb(), req.params.id);
    if (!t) return res.status(404).json({ ok: false, error: 'not_found' });
    if (t.not_amanda) return res.status(404).json({ ok: false, error: 'not_in_amanda_inbox' });
    res.json({ ok: true, ...t });
  } catch (e) {
    console.error('[amanda.email.thread] failed:', e.message);
    res.status(500).json({ ok: false, error: safeErrorMessage(e) });
  }
});

// POST /api/amanda/email/inbox/:id/reply { body? | thought?, cc? }
// Stages Amanda's reply in her Outbox for review. `body` is used as written;
// `thought` is turned into her reply in her voice. Nothing is sent.
router.post('/inbox/:id/reply', async (req, res) => {
  const u = await requireAdmin(req, res); if (!u) return;
  const b = req.body || {};
  const written = String(b.body || '').trim();
  const thought = String(b.thought || '').trim();
  if (!written && !thought) return res.status(400).json({ ok: false, error: 'reply_required', detail: 'Write the reply, or tell Amanda what to say.' });
  if ((written || thought).length > 8000) return res.status(400).json({ ok: false, error: 'too_long' });
  try {
    const t = await inbox.loadThread(sb(), req.params.id);
    if (!t) return res.status(404).json({ ok: false, error: 'not_found' });
    if (t.not_amanda) return res.status(404).json({ ok: false, error: 'not_in_amanda_inbox' });
    let text = written;
    if (!text) {
      if (rateLimited(u.email)) return res.status(429).json({ ok: false, error: 'rate_limited' });
      const m = t.message;
      const d = await desk.draftAmandaEmail({
        recipientName: m.from_name || m.from_email,
        thought: `Write Amanda's REPLY to this email. Reply body only (greeting through sign-off); the original is quoted automatically below it, so do not repeat it.\n\n`
          + `From: ${m.from_name || ''} <${m.from_email || ''}>\nSubject: ${m.subject || ''}\n${m.community ? 'Community: ' + m.community + '\n' : ''}\n${String(m.body || '').slice(0, 6000)}\n\n`
          + `What the reply should say: ${thought}`,
      });
      if (d.degraded) return res.status(503).json({ ok: false, error: 'draft_failed', detail: 'Amanda could not draft that reply. Nothing was staged.' });
      text = d.body;
    }
    const row = await inbox.stageReply(sb(), { message: t.message, body: text, cc: b.cc, createdBy: u.email,
      reason: written ? `Reply written by ${u.full_name || u.email}; waiting for review.` : `Reply drafted from ${u.full_name || u.email}'s note: "${thought.slice(0, 300)}"` });
    res.json({ ok: true, staged: true, draft: row, threaded_reply: t.message.threaded_reply_possible,
      reply: (row.replaced ? 'Updated the reply waiting in Amanda’s outbox.' : 'Reply staged in Amanda’s outbox for review.') + ' Nothing was sent.' });
  } catch (e) {
    console.error('[amanda.email.reply] failed:', e.message);
    res.status(500).json({ ok: false, error: safeErrorMessage(e) });
  }
});


module.exports = router;
