// tests/test_ap_intake_date_and_near_dup.js  (Ed 2026-10-07)
// ----------------------------------------------------------------------------
// SCAR LOCK for two AP intake defects found at Waterview Estates (Fort Bend
// County M.U.D. No. 143), 2026-10-07:
//
//  1) WRONG YEAR. Statement 29748370 prints STATEMENT DATE 08/14/26, due
//     09/09/26, meter read 07/02/26-08/04/26. The only four-digit year on the
//     PDF is a "10/2024" revision stamp in the rate insert's footer, and the
//     reader returned 2024 for every date. It loaded and posted as 2024.
//     -> lib/ap/date_check.js holds the bill with a specific reason, never
//        corrects it, and keeps the reader's raw output on the held record.
//
//  2) SAME STATEMENT TWICE. Statement 30358853 (account 99693, 9/14/26,
//     $5,562.20) loaded twice: the second copy was read off page 3 as account
//     99893 / statement 300388853, so the exact-match dedup saw two bills.
//     -> lib/ap/dedup.js rule 5 holds it as a suspected duplicate.
//
// Runs the REAL commitInvoice / findDuplicates against an in-memory Supabase
// fake (same pattern as test_ap_commit_review_flag.js). Status / dedup values
// used are the ones the ap_invoices CHECK constraints allow (migrations 177, 266).
require('dotenv').config({ quiet: true });
const assert = require('assert');
const Module = require('module');

// ---- in-memory fake: eq filters only; unknown reads come back empty ----------
const db = { ap_invoices: [], ap_invoice_lines: [], updates: [] };
function fakeClient() {
  return {
    from(table) {
      const st = { table, filters: [], op: 'select', payload: null };
      const rows = () => (db[table] || []).filter((r) => st.filters.every(([c, v]) => r[c] === v));
      const q = {
        select() { return q; }, order() { return q; }, limit() { return q; }, range() { return q; },
        eq(c, v) { st.filters.push([c, v]); return q; }, neq() { return q; }, in() { return q; }, is() { return q; },
        ilike() { return q; }, or() { return q; }, not() { return q; }, gte() { return q; }, lte() { return q; }, lt() { return q; }, gt() { return q; },
        insert(p) {
          st.op = 'insert';
          const list = (Array.isArray(p) ? p : [p]).map((r, i) => ({ id: `${table}-${(db[table] || []).length + i + 1}`, ...r }));
          if (!db[table]) db[table] = [];
          db[table].push(...list);
          st.inserted = list;
          return q;
        },
        update(p) { st.op = 'update'; st.payload = p; return q; },
        async single() { return { data: st.inserted ? st.inserted[0] : (rows()[0] || null), error: null }; },
        async maybeSingle() { return { data: st.op === 'insert' ? st.inserted[0] : (rows()[0] || null), error: null }; },
        then(res, rej) {
          if (st.op === 'update') {
            for (const r of rows()) Object.assign(r, st.payload);
            db.updates.push({ table, filters: st.filters, payload: st.payload });
            return Promise.resolve({ data: null, error: null }).then(res, rej);
          }
          if (st.op === 'insert') return Promise.resolve({ data: st.inserted, error: null }).then(res, rej);
          return Promise.resolve({ data: rows(), error: null }).then(res, rej);
        },
      };
      return q;
    },
    storage: { from() { return { upload: async () => ({ error: null }), download: async () => ({ data: null, error: null }) }; } },
  };
}
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === '@supabase/supabase-js') return { createClient: () => fakeClient() };
  return realLoad.apply(this, arguments);
};
const { commitInvoice } = require('../lib/ap/intake');
const { findDuplicates, nearDuplicateStatement, editDistance } = require('../lib/ap/dedup');
const intakeModule = require('../lib/ap/intake');
const { mapReason, promoteException } = require('../lib/ap/intake_exceptions');
Module._load = realLoad;
const { checkInvoiceDates } = require('../lib/ap/date_check');

const results = [];
const t = (name, fn) => results.push({ name, fn });
const clone = (o) => JSON.parse(JSON.stringify(o));

