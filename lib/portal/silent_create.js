// ============================================================================
// lib/portal/silent_create.js  (Ed 2026-11-27)
// ----------------------------------------------------------------------------
// The ONE path that creates homeowner portal accounts from an invite roster
// (lib/portal/invite_roster.js) without emailing anyone. Used by the owner-only
// bulk-invite endpoint (api/portal_admin.js, create_only / send / pilot) and by
// the Owner Authorization Service action portal_silent_create
// (lib/authorization/portal_silent_create.js). Nothing here creates a magic
// link, sends an email, or touches communities.portal_active, balances or
// payments.
// ============================================================================
'use strict';

const { BEDROCK_MGMT_CO_ID } = require('../company');
const { safeErrorMessage } = require('../../api/_safe_error');

async function insertAuditRows(supabase, rows) {
  for (let i = 0; i < rows.length; i += 200) {
    const { error } = await supabase.from('portal_audit_log').insert(rows.slice(i, i + 200));
    if (error) console.warn('[silent_create] audit insert failed:', error.message);
  }
}

// Create portal_users + lot grants for roster rows with action 'create'.
// Returns { byContact: { contact_id: portal_user_id }, failures: [{ contact_id, reason, detail }] }.
async function createRosterAccounts(supabase, rows, { performedBy, slug, via, mark }) {
  const { SILENT_CREATE_MARK } = require('./invite_roster');
  const invitedByMark = mark || SILENT_CREATE_MARK;
  const byContact = {};
  const failures = [];
  const toUserRow = (r) => ({
    management_company_id: BEDROCK_MGMT_CO_ID, email: r.email, full_name: r.name || null,
    role: 'homeowner', status: 'invited', contact_id: r.contact_id, invited_by: invitedByMark,
  });
  for (let i = 0; i < rows.length; i += 100) {
    const slice = rows.slice(i, i + 100);
    const { data, error } = await supabase.from('portal_users').insert(slice.map(toUserRow)).select('id, contact_id');
    if (!error) { for (const u of data || []) byContact[u.contact_id] = u.id; continue; }
    // One bad row fails the whole batch insert; retry this batch row by row so
    // the rest still land and the bad one is named.
    console.warn(`[silent_create] account batch failed, retrying per row: ${error.message}`);
    for (const r of slice) {
      const one = await supabase.from('portal_users').insert(toUserRow(r)).select('id, contact_id').single();
      if (one.error) failures.push({ contact_id: r.contact_id, reason: 'account_insert_failed', detail: safeErrorMessage(one.error) });
      else byContact[r.contact_id] = one.data.id;
    }
  }
  const grants = [];
  for (const r of rows) {
    const uid = byContact[r.contact_id];
    if (!uid) continue;
    for (const p of r.properties) grants.push({ portal_user_id: uid, property_id: p.property_id, granted_by: performedBy, revoked_at: null, revoked_by: null });
  }
  for (let i = 0; i < grants.length; i += 200) {
    const slice = grants.slice(i, i + 200);
    const { error } = await supabase.from('portal_user_properties').upsert(slice, { onConflict: 'portal_user_id,property_id' });
    if (error) {
      console.error('[silent_create] grant batch failed:', error.message);
      const uids = new Set(slice.map((g) => g.portal_user_id));
      for (const [cid, uid] of Object.entries(byContact)) if (uids.has(uid)) failures.push({ contact_id: cid, reason: 'lot_grant_failed', detail: safeErrorMessage(error) });
    }
  }
  await insertAuditRows(supabase, Object.values(byContact).map((uid) => ({
    portal_user_id: uid, action: 'user_invited', performed_by: performedBy, notes: `via=${via} community=${slug} email=not_sent`,
  })));
  return { byContact, failures };
}

// An owner whose account already exists (created silently earlier, not yet
// emailed) still needs THIS roster's lots: a later silent create in another
// association, or a lot bought since, never reached them before. Missing grants
// only (insert-if-missing on portal_user_id + property_id): a grant staff
// revoked stays revoked. (Ed 2026-11-27.)
async function grantExistingAccountLots(supabase, invite, { performedBy }) {
  const existingGrants = [];
  for (const r of (invite || []).filter((x) => x.action === 'email_existing' && x.portal_user_id)) {
    for (const p of r.properties) existingGrants.push({ portal_user_id: r.portal_user_id, property_id: p.property_id, granted_by: performedBy });
  }
  const failures = [];
  for (let i = 0; i < existingGrants.length; i += 200) {
    const { error } = await supabase.from('portal_user_properties').upsert(existingGrants.slice(i, i + 200), { onConflict: 'portal_user_id,property_id', ignoreDuplicates: true });
    if (error) {
      console.error('[silent_create] existing-account lot grants failed:', error.message);
      failures.push({ contact_id: null, reason: 'lot_grant_failed', detail: safeErrorMessage(error) });
    }
  }
  return { existing_accounts_checked: new Set(existingGrants.map((g) => g.portal_user_id)).size, failures };
}

// The whole silent create for one loaded roster: new accounts, then the
// existing silent accounts' missing lots. Emails nobody.
async function silentCreateRoster(supabase, roster, { performedBy, slug, via = 'silent_create', mark }) {
  const toCreate = (roster.invite || []).filter((r) => r.action === 'create');
  const created = await createRosterAccounts(supabase, toCreate, { performedBy, slug, via, mark });
  const existing = await grantExistingAccountLots(supabase, roster.invite, { performedBy });
  return { byContact: created.byContact, accounts_created: Object.keys(created.byContact).length,
    existing_accounts_checked: existing.existing_accounts_checked, failures: [...created.failures, ...existing.failures] };
}

module.exports = { createRosterAccounts, grantExistingAccountLots, silentCreateRoster, insertAuditRows };
