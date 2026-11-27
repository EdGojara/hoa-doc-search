// Legal bill-back reversals through the Owner Authorization Service (migration 585):
// request verification, execution controls, owner attribution and the emails
// (lib/authorization/legal_reversals). Offline: invented data, stubbed database.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const LR = require('../lib/authorization/legal_reversals');
const AZ = require('../lib/authorization');

let failures = 0;
async function check(name, fn) { try { await fn(); console.log('  ok  ' + name); } catch (e) { failures++; console.log('  FAIL ' + name + ': ' + e.message); } }

// A tiny PostgREST stand-in: from(t).select().eq().in().limit().maybeSingle()/single(), and rpc().
function fakeDb(tables, rpcs = {}) {
  const calls = [];
  function q(t) {
    const filters = [];
    const b = {
      select() { return b; }, order() { return b; }, limit() { return b; },
      insert(rows) { (tables[t] = tables[t] || []).push(...[].concat(rows)); return b; },
      eq(col, v) { filters.push((r) => { const m = /^(.+)->>(.+)$/.exec(col); const val = m ? (r[m[1]] || {})[m[2]] : r[col]; return String(val) === String(v); }); return b; },
      in(col, vs) { filters.push((r) => vs.map(String).includes(String(r[col]))); return b; },
      rows() { return (tables[t] || []).filter((r) => filters.every((f) => f(r))); },
      maybeSingle() { return Promise.resolve({ data: b.rows()[0] || null, error: null }); },
      single() { const r = b.rows()[0]; return Promise.resolve(r ? { data: r, error: null } : { data: null, error: { message: 'no row' } }); },
      then(res, rej) { return Promise.resolve({ data: b.rows(), error: null }).then(res, rej); },
    };
    return b;
  }
  return { calls, from: (t) => q(t), rpc: async (n, a) => { calls.push([n, a]); return rpcs[n] ? rpcs[n](a) : { data: null, error: { message: `no rpc ${n}` } }; } };
}

const POSTING = 'p0000000-0000-4000-8000-000000000001';
function world(over = {}) {
  const posting = { id: POSTING, community_id: 'c1', property_id: 'lot-1', tenure_id: 'ten-1', kind: 'homeowner_chargeback', amount_cents: 42500, status: 'posted', posting_date: '2026-10-11',
    journal_entry_id: 'je-1', homeowner_transaction_id: 'tx-1', debit_account_id: 'a1300', credit_account_id: 'a5870', reversal_journal_entry_id: null, reversal_homeowner_transaction_id: null, reversed_at: null,
    properties: { street_address: '100 Example Drive' }, ...(over.posting || {}) };
  return {
    legal_invoice_postings: [posting],
    journal_entries: [{ id: 'je-1', status: 'posted', reference: 'JE-1', posting_date: '2026-10-11', ...(over.je || {}) }],
    journal_entry_lines: [{ journal_entry_id: 'je-1', debit_cents: 42500, credit_cents: 0, property_id: 'lot-1', chart_of_accounts: { account_number: '1300', account_name: 'Accounts Receivable' } },
      { journal_entry_id: 'je-1', debit_cents: 0, credit_cents: 42500, property_id: null, chart_of_accounts: { account_number: '5870', account_name: 'Legal Fees - Collections/DRV' } }],
    homeowner_transactions: [{ id: 'tx-1', community_id: 'c1', transaction_date: '2026-10-11', description: 'Legal Fees - DRV Enforcement (Attorney Inv. X-1)', amount_cents: 42500, tenure_id: 'ten-1', raw_row_jsonb: {} }, ...(over.txns || [])],
    chart_of_accounts: [{ id: 'a1300', account_number: '1300', account_name: 'Accounts Receivable' }, { id: 'a5870', account_number: '5870', account_name: 'Legal Fees - Collections/DRV' }],
    v_current_owner_balance: [{ property_id: 'lot-1', tenure_id: over.currentTenure || 'ten-1', balance_cents: 150000 }],
    owner_authorizations: over.open || [],
    communities: [{ id: 'c1', name: 'Example Estates' }],
  };
}
const REQ = { posting_id: POSTING, reason: 'Duplicate legal bill-back: invoice X-1 was already billed in the opening balance.', expect: { amount_cents: 42500, address: '100 Example' } };