const WATERVIEW = 'c-waterview';
const MUD143 = 'v-fbc-mud-143';

// ---- Fixture 1: statement 29748370 as the reader returned it (wrong year) ----
const RAW_29748370 = {
  vendor_name: 'Fort Bend County M.U.D. No. 143', invoice_number: '29748370', account_number: '99693',
  invoice_date: '2024-08-14', due_date: '2024-09-09',
  service_period_start: '2024-07-02', service_period_end: '2024-08-04',
  total: 1843.17, auto_draft: true, looks_like_invoice: true,
  line_items: [{ description: 'Water / sewer service', amount: 1843.17 }],
};
const extracted29748370 = () => ({
  vendor_name: RAW_29748370.vendor_name, invoice_number: RAW_29748370.invoice_number, account_number: RAW_29748370.account_number,
  invoice_date: RAW_29748370.invoice_date, due_date: RAW_29748370.due_date,
  service_period_start: RAW_29748370.service_period_start, service_period_end: RAW_29748370.service_period_end,
  total_cents: 184317, subtotal_cents: 184317, tax_cents: 0, auto_draft: true,
  line_items: clone(RAW_29748370.line_items), looks_like_invoice: true,
  raw_extracted: clone(RAW_29748370),
});
// The same statement read correctly (what the four sibling statements got).
const correct29748370 = () => ({ ...extracted29748370(), invoice_date: '2026-08-14', due_date: '2026-09-09',
  service_period_start: '2026-07-02', service_period_end: '2026-08-04' });
const RECEIVED = '2026-10-07T14:05:00Z';

// ---- date check (pure) -------------------------------------------------------
t('29748370 as read (2024) against a 2026-10-07 receipt: held, with the two-digit-year reason', () => {
  const r = checkInvoiceDates(extracted29748370(), RECEIVED);
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(r.problems.map((p) => p.code), ['invoice_date_too_old']);
  assert.match(r.problems[0].message, /^invoice date 2024-08-14 is 2 years before the bill was received \(2026-10-07\); the bill may print a two-digit year/);
});

t('the same statement read correctly passes, at receipt and on a ~2-month-late replay', () => {
  assert.strictEqual(checkInvoiceDates(correct29748370(), '2026-08-20').ok, true);
  assert.strictEqual(checkInvoiceDates(correct29748370(), RECEIVED).ok, true);
});

t('due date before the invoice date is held', () => {
  const r = checkInvoiceDates({ ...correct29748370(), due_date: '2025-09-09' }, RECEIVED);
  assert.deepStrictEqual(r.problems.map((p) => p.code), ['due_before_invoice']);
  assert.match(r.problems[0].message, /due date 2025-09-09 is before the invoice date 2026-08-14/);
});

t('an invoice dated more than ~60 days after receipt is held', () => {
  const r = checkInvoiceDates({ invoice_date: '2027-08-14' }, RECEIVED);
  assert.deepStrictEqual(r.problems.map((p) => p.code), ['invoice_date_in_future']);
  assert.strictEqual(checkInvoiceDates({ invoice_date: '2026-11-15' }, RECEIVED).ok, true, '39 days ahead is fine');
});

t('a service period in another year, months from the invoice, is held (invoice year right, period wrong)', () => {
  const r = checkInvoiceDates({ ...correct29748370(), service_period_start: '2024-07-02', service_period_end: '2024-08-04' }, RECEIVED);
  assert.deepStrictEqual(r.problems.map((p) => p.code), ['service_year_mismatch']);
  assert.match(r.problems[0].message, /service period 2024-07-02\.\.2024-08-04 is in 2024 but the invoice is dated 2026-08-14/);
});

t('a December period billed in January is NOT a year mismatch', () => {
  assert.strictEqual(checkInvoiceDates({ invoice_date: '2027-01-08', due_date: '2027-02-01', service_period_start: '2026-12-01', service_period_end: '2026-12-31' }, '2027-01-12').ok, true);
  assert.strictEqual(checkInvoiceDates({ invoice_date: '2027-01-08', service_period_start: '2026-12-05', service_period_end: '2027-01-06' }, '2027-01-12').ok, true);
});

