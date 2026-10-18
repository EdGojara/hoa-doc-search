'use strict';

// Evidence-only matcher for staff replies sent AS an existing shared mailbox.
// Never infer "answered" from subject, read state, folder or conversationId alone.
function normalizeId(v) { return String(v || '').trim().replace(/^<|>$/g, '').toLowerCase(); }
function normalizeAddress(v) { return String(v || '').trim().toLowerCase(); }
function referencedIds(headers = {}) {
  const h = Array.isArray(headers) ? Object.fromEntries(headers.map(x => [String(x.name || '').toLowerCase(), x.value])) : Object.fromEntries(Object.entries(headers).map(([k,v]) => [k.toLowerCase(),v]));
  return [h['in-reply-to'],h.references].filter(Boolean).flatMap(v => String(v).match(/<[^>]+>|[^\s,]+/g) || []).map(normalizeId).filter(Boolean);
}
// Inputs must be independently sourced: inbound from trustEd's persisted record;
// reply from a shared mailbox's Sent Items; headers from its matching journal copy.
// Return "review" on uncertain evidence, never "answered".
function classifyStaffReply({ inbound, sent, journalHeaders, sharedMailbox } = {}) {
  if (!inbound || !sent || !sharedMailbox) return { status: 'review', reason: 'missing_evidence' };
  const from = normalizeAddress(sent.from || sent.sender_email);
  if (from !== normalizeAddress(sharedMailbox)) return { status: 'ignore', reason: 'not_shared_mailbox_send' };
  const expectedRecipient = normalizeAddress(inbound.replyTo || inbound.formSubmitter || inbound.sender_email);
  const tos = (sent.toRecipients || sent.recipients || []).map(x => normalizeAddress(typeof x === 'string' ? x : (x.emailAddress?.address || x.address || x.email)));
  if (!expectedRecipient || !tos.includes(expectedRecipient)) return { status: 'review', reason: 'recipient_not_proven' };
  const sentAt = Date.parse(sent.sentDateTime || sent.sent_at);
  const inboundAt = Date.parse(inbound.received_at || inbound.receivedDateTime);
  if (!Number.isFinite(sentAt) || !Number.isFinite(inboundAt) || sentAt <= inboundAt) return { status: 'review', reason: 'chronology_not_proven' };
  const originalId = normalizeId(inbound.internet_message_id || inbound.internetMessageId);
  if (!originalId) return { status: 'review', reason: 'inbound_message_id_missing' };
  const refs = referencedIds(journalHeaders);
  if (!refs.length) return { status: 'review', reason: 'journal_headers_unavailable' };
  if (!refs.includes(originalId)) return { status: 'review', reason: 'no_verified_reply_reference' };
  return { status: 'answered', reason: 'verified_reply_reference' };
}
module.exports = { classifyStaffReply, normalizeId, referencedIds };
