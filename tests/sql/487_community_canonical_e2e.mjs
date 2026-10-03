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
  check('the service refuses a structurally bad proposal BEFORE any database call (machine-readable codes)', W.validateChange({ documents: [doc('d9', 'd')], parties: [{ ref: 'z', kind: 'unknown', kind_basis: 'unknown', display_name: 'Z', identities: [] }], ownerships: [{ property_id: P[5], party_ref: 'z', role: 'owner', effective_from: null, effective_from_basis: 'unknown', observed_as_of: '2026-10-01', evidence: [] }] }).failures.map((x) => x.code).sort().join() === 'ITEM_WITHOUT_EVIDENCE,PARTY_WITHOUT_SOURCE_IDENTITY');

  // 4. identities are never merged; identities and documents are immutable
  const merge = { documents: [doc('d1', 'a')], parties: [person('both', 'Alex Morgan', [hid('H1'), hid('H2')])], ownerships: [own(P[0], 'both')] };
  check('a party carrying two identities is refused: further identities come only through an evidence-backed identity link (service + database)', W.validateChange(merge).failures.some((x) => x.code === 'IDENTITY_LINK_REQUIRED') && /exactly one source identity/.test(await err(() => rpc('cd_apply', { p_community: COMM, p_idempotency_key: 'k-merge', p_proposal_sha256: W.proposalSha256(merge), p_change: merge, p_actor_kind: 'agent', p_actor_id: 'op' })) || ''));
  const joinTwo = { documents: [doc('d1', 'a')], identity_links: [{ existing: hid('H1'), add: hid('H2'), evidence: ev('d1', 2, 'claims H1 and H2 are one person') }] };
  check('an identity link joining two EXISTING parties is refused (never merged by any means)', /never merged/.test(JSON.stringify(await apply('k-join-two', joinTwo))));
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
  check('an already-ended ownership cannot be ended again', /not a current ownership/.test(JSON.stringify(await apply('k-transfer-2', { ...transfer, parties: [], ownerships: [] }))));

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

  // 10. HARDENING (review of 1cd87f1a)
  const pid = async (key, slot = 'owner') => (await db.query(`SELECT party_id FROM cd_party_source_identities WHERE identity_key = $1 AND slot = $2`, [key, slot])).rows[0].party_id;
  const linkDoc = doc('ln', '1', 'identity_confirmation', { observed_as_of: '2026-10-02' });
  // 10.1 identity linking (explicit, evidence-backed, cross-provider)
  const tenantId = { provider: 'lease', identity_kind: 'tenant_id', identity_key: 'T-77', slot: 'tenant' };
  const noEv = { documents: [linkDoc], identity_links: [{ existing: hid('H3'), add: tenantId, evidence: [] }] };
  check('identity link without evidence is refused (service IDENTITY_LINK_WITHOUT_EVIDENCE; database needs evidence)', W.validateChange(noEv).failures.some((x) => x.code === 'IDENTITY_LINK_WITHOUT_EVIDENCE')
    && /needs evidence/.test(await err(() => rpc('cd_apply', { p_community: COMM, p_idempotency_key: 'k-link-noev', p_proposal_sha256: W.proposalSha256(noEv), p_change: noEv, p_actor_kind: 'agent', p_actor_id: 'op' })) || ''));
  const link = { documents: [linkDoc], identity_links: [{ existing: hid('H3'), add: tenantId, evidence: [{ document_ref: 'ln', locator: { page: 1 }, basis: 'tenant record T-77 names the owner record H3 (signed confirmation)' }] }] };
  const rlk = await apply('k-link', link);
  const linked = (await db.query(`SELECT id, party_id, linked_by_evidence FROM cd_party_source_identities WHERE identity_key = 'T-77'`)).rows[0];
  check('cross-provider identity link with evidence attaches the tenant id to the existing owner party (flagged linked_by_evidence)', rlk.ok && linked && linked.party_id === await pid('H3') && linked.linked_by_evidence === true);
  check('the link has its own provenance (observation "linked")', (await rpc('cd_why', { p_subject_table: 'cd_party_source_identities', p_subject_id: linked.id }))[0].observation === 'linked');
  const viaLinked = await apply('k-via-link', { documents: [linkDoc], parties: [{ ref: 'pt', kind: 'person', kind_basis: 'source_field', display_name: 'P. Rivera', identities: [tenantId] }] });
  check('a later proposal naming the linked tenant id resolves to the SAME party (no new party)', viaLinked.ok && viaLinked.result.parties.pt === await pid('H3') && viaLinked.result.parties_created.length === 0);
  const other = await apply('k-other-tenant', { documents: [linkDoc], parties: [{ ref: 'pr', kind: 'person', kind_basis: 'source_field', display_name: 'Pat Rivera', identities: [{ provider: 'lease', identity_kind: 'tenant_id', identity_key: 'T-88', slot: 'tenant' }] }] });
  check('an unlinked tenant id with the SAME name is a separate party (name never links)', other.ok && other.result.parties.pr !== await pid('H3'));
  // 10.2 repeat observations preserve provenance
  const own2 = (await db.query(`SELECT id FROM cd_ownerships WHERE property_id = $1 AND effective_to IS NULL`, [P[2]])).rows[0].id;
  const reobs = await apply('k-reobs', { documents: [doc('d3', '3', 'all_addresses_export', { observed_as_of: '2026-11-01' })], parties: [person('pat', 'Pat Rivera', [hid('H3')])], ownerships: [{ ...own(P[2], 'pat'), observed_as_of: '2026-11-01', evidence: ev('d3', 9, 'still the owner on the November roster') }],
    contact_methods: [{ party_ref: 'pat', method_type: 'phone', value: '555.010.0001', attribution: 'owner_record', is_primary: true, observed_as_of: '2026-11-01', evidence: ev('d3', 9, 'same phone on the November export') }] });
  const w2 = await rpc('cd_why', { p_subject_table: 'cd_ownerships', p_subject_id: own2 });
  check('re-observing an open ownership APPENDS its evidence (created + reobserved, two documents) instead of losing it', reobs.ok && reobs.result.reobserved === 2 && w2.length === 2 && w2[1].observation === 'reobserved' && w2[1].document.observed_as_of === '2026-11-01', JSON.stringify(w2).slice(0, 300));
  const phoneId = (await db.query(`SELECT id FROM cd_contact_methods WHERE value_normalized = '5550100001' AND effective_to IS NULL`)).rows[0].id;
  check('a repeated contact method appends evidence too (no ON CONFLICT discard)', (await rpc('cd_why', { p_subject_table: 'cd_contact_methods', p_subject_id: phoneId })).length === 2);
  // 10.3 single current primary owner at the database level (concurrency-safe index), co-owners allowed
  const anyChange = (await db.query(`SELECT id FROM cd_changes WHERE community_id = $1 LIMIT 1`, [COMM])).rows[0].id;
  const H1P = await pid('H1'); const H5S = await pid('H5', 'spouse');
  check('database: a second current primary owner inserted around the function hits the unique index (concurrency-safe)', /cd_one_current_owner_per_property/.test(await err(() => db.query(`INSERT INTO cd_ownerships (community_id, property_id, party_id, role, effective_from_basis, observed_as_of, change_id) VALUES ($1, $2, $3, 'owner', 'unknown', '2026-10-01', $4)`, [COMM, P[2], H1P, anyChange])) || ''));
  check('database: a duplicate open co_owner row for the same party is refused; a different co-owner is fine', /cd_one_open_ownership_per_party_role/.test(await err(() => db.query(`INSERT INTO cd_ownerships (community_id, property_id, party_id, role, effective_from_basis, observed_as_of, change_id) VALUES ($1, $2, $3, 'co_owner', 'unknown', '2026-10-01', $4)`, [COMM, P[4], H5S, anyChange])) || ''));
  // 10.4 community consistency at the database level
  const COMM2 = '00000000-0000-0000-0000-0000000000c2'; const P2 = '00000000-0000-4000-8000-0000000000b1';
  await db.exec(`INSERT INTO communities (id, name) VALUES ('${COMM2}', 'Other Creek'); INSERT INTO properties (id, community_id) VALUES ('${P2}', '${COMM2}');`);
  const c2 = await W.applyChange({ rpc, community_id: COMM2, idempotency_key: 'c2-init', change: { documents: [doc('x', '9')] }, actor: { kind: 'agent', id: 'op' } });
  const c2change = c2.result.change_id;
  check('database: a canonical row cannot reference a party of another community (composite foreign key)', /foreign key|violates/i.test(await err(() => db.query(`INSERT INTO cd_ownerships (community_id, property_id, party_id, role, effective_from_basis, observed_as_of, change_id) VALUES ($1, $2, $3, 'owner', 'unknown', '2026-10-01', $4)`, [COMM2, P2, H1P, c2change])) || ''));
  check('database: a canonical row cannot reference a property of another community (trigger)', /is not in community/.test(await err(() => db.query(`INSERT INTO cd_ownerships (community_id, property_id, party_id, role, effective_from_basis, observed_as_of, change_id) VALUES ($1, $2, $3, 'owner', 'unknown', '2026-10-01', $4)`, [COMM, P2, H1P, anyChange])) || ''));
  check('database: evidence cannot point at another community\'s document', /foreign key|violates/i.test(await err(() => db.query(`INSERT INTO cd_evidence (community_id, subject_table, subject_id, observation, document_id, basis, change_id) VALUES ($1, 'cd_ownerships', $2, 'created', (SELECT id FROM cd_source_documents WHERE community_id = $3 LIMIT 1), 'x', $4)`, [COMM, own2, COMM2, anyChange])) || ''));
  // 10.4b end provenance is community-scoped: a lifecycle row cannot be ended by another community's change, even directly
  const openOcc = (await db.query(`SELECT id FROM cd_occupancies WHERE community_id = $1 AND effective_to IS NULL LIMIT 1`, [COMM])).rows[0].id;
  const openAddr = (await db.query(`SELECT id FROM cd_addresses WHERE community_id = $1 AND effective_to IS NULL LIMIT 1`, [COMM])).rows[0].id;
  const lifecycle = [['cd_ownerships', own2, 'transfer_settlement'], ['cd_occupancies', openOcc, 'move_out_statement'], ['cd_addresses', openAddr, 'superseded_by_source'], ['cd_contact_methods', phoneId, 'superseded_by_source']];
  for (const [t, id, basis] of lifecycle) {
    const e = await err(() => db.query(`UPDATE ${t} SET effective_to = '2026-11-15', effective_to_basis = $1, ended_by_change_id = $2 WHERE id = $3`, [basis, c2change, id]));
    check(`database: ${t} cannot be ended by a change of another community (composite end-provenance foreign key, direct UPDATE)`, /foreign key/i.test(e || ''), e);
    await db.exec('BEGIN');
    let same = null;
    try { same = await db.query(`UPDATE ${t} SET effective_to = '2026-11-15', effective_to_basis = $1, ended_by_change_id = $2 WHERE id = $3 AND effective_to IS NULL RETURNING id`, [basis, anyChange, id]); } catch (x) { same = { error: x.message }; }
    await db.exec('ROLLBACK');
    check(`end-only trigger still permits the same-community end of ${t} under the composite FK`, same && same.rows && same.rows.length === 1, JSON.stringify(same && same.error));
  }
  check('the probes left every lifecycle row open (rolled back)', (await db.query(`SELECT count(*)::int AS n FROM (SELECT effective_to FROM cd_ownerships WHERE id = $1 UNION ALL SELECT effective_to FROM cd_occupancies WHERE id = $2 UNION ALL SELECT effective_to FROM cd_addresses WHERE id = $3 UNION ALL SELECT effective_to FROM cd_contact_methods WHERE id = $4) x WHERE effective_to IS NULL`, [own2, openOcc, openAddr, phoneId])).rows[0].n === 4);
  // 10.5 occupancy_ends (end once, with basis + evidence)
  const t0occ = (await db.query(`SELECT o.id FROM cd_occupancies o JOIN cd_party_source_identities s ON s.party_id = o.party_id WHERE s.slot = 'tenant:0' AND s.identity_key = $1`, [sha('e')])).rows[0].id;
  const moveOut = { documents: [doc('mo', '4', 'move_out_statement', { observed_as_of: '2026-12-01' })], occupancy_ends: [{ occupancy_id: t0occ, effective_to: '2026-11-30', effective_to_basis: 'move_out_statement', evidence: [{ document_ref: 'mo', locator: {}, basis: 'tenant move-out notice' }] }] };
  const rmo = await apply('k-move-out', moveOut);
  check('occupancy_ends: a tenancy ends once with basis + evidence; the co-tenants stay open', rmo.ok && (await db.query(`SELECT effective_to::text AS t, effective_to_basis AS b FROM cd_occupancies WHERE id = $1`, [t0occ])).rows[0].b === 'move_out_statement' && (await db.query(`SELECT count(*)::int AS n FROM cd_occupancies WHERE property_id = $1 AND effective_to IS NULL`, [P[1]])).rows[0].n === 2);
  check('occupancy_ends: ending it again is refused', /not a current occupancy/.test(JSON.stringify(await apply('k-move-out-2', moveOut))));
  check('occupancy_ends: the end has its own provenance', (await rpc('cd_why', { p_subject_table: 'cd_occupancy_end', p_subject_id: t0occ }))[0].observation === 'ended');
  check('an occupancy created already-ended needs its end basis (service)', W.validateChange({ documents: [doc('d1', 'a')], parties: [person('sam', 'Sam Lee', [hid('H5')])], occupancies: [{ property_id: P[4], party_ref: 'sam', occupancy_kind: 'owner_occupant', basis: 'owner_statement', effective_to: '2026-01-01', observed_as_of: '2026-10-01', evidence: ev('d1', 6) }] }).failures.some((x) => x.code === 'END_DATE_BASIS_MISMATCH'));
  // 10.6 address / contact-method lifecycle: current vs historical
  const oldAddr = (await db.query(`SELECT id FROM cd_addresses WHERE party_id = $1 AND effective_to IS NULL AND is_primary`, [await pid('H3')])).rows[0].id;
  const newPrimary = { documents: [doc('d4', '5', 'homeowner_contact_information', { observed_as_of: '2026-12-15' })], parties: [person('pat', 'Pat Rivera', [hid('H3')])],
    addresses: [{ party_ref: 'pat', purpose: 'mailing', line1: '9 New Road', city: 'Newtown', state: null, postal_code: '73301', is_primary: true, is_property_address: false, observed_as_of: '2026-12-15', evidence: ev('d4', 3, 'new primary mailing marked by the source') }] };
  check('a second current primary mailing address is refused unless the old one is ended in the same change', /cd_one_current_primary_address/.test(JSON.stringify(await apply('k-addr-1', newPrimary))));
  const rAddr = await apply('k-addr-2', { ...newPrimary, address_ends: [{ address_id: oldAddr, effective_to: '2026-12-15', effective_to_basis: 'superseded_by_source', evidence: ev('d4', 3, 'the source now marks a different primary mailing address') }] });
  const addrHist = (await db.query(`SELECT line1, is_primary, effective_to IS NULL AS current, effective_to_basis FROM cd_addresses WHERE party_id = $1 ORDER BY recorded_at`, [await pid('H3')])).rows;
  check('address lifecycle: the old address is historical (ended, with basis + its own provenance), the new one is the current primary', rAddr.ok && addrHist.length === 2 && !addrHist[0].current && addrHist[0].effective_to_basis === 'superseded_by_source' && addrHist[1].current && addrHist[1].is_primary
    && (await rpc('cd_why', { p_subject_table: 'cd_address_end', p_subject_id: oldAddr }))[0].observation === 'ended', JSON.stringify(addrHist));
  const rAddr3 = await apply('k-addr-3', { documents: [doc('d5', '6', 'homeowner_contact_information', { observed_as_of: '2027-01-15' })], parties: [person('pat', 'Pat Rivera', [hid('H3')])], addresses: [{ ...newPrimary.addresses[0], observed_as_of: '2027-01-15', evidence: ev('d5', 3, 'same address again') }] });
  const curAddr = (await db.query(`SELECT id FROM cd_addresses WHERE party_id = $1 AND effective_to IS NULL`, [await pid('H3')])).rows;
  check('re-observing the current address appends evidence (no duplicate row)', rAddr3.ok && rAddr3.result.reobserved === 1 && curAddr.length === 1 && (await rpc('cd_why', { p_subject_table: 'cd_addresses', p_subject_id: curAddr[0].id })).length === 2);
  const rPh = await apply('k-phone-swap', { documents: [doc('d6', '7', 'homeowner_contact_information', { observed_as_of: '2027-02-01' })], parties: [person('pat', 'Pat Rivera', [hid('H3')])],
    contact_method_ends: [{ contact_method_id: phoneId, effective_to: '2027-02-01', effective_to_basis: 'superseded_by_source', evidence: ev('d6', 2, 'a different primary phone on the export') }],
    contact_methods: [{ party_ref: 'pat', method_type: 'phone', value: '(555) 020-0002', attribution: 'owner_record', is_primary: true, observed_as_of: '2027-02-01', evidence: ev('d6', 2, 'new primary phone') }] });
  check('contact-method lifecycle: the old phone is historical, the new one is the single current primary', rPh.ok && (await db.query(`SELECT count(*)::int AS n FROM cd_contact_methods WHERE party_id = $1 AND method_type = 'phone' AND is_primary AND effective_to IS NULL`, [await pid('H3')])).rows[0].n === 1
    && (await db.query(`SELECT effective_to_basis FROM cd_contact_methods WHERE id = $1`, [phoneId])).rows[0].effective_to_basis === 'superseded_by_source');
  // 10.7 a name pattern never establishes an organization
  check('database: kind organization needs a source field; "name_pattern_flag" is not a kind basis', /cd_party_kind_needs_source/.test(await err(() => db.query(`INSERT INTO cd_parties (community_id, kind, kind_basis, display_name, change_id) VALUES ($1, 'organization', 'unknown', 'Riverside Family Trust', $2)`, [COMM, anyChange])) || '')
    && /check|violat/i.test(await err(() => db.query(`INSERT INTO cd_parties (community_id, kind, kind_basis, display_name, change_id) VALUES ($1, 'organization', 'name_pattern_flag', 'Riverside Family Trust', $2)`, [COMM, anyChange])) || ''));
  {
    const XLSX = require('xlsx'); const R = require(`${REPO}/lib/onboarding/community/vantaca_roster.js`); const { buildCommunityGraph } = require(`${REPO}/lib/onboarding/community/resolve.js`);
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([
      { Account: '7001', 'Homeowner ID': 'ORG1', HomeownerName: 'Riverside Family Trust', FirstName: '', LastName: '', SpouseFirstName: '', SpouseLastName: '', BusinessName: '', MailStreetNo: '1', MailAddress1: 'A St', MailCity: 'X', MailState: '', MailZip: '1' },
      { Account: '7002', 'Homeowner ID': 'ORG2', HomeownerName: 'Oak Holdings LLC', FirstName: '', LastName: '', SpouseFirstName: '', SpouseLastName: '', BusinessName: 'Oak Holdings LLC', MailStreetNo: '2', MailAddress1: 'B St', MailCity: 'X', MailState: '', MailZip: '2' }]), 'Sheet1');
    const g = buildCommunityGraph(R.combine([R.readWorkbook(XLSX, XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }), 'r.xlsx')]), { observed_as_of: '2026-10-01' });
    const pr = W.proposalFromGraph(g, { documents: [], propertyIdOfAccount: () => null });
    const trust = pr.change.parties.find((x) => x.display_name === 'Riverside Family Trust'); const oak = pr.change.parties.find((x) => x.display_name === 'Oak Holdings LLC');
    check('graph -> proposal: a trust by name pattern stays kind unknown with a hint; a source business field makes an organization', trust.kind === 'unknown' && trust.kind_basis === 'unknown' && trust.hints.includes('organization_name_pattern') && oak.kind === 'organization' && oak.kind_basis === 'source_field', JSON.stringify([trust, oak]));
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
