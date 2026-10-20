// ============================================================================
// lib/email/reply_guard.js — one send-safety rule for both reply paths
// ----------------------------------------------------------------------------
// Communications (POST /api/email-triage/:id/send) and the Draft Queue
// (POST /api/email-drafts/:id/send) both answer inbound email. This module is
// the ONE place that decides whether a send may go out:
//
//   packageHash(draft)  fingerprint of exactly what a person reviewed: sender,
//                       recipients, subject, body and each attachment's stored
//                       bytes (sha256). A send must echo the fingerprint its
//                       screen showed; any change since then is refused.
//   activeDraftFor()    a Draft Queue reply waiting for an inbound email. While
//                       one exists, Communications refuses a second reply.
//   claim()/finish()    an atomic claim per reply (reply_send_claims, migration
//                       539). The PRIMARY KEY makes a simultaneous or repeated
//                       Send fail instead of sending twice. A failure records
//                       whether anything could have gone out (uncertain) so a
//                       retry is safe only when nothing could have.
//
// Scar (Ed 2026-10-20): Hugh Durlam's Oct 20 email carried an obsolete AI draft in
// Communications and the approved reply in the Draft Queue. Either Send would have
// gone out, and both could have. Tested in tests/test_reply_send_safeguards.js.
// ============================================================================
const crypto = require('crypto');

const ACTIVE_DRAFT_STATUSES = ['draft'];
// Draft kinds that answer an inbound email (and so share its send guard). Receipts
// (amanda_auto_reply) belong to the auto-reply state machine; acknowledgments and
// other notices are keyed to the draft itself.
const REPLY_KINDS = ['amanda_reply', 'reply'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const normAddr = (s) => String(s || '').trim().toLowerCase();
const normList = (s) => String(s || '').split(/[,;]/).map(normAddr).filter(Boolean).sort().join(',');

// The approved package: what Ed reads on screen and what will go out.
function packageOf(d) {
  d = d || {};
  return {
    persona: d.persona || null,
    to: normList(d.to_email),
    cc: normList(d.cc),
    subject: String(d.subject || ''),
    body_text: String(d.body_text || ''),
    body_html: d.body_text ? null : (d.body_html || null),   // html is re-rendered from body_text when present
    source_email_ref: d.source_email_ref || null,
    attachments: (Array.isArray(d.attachments) ? d.attachments : []).filter((a) => a && a.storage_path)
      .map((a) => ({ bucket: a.bucket || 'documents', storage_path: a.storage_path, name: a.name || null, sha256: a.sha256 || null, size: a.size == null ? null : Number(a.size) })),
  };
}
function packageHash(d) {
  return crypto.createHash('sha256').update(JSON.stringify(packageOf(d))).digest('hex');
}
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// A Draft Queue reply waiting for this inbound email (or null).
async function activeDraftFor(supabase, inboundId) {
  if (!inboundId) return null;
  const { data, error } = await supabase.from('outbound_email_drafts')
    .select('id, persona, status, subject, to_email, created_at, draft_kind')
    .eq('source_email_ref', String(inboundId)).in('status', ACTIVE_DRAFT_STATUSES);
  if (error) throw Object.assign(new Error('draft_lookup_failed: ' + error.message), { code: 'draft_lookup_failed' });
  return (data || []).filter((d) => REPLY_KINDS.includes(d.draft_kind)).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0] || null;
}
// Waiting Draft Queue replies for many inbound emails: { [inboundId]: draft }.
async function activeDraftsFor(supabase, inboundIds) {
  const ids = [...new Set((inboundIds || []).filter(Boolean).map(String))];
  if (!ids.length) return {};
  const { data, error } = await supabase.from('outbound_email_drafts')
    .select('id, persona, status, subject, to_email, created_at, draft_kind, source_email_ref')
    .in('source_email_ref', ids).in('status', ACTIVE_DRAFT_STATUSES);
  if (error) throw Object.assign(new Error('draft_lookup_failed: ' + error.message), { code: 'draft_lookup_failed' });
  const out = {};
  for (const d of data || []) if (REPLY_KINDS.includes(d.draft_kind)) out[d.source_email_ref] = d;
  return out;
}

// The inbound email a Draft Queue draft answers (its send guard key), or null.
function inboundOf(d) {
  return d && REPLY_KINDS.includes(d.draft_kind) && UUID.test(String(d.source_email_ref || '')) ? String(d.source_email_ref) : null;
}
function replyKey({ inboundId, draftId }) {
  if (inboundId && UUID.test(String(inboundId))) return 'email:' + String(inboundId).toLowerCase();
  if (draftId && UUID.test(String(draftId))) return 'draft:' + String(draftId).toLowerCase();
  return null;
}
const isMissingTable = (e) => /could not find|does not exist|42P01|PGRST20[45]|schema cache/i.test(`${e && e.message || ''} ${e && e.code || ''}`);
const refuse = (status, error, message, extra) => ({ ok: false, status, error, message, ...(extra || {}) });

