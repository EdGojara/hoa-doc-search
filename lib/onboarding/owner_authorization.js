// ============================================================================
// Owner-authorized, agent-executed conversion approvals (migration 554, Ed 2026-10-31).
// The owner decides; the AI team executes.
//
//   request   An agent lists the EXACT items (type, id, fingerprint) and emails them to
//             the owner from Tessa's mailbox. Nothing is authorized yet.
//   authorize The owner replies "approved" from the owner's own mailbox. The reply is
//             accepted only if it comes from that mailbox, answers that exact subject,
//             says approve (and not the opposite), arrives before the request expires,
//             and Exchange marks the sender as authenticated inside the tenant
//             (X-MS-Exchange-Organization-AuthAs: Internal). The evidence is recorded.
//   execute   Each listed item is approved through conversion_decide_object_delegated
//             (approver = the owner; executed by = the agent; the audit event carries
//             the authorization id and the reply's message id). The operator then
//             continues each batch. Never: rejections, bridge decisions, waivers,
//             preflight approval or EXECUTE.
// A chat message, an API call or an agent's say-so is never an authorization.
// ============================================================================
const crypto = require('crypto');

const AGENT_ID = 'ai-team:claude';
const AGENT_LABEL = 'Claude (AI team, authorized agent)';

const usd = (c) => '$' + (Number(c) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const normSubj = (s) => String(s || '').replace(/^\s*((re|fw|fwd)\s*:\s*)+/i, '').replace(/\s+/g, ' ').trim().toLowerCase();

// The exact items for a request, from the approval package (pending + still carrying the fingerprint shown).
function itemsFromPackage(pkg, ids) {
  const want = new Set(ids);
  const items = [];
  for (const b of pkg.batches || []) for (const o of b.objects || []) {
    if (!want.has(o.id)) continue;
    items.push({ object_type: o.object_type, object_id: o.id, fingerprint: o.fingerprint, batch_id: b.batch_id, batch_code: b.batch_code,
      kind: o.kind, amount_cents: o.amount_cents, treatment: o.recommendation ? o.recommendation.reason : null });
    want.delete(o.id);
  }
  if (want.size) throw new Error(`not pending in the approval package: ${[...want].join(', ')}`);
  return items;
}

function requestSubject(code, items) {
  const byBatch = {}; for (const i of items) byBatch[i.batch_code] = (byBatch[i.batch_code] || 0) + 1;
  return `Owner authorization ${code}: ${items.length} conversion approvals (${Object.entries(byBatch).map(([k, n]) => `${k} ${n}`).join(', ')})`;
}

function renderRequest({ subject, items, expiresAt }) {
  const rows = items.map((i, n) => `${n + 1}. ${i.batch_code} · ${i.object_type} ${String(i.kind || '').replace(/_/g, ' ')}${i.amount_cents != null ? ' · ' + usd(i.amount_cents) : ' · instruction (no journal amount)'}\n   ${i.treatment || ''}\n   id ${i.object_id} · fingerprint ${i.fingerprint}`);
  const text = [`Ed,`, ``, `These ${items.length} conversion items are ready for your decision. Reply "approved" to this email to authorize exactly these items, with these fingerprints; the AI team then records them and runs both batches to their pre-posting reconciliation.`, ``,
    `Your reply authorizes nothing else: no bridge answers, no waivers, no preflight approval, and no conversion is executed. Reply anything else (or nothing) and nothing happens. This request expires ${expiresAt}.`, ``, ...rows, ``, `Tessa`].join('\n');
  const html = `<p>Ed,</p><p>These <b>${items.length}</b> conversion items are ready for your decision. Reply <b>"approved"</b> to this email to authorize exactly these items, with these fingerprints; the AI team then records them and runs both batches to their pre-posting reconciliation.</p>`
    + `<p>Your reply authorizes nothing else: no bridge answers, no waivers, no preflight approval, and no conversion is executed. Reply anything else (or nothing) and nothing happens. This request expires ${expiresAt}.</p><ol>`
    + items.map((i) => `<li><b>${i.batch_code}</b> · ${i.object_type} ${String(i.kind || '').replace(/_/g, ' ')}${i.amount_cents != null ? ' · ' + usd(i.amount_cents) : ' · instruction (no journal amount)'}<br>${escapeHtml(i.treatment || '')}<br><span style="font-family:monospace;font-size:11px">id ${i.object_id} · fingerprint ${i.fingerprint}</span></li>`).join('') + '</ol><p>Tessa</p>';
  return { subject, text, html };
}
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

// Send through Microsoft Graph as a draft-then-send, so the request email's own identity (Internet
// message id + conversation id) is known and recorded: the owner's reply must answer THAT message (555).
async function graphSendTracked(graphSend, { from, to, subject, text, html }) {
  const g = await require('../demo/outbound_guard').guardOutbound({ channel: 'email_graph', communityId: null, to, subject });
  if (g.blocked) throw new Error('outbound suppressed: ' + g.reason);
  if (!graphSend.isConfigured()) throw new Error('graph_not_configured');
  const token = await graphSend.getToken();
  const base = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(from)}/messages`;
  const d = await fetch(base, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ subject, body: { contentType: 'HTML', content: html || text }, toRecipients: [{ emailAddress: { address: to } }] }) });
  if (!d.ok) throw new Error(`draft failed ${d.status}: ${(await d.text()).slice(0, 200)}`);
  const draft = await d.json();
  const s = await fetch(`${base}/${encodeURIComponent(draft.id)}/send`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
  if (!s.ok) throw new Error(`send failed ${s.status}: ${(await s.text()).slice(0, 200)}`);
  return { sent: true, internetMessageId: draft.internetMessageId, conversationId: draft.conversationId };
}

// Create the request (database checks every item is proposed with that fingerprint), email it to the
// owner, and record the email's identity. `send` returns { internetMessageId, conversationId }.
async function requestAuthorization({ rpc, send, items, ownerEmail, fromMailbox, summary, hours = 72 }) {
  const code = crypto.randomBytes(4).toString('hex').toUpperCase();
  const subject = requestSubject(code, items);
  const r = await rpc('owner_authorization_request', { p_subject: subject, p_summary: summary, p_items: items, p_owner_email: ownerEmail, p_requested_by: AGENT_ID, p_hours: hours });
  const expiresAt = new Date(Date.now() + hours * 3600e3).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
  const mail = renderRequest({ subject, items, expiresAt });
  const sent = await send({ from: fromMailbox, to: ownerEmail, subject: mail.subject, text: mail.text, html: mail.html });
  if (!sent || !sent.internetMessageId || !sent.conversationId) throw new Error('the request email was not sent with a message identity; nothing can authorize it');
  await rpc('owner_authorization_sent', { p_id: r.id, p_message_id: sent.internetMessageId, p_conversation_id: sent.conversationId });
  return { id: r.id, subject, items_sha256: r.items_sha256, request_message_id: sent.internetMessageId, request_conversation_id: sent.conversationId };
}

// Is this message the owner's authorization of one of the open requests? Pure; every condition must hold.
function authorizationFromReply(message, { requests, ownerEmail, headers }) {
  const from = String((message.from && message.from.emailAddress && message.from.emailAddress.address) || '').toLowerCase();
  if (!from || from !== String(ownerEmail || '').toLowerCase()) return { match: false, why: 'not from the owner' };
  const req = (requests || []).find((r) => r.status === 'requested' && normSubj(r.subject) === normSubj(message.subject));
  if (!req) return { match: false, why: 'no open request with this subject' };
  const reply = String(message.replyText || '').split(/\n\s*(from:|-----original message|on .{4,80} wrote:)/i)[0];
  if (!/\bapprov(e|ed|al)\b/i.test(reply)) return { match: false, request: req, why: 'the reply does not say approved' };
  if (/\b(not|don'?t|do not|no)\s+approv|\breject|\bdeclin|\bhold\b|\bwait\b|\bstop\b/i.test(reply)) return { match: false, request: req, why: 'the reply is not an unconditional approval' };
  if (Date.parse(message.receivedDateTime) > Date.parse(req.expires_at)) return { match: false, request: req, why: 'the request had expired' };
  const h = Object.fromEntries((headers || []).map((x) => [String(x.name || '').toLowerCase(), String(x.value || '')]));
  // Microsoft 365's authenticated identity: Exchange stamps an authenticated submission inside the tenant.
  const authAs = h['x-ms-exchange-organization-authas'] || '';
  const authSource = h['x-ms-exchange-organization-authsource'] || '';
  const authMech = h['x-ms-exchange-organization-authmechanism'] || '';
  if (authAs !== 'Internal' || !authSource || !authMech) return { match: false, request: req, why: `sender not authenticated inside the tenant (AuthAs ${authAs || 'missing'}, AuthSource ${authSource || 'missing'}, AuthMechanism ${authMech || 'missing'})` };
  const sender = String((message.sender && message.sender.emailAddress && message.sender.emailAddress.address) || '').toLowerCase();
  if (sender !== from) return { match: false, request: req, why: 'Sender differs from From (sent on behalf of someone else)' };
  // The verified reply relationship: it answers the exact request email, in that email's conversation.
  if (!req.request_message_id || !req.request_conversation_id) return { match: false, request: req, why: 'the request email identity was never recorded' };
  const inReplyTo = (h['in-reply-to'] || '').trim(); const references = h['references'] || '';
  if (inReplyTo !== req.request_message_id && !references.includes(req.request_message_id)) return { match: false, request: req, why: 'not a reply to the request email (In-Reply-To / References)' };
  if (message.conversationId !== req.request_conversation_id) return { match: false, request: req, why: "not in the request email's conversation" };
  return { match: true, request: req, evidence: { internet_message_id: message.internetMessageId, graph_id: message.id, received_at: message.receivedDateTime, from, sender,
    subject: message.subject, auth_as: authAs, auth_source: authSource, auth_mechanism: authMech, in_reply_to: inReplyTo || null, references: references || null,
    conversation_id: message.conversationId, reply_excerpt: reply.trim().slice(0, 500) } };
}

// Execute an AUTHORIZED request: each item through the delegated decision; then let the operator continue.
async function executeAuthorization({ rpc, operate, authorization }) {
  const results = [];
  for (const i of authorization.items) {
    try { await rpc('conversion_decide_object_delegated', { p_authorization: authorization.id, p_object_type: i.object_type, p_object_id: i.object_id, p_fingerprint: i.fingerprint, p_agent_id: AGENT_ID, p_agent_label: AGENT_LABEL });
      results.push({ object_type: i.object_type, object_id: i.object_id, batch_id: i.batch_id, ok: true }); }
    catch (e) { results.push({ object_type: i.object_type, object_id: i.object_id, batch_id: i.batch_id, ok: false, error: e.message }); }
  }
  const operated = [];
  for (const id of [...new Set(results.filter((r) => r.ok).map((r) => r.batch_id))]) {
    try { const op = await operate(id); operated.push({ batch_id: id, ok: true, stopped_at: op && (op.stopped_at || op.stage) || null }); }
    catch (e) { operated.push({ batch_id: id, ok: false, error: e.message }); }
  }
  const execution = { approved: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results, operated, executed_by: AGENT_ID };
  // Closed only when every item is recorded; otherwise it stays authorized (retryable until it expires) and the failures are reported.
  if (!execution.failed) await rpc('owner_authorization_mark_executed', { p_id: authorization.id, p_execution: execution });
  return execution;
}

module.exports = { graphSendTracked, AGENT_ID, AGENT_LABEL, itemsFromPackage, requestSubject, renderRequest, requestAuthorization, authorizationFromReply, executeAuthorization, normSubj };
