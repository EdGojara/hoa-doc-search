// =============================================================================
// Portal Admin — manage portal users, invitations, scope
// =============================================================================
// Mounted at /api/portal-admin in server.js.
//
// Today's job (project_portal_release_gates.md): manage WHO will have portal
// access, define their scope (which communities for boards, which properties
// for homeowners), generate magic-link invites. Actual auth enforcement on
// the portals comes in a follow-up commit; until then the existing staff
// gate still protects the portals — these tables just hold the data the
// auth layer will use when it ships.
//
// Endpoints:
//   GET    /api/portal-admin/users                       list portal users (with scope counts)
//   POST   /api/portal-admin/users                       create + invite
//   PATCH  /api/portal-admin/users/:id                   edit name / notes / status
//   POST   /api/portal-admin/users/:id/revoke            mark revoked (preserves audit trail)
//   POST   /api/portal-admin/users/:id/magic-link        generate fresh magic link
//   GET    /api/portal-admin/users/:id/scope             list communities + properties this user can see
//   POST   /api/portal-admin/users/:id/grant-community   grant a community
//   POST   /api/portal-admin/users/:id/grant-property    grant a property
//   POST   /api/portal-admin/users/:id/revoke-community  revoke a community grant
//   POST   /api/portal-admin/users/:id/revoke-property   revoke a property grant
//   POST   /api/portal-admin/users/auto-grant-property   match-or-create user from contact, grant their property
// =============================================================================

const express = require('express');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { sendEmail } = require('../lib/notifications/email');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const { BEDROCK_MGMT_CO_ID } = require('../lib/company');
const { safeErrorMessage } = require('./_safe_error');

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const router = express.Router();
router.use(express.json({ limit: '256kb' }));

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function makeToken() {
  return crypto.randomBytes(32).toString('hex');
}

// The name of the first granted community (for the invitation email header).
async function _firstCommunityName(communityIds) {
  const id = Array.isArray(communityIds) ? communityIds[0] : null;
  if (!id) return null;
  const { data } = await supabase.from('communities').select('name').eq('id', id).maybeSingle();
  return data ? data.name : null;
}

function magicLinkUrl(req, token) {
  // Construct an absolute URL the email can carry. Render terminates SSL at
  // the edge; respect x-forwarded-proto.
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
  } catch (e) { /* audit failure is non-fatal */ }
}

