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
const { getToken, isConfigured, EMMA_MAILBOX } = require('./graph_send');
const { htmlToText, fetchAttachmentBuffers } = require('./graph_attachments');
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
    // Full body as readable text so Claire drafts on the WHOLE message, not just
    // the ~255-char preview. Was previously never stored (body not requested).
    body_full: ((m.body && m.body.contentType === 'html' ? htmlToText(m.body.content) : (m.body && m.body.content) || m.bodyPreview || '') || '').slice(0, 40000) || null,
    received_at: m.receivedDateTime || null,
    sent_at: m.sentDateTime || null,
    has_attachments: !!m.hasAttachments,
  };
}

// Ingest one mailbox since a date. Returns { scanned, kept, skipped, linked }.
async function ingestMailbox(mailbox, opts = {}) {
  if (!isConfigured()) throw new Error('graph_not_configured');
  const { sinceISO, light = false, onlyLinked = false, max = 5000, force = false } = opts;
  const token = await getToken();
  const sel = 'id,internetMessageId,conversationId,subject,bodyPreview,body,from,sender,toRecipients,receivedDateTime,sentDateTime,hasAttachments,parentFolderId';
  const filter = sinceISO ? `&$filter=receivedDateTime ge ${sinceISO}` : '';
  let url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/messages?$select=${sel}&$top=50&$orderby=receivedDateTime desc${filter}`;
  const stats = { scanned: 0, kept: 0, skipped: 0, linked: 0 };
  // Zero-inbox: after taking a message into trustEd, move it out of the Outlook
  // Inbox into the filed folder. On for live pulls unless FILE_PROCESSED_MAIL=false.
  const fileProcessed = !light && process.env.FILE_PROCESSED_MAIL !== 'false';
  let inboxId = null;
  if (fileProcessed) { try { inboxId = await require('./graph_move').getInboxId(mailbox); } catch (_) {} }
  // Per-message work fires up to 2 AI calls (classify + draft); run a handful of
  // messages at once instead of strictly one-at-a-time. Each message still does
  // its own two calls sequentially, so peak concurrent AI calls == CONCURRENCY.
  const CONCURRENCY = 5;

  // The full per-message pipeline: classify, resolve, draft, upsert, and (Emma
  // only) AP-intake attachments. Returns a small delta so the batch runner can
  // merge stats without shared-state races.
  async function handleMessage(gm) {
    const email = mapGraphMessage(gm, mailbox);
    // Skip the mailbox's OWN sent items. /messages spans all folders incl. Sent,
    // so claire@ would otherwise flood Communications with Claire's own outbound
    // (her sends are logged separately). Only triage mail RECEIVED by this box.
    if (email.sender_email && email.sender_email.toLowerCase() === mailbox.toLowerCase()) return { r: 'skipped' };
    let ex;
    try { ex = light ? heuristic(email) : await classifyAndExtract(email); }
    catch (_) { ex = heuristic(email); }
    const res = ex.is_spam ? { community_id: null, contact_id: null, property_id: null, vendor_id: null, confidence: 'none', candidates: [] } : await resolveEntities(ex, email, supabase);
    const isLinked = !!(res.contact_id || res.property_id);
    if (onlyLinked && !isLinked) return { r: 'skipped' };

    // Auto-draft on CURRENT mail only (not the historical backfill). Claire
    // pre-drafts every non-spam/internal reply so the team just reviews-and-
    // approves; compliance types come out conservative + flagged.
    let draft = null, drvContext = null;
    // No auto-draft for: the General inbox (solicitations/junk), spam/internal,
    // OR vendor/AP mail — a bill or payment confirmation gets FILED (to Payables
    // or the GL), not answered. Ed drafts those on demand. Real front-office /
    // ACC / DRV mail still drafts.
    if (!light && email.direction === 'inbound' && !['spam', 'internal', 'other', 'vendor_financial', 'vendor_general'].includes(ex.classification)) {
      try {
        const nm = await resolveNames(res.contact_id, res.community_id);
        // DRV handoff to Miranda: if the sender's property has an OPEN enforcement
        // case and this reads like a response to it, Miranda drafts the reply
        // (careful, holds the decision) instead of Claire. Else Claire drafts.
        if (res.property_id) {
          try {
            const { findOpenCaseForProperty, looksLikeDrvResponse, draftMirandaReply } = require('../enforcement/drv_reply');
            const openCase = await findOpenCaseForProperty(res.property_id);
            if (openCase && looksLikeDrvResponse(email, ex.classification)) {
              const d = await draftMirandaReply({ email, contactName: nm.contactName });
              if (d && d.draftable) {
                draft = { subject: d.subject, body: d.body, careful: true, status: 'pending', persona: 'miranda' };
                drvContext = { persona: 'miranda', violation_id: openCase.id, community_id: openCase.community_id, current_stage: openCase.current_stage };
              }
            }
          } catch (e) { console.warn('[graph_ingest] miranda draft skipped:', e.message); }
        }
        if (!draft) {
          const d = await draftReply({ email, classification: ex.classification, contactId: res.contact_id, propertyId: res.property_id, communityId: res.community_id, contactName: nm.contactName, communityName: nm.communityName });
          if (d.draftable) draft = { subject: d.subject, body: d.body, careful: d.careful, status: 'pending' };
        }
      } catch (_) { /* draft best-effort — never fails ingest */ }
    }

    // Vendor accounting: resolve the community from the LEARNED map when triage
    // couldn't (by service account number, or a vendor that serves one
    // community), so the bill is pre-coded and can auto-record below.
    let vcMapping = null;
    if (!light && email.direction === 'inbound' && ['vendor_financial', 'vendor_general'].includes(ex.classification)) {
      try {
        const { resolveMapping } = require('../ap/vendor_community');
        vcMapping = await resolveMapping({ accountNumber: ex.account_number, vendorId: res.vendor_id, vendorName: ex.vendor_name || email.sender_name });
        if (vcMapping.community_id && !res.community_id) { res.community_id = vcMapping.community_id; res.confidence = res.confidence === 'high' ? 'high' : 'medium'; }
      } catch (e) { console.warn('[graph_ingest] vendor-community resolve skipped:', e.message); }
    }

    const row = {
      mailbox: email.mailbox, graph_id: email.graph_id, internet_message_id: email.internet_message_id,
      conversation_id: email.conversation_id, direction: email.direction, sender_email: email.sender_email,
      sender_name: email.sender_name, recipients: email.recipients, subject: email.subject,
      body_preview: email.body_preview, received_at: email.received_at, sent_at: email.sent_at, has_attachments: email.has_attachments,
      classification: ex.classification, classification_confidence: ex.classification_confidence || 'low', ai_summary: ex.summary || null,
      extracted: { requested_action: ex.requested_action, community_hint: ex.community_hint, person_names: ex.person_names, addresses: ex.addresses, amounts: ex.amounts, ticket_ref: ex.ticket_ref, vendor_name: ex.vendor_name, account_number: ex.account_number || null, backfill: !!light, draft, drv: drvContext },
      community_id: res.community_id, resolved_contact_id: res.contact_id, resolved_property_id: res.property_id, resolved_vendor_id: res.vendor_id,
      resolution_confidence: res.confidence, resolution_candidates: res.candidates,
      triage_status: ex.is_spam ? 'spam' : (res.confidence === 'high' ? 'linked' : (res.candidates.length ? 'needs_review' : 'new')),
      priority: ex.priority || 'normal',
    };
    // Stamp the owning AI team member (Claire/Emma/Annie/Miranda) for the roster.
    try { row.persona = require('./persona').personaForMessage(row); } catch (_) {}
    // Idempotent by internet_message_id (partial unique index on graph_id can't
    // be targeted by upsert, so delete-then-insert on the stable id).
    if (row.internet_message_id) await supabase.from('email_messages').delete().eq('internet_message_id', row.internet_message_id);
    const { data: ins, error } = await supabase.from('email_messages').insert(row).select('id').single();
    if (error) return { r: 'skipped' };
    const insId = ins && ins.id;

    let invoices = 0, acc = 0, drv = 0, autoGl = 0, filed = 0;
    // HANDS-OFF RECORDING: an exact service-account match to a mapping Ed already
    // TAUGHT (high confidence) records the payment to the GL by itself, flagged
    // needs_review. First-time vendors/accounts are NOT auto-posted — they stay
    // as an exception for Ed to code, and that coding teaches the map. So nothing
    // auto-posts that Ed hasn't coded once. (system-as-operator / single-teacher.)
    if (insId && vcMapping && vcMapping.confidence === 'high' && vcMapping.gl_account_id && ex.classification === 'vendor_financial') {
      try {
        const { recordVendorPaymentToGL, singleAmountCents } = require('../accounting/record_vendor_payment');
        const cents = singleAmountCents(ex.amounts);
        if (cents && res.community_id) {
          const out = await recordVendorPaymentToGL({
            communityId: res.community_id, amountCents: cents, glAccountId: vcMapping.gl_account_id,
            vendorId: res.vendor_id, vendorName: ex.vendor_name || email.sender_name,
            description: `Auto: ${email.subject || 'Vendor payment'}`,
            postingDate: (email.received_at ? String(email.received_at).slice(0, 10) : undefined),
            sourceRef: `email:${insId}`, notes: 'Auto-recorded from a learned vendor mapping. Flagged for month-end review.',
          });
          if (out.ok) {
            autoGl = 1;
            await supabase.from('email_messages').update({ triage_status: 'handled', extracted: { ...row.extracted, auto_gl: { je_id: out.je_id, amount_cents: cents } } }).eq('id', insId);
            try { const { learnMapping } = require('../ap/vendor_community'); await learnMapping({ accountNumber: ex.account_number, vendorId: res.vendor_id, vendorName: ex.vendor_name || email.sender_name, communityId: res.community_id, glAccountId: vcMapping.gl_account_id }); } catch (_) {}
          }
        }
      } catch (e) { console.warn('[graph_ingest] auto-record skipped:', e.message); }
    }
    // Miranda's DRV handoff: log the homeowner's response (and photos) ONTO the
    // open case, plus her held draft, so it lives in the case history instead of
    // an inbox. She changes no enforcement state — a human reviews + sends.
    if (drvContext) {
      try {
        const { logDrvInbound } = require('../enforcement/drv_reply');
        await logDrvInbound({ email, openCase: { id: drvContext.violation_id, community_id: drvContext.community_id, property_id: res.property_id }, propertyId: res.property_id, contactId: res.contact_id, draft });
        drv = 1;
      } catch (e) { console.warn('[graph_ingest] drv case-log skipped:', e.message); }
    }
    // Emma's inbox: a vendor invoice emailed to emma@ flows through the SAME AP
    // intake as uploads and scans — extracted, deduped, loaded to the payables
    // queue. Best-effort, idempotent via the source ref so repeat pulls don't
    // re-process.
    if (!light && email.direction === 'inbound' && email.has_attachments && email.graph_id &&
        String(mailbox).toLowerCase() === String(EMMA_MAILBOX || '').toLowerCase()) {
      try {
        const srcRef = `email:${email.graph_id}`;
        const { data: already } = await supabase.from('ap_invoices').select('id').eq('intake_source_ref', srcRef).limit(1);
        if (!already || !already.length) {
          const { autoIntake } = require('../ap/intake');
          const pdfs = await fetchAttachmentBuffers(mailbox, email.graph_id);
          for (const pdf of pdfs) {
            const out = await autoIntake({ buffer: pdf.buffer, filename: pdf.filename, intakeMethod: 'email', sourceRef: srcRef, communityId: res.community_id || null, vendorIdHint: res.vendor_id || null, achHintText: `${email.subject || ''} ${email.body_full || email.body_preview || ''}` });
            if (out && (out.outcome === 'loaded' || out.outcome === 'held_suspected_duplicate')) invoices += 1;
          }
        }
      } catch (e) { console.warn('[graph_ingest] emma AP intake skipped:', e.message); }
    }

    // Claire's front-desk handoff to Annie (ACC/ARC specialist): an inbound
    // email Claire classified as an architectural application, WITH the form
    // attached, runs through the SAME ACC pipeline as a web submission
    // (community_applications -> completeness -> AI assessment -> review queue)
    // and the homeowner gets a receipt. Best-effort, idempotent via
    // intake_source_ref, and it HOLDS the decision for a human to finalize.
    if (!light && email.direction === 'inbound' && email.has_attachments && email.graph_id && ex.classification === 'acc_request') {
      try {
        const { intakeApplicationFromEmail } = require('../applications/email_intake');
        const out = await intakeApplicationFromEmail({ email, extracted: ex, communityId: res.community_id || null });
        if (out && out.status === 'created') acc = 1;
      } catch (e) { console.warn('[graph_ingest] ACC application intake skipped:', e.message); }
    }
    // Zero-inbox move — LAST, after every attachment-dependent step above (which
    // needs the current message id). Only for messages actually in the Inbox, so
    // mail filed on a prior pull isn't touched again. Best-effort.
    if (fileProcessed && inboxId && insId && gm.parentFolderId === inboxId) {
      try {
        const { fileMessage } = require('./graph_move');
        const mv = await fileMessage(mailbox, gm.id);
        if (mv.moved) { filed = 1; if (mv.new_id) { try { await supabase.from('email_messages').update({ graph_id: mv.new_id }).eq('id', insId); } catch (_) {} } }
      } catch (e) { console.warn('[graph_ingest] file-to-folder skipped:', e.message); }
    }
    return { r: 'kept', linked: isLinked, invoices, acc, drv, autoGl, filed };
  }

  while (url && stats.scanned < max) {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) throw new Error(`Graph messages failed (${r.status}): ${(await r.text().catch(() => '')).slice(0, 160)}`);
    const j = await r.json();
    let page = j.value || [];
    if (stats.scanned + page.length > max) page = page.slice(0, max - stats.scanned);
    stats.scanned += page.length;

    // THE big speedup: skip mail we've already fully processed. One cheap batch
    // query per page instead of re-running two AI calls on every already-seen
    // message. Backfill placeholders (light pass, no draft) are NOT skipped, so
    // they still get a full-fidelity pass once. `force` re-processes everything.
    let toProcess = page;
    if (!force) {
      const ids = page.map((m) => m.internetMessageId).filter(Boolean);
      if (ids.length) {
        const { data: existing } = await supabase
          .from('email_messages').select('internet_message_id, extracted').in('internet_message_id', ids);
        const done = new Set((existing || [])
          .filter((e) => !(e.extracted && e.extracted.backfill === true))
          .map((e) => e.internet_message_id));
        if (done.size) {
          const before = page.length;
          toProcess = page.filter((m) => !(m.internetMessageId && done.has(m.internetMessageId)));
          stats.skipped += before - toProcess.length;
          // Backlog drain: mail already processed but STILL in the Outlook Inbox
          // (e.g. everything ingested before this feature) gets filed now, so a
          // pull empties the inbox instead of only handling new arrivals.
          if (fileProcessed && inboxId) {
            const stale = page.filter((m) => m.parentFolderId === inboxId && m.internetMessageId && done.has(m.internetMessageId));
            const { fileMessage } = require('./graph_move');
            for (let i = 0; i < stale.length; i += CONCURRENCY) {
              const outs = await Promise.all(stale.slice(i, i + CONCURRENCY).map((gm) => fileMessage(mailbox, gm.id).catch(() => ({ moved: false }))));
              for (const o of outs) if (o && o.moved) stats.filed = (stats.filed || 0) + 1;
            }
          }
        }
      }
    }

    // Process the genuinely-new messages a few at a time.
    for (let i = 0; i < toProcess.length; i += CONCURRENCY) {
      const chunk = toProcess.slice(i, i + CONCURRENCY);
      const outs = await Promise.all(chunk.map((gm) => handleMessage(gm).catch(() => ({ r: 'skipped' }))));
      for (const o of outs) {
        if (o && o.r === 'kept') { stats.kept += 1; if (o.linked) stats.linked += 1; if (o.invoices) stats.invoices_loaded = (stats.invoices_loaded || 0) + o.invoices; if (o.acc) stats.acc_apps = (stats.acc_apps || 0) + o.acc; if (o.drv) stats.drv_replies = (stats.drv_replies || 0) + o.drv; if (o.autoGl) stats.auto_gl = (stats.auto_gl || 0) + o.autoGl; if (o.filed) stats.filed = (stats.filed || 0) + o.filed; }
        else stats.skipped += 1;
      }
    }
    url = j['@odata.nextLink'] || null;
  }
  return stats;
}

module.exports = { ingestMailbox, isConfigured };
