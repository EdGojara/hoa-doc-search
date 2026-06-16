// ============================================================================
// Interactions API
// ----------------------------------------------------------------------------
// Manual + drag-drop entry points for the memory-layer foundation table.
// Backs the Interactions section of the staff property detail modal
// (public/index.html, inspPropertyDetailModal).
//
// Ed 2026-06-16: "staff want to be able to see history from homeowner like
// emails or calls that are logged ... we can pull it up and see it or make
// notes." Phase 1 ships:
//   - POST /api/interactions               manual call/note/follow-up
//   - POST /api/interactions/email-drop    drag-dropped email/attachment file
//
// Phase 2 (not in this file yet) is Microsoft 365 inbound sync so emails to
// staff inboxes auto-thread without forwarding. Both phases write into the
// same interactions table; phase 1's schema choices are forward-compatible
// with the M365 source value.
//
// Reads stay on the existing /api/inspections/property-detail/:property_id
// endpoint, which already pulls interactions filtered by property_id. That
// endpoint's interactions select is extended (separately) to include
// attachments + follow_up_due_at so the timeline can render dropped files
// and overdue follow-ups.
// ============================================================================

const express = require('express');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const STORAGE_BUCKET = 'homeowner-interactions';

// 25 MB per file matches the builder ARC upload ceiling. An Outlook .msg
// with screenshots can comfortably fit; bigger packets are an edge case
// staff can split.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

const router = express.Router();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const VALID_MANUAL_TYPES = new Set([
  'phone',           // call (most common)
  'in_person',       // walk-in, drive-by chat
  'internal_note',   // staff jotted note, no homeowner contact
  'email_inbound',   // logged manually because no email-drop available
  'email_outbound',  // logged manually because no email-drop available
  'sms',             // text exchange logged after the fact
]);

const VALID_DIRECTIONS = new Set(['inbound', 'outbound', 'internal']);

function sanitizeFilenameForStorage(name) {
  // Keep extension, strip path traversal + collapse weirdness. Storage paths
  // also can't contain spaces reliably across CDNs.
  const base = (name || 'file').toString().split(/[\\/]/).pop();
  return base.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120) || 'file';
}

function storagePathFor({ communityId, propertyId, filename }) {
  const year = new Date().getFullYear();
  return `${communityId}/${year}/${propertyId}/${Date.now()}_${sanitizeFilenameForStorage(filename)}`;
}

