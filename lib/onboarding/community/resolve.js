// ============================================================================
// lib/onboarding/community/resolve.js  (Issue #15) — properties / parties / relationships
// ----------------------------------------------------------------------------
// Turns Vantaca community-data source records into a canonical graph, by
// DETERMINISTIC identity rules. Prior conversions produced false identity merges,
// wrong names / addresses and bad owner-property links; these rules exist so that
// cannot happen silently. Nothing here writes anywhere.
//
//   R1  PROPERTY = the Vantaca account. Its address is the account's "Property"
//       address row (Homeowner Contact Information), cross-checked against the
//       financial reports' property address when given. Conflicts are questions.
//   R2  OWNER PARTY = the Vantaca Homeowner ID. One Homeowner ID on several
//       accounts = one party owning several properties (durable source identity).
//       Different Homeowner IDs = different parties, ALWAYS, even with an identical
//       name, email, phone or mailing address. SAME NAME IS NEVER A MERGE.
//   R3  CO-OWNER = a second person the source names on the SAME owner record
//       (spouse fields). Keyed to that record only; never matched to anyone else.
//       A different name on another row of the same record is NOT assumed to be a
//       co-owner: it becomes a question.
//   R4  "Current Resident" style rows are mail addressed to the property, not people.
//   R5  Mailing addresses belong to the owner record; the primary one is the one
//       the source marks. The property address is a mailing address only when the
//       source says mail goes to the property.
//   R6  Emails / phones are keyed to the ACCOUNT by the source, so they attach to
//       the owner record (all its people), never to one co-owner. The same email or
//       phone on two owner records stays on both and links nobody.
//   R7  An organization only when the source says so (business name), or flagged
//       by a legal-suffix name pattern (a classification, never a relationship).
//   R8  An ownership's start date only from TRANSFER EVIDENCE (Vantaca Ownership
//       Transfer Report): the transfer is linked to its property by the exact lot
//       address, and to the current owner record only when the names agree exactly
//       on that property; otherwise it is a question. The report's period bounds
//       what it proves: owners with no transfer in the period keep "start unknown"
//       ("owner as of <export date>"). Never the import date. A prior owner is its
//       own party from the transfer, never matched to anyone by name. A changed
//       name is never treated as a sale.
//   R9  Occupancy is separate from ownership. A tenant is a party linked through a
//       tenancy (lease) with provenance; an owner is never overwritten or conflated
//       with a tenant. No tenant source = occupancy "not established"; never
//       owner-occupied by default, never a tenant invented.
//   R10 A lease is a first-class record: property, tenant parties, start / end as
//       stated (missing dates stay missing), status from those dates, document hash,
//       an explicit renewal link only when the source states it.
//   R11 Amenity eligibility is DERIVED (owners and current-lease tenants, per the
//       association's rules); it never proves ownership. An amenity application is
//       investigation evidence only.
//   R12 Contact methods carry relationship-aware attribution: a lease / application
//       email belongs to that tenant / applicant and never reaches the owner record.
// ============================================================================
const C = require('../controls');

