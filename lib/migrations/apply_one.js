// ============================================================================
// lib/migrations/apply_one.js  (Ed 2026-09-27)
// ----------------------------------------------------------------------------
// Applies ONE explicitly approved migration and records it, as one transaction.
// Never bulk; never re-runs an applied file; never marks a failure as applied.
//
//   planMigration()  read-only. Checks the deployed file, its checks file
//                    (migrations/checks/NNN.json), dependencies, tracker state
//                    and preflight; returns what will change plus a short-lived
//                    plan token bound to (file, sha256, checks sha256, deployed
//                    commit, owner). The owner reviews this and clicks
//                    "Approve & Apply"; the token IS the approval.
//   applyMigration() re-verifies everything, then in ONE transaction:
//                    lock -> snapshot -> run the file -> verify objects, row
//                    changes, protected tables, checks -> write schema_migrations
//                    -> NOTIFY pgrst -> COMMIT. Any failure rolls back all of it,
//                    so "applied" and "recorded" can never disagree.
//                    migration_attempts logs every attempt (outside the
//                    transaction) and can never look like an applied migration.
//
// The SQL always comes from the committed file deployed with the app, never
// from a request. Reuses the runner's tracker table (lib/migrations_runner.js).
// ============================================================================
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_DIR = path.join(__dirname, '..', '..', 'migrations');
const PLAN_TTL_MS = 30 * 60 * 1000;
const LOCK_KEY = 4690001;   // pg_advisory_xact_lock key: one migration at a time
const FILE_RE = /^(\d{3})_[a-z0-9_]+\.sql$/;

const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
class Refusal extends Error { constructor(code, message, detail) { super(message); this.code = code; this.detail = detail; } }

// ---------------------------------------------------------------- SQL scanning
// Splits SQL into top-level statements with offsets, skipping comments, string
// literals and dollar-quoted bodies (so BEGIN/COMMIT inside DO blocks and
// function bodies are ignored). Returns [{text, start, end}] where text has
// comments/literals blanked.
function topLevelStatements(sql) {
  const out = []; let i = 0; let start = 0; let buf = '';
  const n = sql.length;
  while (i < n) {
    const c = sql[i], d = sql[i + 1];
    if (c === '-' && d === '-') { while (i < n && sql[i] !== '\n') i++; buf += ' '; continue; }
    if (c === '/' && d === '*') { let depth = 1; i += 2; while (i < n && depth) { if (sql[i] === '/' && sql[i + 1] === '*') { depth++; i += 2; } else if (sql[i] === '*' && sql[i + 1] === '/') { depth--; i += 2; } else i++; } buf += ' '; continue; }
    if (c === "'") { i++; while (i < n) { if (sql[i] === "'" && sql[i + 1] === "'") { i += 2; continue; } if (sql[i] === "'") { i++; break; } i++; } buf += "''"; continue; }
    if (c === '"') { let j = i + 1; while (j < n && sql[j] !== '"') j++; buf += sql.slice(i, j + 1); i = j + 1; continue; }
    if (c === '$') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i, i + 64));
      if (m) { const tag = m[0]; const close = sql.indexOf(tag, i + tag.length); if (close < 0) throw new Refusal('lint', `unterminated dollar quote ${tag}`); buf += ' $body$ '; i = close + tag.length; continue; }
    }
    if (c === ';') { out.push({ text: buf.trim(), start, end: i + 1 }); buf = ''; i++; start = i; continue; }
    buf += c; i++;
  }
  if (buf.trim()) out.push({ text: buf.trim(), start, end: n });
  return out;
}

