// ============================================================================
// lib/email/graph_ingest.js  (Ed 2026-07-05) — pull Outlook mail into the 360
// ----------------------------------------------------------------------------
// Reads a mailbox via Microsoft Graph (application permissions) and files each
// message into email_messages through the triage pipeline (classify + resolve),
// so it shows on the Homeowner 360. Built for archive1emails@bedrocktx.com — the
// journaling mailbox that holds ALL sent + received company mail (~65k msgs,
// 1yr+). That archive is a firehose (homeowner, vendor, internal, personal), so
// backfill runs with onlyLinked=true: a message is only KEPT if it resolves to a
// homeowner (contact or property). Vendor/internal/personal noise is skipped, so
// email_messages stays homeowner-correspondence, not 65k rows.
//
// Two modes:
//   backfill    ingestMailbox(mbx, { sinceISO: oneYearAgo, light:true, onlyLinked:true })
//   incremental ingestMailbox(mbx, { sinceISO: lastRun, light:false })  (current mail)
//
// Needs the Azure app (Mail.Read, scoped to include the mailbox) + GRAPH_* env.
// isConfigured() is false until then. `light` skips the AI classify (heuristic)
// to keep a 1-year backfill cheap; incremental/current mail gets full AI triage.
// ============================================================================
const { getToken, isConfigured } = require('./graph_send');
const { classifyAndExtract, resolveEntities } = require('./triage');
const { draftReply } = require('./draft_reply');
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Look up display names for a resolved draft ("Hey Janelle" / community voice).
async function resolveNames(contactId, communityId) {
  let contactName = null, communityName = null;
  if (contactId) { const { data } = await supabase.from('contacts').select('full_name').eq('id', contactId).maybeSingle(); contactName = data && data.full_name; }
  if (communityId) { const { data } = await supabase.from('communities').select('name').eq('id', communityId).maybeSingle(); communityName = data && data.name; }
  return { contactName, communityName };
}

function heuristic(email) {
  const s = ((email.subject || '') + ' ' + (email.body_preview || '')).toLowerCase();
  const from = (email.sender_email || '').toLowerCase();
  const isSpam = /loan offer|\bseo\b|improve your (online|website)|ready.to.buy|unsubscribe|bonus points/.test(s);
  const isVendorFin = /donotreply|no-?reply|billing|invoice|receipt|quickbooks|statement|past due/.test(from + ' ' + s);
  const isInternal = /@bedrocktx\.com$/.test(from) || /vantaca|zendesk|nextiva|opentable|anthropic/.test(from);
  const classification = isSpam ? 'spam' : isVendorFin ? 'vendor_financial' : isInternal ? 'internal' : 'other';
  return { classification, classification_confidence: 'low', is_spam: isSpam, priority: 'normal', summary: email.subject || '(email)', requested_action: '', community_hint: '', person_names: [], addresses: [], amounts: [], ticket_ref: '', vendor_name: '', _fallback: true };
}

function mapGraphMessage(m, mailbox) {
  const from = (m.from && m.from.emailAddress) || (m.sender && m.sender.emailAddress) || {};
  const toList = (m.toRecipients || []).map((r) => r.emailAddress && r.emailAddress.address).filter(Boolean);
  // Direction is relative to THIS mailbox: outbound only if the mailbox itself
  // sent it; everything else received here is inbound — including mail from
  // other bedrocktx.com staff (a staffer emailing claire@ is an inbound message
  // to Claire, and must stay eligible for a draft). The old "any @bedrocktx.com
  // = outbound" rule mis-tagged those and suppressed their drafts.
  const fromAddr = (from.address || '').toLowerCase();
  const direction = fromAddr === String(mailbox).toLowerCase() ? 'outbound' : 'inbound';
  return {
    mailbox,
    graph_id: m.id || null,
    internet_message_id: m.internetMessageId || null,
    conversation_id: m.conversationId || null,
    direction,
    sender_email: from.address || null,
    sender_name: from.name || null,
    recipients: toList,
    subject: m.subject || null,
    body_preview: (m.bodyPreview || '').slice(0, 2000),
    received_at: m.receivedDateTime || null,
    sent_at: m.sentDateTime || null,
    has_attachments: !!m.hasAttachments,
  };
}

