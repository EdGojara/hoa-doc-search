// ============================================================================
// api/tessa.js — mounted at /api/tessa. Ed's executive assistant, Tessa McCall.
// ----------------------------------------------------------------------------
// OWNER-ONLY (requireOwner — Ed's email, not merely any admin). Draft an email from a thought, review, send it (as Ed
// or as Tessa), and track Ed's personal follow-ups. Payment items belong to
// Emma, not here — Tessa handles Ed's correspondence + admin/banking/vendor
// chase-ups, not AP.
// ============================================================================
const express = require('express');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');
const { requireOwner } = require('./_require_admin');
const { draftEmail } = require('../lib/ea/tessa');
const { pollTessaInbox } = require('../lib/ea/tessa_inbox');
const { transcribeAudio, routeDictation, sttConfigured } = require('../lib/ea/tessa_voice');
const graphSend = require('../lib/email/graph_send');
const { safeErrorMessage } = require('./_safe_error');

const uploadAudio = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 1 } });

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const router = express.Router();
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const parseAddrs = (v) => String(v || '').split(/[,;]/).map((s) => s.trim()).filter((s) => EMAIL_RE.test(s));

// POST /draft — turn a thought into a send-ready email (nothing sent).
router.post('/draft', express.json({ limit: '32kb' }), async (req, res) => {
  const admin = await requireOwner(req, res); if (!admin) return;
  try {
    const { thought, mode, recipient_name } = req.body || {};
    if (!thought || !String(thought).trim()) return res.status(400).json({ error: 'thought_required' });
    const draft = await draftEmail({ thought, mode: mode === 'ed' ? 'ed' : 'tessa', recipientName: recipient_name || null });
    if (draft.degraded) return res.status(503).json({ error: 'Tessa could not draft this right now. Try again or write it yourself.' });
    res.json({ subject: draft.subject, body: draft.body, mode: draft.mode });
  } catch (err) {
    console.error('[tessa] draft failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// POST /send — send the approved draft, as Ed (ghostwrite) or as Tessa.
router.post('/send', express.json({ limit: '64kb' }), async (req, res) => {
  const admin = await requireOwner(req, res); if (!admin) return;
  try {
    if (!graphSend.isConfigured()) return res.status(400).json({ error: 'Email is not connected yet (Microsoft Graph credentials + the mailbox must be set up).' });
    const b = req.body || {};
    const to = parseAddrs(b.to), cc = parseAddrs(b.cc);
    const subject = String(b.subject || '').trim() || '(no subject)';
    const body = String(b.body || '').trim();
    const asEd = String(b.mode || '') === 'ed';
    if (!to.length) return res.status(400).json({ error: 'Add at least one valid recipient.' });
    if (!body) return res.status(400).json({ error: 'The email body is empty.' });

    const from = asEd ? graphSend.ED_MAILBOX : graphSend.TESSA_MAILBOX;
    const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.55;color:#1a2230;">${body.split(/\n{2,}/).map((p) => `<p style="margin:0 0 12px;">${p.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br>')}</p>`).join('')}</div>`;
    await graphSend.sendAs({ from, to, cc, subject, html });

    // Log the outbound (best-effort; a log failure never blocks the send).
    try {
      await supabase.from('email_messages').insert({
        mailbox: from, direction: 'outbound', sender_email: from,
        sender_name: asEd ? 'Ed Gojara' : 'Tessa McCall (Bedrock EA)',
        recipients: [...to, ...cc], subject, body_preview: body.slice(0, 2000),
        classification: 'outbound_reply', classification_confidence: 'high',
        ai_summary: `Tessa sent ${asEd ? 'as Ed' : 'as Tessa'} to ${[...to, ...cc].join(', ')}`,
        triage_status: 'handled', reviewed_at: new Date().toISOString(),
      });
    } catch (e) { console.warn('[tessa] send-log skipped:', e.message); }

    // Optionally spin a follow-up so Tessa can chase it.
    let followup = null;
    if (b.create_followup) {
      const { data } = await supabase.from('ea_followups').insert({
        title: b.followup_title || `Follow up: ${subject}`, detail: b.followup_detail || null,
        category: ['admin', 'banking', 'vendor', 'personal', 'other'].includes(b.followup_category) ? b.followup_category : 'other',
        status: 'waiting', waiting_on: to[0] || null, due_date: b.followup_due_date || null, created_by: 'tessa',
      }).select('id').single();
      followup = data ? data.id : null;
    }
    res.json({ sent: true, from, to, cc, followup_id: followup });
  } catch (err) {
    console.error('[tessa] send failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// POST /voice — Ed dictates; transcribe, then route into an email draft and/or
// follow-up tasks. Nothing is sent or saved; the UI confirms. Owner-only.
router.post('/voice', uploadAudio.single('audio'), async (req, res) => {
  const admin = await requireOwner(req, res); if (!admin) return;
  try {
    if (!sttConfigured()) return res.status(400).json({ error: 'Voice is not connected yet (transcription key missing).' });
    if (!req.file || !req.file.buffer || !req.file.buffer.length) return res.status(400).json({ error: 'No audio came through. Try recording again.' });
    let transcript = '';
    try { transcript = await transcribeAudio(req.file.buffer, req.file.mimetype); }
    catch (e) {
      console.error('[tessa] transcribe failed:', e.message, e.detail || '');
      return res.status(502).json({ error: 'Tessa could not hear that clearly. Try again in a quieter spot.' });
    }
    if (!transcript) return res.status(200).json({ transcript: '', summary: '', email: null, tasks: [], note: 'Nothing was picked up.' });
    const routed = await routeDictation(transcript);
    res.json({ transcript, summary: routed.summary || '', email: routed.email, tasks: routed.tasks || [] });
  } catch (err) {
    console.error('[tessa] voice failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// POST /followups/bulk — add several follow-ups at once (from a dictation).
router.post('/followups/bulk', express.json({ limit: '32kb' }), async (req, res) => {
  const admin = await requireOwner(req, res); if (!admin) return;
  try {
    const items = Array.isArray(req.body && req.body.tasks) ? req.body.tasks : [];
    if (!items.length) return res.status(400).json({ error: 'no_tasks' });
    const cats = ['admin', 'banking', 'vendor', 'personal', 'other'];
    const rows = items.filter((x) => x && x.title && String(x.title).trim()).slice(0, 25).map((x) => ({
      title: String(x.title).trim(), detail: x.detail || null,
      category: cats.includes(x.category) ? x.category : 'other',
      status: x.waiting_on ? 'waiting' : 'open', waiting_on: x.waiting_on || null,
      due_date: x.due_date || null, created_by: 'tessa-voice',
    }));
    if (!rows.length) return res.status(400).json({ error: 'no_valid_tasks' });
    const { data, error } = await supabase.from('ea_followups').insert(rows).select('id');
    if (error) throw error;
    res.json({ added: data ? data.length : 0 });
  } catch (err) { res.status(500).json({ error: safeErrorMessage(err) }); }
});

// ---- Follow-up ledger --------------------------------------------------------
router.get('/followups', async (req, res) => {
  const admin = await requireOwner(req, res); if (!admin) return;
  try {
    let q = supabase.from('ea_followups').select('*').order('due_date', { ascending: true, nullsFirst: false }).order('created_at', { ascending: false }).limit(500);
    const status = req.query.status;
    if (status === 'active') q = q.in('status', ['open', 'waiting']);
    else if (status) q = q.eq('status', status);
    const { data, error } = await q;
    if (error) throw error;
    res.json({ followups: data || [] });
  } catch (err) { res.status(500).json({ error: safeErrorMessage(err) }); }
});

router.post('/followups', express.json(), async (req, res) => {
  const admin = await requireOwner(req, res); if (!admin) return;
  try {
    const b = req.body || {};
    if (!b.title || !String(b.title).trim()) return res.status(400).json({ error: 'title_required' });
    const { data, error } = await supabase.from('ea_followups').insert({
      title: String(b.title).trim(), detail: b.detail || null,
      category: ['admin', 'banking', 'vendor', 'personal', 'other'].includes(b.category) ? b.category : 'other',
      status: 'open', waiting_on: b.waiting_on || null, due_date: b.due_date || null, created_by: admin.full_name || admin.email || 'Ed',
    }).select('*').single();
    if (error) throw error;
    res.json({ followup: data });
  } catch (err) { res.status(500).json({ error: safeErrorMessage(err) }); }
});

router.patch('/followups/:id', express.json(), async (req, res) => {
  const admin = await requireOwner(req, res); if (!admin) return;
  try {
    const b = req.body || {}; const patch = {};
    if (b.status !== undefined) { if (!['open', 'waiting', 'done', 'dropped'].includes(b.status)) return res.status(400).json({ error: 'bad_status' }); patch.status = b.status; }
    if (b.category !== undefined) { if (!['admin', 'banking', 'vendor', 'personal', 'other'].includes(b.category)) return res.status(400).json({ error: 'bad_category' }); patch.category = b.category; }
    if (b.title !== undefined) patch.title = String(b.title);
    if (b.detail !== undefined) patch.detail = b.detail || null;
    if (b.waiting_on !== undefined) patch.waiting_on = b.waiting_on || null;
    if (b.due_date !== undefined) patch.due_date = b.due_date || null;
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'no_fields' });
    patch.updated_at = new Date().toISOString();
    const { data, error } = await supabase.from('ea_followups').update(patch).eq('id', req.params.id).select('*').single();
    if (error) throw error;
    res.json({ followup: data });
  } catch (err) { res.status(500).json({ error: safeErrorMessage(err) }); }
});

// ---- Forwarded-inbox: emails Ed sends Tessa, she drafts a reply -------------

// POST /poll-inbox — pull new tessa@ mail, draft a reply for each, queue it.
// Owner-only, and reads ONLY into ea_inbox (never the staff triage table).
router.post('/poll-inbox', async (req, res) => {
  const admin = await requireOwner(req, res); if (!admin) return;
  try {
    const out = await pollTessaInbox({ max: 25, mode: 'ed' });
    if (out.error) {
      const hint = out.error.startsWith('graph_read_failed_403')
        ? 'Tessa can’t read her mailbox yet. In Azure, add tessa@bedrocktx.com to the app’s Mail.Read access policy.'
        : out.error === 'graph_not_configured'
        ? 'Email is not connected yet (Microsoft Graph credentials must be set up).'
        : out.error === 'tessa_mailbox_not_configured'
        ? 'Tessa’s mailbox (TESSA_MAILBOX) is not set in the environment yet.'
        : 'Could not read Tessa’s mailbox right now.';
      return res.status(400).json({ error: hint, code: out.error });
    }
    res.json({ ok: true, ...out });
  } catch (err) {
    console.error('[tessa] poll-inbox failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// GET /inbox — the review queue (defaults to items still needing review).
router.get('/inbox', async (req, res) => {
  const admin = await requireOwner(req, res); if (!admin) return;
  try {
    let q = supabase.from('ea_inbox').select('*').order('received_at', { ascending: false, nullsFirst: false }).limit(200);
    const status = req.query.status || 'needs_review';
    if (status !== 'all') q = q.eq('status', status);
    const { data, error } = await q;
    if (error) throw error;
    res.json({ inbox: data || [] });
  } catch (err) { res.status(500).json({ error: safeErrorMessage(err) }); }
});

// PATCH /inbox/:id — edit the draft, or mark replied / dismissed.
router.patch('/inbox/:id', express.json(), async (req, res) => {
  const admin = await requireOwner(req, res); if (!admin) return;
  try {
    const b = req.body || {}; const patch = {};
    if (b.status !== undefined) { if (!['needs_review', 'replied', 'dismissed'].includes(b.status)) return res.status(400).json({ error: 'bad_status' }); patch.status = b.status; }
    if (b.draft_subject !== undefined) patch.draft_subject = String(b.draft_subject || '');
    if (b.draft_body !== undefined) patch.draft_body = String(b.draft_body || '');
    if (b.draft_mode !== undefined) { if (!['ed', 'tessa'].includes(b.draft_mode)) return res.status(400).json({ error: 'bad_mode' }); patch.draft_mode = b.draft_mode; }
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'no_fields' });
    patch.updated_at = new Date().toISOString();
    const { data, error } = await supabase.from('ea_inbox').update(patch).eq('id', req.params.id).select('*').single();
    if (error) throw error;
    res.json({ item: data });
  } catch (err) { res.status(500).json({ error: safeErrorMessage(err) }); }
});

// POST /inbox/:id/send — send the reviewed reply (as Ed or Tessa) + mark replied.
router.post('/inbox/:id/send', express.json({ limit: '64kb' }), async (req, res) => {
  const admin = await requireOwner(req, res); if (!admin) return;
  try {
    if (!graphSend.isConfigured()) return res.status(400).json({ error: 'Email is not connected yet (Microsoft Graph credentials + the mailbox must be set up).' });
    const { data: item, error: e0 } = await supabase.from('ea_inbox').select('*').eq('id', req.params.id).single();
    if (e0 || !item) return res.status(404).json({ error: 'not_found' });

    const b = req.body || {};
    const to = parseAddrs(b.to || item.from_email);
    const cc = parseAddrs(b.cc);
    const subject = String(b.subject || item.draft_subject || item.subject || '').trim() || '(no subject)';
    const body = String(b.body || item.draft_body || '').trim();
    const asEd = String(b.mode || item.draft_mode || 'ed') === 'ed';
    if (!to.length) return res.status(400).json({ error: 'No recipient to reply to.' });
    if (!body) return res.status(400).json({ error: 'The reply body is empty.' });

    const from = asEd ? graphSend.ED_MAILBOX : graphSend.TESSA_MAILBOX;
    const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.55;color:#1a2230;">${body.split(/\n{2,}/).map((p) => `<p style="margin:0 0 12px;">${p.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br>')}</p>`).join('')}</div>`;
    await graphSend.sendAs({ from, to, cc, subject, html });

    await supabase.from('ea_inbox').update({ status: 'replied', draft_subject: subject, draft_body: body, draft_mode: asEd ? 'ed' : 'tessa', updated_at: new Date().toISOString() }).eq('id', item.id);
    try {
      await supabase.from('email_messages').insert({
        mailbox: from, direction: 'outbound', sender_email: from,
        sender_name: asEd ? 'Ed Gojara' : 'Tessa McCall (Bedrock EA)',
        recipients: [...to, ...cc], subject, body_preview: body.slice(0, 2000),
        classification: 'outbound_reply', classification_confidence: 'high',
        ai_summary: `Tessa reply ${asEd ? 'as Ed' : 'as Tessa'} to ${[...to, ...cc].join(', ')}`,
        triage_status: 'handled', reviewed_at: new Date().toISOString(),
      });
    } catch (e) { console.warn('[tessa] inbox-send log skipped:', e.message); }
    res.json({ sent: true, from, to, cc });
  } catch (err) {
    console.error('[tessa] inbox-send failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

module.exports = { router };