// The file must be exactly: BEGIN; <body> COMMIT; with no other transaction
// control and nothing that cannot run inside a transaction. Returns the body.
function lintMigration(sql) {
  const st = topLevelStatements(sql).filter((s) => s.text);
  if (st.length < 3) throw new Refusal('lint', 'migration must be BEGIN; ... COMMIT;');
  if (!/^(BEGIN|START\s+TRANSACTION)(\s+(TRANSACTION|WORK))?$/i.test(st[0].text)) throw new Refusal('lint', 'first statement must be BEGIN;');
  if (!/^(COMMIT|END)(\s+(TRANSACTION|WORK))?$/i.test(st[st.length - 1].text)) throw new Refusal('lint', 'last statement must be COMMIT;');
  for (const s of st.slice(1, -1)) {
    if (/^(BEGIN|START\s+TRANSACTION|COMMIT|END|ROLLBACK|ABORT|SAVEPOINT|RELEASE|PREPARE\s+TRANSACTION)\b/i.test(s.text)) throw new Refusal('lint', `transaction control inside the migration: ${s.text.slice(0, 60)}`);
    if (/\bCONCURRENTLY\b/i.test(s.text) || /^(VACUUM|CREATE\s+DATABASE|DROP\s+DATABASE|ALTER\s+SYSTEM|CLUSTER|REINDEX\s+DATABASE)\b/i.test(s.text)) throw new Refusal('lint', `cannot run inside a transaction: ${s.text.slice(0, 60)}`);
  }
  return sql.slice(st[0].end, st[st.length - 1].start);
}

// Checks-file queries: one read-only SELECT each.
const WRITE_WORDS = /\b(INSERT|UPDATE|DELETE|MERGE|ALTER|DROP|CREATE|TRUNCATE|GRANT|REVOKE|COPY|CALL|DO|SET|RESET|NOTIFY|LISTEN|LOCK|VACUUM|COMMENT|SECURITY|REFRESH|nextval|setval|set_config|pg_advisory\w*|pg_terminate_backend|pg_cancel_backend|dblink\w*|lo_\w+)\b/i;
function assertReadOnlySelect(sqlText, where) {
  const st = topLevelStatements(sqlText).filter((s) => s.text);
  if (st.length !== 1) throw new Refusal('checks', `${where}: exactly one statement required`);
  if (!/^(SELECT|WITH)\b/i.test(st[0].text)) throw new Refusal('checks', `${where}: must be a SELECT`);
  if (WRITE_WORDS.test(st[0].text)) throw new Refusal('checks', `${where}: contains a write/unsafe keyword`);
}

// ---------------------------------------------------------------- files
// normalizeLineEndings: only for local build checks on a Windows checkout
// (autocrlf). The server always refuses CRLF: the deployed copy must be the
// committed LF blob byte for byte.
function loadMigration(filename, dir, { normalizeLineEndings = false } = {}) {
  if (!FILE_RE.test(filename || '')) throw new Refusal('bad_filename', 'filename must look like NNN_name.sql');
  const full = path.join(dir, filename);
  if (!fs.existsSync(full)) throw new Refusal('not_deployed', `${filename} is not in the deployed migrations folder`);
  const lf = (t) => (normalizeLineEndings ? t.replace(/\r\n/g, '\n') : t);
  const content = lf(fs.readFileSync(full, 'utf8'));
  if (content.includes('\r')) throw new Refusal('line_endings', `${filename} has CRLF line endings; the deployed copy must match the committed LF blob`);
  const checksPath = path.join(dir, 'checks', filename.replace(/\.sql$/, '.json'));
  if (!fs.existsSync(checksPath)) throw new Refusal('no_checks', `${filename} has no checks file (migrations/checks/${path.basename(checksPath)})`);
  const checksRaw = lf(fs.readFileSync(checksPath, 'utf8'));
  let checks;
  try { checks = JSON.parse(checksRaw); } catch (e) { throw new Refusal('checks', `checks file is not valid JSON: ${e.message}`); }
  validateChecks(checks, filename);
  return { filename, content, sha256: sha256(content), checks, checksSha256: sha256(checksRaw), body: lintMigration(content) };
}

