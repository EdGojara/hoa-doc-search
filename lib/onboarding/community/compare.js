// ============================================================================
// lib/onboarding/community/compare.js  (Issue #15) — the source graph vs Trusted (read-only)
// ----------------------------------------------------------------------------
// Finds what is wrong in Trusted's existing property / owner data, judged by the
// source identity rules: false merges (one Trusted contact holding owners of
// several Vantaca owner records), splits, stale owners, placeholder people,
// import dates posing as ownership start dates, wrong lot addresses. Reports
// only; repairs are a separate, approved step.
// ============================================================================
const { norm } = require('./resolve');

function compareWithTrusted(graph, trusted) {
  const findings = [];
  const propByAcct = new Map(trusted.properties.map((p) => [String(p.vantaca_account_id || ''), p]));
  const acctOfProp = new Map(trusted.properties.map((p) => [p.id, String(p.vantaca_account_id || '')]));
  const cur = trusted.ownerships.filter((o) => !o.end_date);
  const contactName = new Map(trusted.contacts.map((c) => [c.id, c.full_name || '']));
  const hidOfAccount = new Map(graph.ownerships.filter((o) => o.role === 'owner').map((o) => [o.property_key.slice('property:'.length), o.party_key.replace(/^party:hid:/, '')]));
  const ownerNamesOfAccount = (a) => graph.parties.filter((p) => graph.ownerships.some((o) => o.property_key === `property:${a}` && o.party_key === p.key)).map((p) => norm(p.name));

  // false merges / splits by source identity
  const byContact = new Map(); for (const o of cur) { if (!byContact.has(o.contact_id)) byContact.set(o.contact_id, new Set()); byContact.get(o.contact_id).add(acctOfProp.get(o.property_id)); }
  for (const [contact, accts] of byContact) {
    const hids = new Set([...accts].map((a) => hidOfAccount.get(a)).filter(Boolean));
    if (hids.size > 1) findings.push({ type: 'false_merge', severity: 'high', contact_id: contact, accounts: [...accts], owner_records: [...hids], text: `One Trusted contact is the owner of ${accts.size} properties that belong to ${hids.size} different Vantaca owner records${new Set([...accts].flatMap(ownerNamesOfAccount)).size === 1 ? ' with the same name' : ''}. They are different parties.` });
  }
  const contactsOfHid = new Map(); for (const o of cur) { const h = hidOfAccount.get(acctOfProp.get(o.property_id)); if (!h) continue; if (!contactsOfHid.has(h)) contactsOfHid.set(h, new Set()); contactsOfHid.get(h).add(o.contact_id); }
  for (const [h, cs] of contactsOfHid) if (cs.size > 1 && [...cs].every((c) => byContact.get(c).size === 1)) findings.push({ type: 'split_party', severity: 'low', owner_record: h, contacts: [...cs], text: `One Vantaca owner record owns ${cs.size} properties but Trusted holds it as ${cs.size} contacts.` });

  // stale / missing owners, placeholders, invented start dates, lot addresses
  for (const p of graph.properties) {
    const t = propByAcct.get(p.account);
    if (!t) { findings.push({ type: 'property_missing_in_trusted', severity: 'medium', account: p.account, text: `Account ${p.account} is not a Trusted property.` }); continue; }
    const owners = cur.filter((o) => o.property_id === t.id);
    const names = owners.map((o) => norm(contactName.get(o.contact_id)));
    if (!owners.length) findings.push({ type: 'no_current_owner_in_trusted', severity: 'high', account: p.account, text: `Account ${p.account} has no current owner in Trusted.` });
    else if (!ownerNamesOfAccount(p.account).some((n) => names.includes(n))) {
      const sorted = (n) => n.split(' ').sort().join(' ');
      const transferHere = (graph.transfers || []).some((t) => t.property_key === p.key);
      if (ownerNamesOfAccount(p.account).some((n) => names.some((x) => sorted(x) === sorted(n)))) findings.push({ type: 'owner_name_format_differs', severity: 'low', account: p.account, text: `Account ${p.account}: same words in a different order; a name format change on the same owner record, not a sale.` });
      else findings.push({ type: 'owner_name_differs', severity: 'high', account: p.account, transfer_in_report: transferHere, text: `Account ${p.account}: Trusted's current owner name differs from the source owner record${transferHere ? ' (a transfer in the report covers this property)' : ' and no transfer in the report period covers it; a sale outside the period or a rename (the sources do not say which)'}.` });
    }
    if (names.some((n) => /^(CURRENT RESIDENT|RESIDENT|OCCUPANT)$/.test(n))) findings.push({ type: 'placeholder_person_in_trusted', severity: 'high', account: p.account, text: `Account ${p.account} has a "Current Resident" style placeholder as an owner in Trusted.` });
    if (p.address && t.street_address && !norm(t.street_address).startsWith(norm(`${p.address.street_no} ${p.address.line1}`).split(' ').slice(0, 2).join(' '))) findings.push({ type: 'lot_address_differs', severity: 'high', account: p.account, text: `Account ${p.account}: Trusted's lot address differs from the source property address.` });
  }
  const starts = cur.filter((o) => o.start_date).map((o) => o.start_date);
  const common = starts.length ? Object.entries(starts.reduce((m, d) => { m[d] = (m[d] || 0) + 1; return m; }, {})).sort((a, b) => b[1] - a[1])[0] : null;
  if (common && common[1] >= Math.max(5, Math.ceil(cur.length * 0.8))) findings.push({ type: 'import_date_as_start_date', severity: 'medium', date: common[0], count: common[1], text: `${common[1]} of ${cur.length} current ownerships start on ${common[0]}, which looks like an import date, not when the owners took title.` });
  // residency rows Trusted holds without lease / statement evidence
  const res = trusted.residencies || [];
  const guessed = res.filter((r) => /infer/i.test(String(r.source || '')) && !r.lease_start_date && !r.lease_end_date && !r.lease_pdf_path);
  if (guessed.length) findings.push({ type: 'occupancy_assumed', severity: 'high', count: guessed.length, by_type: guessed.reduce((m, r) => { m[r.residency_type] = (m[r.residency_type] || 0) + 1; return m; }, {}), text: `${guessed.length} residency rows were inferred from mailing addresses with no lease or statement (owner-occupied / renter guessed); the source establishes no occupancy.` });
  // ownership start dates contradicted by transfer evidence
  for (const t of (graph.transfers || []).filter((x) => x.linked_owner_record)) {
    const tp = propByAcct.get(t.property_key.slice('property:'.length)); if (!tp) continue;
    const o = cur.find((x) => x.property_id === tp.id);
    if (o && o.start_date && o.start_date !== t.settlement_date) findings.push({ type: 'start_date_contradicted_by_transfer', severity: 'medium', text: `A current ownership starts ${o.start_date} in Trusted; the transfer report proves settlement on ${t.settlement_date}.` });
  }
  const counts = findings.reduce((m, f) => { m[f.type] = (m[f.type] || 0) + 1; return m; }, {});
  return { findings, counts };
}

module.exports = { compareWithTrusted };