const norm = (v) => String(v || '').toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const addrKey = (a) => norm([a.street_no, a.line1, a.line2, a.unit, a.zip].filter(Boolean).join(' '));
const addrText = (a) => [[a.street_no, a.line1].filter(Boolean).join(' '), a.line2, a.unit && `Unit ${a.unit}`, [a.city, [a.state, a.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ')].filter(Boolean).join(', ');
const ORG_SUFFIX = /\b(LLC|L\.L\.C|INC|CORP|CORPORATION|LP|LLP|LTD|TRUST|TRUSTEE|COMPANY|HOLDINGS|PROPERTIES|PARTNERS|BANK|ESTATE OF)\b/i;

function buildCommunityGraph(src, { observed_as_of, financial_property_address = {}, transfer_report = null, tenancy_evidence = null } = {}) {
  if (!observed_as_of) throw new Error('observed_as_of (the export date) is required');
  const questions = []; const notes = [];
  const owners = src.roster.filter((r) => !r.placeholder);
  const placeholders = src.roster.filter((r) => r.placeholder);

  // ---- R1 properties
  const accounts = [...new Set([...owners.map((r) => r.account), ...src.contact_address.map((r) => r.account)])].filter(Boolean).sort();
  const properties = accounts.map((account) => {
    const rows = src.contact_address.filter((r) => r.account === account && r.type === 'Property');
    const labelled = rows.filter((r) => /property/i.test(r.label));
    const chosen = labelled.length === 1 ? labelled[0] : rows.length === 1 ? rows[0] : null;
    if (rows.length > 1) questions.push({ type: 'property_address_conflict', account, question: `Account ${account} lists ${rows.length} different "Property" addresses. Which one is the lot?`, choices: rows.map((r) => ({ key: `row:${r.provenance.row}`, label: addrText(r.address) })), provenance: rows.map((r) => r.provenance) });
    const fin = financial_property_address[account];
    if (chosen && fin && !norm(fin).startsWith(norm(`${chosen.address.street_no} ${chosen.address.line1}`).split(' ').slice(0, 2).join(' '))) questions.push({ type: 'property_address_mismatch', account, question: `Account ${account}: the contact export says the property is ${addrText(chosen.address)}, the financial reports say ${fin}. Which is right?`, provenance: [chosen.provenance] });
    return { key: `property:${account}`, account, address: chosen ? chosen.address : null, address_text: chosen ? addrText(chosen.address) : null, provenance: chosen ? [chosen.provenance] : [] };
  });

  // ---- R2 / R3 / R7 parties
  const byHid = new Map();
  for (const r of owners) { if (!r.homeowner_id) { questions.push({ type: 'owner_without_homeowner_id', account: r.account, question: `An owner row on account ${r.account} has no Homeowner ID; it cannot be identified safely.`, provenance: [r.provenance] }); continue; } if (!byHid.has(r.homeowner_id)) byHid.set(r.homeowner_id, []); byHid.get(r.homeowner_id).push(r); }
  const parties = []; const ownerships = []; const mailing_addresses = [];
  for (const [hid, rows] of byHid) {
    const first = rows[0];
    const distinctNames = [...new Set(rows.map((r) => norm(r.name)))];
    // HomeownerName carries the Mailing Name Override when one is set (e.g. a "Re:" care-of name): that is where mail goes,
    // not who owns. Prefer a row whose name is not its override; else the owner's own name fields; else the name as given.
    const isOverride = (r) => !!r.mailing_name_override && norm(r.name) === norm(r.mailing_name_override);
    const ownName = (rows.find((r) => !isOverride(r)) || {}).name || (first.business || [first.first, first.last].filter(Boolean).join(' ')) || first.name;
    const isOrg = !!first.business; const orgByName = !isOrg && ORG_SUFFIX.test(ownName);
    const owner = { key: `party:hid:${hid}`, source_identity: { provider: 'vantaca', homeowner_id: hid }, role_on_record: 'owner', name: ownName, first: first.first || null, last: first.last || null,
      kind: isOrg ? 'organization' : orgByName ? 'organization_by_name_pattern' : 'person', business_name: first.business || null, provenance: rows.map((r) => r.provenance) };
    parties.push(owner);
    if (distinctNames.length > 1) questions.push({ type: 'second_name_on_owner_record', homeowner_id: hid, accounts: [...new Set(rows.map((r) => r.account))], question: `One Vantaca owner record (Homeowner ID ${hid}) carries ${distinctNames.length} different names. Is the second name a co-owner, or only a mailing name?`, choices: [{ key: 'co_owner', label: 'A co-owner of the same property' }, { key: 'mailing_name_only', label: 'Only a name used for mail' }], provenance: rows.map((r) => r.provenance) });
    let spouse = null;
    if (first.spouse_first || first.spouse_last) {
      // the co-owner's name exactly as given; a missing surname stays missing (never copied from the owner)
      spouse = { key: `party:hid:${hid}#spouse`, source_identity: { provider: 'vantaca', homeowner_id: hid, slot: 'spouse' }, role_on_record: 'co_owner', name: [first.spouse_first, first.spouse_last].filter(Boolean).join(' '), first: first.spouse_first || null, last: first.spouse_last || null, surname_given: !!first.spouse_last, kind: 'person', provenance: [first.provenance] };
      parties.push(spouse);
    }
    // R2: the properties this owner record owns (one Homeowner ID may own several)
    for (const account of [...new Set(rows.map((r) => r.account))]) {
      const base = { property_key: `property:${account}`, effective_from: null, effective_from_source: null, start_evidence: transfer_report ? 'no_transfer_in_report_period' : 'no_transfer_source', observed_as_of, provenance: rows.filter((r) => r.account === account).map((r) => r.provenance) };
      ownerships.push({ ...base, party_key: owner.key, role: 'owner' });
      if (spouse) ownerships.push({ ...base, party_key: spouse.key, role: 'co_owner' });
    }
    // R5 mailing addresses of this record (from the roster rows and the contact export's mailing rows)
    const seen = new Set();
    for (const r of rows) { const k = addrKey(r.mailing); if (!k || seen.has(k)) continue; seen.add(k); mailing_addresses.push({ owner_record: hid, party_keys: [owner.key, ...(spouse ? [spouse.key] : [])], address: r.mailing, address_text: addrText(r.mailing), primary: false, source: 'roster', provenance: [r.provenance] }); }
    for (const account of [...new Set(rows.map((r) => r.account))]) for (const a of src.contact_address.filter((x) => x.account === account && x.primary_mailing)) {
      const k = addrKey(a.address); const existing = mailing_addresses.find((m) => m.owner_record === hid && addrKey(m.address) === k);
      const lot = (properties.find((p) => p.account === account) || {}).address;
      const toLot = !!lot && addrKey(lot) === k; // an unresolved lot never claims mail goes to the property
      if (existing) { existing.primary = true; existing.provenance.push(a.provenance); existing.mail_goes_to_property = toLot; }
      else mailing_addresses.push({ owner_record: hid, party_keys: [owner.key, ...(spouse ? [spouse.key] : [])], address: a.address, address_text: addrText(a.address), primary: true, mail_goes_to_property: toLot, source: 'contact_information', provenance: [a.provenance] });
    }
  }

  // ---- R6 contact methods (account-keyed -> the owner record of that account)
  const hidOfAccount = new Map(owners.filter((r) => r.homeowner_id).map((r) => [r.account, r.homeowner_id]));
  const contact_methods = [];
  for (const [type, list] of [['email', src.contact_email], ['phone', src.contact_phone]]) for (const m of list) {
    if (!m.value) continue;
    const hid = hidOfAccount.get(m.account);
    if (!hid) { questions.push({ type: 'contact_method_without_owner', account: m.account, question: `A ${type} on account ${m.account} has no owner record to attach to.`, provenance: [m.provenance] }); continue; }
    if (contact_methods.some((x) => x.owner_record === hid && x.type === type && x.value === m.value)) continue;
    contact_methods.push({ owner_record: hid, attributed_to: 'owner_record', type, value: m.value, primary: m.primary, row_name: m.row_name || null, label: m.label || null, provenance: [m.provenance] });
  }
  for (const type of ['email', 'phone']) {
    const by = new Map(); for (const m of contact_methods.filter((x) => x.type === type)) { if (!by.has(m.value)) by.set(m.value, new Set()); by.get(m.value).add(m.owner_record); }
    const shared = [...by.values()].filter((set) => set.size > 1);
    if (shared.length) notes.push({ type: `shared_${type}`, text: `${shared.length} ${type}(s) appear on more than one owner record. Each stays on every record it appears on; it does not make them the same party.`, records: shared.map((set) => [...set]) });
  }

  // ---- R8 transfer evidence (bounded by the report's period)
  const lotKey = (a) => norm(`${a.street_no} ${a.line1}`).replace(/\bDRIVE\b/g, 'DR');
  const propertyByLot = (text) => { const k = norm(text).replace(/\bDRIVE\b/g, 'DR'); return properties.filter((p) => p.address && lotKey(p.address) === k); };
  const transfers = []; const prior_ownerships = [];
  for (const t of (transfer_report && transfer_report.transfers) || []) {
    const hits = propertyByLot(t.property_text);
    if (hits.length !== 1) { questions.push({ type: 'transfer_property_not_identified', question: `A transfer (settled ${t.settlement_date}) names a property that matches ${hits.length} lot addresses.`, provenance: [t.provenance] }); continue; }
    const p = hits[0];
    const prev = { key: `party:transfer:${p.account}:${t.settlement_date}:previous`, source_identity: { provider: 'vantaca', report: 'ownership_transfer_report', account: p.account, settlement_date: t.settlement_date, slot: 'previous_owner' }, role_on_record: 'prior_owner', name: t.previous_owner, kind: 'unknown', provenance: [t.provenance] };
    if (t.previous_owner) { parties.push(prev); prior_ownerships.push({ property_key: p.key, party_key: prev.key, role: 'prior_owner', effective_to: t.settlement_date, provenance: [t.provenance] }); }
    const ownersHere = ownerships.filter((o) => o.property_key === p.key && o.role === 'owner');
    const exact = ownersHere.filter((o) => norm((parties.find((x) => x.key === o.party_key) || {}).name) === norm(t.current_owner));
    const rec = { property_key: p.key, settlement_date: t.settlement_date, processed_date: t.processed_date, current_owner_text: t.current_owner, previous_owner_party: t.previous_owner ? prev.key : null, provenance: [t.provenance] };
    if (exact.length === 1) {
      const hid = exact[0].party_key.replace(/^party:hid:/, '');
      for (const o of ownerships.filter((x) => x.property_key === p.key && x.party_key.startsWith(`party:hid:${hid}`))) { o.effective_from = t.settlement_date; o.effective_from_source = 'ownership_transfer_report'; o.start_evidence = 'transfer'; o.provenance.push(t.provenance); }
      transfers.push({ ...rec, linked_owner_record: hid, link: 'exact_name_on_property' });
    } else {
      transfers.push({ ...rec, linked_owner_record: null, link: 'not_established' });
      questions.push({ type: 'transfer_owner_differs_from_roster', account: p.account, question: `The transfer report says this property was settled to "${t.current_owner}" on ${t.settlement_date}; the current owner record names "${ownersHere.map((o) => (parties.find((x) => x.key === o.party_key) || {}).name).join(' / ')}". Is that the same owner record (so the ownership started ${t.settlement_date})?`, choices: [{ key: 'same_owner_record', label: `Yes: the ownership started ${t.settlement_date}` }, { key: 'different', label: 'No: a later change; keep the start unknown' }], provenance: [t.provenance, ...ownersHere.flatMap((o) => o.provenance)] });
    }
  }
  // a roster owner that differs from the financial-cutoff owner, with no transfer in the report: a change outside the period
  const periodEnd = transfer_report && transfer_report.period ? transfer_report.period.end : null;

  // ---- R9 / R10 occupancy and leases (only from tenancy evidence)
  const leases = []; const occupancies = []; const investigations = [];
  const asOf = observed_as_of;
  const leaseStatus = (st, en) => (!st && !en ? 'dates_not_established' : st && st > asOf ? 'future' : en && en < asOf ? 'expired' : st && (!en || en >= asOf) ? 'current' : 'dates_not_established');
  const propOf = (e) => (e.account ? properties.find((p) => p.account === String(e.account)) : null) || (e.property_text ? (propertyByLot(e.property_text).length === 1 ? propertyByLot(e.property_text)[0] : null) : null);
  for (const e of (tenancy_evidence || []).filter((x) => x.kind === 'lease')) {
    const p = propOf(e);
    if (!p) { questions.push({ type: 'lease_property_not_identified', question: 'A lease names a property that cannot be identified exactly.', provenance: [e.provenance] }); continue; }
    const leaseKey = `lease:${e.document_sha256}`;
    const tenantKeys = (e.tenants || []).map((tn, i) => {
      const key = tn.source_tenant_id ? `party:tenant:src:${tn.source_tenant_id}` : `party:tenant:${e.document_sha256}:${i}`;
      if (!parties.some((x) => x.key === key)) parties.push({ key, source_identity: tn.source_tenant_id ? { provider: e.provenance.provider || 'lease', tenant_id: tn.source_tenant_id } : { document_sha256: e.document_sha256, slot: i }, role_on_record: 'tenant', name: tn.name, kind: 'person', provenance: [e.provenance] });
      for (const [type, v] of [['email', tn.email && String(tn.email).toLowerCase()], ['phone', tn.phone && String(tn.phone).replace(/\D/g, '')]]) if (v) contact_methods.push({ party_key: key, owner_record: null, attributed_to: 'tenant', type, value: v, primary: false, provenance: [e.provenance] });
      return key;
    });
    const status = leaseStatus(e.start || null, e.end || null);
    leases.push({ key: leaseKey, property_key: p.key, tenant_party_keys: tenantKeys, start: e.start || null, end: e.end || null, status, received_at: e.received_at || null, document_sha256: e.document_sha256, renewal_of: e.renewal_of ? `lease:${e.renewal_of}` : null, provenance: [e.provenance] });
    for (const k of tenantKeys) occupancies.push({ property_key: p.key, party_key: k, role: 'tenant', basis: 'lease', lease_key: leaseKey, status, provenance: [e.provenance] });
  }
  for (const l of leases) if (l.renewal_of) { const prev = leases.find((x) => x.key === l.renewal_of); if (prev) prev.superseded_by = l.key; }
  for (const e of (tenancy_evidence || []).filter((x) => x.kind === 'occupancy_statement')) {
    const p = propOf(e); if (!p) continue;
    occupancies.push({ property_key: p.key, party_key: null, role: e.occupied_by_owner ? 'owner_occupied' : 'stated_vacant', basis: 'statement', from: e.from || null, status: 'stated', provenance: [e.provenance] });
  }
  for (const e of (tenancy_evidence || []).filter((x) => x.kind === 'amenity_application')) {
    const p = propOf(e);
    const ownersHere = p ? ownerships.filter((o) => o.property_key === p.key).map((o) => norm((parties.find((x) => x.key === o.party_key) || {}).name)) : [];
    const tenantsHere = p ? occupancies.filter((o) => o.property_key === p.key && o.role === 'tenant' && o.status === 'current').map((o) => norm((parties.find((x) => x.key === o.party_key) || {}).name)) : [];
    const n = norm(e.applicant && e.applicant.name);
    investigations.push({ type: 'amenity_application', property_key: p ? p.key : null, applicant_name: e.applicant ? e.applicant.name : null, matches: ownersHere.includes(n) ? 'current_owner_name' : tenantsHere.includes(n) ? 'current_tenant_name' : 'no_one_on_record', action: 'investigate', note: 'an application is evidence to look into; it never changes ownership or tenancy by itself', provenance: [e.provenance] });
  }
  const occupancy_by_property = properties.map((p) => {
    const occ = occupancies.filter((o) => o.property_key === p.key);
    const cur = occ.find((o) => o.role === 'tenant' && o.status === 'current');
    const stated = occ.filter((o) => o.basis === 'statement').sort((a, b) => String(b.from).localeCompare(String(a.from)))[0];
    const lastLease = leases.filter((l) => l.property_key === p.key).sort((a, b) => String(b.end || '').localeCompare(String(a.end || '')))[0];
    const statedAfterLease = stated && (!lastLease || !lastLease.end || String(stated.from || '') >= lastLease.end);
    const status = cur ? 'tenancy_established' : statedAfterLease && stated.role === 'owner_occupied' ? 'owner_occupancy_stated' : lastLease ? 'lease_ended_occupancy_unknown' : (tenancy_evidence && tenancy_evidence.length ? 'no_tenancy_evidence' : 'not_supplied');
    return { property_key: p.key, status };
  });

  // ---- facts worth saying out loud
  const sameName = new Map(); for (const p of parties.filter((x) => x.role_on_record === 'owner')) { const k = norm(p.name); if (!sameName.has(k)) sameName.set(k, []); sameName.get(k).push(p.key); }
  const sameNameDiffParty = [...sameName.values()].filter((keys) => keys.length > 1);
  if (sameNameDiffParty.length) notes.push({ type: 'same_name_different_owner_records', text: `${sameNameDiffParty.length} name(s) belong to more than one Vantaca owner record; they are kept as separate parties (same name is never a merge).`, records: sameNameDiffParty });
  if (placeholders.length) notes.push({ type: 'placeholder_rows_excluded', text: `${placeholders.length} "Current Resident" style row(s) are mail addressed to the property; none became a person.`, count: placeholders.length });

  // ---- controls (structural; the graph must satisfy them before any import is even proposed)
  const partyOfKey = new Map(parties.map((p) => [p.key, p]));
  const controls = [
    C.holds('community.every_party_has_a_source_identity', { label: 'Every party has a durable source identity (Homeowner ID, transfer record, tenant id or lease document slot)', failures: parties.filter((p) => { const si = p.source_identity || {}; return !(si.homeowner_id || (si.report === 'ownership_transfer_report' && si.settlement_date && si.account) || si.tenant_id || (si.document_sha256 && si.slot !== undefined)); }).map((p) => ({ party: p.key })) }),
    C.holds('community.no_party_spans_two_owner_records', { label: 'No party combines two Vantaca owner records (zero cross-record merges)', failures: parties.filter((p) => new Set(p.provenance.map((pv) => (owners.find((r) => r.provenance === pv) || {}).homeowner_id).filter(Boolean)).size > 1).map((p) => ({ party: p.key })) }),
    C.holds('community.no_placeholder_party', { label: 'No "Current Resident" style row became a party', failures: parties.filter((p) => /^\s*(current\s+resident|resident|occupant)\s*$/i.test(p.name)).map((p) => ({ party: p.key })) }),
    C.holds('community.every_relationship_has_provenance', { label: 'Every ownership, mailing address and contact method carries its source row', failures: [...ownerships, ...prior_ownerships, ...mailing_addresses, ...contact_methods, ...leases, ...occupancies].filter((x) => !x.provenance || !x.provenance.length || x.provenance.some((pv) => !pv || !pv.file_sha256 || !(pv.row || pv.line))).map(() => ({ problem: 'missing provenance' })) }),
    C.holds('community.every_property_has_a_current_owner', { label: 'Every property has a current owner party', failures: properties.filter((p) => !ownerships.some((o) => o.property_key === p.key && o.role === 'owner')).map((p) => ({ property: p.key })) }),
    C.holds('community.every_property_has_an_address', { label: 'Every property has its lot address from the source', failures: properties.filter((p) => !p.address).map((p) => ({ property: p.key })) }),
    C.holds('community.no_invented_start_date', { label: 'No ownership start date without a transfer source', failures: ownerships.filter((o) => o.effective_from && o.effective_from_source !== 'ownership_transfer_report').map((o) => ({ property: o.property_key })) }),
    C.holds('community.no_tenant_as_owner', { label: 'No tenant or prior owner is an owner of record', failures: ownerships.filter((o) => { const p = partyOfKey.get(o.party_key); return p && (p.role_on_record === 'tenant' || p.role_on_record === 'prior_owner'); }).map((o) => ({ property: o.property_key })) }),
    C.holds('community.tenant_contact_methods_stay_with_tenant', { label: 'A lease / application email or phone never reaches an owner record', failures: contact_methods.filter((m) => m.attributed_to === 'tenant' && m.owner_record).map((m) => ({ value: m.type })) }),
    C.holds('community.no_occupancy_assumed', { label: 'Occupancy only from evidence (never owner-occupied by default)', failures: occupancy_by_property.filter((o) => o.status === 'owner_occupancy_stated' && !occupancies.some((x) => x.property_key === o.property_key && x.basis === 'statement')).map((o) => ({ property: o.property_key })) }),
    C.holds('community.relationships_reference_known_parties', { label: 'Every relationship points at a party the source established', failures: [...ownerships.filter((o) => !partyOfKey.has(o.party_key)), ...mailing_addresses.filter((m) => m.party_keys.some((k) => !partyOfKey.has(k)))].map(() => ({ problem: 'unknown party' })) }),
  ];
  return { observed_as_of, transfer_period: transfer_report ? transfer_report.period : null, properties, parties, ownerships, prior_ownerships, transfers, mailing_addresses, contact_methods, leases, occupancies, occupancy_by_property, investigations, questions, notes, controls };
}

// R11: amenity eligibility is derived, never proof of ownership. rules: { owners: true, tenants_with_current_lease: true, owner_suspended_while_leased: false }
function amenityEligibility(graph, propertyKey, rules = {}) {
  const r = { owners: true, tenants_with_current_lease: true, owner_suspended_while_leased: false, ...rules };
  const leased = graph.occupancies.some((o) => o.property_key === propertyKey && o.role === 'tenant' && o.status === 'current');
  const out = [];
  if (r.owners && !(r.owner_suspended_while_leased && leased)) for (const o of graph.ownerships.filter((x) => x.property_key === propertyKey)) out.push({ party_key: o.party_key, basis: o.role });
  if (r.tenants_with_current_lease) for (const o of graph.occupancies.filter((x) => x.property_key === propertyKey && x.role === 'tenant' && x.status === 'current')) out.push({ party_key: o.party_key, basis: 'tenant_with_current_lease', lease_key: o.lease_key });
  return { property_key: propertyKey, eligible: out, derived: true, note: 'eligibility is derived from ownership and current leases under the association rules; it is not evidence of ownership' };
}

module.exports = { buildCommunityGraph, amenityEligibility, norm, addrKey, addrText };
