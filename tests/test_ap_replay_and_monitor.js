// ============================================================================
// tests/test_ap_replay_and_monitor.js  (Issue #14 follow-ups)
// ----------------------------------------------------------------------------
// 1. The monitoring gap: the 9/29 Waterview MUD bill ("MUD Invoice WV", file
//    "MUD $150.80.pdf", Fort Bend MUD 143) was labeled `internal`, never asked
//    for payment, and so was not counted as a bill anywhere. Pinned here: the
//    straggler check now catches it, and live intake turns a "not an invoice"
//    file from a vendor we pay into a Payables exception.
// 2. scripts/ap_replay_emails.js: explicit ids only, dry run by default,
//    preconditions, idempotent skips, before/after diff, invariants.
// 3. Autopay: a check can never be recorded against an auto-drafted bill, and
//    a held convenience fee is not added.
// No network, no database: in-memory fakes only.
// ============================================================================
require('dotenv').config({ quiet: true });
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { parseArgs, preconditions, diffSnapshots, invariantViolations } = require('../lib/ap/replay_emails');
const { billSignalFrom, isSuspectedMissedBill, looksLikeBillText, matchKnownVendor, annotateNotInvoiceResults } = require('../lib/ap/bill_signal');
const { stragglerReason, isStraggler } = require('../lib/ap/stragglers');
const { decideOutcome, intakeRecord } = require('../lib/ap/email_intake_outcome');

const tests = []; const check = (n, fn) => tests.push([n, fn]);
const src = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const ID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const NOW = new Date('2026-10-01T12:00:00Z');

// The real shape of the missed email (no personal data).
const MUD_WV = {
  id: ID(1), graph_id: 'g-mud', persona: 'emma', direction: 'inbound', has_attachments: true,
  classification: 'internal', triage_status: 'new', subject: 'MUD Invoice WV',
  body_preview: 'Hi Emma,\r\n\r\nPlease add a $1 to this invoice', received_at: '2026-09-29T16:45:00Z',
  extracted: { amounts: ['$1'], vendor_name: '', account_number: null, community_hint: 'WV' },
};
const MUD_FILE_EXTRACT = { vendor_name: 'Fort Bend County M.U.D. No. 143', invoice_number: '30358920', total_cents: 15080, account_number: '123285', invoice_date: '2026-09-14', looks_like_invoice: false };

