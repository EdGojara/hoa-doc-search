// ============================================================================
// api/community_photos.js — community photo asset library
// ----------------------------------------------------------------------------
// Mounted at /api/community-photos
//
// Shared asset library used by:
//   • Annual reports (cover hero, section breaks, photo gallery)
//   • Monthly newsletters (header hero, amenity callouts)
//   • Meeting notices (community context)
//   • Portal homepage backgrounds
//   • Board packet companion mailings
//   • Letterheads in select cases
//
// One canonical place. Multiple consumers reference photos by id or by
// (community_id + role) query — never duplicated into per-module tables.
//
// Endpoints:
//   POST   /                          → upload one or more photos (multer)
//   GET    /                          → list photos (filter by community/role)
//   PATCH  /:id                       → edit metadata (caption, role, sort_order, active)
//   DELETE /:id                       → soft-delete (active=false) by default,
//                                       hard-delete + storage cleanup with ?hard=1
//   GET    /:id/file                  → signed URL to the storage object (10-min TTL)
// ============================================================================

const express = require('express');
const multer = require('multer');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
const { safeErrorMessage } = require('./_safe_error');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const STORAGE_BUCKET = 'documents';
const BEDROCK_MGMT_CO_ID = '00000000-0000-0000-0000-000000000001';

// 12 MB per photo, 12 photos max per request — covers a full drone session or
// a phone-album batch from a single community walk.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024, files: 12 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) {
      return cb(new Error('Only image files are accepted (got ' + file.mimetype + ')'), false);
    }
    cb(null, true);
  },
});

const ALLOWED_ROLES = ['hero', 'amenity', 'landscape', 'aerial', 'signage', 'event', 'general'];

