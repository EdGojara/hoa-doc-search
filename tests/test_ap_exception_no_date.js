// tests/test_ap_exception_no_date.js — a held bill that printed no invoice date
// (or no total) is finished from its exception card (Ed 2026-10-07). Real case:
// Sweetie Pies Petting Zoo, $625, Waterview, a DOCX with only a service date,
// sat pending 10/2 to 10/7 because promoteException had no way to take a date
// and its own failure text pointed staff at a payable that did not exist yet.
// Offline: the database and commitInvoice are faked; commitInvoice is the SAME
// entry point (duplicate checks, approval routing) and is asserted to be called.
require('dotenv').config({ quiet: true });
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { promoteException, suggestedInvoiceDate, validateInvoiceDate } = require('../lib/ap/intake_exceptions');
const { staffDirectedLines } = require('../lib/ap/intake');

let failed = 0;
const results = [];
const t = (name, fn) => results.push({ name, fn });

const WV = 'c-waterview';
const NOW = new Date('2026-10-07T15:00:00Z');
const ACCOUNTS = [
  { id: 'a5900', community_id: WV, account_number: '5900', account_name: 'Community Events' },
  { id: 'a5100-other', community_id: 'c-other', account_number: '5100', account_name: 'Landscape Maintenance' },
];
const sweetiePies = (over = {}) => ({
  id: 'exc-1', status: 'pending', reason: 'no_date', community_id: WV, suggested_vendor_id: 'v-sweetie',
  vendor_name: 'Sweetie Pies Petting Zoo', email_message_id: 'm-1', intake_source_ref: 'email:sp1',
  storage_path: 'ap_invoices/sweetie.docx', file_sha256: 'sha-sweetie', total_cents: 62500, invoice_date: null,
  extracted: { vendor_name: 'Sweetie Pies Petting Zoo', invoice_date: null, total_cents: 62500,
    service_period_start: '2026-10-10', service_period_end: '2026-10-10',
    line_items: [{ description: 'Petting zoo, fall festival', amount: 625 }] },
  ...over,
});

// A tiny PostgREST stand-in: records every update and answers lookups from fixtures.
function fakeDb(exc, { failUpdate = false } = {}) {
  const updates = [];
  return {
    updates,
    from(table) {
      const st = { table, eqs: {}, op: 'select', patch: null };
      const q = {
        select() { return q; },
        eq(c, v) { st.eqs[c] = v; return q; },
        update(u) { st.op = 'update'; st.patch = u; return q; },
        maybeSingle: async () => {
          if (table === 'ap_intake_exceptions') return { data: exc && exc.id === st.eqs.id ? exc : null, error: null };
          if (table === 'chart_of_accounts') {
            const a = ACCOUNTS.find((x) => x.id === st.eqs.id && x.community_id === st.eqs.community_id);
            return { data: a ? { id: a.id, account_number: a.account_number, account_name: a.account_name } : null, error: null };
          }
          return { data: null, error: null };
        },
        then(res, rej) {
          if (st.op === 'update') {
            updates.push([table, st.patch, { ...st.eqs }]);
            return Promise.resolve(failUpdate && table === 'ap_intake_exceptions' && st.patch.extracted ? { data: null, error: { message: 'boom' } } : { data: null, error: null }).then(res, rej);
          }
          return Promise.resolve({ data: null, error: null }).then(res, rej);
        },
      };
      return q;
    },
  };
}
function fakeIntake(outcome = { outcome: 'loaded', invoice_id: 'inv-9' }) {
  const calls = [];
  return { calls, resolveVendor: async () => ({ vendor: null }), commitInvoice: async (a) => { calls.push(a); return outcome; } };
}
const run = async (exc, opts, { outcome, failUpdate } = {}) => {
  const db = fakeDb(exc, { failUpdate }); const intake = fakeIntake(outcome);
  const out = await promoteException(exc.id, { resolvedBy: 'Kat', ...opts }, { supabase: db, intake, now: NOW });
  return { out, db, intake };
};

