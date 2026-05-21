#!/usr/bin/env node
// =============================================================================
// generate_address_correction_sql.js
// -----------------------------------------------------------------------------
// Reads the JSONL output from analyze_vantaca_addresses.js and generates a
// SQL script that corrects properties.street_address + populates
// contacts.mailing_address + inserts property_residencies inference rows.
//
// Designed to be SAFE to run:
//   - All work inside one BEGIN/COMMIT transaction — if anything errors, full rollback
//   - Uses a temp table for the correction data so we can see what's loaded
//   - The UPDATE matches by vantaca_account_id — only properties already
//     synced with Vantaca get updated. Properties that have NULL
//     vantaca_account_id are reported but not touched (need separate handling).
//   - Includes pre-flight + post-flight verification queries
//
// Usage:
//   node scripts/analyze_vantaca_addresses.js \
//     "<waterview-xlsx>" "<eaglewood-xlsx>" > /tmp/vantaca-analysis.jsonl
//   node scripts/generate_address_correction_sql.js < /tmp/vantaca-analysis.jsonl > /tmp/corrections.sql
//
// Then paste /tmp/corrections.sql into Supabase SQL editor.
// =============================================================================

const readline = require('readline');

// Map Vantaca Assoc Code → community name fragment for lookup
const ASSOC_TO_COMMUNITY = {
  101: 'waterview',
  102: 'lakes-of-pine-forest',  // best guess — verify
  103: 'canyon-gate',
  104: 'eagle%wood',
  105: 'quail-ridge',
  106: 'still-creek-ranch',
  107: 'august-meadows',
};