// Ingest one mailbox since a date. Returns { scanned, kept, skipped, linked }.
async function ingestMailbox(mailbox, opts = {}) {
  if (!isConfigured()) throw new Error('graph_not_configured');
  const { sinceISO, light = false, onlyLinked = false, max = 5000 } = opts;
  const token = await getToken();
  const sel = 'id,internetMessageId,conversationId,subject,bodyPreview,from,sender,toRecipients,receivedDateTime,sentDateTime,hasAttachments';
  const filter = sinceISO ? `&$filter=receivedDateTime ge ${sinceISO}` : '';
  let url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/messages?$select=${sel}&$top=50&$orderby=receivedDateTime desc${filter}`;
  const stats = { scanned: 0, kept: 0, skipped: 0, linked: 0 };

  while (url && stats.scanned < max) {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) throw new Error(`Graph messages failed (${r.status}): ${(await r.text().catch(() => '')).slice(0, 160)}`);
    const j = await r.json();
    for (const gm of (j.value || [])) {
      if (stats.scanned >= max) break;
      stats.scanned += 1;
      const email = mapGraphMessage(gm, mailbox);
      // Skip the mailbox's OWN sent items. /messages spans all folders incl.
      // Sent, so claire@ would otherwise flood Communications with Claire's own
      // outbound (her sends are already logged separately). We only triage mail
      // RECEIVED by this box — i.e. replies TO Claire, not from her.
      if (email.sender_email && email.sender_email.toLowerCase() === mailbox.toLowerCase()) { stats.skipped += 1; continue; }
      let ex;
      try { ex = light ? heuristic(email) : await classifyAndExtract(email); }
      catch (_) { ex = heuristic(email); }
      const res = ex.is_spam ? { community_id: null, contact_id: null, property_id: null, vendor_id: null, confidence: 'none', candidates: [] } : await resolveEntities(ex, email, supabase);
      const isLinked = !!(res.contact_id || res.property_id);
      if (onlyLinked && !isLinked) { stats.skipped += 1; continue; }

      // Auto-draft on CURRENT mail only (not the historical backfill — that's
      // already-handled history, and drafting 65k would be pointless + costly).
      // Claire pre-drafts every non-spam/internal reply so the team just
      // reviews-and-approves; compliance types come out conservative + flagged.
      let draft = null;
      if (!light && email.direction === 'inbound' && !['spam', 'internal'].includes(ex.classification)) {
        try {
          const nm = await resolveNames(res.contact_id, res.community_id);
          const d = await draftReply({ email, classification: ex.classification, contactId: res.contact_id, propertyId: res.property_id, communityId: res.community_id, contactName: nm.contactName, communityName: nm.communityName });
          if (d.draftable) draft = { subject: d.subject, body: d.body, careful: d.careful, status: 'pending' };
        } catch (_) { /* draft best-effort — never fails ingest */ }
      }

      const row = {
        mailbox: email.mailbox, graph_id: email.graph_id, internet_message_id: email.internet_message_id,
        conversation_id: email.conversation_id, direction: email.direction, sender_email: email.sender_email,
        sender_name: email.sender_name, recipients: email.recipients, subject: email.subject,
        body_preview: email.body_preview, received_at: email.received_at, sent_at: email.sent_at, has_attachments: email.has_attachments,
        classification: ex.classification, classification_confidence: ex.classification_confidence || 'low', ai_summary: ex.summary || null,
        extracted: { requested_action: ex.requested_action, community_hint: ex.community_hint, person_names: ex.person_names, addresses: ex.addresses, amounts: ex.amounts, ticket_ref: ex.ticket_ref, vendor_name: ex.vendor_name, backfill: !!light, draft },
        community_id: res.community_id, resolved_contact_id: res.contact_id, resolved_property_id: res.property_id, resolved_vendor_id: res.vendor_id,
        resolution_confidence: res.confidence, resolution_candidates: res.candidates,
        triage_status: ex.is_spam ? 'spam' : (res.confidence === 'high' ? 'linked' : (res.candidates.length ? 'needs_review' : 'new')),
        priority: ex.priority || 'normal',
      };
      // Idempotent by internet_message_id (partial unique index on graph_id
      // can't be targeted by upsert, so delete-then-insert on the stable id).
      if (row.internet_message_id) await supabase.from('email_messages').delete().eq('internet_message_id', row.internet_message_id);
      const { error } = await supabase.from('email_messages').insert(row);
      if (error) { stats.skipped += 1; continue; }
      stats.kept += 1; if (isLinked) stats.linked += 1;
    }
    url = j['@odata.nextLink'] || null;
  }
  return stats;
}

module.exports = { ingestMailbox, isConfigured };
