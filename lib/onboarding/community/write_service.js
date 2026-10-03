// ============================================================================
// lib/onboarding/community/write_service.js  (Issue #15) — canonical proposal + atomic apply
// ----------------------------------------------------------------------------
// The operator's write path for community data (migration 487, proposed):
//   source package -> resolve.js graph (evidence) -> proposalFromGraph (canonical
//   proposal + questions) -> validateChange (machine-readable controls, no DB) ->
//   applyChange (ONE call to cd_apply: validated again in the database and
//   executed in one transaction; idempotent by key + proposal hash).
// No name / email / phone / address is ever used to find a party: parties are
// found only by provider-scoped source identities. Nothing here guesses; a
// question blocks the apply until it is answered.
// ============================================================================
const crypto = require('crypto');

const canonical = (v) => (Array.isArray(v) ? `[${v.map(canonical).join(',')}]` : v && typeof v === 'object' ? `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}` : JSON.stringify(v));
const proposalSha256 = (change) => crypto.createHash('sha256').update(canonical(change)).digest('hex');
const isDate = (d) => d === null || d === undefined || /^\d{4}-\d{2}-\d{2}$/.test(String(d));
const START_BASES = ['unknown', 'transfer_settlement', 'deed_recorded', 'owner_statement'];
const END_BASES = ['transfer_settlement', 'deed_recorded', 'owner_statement'];

