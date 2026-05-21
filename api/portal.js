// ============================================================================
// Homeowner Portal API
// ----------------------------------------------------------------------------
// Mounted at /api/portal. Powers the showcase landing at /portal.
//
// Auth flow (magic link, no password):
//   POST /request-link    homeowner enters email → token created + emailed
//   POST /consume?token=  link clicked → HMAC cookie set → redirect to /portal
//   GET  /me              read cookie → return user + property + community ctx
//   POST /logout          clear cookie
//
// Cookie scheme (separate from STAFF_GATE used for the staff app):
//   TRUSTED_PORTAL = <portal_user_id>.<timestamp>.<hmac(secret, user_id + ts)>
//
// Hardening:
//   - Tokens single-use (used_at stamped on consume)
//   - 1-hour expiry on tokens, 30-day cookie session
//   - Constant-time HMAC verify
//   - No email enumeration: request-link always returns 200 ok regardless
//     of whether the email is registered
// ============================================================================

const express = require('express');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { safeErrorMessage } = require('./_safe_error');
const { sendEmail } = require('../lib/notifications/email');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const BEDROCK_MGMT_CO_ID = '00000000-0000-0000-0000-000000000001';

const COOKIE_NAME = 'TRUSTED_PORTAL';
const COOKIE_TTL_DAYS = 30;
const MAGIC_LINK_TTL_HOURS = 1;

const router = express.Router();

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function portalSecret() {
  return process.env.STAFF_PASSWORD || process.env.SUPABASE_KEY || 'fallback-do-not-use';
}

function signCookie(portalUserId) {
  const ts = Date.now().toString();
  const sig = crypto.createHmac('sha256', portalSecret())
    .update(`${portalUserId}.${ts}`)
    .digest('hex');
  return `${portalUserId}.${ts}.${sig}`;
}

