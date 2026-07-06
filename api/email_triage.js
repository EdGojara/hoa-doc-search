// ============================================================================
// api/email_triage.js — Communications hub Phase 1 (read-only ingest + triage)
// ----------------------------------------------------------------------------
// Serves the triage board and the per-record communications feed. Nothing here
// sends email; a human confirms/redirects the AI's proposed linkage, and the
// confirmation writes back (adds the sender's address to the contact) so the
// next email from that address auto-links — the encode-Ed learning loop.
//
// Mounted at /api/email-triage:
//   GET  /            ?status &classification &community_id &q &limit &offset
//   GET  /stats       counts by triage_status + classification
//   GET  /:id
//   POST /:id/link    { contact_id?, property_id?, vendor_id?, community_id?, write_back_email? }
//   POST /:id/dismiss { as: 'dismissed' | 'spam' | 'handled' }
//   GET  /for-record  ?contact_id= | property_id= | vendor_id=   (record's comms feed)
// ============================================================================
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { safeErrorMessage } = require('./_safe_error');
const { draftReply, DRAFTABLE } = require('../lib/email/draft_reply');
const graphSend = require('../lib/email/graph_send');

// Claire's honest-AI signature — every AI-sent email identifies as AI and
// offers a human (same rule as the voice persona).
function claireSignature(communityName) {
  return `\n\n— Claire, AI assistant${communityName ? ` for ${communityName}` : ''} · Bedrock Association Management\nWant a person instead? Just reply and I'll pass you to the team.`;
}

const router = express.Router();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const SELECT = 'id, mailbox, direction, sender_email, sender_name, subject, body_preview, received_at, has_attachments, classification, classification_confidence, ai_summary, extracted, community_id, resolved_contact_id, resolved_property_id, resolved_vendor_id, resolution_confidence, resolution_candidates, triage_status, priority, reviewed_by, reviewed_at, created_at, resolved_contact:resolved_contact_id(full_name), resolved_property:resolved_property_id(street_address), resolved_vendor:resolved_vendor_id(name), community:community_id(name)';