// ---------------------------------------------------------------- monitoring gap
check('straggler: the Waterview MUD email (labeled "internal", no payment ask) IS flagged, with a reason', () => {
  const r = stragglerReason(MUD_WV, { now: NOW, attachmentNames: { [MUD_WV.id]: ['MUD $150.80.pdf'] } });
  assert.ok(r && /reads like a bill/.test(r) && /internal/.test(r), r);
});
check('straggler: subject alone ("MUD Invoice WV") is enough when no outcome was recorded', () => {
  assert.ok(isStraggler(MUD_WV, { now: NOW }));
});
check('straggler: a non-bill internal email with attachments is NOT flagged (no false alarm)', () => {
  assert.strictEqual(stragglerReason({ ...MUD_WV, subject: 'Post Transfer - Waterview Estates', body_preview: 'transfer done' }, { now: NOW, attachmentNames: { [MUD_WV.id]: ['September 17 OP to Debit Card Transfer.pdf'] } }), null);
});
check('straggler: outcome not_a_bill but a file reads as a bill from a vendor we pay -> still flagged', () => {
  const m = { ...MUD_WV, subject: 'fyi', extracted: { ap_intake: { outcome: 'not_a_bill', files: [{ file: 'MUD $150.80.pdf', result: 'not_an_invoice', bill_signal: { known_vendor_id: 'v143', total_cents: 15080 } }] } } };
  assert.ok(/vendor we pay/.test(stragglerReason(m, { now: NOW })));
});
check('straggler: outcome not_a_bill with no bill signal stays closed', () => {
  const m = { ...MUD_WV, extracted: { ap_intake: { outcome: 'not_a_bill', files: [{ file: 'photo.jpg', result: 'not_an_invoice', bill_signal: { known_vendor_id: null } }] } } };
  assert.strictEqual(stragglerReason(m, { now: NOW }), null);
});
check('straggler: payable / exception on file or a human close still clears it', () => {
  assert.strictEqual(stragglerReason(MUD_WV, { now: NOW, payableRefs: new Set(['email:g-mud']) }), null);
  assert.strictEqual(stragglerReason(MUD_WV, { now: NOW, exceptionEmailIds: new Set([MUD_WV.id]) }), null);
  assert.strictEqual(stragglerReason({ ...MUD_WV, triage_status: 'dismissed' }, { now: NOW }), null);
});
check('looksLikeBillText: bill words in subject or file name; not in ordinary mail', () => {
  assert.ok(looksLikeBillText('MUD Invoice WV'));
  assert.ok(looksLikeBillText('fwd', ['NRG_Statement_Sept.pdf']));
  assert.ok(looksLikeBillText('Waterview', ['Past-Due-Notice.pdf']));
  assert.ok(!looksLikeBillText('Board meeting photos', ['IMG_2201.jpg']));
});
check('live intake: a "not an invoice" file from a vendor we pay becomes a Payables exception, not not_a_bill', () => {
  const r = { file: 'MUD $150.80.pdf', kind: 'pdf', outcome: 'not_an_invoice', _out: { extracted: MUD_FILE_EXTRACT, storage_path: 's', sha256: 'h' },
    bill_signal: { ...billSignalFrom(MUD_FILE_EXTRACT), known_vendor_id: 'v143', known_vendor_name: 'FORT BEND COUNTY M.U.D. No. 143' } };
  assert.ok(isSuspectedMissedBill(r));
  const d = decideOutcome({ filesSeen: 1, results: [r], classification: 'internal' });
  assert.strictEqual(d.outcome, 'exception'); assert.ok(d.handled);
  assert.ok(d.exceptions[0].fromReader, 'carries the stored file + hash');
  assert.ok(/FORT BEND COUNTY M\.U\.D\. No\. 143/.test(d.exceptions[0].reason) && /30358920/.test(d.exceptions[0].reason) && /\$150\.80/.test(d.exceptions[0].reason), d.exceptions[0].reason);
  const rec = intakeRecord(d, { results: [{ ...r, _out: undefined }] });
  assert.strictEqual(rec.files[0].bill_signal.known_vendor_id, 'v143');
});
check('live intake: "not an invoice" from an UNKNOWN vendor stays not_a_bill (a photo is not a bill)', () => {
  const r = { file: 'photo.jpg', outcome: 'not_an_invoice', bill_signal: { vendor_name: 'Someone', total_cents: 500, known_vendor_id: null } };
  assert.strictEqual(decideOutcome({ filesSeen: 1, results: [r], classification: 'internal' }).outcome, 'not_a_bill');
});

