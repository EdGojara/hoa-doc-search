// ============================================================================
// lib/email/graph_send.js  (Ed 2026-07-05) — send mail as Claire via Microsoft
// Graph (application permissions, client-credentials flow).
// ----------------------------------------------------------------------------
// Sends from a real M365 mailbox on bedrocktx.com (SPF/DKIM already valid, so
// deliverability is clean). Requires an Azure app registration with the
// APPLICATION permission Mail.Send, scoped by an Application Access Policy to
// ONLY claire@ (and info@ for ingest) so it can't touch the rest of the tenant.
//
// Env (set after the Azure app is created):
//   GRAPH_TENANT_ID, GRAPH_CLIENT_ID, GRAPH_CLIENT_SECRET
//   CLAIRE_MAILBOX (optional, default claire@bedrocktx.com)
//
// isConfigured() is false until those are present — callers surface a clean
// "Claire isn't connected yet" instead of erroring.
// ============================================================================
const CLAIRE_MAILBOX = process.env.CLAIRE_MAILBOX || 'claire@bedrocktx.com';
const EMMA_MAILBOX = process.env.EMMA_MAILBOX || 'emma@bedrocktx.com';
const TESSA_MAILBOX = process.env.TESSA_MAILBOX || 'tessa@bedrocktx.com';   // Ed's EA
const ED_MAILBOX = process.env.ED_MAILBOX || 'egojara@bedrocktx.com';        // Ed himself (ghostwritten sends)
const ANNIE_MAILBOX = process.env.ANNIE_MAILBOX || 'annie@bedrocktx.com';    // ACC/ARC specialist (Annie Reeves)
const MIRANDA_MAILBOX = process.env.MIRANDA_MAILBOX || 'miranda@bedrocktx.com'; // DRV specialist (Miranda Pierce)
const PAIGE_MAILBOX = process.env.PAIGE_MAILBOX || 'paige@bedrocktx.com';     // Board operations (Paige Chandler)
const REESE_MAILBOX = process.env.REESE_MAILBOX || 'reese@bedrocktx.com';     // Resale / estoppels / closings / transfers (Reese Calloway)
const KAT_MAILBOX = process.env.KAT_MAILBOX || 'kat@bedrocktx.com';           // Accounting Manager — close/reconciliation/financials, over Emma (Katherine "Kat" Reed)
const DARBY_MAILBOX = process.env.DARBY_MAILBOX || 'darby@bedrocktx.com';     // Legal & Collections Coordinator — paralegal / counsel liaison (Darby Woods)
const PHOEBE_MAILBOX = process.env.PHOEBE_MAILBOX || 'phoebe@bedrocktx.com';  // Community Engagement Coordinator — resident submissions / newsletter (Phoebe Hart)
// Internal Bedrock-ops team (company-facing, not community-facing). Dark today.
const MAGGIE_MAILBOX = process.env.MAGGIE_MAILBOX || 'maggie@bedrocktx.com';  // Director of Growth & Community Relations (Maggie Sullivan)
const VIVIAN_MAILBOX = process.env.VIVIAN_MAILBOX || 'vivian@bedrocktx.com';  // Human Resources Director (Vivian Hale)
// TWO ADDRESSES, ON PURPOSE (verified against Graph 2026-08-19).
//   amanda@bedrocktx.com          — the ALIAS. What people write to, what her
//                                    signature shows. Mail to it routes fine.
//   amandaalbright@bedrocktx.com  — the mailbox IDENTITY. Graph resolves users
//                                    by UPN / primary SMTP, never by alias, so
//                                    /users/amanda@... returns 404 ErrorInvalidUser
//                                    while /users/amandaalbright@... returns a real
//                                    result. This constant feeds Graph, so it must
//                                    be the identity.
// Do not "tidy" these into one. The 404 on the alias looks exactly like a
// missing mailbox and sent me chasing a mailbox that had existed all along.
const AMANDA_MAILBOX = process.env.AMANDA_MAILBOX || 'amandaalbright@bedrocktx.com';  // Senior Community Manager — escalation tier for tough/cross-domain issues (Amanda Albright)
// Language front office — same lane as Claire, in another language (Ed 2026-09-13
// created these mailboxes in M365). Body drafts in English for review and
// translates to the resident's language at send (lib/email/translate.js).
const ISABELLA_MAILBOX = process.env.ISABELLA_MAILBOX || 'isabella@bedrocktx.com'; // Front office (Español) — Isabella Reyes
const MEI_MAILBOX = process.env.MEI_MAILBOX || 'mei@bedrocktx.com';                 // Front office (中文) — Mei Chen
const PRIYA_MAILBOX = process.env.PRIYA_MAILBOX || 'priya@bedrocktx.com';           // Front office (हिन्दी) — Priya Sharma
const BILLING_MAILBOX = process.env.BILLING_MAILBOX || 'billing@bedrocktx.com'; // staff -> Tessa billing-item intake (Tessa processes)