// GET / — triage list
router.get('/', async (req, res) => {
  try {
    const { status, classification, community_id, q } = req.query;
    const limit = Math.min(200, parseInt(req.query.limit, 10) || 100);
    const offset = parseInt(req.query.offset, 10) || 0;
    let query = supabase.from('email_messages').select(SELECT).order('received_at', { ascending: false }).range(offset, offset + limit - 1);
    if (status) query = query.in('triage_status', String(status).split(','));
    if (classification) query = query.in('classification', String(classification).split(','));
    if (community_id) query = query.eq('community_id', community_id);
    if (q) query = query.or(`subject.ilike.%${q}%,sender_email.ilike.%${q}%,ai_summary.ilike.%${q}%`);
    const { data, error } = await query;
    if (error) throw error;
    res.json({ messages: data || [] });
  } catch (err) {
    console.error('[email_triage] list failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// GET /stats — board header counts
router.get('/stats', async (req, res) => {
  try {
    const { data, error } = await supabase.from('email_messages').select('triage_status, classification').limit(5000);
    if (error) throw error;
    const byStatus = {}, byClass = {};
    (data || []).forEach((r) => { byStatus[r.triage_status] = (byStatus[r.triage_status] || 0) + 1; byClass[r.classification] = (byClass[r.classification] || 0) + 1; });
    res.json({ total: (data || []).length, by_status: byStatus, by_classification: byClass });
  } catch (err) {
    console.error('[email_triage] stats failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// GET /for-record — every message linked to a homeowner/vendor record
router.get('/for-record', async (req, res) => {
  try {
    const { contact_id, property_id, vendor_id } = req.query;
    if (!contact_id && !property_id && !vendor_id) return res.status(400).json({ error: 'a record id is required' });
    let query = supabase.from('email_messages').select(SELECT).order('received_at', { ascending: false }).limit(200);
    if (contact_id) query = query.eq('resolved_contact_id', contact_id);
    else if (property_id) query = query.eq('resolved_property_id', property_id);
    else if (vendor_id) query = query.eq('resolved_vendor_id', vendor_id);
    const { data, error } = await query;
    if (error) throw error;
    res.json({ messages: data || [] });
  } catch (err) {
    console.error('[email_triage] for-record failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// GET /:id
router.get('/:id', async (req, res) => {
  try {
    const { data, error } = await supabase.from('email_messages').select('*').eq('id', req.params.id).maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'not_found' });
    res.json({ message: data });
  } catch (err) {
    console.error('[email_triage] get failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// POST /:id/link — human confirms (or redirects) the linkage.
router.post('/:id/link', express.json(), async (req, res) => {
  try {
    const { contact_id, property_id, vendor_id, community_id, write_back_email, reviewed_by } = req.body || {};
    const patch = { triage_status: 'linked', reviewed_by: reviewed_by || 'staff', reviewed_at: new Date().toISOString(), resolution_confidence: 'high' };
    if (contact_id !== undefined) patch.resolved_contact_id = contact_id;
    if (property_id !== undefined) patch.resolved_property_id = property_id;
    if (vendor_id !== undefined) patch.resolved_vendor_id = vendor_id;
    if (community_id !== undefined) patch.community_id = community_id;

    const { data: msg } = await supabase.from('email_messages').select('sender_email').eq('id', req.params.id).maybeSingle();
    const { data, error } = await supabase.from('email_messages').update(patch).eq('id', req.params.id).select(SELECT).single();
    if (error) throw error;

    // Learning loop: if we just confirmed a contact for an email address the
    // contact doesn't have on file, add it as secondary_email so next time it
    // auto-links. Only when the primary slot differs and secondary is empty.
    let learned = false;
    if (write_back_email && contact_id && msg && msg.sender_email) {
      const { data: c } = await supabase.from('contacts').select('primary_email, secondary_email').eq('id', contact_id).maybeSingle();
      const s = (msg.sender_email || '').toLowerCase();
      if (c && s && (c.primary_email || '').toLowerCase() !== s && !(c.secondary_email || '').toLowerCase().includes(s)) {
        await supabase.from('contacts').update({ secondary_email: msg.sender_email }).eq('id', contact_id).is('secondary_email', null);
        learned = true;
      }
    }
    res.json({ message: data, learned });
  } catch (err) {
    console.error('[email_triage] link failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// POST /:id/draft-reply — AI suggests a reply (NOT sent). Guardrails in the lib
// force a human for legal/enforcement/ACC/financial. Returns the draft for
// review; the row's triage_status is left as-is until a human acts.
router.post('/:id/draft-reply', express.json(), async (req, res) => {
  try {
    const { data: m, error } = await supabase.from('email_messages')
      .select('subject, body_preview, body_full, classification, community_id, resolved_contact_id, resolved_contact:resolved_contact_id(full_name), community:community_id(name)')
      .eq('id', req.params.id).maybeSingle();
    if (error) throw error;
    if (!m) return res.status(404).json({ error: 'not_found' });
    const draft = await draftReply({
      email: { subject: m.subject, body_preview: m.body_preview, body_full: m.body_full },
      classification: m.classification,
      contactName: m.resolved_contact ? m.resolved_contact.full_name : null,
      communityName: m.community ? m.community.name : null,
    });
    res.json(draft);
  } catch (err) {
    console.error('[email_triage] draft-reply failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// POST /:id/send — approve-to-send: a human reviewed the draft; send it from
// claire@ (honest-AI signature), log it, mark the inbound handled. Defense in
// depth: refuse to send for non-draftable (compliance) classes even if asked.
router.post('/:id/send', express.json(), async (req, res) => {
  try {
    const { body, to, subject, reviewed_by } = req.body || {};
    if (!body || !String(body).trim()) return res.status(400).json({ error: 'body_required' });
    const { data: m, error } = await supabase.from('email_messages')
      .select('sender_email, subject, classification, community_id, resolved_contact_id, resolved_property_id, community:community_id(name)')
      .eq('id', req.params.id).maybeSingle();
    if (error) throw error;
    if (!m) return res.status(404).json({ error: 'not_found' });
    if (!DRAFTABLE.has(m.classification)) return res.status(403).json({ error: 'not_sendable', detail: 'This class of email must be handled by a person, not sent as Claire.' });
    if (!graphSend.isConfigured()) return res.status(400).json({ error: 'claire_not_connected', detail: 'claire@bedrocktx.com send is not wired yet — create the mailbox + Azure app (Mail.Send) and set GRAPH_TENANT_ID / GRAPH_CLIENT_ID / GRAPH_CLIENT_SECRET.' });

    const recipient = to || m.sender_email;
    if (!recipient) return res.status(400).json({ error: 'no_recipient' });
    const commName = m.community ? m.community.name : '';
    const subj = subject || (/^re:/i.test(m.subject || '') ? m.subject : `Re: ${m.subject || 'your message'}`);
    const text = String(body).trim() + claireSignature(commName);

    await graphSend.sendAs({ to: recipient, subject: subj, text });

    // Mark the inbound handled + log the outbound reply on the record (both
    // sides of the thread now show on the homeowner's communications feed).
    await supabase.from('email_messages').update({ triage_status: 'handled', reviewed_by: reviewed_by || 'staff', reviewed_at: new Date().toISOString() }).eq('id', req.params.id);
    await supabase.from('email_messages').insert({
      mailbox: graphSend.CLAIRE_MAILBOX, direction: 'outbound', sender_email: graphSend.CLAIRE_MAILBOX,
      sender_name: 'Claire (Bedrock AI)', recipients: [recipient], subject: subj, body_preview: text.slice(0, 2000),
      classification: 'outbound_reply', classification_confidence: 'high', ai_summary: `Claire replied to ${recipient}`,
      community_id: m.community_id, resolved_contact_id: m.resolved_contact_id, resolved_property_id: m.resolved_property_id,
      resolution_confidence: 'high', triage_status: 'handled', record_ownership: 'association_record', reviewed_by: reviewed_by || 'staff', reviewed_at: new Date().toISOString(),
    });
    res.json({ sent: true, to: recipient, from: graphSend.CLAIRE_MAILBOX });
  } catch (err) {
    console.error('[email_triage] send failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// POST /:id/dismiss — mark spam / dismissed / handled without linking.
router.post('/:id/dismiss', express.json(), async (req, res) => {
  try {
    const as = ['dismissed', 'spam', 'handled'].includes((req.body || {}).as) ? req.body.as : 'dismissed';
    const { data, error } = await supabase.from('email_messages')
      .update({ triage_status: as, reviewed_by: (req.body || {}).reviewed_by || 'staff', reviewed_at: new Date().toISOString() })
      .eq('id', req.params.id).select(SELECT).single();
    if (error) throw error;
    res.json({ message: data });
  } catch (err) {
    console.error('[email_triage] dismiss failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

module.exports = { router };