t('the suggested date is the service date the bill prints (end, else start)', () => {
  assert.strictEqual(suggestedInvoiceDate({ service_period_start: '2026-10-10' }), '2026-10-10');
  assert.strictEqual(suggestedInvoiceDate({ service_period_start: '2026-09-01', service_period_end: '2026-09-30' }), '2026-09-30');
  assert.strictEqual(suggestedInvoiceDate({}), null);
  assert.strictEqual(suggestedInvoiceDate(null), null);
});

t('a no_date exception with no date entered is refused with the suggestion, and nothing is committed', async () => {
  const { out, intake, db } = await run(sweetiePies(), {});
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.error, 'need_date');
  assert.strictEqual(out.suggested_invoice_date, '2026-10-10');
  assert.match(out.detail, /service date is 2026-10-10/);
  assert.strictEqual(intake.calls.length, 0);
  assert.strictEqual(db.updates.length, 0);
});

t('a no_date exception promotes with a supplied date through commitInvoice, from the stored file', async () => {
  const exc = sweetiePies();
  const { out, intake, db } = await run(exc, { invoiceDate: '2026-10-10' });
  assert.ok(out.ok, JSON.stringify(out));
  assert.strictEqual(out.invoice_id, 'inv-9');
  assert.strictEqual(intake.calls.length, 1);
  const c = intake.calls[0];
  assert.strictEqual(c.extracted.invoice_date, '2026-10-10');
  assert.strictEqual(c.extracted.total_cents, 62500);
  assert.strictEqual(c.vendorId, 'v-sweetie'); assert.strictEqual(c.communityId, WV);
  // No re-upload: the stored file, hash and source ref go to the same dedup.
  assert.strictEqual(c.storagePath, 'ap_invoices/sweetie.docx'); assert.strictEqual(c.sha256, 'sha-sweetie'); assert.strictEqual(c.sourceRef, 'email:sp1');
  // Who and when, on the payable's notes and on the exception.
  assert.match(c.extraNotes, /^Entered from the intake exception by Kat on 2026-10-07T15:00:00\.000Z: invoice date 2026-10-10 \(the bill prints none; service date 2026-10-10\)\.$/);
  const saved = db.updates.find(([tb, u]) => tb === 'ap_intake_exceptions' && u.extracted);
  assert.ok(saved, 'the entry is persisted on the exception');
  assert.deepStrictEqual(saved[1].extracted.staff_entered, { invoice_date: '2026-10-10', by: 'Kat', at: '2026-10-07T15:00:00.000Z' });
  assert.strictEqual(saved[1].invoice_date, '2026-10-10');
  assert.strictEqual(saved[1].extracted.invoice_date, null, "the bill's own extraction is kept as read");
  assert.strictEqual(exc.extracted.invoice_date, null, 'the stored row object is not mutated');
  const resolved = db.updates.find(([tb, u]) => tb === 'ap_intake_exceptions' && u.status === 'resolved');
  assert.ok(resolved); assert.strictEqual(resolved[1].resolved_by, 'Kat'); assert.strictEqual(resolved[1].resolved_invoice_id, 'inv-9');
  assert.ok(db.updates.some(([tb, u]) => tb === 'email_messages' && u.triage_status === 'handled'));
  // A plain date entry does not invent a hold the bill would not otherwise get.
  assert.strictEqual(c.forceReview, undefined);
  assert.strictEqual(c.staffGl, null);
});

t('a bad date is refused: nothing committed, nothing saved', async () => {
  for (const d of ['2026-13-01', '10/10/2026', '2026-02-30', '2026-1-5', '1999-12-31', '2026-11-07', 'tomorrow']) {
    const { out, intake, db } = await run(sweetiePies(), { invoiceDate: d });
    assert.strictEqual(out.ok, false, d);
    assert.strictEqual(out.error, 'bad_date', d);
    assert.ok(out.detail, d);
    assert.strictEqual(out.suggested_invoice_date, '2026-10-10');
    assert.strictEqual(intake.calls.length, 0, d);
    assert.strictEqual(db.updates.length, 0, d);
  }
  // The edge of the window: 30 days out (Central) is accepted, 31 is not.
  assert.deepStrictEqual(validateInvoiceDate('2026-11-06', NOW), { date: '2026-11-06' });
  assert.strictEqual(validateInvoiceDate('2026-11-07', NOW).error, 'bad_date');
  // Late evening in Houston is still "today" in Central, not tomorrow (UTC).
  assert.deepStrictEqual(validateInvoiceDate('2026-11-06', new Date('2026-10-08T03:00:00Z')), { date: '2026-11-06' });
  assert.strictEqual(validateInvoiceDate('2026-11-07', new Date('2026-10-08T03:00:00Z')).error, 'bad_date');
});

