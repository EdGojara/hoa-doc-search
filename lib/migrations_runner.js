// ============================================================================
// migrations_runner.js
// ----------------------------------------------------------------------------
// In-app migration runner. Reads migrations/*.sql files from the deployed
// repo, applies any not yet recorded in schema_migrations, records each
// outcome (filename, sha256, applied_at, applied_by, duration_ms, error).
//
// WHY THIS EXISTS:
//   The Supabase SQL editor on Ed's project refuses to find tables that
//   PostgREST reads constantly (user_profiles, communities, nominations,
//   nomination_cycles — all confirmed empty in editor, live in app). The
//   pattern is consistent enough that every new migration we write piles
//   up unapplied. This runner bypasses the broken editor entirely by
//   connecting via raw pg using the DATABASE_URL the operator pastes
//   from Supabase Dashboard → Project Settings → Database → Connection
//   string.
//
// SECURITY:
//   - Called only from POST /api/admin/apply-migrations (admin role required)
//   - Reads SQL from disk, not from request body — operator can't inject
//     arbitrary DDL via the API
//   - Each migration runs in its own transaction so a failure rolls back
//     cleanly without leaving the database in a half-applied state
//   - schema_migrations bootstrap is idempotent (CREATE TABLE IF NOT EXISTS)
//
// FAILURE MODES:
//   - DATABASE_URL not set: returns clear error telling operator what to set
//   - File hash mismatch (file changed after apply): logged, skipped — we
//     never re-run a migration silently after its content changed
//   - Per-migration SQL error: caught, recorded with error text, continues
//     to next migration (other migrations may be independent)
// ============================================================================

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Client } = require('pg');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

// Bootstrap SQL for the tracking table itself. Runs first on every invocation
// so the runner can take over even when no prior tracking existed.
const BOOTSTRAP_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  filename        TEXT NOT NULL UNIQUE,
  sha256          TEXT NOT NULL,
  applied_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  applied_by      TEXT,
  duration_ms     INTEGER,
  error           TEXT
);
CREATE INDEX IF NOT EXISTS idx_schema_migrations_filename
  ON schema_migrations (filename);
`;

function hashFile(content) {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

function listMigrationFiles() {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];
  return fs.readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort(); // numeric prefix sorts lexicographically — 003, 010, 100 etc.
}

async function applyMigrations({ appliedByEmail, dryRun = false } = {}) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    const err = new Error(
      'DATABASE_URL env var not set. ' +
      'Get it from Supabase Dashboard → Project Settings → Database → ' +
      'Connection string → URI (the postgresql:// URL with password). ' +
      'Add it to Render env vars and redeploy.'
    );
    err.code = 'DATABASE_URL_MISSING';
    throw err;
  }

  const client = new Client({
    connectionString: url,
    // Supabase requires SSL — its default cert is self-signed in some
    // direct-connection scenarios. rejectUnauthorized:false matches
    // the supabase-js library's default posture for direct connections.
    ssl: { rejectUnauthorized: false },
  });

  await client.connect();

  const summary = {
    applied: [],
    skipped: [],
    failed: [],
    bootstrap_ran: false,
    dry_run: dryRun,
  };

  try {
    // 1) Bootstrap the tracking table (idempotent)
    await client.query(BOOTSTRAP_SQL);
    summary.bootstrap_ran = true;

    // 2) Read existing schema_migrations rows
    const existing = await client.query(
      'SELECT filename, sha256 FROM schema_migrations WHERE error IS NULL'
    );
    const appliedByFilename = new Map(
      existing.rows.map((r) => [r.filename, r.sha256])
    );

    // 3) Iterate migration files
    const files = listMigrationFiles();
    for (const filename of files) {
      const fullPath = path.join(MIGRATIONS_DIR, filename);
      const content = fs.readFileSync(fullPath, 'utf8');
      const sha = hashFile(content);

      const priorSha = appliedByFilename.get(filename);
      if (priorSha) {
        if (priorSha === sha) {
          summary.skipped.push({ filename, reason: 'already_applied' });
        } else {
          // File changed after apply — log loudly, do NOT re-run
          summary.skipped.push({
            filename,
            reason: 'hash_mismatch_after_apply',
            prior_sha: priorSha,
            current_sha: sha,
          });
          console.warn(
            `[migrations_runner] hash mismatch on ${filename}: ` +
            `was ${priorSha}, now ${sha} — refusing to re-apply`
          );
        }
        continue;
      }

      if (dryRun) {
        summary.applied.push({ filename, status: 'would_apply', sha256: sha });
        continue;
      }

      // 4) Apply the migration. Each migration runs in its own transaction
      //    so a SQL error rolls back without polluting the database.
      const started = Date.now();
      let migrationError = null;
      try {
        await client.query('BEGIN');
        await client.query(content);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        migrationError = e.message;
        console.error(
          `[migrations_runner] FAILED ${filename}: ${e.message}`
        );
      }
      const duration = Date.now() - started;

      // 5) Record outcome. UPSERT (not plain INSERT) — the table has
      // UNIQUE(filename), and a prior failed attempt would already hold a
      // row with error != NULL. A plain INSERT silently lost that conflict
      // and the runner reported "applied" in memory while the database
      // kept the failed-state row → the next dry-run saw the migration as
      // still pending forever (banner-stuck bug Ed hit 2026-06-13 with 219).
      // ON CONFLICT DO UPDATE makes the latest attempt authoritative, so a
      // successful retry clears the prior failure cleanly.
      try {
        await client.query(
          `INSERT INTO schema_migrations
             (filename, sha256, applied_by, duration_ms, error)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (filename) DO UPDATE SET
             sha256      = EXCLUDED.sha256,
             applied_at  = NOW(),
             applied_by  = EXCLUDED.applied_by,
             duration_ms = EXCLUDED.duration_ms,
             error       = EXCLUDED.error`,
          [filename, sha, appliedByEmail || null, duration, migrationError]
        );
      } catch (recordErr) {
        // If we can't even record the outcome, log and move on
        console.error(
          `[migrations_runner] failed to record outcome for ${filename}: ${recordErr.message}`
        );
      }

      if (migrationError) {
        summary.failed.push({
          filename,
          error: migrationError,
          duration_ms: duration,
        });
      } else {
        summary.applied.push({
          filename,
          duration_ms: duration,
          sha256: sha,
        });
      }
    }
  } finally {
    await client.end();
  }

  return summary;
}

module.exports = { applyMigrations, listMigrationFiles, hashFile };