// ----------------------------------------------------------------------------
// GET /api/portal-admin/users
// Query params: role (filter), status (filter), q (email/name search)
// ----------------------------------------------------------------------------
router.get('/users', async (req, res) => {
  try {
    let q = supabase
      .from('v_portal_users_summary')
      .select('*')
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .order('invited_at', { ascending: false });

    if (req.query.role)   q = q.eq('role', req.query.role);
    if (req.query.status) q = q.eq('status', req.query.status);
    if (req.query.q) {
      const like = `%${String(req.query.q).replace(/[%_]/g, '')}%`;
      q = q.or(`email.ilike.${like},full_name.ilike.${like}`);
    }

    const { data, error } = await q;
    if (error) throw error;
    res.json({ users: data || [] });
  } catch (err) {
    console.error('[portal_admin] list users failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// POST /api/portal-admin/users
// Body: { email, full_name?, role, community_ids?, property_ids?,
//         send_invite?, invited_by? }
//
// Creates the portal user, optionally grants initial scope, optionally
// generates + returns a magic link the operator can copy or email.
// ----------------------------------------------------------------------------
router.post('/users', async (req, res) => {
  try {
    const { email, full_name, role, community_ids, property_ids, send_invite, email_invite, invited_by } = req.body || {};
    if (!email || !String(email).trim()) return res.status(400).json({ error: 'email is required' });
    if (!role) return res.status(400).json({ error: 'role is required' });
    const cleanEmail = String(email).toLowerCase().trim();

    // Idempotency: if a row already exists for this email, return it instead
    // of erroring out — operator can re-trigger invite link from there.
    const { data: existing } = await supabase
      .from('portal_users')
      .select('id')
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .eq('email', cleanEmail)
      .maybeSingle();

    let user;
    if (existing) {
      user = existing;
    } else {
      const insert = {
        management_company_id: BEDROCK_MGMT_CO_ID,
        email: cleanEmail,
        full_name: full_name && String(full_name).trim() || null,
        role,
        status: 'invited',
        invited_by: invited_by || null,
      };
      // If we know a contact with this email, link them
      const { data: contactMatch } = await supabase
        .from('contacts')
        .select('id')
        .eq('primary_email', cleanEmail)
        .maybeSingle();
      if (contactMatch && contactMatch.id) insert.contact_id = contactMatch.id;
      const { data: newUser, error: insErr } = await supabase
        .from('portal_users')
        .insert(insert)
        .select('id')
        .single();
      if (insErr) throw insErr;
      user = newUser;
      await logAudit('user_invited', { portal_user_id: user.id, performed_by: invited_by, notes: `role=${role}` });
    }

    // Grant initial scope
    if (Array.isArray(community_ids) && community_ids.length > 0) {
      const rows = community_ids.map((cid) => ({
        portal_user_id: user.id,
        community_id: cid,
        granted_by: invited_by || null,
      }));
      await supabase.from('portal_user_communities').upsert(rows, { onConflict: 'portal_user_id,community_id' });
    }
    if (Array.isArray(property_ids) && property_ids.length > 0) {
      const rows = property_ids.map((pid) => ({
        portal_user_id: user.id,
        property_id: pid,
        granted_by: invited_by || null,
      }));
      await supabase.from('portal_user_properties').upsert(rows, { onConflict: 'portal_user_id,property_id' });
    }

    // Generate magic link if requested
    let magicLink = null;
    if (send_invite) {
      const token = makeToken();
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days
      await supabase.from('portal_magic_links').insert({
        portal_user_id: user.id,
        token,
        purpose: 'invite',
        expires_at: expiresAt.toISOString(),
        created_by: invited_by || null,
      });
      magicLink = magicLinkUrl(req, token);
      await logAudit('magic_link_generated', { portal_user_id: user.id, performed_by: invited_by, notes: 'purpose=invite' });
    }

    // One-click invite: email the magic link (the polished branded invitation)
    // instead of leaving the operator to copy/paste it. (Ed 2026-08-14.)
    let emailed = false;
    if (magicLink && email_invite && email) {
      try {
        const communityName = await _firstCommunityName(community_ids);
        const { sendPortalInvite } = require('../lib/email/portal_invite');
        const send = await sendPortalInvite({ toEmail: email, toName: full_name, communityName, magicLink, role });
        emailed = !!(send && send.ok);
        if (emailed) await logAudit('invite_emailed', { portal_user_id: user.id, performed_by: invited_by, notes: `to=${email}` });
        else console.warn('[portal_admin] invite email not sent:', send && send.error);
      } catch (e) { console.warn('[portal_admin] invite email failed:', e.message); }
    }

    res.json({ user_id: user.id, magic_link: magicLink, emailed });
  } catch (err) {
    console.error('[portal_admin] create user failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// PATCH /api/portal-admin/users/:id
// ----------------------------------------------------------------------------
router.patch('/users/:id', async (req, res) => {
  try {
    const allowed = ['full_name', 'notes', 'status', 'role'];
    const update = {};
    for (const k of allowed) if (k in (req.body || {})) update[k] = req.body[k];
    if (Object.keys(update).length === 0) return res.status(400).json({ error: 'no updatable fields' });

    const { data, error } = await supabase
      .from('portal_users')
      .update(update)
      .eq('id', req.params.id)
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .select()
      .single();
    if (error) throw error;
    res.json({ user: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// POST /api/portal-admin/users/:id/revoke
// Marks the user revoked + revokes all active scope. Preserves the row
// for audit; doesn't delete history.
// ----------------------------------------------------------------------------
router.post('/users/:id/revoke', async (req, res) => {
  try {
    const revokedBy = (req.body && req.body.revoked_by) || null;
    const now = new Date().toISOString();

    await supabase
      .from('portal_users')
      .update({ status: 'revoked', revoked_at: now, revoked_by: revokedBy })
      .eq('id', req.params.id)
      .eq('management_company_id', BEDROCK_MGMT_CO_ID);

    await supabase
      .from('portal_user_communities')
      .update({ revoked_at: now, revoked_by: revokedBy })
      .eq('portal_user_id', req.params.id)
      .is('revoked_at', null);

    await supabase
      .from('portal_user_properties')
      .update({ revoked_at: now, revoked_by: revokedBy })
      .eq('portal_user_id', req.params.id)
      .is('revoked_at', null);

    await logAudit('user_revoked', { portal_user_id: req.params.id, performed_by: revokedBy });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// POST /api/portal-admin/users/:id/magic-link
// Generates a fresh magic link (invalidates any existing pending links).
// ----------------------------------------------------------------------------
router.post('/users/:id/magic-link', async (req, res) => {
  try {
    const purpose = (req.body && req.body.purpose) || 'login';
    const performedBy = (req.body && req.body.performed_by) || null;

    // Invalidate any unused pending links
    await supabase
      .from('portal_magic_links')
      .update({ used_at: new Date().toISOString(), used_user_agent: 'superseded_by_admin' })
      .eq('portal_user_id', req.params.id)
      .is('used_at', null);

    const token = makeToken();
    const ttlMs = purpose === 'invite' ? 7 * 24 * 60 * 60 * 1000 : 60 * 60 * 1000; // invite 7d, login 1h
    const expiresAt = new Date(Date.now() + ttlMs);
    await supabase.from('portal_magic_links').insert({
      portal_user_id: req.params.id,
      token,
      purpose,
      expires_at: expiresAt.toISOString(),
      created_by: performedBy,
    });
    await logAudit('magic_link_generated', { portal_user_id: req.params.id, performed_by: performedBy, notes: `purpose=${purpose}` });

    const magic_link = magicLinkUrl(req, token);
    // Optionally email the invite instead of returning it for copy/paste.
    let emailed = false;
    if (req.body && req.body.email) {
      try {
        const { data: u } = await supabase.from('portal_users').select('email, full_name, role').eq('id', req.params.id).maybeSingle();
        if (u && u.email) {
          const { data: sc } = await supabase.from('portal_user_communities').select('communities:community_id(name)').eq('portal_user_id', req.params.id).is('revoked_at', null).limit(1).maybeSingle();
          const communityName = sc && sc.communities ? sc.communities.name : null;
          const { sendPortalInvite } = require('../lib/email/portal_invite');
          const send = await sendPortalInvite({ toEmail: u.email, toName: u.full_name, communityName, magicLink: magic_link, role: u.role });
          emailed = !!(send && send.ok);
          if (emailed) await logAudit('invite_emailed', { portal_user_id: req.params.id, performed_by: performedBy, notes: `to=${u.email}` });
          else console.warn('[portal_admin] invite email not sent:', send && send.error);
        }
      } catch (e) { console.warn('[portal_admin] invite email failed:', e.message); }
    }

    res.json({ token, magic_link, expires_at: expiresAt.toISOString(), emailed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// GET /api/portal-admin/users/:id/scope
// Returns: { communities: [...], properties: [...] }
// ----------------------------------------------------------------------------
router.get('/users/:id/scope', async (req, res) => {
  try {
    const { data: comms } = await supabase
      .from('portal_user_communities')
      .select('community_id, granted_at, revoked_at, communities:community_id(id, name)')
      .eq('portal_user_id', req.params.id);

    const { data: props } = await supabase
      .from('portal_user_properties')
      .select('property_id, granted_at, revoked_at, properties:property_id(id, street_address, unit, community_id, communities:community_id(name))')
      .eq('portal_user_id', req.params.id);

    res.json({
      communities: comms || [],
      properties: props || [],
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// POST /api/portal-admin/users/:id/grant-community
// Body: { community_id, granted_by? }
// ----------------------------------------------------------------------------
router.post('/users/:id/grant-community', async (req, res) => {
  try {
    const { community_id, granted_by } = req.body || {};
    if (!community_id) return res.status(400).json({ error: 'community_id required' });

    await supabase.from('portal_user_communities').upsert({
      portal_user_id: req.params.id,
      community_id,
      granted_by: granted_by || null,
      revoked_at: null,        // un-revoke if previously revoked
      revoked_by: null,
    }, { onConflict: 'portal_user_id,community_id' });

    await logAudit('community_granted', {
      portal_user_id: req.params.id,
      resource_type: 'community',
      resource_id: community_id,
      performed_by: granted_by,
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// POST /api/portal-admin/users/:id/revoke-community
// ----------------------------------------------------------------------------
router.post('/users/:id/revoke-community', async (req, res) => {
  try {
    const { community_id, revoked_by } = req.body || {};
    if (!community_id) return res.status(400).json({ error: 'community_id required' });

    await supabase
      .from('portal_user_communities')
      .update({ revoked_at: new Date().toISOString(), revoked_by: revoked_by || null })
      .eq('portal_user_id', req.params.id)
      .eq('community_id', community_id);

    await logAudit('community_revoked', {
      portal_user_id: req.params.id,
      resource_type: 'community',
      resource_id: community_id,
      performed_by: revoked_by,
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// POST /api/portal-admin/users/:id/grant-property
// ----------------------------------------------------------------------------
router.post('/users/:id/grant-property', async (req, res) => {
  try {
    const { property_id, granted_by } = req.body || {};
    if (!property_id) return res.status(400).json({ error: 'property_id required' });

    await supabase.from('portal_user_properties').upsert({
      portal_user_id: req.params.id,
      property_id,
      granted_by: granted_by || null,
      revoked_at: null,
      revoked_by: null,
    }, { onConflict: 'portal_user_id,property_id' });

    await logAudit('property_granted', {
      portal_user_id: req.params.id,
      resource_type: 'property',
      resource_id: property_id,
      performed_by: granted_by,
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// POST /api/portal-admin/users/:id/revoke-property
// ----------------------------------------------------------------------------
router.post('/users/:id/revoke-property', async (req, res) => {
  try {
    const { property_id, revoked_by } = req.body || {};
    if (!property_id) return res.status(400).json({ error: 'property_id required' });

    await supabase
      .from('portal_user_properties')
      .update({ revoked_at: new Date().toISOString(), revoked_by: revoked_by || null })
      .eq('portal_user_id', req.params.id)
      .eq('property_id', property_id);

    await logAudit('property_revoked', {
      portal_user_id: req.params.id,
      resource_type: 'property',
      resource_id: property_id,
      performed_by: revoked_by,
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// POST /api/portal-admin/community/:communityId/homeowner-balances   (OWNER ONLY)
//   { on: true, note, ledger_through: 'YYYY-MM-DD' }
//                       -> balance tile live + verification stamp (who/when from the session).
//                          ledger_through is required: the date the owner verified the
//                          homeowner ledger is complete through. Homeowners see it as
//                          "shown through", and a lot with no activity since conversion
//                          shows $0.00 as of that date.
//   { on: false }       -> balance tile hidden, stamp removed
// Homeowners see balances only after this. Online payments are never switched on here.
// ============================================================================
router.post('/community/:communityId/homeowner-balances', async (req, res) => {
  try {
    const { requireOwner } = require('./_require_admin');
    const owner = await requireOwner(req, res);
    if (!owner) return;
    const communityId = req.params.communityId;
    const { on, note, ledger_through: ledgerThrough } = req.body || {};
    if (typeof on !== 'boolean') return res.status(400).json({ error: 'on_must_be_boolean' });
    const fa = require('../lib/portal/financial_access');
    if (on) {
      if (!fa.isIsoDate(ledgerThrough)) return res.status(400).json({ error: 'ledger_through_required', detail: 'Give the date the homeowner ledger is complete through (YYYY-MM-DD).' });
      if (ledgerThrough > new Date().toISOString().slice(0, 10)) return res.status(400).json({ error: 'ledger_through_in_future' });
    }
    const { data: current, error: curErr } = await supabase.from('communities')
      .select('id, name, is_demo, portal_module_config').eq('id', communityId).maybeSingle();
    if (curErr) throw curErr;
    if (!current) return res.status(404).json({ error: 'community_not_found' });
    const verifiedBy = owner.email || owner.id;
    const cfg = on
      ? fa.balancesOnConfig(current.portal_module_config, { verifiedBy, note: typeof note === 'string' ? note.slice(0, 500) : null, at: new Date().toISOString(), ledgerThrough })
      : fa.balancesOffConfig(current.portal_module_config);
    const { error: upErr } = await supabase.from('communities').update({ portal_module_config: cfg }).eq('id', communityId);
    if (upErr) throw upErr;
    await logAudit(on ? 'homeowner_balances_verified_on' : 'homeowner_balances_off', {
      resource_type: 'community', resource_id: communityId, performed_by: verifiedBy, notes: ((on ? `ledger complete through ${ledgerThrough}. ` : '') + (note || '')).slice(0, 500),
    });
    res.json({ ok: true, community_id: communityId, access: fa.decideFinancialAccess({ ...current, portal_module_config: cfg }) });
  } catch (err) {
    console.error('[portal_admin] homeowner-balances failed:', err.message);
    res.status(500).json({ error: 'homeowner_balances_failed' });
  }
});

// ============================================================================
// POST /api/portal-admin/community/:communityId/homeowner-payments   (OWNER ONLY)
//   { on: true }  -> online payments on (needs balances verified + fees set)
//   { on: false } -> online payments off immediately; balances stay as they are
// The only writer of homeowner_financials.payments. Stripe onboarding is still
// required at every payment (decideFinancialAccess); the response says if it is not.
// ============================================================================
router.post('/community/:communityId/homeowner-payments', async (req, res) => {
  try {
    const { requireOwner } = require('./_require_admin');
    const owner = await requireOwner(req, res);
    if (!owner) return;
    const communityId = req.params.communityId;
    const { on } = req.body || {};
    if (typeof on !== 'boolean') return res.status(400).json({ error: 'on_must_be_boolean' });
    const fa = require('../lib/portal/financial_access');
    const { data: current, error: curErr } = await supabase.from('communities').select(fa.COLUMNS).eq('id', communityId).maybeSingle();
    if (curErr) throw curErr;
    if (!current) return res.status(404).json({ error: 'community_not_found' });
    const by = owner.email || owner.id;
    const next = fa.paymentsSwitchConfig(current.portal_module_config, { on, by, at: new Date().toISOString() });
    if (!next.ok) return res.status(409).json({ error: next.error });
    const { error: upErr } = await supabase.from('communities').update({ portal_module_config: next.cfg }).eq('id', communityId);
    if (upErr) throw upErr;
    await logAudit(on ? 'homeowner_payments_on' : 'homeowner_payments_off', { resource_type: 'community', resource_id: communityId, performed_by: by });
    res.json({ ok: true, community_id: communityId, access: fa.decideFinancialAccess({ ...current, portal_module_config: next.cfg }) });
  } catch (err) {
    console.error('[portal_admin] homeowner-payments failed:', err.message);
    res.status(500).json({ error: 'homeowner_payments_failed' });
  }
});

// ============================================================================
// POST /api/portal-admin/community/:communityId/payment-fees   (OWNER ONLY)
//   { card_fee_bps, debit_card_fee_bps|null, ach_fee_cents, ach_tier_threshold_cents|null, ach_fee_above_cents|null }
//   { clear: true }                                           -> remove them (online payment refused)
// The ONLY writer of portal_module_config.payment_fees (lib/payments/fee_quote.js).
// Validated by the same function the payment flow uses, so a value that would be
// refused at payment time is refused here.
// ============================================================================
router.post('/community/:communityId/payment-fees', async (req, res) => {
  try {
    const { requireOwner } = require('./_require_admin');
    const owner = await requireOwner(req, res);
    if (!owner) return;
    const communityId = req.params.communityId;
    const b = req.body || {};
    const { data: current, error: curErr } = await supabase.from('communities')
      .select('id, name, portal_module_config').eq('id', communityId).maybeSingle();
    if (curErr) throw curErr;
    if (!current) return res.status(404).json({ error: 'community_not_found' });
    const cfg = { ...(current.portal_module_config || {}) };
    let fees = null;
    if (b.clear === true) {
      delete cfg.payment_fees;
    } else {
      const { validateFeeConfig } = require('../lib/payments/fee_quote');
      const v = validateFeeConfig({ card_fee_bps: b.card_fee_bps, debit_card_fee_bps: b.debit_card_fee_bps == null ? null : b.debit_card_fee_bps,
        ach_fee_cents: b.ach_fee_cents,
        ach_tier_threshold_cents: b.ach_tier_threshold_cents == null ? null : b.ach_tier_threshold_cents,
        ach_fee_above_cents: b.ach_fee_above_cents == null ? null : b.ach_fee_above_cents });
      if (!v.ok) return res.status(400).json({ error: v.error, detail: v.detail });
      fees = { ...v.config, set_by: owner.email || owner.id, set_at: new Date().toISOString() };
      cfg.payment_fees = fees;
    }
    const { error: upErr } = await supabase.from('communities').update({ portal_module_config: cfg }).eq('id', communityId);
    if (upErr) throw upErr;
    await logAudit(fees ? 'payment_fees_set' : 'payment_fees_cleared', {
      resource_type: 'community', resource_id: communityId, performed_by: owner.email || owner.id,
      notes: fees ? `card ${fees.card_fee_bps}bps, debit ${fees.debit_card_fee_bps == null ? 'same' : fees.debit_card_fee_bps + 'bps'}, ach ${fees.ach_fee_cents}c${fees.ach_tier_threshold_cents != null ? ` up to ${fees.ach_tier_threshold_cents}c, ${fees.ach_fee_above_cents}c above` : ''}` : 'cleared',
    });
    res.json({ ok: true, community_id: communityId, payment_fees: fees });
  } catch (err) {
    console.error('[portal_admin] payment-fees failed:', err.message);
    res.status(500).json({ error: 'payment_fees_failed' });
  }
});

// ============================================================================
// GET /api/portal-admin/community/:communityId/module-config
// ----------------------------------------------------------------------------
// Returns the current per-tile visibility config for a community plus the
// community-wide kill switch (portal_active). Used by the admin Tile
// Visibility panel to render the per-tile dropdowns.
//
// Response shape:
//   {
//     community: { id, name, slug, portal_active, portal_welcome_message },
//     module_config: { <module_key>: { status: 'live'|'coming_soon'|'hidden'|'maintenance',
//                                       notes?: <string>, link?: <override-url> } }
//   }
//
// The canonical list of available module keys lives in public/portal.html
// (MODULES array) — this endpoint just returns what's currently stored. The
// admin UI is responsible for showing tiles that exist in the canonical list
// but are missing from the config (treated as 'coming_soon' by default at
// render time).
// ============================================================================
router.get('/community/:communityId/module-config', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('communities')
      .select('id, name, slug, portal_active, portal_module_config, portal_welcome_message')
      .eq('id', req.params.communityId)
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'community_not_found' });
    res.json({
      community: {
        id: data.id,
        name: data.name,
        slug: data.slug,
        portal_active: data.portal_active === true,
        portal_welcome_message: data.portal_welcome_message || '',
      },
      module_config: data.portal_module_config || {},
    });
  } catch (err) {
    console.error('[portal_admin] get module-config failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// PATCH /api/portal-admin/community/:communityId/module-config
// ----------------------------------------------------------------------------
// Body:
//   {
//     module_config?: { <key>: { status, notes?, link? } },   // FULL replace
//     module_patch?:  { <key>: { status, notes?, link? } },   // MERGE
//     portal_active?:  bool,                                  // kill switch
//     portal_welcome_message?: <string>,                      // banner copy
//     updated_by?: <staff label>
//   }
//
// Pick one of module_config (full replace) OR module_patch (merge into
// existing). The admin UI uses module_patch for per-tile toggles so a single
// tile change doesn't risk overwriting other tiles set in a parallel tab.
//
// Status validation: only allows the four canonical states. Anything else
// rejected with 400.
// ============================================================================
const ALLOWED_TILE_STATUSES = ['live', 'coming_soon', 'hidden', 'maintenance'];

router.patch('/community/:communityId/module-config', async (req, res) => {
  try {
    const communityId = req.params.communityId;
    const body = req.body || {};
    const { module_config, module_patch, portal_active, portal_welcome_message, updated_by } = body;

    // Validate status values in either shape
    const validateCfg = (cfg) => {
      if (!cfg || typeof cfg !== 'object') return null;
      for (const key of Object.keys(cfg)) {
        const v = cfg[key];
        if (!v || typeof v !== 'object') return `invalid value for ${key}`;
        if (v.status && !ALLOWED_TILE_STATUSES.includes(v.status)) {
          return `invalid status "${v.status}" for ${key} (allowed: ${ALLOWED_TILE_STATUSES.join(', ')})`;
        }
      }
      return null;
    };
    const cfgErr = validateCfg(module_config) || validateCfg(module_patch);
    if (cfgErr) return res.status(400).json({ error: cfgErr });

    // Fetch current row (needed for merge OR for diff logging)
    const { data: current } = await supabase
      .from('communities')
      .select('id, portal_module_config, portal_active, portal_welcome_message')
      .eq('id', communityId)
      .maybeSingle();
    if (!current) return res.status(404).json({ error: 'community_not_found' });
    // Launching an association's portal is the owner's decision (Ed 2026-11-22).
    // Turning it OFF stays open to staff as the emergency stop.
    if (portal_active === true && current.portal_active !== true) {
      const { requireOwner } = require('./_require_admin');
      const owner = await requireOwner(req, res);
      if (!owner) return;
    }

    const update = {};
    let newCfg = null;
    if (module_config) {
      newCfg = module_config; // full replace
    } else if (module_patch) {
      newCfg = { ...(current.portal_module_config || {}) };
      // Per-key merge: shallow assign on each tile key so existing tiles not in
      // the patch keep their settings.
      for (const k of Object.keys(module_patch)) {
        newCfg[k] = { ...(newCfg[k] || {}), ...(module_patch[k] || {}) };
      }
    }
    if (newCfg) newCfg = require('../lib/portal/financial_access').carryFinancialStamp(current.portal_module_config, newCfg);
    if (newCfg) update.portal_module_config = newCfg;
    if (typeof portal_active === 'boolean') update.portal_active = portal_active;
    if (typeof portal_welcome_message === 'string') update.portal_welcome_message = portal_welcome_message;

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ error: 'nothing_to_update' });
    }

    const { error: upErr } = await supabase
      .from('communities')
      .update(update)
      .eq('id', communityId);
    if (upErr) throw upErr;

    // Audit log — note this isn't tied to a specific portal_user (community-
    // level admin action), so portal_user_id is null. Notes string summarizes
    // what changed for forensic readability.
    const changedFields = [];
    if (newCfg) changedFields.push('module_config');
    if (typeof portal_active === 'boolean') changedFields.push(`portal_active=${portal_active}`);
    if (typeof portal_welcome_message === 'string') changedFields.push('welcome_message');
    await logAudit('community_portal_config_changed', {
      resource_type: 'community',
      resource_id: communityId,
      performed_by: updated_by || null,
      notes: changedFields.join('; '),
    });

    res.json({
      ok: true,
      community_id: communityId,
      module_config: newCfg || current.portal_module_config || {},
      portal_active: ('portal_active' in update) ? update.portal_active : current.portal_active,
    });
  } catch (err) {
    console.error('[portal_admin] patch module-config failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// GET /api/portal-admin/communities
// ----------------------------------------------------------------------------
// Lightweight list of communities for the admin UI dropdowns. Returns
// id + name + slug + a count of properties (helps operator pick a target
// for bulk-invite). Hard cap at 500 — Bedrock has 7 today, would never
// approach the cap.
// ============================================================================
// ACC committee + workflow admin (Phase 1C — Ed 2026-06-09)
// ----------------------------------------------------------------------------
// PATCH  /api/portal-admin/community/:cid/arc-workflow  — set workflow + min approvals
// GET    /api/portal-admin/community/:cid/arc-committee — list committee members
// POST   /api/portal-admin/community/:cid/arc-committee — add a member
// DELETE /api/portal-admin/community/:cid/arc-committee/:memberId — remove
// ============================================================================
const ARC_WORKFLOWS = ['bedrock_only', 'acc_majority', 'acc_unanimous'];

router.patch('/community/:cid/arc-workflow', async (req, res) => {
  try {
    const b = req.body || {};
    if (b.workflow && !ARC_WORKFLOWS.includes(b.workflow)) {
      return res.status(400).json({ error: 'invalid_workflow', allowed: ARC_WORKFLOWS });
    }
    const patch = {};
    if (b.workflow) patch.arc_approval_workflow = b.workflow;
    if (typeof b.min_approvals === 'number' && b.min_approvals >= 0) patch.arc_acc_min_approvals = b.min_approvals;
    if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'nothing_to_update' });
    const { error } = await supabase.from('communities').update(patch).eq('id', req.params.cid);
    if (error) throw error;
    res.json({ ok: true, ...patch });
  } catch (err) {
    console.error('[portal_admin] arc-workflow patch failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/community/:cid/arc-committee', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('community_arc_committee')
      .select(`
        id, contact_id, position_title, is_chair, is_active,
        term_starts_at, term_ends_at, added_at, notes,
        contact:contact_id (full_name, primary_email, primary_phone)
      `)
      .eq('community_id', req.params.cid)
      .is('removed_at', null)
      .order('is_chair', { ascending: false });
    if (error) throw error;
    res.json({ committee: data || [] });
  } catch (err) {
    console.error('[portal_admin] arc-committee list failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.post('/community/:cid/arc-committee', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.contact_id) return res.status(400).json({ error: 'contact_id_required' });
    const { error } = await supabase.from('community_arc_committee').insert({
      community_id: req.params.cid,
      contact_id: b.contact_id,
      position_title: b.position_title || null,
      is_chair: !!b.is_chair,
      term_starts_at: b.term_starts_at || null,
      term_ends_at: b.term_ends_at || null,
      added_by: b.added_by || 'admin_ui',
      notes: b.notes || null,
    });
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    console.error('[portal_admin] arc-committee add failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.delete('/community/:cid/arc-committee/:memberId', async (req, res) => {
  try {
    const b = req.body || {};
    const { error } = await supabase
      .from('community_arc_committee')
      .update({ removed_at: new Date().toISOString(), removed_by: b.removed_by || 'admin_ui', is_active: false })
      .eq('id', req.params.memberId)
      .eq('community_id', req.params.cid);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    console.error('[portal_admin] arc-committee remove failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
router.get('/communities', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('communities')
      .select('id, name, slug, portal_active, portal_module_config, arc_approval_workflow, arc_acc_min_approvals')
      .order('name', { ascending: true })
      .limit(500);
    if (error) throw error;
    res.json({ communities: data || [] });
  } catch (err) {
    console.error('[portal_admin] list communities failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// GET /api/portal-admin/community/:communityId/adoption
// ----------------------------------------------------------------------------
// Returns the per-community portal-adoption funnel + per-contact status table.
// This is the operational view that lets Bedrock staff actually ROLL OUT the
// portal to a whole community at once instead of inviting one homeowner at
// a time via the create-user POST.
//
// Response shape:
//   {
//     community: { id, name, slug },
//     summary: {
//       total_contacts: <int>,
//       with_email:     <int>,   // contacts that CAN be invited
//       invited:        <int>,   // portal_users created for any of them
//       logged_in_ever: <int>,   // portal_users.first_login_at IS NOT NULL
//       active_30d:     <int>,   // portal_users.last_login_at within 30d
//     },
//     contacts: [
//       { contact_id, name, email, property_id, property_address,
//         portal_user_id, portal_status, invited_at, first_login_at,
//         last_login_at, login_count }
//     ]
//   }
//
// Notes:
//   - "Current" residency = property_residencies.end_date IS NULL.
//   - Contacts WITHOUT a current residency in this community are excluded —
//     we don't show ex-owners on a current-adoption view. (They're still in
//     the audit trail via portal_audit_log if they ever had access.)
//   - Hard-capped at 2000 rows for safety. At scale-50 communities with 1000+
//     doors, pagination becomes worth adding. Today's largest community is
//     ~250 doors so we're nowhere near the cap.
// ============================================================================
router.get('/community/:communityId/adoption', async (req, res) => {
  try {
    const communityId = req.params.communityId;
    if (!communityId) return res.status(400).json({ error: 'community_id_required' });

    // Verify community exists
    const { data: community, error: cErr } = await supabase
      .from('communities')
      .select('id, name, slug')
      .eq('id', communityId)
      .maybeSingle();
    if (cErr) throw cErr;
    if (!community) return res.status(404).json({ error: 'community_not_found' });

    // Step 1: properties in this community
    const { data: properties } = await supabase
      .from('properties')
      .select('id, street_address')
      .eq('community_id', communityId)
      .limit(2000);
    const propertyIds = (properties || []).map((p) => p.id);
    const propertyById = Object.fromEntries((properties || []).map((p) => [p.id, p]));
    if (propertyIds.length === 0) {
      return res.json({
        community,
        summary: { total_contacts: 0, with_email: 0, invited: 0, logged_in_ever: 0, active_30d: 0 },
        contacts: [],
      });
    }

    // Step 2: current residencies (one row per resident on a property)
    const { data: residencies } = await supabase
      .from('property_residencies')
      .select('contact_id, property_id, residency_type')
      .in('property_id', propertyIds)
      .is('end_date', null)
      .limit(2000);
    const contactIds = Array.from(new Set((residencies || []).map((r) => r.contact_id).filter(Boolean)));

    // Step 3: contact details (only for current residents we just found)
    const { data: contacts } = contactIds.length
      ? await supabase
          .from('contacts')
          .select('id, full_name, preferred_name, primary_email')
          .in('id', contactIds)
          .limit(2000)
      : { data: [] };
    const contactById = Object.fromEntries((contacts || []).map((c) => [c.id, c]));

    // Step 4: portal_users for these contacts (matched by contact_id OR email)
    const emails = Array.from(new Set(
      (contacts || []).map((c) => (c.primary_email || '').toLowerCase().trim()).filter(Boolean)
    ));
    const { data: pUsersByContact } = contactIds.length
      ? await supabase
          .from('portal_users')
          .select('id, email, contact_id, status, invited_at, first_login_at, last_login_at, login_count')
          .eq('management_company_id', BEDROCK_MGMT_CO_ID)
          .in('contact_id', contactIds)
          .limit(2000)
      : { data: [] };
    const { data: pUsersByEmail } = emails.length
      ? await supabase
          .from('portal_users')
          .select('id, email, contact_id, status, invited_at, first_login_at, last_login_at, login_count')
          .eq('management_company_id', BEDROCK_MGMT_CO_ID)
          .in('email', emails)
          .limit(2000)
      : { data: [] };
    // Merge both lookups by id, contact_id-first wins (more specific match)
    const portalUserByContactId = {};
    const portalUserByEmail = {};
    for (const u of (pUsersByContact || [])) {
      if (u.contact_id) portalUserByContactId[u.contact_id] = u;
      if (u.email) portalUserByEmail[u.email.toLowerCase()] = u;
    }
    for (const u of (pUsersByEmail || [])) {
      if (u.email && !portalUserByEmail[u.email.toLowerCase()]) {
        portalUserByEmail[u.email.toLowerCase()] = u;
      }
    }

    // Step 5: assemble per-contact rows + summary stats
    const now = Date.now();
    const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
    let with_email = 0;
    let invited = 0;
    let logged_in_ever = 0;
    let active_30d = 0;

    const rows = (residencies || []).map((r) => {
      const c = contactById[r.contact_id];
      if (!c) return null; // contact deleted, residency stale
      const email = (c.primary_email || '').toLowerCase().trim();
      const property = propertyById[r.property_id] || {};
      const u = portalUserByContactId[c.id] || (email ? portalUserByEmail[email] : null);

      if (email) with_email++;
      if (u) {
        invited++;
        if (u.first_login_at) logged_in_ever++;
        if (u.last_login_at && (now - new Date(u.last_login_at).getTime()) <= THIRTY_DAYS_MS) {
          active_30d++;
        }
      }

      return {
        contact_id: c.id,
        name: c.preferred_name || c.full_name || '',
        email: c.primary_email || '',
        residency_type: r.residency_type || null,
        property_id: r.property_id,
        property_address: property.street_address || '',
        portal_user_id: u ? u.id : null,
        portal_status: u ? u.status : null,
        invited_at: u ? u.invited_at : null,
        first_login_at: u ? u.first_login_at : null,
        last_login_at: u ? u.last_login_at : null,
        login_count: u ? (u.login_count || 0) : 0,
      };
    }).filter(Boolean);

    res.json({
      community,
      summary: {
        total_contacts: rows.length,
        with_email,
        invited,
        logged_in_ever,
        active_30d,
      },
      contacts: rows,
    });
  } catch (err) {
    console.error('[portal_admin] adoption query failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// POST /api/portal-admin/community/:communityId/bulk-invite   (Ed 2026-11-22)
// ----------------------------------------------------------------------------
// One roster, three modes. The roster (lib/portal/invite_roster.js) is the
// owners of record from v_current_property_owners, one row per owner contact,
// with risky inboxes excluded by default and a reason for every skip.
//
//   { dry_run: true, contact_ids?, include_flagged? }
//       PREVIEW. Reads only, writes and sends nothing. Returns who WOULD be
//       invited (owner, lots, email), who is skipped and why, a lot-count
//       cross-check against live lots, and preview_hash. Any staffer.
//   { mode: 'create_only', preview_hash, portal_active_expected, ... }   OWNER ONLY
//       Creates portal_users + lot grants for the previewed owners WITHOUT
//       emailing, so "enter your email" sign-in from the printed statement
//       works. Runs with the portal on or off; refuses if portal_active is not
//       what the owner expected.
//   { mode: 'send', preview_hash, ... }   OWNER ONLY
//       Creates any missing accounts, then emails the invitation in the
//       background (paced for the mail provider). Refuses unless the portal is on.
//
// Both write modes recompute the roster and refuse with 409 preview_changed if
// its hash is not the one previewed, and 409 if the lot cross-check fails, so
// what is written and sent is exactly what the owner approved.
// Accounts are created marked SILENT_CREATE_MARK and re-marked only after the
// invitation email is accepted by the provider, so a failed or interrupted send
// shows on the next Preview as "account created, not yet emailed" and is retried.
// ============================================================================
const _sendsInFlight = new Set();

// The create path is shared with the Owner Authorization Service action
// portal_silent_create (lib/portal/silent_create.js): one code path, no copy.
const SilentCreate = require('../lib/portal/silent_create');
const _createRosterAccounts = (rows, opts) => SilentCreate.createRosterAccounts(supabase, rows, opts);

// Background invitation sender: one magic link + one email per account, paced.
// Each success re-marks the account as emailed; a failure leaves it on the
// "not yet emailed" list for the next Preview.
async function _sendInvitesInBackground(items, { req, community, access, performedBy }) {
  const { sendPortalInvite } = require('../lib/email/portal_invite');
  const perSec = Math.max(1, Number(process.env.PORTAL_INVITE_SEND_PER_SEC || 2));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  let sent = 0; let failed = 0;
  try {
    for (let i = 0; i < items.length; i += perSec) {
      const started = Date.now();
      await Promise.all(items.slice(i, i + perSec).map(async (it) => {
        const token = makeToken();
        const { error: linkErr } = await supabase.from('portal_magic_links').insert({
          portal_user_id: it.portal_user_id, token, purpose: 'invite',
          expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(), created_by: performedBy,
        });
        if (linkErr) { failed++; console.warn(`[portal_admin] invite link failed for ${it.portal_user_id}: ${linkErr.message}`); return; }
        const args = { toEmail: it.email, toName: it.name, communityName: community.name, magicLink: magicLinkUrl(req, token),
          role: 'homeowner', balance: access.balance, payments: access.payments };
        let send = await sendPortalInvite(args).catch((e) => ({ ok: false, error: e.message }));
        if (!(send && send.ok)) { await wait(2000); send = await sendPortalInvite(args).catch((e) => ({ ok: false, error: e.message })); }
        if (!(send && send.ok)) { failed++; console.warn(`[portal_admin] invite email failed for ${it.portal_user_id}: ${(send && send.error) || 'send failed'}`); return; }
        const { error: upErr } = await supabase.from('portal_users')
          .update({ invited_by: 'portal-adoption-ui', invited_at: new Date().toISOString() }).eq('id', it.portal_user_id);
        if (upErr) console.error(`[portal_admin] invite sent but account not re-marked ${it.portal_user_id}: ${upErr.message}`);
        sent++;
        await logAudit('magic_link_sent', { portal_user_id: it.portal_user_id, performed_by: performedBy, notes: `purpose=invite via=bulk_invite community=${community.slug}` });
      }));
      const elapsed = Date.now() - started;
      if (elapsed < 1000 && i + perSec < items.length) await wait(1000 - elapsed);
    }
  } catch (e) {
    console.error('[portal_admin] background invite send aborted:', e.message);
  } finally {
    _sendsInFlight.delete(community.id);
    console.log(`[portal_admin] bulk invite send finished community=${community.slug} sent=${sent} failed=${failed} of ${items.length}`);
  }
}

router.post('/community/:communityId/bulk-invite', async (req, res) => {
  try {
    const communityId = req.params.communityId;
    const b = req.body || {};
    const contactIds = b.contact_ids == null ? null : b.contact_ids;
    if (contactIds !== null && (!Array.isArray(contactIds) || contactIds.length === 0 || contactIds.some((x) => typeof x !== 'string'))) {
      return res.status(400).json({ error: 'contact_ids_invalid' });
    }
    if (contactIds && contactIds.length > 1000) return res.status(400).json({ error: 'contact_ids_too_many', max: 1000, got: contactIds.length });
    const includeFlagged = Array.isArray(b.include_flagged) ? b.include_flagged.filter((x) => typeof x === 'string').slice(0, 1000) : [];
    const mode = b.dry_run === true ? 'preview' : (b.mode === 'send' || b.mode === 'create_only' ? b.mode : null);
    if (!mode) return res.status(400).json({ error: 'mode_required', detail: 'Preview first (dry_run: true), then mode send or create_only with the preview_hash.' });

    // Writes are the owner's: check before doing any work.
    let owner = null;
    if (mode !== 'preview') {
      const { requireOwner } = require('./_require_admin');
      owner = await requireOwner(req, res);
      if (!owner) return;
    }

    const { loadInviteRoster } = require('../lib/portal/invite_roster');
    const loaded = await loadInviteRoster(supabase, communityId, { managementCompanyId: BEDROCK_MGMT_CO_ID, contactIds, includeFlagged });
    if (!loaded.community) return res.status(404).json({ error: 'community_not_found' });
    const { community, roster, cross_check, hash } = loaded;
    const access = await require('../lib/portal/financial_access').financialAccessFor(supabase, communityId)
      .catch(() => ({ balance: false, payments: false }));
    const preview = {
      community: { id: community.id, name: community.name, portal_active: community.portal_active === true },
      preview_hash: hash, cross_check, counts: roster.counts,
      invitation_mentions: { balance: !!access.balance, payments: !!access.payments },
      send_in_progress: _sendsInFlight.has(community.id),
    };
    if (mode === 'preview') return res.json({ ok: true, dry_run: true, ...preview, invite: roster.invite, skipped: roster.skipped });

    if (!cross_check.ok) return res.status(409).json({ error: 'roster_cross_check_failed', ...preview });
    if (!b.preview_hash || b.preview_hash !== hash) return res.status(409).json({ error: 'preview_changed', detail: 'The list changed since it was previewed. Preview again.', ...preview });
    const { isOpenCommunity } = require('../lib/portal/portal_open');
    if (mode === 'create_only') {
      if (typeof b.portal_active_expected !== 'boolean') return res.status(400).json({ error: 'portal_active_expected_required' });
      if (b.portal_active_expected !== (community.portal_active === true)) return res.status(409).json({ error: 'portal_state_changed', ...preview });
      // While the portal is off the association is in PILOT: accounts are added
      // one at a time on the pilot list. Creating accounts for every owner is a
      // broader launch and needs the owner's explicit approval in the request.
      if (community.portal_active !== true && b.broader_launch_approved !== true) {
        return res.status(409).json({ error: 'pilot_mode', detail: 'The portal is in pilot. Creating accounts for all owners is a broader launch: approve it explicitly first.', ...preview });
      }
    } else if (!isOpenCommunity(community)) {
      return res.status(409).json({ error: 'portal_not_active', detail: 'Turn the portal on before sending invitations.', ...preview });
    }
    if (_sendsInFlight.has(community.id)) return res.status(409).json({ error: 'send_in_progress', ...preview });

    const performedBy = owner.email || owner.id;
    const toCreate = roster.invite.filter((r) => r.action === 'create');
    if (mode === 'send') _sendsInFlight.add(community.id);
    let created;
    try {
      created = await _createRosterAccounts(toCreate, { performedBy, slug: community.slug, via: mode === 'send' ? 'bulk_invite' : 'silent_create' });
    } catch (e) {
      _sendsInFlight.delete(community.id);
      throw e;
    }
    await logAudit(mode === 'send' ? 'bulk_invite_send_approved' : 'bulk_silent_create', {
      resource_type: 'community', resource_id: community.id, performed_by: performedBy,
      notes: `hash=${hash}${b.broader_launch_approved === true ? ' broader_launch_approved=true' : ''} accounts_created=${Object.keys(created.byContact).length} failures=${created.failures.length} to_email=${mode === 'send' ? roster.invite.length : 0}`,
    });
    // An owner whose account already exists (created silently earlier, not yet
    // emailed) still needs THIS roster's lots (Ed 2026-11-27): shared path.
    const existing = await SilentCreate.grantExistingAccountLots(supabase, roster.invite, { performedBy });
    created.failures.push(...existing.failures);
    const result = {
      ok: true, mode, ...preview,
      accounts_created: Object.keys(created.byContact).length,
      existing_accounts_checked: existing.existing_accounts_checked,
      failures: created.failures,
    };
    if (mode === 'create_only') return res.json(result);

    const failedIds = new Set(created.failures.filter((f) => f.reason === 'account_insert_failed').map((f) => f.contact_id));
    const items = roster.invite.filter((r) => !failedIds.has(r.contact_id)).map((r) => ({
      portal_user_id: r.portal_user_id || created.byContact[r.contact_id], email: r.email, name: r.name,
    })).filter((it) => it.portal_user_id);
    res.status(202).json({ ...result, emails_queued: items.length,
      detail: 'Invitations are sending in the background. Preview again in a few minutes: anyone still listed as not yet emailed did not go out.' });
    setImmediate(() => _sendInvitesInBackground(items, { req, community, access, performedBy }));
  } catch (err) {
    console.error('[portal_admin] bulk-invite failed:', err.message);
    if (!res.headersSent) res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ============================================================================
// POST /api/portal-admin/users/:id/resend-invite
// ----------------------------------------------------------------------------
// For users with status=invited who didn't act on the original invite.
// Generates a FRESH 7-day magic link (invalidating any prior pending links
// for this user) and emails it. Idempotent — calling multiple times just
// re-sends.
//
// Body: { invited_by?: <staff label> }
// ============================================================================
router.post('/users/:id/resend-invite', async (req, res) => {
  try {
    const userId = req.params.id;
    const invitedBy = req.body?.invited_by || null;

    const { data: user } = await supabase
      .from('portal_users')
      .select('id, email, full_name, status, contact_id')
      .eq('id', userId)
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .maybeSingle();
    if (!user) return res.status(404).json({ error: 'user_not_found' });
    if (user.status === 'revoked') return res.status(400).json({ error: 'user_is_revoked' });

    // Find the property tied to this user (for the email context line)
    let propertyAddress = '';
    let communityName = '';
    try {
      const { data: scope } = await supabase
        .from('portal_user_properties')
        .select('properties:property_id(street_address, communities:community_id(name))')
        .eq('portal_user_id', userId)
        .is('revoked_at', null)
        .limit(1)
        .maybeSingle();
      if (scope?.properties) {
        propertyAddress = scope.properties.street_address || '';
        communityName = scope.properties.communities?.name || '';
      }
    } catch (_) { /* not fatal */ }

    // Invalidate prior pending links
    await supabase
      .from('portal_magic_links')
      .update({ used_at: new Date().toISOString(), used_user_agent: 'superseded_by_resend' })
      .eq('portal_user_id', userId)
      .is('used_at', null);

    // Generate fresh 7-day link
    const token = makeToken();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await supabase.from('portal_magic_links').insert({
      portal_user_id: userId,
      token,
      purpose: 'invite',
      expires_at: expiresAt.toISOString(),
      created_by: invitedBy,
    });
    await logAudit('magic_link_generated', { portal_user_id: userId, performed_by: invitedBy, notes: 'purpose=invite via=resend' });

    // Email it
    const url = magicLinkUrl(req, token);
    const firstName = (user.full_name || '').split(/\s+/)[0] || '';
    let emailSent = false;
    let emailError = null;
    try {
      const send = await sendEmail({
        to: user.email,
        subject: `Your ${communityName || 'Bedrock'} homeowner portal invitation`,
        html: `
          <p>Hi${firstName ? ' ' + escapeHtml(firstName) : ''},</p>
          <p>Here's a fresh link to set up your homeowner portal access${communityName ? ' for <strong>' + escapeHtml(communityName) + '</strong>' : ''}${propertyAddress ? ' — ' + escapeHtml(propertyAddress) : ''}.</p>
          <p style="margin: 22px 0;">
            <a href="${escapeHtml(url)}" style="display:inline-block; background:#1A3050; color:white; padding:13px 24px; border-radius:7px; text-decoration:none; font-weight:500; font-family: Inter, Arial, sans-serif;">
              Set up your portal access →
            </a>
          </p>
          <p style="font-size:13px; color:#666;">This invite link is valid for 7 days. Replies come to our team if you need help.</p>
          <p style="font-size:12px; color:#888;">Or paste this URL in your browser:<br><span style="font-family:monospace; font-size:11px; word-break:break-all;">${escapeHtml(url)}</span></p>
          <p style="color:#555; font-size:11px; margin-top:26px; padding-top:14px; border-top:1px solid #ddd;">
            Bedrock Association Management · (832) 588-2485 · info@bedrocktx.com
          </p>
        `,
        tags: [
          { name: 'module', value: 'portal_admin' },
          { name: 'event', value: 'invite_resent' },
        ],
      });
      // sendEmail RETURNS failures, it does not throw — so this catch alone was
      // dead code and emailSent was unconditionally true. Check the result, or
      // the operator is told the invite went out when it didn't. (Ed 2026-07-15.)
      emailSent = !!(send && send.ok);
      emailError = emailSent ? null : ((send && send.error) || 'send failed');
      if (emailSent) {
        // A silently created account is now emailed: drop it from the bulk
        // "not yet emailed" list so a later bulk send does not email it twice.
        const { SILENT_CREATE_MARK } = require('../lib/portal/invite_roster');
        const { error: markErr } = await supabase.from('portal_users').update({ invited_by: invitedBy || 'resend' })
          .eq('id', userId).eq('invited_by', SILENT_CREATE_MARK);
        if (markErr) console.warn('[portal_admin] resend re-mark failed:', markErr.message);
      }
      await logAudit(emailSent ? 'magic_link_sent' : 'magic_link_send_failed', {
        portal_user_id: userId,
        notes: emailSent ? `via=resend id=${send.vendor_message_id || '?'}` : `via=resend error=${emailError}`,
      });
    } catch (e) {
      console.error(`[portal_admin] resend-invite email threw for ${userId}: ${e.message}`);
      emailError = e.message;
    }

    res.json({
      ok: true,
      portal_user_id: userId,
      email_sent: emailSent,
      email_error: emailError,
      magic_link: url, // returned for operator convenience (can paste manually if email failed)
      expires_at: expiresAt.toISOString(),
    });
  } catch (err) {
    console.error('[portal_admin] resend-invite failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// Portal PILOT (OWNER ONLY)   (Ed 2026-11-22)
// ----------------------------------------------------------------------------
// While an association's portal_active is false, the portal opens ONLY for the
// portal users on portal_module_config.portal_pilot.user_ids (lib/portal/
// portal_open.js). Ed picks each pilot homeowner himself. Adding one creates or
// links that owner's account silently (no email) and returns a sign-in link for
// Ed to hand over personally. This route is the only writer of portal_pilot;
// ordinary config writes carry it forward (carryFinancialStamp) and the
// homeowner browser never receives it (presentedModuleConfig).
//
//   GET  /community/:communityId/pilot                         list
//   POST /community/:communityId/pilot { action:'add', contact_id, include_flagged? }
//   POST /community/:communityId/pilot { action:'remove', portal_user_id }
//   POST /community/:communityId/pilot { action:'link', portal_user_id }   fresh sign-in link
// ============================================================================
const PILOT_MARK = 'portal-pilot';
const PILOT_MAX = 50;

async function _issueHandoverLink(req, portalUserId, performedBy) {
  const token = makeToken();
  const { error } = await supabase.from('portal_magic_links').insert({
    portal_user_id: portalUserId, token, purpose: 'invite',
    expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(), created_by: performedBy,
  });
  if (error) throw error;
  await logAudit('magic_link_generated', { portal_user_id: portalUserId, performed_by: performedBy, notes: 'purpose=pilot_handover email=not_sent' });
  return magicLinkUrl(req, token);
}

router.get('/community/:communityId/pilot', async (req, res) => {
  try {
    const { requireOwner } = require('./_require_admin');
    const owner = await requireOwner(req, res);
    if (!owner) return;
    const { data: c, error } = await supabase.from('communities')
      .select('id, name, portal_active, portal_module_config').eq('id', req.params.communityId).maybeSingle();
    if (error) throw error;
    if (!c) return res.status(404).json({ error: 'community_not_found' });
    const { pilotUserIds } = require('../lib/portal/portal_open');
    const ids = pilotUserIds(c);
    let members = [];
    if (ids.length) {
      const { data: users, error: uErr } = await supabase.from('portal_users')
        .select('id, full_name, email, status, first_login_at, last_login_at').in('id', ids);
      if (uErr) throw uErr;
      const { data: grants, error: gErr } = await supabase.from('portal_user_properties')
        .select('portal_user_id, properties:property_id(street_address, community_id)').in('portal_user_id', ids).is('revoked_at', null);
      if (gErr) throw gErr;
      members = (users || []).map((u) => ({
        portal_user_id: u.id, name: u.full_name || '', email: u.email, status: u.status,
        first_login_at: u.first_login_at, last_login_at: u.last_login_at,
        lots: (grants || []).filter((g) => g.portal_user_id === u.id && g.properties && g.properties.community_id === c.id).map((g) => g.properties.street_address),
      }));
    }
    const p = (c.portal_module_config && c.portal_module_config.portal_pilot) || {};
    res.json({ ok: true, community: { id: c.id, name: c.name, portal_active: c.portal_active === true }, set_by: p.set_by || null, set_at: p.set_at || null, members });
  } catch (err) {
    console.error('[portal_admin] pilot list failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

router.post('/community/:communityId/pilot', async (req, res) => {
  try {
    const { requireOwner } = require('./_require_admin');
    const owner = await requireOwner(req, res);
    if (!owner) return;
    const communityId = req.params.communityId;
    const b = req.body || {};
    if (!['add', 'remove', 'link'].includes(b.action)) return res.status(400).json({ error: 'action_must_be_add_remove_or_link' });
    const performedBy = owner.email || owner.id;
    const { data: c, error: cErr } = await supabase.from('communities')
      .select('id, name, slug, portal_active, portal_module_config').eq('id', communityId).maybeSingle();
    if (cErr) throw cErr;
    if (!c) return res.status(404).json({ error: 'community_not_found' });
    const { pilotUserIds } = require('../lib/portal/portal_open');
    const ids = pilotUserIds(c);
    const writePilot = async (nextIds) => {
      const cfg = { ...(c.portal_module_config || {}), portal_pilot: { user_ids: nextIds, set_by: performedBy, set_at: new Date().toISOString() } };
      const { error } = await supabase.from('communities').update({ portal_module_config: cfg }).eq('id', communityId);
      if (error) throw error;
    };

    if (b.action === 'remove' || b.action === 'link') {
      const uid = typeof b.portal_user_id === 'string' ? b.portal_user_id : '';
      if (!ids.includes(uid)) return res.status(404).json({ error: 'not_on_pilot_list' });
      if (b.action === 'remove') {
        await writePilot(ids.filter((x) => x !== uid));
        await logAudit('pilot_user_removed', { portal_user_id: uid, resource_type: 'community', resource_id: communityId, performed_by: performedBy });
        return res.json({ ok: true, removed: uid, pilot_count: ids.length - 1 });
      }
      const link = await _issueHandoverLink(req, uid, performedBy);
      return res.json({ ok: true, portal_user_id: uid, sign_in_link: link, emailed: false });
    }

    // add: must be a current owner of record here with a usable, unshared inbox.
    const contactId = typeof b.contact_id === 'string' ? b.contact_id.trim() : '';
    if (!contactId) return res.status(400).json({ error: 'contact_id_required' });
    if (ids.length >= PILOT_MAX) return res.status(409).json({ error: 'pilot_list_full', max: PILOT_MAX });
    const { loadInviteRoster } = require('../lib/portal/invite_roster');
    const loaded = await loadInviteRoster(supabase, communityId, {
      managementCompanyId: BEDROCK_MGMT_CO_ID, contactIds: [contactId], includeFlagged: b.include_flagged === true ? [contactId] : [],
    });
    const row = loaded.roster.invite[0];
    const skip = loaded.roster.skipped[0];
    let userId = null;
    let lots = [];
    if (row && row.action === 'create') {
      const made = await _createRosterAccounts([row], { performedBy, slug: c.slug, via: 'pilot', mark: PILOT_MARK });
      if (made.failures.length) return res.status(409).json({ error: made.failures[0].reason, detail: made.failures[0].detail });
      userId = made.byContact[contactId];
      lots = row.properties;
    } else if (row && row.action === 'email_existing') {
      userId = row.portal_user_id; lots = row.properties;
    } else if (skip && skip.reason === 'already_has_account') {
      const { data: u, error: uErr } = await supabase.from('portal_users').select('id')
        .eq('management_company_id', BEDROCK_MGMT_CO_ID).eq('contact_id', contactId).limit(1).maybeSingle();
      if (uErr) throw uErr;
      userId = u && u.id; lots = skip.properties;
    } else {
      return res.status(409).json({ error: 'not_eligible', reason: skip ? skip.reason : 'not_a_current_owner', detail: skip && skip.detail });
    }
    if (!userId) return res.status(409).json({ error: 'account_not_found' });
    // Make sure the account can see every lot this owner holds here.
    const { error: gErr } = await supabase.from('portal_user_properties').upsert(
      lots.map((p) => ({ portal_user_id: userId, property_id: p.property_id, granted_by: performedBy, revoked_at: null, revoked_by: null })),
      { onConflict: 'portal_user_id,property_id' });
    if (gErr) throw gErr;
    if (!ids.includes(userId)) await writePilot([...ids, userId]);
    await logAudit('pilot_user_added', { portal_user_id: userId, resource_type: 'community', resource_id: communityId, performed_by: performedBy, notes: `contact=${contactId} email=not_sent` });
    const link = await _issueHandoverLink(req, userId, performedBy);
    res.json({ ok: true, portal_user_id: userId, email: (row || skip).email, lots: lots.map((p) => p.street_address),
      sign_in_link: link, emailed: false, pilot_count: ids.includes(userId) ? ids.length : ids.length + 1 });
  } catch (err) {
    console.error('[portal_admin] pilot change failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

module.exports = { router };
