// ============================================================================
// api/agent_desk.js  (Ed 2026-10-22) — the AI employee email desk, mounted at /api/agents
//
//   GET  /desks                                   the agents with a desk (roster email_desk)
//   GET  /:persona/email/inbox                    their correspondence + reply status
//   GET  /:persona/email/inbox/:id                the thread, Reply all prefill, sending mailbox
//   POST /:persona/email/inbox/:id/reply          stage a reply in THEIR outbox (never sends)
//   POST /:persona/email/inbox/:id/reassign       hand the message to another agent's desk
//   GET  /:persona/email/outbox                   their drafts and sent replies
//
// Sending is the existing approval route, POST /api/email-drafts/:id/send, which needs the
// signed-in approver, refuses a draft opened on another agent's desk (desk_persona), replies
// in the original thread when possible and records who approved it. One implementation for
// every agent: lib/email/agent_desk.js. Amanda's original routes (/api/amanda/email) remain.
// ============================================================================
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { safeErrorMessage } = require('./_safe_error');
const { requireAdmin } = require('./_require_admin');
const desk = require('../lib/email/agent_desk');

const router = express.Router();
router.use(express.json({ limit: '64kb' }));
let _sb = null;
const sb = () => (_sb || (_sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY)));

const recent = new Map();
function rateLimited(email) { const now = Date.now(); const xs = (recent.get(email) || []).filter((t) => now - t < 60000); xs.push(now); recent.set(email, xs); return xs.length > 12; }
function deskOr404(req, res) {
  try { return desk.deskFor(req.params.persona); }
  catch (_) { res.status(404).json({ ok: false, error: 'no_email_desk', detail: `${req.params.persona} has no email desk.` }); return null; }
}
const fail = (res, where, e) => { console.error(`[agent_desk] ${where} failed:`, e.message); res.status(500).json({ ok: false, error: safeErrorMessage(e) }); };

router.get('/desks', async (req, res) => {
  const u = await requireAdmin(req, res); if (!u) return;
  try { res.json({ ok: true, desks: desk.desks() }); } catch (e) { fail(res, 'desks', e); }
});

router.get('/:persona/email/inbox', async (req, res) => {
  const u = await requireAdmin(req, res); if (!u) return;
  if (!deskOr404(req, res)) return;
  try {
    const days = Math.min(90, Math.max(1, Number(req.query.days) || 30));
    res.json({ ok: true, ...(await desk.loadInbox(sb(), req.params.persona, { days })) });
  } catch (e) { fail(res, 'inbox', e); }
});

router.get('/:persona/email/inbox/:id', async (req, res) => {
  const u = await requireAdmin(req, res); if (!u) return;
  if (!deskOr404(req, res)) return;
  try {
    const t = await desk.loadThread(sb(), req.params.persona, req.params.id);
    if (!t) return res.status(404).json({ ok: false, error: 'not_found' });
    if (t.not_on_desk) return res.status(404).json({ ok: false, error: 'not_on_this_desk' });
    res.json({ ok: true, ...t });
  } catch (e) { fail(res, 'thread', e); }
});