t('an impossible date is held, not parsed into another day', () => {
  const r = checkInvoiceDates({ invoice_date: '2026-02-30' }, RECEIVED);
  assert.deepStrictEqual(r.problems.map((p) => p.code), ['invoice_date_invalid']);
});

// ---- commitInvoice: the date hold never loads and never corrects ------------
t('commitInvoice holds 29748370 (2024): needs_review, nothing inserted, dates untouched, raw output kept', async () => {
  const before = db.ap_invoices.length;
  const ex = extracted29748370();
  const out = await commitInvoice({ extracted: ex, vendorId: MUD143, communityId: WATERVIEW, sha256: 'sha-29748370', storagePath: 'ap_invoices/29748370.pdf',
    intakeMethod: 'email', sourceRef: 'email:mud143-aug', receivedAt: RECEIVED });
  assert.strictEqual(out.outcome, 'needs_review');
  assert.match(out.reason, /^date check: invoice date 2024-08-14 is 2 years before the bill was received/);
  assert.strictEqual(db.ap_invoices.length, before, 'no payable created');
  assert.strictEqual(ex.invoice_date, '2024-08-14', 'never auto-corrected');
  assert.deepStrictEqual(out.raw_extracted, RAW_29748370, 'raw model output returned');
  assert.deepStrictEqual(ex.raw_extracted, RAW_29748370, 'raw model output stays on the extraction the exception stores');
  assert.strictEqual(ex._date_check.ok, false, 'the check result rides on the held record');
  assert.strictEqual(mapReason(out.reason), 'date_check', 'lands in the exceptions list as a date check, not "no date"');
});

// ---- the held bill's exception card: correct or confirm, never guessed -----
const NOW = new Date('2026-10-07T15:00:00Z');
const heldException = (id, over = {}) => {
  const ex = extracted29748370();
  ex._date_check = checkInvoiceDates(ex, RECEIVED);
  return { id, status: 'pending', reason: 'date_check', community_id: WATERVIEW, suggested_vendor_id: `${MUD143}-${id}`,
    vendor_name: ex.vendor_name, intake_source_ref: `email:${id}`, storage_path: `ap_invoices/${id}.pdf`, file_sha256: `sha-${id}`,
    total_cents: ex.total_cents, invoice_date: ex.invoice_date, created_at: '2026-10-07T13:00:00Z', extracted: ex, ...over };
};
const promote = (exc, opts) => {
  db.ap_intake_exceptions = [exc];
  return promoteException(exc.id, { resolvedBy: 'Celina', ...opts }, { supabase: fakeClient(), intake: intakeModule, now: NOW });
};

t('card: unchanged dates without confirmation are held again with the specific reason; nothing loads', async () => {
  const before = db.ap_invoices.length;
  const out = await promote(heldException('exc-same'), { invoiceDate: '2024-08-14' });
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.error, 'date_check');
  assert.match(out.detail, /^Date check: invoice date 2024-08-14 is 2 years before the bill was received \(2026-10-07\).*Correct the dates from the bill, or tick "dates are right as shown"\.$/);
  assert.strictEqual(db.ap_invoices.length, before);
});

