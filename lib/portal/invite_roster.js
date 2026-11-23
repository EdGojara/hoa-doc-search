// ============================================================================
// lib/portal/invite_roster.js  (Ed 2026-11-22, LOPF + CG portal launch)
// ----------------------------------------------------------------------------
// WHO a bulk portal invite would reach, decided in one place and read-only.
// The bulk-invite endpoint previews this roster (dry run), and the send and the
// silent account creation recompute it and refuse unless its hash matches the
// one Ed approved on the Preview. So what goes out is exactly what was shown.
//
// Source: v_current_property_owners (the owner of record per live lot, the same
// view statements are mailed from). Owners only: tenants are not invited.
// One row per owner contact; a multi-lot owner gets one account with every lot.
//
// Excluded by default, with a reason (contact review 2026-11-21):
//   no_email          nothing on file
//   multiple_emails   several addresses packed into one field
//   invalid_email     not an address
//   shared_email      the same inbox on two or more different owner contacts
//                     (one inbox would control several owners' accounts, and a
//                     split contact would get two invites)
//   management_inbox  a role inbox (admin@, office@, hoa@ ...) or a property-
//                     manager / institutional-landlord domain. Overridable per
//                     owner with include_flagged after Ed confirms the inbox.
//   already_has_account / portal_access_revoked / email_has_other_portal_account /
//   portal_account_other_email   an account already exists; never duplicated
//   not_a_current_owner  a requested contact who is not an owner of record here
// ============================================================================
'use strict';

const crypto = require('crypto');

// Silent accounts are marked here so a later send emails them exactly once.
const SILENT_CREATE_MARK = 'portal-silent-create';

const ROLE_LOCAL_PARTS = new Set([
  'admin', 'office', 'hoa', 'info', 'hello', 'support', 'accounting', 'accounts', 'ap', 'ar',
  'billing', 'manager', 'management', 'mgmt', 'leasing', 'rentals', 'rental', 'property',
  'properties', 'propertymanagement', 'pm', 'contact', 'service', 'services', 'noreply',
  'no-reply', 'donotreply', 'team', 'sales', 'operations', 'ops', 'hoadocs', 'hoainvoices',
]);
// Property managers and institutional landlords seen in owner contacts.
const MANAGER_DOMAINS = [
  'amgtx.com', 'ah4r.com', 'rentprogress.com', 'mayhoa.com', 'maymonthomes.com', 'fiathomes.com',
  'invitationhomes.com', 'firstkeyhomes.com', 'triconresidential.com', 'mynd.co', 'progressresidential.com',
];

const EMAIL_RE = /^[^\s@;,]+@[^\s@;,]+\.[a-z]{2,}$/i;

function normalizeEmail(raw) {
  return String(raw == null ? '' : raw).trim().toLowerCase();
}

// What is wrong with this address on its own (null = usable).
function classifyEmail(raw) {
  const e = normalizeEmail(raw);
  if (!e) return { reason: 'no_email' };
  if ((e.match(/@/g) || []).length > 1 || /[;,\s]/.test(e)) return { reason: 'multiple_emails', detail: 'several addresses in one field' };
  if (!EMAIL_RE.test(e)) return { reason: 'invalid_email' };
  const [local, domain] = e.split('@');
  const dom = MANAGER_DOMAINS.find((d) => domain === d || domain.endsWith('.' + d));
  if (dom) return { reason: 'management_inbox', detail: `property-manager domain ${dom}` };
  const base = local.split('+')[0];
  if (ROLE_LOCAL_PARTS.has(base)) return { reason: 'management_inbox', detail: `role inbox ${base}@` };
  return null;
}

