// ============================================================================
// lib/ea/tessa_inbox.js  (Ed 2026-07-12)
// ----------------------------------------------------------------------------
// Reads Tessa's shared mailbox (tessa@) DIRECTLY via Graph and, for each new
// inbound message Ed forwarded/BCC'd her, drafts a suggested reply and stores
// it in ea_inbox for Ed's review. This is DELIBERATELY separate from
// lib/email/graph_ingest.js: that pipeline files every message into the
// staff-visible email_messages / triage queue and drafts in Claire's homeowner
// voice. Ed's forwarded personal + banking + vendor mail must NEVER land in a
// staff-visible surface (the owner-only rule), so Tessa's inbox writes only to
// ea_inbox (owner-scoped) and drafts in Ed's own voice.
// ============================================================================
const { createClient } = require('@supabase/supabase-js');
const graphSend = require('../email/graph_send');
const { draftReply } = require('./tessa');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Crude HTML -> text so Tessa drafts on the readable body, not tag soup.
function htmlToText(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<\/(p|div|br|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function isConfigured() { return graphSend.isConfigured(); }

// Poll tessa@ for new inbound mail, draft a reply for each, store in ea_inbox.
// Returns { scanned, drafted, skipped, error? }. Best-effort per message.
async function pollTessaInbox({ max = 25, mode = 'ed' } = {}) {
  const stats = { scanned: 0, drafted: 0, skipped: 0 };
  const mailbox = graphSend.TESSA_MAILBOX;
  if (!mailbox) return { ...stats, error: 'tessa_mailbox_not_configured' };
  if (!graphSend.isConfigured()) return { ...stats, error: 'graph_not_configured' };

  const token = await graphSend.getToken();
  const sel = ['id', 'internetMessageId', 'conversationId', 'from', 'subject', 'bodyPreview', 'body', 'receivedDateTime'].join(',');
  const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/messages?$select=${sel}&$top=${Math.min(50, max)}&$orderby=receivedDateTime desc`;
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    // 403 here almost always = the Azure app policy doesn't include tessa@ for Mail.Read yet.
    return { ...stats, error: `graph_read_failed_${resp.status}`, detail: body.slice(0, 300) };
  }
  const json = await resp.json();
  const messages = Array.isArray(json.value) ? json.value : [];

  for (const m of messages) {
    stats.scanned += 1;
    const graphId = m.id || null;
    const fromAddr = ((m.from && m.from.emailAddress && m.from.emailAddress.address) || '').toLowerCase();
    // Skip Tessa's own sent items (they live in the same /messages collection).
    if (!graphId || (fromAddr && fromAddr === String(mailbox).toLowerCase())) { stats.skipped += 1; continue; }

    // Dedup: already queued this Graph message on a prior poll?
    const { data: exists } = await supabase.from('ea_inbox').select('id').eq('graph_id', graphId).maybeSingle();
    if (exists) { stats.skipped += 1; continue; }

    const subject = m.subject || '';
    const bodyText = (m.body && m.body.contentType === 'html' ? htmlToText(m.body.content) : (m.body && m.body.content)) || m.bodyPreview || '';
    const fromName = (m.from && m.from.emailAddress && m.from.emailAddress.name) || fromAddr || 'the sender';

    let draft = null;
    try { draft = await draftReply({ incomingSubject: subject, incomingBody: bodyText, fromName, mode }); }
    catch (e) { console.warn('[tessa] draftReply failed:', e.message); }

    const row = {
      graph_id: graphId,
      from_email: fromAddr || null,
      from_name: fromName,
      subject,
      body_preview: String(bodyText).slice(0, 2000),
      received_at: m.receivedDateTime || null,
      draft_subject: draft && !draft.degraded ? draft.subject : null,
      draft_body: draft && !draft.degraded ? draft.body : null,
      draft_mode: draft && draft.mode === 'tessa' ? 'tessa' : 'ed',
      status: 'needs_review',
    };
    const { error } = await supabase.from('ea_inbox').insert(row);
    if (error) { console.warn('[tessa] ea_inbox insert failed:', error.message); stats.skipped += 1; continue; }
    stats.drafted += 1;
  }
  return stats;
}

module.exports = { pollTessaInbox, isConfigured, htmlToText };
