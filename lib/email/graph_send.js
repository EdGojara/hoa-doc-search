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
const BILLING_MAILBOX = process.env.BILLING_MAILBOX || 'billing@bedrocktx.com'; // staff -> Tessa billing-item intake (Tessa processes)

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

async function sendAs({ from = CLAIRE_MAILBOX, to, cc, subject, text, html, attachments }) {
  if (!isConfigured()) throw new Error('graph_not_configured');
  const toRecipients = toRecipientList(to);
  const ccRecipients = toRecipientList(cc);
  if (toRecipients.length === 0) throw new Error('recipient_required');
  const token = await getToken();
  const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(from)}/sendMail`;
  const message = {
    subject: subject || '(no subject)',
    body: html ? { contentType: 'HTML', content: html } : { contentType: 'Text', content: text || '' },
    toRecipients,
  };
  if (ccRecipients.length) message.ccRecipients = ccRecipients;
  if (attachments && attachments.length) message.attachments = attachments;
  const payload = { message, saveToSentItems: true };
  const r = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  if (!(r.status === 202 || r.ok)) {
    const t = await r.text().catch(() => '');
    throw new Error(`Graph sendMail failed (${r.status}): ${t.slice(0, 200)}`);
  }
  return { sent: true, from, to };
}

module.exports = { isConfigured, autoSendEnabled, sendAs, getToken, CLAIRE_MAILBOX, EMMA_MAILBOX, TESSA_MAILBOX, ED_MAILBOX, ANNIE_MAILBOX, MIRANDA_MAILBOX, PAIGE_MAILBOX, REESE_MAILBOX, BILLING_MAILBOX };
