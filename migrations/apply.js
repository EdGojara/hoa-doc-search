// ============================================================================
// migrations/apply.js
// ----------------------------------------------------------------------------
// Applies SQL migrations against Supabase Postgres in numeric order.
//
// Usage:
//   node migrations/apply.js                  -> apply all pending
//   node migrations/apply.js --dry-run        -> list files that would run
//   node migrations/apply.js --only 003       -> apply just one file
//
// Requires SUPABASE_DB_URL in .env. Grab it from:
//   Supabase dashboard -> Project Settings -> Database
//   -> "Connection string" -> URI tab
//   It looks like:
//     postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres
//
// Each .sql file is executed as one multi-statement query. The migrations in
// 001/002/003 are idempotent (IF NOT EXISTS, ON CONFLICT, CREATE OR REPLACE)
// so re-running this script is safe.
//
// A `trusted_migrations` table is written/read to surface "already applied"
// status, but is purely informational for v0 — every file runs each time
// because the SQL itself is idempotent.
// ============================================================================

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const MIGRATIONS_DIR = __dirname;
const DRY_RUN = process.argv.includes('--dry-run');
const ONLY_IDX = process.argv.indexOf('--only');
const ONLY_PREFIX = ONLY_IDX !== -1 ? process.argv[ONLY_IDX + 1] : null;

function listMigrationFiles() {
  return fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => /^\d{3}_.+\.sql$/.test(f))
    .sort();   // lexical sort works since prefixes are zero-padded
}

function readFile(name) {
  return fs.readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8');
}

async function ensureMigrationsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS trusted_migrations (
      filename     TEXT PRIMARY KEY,
      applied_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      duration_ms  INTEGER,
      sha          TEXT
    );
  `);
}

async function recordApplied(client, filename, durationMs) {
  await client.query(
    `INSERT INTO trusted_migrations (filename, applied_at, duration_ms)
     VALUES ($1, NOW(), $2)
     ON CONFLICT (filename) DO UPDATE
       SET applied_at = EXCLUDED.applied_at,
           duration_ms = EXCLUDED.duration_ms`,
    [filename, durationMs]
  );
}

async function applied(client) {
  try {
    const r = await client.query(`SELECT filename, applied_at FROM trusted_migrations ORDER BY filename`);
    return r.rows;
  } catch (_e) {
    return [];   // table doesn't exist yet on first run
  }
}

(async function main() {
  const files = listMigrationFiles();
  if (files.length === 0) {
    console.log('No migration files found in', MIGRATIONS_DIR);
    return;
  }

  const filtered = ONLY_PREFIX
    ? files.filter(f => f.startsWith(ONLY_PREFIX))
    : files;

  if (filtered.length === 0) {
    console.error(`No migration files match prefix '${ONLY_PREFIX}'`);
    process.exit(1);
  }

  if (DRY_RUN) {
    console.log('Dry run. Would apply, in order:');
    filtered.forEach(f => console.log('  ' + f));
    return;
  }

  const connectionString = process.env.SUPABASE_DB_URL;
  if (!connectionString) {
    console.error(`
SUPABASE_DB_URL is not set in your environment.

Add it to your .env file. Grab the value from:
  Supabase dashboard -> Project Settings -> Database
  -> "Connection string" -> URI tab

It will look like:
  postgresql://postgres.<project-ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres

Then re-run:  node migrations/apply.js
`);
    process.exit(1);
  }

  const client = new Client({
    connectionString,
    ssl: { rejectUnauthorized: false }   // Supabase pooler requires SSL
  });

  console.log(`Connecting to Supabase Postgres...`);
  await client.connect();

  try {
    await ensureMigrationsTable(client);
    const previously = await applied(client);
    const previouslyMap = new Map(previously.map(r => [r.filename, r.applied_at]));

    if (previously.length > 0) {
      console.log(`\nPreviously applied:`);
      previously.forEach(r => console.log(`  ${r.filename}  (${r.applied_at.toISOString()})`));
      console.log('');
    }

    console.log(`Applying ${filtered.length} migration${filtered.length === 1 ? '' : 's'}:\n`);

    for (const file of filtered) {
      const sql = readFile(file);
      const sizeKb = (sql.length / 1024).toFixed(1);
      const wasApplied = previouslyMap.has(file);
      const tag = wasApplied ? '(re-run, idempotent)' : '(first apply)';
      console.log(`> ${file}  ${sizeKb} KB  ${tag}`);
      const t0 = Date.now();
      try {
        await client.query(sql);
        const dt = Date.now() - t0;
        await recordApplied(client, file, dt);
        console.log(`  ✓ done in ${dt} ms\n`);
      } catch (err) {
        console.error(`  ✗ failed in ${Date.now() - t0} ms`);
        console.error(`  ${err.message}`);
        if (err.position) console.error(`  near position ${err.position}`);
        throw err;
      }
    }

    console.log(`\nAll migrations applied.`);

    // Sanity prints — should match the verification queries in the README.
    const r1 = await client.query(`SELECT name FROM management_companies`);
    console.log(`\nmanagement_companies: ${r1.rows.map(r => r.name).join(', ') || '(none)'}`);

    const r2 = await client.query(`SELECT name, vantaca_code FROM communities ORDER BY name`);
    console.log(`communities:          ${r2.rows.map(r => `${r.name} [${r.vantaca_code}]`).join(', ') || '(none)'}`);

    const r3 = await client.query(`
      SELECT version, escalator_kind, escalator_pct
      FROM contracts
      WHERE community_id = 'a0000000-0000-4000-8000-000000000001'
    `);
    if (r3.rows.length > 0) {
      const c = r3.rows[0];
      console.log(`Waterview contract:   v${c.version}, escalator ${c.escalator_kind} ${c.escalator_pct}%`);
    }

    const r4 = await client.query(`
      SELECT COUNT(*)::int AS n, SUM(monthly_amount)::numeric(12,2) AS total
      FROM contract_fixed_items
      WHERE contract_id = 'b0000000-0000-4000-8000-000000000001'
    `);
    if (r4.rows[0].n > 0) {
      console.log(`Waterview fixed:      ${r4.rows[0].n} items, $${r4.rows[0].total} / month  (expect $6712.00)`);
    }

    const r5 = await client.query(`
      SELECT category, fee_amount FROM contract_owner_charges
      WHERE contract_id = 'b0000000-0000-4000-8000-000000000001'
        AND category IN (
          'assessment_certified_demand_letter',
          'deed_restriction_certified_demand_letter',
          'insufficient_check_charge'
        )
      ORDER BY category
    `);
    if (r5.rows.length > 0) {
      console.log(`\nCorrected leakage rates:`);
      r5.rows.forEach(r => console.log(`  ${r.category.padEnd(45)} $${r.fee_amount}`));
    }

  } finally {
    await client.end();
  }
})().catch(err => {
  console.error(err);
  process.exit(1);
});
