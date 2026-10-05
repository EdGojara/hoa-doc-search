// tests/onboarding_cg_normalize_local.js  (Issue #15, 2026-10-05) — LOCAL ONLY.
// Re-runs the normalize stage on the REAL stored artifacts of two onboarding batches,
// read-only, and proves the AP-aging and GL fixes on them without committing any real
// file, path or figure (the repo is public):
//   - the fund-column batch (Canyon Gate): AP reads every open item (with and without
//     "Inv #"), GL keeps an 8-digit account separate, and the two AR-aging controls that
//     reflect an inconsistency INSIDE the Vantaca report still FAIL (no forced tie);
//   - Quail Ridge: every parser's output is byte-for-byte what it was before this change
//     (pinned as hashes; no figures).
// Batch codes come from the uncommitted local config ($ONBOARDING_LOCAL_CONFIG, default
// ~/.trusted-onboarding/local.json): { "stored_batches": { "cg": "<code>", "qr": "<code>" } }.
// Files are downloaded through the engine's read-only client (writes refused) and each is
// checked against its recorded sha256. SKIPs without the config or database credentials.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert');
try { require('dotenv').config({ quiet: true }); } catch (_) { /* optional */ }
const CONFIG_PATH = process.env.ONBOARDING_LOCAL_CONFIG || path.join(os.homedir(), '.trusted-onboarding', 'local.json');
let cfg = {};
if (fs.existsSync(CONFIG_PATH)) { try { cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch (e) { console.log(`FAIL  local onboarding config is not valid JSON: ${e.message}`); process.exit(1); } }
const batches = cfg.stored_batches || {};
if (!batches.cg && !batches.qr) { console.log('SKIP  stored-batch normalize proof (no stored_batches in the local config)'); process.exit(0); }
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) { console.log('SKIP  stored-batch normalize proof (no database credentials)'); process.exit(0); }
const { createClient } = require('@supabase/supabase-js');
const { readOnlyClient } = require('../lib/onboarding/write_gate');
const E = require('../lib/onboarding/engine');
const R = readOnlyClient(createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, { auth: { persistSession: false } }));
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
// Quail Ridge parse output per artifact type under the pre-change parser (origin/main 4f531484).
const QR_PINNED = {
  gl_trial_balance: '6b6b556958abdfaf236f80a31ea3eefd21311b9b0a523cbe48fce4b21bd6f07e',
  balance_sheet: '42437ba858d0689fc5f49e94914272d3183ae1e4cedfc99707253f7520f05bd3',
  ar_aging: '148f41dbdbf3a365eb326959477307758a271bf94abe42aa08eac719684754ca',
  homeowner_transactions: '361f22d437c7510f6a92d1090c5af2808527a9ca09bbcc1db1d2f91feab5e09d',
  prepaid_homeowners: 'b6c8e49efff099dbf64234717b2987a15a072050382047394471e60bcf0f7bc2',
  ap_aging: 'f8b9d4937d27413fa0f972ddbd724d47fb46bfe1f3c8a7ff9505d403d6625368',
};
let pass = 0, fail = 0;
const check = async (n, fn) => { try { await fn(); pass++; console.log('  PASS  ' + n); } catch (e) { fail++; console.log('  FAIL  ' + n + '\n        ' + e.message); } };

async function normalizeStored(code) {
  const { data: b, error: e1 } = await R.from('conversion_batches').select('id').eq('batch_code', code);
  if (e1) throw new Error(e1.message); if (!b || b.length !== 1) throw new Error(`batch ${code} not found`);
  const { data: arts, error: e2 } = await R.from('onboarding_artifacts').select('artifact_type, filename, sha256, bytes, storage_path').eq('batch_id', b[0].id);
  if (e2) throw new Error(e2.message);
  const inputs = [];
  for (const a of arts.filter((x) => x.artifact_type !== 'original_pdf')) {
    const { data, error } = await R.storage.from('documents').download(a.storage_path);
    if (error) throw new Error(`${a.artifact_type}: ${error.message}`);
    const buf = Buffer.from(await data.arrayBuffer());
    assert.strictEqual(sha(buf), a.sha256, `${a.artifact_type} bytes must be the recorded bytes`);
    inputs.push({ artifact: { artifact_type: a.artifact_type, sha256: a.sha256, bytes: a.bytes }, buffer: buf });
  }
  return E.normalize('vantaca', inputs);
}

(async () => {
  if (batches.cg) {
    const n = await normalizeStored(batches.cg);
    const st = (code) => (n.extraction.find((c) => c.code === code) || {}).status;
    const ap = n.parsed.ap_aging; const gl = n.parsed.gl_trial_balance;
    await check('fund-column batch: AP aging reads every open item, with and without "Inv #", and ties to its printed Total', () => {
      assert.deepStrictEqual(ap.defects, []);
      assert.ok(ap.rows.some((r) => r.invoice_number === null), 'at least one item without an invoice number');
      assert.ok(ap.rows.some((r) => r.provenance.locator.line === r.provenance.locator.amount_line), 'at least one same-line item');
      assert.ok(ap.rows.some((r) => r.invoice_number && r.provenance.locator.amount_line === r.provenance.locator.line + 1), 'at least one following-line item');
      for (const k of ['current', 'over_30', 'over_60', 'over_90', 'balance']) assert.strictEqual(st(`ap_aging.items_tie_to_printed_total.${k}`), 'PASS', k);
      assert.strictEqual(st('ap_aging.no_unreadable_lines'), 'PASS');
    });
    await check('fund-column batch: GL keeps every account (incl. codes over 6 digits) separate; every account ties to its printed totals', () => {
      assert.ok(gl.printed.accounts.some((a) => a.account_code.length > 6), 'a long account code is parsed as its own account');
      assert.strictEqual(st('gl.transactions_tie_to_printed_account_totals'), 'PASS');
      assert.deepStrictEqual(gl.defects, []);
    });
    await check('fund-column batch: the two AR-aging controls that reflect the Vantaca report\'s own inconsistency still FAIL (no forced tie)', () => {
      assert.strictEqual(st('ar_aging.accounts_tie_to_printed_total.current'), 'FAIL');
      assert.strictEqual(st('ar_aging.accounts_tie_to_printed_total.over_90'), 'FAIL');
      const others = n.extraction.filter((c) => c.status !== 'PASS').map((c) => c.code).sort();
      assert.deepStrictEqual(others, ['ar_aging.accounts_tie_to_printed_total.current', 'ar_aging.accounts_tie_to_printed_total.over_90']);
    });
  }
  if (batches.qr) {
    const n = await normalizeStored(batches.qr);
    for (const [t, pinned] of Object.entries(QR_PINNED)) {
      await check(`Quail Ridge: ${t} parses byte-for-byte as before the change`, () => { assert.ok(n.parsed[t], `${t} present`); assert.strictEqual(sha(JSON.stringify(n.parsed[t])), pinned); });
    }
    await check('Quail Ridge: every extraction control still PASSes', () => assert.ok(n.extraction.every((c) => c.status === 'PASS'), JSON.stringify(n.extraction.filter((c) => c.status !== 'PASS').map((c) => c.code))));
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('FAIL  ' + e.message); process.exit(1); });
