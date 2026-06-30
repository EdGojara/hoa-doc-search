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
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');
const { safeErrorMessage } = require('./_safe_error');
const { sendEmail } = require('../lib/notifications/email');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const BEDROCK_MGMT_CO_ID = '00000000-0000-0000-0000-000000000001';

const COOKIE_NAME = 'TRUSTED_PORTAL';
const COOKIE_TTL_DAYS = 30;
// Ed 2026-06-11: bumped from 1 → 2 hours. Real-world feedback (Karla Rutan,
// DRB Group): a 1-hour link can already expire by the time the email
// reaches a busy builder's inbox + they get back to their desk. 2 hours
// covers the typical "I'll get to it after my next call" window without
// extending the attack surface meaningfully.
const MAGIC_LINK_TTL_HOURS = 2;

// Mimic session — staff renders the portal as a specific portal_user with
// audit logging. Separate cookie so a staff member's own portal session (if
// any) survives the mimic. 30-min TTL so abandoned sessions auto-expire.
const MIMIC_COOKIE_NAME = 'TRUSTED_PORTAL_MIMIC';
const MIMIC_COOKIE_TTL_MIN = 30;

const router = express.Router();

// SINGLE SOURCE OF TRUTH for "which submission page does each builder land on."
// Keyed on builder_companies.company_name; value MUST be a real route in
// server.js. Used by /api/portal/me (real builder sessions) AND the builder
// dashboard's "New submission" link via my-submissions (incl. manager preview,
// which is what was sending Lennar previews to the DRB page — 2026-06-29).
// Add a line when onboarding a new builder/community pair.
const BUILDER_LANDING_URLS = {
  'DRB Group': '/builders/august-meadows-drb',
  'Lennar':    '/builders/still-creek-lennar',
};
// First matching company wins; fall back to the dashboard so a builder is never
// dead-ended.
function resolveBuilderLandingUrl(companyNames) {
  for (const name of (companyNames || [])) {
    if (BUILDER_LANDING_URLS[name]) return BUILDER_LANDING_URLS[name];
  }
  return '/builder-dashboard.html';
}

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