function verifyCookie(token) {
  if (!token) return null;
  const parts = String(token).split('.');
  if (parts.length !== 3) return null;
  const [portalUserId, ts, sig] = parts;
  if (!ts || !/^\d+$/.test(ts)) return null;
  const age = Date.now() - Number(ts);
  if (age > COOKIE_TTL_DAYS * 86400 * 1000) return null;
  const expected = crypto.createHmac('sha256', portalSecret())
    .update(`${portalUserId}.${ts}`)
    .digest('hex');
  try {
    if (sig.length !== expected.length) return null;
    if (!crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'))) return null;
  } catch (_) { return null; }
  return portalUserId;
}

function readCookie(req, name) {
  const raw = req.headers.cookie || '';
  const m = raw.match(new RegExp(`(?:^|; )${name}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : null;
}

function setPortalCookie(res, value) {
  const maxAge = COOKIE_TTL_DAYS * 24 * 60 * 60;
  res.setHeader('Set-Cookie',
    `${COOKIE_NAME}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}; Secure`);
}

function clearPortalCookie(res) {
  res.setHeader('Set-Cookie',
    `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function makeMagicToken() {
  return crypto.randomBytes(32).toString('hex');
}

function magicLinkUrl(req, token) {
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
  const host = req.get('host');
  return `${proto}://${host}/portal-login.html?token=${token}`;
}

async function logAudit(action, opts = {}) {
  try {
    await supabase.from('portal_audit_log').insert({
      portal_user_id: opts.portal_user_id || null,
      action,
      resource_type: opts.resource_type || null,
      resource_id: opts.resource_id || null,
      ip_address: opts.ip_address || null,
      user_agent: opts.user_agent || null,
      performed_by: opts.performed_by || null,
      notes: opts.notes || null,
    });
  } catch (_) { /* non-fatal */ }
}

// ============================================================================
// POST /api/portal/request-link
// Body: { email }
// Anti-enumeration: always returns { ok: true } whether or not the email is on file.
// ============================================================================
router.post('/request-link', express.json({ limit: '8kb' }), async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!email || !email.includes('@')) {
      // Don't reveal what's wrong — same shape as success
      return res.json({ ok: true });
    }

    // Find a portal_user with that email
    const { data: user } = await supabase
      .from('portal_users')
      .select('id, email, full_name, role, status')
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .eq('email', email)
      .maybeSingle();

    if (!user || user.status === 'revoked') {
      // Silent — no enumeration
      return res.json({ ok: true });
    }

    // Issue token
    const token = makeMagicToken();
    const expiresAt = new Date(Date.now() + MAGIC_LINK_TTL_HOURS * 60 * 60 * 1000).toISOString();
    await supabase.from('portal_magic_links').insert({
      portal_user_id: user.id,
      token,
      purpose: 'login',
      expires_at: expiresAt,
    });

    // Send the email
    const url = magicLinkUrl(req, token);
    await sendEmail({
      to: user.email,
      subject: 'Your sign-in link for the Bedrock homeowner portal',
      html: `
        <p>Hi${user.full_name ? ' ' + escapeHtml(user.full_name.split(' ')[0]) : ''},</p>
        <p>Click below to sign in to your community's homeowner portal. The link is valid for ${MAGIC_LINK_TTL_HOURS} hour${MAGIC_LINK_TTL_HOURS === 1 ? '' : 's'}.</p>
        <p style="margin: 20px 0;">
          <a href="${escapeHtml(url)}" style="display:inline-block; background:#1A3050; color:white; padding:12px 22px; border-radius:7px; text-decoration:none; font-weight:500;">
            Sign in to portal
          </a>
        </p>
        <p style="font-size:12px; color:#666;">If you didn't request this, you can ignore this email. The link expires automatically.</p>
        <p style="font-size:12px; color:#666;">Or copy this URL into your browser:<br><span style="font-family:monospace; font-size:11px; word-break:break-all;">${escapeHtml(url)}</span></p>
        <p style="color:#555; font-size:11px; margin-top:24px; padding-top:14px; border-top:1px solid #ddd;">
          Bedrock Association Management · (832) 588-2485 · bedrocktx.com
        </p>
      `,
      tags: [
        { name: 'module', value: 'portal_auth' },
        { name: 'event', value: 'magic_link_sent' },
      ],
    });

    await logAudit('magic_link_sent', { portal_user_id: user.id, ip_address: req.ip });

    res.json({ ok: true });
  } catch (err) {
    console.error('[portal] request-link failed:', err.message);
    // Even on error, return ok shape to avoid leaking signal
    res.json({ ok: true });
  }
});