// Whole-proposal validation before any mutation. Returns { ok, failures: [{ code, path, message }] }.
function validateChange(change) {
  const f = []; const fail = (code, p, message) => f.push({ code, path: p, message });
  const c = change || {};
  const docs = new Map((c.documents || []).map((d) => [d.ref, d]));
  (c.documents || []).forEach((d, i) => {
    if (!d.ref) fail('DOCUMENT_WITHOUT_REF', `documents[${i}]`, 'a document needs a ref');
    if (!/^[0-9a-f]{64}$/.test(String(d.sha256 || ''))) fail('DOCUMENT_WITHOUT_HASH', `documents[${i}]`, 'a document needs its sha256');
    if (!d.observed_as_of || !isDate(d.observed_as_of)) fail('DOCUMENT_WITHOUT_OBSERVATION_DATE', `documents[${i}]`, 'a document needs the date it speaks for (observed_as_of)');
  });
  const partyRefs = new Set(); const identitySeen = new Map();
  (c.parties || []).forEach((p, i) => {
    partyRefs.add(p.ref);
    if (!p.identities || !p.identities.length) fail('PARTY_WITHOUT_SOURCE_IDENTITY', `parties[${i}]`, `party ${p.ref} has no durable source identity`);
    for (const id of p.identities || []) {
      if (!id.provider || !id.identity_kind || !id.identity_key || !id.slot) fail('INCOMPLETE_SOURCE_IDENTITY', `parties[${i}]`, 'an identity needs provider, kind, key and slot');
      const k = [id.provider, id.identity_kind, id.identity_key, id.slot].join('|');
      if (identitySeen.has(k) && identitySeen.get(k) !== p.ref) fail('IDENTITY_ON_TWO_PARTIES', `parties[${i}]`, `identity ${k} is given to ${identitySeen.get(k)} and ${p.ref}; identities are never shared`);
      identitySeen.set(k, p.ref);
    }
    if (!['person', 'organization', 'unknown'].includes(p.kind)) fail('PARTY_KIND_INVALID', `parties[${i}]`, 'kind is person / organization / unknown');
    if (!p.display_name) fail('PARTY_WITHOUT_NAME', `parties[${i}]`, 'a party needs the name the source gives');
  });
  const evidenceOk = (item, p) => {
    if (!item.evidence || !item.evidence.length) return fail('ITEM_WITHOUT_EVIDENCE', p, 'every material item needs evidence (document + locator + basis)');
    item.evidence.forEach((e, k) => {
      if (!(e.document_ref && docs.has(e.document_ref)) && !e.document_id) fail('EVIDENCE_UNKNOWN_DOCUMENT', `${p}.evidence[${k}]`, 'evidence must name a document of this proposal (or a recorded one)');
      if (!e.basis) fail('EVIDENCE_WITHOUT_BASIS', `${p}.evidence[${k}]`, 'evidence needs a basis');
    });
  };
  const party = (ref, p) => { if (!partyRefs.has(ref)) fail('UNKNOWN_PARTY_REF', p, `party ${ref} is not in this proposal`); };
  (c.ownerships || []).forEach((o, i) => {
    const p = `ownerships[${i}]`; party(o.party_ref, p); evidenceOk(o, p);
    if (!['owner', 'co_owner'].includes(o.role)) fail('OWNERSHIP_ROLE_INVALID', p, 'role is owner / co_owner');
    if (!START_BASES.includes(o.effective_from_basis)) fail('START_BASIS_INVALID', p, `start basis is one of ${START_BASES.join(', ')}`);
    if ((o.effective_from == null) !== (o.effective_from_basis === 'unknown')) fail('START_DATE_BASIS_MISMATCH', p, 'a start date needs its source basis; an unknown start stays null (never an import date)');
    if ((o.effective_to == null) !== (o.effective_to_basis == null)) fail('END_DATE_BASIS_MISMATCH', p, 'an end date needs its source basis');
    if (o.effective_to_basis != null && !END_BASES.includes(o.effective_to_basis)) fail('END_BASIS_INVALID', p, `end basis is one of ${END_BASES.join(', ')}`);
    if (o.effective_from && o.effective_to && o.effective_from > o.effective_to) fail('DATES_OUT_OF_ORDER', p, 'start after end');
    if (!o.observed_as_of) fail('MISSING_OBSERVED_AS_OF', p, 'observed_as_of (when the source said so) is required');
    if (!o.property_id) fail('OWNERSHIP_WITHOUT_PROPERTY', p, 'property_id required');
  });
  (c.ownership_ends || []).forEach((o, i) => { const p = `ownership_ends[${i}]`; evidenceOk(o, p); if (!o.ownership_id || !o.effective_to || !END_BASES.includes(o.effective_to_basis)) fail('OWNERSHIP_END_INCOMPLETE', p, 'an end names the ownership, the date and its basis'); });
  const leaseRefs = new Set((c.leases || []).map((l) => l.ref));
  (c.leases || []).forEach((l, i) => {
    const p = `leases[${i}]`; evidenceOk(l, p);
    if (!(l.document_ref && docs.has(l.document_ref)) && !l.document_id) fail('LEASE_WITHOUT_DOCUMENT', p, 'a lease is its document');
    if (l.start_date && l.end_date && l.start_date > l.end_date) fail('DATES_OUT_OF_ORDER', p, 'lease start after end');
    for (const r of l.tenant_party_refs || []) party(r, p);
  });
  (c.occupancies || []).forEach((o, i) => {
    const p = `occupancies[${i}]`; evidenceOk(o, p); if (o.party_ref) party(o.party_ref, p);
    if (!['lease', 'owner_statement', 'tenant_source'].includes(o.basis)) fail('OCCUPANCY_WITHOUT_EVIDENCE_BASIS', p, 'occupancy comes only from a lease, an owner statement or a tenant source; it is never inferred');
    if (o.occupancy_kind === 'tenant' && !['lease', 'tenant_source'].includes(o.basis)) fail('TENANT_WITHOUT_LEASE_OR_SOURCE', p, 'a tenant needs a lease or a tenant source');
    if ((o.basis === 'lease') !== !!o.lease_ref) fail('LEASE_BASIS_MISMATCH', p, 'a lease-based occupancy names its lease');
    if (o.lease_ref && !leaseRefs.has(o.lease_ref)) fail('UNKNOWN_LEASE_REF', p, `lease ${o.lease_ref} is not in this proposal`);
    if (!o.observed_as_of) fail('MISSING_OBSERVED_AS_OF', p, 'observed_as_of is required');
  });
  (c.addresses || []).forEach((a, i) => { const p = `addresses[${i}]`; party(a.party_ref, p); evidenceOk(a, p); if (!a.line1) fail('ADDRESS_WITHOUT_LINE1', p, 'an address needs its street line'); if (!a.observed_as_of) fail('MISSING_OBSERVED_AS_OF', p, 'observed_as_of is required'); });
  const tenantParty = new Set((c.parties || []).filter((p) => (p.identities || []).some((id) => ['tenant_id', 'lease_party'].includes(id.identity_kind))).map((p) => p.ref));
  (c.contact_methods || []).forEach((m, i) => {
    const p = `contact_methods[${i}]`; party(m.party_ref, p); evidenceOk(m, p);
    if (!['email', 'phone'].includes(m.method_type) || !m.value) fail('CONTACT_METHOD_INVALID', p, 'email / phone with a value');
    if (m.attribution === 'tenant' && !tenantParty.has(m.party_ref)) fail('TENANT_ATTRIBUTION_NOT_TENANT', p, 'tenant attribution on a party that is not a tenant');
    if (m.attribution !== 'tenant' && (m.evidence || []).some((e) => ['lease', 'amenity_application'].includes((docs.get(e.document_ref) || {}).kind))) fail('LEASE_DOCUMENT_FEEDS_OWNER_CONTACT', p, 'a lease / application never supplies an owner\'s contact method');
    if (!m.observed_as_of) fail('MISSING_OBSERVED_AS_OF', p, 'observed_as_of is required');
  });
  return { ok: f.length === 0, failures: f };
}

