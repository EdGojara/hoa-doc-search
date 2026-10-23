// delivery_receipts must be readable and writable by the API (service_role).
// Migration 065 created it with no grant, so every receipt write and the Evidence
// panel read failed with "permission denied" (Ed 2026-10-23). Migration 543 grants
// it. The live check runs against the real database when credentials are present.
try { require('dotenv').config(); } catch (_) {}
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0;
const at = async (name, fn) => { await fn(); passed++; console.log('  ✓', name); };

console.log('delivery_receipts_access:');
(async () => {
  await at('a migration grants service_role SELECT, INSERT, UPDATE on delivery_receipts (no DELETE)', async () => {
    const dir = path.join(__dirname, '..', 'migrations');
    const sql = fs.readdirSync(dir).filter((f) => /^\d{3}_.*\.sql$/.test(f)).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
    assert.match(sql, /GRANT\s+SELECT,\s*INSERT,\s*UPDATE\s+ON\s+public\.delivery_receipts\s+TO\s+service_role/i);
    assert.ok(!/GRANT[^;]*DELETE[^;]*ON\s+public\.delivery_receipts/i.test(sql), 'receipts are an evidence trail: no DELETE');
  });
  if (process.env.SUPABASE_URL && process.env.SUPABASE_KEY) {
    await at('LIVE: the API role can read delivery_receipts (fails until migration 543 is applied)', async () => {
      const { createClient } = require('@supabase/supabase-js');
      const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
      const { error } = await s.from('delivery_receipts').select('id').limit(1);
      assert.ok(!error, 'delivery_receipts read failed: ' + (error && error.message));
    });
  } else {
    console.log('  - live check skipped (no database credentials)');
  }
  console.log(`\ndelivery_receipts_access: ${passed} passed`);
})().catch((e) => { console.error('  ✗', e.message); process.exit(1); });