t('card: a person corrects all four dates from the bill; re-checked, loaded, the change noted, the reader output kept', async () => {
  const exc = heldException('exc-fix');
  const out = await promote(exc, { invoiceDate: '2026-08-14', dueDate: '2026-09-09', servicePeriodStart: '2026-07-02', servicePeriodEnd: '2026-08-04' });
  assert.strictEqual(out.ok, true, JSON.stringify(out));
  assert.strictEqual(out.outcome, 'loaded');
  const inv = db.ap_invoices.find((r) => r.id === out.invoice_id);
  assert.deepStrictEqual([inv.invoice_date, inv.due_date, inv.service_period_start, inv.service_period_end], ['2026-08-14', '2026-09-09', '2026-07-02', '2026-08-04']);
  assert.match(inv.notes, /corrected invoice date 2024-08-14 -> 2026-08-14, due date 2024-09-09 -> 2026-09-09, service start 2024-07-02 -> 2026-07-02, service end 2024-08-04 -> 2026-08-04 \(the date check held the bill/);
  const kept = db.ap_intake_exceptions[0].extracted;
  assert.deepStrictEqual(kept.raw_extracted, RAW_29748370, 'the reader output stays on the exception');
  assert.strictEqual(kept.invoice_date, '2024-08-14', 'the stored extraction is not overwritten');
  assert.deepStrictEqual(kept.staff_entered.corrected.invoice_date, ['2024-08-14', '2026-08-14']);
  assert.strictEqual(kept.staff_entered.by, 'Celina');
});

t('card: a correction that is still implausible is held again (corrections are checked, not trusted)', async () => {
  const out = await promote(heldException('exc-half'), { invoiceDate: '2026-08-14' });   // due + service still 2024
  assert.strictEqual(out.error, 'date_check');
  assert.match(out.detail, /due date 2024-09-09 is before the invoice date 2026-08-14/);
});

t('card: "dates are right as shown" loads the bill as read, and says so on the payable', async () => {
  const out = await promote(heldException('exc-ok'), { datesConfirmed: true });
  assert.strictEqual(out.ok, true, JSON.stringify(out));
  const inv = db.ap_invoices.find((r) => r.id === out.invoice_id);
  assert.strictEqual(inv.invoice_date, '2024-08-14');
  assert.match(inv.notes, /dates confirmed as shown after the date check held the bill/);
});

t('card: a non-date-check exception still cannot type over a date the bill prints (#86 rule kept)', async () => {
  const out = await promote(heldException('exc-other', { reason: 'no_vendor', extracted: { ...correct29748370() } }), { invoiceDate: '2026-08-15' });
  assert.strictEqual(out.error, 'date_already_read');
});

t('card: a correction that is not a date is refused', async () => {
  const out = await promote(heldException('exc-bad'), { invoiceDate: '2026-08-14', dueDate: '09/09/26' });
  assert.strictEqual(out.error, 'bad_date');
});

t('datesConfirmed (a person confirmed the dates as shown) loads the bill', async () => {
  const out = await commitInvoice({ extracted: { ...extracted29748370(), invoice_number: '29748370-confirmed' }, vendorId: 'v-confirm', communityId: WATERVIEW,
    sha256: 'sha-confirm', storagePath: 'c.pdf', intakeMethod: 'email', sourceRef: 'email:c', receivedAt: RECEIVED, datesConfirmed: true });
  assert.strictEqual(out.outcome, 'loaded');
});

// ---- near-duplicate statement (pure) ----------------------------------------
const FIRST_30358853 = { id: 'ap-30358853', vendor_id: MUD143, community_id: WATERVIEW, vendor_invoice_number: '30358853', account_number: '99693',
  invoice_date: '2026-09-14', total_cents: 556220, amount_paid_cents: 556220, status: 'paid', dedup_status: 'unique',
  service_period_start: '2026-08-04', service_period_end: '2026-09-02' };
const PAGE3_MISREAD = { invoiceNumber: '300388853', accountNumber: '99893', totalCents: 556220, invoiceDate: '2026-09-14' };

t('edit distance: the two misreads are each within 2 edits', () => {
  assert.strictEqual(editDistance('99893', '99693'), 1);
  assert.strictEqual(editDistance('300388853', '30358853'), 2);
  assert.strictEqual(editDistance('41207', '99693'), 3, 'capped at cap+1');
});

t('30358853 page-3 misread (99893 / 300388853) matches the first copy', () => {
  const reason = nearDuplicateStatement(PAGE3_MISREAD, FIRST_30358853);
  assert.match(reason, /^Same vendor \+ amount \(\$5562\.20\) \+ date \(2026-09-14\), account 99893 vs 99693, invoice # 300388853 vs 30358853: likely the same statement read twice$/);
});

t('NOT a near duplicate: different date, different total, unrelated ids, or short ids one edit apart', () => {
  assert.strictEqual(nearDuplicateStatement({ ...PAGE3_MISREAD, invoiceDate: '2026-10-14' }, FIRST_30358853), null);
  assert.strictEqual(nearDuplicateStatement({ ...PAGE3_MISREAD, totalCents: 556120 }, FIRST_30358853), null);
  assert.strictEqual(nearDuplicateStatement({ invoiceNumber: '31877410', accountNumber: '41207', totalCents: 556220, invoiceDate: '2026-09-14' }, FIRST_30358853), null);
  assert.strictEqual(nearDuplicateStatement({ invoiceNumber: '13', accountNumber: null, totalCents: 1000, invoiceDate: '2026-09-14' },
    { vendor_invoice_number: '12', account_number: null, total_cents: 1000, invoice_date: '2026-09-14' }), null);
});

// ---- findDuplicates / commitInvoice: held, never silently loaded -------------
t('findDuplicates: the misread copy is a SUSPECTED (high) duplicate of 30358853', async () => {
  db.ap_invoices.push(clone(FIRST_30358853));
  const r = await findDuplicates(fakeClient(), { communityId: WATERVIEW, vendorId: MUD143, ...PAGE3_MISREAD, fileSha256: 'sha-other',
    servicePeriodStart: '2026-08-04', servicePeriodEnd: '2026-09-02' });
  assert.strictEqual(r.verdict, 'suspected');
  assert.strictEqual(r.matches[0].invoice.id, 'ap-30358853');
  assert.strictEqual(r.matches[0].confidence, 'high');
});

t('a recurring same-amount bill on a different date with its own number stays unique (Star Protection shape)', async () => {
  const r = await findDuplicates(fakeClient(), { communityId: WATERVIEW, vendorId: MUD143, invoiceNumber: '30358854', accountNumber: '99693',
    totalCents: 556220, invoiceDate: '2026-10-14', servicePeriodStart: '2026-09-02', servicePeriodEnd: '2026-10-01' });
  assert.strictEqual(r.verdict, 'unique');
});

t('commitInvoice: the misread copy is held on_hold as a suspected duplicate, with no accrual; the first copy is untouched', async () => {
  const firstBefore = clone(db.ap_invoices.find((r) => r.id === 'ap-30358853'));
  const out = await commitInvoice({
    extracted: { vendor_name: 'Fort Bend County M.U.D. No. 143', invoice_number: '300388853', account_number: '99893',
      invoice_date: '2026-09-14', due_date: '2026-10-09', service_period_start: '2026-08-04', service_period_end: '2026-09-02',
      total_cents: 556220, subtotal_cents: 556220, tax_cents: 0, auto_draft: true,
      line_items: [{ description: 'Water / sewer service', amount: 5562.20 }] },
    vendorId: MUD143, communityId: WATERVIEW, sha256: 'sha-page3', storagePath: 'p3.pdf', intakeMethod: 'email', sourceRef: 'email:mud143-sep', receivedAt: '2026-09-16T15:00:00Z' });
  assert.strictEqual(out.outcome, 'held_suspected_duplicate');
  assert.strictEqual(out.duplicate_of, 'ap-30358853');
  assert.strictEqual(out.posting_journal_entry_id, null, 'no accrual posted for a held bill');
  const inv = db.ap_invoices.find((r) => r.id === out.invoice_id);
  assert.strictEqual(inv.status, 'on_hold');
  assert.strictEqual(inv.dedup_status, 'suspected_duplicate');
  assert.strictEqual(inv.needs_review, true);
  assert.match(inv.notes, /possible duplicate of AP ap-30358853 .*likely the same statement read twice\. Held for review\./);
  assert.deepStrictEqual(db.ap_invoices.find((r) => r.id === 'ap-30358853'), firstBefore, 'existing record not changed');
});

(async () => {
  let failed = 0;
  for (const { name, fn } of results) {
    try { await fn(); console.log('PASS ', name); } catch (e) { failed++; console.log('FAIL ', name, '\n   ', e.stack.split('\n').slice(0, 4).join('\n   ')); }
  }
  console.log(failed ? `\n${failed} FAILED` : '\nall AP intake date + near-duplicate checks passed');
  process.exitCode = failed ? 1 : 0;
})();
