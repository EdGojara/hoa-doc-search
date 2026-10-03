// ============================================================================
// tests/test_onboarding_community_identity.js  (Issue #15) — community-data truth set
// ----------------------------------------------------------------------------
// A synthetic Vantaca roster + contact export (real xlsx, built here; no client
// data) that deliberately contains every failure mode the prior conversion hit.
// Asserts ZERO false merges and ZERO invented relationships, provenance on every
// accepted relationship, the read-only inventory's requests, and that the
// comparison finds false merges / stale owners / placeholders / import dates in
// an existing Trusted snapshot.
// ============================================================================
const assert = require('assert');
const XLSX = require('xlsx');
const R = require('../lib/onboarding/community/vantaca_roster');
const { buildCommunityGraph } = require('../lib/onboarding/community/resolve');
const { inventory } = require('../lib/onboarding/community/sufficiency');
const { compareWithTrusted } = require('../lib/onboarding/community/compare');

const tests = []; const check = (n, fn) => tests.push([n, fn]);
const book = (sheets) => { const wb = XLSX.utils.book_new(); for (const [name, rows] of Object.entries(sheets)) XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), name); return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }); };
const mail = (no, street, city = 'Exampleton', zip = '77000') => ({ MailStreetNo: no, MailAddress1: street, MailAddress2: '', 'Unit No': '', MailCity: city, MailState: 'TX', MailZip: zip });
const owner = (acct, hid, name, extra = {}, m = null) => ({ 'Assoc Code': 'EX', Account: acct, 'Homeowner ID': hid, HomeownerName: name, FirstName: name.split(' ')[0], LastName: name.split(' ').slice(-1)[0], SpouseFirstName: '', SpouseLastName: '', BusinessName: '', DeedName: '', MailingNameOverride: '', ...(m || mail(String(acct).slice(-3), 'Example Lane')), GeneralPreference: 'Paper', BillingPreference: 'Paper', ...extra });
const ROSTER = [
  owner('9001', 'H1', 'Alex Morgan', {}, mail('101', 'Example Lane')),                                       // same name as 9002, different owner record
  owner('9002', 'H2', 'Alex Morgan', {}, mail('202', 'Sample Road')),                                         // -> must stay a SEPARATE party
  owner('9003', 'H3', 'Pat Rivera', {}, mail('55', 'Investor Way', 'Farville', '90210')),                     // one person, two properties (same Homeowner ID)
  owner('9004', 'H3', 'Pat Rivera', {}, mail('55', 'Investor Way', 'Farville', '90210')),
  owner('9005', 'H5', 'Sam & Jo Lee', { FirstName: 'Sam', LastName: 'Lee', SpouseFirstName: 'Jo', SpouseLastName: 'Lee' }, mail('105', 'Example Lane')),   // primary + co-owner
  owner('9006', 'H6', 'Chris Dale', {}, mail('9', 'Elsewhere Ct', 'Othertown', '75001')),                     // separate mailing address
  owner('9007', 'H7', 'Robin Fox', {}, mail('107', 'Example Lane')),                                          // changed mailing: two rows, contact export marks the new one
  owner('9007', 'H7', 'Robin Fox', {}, mail('3', 'New Place', 'Newcity', '73301')),
  owner('9008', 'H8', 'Oak Holdings LLC', { BusinessName: 'Oak Holdings LLC' }, mail('1', 'Corporate Dr', 'Big City', '10001')),   // company (business name)
  owner('9009', 'H9', 'Riverside Family Trust', {}, mail('109', 'Example Lane')),                             // trust by name pattern
  owner('9010', 'H10', 'Taylor Kim', {}, mail('110', 'Example Lane')),                                        // shared email with 9011, different owner record
  owner('9011', 'H11', 'Jordan Kim', {}, mail('111', 'Example Lane')),
  owner('9012', 'H12', 'Casey Park', {}, mail('112', 'Example Lane')),                                        // no email at all
  owner('9013', 'H13', 'Lee Grant', {}, mail('7', 'Shared Blvd', 'Twincity', '78000')),                       // duplicate-looking: same name, same mailing,
  owner('9014', 'H14', 'Lee Grant', {}, mail('7', 'Shared Blvd', 'Twincity', '78000')),                       //   same phone, different owner records -> separate
  owner('9015', 'H15', 'Dana White', {}, mail('115', 'Example Lane')),                                        // a second, different name on the same record
  owner('9015', 'H15', 'Morgan Blake', {}, mail('115', 'Example Lane')),
  owner('9006', 'H6', 'Current Resident', {}, mail('106', 'Example Lane')),                                   // placeholder rows: mail to the property
  owner('9010', 'H10', 'Current Resident', {}, mail('110', 'Example Lane')),
];
const prop = (acct, no, street, extra = {}) => ({ Account: acct, HomeownerName: '', 'Street No': no, Address1: street, Address2: '', 'Unit No': '', City: 'Exampleton', 'State/Province': 'TX', Zip: '77000', 'International Address': '', 'Address Type': 'Property', Label: 'Property', 'Primary Mailing': 'Yes', ...extra });
const mailRow = (acct, no, street, city, zip, primary = 'Yes') => ({ Account: acct, HomeownerName: '', 'Street No': no, Address1: street, Address2: '', 'Unit No': '', City: city, 'State/Province': 'TX', Zip: zip, 'International Address': '', 'Address Type': 'Mailing', Label: '', 'Primary Mailing': primary });
const ADDRESS = [
  ...['9001', '9002', '9005', '9009', '9010', '9011', '9012', '9015'].map((a) => prop(a, String(Number(a) - 8900), 'Example Lane')),
  prop('9003', '103', 'Example Lane', { 'Primary Mailing': 'No' }), mailRow('9003', '55', 'Investor Way', 'Farville', '90210'),
  prop('9004', '104', 'Example Lane', { 'Primary Mailing': 'No' }), mailRow('9004', '55', 'Investor Way', 'Farville', '90210'),
  prop('9006', '106', 'Example Lane', { 'Primary Mailing': 'No' }), mailRow('9006', '9', 'Elsewhere Ct', 'Othertown', '75001'),
  prop('9007', '107', 'Example Lane', { 'Primary Mailing': 'No' }), mailRow('9007', '3', 'New Place', 'Newcity', '73301'),
  prop('9008', '108', 'Example Lane', { 'Primary Mailing': 'No' }), mailRow('9008', '1', 'Corporate Dr', 'Big City', '10001'),
  prop('9013', '113', 'Example Lane', { 'Primary Mailing': 'No' }), mailRow('9013', '7', 'Shared Blvd', 'Twincity', '78000'),
  prop('9014', '114', 'Example Lane', { 'Primary Mailing': 'No' }), mailRow('9014', '7', 'Shared Blvd', 'Twincity', '78000'),
];
const EMAIL = [
  { Account: '9001', HomeOwnerName: 'Alex Morgan', Email: 'alex1@example.test', Primary: 'Yes', label: '' },
  { Account: '9002', HomeOwnerName: 'Alex Morgan', Email: 'alex2@example.test', Primary: 'Yes', label: '' },
  { Account: '9005', HomeOwnerName: 'Sam & Jo Lee', Email: 'jo@example.test', Primary: 'Yes', label: 'Jo' },
  { Account: '9010', HomeOwnerName: 'Taylor Kim', Email: 'kimfamily@example.test', Primary: 'Yes', label: '' },
  { Account: '9011', HomeOwnerName: 'Jordan Kim', Email: 'kimfamily@example.test', Primary: 'Yes', label: '' },
];
const PHONE = [{ Account: '9013', HomeOwnerName: 'Lee Grant', phone: '(555) 010-0001', Primary: 'Yes', label: 'Mobile' }, { Account: '9014', HomeOwnerName: 'Lee Grant', phone: '(555) 010-0001', Primary: 'Yes', label: 'Mobile' }];

