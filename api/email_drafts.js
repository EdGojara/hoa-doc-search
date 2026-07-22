// ============================================================================
// api/email_drafts.js  (Ed 2026-07-22)
// ----------------------------------------------------------------------------
// The DRAFT QUEUE surface. Homeowner-facing outbound mail (persona replies, ACC
// acknowledgments, decision letters) is queued here as status='draft' instead
// of sending. Ed reviews, edits the plain body if he wants, and clicks Send —
// POST /:id/send is the ONLY endpoint that calls Graph. Nothing leaves without
// that click.
//
// On send, a persona wrapper (Annie's branded signature + inline logo) is
// re-rendered from the edited plain body, and any stored file attachments are
// pulled from the documents bucket and base64-encoded for Graph.
// ============================================================================
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const graphSend = require('../lib/email/graph_send');
const { buildAnnieEmail } = require('../lib/email/annie_signature');

const router = express.Router();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

function safe(err) { return require('./_safe_error').safeErrorMessage ? require('./_safe_error').safeErrorMessage(err) : 'Something went wrong'; }
function _isMissingTable(err) {
  const m = `${err && err.message || ''} ${err && err.code || ''}`;
  return /could not find|does not exist|42P01|42703|PGRST20[45]|schema cache/i.test(m);
}

// persona -> { mailbox, build(bodyText, communityName) -> {html, attachments} }
const PERSONA = {
  annie: { mailbox: graphSend.ANNIE_MAILBOX, build: buildAnnieEmail },
};
function personaMailbox(p, fallback) {
  return (PERSONA[p] && PERSONA[p].mailbox) || fallback || graphSend.CLAIRE_MAILBOX;
}

// GET /api/email-drafts?status=draft&community_id=...
router.get('/', async (req, res) => {
  try {
    let q = supabase.from('outbound_email_drafts')
      .select('id, community_id, community_name, persona, to_email, to_name, cc, subject, body_text, draft_kind, related_type, related_id, draft_reason, status, created_at, sent_at, send_error')
      .order('created_at', { ascending: false }).limit(500);
    const status = (req.query.status || 'draft').toString();
    if (status !== 'all') q = q.eq('status', status);
    if (req.query.community_id) q = q.eq('community_id', req.query.community_id);
    const { data, error } = await q;
    if (error) {
      if (_isMissingTable(error)) return res.json({ drafts: [], migration_pending: true });
      throw error;
    }
    res.json({ drafts: data || [] });
  } catch (err) {
    console.error('[email_drafts] list failed:', err.message);
    res.status(500).json({ error: safe(err) });
  }
});

// GET /api/email-drafts/:id
router.get('/:id', async (req, res) => {
  try {
    const { data, error } = await supabase.from('outbound_email_drafts').select('*').eq('id', req.params.id).maybeSingle();
    if (error) { if (_isMissingTable(error)) return res.status(404).json({ error: 'not_found' }); throw error; }
    if (!data) return res.status(404).json({ error: 'not_found' });
    res.json({ draft: data });
  } catch (err) {
    console.error('[email_drafts] get failed:', err.message);
    res.status(500).json({ error: safe(err) });
  }
});

// PUT /api/email-drafts/:id  — edit to/subject/body/cc before sending.
router.put('/:id', async (req, res) => {
  try {
    const patch = {};
    for (const f of ['to_email', 'to_name', 'cc', 'subject', 'body_text', 'body_html']) {
      if (req.body[f] !== undefined) patch[f] = req.body[f];
    }
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'no_fields' });
    const { data, error } = await supabase.from('outbound_email_drafts')
      .update(patch).eq('id', req.params.id).eq('status', 'draft').select('id').maybeSingle();
    if (error) throw error;
    if (!data) return res.status(409).json({ error: 'not_editable' }); // already sent/discarded
    res.json({ ok: true });
  } catch (err) {
    console.error('[email_drafts] edit failed:', err.message);
    res.status(500).json({ error: safe(err) });
  }
});

// POST /api/email-drafts/:id/send  — approve + actually send. The gate.
router.post('/:id/send', async (req, res) => {
  try {
    const { data: d, error } = await supabase.from('outbound_email_drafts').select('*').eq('id', req.params.id).maybeSingle();
    if (error) throw error;
    if (!d) return res.status(404).json({ error: 'not_found' });
    if (d.status === 'sent') return res.status(409).json({ error: 'already_sent' });
    if (d.status === 'discarded') return res.status(409).json({ error: 'discarded' });
    if (!graphSend.isConfigured()) return res.status(400).json({ error: 'email not connected (Graph credentials missing)' });

    // Re-render the branded wrapper from the (possibly edited) plain body, so
    // what Ed edits is what goes out — signature + logo applied at send.
    const p = PERSONA[d.persona];
    let html = d.body_html || null;
    let personaAttachments = [];
    if (p && p.build && d.body_text) {
      const built = p.build(d.body_text, d.community_name);
      html = built.html; personaAttachments = built.attachments || [];
    } else if (!html && d.body_text) {
      html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.55;white-space:pre-wrap;">${d.body_text.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))}</div>`;
    }

    // Pull any stored file attachments from the documents bucket.
    const fileAttachments = [];
    for (const a of Array.isArray(d.attachments) ? d.attachments : []) {
      if (!a || !a.storage_path) continue;
      try {
        const { data: blob, error: dErr } = await supabase.storage.from('documents').download(a.storage_path);
        if (dErr) { console.warn('[email_drafts] attachment download failed:', a.storage_path, dErr.message); continue; }
        const buf = Buffer.from(await blob.arrayBuffer());
        fileAttachments.push({ '@odata.type': '#microsoft.graph.fileAttachment', name: a.name || 'attachment', contentType: a.mime || 'application/octet-stream', contentBytes: buf.toString('base64') });
      } catch (e) { console.warn('[email_drafts] attachment error:', e.message); }
    }

    const from = personaMailbox(d.persona, d.from_mailbox);
    const subject = d.subject || '(no subject)';
    try {
      await graphSend.sendAs({ from, to: d.to_email, cc: d.cc || undefined, subject, html, attachments: [...personaAttachments, ...fileAttachments] });
    } catch (e) {
      await supabase.from('outbound_email_drafts').update({ send_error: e.message }).eq('id', d.id);
      return res.status(502).json({ error: `send failed: ${e.message}` });
    }
    await supabase.from('outbound_email_drafts').update({
      status: 'sent', sent_at: new Date().toISOString(), sent_from: from,
      approved_by: req.body.approved_by || 'staff', send_error: null,
      record_ownership: 'association_record',
    }).eq('id', d.id);
    res.json({ ok: true, sent_from: from, to: d.to_email });
  } catch (err) {
    console.error('[email_drafts] send failed:', err.message);
    res.status(500).json({ error: safe(err) });
  }
});

// POST /api/email-drafts/:id/discard
router.post('/:id/discard', async (req, res) => {
  try {
    const { data, error } = await supabase.from('outbound_email_drafts')
      .update({ status: 'discarded' }).eq('id', req.params.id).eq('status', 'draft').select('id').maybeSingle();
    if (error) throw error;
    if (!data) return res.status(409).json({ error: 'not_discardable' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[email_drafts] discard failed:', err.message);
    res.status(500).json({ error: safe(err) });
  }
});

module.exports = router;
