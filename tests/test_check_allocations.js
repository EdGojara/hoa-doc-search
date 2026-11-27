// Split check allocations (migration 584): validation, the GL entry, and the Owner Authorization
// Service request/execution (lib/authorization/check_allocations). Invented data only.
const assert = require('assert');
const CR = require('../lib/payments/check_receipts');
const CA = require('../lib/authorization/check_allocations');

let failures = 0;
async function check(name, fn) { try { await fn(); console.log('  ok  ' + name); } catch (e) { failures++; console.log('  FAIL ' + name + ': ' + e.message); } }
const L = (o) => ({ kind: 'owner_account', property_id: 'lot-1', tenure_id: 'ten-s', funding_party: 'seller', purpose: 'assessment', amount_cents: 1000, basis: 'Settlement statement line 1', ...o });

(async () => {
  console.log('check allocations');

  await check('validate: a balanced seller/buyer split passes', async () => {
    assert.deepStrictEqual(CR.validateAllocation(3000, [L({}), L({ tenure_id: 'ten-b', funding_party: 'buyer', amount_cents: 2000 })]), []);
  });

  await check('validate: lines must total the check, and each line needs its basis and a real funding party', async () => {
    assert.match(CR.validateAllocation(5000, [L({}), L({ tenure_id: 'ten-b', amount_cents: 2000 })]).join(' '), /total \$30\.00; the check is \$50\.00/);
    assert.match(CR.validateAllocation(2000, [L({ basis: 'x' }), L({ tenure_id: 'ten-b' })]).join(' '), /basis/);
    assert.match(CR.validateAllocation(2000, [L({ funding_party: 'unknown' }), L({ tenure_id: 'ten-b' })]).join(' '), /held line/);
    assert.match(CR.validateAllocation(2000, [L({})]).join(' '), /2 to 20 lines/);
  });

  await check('validate: an unknown funding party is a held line with no account; held-only is refused', async () => {
    const held = { kind: 'held', funding_party: 'unknown', purpose: 'held', amount_cents: 500, basis: 'Not established on the statement' };
    assert.deepStrictEqual(CR.validateAllocation(1500, [L({}), held]), []);
    assert.match(CR.validateAllocation(1000, [held, held]).join(' '), /at least one line applies to an owner account/);
    assert.match(CR.validateAllocation(1500, [L({}), { ...held, property_id: 'lot-1' }]).join(' '), /held line names no account/);
  });

  await check('GL: Dr Undeposited the whole check; Cr AR per owner account (property-tagged); Cr Unidentified for the held part', async () => {
    const acct = { undeposited_funds: { id: 'u', fund_id: 'f' }, homeowner_ar: { id: 'ar', fund_id: 'f' }, unidentified_receipts: { id: 'un', fund_id: 'f' } };
    const lines = CR.splitGlLines({ amountCents: 99000, checkNumber: '1', groups: [{ property_id: 'lot-1', amount_cents: 27000, funding_parties: 'seller' }, { property_id: 'lot-1', amount_cents: 52000, funding_parties: 'buyer, seller' }], heldCents: 20000, acct });
    assert.deepStrictEqual(lines.map((l) => [l.account_id, l.debit_cents, l.credit_cents, l.property_id || null]), [['u', 99000, 0, null], ['ar', 0, 27000, 'lot-1'], ['ar', 0, 52000, 'lot-1'], ['un', 0, 20000, null]]);
    assert.throws(() => CR.splitGlLines({ amountCents: 99000, checkNumber: '1', groups: [{ property_id: 'p', amount_cents: 1 }], heldCents: 0, acct }), /does not balance/);
  });

  await check('request email: each check, every line with its funding party and basis, how each share applies, no refunds', async () => {
    const checks = [{ address: '100 Example Way', receipt: { check_number: '7001', amount_cents: 99000, check_date: '2026-09-22', payer_name: 'Example Title', community_id: 'c' },
      lines: [{ line_no: 1, kind: 'owner_account', address: '100 Example Way', tenure_label: 'Example Builder (2025-12-08 to 2026-09-21)', funding_party: 'seller', purpose: 'assessment', amount_cents: 27000, basis: 'Seller column' },
        { line_no: 2, kind: 'owner_account', address: '100 Example Way', tenure_label: 'Buyer (2026-09-22 to current)', funding_party: 'buyer', purpose: 'assessment', amount_cents: 72000, basis: 'Buyer column' }],
      preview: { accounts: [{ funding_parties: 'seller', amount_cents: 27000, applied_cents: 17901, unapplied_cents: 9099 }, { funding_parties: 'buyer', amount_cents: 72000, applied_cents: 63197, unapplied_cents: 8803 }] } }];
    const subject = CA.requestSubject('ABCD1234', checks);
    assert.strictEqual(subject, 'Owner authorization ABCD1234: record 1 split check ($990.00)');
    const mail = CA.renderRequest({ subject, checks, communityName: 'Example HOA', expiresAt: 'soon' });
    assert.match(mail.text, /1\. 100 Example Way check #7001, \$990\.00/);
    assert.match(mail.text, /Example Builder \(2025-12-08 to 2026-09-21\): \$270\.00, funded by seller, for assessment\. Basis: Seller column/);
    assert.match(mail.text, /seller share \$270\.00: applied \$179\.01, unapplied credit \$90\.99 on that account/);
    assert.match(mail.text, /nothing is refunded/);
    assert.ok(!/—/.test(mail.text + mail.html), 'no em-dashes');
  });

  await check('execute: records only checks whose allocation is unchanged; marks executed only when all recorded', async () => {
    const recorded = []; const rpcCalls = [];
    const fps = { r1: 'a'.repeat(64), r2: 'c'.repeat(64) };
    const ctx = { supabase: { rpc: async (n, a) => ({ data: fps[a.p_receipt_id], error: null }) }, rpc: async (n, a) => { rpcCalls.push(n); },
      recordReceipt: async (_s, id, o) => { recorded.push([id, o.actor]); return { status: 'recorded', journal_reference: 'JE-' + id, applied_cents: 1, unapplied_cents: 0 }; } };
    const auth = { id: 'auth-1', status: 'authorized', scope: 'check_receipt_allocations', authorized_by_email: 'owner@example.com', items: [{ receipt_id: 'r1', check_number: '1', amount_cents: 100, fingerprint: 'a'.repeat(64) }, { receipt_id: 'r2', check_number: '2', amount_cents: 200, fingerprint: 'b'.repeat(64) }] };
    const out = await CA.executeAuthorized(ctx, auth);
    assert.deepStrictEqual([out.recorded, out.failed], [1, 1]);
    assert.deepStrictEqual(recorded.map((r) => r[0]), ['r1']);
    assert.match(recorded[0][1], /authorized by email reply, owner authorization auth-1/);
    assert.match(out.results[1].error, /changed after the owner authorized/);
    assert.deepStrictEqual(rpcCalls, []);   // not every check recorded: the authorization stays open for Amanda
    assert.match(CA.renderCompletion(auth, out).text, /1 check\(s\) recorded, 1 not/);
    await assert.rejects(CA.executeAuthorized(ctx, { ...auth, status: 'requested' }), (e) => e.code === 'approval_required');
  });

  await check('authorization service: check allocations are a registered tier-1 action approved whole', async () => {
    const AZ = require('../lib/authorization');
    const a = AZ.actionForScope('check_receipt_allocations');
    assert.ok(a && a.executable && a.type === 'check_allocation' && a.tier === 1 && !a.parseReply);
  });

  if (failures) { console.log(`${failures} failed`); process.exit(1); }
  console.log('all passed');
})();