t('a date the bill DOES print cannot be typed over here', async () => {
  const exc = sweetiePies({ reason: 'no_vendor', invoice_date: '2026-09-30', extracted: { ...sweetiePies().extracted, invoice_date: '2026-09-30' } });
  const { out, intake } = await run(exc, { invoiceDate: '2026-10-10' });
  assert.strictEqual(out.error, 'date_already_read');
  assert.strictEqual(intake.calls.length, 0);
  // ...and with no date entered it promotes on the bill's own date, as before.
  const ok = await run(exc, {});
  assert.ok(ok.out.ok); assert.strictEqual(ok.intake.calls[0].extracted.invoice_date, '2026-09-30');
  assert.strictEqual(ok.intake.calls[0].extraNotes, null);
});

t("the GL override codes the bill as staff-directed, on THIS community's chart only", async () => {
  const { out, intake } = await run(sweetiePies(), { invoiceDate: '2026-10-10', accountId: 'a5900' });
  assert.ok(out.ok, JSON.stringify(out));
  const c = intake.calls[0];
  assert.deepStrictEqual(c.staffGl, { account_id: 'a5900', account_number: '5900', account_name: 'Community Events' });
  assert.match(c.extraNotes, /account 5900 Community Events/);
  // commitInvoice codes every line to it with the staff-directed reason.
  const lines = staffDirectedLines(c.extracted.line_items, c.staffGl);
  assert.deepStrictEqual(lines.map((l) => [l.amount_cents, l.gl_account_id]), [[62500, 'a5900']]);
  assert.match(lines[0].reason, /^Staff-directed: code 5900 Community Events$/);
  // An account from another community's chart is refused before anything loads.
  const bad = await run(sweetiePies(), { invoiceDate: '2026-10-10', accountId: 'a5100-other' });
  assert.strictEqual(bad.out.error, 'bad_account');
  assert.strictEqual(bad.intake.calls.length, 0);
  assert.strictEqual(bad.db.updates.length, 0);
});

t('a no_total bill takes a typed amount; mismatched lines become one line and the bill is held for review', async () => {
  const base = sweetiePies().extracted;
  const noTotal = (lines) => sweetiePies({ reason: 'no_total', total_cents: null, invoice_date: '2026-10-01',
    extracted: { ...base, invoice_date: '2026-10-01', total_cents: null, line_items: lines } });
  const r1 = await run(noTotal([]), {});
  assert.strictEqual(r1.out.error, 'need_total'); assert.strictEqual(r1.intake.calls.length, 0);
  const r2 = await run(noTotal([{ description: 'Petting zoo', amount: 600 }]), { totalCents: 62500 });
  assert.ok(r2.out.ok, JSON.stringify(r2.out));
  const c2 = r2.intake.calls[0];
  assert.strictEqual(c2.extracted.total_cents, 62500);
  assert.deepStrictEqual(c2.extracted.line_items, [{ description: 'Petting zoo', quantity: 1, amount: 625 }]);
  assert.strictEqual(c2.forceReview, true);
  assert.match(c2.extraNotes, /amount \$625\.00 \(the bill showed none; entered as one line\)/);
  const saved = r2.db.updates.find(([tb, u]) => tb === 'ap_intake_exceptions' && u.extracted);
  assert.strictEqual(saved[1].total_cents, 62500); assert.strictEqual(saved[1].extracted.staff_entered.total_cents, 62500);
  // Lines that already add up to the typed total are kept as the bill's own.
  const r3 = await run(noTotal([{ description: 'Zoo', amount: 500 }, { description: 'Pony', amount: 125 }]), { totalCents: 62500 });
  assert.strictEqual(r3.intake.calls[0].extracted.line_items.length, 2);
  assert.strictEqual(r3.intake.calls[0].forceReview, undefined);
  // Bad amounts, and a total the bill already shows, are refused.
  for (const v of [0, -5, 12.5, NaN]) assert.strictEqual((await run(noTotal([]), { totalCents: v })).out.error, 'bad_total', String(v));
  assert.strictEqual((await run(sweetiePies(), { invoiceDate: '2026-10-10', totalCents: 1000 })).out.error, 'total_already_read');
});

