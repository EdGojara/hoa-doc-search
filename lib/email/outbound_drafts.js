// ============================================================================
// lib/email/outbound_drafts.js  (Ed 2026-07-22)
// ----------------------------------------------------------------------------
// The one place a persona reply / ACC acknowledgment / decision letter goes
// INSTEAD of sending: the draft queue. Ed reviews and clicks Send — that click
// is the only thing that calls Graph. queueDraft() is idempotent on
// (source_email_ref, draft_kind) so a re-pull never double-queues.
//
// Degrades gracefully before migration 327: if the table is missing, queueDraft
// returns { status:'skipped', reason:'no_table' } and the caller can fall back.
// ============================================================================
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const BEDROCK_MGMT_CO_ID = '00000000-0000-0000-0000-000000000001';

function _isMissingTable(err) {
  const m = `${err && err.message || ''} ${err && err.code || ''}`;
  return /could not find|does not exist|42P01|42703|PGRST20[45]|schema cache/i.test(m);
}

// files: [{ name, storage_path, mime }]. body: prefer html; text fallback.
async function queueDraft({
  communityId = null, communityName = null,
  persona = null, fromMailbox = null,
  toEmail, toName = null, cc = null,
  subject, bodyHtml = null, bodyText = null,
  attachments = [],
  relatedType = null, relatedId = null, sourceEmailRef = null,
  draftKind = 'reply', aiDrafted = true, draftReason = null, createdBy = null,
}) {
  if (!toEmail || !subject) return { status: 'error', error: 'to_and_subject_required' };

  // Idempotency: an existing open draft for the same inbound email + kind wins.
  if (sourceEmailRef) {
    try {
      const { data: existing } = await supabase.from('outbound_email_drafts')
        .select('id').eq('source_email_ref', sourceEmailRef).eq('draft_kind', draftKind)
        .eq('status', 'draft').limit(1);
      if (existing && existing.length) return { status: 'exists', id: existing[0].id };
    } catch (_) { /* pre-migration; fall through */ }
  }

  const row = {
    management_company_id: BEDROCK_MGMT_CO_ID,
    community_id: communityId, community_name: communityName,
    persona, from_mailbox: fromMailbox,
    to_email: toEmail, to_name: toName, cc,
    subject, body_html: bodyHtml, body_text: bodyText,
    attachments: Array.isArray(attachments) ? attachments : [],
    related_type: relatedType, related_id: relatedId != null ? String(relatedId) : null,
    source_email_ref: sourceEmailRef, draft_kind: draftKind,
    ai_drafted: aiDrafted, draft_reason: draftReason, created_by: createdBy,
    status: 'draft',
  };
  const { data, error } = await supabase.from('outbound_email_drafts').insert(row).select('id').single();
  if (error) {
    if (_isMissingTable(error)) return { status: 'skipped', reason: 'no_table' };
    if (String(error.code) === '23505') return { status: 'exists' };
    console.error('[outbound_drafts] queue failed:', error.message);
    return { status: 'error', error: error.message };
  }
  return { status: 'queued', id: data.id };
}

module.exports = { queueDraft, _isMissingTable };