const IDENT = /^[a-z_][a-z0-9_]*$/;
function validateChecks(c, filename) {
  if (c.migration !== filename) throw new Refusal('checks', `checks file names ${c.migration}, not ${filename}`);
  for (const k of ['requires', 'preflight', 'expected_changes', 'protected', 'verify']) if (!Array.isArray(c[k])) throw new Refusal('checks', `checks.${k} must be an array`);
  if (!c.objects || !['added', 'changed', 'removed'].every((k) => Array.isArray(c.objects[k]))) throw new Refusal('checks', 'checks.objects needs added/changed/removed arrays');
  if (!c.row_changes || typeof c.row_changes !== 'object') throw new Refusal('checks', 'checks.row_changes must be an object {table: net delta}');
  for (const [t, v] of Object.entries(c.row_changes)) if (!IDENT.test(t) || !Number.isInteger(v)) throw new Refusal('checks', `row_changes.${t} must be an integer`);
  for (const p of c.protected) if (!IDENT.test(p.table || '') || !IDENT.test(p.order_by || 'id')) throw new Refusal('checks', 'protected entries need {table, order_by}');
  for (const r of c.requires) if (!FILE_RE.test(r)) throw new Refusal('checks', `requires entry ${r} is not a migration filename`);
  c.preflight.forEach((q, i) => { if (!q.name || !('expect' in q)) throw new Refusal('checks', `preflight[${i}] needs name, sql, expect`); assertReadOnlySelect(q.sql, `preflight "${q.name}"`); });
  c.verify.forEach((q, i) => { if (!q.name || !('expect' in q)) throw new Refusal('checks', `verify[${i}] needs name, sql, expect`); assertReadOnlySelect(q.sql, `verify "${q.name}"`); });
  for (const a of c.api_checks || []) if (!IDENT.test(a.table || '') || !Number.isInteger(a.expect_count)) throw new Refusal('checks', 'api_checks entries need {table, expect_count}');
}

// ---------------------------------------------------------------- database helpers
const qi = (id) => '"' + String(id).replace(/"/g, '""') + '"';
async function one(client, sql, params) { const r = await client.query(sql, params); return r.rows[0]; }
async function scalar(client, sql) { const r = await client.query(sql); const row = r.rows[0]; if (!row) return null; return row[Object.keys(row)[0]]; }
const same = (a, b) => JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));
function normalize(v) { if (typeof v === 'bigint') return Number(v); if (typeof v === 'string' && /^-?\d+$/.test(v) && v.length < 16) return Number(v); return v; }

async function tableExists(client, name) { return !!(await one(client, `SELECT 1 AS x FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1`, [name])); }
async function trackerRow(client, filename) {
  if (!(await tableExists(client, 'schema_migrations'))) return null;
  return (await client.query('SELECT filename, sha256, error, applied_at FROM schema_migrations WHERE filename = $1', [filename])).rows[0] || null;
}