t('duplicate checks stay in commitInvoice: a blocked duplicate resolves to the original; a failed load stays pending with its reason', async () => {
  const dup = await run(sweetiePies(), { invoiceDate: '2026-10-10' }, { outcome: { outcome: 'blocked_duplicate', duplicate_of: 'inv-orig' } });
  assert.ok(dup.out.ok); assert.strictEqual(dup.out.outcome, 'blocked_duplicate'); assert.strictEqual(dup.out.invoice_id, 'inv-orig');
  const fail = await run(sweetiePies(), { invoiceDate: '2026-10-10' }, { outcome: { outcome: 'needs_review', reason: 'missing vendor or community' } });
  assert.strictEqual(fail.out.ok, false); assert.strictEqual(fail.out.detail, 'missing vendor or community');
  assert.ok(!fail.db.updates.some(([, u]) => u.status === 'resolved'), 'stays pending');
  assert.ok(fail.db.updates.some(([, u]) => u.extracted && u.extracted.staff_entered), 'what was entered is kept for the next try');
  // If the entry itself can't be saved, nothing loads (no unattributed payable).
  const noSave = await run(sweetiePies(), { invoiceDate: '2026-10-10' }, { failUpdate: true });
  assert.strictEqual(noSave.out.error, 'save_failed'); assert.strictEqual(noSave.intake.calls.length, 0);
});

t('a resolved exception (Sweetie Pies after the script load) is never reprocessed', async () => {
  const { out, intake } = await run(sweetiePies({ status: 'resolved' }), { invoiceDate: '2026-10-10' });
  assert.strictEqual(out.error, 'not_pending'); assert.strictEqual(intake.calls.length, 0);
});

t('the route passes the fields through, with who-entered taken from the signed-in admin, never the body', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'api', 'ap_intake.js'), 'utf8');
  const i = src.indexOf("router.post('/exceptions/:id/resolve',");
  const block = src.slice(i, src.indexOf('});', i));
  assert.ok(/const admin = await requireAdmin\(req, res\); if \(!admin\) return;/.test(block));
  assert.ok(/invoiceDate: b\.invoice_date/.test(block) && /totalCents:/.test(block) && /accountId: b\.account_id/.test(block));
  assert.ok(/resolvedBy: admin\.full_name/.test(block));
  assert.ok(!/b\.resolved_by|b\.by\b|b\.entered_by/.test(block));
});

t('the exception card has the date input (prefilled from the suggestion) and shows the server error inline', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'ap-invoices.html'), 'utf8');
  assert.ok(/id="exc-date-\$\{x\.id\}"/.test(html), 'date input on the card');
  assert.ok(/x\.suggested_invoice_date/.test(html), 'prefilled from the suggestion');
  assert.ok(/body\.invoice_date=dEl\.value/.test(html), 'sent with the resolve');
  assert.ok(/say\(j\.detail\|\|j\.error\|\|/.test(html), 'server reason shown inline');
});

(async () => {
  for (const { name, fn } of results) {
    try { await fn(); console.log('PASS ', name); } catch (e) { failed++; console.log('FAIL ', name, '\n   ', e.message); }
  }
  console.log(failed ? `\n${failed} FAILED` : '\nall no-date exception checks passed');
  process.exitCode = failed ? 1 : 0;
})();
