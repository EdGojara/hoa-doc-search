// ============================================================================
// lib/acc/address_cases.js  (Ed 2026-11-27)
// ----------------------------------------------------------------------------
// THE ACC CASES AT ONE ADDRESS, from the canonical record (acc_decisions).
// acc_decisions has no property_id: a case belongs to a lot by community +
// homeowner_address, matched on the canonical street address (the same rule
// Annie's property history uses). Portal applications are on acc_decisions too
// (linked back by community_application_id), so this is the whole picture.
//
// accCasesForAddress(supabase, { communityId, address, openOnly, select })
//   -> rows (newest first), each with the decision in effect (withEffective).
//   Withdrawn and archived cases are never returned. openOnly keeps only the
//   cases still in flight. Throws on a query error: an unreadable ACC record
//   must never look like "no ACC cases".
// ============================================================================
const { normalizeAddress } = require('../entity_resolution');
const { fetchAllQuery } = require('../db/fetch_all');
const { withEffective } = require('./effective');

const OPEN_STATUSES = ['pending_review', 'awaiting_info', 'finalizing'];
const EXCLUDED_STATUSES = ['withdrawn', 'archived'];
const BASE_COLS = ['id', 'reference_number', 'status', 'decision_type', 'project_summary', 'created_at', 'decided_at', 'homeowner_address', 'community_application_id'];

const canon = (a) => { try { return normalizeAddress(a).canonical || null; } catch (_) { return null; } };

async function accCasesForAddress(supabase, { communityId, address, openOnly = false, select = null } = {}) {
  const target = canon(address);
  const num = target && (target.match(/^\d+/) || [])[0];
  if (!supabase || !communityId || !target || !num) return [];
  const cols = [...new Set([...BASE_COLS, ...String(select || '').split(',').map((c) => c.trim()).filter(Boolean)])].join(', ');
  const rows = await fetchAllQuery(() => {
    const q = supabase.from('acc_decisions').select(cols)
      .eq('community_id', communityId).ilike('homeowner_address', `${num} %`);
    return openOnly ? q.in('status', OPEN_STATUSES) : q.not('status', 'in', `(${EXCLUDED_STATUSES.join(',')})`);
  });
  const mine = rows
    .filter((a) => !EXCLUDED_STATUSES.includes(a.status) && (!openOnly || OPEN_STATUSES.includes(a.status)))
    .filter((a) => canon(a.homeowner_address) === target)
    .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
  return withEffective(supabase, mine);
}

module.exports = { accCasesForAddress, ACC_OPEN_STATUSES: OPEN_STATUSES };