// Catalog snapshot of the public schema: key -> definition fingerprint.
const CATALOG_SQL = `
SELECT 'table:' || c.relname AS k, c.relkind::text AS v FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m')
UNION ALL
SELECT 'column:' || c.relname || '.' || a.attname, format_type(a.atttypid, a.atttypmod) || CASE WHEN a.attnotnull THEN ' not null' ELSE '' END || coalesce(' default ' || pg_get_expr(d.adbin, d.adrelid), '')
  FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
 WHERE n.nspname = 'public' AND c.relkind IN ('r','p') AND a.attnum > 0 AND NOT a.attisdropped
UNION ALL
SELECT 'function:' || p.proname, md5(string_agg(pg_get_function_identity_arguments(p.oid) || '|' || pg_get_function_result(p.oid) || '|' || p.prosrc || '|' || p.prosecdef::text || '|' || coalesce(array_to_string(p.proconfig, ','), ''), ';' ORDER BY pg_get_function_identity_arguments(p.oid)))
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND NOT EXISTS (SELECT 1 FROM pg_depend dp WHERE dp.objid = p.oid AND dp.deptype = 'e')
 GROUP BY p.proname
UNION ALL
SELECT 'trigger:' || c.relname || '.' || t.tgname, md5(pg_get_triggerdef(t.oid))
  FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND NOT t.tgisinternal
UNION ALL
SELECT 'index:' || i.relname, md5(pg_get_indexdef(i.oid))
  FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid JOIN pg_namespace n ON n.oid = i.relnamespace
 WHERE n.nspname = 'public'
UNION ALL
SELECT 'constraint:' || c.relname || '.' || k.conname, md5(pg_get_constraintdef(k.oid))
  FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public'
UNION ALL
SELECT 'view:' || c.relname, md5(pg_get_viewdef(c.oid))
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('v','m')`;
async function catalog(client) { const m = new Map(); for (const r of (await client.query(CATALOG_SQL)).rows) m.set(r.k, r.v); return m; }
function diffCatalog(before, after) {
  const added = [], removed = [], changed = [];
  for (const [k, v] of after) { if (!before.has(k)) added.push(k); else if (before.get(k) !== v) changed.push(k); }
  for (const k of before.keys()) if (!after.has(k)) removed.push(k);
  return { added: added.sort(), changed: changed.sort(), removed: removed.sort() };
}
function setDiff(actual, expected) {
  const a = new Set(actual), e = new Set(expected);
  return { unexpected: actual.filter((x) => !e.has(x)), missing: expected.filter((x) => !a.has(x)) };
}

