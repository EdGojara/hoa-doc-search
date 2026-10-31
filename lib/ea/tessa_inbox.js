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

// HTML -> readable text. ONE canonical helper (lib/email/graph_attachments)
// so quoted history keeps its line breaks. The local copy that used to live
// here treated <br> as a closing tag (</br>, which never exists), so signature
// lines separated by <br> collapsed into one run-on line in the quoted thread.
const { htmlToText } = require('../email/graph_attachments');

// Pull the ORIGINAL sender out of a forwarded email body — the first "From:"
// line in the quoted block. Handles: From: Name <e@x.com> / From: "Org" <e@x.com>
// / From: e@x.com. Returns { email, name } or null.
function extractForwardedSender(text) {
  if (!text) return null;
  const m = String(text).match(/^\s*(?:From|De|Von)\s*:\s*(.+)$/mi);
  if (!m) return null;
  const line = m[1].trim();
  const email = (line.match(/<\s*([^<>@\s]+@[^<>@\s]+)\s*>/) || line.match(/([^<>@\s]+@[^<>@\s]+)/) || [])[1];
  if (!email) return null;
  let name = line.replace(/<[^>]*>/, '').replace(/["']/g, '').replace(/[;,]\s*$/, '').trim();
  if (!name || /@/.test(name)) name = email.split('@')[0];
  return { email: email.toLowerCase(), name };
}

function isConfigured() { return graphSend.isConfigured(); }

// Poll tessa@ for new inbound mail, draft a reply for each, store in ea_inbox.
// Returns { scanned, drafted, skipped, error? }. Best-effort per message.
async function pollTessaInbox({ max = 25, mode = 'tessa' } = {}) {
  const stats = { scanned: 0, drafted: 0, skipped: 0 };
  let _lastDrafted = null;   // newest drafted item, for the owner SMS heads-up
  const mailbox = graphSend.TESSA_MAILBOX;
  if (!mailbox) return { ...stats, error: 'tessa_mailbox_not_configured' };
  if (!graphSend.isConfigured()) return { ...stats, error: 'graph_not_configured' };

  const token = await graphSend.getToken();
  const sel = ['id', 'internetMessageId', 'conversationId', 'from', 'toRecipients', 'ccRecipients', 'subject', 'bodyPreview', 'body', 'receivedDateTime', 'hasAttachments'].join(',');
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

    // Delivery evidence (Ed 2026-10-07, Nicole Hill): a bounce report marks the
    // address it names as bounced; a person writing in verifies their address.
    // Best-effort: evidence is never a reason to drop the message.
    try {
      const AS = require('./address_status');
      const own = Object.entries(graphSend).filter(([k, v]) => /_MAILBOX$/.test(k) && typeof v === 'string').map(([, v]) => v);
      const msg = {
        id: graphId, subject, preview: String(bodyText).slice(0, 2000), received_at: m.receivedDateTime,
        from: { email: fromAddr, name: (m.from && m.from.emailAddress && m.from.emailAddress.name) || null },
        to: (m.toRecipients || []).map((x) => ({ email: ((x.emailAddress || {}).address || '').toLowerCase(), name: (x.emailAddress || {}).name || null })),
      };
      const ndr = AS.parseNdr(msg, own);
      const evs = ndr ? ndr.failed.flatMap((e) => AS.eventsFromMessages(e, [msg], own)) : AS.eventsFromMessages(fromAddr, [msg], own);
      if (evs.length) await AS.supabaseStore(supabase).addEvents(evs);
    } catch (e) { console.warn('[tessa] delivery evidence not recorded:', e.message); }

    // ── Owner authorization of conversion approvals (mig 554) ───────────────
    // Ed replies "approved" to an "Owner authorization XXXXXXXX" request Tessa sent:
    // verified (owner mailbox, exact subject, unexpired, Exchange AuthAs Internal),
    // recorded with its evidence, then executed item by item by the AI team.
    try {
      if (/owner authorization [0-9a-f]{8}\b/i.test(subject)) {
        const OA = require('../onboarding/owner_authorization');
        const { data: requests, error: rqErr } = await supabase.from('owner_authorizations').select('*').eq('status', 'requested');
        if (rqErr) throw new Error(rqErr.message);
        const hResp = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/messages/${encodeURIComponent(graphId)}?$select=internetMessageHeaders,sender,conversationId`, { headers: { Authorization: `Bearer ${token}` } });
        const hj = hResp.ok ? await hResp.json() : {};
        const headers = hj.internetMessageHeaders || [];
        const v = OA.authorizationFromReply({ ...m, sender: hj.sender || null, conversationId: hj.conversationId || m.conversationId, replyText: bodyText }, { requests, ownerEmail: graphSend.ED_MAILBOX, headers });
        if (v.match) {
          const { data: prof, error: pErr } = await supabase.from('user_profiles').select('id').ilike('email', graphSend.ED_MAILBOX).limit(1);
          if (pErr || !prof || !prof.length) throw new Error('owner user id not found' + (pErr ? ': ' + pErr.message : ''));
          const rec = await supabase.rpc('owner_authorization_record', { p_id: v.request.id, p_user_id: prof[0].id, p_email: fromAddr, p_evidence: v.evidence });
          if (rec.error) throw new Error(rec.error.message);
          const { data: auth, error: aErr } = await supabase.from('owner_authorizations').select('*').eq('id', v.request.id).single();
          if (aErr) throw new Error(aErr.message);
          const { createOnboardingService, supabaseBackends } = require('../onboarding/service');
          const svc = createOnboardingService(supabaseBackends(supabase));
          const rpc = async (name, args) => { const { data, error } = await supabase.rpc(name, args); if (error) throw new Error(error.message); return data; };
          const out = await OA.executeAuthorization({ rpc, operate: (id) => svc.operate(id), authorization: auth });
          console.log(`[tessa] owner authorization ${auth.id} by ${fromAddr}: ${out.approved} approved, ${out.failed} failed`, JSON.stringify(out.operated));
          stats.skipped += 1;
          continue;
        } else if (v.request) console.warn(`[tessa] owner authorization reply NOT accepted (${v.why}) for "${subject}"`);
      }
    } catch (e) { console.warn('[tessa] owner authorization hook failed:', e.message); }

    // ── Billing-package approval ────────────────────────────────────────────
    // Ed replies "approved" to a billing package Tessa sent → post the invoices
    // to the association's AP. Only Ed can approve (owner-gated). Matched by the
    // exact subject of a pending review, so it can't fire on an unrelated email.
    // (Ed 2026-08-25.) Gate + idempotency live in post_fee_to_ap.js.
    try {
      const edMb = String(graphSend.ED_MAILBOX || '').toLowerCase();
      const isApprovalReply = fromAddr && fromAddr === edMb
        && /billing package for review/i.test(subject)
        && /\bapprov/i.test(bodyText);
      if (isApprovalReply) {
        const normSubj = (s) => String(s || '').replace(/^\s*(re|fw|fwd)\s*:\s*/i, '').trim().toLowerCase();
        const { data: reviews } = await supabase.from('billing_package_reviews').select('*').eq('status', 'pending');
        const review = (reviews || []).find((r) => normSubj(r.subject) === normSubj(subject));
        if (review) {
          const { postBedrockInvoiceToAP } = require('../billing/post_fee_to_ap');
          const results = [];
          for (const invId of (review.invoice_ids || [])) {
            try { results.push(await postBedrockInvoiceToAP(supabase, { invoiceId: invId, approvedBy: fromAddr })); }
            catch (e) { results.push({ invoiceId: invId, error: e.message }); }
          }
          const apIds = results.filter((r) => r.posted && r.ap_invoice_id).map((r) => r.ap_invoice_id);
          await supabase.from('billing_package_reviews').update({
            status: 'posted', approved_at: new Date().toISOString(), approved_by: fromAddr,
            posted_ap_invoice_ids: apIds, post_note: JSON.stringify(results).slice(0, 1000),
          }).eq('id', review.id);
          console.log(`[tessa] billing approved by ${fromAddr} for "${review.subject}" — posted ${apIds.length} to AP; results:`, JSON.stringify(results));
          stats.skipped += 1;   // handled as an action, not a draft
          continue;
        }
      }
    } catch (e) { console.warn('[tessa] billing approval hook skipped:', e.message); }

    // When Ed FORWARDS an email to Tessa so she'll follow up for him, the reply
    // must go to the ORIGINAL sender (the person who emailed Ed) — not back to Ed.
    // The immediate `from` is Ed; the real correspondent is the first "From:" line
    // in the forwarded body. (Ed 2026-08-10 — a reply to a UPS security proposal
    // defaulted to egojara@ because Ed forwarded it.)
    const edMailbox = String(graphSend.ED_MAILBOX || '').toLowerCase();
    let replyToEmail = fromAddr || null;
    let replyToName = fromName;
    const isForward = (edMailbox && fromAddr === edMailbox) || /^\s*(fw|fwd)\s*:/i.test(subject);
    if (isForward) {
      const orig = extractForwardedSender(bodyText);
      if (orig && orig.email && orig.email !== edMailbox && orig.email !== String(mailbox).toLowerCase()) {
        replyToEmail = orig.email;
        replyToName = orig.name || replyToName;
      }
    }

    // WHO IS SHE, and who is writing. Tessa ALWAYS replies as herself now:
    // Ed 2026-08-20, 'i dont want tessa send as me she can say i asked her to
    // send it.' She used to ghostwrite in his first person from his own
    // mailbox, so Martha wrote 'Hi tessa, how are you doing today?' and got
    // back, over Ed's name, 'I think you meant this for Tessa directly.'
    //
    // What still varies is WHY the message is here. Ed forwarding something is
    // him handing her his correspondence, so she answers the original sender on
    // his behalf. Anyone else is writing to Tessa, and she answers them.
    // WAS SHE ASKED, OR COPIED?
    //
    // Ed 2026-08-20 copies her on his own correspondence so she knows what is
    // going on, starting with a personnel matter. An assistant who replied to
    // everything their principal copied them on would be a liability, so being
    // on the CC line files the message and drafts nothing.
    //
    // She could not tell the difference until now because the Graph query did
    // not fetch the recipient list at all.
    const toList = (m.toRecipients || []).map((x) => ((x.emailAddress || {}).address || '').toLowerCase());
    const ccList = (m.ccRecipients || []).map((x) => ((x.emailAddress || {}).address || '').toLowerCase());
    const me = String(mailbox).toLowerCase();
    // Neither list naming her means BCC, which is still not being asked.
    const addressedAs = toList.includes(me) ? 'to' : (ccList.includes(me) ? 'cc' : 'bcc');

    const forwardedByEd = !!(edMailbox && fromAddr === edMailbox);

    // A teammate is not a business correspondent. Ed 2026-08-20: 'she should
    // have good interactions with her staff and team.' Their title comes from
    // the address book so she knows Martha is a Community Manager.
    const isColleague = /@bedrocktx\.com$/i.test(replyToEmail || '');
    let title = null;
    if (isColleague) {
      const { data: who } = await supabase.from('ea_contacts')
        .select('title, role').ilike('email', replyToEmail).maybeSingle();
      title = who && (who.title || who.role);
    }

    // Copied in means keep her informed. No draft, nothing to review, and
    // nothing that could be sent to a third party by accident.
    const shouldDraft = addressedAs === 'to';

    let draft = null;
    if (shouldDraft) {
      try {
        draft = await draftReply({
          incomingSubject: subject, incomingBody: bodyText, fromName: replyToName,
          mode: 'tessa',
          sender: { isColleague, title, forwardedByEd },
        });
      } catch (e) { console.warn('[tessa] draftReply failed:', e.message); }
    }

    const row = {
      graph_id: graphId,
      from_email: replyToEmail,
      from_name: replyToName,
      subject,
      body_preview: String(bodyText).slice(0, 2000),
      // The whole message, not just the first 2,000 characters. Her draft is
      // made here with bodyText in hand, so it reads fine; every later look at
      // the item reads the stored row instead. On a forwarded thread the part
      // that gets cut is the bottom, which is the original message. (Ed
      // 2026-08-20 — same defect as email_messages.body_full.)
      body_full: String(bodyText).slice(0, 40000) || null,
      received_at: m.receivedDateTime || null,
      draft_subject: draft && !draft.degraded ? draft.subject : null,
      draft_body: draft && !draft.degraded ? draft.body : null,
      draft_mode: 'tessa',   // she signs as herself, always
      addressed_as: addressedAs,
      // Keep the lists, not just the conclusion drawn from them.
      //
      // These were built above to decide whether Ed was on the To line or the
      // Cc line, then thrown away. Without them a reply can only ever go back
      // to the sender, so Ed had no way to answer a board thread that reached
      // five aliases plus the manager. Reply-all was not switched off, it was
      // impossible. (Ed 2026-08-21: "how do i know tessa is replying to all or
      // just sender?")
      to_recipients: toList.length ? toList : null,
      cc_recipients: ccList.length ? ccList : null,
      // The thread, and the NAMES of its files (never the bytes), so a document
      // Ed is waiting on can be recognised when it comes back. (Ed 2026-10-19.)
      conversation_id: m.conversationId || null,
      attachment_names: m.hasAttachments ? await attachmentNames(mailbox, graphId) : null,
      // Copied in (Cc/Bcc): filed as "Copied (FYI)", no draft, until Ed gives her an
      // instruction. It used to be 'dismissed', which read as "Ed threw this away"
      // and left him no way to act on it. (Ed 2026-10-19, Paul Grover "RE: Tax return".)
      status: shouldDraft ? 'needs_review' : 'fyi',
    };
    let { data: saved, error } = await insertInboxRow(row);
    if (error) { console.warn('[tessa] ea_inbox insert failed:', error.message); stats.skipped += 1; continue; }
    // A document someone is waiting on? Recorded as RECEIVED, never as verified.
    try {
      const hits = await require('./delegation_store').onInboxMessage(supabase, { ...row, id: saved && saved.id });
      if (hits.length) stats.documents_received = (stats.documents_received || 0) + hits.length;
    } catch (e) { console.warn('[tessa] delegation match skipped:', e.message); }
    stats.drafted += 1;
    // Only what needs Ed's review counts toward the text; a copied (FYI) message does not.
    if (row.status === 'needs_review') { stats.needs_review = (stats.needs_review || 0) + 1; _lastDrafted = { subject: row.subject, from: row.from_name }; }
  }

  // Tessa texts Ed when new items land that need his review. One batched text
  // per poll (never one-per-item), and only when TESSA_SMS_ALERTS + OWNER_MOBILE
  // are set — otherwise a silent no-op. (Ed 2026-09-12: "so if something comes
  // up tessa can text me.")
  try {
    if ((stats.needs_review || 0) > 0 || (stats.documents_received || 0) > 0) {
      const { alertsEnabled, textOwner } = require('../notifications/notify_owner');
      if (alertsEnabled()) {
        const n = stats.needs_review || 0;
        const latest = _lastDrafted ? ` Latest: "${String(_lastDrafted.subject || '(no subject)').slice(0, 80)}" from ${_lastDrafted.from || 'someone'}.` : '';
        const docs = stats.documents_received || 0;
        const parts = [n ? `${n} new email${n > 1 ? 's' : ''} need your review.${latest}` : '', docs ? `${docs} document${docs > 1 ? 's' : ''} you were waiting on came back (not yet checked).` : ''].filter(Boolean);
        await textOwner(`Tessa here. ${parts.join(' ')} They're in my inbox in trustEd.`);
      }
    }
  } catch (e) { console.warn('[tessa] owner SMS alert skipped:', e.message); }

  return stats;
}

async function attachmentNames(mailbox, graphId) {
  try { return await require('../email/graph_attachments').fetchAttachmentNames(mailbox, graphId); }
  catch (e) { console.warn('[tessa] attachment names not read:', e.message); return null; }
}

// Insert one inbox row. Before migration 537 the table has no fyi status and no
// thread / attachment columns: never lose the message over that. Store it the old
// way (the app still shows a copied message as FYI) and say so in the log.
async function insertInboxRow(row) {
  let r = await supabase.from('ea_inbox').insert(row).select('id').single();
  if (r.error && /conversation_id|attachment_names|schema cache|column/i.test(r.error.message || '')) {
    console.warn('[tessa] ea_inbox has no thread/attachment columns yet (migration 537); storing without them');
    const { conversation_id, attachment_names, ...rest } = row; row = rest;
    r = await supabase.from('ea_inbox').insert(row).select('id').single();
  }
  if (r.error && row.status === 'fyi' && /ea_inbox_status_check|check constraint/i.test(r.error.message || '')) {
    console.warn('[tessa] ea_inbox has no fyi status yet (migration 537); filing the copied message as dismissed');
    r = await supabase.from('ea_inbox').insert({ ...row, status: 'dismissed' }).select('id').single();
  }
  return r;
}

// Is this inbox item mail Tessa was only COPIED on, filed without a draft, that
// Ed has not acted on? Either the 'fyi' status (migration 537), or a row filed
// before it: Cc/Bcc, 'dismissed' at the moment it was filed and never touched
// since (Ed setting an item aside moves updated_at past created_at). Read-only;
// no existing row is rewritten.
function isCopiedFyi(item) {
  if (!item) return false;
  if (item.status === 'fyi') return true;
  if (item.status !== 'dismissed' || !item.addressed_as || item.addressed_as === 'to') return false;
  if (item.draft_body) return false;
  const c = Date.parse(item.created_at), u = Date.parse(item.updated_at);
  return Number.isFinite(c) && Number.isFinite(u) && Math.abs(u - c) < 2000;
}

module.exports = { pollTessaInbox, isConfigured, htmlToText, isCopiedFyi };
