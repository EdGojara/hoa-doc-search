// ============================================================================
// lib/onboarding/community/sufficiency.js  (Issue #15) — what the community data proves
// ----------------------------------------------------------------------------
// Read-only inventory the operator runs before any community-data import: what
// it has, what each source proves, what is missing, and the exact Vantaca report
// to request for each gap (by the provider's own name). No column mapping by a
// human; nothing is imported.
// ============================================================================
const { COMMUNITY_PACKAGE } = require('./vantaca_roster');

function inventory(src, graph, { transfer_report = null, tenancy_evidence = null, expected_accounts = null } = {}) {
  const accountsInRoster = new Set(src.roster.filter((r) => !r.placeholder).map((r) => r.account));
  const proves = [];
  const missing = [];
  const add = (dimension, status, evidence, request = null) => (status === 'proven' ? proves : missing).push({ dimension, status, evidence, ...(request ? { request } : {}) });
  const expected = expected_accounts ? new Set(expected_accounts) : null;
  const rosterCovers = expected ? [...expected].filter((a) => accountsInRoster.has(a)).length : accountsInRoster.size;
  if (src.roster.length && (!expected || rosterCovers === expected.size)) add('current owner roster', 'proven', `${accountsInRoster.size} accounts, ${new Set(src.roster.filter((r) => !r.placeholder).map((r) => r.homeowner_id)).size} Vantaca owner records (Homeowner ID)${expected ? `, every one of the ${expected.size} financial accounts` : ''}`);
  else add('current owner roster', src.roster.length ? 'partial' : 'missing', src.roster.length ? `covers ${rosterCovers} of ${expected.size} financial accounts` : 'no roster export', COMMUNITY_PACKAGE.find((p) => p.kind === 'roster'));
  const propRows = graph.properties.filter((p) => p.address).length;
  if (src.contact_address.length && propRows === graph.properties.length) add('property (lot) addresses', 'proven', `${propRows} of ${graph.properties.length} accounts`);
  else add('property (lot) addresses', src.contact_address.length ? 'partial' : 'missing', `${propRows} of ${graph.properties.length} accounts`, COMMUNITY_PACKAGE.find((p) => p.kind === 'contacts'));
  if (graph.mailing_addresses.length) add('mailing addresses', 'proven', `${graph.mailing_addresses.filter((m) => m.primary).length} primary mailing addresses; ${graph.mailing_addresses.filter((m) => m.primary && !m.mail_goes_to_property).length} go somewhere other than the property`);
  else add('mailing addresses', 'missing', 'none', COMMUNITY_PACKAGE.find((p) => p.kind === 'contacts'));
  const withEmail = new Set(graph.contact_methods.filter((m) => m.type === 'email').map((m) => m.owner_record)).size;
  const withPhone = new Set(graph.contact_methods.filter((m) => m.type === 'phone').map((m) => m.owner_record)).size;
  const records = new Set(graph.parties.filter((p) => p.role_on_record === 'owner').map((p) => p.source_identity.homeowner_id)).size;
  if (src.contact_email.length || src.contact_phone.length) add('emails and phones', 'proven', `email on ${withEmail} of ${records} owner records, phone on ${withPhone}; attributed to the owner record (the source keys them by account, not by person)`);
  else add('emails and phones', 'missing', 'none', COMMUNITY_PACKAGE.find((p) => p.kind === 'contacts'));
  add('co-owners', 'proven', `${graph.parties.filter((p) => p.role_on_record === 'co_owner').length} co-owners named by the source (spouse fields)${graph.questions.some((q) => q.type === 'second_name_on_owner_record') ? '; some second names need a decision' : ''}`);
  if (transfer_report && transfer_report.period) {
    const linked = graph.transfers.filter((t) => t.linked_owner_record).length;
    add('ownership transfers in the report period', 'proven', `${graph.transfers.length} transfer(s) settled ${transfer_report.period.start} to ${transfer_report.period.end}; ${linked} linked to the current owner record, ${graph.transfers.length - linked} need a decision; ${graph.prior_ownerships.length} prior owner(s) recorded`);
    const unknown = graph.ownerships.filter((o) => o.role === 'owner' && !o.effective_from).length;
    missing.push({ dimension: 'ownership start dates outside the report period', status: 'partial', evidence: `${unknown} current ownership(s) have no transfer in ${transfer_report.period.start} to ${transfer_report.period.end}: acquired before the period (or after it); start stays unknown`, request: { report: `Ownership Transfer Report for ${transfer_report.period.end} onward (to the roster date), and for earlier years if Vantaca holds them`, why_missing: 'the report proves only the transfers in its stated period', required: false } });
  } else add('ownership start dates and prior owners', 'missing', 'no transfer source: ownerships are "owner as of the export date", start unknown, no prior owner recorded', COMMUNITY_PACKAGE.find((p) => p.kind === 'transfers'));
  const leasesKnown = graph.leases.length;
  if (leasesKnown) add('tenants and leases', 'proven', `${leasesKnown} lease(s), ${graph.occupancies.filter((o) => o.role === 'tenant').length} tenancy link(s)`);
  else add('tenants and occupants', 'missing', `no tenant / lease source: occupancy is "not established" on all ${graph.properties.length} properties (never owner-occupied by default)${src.recurring_charge_sheets && src.recurring_charge_sheets.length ? '. The Homeowner Rent Export supplied is recurring charges, not tenants (' + src.recurring_charges.length + ' rows)' : ''}`, COMMUNITY_PACKAGE.find((p) => p.kind === 'tenants'));
  const requests = missing.filter((m) => m.request).map((m) => ({ report: m.request.report, why: m.request.why_missing || `needed for ${m.dimension}`, required: !!m.request.required }));
  return { proves, missing, requests, sources: src.files, unrecognized_sheets: src.unrecognized_sheets };
}

module.exports = { inventory };