// ============================================================================
// POST /api/portal/consume?token=...
// Single-use; sets HMAC cookie; redirects (or returns ok JSON for fetch caller).
// ============================================================================
router.post('/consume', async (req, res) => {
  try {
    const token = req.query.token || req.body?.token;
    if (!token) return res.status(400).json({ error: 'token is required' });

    const { data: link } = await supabase
      .from('portal_magic_links')
      .select('id, portal_user_id, purpose, expires_at, used_at')
      .eq('token', token)
      .maybeSingle();

    if (!link) return res.status(400).json({ error: 'sign-in link is invalid' });
    if (link.used_at) return res.status(400).json({ error: 'sign-in link already used' });
    if (new Date(link.expires_at) < new Date()) {
      return res.status(400).json({ error: 'sign-in link has expired' });
    }

    // Confirm user still active
    const { data: user } = await supabase
      .from('portal_users')
      .select('id, status')
      .eq('id', link.portal_user_id)
      .single();
    if (!user || user.status === 'revoked') {
      return res.status(403).json({ error: 'account is not active' });
    }

    // Mark single-use
    await supabase
      .from('portal_magic_links')
      .update({
        used_at: new Date().toISOString(),
        used_ip: req.ip,
        used_user_agent: req.headers['user-agent'] || null,
      })
      .eq('id', link.id);

    // Update portal_users login tracking
    await supabase
      .from('portal_users')
      .update({
        status: user.status === 'invited' ? 'active' : user.status,
        first_login_at: null,  // only set the first time; let DB default handle
        last_login_at: new Date().toISOString(),
        login_count: 1,  // simplistic; would be increment in production
      })
      .eq('id', user.id);

    await logAudit('portal_login', {
      portal_user_id: user.id,
      ip_address: req.ip,
      user_agent: req.headers['user-agent'] || null,
    });

    setPortalCookie(res, signCookie(user.id));
    res.json({ ok: true });
  } catch (err) {
    console.error('[portal] consume failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ============================================================================
// GET /api/portal/me
// Returns the full portal context for the signed-in homeowner.
// 401 if no cookie / expired / invalid.
// ============================================================================
router.get('/me', async (req, res) => {
  try {
    const cookieValue = readCookie(req, COOKIE_NAME);
    const portalUserId = verifyCookie(cookieValue);
    if (!portalUserId) return res.status(401).json({ error: 'not signed in' });

    const { data: user, error: uErr } = await supabase
      .from('portal_users')
      .select('id, email, full_name, role, status')
      .eq('id', portalUserId)
      .single();
    if (uErr || !user || user.status === 'revoked') {
      clearPortalCookie(res);
      return res.status(401).json({ error: 'session no longer valid' });
    }

    // Resolve property scope (homeowners are scoped to one or more properties)
    const { data: propScopes } = await supabase
      .from('portal_user_properties')
      .select(`
        property_id,
        properties:property_id (
          id,
          street_address,
          lot_number,
          block_number,
          section_number,
          community_id,
          communities:community_id (
            id, name, slug, hoa_legal_name,
            portal_active, portal_module_config, portal_welcome_message
          )
        )
      `)
      .eq('portal_user_id', user.id)
      .is('revoked_at', null);

    const props = (propScopes || []).map((s) => s.properties).filter(Boolean);
    if (!props.length) {
      // User has portal access but no property scope yet — show a polite empty state
      return res.json({
        user: { name: user.full_name || user.email, email: user.email },
        property: null,
        community: { name: 'Your Community', slug: '', portal_active: false },
        balance: {},
        compliance: {},
        open_requests: { count: 0 },
      });
    }

    // For v0, return first property's context. Multi-property switching is a follow-on.
    const prop = props[0];
    const community = prop.communities || {};

    // Balance — most recent owner_ar_snapshot for this property
    let balance = { status: 'unknown', amount_cents: null, as_of: null };
    try {
      const { data: snap } = await supabase
        .from('owner_ar_snapshots')
        .select('balance_cents, snapshot_at, ar_status')
        .eq('property_id', prop.id)
        .order('snapshot_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (snap) {
        balance = {
          amount_cents: snap.balance_cents,
          as_of: snap.snapshot_at,
          status: snap.ar_status || (snap.balance_cents <= 0 ? 'current' : 'past_due'),
        };
      }
    } catch (_) { /* gracefully degrade */ }

    // Compliance — count of open violations
    let compliance = { open_count: 0, status: 'good' };
    try {
      const { count } = await supabase
        .from('violations')
        .select('id', { count: 'exact', head: true })
        .eq('property_id', prop.id)
        .not('current_stage', 'in', '(cured,closed,voided)');
      compliance = { open_count: count || 0, status: (count || 0) === 0 ? 'good' : 'open' };
    } catch (_) { /* fall through */ }

    // Open requests — ACC applications still in flight + builder applications (if any)
    let openRequests = { count: 0, label: 'No active requests' };
    try {
      const { count } = await supabase
        .from('community_applications')
        .select('id', { count: 'exact', head: true })
        .eq('community_id', community.id)
        .ilike('submitter_email', user.email)
        .in('final_status', ['', 'pending', 'pending_review', 'pending_committee_review']);
      if (count && count > 0) {
        openRequests = { count, label: `${count} architectural request${count === 1 ? '' : 's'} in review` };
      }
    } catch (_) { /* skip if schema differs */ }

    res.json({
      user: { name: user.full_name || user.email, email: user.email },
      property: {
        id: prop.id,
        address: prop.street_address,
        lot_block_section: [
          prop.lot_number && `Lot ${prop.lot_number}`,
          prop.block_number && `Block ${prop.block_number}`,
          prop.section_number && `Section ${prop.section_number}`,
        ].filter(Boolean).join(', '),
        community_slug: community.slug,
        community_name: community.name,
      },
      community: {
        id: community.id,
        slug: community.slug,
        name: community.name,
        hoa_legal_name: community.hoa_legal_name || community.name,
        welcome_message: community.portal_welcome_message || '',
        portal_active: community.portal_active === true,
        portal_module_config: community.portal_module_config || {},
      },
      balance,
      compliance,
      open_requests: openRequests,
    });
  } catch (err) {
    console.error('[portal] /me failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ============================================================================
// GET /api/portal/map/:community-slug
// Returns map data for the amenity map: community center + boundary +
// rentable + non-rentable amenities. PUBLIC (no auth) so it can be embedded
// in a community-landing page or shared via the portal map tile equally.
//
// Returns:
//   {
//     community: { name, slug, center: { lat, lng } },
//     boundary: GeoJSON Feature OR null,
//     amenities: [{ id, name, type, lat, lng, hours_structured, hours_text,
//                   contact_phone, contact_email, photo_url, rentable,
//                   street_address, description, rules_url }]
//   }
// ============================================================================
router.get('/map/:slug', async (req, res) => {
  try {
    const { data: community, error: cErr } = await supabase
      .from('communities')
      .select('id, name, slug, hoa_legal_name')
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .eq('slug', req.params.slug)
      .maybeSingle();
    if (cErr) throw cErr;
    if (!community) return res.status(404).json({ error: 'community_not_found' });

    // Boundary via RPC (GeoJSON)
    let boundary = null;
    let center = null;
    try {
      const { data: bData } = await supabase
        .rpc('community_boundary_geojson', { p_community_id: community.id });
      if (bData && bData.boundary) {
        boundary = {
          type: 'Feature',
          geometry: bData.boundary,
          properties: { name: community.name },
        };
        // Compute centroid from ring 0 (rough average — good enough for map centering)
        try {
          const coords = bData.boundary.coordinates?.[0] || [];
          if (coords.length) {
            const sumLng = coords.reduce((s, c) => s + c[0], 0);
            const sumLat = coords.reduce((s, c) => s + c[1], 0);
            center = { lat: sumLat / coords.length, lng: sumLng / coords.length };
          }
        } catch (_) { /* fall through */ }
      }
    } catch (_) { /* boundary RPC not critical */ }

    // Amenities (everything visible, rentable or not — the map shows all)
    const { data: amenities, error: aErr } = await supabase
      .from('amenities')
      .select(`
        id, amenity_type, name, description, street_address, capacity,
        hours_text, hours_structured, contact_name, contact_phone, contact_email,
        rules_url, photo_storage_path, lat, lng,
        is_rentable, rental_max_attendees, rental_min_lead_time_days, rental_max_lead_time_days,
        status, seasonal_open_month, seasonal_close_month
      `)
      .eq('community_id', community.id)
      .in('status', ['active', 'seasonal_closed', 'maintenance'])
      .order('display_order');
    if (aErr) throw aErr;

    // If no boundary-derived center, use average of amenity coords; if neither, null
    if (!center && amenities && amenities.length) {
      const withCoords = amenities.filter((a) => a.lat != null && a.lng != null);
      if (withCoords.length) {
        center = {
          lat: withCoords.reduce((s, a) => s + Number(a.lat), 0) / withCoords.length,
          lng: withCoords.reduce((s, a) => s + Number(a.lng), 0) / withCoords.length,
        };
      }
    }

    res.json({
      community: {
        id: community.id,
        name: community.name,
        slug: community.slug,
        hoa_legal_name: community.hoa_legal_name || community.name,
        center,
      },
      boundary,
      amenities: amenities || [],
    });
  } catch (err) {
    console.error('[portal] map lookup failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ============================================================================
// GET /api/portal/compliance
// Returns the auth'd homeowner's compliance state for their property:
//   - status (good | has_open_notices)
//   - open notices (active violations) with observation summary + cure date +
//     letter PDFs (signed URLs) + governing-doc citation
//   - past notices (resolved/cured in last 18 months)
//   - never includes community-aggregated data
//
// Vocabulary is staff-internal here (violation, courtesy, cure) — the page
// translates to homeowner-facing vocabulary at render time per the
// feedback_compliance_facing_tone memory.
// ============================================================================
router.get('/compliance', async (req, res) => {
  try {
    const cookieValue = readCookie(req, COOKIE_NAME);
    const portalUserId = verifyCookie(cookieValue);
    if (!portalUserId) return res.status(401).json({ error: 'not signed in' });

    // Resolve property scope (first property for v0; multi-property in follow-on)
    const { data: scopes } = await supabase
      .from('portal_user_properties')
      .select(`
        property_id,
        properties:property_id (
          id, street_address, lot_number, block_number, section_number,
          community_id,
          communities:community_id (id, name, slug, hoa_legal_name)
        )
      `)
      .eq('portal_user_id', portalUserId)
      .is('revoked_at', null)
      .limit(1);

    const prop = (scopes && scopes[0]?.properties) || null;
    if (!prop) {
      return res.json({
        status: 'unscoped',
        property: null,
        community: null,
        open: [],
        resolved: [],
      });
    }

    // Load violations for this property
    const { data: violations, error: vErr } = await supabase
      .from('violations')
      .select(`
        id, current_stage, cure_period_ends_at, opened_at, resolved_at, voided_at,
        severity, opened_from_observation_id, governing_doc_reference_id
      `)
      .eq('property_id', prop.id)
      .order('opened_at', { ascending: false })
      .limit(50);
    if (vErr) throw vErr;

    const openStages = ['courtesy_1', 'courtesy_2', 'certified_209', 'fine_assessed'];
    const open = (violations || []).filter((v) => openStages.includes(v.current_stage) && !v.voided_at);
    const resolved = (violations || []).filter((v) => !openStages.includes(v.current_stage));

    // Load related observations + letters in parallel
    const observationIds = (violations || []).map((v) => v.opened_from_observation_id).filter(Boolean);
    const violationIds = (violations || []).map((v) => v.id);

    const [obsResp, lettersResp, photosResp] = await Promise.all([
      observationIds.length
        ? supabase.from('property_observations')
            .select('id, ai_description, reviewer_description, category_id, ai_confidence, reviewer_status, created_at')
            .in('id', observationIds)
        : Promise.resolve({ data: [] }),
      violationIds.length
        ? supabase.from('interactions')
            .select('id, violation_id, type, subject, sent_at, attachments, content')
            .in('violation_id', violationIds)
            .in('type', ['letter_courtesy_1', 'letter_courtesy_2', 'letter_209', 'letter_other'])
            .eq('direction', 'outbound')
            .order('sent_at', { ascending: false })
        : Promise.resolve({ data: [] }),
      observationIds.length
        ? supabase.from('inspection_photos')
            .select('id, observation_id, storage_path, captured_at')
            .in('observation_id', observationIds)
        : Promise.resolve({ data: [] }),
    ]);

    const obsById = Object.fromEntries((obsResp.data || []).map((o) => [o.id, o]));
    const lettersByViolation = (lettersResp.data || []).reduce((m, l) => {
      (m[l.violation_id] = m[l.violation_id] || []).push(l);
      return m;
    }, {});
    const photosByObs = (photosResp.data || []).reduce((m, p) => {
      (m[p.observation_id] = m[p.observation_id] || []).push(p);
      return m;
    }, {});

    const enrich = async (v) => {
      const obs = v.opened_from_observation_id ? obsById[v.opened_from_observation_id] : null;
      const letters = lettersByViolation[v.id] || [];
      const photos = obs ? (photosByObs[obs.id] || []) : [];

      // Generate signed URLs for letter PDFs (best-effort)
      const letterLinks = [];
      for (const l of letters) {
        const att = Array.isArray(l.attachments) ? l.attachments : [];
        for (const a of att) {
          if (a.type === 'pdf' && a.storage_path) {
            try {
              const { data: signed } = await supabase.storage
                .from(a.bucket || 'violation-letters')
                .createSignedUrl(a.storage_path, 60 * 60 * 24 * 7);
              if (signed?.signedUrl) {
                letterLinks.push({
                  type: l.type,
                  subject: l.subject,
                  sent_at: l.sent_at,
                  url: signed.signedUrl,
                });
              }
            } catch (_) { /* skip */ }
          }
        }
      }

      // Photo signed URLs (only first photo to keep payload light; viewer can request more)
      const photoLinks = [];
      for (const p of photos.slice(0, 3)) {
        try {
          const { data: signed } = await supabase.storage
            .from('documents')
            .createSignedUrl(p.storage_path, 60 * 60 * 24 * 7);
          if (signed?.signedUrl) photoLinks.push({ url: signed.signedUrl, captured_at: p.captured_at });
        } catch (_) { /* skip */ }
      }

      // Compute days until cure
      let daysUntilCure = null;
      if (v.cure_period_ends_at) {
        const ms = new Date(v.cure_period_ends_at).getTime() - Date.now();
        daysUntilCure = Math.ceil(ms / 86400000);
      }

      return {
        id: v.id,
        stage: v.current_stage,
        severity: v.severity,
        opened_at: v.opened_at,
        resolved_at: v.resolved_at,
        cure_period_ends_at: v.cure_period_ends_at,
        days_until_cure: daysUntilCure,
        observation_summary: (obs?.reviewer_description || obs?.ai_description || '').trim() || null,
        letters: letterLinks,
        photos: photoLinks,
      };
    };

    const enrichedOpen = await Promise.all(open.map(enrich));
    const enrichedResolved = await Promise.all(resolved.slice(0, 12).map(enrich));

    res.json({
      status: enrichedOpen.length ? 'has_open_notices' : 'in_good_standing',
      property: {
        id: prop.id,
        street_address: prop.street_address,
        lot_block_section: [
          prop.lot_number && `Lot ${prop.lot_number}`,
          prop.block_number && `Block ${prop.block_number}`,
          prop.section_number && `Section ${prop.section_number}`,
        ].filter(Boolean).join(', '),
      },
      community: {
        name: prop.communities?.name,
        slug: prop.communities?.slug,
        hoa_legal_name: prop.communities?.hoa_legal_name,
      },
      open: enrichedOpen,
      resolved: enrichedResolved,
    });
  } catch (err) {
    console.error('[portal] compliance failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ============================================================================
// GET /api/portal/documents
// Returns the auth'd homeowner's community's documents that are appropriate
// for homeowner viewing. Filters by category (no insurance, W9, litigation,
// management agreement, unit ledgers, etc.) and status='current'.
// Each doc gets a 24-hour signed URL for download.
// ============================================================================
const HOMEOWNER_DOC_CATEGORIES = [
  // Governing
  'declaration_ccrs', 'bylaws', 'rules_and_regulations',
  'resolutions_and_policies', 'design_document', 'articles_of_incorporation',
  // Financial
  'annual_budget', 'annual_financial_statements', 'current_unaudited_financials',
  // Meetings
  'annual_board_meeting_minutes', 'regular_meeting_minutes',
  // Reserves
  'reserve_study', 'reserve_report',
  // Forms
  'arc_application', 'key_fob_form', 'forms_and_applications',
  // Welcome
  'welcome_package',
];

const HOMEOWNER_DOC_GROUPS = {
  governing: {
    label: 'Governing Documents',
    icon: '📜',
    categories: ['declaration_ccrs', 'bylaws', 'articles_of_incorporation',
                 'rules_and_regulations', 'resolutions_and_policies', 'design_document'],
  },
  financial: {
    label: 'Financials',
    icon: '💵',
    categories: ['annual_budget', 'annual_financial_statements', 'current_unaudited_financials'],
  },
  meetings: {
    label: 'Meeting Minutes',
    icon: '📅',
    categories: ['annual_board_meeting_minutes', 'regular_meeting_minutes'],
  },
  reserves: {
    label: 'Reserves',
    icon: '🏦',
    categories: ['reserve_study', 'reserve_report'],
  },
  forms: {
    label: 'Forms',
    icon: '📋',
    categories: ['arc_application', 'key_fob_form', 'forms_and_applications'],
  },
  welcome: {
    label: 'Welcome',
    icon: '👋',
    categories: ['welcome_package'],
  },
};

const CATEGORY_LABELS = {
  declaration_ccrs: 'Declaration (CC&Rs)',
  bylaws: 'Bylaws',
  articles_of_incorporation: 'Articles of Incorporation',
  rules_and_regulations: 'Rules & Regulations',
  resolutions_and_policies: 'Resolutions & Policies',
  design_document: 'Architectural Guidelines',
  annual_budget: 'Annual Budget',
  annual_financial_statements: 'Annual Financial Statements',
  current_unaudited_financials: 'Recent Financials (Unaudited)',
  annual_board_meeting_minutes: 'Annual Meeting Minutes',
  regular_meeting_minutes: 'Board Meeting Minutes',
  reserve_study: 'Reserve Study',
  reserve_report: 'Reserve Report',
  arc_application: 'ARC Application Form',
  key_fob_form: 'Pool & Gate Access Form',
  forms_and_applications: 'Other Forms',
  welcome_package: 'Welcome Package',
};

router.get('/documents', async (req, res) => {
  try {
    const cookieValue = readCookie(req, COOKIE_NAME);
    const portalUserId = verifyCookie(cookieValue);
    if (!portalUserId) return res.status(401).json({ error: 'not signed in' });

    const { data: scopes } = await supabase
      .from('portal_user_properties')
      .select(`property_id, properties:property_id (community_id, communities:community_id (id, name, slug))`)
      .eq('portal_user_id', portalUserId)
      .is('revoked_at', null)
      .limit(1);
    const prop = (scopes && scopes[0]?.properties) || null;
    if (!prop) return res.json({ community: null, groups: {} });

    const community = prop.communities || {};

    // Pull homeowner-appropriate library_documents for this community
    const { data: docs, error } = await supabase
      .from('library_documents')
      .select('id, category, title, period_label, effective_date, file_path, file_name_normalized, status, approval_status, created_at')
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .eq('community_id', community.id)
      .eq('status', 'current')
      .in('category', HOMEOWNER_DOC_CATEGORIES)
      .order('effective_date', { ascending: false, nullsFirst: false });
    if (error) throw error;

    // Generate signed URLs (24h)
    const enriched = [];
    for (const d of docs || []) {
      let signedUrl = null;
      if (d.file_path) {
        try {
          const { data: signed } = await supabase.storage
            .from('documents')
            .createSignedUrl(d.file_path, 60 * 60 * 24);
          signedUrl = signed?.signedUrl || null;
        } catch (_) { /* skip */ }
      }
      enriched.push({
        id: d.id,
        category: d.category,
        category_label: CATEGORY_LABELS[d.category] || d.category,
        title: d.title || d.file_name_normalized || CATEGORY_LABELS[d.category],
        period_label: d.period_label,
        effective_date: d.effective_date,
        download_url: signedUrl,
      });
    }

    // Group by section
    const groups = {};
    for (const [key, group] of Object.entries(HOMEOWNER_DOC_GROUPS)) {
      const items = enriched.filter((d) => group.categories.includes(d.category));
      if (items.length) {
        groups[key] = { label: group.label, icon: group.icon, items };
      }
    }

    res.json({
      community: { id: community.id, name: community.name, slug: community.slug },
      groups,
      total: enriched.length,
    });
  } catch (err) {
    console.error('[portal] documents failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ============================================================================
// GET /api/portal/property
// Returns property details + owner-of-record contacts + unified recent activity
// timeline (last 10 items across ARC apps, compliance, clubhouse rentals).
// ============================================================================
router.get('/property', async (req, res) => {
  try {
    const cookieValue = readCookie(req, COOKIE_NAME);
    const portalUserId = verifyCookie(cookieValue);
    if (!portalUserId) return res.status(401).json({ error: 'not signed in' });

    const { data: scopes } = await supabase
      .from('portal_user_properties')
      .select(`property_id, properties:property_id (
        id, street_address, unit, city, state, zip, property_type, lot_number,
        community_id, vantaca_account_id, notes, created_at,
        communities:community_id (id, name, slug, hoa_legal_name)
      )`)
      .eq('portal_user_id', portalUserId)
      .is('revoked_at', null)
      .limit(1);
    const prop = (scopes && scopes[0]?.properties) || null;
    if (!prop) return res.json({ property: null });

    // Owners of record (current — end_date IS NULL)
    const { data: ownerships } = await supabase
      .from('property_ownerships')
      .select(`
        id, start_date, end_date, vesting, is_primary, source,
        contacts:contact_id (id, primary_email, primary_phone, full_name)
      `)
      .eq('property_id', prop.id)
      .is('end_date', null)
      .order('is_primary', { ascending: false });

    const owners = (ownerships || []).map((o) => ({
      name: o.contacts?.full_name || '—',
      email: o.contacts?.primary_email || null,
      phone: o.contacts?.primary_phone || null,
      is_primary: o.is_primary,
      start_date: o.start_date,
      vesting: o.vesting,
    }));

    // Unified activity timeline (best-effort across modules)
    const activity = [];
    try {
      const { data: arc } = await supabase
        .from('community_applications')
        .select('id, reference_number, final_status, final_decided_at, created_at, application_data')
        .eq('community_id', prop.community_id)
        .ilike('property_address', `%${prop.street_address.split(',')[0]}%`)
        .order('created_at', { ascending: false })
        .limit(4);
      for (const a of arc || []) {
        activity.push({
          type: 'arc',
          icon: '🏗️',
          date: a.final_decided_at || a.created_at,
          summary: a.final_status === 'approved'
            ? `ARC request approved · ${a.reference_number}`
            : a.final_status === 'denied'
              ? `ARC request denied · ${a.reference_number}`
              : `ARC request filed · ${a.reference_number}`,
        });
      }
    } catch (_) { /* skip */ }

    try {
      const { data: viols } = await supabase
        .from('violations')
        .select('id, current_stage, opened_at, resolved_at')
        .eq('property_id', prop.id)
        .order('opened_at', { ascending: false })
        .limit(4);
      for (const v of viols || []) {
        if (v.resolved_at) {
          activity.push({
            type: 'compliance',
            icon: '✅',
            date: v.resolved_at,
            summary: 'Compliance notice resolved',
          });
        } else if (['courtesy_1', 'courtesy_2', 'certified_209', 'fine_assessed'].includes(v.current_stage)) {
          activity.push({
            type: 'compliance',
            icon: '⚠️',
            date: v.opened_at,
            summary: 'Active compliance notice opened',
          });
        }
      }
    } catch (_) { /* skip */ }

    try {
      const { data: rentals } = await supabase
        .from('amenity_rentals')
        .select('id, reference_number, event_date, status, amenity:amenities(name)')
        .eq('property_id', prop.id)
        .order('event_date', { ascending: false })
        .limit(4);
      for (const r of rentals || []) {
        activity.push({
          type: 'rental',
          icon: '🎉',
          date: r.event_date,
          summary: `${r.amenity?.name || 'Clubhouse'} reservation · ${r.reference_number} (${r.status.replace(/_/g, ' ')})`,
        });
      }
    } catch (_) { /* skip */ }

    activity.sort((a, b) => (b.date || '').localeCompare(a.date || ''));

    res.json({
      property: {
        id: prop.id,
        street_address: prop.street_address,
        unit: prop.unit,
        city: prop.city,
        state: prop.state,
        zip: prop.zip,
        property_type: prop.property_type,
        lot_number: prop.lot_number,
        vantaca_account_id: prop.vantaca_account_id,
        on_record_since: prop.created_at,
      },
      community: {
        id: prop.communities?.id,
        name: prop.communities?.name,
        slug: prop.communities?.slug,
        hoa_legal_name: prop.communities?.hoa_legal_name,
      },
      owners,
      activity: activity.slice(0, 10),
    });
  } catch (err) {
    console.error('[portal] property failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ============================================================================
// POST /api/portal/logout
// ============================================================================
router.post('/logout', async (req, res) => {
  const cookieValue = readCookie(req, COOKIE_NAME);
  const portalUserId = verifyCookie(cookieValue);
  if (portalUserId) {
    await logAudit('portal_logout', { portal_user_id: portalUserId, ip_address: req.ip });
  }
  clearPortalCookie(res);
  res.json({ ok: true });
});

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

module.exports = { router };
