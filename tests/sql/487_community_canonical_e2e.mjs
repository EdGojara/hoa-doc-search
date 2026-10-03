// tests/sql/487_community_canonical_e2e.mjs — migration 487 (canonical community data)
// applied END TO END through the single-migration tool with its REAL checks file,
// then exercised through cd_apply and the Node write service. Synthetic data only.
// Proves: atomic rollback (no partial party), idempotent replay, same-name different
// source identities stay separate, one party for several properties ONLY by durable
// identity, co-owners, unknown dates as a state, prior / current owners, co-tenants,
// shared email / phone without merge, provenance (cd_why), immutability, single
// write path, and the graph -> proposal -> controls -> apply operator path.
// Postgres 17 (PGlite 0.3.x). Skips without PGlite.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { onboardingWorld, COMM } from './onboarding_world.mjs';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let PGlite;
try { ({ PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite')); }
catch (_) { console.log('SKIP  487 end-to-end (@electric-sql/pglite not installed)'); process.exit(0); }
const require = createRequire(import.meta.url);
const A = require(`${REPO}/lib/migrations/apply_one.js`);
const W = require(`${REPO}/lib/onboarding/community/write_service.js`);
const F = '487_community_data_canonical.sql';
let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { if (cond) { pass++; console.log('PASS ', name); } else { fail++; console.log('FAIL ', name, extra); } };
const lf = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm487-e2e-'));
fs.mkdirSync(path.join(dir, 'checks'));
fs.writeFileSync(path.join(dir, F), lf(`${REPO}/migrations/${F}`));
fs.writeFileSync(path.join(dir, 'checks', F.replace('.sql', '.json')), lf(`${REPO}/migrations/checks/${F.replace('.sql', '.json')}`));
const PRINT = process.argv.includes('--print-objects');
const OWNER = { id: 'owner-uuid', email: 'owner@example.test' };
const ctx = (client) => ({ client, user: OWNER, deployedCommit: 'deadbeefcafe', migrationsDir: dir, secret: 'e2e' });
const world = await onboardingWorld(PGlite, { through: 485 });
const { db, client, rpc } = world;
const P = Array.from({ length: 10 }, (_, i) => `00000000-0000-4000-8000-0000000000a${i}`);
await db.exec(`ALTER TABLE properties ADD COLUMN IF NOT EXISTS community_id uuid; INSERT INTO properties (id, community_id) VALUES ${P.map((p) => `('${p}', '${COMM}')`).join(', ')};`);
const plan = await A.planMigration({ ...ctx(client), filename: F });
if (PRINT) { const rr = await A.applyMigration({ ...ctx(client), planToken: plan.plan_token, log: { error() {} }, apiCheck: async () => ({ ok: true, count: 0 }) }); console.log(JSON.stringify((rr.detail || {}).objects || rr, null, 2)); process.exit(0); }
check('plan: ready, every preflight passes', plan.status === 'ready' && plan.preflight.every((p) => p.ok), JSON.stringify({ status: plan.status, error: plan.error }).slice(0, 600));
const r = await A.applyMigration({ ...ctx(client), planToken: plan.plan_token, log: { error() {} }, apiCheck: async () => ({ ok: true, count: 0 }) });
check('apply: 487 applied and verified through the tool', r.status === 'applied', JSON.stringify({ status: r.status, error: r.error }));
const err = async (fn) => { try { await fn(); return null; } catch (e) { return e.message; } };
const count = async (t) => (await db.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n;
const sha = (c) => c.repeat(64);
const doc = (ref, c, kind = 'all_addresses_export', extra = {}) => ({ ref, provider: 'vantaca', kind, filename: `${kind}.xlsx`, sha256: sha(c), period_start: null, period_end: null, observed_as_of: '2026-10-01', ...extra });
const ev = (ref, row, basis = 'owner record') => [{ document_ref: ref, locator: { sheet: 'Sheet1', row }, basis }];
const hid = (h, slot = 'owner') => ({ provider: 'vantaca', identity_kind: 'homeowner_id', identity_key: h, slot });
const person = (ref, name, identities) => ({ ref, kind: 'person', kind_basis: 'source_field', display_name: name, given_name: name.split(' ')[0], family_name: name.split(' ')[1] || null, identities });
const own = (property_id, party_ref, extra = {}) => ({ property_id, party_ref, role: 'owner', effective_from: null, effective_from_basis: 'unknown', effective_to: null, effective_to_basis: null, observed_as_of: '2026-10-01', evidence: ev('d1', 2), ...extra });
const apply = (key, change, actor = { kind: 'agent', id: 'onboarding-operator' }) => W.applyChange({ rpc, community_id: COMM, idempotency_key: key, change, actor });
const TABLES = ['cd_changes', 'cd_parties', 'cd_party_source_identities', 'cd_ownerships', 'cd_contact_methods', 'cd_addresses', 'cd_evidence', 'cd_source_documents'];

if (r.status === 'applied') {
  // 1. same name, different source identities; one person with two properties by identity; co-owners; unknown dates
  const base = {
    documents: [doc('d1', 'a')],
    parties: [person('alex1', 'Alex Morgan', [hid('H1')]), person('alex2', 'Alex Morgan', [hid('H2')]), person('pat', 'Pat Rivera', [hid('H3')]), person('sam', 'Sam Lee', [hid('H5')]), person('jo', 'Jo Lee', [hid('H5', 'spouse')])],
    property_identities: P.slice(0, 5).map((p, i) => ({ property_id: p, provider: 'vantaca', identity_key: `900${i + 1}` })),
    ownerships: [own(P[0], 'alex1'), own(P[1], 'alex2'), own(P[2], 'pat'), own(P[3], 'pat'), own(P[4], 'sam'), own(P[4], 'jo', { role: 'co_owner' })],
    addresses: [{ party_ref: 'pat', purpose: 'mailing', line1: '55 Investor Way', city: 'Farville', state: null, postal_code: '90210', is_primary: true, is_property_address: false, observed_as_of: '2026-10-01', evidence: ev('d1', 4, 'primary mailing marked by the source') }],
    contact_methods: [{ party_ref: 'alex1', method_type: 'email', value: 'Family@Example.test', attribution: 'owner_record', is_primary: true, observed_as_of: '2026-10-01', evidence: ev('d1', 2) }, { party_ref: 'alex2', method_type: 'email', value: 'family@example.test', attribution: 'owner_record', is_primary: true, observed_as_of: '2026-10-01', evidence: ev('d1', 3) }, { party_ref: 'pat', method_type: 'phone', value: '(555) 010-0001', attribution: 'owner_record', is_primary: true, observed_as_of: '2026-10-01', evidence: ev('d1', 4) }],
  };
  const r1 = await apply('k1', base);
  check('apply ok through the service (validated first, one database call)', r1.ok && r1.applied && r1.result.change_id, JSON.stringify(r1));
  const parties = (await db.query(`SELECT p.display_name, s.identity_key, s.slot FROM cd_parties p JOIN cd_party_source_identities s ON s.party_id = p.id ORDER BY s.identity_key, s.slot`)).rows;
  check('same name, different source identities -> two separate parties (name is never used to find a party)', parties.filter((x) => x.display_name === 'Alex Morgan').length === 2 && new Set((await db.query(`SELECT party_id FROM cd_party_source_identities WHERE identity_key IN ('H1','H2')`)).rows.map((x) => x.party_id)).size === 2);
  check('one person with two properties ONLY by durable identity: H3 is one party with two ownerships', (await db.query(`SELECT count(DISTINCT party_id)::int AS p, count(*)::int AS o FROM cd_ownerships o JOIN cd_party_source_identities s USING (party_id) WHERE s.identity_key = 'H3'`)).rows[0].p === 1 && (await db.query(`SELECT count(*)::int AS o FROM cd_ownerships o JOIN cd_party_source_identities s USING (party_id) WHERE s.identity_key = 'H3'`)).rows[0].o === 2);
  check('co-owners: owner + co_owner (spouse slot of the same record) on one property, two parties', (await db.query(`SELECT array_agg(role ORDER BY role) AS r FROM cd_ownerships WHERE property_id = $1`, [P[4]])).rows[0].r.join() === 'co_owner,owner');
  check('unknown start is stored as unknown (null + basis), with observed_as_of; no default state on the address', (await db.query(`SELECT count(*)::int AS n FROM cd_ownerships WHERE effective_from IS NULL AND effective_from_basis = 'unknown' AND observed_as_of = '2026-10-01'`)).rows[0].n === 6 && (await db.query(`SELECT state FROM cd_addresses`)).rows[0].state === null);
  check('shared email on two parties: stored on both (normalized), the parties stay separate', (await db.query(`SELECT count(DISTINCT party_id)::int AS n FROM cd_contact_methods WHERE value_normalized = 'family@example.test'`)).rows[0].n === 2);
  const own0 = (await db.query(`SELECT id FROM cd_ownerships WHERE property_id = $1`, [P[0]])).rows[0].id;
  const why = await rpc('cd_why', { p_subject_table: 'cd_ownerships', p_subject_id: own0 });
  check('provenance: cd_why answers why (document hash, kind, observation date, locator, basis)', why.length === 1 && why[0].document.sha256 === sha('a') && why[0].locator.row === 2 && why[0].basis === 'owner record' && why[0].document.observed_as_of === '2026-10-01', JSON.stringify(why));
  check('every material row has evidence', (await db.query(`SELECT count(*)::int AS n FROM cd_ownerships o WHERE NOT EXISTS (SELECT 1 FROM cd_evidence e WHERE e.subject_table = 'cd_ownerships' AND e.subject_id = o.id)`)).rows[0].n === 0
    && (await db.query(`SELECT count(*)::int AS n FROM cd_contact_methods m WHERE NOT EXISTS (SELECT 1 FROM cd_evidence e WHERE e.subject_table = 'cd_contact_methods' AND e.subject_id = m.id)`)).rows[0].n === 0);

  // 2. idempotent replay
  const before = {}; for (const t of TABLES) before[t] = await count(t);
  const replay = await apply('k1', base);
  let same = true; for (const t of TABLES) same = same && (await count(t)) === before[t];
  check('idempotent replay: same key + same proposal returns the original result and writes nothing', replay.ok && replay.replayed && replay.result.change_id === r1.result.change_id && same, JSON.stringify(replay));
  check('same key + a different proposal is refused', /already used for a different proposal/.test(JSON.stringify(await apply('k1', { ...base, parties: base.parties.slice(0, 1), ownerships: [own(P[0], 'alex1')], addresses: [], contact_methods: [] }))));

  // 3. atomic rollback: the last item is invalid at the database -> nothing from the proposal remains
  for (const t of TABLES) before[t] = await count(t);
  const bad = { documents: [doc('d2', 'b')], parties: [person('newbie', 'New Person', [hid('H90')])], ownerships: [{ ...own(P[5], 'newbie'), evidence: ev('d2', 2) }],
    contact_methods: [{ party_ref: 'newbie', method_type: 'email', value: 'x@example.test', attribution: 'owner_record', is_primary: true, observed_as_of: '2026-10-01', evidence: [{ document_id: '00000000-0000-4000-8000-00000000dead', locator: {}, basis: 'nope' }] }] };
  const rollback = await err(() => rpc('cd_apply', { p_community: COMM, p_idempotency_key: 'k-bad', p_proposal_sha256: W.proposalSha256(bad), p_change: bad, p_actor_kind: 'agent', p_actor_id: 'op' }));
  let untouched = true; for (const t of TABLES) untouched = untouched && (await count(t)) === before[t];
  check('atomic: a failure late in the proposal rolls back everything (no party, ownership, document or change row remains)', /unknown document/.test(rollback || '') && untouched, rollback);
  const viaService = await apply('k-bad', bad); let still = true; for (const t of TABLES) still = still && (await count(t)) === before[t];
  check('through the service a database refusal comes back machine-readable (REFUSED_BY_DATABASE) and nothing is written', viaService.ok === false && viaService.failures[0].code === 'REFUSED_BY_DATABASE' && /unknown document/.test(viaService.failures[0].message) && still, JSON.stringify(viaService));
  check('the service refuses a structurally bad proposal BEFORE any database call (machine-readable codes)', W.validateChange({ documents: [doc('d9', 'd')], parties: [{ ref: 'z', kind: 'person', display_name: 'Z', identities: [] }], ownerships: [{ property_id: P[5], party_ref: 'z', role: 'owner', effective_from: null, effective_from_basis: 'unknown', observed_as_of: '2026-10-01', evidence: [] }] }).failures.map((x) => x.code).sort().join() === 'ITEM_WITHOUT_EVIDENCE,PARTY_WITHOUT_SOURCE_IDENTITY');

  // 4. identities are never merged; identities and documents are immutable
  const merge = { documents: [doc('d1', 'a')], parties: [person('both', 'Alex Morgan', [hid('H1'), hid('H2')])], ownerships: [own(P[0], 'both')] };
  check('a proposal naming identities of two existing parties is refused (no merge by any means)', /never merged/.test(await err(() => rpc('cd_apply', { p_community: COMM, p_idempotency_key: 'k-merge', p_proposal_sha256: W.proposalSha256(merge), p_change: merge, p_actor_kind: 'agent', p_actor_id: 'op' })) || ''));
  check('the service flags the same identity on two parties of one proposal', W.validateChange({ documents: [doc('d1', 'a')], parties: [person('x', 'X', [hid('H7')]), person('y', 'Y', [hid('H7')])] }).failures.some((f) => f.code === 'IDENTITY_ON_TWO_PARTIES'));
  check('source identities are immutable (no edit, no delete)', /append-only/.test(await err(() => db.query(`UPDATE cd_party_source_identities SET identity_key = 'H99' WHERE identity_key = 'H1'`)) || '') && /append-only/.test(await err(() => db.query(`DELETE FROM cd_party_source_identities WHERE identity_key = 'H1'`)) || ''));
  check('an ownership row can only be ended once by a change; nothing else changes', /only be ended once/.test(await err(() => db.query(`UPDATE cd_ownerships SET role = 'co_owner' WHERE id = $1`, [own0])) || ''));

  // 5. prior / current owners through a transfer (end the old ownership, start the new one, with transfer evidence)
  const transfer = { documents: [doc('t1', 'c', 'ownership_transfer_report', { period_start: '2026-01-01', period_end: '2026-07-31', observed_as_of: '2026-10-03' })],
    parties: [person('buyer', 'Chris Dale', [hid('H6')])],
    ownership_ends: [{ ownership_id: own0, effective_to: '2026-06-30', effective_to_basis: 'transfer_settlement', evidence: [{ document_ref: 't1', locator: { line: 6 }, basis: 'previous owner on the transfer report' }] }],
    ownerships: [own(P[0], 'buyer', { effective_from: '2026-06-30', effective_from_basis: 'transfer_settlement', observed_as_of: '2026-10-03', evidence: [{ document_ref: 't1', locator: { line: 6 }, basis: 'settlement on the transfer report' }] })] };
  const rt = await apply('k-transfer', transfer);
  const hist = (await db.query(`SELECT effective_from, effective_from_basis, effective_to, effective_to_basis FROM cd_ownerships WHERE property_id = $1 ORDER BY effective_to NULLS LAST`, [P[0]])).rows;
  check('prior / current owners: the old ownership ends on the settlement (basis + evidence), the new one starts on it; history kept', rt.ok && hist.length === 2 && hist[0].effective_to_basis === 'transfer_settlement' && hist[1].effective_from_basis === 'transfer_settlement' && hist[1].effective_to === null, JSON.stringify(hist));
  const endWhy = await rpc('cd_why', { p_subject_table: 'cd_ownership_end', p_subject_id: own0 });
  check('the end of an ownership has its own provenance (the transfer report line)', endWhy.length === 1 && endWhy[0].document.kind === 'ownership_transfer_report' && endWhy[0].locator.line === 6);
  check('an already-ended ownership cannot be ended again', /not an open ownership/.test(JSON.stringify(await apply('k-transfer-2', { ...transfer, parties: [], ownerships: [] }))));

  const second = { documents: [doc('d1', 'a')], parties: [person('intruder', 'Alex Morgan', [hid('H77')])], ownerships: [own(P[1], 'intruder')] };
  check('no silent second owner: a current owner of another owner record on the same property is refused (a transfer must end the old one)', /already has a current owner/.test(JSON.stringify(await apply('k-second-owner', second))));

  // 6. unknown dates are real: a date without a basis / a basis without a date is refused (service and database)
  const v = W.validateChange({ documents: [doc('d1', 'a')], parties: [person('u', 'U', [hid('H50')])], ownerships: [own(P[5], 'u', { effective_from: '2026-05-18', effective_from_basis: 'unknown' })] });
  check('service: an import date posing as a start date is refused (START_DATE_BASIS_MISMATCH)', v.failures.some((f) => f.code === 'START_DATE_BASIS_MISMATCH'));
  const dbDate = { documents: [doc('d1', 'a')], parties: [person('u', 'U', [hid('H50')])], ownerships: [own(P[5], 'u', { effective_from: '2026-05-18', effective_from_basis: 'unknown' })] };
  check('database: the same is refused even if the service is bypassed', /cd_ownership_unknown_start_is_real/.test(await err(() => rpc('cd_apply', { p_community: COMM, p_idempotency_key: 'k-date', p_proposal_sha256: W.proposalSha256(dbDate), p_change: dbDate, p_actor_kind: 'agent', p_actor_id: 'op' })) || ''));

  // 7. co-tenants on a lease; a second lease's tenant does not end the first; lease emails stay with the tenant
  const leaseDoc = doc('L', 'e', 'lease', { observed_as_of: '2026-07-01' });
  const lease = { documents: [leaseDoc],
    parties: [{ ref: 't0', kind: 'person', kind_basis: 'source_field', display_name: 'Terry Tenant', identities: [{ provider: 'lease', identity_kind: 'lease_party', identity_key: sha('e'), slot: 'tenant:0' }] }, { ref: 't1', kind: 'person', kind_basis: 'source_field', display_name: 'Alex Morgan', identities: [{ provider: 'lease', identity_kind: 'lease_party', identity_key: sha('e'), slot: 'tenant:1' }] }],
    leases: [{ ref: 'lease1', property_id: P[1], document_ref: 'L', start_date: '2026-07-01', end_date: '2027-06-30', received_at: null, tenant_party_refs: ['t0', 't1'], evidence: [{ document_ref: 'L', locator: { page: 1 }, basis: 'lease document' }] }],
    occupancies: ['t0', 't1'].map((t) => ({ property_id: P[1], party_ref: t, occupancy_kind: 'tenant', basis: 'lease', lease_ref: 'lease1', effective_from: '2026-07-01', effective_to: null, observed_as_of: '2026-07-01', evidence: [{ document_ref: 'L', locator: { page: 1 }, basis: 'tenant on the lease' }] })),
    contact_methods: [{ party_ref: 't1', method_type: 'email', value: 'alex.tenant@example.test', attribution: 'tenant', is_primary: false, observed_as_of: '2026-07-01', evidence: [{ document_ref: 'L', locator: { page: 1 }, basis: 'on the lease' }] }] };
  const rl = await apply('k-lease', lease);
  check('co-tenants: two tenant parties, two open occupancies on one property, the owner untouched', rl.ok && (await db.query(`SELECT count(*)::int AS n FROM cd_occupancies WHERE property_id = $1 AND effective_to IS NULL`, [P[1]])).rows[0].n === 2 && (await db.query(`SELECT count(*)::int AS n FROM cd_ownerships WHERE property_id = $1 AND effective_to IS NULL`, [P[1]])).rows[0].n === 1);
  check('same name across owner and tenant populations: the tenant "Alex Morgan" is a third, separate party', (await db.query(`SELECT count(DISTINCT id)::int AS n FROM cd_parties WHERE display_name = 'Alex Morgan'`)).rows[0].n === 3);
  const add = { documents: [doc('L2', 'f', 'lease', { observed_as_of: '2026-08-01' })], parties: [{ ref: 't2', kind: 'person', kind_basis: 'source_field', display_name: 'New Roommate', identities: [{ provider: 'lease', identity_kind: 'lease_party', identity_key: sha('f'), slot: 'tenant:0' }] }],
    leases: [{ ref: 'lease2', property_id: P[1], document_ref: 'L2', start_date: '2026-08-01', end_date: null, tenant_party_refs: ['t2'], evidence: [{ document_ref: 'L2', locator: {}, basis: 'lease addendum' }] }],
    occupancies: [{ property_id: P[1], party_ref: 't2', occupancy_kind: 'tenant', basis: 'lease', lease_ref: 'lease2', effective_from: '2026-08-01', effective_to: null, observed_as_of: '2026-08-01', evidence: [{ document_ref: 'L2', locator: {}, basis: 'tenant on the lease' }] }] };
  await apply('k-add-tenant', add);
  check('adding a tenant never ends another occupancy (three open now)', (await db.query(`SELECT count(*)::int AS n FROM cd_occupancies WHERE property_id = $1 AND effective_to IS NULL`, [P[1]])).rows[0].n === 3);
  const leakDoc = { documents: [leaseDoc], parties: [person('alex2', 'Alex Morgan', [hid('H2')])], contact_methods: [{ party_ref: 'alex2', method_type: 'phone', value: '555-777-0000', attribution: 'owner_record', is_primary: false, observed_as_of: '2026-07-01', evidence: [{ document_ref: 'L', locator: {}, basis: 'phone on a lease' }] }] };
  check('a lease document can never supply an owner\'s contact method (service and database)', W.validateChange(leakDoc).failures.some((f) => f.code === 'LEASE_DOCUMENT_FEEDS_OWNER_CONTACT')
    && /never supplies an owner/.test(await err(() => rpc('cd_apply', { p_community: COMM, p_idempotency_key: 'k-leak', p_proposal_sha256: W.proposalSha256(leakDoc), p_change: leakDoc, p_actor_kind: 'agent', p_actor_id: 'op' })) || ''));
  const inferred = { documents: [doc('d1', 'a')], parties: [person('sam', 'Sam Lee', [hid('H5')])], occupancies: [{ property_id: P[4], party_ref: 'sam', occupancy_kind: 'owner_occupant', basis: 'inferred_from_mailing_address', effective_from: null, effective_to: null, observed_as_of: '2026-10-01', evidence: ev('d1', 6) }] };
  check('occupancy can never be inferred (service: OCCUPANCY_WITHOUT_EVIDENCE_BASIS; database CHECK)', W.validateChange(inferred).failures.some((f) => f.code === 'OCCUPANCY_WITHOUT_EVIDENCE_BASIS')
    && /check|violat/i.test(await err(() => rpc('cd_apply', { p_community: COMM, p_idempotency_key: 'k-infer', p_proposal_sha256: W.proposalSha256(inferred), p_change: inferred, p_actor_kind: 'agent', p_actor_id: 'op' })) || ''));

  // 9. the operator path: source exports -> resolve.js graph -> canonical proposal -> controls / questions -> atomic apply
  {
    const XLSX = require('xlsx');
    const R = require(`${REPO}/lib/onboarding/community/vantaca_roster.js`);
    const { buildCommunityGraph } = require(`${REPO}/lib/onboarding/community/resolve.js`);
    const book = (sheets) => { const wb = XLSX.utils.book_new(); for (const [n, rows] of Object.entries(sheets)) XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), n); return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }); };
    const row = (acct, hidv, name, extra = {}) => ({ Account: acct, 'Homeowner ID': hidv, HomeownerName: name, FirstName: name.split(' ')[0], LastName: name.split(' ').slice(-1)[0], SpouseFirstName: '', SpouseLastName: '', BusinessName: '', DeedName: '', MailingNameOverride: '', MailStreetNo: '1', MailAddress1: 'Op Street', MailAddress2: '', 'Unit No': '', MailCity: 'Optown', MailState: '', MailZip: '77001', ...extra });
    const prop = (acct, no) => ({ Account: acct, HomeownerName: '', 'Street No': no, Address1: 'Example Lane', Address2: '', 'Unit No': '', City: 'Exampleton', 'State/Province': 'TX', Zip: '77000', 'International Address': '', 'Address Type': 'Property', Label: 'Property', 'Primary Mailing': 'No' });
    const reads = [R.readWorkbook(XLSX, book({ Sheet1: [row('8001', 'OP1', 'Kim Park'), row('8002', 'OP2', 'Kim Park'), row('8003', 'OP3', 'Lee Fox', { SpouseFirstName: 'Ana', SpouseLastName: 'Fox' })] }), 'All Addresses Export.xlsx'),
      R.readWorkbook(XLSX, book({ Address: [prop('8001', '201'), prop('8002', '202'), prop('8003', '203')], Email: [{ Account: '8001', HomeOwnerName: 'Kim Park', Email: 'kp@example.test', Primary: 'Yes', label: '' }], Phone: [] }), 'Homeowner Contact Information.xlsx')];
    const src = R.combine(reads);
    const G = buildCommunityGraph(src, { observed_as_of: '2026-10-01' });
    const pidOf = { '8001': P[6], '8002': P[7], '8003': P[8] };
    const documents = src.files.map((fl) => ({ file_sha256: fl.sha256, provider: 'vantaca', kind: /Contact/.test(fl.filename) ? 'homeowner_contact_information' : 'all_addresses_export', filename: fl.filename, observed_as_of: '2026-10-01' }));
    const { change, questions, ready } = W.proposalFromGraph(G, { documents, propertyIdOfAccount: (a) => pidOf[a] || null });
    const v2 = W.validateChange(change);
    check('operator path: the graph becomes a canonical proposal that passes every control, with no open question', ready && questions.length === 0 && v2.ok, JSON.stringify(v2.failures).slice(0, 400));
    const ra = await apply('op-graph-1', change);
    check('operator path: the proposal applies atomically; two same-name owners stay two parties; the co-owner is the record\'s spouse slot', ra.ok && (await db.query(`SELECT count(DISTINCT s.party_id)::int AS n FROM cd_party_source_identities s WHERE s.identity_key IN ('OP1','OP2')`)).rows[0].n === 2
      && (await db.query(`SELECT count(*)::int AS n FROM cd_party_source_identities WHERE identity_key = 'OP3' AND slot = 'spouse'`)).rows[0].n === 1, JSON.stringify(ra).slice(0, 300));
    check('operator path: replaying the same proposal is a no-op', (await apply('op-graph-1', change)).replayed === true);
    const reads2 = [R.readWorkbook(XLSX, book({ Sheet1: [row('8001', 'OP1', 'Kim Park'), row('8001', 'OP1', 'Someone Else')] }), 'All Addresses Export 2.xlsx'), reads[1]];
    const G2 = buildCommunityGraph(R.combine(reads2), { observed_as_of: '2026-10-02' });
    const p2 = W.proposalFromGraph(G2, { documents: R.combine(reads2).files.map((fl) => ({ file_sha256: fl.sha256, provider: 'vantaca', kind: 'all_addresses_export', filename: fl.filename, observed_as_of: '2026-10-02' })), propertyIdOfAccount: (a) => pidOf[a] || null });
    check('operator path: an open identity question blocks the proposal (ready = false) and is returned in plain words', p2.ready === false && p2.questions.some((q) => q.type === 'second_name_on_owner_record'));
  }

  // 8. single write path
  const priv = (await db.query(`SELECT has_table_privilege('service_role', 'cd_ownerships', 'INSERT') AS i, has_table_privilege('service_role', 'cd_ownerships', 'SELECT') AS s, has_function_privilege('service_role', 'cd_apply(uuid,text,text,jsonb,text,text)', 'EXECUTE') AS a, has_function_privilege('service_role', 'cd_apply_change(uuid,text,text,jsonb,text,text)', 'EXECUTE') AS raw, has_function_privilege('anon', 'cd_apply(uuid,text,text,jsonb,text,text)', 'EXECUTE') AS anon`)).rows[0];
  check('single write path: service_role may SELECT and EXECUTE cd_apply only; no direct INSERT, no raw apply, nothing for anon', priv.i === false && priv.s === true && priv.a === true && priv.raw === false && priv.anon === false, JSON.stringify(priv));
  check('no legacy table was touched (contacts / ownerships / residencies are not part of 487)', (await count('journal_entries')) === 0);
}
{
  const w = await onboardingWorld(PGlite, { through: 485 });
  await w.db.exec(`ALTER TABLE properties ADD COLUMN IF NOT EXISTS community_id uuid; CREATE TABLE cd_parties (id uuid);`);
  const p = await A.planMigration({ ...ctx(w.client), filename: F });
  check('drift: a pre-existing cd_ table blocks the plan', p.status !== 'ready');
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