// Mimic cookie helpers. Format: <portal_user_id>.<staff_email_b64>.<ts>.<hmac>
// Same secret as portal cookie. 30-min TTL.
function signMimicCookie(portalUserId, staffEmail) {
  const ts = Date.now().toString();
  const emailB64 = Buffer.from(String(staffEmail), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', portalSecret())
    .update(`${portalUserId}.${emailB64}.${ts}.mimic`)
    .digest('hex');
  return `${portalUserId}.${emailB64}.${ts}.${sig}`;
}

function verifyMimicCookie(token) {
  if (!token) return null;
  const parts = String(token).split('.');
  if (parts.length !== 4) return null;
  const [portalUserId, emailB64, ts, sig] = parts;
  if (!ts || !/^\d+$/.test(ts)) return null;
  const age = Date.now() - Number(ts);
  if (age > MIMIC_COOKIE_TTL_MIN * 60 * 1000) return null;
  const expected = crypto.createHmac('sha256', portalSecret())
    .update(`${portalUserId}.${emailB64}.${ts}.mimic`)
    .digest('hex');
  try {
    if (sig.length !== expected.length) return null;
    if (!crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'))) return null;
  } catch (_) { return null; }
  let staffEmail = '';
  try { staffEmail = Buffer.from(emailB64, 'base64url').toString('utf8'); } catch (_) { return null; }
  return {
    portal_user_id: portalUserId,
    staff_email: staffEmail,
    started_at: new Date(Number(ts)).toISOString(),
    expires_at: new Date(Number(ts) + MIMIC_COOKIE_TTL_MIN * 60 * 1000).toISOString(),
  };
}

function setMimicCookie(res, value) {
  const maxAge = MIMIC_COOKIE_TTL_MIN * 60;
  res.setHeader('Set-Cookie',
    `${MIMIC_COOKIE_NAME}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}; Secure`);
}

function clearMimicCookie(res) {
  res.setHeader('Set-Cookie',
    `${MIMIC_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

// Resolve effective portal user. Mimic cookie takes precedence when present
// (and valid) so staff sees the portal AS the target homeowner.
function resolvePortalUser(req) {
  const mimicCookieValue = readCookie(req, MIMIC_COOKIE_NAME);
  const mimic = mimicCookieValue ? verifyMimicCookie(mimicCookieValue) : null;
  if (mimic) return { portalUserId: mimic.portal_user_id, mimic };
  const cookieValue = readCookie(req, COOKIE_NAME);
  const portalUserId = verifyCookie(cookieValue);
  return { portalUserId, mimic: null };
}

// ============================================================================
// RENTER PORTAL ENFORCEMENT (Ed 2026-06-08, migration 186)
// ----------------------------------------------------------------------------
// Capability matrix lives in the migration comment. Two helpers here:
//
//   resolveUserWithRole(req)
//       Same as resolvePortalUser but ALSO fetches the user's role + status.
//       Returns null and sends 401 if not signed in OR session invalid.
//       Use at the top of any endpoint that needs role-aware behavior.
//
//   assertOwnerLikeRole(req, res)
//       Hard gate. Returns the user if their role is in ('homeowner',
//       'board_member', 'staff', 'admin') — i.e., anyone who can see
//       owner-class data (AR, violations, ACC, financials, meetings).
//       Sends 403 and returns null for 'renter', 'builder', 'franchisee'.
//
// Pattern at sensitive endpoints:
//   const user = await assertOwnerLikeRole(req, res);
//   if (!user) return;
// ============================================================================
const OWNER_LIKE_ROLES = new Set(['homeowner', 'board_member', 'staff', 'admin', 'manager']);

async function resolveUserWithRole(req, res) {
  const { portalUserId, mimic } = resolvePortalUser(req);
  if (!portalUserId) {
    if (res) res.status(401).json({ error: 'not_signed_in' });
    return null;
  }
  try {
    const { data: user } = await supabase
      .from('portal_users')
      .select('id, email, role, status, full_name')
      .eq('id', portalUserId)
      .single();
    if (!user || user.status === 'revoked') {
      if (res) {
        clearPortalCookie(res);
        res.status(401).json({ error: 'session_invalid' });
      }
      return null;
    }
    return { user, mimic };
  } catch (e) {
    if (res) res.status(500).json({ error: 'session_lookup_failed' });
    return null;
  }
}

async function assertOwnerLikeRole(req, res) {
  const resolved = await resolveUserWithRole(req, res);
  if (!resolved) return null;
  if (!OWNER_LIKE_ROLES.has(resolved.user.role)) {
    res.status(403).json({
      error: 'role_not_authorized',
      role: resolved.user.role,
      message: 'Renters cannot access this resource. If you are the owner and this is an error, contact Bedrock.',
    });
    return null;
  }
  return resolved;
}

// ----------------------------------------------------------------------------
// resolveScopedProperty(req, supabase, user)
// ----------------------------------------------------------------------------
// Single helper that resolves "which property are we serving data for?"
// across the OWNER path (portal_user_properties) and the MANAGER path
// (portal_manager_scope + ?property_id query param).
//
// Returns:
//   { property: { id, street_address, vantaca_account_id, community_id,
//                 communities: { id, name, slug, hoa_legal_name } } | null,
//     allProperties: array,   // empty for managers (no fixed scope list)
//     isManager: boolean }
//
// Per-endpoint code reads property.id / vantaca_account_id / community_id
// from this without caring whether the user is an owner or a manager.
// ----------------------------------------------------------------------------
async function resolveScopedProperty(req, supabase, user) {
  const isManager = user.role === 'manager';
  const requestedPropertyId = String(req.query?.property_id || '').trim();

  if (isManager) {
    if (!requestedPropertyId) {
      return { property: null, allProperties: [], isManager: true };
    }
    // Verify the property is in the manager's scope
    const { data: pickedProp } = await supabase
      .from('properties')
      .select(`
        id, street_address, lot_number, vantaca_account_id, community_id,
        communities:community_id (id, name, slug, hoa_legal_name)
      `)
      .eq('id', requestedPropertyId)
      .maybeSingle();
    if (!pickedProp) return { property: null, allProperties: [], isManager: true };

    const { data: scopeRows } = await supabase
      .from('portal_manager_scope')
      .select('community_id')
      .eq('portal_user_id', user.id)
      .is('revoked_at', null);
    const portfolioWide = (scopeRows || []).some(s => s.community_id === null);
    if (!portfolioWide) {
      const allowed = new Set((scopeRows || []).map(s => s.community_id).filter(Boolean));
      if (!allowed.has(pickedProp.community_id)) {
        return { property: null, allProperties: [], isManager: true, error: 'property_outside_manager_scope' };
      }
    }
    return { property: pickedProp, allProperties: [], isManager: true };
  }

  // OWNER path — pull from portal_user_properties
  const { data: scopes } = await supabase
    .from('portal_user_properties')
    .select(`
      property_id,
      properties:property_id (
        id, street_address, lot_number, vantaca_account_id, community_id,
        communities:community_id (id, name, slug, hoa_legal_name)
      )
    `)
    .eq('portal_user_id', user.id)
    .is('revoked_at', null);
  const props = (scopes || []).map(s => s.properties).filter(Boolean);
  if (!props.length) return { property: null, allProperties: [], isManager: false };

  const focus = (requestedPropertyId && props.find(p => String(p.id) === requestedPropertyId)) || props[0];
  return { property: focus, allProperties: props, isManager: false };
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

// ----------------------------------------------------------------------------
// In-memory rate limiter for /request-link
// ----------------------------------------------------------------------------
// Why in-memory not Redis: at current scale (~few hundred homeowners across
// 7 communities), magic-link request volume is tiny. An in-memory Map with
// periodic prune handles 100K req/hr trivially while adding zero new deps.
// When/if trustEd scales to franchise / multi-instance, this would be the
// time to swap in Redis — the abstraction below makes that a one-function
// change.
//
// Throttle is keyed by email (the abuse vector — attacker spams a target
// email to either DoS them with link emails or fish the response timing).
// Also tracks per-IP as a secondary signal so an attacker can't trivially
// rotate emails from one host.
//
// Limits (configurable via env):
//   RATELIMIT_PORTAL_PER_EMAIL_HOUR  default 5
//   RATELIMIT_PORTAL_PER_IP_HOUR     default 20
// Both windows are rolling 60-minute.
// ----------------------------------------------------------------------------
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const RATE_LIMIT_PER_EMAIL = Number(process.env.RATELIMIT_PORTAL_PER_EMAIL_HOUR || 5);
const RATE_LIMIT_PER_IP = Number(process.env.RATELIMIT_PORTAL_PER_IP_HOUR || 20);
const _rateLimitHits = new Map(); // key -> [ts1, ts2, ...]
let _rateLimitLastPrune = Date.now();

/** Check whether `key` has exceeded `limit` hits within the rolling window.
 *  Returns { allowed: bool, retryAfterSeconds: number }. Increments the
 *  count if allowed (side-effecting on purpose — simpler call sites). */
function _consumeRateLimit(key, limit) {
  const now = Date.now();
  // Periodic prune to prevent unbounded growth (run at most once / 5 min)
  if (now - _rateLimitLastPrune > 5 * 60 * 1000) {
    for (const [k, hits] of _rateLimitHits.entries()) {
      const recent = hits.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
      if (recent.length === 0) _rateLimitHits.delete(k);
      else _rateLimitHits.set(k, recent);
    }
    _rateLimitLastPrune = now;
  }
  const existing = (_rateLimitHits.get(key) || []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  if (existing.length >= limit) {
    const oldestMs = Math.min(...existing);
    const retryAfterSeconds = Math.ceil((RATE_LIMIT_WINDOW_MS - (now - oldestMs)) / 1000);
    return { allowed: false, retryAfterSeconds: Math.max(retryAfterSeconds, 1) };
  }
  existing.push(now);
  _rateLimitHits.set(key, existing);
  return { allowed: true, retryAfterSeconds: 0 };
}

// ============================================================================
// POST /api/portal/demo-sign-in
// Body: { persona: 'bob' | 'sunny' | 'byron' | ... }
//
// Issues a portal session cookie for a Drama Creek Estates demo persona
// WITHOUT the magic-link email round trip. Used by /try-the-demo so
// prospects (and Ed) can click "Try as homeowner" and land in the portal
// immediately, no email delivery needed.
//
// HARD SAFETY: this endpoint refuses to issue a session for any portal
// user whose scope reaches a non-demo community. The is_demo flag on the
// community is the only ticket through. A misconfiguration that attached
// a Waterview property to a "demo" persona would NOT silently expose
// Waterview — the endpoint returns 403 instead.
//
// Rate-limit posture: leaving the endpoint open at the API layer because
// (a) it cannot escalate to a real community, (b) demo logins are a
// feature signal we want to measure. If abuse shows up in logs, add a
// per-IP token bucket here.
// ============================================================================
router.post('/demo-sign-in', express.json({ limit: '1kb' }), async (req, res) => {
  try {
    const personaRaw = String(req.body?.persona || '').toLowerCase().trim();
    // Persona keys are lowercase letters only, 1-30 chars (matches our seed
    // pattern). Anything else is malformed.
    if (!/^[a-z]{1,30}$/.test(personaRaw)) {
      return res.status(400).json({ error: 'persona_required' });
    }
    const email = `${personaRaw}@dramacreekhoa.demo`;

    const { data: user } = await supabase
      .from('portal_users')
      .select('id, email, role, status, full_name')
      .eq('email', email)
      .eq('management_company_id', '00000000-0000-0000-0000-000000000001')
      .maybeSingle();

    if (!user) return res.status(404).json({ error: 'unknown_persona' });
    if (user.status === 'revoked') return res.status(403).json({ error: 'persona_inactive' });

    // SAFETY: verify the user's reachable communities are ALL is_demo=TRUE.
    // Schema-cache-resilient pattern (Ed 2026-06-08): pull community IDs
    // through both scope tables WITHOUT asking PostgREST for is_demo in the
    // nested select (that's the column the cache may not know yet — same
    // issue that broke /me). Then check each ID against a hardcoded demo
    // allowlist + a fallback direct lookup.
    const [{ data: propScopes }, { data: commScopes }] = await Promise.all([
      supabase
        .from('portal_user_properties')
        .select('property:property_id (community_id)')
        .eq('portal_user_id', user.id)
        .is('revoked_at', null),
      supabase
        .from('portal_user_communities')
        .select('community_id')
        .eq('portal_user_id', user.id)
        .is('revoked_at', null),
    ]);

    const reachableCommunityIds = [
      ...(propScopes || []).map(s => s.property?.community_id),
      ...(commScopes || []).map(s => s.community_id),
    ].filter(Boolean);

    if (!reachableCommunityIds.length) {
      return res.status(403).json({ error: 'persona_no_scope' });
    }

    const KNOWN_DEMO_COMMUNITY_IDS = new Set([
      'dc100000-0000-4000-a000-000000000000', // Drama Creek Estates
    ]);
    // For each reachable community, check hardcoded allowlist first; if
    // not present, fall back to a direct is_demo lookup. If ANY community
    // resolves to non-demo (or unverifiable), refuse.
    for (const cid of reachableCommunityIds) {
      if (KNOWN_DEMO_COMMUNITY_IDS.has(String(cid))) continue;
      try {
        const { data: row } = await supabase
          .from('communities')
          .select('is_demo')
          .eq('id', cid)
          .maybeSingle();
        if (row?.is_demo === true) continue;
      } catch (e) {
        /* fall through to refusal */
      }
      console.warn(`[portal demo-sign-in] REFUSED — persona "${personaRaw}" reaches community ${cid} that is not on demo allowlist`);
      return res.status(403).json({ error: 'persona_not_demo_scoped' });
    }

    // Touch login tracking (same shape as /consume, abbreviated)
    try {
      const { data: lp } = await supabase
        .from('portal_users')
        .select('login_count, first_login_at')
        .eq('id', user.id)
        .single();
      const updatePayload = {
        status: user.status === 'invited' ? 'active' : user.status,
        last_login_at: new Date().toISOString(),
        login_count: Number(lp?.login_count || 0) + 1,
      };
      if (!lp?.first_login_at) updatePayload.first_login_at = new Date().toISOString();
      await supabase.from('portal_users').update(updatePayload).eq('id', user.id);
    } catch (_) { /* non-fatal */ }

    await logAudit('demo_sign_in', {
      portal_user_id: user.id,
      ip_address: req.ip,
      user_agent: req.headers['user-agent'] || null,
    });

    setPortalCookie(res, signCookie(user.id));

    return res.json({
      ok: true,
      persona: personaRaw,
      full_name: user.full_name,
      role: user.role,
      // Board members default to the board portal; homeowners to /portal.
      // Caller may follow this hint or override.
      redirect: user.role === 'board_member' ? '/board-portal' : '/portal',
    });
  } catch (err) {
    console.error('[portal] demo-sign-in failed:', err.message);
    return res.status(500).json({ error: safeErrorMessage(err) });
  }
});

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

    // ---- Rate limiting (per email + per IP) ----
    // Email throttle is the primary defense (abuse vector: spam a target's
    // inbox with link emails). IP throttle catches an attacker rotating
    // emails from one host. BOTH must pass.
    //
    // On throttle: still return 200 with { ok: true } shape so we don't
    // leak which limit fired, but set Retry-After header for legitimate
    // clients that respect it. Log a warn for visibility — if these fire
    // frequently for a real user, the limits are too tight.
    const ipKey = `ip:${req.ip || 'unknown'}`;
    const emailKey = `email:${email}`;
    const ipCheck = _consumeRateLimit(ipKey, RATE_LIMIT_PER_IP);
    const emailCheck = _consumeRateLimit(emailKey, RATE_LIMIT_PER_EMAIL);
    if (!ipCheck.allowed || !emailCheck.allowed) {
      const retry = Math.max(ipCheck.retryAfterSeconds, emailCheck.retryAfterSeconds);
      console.warn(`[portal] rate-limited request-link email=${email.slice(0, 3)}*** ip=${(req.ip || '').slice(0, 7)}*** retry=${retry}s`);
      res.setHeader('Retry-After', String(retry));
      // Still 200 with anti-enumeration shape — the attacker can't tell us
      // apart from a fresh request. Retry-After leaks nothing useful.
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
    if (!token) return res.status(400).json({ error: 'token is required', error_kind: 'invalid' });

    const { data: link } = await supabase
      .from('portal_magic_links')
      .select('id, portal_user_id, purpose, expires_at, used_at')
      .eq('token', token)
      .maybeSingle();

    // Ed 2026-06-11: structured error_kind so the frontend can show clear
    // "your link expired, here's how to get a new one" copy rather than a
    // generic error string. user_email_hint surfaces a masked email only
    // when the token was real (we already confirmed it via .eq) — letting
    // the frontend pre-fill the renewal form so the user doesn't have to
    // remember which email they registered with.
    if (!link) return res.status(400).json({ error: 'sign-in link is invalid', error_kind: 'invalid' });

    let userEmailHint = null;
    if (link.portal_user_id) {
      const { data: u } = await supabase.from('portal_users')
        .select('email').eq('id', link.portal_user_id).maybeSingle();
      if (u && u.email) {
        // Masked form: "kr***@drbgroup.com" — enough to pre-fill, not enough to enumerate.
        const [lhs, rhs] = u.email.split('@');
        userEmailHint = `${lhs.slice(0, 2)}${'*'.repeat(Math.max(1, lhs.length - 2))}@${rhs}`;
      }
    }

    if (link.used_at) {
      return res.status(400).json({
        error: 'sign-in link already used',
        error_kind: 'used',
        renewable: true,
        user_email_hint: userEmailHint,
      });
    }
    if (new Date(link.expires_at) < new Date()) {
      return res.status(400).json({
        error: 'sign-in link has expired',
        error_kind: 'expired',
        renewable: true,
        user_email_hint: userEmailHint,
      });
    }

    // Confirm user still active
    const { data: user } = await supabase
      .from('portal_users')
      .select('id, status')
      .eq('id', link.portal_user_id)
      .single();
    if (!user || user.status === 'revoked') {
      return res.status(403).json({ error: 'account is not active', error_kind: 'revoked', renewable: false });
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

    // Update portal_users login tracking. login_count must actually increment
    // (was hardcoded to 1 — see fix 2026-05-25). Fetch current value then write
    // value+1 so the count reflects real usage. Race conditions on rapid
    // consecutive logins (highly unlikely with magic links) are acceptable —
    // worst case is a momentary off-by-one in an analytics number, no
    // functional impact. If we ever need atomic increment, swap to a Postgres
    // RPC that does `UPDATE ... SET login_count = login_count + 1 RETURNING *`.
    let currentCount = 0;
    let alreadyLoggedInOnce = false;
    try {
      const { data: lp } = await supabase
        .from('portal_users')
        .select('login_count, first_login_at')
        .eq('id', user.id)
        .single();
      currentCount = Number(lp?.login_count || 0);
      alreadyLoggedInOnce = !!lp?.first_login_at;
    } catch (_) { /* fall through with defaults */ }

    const updatePayload = {
      status: user.status === 'invited' ? 'active' : user.status,
      last_login_at: new Date().toISOString(),
      login_count: currentCount + 1,
    };
    // Stamp first_login_at on the FIRST login only; preserve existing value
    // thereafter so we have a stable "joined the portal" timestamp.
    if (!alreadyLoggedInOnce) {
      updatePayload.first_login_at = new Date().toISOString();
    }
    await supabase
      .from('portal_users')
      .update(updatePayload)
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
// When a staff mimic cookie is present, /me resolves the TARGET portal user
// and includes a `mimic` block so the frontend can render the warning banner.
// ============================================================================
// ============================================================================
// POST /api/portal/staff-enter
// Bridge — convert a Bedrock staff Supabase auth session into a portal
// manager session. No magic link needed; the user is already authenticated
// via Microsoft 365.
//
// Flow:
//   1. Client sends Authorization: Bearer <supabase_jwt> from their
//      already-active trustEd staff session
//   2. We validate the JWT via Supabase auth
//   3. Check user_profiles row exists and is_active
//   4. Auto-provision (or update) portal_users row with role='manager'
//      keyed on email — idempotent, same user can re-enter anytime
//   5. Auto-grant portfolio-wide scope (community_id=NULL)
//   6. Set portal cookie pointing at the manager portal_user
//   7. Return ok — client navigates to /portal
//
// Single-tenant lock: rejects any email not under bedrocktx.com.
// ============================================================================
router.post('/staff-enter', async (req, res) => {
  try {
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!token) return res.status(401).json({ error: 'missing_bearer_token' });

    // Validate the Supabase JWT
    const { data: { user }, error: userErr } = await supabase.auth.getUser(token);
    if (userErr || !user) return res.status(401).json({ error: 'invalid_supabase_session' });

    // Single-tenant: only bedrocktx.com staff (matches the Azure AD
    // single-tenant lock on the OAuth app)
    const email = String(user.email || '').toLowerCase();
    if (!email.endsWith('@bedrocktx.com')) {
      return res.status(403).json({ error: 'tenant_locked', message: 'Only @bedrocktx.com accounts can use the manager portal.' });
    }

    // Verify active user_profile (same gate as the existing staff-cookie
    // exchange — if the staff account is deactivated, this fails)
    const { data: profile } = await supabase
      .from('user_profiles')
      .select('id, email, role, is_active')
      .eq('id', user.id)
      .maybeSingle();
    if (!profile) {
      return res.status(403).json({ error: 'no_profile', message: 'No user_profiles row. The handle_new_user trigger from migration 039 may not be installed.' });
    }
    if (profile.is_active === false) {
      return res.status(403).json({ error: 'account_inactive' });
    }

    // Find or create the portal_user with role='manager' for this email
    const fullName = user.user_metadata?.full_name
      || user.user_metadata?.name
      || profile.email
      || email;

    let { data: portalUser } = await supabase
      .from('portal_users')
      .select('id, email, role, status')
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .eq('email', email)
      .maybeSingle();

    if (portalUser) {
      // Promote to manager if not already (staff can hold multiple roles
      // implicitly; we always want them as manager for this flow)
      if (portalUser.role !== 'manager' || portalUser.status !== 'active') {
        await supabase
          .from('portal_users')
          .update({ role: 'manager', status: 'active' })
          .eq('id', portalUser.id);
      }
    } else {
      const { data: created, error: createErr } = await supabase
        .from('portal_users')
        .insert({
          management_company_id: BEDROCK_MGMT_CO_ID,
          email,
          full_name: fullName,
          role: 'manager',
          status: 'active',
        })
        .select()
        .single();
      if (createErr) return res.status(500).json({ error: createErr.message });
      portalUser = created;
    }

    // Grant portfolio-wide scope. The PG primary key originally included
    // community_id which forced NOT NULL, silently breaking the NULL
    // (portfolio-wide) insert (migration 207 fixes the schema). We now do
    // an explicit check-then-insert so failures surface AND so we don't
    // re-insert on every staff-enter visit.
    const { data: existingScope, error: scopeReadErr } = await supabase
      .from('portal_manager_scope')
      .select('id')
      .eq('portal_user_id', portalUser.id)
      .is('community_id', null)
      .is('revoked_at', null)
      .maybeSingle();
    if (scopeReadErr) {
      console.warn('[portal] staff-enter scope read failed:', scopeReadErr.message);
    }
    if (!existingScope) {
      const { error: scopeInsertErr } = await supabase
        .from('portal_manager_scope')
        .insert({
          portal_user_id: portalUser.id,
          community_id: null,
          granted_by: 'staff_sso_bridge',
        });
      if (scopeInsertErr) {
        console.error('[portal] staff-enter scope insert failed:', scopeInsertErr.message);
        return res.status(500).json({
          error: 'scope_grant_failed',
          message: scopeInsertErr.message,
        });
      }
    }

    // Mirror the same portfolio-wide grant on the BUILDER side (migration
    // 227). Idempotent; staff who go through staff-enter get both scopes so
    // they can preview both the homeowner portal AND the builder portal.
    const { data: existingBuilderScope } = await supabase
      .from('portal_manager_builder_scope')
      .select('portal_user_id')
      .eq('portal_user_id', portalUser.id)
      .is('builder_company_id', null)
      .is('revoked_at', null)
      .maybeSingle();
    if (!existingBuilderScope) {
      const { error: bScopeErr } = await supabase
        .from('portal_manager_builder_scope')
        .insert({
          portal_user_id: portalUser.id,
          builder_company_id: null,
          granted_by: 'staff_sso_bridge',
        });
      if (bScopeErr) {
        // Don't fail the whole staff-enter on a missing builder-scope table
        // (migration 227 may not have run yet on this deploy). Log and move on.
        console.warn('[portal] staff-enter builder-scope insert skipped:', bScopeErr.message);
      }
    }

    // Set the portal cookie
    setPortalCookie(res, signCookie(portalUser.id));

    await logAudit('manager_session_started', {
      portal_user_id: portalUser.id,
      ip_address: req.ip,
      user_agent: req.headers['user-agent'] || null,
      notes: `Staff SSO bridge for ${email}`,
    });

    res.json({
      ok: true,
      portal_user_id: portalUser.id,
      email,
      redirect: '/portal',
    });
  } catch (err) {
    console.error('[portal] staff-enter failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ============================================================================
// GET /api/portal/manager/properties
// Browse properties available to the manager. Powers the property picker
// on the manager portal landing. Search by address, owner name, or
// vantaca_account_id. Limited to the manager's community scope.
// ============================================================================
router.get('/manager/properties', async (req, res) => {
  try {
    const { portalUserId } = resolvePortalUser(req);
    if (!portalUserId) return res.status(401).json({ error: 'not_signed_in' });

    const { data: user } = await supabase
      .from('portal_users')
      .select('id, email, role, status')
      .eq('id', portalUserId)
      .single();
    if (!user || user.status === 'revoked') return res.status(401).json({ error: 'session_invalid' });
    if (user.role !== 'manager' && user.role !== 'staff' && user.role !== 'admin') {
      return res.status(403).json({ error: 'role_not_authorized' });
    }

    // Manager scope
    const { data: scopeRows } = await supabase
      .from('portal_manager_scope')
      .select('community_id')
      .eq('portal_user_id', user.id)
      .is('revoked_at', null);
    const portfolioWide = (scopeRows || []).some(s => s.community_id === null);
    const allowedCommunityIds = portfolioWide
      ? null
      : (scopeRows || []).map(s => s.community_id).filter(Boolean);

    const q = String(req.query?.q || '').trim();
    const limit = Math.min(parseInt(req.query?.limit || '50', 10), 200);

    let propQuery = supabase
      .from('properties')
      .select(`
        id, street_address, vantaca_account_id, community_id,
        communities:community_id (id, name),
        property_ownerships!inner (
          contact_id, end_date,
          contacts:contact_id (id, full_name, primary_email)
        )
      `)
      .is('property_ownerships.end_date', null)
      .order('street_address')
      .limit(limit);

    if (!portfolioWide && allowedCommunityIds && allowedCommunityIds.length) {
      propQuery = propQuery.in('community_id', allowedCommunityIds);
    }
    if (q) {
      // Search across address + vantaca_account_id (owner name search would
      // require a separate query; address + account is enough for v1)
      propQuery = propQuery.or(`street_address.ilike.%${q}%,vantaca_account_id.ilike.%${q}%`);
    }

    const { data: rows, error } = await propQuery;
    if (error) return res.status(500).json({ error: error.message });

    const items = (rows || []).map(p => {
      const owner = p.property_ownerships?.[0]?.contacts;
      return {
        property_id: p.id,
        street_address: p.street_address,
        vantaca_account_id: p.vantaca_account_id,
        community_id: p.community_id,
        community_name: p.communities?.name || '',
        owner_name: owner?.full_name || '',
        owner_email: owner?.primary_email || '',
      };
    });

    res.json({
      properties: items,
      total: items.length,
      portfolio_wide: portfolioWide,
    });
  } catch (err) {
    console.error('[portal manager/properties] failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

router.get('/me', async (req, res) => {
  try {
    const { portalUserId, mimic } = resolvePortalUser(req);
    if (!portalUserId) return res.status(401).json({ error: 'not signed in' });

    const { data: user, error: uErr } = await supabase
      .from('portal_users')
      .select('id, email, full_name, role, status, tutorial_dismissed_at, first_login_at, login_count')
      .eq('id', portalUserId)
      .single();
    if (uErr || !user || user.status === 'revoked') {
      clearPortalCookie(res);
      return res.status(401).json({ error: 'session no longer valid' });
    }

    // RENTER PATH (migration 186) — renters reach their property via
    // portal_user_residencies. Different scope table, scoped response
    // shape (no AR / no compliance / scoped doc categories). The actual
    // security guarantee lives in per-endpoint guards on /balance,
    // /compliance, /meetings — this branch exists so renters get a
    // useful portal experience, not so they're prevented from seeing
    // sensitive data (that's the endpoint guards' job).
    const isRenter = user.role === 'renter';
    if (isRenter) {
      const { data: rscopes } = await supabase
        .from('portal_user_residencies')
        .select(`residency_id, property_residencies:residency_id (
          id, property_id, residency_type, end_date, lease_end_date,
          properties:property_id (id, street_address, community_id)
        )`)
        .eq('portal_user_id', user.id)
        .is('revoked_at', null);
      // CURRENT residencies only — when lease ends (residency.end_date
      // set), the renter loses portal access on next /me. Structural.
      const currentRes = (rscopes || []).filter(s =>
        s.property_residencies && !s.property_residencies.end_date
      );
      if (!currentRes.length) {
        return res.json({
          user: {
            name: user.full_name || user.email,
            email: user.email,
            role: user.role,
            tutorial_dismissed: !!user.tutorial_dismissed_at,
            first_login_at: user.first_login_at,
            login_count: user.login_count || 0,
          },
          property: null,
          properties: [],
          community: { name: 'No Active Lease', slug: '', portal_active: false, is_demo: false },
          balance: { role_restricted: true },
          compliance: { role_restricted: true },
          open_requests: { count: 0, role_restricted: true },
        });
      }
      const renterProps = currentRes.map(s => s.property_residencies.properties).filter(Boolean);
      const focusProp = renterProps[0];
      let focusComm = { id: focusProp.community_id, name: 'Your Community', slug: '', portal_active: false };
      try {
        const { data: cRow } = await supabase
          .from('communities')
          .select('id, name, slug, hoa_legal_name, portal_active, portal_module_config, portal_welcome_message')
          .eq('id', focusProp.community_id)
          .maybeSingle();
        if (cRow) focusComm = { ...focusComm, ...cRow };
      } catch (_) {}

      // is_demo check (matches owner-path logic)
      const RENTER_DEMO_IDS = new Set(['dc100000-0000-4000-a000-000000000000']);
      const renterIsDemo = RENTER_DEMO_IDS.has(String(focusComm.id));
      focusComm.is_demo = renterIsDemo;
      if (renterIsDemo) focusComm.portal_active = true;

      // Renter-safe tile config — owner-only tiles hidden so the frontend
      // doesn't render them. Renter-OK tiles inherit community config.
      const baseCfg = focusComm.portal_module_config || {};
      const RENTER_HIDDEN_TILES = ['balance', 'compliance', 'arc', 'financials', 'meetings'];
      const renterCfg = { ...baseCfg };
      for (const k of RENTER_HIDDEN_TILES) renterCfg[k] = { status: 'hidden' };
      focusComm.portal_module_config = renterCfg;

      return res.json({
        user: {
          name: user.full_name || user.email,
          email: user.email,
          role: user.role,
          tutorial_dismissed: !!user.tutorial_dismissed_at,
          first_login_at: user.first_login_at,
          login_count: user.login_count || 0,
        },
        property: {
          id: focusProp.id,
          address: focusProp.street_address,
          community_slug: focusComm.slug,
          community_name: focusComm.name,
        },
        properties: renterProps.map(p => ({
          id: p.id,
          address: p.street_address,
          community_id: p.community_id,
          community_name: focusComm.name,
          community_slug: focusComm.slug,
        })),
        community: focusComm,
        balance: { role_restricted: true },
        compliance: { role_restricted: true },
        open_requests: { count: 0, role_restricted: true },
        is_board_member: false,
        board_communities: [],
        mimic: mimic ? {
          active: true,
          staff_email: mimic.staff_email,
          started_at: mimic.started_at,
          expires_at: mimic.expires_at,
        } : null,
      });
    }

    // BUILDER PATH — Ed 2026-06-11 evening, in support of adding Lennar to
    // Still Creek Ranch alongside DRB at August Meadows. Each builder needs
    // to land on THEIR submission page, not a hardcoded one. Look up which
    // builder_companies this portal user has access to via
    // portal_user_builders, then resolve the landing URL from a code-level
    // mapping (single source of truth — extend when onboarding a new
    // builder/community pair).
    //
    // SINGLE SOURCE OF TRUTH for "which page does each builder land on":
    //   - One entry per builder_companies.company_name
    //   - Value MUST be a real route declared in server.js (otherwise the
    //     builder lands on a 404)
    //   - When a builder has multiple active communities, list them in
    //     order of preference; the FIRST match wins
    //   - When NO mapping matches, fall back to the dashboard so the
    //     builder isn't dead-ended — they can navigate from there
    const isBuilder = user.role === 'builder';
    if (isBuilder) {
      const { data: builderLinks } = await supabase
        .from('portal_user_builders')
        .select('builder_companies(id, company_name)')
        .eq('portal_user_id', user.id)
        .is('revoked_at', null);
      const companies = (builderLinks || [])
        .map((b) => b.builder_companies)
        .filter(Boolean);

      const landingUrl = resolveBuilderLandingUrl(companies.map((c) => c.company_name));

      return res.json({
        user: {
          name: user.full_name || user.email,
          email: user.email,
          role: user.role,
          tutorial_dismissed: !!user.tutorial_dismissed_at,
          first_login_at: user.first_login_at,
          login_count: user.login_count || 0,
          landing_url: landingUrl,
          builder_companies: companies.map((c) => c.company_name),
        },
        property: null,
        properties: [],
        community: { name: 'Builder Portal', slug: '', portal_active: false, is_demo: false },
        balance: {},
        compliance: {},
      });
    }

    // MANAGER PATH (migration 201) — Bedrock staff role that can pick ANY
    // property in the portfolio and render its homeowner view. Eliminates
    // per-homeowner portal_user provisioning for support, QA, training,
    // prospect demos.
    //
    // The client passes ?property_id=X to pick a property. If not provided,
    // we return a special "show picker" response shape so the UI knows to
    // render the property browser instead of the standard homeowner view.
    //
    // Once a property_id is provided AND verified to be in the manager's
    // scope, we substitute a synthetic property scope and fall through to
    // the OWNER PATH below — same rendering, same downstream calls. The
    // homeowner experience is identical to what the real homeowner would
    // see when they log in.
    const isManager = user.role === 'manager';
    if (isManager) {
      const requestedPropertyId = String(req.query?.property_id || '').trim();

      // Manager scope — communities they can browse
      const { data: scopeRows } = await supabase
        .from('portal_manager_scope')
        .select('community_id')
        .eq('portal_user_id', user.id)
        .is('revoked_at', null);
      const scopes = scopeRows || [];
      const portfolioWide = scopes.some(s => s.community_id === null);
      const allowedCommunityIds = portfolioWide
        ? null  // null = all communities allowed (Bedrock staff)
        : new Set(scopes.map(s => s.community_id).filter(Boolean));

      if (!requestedPropertyId) {
        // No property picked yet → return picker mode
        return res.json({
          user: {
            name: user.full_name || user.email,
            email: user.email,
            role: 'manager',
            tutorial_dismissed: !!user.tutorial_dismissed_at,
            login_count: user.login_count || 0,
          },
          manager_mode: {
            active: true,
            portfolio_wide: portfolioWide,
            scoped_community_count: portfolioWide ? null : allowedCommunityIds?.size,
            picker_required: true,
          },
          // Empty placeholders so the frontend doesn't render a broken homeowner view
          property: null,
          properties: [],
          community: { name: 'Select a property', slug: '', portal_active: false },
          balance: {},
          compliance: {},
          open_requests: { count: 0 },
        });
      }

      // Property picked → verify it's in scope, then proceed to homeowner render
      const { data: pickedProp } = await supabase
        .from('properties')
        .select('id, street_address, community_id, vantaca_account_id')
        .eq('id', requestedPropertyId)
        .maybeSingle();
      if (!pickedProp) {
        return res.status(404).json({ error: 'property_not_found' });
      }
      if (!portfolioWide && allowedCommunityIds && !allowedCommunityIds.has(pickedProp.community_id)) {
        return res.status(403).json({ error: 'property_outside_manager_scope' });
      }

      // Audit — log every property view in manager mode
      try {
        await supabase.from('portal_manager_view_log').insert({
          portal_user_id: user.id,
          staff_email: user.email,
          viewed_property_id: pickedProp.id,
          viewed_community_id: pickedProp.community_id,
          ip_address: req.ip || null,
          user_agent: req.headers['user-agent'] || null,
        });
      } catch (e) {
        console.warn('[portal /me manager] view log failed (non-fatal):', e.message);
      }

      // Manager has access — fall through with a synthetic property scope so
      // the rest of /me processes exactly as if this property were owned.
      // The picked property gets injected into req.query for downstream code.
      req.query.property_id = pickedProp.id;

      // Look up the CURRENT owner so the greeting + top-right show the
      // homeowner's name (not the manager's). This is what "see what they
      // see" actually requires — staff name in the header makes the
      // preview misleading.
      // contacts has full_name + preferred_name only; no first_name column.
      let homeownerName = null;
      try {
        const { data: ownerRows, error: ownerErr } = await supabase
          .from('property_ownerships')
          .select('is_primary, contacts:contact_id (full_name, preferred_name)')
          .eq('property_id', pickedProp.id)
          .is('end_date', null)
          .limit(5);
        if (ownerErr) {
          console.warn('[portal /me manager] owner query error:', ownerErr.message);
        }
        // Pick the primary owner if present; else the first
        const primary = (ownerRows || []).find(r => r.is_primary) || (ownerRows || [])[0];
        const c = primary?.contacts;
        if (c) {
          homeownerName = c.preferred_name || c.full_name || null;
        }
      } catch (e) {
        console.warn('[portal /me manager] owner lookup failed (non-fatal):', e.message);
      }

      req._managerView = {
        synthetic_property: pickedProp,
        portfolio_wide: portfolioWide,
        homeowner_name: homeownerName,
        staff_email: user.email,
      };
    }

    // OWNER PATH — original logic continues below.
    // Resolve property scope (homeowners are scoped to one or more properties).
    // We pull the FULL list of accessible properties so the frontend can:
    //   - Render the property picker on first load when length > 1
    //   - Render the header "Switch property" affordance
    //   - Surface a quick balance preview per property on the picker cards
    // The CURRENT focus property is selected via optional ?property_id query;
    // defaults to the first accessible property if omitted (preserves prior
    // single-property behavior for the common case).
    // Minimal SELECT — only columns that definitely exist on properties.
    // block_number / section_number are NOT real columns on properties
    // (they live on builder_arc); including them historically may have
    // been silently tolerated by PostgREST but it's not safe to depend
    // on. Stripped to the essentials so the join cannot fail on a
    // missing-column reference. Extra data (community config etc.) gets
    // looked up in separate queries below.
    const { data: propScopes, error: propScopesErr } = await supabase
      .from('portal_user_properties')
      .select(`
        property_id,
        properties:property_id (
          id,
          street_address,
          lot_number,
          community_id
        )
      `)
      .eq('portal_user_id', user.id)
      .is('revoked_at', null);
    if (propScopesErr) {
      console.warn('[portal /me] propScopes query failed:', propScopesErr.message);
    }

    let props = (propScopes || []).map((s) => s.properties).filter(Boolean);

    // MANAGER MODE — inject the picked property as a synthetic scope.
    // (The manager has no portal_user_properties rows; they were granted
    // access via portal_manager_scope which is checked earlier.)
    if (req._managerView?.synthetic_property) {
      const sp = req._managerView.synthetic_property;
      props = [{
        id: sp.id,
        street_address: sp.street_address,
        community_id: sp.community_id,
        vantaca_account_id: sp.vantaca_account_id,
      }];
    }

    if (!props.length) {
      // User has portal access but no property scope yet — show a polite
      // empty state. Include role + email so the login-page router can tell
      // builders from homeowners (builders have no property scope by design;
      // without role here the post-consume router can't decide between the
      // homeowner portal and /builder-dashboard.html).
      return res.json({
        user: {
          name: user.full_name || user.email,
          email: user.email,
          role: user.role,
          tutorial_dismissed: !!user.tutorial_dismissed_at,
          first_login_at: user.first_login_at,
          login_count: user.login_count || 0,
        },
        property: null,
        properties: [],
        community: { name: 'Your Community', slug: '', portal_active: false },
        balance: {},
        compliance: {},
        open_requests: { count: 0 },
      });
    }

    // Batch-fetch all unique communities the user touches, so downstream
    // code that expects p.communities (board view, property list, etc.)
    // still works. Single query, IN clause, served from communities table
    // directly. Avoids nested-SELECT failure modes.
    const uniqueCommunityIds = Array.from(new Set(
      props.map(p => p.community_id).filter(Boolean)
    ));
    const communitiesById = {};
    if (uniqueCommunityIds.length) {
      try {
        const { data: cRows, error: cErr } = await supabase
          .from('communities')
          .select('id, name, slug, hoa_legal_name, portal_active, portal_module_config, portal_welcome_message')
          .in('id', uniqueCommunityIds);
        if (cErr) console.warn('[portal /me] communities batch fetch failed:', cErr.message);
        (cRows || []).forEach(c => { communitiesById[c.id] = c; });
      } catch (e) {
        console.warn('[portal /me] communities batch fetch threw:', e.message);
      }
    }
    // Attach community to each prop so existing downstream code keeps working
    props.forEach(p => { p.communities = communitiesById[p.community_id] || null; });

    // Honor ?property_id if provided AND that property is in the user's
    // accessible list. Otherwise default to the first. Security: NEVER trust
    // the client-supplied property_id without verifying it's in propScopes —
    // that's the community-scoping discipline from CLAUDE.md. The .find()
    // below is that verification.
    const requestedPropertyId = String(req.query?.property_id || '').trim();
    const prop = (requestedPropertyId && props.find((p) => String(p.id) === requestedPropertyId))
      || props[0];

    let community = communitiesById[prop.community_id]
      || { id: prop.community_id, name: 'Your Community', slug: '', portal_active: false };
    // Operate on a shallow copy so the is_demo / portal_active coercion
    // below doesn't mutate the shared map used by other props above.
    community = { ...community };

    // Resolve is_demo via a SEPARATE single-column query. Hardcoded
    // allowlist as fallback so demo works even if PostgREST hasn't learned
    // about communities.is_demo yet.
    const KNOWN_DEMO_COMMUNITY_IDS = new Set([
      'dc100000-0000-4000-a000-000000000000', // Drama Creek Estates
    ]);
    let isDemoCommunity = KNOWN_DEMO_COMMUNITY_IDS.has(String(community.id));
    if (!isDemoCommunity) {
      try {
        const { data: demoLookup } = await supabase
          .from('communities')
          .select('is_demo')
          .eq('id', community.id)
          .maybeSingle();
        if (demoLookup?.is_demo === true) isDemoCommunity = true;
      } catch (e) {
        console.warn(`[portal] is_demo lookup failed (likely schema cache): ${e.message}`);
      }
    }
    community.is_demo = isDemoCommunity;

    // Demo communities bypass the portal_active gate by design.
    if (isDemoCommunity) {
      community.portal_active = true;
    }

    // Balance — single resolver. Tries v_homeowner_current_balance
    // (canonical post-Jun-2026), falls back to owner_ar_snapshots for
    // legacy data. See lib/ar/resolve_current_ar.js for merge logic.
    let balance = { status: 'unknown', amount_cents: null, as_of: null };
    try {
      const { resolveCurrentAR } = require('../lib/ar/resolve_current_ar');
      const ar = await resolveCurrentAR(supabase, {
        propertyId: prop.id,
        vantacaAccountId: prop.vantaca_account_id,
        communityId: prop.community_id,
      });
      if (ar) {
        const isPastDue = ar.at_legal || ar.in_collections
          || ['certified_209', 'at_legal', 'with_attorney', 'in_collections', 'judgment', 'lien_filed'].includes(ar.enforcement_stage || '');
        balance = {
          amount_cents: ar.balance_cents,
          as_of: ar.as_of,
          source: ar.source,
          status: (ar.balance_cents == null || ar.balance_cents <= 0) ? 'current' : (isPastDue ? 'past_due' : 'open_balance'),
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

    // Board-member determination — supports the dual-portal pattern
    // (project_board_portal memory note). A portal user with role
    // 'board_member' / 'admin' / 'staff' can switch to the Board View.
    // For 'board_member' specifically, only show communities where their
    // email appears in board_members (so a board member of community A
    // doesn't see community B's board portal).
    const isBoardCapable = ['board_member', 'admin', 'staff'].includes(user.role);
    let boardCommunities = [];
    if (isBoardCapable) {
      if (user.role === 'board_member') {
        // Match by email against board_members for the communities this
        // user has portal access to.
        const accessibleCommunityIds = props.map(p => p.community_id).filter(Boolean);
        if (accessibleCommunityIds.length) {
          try {
            const { data: rosterRows } = await supabase
              .from('board_members')
              .select('community_id, position, term_end')
              .in('community_id', accessibleCommunityIds)
              .eq('is_active', true)
              .eq('email', user.email);
            const communityById = {};
            props.forEach(p => {
              if (p.communities) communityById[p.communities.id] = p.communities;
            });
            boardCommunities = (rosterRows || []).map(r => ({
              id: r.community_id,
              name: communityById[r.community_id]?.name || '',
              slug: communityById[r.community_id]?.slug || '',
              position: r.position,
              term_end: r.term_end,
            }));
          } catch (_) { /* board_members table optional */ }
        }
      } else {
        // admin / staff — broad access (their board view scope is
        // determined inside the board portal endpoints, not here)
        boardCommunities = props.map(p => p.communities).filter(Boolean).map(c => ({
          id: c.id, name: c.name, slug: c.slug,
        }));
      }
    }
    const isBoardMember = isBoardCapable && boardCommunities.length > 0;

    // Owner of record for the focus property — used for the greeting so a joint
    // owner ("Brett & Alexis Geissler") is never reduced to one name. This is
    // the canonical contact name, independent of which individual logged in.
    // Prefer full_name (carries both joint owners) over preferred_name.
    let ownerOfRecordName = null;
    try {
      const { data: ownerRows } = await supabase
        .from('property_ownerships')
        .select('is_primary, contacts:contact_id (full_name, preferred_name)')
        .eq('property_id', prop.id)
        .is('end_date', null)
        .limit(5);
      const primaryOwner = (ownerRows || []).find((r) => r.is_primary) || (ownerRows || [])[0];
      const oc = primaryOwner && primaryOwner.contacts;
      if (oc) ownerOfRecordName = oc.full_name || oc.preferred_name || null;
    } catch (e) {
      console.warn('[portal /me] owner-of-record lookup failed (non-fatal):', e.message);
    }

    // Light summary array of ALL accessible properties (for the picker UI
    // and the header switcher). We keep the per-property payload SMALL —
    // address + community name + property id — so the picker can render
    // instantly without N+1 lookups. The currently-focused property gets
    // the full balance/compliance/requests payload below; switching
    // properties triggers a fresh /me?property_id=<X> fetch to load the
    // full context for that one.
    const propertiesList = props.map((p) => ({
      id: p.id,
      address: p.street_address,
      lot_block_section: [
        p.lot_number && `Lot ${p.lot_number}`,
        p.block_number && `Block ${p.block_number}`,
        p.section_number && `Section ${p.section_number}`,
      ].filter(Boolean).join(', '),
      community_id: p.community_id,
      community_name: p.communities?.name || '',
      community_slug: p.communities?.slug || '',
    }));

    // In manager mode, show the actual homeowner's name in the portal
    // header/greeting — that's what "see what they see" means. Staff email
    // is preserved on the manager banner for audit/identity context.
    const displayName = (req._managerView?.homeowner_name)
      || user.full_name
      || user.email;

    res.json({
      user: {
        name: displayName,
        email: req._managerView ? (req._managerView.homeowner_name || 'Homeowner') : user.email,
        staff_email: req._managerView ? req._managerView.staff_email : null,
        role: user.role,
        // Tutorial state — true means "user has dismissed/completed the
        // first-login tutorial, don't auto-show again." Frontend reads this
        // to decide whether to render the overlay automatically on load.
        tutorial_dismissed: !!user.tutorial_dismissed_at,
        first_login_at: user.first_login_at,
        login_count: user.login_count || 0,
      },
      property: {
        id: prop.id,
        address: prop.street_address,
        owner_name: req._managerView ? (req._managerView.homeowner_name || ownerOfRecordName) : ownerOfRecordName,
        lot_block_section: [
          prop.lot_number && `Lot ${prop.lot_number}`,
          prop.block_number && `Block ${prop.block_number}`,
          prop.section_number && `Section ${prop.section_number}`,
        ].filter(Boolean).join(', '),
        community_slug: community.slug,
        community_name: community.name,
      },
      // Full list of accessible properties — used by the frontend picker
      // and header switcher. Always present (may be length 1).
      properties: propertiesList,
      community: {
        id: community.id,
        slug: community.slug,
        name: community.name,
        hoa_legal_name: community.hoa_legal_name || community.name,
        welcome_message: community.portal_welcome_message || '',
        portal_active: community.portal_active === true,
        portal_module_config: community.portal_module_config || {},
        // Demo community flag — drives watermark ribbon. Migration 184
        // adds Drama Creek Estates as the canonical demo community.
        is_demo: community.is_demo === true,
      },
      balance,
      compliance,
      open_requests: openRequests,
      // Board-portal switcher hints (consumed by portal.html header)
      is_board_member: isBoardMember,
      board_communities: boardCommunities,
      // Mimic block — present (with active:true) ONLY when a staff member
      // is rendering the portal as this homeowner via /mimic/start. Frontend
      // uses this to render the persistent "you are in mimic mode" banner.
      mimic: mimic ? {
        active: true,
        staff_email: mimic.staff_email,
        started_at: mimic.started_at,
        expires_at: mimic.expires_at,
      } : null,
      // Manager mode flag — surfaced even on the picked-property branch
      // so the frontend can bypass the portal_active gate (staff are
      // intentionally previewing communities that haven't gone live yet)
      // and so the navy "MANAGER VIEW" banner renders.
      manager_mode: req._managerView ? {
        active: true,
        portfolio_wide: !!req._managerView.portfolio_wide,
      } : null,
    });
  } catch (err) {
    console.error('[portal] /me failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ============================================================================
// POST /api/portal/mimic/start
// Staff renders the portal as a specific portal_user. Sets a separate
// TRUSTED_PORTAL_MIMIC cookie (30-min TTL) that takes precedence over the
// normal session cookie. Logs to portal_audit_log so the audit trail
// captures who, when, and for whom.
//
// Body: { portal_user_id, staff_email }
// Trust model: the trustEd app this is called from is gated by staff auth at
// the network/app layer. The staff_email passed in is recorded for audit.
// Future hardening: cross-check req.headers against a staff session.
// ============================================================================
router.post('/mimic/start', express.json({ limit: '4kb' }), async (req, res) => {
  try {
    const portalUserId = String(req.body?.portal_user_id || '').trim();
    const staffEmail = String(req.body?.staff_email || '').trim().toLowerCase();
    if (!portalUserId || !staffEmail) {
      return res.status(400).json({ error: 'portal_user_id_and_staff_email_required' });
    }
    if (!staffEmail.includes('@')) {
      return res.status(400).json({ error: 'staff_email_invalid' });
    }

    // Confirm target portal user exists + is active
    const { data: user } = await supabase
      .from('portal_users')
      .select('id, email, full_name, role, status')
      .eq('id', portalUserId)
      .maybeSingle();
    if (!user) return res.status(404).json({ error: 'portal_user_not_found' });
    if (user.status === 'revoked') return res.status(403).json({ error: 'portal_user_revoked' });

    setMimicCookie(res, signMimicCookie(portalUserId, staffEmail));

    await logAudit('mimic_start', {
      portal_user_id: portalUserId,
      performed_by: staffEmail,
      ip_address: req.ip,
      user_agent: req.headers['user-agent'] || null,
      notes: `Staff ${staffEmail} started mimic session as ${user.full_name || user.email} (${user.email})`,
    });

    res.json({
      ok: true,
      target_email: user.email,
      target_name: user.full_name,
      expires_in_minutes: MIMIC_COOKIE_TTL_MIN,
    });
  } catch (err) {
    console.error('[portal] mimic/start failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ============================================================================
// POST /api/portal/mimic/stop
// Clears the mimic cookie. Does NOT touch the normal portal session cookie
// (so if staff had their own portal login, they return to their own session).
// ============================================================================
router.post('/mimic/stop', async (req, res) => {
  try {
    const mimicCookieValue = readCookie(req, MIMIC_COOKIE_NAME);
    const mimic = mimicCookieValue ? verifyMimicCookie(mimicCookieValue) : null;
    clearMimicCookie(res);
    if (mimic) {
      await logAudit('mimic_end', {
        portal_user_id: mimic.portal_user_id,
        performed_by: mimic.staff_email,
        ip_address: req.ip,
        user_agent: req.headers['user-agent'] || null,
      });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[portal] mimic/stop failed:', err.message);
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
    // Renter sessions REFUSED — compliance/violations are owner-class data.
    // Migration 186 capability matrix.
    const roleCheck = await assertOwnerLikeRole(req, res);
    if (!roleCheck) return;

    // Owner-or-manager scope resolution
    const scoped = await resolveScopedProperty(req, supabase, roleCheck.user);
    if (scoped.error === 'property_outside_manager_scope') {
      return res.status(403).json({ error: scoped.error });
    }
    const prop = scoped.property;
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

// Renter-scoped document categories (migration 186 capability matrix).
// Renters see rules they need to follow + forms they may need + welcome
// info. They do NOT see governing documents (CCRs/bylaws are member-only
// in many states), financials, meeting minutes, or reserve studies.
const RENTER_DOC_CATEGORIES = [
  'rules_and_regulations',
  'design_document',          // architectural guidelines — they need to know what they CAN'T do to the property
  'forms_and_applications',   // amenity rental, fob, etc.
  'key_fob_form',
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
    // Role-aware: renters see a SCOPED subset of doc categories. The
    // assertOwnerLikeRole gate would over-restrict (renters DO get docs,
    // just fewer of them). So resolve user first, then pick category list.
    const roleCheck = await resolveUserWithRole(req, res);
    if (!roleCheck) return;
    const portalUserId = roleCheck.user.id;
    const isRenter = roleCheck.user.role === 'renter';
    const allowedCategories = isRenter ? RENTER_DOC_CATEGORIES : HOMEOWNER_DOC_CATEGORIES;

    // Renters reach their property via portal_user_residencies, not
    // portal_user_properties. Try both — single source: the residency
    // path takes precedence for renters.
    let prop = null;
    if (isRenter) {
      const { data: rscopes } = await supabase
        .from('portal_user_residencies')
        .select(`residency_id, property_residencies:residency_id (
          property_id, end_date,
          properties:property_id (community_id, communities:community_id (id, name, slug))
        )`)
        .eq('portal_user_id', portalUserId)
        .is('revoked_at', null)
        .limit(1);
      const r = rscopes && rscopes[0]?.property_residencies;
      // Renter access only valid while the residency is current
      if (r && !r.end_date && r.properties) {
        prop = r.properties;
      }
    } else {
      // Owner or manager — single helper handles both scope paths
      const scoped = await resolveScopedProperty(req, supabase, roleCheck.user);
      if (scoped.error === 'property_outside_manager_scope') {
        return res.status(403).json({ error: scoped.error });
      }
      // resolveScopedProperty returns a richer property shape; we only need
      // the community linkage downstream, so map to the same shape the
      // renter path produces.
      prop = scoped.property ? {
        community_id: scoped.property.community_id,
        communities: scoped.property.communities,
      } : null;
    }
    if (!prop) return res.json({ community: null, groups: {} });

    const community = prop.communities || {};

    // Pull homeowner-appropriate library_documents for this community
    const { data: docs, error } = await supabase
      .from('library_documents')
      .select('id, category, title, period_label, effective_date, file_path, file_name_normalized, status, approval_status, created_at')
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .eq('community_id', community.id)
      .eq('status', 'current')
      .in('category', allowedCategories)
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
    const roleCheck = await assertOwnerLikeRole(req, res);
    if (!roleCheck) return;

    // Owner-or-manager scope resolution
    const scoped = await resolveScopedProperty(req, supabase, roleCheck.user);
    if (scoped.error === 'property_outside_manager_scope') {
      return res.status(403).json({ error: scoped.error });
    }
    if (!scoped.property) return res.json({ property: null });
    // Re-query for the full property details (extra columns not in helper)
    const { data: prop } = await supabase
      .from('properties')
      .select(`
        id, street_address, unit, city, state, zip, property_type, lot_number,
        community_id, vantaca_account_id, notes, created_at,
        communities:community_id (id, name, slug, hoa_legal_name)
      `)
      .eq('id', scoped.property.id)
      .maybeSingle();
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
// GET /api/portal/balance
// Returns current balance + last 12 snapshots + payment plan info if active.
// Driven by owner_ar_snapshots which is fed by drag-drop Vantaca AR PDFs.
// Real-time balance lives in Vantaca; we mirror for visibility per single-
// source-of-truth discipline (Vantaca is the GL of record).
// ============================================================================
router.get('/balance', async (req, res) => {
  try {
    // Renter sessions REFUSED at this endpoint — AR data is owner-class
    // financial info. Migration 186 capability matrix.
    const roleCheck = await assertOwnerLikeRole(req, res);
    if (!roleCheck) return;

    // Resolve target property — handles both owner and manager scope
    const scoped = await resolveScopedProperty(req, supabase, roleCheck.user);
    if (scoped.error === 'property_outside_manager_scope') {
      return res.status(403).json({ error: scoped.error });
    }
    const prop = scoped.property;
    if (!prop) return res.json({ property: null });

    const community = prop.communities || {};

    // Current balance via the unified resolver — single source of truth
    // across the transactions view + owner_ar_snapshots + enforcement state.
    const { resolveCurrentAR } = require('../lib/ar/resolve_current_ar');
    const ar = await resolveCurrentAR(supabase, {
      propertyId: prop.id,
      vantacaAccountId: prop.vantaca_account_id,
      communityId: prop.community_id,
    });

    // Snapshot history — still useful for the 12-month aging chart even
    // when the current balance comes from transactions. Empty array is fine.
    const { data: snaps } = await supabase
      .from('owner_ar_snapshots')
      .select(`
        id, snapshot_date, balance_total,
        bucket_0_30, bucket_31_60, bucket_61_90, bucket_91_120, bucket_over_120,
        at_legal, in_collections, payment_plan_active, payment_plan_terms_text,
        enforcement_stage
      `)
      .eq('property_id', prop.id)
      .order('snapshot_date', { ascending: false })
      .limit(12);

    let statusKey = 'no_data';
    let currentBlock = null;
    if (ar && ar.balance_cents != null) {
      const cents = Number(ar.balance_cents);
      const isPastDue = !!(ar.at_legal || ar.in_collections
        || ['certified_209', 'at_legal', 'with_attorney', 'in_collections', 'judgment', 'lien_filed']
            .includes(String(ar.enforcement_stage || '').toLowerCase()));
      statusKey = cents <= 0 ? 'current' : (isPastDue ? 'past_due' : 'open_balance');

      // Aging buckets come from the latest snapshot if present; transactions
      // doesn't carry aging metadata. So we surface them when we have them.
      const snapBuckets = (snaps && snaps[0]) || null;
      currentBlock = {
        snapshot_date: ar.as_of,
        balance_total: cents / 100,
        bucket_0_30: Number(snapBuckets?.bucket_0_30 || 0),
        bucket_31_60: Number(snapBuckets?.bucket_31_60 || 0),
        bucket_61_90: Number(snapBuckets?.bucket_61_90 || 0),
        bucket_91_120: Number(snapBuckets?.bucket_91_120 || 0),
        bucket_over_120: Number(snapBuckets?.bucket_over_120 || 0),
        at_legal: !!ar.at_legal,
        in_collections: !!ar.in_collections,
        payment_plan_active: !!ar.payment_plan_active,
        payment_plan_terms_text: ar.payment_plan_terms_text || null,
        enforcement_stage: ar.enforcement_stage || null,
        source: ar.source,
      };
    }
    const current = currentBlock;

    res.json({
      property: {
        id: prop.id,
        street_address: prop.street_address,
      },
      community: {
        name: community.name,
        slug: community.slug,
        hoa_legal_name: community.hoa_legal_name,
      },
      status: statusKey,
      current: current ? {
        snapshot_date: current.snapshot_date,
        balance_total: Number(current.balance_total) || 0,
        bucket_0_30: Number(current.bucket_0_30) || 0,
        bucket_31_60: Number(current.bucket_31_60) || 0,
        bucket_61_90: Number(current.bucket_61_90) || 0,
        bucket_91_120: Number(current.bucket_91_120) || 0,
        bucket_over_120: Number(current.bucket_over_120) || 0,
        at_legal: current.at_legal,
        in_collections: current.in_collections,
        payment_plan_active: current.payment_plan_active,
        payment_plan_terms_text: current.payment_plan_terms_text,
        enforcement_stage: current.enforcement_stage,
      } : null,
      history: (snaps || []).slice(1).map((s) => ({
        snapshot_date: s.snapshot_date,
        balance_total: Number(s.balance_total) || 0,
        enforcement_stage: s.enforcement_stage,
      })),
    });
  } catch (err) {
    console.error('[portal] balance failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ============================================================================
// ============================================================================
// GET /api/portal/transactions
// Returns the signed-in homeowner's transaction history + running balance
// for the property they're scoped to. Plus the freshness disclosure —
// "Financial activity current as of [date]" — pulled from the latest
// committed upload batch for the community.
//
// Renters refused (per migration 186 capability matrix — financial data
// is owner-class).
//
// Query params:
//   property_id — optional, defaults to the user's first property
//   limit       — optional, default 100
// ============================================================================
router.get('/transactions', async (req, res) => {
  try {
    const roleCheck = await assertOwnerLikeRole(req, res);
    if (!roleCheck) return;

    // Owner-or-manager scope resolution
    const scoped = await resolveScopedProperty(req, supabase, roleCheck.user);
    if (scoped.error === 'property_outside_manager_scope') {
      return res.status(403).json({ error: scoped.error });
    }
    const prop = scoped.property;
    if (!prop) return res.json({ property: null, transactions: [], balance: null, freshness: null });

    const community = prop.communities || {};
    const vantacaAccountId = prop.vantaca_account_id;

    if (!vantacaAccountId) {
      // No Vantaca account linkage — return shape but empty
      return res.json({
        property: { id: prop.id, address: prop.street_address, community_name: community.name },
        transactions: [],
        balance: null,
        freshness: null,
        note: 'This property has no Vantaca account number on file. Transaction history is not available until that linkage is set.',
      });
    }

    const limit = Math.min(parseInt(req.query.limit || '100', 10), 500);

    // Pull transactions joined to committed batches only (reverted batches
    // are excluded structurally)
    const { data: txns } = await supabase
      .from('homeowner_transactions')
      .select('id, transaction_date, description, txn_type, amount_cents, running_balance_cents, vantaca_account_id, source_batch:source_batch_id(status, as_of_date)')
      .eq('community_id', community.id)
      .eq('vantaca_account_id', vantacaAccountId)
      .order('transaction_date', { ascending: false })
      .limit(limit);
    const visibleTxns = (txns || []).filter(t => t.source_batch?.status === 'committed');

    // Running balance — sum of all visible transactions, using the view
    let balance = null;
    try {
      const { data: bal } = await supabase
        .from('v_homeowner_current_balance')
        .select('balance_cents, most_recent_txn_date, txn_count')
        .eq('community_id', community.id)
        .eq('vantaca_account_id', vantacaAccountId)
        .maybeSingle();
      if (bal) balance = bal;
    } catch (_) { /* view may not be ready on fresh deploys */ }

    // Freshness disclosure
    let freshness = null;
    try {
      const { data: f } = await supabase
        .from('v_community_transaction_freshness')
        .select('period_label, as_of_date, committed_at')
        .eq('community_id', community.id)
        .maybeSingle();
      if (f) freshness = f;
    } catch (_) {}

    res.json({
      property: {
        id: prop.id,
        address: prop.street_address,
        community_id: community.id,
        community_name: community.name,
        vantaca_account_id: vantacaAccountId,
      },
      transactions: visibleTxns.map(t => ({
        id: t.id,
        date: t.transaction_date,
        description: t.description,
        type: t.txn_type,
        amount_cents: t.amount_cents,
        running_balance_cents: t.running_balance_cents,
      })),
      balance: balance ? {
        balance_cents: balance.balance_cents,
        most_recent_txn_date: balance.most_recent_txn_date,
      } : null,
      freshness: freshness ? {
        period_label: freshness.period_label,
        as_of_date: freshness.as_of_date,
      } : null,
    });
  } catch (err) {
    console.error('[portal/transactions] failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ============================================================================
// GET /api/portal/meetings
// Returns upcoming meetings (from events table where event_type contains
// 'meeting') + past meeting minutes (library_documents with meeting categories).
// ============================================================================
router.get('/meetings', async (req, res) => {
  try {
    // Renter sessions REFUSED — meetings are owner/member-only (statutory
    // in TX § 209). Migration 186 capability matrix.
    const roleCheck = await assertOwnerLikeRole(req, res);
    if (!roleCheck) return;

    // Owner-or-manager scope resolution
    const scoped = await resolveScopedProperty(req, supabase, roleCheck.user);
    if (scoped.error === 'property_outside_manager_scope') {
      return res.status(403).json({ error: scoped.error });
    }
    const prop = scoped.property;
    if (!prop) return res.json({ community: null, upcoming: [], past: [] });

    const community = prop.communities || {};

    // Upcoming meetings — events table, future-dated, meeting-type
    const today = new Date().toISOString();
    let upcoming = [];
    try {
      const { data: events } = await supabase
        .from('events')
        .select('id, name, event_type, description, location, scheduled_start_at, status')
        .eq('community_id', community.id)
        .in('event_type', ['annual_meeting', 'board_meeting', 'special_meeting', 'meeting'])
        .gte('scheduled_start_at', today)
        .order('scheduled_start_at', { ascending: true })
        .limit(6);
      upcoming = (events || []).map((e) => ({
        id: e.id,
        name: e.name,
        type: e.event_type,
        type_label: meetingTypeLabel(e.event_type),
        description: e.description,
        location: e.location,
        scheduled_start_at: e.scheduled_start_at,
        status: e.status,
      }));
    } catch (_) { /* skip */ }

    // Past meeting minutes — library_documents in meeting categories
    let past = [];
    try {
      const { data: docs } = await supabase
        .from('library_documents')
        .select('id, category, title, period_label, effective_date, file_path, file_name_normalized, created_at')
        .eq('management_company_id', BEDROCK_MGMT_CO_ID)
        .eq('community_id', community.id)
        .eq('status', 'current')
        .in('category', ['annual_board_meeting_minutes', 'regular_meeting_minutes'])
        .order('effective_date', { ascending: false, nullsFirst: false })
        .limit(12);

      for (const d of docs || []) {
        let url = null;
        if (d.file_path) {
          try {
            const { data: signed } = await supabase.storage
              .from('documents')
              .createSignedUrl(d.file_path, 60 * 60 * 24);
            url = signed?.signedUrl || null;
          } catch (_) { /* skip */ }
        }
        past.push({
          id: d.id,
          type: d.category,
          type_label: d.category === 'annual_board_meeting_minutes' ? 'Annual Meeting' : 'Board Meeting',
          title: d.title || d.file_name_normalized,
          period_label: d.period_label,
          effective_date: d.effective_date,
          minutes_url: url,
        });
      }
    } catch (_) { /* skip */ }

    res.json({
      community: {
        id: community.id,
        name: community.name,
        slug: community.slug,
        hoa_legal_name: community.hoa_legal_name,
      },
      upcoming,
      past,
    });
  } catch (err) {
    console.error('[portal] meetings failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

function meetingTypeLabel(t) {
  return ({
    annual_meeting: 'Annual Meeting',
    board_meeting: 'Board Meeting',
    special_meeting: 'Special Meeting',
    meeting: 'Meeting',
  })[t] || 'Meeting';
}

// ============================================================================
// POST /api/portal/tutorial-dismissed
// ----------------------------------------------------------------------------
// Called by the frontend overlay when a homeowner dismisses or completes the
// first-login tutorial. Sets portal_users.tutorial_dismissed_at = now() so
// the overlay doesn't auto-show on subsequent logins. The user can still
// re-launch the tutorial manually via the "Tour" link in the portal header —
// that path doesn't re-update the timestamp (we don't track repeat views).
//
// Idempotent: re-calling has no effect after the first call (already
// dismissed). Safe to call on every dismissal attempt without checking
// state first.
// ============================================================================
router.post('/tutorial-dismissed', async (req, res) => {
  try {
    const { portalUserId } = resolvePortalUser(req);
    if (!portalUserId) return res.status(401).json({ error: 'not signed in' });
    await supabase
      .from('portal_users')
      .update({ tutorial_dismissed_at: new Date().toISOString() })
      .eq('id', portalUserId)
      .is('tutorial_dismissed_at', null); // only set on first dismissal
    await logAudit('tutorial_dismissed', { portal_user_id: portalUserId, ip_address: req.ip });
    res.json({ ok: true });
  } catch (err) {
    console.error('[portal] tutorial-dismissed failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ============================================================================
// POST /api/portal/logout
// ============================================================================
router.post('/logout', async (req, res) => {
  const { portalUserId, mimic } = resolvePortalUser(req);
  // Always clear both cookies on logout — if staff was mimicking, end mimic
  // session too so we don't leave a stale mimic cookie that takes precedence
  // on next visit.
  clearMimicCookie(res);
  if (mimic) {
    await logAudit('mimic_end', {
      portal_user_id: mimic.portal_user_id,
      performed_by: mimic.staff_email,
      ip_address: req.ip,
      notes: 'mimic ended via logout',
    });
  }
  if (portalUserId) {
    await logAudit('portal_logout', { portal_user_id: portalUserId, ip_address: req.ip });
  }
  clearPortalCookie(res);
  res.json({ ok: true });
});

// ============================================================================
// MESSAGES — Phase 1 homeowner-side endpoints
// ----------------------------------------------------------------------------
// Wired to homeowner_threads + messages tables (migration 161). Auth via
// portal cookie. Homeowner sees threads anchored to ANY property they have
// access to (via portal_user_properties).
// ============================================================================

// Resolve the contact_id + accessible property_ids for the signed-in
// portal user. Returns null if not authenticated. Manager-aware: if the
// user is a manager and ?property_id is passed AND the property is in
// scope, that property_id is returned so the manager sees the same
// messages a real homeowner would.
async function resolveHomeownerScope(req) {
  const { portalUserId } = resolvePortalUser(req);
  if (!portalUserId) return null;

  // portal_users -> contact_id + role
  const { data: user } = await supabase
    .from('portal_users')
    .select('id, contact_id, email, full_name, role')
    .eq('id', portalUserId)
    .maybeSingle();
  if (!user) return null;

  let propertyIds = [];

  if (user.role === 'manager') {
    // Manager path — read property_id from query (or stored). Verify scope.
    const requestedPid = String(req.query?.property_id || '').trim();
    if (requestedPid) {
      const { data: prop } = await supabase
        .from('properties')
        .select('id, community_id')
        .eq('id', requestedPid)
        .maybeSingle();
      if (prop) {
        const { data: scopeRows } = await supabase
          .from('portal_manager_scope')
          .select('community_id')
          .eq('portal_user_id', user.id)
          .is('revoked_at', null);
        const portfolioWide = (scopeRows || []).some(s => s.community_id === null);
        const allowed = new Set((scopeRows || []).map(s => s.community_id).filter(Boolean));
        if (portfolioWide || allowed.has(prop.community_id)) {
          propertyIds = [prop.id];
        }
      }
    }
  } else {
    // Owner / renter / board — portal_user_properties is the scope source
    const { data: scopes } = await supabase
      .from('portal_user_properties')
      .select('property_id')
      .eq('portal_user_id', portalUserId);
    propertyIds = (scopes || []).map((s) => s.property_id).filter(Boolean);
  }

  return { portal_user_id: portalUserId, contact_id: user.contact_id, full_name: user.full_name, email: user.email, role: user.role, property_ids: propertyIds };
}

// ----------------------------------------------------------------------------
// GET /api/portal/messages
// List the homeowner's open threads across all accessible properties.
// Query params:
//   property_id  (optional) — filter to one property
//   include_closed=true     — include closed threads
// ----------------------------------------------------------------------------
router.get('/messages', async (req, res) => {
  try {
    const scope = await resolveHomeownerScope(req);
    if (!scope) return res.status(401).json({ error: 'not_signed_in' });
    if (scope.property_ids.length === 0) return res.json({ threads: [] });

    let q = supabase
      .from('homeowner_threads')
      .select(`
        id, community_id, property_id, subject, topic_tag, next_action_status,
        last_message_at, last_responder_type, created_at, closure_proposed_at,
        properties:property_id(street_address, lot_number),
        communities:community_id(name)
      `)
      .in('property_id', scope.property_ids)
      .order('last_message_at', { ascending: false, nullsFirst: false })
      .limit(200);

    const propertyFilter = req.query.property_id ? String(req.query.property_id) : null;
    if (propertyFilter) {
      if (!scope.property_ids.includes(propertyFilter)) return res.status(403).json({ error: 'forbidden' });
      q = q.eq('property_id', propertyFilter);
    }
    if (String(req.query.include_closed || 'false') !== 'true') q = q.neq('next_action_status', 'closed');

    const { data, error } = await q;
    if (error) return res.status(500).json({ error: 'list_failed' });

    // Compute unread count per thread for the homeowner side. A message is
    // "unread by homeowner" if direction='outbound' and read_at is null.
    const threadIds = (data || []).map((t) => t.id);
    const unreadByThread = {};
    if (threadIds.length > 0) {
      const { data: unread } = await supabase
        .from('messages')
        .select('thread_id')
        .in('thread_id', threadIds)
        .eq('direction', 'outbound')
        .is('read_at', null);
      for (const row of (unread || [])) {
        unreadByThread[row.thread_id] = (unreadByThread[row.thread_id] || 0) + 1;
      }
    }

    const decorated = (data || []).map((t) => ({ ...t, unread_count: unreadByThread[t.id] || 0 }));
    res.json({ threads: decorated, properties: scope.property_ids });
  } catch (err) {
    console.error('[portal/messages] list failed:', err.message);
    res.status(500).json({ error: 'list_failed' });
  }
});

// ----------------------------------------------------------------------------
// GET /api/portal/messages/:threadId — thread detail + messages
// Marks all outbound (homeowner-bound) messages as read_at = now.
// ----------------------------------------------------------------------------
router.get('/messages/:threadId', async (req, res) => {
  try {
    const scope = await resolveHomeownerScope(req);
    if (!scope) return res.status(401).json({ error: 'not_signed_in' });

    const { data: thread, error: thErr } = await supabase
      .from('homeowner_threads')
      .select(`
        id, community_id, property_id, subject, next_action_status,
        last_message_at, closure_proposed_at, closed_at,
        properties:property_id(street_address, lot_number),
        communities:community_id(name)
      `)
      .eq('id', req.params.threadId)
      .maybeSingle();
    if (thErr) return res.status(500).json({ error: 'fetch_failed' });
    if (!thread) return res.status(404).json({ error: 'not_found' });
    if (!scope.property_ids.includes(thread.property_id)) return res.status(403).json({ error: 'forbidden' });

    const { data: messages } = await supabase
      .from('messages')
      .select('id, direction, sender_type, sender_display_name, body_text, channel, created_at, read_at')
      .eq('thread_id', thread.id)
      .order('created_at', { ascending: true });

    // Mark all outbound messages as read by the homeowner
    try {
      await supabase
        .from('messages')
        .update({ read_at: new Date().toISOString(), read_count: 1, last_read_at: new Date().toISOString() })
        .eq('thread_id', thread.id)
        .eq('direction', 'outbound')
        .is('read_at', null);
    } catch (_) {}

    res.json({ thread, messages: messages || [] });
  } catch (err) {
    console.error('[portal/messages] detail failed:', err.message);
    res.status(500).json({ error: 'fetch_failed' });
  }
});

// ----------------------------------------------------------------------------
// POST /api/portal/messages — create a new thread (homeowner-initiated)
// Body: { property_id, subject, body_text }
// ----------------------------------------------------------------------------
router.post('/messages', express.json({ limit: '256kb' }), async (req, res) => {
  try {
    const scope = await resolveHomeownerScope(req);
    if (!scope) return res.status(401).json({ error: 'not_signed_in' });

    const propertyId = String(req.body?.property_id || '').trim();
    const subject = String(req.body?.subject || '').trim().slice(0, 200);
    const body = String(req.body?.body_text || '').trim();
    if (!propertyId) return res.status(400).json({ error: 'property_id_required' });
    if (!subject) return res.status(400).json({ error: 'subject_required' });
    if (!body) return res.status(400).json({ error: 'body_text_required' });
    if (!scope.property_ids.includes(propertyId)) return res.status(403).json({ error: 'forbidden' });

    // Look up community + computed first-response due
    const { data: prop } = await supabase
      .from('properties')
      .select('community_id')
      .eq('id', propertyId)
      .maybeSingle();
    if (!prop) return res.status(404).json({ error: 'property_not_found' });

    // SLA target: 8 business hours via the shared sla_engine helper.
    const { computeFirstResponseDueAt } = require('../lib/messaging/sla_engine');
    const dueAt = computeFirstResponseDueAt(new Date()).toISOString();

    const { data: thread, error: thErr } = await supabase
      .from('homeowner_threads')
      .insert({
        community_id: prop.community_id,
        property_id: propertyId,
        primary_contact_id: scope.contact_id,
        subject,
        next_action_status: 'awaiting_staff_first_response',
        first_response_due_at: dueAt,
      })
      .select()
      .single();
    if (thErr) return res.status(500).json({ error: 'create_failed' });

    // First message — the body the homeowner just typed.
    await supabase.from('messages').insert({
      thread_id: thread.id,
      direction: 'inbound',
      sender_type: 'homeowner',
      sender_id: scope.contact_id,
      sender_display_name: scope.full_name || scope.email,
      channel: 'portal',
      body_text: body,
    });

    res.status(201).json({ thread });
  } catch (err) {
    console.error('[portal/messages] create failed:', err.message);
    res.status(500).json({ error: 'create_failed' });
  }
});

// ----------------------------------------------------------------------------
// POST /api/portal/messages/:threadId/reply — homeowner reply
// ----------------------------------------------------------------------------
router.post('/messages/:threadId/reply', express.json({ limit: '256kb' }), async (req, res) => {
  try {
    const scope = await resolveHomeownerScope(req);
    if (!scope) return res.status(401).json({ error: 'not_signed_in' });

    const body = String(req.body?.body_text || '').trim();
    if (!body) return res.status(400).json({ error: 'body_text_required' });

    // Verify ownership of the thread
    const { data: thread } = await supabase
      .from('homeowner_threads')
      .select('id, property_id')
      .eq('id', req.params.threadId)
      .maybeSingle();
    if (!thread) return res.status(404).json({ error: 'not_found' });
    if (!scope.property_ids.includes(thread.property_id)) return res.status(403).json({ error: 'forbidden' });

    const { data: msg, error } = await supabase
      .from('messages')
      .insert({
        thread_id: thread.id,
        direction: 'inbound',
        sender_type: 'homeowner',
        sender_id: scope.contact_id,
        sender_display_name: scope.full_name || scope.email,
        channel: 'portal',
        body_text: body,
      })
      .select()
      .single();
    if (error) return res.status(500).json({ error: 'reply_failed' });

    // Status auto-flips via the thread-activity-sync trigger:
    // homeowner reply during closure_pending -> cancels close offer
    // homeowner reply to closed thread -> reopens
    // otherwise -> awaiting_staff_followup

    res.status(201).json({ message: msg });
  } catch (err) {
    console.error('[portal/messages] reply failed:', err.message);
    res.status(500).json({ error: 'reply_failed' });
  }
});

// ----------------------------------------------------------------------------
// ============================================================================
// ARC SUBMISSIONS FROM THE PORTAL — drag-drop friendly
// ----------------------------------------------------------------------------
// Ed 2026-06-09 — Homeowners who are signed into the portal can submit an
// ARC application without re-typing their property + email. Drag-drop of
// the form PDF + photos goes through the same completeness + assessment
// pipeline as /apply/<slug> public submissions.
//
// Endpoints:
//   POST  /api/portal/arc/submit  — multipart upload (form file + photos
//                                   + JSON application_data field)
//   GET   /api/portal/arc         — list MY applications (open + past)
// ============================================================================
const portalArcUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024, files: 20 },
});

router.post('/arc/submit', portalArcUpload.any(), async (req, res) => {
  try {
    const roleCheck = await assertOwnerLikeRole(req, res);
    if (!roleCheck) return;

    // Owner-or-manager scope resolution — same helper as the rest of the
    // portal subpages. property_id can come via ?property_id or stored.
    const scoped = await resolveScopedProperty(req, supabase, roleCheck.user);
    if (scoped.error === 'property_outside_manager_scope') {
      return res.status(403).json({ error: scoped.error });
    }
    if (!scoped.property) return res.status(400).json({ error: 'no_property_scope' });
    const prop = scoped.property;
    const community = prop.communities || {};
    if (!community.id) return res.status(400).json({ error: 'community_lookup_failed' });

    // Parse application_data + service type
    const b = req.body || {};
    let applicationData = {};
    if (b.application_data) {
      try { applicationData = JSON.parse(b.application_data); }
      catch (_) { return res.status(400).json({ error: 'application_data_must_be_json' }); }
    } else {
      // Allow top-level fields too — convenient for simple drag-drop UX
      for (const k of Object.keys(b)) {
        if (!['service_type', 'description', 'signature_name', 'agreed_to_indemnification'].includes(k)) continue;
        applicationData[k] = b[k];
      }
    }

    const serviceType = (b.service_type || applicationData.service_type || 'arc').toLowerCase();

    // Find the corresponding community_service for this community + ARC.
    // Schema uses community_services to scope ARC vs fob vs clubhouse per
    // community; for ARC we expect type='arc' (or arc_application — depends
    // on community).
    const { data: service } = await supabase
      .from('community_services')
      .select('id, service_type, name')
      .eq('community_id', community.id)
      .in('service_type', ['arc', 'arc_application'])
      .limit(1)
      .maybeSingle();
    if (!service) {
      return res.status(400).json({ error: 'arc_not_configured_for_community' });
    }

    // Generate reference number — same format as the public flow
    // (e.g., "QR-ARC-2026-0001" — community-prefix + type + year + counter).
    // We re-use the public-side counter strategy: query existing references
    // for this community + year and increment.
    const yr = new Date().getFullYear();
    const slug = community.slug || 'COM';
    const prefix = `${slug.slice(0, 3).toUpperCase()}-ARC-${yr}-`;
    const { data: refRows } = await supabase
      .from('community_applications')
      .select('reference_number')
      .like('reference_number', `${prefix}%`)
      .order('reference_number', { ascending: false })
      .limit(1);
    let nextNum = 1;
    if (refRows && refRows[0]) {
      const match = refRows[0].reference_number.match(/-(\d+)$/);
      if (match) nextNum = parseInt(match[1], 10) + 1;
    }
    const reference = `${prefix}${String(nextNum).padStart(4, '0')}`;

    // Look up portal user for submitter info
    const { portalUserId } = resolvePortalUser(req);
    const { data: pu } = await supabase
      .from('portal_users')
      .select('full_name, email')
      .eq('id', portalUserId)
      .maybeSingle();
    const submitterName = applicationData.signed_by_name
      || (b.signature_name && b.signature_name.trim())
      || pu?.full_name
      || pu?.email
      || 'Portal Homeowner';
    const submitterEmail = pu?.email || 'homeowner@unknown.invalid';

    // Stamp signature into application_data (same shape as public flow)
    applicationData.signature = {
      signed_by_name: submitterName,
      signed_at: new Date().toISOString(),
      agreed_to_indemnification: String(b.agreed_to_indemnification || '').toLowerCase() === 'true',
      source: 'portal_drag_drop',
    };

    // Insert as draft, will flip to incomplete/pending_review after
    // completeness check
    const { data: app, error: insErr } = await supabase
      .from('community_applications')
      .insert({
        management_company_id: BEDROCK_MGMT_CO_ID,
        community_id: community.id,
        community_service_id: service.id,
        reference_number: reference,
        service_type: serviceType,
        submitter_name: submitterName,
        submitter_email: submitterEmail,
        property_address: prop.street_address,
        application_data: applicationData,
        final_status: 'draft',
        submitted_at: new Date().toISOString(),
        client_ip: (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim() || null,
        user_agent: req.headers['user-agent'] || null,
      })
      .select()
      .single();
    if (insErr) throw insErr;

    // Save uploaded files (form PDF and/or photos) to storage
    const files = req.files || [];
    const savedAttachments = [];
    for (const f of files) {
      try {
        const isPhoto = /^image\//i.test(f.mimetype);
        const isPdf = /pdf$/i.test(f.mimetype) || /\.pdf$/i.test(f.originalname || '');
        if (!isPhoto && !isPdf) continue;
        const safeName = (f.originalname || 'upload').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80) || 'upload';
        const storagePath = `applications/${app.id}/${Date.now()}_${safeName}`;
        const { error: stErr } = await supabase.storage
          .from('documents')
          .upload(storagePath, f.buffer, { contentType: f.mimetype, upsert: false });
        if (stErr) { console.warn('[portal/arc] storage upload failed:', stErr.message); continue; }
        const { data: attRow } = await supabase.from('application_attachments').insert({
          application_id: app.id,
          attachment_type: isPdf ? 'application_form' : 'photo_current',
          file_path: storagePath,
          original_filename: f.originalname,
          file_size_bytes: f.size,
          file_mime_type: f.mimetype,
        }).select('id').single();
        savedAttachments.push({
          id: attRow?.id,
          name: f.originalname,
          kind: isPdf ? 'application_form' : 'photo_current',
          mime: f.mimetype,
        });
      } catch (e) {
        console.warn('[portal/arc] attachment record failed:', e.message);
      }
    }

    // Run completeness check
    const { checkCompleteness } = require('../lib/applications/completeness');
    const completeness = checkCompleteness({
      service_type: serviceType,
      application_data: applicationData,
      attachments: savedAttachments,
    });

    const stagedStatus = completeness.passed ? 'pending_review' : 'incomplete';
    await supabase
      .from('community_applications')
      .update({
        completeness_passed: completeness.passed,
        completeness_checked_at: new Date().toISOString(),
        completeness_issues: completeness.issues,
        completeness_message: completeness.message,
        final_status: stagedStatus,
      })
      .eq('id', app.id);

    // Audit
    try {
      await supabase.from('application_state_log').insert({
        application_id: app.id,
        from_status: 'draft',
        to_status: stagedStatus,
        actor_kind: 'homeowner',
        actor_id: portalUserId,
        actor_display_name: submitterName,
        reason: completeness.passed ? 'completeness_passed' : 'completeness_failed',
        metadata: { source: 'portal_drag_drop', files: savedAttachments.length },
      });
    } catch (_) {}

    res.json({
      ok: true,
      reference_number: reference,
      application_id: app.id,
      status_url: `/apply/status/${encodeURIComponent(reference)}`,
      receipt: {
        kind: completeness.passed ? 'received' : 'needs_more',
        title: completeness.passed ? 'We received your application' : 'Almost there — we need a little more',
        message: completeness.message,
        submitted_at_iso: app.submitted_at,
        submitted_at_human: new Date(app.submitted_at).toLocaleString('en-US', {
          timeZone: 'America/Chicago', dateStyle: 'long', timeStyle: 'short',
        }) + ' Central',
        issues: completeness.passed ? null : completeness.issues,
      },
      files_uploaded: savedAttachments.length,
    });
  } catch (err) {
    console.error('[portal/arc/submit] failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ============================================================================
// ACC COMMITTEE REVIEW ENDPOINTS (Phase 1C)
// ----------------------------------------------------------------------------
// Portal user with contact_id matching a community_arc_committee row sees a
// queue of applications awaiting their vote. Reviewers see only the
// application package (form + photos) + the proposed decision letter — never
// Bedrock's internal multi-persona AI analysis.
// ============================================================================

// GET /api/portal/acc-reviews — list applications I need to vote on
router.get('/acc-reviews', async (req, res) => {
  try {
    const { portalUserId } = resolvePortalUser(req);
    if (!portalUserId) return res.status(401).json({ error: 'not_signed_in' });
    const { data: pu } = await supabase
      .from('portal_users')
      .select('contact_id, email')
      .eq('id', portalUserId)
      .maybeSingle();
    if (!pu?.contact_id) return res.json({ applications: [] });

    // Find committees this user serves on
    const { data: committees } = await supabase
      .from('community_arc_committee')
      .select('community_id, is_chair')
      .eq('contact_id', pu.contact_id)
      .eq('is_active', true)
      .is('removed_at', null);
    const communityIds = (committees || []).map(c => c.community_id);
    if (!communityIds.length) return res.json({ applications: [] });

    // Pull applications in pending_committee_review for those communities
    const { data: apps } = await supabase
      .from('community_applications')
      .select(`
        id, reference_number, service_type, property_address, submitter_name,
        submitted_at, forwarded_to_committee_at, final_status,
        community:communities(id, name, slug)
      `)
      .in('community_id', communityIds)
      .eq('final_status', 'pending_committee_review')
      .order('forwarded_to_committee_at', { ascending: true })
      .limit(100);

    // Exclude apps I've already voted on
    const appIds = (apps || []).map(a => a.id);
    let myVotes = [];
    if (appIds.length) {
      const { data } = await supabase
        .from('application_committee_votes')
        .select('application_id, vote, voted_at')
        .eq('committee_member_contact_id', pu.contact_id)
        .in('application_id', appIds);
      myVotes = data || [];
    }
    const votedSet = new Set(myVotes.map(v => v.application_id));

    res.json({
      applications: (apps || []).map(a => ({
        ...a,
        already_voted: votedSet.has(a.id),
        my_vote: myVotes.find(v => v.application_id === a.id)?.vote || null,
      })),
    });
  } catch (err) {
    console.error('[portal/acc-reviews] failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// GET /api/portal/acc-reviews/:appId — load the review package
router.get('/acc-reviews/:appId', async (req, res) => {
  try {
    const { portalUserId } = resolvePortalUser(req);
    if (!portalUserId) return res.status(401).json({ error: 'not_signed_in' });
    const { data: pu } = await supabase
      .from('portal_users')
      .select('contact_id, email, full_name')
      .eq('id', portalUserId)
      .maybeSingle();
    if (!pu?.contact_id) return res.status(403).json({ error: 'no_contact_linkage' });

    const { data: app, error } = await supabase
      .from('community_applications')
      .select(`
        id, reference_number, service_type, property_address, submitter_name,
        submitted_at, forwarded_to_committee_at, final_status, application_data,
        decision_letter_html, decision_letter_subject,
        community_id, community:communities(id, name, slug)
      `)
      .eq('id', req.params.appId)
      .maybeSingle();
    if (error) throw error;
    if (!app) return res.status(404).json({ error: 'application_not_found' });

    // Authorize — must be an active committee member for this community
    const { data: scope } = await supabase
      .from('community_arc_committee')
      .select('id, is_chair')
      .eq('community_id', app.community_id)
      .eq('contact_id', pu.contact_id)
      .eq('is_active', true)
      .is('removed_at', null)
      .maybeSingle();
    if (!scope) return res.status(403).json({ error: 'not_authorized_to_review' });

    // Attachments (homeowner's submission package)
    const { data: attachments } = await supabase
      .from('application_attachments')
      .select('id, attachment_type, original_filename, file_path, file_mime_type, file_size_bytes')
      .eq('application_id', app.id);

    // Generate signed URLs for each attachment for secure viewing
    const attachmentsWithUrls = await Promise.all((attachments || []).map(async (a) => {
      try {
        const { data: signed } = await supabase.storage
          .from('documents')
          .createSignedUrl(a.file_path, 3600);
        return { ...a, signed_url: signed?.signedUrl || null };
      } catch (_) {
        return { ...a, signed_url: null };
      }
    }));

    // My existing vote (if any)
    const { data: myVote } = await supabase
      .from('application_committee_votes')
      .select('vote, comments, voted_at')
      .eq('application_id', app.id)
      .eq('committee_member_contact_id', pu.contact_id)
      .maybeSingle();

    res.json({
      application: {
        id: app.id,
        reference_number: app.reference_number,
        service_type: app.service_type,
        property_address: app.property_address,
        submitter_name: app.submitter_name,
        submitted_at: app.submitted_at,
        forwarded_to_committee_at: app.forwarded_to_committee_at,
        application_data: app.application_data,
        community: app.community,
      },
      // Reviewer sees the proposed letter — they verify Bedrock's analysis
      // matches the application materials.
      proposed_decision_letter_html: app.decision_letter_html,
      proposed_decision_subject: app.decision_letter_subject,
      attachments: attachmentsWithUrls,
      my_vote: myVote || null,
      reviewer: { contact_id: pu.contact_id, full_name: pu.full_name, is_chair: scope.is_chair },
    });
  } catch (err) {
    console.error('[portal/acc-reviews/:id] failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// POST /api/portal/acc-reviews/:appId/vote — cast or update my vote
router.post('/acc-reviews/:appId/vote', express.json({ limit: '16kb' }), async (req, res) => {
  try {
    const { portalUserId } = resolvePortalUser(req);
    if (!portalUserId) return res.status(401).json({ error: 'not_signed_in' });
    const { vote, comments } = req.body || {};
    if (!['approve','deny','request_more_info','abstain'].includes(vote)) {
      return res.status(400).json({ error: 'invalid_vote' });
    }
    const { data: pu } = await supabase
      .from('portal_users')
      .select('contact_id, email, full_name')
      .eq('id', portalUserId)
      .maybeSingle();
    if (!pu?.contact_id) return res.status(403).json({ error: 'no_contact_linkage' });

    // Load app + community workflow
    const { data: app } = await supabase
      .from('community_applications')
      .select('id, community_id, final_status, community:communities(id, name, slug, arc_approval_workflow, arc_acc_min_approvals)')
      .eq('id', req.params.appId)
      .maybeSingle();
    if (!app) return res.status(404).json({ error: 'application_not_found' });
    if (app.final_status !== 'pending_committee_review') {
      return res.status(409).json({ error: 'application_not_in_committee_review' });
    }

    // Verify reviewer is on the committee
    const { data: scope } = await supabase
      .from('community_arc_committee')
      .select('id')
      .eq('community_id', app.community_id)
      .eq('contact_id', pu.contact_id)
      .eq('is_active', true)
      .is('removed_at', null)
      .maybeSingle();
    if (!scope) return res.status(403).json({ error: 'not_authorized' });

    // Upsert vote
    const { error: voteErr } = await supabase
      .from('application_committee_votes')
      .upsert({
        application_id: app.id,
        committee_member_contact_id: pu.contact_id,
        vote,
        comments: comments || null,
        voted_at: new Date().toISOString(),
        vote_source: 'portal',
        ip_address: req.ip || null,
      }, { onConflict: 'application_id,committee_member_contact_id' });
    if (voteErr) throw voteErr;

    // Tally + evaluate quorum
    const { getActiveCommitteeMembers, tallyVotes, evaluateQuorum } = require('../lib/applications/committee');
    const members = await getActiveCommitteeMembers(supabase, app.community_id);
    const { counts } = await tallyVotes(supabase, app.id);
    const quorum = evaluateQuorum({
      workflow: app.community.arc_approval_workflow,
      minApprovals: app.community.arc_acc_min_approvals || 0,
      activeMemberCount: members.length,
      counts,
    });

    // If quorum reached approve → auto-send to homeowner
    // If denial → stay in pending_committee_review (Bedrock staff decides)
    // If pending → no further action
    let triggered = null;
    if (quorum.outcome === 'approved') {
      try {
        // Internal callback to send-decision endpoint with skip_committee=true
        // so it bypasses this check and actually delivers the email.
        const finalStatus = 'approved';
        const internalReq = {
          params: { id: app.id },
          body: { final_status: finalStatus, skip_committee: true },
          headers: req.headers,
          ip: req.ip,
        };
        // We can't call the endpoint directly without auth machinery; instead
        // mark the application back to pending_send and let Bedrock staff
        // confirm + click send. The committee approved; staff still owns the
        // physical send button (the audit chain is cleaner this way).
        await supabase
          .from('community_applications')
          .update({ final_status: 'pending_send' })
          .eq('id', app.id);
        triggered = { action: 'quorum_met_pending_send' };
      } catch (e) {
        console.warn('[portal/acc-reviews/vote] quorum trigger failed (non-fatal):', e.message);
      }
    }

    // Audit
    try {
      await supabase.from('application_state_log').insert({
        application_id: app.id,
        from_status: 'pending_committee_review',
        to_status: triggered ? 'pending_send' : 'pending_committee_review',
        actor_kind: 'committee_member',
        actor_id: pu.contact_id,
        actor_display_name: pu.full_name || pu.email,
        reason: `vote_${vote}`,
        metadata: { counts, quorum_outcome: quorum.outcome, quorum_reason: quorum.reason },
      });
    } catch (_) {}

    res.json({
      ok: true,
      vote,
      counts,
      quorum,
      triggered,
    });
  } catch (err) {
    console.error('[portal/acc-reviews/vote] failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// GET /api/portal/arc — list this portal user's own ARC applications
router.get('/arc', async (req, res) => {
  try {
    const roleCheck = await assertOwnerLikeRole(req, res);
    if (!roleCheck) return;

    const scoped = await resolveScopedProperty(req, supabase, roleCheck.user);
    if (scoped.error === 'property_outside_manager_scope') {
      return res.status(403).json({ error: scoped.error });
    }
    const prop = scoped.property;
    const filters = supabase
      .from('community_applications')
      .select(`
        id, reference_number, service_type, property_address, submitter_email,
        submitted_at, completeness_passed, completeness_message,
        final_status, final_decided_at, decision_letter_sent_at,
        assessment_summary
      `)
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .order('submitted_at', { ascending: false })
      .limit(50);

    // Two match criteria: property OR signed-in user's email. Either qualifies
    // as "your" application since homeowners often submit from multiple emails.
    let query = filters;
    if (prop?.id) {
      query = query.eq('property_address', prop.street_address);
    } else {
      // No property in scope — fall back to email match
      const { portalUserId } = resolvePortalUser(req);
      const { data: pu } = await supabase
        .from('portal_users')
        .select('email')
        .eq('id', portalUserId)
        .maybeSingle();
      if (!pu?.email) return res.json({ applications: [] });
      query = query.ilike('submitter_email', pu.email);
    }
    const { data: apps, error } = await query;
    if (error) throw error;

    res.json({ applications: apps || [] });
  } catch (err) {
    console.error('[portal/arc] list failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ----------------------------------------------------------------------------
// VENDOR DIRECTORY — Ed 2026-06-11 evening
// ----------------------------------------------------------------------------
// Foundation for the homeowner-data-only vendor directory described in
// memory project_vendor_directory_pricing_intelligence. Three endpoints
// at this layer:
//
//   GET  /vendor-categories        — public list of categories (no auth)
//   POST /vendor-experiences       — homeowner submits an experience
//   GET  /vendor-experiences/mine  — homeowner sees their own submissions
//
// Display endpoints (community-scoped lists, vendor detail pages) come in
// a later phase once we have data to display. The priority right now is
// the data-collection mechanism — empty UIs train homeowners that the
// feature is broken.
//
// Policy reminders baked into the code:
//   - No "rating" column. would_hire_again BOOLEAN is the only signal.
//   - Vendor names are free-text. We don't pre-curate a vendor list.
//   - Submissions are PERMANENT. No edit-after-submit, no delete. Per
//     strategy: "BAM does not edit, remove, or influence vendor ratings."
//     If we ever need a soft-hide for abuse, add it as an admin-only flag
//     column LATER, not exposed to the submitter.
// ----------------------------------------------------------------------------

router.get('/vendor-categories', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('vendor_categories')
      .select('id, slug, label, display_order')
      .eq('active', true)
      .order('display_order', { ascending: true })
      .order('label', { ascending: true });
    if (error) return res.status(500).json({ error: safeErrorMessage(error) });
    res.json({ categories: data || [] });
  } catch (err) {
    console.error('[portal.vendor-categories]', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

router.post('/vendor-experiences', express.json({ limit: '32kb' }), async (req, res) => {
  try {
    const roleCheck = await assertOwnerLikeRole(req, res);
    if (!roleCheck) return;
    const user = roleCheck.user;

    // Resolve the user's property to pin the community context. We don't
    // trust a client-supplied community_id — the experience belongs to the
    // submitter's home community.
    const scoped = await resolveScopedProperty(req, supabase, user);
    if (!scoped.property || !scoped.property.community_id) {
      return res.status(403).json({
        error: 'no_property_scope',
        message: 'Vendor experiences can only be submitted by homeowners linked to a property in a Bedrock-managed community.',
      });
    }

    const body = req.body || {};
    const required = {
      vendor_name:        String(body.vendor_name || '').trim(),
      vendor_category_id: String(body.vendor_category_id || '').trim(),
      would_hire_again:   body.would_hire_again,
    };
    if (!required.vendor_name)        return res.status(400).json({ error: 'vendor_name_required' });
    if (!required.vendor_category_id) return res.status(400).json({ error: 'vendor_category_id_required' });
    if (typeof required.would_hire_again !== 'boolean') {
      return res.status(400).json({ error: 'would_hire_again_required', message: 'Must be true or false.' });
    }

    // Optional fields — validate shape but accept null/missing
    const project_type    = body.project_type ? String(body.project_type).trim().slice(0, 500) : null;
    const did_well        = body.did_well ? String(body.did_well).trim().slice(0, 1500) : null;
    const could_improve   = body.could_improve ? String(body.could_improve).trim().slice(0, 1500) : null;

    // Price — accept dollars from the client, store cents server-side. Reject
    // negative / NaN / wildly-large values.
    let price_paid_cents = null;
    if (body.price_paid_dollars != null && body.price_paid_dollars !== '') {
      const dollars = Number(body.price_paid_dollars);
      if (!Number.isFinite(dollars) || dollars < 0 || dollars > 5000000) {
        return res.status(400).json({ error: 'price_paid_dollars_invalid', message: 'Enter a price between $0 and $5,000,000 (or leave blank).' });
      }
      price_paid_cents = Math.round(dollars * 100);
    }

    const completed_month = body.completed_month != null && body.completed_month !== ''
      ? Number(body.completed_month) : null;
    const completed_year  = body.completed_year != null && body.completed_year !== ''
      ? Number(body.completed_year) : null;
    if (completed_month != null && !(completed_month >= 1 && completed_month <= 12)) {
      return res.status(400).json({ error: 'completed_month_invalid' });
    }
    if (completed_year != null && !(completed_year >= 2020 && completed_year <= 2050)) {
      return res.status(400).json({ error: 'completed_year_invalid' });
    }

    const { data: inserted, error: insErr } = await supabase
      .from('vendor_experiences')
      .insert({
        community_id:        scoped.property.community_id,
        portal_user_id:      user.id,
        property_id:         scoped.property.id,
        vendor_name:         required.vendor_name.slice(0, 200),
        vendor_category_id:  required.vendor_category_id,
        project_type,
        price_paid_cents,
        would_hire_again:    required.would_hire_again,
        did_well,
        could_improve,
        completed_month,
        completed_year,
      })
      .select('id, vendor_name, submitted_at')
      .single();
    if (insErr) {
      console.error('[portal.vendor-experiences] insert failed:', insErr.message);
      return res.status(500).json({ error: safeErrorMessage(insErr) });
    }

    res.json({
      ok: true,
      experience: inserted,
      message: 'Thanks — submission recorded. Your neighbors will see this when they look up this vendor or category.',
    });
  } catch (err) {
    console.error('[portal.vendor-experiences] failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

router.get('/vendor-experiences/mine', async (req, res) => {
  try {
    const roleCheck = await assertOwnerLikeRole(req, res);
    if (!roleCheck) return;
    const user = roleCheck.user;

    const { data, error } = await supabase
      .from('vendor_experiences')
      .select(`
        id, vendor_name, project_type, price_paid_cents, would_hire_again,
        did_well, could_improve, completed_month, completed_year, submitted_at,
        vendor_categories:vendor_category_id (slug, label)
      `)
      .eq('portal_user_id', user.id)
      .order('submitted_at', { ascending: false })
      .limit(100);
    if (error) return res.status(500).json({ error: safeErrorMessage(error) });
    res.json({ experiences: data || [] });
  } catch (err) {
    console.error('[portal.vendor-experiences.mine]', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ----------------------------------------------------------------------------
// DISPLAY ENDPOINTS — Ed 2026-06-11 evening, focus-group prep build.
//
//   GET /vendor-directory/feed            — recency-ordered vendor cards
//                                            scoped to user's community
//   GET /vendor-directory/categories      — categories with counts
//   GET /vendor-directory/vendor          — full detail for one vendor
//                                            ?name=Carlos+Painting&category_id=xxx
//
// All scoped to the authenticated portal user's community via
// resolveScopedProperty — never trusts a client-supplied community_id.
//
// Aggregation policy (per project_vendor_directory_pricing_intelligence):
//   - Vendor "card" = group of submissions sharing same vendor_name +
//     category_id within the same community. Exact-match grouping for v1
//     (Carlos Painting vs Carlos Painting LLC are separate vendors). Name
//     normalization is a known future feature.
//   - Pricing summary requires 5+ submissions to display (avoids
//     "one neighbor's $4,800 outlier looks authoritative").
//   - "% would hire again" is rounded over ALL submissions for that
//     vendor — bad submissions stay permanently, no editorial removal.
//   - Recency weighting is NOT applied in v1 — feed shows all; sorting
//     by submitted_at DESC gives the natural recency-first behavior the
//     strategy memo describes.
// ----------------------------------------------------------------------------

function _slugifyVendorKey(vendor_name, vendor_category_id) {
  // Group-by key for aggregating submissions into "vendor cards." Same vendor
  // name in two different categories = two different cards (a handyman doing
  // landscaping is treated separately from a handyman doing electrical).
  return String(vendor_name || '').toLowerCase().trim() + '|' + String(vendor_category_id || '');
}

function _aggregateVendorCards(rows, opts = {}) {
  const minPricingThreshold = opts.minPricingThreshold || 5;
  const groups = new Map();
  for (const r of rows) {
    const key = _slugifyVendorKey(r.vendor_name, r.vendor_category_id);
    if (!groups.has(key)) {
      groups.set(key, {
        vendor_name:   r.vendor_name,
        category:      r.vendor_categories || null,
        submissions:   [],
      });
    }
    groups.get(key).submissions.push(r);
  }
  const cards = [];
  for (const g of groups.values()) {
    // Sort each vendor's submissions newest-first for any display surface.
    g.submissions.sort((a, b) => new Date(b.submitted_at) - new Date(a.submitted_at));
    const n = g.submissions.length;
    const wouldHireCount = g.submissions.filter((s) => s.would_hire_again === true).length;
    const pctWouldHire = Math.round((wouldHireCount / n) * 100);
    const mostRecent = g.submissions[0];
    // Pricing summary — group by project_type, only show ranges when 5+
    // for the same project type. Avoids one outlier becoming "the price."
    const pricingByType = {};
    for (const s of g.submissions) {
      const pt = (s.project_type || 'General work').slice(0, 60);
      if (!pricingByType[pt]) pricingByType[pt] = [];
      if (s.price_paid_cents != null) pricingByType[pt].push(s.price_paid_cents);
    }
    const pricing_summary = [];
    for (const [pt, prices] of Object.entries(pricingByType)) {
      if (prices.length >= minPricingThreshold) {
        prices.sort((a, b) => a - b);
        pricing_summary.push({
          project_type: pt,
          n: prices.length,
          min_cents: prices[0],
          max_cents: prices[prices.length - 1],
          median_cents: prices[Math.floor(prices.length / 2)],
        });
      }
    }
    cards.push({
      vendor_name: g.vendor_name,
      category:    g.category,
      n_submissions: n,
      pct_would_hire_again: pctWouldHire,
      most_recent_at: mostRecent.submitted_at,
      most_recent_project_type: mostRecent.project_type || null,
      pricing_summary,
      submissions: g.submissions,
    });
  }
  return cards;
}

router.get('/vendor-directory/feed', async (req, res) => {
  try {
    const roleCheck = await assertOwnerLikeRole(req, res);
    if (!roleCheck) return;
    const scoped = await resolveScopedProperty(req, supabase, roleCheck.user);
    if (!scoped.property || !scoped.property.community_id) {
      return res.json({ vendors: [], community: null, empty_reason: 'no_property_scope' });
    }

    // Optional ?category_id= filter — when the homeowner taps a category chip.
    const categoryFilter = req.query.category_id ? String(req.query.category_id) : null;

    let q = supabase
      .from('vendor_experiences')
      .select(`
        id, vendor_name, project_type, price_paid_cents, would_hire_again,
        did_well, could_improve, completed_month, completed_year, submitted_at,
        vendor_category_id, vendor_categories:vendor_category_id (id, slug, label)
      `)
      .eq('community_id', scoped.property.community_id)
      .order('submitted_at', { ascending: false })
      .limit(500);
    if (categoryFilter) q = q.eq('vendor_category_id', categoryFilter);
    const { data, error } = await q;
    if (error) return res.status(500).json({ error: safeErrorMessage(error) });

    const cards = _aggregateVendorCards(data || []);
    // Cards arrive grouped — sort by most-recent-submission across vendors.
    cards.sort((a, b) => new Date(b.most_recent_at) - new Date(a.most_recent_at));
    // Strip the full submission list from feed cards — feed is a summary view.
    // Detail endpoint returns the full submissions.
    const feed = cards.map((c) => ({ ...c, submissions: undefined }));

    res.json({
      vendors: feed,
      community_id: scoped.property.community_id,
    });
  } catch (err) {
    console.error('[portal.vendor-directory.feed]', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

router.get('/vendor-directory/categories', async (req, res) => {
  try {
    const roleCheck = await assertOwnerLikeRole(req, res);
    if (!roleCheck) return;
    const scoped = await resolveScopedProperty(req, supabase, roleCheck.user);
    if (!scoped.property || !scoped.property.community_id) {
      return res.json({ categories: [], community: null });
    }

    // Get all active categories
    const { data: cats } = await supabase
      .from('vendor_categories')
      .select('id, slug, label, display_order')
      .eq('active', true)
      .order('display_order', { ascending: true });

    // Get submission counts per category in this community
    const { data: experiences } = await supabase
      .from('vendor_experiences')
      .select('vendor_category_id, vendor_name')
      .eq('community_id', scoped.property.community_id);

    const submissionCountByCategory = new Map();
    const distinctVendorsByCategory = new Map();
    for (const e of experiences || []) {
      submissionCountByCategory.set(e.vendor_category_id, (submissionCountByCategory.get(e.vendor_category_id) || 0) + 1);
      const key = e.vendor_category_id;
      if (!distinctVendorsByCategory.has(key)) distinctVendorsByCategory.set(key, new Set());
      distinctVendorsByCategory.get(key).add(String(e.vendor_name || '').toLowerCase().trim());
    }

    const enriched = (cats || []).map((c) => ({
      ...c,
      n_submissions: submissionCountByCategory.get(c.id) || 0,
      n_vendors: distinctVendorsByCategory.has(c.id) ? distinctVendorsByCategory.get(c.id).size : 0,
    }));
    res.json({ categories: enriched });
  } catch (err) {
    console.error('[portal.vendor-directory.categories]', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

router.get('/vendor-directory/vendor', async (req, res) => {
  try {
    const roleCheck = await assertOwnerLikeRole(req, res);
    if (!roleCheck) return;
    const scoped = await resolveScopedProperty(req, supabase, roleCheck.user);
    if (!scoped.property || !scoped.property.community_id) {
      return res.status(403).json({ error: 'no_property_scope' });
    }

    const vendorName = String(req.query.name || '').trim();
    const categoryId = String(req.query.category_id || '').trim();
    if (!vendorName) return res.status(400).json({ error: 'name_required' });
    if (!categoryId) return res.status(400).json({ error: 'category_id_required' });

    // Case-insensitive exact match on vendor_name + exact category + community.
    // Future: normalize vendor names so "Carlos Painting" and "Carlos Painting LLC"
    // merge. For v1 the operator submits exact strings as-typed.
    const { data, error } = await supabase
      .from('vendor_experiences')
      .select(`
        id, vendor_name, project_type, price_paid_cents, would_hire_again,
        did_well, could_improve, completed_month, completed_year, submitted_at,
        vendor_categories:vendor_category_id (id, slug, label)
      `)
      .eq('community_id', scoped.property.community_id)
      .eq('vendor_category_id', categoryId)
      .ilike('vendor_name', vendorName)
      .order('submitted_at', { ascending: false });
    if (error) return res.status(500).json({ error: safeErrorMessage(error) });

    if (!data || data.length === 0) return res.status(404).json({ error: 'vendor_not_found' });

    const cards = _aggregateVendorCards(data, { minPricingThreshold: 5 });
    if (cards.length === 0) return res.status(404).json({ error: 'vendor_not_found' });

    res.json({ vendor: cards[0] });
  } catch (err) {
    console.error('[portal.vendor-directory.vendor]', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ----------------------------------------------------------------------------
// GET /api/portal/builder/master-plan-approvals
// Builder-facing read: the builder's currently-approved master plans grouped by
// community, plus the latest grouped approval letter (download link) per
// community. This is what makes a builder's approved plan library VISIBLE in
// the portal — Teresa @ Lennar reported (2026-06-30) she could not see her
// master-plan approvals. Scoped to the logged-in builder's own companies only.
// ----------------------------------------------------------------------------
router.get('/builder/master-plan-approvals', async (req, res) => {
  try {
    const { portalUserId } = resolvePortalUser(req);
    if (!portalUserId) return res.status(401).json({ error: 'not signed in' });
    const { data: user } = await supabase
      .from('portal_users')
      .select('id, role, status, email')
      .eq('id', portalUserId)
      .single();
    if (!user || user.status === 'revoked') return res.status(401).json({ error: 'session no longer valid' });

    let companies = [];
    const isManager = user.role === 'manager' && user.status === 'active';
    const asBuilderId = (req.query.as_builder_id || '').toString().trim() || null;

    if (user.role === 'builder') {
      const { data: builderLinks } = await supabase
        .from('portal_user_builders')
        .select('builder_companies(id, company_name)')
        .eq('portal_user_id', user.id)
        .is('revoked_at', null);
      companies = (builderLinks || []).map((b) => b.builder_companies).filter(Boolean);
    } else if (isManager && asBuilderId) {
      // Manager preview — same scope check as my-submissions (migration 227).
      const { data: scopeRows } = await supabase
        .from('portal_manager_builder_scope')
        .select('builder_company_id')
        .eq('portal_user_id', portalUserId)
        .is('revoked_at', null);
      const scope = scopeRows || [];
      const inScope = scope.some((s) => s.builder_company_id === null) || scope.some((s) => s.builder_company_id === asBuilderId);
      if (!inScope) return res.status(403).json({ error: 'builder_not_in_manager_scope' });
      const { data: bc } = await supabase
        .from('builder_companies')
        .select('id, company_name')
        .eq('id', asBuilderId)
        .maybeSingle();
      if (!bc) return res.status(404).json({ error: 'builder_not_found' });
      companies = [bc];
    } else if (isManager && !asBuilderId) {
      // Manager without a builder picked — nothing to scope to; UI hides section.
      return res.json({ ok: true, groups: [], manager_picker_required: true });
    } else {
      return res.status(403).json({ error: 'builder access required' });
    }

    if (!companies.length) return res.json({ ok: true, groups: [] });
    const companyIds = companies.map((c) => c.id);
    const companyNameById = new Map(companies.map((c) => [c.id, c.company_name]));

    // Approved (non-retired) master plans for these builders, with the
    // community on each approval row.
    const { data: rows, error: rErr } = await supabase
      .from('master_plans')
      .select('id, builder_company_id, plan_number, plan_name, elevation, square_footage, stories, status, master_plan_community_approvals!inner(community_id, retired_at, communities:community_id(id, name, slug))')
      .in('builder_company_id', companyIds)
      .is('master_plan_community_approvals.retired_at', null)
      .neq('status', 'retired')
      .limit(2000);
    if (rErr) throw rErr;

    // Group by (builder_company, community).
    const { groupMasterPlansForLetter } = require('../lib/builder_letter');
    const groupsMap = new Map();
    for (const row of (rows || [])) {
      const approvals = Array.isArray(row.master_plan_community_approvals)
        ? row.master_plan_community_approvals
        : (row.master_plan_community_approvals ? [row.master_plan_community_approvals] : []);
      for (const ap of approvals) {
        if (!ap || ap.retired_at) continue;
        const comm = ap.communities;
        if (!comm) continue;
        const key = `${row.builder_company_id}::${comm.id}`;
        if (!groupsMap.has(key)) {
          groupsMap.set(key, {
            community: { id: comm.id, name: comm.name, slug: comm.slug },
            builder_company_id: row.builder_company_id,
            builder_company_name: companyNameById.get(row.builder_company_id) || '',
            _rows: [],
          });
        }
        groupsMap.get(key)._rows.push({
          plan_number: row.plan_number,
          plan_name: row.plan_name,
          elevation: row.elevation,
          square_footage: row.square_footage,
          stories: row.stories,
        });
      }
    }

    // Latest approval letter per (builder, community) for the download link.
    const { data: letters } = await supabase
      .from('master_plan_approval_letters')
      .select('id, community_id, builder_company_id, reference_number, generated_at, email_sent_at, letter_pdf_path')
      .in('builder_company_id', companyIds)
      .order('generated_at', { ascending: false })
      .limit(1000);
    const latestLetterByKey = new Map();
    for (const l of (letters || [])) {
      const k = `${l.builder_company_id}::${l.community_id}`;
      if (!latestLetterByKey.has(k)) latestLetterByKey.set(k, l);
    }

    const groups = await Promise.all(Array.from(groupsMap.values()).map(async (g) => {
      const plans = groupMasterPlansForLetter(g._rows);
      const key = `${g.builder_company_id}::${g.community.id}`;
      const l = latestLetterByKey.get(key);
      let letter = null;
      if (l) {
        let download_url = null;
        if (l.letter_pdf_path) {
          const { data: signed } = await supabase.storage.from('documents').createSignedUrl(l.letter_pdf_path, 60 * 60);
          download_url = signed?.signedUrl || null;
        }
        letter = {
          reference_number: l.reference_number,
          generated_at: l.generated_at,
          sent: !!l.email_sent_at,
          download_url,
        };
      }
      return {
        community: g.community,
        builder_company_name: g.builder_company_name,
        plan_count: plans.length,
        elevation_count: plans.reduce((n, p) => n + p.elevations.length, 0),
        plans,
        letter,
      };
    }));
    // Stable order: by community name.
    groups.sort((a, b) => String(a.community.name || '').localeCompare(String(b.community.name || '')));

    res.json({ ok: true, groups });
  } catch (err) {
    console.error('[portal.builder.master-plan-approvals]', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

module.exports = {
  router,
  // Auth helper — used by builder-applications dashboard to authenticate
  // the same portal-user cookie that homeowners use. Builder reviewers are
  // linked to builder_companies via the portal_user_builders join table
  // (migration 080). Exported here so the linkage table is the single
  // source of truth for "what does this portal user have access to."
  resolvePortalUser,
  resolveBuilderLandingUrl,
};
