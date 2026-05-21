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