// Read-only: has this reply already gone, or is it going? (Early check; the atomic
// claim right before sending is what actually prevents a double send.)
async function existingClaim(supabase, key) {
  if (!key) return null;
  const { data, error } = await supabase.from('reply_send_claims').select('*').eq('reply_key', key).maybeSingle();
  if (error) throw Object.assign(new Error(error.message), { code: isMissingTable(error) ? 'send_guard_not_installed' : 'claim_lookup_failed' });
  return data || null;
}
function blockedBy(c, { retryAfterUncertain } = {}) {
  if (!c) return null;
  if (c.status === 'sent') return refuse(409, 'already_replied', `A reply to this email was already sent (${c.send_path === 'draft_queue' ? 'Draft Queue' : 'Communications'}, ${String(c.finished_at || c.claimed_at).slice(0, 16).replace('T', ' ')}). Nothing was sent.`, { claim: c });
  if (c.status === 'sending') return refuse(409, 'send_in_progress', 'A reply to this email is being sent right now. Nothing more was sent; refresh in a moment.', { claim: c });
  if (c.status === 'failed' && c.uncertain && !retryAfterUncertain) return refuse(409, 'previous_send_unconfirmed', 'The last send attempt for this email failed while sending, so it may have gone out. Check the persona\'s Sent Items before sending again.', { claim: c, needs_confirmation: true });
  return null;
}

// Take the claim atomically. Returns { ok, token, key } or a refusal.
async function claim(supabase, { inboundId, draftId, path, packageSha = null, actor = null, retryAfterUncertain = false }) {
  const key = replyKey({ inboundId, draftId });
  if (!key) return refuse(400, 'reply_key_required', 'This reply has no message to key its send guard to. Nothing was sent.');
  const token = crypto.randomUUID();
  const row = { reply_key: key, inbound_email_id: key.startsWith('email:') ? key.slice(6) : null, outbound_draft_id: draftId || null,
    send_path: path, status: 'sending', claim_token: token, package_sha256: packageSha, claimed_by: actor, claimed_at: new Date().toISOString() };
  const ins = await supabase.from('reply_send_claims').insert(row).select('reply_key').maybeSingle();
  if (!ins.error) return { ok: true, token, key };
  if (isMissingTable(ins.error)) return refuse(503, 'send_guard_not_installed', 'Sending is paused until the send-safety guard is installed (migration 539). Nothing was sent.');
  if (!/23505|duplicate key|unique/i.test(`${ins.error.code || ''} ${ins.error.message || ''}`)) return refuse(503, 'claim_failed', 'Could not take the send guard. Nothing was sent; try again.', { detail: ins.error.message });
  // Someone holds or held this reply. Only a FAILED claim can be re-taken, atomically.
  const c = await existingClaim(supabase, key);
  const b = blockedBy(c, { retryAfterUncertain });
  if (b) return b;
  if (!c || c.status !== 'failed') return refuse(409, 'send_in_progress', 'A reply to this email is being sent right now. Nothing more was sent.');
  const up = await supabase.from('reply_send_claims')
    .update({ status: 'sending', claim_token: token, send_path: path, outbound_draft_id: draftId || c.outbound_draft_id || null, package_sha256: packageSha, claimed_by: actor, claimed_at: new Date().toISOString(), finished_at: null, error: null, uncertain: false, attempts: (c.attempts || 1) + 1 })
    .eq('reply_key', key).eq('status', 'failed').eq('claim_token', c.claim_token).select('reply_key');
  if (up.error) return refuse(503, 'claim_failed', 'Could not take the send guard. Nothing was sent; try again.', { detail: up.error.message });
  if (!up.data || up.data.length !== 1) return refuse(409, 'send_in_progress', 'Another send took this reply first. Nothing more was sent.');
  return { ok: true, token, key };
}

// Did anything possibly leave? A Graph error with a step is an HTTP refusal (nothing
// sent, or the draft was deleted before /send); only a failure with no step (network
// drop mid-send) or an explicit flag is uncertain.
function failureIsUncertain(err) {
  if (!err) return false;
  if (err.preSend === true) return false;
  if (err.uncertain === true) return true;
  return !err.step;
}
async function finish(supabase, { key, token, ok, err = null, uncertain = null }) {
  if (!key || !token) return;
  const patch = ok
    ? { status: 'sent', finished_at: new Date().toISOString(), error: null, uncertain: false }
    : { status: 'failed', finished_at: new Date().toISOString(), error: String((err && (err.message || err)) || 'failed').slice(0, 500), uncertain: uncertain == null ? failureIsUncertain(err) : !!uncertain };
  const { error } = await supabase.from('reply_send_claims').update(patch).eq('reply_key', key).eq('claim_token', token);
  if (error) console.error('[reply_guard] could not record claim outcome:', key, error.message);
}

module.exports = { packageOf, packageHash, sha256, activeDraftFor, activeDraftsFor, inboundOf, replyKey, REPLY_KINDS, existingClaim, blockedBy, claim, finish, failureIsUncertain, ACTIVE_DRAFT_STATUSES };
