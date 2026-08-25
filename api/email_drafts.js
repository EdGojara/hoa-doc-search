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
const { buildClaireEmail } = require('../lib/email/claire_signature');
const { buildEmmaEmail } = require('../lib/email/emma_signature');
const { buildMirandaEmail } = require('../lib/email/miranda_signature');
const { buildKatEmail } = require('../lib/email/kat_signature');
const { buildAmandaEmail } = require('../lib/email/amanda_signature');
const { buildReeseEmail } = require('../lib/email/reese_signature');
const { buildPaigeEmail } = require('../lib/email/paige_signature');
const { buildTessaEmail } = require('../lib/email/tessa_signature');

const router = express.Router();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

function safe(err) { return require('./_safe_error').safeErrorMessage ? require('./_safe_error').safeErrorMessage(err) : 'Something went wrong'; }
function _isMissingTable(err) {
  const m = `${err && err.message || ''} ${err && err.code || ''}`;
  return /could not find|does not exist|42P01|42703|PGRST20[45]|schema cache/i.test(m);
}

// persona -> { mailbox, build(bodyText, communityName) -> {html, attachments} }
// Every AI team member who can send a homeowner-facing reply. Changing a draft's
// persona changes both the FROM mailbox and the branded signature applied at
// send. (Ed 2026-07-23: "I want an AI team member to send it ... adjust who sends.")
const PERSONA = {
  claire:  { mailbox: graphSend.CLAIRE_MAILBOX,  build: buildClaireEmail,   label: 'Claire (front office)' },
  annie:   { mailbox: graphSend.ANNIE_MAILBOX,   build: buildAnnieEmail,    label: 'Annie Reeves (architectural / ACC)' },
  emma:    { mailbox: graphSend.EMMA_MAILBOX,    build: buildEmmaEmail,     label: 'Emma Brooks (accounts payable)' },
  miranda: { mailbox: graphSend.MIRANDA_MAILBOX, build: buildMirandaEmail,  label: 'Miranda Pierce (compliance / DRV)' },
  kat:     { mailbox: graphSend.KAT_MAILBOX,     build: buildKatEmail,      label: 'Kat Reed (accounting manager)' },
  amanda:  { mailbox: graphSend.AMANDA_MAILBOX,  build: buildAmandaEmail,   label: 'Amanda Albright (senior community manager)' },
  reese:   { mailbox: graphSend.REESE_MAILBOX,   build: buildReeseEmail,    label: 'Reese Calloway (resale / closings)' },
  paige:   { mailbox: graphSend.PAIGE_MAILBOX,   build: buildPaigeEmail,    label: 'Paige Chandler (board operations)' },
  tessa:   { mailbox: graphSend.TESSA_MAILBOX,   build: buildTessaEmail,    label: 'Tessa McCall (executive assistant)' },
};
function personaMailbox(p, fallback) {
  return (PERSONA[p] && PERSONA[p].mailbox) || fallback || graphSend.CLAIRE_MAILBOX;
}
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fmtWhen = (d) => { try { return new Date(d).toLocaleString('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); } catch (_) { return String(d || ''); } }

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

// GET /api/email-drafts/personas — the AI team members that can send a draft.
router.get('/personas', (req, res) => {
  res.json({ personas: Object.keys(PERSONA).map((id) => ({ id, label: PERSONA[id].label, mailbox: PERSONA[id].mailbox })) });
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
    for (const f of ['to_email', 'to_name', 'cc', 'subject', 'body_text', 'body_html', 'persona']) {
      if (req.body[f] !== undefined) patch[f] = req.body[f];
    }
    if (patch.persona !== undefined && patch.persona !== null && !PERSONA[patch.persona]) {
      return res.status(400).json({ error: 'unknown sender' });
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
// Record a sent draft on the homeowner timeline (email_messages) so it shows on
// the 360. The Draft Queue is a SEND PATH and every send path must log a
// RESOLVED outbound, or the customer email is invisible on the 360. (Ed
// 2026-07-28: Claire's fee-waiver email to Carlos, sent from here, never
// appeared — same class as the ACC finalize email.) Resolution order: inherit
// from the inbound this answers (source_email_ref → same thread's contact +
// conversation), else resolve the recipient address to a contact + property.
// Best-effort: the mail already went out, so a logging miss never fails the
// send — but it warns loudly.
async function logSentDraftToTimeline(d, from, subject) {
  try {
    let contactId = null, propertyId = null, communityId = d.community_id || null, conversationId = null;
    if (d.source_email_ref) {
      // Resilient thread lookup: a bad/non-uuid ref must NOT abort logging — fall
      // through to recipient resolution. id.eq only when the ref is a real uuid
      // (an id.eq on a non-uuid errors and would skip the whole log).
      try {
        const ref = String(d.source_email_ref);
        const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ref);
        const ors = [`internet_message_id.eq.${ref}`, `graph_id.eq.${ref}`];
        if (isUuid) ors.unshift(`id.eq.${ref}`);
        const { data: src } = await supabase.from('email_messages')
          .select('resolved_contact_id, resolved_property_id, community_id, conversation_id')
          .or(ors.join(',')).limit(1).maybeSingle();
        if (src) {
          contactId = src.resolved_contact_id || null;
          propertyId = src.resolved_property_id || null;
          communityId = communityId || src.community_id || null;
          conversationId = src.conversation_id || null;
        }
      } catch (e) { console.warn('[email_drafts] source thread lookup skipped:', e.message); }
    }
    if (!contactId && d.to_email) {
      const { resolveContact } = require('../lib/entity_resolution');
      const c = await resolveContact(supabase, { email: d.to_email, name: d.to_name, communityId }).catch(() => null);
      if (c && c.id && !c.ambiguous) {
        contactId = c.id;
        const { data: own } = await supabase.from('property_ownerships')
          .select('property_id, properties:property_id(community_id)').eq('contact_id', c.id).is('end_date', null).limit(1).maybeSingle();
        if (own) { propertyId = own.property_id; communityId = communityId || (own.properties && own.properties.community_id); }
      }
    }
    const nm = String((PERSONA[d.persona] && PERSONA[d.persona].label) || '').split(' (')[0].trim();
    const cc = String(d.cc || '').split(',').map((s) => s.trim()).filter(Boolean);
    const { error } = await supabase.from('email_messages').insert({
      mailbox: from, direction: 'outbound', sender_email: from,
      sender_name: nm ? `${nm} (Bedrock AI)` : 'Bedrock', persona: d.persona || null,
      recipients: [d.to_email, ...cc].filter(Boolean),
      subject, body_preview: (d.body_text || '').slice(0, 400), body_full: d.body_text || null,
      classification: 'outbound_reply', classification_confidence: 'high',
      resolved_contact_id: contactId, resolved_property_id: propertyId,
      community_id: communityId, conversation_id: conversationId,
      triage_status: 'handled', record_ownership: 'association_record',
      reviewed_at: new Date().toISOString(), sent_at: new Date().toISOString(), received_at: new Date().toISOString(),
    });
    if (error) console.warn('[email_drafts] timeline log failed:', error.message);
    return { logged: !error, resolved: !!contactId };
  } catch (e) { console.warn('[email_drafts] timeline log skipped:', e.message); return { logged: false, resolved: false }; }
}

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
      // Build real paragraphs. white-space:pre-wrap gets collapsed by Outlook
      // into one blob (Ed 2026-08-25), so emit explicit <p> per blank-line block
      // and <br> per line instead.
      const esc0 = (t) => String(t).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
      const paras = d.body_text.replace(/\r\n/g, '\n').split(/\n{2,}/)
        .map((para) => `<p style="margin:0 0 12px;">${esc0(para).replace(/\n/g, '<br>')}</p>`).join('');
      html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.55;color:#1f2430;">${paras}</div>`;
    }

    // Pull any stored file attachments. Default bucket is 'documents'; an
    // attachment may name its own bucket (e.g. a violation letter lives in
    // 'violation-letters'), so honor a.bucket when set. (Ed 2026-08-01.)
    const fileAttachments = [];
    for (const a of Array.isArray(d.attachments) ? d.attachments : []) {
      if (!a || !a.storage_path) continue;
      try {
        const { data: blob, error: dErr } = await supabase.storage.from(a.bucket || 'documents').download(a.storage_path);
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
    // A staff review only becomes MEMORY once the person actually received it.
    // staff_document_reviews rows are written at draft time with sent_at null;
    // stamping it here is what lets Amanda say "this came back" next month.
    // Without this the history filter would be permanently empty and she would
    // never remember anything. (Ed 2026-08-19.)
    if (d.persona === 'amanda' && d.to_email) {
      try {
        const { error: revErr } = await supabase.from('staff_document_reviews')
          .update({ sent_at: new Date().toISOString() })
          .eq('staff_email', String(d.to_email).toLowerCase())
          .is('sent_at', null);
        if (revErr) console.warn('[email_drafts] could not stamp review as sent:', revErr.message);
      } catch (e) { console.warn('[email_drafts] review stamp failed:', e.message); }
    }

    // Log the sent email onto the homeowner's 360 (resolved). Best-effort.
    const timeline = await logSentDraftToTimeline(d, from, subject);
    res.json({ ok: true, sent_from: from, to: d.to_email, timeline });
  } catch (err) {
    console.error('[email_drafts] send failed:', err.message);
    res.status(500).json({ error: safe(err) });
  }
});

// POST /api/email-drafts/:id/redraft — add comments and let the persona rewrite
// the message body. Returns the revised body for review; does NOT save or send.
router.post('/:id/redraft', async (req, res) => {
  try {
    const notes = String(req.body && req.body.notes || '').trim();
    const currentBody = String(req.body && req.body.body_text || '').trim();
    if (!notes) return res.status(400).json({ error: 'add a note describing what to change' });
    const { data: d, error } = await supabase.from('outbound_email_drafts').select('persona, community_name, to_name').eq('id', req.params.id).maybeSingle();
    if (error) throw error;
    if (!d) return res.status(404).json({ error: 'not_found' });
    const { revisePersonaDraft } = require('../lib/email/compose_draft');
    const out = await revisePersonaDraft({
      persona: d.persona, currentBody, notes,
      ctx: { recipientName: d.to_name, community: d.community_name },
    });
    if (out.degraded) return res.status(503).json({ error: 'the draft assistant is unavailable right now — edit the text directly' });
    res.json({ ok: true, body_text: out.body });
  } catch (err) {
    console.error('[email_drafts] redraft failed:', err.message);
    res.status(500).json({ error: safe(err) });
  }
});

// POST /api/email-drafts/:id/forward — loop a HUMAN teammate in to help. Sends
// the draft PLUS the homeowner's inbound thread to an internal @bedrocktx.com
// address. Internal only (never the homeowner); the click is the release.
router.post('/:id/forward', async (req, res) => {
  try {
    const to_email = String(req.body && req.body.to_email || '').trim();
    const to_name = String(req.body && req.body.to_name || '').trim();
    const note = String(req.body && req.body.note || '').trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to_email)) return res.status(400).json({ error: 'a teammate email is required' });
    // Privacy: only forward internally — homeowner correspondence must not leave
    // the company to an arbitrary outside address from here.
    if (!/@bedrocktx(ai)?\.com$/i.test(to_email)) return res.status(400).json({ error: 'forward is for the internal team only (@bedrocktx.com)' });

    const { data: d, error } = await supabase.from('outbound_email_drafts').select('*').eq('id', req.params.id).maybeSingle();
    if (error) throw error;
    if (!d) return res.status(404).json({ error: 'not_found' });
    if (!graphSend.isConfigured()) return res.status(400).json({ error: 'email not connected (Graph credentials missing)' });

    // The homeowner's inbound messages, oldest first — the chain the teammate
    // needs — AND their PHOTOS/attachments, so the teammate can actually see the
    // issue (a boundary photo, a site sketch), not just read about it. Photos
    // are re-fetched from Graph and attached to the forward. (Ed 2026-07-22 —
    // "how does a team member see the photos Andrea sent?")
    let chainHtml = '';
    const fwdAttachments = [];
    let attachTotal = 0, photosSkipped = 0;
    const MAX_ATTACH_BYTES = 22 * 1024 * 1024; // Graph message ceiling headroom
    try {
      const { data: msgs } = await supabase.from('email_messages')
        .select('subject, received_at, body_full, body_preview, sender_name, direction, has_attachments, graph_id, mailbox')
        .ilike('sender_email', d.to_email).eq('direction', 'inbound')
        .order('received_at', { ascending: true }).limit(12);
      if (msgs && msgs.length) {
        chainHtml = '<hr style="border:0;border-top:1px solid #e4e2db;margin:16px 0;"><p style="color:#6b7a8d;font-size:12px;margin:0 0 6px;">Homeowner\'s messages (for context):</p>' +
          msgs.map((m) => {
            const body = String(m.body_full || m.body_preview || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1600);
            return `<div style="border-left:3px solid #e4e2db;padding-left:12px;margin:10px 0;"><b>${esc(m.subject || '(no subject)')}</b> <span style="color:#6b7a8d;font-size:12px;">${esc(fmtWhen(m.received_at))}</span><br><span style="white-space:pre-wrap;">${esc(body)}</span></div>`;
          }).join('');
        // Re-fetch attachments from every message that carried one. Best-effort:
        // a filed message whose Graph id went stale just gets skipped + noted.
        const { fetchAllAttachmentBuffers } = require('../lib/email/graph_attachments');
        for (const m of msgs) {
          if (!m.has_attachments || !m.graph_id || !m.mailbox) continue;
          try {
            const atts = await fetchAllAttachmentBuffers(m.mailbox, m.graph_id);
            for (const a of atts || []) {
              if (!a.buffer || !a.buffer.length) continue;
              if (attachTotal + a.buffer.length > MAX_ATTACH_BYTES) { photosSkipped++; continue; }
              attachTotal += a.buffer.length;
              fwdAttachments.push({ '@odata.type': '#microsoft.graph.fileAttachment', name: a.filename || 'attachment', contentType: a.contentType || 'application/octet-stream', contentBytes: a.buffer.toString('base64') });
            }
          } catch (e) { photosSkipped++; console.warn('[email_drafts] forward attach re-fetch failed:', e.message); }
        }
      }
    } catch (e) { console.warn('[email_drafts] forward chain load skipped:', e.message); }

    const attachNote = fwdAttachments.length
      ? `<p style="margin:0 0 12px;color:#2f6f4f;">📎 ${fwdAttachments.length} photo/attachment${fwdAttachments.length === 1 ? '' : 's'} the homeowner sent ${fwdAttachments.length === 1 ? 'is' : 'are'} attached below.${photosSkipped ? ` (${photosSkipped} could not be retrieved — open the original in Outlook.)` : ''}</p>`
      : (photosSkipped ? `<p style="margin:0 0 12px;color:#B7791F;">The homeowner sent attachments, but they couldn't be retrieved automatically — please open the original email in Outlook to view them.</p>` : '');

    const noteHtml = note ? `<p style="margin:0 0 12px;">${esc(note).replace(/\n/g, '<br>')}</p>` : '';
    const draftHtml = `<div style="background:#f7f5ef;border:1px solid #e4e2db;border-radius:8px;padding:12px 14px;margin:6px 0;">
      <p style="color:#6b7a8d;font-size:12px;margin:0 0 6px;">Draft prepared for ${esc(d.to_name || d.to_email)} &lt;${esc(d.to_email)}&gt; — <b>not yet sent</b>:</p>
      <p style="margin:0 0 6px;"><b>Subject:</b> ${esc(d.subject)}</p>
      <div style="white-space:pre-wrap;">${esc(d.body_text || '')}</div></div>`;
    const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.55;color:#1a2230;">
      ${noteHtml}
      <p style="margin:0 0 12px;">Can you take a look and help with this one? This did not go to the homeowner — reply here and we'll fold it into the response.</p>
      ${attachNote}${draftHtml}${chainHtml}
      <p style="color:#6b7a8d;font-size:12px;margin-top:14px;">Forwarded from the Bedrock Draft Queue.</p></div>`;

    const from = personaMailbox(d.persona, d.from_mailbox);
    const subject = `For your help: ${d.subject}`;
    try { await graphSend.sendAs({ from, to: to_email, subject, html, attachments: fwdAttachments.length ? fwdAttachments : undefined }); }
    catch (e) { return res.status(502).json({ error: `forward failed: ${e.message}` }); }
    res.json({ ok: true, forwarded_to: to_email, from, attachments: fwdAttachments.length });
  } catch (err) {
    console.error('[email_drafts] forward failed:', err.message);
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
