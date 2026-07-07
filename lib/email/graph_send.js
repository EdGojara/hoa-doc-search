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
async function sendAs({ from = CLAIRE_MAILBOX, to, subject, text, html, attachments }) {
  if (!isConfigured()) throw new Error('graph_not_configured');
  if (!to) throw new Error('recipient_required');
  const token = await getToken();
  const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(from)}/sendMail`;
  const message = {
    subject: subject || '(no subject)',
    body: html ? { contentType: 'HTML', content: html } : { contentType: 'Text', content: text || '' },
    toRecipients: [{ emailAddress: { address: to } }],
  };
  if (attachments && attachments.length) message.attachments = attachments;
  const payload = { message, saveToSentItems: true };
  const r = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  if (!(r.status === 202 || r.ok)) {
    const t = await r.text().catch(() => '');
    throw new Error(`Graph sendMail failed (${r.status}): ${t.slice(0, 200)}`);
  }
  return { sent: true, from, to };
}

module.exports = { isConfigured, sendAs, getToken, CLAIRE_MAILBOX };
