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
const multer = require('multer');
const XLSX = require('xlsx');
const QRCode = require('qrcode');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const BEDROCK_MGMT_CO_ID = '00000000-0000-0000-0000-000000000001';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const router = express.Router();

// ----------------------------------------------------------------------------
// Roster import helpers
// ----------------------------------------------------------------------------

function normalizeAddress(s) {
  return (s || '').toString().toLowerCase().replace(/\s+/g, ' ').replace(/[^a-z0-9 ]/g, '').trim();
}

// Take a row from any CSV/XLSX and try to extract our canonical fields.
// We accept a wide variety of column naming conventions Vantaca / generic
// HOA exports tend to use.
function mapRosterRow(row) {
  // Lowercase all keys for matching
  const norm = {};
  for (const k of Object.keys(row || {})) norm[k.toLowerCase().trim()] = row[k];

  const pick = (...candidates) => {
    for (const c of candidates) {
      if (norm[c] != null && String(norm[c]).trim() !== '') return String(norm[c]).trim();
    }
    return null;
  };

  const first = pick('first_name', 'firstname', 'first', 'owner first name', 'owner first');
  const last  = pick('last_name', 'lastname', 'last', 'owner last name', 'owner last');
  const full  = pick('full_name', 'fullname', 'name', 'owner name', 'owner', 'homeowner name', 'resident name');
  let firstName = first, lastName = last, fullName = full;
  if (!firstName && !lastName && fullName) {
    const parts = fullName.split(/\s+/);
    if (parts.length >= 2) { firstName = parts[0]; lastName = parts.slice(1).join(' '); }
  }
  if (!fullName && (firstName || lastName)) fullName = [firstName, lastName].filter(Boolean).join(' ');

  return {
    first_name: firstName,
    last_name: lastName,
    full_name: fullName,
    address: pick('address', 'street_address', 'street address', 'property address', 'home address', 'site address', 'lot address'),
    unit: pick('unit', 'apt', 'apartment', 'suite'),
    email: pick('email', 'email_address', 'email address', 'owner email', 'primary email'),
    phone: pick('phone', 'phone_number', 'phone number', 'mobile', 'cell', 'home phone', 'primary phone'),
    vantaca_id: pick('vantaca_id', 'vantaca id', 'account', 'account_id', 'account id', 'account number', 'member id', 'owner id'),
    external_id: pick('external_id', 'external id', 'id'),
    account_status: pick('account_status', 'account status', 'status', 'owner status'),
    is_owner_occupied: (() => {
      const v = pick('is_owner_occupied', 'owner_occupied', 'owner occupied', 'occupied');
      if (v == null) return null;
      return /^(true|yes|y|1|owner|owner-occupied)$/i.test(v);
    })(),
    household_size_hint: (() => {
      const v = pick('household_size', 'household size', 'occupants', 'residents');
      const n = Number(v);
      return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
    })()
  };
}

function workbookToRows(buffer, originalname) {
  const lower = (originalname || '').toLowerCase();
  if (lower.endsWith('.csv')) {
    const wb = XLSX.read(buffer.toString('utf8'), { type: 'string' });
    const sheetName = wb.SheetNames[0];
    return XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: null });
  }
  // xlsx / xls
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const sheetName = wb.SheetNames[0];
  return XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: null });
}

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
        community:communities(id, name, slug)
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
      source: 'electronic',
      // Pre-registration extensions
      party_size: Number(b.party_size) || 1,
      additional_attendee_names: b.additional_attendee_names || null,
      homeowner_id: b.homeowner_id || null,
      pre_registered_at: b.pre_registered_at || new Date().toISOString()
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

// ============================================================================
// ROSTER MANAGEMENT
// ----------------------------------------------------------------------------
// Import homeowners from Vantaca CSV/XLSX → community_homeowners.
// Upsert by vantaca_id when present; otherwise insert as new.
// ============================================================================