// ----------------------------------------------------------------------------
// POST / — upload one or more photos
//
// Multipart fields:
//   community_id     (required)
//   files            (required, multipart files)
//   role             (optional, default 'general') — single value applied to all
//   roles            (optional, parallel array per-file)
//   captions         (optional, parallel array per-file)
//   uploaded_by      (optional)
// ----------------------------------------------------------------------------
router.post('/', upload.array('files', 12), async (req, res) => {
  try {
    const communityId = req.body.community_id;
    if (!communityId) return res.status(400).json({ error: 'community_id is required' });

    // Resolve the community to (a) confirm it exists and (b) pull the slug
    // for the storage path.
    const { data: community, error: commErr } = await supabase
      .from('communities')
      .select('id, slug, name, management_company_id')
      .eq('id', communityId)
      .maybeSingle();
    if (commErr) throw commErr;
    if (!community) return res.status(404).json({ error: 'community not found' });
    if (community.management_company_id !== BEDROCK_MGMT_CO_ID) {
      return res.status(403).json({ error: 'community is not Bedrock-managed' });
    }

    const files = req.files || [];
    if (!files.length) return res.status(400).json({ error: 'no files uploaded' });

    // Per-file role + caption — accept parallel arrays OR a single value
    // applied to all files. Same pattern as builder_applications attachments.
    const rolesArr = Array.isArray(req.body.roles) ? req.body.roles
                   : typeof req.body.roles === 'string' ? [req.body.roles]
                   : null;
    const captionsArr = Array.isArray(req.body.captions) ? req.body.captions
                      : typeof req.body.captions === 'string' ? [req.body.captions]
                      : null;
    const defaultRole = req.body.role && ALLOWED_ROLES.includes(req.body.role) ? req.body.role : 'general';

    const year = new Date().getFullYear();
    const inserted = [];

    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const safeName = (f.originalname || `photo_${i}.jpg`).replace(/[^\w.\-]+/g, '_');
      const storagePath = `communities/${community.slug}/photos/${year}/${Date.now()}_${i}_${safeName}`;

      // Upload to storage first
      const up = await supabase.storage
        .from(STORAGE_BUCKET)
        .upload(storagePath, f.buffer, {
          contentType: f.mimetype,
          upsert: false,
        });
      if (up.error) {
        console.warn('[community_photos] storage upload failed:', up.error.message);
        inserted.push({ index: i, error: 'storage upload failed: ' + up.error.message });
        continue;
      }

      // Then create the metadata row
      const role = (rolesArr && rolesArr[i] && ALLOWED_ROLES.includes(rolesArr[i]))
        ? rolesArr[i]
        : defaultRole;
      const caption = captionsArr && captionsArr[i] ? captionsArr[i] : null;

      const { data: row, error: rowErr } = await supabase
        .from('community_photos')
        .insert({
          community_id: community.id,
          storage_bucket: STORAGE_BUCKET,
          storage_path: storagePath,
          original_filename: f.originalname || null,
          mime_type: f.mimetype || null,
          size_bytes: f.size || null,
          role,
          caption,
          uploaded_by: req.body.uploaded_by || null,
        })
        .select('id, role, original_filename, size_bytes, uploaded_at')
        .single();
      if (rowErr) {
        // Roll back the storage upload so we don't leave orphans
        try { await supabase.storage.from(STORAGE_BUCKET).remove([storagePath]); } catch (_) {}
        inserted.push({ index: i, error: 'metadata insert failed: ' + rowErr.message });
        continue;
      }
      inserted.push({ index: i, ...row });
    }

    res.json({ ok: true, uploaded: inserted });
  } catch (err) {
    console.error('[community_photos] upload failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ----------------------------------------------------------------------------
// GET / — list photos
//   ?community_id=  (required for now; portfolio-wide listing comes later)
//   ?role=          (optional, repeat or comma-separated)
//   ?include_inactive=1  (optional, default false)
//   ?limit=         (optional, default 200, hard-capped at 500)
// ----------------------------------------------------------------------------
router.get('/', async (req, res) => {
  try {
    const communityId = req.query.community_id;
    if (!communityId) return res.status(400).json({ error: 'community_id is required' });

    const limit = Math.min(parseInt(req.query.limit, 10) || 200, 500);
    const includeInactive = req.query.include_inactive === '1';
    const rolesParam = req.query.role;
    const roles = Array.isArray(rolesParam) ? rolesParam
                : typeof rolesParam === 'string' ? rolesParam.split(',').map((s) => s.trim()).filter(Boolean)
                : null;

    let q = supabase
      .from('community_photos')
      .select('id, community_id, storage_path, original_filename, mime_type, size_bytes, width_px, height_px, role, caption, taken_at, sort_order, active, uploaded_by, uploaded_at')
      .eq('community_id', communityId)
      .order('role')
      .order('sort_order')
      .order('uploaded_at', { ascending: false })
      .limit(limit);
    if (!includeInactive) q = q.eq('active', true);
    if (roles && roles.length) q = q.in('role', roles);

    const { data, error } = await q;
    if (error) throw error;

    // Sign each storage path so the client can render thumbnails. 10-min TTL.
    const enriched = await Promise.all((data || []).map(async (p) => {
      const { data: signed } = await supabase.storage
        .from(STORAGE_BUCKET)
        .createSignedUrl(p.storage_path, 60 * 10);
      return { ...p, signed_url: signed?.signedUrl || null };
    }));

    res.json({ photos: enriched, count: enriched.length });
  } catch (err) {
    console.error('[community_photos] list failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ----------------------------------------------------------------------------
// PATCH /:id — edit metadata
//   allowedFields: role, caption, sort_order, active, taken_at, notes
// ----------------------------------------------------------------------------
router.patch('/:id', express.json({ limit: '8kb' }), async (req, res) => {
  try {
    const allowed = ['role', 'caption', 'sort_order', 'active', 'taken_at', 'notes'];
    const patch = {};
    for (const k of allowed) {
      if (req.body[k] !== undefined) patch[k] = req.body[k];
    }
    if (patch.role !== undefined && !ALLOWED_ROLES.includes(patch.role)) {
      return res.status(400).json({ error: 'invalid role: ' + patch.role });
    }
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'no editable fields in body' });

    const { data, error } = await supabase
      .from('community_photos')
      .update(patch)
      .eq('id', req.params.id)
      .select('id, role, caption, sort_order, active, taken_at, notes, updated_at')
      .single();
    if (error) throw error;

    res.json({ ok: true, photo: data });
  } catch (err) {
    console.error('[community_photos] patch failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ----------------------------------------------------------------------------
// DELETE /:id — soft-delete by default (active=false), hard with ?hard=1
// ----------------------------------------------------------------------------
router.delete('/:id', async (req, res) => {
  try {
    const hard = req.query.hard === '1';
    if (!hard) {
      const { error } = await supabase
        .from('community_photos')
        .update({ active: false })
        .eq('id', req.params.id);
      if (error) throw error;
      return res.json({ ok: true, mode: 'soft' });
    }

    // Hard delete — first read the storage_path so we can clean up the blob.
    const { data: row, error: readErr } = await supabase
      .from('community_photos')
      .select('storage_bucket, storage_path')
      .eq('id', req.params.id)
      .maybeSingle();
    if (readErr) throw readErr;
    if (!row) return res.status(404).json({ error: 'photo not found' });

    const { error: delErr } = await supabase
      .from('community_photos')
      .delete()
      .eq('id', req.params.id);
    if (delErr) throw delErr;

    try { await supabase.storage.from(row.storage_bucket || STORAGE_BUCKET).remove([row.storage_path]); }
    catch (e) { console.warn('[community_photos] storage cleanup failed:', e.message); }

    res.json({ ok: true, mode: 'hard' });
  } catch (err) {
    console.error('[community_photos] delete failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ----------------------------------------------------------------------------
// GET /:id/file — signed URL (10-min TTL) for the storage object
// ----------------------------------------------------------------------------
router.get('/:id/file', async (req, res) => {
  try {
    const { data: row, error } = await supabase
      .from('community_photos')
      .select('storage_bucket, storage_path, mime_type')
      .eq('id', req.params.id)
      .maybeSingle();
    if (error) throw error;
    if (!row) return res.status(404).json({ error: 'photo not found' });

    const { data: signed, error: signErr } = await supabase.storage
      .from(row.storage_bucket || STORAGE_BUCKET)
      .createSignedUrl(row.storage_path, 60 * 10);
    if (signErr) throw signErr;

    res.json({ signed_url: signed?.signedUrl || null, mime_type: row.mime_type });
  } catch (err) {
    console.error('[community_photos] signed_url failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

module.exports = router;