function sqlString(s) {
  if (s === null || s === undefined) return 'NULL';
  return "'" + String(s).replace(/'/g, "''") + "'";
}

async function main() {
  const accounts = [];
  const rl = readline.createInterface({ input: process.stdin });
  for await (const line of rl) {
    const t = line.trim();
    if (!t || !t.startsWith('{')) continue;
    try { accounts.push(JSON.parse(t)); }
    catch (e) { console.error('skip bad json:', e.message); }
  }

  console.error(`Loaded ${accounts.length} account analyses from JSONL`);

  const out = [];
  out.push(`-- =============================================================================`);
  out.push(`-- Vantaca address corrections`);
  out.push(`-- Generated: ${new Date().toISOString()}`);
  out.push(`-- Accounts: ${accounts.length}`);
  out.push(`-- =============================================================================`);
  out.push('');
  out.push(`BEGIN;`);
  out.push('');

  // -------------------------------------------------------------------------
  // 1) Temp table holding all corrections
  // -------------------------------------------------------------------------
  out.push(`-- 1. Create temp table holding the corrected (property, mailing, owner) tuples`);
  out.push(`CREATE TEMP TABLE IF NOT EXISTS vantaca_corrections (`);
  out.push(`  assoc_code         INT,`);
  out.push(`  vantaca_account_id TEXT,`);
  out.push(`  property_street    TEXT,`);
  out.push(`  property_unit      TEXT,`);
  out.push(`  property_city      TEXT,`);
  out.push(`  property_state     TEXT,`);
  out.push(`  property_zip       TEXT,`);
  out.push(`  mailing_street     TEXT,`);
  out.push(`  mailing_city       TEXT,`);
  out.push(`  mailing_state      TEXT,`);
  out.push(`  mailing_zip        TEXT,`);
  out.push(`  owner_full_name    TEXT,`);
  out.push(`  homeowner_id       TEXT,`);
  out.push(`  residency_type     TEXT,`);
  out.push(`  confidence         TEXT,`);
  out.push(`  notes              TEXT`);
  out.push(`);`);
  out.push('');
  out.push(`TRUNCATE vantaca_corrections;`);
  out.push('');
  out.push(`-- 2. Load corrections — one row per Vantaca Account`);

  let inserted = 0;
  for (const a of accounts) {
    if (!a.property) continue;
    const p = a.property;
    const m = a.mailing || p;
    const owner = a.owners?.[0] || {};
    out.push(
      `INSERT INTO vantaca_corrections VALUES (` +
      [
        a.assoc_code ?? 'NULL',
        sqlString(a.account),
        sqlString(p.street),
        sqlString(p.unit),
        sqlString(p.city),
        sqlString(p.state),
        sqlString(p.zip),
        sqlString(m.street),
        sqlString(m.city),
        sqlString(m.state),
        sqlString(m.zip),
        sqlString(owner.full_name),
        sqlString(owner.homeowner_id),
        sqlString(a.residencyType),
        sqlString(a.confidence),
        sqlString(a.notes),
      ].join(', ') +
      `);`
    );
    inserted++;
  }
  out.push('');
  out.push(`-- Inserted ${inserted} correction rows`);
  out.push('');

  // -------------------------------------------------------------------------
  // 3) Pre-flight: how many properties in our DB match by vantaca_account_id?
  // -------------------------------------------------------------------------
  out.push(`-- 3. Pre-flight: count properties that will match by vantaca_account_id`);
  out.push(`-- (Run these SELECTs to see what would change; comment out if not needed)`);
  out.push(`/*`);
  out.push(`SELECT`);
  out.push(`  c.assoc_code,`);
  out.push(`  COUNT(*) AS corrections_for_assoc,`);
  out.push(`  COUNT(p.id) AS matched_in_db,`);
  out.push(`  COUNT(*) - COUNT(p.id) AS unmatched`);
  out.push(`FROM vantaca_corrections c`);
  out.push(`LEFT JOIN properties p ON p.vantaca_account_id = c.vantaca_account_id`);
  out.push(`GROUP BY c.assoc_code;`);
  out.push(`*/`);
  out.push('');

  // -------------------------------------------------------------------------
  // 4) Apply property address corrections
  // -------------------------------------------------------------------------
  out.push(`-- 4. Update property addresses where current address differs from Vantaca property address`);
  out.push(`-- Triggers will automatically rebuild normalized_address + normalized_unit`);
  out.push(`UPDATE properties p SET`);
  out.push(`  street_address = c.property_street,`);
  out.push(`  unit           = NULLIF(c.property_unit, ''),`);
  out.push(`  city           = COALESCE(c.property_city, p.city),`);
  out.push(`  state          = COALESCE(c.property_state, p.state),`);
  out.push(`  zip            = COALESCE(c.property_zip, p.zip),`);
  out.push(`  updated_at     = NOW()`);
  out.push(`FROM vantaca_corrections c`);
  out.push(`WHERE p.vantaca_account_id = c.vantaca_account_id`);
  out.push(`  AND (`);
  out.push(`    LOWER(TRIM(p.street_address)) IS DISTINCT FROM LOWER(TRIM(c.property_street))`);
  out.push(`    OR p.zip IS DISTINCT FROM c.property_zip`);
  out.push(`    OR p.city IS DISTINCT FROM c.property_city`);
  out.push(`  );`);
  out.push('');

  // -------------------------------------------------------------------------
  // 5) Update contacts.mailing_address for owners with off-site mailing
  // -------------------------------------------------------------------------
  out.push(`-- 5. Populate contacts.mailing_address from the corrected mailing data`);
  out.push(`-- Only updates contacts that are current owners of the matched property`);
  out.push(`UPDATE contacts ct SET`);
  out.push(`  mailing_address = c.mailing_street || ', ' || c.mailing_city || ', ' || c.mailing_state || ' ' || c.mailing_zip,`);
  out.push(`  updated_at = NOW()`);
  out.push(`FROM vantaca_corrections c`);
  out.push(`JOIN properties p ON p.vantaca_account_id = c.vantaca_account_id`);
  out.push(`JOIN property_ownerships o ON o.property_id = p.id AND o.end_date IS NULL`);
  out.push(`WHERE ct.id = o.contact_id`);
  out.push(`  AND c.mailing_street IS NOT NULL`);
  out.push(`  AND c.mailing_street != c.property_street;`);
  out.push('');

  // -------------------------------------------------------------------------
  // 6) Insert inferred residency rows
  // -------------------------------------------------------------------------
  out.push(`-- 6. Insert inferred residency rows for renter / off-site-owner cases`);
  out.push(`-- Existing residencies (non-end-dated) are preserved if they exist`);
  out.push(`INSERT INTO property_residencies (property_id, residency_type, start_date, source, notes)`);
  out.push(`SELECT`);
  out.push(`  p.id,`);
  out.push(`  CASE`);
  out.push(`    WHEN c.residency_type = 'renter' THEN 'renter'`);
  out.push(`    WHEN c.residency_type = 'unknown_off_site' THEN 'unknown'`);
  out.push(`    ELSE 'owner_occupied'`);
  out.push(`  END,`);
  out.push(`  CURRENT_DATE,`);
  out.push(`  'vantaca_inference_2026_05_21',`);
  out.push(`  'Inferred from Vantaca All Addresses (Current Resident) Export. property.zip=' || c.property_zip || ', mailing.zip=' || COALESCE(c.mailing_zip, 'none')`);
  out.push(`FROM vantaca_corrections c`);
  out.push(`JOIN properties p ON p.vantaca_account_id = c.vantaca_account_id`);
  out.push(`WHERE NOT EXISTS (`);
  out.push(`  SELECT 1 FROM property_residencies r`);
  out.push(`  WHERE r.property_id = p.id AND r.end_date IS NULL`);
  out.push(`);`);
  out.push('');

  // -------------------------------------------------------------------------
  // 7) Verification queries (commented out — uncomment to run)
  // -------------------------------------------------------------------------
  out.push(`-- 7. Verification — uncomment to see results before COMMIT`);
  out.push(`/*`);
  out.push(`-- Properties changed:`);
  out.push(`SELECT count(*) AS properties_updated FROM properties WHERE updated_at > NOW() - INTERVAL '5 minutes';`);
  out.push(`-- Inferred renters per community:`);
  out.push(`SELECT cm.name, r.residency_type, count(*)`);
  out.push(`FROM property_residencies r`);
  out.push(`JOIN properties p ON p.id = r.property_id`);
  out.push(`JOIN communities cm ON cm.id = p.community_id`);
  out.push(`WHERE r.source = 'vantaca_inference_2026_05_21'`);
  out.push(`GROUP BY cm.name, r.residency_type`);
  out.push(`ORDER BY cm.name, r.residency_type;`);
  out.push(`-- Sample 10 corrected properties (check a few visually):`);
  out.push(`SELECT p.vantaca_account_id, p.street_address, p.city, p.zip,`);
  out.push(`       c.full_name, c.mailing_address`);
  out.push(`FROM properties p`);
  out.push(`LEFT JOIN property_ownerships o ON o.property_id = p.id AND o.end_date IS NULL`);
  out.push(`LEFT JOIN contacts c ON c.id = o.contact_id`);
  out.push(`WHERE p.vantaca_account_id IN ('10110088', '10110124', '10110100', '10110090')`);
  out.push(`ORDER BY p.vantaca_account_id;`);
  out.push(`*/`);
  out.push('');

  out.push(`COMMIT;`);
  out.push('');
  out.push(`-- ============================================================================`);
  out.push(`-- After running this, run the dedup again — it will now operate on correct`);
  out.push(`-- property addresses and only catch TRUE duplicates (multiple Vantaca`);
  out.push(`-- accounts pointing at the same physical home, like Garcia's case).`);
  out.push(`--`);
  out.push(`--   SELECT * FROM dedup_community_properties(NULL, TRUE);  -- preview`);
  out.push(`--   SELECT * FROM dedup_community_properties(NULL, FALSE); -- apply`);
  out.push(`--   CREATE UNIQUE INDEX uniq_properties_normalized`);
  out.push(`--     ON properties (community_id, normalized_address, normalized_unit);`);
  out.push(`-- ============================================================================`);

  process.stdout.write(out.join('\n') + '\n');
  console.error(`Wrote ${out.length} lines of SQL covering ${inserted} accounts`);
}

main().catch((e) => { console.error(e); process.exit(1); });