async function propertyCommunityId(propertyId) {
  const { data, error } = await supabase
    .from('properties')
    .select('community_id')
    .eq('id', propertyId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error('property not found');
  return data.community_id;
}

// ---------------------------------------------------------------------------
// POST /api/interactions
// Manual log of a call / note / follow-up. No file upload — pure JSON.
// Body: {
//   property_id (required),
//   type (required, one of VALID_MANUAL_TYPES),
//   direction (optional, defaults by type),
//   subject (optional, short headline),
//   content (optional, body),
//   occurred_at (optional ISO, defaults to now — operator can backdate),
//   follow_up_due_at (optional ISO),
//   logged_by (optional display name; falls back to 'Staff'),
//   violation_id (optional — link to specific violation thread)
// }
// ---------------------------------------------------------------------------
router.post('/interactions', async (req, res) => {
  try {
    const b = req.body || {};
    const property_id = b.property_id;
    const type = (b.type || '').toString();

    if (!property_id) return res.status(400).json({ error: 'property_id is required' });
    if (!VALID_MANUAL_TYPES.has(type)) {
      return res.status(400).json({ error: `type must be one of: ${[...VALID_MANUAL_TYPES].join(', ')}` });
    }

    const community_id = await propertyCommunityId(property_id);

    // Default direction by type so staff doesn't have to pick it every time.
    let direction = (b.direction || '').toString().toLowerCase() || null;
    if (!direction) {
      direction = type === 'internal_note' ? 'internal'
                : type === 'email_outbound' ? 'outbound'
                : 'inbound';
    }
    if (!VALID_DIRECTIONS.has(direction)) {
      return res.status(400).json({ error: `direction must be one of: ${[...VALID_DIRECTIONS].join(', ')}` });
    }

    const occurred_at = b.occurred_at ? new Date(b.occurred_at).toISOString() : new Date().toISOString();
    const follow_up_due_at = b.follow_up_due_at ? new Date(b.follow_up_due_at).toISOString() : null;

    // delivery_method maps cleanly from type for the existing render which
    // shows method in the timeline column.
    const delivery_method = type === 'phone' ? 'phone'
                          : type === 'sms' ? 'sms'
                          : type === 'in_person' ? 'in_person'
                          : type === 'email_inbound' || type === 'email_outbound' ? 'email'
                          : null;

    const loggedBy = (b.logged_by || 'Staff').toString().slice(0, 120);

    const row = {
      community_id,
      property_id,
      violation_id: b.violation_id || null,
      type,
      direction,
      subject: (b.subject || '').toString().slice(0, 300) || null,
      content: (b.content || '').toString() || null,
      delivery_method,
      status: 'sent',          // operator logged it = it happened
      sent_at: occurred_at,
      received_at: direction === 'inbound' ? occurred_at : null,
      follow_up_due_at,
      source: 'manual',
      notes: `Logged by ${loggedBy}`,
    };

    const { data, error } = await supabase
      .from('interactions')
      .insert(row)
      .select('id, type, direction, subject, sent_at, follow_up_due_at')
      .single();

    if (error) return res.status(500).json({ error: error.message });
    res.json({ interaction: data });
  } catch (err) {
    console.error('[interactions.create]', err);
    res.status(500).json({ error: err.message || 'failed to log interaction' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/interactions/email-drop
// Drag-dropped email file (.msg / .eml) or any correspondence attachment
// (.pdf / .png / .jpg). Stored in the homeowner-interactions bucket and
// linked to an interaction row of type='email_inbound' (the common case)
// with attachments JSONB.
//
// Body (multipart/form-data):
//   file        the dropped file (required)
//   property_id required
//   direction   optional — defaults to inbound (the dragged-in case)
//   subject     optional — defaults to the filename
//   content     optional — operator note about what this is
//   occurred_at optional — defaults to file mtime if present, else now
//   logged_by   optional
//
// v1 does NOT parse .msg / .eml bodies. The file is preserved verbatim so
// the operator can open it; the subject/content fields are operator-typed.
// Phase 2 plugs mailparser/msg-extractor in here to auto-fill subject + body.
// ---------------------------------------------------------------------------
router.post('/interactions/email-drop', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'file is required' });
    const b = req.body || {};
    const property_id = b.property_id;
    if (!property_id) return res.status(400).json({ error: 'property_id is required' });

    const community_id = await propertyCommunityId(property_id);

    const direction = (b.direction || 'inbound').toString().toLowerCase();
    if (!VALID_DIRECTIONS.has(direction)) {
      return res.status(400).json({ error: 'invalid direction' });
    }

    const filename = req.file.originalname || 'attachment';
    const mime = req.file.mimetype || 'application/octet-stream';
    const path = storagePathFor({ communityId: community_id, propertyId: property_id, filename });

    const { error: upErr } = await supabase.storage
      .from(STORAGE_BUCKET)
      .upload(path, req.file.buffer, { contentType: mime, upsert: false });
    if (upErr) return res.status(500).json({ error: `storage upload failed: ${upErr.message}` });

    const attachment = {
      type: mime,
      storage_path: path,
      label: filename,
      size_bytes: req.file.size || null,
    };

    const occurred_at = b.occurred_at ? new Date(b.occurred_at).toISOString() : new Date().toISOString();
    const subject = (b.subject || '').toString().slice(0, 300) || filename;
    const loggedBy = (b.logged_by || 'Staff').toString().slice(0, 120);

    // Type heuristic: .msg / .eml → email_inbound/outbound, everything else
    // → email_inbound (correspondence default; operator can change later).
    // The point in v1 is the FILE being on the timeline, not the type.
    const ext = (filename.toLowerCase().match(/\.([a-z0-9]+)$/) || [, ''])[1];
    const isEmail = ext === 'msg' || ext === 'eml';
    const type = direction === 'outbound' ? 'email_outbound' : 'email_inbound';

    const row = {
      community_id,
      property_id,
      type,
      direction,
      subject,
      content: (b.content || '').toString() || null,
      delivery_method: 'email',
      status: direction === 'inbound' ? 'received' : 'sent',
      sent_at: occurred_at,
      received_at: direction === 'inbound' ? occurred_at : null,
      attachments: [attachment],
      source: 'manual',
      notes: `${isEmail ? 'Email file' : 'Correspondence'} dropped by ${loggedBy}`,
    };

    const { data, error } = await supabase
      .from('interactions')
      .insert(row)
      .select('id, type, direction, subject, sent_at, attachments')
      .single();

    if (error) {
      // Roll back the orphan file so a failed insert doesn't leave a
      // dangling attachment in the bucket.
      try { await supabase.storage.from(STORAGE_BUCKET).remove([path]); } catch (_) {}
      return res.status(500).json({ error: error.message });
    }
    res.json({ interaction: data });
  } catch (err) {
    console.error('[interactions.email-drop]', err);
    res.status(500).json({ error: err.message || 'failed to attach file' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/interactions/attachment-url?path=<storage_path>
// Mint a 1-hour signed URL so the timeline can render clickable file links
// without leaking storage paths to the browser at page-load time.
// ---------------------------------------------------------------------------
router.get('/interactions/attachment-url', async (req, res) => {
  const path = (req.query.path || '').toString();
  if (!path) return res.status(400).json({ error: 'path is required' });
  // Light path-shape guard so callers can't ask us to sign arbitrary buckets.
  if (path.startsWith('/') || path.includes('..')) {
    return res.status(400).json({ error: 'invalid path' });
  }
  try {
    const { data, error } = await supabase.storage
      .from(STORAGE_BUCKET)
      .createSignedUrl(path, 60 * 60);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ signed_url: data?.signedUrl || null });
  } catch (err) {
    res.status(500).json({ error: err.message || 'sign failed' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/interactions/summarize
// Body: { property_id }
// Returns: { summary, followups: [], headline, generated_at }
//
// Reads the full interactions thread for a property (up to 50 rows, the
// timeline's own cap) and asks the AI for a concise plain-English
// summary that a staff member can read in 10 seconds before picking up
// the phone. Headline = one-liner (who/what); summary = 2-4 sentences
// of the story arc; followups = open commitments not yet closed out.
// ---------------------------------------------------------------------------
router.post('/interactions/summarize', express.json(), async (req, res) => {
  const property_id = (req.body || {}).property_id;
  if (!property_id) return res.status(400).json({ error: 'property_id is required' });
  try {
    const { getInteractionHistoryBundle } = require('../lib/interactions/history');
    const bundle = await getInteractionHistoryBundle({ property_id, caller_facing: false, include_recent: false });
    if (bundle.ok === false) return res.status(404).json(bundle);
    // Keep the response shape stable for the existing frontend renderer.
    res.json({
      headline:  bundle.headline,
      summary:   bundle.summary,
      followups: bundle.open_followups || [],
      row_count: bundle.row_count,
      generated_at: bundle.generated_at,
    });
  } catch (err) {
    console.error('[interactions.summarize]', err);
    res.status(500).json({ error: err.message || 'summary failed' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/interactions/property-search?q=<query>
// Backs the top-bar "📞 Log contact" shortcut. Cross-community by design —
// staff types an address or owner name from anywhere in the app, picks one
// result, and logs against it. 25-row cap to keep the dropdown snappy.
// ---------------------------------------------------------------------------
router.get('/interactions/property-search', async (req, res) => {
  const q = (req.query.q || '').toString().trim();
  if (q.length < 2) return res.json({ results: [] });
  try {
    // Escape PostgREST .or() reserved characters that would split the filter.
    const safe = q.replace(/[(),%]/g, ' ');
    const pattern = `%${safe}%`;
    const { data, error } = await supabase
      .from('v_current_property_owners')
      .select('property_id, community_id, street_address, city, owner_name, owner_email')
      .or(`street_address.ilike.${pattern},owner_name.ilike.${pattern},owner_email.ilike.${pattern}`)
      .order('street_address')
      .limit(25);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ results: data || [] });
  } catch (err) {
    res.status(500).json({ error: err.message || 'search failed' });
  }
});

module.exports = { router };
