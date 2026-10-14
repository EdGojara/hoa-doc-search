// ============================================================================
// lib/ap/line_rules.js  (Ed 2026-10-14: split Bedrock invoices by the contract)
// ----------------------------------------------------------------------------
// A contract-driven coding rule for a vendor's invoice LINES at one community
// (vendor_line_rules, migration 527): "Onsite Staff (4 days week)" -> 5855 Clubhouse
// Office Staffing, "Monthly Management Fee" -> 5810, "Website and homeowner/board
// Portals" -> 5030. A rule codes the line deterministically and BEFORE history-based
// classification: Canyon Gate's October onsite-staff line was coded to 5810 because a
// September reclass had taught the history that account. A rule names the clause it
// rests on, so the coding is auditable.
//
// One line matching rules for two different accounts is ambiguous: no rule applies and
// the line falls through to the classifier, flagged for review.
// ============================================================================

function compile(pattern) { try { return new RegExp(pattern, 'i'); } catch (_) { return null; } }

/** PURE. The rule for one line, or null (none, or ambiguous). */
function ruleForLine(rules, description) {
  const text = String(description || '');
  const hits = (rules || []).filter((r) => { const re = compile(r.pattern); return re && re.test(text); });
  const accounts = new Set(hits.map((r) => r.gl_account_id));
  if (accounts.size !== 1) return hits.length ? { ambiguous: true, hits } : null;
  return hits[0];
}

async function loadRules(supabase, { communityId, vendorId }) {
  if (!supabase || !communityId || !vendorId) return [];
  const { data, error } = await supabase.from('vendor_line_rules')
    .select('id, pattern, gl_account_id, basis, chart_of_accounts:gl_account_id(account_number, account_name)')
    .eq('community_id', communityId).eq('vendor_id', vendorId).eq('is_active', true).limit(200);
  if (error) {
    // Before migration 527 the table does not exist: no rules, never a failed intake.
    if (!/vendor_line_rules/.test(error.message || '')) console.warn('[line_rules] load failed:', error.message, { communityId, vendorId });
    return [];
  }
  return data || [];
}

module.exports = { ruleForLine, loadRules };
