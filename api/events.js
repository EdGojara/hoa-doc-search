// ============================================================================
// Events Module API
// ----------------------------------------------------------------------------
// Mounted at /api/events. Powers:
//   - Admin: plan an event, add vendors with estimates, list past events
//   - Public: /event/:slug pulls the event payload + records signatures
//   - Reporting: vendor cost history, attendance trends, vendor scorecards
//
// All routes scoped to BEDROCK_MGMT_CO_ID for now (single-tenant).
// ============================================================================

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const QRCode = require('qrcode');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const BEDROCK_MGMT_CO_ID = '00000000-0000-0000-0000-000000000001';

const router = express.Router();

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function slugify(s) {
  return (s || '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

async function makeUniqueSlug(base) {
  // Try base, then base-2, base-3, etc.
  let candidate = base;
  let n = 1;
  while (true) {
    const { data } = await supabase
      .from('events')
      .select('id')
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .eq('slug', candidate)
      .maybeSingle();
    if (!data) return candidate;
    n++;
    candidate = `${base}-${n}`;
    if (n > 50) return `${base}-${Date.now().toString(36)}`;
  }
}

function publicBaseUrl(req) {
  // Prefer env override (lets us route public QRs to my.bedrocktxai.com once DNS lands)
  if (process.env.EVENT_PUBLIC_URL) return process.env.EVENT_PUBLIC_URL.replace(/\/+$/, '');
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const host = req.headers['x-forwarded-host'] || req.get('host');
  return `${proto}://${host}`;
}

// ----------------------------------------------------------------------------
// GET /api/events  — list events (filterable by community + status)
// Query: ?community_id=... &status=planned|live|completed
// ----------------------------------------------------------------------------
router.get('/', async (req, res) => {
  try {
    let q = supabase.from('events')
      .select(`
        id, community_id, name, slug, event_type, location, status,
        scheduled_start_at, scheduled_end_at, estimated_attendance,
        budget_estimated, public_signup_enabled, created_at,
        community:communities(id, name)
      `)
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .order('scheduled_start_at', { ascending: false });
    if (req.query.community_id) q = q.eq('community_id', req.query.community_id);
    if (req.query.status) q = q.eq('status', req.query.status);

    const { data, error } = await q;
    if (error) throw error;

    // Attach aggregate cost + attendance counts
    const eventIds = (data || []).map((e) => e.id);
    let costsById = {};
    let attendanceById = {};
    if (eventIds.length > 0) {
      const [{ data: costs }, { data: att }] = await Promise.all([
        supabase.from('v_event_costs')
          .select('event_id, vendors_estimated_total, vendors_actual_total, invoices_total, actual_total_estimate')
          .in('event_id', eventIds),
        supabase.from('v_event_attendance')
          .select('event_id, signatures_count, homeowner_count, guest_count')
          .in('event_id', eventIds)
      ]);
      for (const c of costs || []) costsById[c.event_id] = c;
      for (const a of att || []) attendanceById[a.event_id] = a;
    }

    const enriched = (data || []).map((e) => ({
      ...e,
      costs: costsById[e.id] || null,
      attendance: attendanceById[e.id] || null
    }));

    res.json({ events: enriched });
  } catch (err) {
    console.error('[events] list failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// POST /api/events — create a new event
// Body: { community_id, name, scheduled_start_at, event_type, location,
//          description, scheduled_end_at?, estimated_attendance?,
//          budget_estimated?, waiver_text?, waiver_title?,
//          requires_minor_consent? }
// ----------------------------------------------------------------------------
router.post('/', express.json(), async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.community_id || !b.name || !b.scheduled_start_at) {
      return res.status(400).json({ error: 'community_id, name, and scheduled_start_at are required' });
    }

    // Build a friendly slug: community-slug + event-name + YYYY-MM-DD
    const { data: comm } = await supabase
      .from('communities')
      .select('slug, name')
      .eq('id', b.community_id)
      .maybeSingle();
    const datePart = (b.scheduled_start_at || '').slice(0, 10).replace(/-/g, '');
    const base = [
      slugify(comm?.slug || comm?.name || 'event'),
      slugify(b.name),
      datePart
    ].filter(Boolean).join('-').slice(0, 90);
    const slug = await makeUniqueSlug(base);

    const insert = {
      management_company_id: BEDROCK_MGMT_CO_ID,
      community_id: b.community_id,
      name: b.name,
      slug,
      event_type: b.event_type || null,
      description: b.description || null,
      location: b.location || null,
      scheduled_start_at: b.scheduled_start_at,
      scheduled_end_at: b.scheduled_end_at || null,
      estimated_attendance: b.estimated_attendance || null,
      max_attendance: b.max_attendance || null,
      budget_estimated: b.budget_estimated || null,
      status: 'planned',
      waiver_required: b.waiver_required ?? true,
      waiver_title: b.waiver_title || `Event Waiver — ${b.name}`,
      waiver_text: b.waiver_text || DEFAULT_WAIVER_TEXT,
      requires_minor_consent: b.requires_minor_consent ?? true,
      public_signup_enabled: b.public_signup_enabled || false
    };

    const { data, error } = await supabase
      .from('events')
      .insert(insert)
      .select()
      .single();
    if (error) throw error;
    res.json({ event: data });
  } catch (err) {
    console.error('[events] create failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

const DEFAULT_WAIVER_TEXT = `By signing below, I acknowledge and agree to the following:

1. I am voluntarily participating in this community event hosted by the homeowners association.

2. I understand that participation involves inherent risks including but not limited to physical activity, exposure to weather, and interaction with other attendees, vendors, and equipment.

3. I assume all risks associated with my participation and the participation of any minor children for whom I am responsible.

4. I release the homeowners association, its board members, management company, staff, vendors, and other attendees from any and all claims, demands, or causes of action arising from my participation in this event, except in cases of gross negligence or willful misconduct.

5. I consent to the use of photographs or videos taken at this event for community publications and marketing purposes, unless I notify event staff otherwise in writing.

6. If I am signing on behalf of a minor, I confirm I am the parent or legal guardian and have authority to do so on their behalf.

7. I understand this is a binding legal agreement and have signed it freely and knowingly.`;

// ----------------------------------------------------------------------------
// GET /api/events/:id — full event detail (admin view: includes vendors + sigs)
// ----------------------------------------------------------------------------
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const [eventResp, vendorsResp, sigsResp, costsResp, attResp] = await Promise.all([
      supabase.from('events')
        .select('*, community:communities(id, name, slug)')
        .eq('id', id)
        .eq('management_company_id', BEDROCK_MGMT_CO_ID)
        .maybeSingle(),
      supabase.from('event_vendors')
        .select('*, vendor:vendors(id, name, primary_contact_name, primary_contact_email, primary_contact_phone)')
        .eq('event_id', id)
        .order('created_at', { ascending: true }),
      supabase.from('event_signatures')
        .select('id, signer_name, signer_email, signer_phone, signer_address, is_homeowner, is_minor, signed_at, source, device_type, checked_in_at, checked_out_at')
        .eq('event_id', id)
        .order('signed_at', { ascending: false }),
      supabase.from('v_event_costs').select('*').eq('event_id', id).maybeSingle(),
      supabase.from('v_event_attendance').select('*').eq('event_id', id).maybeSingle()
    ]);

    if (eventResp.error) throw eventResp.error;
    if (!eventResp.data) return res.status(404).json({ error: 'Event not found' });

    res.json({
      event: eventResp.data,
      vendors: vendorsResp.data || [],
      signatures: sigsResp.data || [],
      costs: costsResp.data || null,
      attendance: attResp.data || null
    });
  } catch (err) {
    console.error('[events] get failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// PATCH /api/events/:id — update event
// ----------------------------------------------------------------------------
router.patch('/:id', express.json(), async (req, res) => {
  try {
    const allowed = [
      'name', 'event_type', 'description', 'location',
      'scheduled_start_at', 'scheduled_end_at',
      'estimated_attendance', 'max_attendance', 'budget_estimated',
      'status', 'waiver_required', 'waiver_title', 'waiver_text',
      'requires_minor_consent', 'public_signup_enabled',
      'actual_start_at', 'actual_end_at'
    ];
    const patch = {};
    for (const k of allowed) if (k in req.body) patch[k] = req.body[k];
    patch.updated_at = new Date().toISOString();

    const { data, error } = await supabase
      .from('events')
      .update(patch)
      .eq('id', req.params.id)
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .select()
      .single();
    if (error) throw error;
    res.json({ event: data });
  } catch (err) {
    console.error('[events] patch failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// DELETE /api/events/:id — delete (cascades to vendors + signatures)
// ----------------------------------------------------------------------------
router.delete('/:id', async (req, res) => {
  try {
    const { error } = await supabase
      .from('events')
      .delete()
      .eq('id', req.params.id)
      .eq('management_company_id', BEDROCK_MGMT_CO_ID);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    console.error('[events] delete failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// POST /api/events/:id/vendors — add a vendor line
// Body: { vendor_id?, vendor_name_snapshot?, service_role, service_description?,
//          estimated_cost?, actual_cost?, payment_status?, notes?, ordered_at?, delivery_date? }
// ----------------------------------------------------------------------------
router.post('/:id/vendors', express.json(), async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.service_role) return res.status(400).json({ error: 'service_role is required' });
    if (!b.vendor_id && !b.vendor_name_snapshot) {
      return res.status(400).json({ error: 'Either vendor_id or vendor_name_snapshot is required' });
    }

    // If vendor_id provided, fetch the name to snapshot
    let snapshot = b.vendor_name_snapshot;
    if (b.vendor_id && !snapshot) {
      const { data: v } = await supabase.from('vendors').select('name').eq('id', b.vendor_id).maybeSingle();
      snapshot = v?.name || null;
    }

    const { data, error } = await supabase
      .from('event_vendors')
      .insert({
        event_id: req.params.id,
        vendor_id: b.vendor_id || null,
        vendor_name_snapshot: snapshot,
        service_role: b.service_role,
        service_description: b.service_description || null,
        estimated_cost: b.estimated_cost ?? null,
        actual_cost: b.actual_cost ?? null,
        payment_status: b.payment_status || 'pending',
        notes: b.notes || null,
        ordered_at: b.ordered_at || null,
        delivery_date: b.delivery_date || null
      })
      .select('*, vendor:vendors(id, name, primary_contact_name, primary_contact_email, primary_contact_phone)')
      .single();
    if (error) throw error;
    res.json({ event_vendor: data });
  } catch (err) {
    console.error('[events] add vendor failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// PATCH /api/events/vendors/:vendorRowId — update a vendor line
// ----------------------------------------------------------------------------
router.patch('/vendors/:vendorRowId', express.json(), async (req, res) => {
  try {
    const allowed = [
      'service_role', 'service_description', 'estimated_cost', 'actual_cost',
      'payment_status', 'notes', 'ordered_at', 'delivery_date'
    ];
    const patch = {};
    for (const k of allowed) if (k in req.body) patch[k] = req.body[k];
    patch.updated_at = new Date().toISOString();

    const { data, error } = await supabase
      .from('event_vendors')
      .update(patch)
      .eq('id', req.params.vendorRowId)
      .select('*, vendor:vendors(id, name)')
      .single();
    if (error) throw error;
    res.json({ event_vendor: data });
  } catch (err) {
    console.error('[events] patch vendor failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// DELETE /api/events/vendors/:vendorRowId
// ----------------------------------------------------------------------------
router.delete('/vendors/:vendorRowId', async (req, res) => {
  try {
    const { error } = await supabase
      .from('event_vendors')
      .delete()
      .eq('id', req.params.vendorRowId);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    console.error('[events] delete vendor failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// GET /api/events/:id/qr — return PNG QR code image bytes for public URL
// ----------------------------------------------------------------------------
router.get('/:id/qr', async (req, res) => {
  try {
    const { data: ev, error } = await supabase
      .from('events')
      .select('slug, public_signup_enabled')
      .eq('id', req.params.id)
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .single();
    if (error) throw error;
    if (!ev) return res.status(404).json({ error: 'not found' });

    const url = `${publicBaseUrl(req)}/event/${ev.slug}`;
    const png = await QRCode.toBuffer(url, {
      errorCorrectionLevel: 'M',
      width: 600,
      margin: 1,
      color: { dark: '#1a3a5c', light: '#ffffff' }
    });
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'public, max-age=86400');
    res.set('X-Event-URL', url);
    res.send(png);
  } catch (err) {
    console.error('[events] QR failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// PUBLIC ENDPOINTS — used by /event/:slug page
// ----------------------------------------------------------------------------

// GET /api/events/public/:slug — what the public page needs
router.get('/public/:slug', async (req, res) => {
  try {
    const { data: ev, error } = await supabase
      .from('events')
      .select(`
        id, name, slug, description, location, event_type,
        scheduled_start_at, scheduled_end_at, status,
        waiver_required, waiver_title, waiver_text, requires_minor_consent,
        public_signup_enabled,
        community:communities(name, slug)
      `)
      .eq('slug', req.params.slug)
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .maybeSingle();
    if (error) throw error;
    if (!ev) return res.status(404).json({ error: 'Event not found' });
    if (!ev.public_signup_enabled) {
      return res.status(403).json({ error: 'This event is not currently accepting public sign-ins.' });
    }
    res.json({ event: ev });
  } catch (err) {
    console.error('[events] public get failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/events/public/:slug/sign — submit a waiver signature + check-in
// Body: { signer_name, signer_email?, signer_phone?, signer_address?,
//          is_homeowner, guest_of_address?, is_minor, parent_guardian_name?,
//          parent_guardian_signature_png?, signature_png, device_type? }
router.post('/public/:slug/sign', express.json({ limit: '2mb' }), async (req, res) => {
  try {
    const { data: ev } = await supabase
      .from('events')
      .select('id, public_signup_enabled, waiver_text, requires_minor_consent')
      .eq('slug', req.params.slug)
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .maybeSingle();
    if (!ev) return res.status(404).json({ error: 'Event not found' });
    if (!ev.public_signup_enabled) {
      return res.status(403).json({ error: 'This event is not accepting sign-ins.' });
    }

    const b = req.body || {};
    if (!b.signer_name) return res.status(400).json({ error: 'signer_name is required' });
    if (!b.signature_png) return res.status(400).json({ error: 'signature_png is required' });
    if (b.is_minor && ev.requires_minor_consent && !b.parent_guardian_signature_png) {
      return res.status(400).json({ error: 'A parent or guardian signature is required for minors.' });
    }

    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    const ua = req.headers['user-agent'] || '';

    const insert = {
      event_id: ev.id,
      signer_name: b.signer_name,
      signer_email: b.signer_email || null,
      signer_phone: b.signer_phone || null,
      signer_address: b.signer_address || null,
      is_homeowner: !!b.is_homeowner,
      guest_of_address: b.guest_of_address || null,
      is_minor: !!b.is_minor,
      parent_guardian_name: b.parent_guardian_name || null,
      parent_guardian_signature_png: b.parent_guardian_signature_png || null,
      signature_png: b.signature_png,
      waiver_text_at_signing: ev.waiver_text || '',
      ip_address: ip || null,
      user_agent: ua,
      device_type: b.device_type || 'electronic',
      source: 'electronic'
    };

    const { data, error } = await supabase
      .from('event_signatures')
      .insert(insert)
      .select('id, signed_at, signer_name, is_homeowner')
      .single();
    if (error) throw error;

    res.json({ ok: true, signature: data });
  } catch (err) {
    console.error('[events] sign failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// REPORTING ENDPOINTS — Session 3
// ----------------------------------------------------------------------------

// GET /api/events/reports/vendor-history?community_id=&service_role=
// Returns rows of past event_vendors for cost-trend analysis
router.get('/reports/vendor-history', async (req, res) => {
  try {
    let q = supabase.from('event_vendors')
      .select(`
        id, service_role, service_description, estimated_cost, actual_cost,
        delivery_date, vendor_name_snapshot,
        event:events!inner(id, name, scheduled_start_at, community_id, community:communities(name))
      `)
      .order('delivery_date', { ascending: false, nullsFirst: false });

    if (req.query.community_id) q = q.eq('events.community_id', req.query.community_id);
    if (req.query.service_role) q = q.eq('service_role', req.query.service_role);
    if (req.query.vendor_id) q = q.eq('vendor_id', req.query.vendor_id);

    const { data, error } = await q.limit(200);
    if (error) throw error;
    res.json({ rows: data || [] });
  } catch (err) {
    console.error('[events] vendor-history failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/events/reports/cost-trend?community_id=&service_role=
// Aggregated yearly avg + max cost for trend chart
router.get('/reports/cost-trend', async (req, res) => {
  try {
    // We do this in Node since Supabase JS SQL aggregations are limited.
    let q = supabase.from('event_vendors')
      .select(`
        service_role, estimated_cost, actual_cost, delivery_date,
        event:events!inner(scheduled_start_at, community_id)
      `);
    if (req.query.community_id) q = q.eq('events.community_id', req.query.community_id);
    if (req.query.service_role) q = q.eq('service_role', req.query.service_role);

    const { data, error } = await q;
    if (error) throw error;

    const byYearRole = {};
    for (const r of data || []) {
      const stamp = r.delivery_date || r.event?.scheduled_start_at;
      if (!stamp) continue;
      const year = new Date(stamp).getUTCFullYear();
      const key = `${year}|${r.service_role}`;
      if (!byYearRole[key]) byYearRole[key] = { year, role: r.service_role, n: 0, sum: 0, max: 0 };
      const cost = Number(r.actual_cost ?? r.estimated_cost ?? 0);
      if (cost > 0) {
        byYearRole[key].n += 1;
        byYearRole[key].sum += cost;
        if (cost > byYearRole[key].max) byYearRole[key].max = cost;
      }
    }
    const trend = Object.values(byYearRole).map((b) => ({
      year: b.year,
      role: b.role,
      count: b.n,
      avg_cost: b.n > 0 ? b.sum / b.n : 0,
      max_cost: b.max
    })).sort((a, b) => a.year - b.year || a.role.localeCompare(b.role));

    res.json({ trend });
  } catch (err) {
    console.error('[events] cost-trend failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = { router };
