// ============================================================================
// Community contacts directory API
// ----------------------------------------------------------------------------
// Mounted at /api/community-contacts.
//
//   GET    /community/:community_id           list all (grouped by category)
//   GET    /by-slug/:slug                     public lookup by slug + trash schedule
//   POST   /                                  create
//   PATCH  /:id                               update
//   DELETE /:id                               delete
//   PATCH  /community/:community_id/trash-schedule  update trash JSONB
// ============================================================================

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { safeErrorMessage } = require('./_safe_error');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const router = express.Router();

const CATEGORY_LABELS = {
  management: 'Your Bedrock team',
  emergency: 'Emergency',
  utility: 'Utilities & services',
  trash: 'Trash & recycling',
  tv_internet: 'TV / Internet',
  community: 'Community-specific contacts',
  other: 'Other',
};
// Order on the homeowner portal: Bedrock team first (most-used), then
// emergency, then utilities/trash/TV. Community-specific (vendors, clubhouse)
// last because those are reference data, not action-required.
const CATEGORY_ORDER = ['management', 'emergency', 'utility', 'trash', 'tv_internet', 'community', 'other'];

// Helper — group contacts by category in CATEGORY_ORDER sequence
function groupByCategory(rows) {
  const buckets = {};
  for (const r of rows) {
    if (!buckets[r.category]) buckets[r.category] = [];
    buckets[r.category].push(r);
  }
  return CATEGORY_ORDER
    .filter(cat => buckets[cat]?.length)
    .map(cat => ({
      category: cat,
      label: CATEGORY_LABELS[cat],
      contacts: buckets[cat],
    }));
}

