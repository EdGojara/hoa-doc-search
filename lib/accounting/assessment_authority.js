// ============================================================================
// lib/accounting/assessment_authority.js — FY budget funding vs the board's
// assessment-increase authority (Forecast Phase 3B design hook, Ed 2026-09-25).
// PURE. No UI yet.
//
// The authority rule is community-specific and source-backed (table
// community_assessment_authority, migration 465). Only a VERIFIED rule with a
// document + citation + excerpt is used to draw a conclusion. Without one, the
// result says "authority not on file" and draws no legal conclusion — there is
// deliberately no global default cap.
// ============================================================================

const int = (n) => Math.round(Number(n) || 0);

/**
 * @param {object} p
 *   required_operating_cents      total operating expense requirement
 *   required_reserve_cents        reserve contribution requirement
 *   non_assessment_revenue_cents  interest, fees, other revenue expected
 *   current_assessment_revenue_cents  current annual assessment revenue (levy)
 *   units                         optional billable units (per-unit amounts)
 *   authority                     row from community_assessment_authority (or null)
 */
function assessmentFundingCheck(p) {
  const requiredRevenue = int(p.required_operating_cents) + int(p.required_reserve_cents) - int(p.non_assessment_revenue_cents);
  const current = int(p.current_assessment_revenue_cents);
  if (current <= 0) throw new Error('current_assessment_revenue_required');
  const requiredIncreasePct = Math.round(((requiredRevenue - current) / current) * 100000) / 1000; // 3 dp
  const units = int(p.units) || null;
  const perUnit = (c) => (units ? Math.round(c / units) : null);
  const out = {
    current_assessment_revenue_cents: current, required_assessment_revenue_cents: requiredRevenue,
    required_increase_pct: requiredIncreasePct,
    current_per_unit_cents: perUnit(current), required_per_unit_cents: perUnit(requiredRevenue),
    authority_on_file: false, conclusion: null,
  };
  const a = p.authority;
  if (!a || a.status !== 'verified' || a.board_max_increase_pct == null || !a.source_document_id || !a.source_citation) {
    out.conclusion = 'authority_not_on_file';
    out.note = 'No verified, source-backed assessment-increase rule is on file for this community. No conclusion about board authority is drawn.';
    return out;
  }
  const cap = Number(a.board_max_increase_pct);
  const maxRevenue = Math.floor(current * (1 + cap / 100));
  out.authority_on_file = true;
  out.board_max_increase_pct = cap;
  out.max_without_member_approval_cents = maxRevenue;
  out.max_per_unit_cents = perUnit(maxRevenue);
  out.shortfall_at_cap_cents = Math.max(0, requiredRevenue - maxRevenue);
  out.within_board_authority = requiredRevenue <= maxRevenue;
  out.source = { document_id: a.source_document_id, citation: a.source_citation, excerpt: a.source_excerpt || null, effective_from: a.effective_from || null };
  if (out.within_board_authority) { out.conclusion = 'within_board_authority'; return out; }
  if (a.above_cap_permitted === false) { out.conclusion = 'above_cap_not_permitted'; return out; }
  if (a.above_cap_permitted == null) { out.conclusion = 'above_cap_path_not_on_file'; return out; }
  out.conclusion = 'member_approval_required';
  out.member_approval = {
    threshold_pct: a.member_approval_threshold_pct == null ? null : Number(a.member_approval_threshold_pct),
    basis: a.member_approval_basis || null,
    procedural_steps: a.procedural_steps || [],
  };
  return out;
}

module.exports = { assessmentFundingCheck };