// Build the canonical proposal from a resolve.js graph. documents: [{ file_sha256, provider, kind, filename, observed_as_of, period_start, period_end }]
function proposalFromGraph(graph, { documents, propertyIdOfAccount }) {
  const docRef = (sha) => `doc:${sha.slice(0, 12)}`;
  const docBySha = new Map(documents.map((d) => [d.file_sha256, d]));
  const ev = (provs, basis) => (provs || []).filter((pv) => pv && docBySha.has(pv.file_sha256)).map((pv) => ({ document_ref: docRef(pv.file_sha256), locator: Object.fromEntries(Object.entries({ sheet: pv.sheet, row: pv.row, line: pv.line }).filter(([, v]) => v != null)), basis }));
  const partyKeyToRef = (k) => `party:${k}`;
  const identityOf = (p) => {
    const si = p.source_identity || {};
    if (si.homeowner_id) return { provider: si.provider || 'vantaca', identity_kind: 'homeowner_id', identity_key: si.homeowner_id, slot: si.slot || 'owner' };
    if (si.report === 'ownership_transfer_report') return { provider: si.provider || 'vantaca', identity_kind: 'transfer_record', identity_key: `${si.account}:${si.settlement_date}`, slot: 'previous_owner' };
    if (si.tenant_id) return { provider: si.provider || 'lease', identity_kind: 'tenant_id', identity_key: si.tenant_id, slot: 'tenant' };
    if (si.document_sha256) return { provider: 'lease', identity_kind: 'lease_party', identity_key: si.document_sha256, slot: `tenant:${si.slot}` };
    return null;
  };
  const kindOf = (p) => (p.kind === 'organization' ? ['organization', 'source_field'] : p.kind === 'organization_by_name_pattern' ? ['organization', 'name_pattern_flag'] : p.kind === 'person' && (p.first || p.last) ? ['person', 'source_field'] : ['unknown', 'unknown']);
  const change = { documents: documents.map((d) => ({ ref: docRef(d.file_sha256), provider: d.provider, kind: d.kind, filename: d.filename, sha256: d.file_sha256, period_start: d.period_start || null, period_end: d.period_end || null, observed_as_of: d.observed_as_of })),
    parties: [], property_identities: [], ownerships: [], leases: [], occupancies: [], addresses: [], contact_methods: [] };
  for (const p of graph.parties) {
    const id = identityOf(p); if (!id) continue;
    const [kind, kind_basis] = kindOf(p);
    change.parties.push({ ref: partyKeyToRef(p.key), kind, kind_basis, display_name: p.name || '(name not given)', given_name: p.first || null, family_name: p.last || null, identities: [id] });
  }
  for (const pr of graph.properties) { const pid = propertyIdOfAccount(pr.account); if (pid) change.property_identities.push({ property_id: pid, provider: 'vantaca', identity_key: pr.account }); }
  const pidOfKey = (k) => propertyIdOfAccount(k.replace(/^property:/, ''));
  for (const o of graph.ownerships) change.ownerships.push({ property_id: pidOfKey(o.property_key), party_ref: partyKeyToRef(o.party_key), role: o.role, effective_from: o.effective_from, effective_from_basis: o.effective_from ? 'transfer_settlement' : 'unknown', effective_to: null, effective_to_basis: null, observed_as_of: o.observed_as_of, evidence: ev(o.provenance, o.effective_from ? 'owner record + transfer settlement' : 'current owner record') });
  for (const o of graph.prior_ownerships || []) change.ownerships.push({ property_id: pidOfKey(o.property_key), party_ref: partyKeyToRef(o.party_key), role: 'owner', effective_from: null, effective_from_basis: 'unknown', effective_to: o.effective_to, effective_to_basis: 'transfer_settlement', observed_as_of: (graph.transfer_period && graph.transfer_period.end) || graph.observed_as_of, evidence: ev(o.provenance, 'previous owner on the transfer report') });
  for (const l of graph.leases || []) change.leases.push({ ref: l.key, property_id: pidOfKey(l.property_key), document_ref: docRef(l.document_sha256), start_date: l.start, end_date: l.end, received_at: l.received_at, tenant_party_refs: l.tenant_party_keys.map(partyKeyToRef), evidence: ev(l.provenance, 'lease document') });
  for (const o of graph.occupancies || []) change.occupancies.push({ property_id: pidOfKey(o.property_key), party_ref: o.party_key ? partyKeyToRef(o.party_key) : null, occupancy_kind: o.role === 'tenant' ? 'tenant' : o.role === 'owner_occupied' ? 'owner_occupant' : 'vacant', basis: o.basis === 'lease' ? 'lease' : 'owner_statement', lease_ref: o.lease_key || null, effective_from: o.from || null, effective_to: null, observed_as_of: graph.observed_as_of, evidence: ev(o.provenance, o.basis === 'lease' ? 'tenant on the lease' : 'owner statement') });
  for (const m of graph.mailing_addresses) change.addresses.push({ party_ref: partyKeyToRef(m.party_keys[0]), purpose: 'mailing', line1: [m.address.street_no, m.address.line1].filter(Boolean).join(' '), line2: m.address.line2 || null, unit: m.address.unit || null, city: m.address.city || null, state: m.address.state || null, postal_code: m.address.zip || null, is_primary: !!m.primary, is_property_address: !!m.mail_goes_to_property, observed_as_of: graph.observed_as_of, evidence: ev(m.provenance, m.primary ? 'primary mailing address marked by the source' : 'mailing address on the owner record') });
  for (const m of graph.contact_methods) {
    // tenant methods belong to the tenant party; account-keyed methods to the owner record's party
    const ref = m.party_key ? partyKeyToRef(m.party_key) : partyKeyToRef(`party:hid:${m.owner_record}`);
    change.contact_methods.push({ party_ref: ref, method_type: m.type, value: m.value, attribution: m.attributed_to === 'tenant' ? 'tenant' : 'owner_record', is_primary: !!m.primary, observed_as_of: graph.observed_as_of, evidence: ev(m.provenance, m.attributed_to === 'tenant' ? 'on the lease' : 'on the account in the contact export') });
  }
  const questions = (graph.questions || []).map((q) => ({ type: q.type, question: q.question, choices: q.choices || null }));
  return { change, questions, ready: questions.length === 0 };
}

// Validate, then ONE database call (validated again there; one transaction; idempotent).
async function applyChange({ rpc, community_id, idempotency_key, change, actor }) {
  const v = validateChange(change);
  if (!v.ok) return { ok: false, applied: false, failures: v.failures };
  if (!actor || !actor.kind || !actor.id) return { ok: false, applied: false, failures: [{ code: 'ACTOR_REQUIRED', path: 'actor', message: 'an actor is required' }] };
  let result;
  try { result = await rpc('cd_apply', { p_community: community_id, p_idempotency_key: idempotency_key, p_proposal_sha256: proposalSha256(change), p_change: change, p_actor_kind: actor.kind, p_actor_id: actor.id }); }
  catch (e) {
    // a database refusal is an answer, not a crash: nothing was written (one transaction)
    if (/^community data:/.test(e.message || '') || /23514|23505|23503/.test(String(e.code || ''))) return { ok: false, applied: false, failures: [{ code: 'REFUSED_BY_DATABASE', path: null, message: e.message }] };
    throw e;
  }
  return { ok: true, applied: !result.replayed, replayed: !!result.replayed, result };
}

module.exports = { validateChange, proposalFromGraph, applyChange, proposalSha256, canonical };