// POST /api/events/communities/:communityId/roster/preview
// Returns the parsed rows + column mapping so user can sanity-check before commit
router.post('/communities/:communityId/roster/preview', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'file is required' });
    const rows = workbookToRows(req.file.buffer, req.file.originalname);
    const mapped = rows.slice(0, 500).map(mapRosterRow);
    const stats = {
      total_rows: rows.length,
      with_vantaca_id: mapped.filter((r) => r.vantaca_id).length,
      with_email: mapped.filter((r) => r.email).length,
      with_phone: mapped.filter((r) => r.phone).length,
      with_address: mapped.filter((r) => r.address).length
    };
    res.json({ stats, sample: mapped.slice(0, 10), columns: rows[0] ? Object.keys(rows[0]) : [] });
  } catch (err) {
    console.error('[roster] preview failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/events/communities/:communityId/roster/import
// Commits the parsed rows. Upsert on (community_id, vantaca_id) when present;
// otherwise insert. Returns counts.
router.post('/communities/:communityId/roster/import', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'file is required' });
    const { communityId } = req.params;

    const rows = workbookToRows(req.file.buffer, req.file.originalname);
    const mapped = rows.map(mapRosterRow).filter((r) => r.full_name || r.first_name || r.last_name || r.email || r.address);

    let inserted = 0, updated = 0, skipped = 0;
    const errors = [];

    // Process in chunks to keep round-trips reasonable
    const CHUNK = 100;
    for (let i = 0; i < mapped.length; i += CHUNK) {
      const slice = mapped.slice(i, i + CHUNK).map((r) => ({
        ...r,
        management_company_id: BEDROCK_MGMT_CO_ID,
        community_id: communityId,
        address_normalized: normalizeAddress(r.address),
        source: 'vantaca_import',
        last_synced_at: new Date().toISOString()
      }));

      // For rows with vantaca_id, use upsert (postgres unique index handles dedup)
      const withVantaca = slice.filter((r) => r.vantaca_id);
      const withoutVantaca = slice.filter((r) => !r.vantaca_id);

      if (withVantaca.length > 0) {
        const { data, error } = await supabase
          .from('community_homeowners')
          .upsert(withVantaca, { onConflict: 'community_id,vantaca_id', ignoreDuplicates: false })
          .select('id');
        if (error) errors.push(error.message);
        else updated += data?.length || 0;
      }

      if (withoutVantaca.length > 0) {
        // No strong key — just insert and let address/email indices coexist
        const { data, error } = await supabase
          .from('community_homeowners')
          .insert(withoutVantaca)
          .select('id');
        if (error) errors.push(error.message);
        else inserted += data?.length || 0;
      }

      skipped += slice.length - (withVantaca.length + withoutVantaca.length);
    }

    res.json({
      ok: true,
      inserted,
      updated,
      skipped,
      total_processed: mapped.length,
      errors: errors.slice(0, 5)
    });
  } catch (err) {
    console.error('[roster] import failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/events/communities/:communityId/roster — list/search
router.get('/communities/:communityId/roster', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    let query = supabase
      .from('community_homeowners')
      .select('id, first_name, last_name, full_name, address, unit, email, phone, vantaca_id, account_status, last_synced_at')
      .eq('community_id', req.params.communityId)
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .order('last_name', { ascending: true, nullsFirst: false })
      .limit(Math.min(Number(req.query.limit) || 200, 500));

    if (q) {
      // Postgres ILIKE search across the most useful fields
      const like = `%${q.replace(/[%_]/g, '')}%`;
      query = query.or(`full_name.ilike.${like},last_name.ilike.${like},first_name.ilike.${like},address.ilike.${like},email.ilike.${like}`);
    }

    const { data, error } = await query;
    if (error) throw error;

    // Also surface the total count for the community (separate quick query)
    const { count } = await supabase
      .from('community_homeowners')
      .select('id', { count: 'exact', head: true })
      .eq('community_id', req.params.communityId)
      .eq('management_company_id', BEDROCK_MGMT_CO_ID);

    res.json({ rows: data || [], total_count: count || 0 });
  } catch (err) {
    console.error('[roster] list failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/events/roster/:homeownerId — remove a single row
router.delete('/roster/:homeownerId', async (req, res) => {
  try {
    const { error } = await supabase
      .from('community_homeowners')
      .delete()
      .eq('id', req.params.homeownerId)
      .eq('management_company_id', BEDROCK_MGMT_CO_ID);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    console.error('[roster] delete failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/events/communities/:communityId/roster — wipe (with confirm token)
router.delete('/communities/:communityId/roster', async (req, res) => {
  try {
    if (req.query.confirm !== 'yes-delete-all') {
      return res.status(400).json({ error: 'pass ?confirm=yes-delete-all to wipe' });
    }
    const { error } = await supabase
      .from('community_homeowners')
      .delete()
      .eq('community_id', req.params.communityId)
      .eq('management_company_id', BEDROCK_MGMT_CO_ID);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    console.error('[roster] wipe failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// ROSTER MATCHING — used by public registration to verify homeowner status
// ============================================================================

// GET /api/events/communities/:communityId/roster-match
// Query: ?address=...&name=...
// Returns best-match candidates (so the public form can show "✓ Verified at 8201 Pine Forest")
router.get('/communities/:communityId/roster-match', async (req, res) => {
  try {
    const { communityId } = req.params;
    const address = req.query.address ? String(req.query.address).trim() : null;
    const name = req.query.name ? String(req.query.name).trim() : null;
    if (!address && !name) return res.json({ matches: [] });

    let query = supabase
      .from('community_homeowners')
      .select('id, full_name, first_name, last_name, address, unit, email, phone')
      .eq('community_id', communityId)
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .limit(8);

    if (address) {
      const normalized = normalizeAddress(address);
      // First try address_normalized exact, then ilike on raw address
      const { data: exact } = await supabase
        .from('community_homeowners')
        .select('id, full_name, first_name, last_name, address, unit, email, phone')
        .eq('community_id', communityId)
        .eq('management_company_id', BEDROCK_MGMT_CO_ID)
        .eq('address_normalized', normalized)
        .limit(5);
      if (exact && exact.length > 0) return res.json({ matches: exact, match_type: 'exact_address' });

      const like = `%${address.replace(/[%_]/g, '')}%`;
      query = query.ilike('address', like);
    } else if (name) {
      const like = `%${name.replace(/[%_]/g, '')}%`;
      query = query.or(`full_name.ilike.${like},last_name.ilike.${like},first_name.ilike.${like}`);
    }

    const { data, error } = await query;
    if (error) throw error;
    res.json({ matches: data || [], match_type: 'fuzzy' });
  } catch (err) {
    console.error('[roster-match] failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// STAFF CHECK-IN — gated by 6-digit code, mobile-first dashboard
// ============================================================================

// POST /api/events/:id/generate-checkin-code — manager creates / rotates the code
router.post('/:id/generate-checkin-code', async (req, res) => {
  try {
    const code = String(Math.floor(100000 + Math.random() * 900000)); // 6 digits
    const { data, error } = await supabase
      .from('events')
      .update({ staff_checkin_code: code, updated_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .select('id, slug, staff_checkin_code')
      .single();
    if (error) throw error;
    res.json({ event: data });
  } catch (err) {
    console.error('[checkin] code gen failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/events/public/:slug/checkin-auth — staff enters 6-digit code, gets a short-lived token
router.post('/public/:slug/checkin-auth', express.json(), async (req, res) => {
  try {
    const { code } = req.body || {};
    if (!code) return res.status(400).json({ error: 'code is required' });

    const { data: ev, error } = await supabase
      .from('events')
      .select('id, slug, name, staff_checkin_code')
      .eq('slug', req.params.slug)
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .single();
    if (error) throw error;
    if (!ev) return res.status(404).json({ error: 'not found' });
    if (!ev.staff_checkin_code || String(code) !== String(ev.staff_checkin_code)) {
      return res.status(401).json({ error: 'Incorrect code.' });
    }
    res.json({ ok: true, event: { id: ev.id, name: ev.name, slug: ev.slug } });
  } catch (err) {
    console.error('[checkin-auth] failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/events/public/:slug/checkin-feed — live data for the staff page
// Body none. Headers: X-Checkin-Code (the 6-digit code, validated each poll)
router.get('/public/:slug/checkin-feed', async (req, res) => {
  try {
    const code = req.headers['x-checkin-code'];
    const { data: ev, error: evErr } = await supabase
      .from('events')
      .select(`
        id, name, slug, location, scheduled_start_at, scheduled_end_at,
        community_id, staff_checkin_code, waiver_required, waiver_title, waiver_text
      `)
      .eq('slug', req.params.slug)
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .single();
    if (evErr) throw evErr;
    if (!ev) return res.status(404).json({ error: 'not found' });
    if (!ev.staff_checkin_code || String(code) !== String(ev.staff_checkin_code)) {
      return res.status(401).json({ error: 'invalid code' });
    }

    const [{ data: signatures }, { data: attendance }] = await Promise.all([
      supabase.from('event_signatures')
        .select('id, signer_name, signer_email, signer_phone, signer_address, is_homeowner, is_minor, party_size, additional_attendee_names, homeowner_id, pre_registered_at, signed_at, checked_in_at, checked_in_by, signature_png, waiver_text_at_signing')
        .eq('event_id', ev.id)
        .order('pre_registered_at', { ascending: true, nullsFirst: false }),
      supabase.from('v_event_attendance')
        .select('*')
        .eq('event_id', ev.id)
        .maybeSingle()
    ]);

    res.json({
      event: { id: ev.id, name: ev.name, slug: ev.slug, location: ev.location, scheduled_start_at: ev.scheduled_start_at, community_id: ev.community_id, waiver_text: ev.waiver_text, waiver_title: ev.waiver_title, waiver_required: ev.waiver_required },
      signatures: signatures || [],
      attendance: attendance || null
    });
  } catch (err) {
    console.error('[checkin-feed] failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/events/public/:slug/checkin/:signatureId — staff marks attendee checked in
router.post('/public/:slug/checkin/:signatureId', express.json(), async (req, res) => {
  try {
    const code = req.headers['x-checkin-code'];
    const { data: ev } = await supabase
      .from('events')
      .select('id, staff_checkin_code')
      .eq('slug', req.params.slug)
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .single();
    if (!ev) return res.status(404).json({ error: 'not found' });
    if (!ev.staff_checkin_code || String(code) !== String(ev.staff_checkin_code)) {
      return res.status(401).json({ error: 'invalid code' });
    }

    const { staff_label } = req.body || {};
    const { data, error } = await supabase
      .from('event_signatures')
      .update({
        checked_in_at: new Date().toISOString(),
        checked_in_by: staff_label || null
      })
      .eq('id', req.params.signatureId)
      .eq('event_id', ev.id)
      .select('id, signer_name, party_size, checked_in_at')
      .single();
    if (error) throw error;
    res.json({ ok: true, signature: data });
  } catch (err) {
    console.error('[checkin] mark failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/events/public/:slug/walkup — register a walk-up at the event
// Body: { signer_name, signer_email?, signer_phone?, signer_address?, is_homeowner,
//          party_size, additional_attendee_names?, signature_png, staff_label? }
router.post('/public/:slug/walkup', express.json({ limit: '2mb' }), async (req, res) => {
  try {
    const code = req.headers['x-checkin-code'];
    const { data: ev } = await supabase
      .from('events')
      .select('id, community_id, staff_checkin_code, waiver_text')
      .eq('slug', req.params.slug)
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .single();
    if (!ev) return res.status(404).json({ error: 'not found' });
    if (!ev.staff_checkin_code || String(code) !== String(ev.staff_checkin_code)) {
      return res.status(401).json({ error: 'invalid code' });
    }

    const b = req.body || {};
    if (!b.signer_name || !b.signature_png) {
      return res.status(400).json({ error: 'signer_name and signature_png are required' });
    }

    // Optional roster match on address
    let homeownerId = null;
    if (b.signer_address) {
      const normalized = normalizeAddress(b.signer_address);
      const { data: match } = await supabase
        .from('community_homeowners')
        .select('id')
        .eq('community_id', ev.community_id)
        .eq('address_normalized', normalized)
        .maybeSingle();
      if (match) homeownerId = match.id;
    }

    const now = new Date().toISOString();
    const { data, error } = await supabase
      .from('event_signatures')
      .insert({
        event_id: ev.id,
        signer_name: b.signer_name,
        signer_email: b.signer_email || null,
        signer_phone: b.signer_phone || null,
        signer_address: b.signer_address || null,
        is_homeowner: !!b.is_homeowner,
        is_minor: !!b.is_minor,
        party_size: Number(b.party_size) || 1,
        additional_attendee_names: b.additional_attendee_names || null,
        homeowner_id: homeownerId,
        pre_registered_at: null,   // walk-up: skip pre-reg timestamp
        signature_png: b.signature_png,
        waiver_text_at_signing: ev.waiver_text || '',
        ip_address: (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim() || null,
        user_agent: req.headers['user-agent'] || '',
        device_type: 'walkup_tablet',
        source: 'electronic',
        checked_in_at: now,
        checked_in_by: b.staff_label || null
      })
      .select()
      .single();
    if (error) throw error;
    res.json({ ok: true, signature: data });
  } catch (err) {
    console.error('[walkup] failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// EMAIL BLAST — generate HTML the manager can paste into Outlook
// ============================================================================

router.get('/:id/email-blast', async (req, res) => {
  try {
    const { data: ev, error } = await supabase
      .from('events')
      .select('*, community:communities(name)')
      .eq('id', req.params.id)
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .single();
    if (error) throw error;
    if (!ev) return res.status(404).json({ error: 'not found' });

    const baseUrl = publicBaseUrl(req);
    const eventUrl = `${baseUrl}/event/${ev.slug}`;
    const qrUrl = `${baseUrl}/api/events/${ev.id}/qr`;

    const startDate = new Date(ev.scheduled_start_at);
    const dateStr = startDate.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
    const timeStr = startDate.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

    const html = `<!DOCTYPE html>
<html><body style="font-family: Inter, Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; color: #1f2937;">
  <div style="background: #1a3a5c; color: #fff; padding: 24px; border-radius: 8px 8px 0 0; text-align: center;">
    <h1 style="margin: 0; font-size: 24px;">${escapeHtml(ev.name)}</h1>
    <div style="margin-top: 8px; font-size: 14px; opacity: 0.9;">${escapeHtml(ev.community?.name || '')}</div>
  </div>
  <div style="background: #fff; padding: 24px; border: 1px solid #e2e8f0; border-top: none; border-radius: 0 0 8px 8px;">
    <p style="font-size: 16px; line-height: 1.6;">
      You're invited to a community event!
    </p>
    <div style="background: #f5f8fc; padding: 16px; border-radius: 6px; margin: 16px 0;">
      <div style="font-size: 15px; line-height: 1.8;">
        📅 <strong>${escapeHtml(dateStr)}</strong><br>
        🕒 <strong>${escapeHtml(timeStr)}</strong>${ev.scheduled_end_at ? ` – ${escapeHtml(new Date(ev.scheduled_end_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }))}` : ''}<br>
        ${ev.location ? `📍 <strong>${escapeHtml(ev.location)}</strong>` : ''}
      </div>
    </div>
    ${ev.description ? `<p style="font-size: 14px; line-height: 1.6;">${escapeHtml(ev.description)}</p>` : ''}

    <h2 style="font-size: 16px; color: #1a3a5c; margin-top: 24px;">🎟️ Skip the line — register now</h2>
    <p style="font-size: 14px; line-height: 1.6;">
      Pre-register and sign the event waiver before you arrive. When you get to the event,
      we'll have a dedicated <strong>fast lane</strong> for pre-registered guests — just walk up,
      we'll verify your name, and you're in.
    </p>
    <div style="text-align: center; margin: 24px 0;">
      <a href="${eventUrl}" style="display: inline-block; background: #1a3a5c; color: #fff; text-decoration: none; padding: 14px 32px; border-radius: 8px; font-weight: 600; font-size: 16px;">Register here →</a>
    </div>
    <p style="font-size: 13px; line-height: 1.6; color: #475569; text-align: center;">
      Or scan this QR code with your phone camera:
    </p>
    <div style="text-align: center; margin: 16px 0;">
      <img src="${qrUrl}" alt="Scan to register" style="width: 180px; height: 180px;" />
    </div>
    <p style="font-size: 12px; line-height: 1.5; color: #64748b; margin-top: 24px; text-align: center;">
      Hosted by Bedrock Association Management
    </p>
  </div>
</body></html>`;

    res.json({ html, plain_text_url: eventUrl });
  } catch (err) {
    console.error('[email-blast] failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

function escapeHtml(s) {
  return (s == null ? '' : String(s))
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

module.exports = { router };