// ---------------------------------------------------------------------------
// THE canonical "pull every AI inbox" list (Ed 2026-09-07: "make sure this is
// the case for all the emails"). The /pull endpoint used to hand-list mailboxes
// and had silently dropped darby@ and phoebe@ — so a reply to those inboxes was
// never ingested and never owned by anyone (the exact way Noreen's reply to
// Claire went missing). This is the ONE list every ingest path pulls, so adding
// a teammate's mailbox is a one-line change here, not a scavenger hunt across
// endpoints. Uses the Graph IDENTITY address (amandaalbright@, not the alias).
// Excludes tessa@ (Ed's owner-only EA, ingested on her own gated surface) and
// the dark internal-ops boxes (maggie@/vivian@). info@ is the shared front door.
const TEAM_INGEST_MAILBOXES = [
  'info@bedrocktx.com',
  'welcome@bedrocktx.com', // Public website and general inquiries; routes through existing front-door triage.
  CLAIRE_MAILBOX, EMMA_MAILBOX, KAT_MAILBOX, ANNIE_MAILBOX, MIRANDA_MAILBOX,
  AMANDA_MAILBOX, REESE_MAILBOX, DARBY_MAILBOX, PAIGE_MAILBOX, PHOEBE_MAILBOX,
  // Language front office (Ed 2026-09-13). Mail here is owned by the persona at
  // that mailbox (personaFor in email_triage.js).
  ISABELLA_MAILBOX, MEI_MAILBOX, PRIYA_MAILBOX,
  // Functional inbox addresses that exist in M365 (verified via Graph 2026-09-07).
  // Mail here routes to the owning specialist by FUNCTIONAL_INBOX in persona.js:
  // violations@ -> Miranda, accounting@ -> Kat, jobs@ -> Vivian (HR). (acc@/
  // builders@/arc@ don't exist — ACC mail routes to Annie by classification.)
  'violations@bedrocktx.com', 'accounting@bedrocktx.com', 'jobs@bedrocktx.com',
  // Internal-ops teammates' own inboxes (HR + Growth). (Ed 2026-09-07.)
  VIVIAN_MAILBOX, MAGGIE_MAILBOX,
];

// ---------------------------------------------------------------------------
// KILL SWITCH for AUTOMATED outbound. (Ed 2026-07-15: "I release all outbound
// emails for now until we get the system working better — there are way too
// many errors right now.")
//
// Gates only sends that fire with NO human in the loop — today that's Annie's
// ARC receipt and Tessa's billing auto-reply. It deliberately does NOT gate
// human-released sends (an approved Claire reply, an internal forward, a
// finalized ACC decision, a Tessa compose): there, the click IS the release.
//
// FAIL-SAFE OFF: unset/blank/anything-but-on means HELD. Turning automated mail
// back on is a deliberate act (set AUTO_OUTBOUND_EMAIL=on), never something a
// missing env var does by accident. Held sends are RECORDED on the record with
// a reason (see acc_decisions.acknowledgment_error) so a held receipt is
// visible, never silent.
// ---------------------------------------------------------------------------
function autoSendEnabled() {
  return /^(1|true|on|yes|enabled)$/i.test(String(process.env.AUTO_OUTBOUND_EMAIL || '').trim());
}