// in-memory supabase for matchKnownVendor
function fakeDb(tables, { failOn } = {}) {
  return { from(t) {
    const f = []; let lim = 1e9;
    const q = {
      select() { return q; }, eq(c, v) { f.push((r) => r[c] === v); return q; }, not(c, op, v) { f.push((r) => r[c] !== null && r[c] !== undefined); return q; },
      ilike(c, pat) { const re = new RegExp('^' + pat.split('%').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i'); f.push((r) => re.test(String(r[c] || ''))); return q; },
      or(expr) { const parts = expr.split(',').map((p) => p.split('.')); f.push((r) => parts.some(([c, , pat]) => new RegExp('^' + pat.split('%').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i').test(String(r[c] || '')))); return q; },
      limit(n) { lim = n; return q; },
      then(res, rej) { if (failOn === t) return Promise.resolve({ data: null, error: { message: 'column does not exist' } }).then(res, rej); return Promise.resolve({ data: (tables[t] || []).filter((r) => f.every((p) => p(r))).slice(0, lim), error: null }).then(res, rej); },
    };
    return q;
  } };
}
check('matchKnownVendor: account number stored with spaces/dashes still matches (NRG "24 035 567 - 7")', async () => {
  const db = fakeDb({ ap_invoices: [{ vendor_id: 'nrg', account_number: '24 035 567 - 7', vendors: { name: 'NRG Business' } }] });
  const v = await matchKnownVendor(db, { account_number: '240355677' });
  assert.deepStrictEqual(v, { id: 'nrg', name: 'NRG Business', via: 'account_number' });
});
check('matchKnownVendor: by name, ignoring LLC/punctuation; no false match on a partial name', async () => {
  const db = fakeDb({ ap_invoices: [], vendors: [{ id: 'm143', name: 'FORT BEND COUNTY M.U.D. No. 143' }, { id: 'm162', name: 'FORT BEND COUNTY MUD 162' }] });
  assert.strictEqual((await matchKnownVendor(db, { vendor_name: 'Fort Bend County M.U.D. No. 143' })).id, 'm143');
  assert.strictEqual(await matchKnownVendor(db, { vendor_name: 'Fort Bend County' }), null);
});
check('matchKnownVendor: a broken query THROWS (never reads as "unknown vendor")', async () => {
  await assert.rejects(matchKnownVendor(fakeDb({}, { failOn: 'ap_invoices' }), { account_number: '123285' }), /known-vendor lookup/);
});
check('annotateNotInvoiceResults: only not_an_invoice results are annotated; a lookup failure is logged, not thrown', async () => {
  const results = [{ outcome: 'loaded', _out: {} }, { outcome: 'not_an_invoice', _out: { extracted: MUD_FILE_EXTRACT } }];
  await annotateNotInvoiceResults(fakeDb({}, { failOn: 'ap_invoices' }), results);
  assert.strictEqual(results[0].bill_signal, undefined);
  assert.strictEqual(results[1].bill_signal.known_vendor_id, null);
});

// ---------------------------------------------------------------- replay script checks
check('replay args: ids required, ids must be email ids, max 10, no duplicates, dry run by default', () => {
  assert.ok(/required/.test(parseArgs([]).error));
  assert.ok(/not an email id/.test(parseArgs(['--ids', 'abc']).error));
  assert.ok(/at most 10/.test(parseArgs(['--ids', Array.from({ length: 11 }, (_, i) => ID(i + 1)).join(',')]).error));
  assert.ok(/duplicate/.test(parseArgs(['--ids', `${ID(1)},${ID(1)}`]).error));
  const a = parseArgs(['--ids', `${ID(1)},${ID(2)}`]);
  assert.strictEqual(a.apply, false); assert.deepStrictEqual(a.ids, [ID(1), ID(2)]);
  assert.strictEqual(parseArgs(['--ids', ID(1), '--apply']).apply, true);
});
check('replay args: --fee-hold may only name ids being replayed', () => {
  assert.ok(/not in --ids/.test(parseArgs(['--ids', ID(1), '--fee-hold', ID(2)]).error));
  assert.ok(parseArgs(['--ids', ID(1), '--fee-hold', ID(1)]).feeHold.has(ID(1)));
});
const OK_EMAIL = { id: ID(1), persona: 'emma', direction: 'inbound', has_attachments: true, graph_id: 'g1', extracted: {} };
check('replay preconditions: refuses non-Emma, outbound, no attachments, no mailbox id', () => {
  assert.strictEqual(preconditions(null, {}).ok, false);
  assert.ok(preconditions({ ...OK_EMAIL, persona: 'amanda' }, {}).problems[0].includes('not an Emma'));
  assert.strictEqual(preconditions({ ...OK_EMAIL, direction: 'outbound' }, {}).ok, false);
  assert.strictEqual(preconditions({ ...OK_EMAIL, has_attachments: false }, {}).ok, false);
  assert.strictEqual(preconditions({ ...OK_EMAIL, graph_id: null }, {}).ok, false);
});
check('replay preconditions: an email auto-recorded as a payment is REFUSED (the Cinco MUD $1.00 entries are gated)', () => {
  const p = preconditions({ ...OK_EMAIL, extracted: { auto_gl: { je_id: 'je1', amount_cents: 100 } } }, {});
  assert.strictEqual(p.ok, false); assert.ok(/reversed first/.test(p.problems[0]));
});
check('replay preconditions: already done -> idempotent skip (payable on file, or outcome payable/duplicate)', () => {
  assert.ok(/payable already exists/.test(preconditions(OK_EMAIL, { payables: [{ id: 'p1' }] }).skip));
  assert.ok(/already recorded as duplicate/.test(preconditions({ ...OK_EMAIL, extracted: { ap_intake: { outcome: 'duplicate' } } }, {}).skip));
  const fresh = preconditions(OK_EMAIL, { payables: [] });
  assert.ok(fresh.ok && !fresh.skip);
  // an existing exception does NOT block: the replay reuses it (exception de-dup)
  assert.ok(!preconditions({ ...OK_EMAIL, extracted: { ap_intake: { outcome: 'exception' } } }, { payables: [] }).skip);
});
// Ed 2026-10-01: Eaglewood's financials are kept in Vantaca (system of record),
// never converted. Excluded from AP backfill and reconciliation; nothing changes.
const EAGLEWOOD = { id: 'c-ew', name: 'Eaglewood', financials_active: false, books_of_record: 'vantaca' };
check('books scope: a community whose books are kept in Vantaca is outside trustEd books; converted ones are not', () => {
  const { outsideTrustedBooks } = require('../lib/ap/books_scope');
  assert.ok(/kept in Vantaca, not trustEd/.test(outsideTrustedBooks(EAGLEWOOD)));
  assert.ok(outsideTrustedBooks({ name: 'X', financials_active: false }));
  assert.strictEqual(outsideTrustedBooks({ name: 'Waterview Estates', financials_active: true, books_of_record: 'trusted' }), null);
  assert.strictEqual(outsideTrustedBooks({ name: 'Waterview Estates', financials_active: true, books_of_record: null }), null);
  assert.strictEqual(outsideTrustedBooks(null), null);
});
check('replay preconditions: an Eaglewood email is REFUSED (no AP backfill for books kept in Vantaca)', () => {
  const p = preconditions({ ...OK_EMAIL, community_id: 'c-ew' }, { payables: [] }, EAGLEWOOD);
  assert.strictEqual(p.ok, false); assert.ok(/Vantaca/.test(p.problems[0]));
  assert.ok(preconditions({ ...OK_EMAIL, community_id: 'c-wv' }, { payables: [] }, { name: 'Waterview Estates', financials_active: true }).ok);
});
check('straggler: an Eaglewood bill email is not listed (reconciliation excludes books kept in Vantaca)', () => {
  const m = { ...MUD_WV, community_id: 'c-ew', classification: 'vendor_financial', subject: 'ENGIE bill past due' };
  assert.strictEqual(stragglerReason(m, { now: NOW, excludedCommunityIds: new Set(['c-ew']) }), null);
  assert.ok(stragglerReason(m, { now: NOW }), 'listed when the community is in trustEd books');
});
check('wiring: the replay script and the straggler finder both load the books scope', () => {
  assert.ok(/preconditions\(m, before, m && m\.community_id \? comms\.get\(m\.community_id\)/.test(src('scripts/ap_replay_emails.js')));
  assert.ok(/excludedCommunityIds = new Set\(\(comms \|\| \[\]\)\.filter\(\(c\) => outsideTrustedBooks\(c\)\)/.test(src('lib/ap/stragglers.js')));
});
check('replay diff: created vs reused records, triage and outcome changes', () => {
  const d = diffSnapshots({ payables: [], exceptions: [{ id: 'e1' }], triage_status: 'new', ap_intake_outcome: null },
    { payables: [{ id: 'p1', status: 'awaiting_approval' }], exceptions: [{ id: 'e1' }, { id: 'e2' }], triage_status: 'handled', ap_intake_outcome: 'payable' });
  assert.deepStrictEqual(d.payables_created.map((x) => x.id), ['p1']);
  assert.deepStrictEqual(d.exceptions_created.map((x) => x.id), ['e2']);
  assert.deepStrictEqual(d.exceptions_reused.map((x) => x.id), ['e1']);
  assert.deepStrictEqual(d.triage, { from: 'new', to: 'handled' });
  assert.deepStrictEqual(d.outcome, { from: null, to: 'payable' });
});
check('replay invariants: never approved/paid; an autopay vendor\'s bill must carry the autopay flag', () => {
  const ok = invariantViolations({ payables_created: [{ id: 'p1', status: 'awaiting_approval', vendor_id: 'nrg', is_ach_autopay: true }] }, { autopayVendorIds: new Set(['nrg']) });
  assert.deepStrictEqual(ok, []);
  assert.ok(invariantViolations({ payables_created: [{ id: 'p2', status: 'approved' }] })[0].includes('never approve'));
  assert.ok(invariantViolations({ payables_created: [{ id: 'p3', status: 'awaiting_approval', vendor_id: 'nrg', is_ach_autopay: false }] }, { autopayVendorIds: new Set(['nrg']) })[0].includes('pay it twice'));
});

// ---------------------------------------------------------------- shared intake path
function storageDb(archived) {
  const updates = [];
  return { updates, from(t) {
    const q = { select() { return q; }, eq() { return q; }, update(u) { updates.push({ t, u }); return q; },
      then(res) { return Promise.resolve(t === 'email_attachments' ? { data: archived.map((a) => ({ filename: a.name, mime: a.mime, storage_path: a.name })), error: null } : { data: null, error: null }).then(res); } };
    return q;
  }, storage: { from() { return { download: async (p) => { const a = archived.find((x) => x.name === p); return { data: { arrayBuffer: async () => a.buf }, error: null }; } }; } } };
}
check('shared intake: the MAILBOX copy is used first (it marks inline logos); archive only when the mailbox fails', async () => {
  const { loadBillAttachments } = require('../lib/ap/email_bill_intake');
  const live = [{ name: 'image.png', isInline: true, buffer: Buffer.from('logo') }, { name: 'bill.pdf', buffer: Buffer.from('%PDF') }];
  const got = await loadBillAttachments({ id: 'm', graph_id: 'g', mailbox: 'emma@x' }, { supabase: storageDb([]), fetchBillAttachments: async () => live });
  assert.strictEqual(got, live);
});
check('shared intake: archive fallback treats Outlook signature images (image001.png, small) as inline, never as bills', async () => {
  const { loadBillAttachments } = require('../lib/ap/email_bill_intake');
  const db = storageDb([{ name: 'image001.png', mime: 'image/png', buf: Buffer.alloc(5000) }, { name: 'MUD $150.80.pdf', mime: 'application/pdf', buf: Buffer.from('%PDF') }, { name: 'IMG_4412.jpg', mime: 'image/jpeg', buf: Buffer.alloc(5000) }]);
  const got = await loadBillAttachments({ id: 'm', graph_id: 'g', mailbox: 'emma@x' }, { supabase: db, fetchBillAttachments: async () => { throw new Error('404'); } });
  assert.deepStrictEqual(got.map((a) => [a.name, a.isInline]), [['image001.png', true], ['MUD $150.80.pdf', false], ['IMG_4412.jpg', false]]);
});
check('shared intake: fee hold reaches autoIntake; outcome is recorded on the email; nothing approves or pays', async () => {
  const { intakeBillEmail } = require('../lib/ap/email_bill_intake');
  const calls = [];
  const db = storageDb([]);
  const out = await intakeBillEmail({ ...MUD_WV, mailbox: 'emma@x', body_full: MUD_WV.body_preview }, { convenienceFeeHold: true, atts: [{ name: 'MUD $150.80.pdf', contentType: 'application/pdf', buffer: Buffer.from('%PDF-1.4') }] }, {
    supabase: db,
    autoIntake: async (a) => { calls.push(a); return { outcome: 'loaded', invoice_id: 'inv1' }; },
    recordException: async () => ({ ok: true, id: 'e1' }),
    fetchBillAttachments: async () => [],
  });
  assert.strictEqual(calls.length, 1); assert.strictEqual(calls[0].convenienceFeeHold, true);
  assert.strictEqual(calls[0].sourceRef, 'email:g-mud');
  assert.strictEqual(out.decision.outcome, 'payable');
  const upd = db.updates.find((x) => x.t === 'email_messages');
  assert.ok(upd && upd.u.extracted.ap_intake.outcome === 'payable' && upd.u.triage_status === 'handled');
  assert.ok(!/approveInvoice|recordPayment|markPaid/.test(src('lib/ap/email_bill_intake.js')));
});
check('wiring: /sweep-inbox and the replay script use the ONE shared path; live ingest annotates bill signals', () => {
  const sweep = src('api/ap_intake.js');
  assert.ok(sweep.includes("require('../lib/ap/email_bill_intake')") && sweep.includes('intakeBillEmail(m)'));
  assert.ok(!/autoIntake\(\{ buffer: f\.buffer/.test(sweep.slice(sweep.indexOf("'/sweep-inbox'"), sweep.indexOf("'/exceptions/:id/file'"))), 'sweep no longer has its own copy');
  assert.ok(src('scripts/ap_replay_emails.js').includes('intakeBillEmail(m, { convenienceFeeHold'));
  const g = src('lib/email/graph_ingest.js');
  assert.ok(g.indexOf('annotateNotInvoiceResults(supabase, results)') > 0 && g.indexOf('annotateNotInvoiceResults(supabase, results)') < g.indexOf('const decision = decideOutcome'));
});
check('replay script: dry run is the default and turns off telemetry; --apply is required to write', () => {
  const s = src('scripts/ap_replay_emails.js');
  assert.ok(/if \(!args\.apply\) process\.env\.AI_TELEMETRY = 'off'/.test(s));
  assert.ok(/if \(!args\.apply\) \{\s*entry\.dry_run = await dryRun\(m, /.test(s));
});

// ---------------------------------------------------------------- duplicate guard + dry-run parity
// The NRG replay stop (2026-10-01): rule 2b called two different invoice numbers
// a "certain" duplicate because the service periods overlapped. findDuplicates is
// run here end to end against an in-memory ap_invoices with the REAL shapes.
function apDb(rows) {
  return { from() {
    const f = []; let lim = 1e9;
    const q = {
      select() { return q; }, eq(c, v) { f.push((r) => r[c] === v); return q; }, neq(c, v) { f.push((r) => r[c] !== v); return q; },
      order() { return q; }, limit(n) { lim = n; return q; },
      then(res, rej) { return Promise.resolve({ data: rows.filter((r) => f.every((p) => p(r))).slice(0, lim), error: null }).then(res, rej); },
    };
    return q;
  } };
}
const WV = 'c-wv';
const NRG_AUG = { id: 'nrg-aug', community_id: WV, vendor_id: 'nrg', vendor_invoice_number: '302 008 234 841', account_number: '24 035 567 - 7', invoice_date: '2026-08-18', total_cents: 21731, status: 'paid', service_period_start: '2026-07-16', service_period_end: '2026-08-18', file_sha256: 'h-aug' };
const MUD_AUG = { id: 'mud-aug', community_id: WV, vendor_id: 'm143', vendor_invoice_number: '29748558', account_number: '123285', invoice_date: '2026-08-14', total_cents: 14100, status: 'paid', service_period_start: '2026-07-03', service_period_end: '2026-08-14', file_sha256: 'h-maug' };
const NRG_SEPT = { communityId: WV, vendorId: 'nrg', invoiceNumber: '302 008 342 079', totalCents: 9134, invoiceDate: '2026-09-17', fileSha256: 'h-sept', accountNumber: '24 035 567 - 7', servicePeriodStart: '2026-08-16', servicePeriodEnd: '2026-09-15' };
const MUD_SEPT = { communityId: WV, vendorId: 'm143', invoiceNumber: '30358920', totalCents: 15080, invoiceDate: '2026-09-14', fileSha256: 'h-msept', accountNumber: '123285', servicePeriodStart: '2026-08-05', servicePeriodEnd: '2026-09-02' };
const { findDuplicates } = require('../lib/ap/dedup');
check('dedup (real shape): NRG Waterview Sept vs Aug, overlapping periods, different invoice #s -> unique', async () => {
  const r = await findDuplicates(apDb([NRG_AUG]), NRG_SEPT);
  assert.strictEqual(r.verdict, 'unique', JSON.stringify(r.matches.map((m) => m.reason)));
});
check('dedup (real shape): Fort Bend MUD 143 Sept vs Aug -> unique (fee held or not)', async () => {
  assert.strictEqual((await findDuplicates(apDb([MUD_AUG]), MUD_SEPT)).verdict, 'unique');
  assert.strictEqual((await findDuplicates(apDb([MUD_AUG]), { ...MUD_SEPT, totalCents: 15180 })).verdict, 'unique');
});
check('dedup: the SAME invoice # is still a certain duplicate', async () => {
  const r = await findDuplicates(apDb([NRG_AUG]), { ...NRG_SEPT, invoiceNumber: '302-008-234-841' });
  assert.strictEqual(r.verdict, 'certain'); assert.ok(/invoice #/.test(r.matches[0].reason));
});
check('dedup: the same FILE is still a certain duplicate', async () => {
  assert.strictEqual((await findDuplicates(apDb([NRG_AUG]), { ...NRG_SEPT, fileSha256: 'h-aug' })).verdict, 'certain');
});
check('dedup: conservative when an invoice # is missing: same account + overlapping period stays certain', async () => {
  const r = await findDuplicates(apDb([NRG_AUG]), { ...NRG_SEPT, invoiceNumber: null });
  assert.strictEqual(r.verdict, 'certain'); assert.ok(/service period/.test(r.matches[0].reason));
  const r2 = await findDuplicates(apDb([{ ...NRG_AUG, vendor_invoice_number: null }]), NRG_SEPT);
  assert.strictEqual(r2.verdict, 'certain');
});
check('predictOutcome: certain -> BLOCKED (names the invoice); suspected -> held; unique -> payable; fee hold -> needs review', () => {
  const { predictOutcome } = require('../lib/ap/replay_emails');
  assert.ok(/^BLOCKED as a duplicate of nrg-aug/.test(predictOutcome({ dup: { verdict: 'certain', matches: [{ invoice: { id: 'nrg-aug' }, reason: 'Same account' }] } })));
  assert.ok(/suspected duplicate/.test(predictOutcome({ dup: { verdict: 'suspected', matches: [{ reason: 'amount' }] } })));
  assert.strictEqual(predictOutcome({ dup: { verdict: 'unique', matches: [] } }), 'payable, awaiting approval');
  assert.strictEqual(predictOutcome({ dup: { verdict: 'unique', matches: [] }, feeHeld: true }), 'payable, awaiting approval, needs review (convenience fee held)');
  assert.ok(/Payables exception \(vendor not on file\) · reuses the exception/.test(predictOutcome({ missing: ['vendor not on file'], exceptionReuse: 'the exception email 003c522b creates in this run' })));
});
check('dry-run PARITY: the script calls the SAME findDuplicates as intake, with the fee intake would add (0 when held)', () => {
  const s = src('scripts/ap_replay_emails.js');
  assert.ok(/require\('\.\.\/lib\/ap\/dedup'\)\.findDuplicates\(supabase, \{/.test(s));
  for (const k of ['communityId: community.id', 'vendorId: (vendor && vendor.id) || null', 'invoiceNumber: x.invoice_number', 'totalCents: x.total_cents + feeAppliedCents', 'fileSha256: sha', 'servicePeriodStart', 'servicePeriodEnd']) assert.ok(s.includes(k), k);
  assert.ok(/feeAppliedCents = opts\.feeHold \? 0 : feeCents/.test(s));
  // intake applies the fee before dedup the same way
  const i = src('lib/ap/intake.js');
  assert.ok(i.indexOf('convenienceFeeHold) {') < i.indexOf('await findDuplicates(supabase, {'));
});
check('dry-run PARITY: the second petting-zoo forward is predicted to reuse the first one\'s exception (in-run de-dup)', () => {
  const s = src('scripts/ap_replay_emails.js');
  assert.ok(/opts\.runExceptions\.has\(runKey\)/.test(s) && /opts\.runExceptions\.set\(runKey, m\.id\)/.test(s));
});
check('no new payment or approval actions in the dedup / replay code', () => {
  for (const f of ['lib/ap/dedup.js', 'lib/ap/replay_emails.js', 'scripts/ap_replay_emails.js', 'lib/ap/email_bill_intake.js']) {
    assert.ok(!/approveInvoice|recordPayment|markPaid|mark-paid|createCheck|check_run/.test(src(f)), f);
  }
});

// ---------------------------------------------------------------- autopay + fee hold
check('autopay: a CHECK cannot be recorded against an auto-drafted bill (no second payment)', async () => {
  const sbPath = require.resolve('@supabase/supabase-js'); const enPath = require.resolve('../lib/accounting/ap_engine');
  const saved = [require.cache[sbPath], require.cache[enPath]];
  const inv = { id: 'i1', vendor_id: 'nrg', vendor_invoice_number: '302 008 342 079', is_ach_autopay: true, invoice_date: '2026-09-17' };
  // The vendor has a W-9 on file, so the W-9 gate passes and the AUTOPAY guard is what's tested.
  const vendor = { id: 'nrg', name: 'NRG Business', w9_on_file: true, is_mud: false };
  const fake = () => ({ from: (t) => { const q = { select() { return q; }, in() { return Promise.resolve({ data: [t === 'vendors' ? vendor : inv], error: null }); }, eq() { return q; } }; return q; } });
  require.cache[sbPath] = { id: sbPath, filename: sbPath, loaded: true, exports: { createClient: fake } };
  delete require.cache[enPath];
  try {
    const { recordPayment } = require('../lib/accounting/ap_engine');
    await assert.rejects(recordPayment({ community_id: 'c', vendor_id: 'v', amount_cents: 9134, payment_date: '2026-10-02', payment_method: 'check', applications: [{ invoice_id: 'i1', applied_cents: 9134 }] }),
      (e) => e.code === 'invalid_state' && /autopay_invoice_not_paid_by_check/.test(e.message));
    // recording the draft itself (ACH) is not blocked by this guard
    await recordPayment({ community_id: 'c', vendor_id: 'v', amount_cents: 9134, payment_date: '2026-10-05', payment_method: 'ach', applications: [{ invoice_id: 'i1', applied_cents: 9134 }] })
      .catch((e) => assert.ok(!/autopay_invoice_not_paid_by_check/.test(e.message), e.message));
  } finally {
    if (saved[0]) require.cache[sbPath] = saved[0]; else delete require.cache[sbPath];
    if (saved[1]) require.cache[enPath] = saved[1]; else delete require.cache[enPath];
  }
});
check('fee hold: the vendor convenience fee is NOT added and the bill is forced to review with a note', () => {
  const s = src('lib/ap/intake.js');
  assert.ok(/if \(cents > 0 && convenienceFeeHold\) \{\s*forceReview = true;/.test(s));
  assert.ok(/Convenience fee NOT applied/.test(s));
  assert.ok(/convenienceFeeHold = false[,}]/.test(s) && /staffGlSplit, convenienceFeeHold[,}]/.test(s), 'autoIntake passes it to commitInvoice');
  // the held path must run before applyConvenienceFee
  assert.ok(s.indexOf('convenienceFeeHold) {') < s.indexOf("applyConvenienceFee(extracted, { cents, label }, 'line_items')"));
});

(async () => {
  let pass = 0, fail = 0;
  console.log('AP replay + monitoring follow-ups (Issue #14)');
  for (const [n, fn] of tests) { try { await fn(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n      ' + e.message); } }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
