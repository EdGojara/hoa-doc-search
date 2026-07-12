// ============================================================================
// api/tessa.js — mounted at /api/tessa. Ed's executive assistant, Tessa McCall.
// ----------------------------------------------------------------------------
// OWNER-ONLY (requireOwner — Ed's email, not merely any admin). Draft an email from a thought, review, send it (as Ed
// or as Tessa), and track Ed's personal follow-ups. Payment items belong to
// Emma, not here — Tessa handles Ed's correspondence + admin/banking/vendor
// chase-ups, not AP.
// ============================================================================
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { requireOwner } = require('./_require_admin');
const { draftEmail } = require('../lib/ea/tessa');
const graphSend = require('../lib/email/graph_send');
const { safeErrorMessage } = require('./_safe_error');

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

module.exports = { router };