(async () => {
  console.log('legal posting reversals');

  await check('registry: tier 2, executed by Kat, scope legal_posting_reversals, email may authorize it', async () => {
    const a = AZ.actionForScope('legal_posting_reversals');
    assert.ok(a && a.executable && a.type === 'legal_posting_reversal' && a.executor === 'ai-team:kat');
    assert.strictEqual(AZ.tierOf(a, {}), 2);
    assert.ok(AZ.channelAllowed(2, 'email') && !AZ.channelAllowed(3, 'email'));
  });

  await check('package: a posted, unreversed, matching posting passes, with balance before/after and the reversing GL lines', async () => {
    const pkg = await LR.buildPackage(fakeDb(world(), { close_closed_through: () => ({ data: '2026-10-31', error: null }) }), [REQ]);
    assert.deepStrictEqual(pkg.problems, []);
    const p = pkg.postings[0];
    assert.strictEqual(p.balance_before_cents, 150000); assert.strictEqual(p.balance_after_cents, 107500);
    assert.deepStrictEqual(p.gl.lines.map((l) => [l.account, l.debit_cents, l.credit_cents]), [['1300 Accounts Receivable', 0, 42500], ['5870 Legal Fees - Collections/DRV', 42500, 0]]);
  });

  await check('package: refuses an already-reversed posting', async () => {
    const pkg = await LR.buildPackage(fakeDb(world({ posting: { status: 'reversed', reversal_journal_entry_id: 'je-2', reversal_homeowner_transaction_id: 'tx-2', reversed_at: '2026-11-01T00:00:00Z' } })), [REQ]);
    assert.ok(!pkg.ok); assert.match(pkg.problems[0].problems.join(' '), /not posted/); assert.match(pkg.problems[0].problems.join(' '), /already been reversed/);
  });

  await check('package: refuses a changed posting (amount, address, existing owner credit, voided entry, new owner)', async () => {
    let pkg = await LR.buildPackage(fakeDb(world({ posting: { amount_cents: 50000 } })), [REQ]);
    assert.match(pkg.problems[0].problems.join(' '), /expected \$425.00, the posting is \$500\.00/);
    pkg = await LR.buildPackage(fakeDb(world()), [{ ...REQ, expect: { address: '5922 Other Street' } }]);
    assert.match(pkg.problems[0].problems.join(' '), /expected 5922 Other Street/);
    pkg = await LR.buildPackage(fakeDb(world({ txns: [{ id: 'tx-9', community_id: 'c1', amount_cents: -42500, raw_row_jsonb: { reverses_legal_posting_id: POSTING } }] })), [REQ]);
    assert.match(pkg.problems[0].problems.join(' '), /owner credit reversing it already exists/);
    pkg = await LR.buildPackage(fakeDb(world({ je: { status: 'voided' } })), [REQ]);
    assert.match(pkg.problems[0].problems.join(' '), /entry is voided/);
    pkg = await LR.buildPackage(fakeDb(world({ currentTenure: 'ten-2' })), [REQ]);
    assert.match(pkg.problems[0].problems.join(' '), /no longer the current owner/);
  });

  await check('package: requires a reason and refuses a closed-period reversal date', async () => {
    let pkg = await LR.buildPackage(fakeDb(world()), [{ ...REQ, reason: 'dup' }]);
    assert.match(pkg.problems[0].problems.join(' '), /state why/);
    pkg = await LR.buildPackage(fakeDb(world(), { close_closed_through: () => ({ data: '2026-10-31', error: null }) }), [{ ...REQ, reversal_date: '2026-10-15' }]);
    assert.match(pkg.problems[0].problems.join(' '), /closed period/);
  });

  await check('request: refuses before filing anything when verification fails', async () => {
    const rpcs = [];
    await assert.rejects(LR.requestAuthorization({ supabase: fakeDb(world({ posting: { status: 'reversed' } })), rpc: async (n) => { rpcs.push(n); }, send: async () => { throw new Error('must not send'); }, requests: [REQ], ownerEmail: 'owner@example.com', fromMailbox: 'ea@example.com', summary: 's' }), /not requested; fix first/);
    assert.deepStrictEqual(rpcs, []);
  });

  await check('request: refuses when an open request already covers the posting', async () => {
    const db = fakeDb(world({ open: [{ id: 'oa-1', scope: 'legal_posting_reversals', status: 'requested', subject: 'Owner authorization AAAA0000: reverse', items: [{ posting_id: POSTING }] }] }));
    await assert.rejects(LR.requestAuthorization({ supabase: db, rpc: async () => { throw new Error('must not file'); }, send: async () => { throw new Error('must not send'); }, requests: [REQ], ownerEmail: 'o@example.com', fromMailbox: 'ea@example.com', summary: 's' }), /open request already covers/);
  });

  await check('request: files through the rpc, Tessa sends it, then it is marked sent', async () => {
    const rpcs = []; const sent = [];
    const rpc = async (n, a) => { rpcs.push([n, a]); if (n === 'owner_authorization_request_legal_reversals') return { id: 'oa-9', items: [{ posting_id: POSTING, community_id: 'c1', fingerprint: 'f'.repeat(64), reason: REQ.reason, amount_cents: 42500 }], items_sha256: 'h' }; return null; };
    const out = await LR.requestAuthorization({ supabase: fakeDb(world()), rpc, send: async (m) => { sent.push(m); return { internetMessageId: '<m@x>', conversationId: 'conv' }; }, requests: [REQ], ownerEmail: 'owner@example.com', fromMailbox: 'tessa@example.com', summary: 's' });
    assert.strictEqual(out.id, 'oa-9');
    assert.deepStrictEqual(rpcs.map((r) => r[0]), ['owner_authorization_request_legal_reversals', 'owner_authorization_sent']);
    assert.deepStrictEqual(rpcs[0][1].p_postings, [{ posting_id: POSTING, reason: REQ.reason, reversal_date: null }]);
    assert.strictEqual(rpcs[0][1].p_requested_by, 'ai-team:kat');
    assert.strictEqual(sent[0].from, 'tessa@example.com'); assert.match(sent[0].subject, /^Owner authorization [0-9A-F]{8}: reverse 1 legal bill-back \(\$425.00\)$/);
  });

  await check('request email: what is reversed, why, balance before/after, GL effect, reply "approved"; no em dashes', async () => {
    const pkg = await LR.buildPackage(fakeDb(world()), [REQ]);
    const mail = LR.renderRequest({ subject: LR.requestSubject('ABCD1234', pkg.postings), postings: pkg.postings, communityName: 'Example Estates', expiresAt: 'soon' });
    assert.strictEqual(mail.subject, 'Owner authorization ABCD1234: reverse 1 legal bill-back ($425.00)');
    assert.match(mail.text, /1\. 100 Example Drive: \$425.00 legal bill-back posted 2026-10-11/);
    assert.match(mail.text, /Why: Duplicate legal bill-back/);
    assert.match(mail.text, /Homeowner balance: \$1,500.00 before, \$1,075.00 after/);
    assert.match(mail.text, /Cr 1300 Accounts Receivable \(this property\): \$425.00/);
    assert.match(mail.text, /Dr 5870 Legal Fees - Collections\/DRV: \$425.00/);
    assert.match(mail.text, /Reply "approved" to authorize exactly these reversals/);
    assert.ok(!/—/.test(mail.text + mail.html), 'no em dashes');
  });

  const AUTH = { id: 'oa-1234567890', status: 'authorized', scope: 'legal_posting_reversals', authorized_by_email: 'owner@example.com', authorized_by_user_id: 'user-owner', subject: 'Owner authorization ABCD1234: reverse 1 legal bill-back ($425.00)',
    items: [{ n: 1, posting_id: POSTING, property_id: 'lot-1', amount_cents: 42500, reason: REQ.reason, reversal_date: null, fingerprint: 'a'.repeat(64) }] };
  const execDb = { v_current_owner_balance: [{ property_id: 'lot-1', balance_cents: 107500 }] };
  const execCtx = (fp, calls, reverse) => ({ supabase: { rpc: async () => ({ data: fp, error: null }), from: (t) => fakeDb(execDb).from(t) },
    rpc: async (n, a) => { calls.push([n, a]); }, resumeAfter: () => {}, reversePosting: reverse || (async (_s, id, o) => { calls.push(['reverse', id, o]); return { ok: true, posting_id: id, reversal_journal_entry_id: 'je-rev', reversal_homeowner_transaction_id: 'tx-rev' }; }) });

  await check('execute: refuses without authorized status, the right scope, or the authorizing email', async () => {
    for (const bad of [{ status: 'requested' }, { scope: 'check_receipt_allocations' }, { authorized_by_email: null }]) {
      const calls = [];
      await assert.rejects(LR.executeAuthorized(execCtx('a'.repeat(64), calls), { ...AUTH, ...bad }), /no authorized legal posting reversal/);
      assert.deepStrictEqual(calls, []);
    }
  });

  await check('execute: refuses when the posting fingerprint changed; not reversed, not marked executed', async () => {
    const calls = [];
    const out = await LR.executeAuthorized(execCtx('b'.repeat(64), calls), AUTH);
    assert.ok(!out.ok); assert.match(out.results[0].error, /changed after the owner authorized it/);
    assert.deepStrictEqual(calls, []);
  });

  await check('execute: reverses through reversePosting with the owner attribution, then marks executed', async () => {
    const calls = [];
    const out = await LR.executeAuthorized(execCtx('a'.repeat(64), calls), AUTH);
    assert.ok(out.ok); assert.strictEqual(out.reversed, 1);
    const [, id, opts] = calls.find((c) => c[0] === 'reverse');
    assert.strictEqual(id, POSTING);
    assert.strictEqual(opts.actor, 'owner@example.com (owner, authorized by email reply, owner authorization oa-1234567890; executed by Kat)');
    assert.strictEqual(opts.actorUserId, 'user-owner'); assert.strictEqual(opts.reason, REQ.reason); assert.strictEqual(opts.reversalDate, undefined);
    assert.strictEqual(out.results[0].balance_after_cents, 107500);
    assert.ok(calls.some((c) => c[0] === 'owner_authorization_mark_executed' && c[1].p_id === AUTH.id));
  });

  await check('execute: a module refusal is reported and the request is not marked executed', async () => {
    const calls = [];
    const out = await LR.executeAuthorized(execCtx('a'.repeat(64), calls, async () => ({ ok: false, error: 'not_posted', detail: 'This posting is reversed.' })), AUTH);
    assert.ok(!out.ok); assert.strictEqual(out.results[0].error, 'This posting is reversed.');
    assert.ok(!calls.some((c) => c[0] === 'owner_authorization_mark_executed'));
  });

  await check('completion email: reversed, entry and owner credit, balance now, reason; no em dashes', async () => {
    const done = LR.renderCompletion(AUTH, { reversed: 1, failed: 0, results: [{ posting_id: POSTING, ok: true, amount_cents: 42500, reversal_journal_entry_id: 'je-rev-123', reversal_homeowner_transaction_id: 'tx-rev-456', balance_after_cents: 107500 }] });
    assert.strictEqual(done.subject, `Done: ${AUTH.subject}`);
    assert.match(done.text, /Kat carried out your authorization oa-12345: 1 legal bill-back reversed, 0 not\./);
    assert.match(done.text, /\$425.00 legal bill-back \(posting p0000000\): reversed \(entry je-rev-1, owner credit tx-rev-4\); homeowner balance now \$1,075.00\. Reason: Duplicate/);
    assert.ok(!/—/.test(done.text));
    const fail = LR.renderCompletion(AUTH, { reversed: 0, failed: 1, results: [{ posting_id: POSTING, ok: false, amount_cents: 42500, error: 'the posting changed' }] });
    assert.match(fail.text, /NOT reversed: the posting changed/);
  });

  await check('dispatcher: executeAuthorized routes the scope to Kat via email at tier 2', async () => {
    const calls = [];
    const out = await AZ.executeAuthorized(execCtx('a'.repeat(64), calls), AUTH, { channel: 'email' });
    assert.strictEqual(out.tier, 2); assert.ok(out.ok); assert.strictEqual(out.summary, '1 reversed, 0 not');
  });

  await check('script: dry run by default; --send, reason and expectations parsed', async () => {
    const { parseArgs } = require('../scripts/request_legal_reversal');
    const a = parseArgs([POSTING, '--reason', 'Duplicate bill-back', '--expect-amount', '425.00', '--expect-address', '100 Example']);
    assert.strictEqual(a.send, false); assert.strictEqual(a.expect.amount_cents, 42500); assert.strictEqual(a.reason, 'Duplicate bill-back');
    assert.strictEqual(parseArgs([POSTING, '--reason', 'x y z', '--send']).send, true);
  });

  await check('migration 585: scope, fingerprint, request function, tier 2 / Kat, service_role only', async () => {
    const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', '585_owner_authorized_legal_reversal.sql'), 'utf8');
    assert.match(sql, /'check_receipt_allocations', 'legal_posting_reversals'\)\);/);
    assert.match(sql, /FUNCTION legal_posting_reversal_sha256\(p_posting_id uuid\)/);
    assert.match(sql, /'ai-team:amanda', 'ai-team:kat', 2\)/);
    assert.match(sql, /FROM PUBLIC, anon, authenticated;/); assert.match(sql, /TO service_role;/);
    assert.ok(/^-- [\s\S]*\nBEGIN;[\s\S]*COMMIT;\s*$/.test(sql));
  });

  if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1); }
  console.log('\nall legal reversal checks passed');
})();
