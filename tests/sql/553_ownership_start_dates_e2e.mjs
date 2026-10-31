// tests/sql/553_ownership_start_dates_e2e.mjs — migration 553 (roster-load start dates replaced by county
// deed dates or NULL) applied END TO END through the single-migration tool with its REAL checks file, on a
// world built from the migration's own list (all 2,332 periods, at production scale), with the REAL tenure
// guards (456 / 459 / 536), the REAL ledger views (457) and the REAL transfer function (460). Then:
//   BEFORE  the pending Waterview transfer (settlement 2026-05-04) is refused by the 2026-05-19 load date;
//   APPLY   1,216 county deed dates + 1,116 NULLs, recorded with evidence; nothing outside the list moves;
//           no owner, account number, end date or balance changes; the tenure guard is back on;
//   RERUN   running the file again changes nothing;
//   AFTER   the same transfer is approved through approve_ownership_proposal: the seller ends 2026-05-03,
//           keeps its -$56.37 credit on its own tenure, the buyer starts 2026-05-04 with nothing;
//   GUARDS  correction records are permanent; tenure start dates are immutable again.
// Postgres 17 (PGlite 0.3.x). Skips without PGlite.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let PGlite;
try { ({ PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite')); }
catch (_) { console.log('SKIP  553 ownership start dates e2e (@electric-sql/pglite not installed)'); process.exit(0); }
const require = createRequire(import.meta.url);
const A = require(`${REPO}/lib/migrations/apply_one.js`);
const F = '553_ownership_start_dates_county.sql';
let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { if (cond) { pass++; console.log('PASS ', name); } else { fail++; console.log('FAIL ', name, extra); } };
const lf = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm553-e2e-'));
fs.mkdirSync(path.join(dir, 'checks'));
const SQL = lf(`${REPO}/migrations/${F}`);
fs.writeFileSync(path.join(dir, F), SQL);
fs.writeFileSync(path.join(dir, 'checks', F.replace('.sql', '.json')), lf(`${REPO}/migrations/checks/${F.replace('.sql', '.json')}`));
const PRINT = process.argv.includes('--print-objects');

const WV = 'a0000000-0000-4000-8000-000000000001', LOPF = 'a0000000-0000-4000-8000-000000000002', CG = 'a0000000-0000-4000-8000-000000000003';
const QR = 'a0000000-0000-4000-8000-000000000005', SCR = 'a0000000-0000-4000-8000-000000000006', EW = 'a0000000-0000-4000-8000-000000000004';
const SELLER_TENURE = '56bd7953-fc8c-406d-88c5-f899e698c2f1', SELLER_LOT = 'f47ed6f9-b60a-4173-a1bf-02423fcabd2a', PROPOSAL = '0f146aca-ec7f-4dd7-ad09-81b7b8459e4e';
const MC = '00000000-0000-0000-0000-000000000001';

const db = new PGlite();
await db.exec(`
  CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
  CREATE OR REPLACE FUNCTION trusted_set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END $$;
  CREATE TABLE schema_migrations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), filename text NOT NULL UNIQUE, sha256 text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now(), applied_by text, duration_ms integer, error text);
  CREATE TABLE communities (id uuid PRIMARY KEY, name text);
  CREATE TABLE properties (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), community_id uuid NOT NULL REFERENCES communities(id), street_address text,
    vantaca_account_id text, trusted_account_number text, updated_at timestamptz DEFAULT now());
  CREATE TABLE contacts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), full_name text, primary_email text, primary_phone text, mailing_address text,
    vantaca_account_id text, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
  CREATE TABLE ownership_change_proposals (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), property_id uuid, community_id uuid, current_contact_id uuid,
    proposed_owner_name text, proposed_owner_email text, proposed_owner_phone text, proposed_mailing_address text, vantaca_account_id text,
    status text NOT NULL, reviewed_at timestamptz, reviewed_by text, decision_notes text, effective_start_date date, effective_end_date_prior date,
    home_sale_id uuid, seller_tenure_id uuid, buyer_tenure_id uuid, transfer_exceptions jsonb, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
  CREATE TABLE ownership_tenures (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), community_id uuid NOT NULL REFERENCES communities(id), property_id uuid REFERENCES properties(id),
    kind text NOT NULL CHECK (kind IN ('owner', 'legacy')), start_date date, end_date date, vantaca_account_id text,
    origin text NOT NULL CONSTRAINT ownership_tenures_origin_check CHECK (origin IN ('backfill_current','backfill_historical','backfill_legacy','transfer','conversion')),
    created_by_proposal_id uuid REFERENCES ownership_change_proposals(id) ON DELETE SET NULL, notes text, created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT ownership_tenures_legacy_has_no_property CHECK ((kind = 'legacy') = (property_id IS NULL)),
    CONSTRAINT ownership_tenures_dates_ordered CHECK (end_date IS NULL OR start_date IS NULL OR end_date >= start_date));
  CREATE UNIQUE INDEX uq_ownership_tenures_current ON ownership_tenures (property_id) WHERE kind = 'owner' AND end_date IS NULL;
  CREATE TABLE property_ownerships (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), property_id uuid NOT NULL REFERENCES properties(id), contact_id uuid NOT NULL REFERENCES contacts(id),
    start_date date NOT NULL, end_date date, vesting text, is_primary boolean DEFAULT false, source text, notes text,
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), tenure_id uuid REFERENCES ownership_tenures(id));
  CREATE TRIGGER trg_property_ownerships_updated_at BEFORE UPDATE ON property_ownerships FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();
  CREATE TABLE transaction_upload_batches (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), management_company_id uuid, community_id uuid NOT NULL, status text NOT NULL);
  CREATE TABLE homeowner_transactions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), source_batch_id uuid NOT NULL REFERENCES transaction_upload_batches(id),
    community_id uuid NOT NULL, vantaca_account_id text, property_id uuid, contact_id uuid, transaction_date date NOT NULL, description text NOT NULL,
    txn_type text NOT NULL DEFAULT 'charge', amount_cents bigint NOT NULL, running_balance_cents bigint, charge_category text, created_at timestamptz DEFAULT now(),
    tenure_id uuid REFERENCES ownership_tenures(id));
  CREATE TABLE ar_charges (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), property_id uuid, tenure_id uuid, charge_date date, balance_remaining_cents bigint, description text);
  CREATE TABLE ar_payments (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), property_id uuid, tenure_id uuid, payment_date date, amount_cents bigint, notes text);
  CREATE TABLE home_sales (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), property_id uuid, status text, closing_date date, buyer_contact_id uuid, ownership_proposal_id uuid,
    ownership_updated_at timestamptz, seller_final_balance_cents bigint, updated_at timestamptz);
  CREATE TABLE journal_entries (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), status text NOT NULL DEFAULT 'posted', total_debits_cents bigint NOT NULL DEFAULT 0, total_credits_cents bigint NOT NULL DEFAULT 0);
  CREATE TABLE journal_entry_lines (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), journal_entry_id uuid REFERENCES journal_entries(id), debit_cents bigint, credit_cents bigint);
  CREATE VIEW v_homeowner_current_balance AS
    SELECT t.community_id, t.vantaca_account_id, t.property_id, t.contact_id, SUM(t.amount_cents) AS balance_cents, MAX(t.transaction_date) AS most_recent_txn_date, COUNT(*) AS txn_count
      FROM homeowner_transactions t JOIN transaction_upload_batches b ON b.id = t.source_batch_id WHERE b.status = 'committed'
     GROUP BY t.community_id, t.vantaca_account_id, t.property_id, t.contact_id;
  INSERT INTO communities VALUES ('${WV}', 'Waterview Estates'), ('${LOPF}', 'Lakes of Pine Forest'), ('${CG}', 'Canyon Gate'), ('${EW}', 'Eaglewood'),
                                 ('${QR}', 'Quail Ridge'), ('${SCR}', 'Still Creek Ranch');
  INSERT INTO journal_entries (total_debits_cents, total_credits_cents) VALUES (1000, 1000);`);
const m457 = lf(`${REPO}/migrations/457_current_tenure_reader_views.sql`);
await db.exec(m457.slice(m457.indexOf('CREATE OR REPLACE VIEW v_current_owner_ledger'), m457.indexOf('GRANT SELECT ON v_current_owner_ledger')));

// ---------------------------------------------------------------- the world, from the migration's own list
const rows = [...SQL.matchAll(/^\('([0-9a-f-]{36})', '([0-9a-f-]{36})', '([0-9a-f-]{36})', '(\d{4}-\d{2}-\d{2})', (NULL|'\d{4}-\d{2}-\d{2}'), '([a-z_]+)'/gm)]
  .map((m) => ({ tenure: m[1], property: m[2], community: m[3], prior: m[4], next: m[5] === 'NULL' ? null : m[5].slice(1, -1), reason: m[6] }));
check('the migration lists 2,332 periods (parsed from the file itself)', rows.length === 2332, String(rows.length));
const batch = (await db.query(`INSERT INTO transaction_upload_batches (management_company_id, community_id, status) VALUES ($1, $2, 'committed') RETURNING id`, [MC, WV])).rows[0].id;
const vals = (list, f) => list.map(f).join(',\n');
for (let i = 0; i < rows.length; i += 500) {
  const chunk = rows.slice(i, i + 500);
  await db.exec(`
    INSERT INTO properties (id, community_id, street_address, vantaca_account_id, trusted_account_number) VALUES
      ${vals(chunk, (r, k) => `('${r.property}', '${r.community}', 'Lot ${i + k}', '${r.property === SELLER_LOT ? '10111325' : String(20000000 + i + k)}', 'T${i + k}')`)};
    INSERT INTO ownership_tenures (id, community_id, property_id, kind, start_date, vantaca_account_id, origin) VALUES
      ${vals(chunk, (r, k) => `('${r.tenure}', '${r.community}', '${r.property}', 'owner', '${r.prior}', '${r.property === SELLER_LOT ? '10111325' : String(20000000 + i + k)}', 'backfill_current')`)};
    INSERT INTO contacts (id, full_name) VALUES ${vals(chunk, (r, k) => `(md5('c${r.tenure}')::uuid, 'Owner ${i + k}')`)};
    INSERT INTO property_ownerships (property_id, contact_id, start_date, is_primary, source, tenure_id) VALUES
      ${vals(chunk, (r) => `('${r.property}', md5('c${r.tenure}')::uuid, '${r.prior}', true, 'vantaca_import', '${r.tenure}')`)};`);
}
// Placeholder prior periods ("Current Resident" 5/19-5/26) where the list says so.
for (const r of rows.filter((x) => x.reason === 'placeholder_prior_tenure')) {
  const t = (await db.query(`INSERT INTO ownership_tenures (community_id, property_id, kind, start_date, end_date, origin) VALUES ($1, $2, 'owner', '2026-05-19', '2026-05-26', 'backfill_historical') RETURNING id`, [r.community, r.property])).rows[0].id;
  const c = (await db.query(`INSERT INTO contacts (full_name) VALUES ('Current Resident') RETURNING id`)).rows[0].id;
  await db.query(`INSERT INTO property_ownerships (property_id, contact_id, start_date, end_date, source, tenure_id) VALUES ($1, $2, '2026-05-19', '2026-05-26', 'vantaca_import', $3)`, [r.property, c, t]);
}
// Outside the list: must not move. LOPF + Eaglewood load dates, a Waterview 6/03 date, a Canyon Gate approved transfer, a NULL start.
const outside = [];
async function lot(community, start, origin, source, acct) {
  const p = (await db.query(`INSERT INTO properties (community_id, street_address, vantaca_account_id, trusted_account_number) VALUES ($1, 'Outside', $2, $2) RETURNING id`, [community, acct])).rows[0].id;
  const t = (await db.query(`INSERT INTO ownership_tenures (community_id, property_id, kind, start_date, vantaca_account_id, origin) VALUES ($1, $2, 'owner', $3, $4, $5) RETURNING id`, [community, p, start, acct, origin])).rows[0].id;
  const c = (await db.query(`INSERT INTO contacts (full_name) VALUES ('Outside owner') RETURNING id`)).rows[0].id;
  await db.query(`INSERT INTO property_ownerships (property_id, contact_id, start_date, is_primary, source, tenure_id) VALUES ($1, $2, coalesce($3::date, DATE '2026-05-21'), true, $4, $5)`, [p, c, start, source, t]);
  outside.push(t); return { p, t };
}
await lot(LOPF, '2026-05-19', 'backfill_current', 'vantaca_import', '30000001');
await lot(EW, '2026-05-21', 'backfill_current', 'vantaca_import', '30000002');
await lot(WV, '2026-06-03', 'backfill_current', null, '30000003');
await lot(CG, '2026-07-21', 'transfer', 'ownership_proposal_approval', '30000004');
await lot(QR, null, 'backfill_current', 'vantaca_import', '30000005');
// Ledger: the seller's -$56.37 credit (stamped to its tenure) and a charge on another listed lot.
await db.query(`INSERT INTO homeowner_transactions (source_batch_id, community_id, vantaca_account_id, property_id, transaction_date, description, txn_type, amount_cents, tenure_id)
  VALUES ($1, $2, '10111325', $3, '2026-03-01', 'Prepaid', 'credit', -5637, $4)`, [batch, WV, SELLER_LOT, SELLER_TENURE]);
const other = rows.find((r) => r.reason === 'county_deed_date' && r.community === WV && r.tenure !== SELLER_TENURE);
await db.query(`INSERT INTO homeowner_transactions (source_batch_id, community_id, vantaca_account_id, property_id, transaction_date, description, amount_cents, tenure_id)
  SELECT $1, $2, vantaca_account_id, id, '2026-04-01', 'Assessment', 41500, $4 FROM properties WHERE id = $3`, [batch, WV, other.property, other.tenure]);
await db.query(`INSERT INTO ownership_change_proposals (id, property_id, community_id, proposed_owner_name, vantaca_account_id, status, effective_start_date)
  VALUES ($1, $2, $3, 'Buyer of record', '10116994', 'pending', '2026-05-04')`, [PROPOSAL, SELLER_LOT, WV]);

// The REAL guards and transfer function, sliced verbatim.
const m456 = lf(`${REPO}/migrations/456_ownership_tenures.sql`);
await db.exec(m456.slice(m456.indexOf('CREATE OR REPLACE FUNCTION ownership_tenures_guard()'), m456.indexOf('GRANT SELECT, INSERT, UPDATE ON ownership_tenures')));
const m459 = lf(`${REPO}/migrations/459_ownership_transfer_single_path.sql`);
await db.exec(m459.slice(m459.indexOf('CREATE OR REPLACE FUNCTION ownership_transfer_in_progress()'), m459.indexOf('-- 3) The single transfer path.')).replace(/^-- -+$/m, ''));
const m536 = lf(`${REPO}/migrations/536_conversion_execute_establishment.sql`);
await db.exec(m536.slice(m536.indexOf('CREATE OR REPLACE FUNCTION ownership_tenures_transfer_only()'), m536.indexOf('FOR EACH ROW EXECUTE FUNCTION ownership_tenures_transfer_only();') + 'FOR EACH ROW EXECUTE FUNCTION ownership_tenures_transfer_only();'.length));
const m460 = lf(`${REPO}/migrations/460_same_day_sequential_resale.sql`);
await db.exec(m460.slice(m460.indexOf('CREATE OR REPLACE FUNCTION approve_ownership_proposal('), m460.indexOf('REVOKE ALL ON FUNCTION approve_ownership_proposal')));
await db.exec(`INSERT INTO schema_migrations (filename, sha256) VALUES ('459_ownership_transfer_single_path.sql', 'recorded')`);

const client = { query: async (sql, params) => {
  if (params) { const r = await db.query(sql, params.map((v) => (v && typeof v === 'object' ? JSON.stringify(v) : v))); return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length }; }
  const rs = await db.exec(sql); const last = rs[rs.length - 1] || { rows: [] }; return { rows: last.rows, rowCount: last.affectedRows ?? 0 };
} };
const ctx = { client, user: { id: 'o', email: 'owner@example.test' }, deployedCommit: 'deadbeefcafe', migrationsDir: dir, secret: 'e2e' };
const q = async (sql, params) => (await db.query(sql, params)).rows;
const one = async (sql, params) => (await q(sql, params))[0];
const err = async (sql, params) => { try { await db.query(sql, params); return null; } catch (e) { return e.message; } };
const approve = () => err(`SELECT approve_ownership_proposal(p_proposal_id => $1, p_reviewed_by => 'Ed (test)', p_settlement_date => '2026-05-04')`, [PROPOSAL]);
const snap = async () => ({
  own: (await one(`SELECT md5(string_agg(id::text || contact_id::text || coalesce(end_date::text, '') || coalesce(tenure_id::text, '') || coalesce(source, ''), ',' ORDER BY id)) h FROM property_ownerships`)).h,
  ten: (await one(`SELECT md5(string_agg(id::text || coalesce(property_id::text, '') || coalesce(end_date::text, '') || coalesce(vantaca_account_id, '') || origin, ',' ORDER BY id)) h FROM ownership_tenures`)).h,
  props: (await one(`SELECT md5(string_agg(id::text || coalesce(vantaca_account_id, '') || coalesce(trusted_account_number, ''), ',' ORDER BY id)) h FROM properties`)).h,
  bal: JSON.stringify(await q(`SELECT * FROM v_homeowner_current_balance ORDER BY vantaca_account_id`)),
  outside: JSON.stringify(await q(`SELECT t.id, t.start_date, o.start_date AS o_start, o.updated_at FROM ownership_tenures t JOIN property_ownerships o ON o.tenure_id = t.id WHERE t.id = ANY ($1) ORDER BY t.id`, [outside])),
  hist: JSON.stringify(await q(`SELECT id, start_date, end_date FROM ownership_tenures WHERE origin = 'backfill_historical' ORDER BY id`)),
});

// ---------------------------------------------------------------- BEFORE
const refused = await approve();
check('BEFORE: the 2026-05-04 transfer is refused by the 2026-05-19 roster-load date', /must be after the current owner's start date 2026-05-19/.test(refused || ''), refused);
const before = await snap();

// ---------------------------------------------------------------- APPLY through the tool
{ const req = JSON.parse(lf(`${REPO}/migrations/checks/${F.replace('.sql', '.json')}`)).requires || []; const missing = req.filter((x) => !fs.existsSync(`${REPO}/migrations/${x}`));
  check('every prerequisite named by the 553 checks file is a real migration file', missing.length === 0, JSON.stringify(missing)); }
const plan = await A.planMigration({ ...ctx, filename: F });
if (PRINT) { const rr = await A.applyMigration({ ...ctx, planToken: plan.plan_token, log: { error() {} }, apiCheck: async () => ({ ok: true, count: 0 }) }); console.log(JSON.stringify((rr.detail || {}).objects || rr, null, 2)); console.log(JSON.stringify((rr.detail || {}).row_changes), rr.error || ''); process.exit(0); }
check('plan: ready, every preflight passes', plan.status === 'ready' && plan.preflight.every((p) => p.ok), JSON.stringify({ status: plan.status, reason: plan.reason, pre: plan.preflight }).slice(0, 900));
const r = await A.applyMigration({ ...ctx, planToken: plan.plan_token, log: { error() {} }, apiCheck: async () => ({ ok: true, count: 0 }) });
check('apply: 553 applied and verified through the tool (objects, row changes, protected tables, verify queries)', r.status === 'applied', JSON.stringify({ status: r.status, error: r.error, detail: r.detail }).slice(0, 1500));
if (r.status !== 'applied') { console.log(`\n${pass} passed, ${fail} failed`); process.exit(1); }
const after = await snap();

const c = await one(`SELECT count(*)::int n, count(*) FILTER (WHERE action = 'county_deed_date')::int d, count(*) FILTER (WHERE action = 'cleared_unknown')::int u FROM ownership_start_date_corrections`);
check('2,332 correction records: 1,216 county deed dates, 1,116 cleared', c.n === 2332 && c.d === 1216 && c.u === 1116, JSON.stringify(c));
const wrong = await one(`SELECT count(*)::int n FROM ownership_tenures t JOIN ownership_start_date_corrections c ON c.tenure_id = t.id
  JOIN property_ownerships o ON o.tenure_id = t.id AND o.end_date IS NULL
 WHERE t.start_date IS DISTINCT FROM c.corrected_start_date OR o.start_date IS DISTINCT FROM c.corrected_start_date`);
check('every listed period AND its open ownership carry exactly the corrected date (or NULL)', wrong.n === 0, JSON.stringify(wrong));
const listed = new Map(rows.map((x) => [x.tenure, x.next]));
const got = await q(`SELECT id::text, start_date::text FROM ownership_tenures WHERE id = ANY ($1)`, [rows.map((x) => x.tenure)]);
check('each period got the date the list names, row by row', got.length === 2332 && got.every((g) => (listed.get(g.id) ?? null) === (g.start_date ?? null)));
const seller = await one(`SELECT start_date::text s, start_date_basis b FROM ownership_tenures WHERE id = $1`, [SELLER_TENURE]);
const ev = await one(`SELECT evidence FROM ownership_start_date_corrections WHERE tenure_id = $1`, [SELLER_TENURE]);
check('the seller period starts on the county deed date 2013-10-29, basis county_deed', seller.s === '2013-10-29' && seller.b === 'county_deed', JSON.stringify(seller));
check('its evidence names the roll, CAD reference, instrument, deed date and says it is not a closing date',
  ev.evidence.instrument === '2013137898' && ev.evidence.cad_reference === 'R378810' && ev.evidence.roll === 'preliminary_2026' && ev.evidence.date_type === 'county_deed_date'
  && /not a confirmed closing date/.test(ev.evidence.date_note) && ev.evidence.checked.length === 2 && /^[0-9a-f]{64}$/.test(ev.evidence.checked[0].dbf_sha256), JSON.stringify(ev.evidence).slice(0, 600));
check('no owner, lot, tenure link, end date or source changed on any ownership', after.own === before.own);
check('no tenure lot, end date, account or origin changed', after.ten === before.ten);
check('no property account number (source or trustEd) changed', after.props === before.props);
check('every balance is identical (the seller keeps its -$56.37)', after.bal === before.bal && /-5637/.test(after.bal));
check('nothing outside the list moved (LOPF, Eaglewood, a 6/03 date, an approved transfer, a NULL start)', after.outside === before.outside, after.outside.slice(0, 300));
check('placeholder prior periods are untouched (start and end)', after.hist === before.hist);
check('the tenure immutability guard is enabled again', (await one(`SELECT tgenabled::text e FROM pg_trigger WHERE tgname = 'trg_ownership_tenures_guard'`)).e === 'O');

// ---------------------------------------------------------------- RERUN
const rerun = await db.exec(SQL).then(() => null, (e) => e.message);
const again = await snap();
const c2 = await one(`SELECT count(*)::int n FROM ownership_start_date_corrections`);
check('RERUN: executing the file again succeeds and changes nothing', rerun === null && c2.n === 2332 && JSON.stringify(again) === JSON.stringify(after), rerun || '');

// ---------------------------------------------------------------- GUARDS
check('a correction record cannot be edited', /permanent record/.test(await err(`UPDATE ownership_start_date_corrections SET reason = 'no_county_parcel' WHERE tenure_id = $1`, [SELLER_TENURE]) || ''));
check('a correction record cannot be deleted', /permanent record/.test(await err(`DELETE FROM ownership_start_date_corrections WHERE tenure_id = $1`, [SELLER_TENURE]) || ''));
check('a tenure start date cannot be edited directly again', /immutable/.test(await err(`UPDATE ownership_tenures SET start_date = '2020-01-01' WHERE id = $1`, [SELLER_TENURE]) || ''));
check('an ownership start date can now be unknown', (await err(`UPDATE property_ownerships SET start_date = NULL WHERE tenure_id = $1`, [outside[0]])) === null);
await db.query(`UPDATE property_ownerships SET start_date = '2026-05-19' WHERE tenure_id = $1`, [outside[0]]);

// ---------------------------------------------------------------- AFTER: the real transfer path
const bal0 = await one(`SELECT balance_cents::int b FROM v_homeowner_current_balance WHERE vantaca_account_id = '10111325'`);
const res = await one(`SELECT approve_ownership_proposal(p_proposal_id => $1, p_reviewed_by => 'Ed (test)', p_settlement_date => '2026-05-04') r`, [PROPOSAL]).catch((e) => ({ r: { error: e.message } }));
check('AFTER: approve_ownership_proposal accepts the 2026-05-04 transfer', res.r && res.r.ok === true, JSON.stringify(res.r));
const sel = await one(`SELECT end_date::text e FROM ownership_tenures WHERE id = $1`, [SELLER_TENURE]);
const buyer = await one(`SELECT t.start_date::text s, t.origin, t.vantaca_account_id a FROM ownership_tenures t WHERE t.property_id = $1 AND t.end_date IS NULL`, [SELLER_LOT]);
const led = await one(`SELECT tenure_id::text t FROM homeowner_transactions WHERE vantaca_account_id = '10111325'`);
const bal1 = await one(`SELECT balance_cents::int b FROM v_homeowner_current_balance WHERE vantaca_account_id = '10111325'`);
const buyerRows = await one(`SELECT count(*)::int n FROM v_current_owner_ledger WHERE property_id = $1`, [SELLER_LOT]);
const lotAcct = await one(`SELECT vantaca_account_id a, trusted_account_number tn FROM properties WHERE id = $1`, [SELLER_LOT]);
check('the seller ends 2026-05-03 and the buyer starts 2026-05-04 on a new transfer tenure with the new source account',
  sel.e === '2026-05-03' && buyer.s === '2026-05-04' && buyer.origin === 'transfer' && buyer.a === '10116994', JSON.stringify({ sel, buyer }));
check('the seller keeps its -$56.37 credit on its own tenure; the buyer starts with no ledger rows',
  bal0.b === -5637 && bal1.b === -5637 && led.t === SELLER_TENURE && buyerRows.n === 0, JSON.stringify({ bal0, bal1, led, buyerRows }));
check('the lot’s trustEd account number is unchanged by the transfer', lotAcct.tn === (await one(`SELECT trusted_account_number tn FROM properties WHERE id = $1`, [SELLER_LOT])).tn && lotAcct.a === '10116994');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
