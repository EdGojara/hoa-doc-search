// ============================================================================
// lib/acc/prior_approvals.js  (Ed 2026-11-27)
// ----------------------------------------------------------------------------
// The dates of approvals already DECIDED and on record for the same property, so a
// letter that refers to one ("your tree removal application, which was approved
// with conditions on August 10, 2026") is not read as granting a new approval. The
// decision-authority detector (lib/acc/decision_authority grantsApproval) skips an
// approval statement only when its date is one of these, so the exception is
// verified against the records and cannot be used to assert an approval that was
// never made.
// ============================================================================

const norm = (a) => String(a || '').toLowerCase().replace(/,.*$/, '')
  .replace(/\b(drive|dr|lane|ln|court|ct|street|st|trail|trl|way|circle|cir|road|rd|boulevard|blvd|avenue|ave|place|pl|bend|bnd)\b\.?/g, '')
  .replace(/[^a-z0-9]/g, '');
const centralDate = (iso) => new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });

/** ['YYYY-MM-DD', ...] of decided approvals at the same property (excluding this case). */
async function priorApprovalDates(supabase, row) {
  if (!row || !row.community_id || !row.homeowner_address) return [];
  const street = String(row.homeowner_address).split(',')[0].trim();
  const num = (street.match(/^\d+/) || [])[0];
  if (!num) return [];
  const { data, error } = await supabase.from('acc_decisions').select('id, homeowner_address, status, decision_type, decided_at')
    .eq('community_id', row.community_id).eq('status', 'decided').ilike('homeowner_address', `${num} %`).limit(200);
  if (error) { console.warn('[acc prior approvals] lookup failed:', error.message); return []; }
  const key = norm(row.homeowner_address);
  return [...new Set((data || []).filter((d) => d.id !== row.id && norm(d.homeowner_address) === key && /^approved/.test(String(d.decision_type || '')) && d.decided_at)
    .map((d) => centralDate(d.decided_at)))];
}

module.exports = { priorApprovalDates, centralDate };
