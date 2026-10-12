#!/usr/bin/env node
// Tests for lib/accounting/ap_as_of.js: point-in-time AP at a conversion cutoff.
const assert = require('assert');
const { openApAsOf } = require('../lib/accounting/ap_as_of');

let failed = 0;
const t = (name, fn) => { try { fn(); console.log('PASS  ' + name); } catch (e) { failed++; console.log('FAIL  ' + name + '\n      ' + e.message); } };

const jes = {
  OPEN: { id: 'OPEN', reference: 'CONV-LPF-20260731-OPEN-OPR', posting_date: '2026-07-31' },
  J1: { id: 'J1', reference: 'JE-1', posting_date: '2026-07-15' },
  N1: { id: 'N1', reference: 'CONV-LPF-20260731-NEUT-JE-1', posting_date: '2026-07-15', reverses_je_id: 'J1' },
  R1: { id: 'R1', reference: 'CONV-LPF-20260731-REPOST-JE-1', posting_date: '2026-08-01', source_reference: 'J1' },
  J2: { id: 'J2', reference: 'JE-2', posting_date: '2026-07-31' },
  N2: { id: 'N2', reference: 'CONV-LPF-20260731-NEUT-JE-2', posting_date: '2026-07-31', reverses_je_id: 'J2' },
  J3: { id: 'J3', reference: 'JE-3', posting_date: '2026-07-13', void_reversal_je_id: 'V3' },
  N3: { id: 'N3', reference: 'CONV-LPF-20260731-NEUT-JE-3', posting_date: '2026-07-13', reverses_je_id: 'J3' },
  R3: { id: 'R3', reference: 'CONV-LPF-20260731-REPOST-JE-3', posting_date: '2026-08-01', source_reference: 'J3' },
  V3: { id: 'V3', reference: 'JE-V3', posting_date: '2026-08-11' },
};
const inv = (id, o) => ({ id, total_cents: 10000, status: 'approved', invoice_date: '2026-07-01', ...o });
const invoices = [
  inv('conv', { posting_journal_entry_id: 'OPEN', invoice_date: '2026-06-30' }),         // converted Vantaca open AP
  inv('native', { posting_journal_entry_id: 'J1', status: 'paid' }),                     // July native, re-posted 8/1, paid 8/10
  inv('dupe', { posting_journal_entry_id: 'J2' }),                                       // neutralized, not re-posted
  inv('voided', { posting_journal_entry_id: 'J3', status: 'voided' }),                   // re-posted 8/1, voided 8/11
  inv('unposted', { posting_journal_entry_id: null, invoice_date: '2026-07-28' }),       // no GL entry, dated before cutover
];
const applications = [{ payment_id: 'P1', invoice_id: 'native', applied_cents: 10000 }];
const paymentsById = { P1: { id: 'P1', payment_date: '2026-08-10', status: 'completed' } };
const at = (asOf) => openApAsOf({ invoices, jesById: jes, applications, paymentsById, asOf, cutoverDate: '2026-08-01' }).map((r) => r.id).sort();

t('7/31: only the converted open AP', () => assert.deepStrictEqual(at('2026-07-31'), ['conv']));
t('8/1: native July activity re-posted 8/1 appears; unposted pre-cutover invoice moves to cutover', () => assert.deepStrictEqual(at('2026-08-01'), ['conv', 'native', 'unposted', 'voided']));
t('a payment dated after as_of does not reduce the as-of balance; on/after its date it does', () => {
  assert.ok(at('2026-08-09').includes('native'));
  assert.ok(!at('2026-08-10').includes('native'));
});
t('a void only counts from its reversal date', () => {
  assert.ok(at('2026-08-10').includes('voided'));
  assert.ok(!at('2026-08-11').includes('voided'));
});
t('neutralized with no re-post never appears (duplicate posting)', () => {
  for (const d of ['2026-07-31', '2026-08-01', '2026-12-31']) assert.ok(!at(d).includes('dupe'));
});
// Canyon Gate 8/31 bridge (Ed 2026-10-12): three rules the GL already followed.
{
  const J = {
    A: { id: 'A', reference: 'JE-A', posting_date: '2025-12-05' },
    NA: { id: 'NA', reference: 'CONV-CGACR-20260731-NEUT-JE-A', posting_date: '2025-12-05', reverses_je_id: 'A', description: 'Conversion neutralization of JE-A (already in the source position)' },
    D: { id: 'D', reference: 'JE-D', posting_date: '2026-07-31' },
    ND: { id: 'ND', reference: 'CONV-CGACR-20260731-NEUT-JE-D', posting_date: '2026-07-31', reverses_je_id: 'D', description: 'Conversion neutralization of JE-D (owner decision accrued_in_legacy_books)' },
    RD: { id: 'RD', reference: 'CONV-CGACR-20260731-RECLASS-JE-D', posting_date: '2026-08-01', source_reference: 'D' },
    G: { id: 'G', reference: 'JE-G', posting_date: '2026-08-01' },
  };
  const iv = [inv('pool', { posting_journal_entry_id: 'A', status: 'paid' }), inv('reclass', { posting_journal_entry_id: 'D', status: 'paid' }), inv('gym', { posting_journal_entry_id: 'G', status: 'paid' })];
  const ap = [{ payment_id: 'C1036', invoice_id: 'pool', applied_cents: 10000 }, { payment_id: 'C1030', invoice_id: 'reclass', applied_cents: 10000 },
    { payment_id: 'C1006', invoice_id: 'gym', applied_cents: 10000 }, { payment_id: 'C1023', invoice_id: 'gym', applied_cents: 10000 }];
  const pb = { C1036: { id: 'C1036', payment_date: '2026-09-28', status: 'completed' }, C1030: { id: 'C1030', payment_date: '2026-09-16', status: 'completed' },
    C1006: { id: 'C1006', payment_date: '2026-08-14', status: 'voided', void_date: '2026-09-01' }, C1023: { id: 'C1023', payment_date: '2026-09-01', status: 'completed' } };
  const cg = (asOf) => openApAsOf({ invoices: iv, jesById: J, applications: ap, paymentsById: pb, asOf, cutoverDate: '2026-08-01' }).map((r) => r.id).sort();
  t('already in the source position: carried as open AP from the conversion date until paid', () => {
    assert.ok(cg('2026-07-31').includes('pool') && cg('2026-08-31').includes('pool') && !cg('2026-09-30').includes('pool'));
    assert.ok(!cg('2026-07-30').includes('pool'));
  });
  t('a conversion RECLASS re-posts like a REPOST (open 8/1 until paid 9/16)', () => {
    assert.ok(!cg('2026-07-31').includes('reclass') && cg('2026-08-31').includes('reclass') && !cg('2026-09-30').includes('reclass'));
  });
  t('a payment voided after the as-of date still paid the invoice on that date', () => {
    assert.ok(!cg('2026-08-31').includes('gym'), 'check 1006 (voided 9/1) paid it at 8/31');
    assert.ok(!cg('2026-09-30').includes('gym'), 'check 1023 pays it after the void');
    const noRepay = openApAsOf({ invoices: iv, jesById: J, applications: ap.filter((a) => a.payment_id !== 'C1023'), paymentsById: pb, asOf: '2026-09-30', cutoverDate: '2026-08-01' }).map((r) => r.id);
    assert.ok(noRepay.includes('gym'), 'once the void date passes with no repayment it is open again');
  });
}
t('no invoice appears twice', () => { const r = at('2026-08-01'); assert.strictEqual(r.length, new Set(r).size); });

console.log(failed ? `\n${failed} failure(s)` : '\nall passed');
process.exit(failed ? 1 : 0);