// ownerRows: v_current_property_owners rows { property_id, street_address, owner_contact_id, owner_name, owner_email }
// users:     portal_users rows { id, email, contact_id, status, invited_by, first_login_at }
// opts:      { contactIds?: [] (restrict), includeFlagged?: [] (override management_inbox) }
function buildRoster(ownerRows, users, opts = {}) {
  const include = new Set(opts.includeFlagged || []);
  const filter = Array.isArray(opts.contactIds) && opts.contactIds.length ? new Set(opts.contactIds) : null;

  // Group lots by owner contact.
  const byContact = new Map();
  for (const r of ownerRows || []) {
    if (!r || !r.owner_contact_id) continue;
    let g = byContact.get(r.owner_contact_id);
    if (!g) { g = { contact_id: r.owner_contact_id, name: r.owner_name || '', raw_email: r.owner_email || '', properties: [] }; byContact.set(r.owner_contact_id, g); }
    if (!g.properties.some((p) => p.property_id === r.property_id)) g.properties.push({ property_id: r.property_id, street_address: r.street_address || '' });
  }
  // Inbox -> distinct owner contacts (community-wide, before any filter).
  const contactsByEmail = new Map();
  for (const g of byContact.values()) {
    const e = normalizeEmail(g.raw_email);
    if (!e) continue;
    if (!contactsByEmail.has(e)) contactsByEmail.set(e, new Set());
    contactsByEmail.get(e).add(g.contact_id);
  }
  const userByContact = new Map();
  const userByEmail = new Map();
  for (const u of users || []) {
    if (u.contact_id && !userByContact.has(u.contact_id)) userByContact.set(u.contact_id, u);
    if (u.email) userByEmail.set(normalizeEmail(u.email), u);
  }

  const invite = [];
  const skipped = [];
  const groups = [...byContact.values()].filter((g) => !filter || filter.has(g.contact_id));
  for (const g of groups) {
    g.properties.sort((a, b) => String(a.property_id).localeCompare(String(b.property_id)));
    const email = normalizeEmail(g.raw_email);
    const base = { contact_id: g.contact_id, name: g.name, email: g.raw_email ? String(g.raw_email).trim() : '', properties: g.properties };
    const skip = (reason, detail) => skipped.push({ ...base, reason, ...(detail ? { detail } : {}) });

    const bad = classifyEmail(email);
    if (bad && bad.reason !== 'management_inbox') { skip(bad.reason, bad.detail); continue; }
    const sharers = contactsByEmail.get(email);
    if (sharers && sharers.size > 1) { skip('shared_email', `same inbox on ${sharers.size} owner contacts`); continue; }
    let override = false;
    if (bad && bad.reason === 'management_inbox') {
      if (!include.has(g.contact_id)) { skip('management_inbox', bad.detail); continue; }
      override = true;
    }

    const uc = userByContact.get(g.contact_id);
    const ue = userByEmail.get(email);
    let action = 'create';
    let portalUserId = null;
    if (uc && normalizeEmail(uc.email) !== email) { skip('portal_account_other_email', 'this owner already has an account under another email'); continue; }
    if (ue && ue.contact_id !== g.contact_id) { skip('email_has_other_portal_account', 'this inbox already signs in to another account'); continue; }
    const u = uc || ue;
    if (u) {
      if (u.status === 'revoked') { skip('portal_access_revoked'); continue; }
      if (u.invited_by === SILENT_CREATE_MARK && u.status === 'invited' && !u.first_login_at) { action = 'email_existing'; portalUserId = u.id; }
      else { skip('already_has_account'); continue; }
    }
    invite.push({ ...base, email, action, ...(portalUserId ? { portal_user_id: portalUserId } : {}), ...(override ? { override: 'management_inbox' } : {}) });
  }
  if (filter) {
    for (const cid of filter) if (!byContact.has(cid)) skipped.push({ contact_id: cid, name: '', email: '', properties: [], reason: 'not_a_current_owner' });
  }
  invite.sort((a, b) => String(a.contact_id).localeCompare(String(b.contact_id)));
  skipped.sort((a, b) => (a.reason + a.contact_id).localeCompare(b.reason + b.contact_id));
  const by_reason = {};
  for (const s of skipped) by_reason[s.reason] = (by_reason[s.reason] || 0) + 1;
  return {
    invite, skipped,
    counts: {
      owners: groups.length,
      lots: groups.reduce((n, g) => n + g.properties.length, 0),
      invite: invite.length,
      invite_new: invite.filter((r) => r.action === 'create').length,
      invite_existing_silent: invite.filter((r) => r.action === 'email_existing').length,
      skipped: skipped.length,
      by_reason,
    },
  };
}

// The approval fingerprint: exactly who, which inbox, which lots, what action.
function rosterHash(communityId, invite) {
  const canon = (invite || []).map((r) => [r.contact_id, normalizeEmail(r.email), (r.properties || []).map((p) => p.property_id).sort(), r.action]);
  canon.sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  return crypto.createHash('sha256').update(JSON.stringify([String(communityId), canon])).digest('hex').slice(0, 24);
}

function chunk(arr, n) { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; }

// Read-only load. Pages past 1000 rows and cross-checks the roster lot count
// against the live-lot count (CLAUDE.md Preview rule). Throws on any query error.
async function loadInviteRoster(supabase, communityId, opts = {}) {
  const { fetchAllQuery } = require('../db/fetch_all');
  const { data: community, error: cErr } = await supabase.from('communities')
    .select('id, name, slug, portal_active, is_demo').eq('id', communityId).maybeSingle();
  if (cErr) throw cErr;
  if (!community) return { community: null };
  const ownerRows = await fetchAllQuery(() => supabase.from('v_current_property_owners')
    .select('property_id, street_address, owner_contact_id, owner_name, owner_email').eq('community_id', communityId),
  { orderBy: 'property_id' });
  const { count: liveLots, error: lErr } = await supabase.from('properties')
    .select('id', { count: 'exact', head: true }).eq('community_id', communityId).is('excluded_at', null);
  if (lErr) throw lErr;

  const mgmtId = opts.managementCompanyId;
  const contactIds = [...new Set(ownerRows.map((r) => r.owner_contact_id).filter(Boolean))];
  const emails = [...new Set(ownerRows.map((r) => normalizeEmail(r.owner_email)).filter((e) => e && e.includes('@')))];
  const users = new Map();
  const cols = 'id, email, contact_id, status, invited_by, first_login_at';
  for (const ids of chunk(contactIds, 150)) {
    let q = supabase.from('portal_users').select(cols).in('contact_id', ids);
    if (mgmtId) q = q.eq('management_company_id', mgmtId);
    const { data, error } = await q.limit(1000);
    if (error) throw error;
    for (const u of data || []) users.set(u.id, u);
  }
  for (const es of chunk(emails, 150)) {
    let q = supabase.from('portal_users').select(cols).in('email', es);
    if (mgmtId) q = q.eq('management_company_id', mgmtId);
    const { data, error } = await q.limit(1000);
    if (error) throw error;
    for (const u of data || []) users.set(u.id, u);
  }
  const roster = buildRoster(ownerRows, [...users.values()], opts);
  const rosterLots = new Set(ownerRows.map((r) => r.property_id)).size;
  const cross_check = { live_lots: liveLots, owner_lots: rosterLots, ok: liveLots === rosterLots };
  return { community, roster, cross_check, hash: rosterHash(communityId, roster.invite) };
}

module.exports = { SILENT_CREATE_MARK, normalizeEmail, classifyEmail, buildRoster, rosterHash, loadInviteRoster, MANAGER_DOMAINS };
