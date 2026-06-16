// ============================================================================
// lib/builder_applications/resolve_builder_company.js
// ----------------------------------------------------------------------------
// Match an incoming builder name + contact to an existing builder_companies
// row when "close enough" — silently auto-creating duplicate rows for every
// variant ("DRB Group" vs "DRB Group, Inc." vs "D.R.B. Group") quietly
// poisons the per-builder history that the AI recommendation block depends
// on.
//
// Three-tier dedup ladder. Each tier is conservative; we only fall to the
// next tier when the prior tier returned exactly zero matches.
//
//   1. EXACT (case-insensitive)
//      "DRB Group" -> "drb group" matches builder_companies whose
//      lower(company_name) = "drb group". Default behavior.
//
//   2. NORMALIZED
//      Strip punctuation + trailing legal suffixes (Inc, LLC, Corp, Co,
//      Homes, Group, Construction, Builders, Holdings) on both sides
//      before comparing. "DRB Group, Inc." -> "drb" matches an existing
//      "DRB Group" -> "drb". One-to-many = ambiguous, skip.
//
//   3. EMAIL DOMAIN
//      If the contact email has a domain (karla@drbgroup.com), look for any
//      existing builder_companies whose primary_email_domain is "drbgroup.com"
//      OR whose primary_contact_email ends with the domain. Free-email
//      domains (gmail, yahoo, hotmail, outlook, aol, icloud) are EXCLUDED
//      since they collide trivially across unrelated builders.
//
// Returns:
//   { ok: true, id, match_type, matched_name }                — found
//   { ok: true, id: null, match_type: 'ambiguous', candidates } — manual
//   { ok: false, error }                                       — db error
//
// match_type values: 'exact' | 'normalized' | 'domain' | 'created' | 'ambiguous'
// ============================================================================

const FREE_EMAIL_DOMAINS = new Set([
  'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'aol.com',
  'icloud.com', 'me.com', 'live.com', 'msn.com', 'ymail.com',
  'protonmail.com', 'proton.me',
]);

// Legal-suffix tokens stripped during normalization. Lowercase, no punctuation.
const STRIP_TOKENS = new Set([
  'inc', 'incorporated', 'llc', 'lp', 'llp', 'corp', 'corporation',
  'co', 'company', 'homes', 'home', 'group', 'construction', 'builders',
  'builder', 'holdings', 'enterprises', 'enterprise', 'partners',
  'partnership', 'limited', 'ltd', 'usa',
]);

function normalizeBuilderName(raw) {
  if (!raw) return '';
  return String(raw)
    .toLowerCase()
    // Strip punctuation, keep word chars + spaces
    .replace(/[^a-z0-9\s]/g, ' ')
    // Collapse whitespace
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter((tok) => tok && !STRIP_TOKENS.has(tok))
    .join(' ');
}

function domainFrom(email) {
  if (!email) return null;
  const m = String(email).match(/@([^>\s]+)/);
  if (!m) return null;
  const d = m[1].toLowerCase().trim();
  return FREE_EMAIL_DOMAINS.has(d) ? null : d;
}

/**
 * Resolve an extracted builder identity to an existing builder_companies
 * row, or signal that a new row should be created. Does NOT create rows
 * itself — caller decides whether to insert based on match_type.
 *
 * @param {object} supabase  authenticated supabase client (service role)
 * @param {object} input     { company_name (required), contact_email, mgmt_co_id }
 * @returns {Promise<object>}
 */
