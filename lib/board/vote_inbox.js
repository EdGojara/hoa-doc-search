// ============================================================================
// lib/board/vote_inbox.js  (Ed 2026-08-09)
// ----------------------------------------------------------------------------
// Reads the shared Board-votes mailbox (vote@bedrocktx.com) via Microsoft Graph
// and turns each UNREAD reply into a recorded vote through resolveVoteReply() —
// the reply-to-vote auto-ingest. Reuses the existing Graph plumbing
// (lib/email/graph_send.js getToken/isConfigured), exactly like tessa_inbox.js
// reads tessa@.
//
// Safety: a clear vote is recorded (idempotent upsert) and the message marked
// read. A reply we CAN'T read cleanly is never silently dropped — the member
// gets a fallback with a fresh one-click ballot link (or a portal pointer), and
// the message is marked read so it isn't reprocessed. Non-members are ignored.
//
// Trigger: POST /api/board-motions/poll-inbox (staff), and/or a scheduler.
// Gated: does nothing until GRAPH_* is set AND vote@ is in the Azure app's
// Mail.Read access policy.
// ============================================================================
const { createClient } = require('@supabase/supabase-js');
const graphSend = require('../email/graph_send');
const { resolveVoteReply } = require('./vote_reply');
const { signVoteToken, voteLinkUrl } = require('./vote_token');
const { sendEmail } = require('../notifications/email');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const MAILBOX = process.env.BOARD_VOTE_INBOX || 'vote@bedrocktx.com';

function isConfigured() { return graphSend.isConfigured(); }
function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

function htmlToText(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<\/(p|div|br|li|tr|h[1-6])>/gi, '\n').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim();
}

async function markRead(token, id) {
  try {
    await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(MAILBOX)}/messages/${id}`, {
      method: 'PATCH', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ isRead: true }),
    });
  } catch (_) { /* best-effort */ }
}

// The email we send back after processing a reply. Kill-switched with the rest
// of board email — the vote is recorded regardless; only the note is gated.
async function replyToMember(result, toEmail) {
  if (process.env.BOARD_NOTIFY_ENABLED !== '1') return;
  const first = String(result.name || '').split(' ')[0] || 'there';
  const common = { to: toEmail, replyTo: MAILBOX, bcc: process.env.BOARD_RECORDS_EMAIL || MAILBOX, tags: [{ name: 'module', value: 'board_motion' }, { name: 'event', value: 'reply_' + result.status }] };
  try {
    if (result.status === 'recorded') {
      const label = { for: 'FOR', against: 'AGAINST', abstain: 'ABSTAIN' }[result.vote];
      await sendEmail({ ...common, subject: `Vote recorded, ${label}: ${result.motion.title}`,
        html: `<div style="font-family:Inter,sans-serif;color:#1a2230;"><p>Hi ${esc(first)},</p><p>Your vote has been recorded: <b>${label}</b> on &ldquo;${esc(result.motion.title)}&rdquo;.</p><p style="color:#64748b;font-size:12px;">If this was not you, contact your community manager.</p></div>` });
    } else if (result.status === 'unclear' && result.motion) {
      // We know the motion but not the vote → give them one-click buttons.
      const url = voteLinkUrl(signVoteToken({ motion_id: result.motion.id, voter_email: toEmail }));
      const btn = (c, l, bg) => `<a href="${esc(url)}&choice=${c}" style="display:inline-block;background:${bg};color:#fff;padding:11px 20px;border-radius:8px;text-decoration:none;font-weight:700;margin:0 8px 8px 0;">${l}</a>`;
      await sendEmail({ ...common, subject: `Couldn't read your vote: ${result.motion.title}`,
        html: `<div style="font-family:Inter,sans-serif;color:#1a2230;"><p>Hi ${esc(first)},</p><p>We could not tell from your reply how you meant to vote on &ldquo;${esc(result.motion.title)}&rdquo;. Tap your vote:</p><div style="margin:16px 0;">${btn('for', 'Vote For', '#1a7a3c')}${btn('against', 'Vote Against', '#b42318')}${btn('abstain', 'Abstain', '#64748b')}</div></div>` });
    } else if (result.status === 'ambiguous') {
      await sendEmail({ ...common, subject: `Which motion? Your board vote`,
        html: `<div style="font-family:Inter,sans-serif;color:#1a2230;"><p>Hi ${esc(first)},</p><p>You have more than one open motion, so we could not tell which one your reply was about. Please reply from the specific motion's email, or open the board portal to vote.</p></div>` });
    }
    // no_member / no_open_motion / already_voted → no reply.
  } catch (e) { console.warn('[vote_inbox] reply failed:', e.message); }
}

// Poll vote@ for unread replies, record each clear vote. Returns stats.
async function pollVoteInbox({ max = 25 } = {}) {
  const stats = { scanned: 0, recorded: 0, unclear: 0, ambiguous: 0, ignored: 0, errors: 0 };
  if (!isConfigured()) return { ...stats, error: 'graph_not_configured', detail: `Set GRAPH_* and add ${MAILBOX} to the Azure app Mail.Read policy.` };

  let token;
  try { token = await graphSend.getToken(); } catch (e) { return { ...stats, error: 'token_failed', detail: e.message }; }
  const sel = ['id', 'from', 'subject', 'bodyPreview', 'body', 'receivedDateTime'].join(',');
  const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(MAILBOX)}/messages?$filter=isRead%20eq%20false&$select=${sel}&$top=${Math.min(50, max)}&$orderby=receivedDateTime%20desc`;
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!resp.ok) {
    const b = await resp.text().catch(() => '');
    // 403 almost always = vote@ not in the app's Mail.Read policy yet.
    return { ...stats, error: `graph_read_failed_${resp.status}`, detail: b.slice(0, 300) };
  }
  const json = await resp.json().catch(() => ({}));
  const messages = Array.isArray(json.value) ? json.value : [];

  for (const m of messages) {
    stats.scanned += 1;
    const id = m.id;
    const from = ((m.from && m.from.emailAddress && m.from.emailAddress.address) || '').toLowerCase();
    if (!id) { stats.ignored += 1; continue; }
    if (from && from === String(MAILBOX).toLowerCase()) { await markRead(token, id); stats.ignored += 1; continue; } // own sent
    const subject = m.subject || '';
    const body = (m.body && m.body.contentType === 'html' ? htmlToText(m.body.content) : (m.body && m.body.content)) || m.bodyPreview || '';

    let result;
    try { result = await resolveVoteReply(supabase, { from, subject, body }); }
    catch (e) { console.warn('[vote_inbox] resolve failed:', e.message); stats.errors += 1; continue; } // leave UNREAD → retry next poll

    await markRead(token, id);
    if (result.status === 'recorded') stats.recorded += 1;
    else if (result.status === 'unclear') stats.unclear += 1;
    else if (result.status === 'ambiguous') stats.ambiguous += 1;
    else stats.ignored += 1;
    await replyToMember(result, from);
  }
  return stats;
}

module.exports = { pollVoteInbox, isConfigured, MAILBOX };
