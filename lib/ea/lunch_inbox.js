// ============================================================================
// lib/ea/lunch_inbox.js  (Ed 2026-09-05)
// ----------------------------------------------------------------------------
// Reads Tessa's mailbox for replies to a lunch round and records each order via
// resolveLunchReply(). Modeled on lib/board/vote_inbox.js. Scoped by the
// [LUN-XXXX] subject ref-code so it only touches lunch replies and leaves the
// rest of Tessa's inbox to lib/ea/tessa_inbox.js. Dedups on
// lunch_reply_inbox_seen so a reply is processed once. Mail.Read only (never
// marks messages read).
//
// Trigger: POST /api/tessa/lunch/poll-inbox (owner-gated).
// ============================================================================
const { createClient } = require('@supabase/supabase-js');
const graphSend = require('../email/graph_send');
const { resolveLunchReply } = require('./lunch_reply');
const { isLunchQuestion, respondToLunchQuestion } = require('./lunch_question');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const MAILBOX = graphSend.TESSA_MAILBOX;

function isConfigured() { return graphSend.isConfigured(); }

function htmlToText(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<\/(p|div|br|li|tr|h[1-6])>/gi, '\n').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim();
}

async function alreadySeen(graphId) {
  const { data } = await supabase.from('lunch_reply_inbox_seen').select('graph_id').eq('graph_id', graphId).maybeSingle();
  return !!data;
}
async function markSeen(graphId, fromEmail, outcome) {
  try { await supabase.from('lunch_reply_inbox_seen').insert({ graph_id: graphId, from_email: fromEmail || null, outcome }); } catch (_) { /* best-effort */ }
}

async function pollLunchInbox({ max = 40 } = {}) {
  const stats = { scanned: 0, recorded: 0, answered: 0, unclear: 0, ignored: 0, errors: 0 };
  if (!isConfigured()) return { ...stats, error: 'graph_not_configured', detail: `Set GRAPH_* and give the app Mail.Read on ${MAILBOX}.` };

  let token;
  try { token = await graphSend.getToken(); } catch (e) { return { ...stats, error: 'token_failed', detail: e.message }; }
  const sel = ['id', 'from', 'subject', 'bodyPreview', 'body', 'receivedDateTime'].join(',');
  const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(MAILBOX)}/messages?$select=${sel}&$top=${Math.min(50, max)}&$orderby=receivedDateTime%20desc`;
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!resp.ok) { const b = await resp.text().catch(() => ''); return { ...stats, error: `graph_read_failed_${resp.status}`, detail: b.slice(0, 300) }; }
  const json = await resp.json().catch(() => ({}));
  const messages = Array.isArray(json.value) ? json.value : [];

  for (const m of messages) {
    const id = m.id;
    if (!id) continue;
    const subject = m.subject || '';
    const body = (m.body && m.body.contentType === 'html' ? htmlToText(m.body.content) : (m.body && m.body.content)) || m.bodyPreview || '';
    const isOrder = /\[LUN-[A-Z0-9]{3,6}\]/i.test(subject);          // a reply to a round
    const isQuestion = !isOrder && isLunchQuestion(subject + '\n' + body); // "what's for lunch?"
    // Anything that isn't lunch is left to tessa_inbox.js — no seen-row, so the
    // two pollers stay independent.
    if (!isOrder && !isQuestion) continue;
    stats.scanned += 1;
    const from = ((m.from && m.from.emailAddress && m.from.emailAddress.address) || '').toLowerCase();
    if (await alreadySeen(id)) { stats.ignored += 1; continue; }
    if (from && from === String(MAILBOX).toLowerCase()) { await markSeen(id, from, 'own_sent'); stats.ignored += 1; continue; }

    let result;
    try {
      result = isOrder
        ? await resolveLunchReply(supabase, { from, subject, body })
        : await respondToLunchQuestion(supabase, { from, subject, body });
    } catch (e) { console.warn('[lunch_inbox] handle failed:', e.message); stats.errors += 1; continue; } // not marked seen → retried next poll

    if (result.status === 'recorded') stats.recorded += 1;
    else if (result.status === 'answered') stats.answered += 1;
    else if (result.status === 'unclear') stats.unclear += 1;
    else stats.ignored += 1;
    await markSeen(id, from, result.status);
  }
  return stats;
}

module.exports = { pollLunchInbox, isConfigured, MAILBOX };