async function resolveBuilderCompany(supabase, input) {
  const companyName = (input && input.company_name || '').trim();
  if (!companyName) {
    return { ok: false, error: 'company_name is required' };
  }
  const contactEmail = (input && input.contact_email || '').trim();
  const mgmtCoId = input && input.mgmt_co_id;

  // Pulling primary_contact_name + primary_contact_phone too so the caller
  // (upload-on-behalf) can prefer authoritative on-file contact info over
  // the AI's partial page-1 extraction. Ed 2026-06-16: "you have Karla's
  // full name, why did you use the partial one."
  const SELECT_COLS = 'id, company_name, primary_email_domain, primary_contact_email, primary_contact_name, primary_contact_phone';
  let baseQuery = supabase
    .from('builder_companies')
    .select(SELECT_COLS);
  if (mgmtCoId) baseQuery = baseQuery.eq('management_company_id', mgmtCoId);

  // ---- Tier 1: exact case-insensitive ----
  {
    const { data, error } = await baseQuery.ilike('company_name', companyName);
    if (error) return { ok: false, error: error.message };
    if (data && data.length === 1) {
      return {
        ok: true,
        id: data[0].id,
        match_type: 'exact',
        matched_name: data[0].company_name,
        matched_company: data[0],   // full row for caller to pull contact info
      };
    }
    if (data && data.length > 1) {
      // Exact (case-insensitive) match returned multiples — this means a
      // duplicate already exists in builder_companies. Don't auto-pick;
      // return ambiguous so a human resolves it.
      return {
        ok: true,
        id: null,
        match_type: 'ambiguous',
        candidates: data.map((r) => ({ id: r.id, company_name: r.company_name })),
      };
    }
  }

  // ---- Tier 2: normalized name ----
  const normalizedQuery = normalizeBuilderName(companyName);
  if (normalizedQuery) {
    // Pull a small candidate window first — we can't normalize in SQL
    // efficiently without an index, so we filter in-memory. Limit by
    // first token (usually the brand) to keep candidates tight.
    const firstToken = normalizedQuery.split(' ')[0];
    let candQuery = supabase
      .from('builder_companies')
      .select(SELECT_COLS)
      .ilike('company_name', `%${firstToken}%`);
    if (mgmtCoId) candQuery = candQuery.eq('management_company_id', mgmtCoId);
    const { data: cands, error: cErr } = await candQuery.limit(20);
    if (cErr) return { ok: false, error: cErr.message };
    const normMatches = (cands || []).filter((r) => normalizeBuilderName(r.company_name) === normalizedQuery);
    if (normMatches.length === 1) {
      return {
        ok: true,
        id: normMatches[0].id,
        match_type: 'normalized',
        matched_name: normMatches[0].company_name,
        matched_company: normMatches[0],
        normalized_query: normalizedQuery,
      };
    }
    if (normMatches.length > 1) {
      return {
        ok: true,
        id: null,
        match_type: 'ambiguous',
        candidates: normMatches.map((r) => ({ id: r.id, company_name: r.company_name })),
      };
    }
  }

  // ---- Tier 3: email domain ----
  const domain = domainFrom(contactEmail);
  if (domain) {
    // Prefer primary_email_domain column when populated; fall back to a
    // suffix match on primary_contact_email for older rows that predate
    // the domain column.
    let dq = supabase
      .from('builder_companies')
      .select(SELECT_COLS)
      .or(`primary_email_domain.eq.${domain},primary_contact_email.ilike.%@${domain}`);
    if (mgmtCoId) dq = dq.eq('management_company_id', mgmtCoId);
    const { data: dRows, error: dErr } = await dq.limit(5);
    if (dErr) return { ok: false, error: dErr.message };
    if (dRows && dRows.length === 1) {
      return {
        ok: true,
        id: dRows[0].id,
        match_type: 'domain',
        matched_name: dRows[0].company_name,
        matched_company: dRows[0],
        matched_domain: domain,
      };
    }
    if (dRows && dRows.length > 1) {
      return {
        ok: true,
        id: null,
        match_type: 'ambiguous',
        candidates: dRows.map((r) => ({ id: r.id, company_name: r.company_name })),
        matched_domain: domain,
      };
    }
  }

  // Nothing matched — caller will create a new row.
  return {
    ok: true,
    id: null,
    match_type: 'created',
    normalized_query: normalizedQuery || null,
    matched_domain: domain || null,
  };
}

module.exports = {
  resolveBuilderCompany,
  normalizeBuilderName,
  domainFrom,
};
