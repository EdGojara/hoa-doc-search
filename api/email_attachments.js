// ============================================================================
// api/email_attachments.js  (Ed 2026-07-22)
// ----------------------------------------------------------------------------
// Serve the archived homeowner attachments (photos, sketches, PDFs) so a team
// member can see what was sent on the record. Filter by property / contact /
// email / sender. Each row comes back with a short-lived signed URL to the
// file in the documents bucket. Degrades gracefully before migration 328.
// ============================================================================
const express = require('express');
const { createClient } = require('@supabase/supabase-js');

const router = express.Router();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

function safe(err) { try { return require('./_safe_error').safeErrorMessage(err); } catch (_) { return 'Something went wrong'; } }
function _isMissingTable(err) {
  const m = `${err && err.message || ''} ${err && err.code || ''}`;
  return /could not find|does not exist|42P01|42703|PGRST20[45]|schema cache/i.test(m);
}

// GET /api/email-attachments?property_id=|contact_id=|email_message_id=|sender_email=&images_only=1
router.get('/', async (req, res) => {
  try {
    let q = supabase.from('email_attachments')
      .select('id, email_message_id, community_id, resolved_property_id, resolved_contact_id, sender_email, filename, mime, size_bytes, storage_path, is_image, created_at')
      .order('created_at', { ascending: false }).limit(500);
    const { property_id, contact_id, email_message_id, sender_email, images_only } = req.query;
    if (property_id) q = q.eq('resolved_property_id', property_id);
    if (contact_id) q = q.eq('resolved_contact_id', contact_id);
    if (email_message_id) q = q.eq('email_message_id', email_message_id);
    if (sender_email) q = q.ilike('sender_email', String(sender_email));
    if (images_only === '1' || images_only === 'true') q = q.eq('is_image', true);
    if (!property_id && !contact_id && !email_message_id && !sender_email) {
      return res.status(400).json({ error: 'a filter is required (property_id, contact_id, email_message_id, or sender_email)' });
    }
    const { data, error } = await q;
    if (error) { if (_isMissingTable(error)) return res.json({ attachments: [], migration_pending: true }); throw error; }

    // Sign each file (1 hour) so the browser can render/download it.
    const out = [];
    for (const a of data || []) {
      let url = null;
      try {
        const { data: s } = await supabase.storage.from('documents').createSignedUrl(a.storage_path, 3600);
        url = s ? s.signedUrl : null;
      } catch (_) {}
      out.push({ ...a, url });
    }
    res.json({ attachments: out });
  } catch (err) {
    console.error('[email_attachments] list failed:', err.message);
    res.status(500).json({ error: safe(err) });
  }
});

module.exports = router;