// POST { body? | thought?, reply_mode? ('all' default | 'sender'), cc?, follow_up? }
// `body` is used as written; `thought` is drafted in the agent's own voice on a fact basis
// from the records that cover the topic. Nothing is sent.
router.post('/:persona/email/inbox/:id/reply', async (req, res) => {
  const u = await requireAdmin(req, res); if (!u) return;
  const d = deskOr404(req, res); if (!d) return;
  const b = req.body || {};
  const written = String(b.body || '').trim(); const thought = String(b.thought || '').trim();
  if (!written && !thought) return res.status(400).json({ ok: false, error: 'reply_required', detail: `Write the reply, or tell ${d.name.split(' ')[0]} what to say.` });
  if ((written || thought).length > 8000) return res.status(400).json({ ok: false, error: 'too_long' });
  try {
    const t = await desk.loadThread(sb(), d.persona, req.params.id);
    if (!t) return res.status(404).json({ ok: false, error: 'not_found' });
    if (t.not_on_desk) return res.status(404).json({ ok: false, error: 'not_on_this_desk' });
    if (t.already_replied && b.follow_up !== true) {
      return res.status(409).json({ ok: false, error: 'already_replied', detail: `${d.name} already replied in this thread from ${d.mailbox} on ${String(t.already_replied.at).slice(0, 16).replace('T', ' ')} UTC${t.already_replied.approved_by ? ` (approved by ${t.already_replied.approved_by})` : ''}. Nothing new was prepared. Ask for a follow-up explicitly if one is needed.`, already_replied: t.already_replied });
    }
    // Check the records that cover this message BEFORE drafting (narrow: only covered topics).
    const OF = require('../lib/agents/operational_facts');
    const facts = await OF.factsFor(sb(), d, t.message);
    let text = written;
    if (!text) {
      if (rateLimited(u.email)) return res.status(429).json({ ok: false, error: 'rate_limited' });
      const m = t.message;
      if (d.persona === 'amanda') {
        let att = { blocks: [], summary: '' };
        if (m.graph_id) { try { att = await require('../lib/email/graph_attachments').fetchAttachmentBlocks(m.mailbox, m.graph_id); } catch (_) {} }
        const dr = await require('../lib/amanda/email_console').draftAmandaEmail({
          attachmentBlocks: att.blocks || [], attachmentSummary: att.summary || '', recipientName: m.from_name || m.from_email,
          thought: `Write Amanda's REPLY to this email. Reply body only (greeting through sign-off); the original is quoted automatically below it, so do not repeat it.\n\n`
            + `From: ${m.from_name || ''} <${m.from_email || ''}>\nSubject: ${m.subject || ''}\n${m.community ? 'Community: ' + m.community + '\n' : ''}\n${String(m.body || '').slice(0, 6000)}\n\nWhat the reply should say: ${thought}`,
        });
        if (dr.degraded) return res.status(503).json({ ok: false, error: 'draft_failed', detail: 'Amanda could not draft that reply. Nothing was staged.' });
        text = dr.body;
      } else {
        const { draftReply } = require('../lib/email/draft_reply');
        const dr = await draftReply({
          email: { subject: m.subject, body_full: m.body, body_preview: String(m.body || '').slice(0, 500), conversation_id: m.conversation_id, sender_email: m.from_email, graph_id: m.graph_id, mailbox: m.mailbox },
          classification: 'vendor_general', communityId: m.community_id || null, communityName: m.community || null, contactName: m.from_name || null,
          force: true, persona: d.persona, notes: `What the reply should say (from ${u.full_name || u.email}): ${thought}`, factBasis: facts.basis || undefined,
        });
        if (!dr || !dr.body) return res.status(503).json({ ok: false, error: 'draft_failed', detail: `${d.name} could not draft that reply. Nothing was staged.` });
        text = dr.body;
      }
    }
    const check = OF.checkDraft(text, facts);
    const rcpt = desk.replyRecipients(d, t, { mode: b.reply_mode === 'sender' ? 'sender' : 'all', extraCc: b.cc });
    const row = await desk.stageReply(sb(), d.persona, { thread: t, body: text, cc: rcpt.cc.join(', '), createdBy: u.email, followUp: b.follow_up === true,
      factCheck: { checked: check.checked, issues: check.issues, note: check.note, basis: facts.basis },
      reason: (written ? `Reply written by ${u.full_name || u.email}` : `Reply drafted from ${u.full_name || u.email}'s note: "${thought.slice(0, 300)}"`)
        + ` (${rcpt.mode === 'all' ? 'reply all' : 'reply to sender only'}); waiting for review.` });
    res.json({ ok: true, staged: true, draft: row, reply_mode: rcpt.mode, sends_from: d.mailbox, in_thread: t.reply.in_thread, threading: t.reply.threading,
      fact_check: check, reply: `${row.replaced ? 'Updated the reply' : 'Reply staged'} in ${d.name}'s outbox. It sends from ${d.mailbox} only after a person approves it. Nothing was sent.` });
  } catch (e) {
    if (e.code === 'already_replied') return res.status(409).json({ ok: false, error: 'already_replied', already_replied: e.detail });
    if (e.code === 'reply_staged_by_another_agent') return res.status(409).json({ ok: false, error: 'reply_staged_by_another_agent', detail: `A reply to this email is already waiting on ${e.detail}'s desk.` });
    fail(res, 'reply', e);
  }
});

router.post('/:persona/email/inbox/:id/reassign', async (req, res) => {
  const u = await requireAdmin(req, res); if (!u) return;
  if (!deskOr404(req, res)) return;
  try {
    const to = String((req.body || {}).to || '').toLowerCase();
    try { desk.deskFor(to); } catch (_) { return res.status(400).json({ ok: false, error: 'unknown_desk', detail: `${to || '(none)'} has no email desk.` }); }
    res.json({ ok: true, ...(await desk.reassign(sb(), req.params.persona, req.params.id, { to, by: u.email })) });
  } catch (e) {
    if (e.code === 'not_on_desk') return res.status(404).json({ ok: false, error: 'not_on_this_desk' });
    fail(res, 'reassign', e);
  }
});

router.get('/:persona/email/outbox', async (req, res) => {
  const u = await requireAdmin(req, res); if (!u) return;
  if (!deskOr404(req, res)) return;
  try { res.json({ ok: true, ...(await desk.loadOutbox(sb(), req.params.persona)) }); } catch (e) { fail(res, 'outbox', e); }
});

module.exports = router;
