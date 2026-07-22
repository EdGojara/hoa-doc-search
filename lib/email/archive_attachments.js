// ============================================================================
// lib/email/archive_attachments.js  (Ed 2026-07-22)
// ----------------------------------------------------------------------------
// Capture what a homeowner attached to an inbound email into the platform, so
// it survives the message being filed (a filed message's Graph id rotates and
// the attachments can't be re-fetched). Runs at ingest while the id is still
// valid, and again from a backfill for anything already in the inbox.
//
// Idempotent per (email_message_id, filename). Best-effort: a failure to
// archive never blocks ingest. Degrades gracefully before migration 328.
// ============================================================================
const { createClient } = require('@supabase/supabase-js');
const { fetchAllAttachmentBuffers } = require('./graph_attachments');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

function _isMissingTable(err) {
  const m = `${err && err.message || ''} ${err && err.code || ''}`;
  return /could not find|does not exist|42P01|42703|PGRST20[45]|schema cache/i.test(m);
}
const isImageish = (name, mime) => /^image\//i.test(String(mime || '')) || /\.(jpe?g|png|gif|heic|heif|webp|bmp|tiff?)$/i.test(String(name || ''));

// email: the email_messages row (needs id, mailbox, graph_id, has_attachments;
// uses community_id / resolved_property_id / resolved_contact_id / sender_email
// when present to link the archive to the record).
async function archiveInboundAttachments(email) {
  if (!email || !email.id || !email.graph_id || !email.mailbox || !email.has_attachments) {
    return { archived: 0, reason: 'nothing_to_do' };
  }
  // Already archived? (idempotency — cheap check before hitting Graph)
  try {
    const { data: existing, error } = await supabase.from('email_attachments')
      .select('id').eq('email_message_id', email.id).limit(1);
    if (error) { if (_isMissingTable(error)) return { archived: 0, reason: 'no_table' }; throw error; }
    if (existing && existing.length) return { archived: 0, reason: 'exists' };
  } catch (e) { console.warn('[archive_attachments] precheck failed:', e.message); return { archived: 0, error: e.message }; }

  let atts = [];
  try { atts = await fetchAllAttachmentBuffers(email.mailbox, email.graph_id); }
  catch (e) { return { archived: 0, error: e.message, reason: 'fetch_failed' }; }
  if (!atts.length) return { archived: 0, reason: 'no_attachments' };

  let n = 0;
  for (const a of atts) {
    if (!a.buffer || !a.buffer.length) continue;
    const filename = a.filename || `attachment_${n + 1}`;
    const safe = filename.replace(/[^\w.\-]+/g, '_').slice(0, 120);
    const path = `email_attachments/${email.id}/${safe}`;
    try {
      const { error: upErr } = await supabase.storage.from('documents')
        .upload(path, a.buffer, { contentType: a.contentType || 'application/octet-stream', upsert: true });
      if (upErr) throw upErr;
      const { error: insErr } = await supabase.from('email_attachments').insert({
        email_message_id: email.id,
        community_id: email.community_id || null,
        resolved_property_id: email.resolved_property_id || null,
        resolved_contact_id: email.resolved_contact_id || null,
        sender_email: email.sender_email || null,
        filename, mime: a.contentType || null, size_bytes: a.buffer.length,
        storage_path: path, is_image: isImageish(filename, a.contentType),
      });
      if (insErr) { if (String(insErr.code) === '23505') { continue; } throw insErr; }
      n++;
    } catch (e) { console.warn('[archive_attachments] skip', filename, e.message); }
  }
  return { archived: n };
}

module.exports = { archiveInboundAttachments, isImageish };