function isConfigured() {
  return !!(process.env.GRAPH_TENANT_ID && process.env.GRAPH_CLIENT_ID && process.env.GRAPH_CLIENT_SECRET);
}

let _tok = { value: null, exp: 0 };
async function getToken() {
  if (_tok.value && Date.now() < _tok.exp - 60000) return _tok.value;
  const url = `https://login.microsoftonline.com/${process.env.GRAPH_TENANT_ID}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    client_id: process.env.GRAPH_CLIENT_ID,
    client_secret: process.env.GRAPH_CLIENT_SECRET,
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials',
  });
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  if (!r.ok) throw new Error(`Graph token failed (${r.status})`);
  const j = await r.json();
  _tok = { value: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return _tok.value;
}

// Send a plain-text email from `fromMailbox` (default Claire). Threads by
// subject (Re: ...) — true In-Reply-To threading across mailboxes isn't
// reliably settable via Graph, so subject-based threading is v1.
// `to` and `cc` accept a single address, a comma/semicolon-separated string,
// or an array — so one email can go to several recipients.
function toRecipientList(v) {
  if (!v) return [];
  const arr = Array.isArray(v) ? v : String(v).split(/[,;]/);
  return arr.map((s) => String(s).trim()).filter((s) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s))
    .map((address) => ({ emailAddress: { address } }));
}

const { graphSendError } = require('./graph_errors');

// ACC DECISION AUTHORITY (Ed 2026-10-20, lib/acc/decision_authority). Every
// app email passes here, so this is where an approval or denial of an
// architectural application is stopped when no authorized decision is recorded:
// Communications replies, the Draft Queue, the ACC reply box, automated jobs.
// The caller that issues an authorized decision names the case (accDecisionId)
// and the case is re-read and re-checked here. Mail only to our own staff
// (internal review, billing) is not a homeowner decision and is not checked.
const INTERNAL_DOMAINS = /@(?:bedrocktx\.com|bedrocktxai\.com)$/i;
let _accSb = null;
// Attachments are read too (lib/acc/attachment_text, Ed 2026-10-29): a decision
// letter attached as a PDF under a neutral body used to pass unchecked.
async function accDecisionGuard({ to, cc, subject, html, text, attachments, accDecisionId, accReconsiderationId, masterPlanSubmissionIds, builderApplicationIds }) {
  const recips = [...toRecipientList(to), ...toRecipientList(cc)].map((r) => r.emailAddress.address);
  if (recips.length && recips.every((a) => INTERNAL_DOMAINS.test(a))) return;
  const DA = require('../acc/decision_authority');
  const files = await require('../acc/attachment_text').readAttachments(attachments);
  // Approvals already decided at the case's property (lib/acc/prior_approvals): a reference to one
  // ("which was approved on August 10, 2026") is the record, not a new approval.
  let priorApprovalDates = [];
  if (accDecisionId) {
    if (!_accSb) _accSb = require('@supabase/supabase-js').createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
    const { data: pr } = await _accSb.from('acc_decisions').select('id, community_id, homeowner_address').eq('id', accDecisionId).maybeSingle();
    if (pr) priorApprovalDates = await require('../acc/prior_approvals').priorApprovalDates(_accSb, pr);
  }
  const chk = DA.checkOutboundText([subject || '', html || text || '', ...files.filter((f) => f.readable).map((f) => f.text)].join('\n'), { priorApprovalDates });
  // An unreadable file (scan, image) named like a decision is held. Files from
  // outside the library that cannot be read are held in ACC email at the
  // Communications reply (api/email_triage), and scanned ACC library records
  // are never attached; scanned governing documents still go out.
  const unreadableDecision = files.filter((f) => !f.readable && f.decisionName);
  if (chk.ok && !unreadableDecision.length) return;
  let caseReason = null;
  if (accDecisionId) {
    if (!_accSb) _accSb = require('@supabase/supabase-js').createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
    const { data: row, error } = await _accSb.from('acc_decisions').select('*').eq('id', accDecisionId).maybeSingle();
    if (error) console.warn('[acc guard] case lookup failed:', accDecisionId, error.message);
    // The decision in effect: a revised decision (migration 576) once issued, or the
    // one being issued now; never the superseded original.
    let effRow = error ? null : row;
    if (effRow) {
      try { effRow = await require('../acc/effective').effectiveAuthorityRow(_accSb, effRow, { reconsiderationId: accReconsiderationId || null }); }
      catch (e2) { console.warn('[acc guard] revised decision lookup failed:', accDecisionId, e2.message); effRow = null; }
    }
    const auth = DA.authorizesOutbound(effRow, chk, recips.filter((a) => !INTERNAL_DOMAINS.test(a)));
    if (auth.ok) return;
    caseReason = auth.reason;
  }
  // A recorded builder master-plan decision authorizes a notice of that decision
  // to its applicant or a recipient recorded on it. Never an unreadable attachment.
  if (Array.isArray(masterPlanSubmissionIds) && masterPlanSubmissionIds.length && !unreadableDecision.length) {
    if (!_accSb) _accSb = require('@supabase/supabase-js').createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
    const { data: subs, error } = await _accSb.from('master_plan_submissions')
      .select('id, reference_number, status, decided_by, decided_at, submitter_email, ai_extraction').in('id', masterPlanSubmissionIds);
    if (error) console.warn('[acc guard] master plan lookup failed:', error.message);
    const found = error ? [] : (subs || []);
    const auth = found.length === new Set(masterPlanSubmissionIds).size
      ? DA.authorizesMasterPlanNotice(found, chk, recips.filter((a) => !INTERNAL_DOMAINS.test(a)))
      : { ok: false, reason: 'a named master plan submission was not found' };
    if (auth.ok) return;
    caseReason = auth.reason;
  }
  // Recorded builder lot decisions authorize a notice of them (their letters) to the submitter or
  // the builder's primary contact of record (the owner-authorized builder reply). Never an unreadable file.
  if (Array.isArray(builderApplicationIds) && builderApplicationIds.length && !unreadableDecision.length) {
    if (!_accSb) _accSb = require('@supabase/supabase-js').createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
    const { data: apps, error } = await _accSb.from('builder_applications')
      .select('id, reference_number, status, decided_by, decided_at, submitter_email, builder_company:builder_companies(primary_contact_email)').in('id', builderApplicationIds);
    if (error) console.warn('[acc guard] builder decision lookup failed:', error.message);
    const found = error ? [] : (apps || []);
    const auth = found.length === new Set(builderApplicationIds).size
      ? DA.authorizesBuilderDecisionNotice(found, chk, recips.filter((a) => !INTERNAL_DOMAINS.test(a)))
      : { ok: false, reason: 'a named builder application was not found' };
    if (auth.ok) return;
    caseReason = auth.reason;
  }
  const inFile = files.filter((f) => f.readable && !DA.checkOutboundText(`${subject || ''}\n${f.text}`, { priorApprovalDates }).ok).concat(unreadableDecision).map((f) => f.name);
  const e = new Error('acc_decision_not_authorized');
  e.code = 'acc_decision_not_authorized'; e.temporary = false; e.preSend = true;
  e.blockedAttachments = inFile;
  e.userMessage = (inFile.length
    ? `Not sent: the attachment ${inFile.map((n) => `"${n}"`).join(', ')} reads as, or could not be checked and may be, an approval or denial of an architectural application, and no authorized decision is recorded for it. Attach a readable copy (not a scan), or send the decision from its ACC case.`
    : 'Not sent: this email approves or denies an architectural application, and no authorized decision is recorded for it.')
    + (caseReason ? ` (${caseReason}.)` : '')
    + ' A decision is issued only once it is recorded on the case (Ed, the Architectural Committee or Board, or Annie or Amanda within delegated authority). You can still send a request for information.';
  throw e;
}

async function sendAs({ from = CLAIRE_MAILBOX, to, cc, subject, text, html, attachments, communityId = null, accDecisionId = null, accReconsiderationId = null, masterPlanSubmissionIds = null, builderApplicationIds = null }) {
  // Demo isolation boundary — the FIRST thing any send does. A demo-org action is
  // suppressed and recorded here, never sent. Signals: communityId (when threaded),
  // the demo execution context, or a reserved demo recipient.
  const _g = await require('../demo/outbound_guard').guardOutbound({ channel: 'email_graph', communityId, to, subject });
  if (_g.blocked) return { sent: false, suppressed: true, reason: _g.reason, from, to };
  await accDecisionGuard({ to, cc, subject, html, text, attachments, accDecisionId, accReconsiderationId, masterPlanSubmissionIds, builderApplicationIds });
  if (!isConfigured()) throw new Error('graph_not_configured');
  const toRecipients = toRecipientList(to);
  const ccRecipients = toRecipientList(cc);
  if (toRecipients.length === 0) throw new Error('recipient_required');
  const token = await getToken();
  const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(from)}/sendMail`;
  // Every email from an AI teammate's mailbox carries that teammate's approved
  // signature, exactly once, however the caller built the body (Ed 2026-11-20).
  ({ html, attachments } = _ensureSignature(from, html, text, attachments));
  const message = {
    subject: subject || '(no subject)',
    body: html ? { contentType: 'HTML', content: html } : { contentType: 'Text', content: text || '' },
    toRecipients,
  };
  if (ccRecipients.length) message.ccRecipients = ccRecipients;
  if (attachments && attachments.length) message.attachments = attachments;
  const payload = { message, saveToSentItems: true };
  const sentAfter = new Date(Date.now() - 60000).toISOString();
  const r = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  if (!(r.status === 202 || r.ok)) {
    const t = await r.text().catch(() => '');
    throw graphSendError('sendMail', r.status, t);
  }
  // sendMail returns no id: find the message in Sent Items so the approval record carries its
  // Microsoft 365 message ID (Ed 2026-10-22). Best effort; never fails a send that succeeded.
  const internetMessageId = await sentMessageId({ from, subject: message.subject, to: toRecipients[0].emailAddress.address, sentAfter, token }).catch(() => null);
  return { sent: true, from, to, internetMessageId };
}

