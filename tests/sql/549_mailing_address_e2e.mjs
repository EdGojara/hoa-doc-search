// tests/sql/549_mailing_address_e2e.mjs — homeowner mailing address management.
//
// Builds the pre-549 shape (Supabase roles; a NON-superuser app_owner that owns
// the public objects and runs the migration; contacts as 049 + 153 left them;
// properties / ownerships / tenures; v_current_property_owners exactly as 457
// defines it; interactions letters; letter_mail_holds + its 544 guard;
// letter_mailing_evidence; collection_notices; audit_events) and proves:
//   APPLY   549 goes through lib/migrations/apply_one.js with its real checks file
//           (preflight, catalog diff, protected rows, verify); no existing address,
//           property, ownership, letter or notice row changes.
//   STAFF   set_contact_mailing_address() writes the contact, a history row and one
//           audit event naming the employee, and flags exactly the unmailed letters
//           whose recipient is that person (never a mailed one, an emailed one, or
//           another lot's); the letters themselves are never re-addressed; the
//           property address, ownerships and tenures are byte-identical.
//   OWNERS  a co-owner's change touches only that co-owner and flags nothing that
//           is mailed to the primary owner.
//   SYNC    an import/sync cannot replace a staff-entered address (kept, recorded);
//           for other contacts the one-line and structured forms stay in agreement.
//   VERIFY  resolving a flag releases only the hold it placed.
//   GRANTS  only the server can call the functions; the records are append-only.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let PGlite;
try { ({ PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite')); }
catch (_) { console.log('SKIP  549 mailing address e2e (@electric-sql/pglite not installed)'); process.exit(0); }
const require = createRequire(import.meta.url);
const A = require(`${REPO}/lib/migrations/apply_one.js`);
const F = '549_mailing_address_management.sql';

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { if (cond) { pass++; console.log('PASS ', name); } else { fail++; console.log('FAIL ', name, extra); } };
const lf = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm549-e2e-'));
fs.mkdirSync(path.join(dir, 'checks'));
fs.writeFileSync(path.join(dir, F), lf(`${REPO}/migrations/${F}`));
fs.writeFileSync(path.join(dir, 'checks', F.replace('.sql', '.json')), lf(`${REPO}/migrations/checks/${F.replace('.sql', '.json')}`));

const ED = '00000000-0000-4000-8000-0000000000ed';
const ANA = '00000000-0000-4000-8000-0000000000a1';
const GONE = '00000000-0000-4000-8000-0000000000d0';
const CG = 'a0000000-0000-4000-8000-000000000003';
const MARY = '10000000-0000-4000-8000-000000000001';   // primary owner of lot A; legacy one-line address
const JOE = '10000000-0000-4000-8000-000000000002';    // co-owner of lot A (not primary), own address
const INV = '10000000-0000-4000-8000-000000000003';    // investor: lots B and C, no mailing address
const LOT_A = '20000000-0000-4000-8000-00000000000a';
const LOT_B = '20000000-0000-4000-8000-00000000000b';
const LOT_C = '20000000-0000-4000-8000-00000000000c';
const L = (n) => `30000000-0000-4000-8000-00000000000${n}`;
const N1 = '40000000-0000-4000-8000-000000000001';
const N2 = '40000000-0000-4000-8000-000000000002';

// v_current_property_owners exactly as migration 457 defines it.
const VIEW_457 = (() => {
  const src = lf(`${REPO}/migrations/457_current_tenure_reader_views.sql`);
  const m = /CREATE OR REPLACE VIEW v_current_property_owners AS[\s\S]*?;/.exec(src);
  if (!m) throw new Error('could not find the 457 view');
  return m[0];
})();

const WORLD = `
  CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
  CREATE ROLE app_owner NOSUPERUSER NOBYPASSRLS;
  GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
  GRANT USAGE, CREATE ON SCHEMA public TO app_owner;
  -- Supabase's default privileges: every new table / function is granted to the API roles.
  ALTER DEFAULT PRIVILEGES FOR ROLE app_owner IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES FOR ROLE app_owner IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
  SET ROLE app_owner;
  CREATE OR REPLACE FUNCTION trusted_set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END $$;
  CREATE TABLE communities (id uuid PRIMARY KEY, name text);
  CREATE TABLE user_profiles (id uuid PRIMARY KEY, email text, full_name text, role text NOT NULL DEFAULT 'staff'
    CHECK (role IN ('admin','staff','assistant')), is_active boolean NOT NULL DEFAULT true);
  CREATE TABLE audit_events (
    id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY, community_id uuid, actor_user_id uuid NOT NULL REFERENCES user_profiles(id),
    actor_name text, entity_type text NOT NULL, entity_id text NOT NULL, action text NOT NULL, field text,
    previous_value jsonb, new_value jsonb, reason text NOT NULL CHECK (length(btrim(reason)) > 0), route text,
    record_ownership text NOT NULL DEFAULT 'association_record', created_at timestamptz NOT NULL DEFAULT now());
  CREATE TABLE contacts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), full_name text NOT NULL, primary_email text, primary_phone text,
    mailing_address text, vantaca_account_id text, notes text,
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
    mailing_street text, mailing_city text, mailing_state text DEFAULT 'TX', mailing_zip text);
  CREATE TRIGGER trg_contacts_updated_at BEFORE UPDATE ON contacts FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();
  CREATE TABLE properties (
    id uuid PRIMARY KEY, community_id uuid NOT NULL REFERENCES communities(id), street_address text NOT NULL, unit text,
    city text, state text, zip text, property_type text, lot_number text, latitude numeric, longitude numeric, boundary jsonb,
    vantaca_account_id text, trusted_account_number text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
  CREATE TABLE property_ownerships (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), property_id uuid NOT NULL REFERENCES properties(id), contact_id uuid NOT NULL REFERENCES contacts(id),
    start_date date NOT NULL, end_date date, vesting text, is_primary boolean NOT NULL DEFAULT false, source text,
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
  CREATE TABLE ownership_tenures (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), property_id uuid NOT NULL REFERENCES properties(id),
    kind text NOT NULL, start_date date, end_date date);
  ${VIEW_457}
  CREATE TABLE interactions (
    id uuid PRIMARY KEY, community_id uuid REFERENCES communities(id), property_id uuid REFERENCES properties(id), contact_id uuid REFERENCES contacts(id),
    violation_id uuid, type text, direction text, subject text, content text, status text, delivery_method text,
    printed_at timestamptz, mailed_at timestamptz, sent_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
  CREATE TABLE letter_mailing_evidence (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), interaction_id uuid NOT NULL REFERENCES interactions(id),
    community_id uuid NOT NULL, outcome text NOT NULL, mailed_on date, recorded_at timestamptz NOT NULL DEFAULT now());
  CREATE TABLE letter_mail_holds (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), interaction_id uuid NOT NULL REFERENCES interactions(id), community_id uuid NOT NULL REFERENCES communities(id),
    reason text NOT NULL, directed_by text NOT NULL, directed_at timestamptz NOT NULL DEFAULT now(), released_at timestamptz,
    released_by_user_id uuid REFERENCES user_profiles(id), release_reason text,
    CHECK (released_at IS NULL OR (released_by_user_id IS NOT NULL AND coalesce(release_reason, '') <> '')));
  CREATE UNIQUE INDEX uq_letter_mail_holds_active ON letter_mail_holds (interaction_id) WHERE released_at IS NULL;
  CREATE FUNCTION letter_mail_holds_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
  BEGIN
    IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'mail holds are permanent (hold %); release it instead', OLD.id; END IF;
    IF OLD.released_at IS NOT NULL THEN RAISE EXCEPTION 'hold % was already released', OLD.id; END IF;
    IF NEW.interaction_id IS DISTINCT FROM OLD.interaction_id OR NEW.community_id IS DISTINCT FROM OLD.community_id
       OR NEW.reason IS DISTINCT FROM OLD.reason OR NEW.directed_by IS DISTINCT FROM OLD.directed_by
       OR NEW.directed_at IS DISTINCT FROM OLD.directed_at THEN
      RAISE EXCEPTION 'only the release of hold % can be recorded', OLD.id;
    END IF;
    RETURN NEW;
  END $fn$;
  CREATE TRIGGER trg_letter_mail_holds_guard BEFORE UPDATE OR DELETE ON letter_mail_holds FOR EACH ROW EXECUTE FUNCTION letter_mail_holds_guard();
  CREATE TABLE collection_notices (id uuid PRIMARY KEY, community_id uuid NOT NULL REFERENCES communities(id), property_id uuid NOT NULL REFERENCES properties(id),
    status text NOT NULL, owner_name text, mailing_address jsonb, created_at timestamptz NOT NULL DEFAULT now());
  CREATE TABLE schema_migrations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), filename text NOT NULL UNIQUE, sha256 text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now(), applied_by text, duration_ms integer, error text);

  GRANT SELECT, INSERT ON audit_events TO service_role;
  GRANT SELECT, INSERT, UPDATE, DELETE ON user_profiles, contacts, properties, property_ownerships, ownership_tenures, interactions, collection_notices TO service_role;
  GRANT SELECT, INSERT ON letter_mailing_evidence TO service_role;
  GRANT SELECT, INSERT, UPDATE ON letter_mail_holds TO service_role;
  GRANT SELECT ON v_current_property_owners TO anon, authenticated, service_role;
  GRANT SELECT, UPDATE ON contacts TO authenticated;

  INSERT INTO schema_migrations (filename, sha256) VALUES ('545_audit_events_and_closure_outcomes.sql', 'r'), ('548_user_profiles_lockdown.sql', 'r');
  INSERT INTO communities VALUES ('${CG}', 'Canyon Gate');
  INSERT INTO user_profiles (id, email, full_name, role, is_active) VALUES
    ('${ED}', 'ed@example.test', 'Ed Owner', 'admin', true), ('${ANA}', 'ana@example.test', 'Ana Staff', 'staff', true),
    ('${GONE}', 'gone@example.test', 'Former Staff', 'staff', false);
  INSERT INTO contacts (id, full_name, mailing_address, mailing_street, mailing_city, mailing_state, mailing_zip) VALUES
    ('${MARY}', 'Mary Owner', '100 Oak St, Houston, TX 77001', '100 Oak St', 'Houston', 'TX', '77001'),
    ('${JOE}',  'Joe CoOwner', '7 Lake Dr, Katy, TX 77450', '7 Lake Dr', 'Katy', 'TX', '77450'),
    ('${INV}',  'Investor LLC', NULL, NULL, NULL, 'TX', NULL);
  INSERT INTO properties (id, community_id, street_address, city, state, zip, trusted_account_number) VALUES
    ('${LOT_A}', '${CG}', '100 Oak St', 'Houston', 'TX', '77001', 'T-100'),
    ('${LOT_B}', '${CG}', '200 Elm St', 'Houston', 'TX', '77001', 'T-200'),
    ('${LOT_C}', '${CG}', '300 Ash St', 'Houston', 'TX', '77001', 'T-300');
  INSERT INTO property_ownerships (property_id, contact_id, start_date, is_primary) VALUES
    ('${LOT_A}', '${MARY}', '2020-01-01', true), ('${LOT_A}', '${JOE}', '2020-01-01', false),
    ('${LOT_B}', '${INV}', '2021-01-01', true), ('${LOT_C}', '${INV}', '2021-01-01', true);
  INSERT INTO ownership_tenures (property_id, kind, start_date) VALUES ('${LOT_A}', 'owner', '2020-01-01'), ('${LOT_B}', 'owner', '2021-01-01'), ('${LOT_C}', 'owner', '2021-01-01');
  INSERT INTO interactions (id, community_id, property_id, type, status, delivery_method, printed_at, mailed_at, content) VALUES
    ('${L(1)}', '${CG}', '${LOT_A}', 'violation_letter', 'draft',    'first_class_mail', NULL, NULL, 'a/1.pdf'),
    ('${L(2)}', '${CG}', '${LOT_A}', 'violation_letter', 'approved', 'first_class_mail', NULL, NULL, 'a/2.pdf'),
    ('${L(3)}', '${CG}', '${LOT_A}', 'violation_letter', 'approved', 'certified_mail',   now(), NULL, 'a/3.pdf'),
    ('${L(4)}', '${CG}', '${LOT_A}', 'violation_letter', 'sent',     'certified_mail',   now(), now(), 'a/4.pdf'),
    ('${L(5)}', '${CG}', '${LOT_B}', 'violation_letter', 'approved', 'first_class_mail', NULL, NULL, 'b/5.pdf'),
    ('${L(6)}', '${CG}', '${LOT_A}', 'violation_letter', 'approved', 'first_class_mail', now(), NULL, 'a/6.pdf'),
    ('${L(7)}', '${CG}', '${LOT_A}', 'email_letter',     'approved', 'email',            NULL, NULL, 'a/7.pdf'),
    ('${L(8)}', '${CG}', '${LOT_A}', 'violation_letter', 'voided',   'first_class_mail', NULL, NULL, 'a/8.pdf');
  INSERT INTO letter_mailing_evidence (interaction_id, community_id, outcome, mailed_on) VALUES ('${L(6)}', '${CG}', 'mailed', current_date);
  INSERT INTO letter_mail_holds (interaction_id, community_id, reason, directed_by) VALUES ('${L(3)}', '${CG}', 'Held by Ed: do not mail until Ed releases it.', 'Ed Gojara');
  INSERT INTO collection_notices (id, community_id, property_id, status, owner_name, mailing_address) VALUES
    ('${N1}', '${CG}', '${LOT_A}', 'printed', 'Mary Owner', '{"street":"100 Oak St","cityline":"Houston, TX 77001"}'),
    ('${N2}', '${CG}', '${LOT_A}', 'mailed',  'Mary Owner', '{"street":"100 Oak St","cityline":"Houston, TX 77001"}');
`;

const db = new PGlite();
await db.exec(WORLD);
const client = { query: async (sql, params) => {
  if (params) { const r = await db.query(sql, params.map((v) => (v && typeof v === 'object' ? JSON.stringify(v) : v))); return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length }; }
  const rs = await db.exec(sql); const last = rs[rs.length - 1] || { rows: [] }; return { rows: last.rows, rowCount: last.affectedRows ?? 0 };
} };

// as(who, sql): run as a Supabase role ('owner' = the superuser test harness).
async function as(who, sql) {
  const role = { service: 'service_role', anon: 'anon', auth: 'authenticated', app: 'app_owner' }[who] || null;
  await db.exec('RESET ROLE;' + (role ? ` SET ROLE ${role};` : ''));
  try { return { rows: (await db.query(sql)).rows, err: null }; }
  catch (e) { return { rows: [], err: e.message }; }
  finally { await db.exec('RESET ROLE; SET ROLE app_owner;'); }
}
const one = async (who, sql) => (await as(who, sql)).rows[0];
const snap = async (t, cols = '*') => (await one('owner', `SELECT md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) h, count(*)::int n FROM (SELECT ${cols} FROM ${t}) x`));

// ---- apply through the tool ---------------------------------------------------
const contactCols = 'id, full_name, mailing_address, mailing_street, mailing_city, mailing_state, mailing_zip, updated_at';
const before = {
  contacts: await snap('contacts', contactCols), properties: await snap('properties'), ownerships: await snap('property_ownerships'),
  tenures: await snap('ownership_tenures'), interactions: await snap('interactions'), notices: await snap('collection_notices'), holds: await snap('letter_mail_holds'),
};
const viewColsBefore = (await one('owner', `SELECT string_agg(attname, ',' ORDER BY attnum) c FROM pg_attribute WHERE attrelid = 'v_current_property_owners'::regclass AND attnum > 0`)).c;
const ctx = { client, user: { id: 'owner-uuid', email: 'owner@example.test' }, deployedCommit: 'deadbeefcafe', migrationsDir: dir, secret: 'e2e' };
const plan = await A.planMigration({ ...ctx, filename: F });
check('plan: ready, every preflight passes', plan.status === 'ready' && plan.preflight.every((p) => p.ok), JSON.stringify({ status: plan.status, error: plan.error, reason: plan.reason, preflight: plan.preflight }).slice(0, 1500));
const r = await A.applyMigration({ ...ctx, planToken: plan.plan_token, log: { error() {} }, apiCheck: async () => ({ ok: true, count: 0 }) });
check('apply: 549 applied and verified through the tool', r.status === 'applied', JSON.stringify({ status: r.status, error: r.error, detail: r.detail }).slice(0, 5000));
if (r.status !== 'applied') { console.log(`\n${pass} passed, ${fail} failed`); process.exit(1); }

check('no existing mailing address changed (contacts identical over the pre-549 columns)', (await snap('contacts', contactCols)).h === before.contacts.h);
for (const k of ['properties', 'ownerships', 'tenures', 'interactions', 'notices', 'holds']) {
  const t = { properties: 'properties', ownerships: 'property_ownerships', tenures: 'ownership_tenures', interactions: 'interactions', notices: 'collection_notices', holds: 'letter_mail_holds' }[k];
  check(`migration changed no ${t} row`, (await snap(t)).h === before[k].h);
}
const viewColsAfter = (await one('owner', `SELECT string_agg(attname, ',' ORDER BY attnum) c FROM pg_attribute WHERE attrelid = 'v_current_property_owners'::regclass AND attnum > 0`)).c;
check('owner view keeps its 457 columns in order and appends the four new ones',
  viewColsAfter === viewColsBefore + ',owner_mailing_unit,owner_mailing_country,owner_mailing_source,owner_mailing_updated_at', viewColsAfter);
check('owner view still readable by the server after CREATE OR REPLACE', !(await as('service', `SELECT * FROM v_current_property_owners`)).err);

// ---- the staff change -----------------------------------------------------------
const set = (who, args) => as(who, `SELECT set_contact_mailing_address(${args}) AS j`);
const propsBefore = await snap('properties'); const ownBefore = await snap('property_ownerships'); const tenBefore = await snap('ownership_tenures');
const letterRowsBefore = await snap('interactions'); const noticeRowsBefore = await snap('collection_notices');
const res1 = await set('service', `'${MARY}', '9 Elm Rd', 'Apt 4', 'Dallas', 'tx', '75201', NULL, 'Owner called: moved to Dallas', '${ANA}', 'POST /api/homeowner/:contactId/mailing-address'`);
const j1 = (res1.rows[0] || {}).j || {};
check('Ana changes Mary\'s mailing address', !res1.err && j1.status === 'changed', res1.err || JSON.stringify(j1));
const mary = await one('owner', `SELECT * FROM contacts WHERE id = '${MARY}'`);
check('contact holds the structured address, uppercased state, and the composed one-line form',
  mary.mailing_street === '9 Elm Rd' && mary.mailing_unit === 'Apt 4' && mary.mailing_city === 'Dallas' && mary.mailing_state === 'TX'
  && mary.mailing_zip === '75201' && mary.mailing_country === 'US' && mary.mailing_address === '9 Elm Rd Apt 4, Dallas, TX 75201', JSON.stringify(mary));
check('contact records that an employee (Ana) entered it', mary.mailing_address_source === 'staff' && mary.mailing_address_updated_by === ANA && mary.mailing_address_updated_at);
check('property address, ownerships and tenures are byte-identical',
  (await snap('properties')).h === propsBefore.h && (await snap('property_ownerships')).h === ownBefore.h && (await snap('ownership_tenures')).h === tenBefore.h);
check('no letter or notice was re-addressed or otherwise changed', (await snap('interactions')).h === letterRowsBefore.h && (await snap('collection_notices')).h === noticeRowsBefore.h);
const hist = await as('owner', `SELECT * FROM contact_mailing_address_changes WHERE contact_id = '${MARY}'`);
const h1 = hist.rows[0] || {};
check('one history row: previous + new address, reason, who', hist.rows.length === 1 && h1.kind === 'staff_change'
  && h1.previous_address.text === '100 Oak St, Houston, TX 77001' && h1.new_address.text === '9 Elm Rd Apt 4, Dallas, TX 75201'
  && h1.reason === 'Owner called: moved to Dallas' && h1.changed_by_user_id === ANA && h1.changed_by_name === 'Ana Staff' && h1.community_id === CG, JSON.stringify(h1));
const ae = await as('owner', `SELECT * FROM audit_events WHERE entity_type = 'contact' AND entity_id = '${MARY}'`);
const a1 = ae.rows[0] || {};
check('one canonical audit event naming Ana, with previous and new address and the reason', ae.rows.length === 1 && a1.action === 'mailing_address.changed'
  && a1.actor_user_id === ANA && a1.field === 'mailing_address' && a1.previous_value.street === '100 Oak St' && a1.new_value.street === '9 Elm Rd'
  && a1.reason === 'Owner called: moved to Dallas' && a1.community_id === CG && a1.route === 'POST /api/homeowner/:contactId/mailing-address', JSON.stringify(a1));
const reviews = (await as('owner', `SELECT letter_kind, coalesce(interaction_id, collection_notice_id) AS letter, letter_state, mail_hold_id FROM mailing_address_letter_reviews ORDER BY 2`)).rows;
const flagged = reviews.map((x) => x.letter).sort();
check('flags exactly the draft, approved and printed-unmailed letters on Mary\'s lot plus the printed collections notice',
  JSON.stringify(flagged) === JSON.stringify([L(1), L(2), L(3), N1].sort()) && j1.letters_flagged === 4, JSON.stringify(reviews));
check('never flags a mailed letter, a letter with mailed evidence, an emailed letter, a voided letter, another lot\'s letter or a mailed notice',
  ![L(4), L(5), L(6), L(7), L(8), N2].some((x) => flagged.includes(x)));
check('flag records the state each letter was in', JSON.stringify(reviews.filter((x) => x.letter_kind === 'violation_letter').map((x) => x.letter_state)) === JSON.stringify(['draft', 'approved', 'printed_not_mailed']), JSON.stringify(reviews));
const holds = (await as('owner', `SELECT interaction_id, reason, directed_by FROM letter_mail_holds WHERE released_at IS NULL ORDER BY interaction_id`)).rows;
check('a mail hold now stops L1 and L2 being confirmed as mailed; L3 keeps Ed\'s own hold (no second hold)',
  JSON.stringify(holds.map((x) => x.interaction_id)) === JSON.stringify([L(1), L(2), L(3)])
  && holds.filter((x) => /Mailing address changed/.test(x.reason) && x.directed_by === 'Ana Staff').length === 2
  && /Held by Ed/.test(holds.find((x) => x.interaction_id === L(3)).reason));
check('the L3 flag points at no hold of its own', reviews.find((x) => x.letter === L(3)).mail_hold_id === null);

// ---- repeat, confirm, validation ----------------------------------------------------
const again = await set('service', `'${MARY}', '9 Elm Rd', 'Apt 4', 'Dallas', 'TX', '75201', 'US', 'same again', '${ANA}', NULL`);
check('the same address again is a no-op (no history, no audit, no flags)', (again.rows[0] || {}).j && again.rows[0].j.status === 'unchanged'
  && (await one('owner', `SELECT count(*)::int n FROM contact_mailing_address_changes`)).n === 1 && (await one('owner', `SELECT count(*)::int n FROM audit_events`)).n === 1
  && (await one('owner', `SELECT count(*)::int n FROM mailing_address_letter_reviews`)).n === 4);
const bad = async (args, re, label) => { const x = await set('service', args); check(label, re.test(x.err || ''), x.err || JSON.stringify(x.rows)); };
await bad(`'${INV}', '1 A St', NULL, 'Austin', 'TX', '7870', NULL, 'r', '${ANA}', NULL`, /ZIP must be 5 digits/, 'refuses a bad ZIP');
await bad(`'${INV}', '1 A St', NULL, 'Austin', 'Texas', '78701', NULL, 'r', '${ANA}', NULL`, /2-letter/, 'refuses a state that is not the 2-letter code');
await bad(`'${INV}', '1 A St', NULL, 'Austin', 'TX', '78701', NULL, '   ', '${ANA}', NULL`, /reason is required/, 'refuses a change with no reason');
await bad(`'${INV}', '', NULL, 'Austin', 'TX', '78701', NULL, 'r', '${ANA}', NULL`, /street and city are required/, 'refuses a blank street');
await bad(`'${INV}', E'1 A St\\nX', NULL, 'Austin', 'TX', '78701', NULL, 'r', '${ANA}', NULL`, /line breaks/, 'refuses a line break inside a field');
await bad(`'${INV}', '1 A St', NULL, 'Austin', 'TX', '78701', NULL, 'r', '${GONE}', NULL`, /active employee/, 'refuses an inactive employee');
await bad(`'${INV}', '1 A St', NULL, 'Austin', 'TX', '78701', NULL, 'r', '00000000-0000-4000-8000-000000000999', NULL`, /active employee/, 'refuses an unknown actor');
await bad(`'10000000-0000-4000-8000-000000000999', '1 A St', NULL, 'Austin', 'TX', '78701', NULL, 'r', '${ANA}', NULL`, /homeowner not found/, 'refuses an unknown homeowner');
check('refused calls wrote nothing', (await one('owner', `SELECT count(*)::int n FROM contact_mailing_address_changes`)).n === 1 && (await one('owner', `SELECT mailing_street FROM contacts WHERE id = '${INV}'`)).mailing_street === null);

const foreign = await set('service', `'${INV}', '22 King St W', 'Suite 500', 'Toronto', 'ON', 'M5H 1A1', 'ca', 'Investor office is in Canada', '${ED}', NULL`);
const inv = await one('owner', `SELECT * FROM contacts WHERE id = '${INV}'`);
check('a foreign address is accepted with free-form province/postal code and ends with the country line',
  !foreign.err && inv.mailing_country === 'CA' && inv.mailing_address === '22 King St W Suite 500\nToronto ON M5H 1A1\nCA', foreign.err || JSON.stringify(inv));
check('the investor change flags the approved letter on lot B (the investor is its recipient)',
  (await one('owner', `SELECT count(*)::int n FROM mailing_address_letter_reviews WHERE interaction_id = '${L(5)}' AND resolved_at IS NULL`)).n === 1);

// ---- multiple owners ----------------------------------------------------------
const reviewsBeforeJoe = (await one('owner', `SELECT count(*)::int n FROM mailing_address_letter_reviews`)).n;
const joe = await set('service', `'${JOE}', '55 Bay Ct', NULL, 'Galveston', 'TX', '77550', NULL, 'Co-owner gets mail separately', '${ANA}', NULL`);
check('a co-owner\'s change is saved for the co-owner only', !joe.err && (await one('owner', `SELECT mailing_street FROM contacts WHERE id = '${JOE}'`)).mailing_street === '55 Bay Ct'
  && (await one('owner', `SELECT mailing_street FROM contacts WHERE id = '${MARY}'`)).mailing_street === '9 Elm Rd', joe.err || '');
check('a co-owner\'s change flags no letter (the lot\'s letters go to the primary owner)', (await one('owner', `SELECT count(*)::int n FROM mailing_address_letter_reviews`)).n === reviewsBeforeJoe
  && joe.rows[0].j.letters_flagged === 0);

// ---- syncs and imports ------------------------------------------------------------
const histN = async () => (await one('owner', `SELECT count(*)::int n FROM contact_mailing_address_changes WHERE kind = 'sync_blocked'`)).n;
const vantaca = await as('service', `UPDATE contacts SET mailing_address = '100 Oak St, Houston, TX 77001', primary_email = 'mary@example.test' WHERE id = '${MARY}'`);
const m2 = await one('owner', `SELECT * FROM contacts WHERE id = '${MARY}'`);
check('an import cannot put the older address back over a staff-entered one', !vantaca.err && m2.mailing_address === '9 Elm Rd Apt 4, Dallas, TX 75201' && m2.mailing_street === '9 Elm Rd', vantaca.err || JSON.stringify(m2));
check('the rest of the import row still applies (email updated)', m2.primary_email === 'mary@example.test');
check('the blocked attempt is recorded with what the import tried to write', (await histN()) === 1
  && (await one('owner', `SELECT new_address->>'text' t FROM contact_mailing_address_changes WHERE kind = 'sync_blocked'`)).t === '100 Oak St, Houston, TX 77001');
await as('service', `UPDATE contacts SET mailing_street = '1 Old Rd', mailing_city = 'Houston' WHERE id = '${MARY}'`);
check('a roster import of structured fields is blocked the same way', (await one('owner', `SELECT mailing_street FROM contacts WHERE id = '${MARY}'`)).mailing_street === '9 Elm Rd' && (await histN()) === 2);
await as('auth', `UPDATE contacts SET mailing_address = 'x', mailing_address_source = NULL WHERE id = '${MARY}'`);
check('a signed-in client cannot clear the protection or the address either', (await one('owner', `SELECT mailing_address_source s, mailing_street FROM contacts WHERE id = '${MARY}'`)).s === 'staff'
  && (await histN()) === 3);
await as('service', `UPDATE contacts SET full_name = 'Mary A. Owner' WHERE id = '${MARY}'`);
check('a write that does not touch the address records nothing', (await histN()) === 3);
check('only the staff function can mark an address staff-entered',
  !(await as('service', `UPDATE contacts SET mailing_address_source = 'staff', mailing_address_updated_by = '${ANA}' WHERE id = '${JOE}' AND false`)).err
  && (await one('owner', `INSERT INTO contacts (full_name, mailing_address, mailing_address_source, mailing_address_updated_by) VALUES ('New Person', '1 New St, Houston, TX 77002', 'staff', '${ANA}') RETURNING mailing_address_source s, mailing_address_updated_by u, mailing_street, mailing_zip`)).s === null);
const np = await one('owner', `SELECT mailing_street, mailing_city, mailing_zip FROM contacts WHERE full_name = 'New Person'`);
check('a new contact\'s one-line address is split into the structured fields', np.mailing_street === '1 New St' && np.mailing_city === 'Houston' && np.mailing_zip === '77002', JSON.stringify(np));
const PLAIN = '10000000-0000-4000-8000-000000000004';
await as('owner', `INSERT INTO contacts (id, full_name) VALUES ('${PLAIN}', 'Plain Person')`);
await as('service', `UPDATE contacts SET mailing_address = '5 Pine Ln, Suite 2, Austin, TX 78701' WHERE id = '${PLAIN}'`);
let pl = await one('owner', `SELECT * FROM contacts WHERE id = '${PLAIN}'`);
check('one-line write -> structured fields follow', pl.mailing_street === '5 Pine Ln, Suite 2' && pl.mailing_city === 'Austin' && pl.mailing_state === 'TX' && pl.mailing_zip === '78701', JSON.stringify(pl));
await as('service', `UPDATE contacts SET mailing_street = '6 Pine Ln' WHERE id = '${PLAIN}'`);
pl = await one('owner', `SELECT * FROM contacts WHERE id = '${PLAIN}'`);
check('structured write -> one-line form follows', pl.mailing_address === '6 Pine Ln, Austin, TX 78701', pl.mailing_address);
await as('service', `UPDATE contacts SET mailing_address = '12 Main Street Richmond TX 77469' WHERE id = '${PLAIN}'`);
pl = await one('owner', `SELECT * FROM contacts WHERE id = '${PLAIN}'`);
check('an unparseable one-line address clears the stale structured fields (readers use the one-line text)', pl.mailing_street === null && pl.mailing_address === '12 Main Street Richmond TX 77469', JSON.stringify(pl));
await as('service', `UPDATE contacts SET mailing_address = '8 Cedar Ct, Sugar Land TX 77479' WHERE id = '${PLAIN}'`);
pl = await one('owner', `SELECT * FROM contacts WHERE id = '${PLAIN}'`);
check('"Street, City ST ZIP" (no comma before the state) parses', pl.mailing_street === '8 Cedar Ct' && pl.mailing_city === 'Sugar Land' && pl.mailing_zip === '77479', JSON.stringify(pl));
check('a non-staff contact never gets a staff stamp from these writes', pl.mailing_address_source === null);

// ---- resolving a flag -------------------------------------------------------------
const rid = async (letter) => (await one('owner', `SELECT id FROM mailing_address_letter_reviews WHERE coalesce(interaction_id, collection_notice_id) = '${letter}'`)).id;
const resolve = (id, reason, actor = ANA) => as('service', `SELECT resolve_mailing_address_letter_review('${id}', '${reason}', '${actor}', NULL) AS j`);
const r2 = await resolve(await rid(L(2)), 'Envelope re-addressed to Dallas, checked against Homeowner 360');
check('Ana verifies L2: flag resolved, its hold released', !r2.err && r2.rows[0].j.hold_released === true
  && (await one('owner', `SELECT count(*)::int n FROM letter_mail_holds WHERE interaction_id = '${L(2)}' AND released_at IS NULL`)).n === 0, r2.err || '');
check('the verification is an audit event naming Ana', (await one('owner', `SELECT count(*)::int n FROM audit_events WHERE action = 'mailing_address.letter_verified' AND actor_user_id = '${ANA}'`)).n === 1);
check('a flag cannot be verified twice', /already verified/.test((await resolve(await rid(L(2)), 'again please')).err || ''));
check('verifying needs a real reason', /how the destination was verified/.test((await resolve(await rid(L(1)), 'ok')).err || ''));
const r3 = await resolve(await rid(L(3)), 'Certified envelope checked: Dallas address');
check('verifying L3 leaves Ed\'s own hold in place', !r3.err && r3.rows[0].j.hold_released === false
  && (await one('owner', `SELECT count(*)::int n FROM letter_mail_holds WHERE interaction_id = '${L(3)}' AND released_at IS NULL`)).n === 1);
check('an inactive employee cannot verify', /active employee/.test((await resolve(await rid(L(1)), 'checked the envelope', GONE)).err || ''));

// ---- permanence + grants ---------------------------------------------------------------
check('history cannot be edited or deleted, even by the owner', /permanent/.test((await as('app', `UPDATE contact_mailing_address_changes SET reason = 'x'`)).err || '')
  && /permanent/.test((await as('app', `DELETE FROM contact_mailing_address_changes`)).err || ''));
check('a flag cannot be rewritten or deleted', /only the resolution/.test((await as('app', `UPDATE mailing_address_letter_reviews SET letter_state = 'x' WHERE resolved_at IS NULL`)).err || '')
  && /permanent/.test((await as('app', `DELETE FROM mailing_address_letter_reviews`)).err || ''));
check('signed-in users and anon cannot call the staff functions', /permission denied/.test((await set('auth', `'${INV}', '1 A St', NULL, 'Austin', 'TX', '78701', NULL, 'r', '${ANA}', NULL`)).err || '')
  && /permission denied/.test((await set('anon', `'${INV}', '1 A St', NULL, 'Austin', 'TX', '78701', NULL, 'r', '${ANA}', NULL`)).err || '')
  && /permission denied/.test((await as('auth', `SELECT resolve_mailing_address_letter_review('${await rid(L(1))}', 'checked it', '${ANA}', NULL)`)).err || ''));
check('signed-in users cannot read or write the records', /permission denied/.test((await as('auth', `SELECT * FROM contact_mailing_address_changes`)).err || '')
  && /permission denied/.test((await as('auth', `INSERT INTO contact_mailing_address_changes (contact_id, kind, previous_address, new_address, reason) VALUES ('${MARY}', 'sync_blocked', '{}', '{}', 'x')`)).err || ''));
check('despite Supabase default privileges, anon has no access to the records and the server cannot delete or rewrite them',
  /permission denied/.test((await as('anon', `SELECT * FROM mailing_address_letter_reviews`)).err || '')
  && /permission denied/.test((await as('anon', `SELECT * FROM contact_mailing_address_changes`)).err || '')
  && /permission denied/.test((await as('service', `DELETE FROM contact_mailing_address_changes`)).err || '')
  && /permission denied/.test((await as('service', `DELETE FROM mailing_address_letter_reviews`)).err || ''));
check('row level security is on for both record tables',
  (await one('owner', `SELECT count(*)::int n FROM pg_class WHERE relname IN ('contact_mailing_address_changes', 'mailing_address_letter_reviews') AND relrowsecurity`)).n === 2);
check('the server reads the records',!(await as('service', `SELECT * FROM contact_mailing_address_changes`)).err && !(await as('service', `SELECT * FROM mailing_address_letter_reviews`)).err);

const replan = await A.planMigration({ ...ctx, filename: F });
check('re-planning after apply is refused as already applied', replan.status !== 'ready' && !replan.plan_token, JSON.stringify({ status: replan.status }));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