// GET /community/:community_id — staff-facing list (all contacts including unpublished)
router.get('/community/:community_id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('community_contacts')
      .select('*')
      .eq('community_id', req.params.community_id)
      .order('category')
      .order('display_order');
    if (error) throw error;

    const { data: community } = await supabase
      .from('communities')
      .select('id, name, slug, trash_schedule')
      .eq('id', req.params.community_id)
      .maybeSingle();

    res.json({
      community,
      contacts: data || [],
      grouped: groupByCategory((data || []).filter(c => c.is_published)),
    });
  } catch (err) {
    console.error('[community-contacts] list failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// GET /by-slug/:slug — homeowner-facing endpoint (published only)
router.get('/by-slug/:slug', async (req, res) => {
  try {
    const { data: community, error: cErr } = await supabase
      .from('communities')
      .select('id, name, slug, trash_schedule')
      .eq('slug', req.params.slug)
      .maybeSingle();
    if (cErr) throw cErr;
    if (!community) return res.status(404).json({ error: 'community_not_found' });

    const { data: contacts, error } = await supabase
      .from('community_contacts')
      .select('id, category, name, phone, email, url, notes, display_order')
      .eq('community_id', community.id)
      .eq('is_published', true)
      .order('display_order');
    if (error) throw error;

    res.json({
      community: { name: community.name, slug: community.slug },
      trash_schedule: community.trash_schedule || null,
      grouped: groupByCategory(contacts || []),
    });
  } catch (err) {
    console.error('[community-contacts] by-slug failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// POST / — create a contact
router.post('/', express.json({ limit: '32kb' }), async (req, res) => {
  try {
    const body = req.body || {};
    if (!body.community_id) return res.status(400).json({ error: 'community_id_required' });
    if (!body.category)     return res.status(400).json({ error: 'category_required' });
    if (!body.name)         return res.status(400).json({ error: 'name_required' });

    const row = {
      community_id:  body.community_id,
      category:      body.category,
      name:          body.name.trim(),
      phone:         body.phone?.trim() || null,
      email:         body.email?.trim() || null,
      url:           body.url?.trim() || null,
      notes:         body.notes?.trim() || null,
      display_order: body.display_order || 100,
      is_published:  body.is_published !== false,
    };
    const { data, error } = await supabase
      .from('community_contacts')
      .insert(row)
      .select('*')
      .single();
    if (error) throw error;
    res.json({ ok: true, contact: data });
  } catch (err) {
    console.error('[community-contacts] create failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// PATCH /:id — update a contact
router.patch('/:id', express.json({ limit: '32kb' }), async (req, res) => {
  try {
    const allowed = ['category', 'name', 'phone', 'email', 'url', 'notes',
                     'display_order', 'is_published'];
    const patch = {};
    for (const k of allowed) {
      if (k in (req.body || {})) patch[k] = req.body[k];
    }
    if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'no_fields_to_update' });
    const { data, error } = await supabase
      .from('community_contacts')
      .update(patch)
      .eq('id', req.params.id)
      .select('*')
      .single();
    if (error) throw error;
    res.json({ ok: true, contact: data });
  } catch (err) {
    console.error('[community-contacts] update failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// DELETE /:id
router.delete('/:id', async (req, res) => {
  try {
    const { error } = await supabase
      .from('community_contacts')
      .delete()
      .eq('id', req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    console.error('[community-contacts] delete failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// PATCH /community/:community_id/trash-schedule
// Saves the schedule JSONB AND (when company_name is provided) upserts the
// trash hauler as a community_contacts row of category 'trash', so the company
// entered once in the trash block also shows in the directory + on the portal.
// The schedule is MERGED over the existing value, never replaced wholesale —
// posting only the visible fields must not wipe keys the UI doesn't render
// (recycling_days, curbside_deadline, vendor_contact_id).
router.patch('/community/:community_id/trash-schedule', express.json({ limit: '8kb' }), async (req, res) => {
  try {
    const cid = req.params.community_id;
    const posted = (req.body && req.body.trash_schedule) || {};
    const companyName = (req.body?.company_name || '').trim();
    const companyPhone = (req.body?.company_phone || '').trim();

    // 1) Merge over existing so we never clobber keys the caller didn't send.
    const { data: comm } = await supabase
      .from('communities').select('trash_schedule').eq('id', cid).maybeSingle();
    const existing = (comm && comm.trash_schedule) || {};
    const merged = { ...existing, ...posted };

    // 2) Upsert the hauler as a category='trash' contact so it lands in the
    //    directory. Canonical home is the contact row; the schedule links to it
    //    by vendor_contact_id (single source of truth — no duplicated name).
    let trashContact = null;
    if (companyName) {
      let vendorId = merged.vendor_contact_id || null;
      if (vendorId) {
        const { data: vc } = await supabase
          .from('community_contacts').select('id').eq('id', vendorId).maybeSingle();
        if (!vc) vendorId = null; // referenced contact was deleted — re-find/create
      }
      if (!vendorId) {
        const { data: existingTrash } = await supabase
          .from('community_contacts').select('id')
          .eq('community_id', cid).eq('category', 'trash')
          .order('display_order').limit(1);
        if (existingTrash && existingTrash.length) vendorId = existingTrash[0].id;
      }
      if (vendorId) {
        const { data } = await supabase
          .from('community_contacts')
          .update({ name: companyName, phone: companyPhone || null })
          .eq('id', vendorId).select('*').single();
        trashContact = data;
      } else {
        const { data } = await supabase
          .from('community_contacts')
          .insert({
            community_id: cid, category: 'trash', name: companyName,
            phone: companyPhone || null, display_order: 40, is_published: true,
          })
          .select('*').single();
        trashContact = data;
        vendorId = data && data.id;
      }
      merged.vendor_contact_id = vendorId || null;
    }

    // 3) Persist the merged schedule.
    const { data, error } = await supabase
      .from('communities')
      .update({ trash_schedule: merged })
      .eq('id', cid)
      .select('id, name, slug, trash_schedule')
      .single();
    if (error) throw error;
    res.json({ ok: true, community: data, trash_contact: trashContact });
  } catch (err) {
    console.error('[community-contacts] trash-schedule update failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

module.exports = { router };