async function sentMessageId({ from, subject, to, sentAfter, token, tries = 3 }) {
  const H = { Authorization: `Bearer ${token}` };
  for (let i = 0; i < tries; i++) {
    if (i) await new Promise((r) => setTimeout(r, 1500));
    const q = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(from)}/mailFolders/sentitems/messages?$top=10&$orderby=sentDateTime desc&$select=internetMessageId,subject,sentDateTime,toRecipients&$filter=sentDateTime ge ${sentAfter}`;
    const r = await fetch(q, { headers: H });
    if (!r.ok) continue;
    const hit = ((await r.json()).value || []).find((m) => String(m.subject || '') === String(subject || '') && (m.toRecipients || []).some((x) => String(x.emailAddress && x.emailAddress.address || '').toLowerCase() === String(to || '').toLowerCase()));
    if (hit && hit.internetMessageId) return hit.internetMessageId;
  }
  return null;
}

// Reply IN THREAD, carrying the quoted history — the Outlook-native reply. Melody
// Hess (NewFirst, 2026-09-09) asked us to include the email history rather than
// start a new message each time, and a fresh sendMail neither quotes the thread
// nor threads correctly. createReply gives a draft that already has the recipient,
// the quoted history, and the In-Reply-To/References headers; we prepend our
// formatted body above the quote, attach files, and send it. (Ed 2026-09-09.)
// Graph can only createReply INSIDE the mailbox that holds the message. A graph id
// from info@ used under /users/claire@/ is rejected by Exchange as
// "ErrorMailboxMoveInProgress ... Cross Server access is not allowed" (Issue #29,
// 2026-10-04: 186 of 280 review-ready replies were cross-mailbox). So the caller
// must say which mailbox the source message lives in, and a mismatch never reaches
// Graph: the caller sends a fresh message from the persona mailbox instead.
const sameMailbox = (a, b) => !!a && !!b && String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

// The mailbox each persona sends from. Mirrors the persona branches in
// api/email_triage.js POST /:id/send (Claire is the default voice).
function personaMailbox(persona) {
  return ({ emma: EMMA_MAILBOX, miranda: MIRANDA_MAILBOX, annie: ANNIE_MAILBOX, paige: PAIGE_MAILBOX, kat: KAT_MAILBOX,
    amanda: AMANDA_MAILBOX, reese: REESE_MAILBOX, isabella: ISABELLA_MAILBOX, mei: MEI_MAILBOX, priya: PRIYA_MAILBOX, maggie: MAGGIE_MAILBOX })[persona] || CLAIRE_MAILBOX;
}

// Sign the body when an AI teammate's mailbox sends it without a signature.
// Returns { html, attachments }: unchanged when already signed or when the
// mailbox is not an AI teammate (Ed's own mail is never signed). Inline images
// already on the message (same contentId) are not attached twice.
function _ensureSignature(from, html, text, attachments) {
  const PS = require('./persona_signature');
  if (!PS.personaForMailbox(from)) return { html, attachments };
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const body = html || (text ? `<div>${esc(text).replace(/\n/g, '<br>')}</div>` : html);
  if (!body) return { html, attachments };
  const signed = PS.signForMailbox(from, body);
  if (signed.html === body) return { html: body, attachments };
  const have = new Set((attachments || []).map((a) => a && a.contentId).filter(Boolean));
  return { html: signed.html, attachments: [...(attachments || []), ...signed.attachments.filter((a) => !have.has(a.contentId))] };
}

// The alt text of the <img> that references cid:<id> in an HTML body, or null.
function _altForCid(html, id) {
  const esc = String(id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const tag = (String(html || '').match(new RegExp(`<img\\b[^>]*\\bsrc=["']cid:${esc}["'][^>]*>`, 'i')) || [])[0];
  if (!tag) return null;
  const m = tag.match(/\balt=["']([^"']*)["']/i);
  return m ? m[1].trim().toLowerCase() : '';
}
// See 1b) in sendReplyAs. Returns the attachment list to add (ours, possibly
// with a renamed contentId). Fails open: if the draft's attachments cannot be
// read, the reply goes out as before rather than not at all.
async function _dedupeReplyInlineImages({ base, H, draftId, quoted, attachments, ours, setOurs }) {
  const list = Array.isArray(attachments) ? attachments.slice() : [];
  const mine = list.filter((a) => a && a.isInline && a.contentId);
  if (!mine.length) return list;
  let existing = [];
  try {
    const r = await fetch(`${base}/messages/${encodeURIComponent(draftId)}/attachments`, { headers: H });
    if (!r.ok) { console.warn('[graph reply] could not list quoted inline images:', r.status); return list; }
    existing = ((await r.json()).value || []).filter((x) => x.isInline && x.contentId);
  } catch (e) { console.warn('[graph reply] could not list quoted inline images:', e.message); return list; }
  for (const a of mine) {
    const clash = existing.filter((x) => String(x.contentId).toLowerCase() === String(a.contentId).toLowerCase());
    if (!clash.length) continue;
    const ourAlt = _altForCid(ours(), a.contentId);
    const theirAlt = _altForCid(quoted, a.contentId);
    if (ourAlt != null && ourAlt === theirAlt) {
      for (const x of clash) {
        const d = await fetch(`${base}/messages/${encodeURIComponent(draftId)}/attachments/${encodeURIComponent(x.id)}`, { method: 'DELETE', headers: H }).catch(() => null);
        if (!d || !(d.ok || d.status === 204)) console.warn('[graph reply] could not drop quoted duplicate image', a.contentId);
      }
    } else {
      const fresh = `${a.contentId}-${Date.now().toString(36)}`;
      setOurs(ours().split(`cid:${a.contentId}"`).join(`cid:${fresh}"`).split(`cid:${a.contentId}'`).join(`cid:${fresh}'`));
      list[list.indexOf(a)] = { ...a, contentId: fresh };
    }
  }
  return list;
}

async function sendReplyAs({ from = CLAIRE_MAILBOX, sourceMailbox, sourceGraphId, to, cc, html, text, attachments, communityId = null, accDecisionId = null, builderApplicationIds = null }) {
  if (!sameMailbox(sourceMailbox, from)) {
    const e = new Error(`cross_mailbox_reply: message lives in ${sourceMailbox || '(unknown mailbox)'}, reply requested from ${from}`);
    e.code = 'cross_mailbox_reply'; e.temporary = false;
    e.userMessage = 'This email is stored in a different mailbox than the one replying, so the reply was not sent.';
    throw e;
  }
  // Demo isolation boundary FIRST (recipient is on the source thread; rely on
  // communityId / demo execution context).
  const _g = await require('../demo/outbound_guard').guardOutbound({ channel: 'email_graph', communityId, to: null, summary: 'reply:' + sourceGraphId });
  if (_g.blocked) return { sent: false, suppressed: true, reason: _g.reason, from, replied_to: sourceGraphId };
  await accDecisionGuard({ to, cc, subject: null, html, text, attachments, accDecisionId, builderApplicationIds });
  if (!isConfigured()) throw new Error('graph_not_configured');
  if (!sourceGraphId) throw new Error('source_message_required');
  const token = await getToken();
  const base = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(from)}`;
  const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  // 1) createReply — a draft carrying the quoted history + threading headers.
  const cr = await fetch(`${base}/messages/${encodeURIComponent(sourceGraphId)}/createReply`, { method: 'POST', headers: H, body: '{}' });
  if (!cr.ok) throw graphSendError('createReply', cr.status, await cr.text().catch(() => ''));
  const draft = await cr.json();
  const draftId = draft.id;
  if (!draftId) throw Object.assign(new Error('createReply returned no draft id'), { step: 'createReply', preSend: true });

  // 2) Prepend our formatted reply above the quoted history Outlook already put
  //    in the draft body. PATCH replaces the body, so we concatenate.
  const quoted = (draft.body && draft.body.content) || '';
  // Our part of the reply carries the teammate's signature exactly once (the
  // quoted history is checked separately below).
  ({ html, attachments } = _ensureSignature(from, html, text, attachments));
  let ourBody = html || `<div>${(text || '').replace(/\n/g, '<br>')}</div>`;
  // 1b) One picture per person. createReply copies the quoted message's inline
  //     images, and a teammate's earlier email uses the SAME contentIds as the
  //     signature we add (cid:headshot, cid:bedrocklogo). Two inline images with
  //     one contentId let the client show either face, in either place: Annie's
  //     replies showed her old portrait next to the approved one (Ed 2026-11-19).
  //     Same subject in both (same alt text): drop the quoted copy, so the quote
  //     and the new signature both show the current approved image. Different
  //     subject (another teammate's quoted signature): rename ours instead, so
  //     neither replaces the other.
  attachments = await _dedupeReplyInlineImages({ base, H, draftId, quoted, attachments, ours: () => ourBody, setOurs: (b) => { ourBody = b; } });
  // The recipients are EXACTLY the ones the person approved: createReply's own choice (the
  // original sender, or its Reply-To) is replaced, never silently kept. (Ed 2026-10-14.)
  const patch = { body: { contentType: 'HTML', content: ourBody + quoted } };
  if (to) patch.toRecipients = toRecipientList(to);
  patch.ccRecipients = cc ? toRecipientList(cc) : [];
  const pr = await fetch(`${base}/messages/${encodeURIComponent(draftId)}`, { method: 'PATCH', headers: H, body: JSON.stringify(patch) });
  if (!pr.ok) throw graphSendError('patch reply', pr.status, await pr.text().catch(() => ''));

  // 2b) Verify what will actually go out before sending: the draft's To/Cc must be exactly the
  //     approved recipients; otherwise the draft is deleted and nothing is sent.
  const want = (v) => toRecipientList(v || []).map((x) => x.emailAddress.address.toLowerCase()).sort().join(',');
  const got = (arr) => (arr || []).map((x) => String(x.emailAddress && x.emailAddress.address || '').toLowerCase()).sort().join(',');
  const vr = await fetch(`${base}/messages/${encodeURIComponent(draftId)}?$select=toRecipients,ccRecipients,internetMessageId`, { headers: H });
  const vd = vr.ok ? await vr.json() : null;
  if (!vd || (to && got(vd.toRecipients) !== want(to)) || got(vd.ccRecipients) !== want(cc)) {
    await fetch(`${base}/messages/${encodeURIComponent(draftId)}`, { method: 'DELETE', headers: H }).catch(() => {});
    const e = new Error(`recipient_verification_failed: draft has To [${vd ? got(vd.toRecipients) : '?'}] Cc [${vd ? got(vd.ccRecipients) : '?'}], approved To [${want(to)}] Cc [${want(cc)}]`);
    e.code = 'recipient_verification_failed'; e.step = 'verify recipients'; e.preSend = true; e.userMessage = 'The reply was not sent: its recipients did not match the ones you approved.'; throw e;
  }
  const verified = { to: vd.toRecipients.map((x) => x.emailAddress.address), cc: (vd.ccRecipients || []).map((x) => x.emailAddress.address) };

  // 3) Attach files to the draft (inline signature images + any documents). Fail
  //    closed: a reply never goes out missing an attachment the person approved. Any
  //    failed upload, or a draft whose attachment list does not match afterwards,
  //    deletes the draft and throws before /send. (Ed 2026-10-20.)
  const abort = async (code, message) => {
    await fetch(`${base}/messages/${encodeURIComponent(draftId)}`, { method: 'DELETE', headers: H }).catch(() => {});
    const e = new Error(message); e.code = code; e.step = 'attach'; e.preSend = true;
    e.userMessage = 'The reply was not sent: an attachment could not be added to it. Nothing went out.'; throw e;
  };
  const files = [];
  for (const a of (attachments || [])) {
    // An unclear answer (network drop, timeout) counts as a failure: the draft has not
    // been sent, so it is deleted and nothing goes out.
    let ar = null;
    try { ar = await fetch(`${base}/messages/${encodeURIComponent(draftId)}/attachments`, { method: 'POST', headers: H, body: JSON.stringify(a) }); }
    catch (e) { await abort('attachment_failed', `attachment_failed: ${a && a.name} (no response: ${e.message})`); }
    if (!ar.ok) await abort('attachment_failed', `attachment_failed: ${a && a.name} (${ar.status})`);
    if (!a.isInline) files.push(a);
  }
  if (files.length) {
    let onDraft = null;
    try {
      const lr = await fetch(`${base}/messages/${encodeURIComponent(draftId)}/attachments?$select=name,size,isInline`, { headers: H });
      onDraft = lr.ok ? ((await lr.json()).value || []).filter((x) => !x.isInline).map((x) => x.name) : null;
    } catch (_) { onDraft = null; }   // could not confirm the attachments: treated as missing
    const missing = onDraft ? files.map((f) => f.name).filter((n) => !onDraft.includes(n)) : files.map((f) => f.name);
    if (missing.length) await abort('attachment_not_on_reply', `attachment_not_on_reply: ${missing.join(', ')}`);
  }

  // 4) Send the draft.
  const sr = await fetch(`${base}/messages/${encodeURIComponent(draftId)}/send`, { method: 'POST', headers: H });
  if (!(sr.status === 202 || sr.ok)) throw graphSendError('send reply', sr.status, await sr.text().catch(() => ''));
  return { sent: true, from, replied_to: sourceGraphId, recipients: verified, internetMessageId: (vd && vd.internetMessageId) || null };
}

module.exports = { _ensureSignature, _dedupeReplyInlineImages, _altForCid, isConfigured, autoSendEnabled, sendAs, sendReplyAs, accDecisionGuard, sameMailbox, personaMailbox, getToken, CLAIRE_MAILBOX, EMMA_MAILBOX, TESSA_MAILBOX, ED_MAILBOX, ANNIE_MAILBOX, MIRANDA_MAILBOX, PAIGE_MAILBOX, REESE_MAILBOX, KAT_MAILBOX, DARBY_MAILBOX, PHOEBE_MAILBOX, MAGGIE_MAILBOX, VIVIAN_MAILBOX, AMANDA_MAILBOX, ISABELLA_MAILBOX, MEI_MAILBOX, PRIYA_MAILBOX, BILLING_MAILBOX, TEAM_INGEST_MAILBOXES };