// Protected tables: fingerprint over the columns that existed BEFORE the
// migration (so an added column does not count as a data change).
async function protectedColumns(client, table) {
  return (await client.query(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`, [table])).rows.map((r) => r.column_name);
}
async function fingerprint(client, table, cols, orderBy) {
  if (!cols.length) return { missing: true };
  const row = await one(client, `SELECT count(*)::bigint AS n, md5(coalesce(string_agg(ROW(${cols.map(qi).join(', ')})::text, '|' ORDER BY ${qi(orderBy)}), '')) AS h FROM public.${qi(table)}`);
  return { n: Number(row.n), h: row.h };
}
// Rows written per public table, as this backend's pending counters. On PG15+
// these include not-yet-flushed earlier transactions, so callers take a
// baseline right before the migration and diff (flushes never happen inside
// an open transaction).
async function writeCounters(client) {
  const m = new Map();
  for (const r of (await client.query(`SELECT relname, n_tup_ins + n_tup_upd + n_tup_del AS w, n_tup_ins, n_tup_upd, n_tup_del
    FROM pg_stat_xact_user_tables WHERE schemaname = 'public'`)).rows) m.set(r.relname, { w: Number(r.w), ins: Number(r.n_tup_ins), upd: Number(r.n_tup_upd), del: Number(r.n_tup_del) });
  return m;
}
async function counts(client, tables) {
  const out = {};
  for (const t of tables) out[t] = (await tableExists(client, t)) ? Number(await scalar(client, `SELECT count(*)::bigint AS n FROM public.${qi(t)}`)) : null;
  return out;
}

// ---------------------------------------------------------------- tracker bootstrap
// The tracker is the migration tool's own bookkeeping (the runner already
// creates schema_migrations itself). These additions run only inside an
// approved apply, never on a status check.
const TRACKER_BOOTSTRAP_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), filename text NOT NULL UNIQUE, sha256 text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now(), applied_by text, duration_ms integer, error text);
ALTER TABLE schema_migrations
  ADD COLUMN IF NOT EXISTS commit_sha    text,
  ADD COLUMN IF NOT EXISTS status        text,
  ADD COLUMN IF NOT EXISTS checks_sha256 text,
  ADD COLUMN IF NOT EXISTS applied_via   text,
  ADD COLUMN IF NOT EXISTS verification  jsonb;
CREATE TABLE IF NOT EXISTS migration_attempts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  filename      text NOT NULL,
  sha256        text NOT NULL,
  checks_sha256 text,
  commit_sha    text,
  plan_nonce    text UNIQUE,
  requested_by  text NOT NULL,
  status        text NOT NULL CHECK (status IN ('running', 'applied', 'already_applied', 'failed', 'verify_failed', 'refused', 'abandoned')),
  detail        jsonb,
  error         text,
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz
);
COMMENT ON TABLE migration_attempts IS 'workpaper: one row per single-migration apply attempt (lib/migrations/apply_one.js). Append-only; a row here never means applied; schema_migrations does.';
CREATE OR REPLACE FUNCTION migration_attempts_append_only() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'migration attempts are permanent'; END IF;
  IF OLD.status <> 'running' THEN RAISE EXCEPTION 'a finished migration attempt cannot be changed'; END IF;
  IF NEW.filename <> OLD.filename OR NEW.sha256 <> OLD.sha256 OR NEW.plan_nonce IS DISTINCT FROM OLD.plan_nonce OR NEW.requested_by <> OLD.requested_by THEN
    RAISE EXCEPTION 'attempt identity cannot change';
  END IF;
  RETURN NEW;
END $fn$;
DROP TRIGGER IF EXISTS trg_migration_attempts_append_only ON migration_attempts;
CREATE TRIGGER trg_migration_attempts_append_only BEFORE UPDATE OR DELETE ON migration_attempts
  FOR EACH ROW EXECUTE FUNCTION migration_attempts_append_only();
ALTER TABLE migration_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON migration_attempts FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN EXECUTE 'REVOKE ALL ON migration_attempts FROM anon, authenticated'; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN EXECUTE 'GRANT SELECT, INSERT, UPDATE ON migration_attempts TO service_role'; END IF;
END $$;`;
async function trackerBootstrapNeeded(client) {
  const need = [];
  if (!(await tableExists(client, 'schema_migrations'))) need.push('create schema_migrations');
  else {
    const cols = new Set(await protectedColumns(client, 'schema_migrations'));
    const add = ['commit_sha', 'status', 'checks_sha256', 'applied_via', 'verification'].filter((c) => !cols.has(c));
    if (add.length) need.push(`add schema_migrations columns: ${add.join(', ')}`);
  }
  if (!(await tableExists(client, 'migration_attempts'))) need.push('create migration_attempts (append-only attempt log, service role only)');
  return need;
}

// ---------------------------------------------------------------- plan tokens
function planKey(secret) {
  const s = secret || process.env.MIGRATION_PLAN_SECRET || (process.env.DATABASE_URL ? 'derived:' + sha256('trusted-migration-plan:' + process.env.DATABASE_URL) : null);
  if (!s) throw new Refusal('no_secret', 'no plan-signing secret available on the server');
  return s;
}
function signPlan(payload, secret) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return body + '.' + crypto.createHmac('sha256', planKey(secret)).update(body).digest('base64url');
}
function verifyPlan(token, secret, now = Date.now()) {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig) throw new Refusal('bad_plan', 'plan token missing or malformed');
  const want = crypto.createHmac('sha256', planKey(secret)).update(body).digest('base64url');
  if (sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) throw new Refusal('bad_plan', 'plan token signature is invalid');
  const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  if (!(p.exp > now)) throw new Refusal('plan_expired', 'the plan expired; review the migration again');
  return p;
}

// ---------------------------------------------------------------- plan
async function planMigration({ client, filename, user, deployedCommit, migrationsDir = DEFAULT_DIR, secret, now = Date.now() }) {
  if (!user || !user.id) throw new Refusal('no_user', 'an authenticated owner is required');
  if (!deployedCommit || deployedCommit === 'unknown') throw new Refusal('no_commit', 'the deployed commit is unknown; refusing');
  const m = loadMigration(filename, migrationsDir);
  const base = { filename, sha256: m.sha256, checks_sha256: m.checksSha256, deployed_commit: deployedCommit, summary: m.checks.summary || null,
    expected_changes: m.checks.expected_changes, objects: m.checks.objects, row_changes: m.checks.row_changes,
    protected: m.checks.protected.map((p) => p.table), requires: m.checks.requires };

  const tr = await trackerRow(client, filename);
  if (tr && !tr.error) {
    if (tr.sha256 === m.sha256) return { ...base, status: 'already_applied', applied_at: tr.applied_at };
    return { ...base, status: 'blocked', reason: `recorded with a DIFFERENT hash (${tr.sha256.slice(0, 12)}); the file changed after it was applied. Review required.` };
  }

  const missing = [];
  for (const r of m.checks.requires) { const row = await trackerRow(client, r); if (!row || row.error) missing.push(r); }
  if (missing.length) return { ...base, status: 'blocked', reason: `required migrations not recorded as applied: ${missing.join(', ')}` };

  const preflight = [];
  await client.query('BEGIN READ ONLY');
  try {
    for (const q of m.checks.preflight) {
      let got, error = null;
      try { got = normalize(await scalar(client, q.sql)); } catch (e) { error = e.message; }
      preflight.push({ name: q.name, expect: q.expect, got, ok: !error && same(got, q.expect), error });
      if (error) break;   // an error aborts the read-only transaction
    }
  } finally { await client.query('ROLLBACK'); }
  const conn = await one(client, `SELECT inet_server_port() AS port, current_user AS db_user, current_setting('server_version') AS version`);
  const bootstrap = await trackerBootstrapNeeded(client);
  const failed = preflight.filter((p) => !p.ok);
  const plan = { ...base, preflight, connection: { port: conn.port, pooled: String(conn.port) === '6543', user: conn.db_user, version: conn.version },
    tracker_bootstrap: bootstrap, prior_failed_record: tr && tr.error ? tr.error.slice(0, 200) : null };
  if (failed.length) return { ...plan, status: 'blocked', reason: `preflight failed: ${failed.map((f) => f.name).join('; ')}` };
  const token = signPlan({ f: filename, s: m.sha256, c: m.checksSha256, commit: deployedCommit, u: user.id, exp: now + PLAN_TTL_MS, n: crypto.randomBytes(12).toString('base64url') }, secret);
  return { ...plan, status: 'ready', plan_token: token, expires_at: new Date(now + PLAN_TTL_MS).toISOString() };
}

// ---------------------------------------------------------------- apply
async function applyMigration({ client, planToken, user, deployedCommit, migrationsDir = DEFAULT_DIR, secret, onAttempt, apiCheck, log = console, now = Date.now() }) {
  const p = verifyPlan(planToken, secret, now);
  if (!user || user.id !== p.u) throw new Refusal('wrong_user', 'this plan was prepared for a different user');
  if (deployedCommit !== p.commit) throw new Refusal('commit_changed', `the deployed commit changed since review (${String(p.commit).slice(0, 7)} -> ${String(deployedCommit).slice(0, 7)}); review again`);
  const m = loadMigration(p.f, migrationsDir);
  if (m.sha256 !== p.s) throw new Refusal('hash_changed', 'the deployed migration file no longer matches the reviewed hash');
  if (m.checksSha256 !== p.c) throw new Refusal('checks_changed', 'the checks file no longer matches the reviewed version');
  const replan = await planMigration({ client, filename: p.f, user, deployedCommit, migrationsDir, secret, now });
  if (replan.status === 'already_applied') return { status: 'already_applied', filename: p.f, applied_at: replan.applied_at };
  if (replan.status !== 'ready') throw new Refusal('not_ready', replan.reason || `migration is ${replan.status}`, replan);

  await client.query('BEGIN');
  try { await client.query(TRACKER_BOOTSTRAP_SQL); await client.query('COMMIT'); } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }

  let attemptId;
  try {
    attemptId = (await one(client, `INSERT INTO migration_attempts (filename, sha256, checks_sha256, commit_sha, plan_nonce, requested_by, status)
      VALUES ($1, $2, $3, $4, $5, $6, 'running') RETURNING id`, [p.f, p.s, p.c, p.commit, p.n, user.email || user.id])).id;
  } catch (e) {
    if (/plan_nonce|duplicate key/i.test(e.message)) throw new Refusal('plan_used', 'this approval was already used; review again');
    throw e;
  }
  if (onAttempt) onAttempt(attemptId);

  const started = Date.now(); const c = m.checks; const detail = {};
  const finish = async (status, error) => {
    try { await client.query(`UPDATE migration_attempts SET status = $2, detail = $3, error = $4, finished_at = now() WHERE id = $1`, [attemptId, status, detail, error || null]); }
    catch (e) { log.error('[apply_one] could not finish attempt log:', e.message); }
  };
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL lock_timeout = '5s'`);
    await client.query(`SET LOCAL statement_timeout = '10min'`);
    await client.query(`SELECT pg_advisory_xact_lock(${LOCK_KEY})`);
    const tr = (await client.query('SELECT sha256, error FROM schema_migrations WHERE filename = $1 FOR UPDATE', [p.f])).rows[0];
    if (tr && !tr.error) throw new Refusal(tr.sha256 === p.s ? 'already_applied' : 'blocked', tr.sha256 === p.s ? 'applied by a concurrent attempt' : 'recorded with a different hash');

    const catBefore = await catalog(client);
    const rowTables = Object.keys(c.row_changes);
    const countsBefore = await counts(client, rowTables);
    const prot = [];
    for (const t of c.protected) { const cols = await protectedColumns(client, t.table); prot.push({ ...t, cols, before: await fingerprint(client, t.table, cols, t.order_by || 'id') }); }
    const writesBefore = await writeCounters(client);

    await client.query(m.body);

    const problems = [];
    const diff = diffCatalog(catBefore, await catalog(client));
    for (const k of ['added', 'changed', 'removed']) {
      const d = setDiff(diff[k], c.objects[k]);
      if (d.unexpected.length) problems.push(`unexpected ${k} objects: ${d.unexpected.join(', ')}`);
      if (d.missing.length) problems.push(`expected ${k} objects not seen: ${d.missing.join(', ')}`);
    }
    detail.objects = diff;
    const countsAfter = await counts(client, rowTables);
    detail.row_changes = {};
    for (const t of rowTables) {
      const delta = (countsAfter[t] ?? 0) - (countsBefore[t] ?? 0);
      detail.row_changes[t] = delta;
      if (delta !== c.row_changes[t]) problems.push(`${t}: expected net ${c.row_changes[t]} rows, got ${delta}`);
    }
    const writesAfter = await writeCounters(client);
    const writes = [];
    for (const [t, a] of writesAfter) {
      const b = writesBefore.get(t) || { w: 0, ins: 0, upd: 0, del: 0 };
      if (a.w > b.w) writes.push({ table: t, ins: a.ins - b.ins, upd: a.upd - b.upd, del: a.del - b.del });
    }
    writes.sort((x, y) => x.table.localeCompare(y.table));
    detail.tables_written = writes;
    const undeclared = writes.filter((r) => !(r.table in c.row_changes)).map((r) => r.table);
    if (undeclared.length) problems.push(`rows written in undeclared tables: ${undeclared.join(', ')}`);
    detail.protected = [];
    for (const t of prot) {
      const after = await fingerprint(client, t.table, t.cols, t.order_by || 'id');
      const ok = !t.before.missing && after.n === t.before.n && after.h === t.before.h;
      detail.protected.push({ table: t.table, rows: after.n, unchanged: ok });
      if (!ok) problems.push(`protected table ${t.table} changed`);
    }
    detail.verify = [];
    for (const q of c.verify) {
      const got = normalize(await scalar(client, q.sql));
      const ok = same(got, q.expect);
      detail.verify.push({ name: q.name, expect: q.expect, got, ok });
      if (!ok) problems.push(`verify "${q.name}": expected ${JSON.stringify(q.expect)}, got ${JSON.stringify(got)}`);
    }
    if (problems.length) { const e = new Refusal('verify_failed', problems.join(' | ')); e.problems = problems; throw e; }

    const rec = await client.query(`INSERT INTO schema_migrations (filename, sha256, applied_at, applied_by, duration_ms, error, commit_sha, status, checks_sha256, applied_via, verification)
      VALUES ($1, $2, now(), $3, $4, NULL, $5, 'applied', $6, 'owner_single_apply', $7)
      ON CONFLICT (filename) DO UPDATE SET sha256 = EXCLUDED.sha256, applied_at = EXCLUDED.applied_at, applied_by = EXCLUDED.applied_by,
        duration_ms = EXCLUDED.duration_ms, error = NULL, commit_sha = EXCLUDED.commit_sha, status = EXCLUDED.status,
        checks_sha256 = EXCLUDED.checks_sha256, applied_via = EXCLUDED.applied_via, verification = EXCLUDED.verification
      WHERE schema_migrations.error IS NOT NULL`,
      [p.f, p.s, user.email || user.id, Date.now() - started, p.commit, p.c, detail]);
    if (rec.rowCount !== 1) throw new Refusal('record_conflict', 'schema_migrations already holds a clean row for this file');
    if (c.reload_schema !== false) await client.query(`NOTIFY pgrst, 'reload schema'`);   // delivered only on COMMIT
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    detail.error_code = e.code || null;
    if (e.code === 'already_applied') { await finish('already_applied', e.message); return { status: 'already_applied', filename: p.f, attempt_id: attemptId }; }
    await finish(e.code === 'verify_failed' ? 'verify_failed' : 'failed', e.message);
    return { status: e.code === 'verify_failed' ? 'verify_failed' : 'failed', filename: p.f, attempt_id: attemptId, error: e.message, detail };
  }

  detail.duration_ms = Date.now() - started;
  detail.api_checks = [];
  for (const a of c.api_checks || []) {
    let res = null;
    try { res = apiCheck ? await apiCheck(a) : { skipped: true }; } catch (e) { res = { ok: false, error: e.message }; }
    detail.api_checks.push({ table: a.table, expect_count: a.expect_count, ...res });
  }
  await finish('applied', null);
  const warnings = detail.api_checks.filter((x) => x.ok === false).map((x) => `API check ${x.table}: ${x.error || `got ${x.count}`}`);
  return { status: 'applied', filename: p.f, sha256: p.s, commit_sha: p.commit, attempt_id: attemptId, detail, warnings };
}

// ---------------------------------------------------------------- attempt status
async function getAttempt(client, id, { staleMs = 20 * 60 * 1000 } = {}) {
  if (!(await tableExists(client, 'migration_attempts'))) return null;
  const a = (await client.query('SELECT * FROM migration_attempts WHERE id = $1', [id])).rows[0];
  if (!a) return null;
  if (a.status === 'running' && Date.now() - new Date(a.started_at).getTime() > staleMs) {
    const tr = await trackerRow(client, a.filename);
    a.reconciled = tr && !tr.error && tr.sha256 === a.sha256 ? 'applied (the tracker holds it)' : 'abandoned (the transaction rolled back; nothing was applied)';
  }
  return a;
}

module.exports = { planMigration, applyMigration, getAttempt, lintMigration, topLevelStatements, loadMigration, validateChecks, Refusal,
  _internal: { catalog, diffCatalog, signPlan, verifyPlan, TRACKER_BOOTSTRAP_SQL, sha256 } };