const src = R.combine([R.readWorkbook(XLSX, book({ Sheet1: ROSTER }), 'All Addresses (Current Resident) Export.xlsx'), R.readWorkbook(XLSX, book({ Address: ADDRESS, Email: EMAIL, Phone: PHONE }), 'Homeowner Contact Information.xlsx')]);
const G = buildCommunityGraph(src, { observed_as_of: '2026-10-01' });
const party = (key) => G.parties.find((p) => p.key === key);
const ownersOf = (acct) => G.ownerships.filter((o) => o.property_key === `property:${acct}`);

check('reader: recognizes every sheet by its headers; every record keeps file sha256 / sheet / row', () => {
  assert.deepStrictEqual([src.roster.length, src.contact_address.length, src.contact_email.length, src.contact_phone.length, src.unrecognized_sheets.length], [ROSTER.length, ADDRESS.length, EMAIL.length, PHONE.length, 0]);
  assert.ok([...src.roster, ...src.contact_address, ...src.contact_email].every((r) => /^[0-9a-f]{64}$/.test(r.provenance.file_sha256) && r.provenance.row >= 2));
});
check('ZERO false merges: identical names on different owner records stay separate parties (and the duplicate-looking pair with same name + mailing + phone too)', () => {
  assert.ok(party('party:hid:H1') && party('party:hid:H2') && party('party:hid:H1') !== party('party:hid:H2'));
  assert.ok(party('party:hid:H13') && party('party:hid:H14'));
  assert.strictEqual(ownersOf('9013')[0].party_key, 'party:hid:H13'); assert.strictEqual(ownersOf('9014')[0].party_key, 'party:hid:H14');
  const ownerParties = G.parties.filter((p) => p.role_on_record === 'owner');
  assert.strictEqual(ownerParties.length, new Set(src.roster.filter((r) => !r.placeholder).map((r) => r.homeowner_id)).size, 'one owner party per Vantaca owner record, never fewer');
  assert.ok(G.notes.some((n) => n.type === 'same_name_different_owner_records' && n.records.length === 2));
});
check('one real person owning several properties: ONE party (same Homeowner ID) with an ownership on each', () => {
  assert.deepStrictEqual([ownersOf('9003')[0].party_key, ownersOf('9004')[0].party_key], ['party:hid:H3', 'party:hid:H3']);
  assert.strictEqual(G.parties.filter((p) => p.source_identity.homeowner_id === 'H3').length, 1);
});
check('primary + co-owner: the spouse is a second party bound to THAT owner record only; contact methods are not given to either person', () => {
  const o = ownersOf('9005');
  assert.deepStrictEqual(o.map((x) => [x.party_key, x.role]), [['party:hid:H5', 'owner'], ['party:hid:H5#spouse', 'co_owner']]);
  assert.strictEqual(party('party:hid:H5#spouse').name, 'Jo Lee');
  const email = G.contact_methods.find((m) => m.value === 'jo@example.test');
  assert.deepStrictEqual([email.owner_record, email.attributed_to], ['H5', 'owner_record'], 'an email labelled "Jo" is still the owner record\'s, not inferred to belong to the co-owner');
});
check('separate and changed mailing addresses: the source-marked primary wins; the property address is never assumed to be the mailing address', () => {
  const m6 = G.mailing_addresses.filter((m) => m.owner_record === 'H6');
  assert.ok(m6.find((m) => m.primary).address_text.startsWith('9 Elsewhere Ct'), 'separate mailing is primary');
  assert.ok(!m6.some((m) => m.primary && m.mail_goes_to_property));
  assert.strictEqual(G.properties.find((p) => p.account === '9006').address_text.split(',')[0], '106 Example Lane', 'lot address is the Property row');
  const m7 = G.mailing_addresses.filter((m) => m.owner_record === 'H7');
  assert.deepStrictEqual(m7.map((m) => [m.address_text.split(',')[0], m.primary]).sort(), [['107 Example Lane', false], ['3 New Place', true]]);
  const m1 = G.mailing_addresses.find((m) => m.owner_record === 'H1' && m.primary);
  assert.strictEqual(m1.mail_goes_to_property, true, 'mail to the property only because the source marks the Property row as primary mailing');
});
check('"Current Resident" rows become nobody; a second different name on one owner record is a question, not an assumed co-owner', () => {
  assert.ok(!G.parties.some((p) => /current resident/i.test(p.name)));
  assert.ok(G.notes.some((n) => n.type === 'placeholder_rows_excluded' && n.count === 2));
  assert.ok(!G.parties.some((p) => p.name === 'Morgan Blake'), 'no party invented from the second name');
  const q = G.questions.find((x) => x.type === 'second_name_on_owner_record');
  assert.ok(q && q.homeowner_id === 'H15' && q.choices.length === 2 && q.provenance.length === 2);
});
check('companies and trusts: organization only from the source field; a legal-suffix name is flagged as a pattern, never more', () => {
  assert.strictEqual(party('party:hid:H8').kind, 'organization');
  assert.strictEqual(party('party:hid:H9').kind, 'organization_by_name_pattern');
  assert.strictEqual(party('party:hid:H1').kind, 'person');
});
check('shared email / phone on different owner records: kept on each record, links nobody (noted); missing email simply absent', () => {
  assert.deepStrictEqual(G.contact_methods.filter((m) => m.value === 'kimfamily@example.test').map((m) => m.owner_record).sort(), ['H10', 'H11']);
  assert.ok(party('party:hid:H10') && party('party:hid:H11'));
  assert.ok(G.notes.some((n) => n.type === 'shared_email') && G.notes.some((n) => n.type === 'shared_phone'));
  assert.ok(!G.contact_methods.some((m) => m.owner_record === 'H12'));
});
check('without a transfer or tenancy source nothing is invented: start unknown, no prior owner, occupancy "not supplied" (never owner-occupied)', () => {
  assert.ok(G.ownerships.every((o) => o.effective_from === null && o.observed_as_of === '2026-10-01' && o.start_evidence === 'no_transfer_source'));
  assert.deepStrictEqual([G.prior_ownerships.length, G.occupancies.length, G.leases.length], [0, 0, 0]);
  assert.ok(G.occupancy_by_property.every((o) => o.status === 'not_supplied'));
});
// ---- transfer evidence (synthetic layout text shaped like the Vantaca report, incl. an email that spills into the date column and wrapped lines)
const TRANSFER_TEXT = [
  '                    Example Creek Homeowners Association, Inc',
  '                        Ownership Transfers for 1/1/2026 - 7/31/2026',
  '              Current                                                                              Previous',
  '  Property    Owner           Address                     Contact                 Settlement   Processed      Owner',
  '  Report generated on 10/3/2026 12:54 PM - V3.01                                                              Page 1',
  '  106 Example Chris Dale      9 Elsewhere Ct,             chris.dale.long@example.test\\Home 6/30/2026   7/15/2026   Former Owner',
  '  Lane                        Othertown TX 75001          (555) 010-0002                                         One',
  '  103 Example Pat Rivera      55 Investor Way,            pat@example.test        2/1/2026     2/9/2026       Alex Morgan',
  '  Lane                        Farville TX 90210',
  '  113 Example Somebody Else   7 Shared Blvd,              x@example.test          3/3/2026     3/9/2026       Earlier Person',
  '  Lane                        Twincity TX 78000',
].join('\n');
const { parseOwnershipTransfers } = require('../lib/onboarding/community/vantaca_transfers');
const TR = parseOwnershipTransfers(TRANSFER_TEXT, { file: 'Ownership Transfer Report.pdf', file_sha256: 'b'.repeat(64) });
check('transfer report: period, every transfer (despite the spilled email and wrapped lines), dates, contacts, provenance; no defects', () => {
  assert.deepStrictEqual(TR.period, { start: '2026-01-01', end: '2026-07-31' }); assert.deepStrictEqual(TR.defects, []);
  assert.strictEqual(TR.transfers.length, 3);
  const t = TR.transfers[0];
  assert.deepStrictEqual([t.property_text, t.current_owner, t.settlement_date, t.processed_date, t.previous_owner], ['106 Example Lane', 'Chris Dale', '2026-06-30', '2026-07-15', 'Former Owner One']);
  assert.deepStrictEqual([t.emails, t.phones], [['chris.dale.long@example.test'], ['5550100002']]);
  assert.ok(t.provenance.file_sha256 === 'b'.repeat(64) && t.provenance.line === 6);
  assert.deepStrictEqual(parseOwnershipTransfers('Some other report\nno header').defects.map((d) => d.code), ['TRANSFER_PERIOD_NOT_FOUND']);
});
check('transfer evidence: linked by exact lot address + exact owner name ON THAT PROPERTY; the start date comes from settlement; everyone else stays "start unknown"', () => {
  const g = buildCommunityGraph(src, { observed_as_of: '2026-10-01', transfer_report: TR });
  const o6 = g.ownerships.find((x) => x.property_key === 'property:9006' && x.role === 'owner');
  assert.deepStrictEqual([o6.effective_from, o6.effective_from_source, o6.start_evidence], ['2026-06-30', 'ownership_transfer_report', 'transfer']);
  assert.strictEqual(g.ownerships.find((x) => x.property_key === 'property:9003').effective_from, '2026-02-01');
  assert.strictEqual(g.ownerships.find((x) => x.property_key === 'property:9004').effective_from, null, 'the same owner\'s OTHER property is not dated by this transfer');
  assert.ok(g.ownerships.filter((x) => !['property:9006', 'property:9003'].includes(x.property_key)).every((x) => x.effective_from === null && x.start_evidence === 'no_transfer_in_report_period'));
  assert.ok(g.controls.find((c) => c.code === 'community.no_invented_start_date').status === 'PASS');
});
check('prior owners are their own parties from the transfer, never matched by name (even when the name equals a CURRENT owner elsewhere)', () => {
  const g = buildCommunityGraph(src, { observed_as_of: '2026-10-01', transfer_report: TR });
  const prev = g.parties.find((p) => p.role_on_record === 'prior_owner' && p.name === 'Alex Morgan');
  assert.ok(prev && prev.key.startsWith('party:transfer:9003:'), 'previous owner of 9003 named like the current owners of 9001 / 9002');
  assert.ok(!g.ownerships.some((o) => o.party_key === prev.key), 'a prior owner is never an owner of record');
  assert.strictEqual(g.parties.filter((p) => p.name === 'Alex Morgan' && p.role_on_record === 'owner').length, 2, 'the two current Alex Morgans are untouched');
  assert.ok(g.prior_ownerships.every((x) => x.effective_to && x.provenance[0].file_sha256 === 'b'.repeat(64)));
});
check('a transfer whose new-owner name differs from the owner record is a QUESTION; the start stays unknown (no fuzzy name link)', () => {
  const g = buildCommunityGraph(src, { observed_as_of: '2026-10-01', transfer_report: TR });
  const q = g.questions.find((x) => x.type === 'transfer_owner_differs_from_roster' && x.account === '9013');
  assert.ok(q && q.choices.length === 2 && /Somebody Else/.test(q.question));
  assert.strictEqual(g.ownerships.find((x) => x.property_key === 'property:9013').effective_from, null);
  assert.strictEqual(g.transfers.find((t) => t.property_key === 'property:9013').link, 'not_established');
});
check('co-owner surname is never copied from the owner', () => {
  const s2 = R.combine([R.readWorkbook(XLSX, book({ Sheet1: [owner('9200', 'H200', 'Ray & Lu Stone', { FirstName: 'Ray', LastName: 'Stone', SpouseFirstName: 'Lu', SpouseLastName: '' })] }), 'r.xlsx'), R.readWorkbook(XLSX, book({ Address: [prop('9200', '1', 'One St')] }), 'c.xlsx')]);
  const sp = buildCommunityGraph(s2, { observed_as_of: '2026-10-01' }).parties.find((p) => p.role_on_record === 'co_owner');
  assert.deepStrictEqual([sp.name, sp.last, sp.surname_given], ['Lu', null, false]);
});
// ---- tenancy / leases / amenities (relationship-separated)
const pvL = (file, row = 1) => ({ provider: 'lease_intake', file, file_sha256: 'c'.repeat(64), sheet: null, row });
const TENANCY = [
  { kind: 'lease', account: '9006', document_sha256: 'L1'.padEnd(64, '0'), start: '2025-07-01', end: '2026-06-30', received_at: '2025-06-20', tenants: [{ name: 'Terry Tenant', email: 'terry@example.test' }, { name: 'Alex Morgan', email: 'alex.tenant@example.test' }], provenance: pvL('lease-9006-2025.pdf') },
  { kind: 'lease', account: '9006', document_sha256: 'L2'.padEnd(64, '0'), start: '2026-07-01', end: '2027-06-30', renewal_of: 'L1'.padEnd(64, '0'), tenants: [{ name: 'Terry Tenant', email: 'terry@example.test' }], provenance: pvL('lease-9006-2026.pdf') },
  { kind: 'lease', account: '9010', document_sha256: 'L3'.padEnd(64, '0'), start: '2024-01-01', end: '2025-12-31', tenants: [{ name: 'Gale Old' }], provenance: pvL('lease-9010.pdf') },
  { kind: 'occupancy_statement', account: '9010', occupied_by_owner: true, from: '2026-02-01', provenance: pvL('owner-move-in-9010.pdf') },
  { kind: 'lease', account: '9011', document_sha256: 'L4'.padEnd(64, '0'), tenants: [{ name: 'Terry Tenant' }], provenance: pvL('lease-9011-undated.pdf') },
  { kind: 'lease', account: '9012', document_sha256: 'L5'.padEnd(64, '0'), start: '2026-01-01', end: '2026-12-31', tenants: [{ name: 'Sky Blue', source_tenant_id: 'T-77' }], provenance: pvL('lease-9012.pdf') },
  { kind: 'lease', account: '9013', document_sha256: 'L6'.padEnd(64, '0'), start: '2026-03-01', end: '2027-02-28', tenants: [{ name: 'Sky Blue', source_tenant_id: 'T-77' }], provenance: pvL('lease-9013.pdf') },
  { kind: 'amenity_application', account: '9006', applicant: { name: 'Pool Applicant', email: 'pool@example.test' }, provenance: pvL('pool-app.pdf') },
];
const GT = buildCommunityGraph(src, { observed_as_of: '2026-10-01', tenancy_evidence: TENANCY });
const { amenityEligibility } = require('../lib/onboarding/community/resolve');
check('tenancy is separate from ownership: two tenants on a lease become two tenant parties linked by the lease; the owner record is untouched', () => {
  const l1 = GT.leases.find((l) => l.document_sha256.startsWith('L1'));
  assert.strictEqual(l1.tenant_party_keys.length, 2);
  assert.deepStrictEqual(GT.ownerships.filter((o) => o.property_key === 'property:9006').map((o) => o.party_key), ['party:hid:H6'], 'ownership unchanged');
  assert.ok(GT.controls.find((c) => c.code === 'community.no_tenant_as_owner').status === 'PASS');
});
check('same name across owner and tenant populations stays separate (a tenant named like two owners is a third, separate party)', () => {
  const tenantAlex = GT.parties.filter((p) => p.name === 'Alex Morgan' && p.role_on_record === 'tenant');
  assert.strictEqual(tenantAlex.length, 1); assert.strictEqual(GT.parties.filter((p) => p.name === 'Alex Morgan').length, 3);
});
check('renewal and supersession only when the lease says so; the current lease decides occupancy; an expired lease does not make anyone owner-occupied', () => {
  const l1 = GT.leases.find((l) => l.document_sha256.startsWith('L1')); const l2 = GT.leases.find((l) => l.document_sha256.startsWith('L2'));
  assert.deepStrictEqual([l1.status, l2.status, l2.renewal_of, l1.superseded_by], ['expired', 'current', l1.key, l2.key]);
  assert.strictEqual(GT.occupancy_by_property.find((o) => o.property_key === 'property:9006').status, 'tenancy_established');
  assert.ok(GT.parties.filter((p) => p.name === 'Terry Tenant').length >= 2, 'the renewal tenant is NOT merged with the first lease\'s tenant by name (no tenant id)');
});
check('owner move-in after a tenant: occupancy becomes owner-occupied only from the owner\'s statement dated after the lease ended', () => {
  assert.strictEqual(GT.occupancy_by_property.find((o) => o.property_key === 'property:9010').status, 'owner_occupancy_stated');
  const noStatement = buildCommunityGraph(src, { observed_as_of: '2026-10-01', tenancy_evidence: TENANCY.filter((e) => e.kind !== 'occupancy_statement') });
  assert.strictEqual(noStatement.occupancy_by_property.find((o) => o.property_key === 'property:9010').status, 'lease_ended_occupancy_unknown');
});
check('missing lease dates stay missing (status "dates not established"); one tenant on two leases is one party only with a durable tenant id', () => {
  assert.strictEqual(GT.leases.find((l) => l.document_sha256.startsWith('L4')).status, 'dates_not_established');
  assert.strictEqual(GT.parties.filter((p) => p.name === 'Sky Blue').length, 1, 'same source tenant id on two leases -> one party');
  assert.strictEqual(GT.occupancies.filter((o) => o.party_key === 'party:tenant:src:T-77').length, 2);
  assert.ok(GT.parties.filter((p) => p.name === 'Terry Tenant').length === 3, 'no tenant id -> one party per lease document, never merged by name');
});
check('contact methods are relationship-aware: a lease email belongs to the tenant and never reaches the owner record', () => {
  const m = GT.contact_methods.find((x) => x.value === 'alex.tenant@example.test');
  assert.deepStrictEqual([m.attributed_to, m.owner_record], ['tenant', null]);
  assert.ok(!GT.contact_methods.some((x) => x.owner_record === 'H6' && /terry|alex\.tenant/.test(x.value)));
  assert.ok(GT.controls.find((c) => c.code === 'community.tenant_contact_methods_stay_with_tenant').status === 'PASS');
});
check('an amenity application is investigation evidence only (applicant not on record); eligibility is derived and never proves ownership', () => {
  const inv = GT.investigations.find((i) => i.type === 'amenity_application');
  assert.deepStrictEqual([inv.matches, inv.action], ['no_one_on_record', 'investigate']);
  assert.ok(!GT.parties.some((p) => p.name === 'Pool Applicant'), 'no party created from the application');
  const e = amenityEligibility(GT, 'property:9006');
  assert.deepStrictEqual(e.eligible.map((x) => x.basis).sort(), ['owner', 'tenant_with_current_lease']);
  assert.strictEqual(amenityEligibility(GT, 'property:9006', { owner_suspended_while_leased: true }).eligible.every((x) => x.basis === 'tenant_with_current_lease'), true);
  assert.ok(!amenityEligibility(GT, 'property:9010').eligible.some((x) => x.basis === 'tenant_with_current_lease'), 'an expired-lease tenant is not eligible');
  assert.deepStrictEqual(GT.ownerships.filter((o) => o.property_key === 'property:9006').length, 1, 'eligibility never adds an ownership');
});
check('controls still PASS with transfer evidence and tenancy evidence present (prior owners and tenants carry their own durable identity + provenance)', () => {
  const gx = buildCommunityGraph(src, { observed_as_of: '2026-10-01', transfer_report: TR, tenancy_evidence: TENANCY });
  for (const c of gx.controls) if (c.code !== 'community.every_property_has_a_current_owner') assert.strictEqual(c.status, 'PASS', c.code + ' ' + JSON.stringify(c.failures));
});
check('the Vantaca "Homeowner Rent Export" is recognized as recurring charges, NOT tenant evidence; occupancy stays not supplied', () => {
  const rent = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(rent, XLSX.utils.aoa_to_sheet([['AssocCode', 'Account', 'Owner Name', 'Property Address', 'Charge Description', 'Start Date', 'End Date', 'Amount', 'Rent Frequency', 'Allow Auto Renewal', 'Auto Renewal Frequency (Years)', 'Auto Renewal Increase %', 'Description']]), 'Sheet1');
  const read = R.readWorkbook(XLSX, XLSX.write(rent, { type: 'buffer', bookType: 'xlsx' }), 'Homeowner Rent Export.xlsx');
  assert.deepStrictEqual([read.recurring_charge_sheets.length, read.recurring_charges.length, read.unrecognized_sheets.length], [1, 0, 0]);
  const s3 = R.combine([...[R.readWorkbook(XLSX, book({ Sheet1: ROSTER }), 'a.xlsx'), R.readWorkbook(XLSX, book({ Address: ADDRESS }), 'b.xlsx')], read]);
  const g3 = buildCommunityGraph(s3, { observed_as_of: '2026-10-01' });
  assert.ok(g3.occupancy_by_property.every((o) => o.status === 'not_supplied'));
  const inv = inventory(s3, g3, {});
  assert.ok(inv.missing.some((m) => m.dimension === 'tenants and occupants' && /recurring charges, not tenants/.test(m.evidence) && /never owner-occupied by default/.test(m.evidence)));
});
check('controls: every party has a source identity, no cross-record merge, no placeholder party, provenance everywhere, every property owned and addressed', () => {
  for (const c of G.controls) assert.strictEqual(c.status, 'PASS', `${c.code} ${JSON.stringify(c.failures)}`);
});
check('a property with two different "Property" addresses is a question (no guess)', () => {
  const s2 = R.combine([R.readWorkbook(XLSX, book({ Sheet1: [owner('9100', 'H100', 'Quinn Ash')] }), 'r.xlsx'), R.readWorkbook(XLSX, book({ Address: [prop('9100', '1', 'One St', { Label: 'Property', 'Primary Mailing': 'No' }), prop('9100', '2', 'Two St', { Label: '', 'Primary Mailing': 'Yes' })] }), 'c.xlsx')]);
  const g = buildCommunityGraph(s2, { observed_as_of: '2026-10-01' });
  assert.ok(g.questions.some((q) => q.type === 'property_address_conflict' && q.choices.length === 2));
});
check('inventory: says what is proven and asks for the missing Vantaca reports by name (transfers, tenants); no column mapping', () => {
  const inv = inventory(src, G, { expected_accounts: ['9001', '9002', '9003', '9004', '9005', '9006', '9007', '9008', '9009', '9010', '9011', '9012', '9013', '9014', '9015'] });
  assert.ok(inv.proves.some((p) => p.dimension === 'current owner roster') && inv.proves.some((p) => p.dimension === 'property (lot) addresses'));
  assert.deepStrictEqual(inv.requests.map((r) => r.report.split(' (')[0]), ['Ownership Transfer Report', 'tenant / renter / lease records']);
  const withT = inventory(src, buildCommunityGraph(src, { observed_as_of: '2026-10-01', transfer_report: TR }), { transfer_report: TR });
  assert.ok(withT.proves.some((p) => p.dimension === 'ownership transfers in the report period' && p.evidence.includes('3 transfer(s) settled 2026-01-01 to 2026-07-31; 2 linked')), JSON.stringify(withT.proves));
  assert.ok(withT.requests.some((r) => /Ownership Transfer Report for 2026-07-31 onward/.test(r.report)), 'the bounded period is stated and the rest is requested');
  const short = inventory(src, G, { expected_accounts: ['9001', '9999'] });
  assert.ok(short.requests.some((r) => r.report === 'All Addresses Export'), 'a roster that misses a financial account is requested again');
});
check('compare with Trusted: finds a false merge, a stale owner, a placeholder owner, import-date start dates and a wrong lot address', () => {
  const props = G.properties.map((p, i) => ({ id: `p${i}`, vantaca_account_id: p.account, street_address: p.address_text.split(',')[0] }));
  const pid = (a) => props.find((p) => p.vantaca_account_id === a).id;
  props.find((p) => p.vantaca_account_id === '9012').street_address = '999 Wrong Street';
  const contacts = [{ id: 'cMerged', full_name: 'Alex Morgan' }, { id: 'cOld', full_name: 'Previous Person' }, { id: 'cRes', full_name: 'Current Resident' }];
  const ownerships = [{ property_id: pid('9001'), contact_id: 'cMerged', start_date: '2026-05-18' }, { property_id: pid('9002'), contact_id: 'cMerged', start_date: '2026-05-18' }, { property_id: pid('9006'), contact_id: 'cOld', start_date: '2026-05-18' }, { property_id: pid('9010'), contact_id: 'cRes', start_date: '2026-05-18' }, { property_id: pid('9012'), contact_id: 'cX', start_date: '2026-05-18' }];
  contacts.push({ id: 'cX', full_name: 'Casey Park' });
  const r = compareWithTrusted(G, { properties: props, ownerships, contacts });
  assert.ok(r.findings.some((f) => f.type === 'false_merge' && f.owner_records.sort().join() === 'H1,H2' && /same name/.test(f.text)));
  assert.ok(r.findings.some((f) => f.type === 'owner_name_differs' && f.account === '9006'));
  assert.ok(r.findings.some((f) => f.type === 'placeholder_person_in_trusted' && f.account === '9010'));
  assert.ok(r.findings.some((f) => f.type === 'import_date_as_start_date' && f.date === '2026-05-18'));
  assert.ok(r.findings.some((f) => f.type === 'lot_address_differs' && f.account === '9012'));
});

(async () => {
  let pass = 0, fail = 0;
  console.log('Onboarding: community-data identity truth set (Issue #15)');
  for (const [n, fn] of tests) { try { await fn(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n      ' + (e.stack || e.message).split('\n').slice(0, 3).join('\n      ')); } }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
