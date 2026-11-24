// ============================================================================
// tests/test_acc_reconsideration.js  (Ed 2026-11-24, migration 576)
// ----------------------------------------------------------------------------
// Supplemental evidence, reconsideration and revised decisions on a decided ACC
// application; replies about a decided application never become new ones.
// In-memory store. The database guarantees (append-only evidence, owner-approved
// versions, the original locked) are proven in tests/sql/576_acc_revised_e2e.mjs.
// Scar: WAT-ARC-2026-0043 (a swatch sent after the denial became two new
// applications, one per mailbox, because only OPEN cases were matched).
// ============================================================================
require('dotenv').config({ quiet: true });
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const R = require('../lib/acc/reconsideration');
const M = require('../lib/acc/match_decided');
const E = require('../lib/acc/effective');
const tests = []; const check = (n, fn) => tests.push([n, fn]);
const src = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

function store(seed = {}, { failInsert = {}, failUpload = null } = {}) {
  const T = { acc_decisions: [], acc_finalizations: [], acc_case_supplements: [], acc_reconsiderations: [], email_messages: [], email_attachments: [], finalized_record_archive: [], interactions: [], communities: [], outbound_email_drafts: [], audit_events: [], community_applications: [], properties: [], ...JSON.parse(JSON.stringify(seed)) };
  const files = new Map(); const writes = []; let n = 0;
  const get = (r, c) => r[c];
  const from = (t) => {
    const f = []; let mode = 'select'; let payload = null; let single = null; let ret = false; let order = null; let lim = null;
    const api = {
      select() { if (mode !== 'select') ret = true; return api; },
      eq(c, v) { f.push((r) => get(r, c) === v); return api; }, in(c, vs) { f.push((r) => vs.includes(get(r, c))); return api; },
      is(c, v) { f.push((r) => (get(r, c) == null ? null : get(r, c)) === v); return api; },
      gt(c, v) { f.push((r) => get(r, c) > v); return api; }, gte(c, v) { f.push((r) => get(r, c) >= v); return api; },
      like(c, v) { const rx = new RegExp('^' + v.replace(/\\(.)/g, '$1').split('%').map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$'); f.push((r) => rx.test(get(r, c) || '')); return api; },
      order(c, o) { order = [c, o && o.ascending === false ? -1 : 1]; return api; }, limit(x) { lim = x; return api; },
      maybeSingle() { single = 'maybe'; return api; }, single() { single = 'one'; return api; },
      insert(p) { mode = 'insert'; payload = p; return api; }, update(p) { mode = 'update'; payload = p; return api; },
      then(res, rej) {
        return Promise.resolve().then(() => {
          if (mode === 'insert') {
            if (failInsert[t]) return { data: null, error: { message: failInsert[t] } };
            if (t === 'acc_case_supplements' && payload.source_ref && T[t].some((r) => r.acc_decision_id === payload.acc_decision_id && r.source_ref === payload.source_ref)) return { data: null, error: { code: '23505', message: 'duplicate key' } };
            const row = { id: `${t}-${++n}`, created_at: new Date().toISOString(), ...payload }; if (t === 'acc_reconsiderations') { row.status = row.status || 'open'; row.opened_at = new Date().toISOString(); }
            T[t].push(row); writes.push([t, 'insert']); return { data: { ...row }, error: null };
          }
          let rows = T[t].filter((r) => f.every((p) => p(r)));
          if (mode === 'update') { rows.forEach((r) => Object.assign(r, payload)); if (rows.length) writes.push([t, 'update', payload]); const out = rows.map((r) => ({ ...r })); return { data: ret ? (single ? out[0] || null : out) : null, error: null }; }
          if (order) rows = rows.slice().sort((a, b) => (a[order[0]] > b[order[0]] ? 1 : -1) * order[1]);
          if (lim != null) rows = rows.slice(0, lim);
          const out = rows.map((r) => ({ ...r }));
          return { data: single ? (out[0] || null) : out, error: null };
        }).then(res, rej);
      },
    };
    return api;
  };
  const storage = { from: () => ({
    async upload(p, b) { if (failUpload && p.includes(failUpload)) return { error: { message: 'storage down' } }; files.set(p, Buffer.from(b)); return { error: null }; },
    async remove(ps) { ps.forEach((p) => files.delete(p)); return {}; },
    async download(p) { return files.has(p) ? { data: { arrayBuffer: async () => files.get(p) } } : { error: { message: 'nf' } }; },
  }) };
  return { T, files, writes, from, storage, download: async (p) => files.get(p) || null };
}
const DEC = { id: 'acc1', management_company_id: 'mc', community_id: 'c1', community_name: 'Riverbend', status: 'decided', decision_type: 'denied', letter_body: 'Dear Pat, the existing color is denied.', decided_at: '2026-11-19T23:00:00Z', decided_by_user_id: null, finalization_id: 'f1', reference_number: 'RIV-ARC-2026-0007', homeowner_name: 'Pat Doe', homeowner_address: '1 Main St, Town, TX', submitter_email: 'pat@example.test', correspondent_emails: ['pat@example.test'], conversation_id: 'AAQk' + 'M'.repeat(50) + 'ALa1hpXMHB1Cp5NCHmvzlgE=', application_pdf_storage_path: 'acc/app.pdf', photo_storage_paths: [], supporting_docs_storage_paths: [], project_summary: 'Garage door repaint' };
const FIN1 = { id: 'f1', acc_decision_id: 'acc1', version: 1, decision_type: 'denied', letter_text: DEC.letter_body, letter_sha256: 'x', finalized_at: '2026-11-19T23:00:00Z' };
const seed = () => ({ acc_decisions: [DEC], acc_finalizations: [FIN1] });
const DL = (db) => db.download;

// ------------------------------------------------------------ evidence
check('evidence is filed on the same application, hashed, and the case row is never written', async () => {
  const db = store(seed()); db.files.set('acc/app.pdf', Buffer.from('FORM'));
  const before = JSON.stringify(db.T.acc_decisions);
  const r = await R.addSupplement(db, { dec: DEC, kind: 'email', sourceRef: 'msg:<a>', files: [{ buffer: Buffer.from('SWATCH'), originalname: 'image0.jpeg', mimetype: 'image/jpeg' }], bodyText: 'Please find the swatch', fromEmail: 'pat@example.test', addedBy: 'Email intake', download: DL(db) });
  assert.ok(r.ok && r.status === 'added' && r.new_documents === 1, JSON.stringify(r));
  const d = db.T.acc_case_supplements[0].documents[0];
  assert.strictEqual(d.sha256, sha(Buffer.from('SWATCH'))); assert.ok(db.files.has(d.path));
  assert.strictEqual(JSON.stringify(db.T.acc_decisions), before);
});
check('the same message twice, and the same file forwarded again, is recorded once', async () => {
  const db = store(seed()); db.files.set('acc/app.pdf', Buffer.from('FORM'));
  const f = [{ buffer: Buffer.from('SWATCH'), originalname: 'a.jpeg', mimetype: 'image/jpeg' }];
  await R.addSupplement(db, { dec: DEC, kind: 'email', sourceRef: 'msg:<a>', files: f, addedBy: 'x', download: DL(db) });
  assert.strictEqual((await R.addSupplement(db, { dec: DEC, kind: 'email', sourceRef: 'msg:<a>', files: f, addedBy: 'x', download: DL(db) })).status, 'exists');
  const fw = await R.addSupplement(db, { dec: DEC, kind: 'email', sourceRef: 'msg:<fw>', files: [...f, { buffer: Buffer.from('FORM'), originalname: 'form.pdf', mimetype: 'application/pdf' }], addedBy: 'x', download: DL(db) });
  assert.strictEqual(fw.new_documents, 0);
  assert.ok(db.T.acc_case_supplements[1].documents.every((d) => d.already_on_case && d.path === null));
  assert.strictEqual(db.T.acc_case_supplements.length, 2);
});
check('a file that cannot be stored files nothing and leaves nothing behind', async () => {
  const db = store(seed(), { failUpload: 'two' });
  const r = await R.addSupplement(db, { dec: DEC, kind: 'upload', files: [{ buffer: Buffer.from('1'), originalname: 'one.jpg', mimetype: 'image/jpeg' }, { buffer: Buffer.from('2'), originalname: 'two.jpg', mimetype: 'image/jpeg' }], addedBy: 'x', download: DL(db) });
  assert.ok(!r.ok && r.httpStatus === 502); assert.strictEqual(db.T.acc_case_supplements.length, 0); assert.strictEqual(db.files.size, 0);
});
check('evidence is refused on an open application, when empty, and without a name', async () => {
  const db = store(seed());
  assert.strictEqual((await R.addSupplement(db, { dec: { ...DEC, status: 'pending_review' }, kind: 'upload', note: 'x', addedBy: 'x', download: DL(db) })).httpStatus, 409);
  assert.strictEqual((await R.addSupplement(db, { dec: DEC, kind: 'upload', addedBy: 'x', download: DL(db) })).httpStatus, 400);
  assert.strictEqual((await R.addSupplement(db, { dec: DEC, kind: 'upload', note: 'x', addedBy: ' ', download: DL(db) })).httpStatus, 400);
});
check('attaching an ingested email brings its archived attachments; another association\'s email is refused', async () => {
  const db = store({ ...seed(), email_messages: [{ id: 'm1', internet_message_id: '<a>', subject: 'Re: swatch', sender_email: 'pat@example.test', body_full: 'swatch attached', received_at: '2026-11-24T19:22:19Z', has_attachments: true, community_id: 'c1' }, { id: 'm2', community_id: 'c2' }, { id: 'm3', community_id: 'c1', has_attachments: true }], email_attachments: [{ email_message_id: 'm1', filename: 'image0.jpeg', mime: 'image/jpeg', storage_path: 'em/0' }] });
  db.files.set('em/0', Buffer.from('SWATCH'));
  const r = await R.addEmailSupplement(db, { dec: DEC, emailId: 'm1', actorId: 'u1', addedBy: 'Staff', download: DL(db) });
  assert.ok(r.ok && r.new_documents === 1); assert.strictEqual(r.supplement.source_ref, 'msg:<a>'); assert.strictEqual(r.supplement.received_at, '2026-11-24T19:22:19Z');
  assert.strictEqual((await R.addEmailSupplement(db, { dec: DEC, emailId: 'm2', addedBy: 'S', download: DL(db) })).httpStatus, 409);
  assert.strictEqual((await R.addEmailSupplement(db, { dec: DEC, emailId: 'm3', addedBy: 'S', download: DL(db) })).httpStatus, 409, 'attachments not archived yet: nothing is filed without them');
});

// ------------------------------------------------------------ reconsideration
const openOne = async (db, dec = DEC) => (await R.openReconsideration(db, { dec, reason: 'swatch received', openedBy: 'Staff' })).reconsideration;
check('one active reconsideration; a reason is required; the earlier decision is snapshotted', async () => {
  const db = store(seed());
  assert.strictEqual((await R.openReconsideration(db, { dec: DEC, reason: ' ', openedBy: 'S' })).httpStatus, 400);
  const a = await R.openReconsideration(db, { dec: DEC, reason: 'swatch', openedBy: 'S' });
  assert.strictEqual(a.reconsideration.prior_finalization_id, 'f1'); assert.strictEqual(a.reconsideration.prior_snapshot.decision_type, 'denied');
  assert.strictEqual((await R.openReconsideration(db, { dec: DEC, reason: 'again', openedBy: 'S' })).status, 'exists');
  assert.strictEqual(db.T.acc_reconsiderations.length, 1);
});
check('a case decided before sealed records can be reconsidered (version 2, nothing superseded)', async () => {
  const legacy = { ...DEC, finalization_id: null };
  const db = store({ acc_decisions: [legacy] });
  const rec = await openOne(db, legacy);
  assert.strictEqual(rec.prior_finalization_id, null); assert.strictEqual(rec.prior_snapshot.sealed, false);
});
const engine = (rec, letter) => ({ runEngine: async (a) => { engine.last = a; return { review: '*** INTERNAL ***\nreview text\n*** END', letter_body: letter }; }, classifyRecommendation: async () => rec });
check("Annie's review recommends and drafts; it never issues, and she sees the earlier decision and the evidence", async () => {
  const db = store(seed()); db.files.set('acc/app.pdf', Buffer.from('FORM'));
  await R.addSupplement(db, { dec: DEC, kind: 'email', sourceRef: 'msg:<a>', files: [{ buffer: Buffer.from('SWATCH'), originalname: 'image0.jpeg', mimetype: 'image/jpeg' }], bodyText: 'this is the new color', fromEmail: 'pat@example.test', addedBy: 'x', download: DL(db) });
  const rec = await openOne(db);
  const r = await R.reviewReconsideration(db, rec.id, { ...engine('approved_no_conditions', 'Dear Pat, approved.'), download: DL(db) });
  assert.ok(r.ok); const x = db.T.acc_reconsiderations[0];
  assert.deepStrictEqual([x.status, x.recommendation, x.outcome, x.letter_body], ['ready', 'approved', 'approved', 'Dear Pat, approved.']);
  assert.strictEqual(db.T.acc_finalizations.length, 1);
  assert.deepStrictEqual(engine.last.files.map((f) => f.originalname), ['app.pdf', 'image0.jpeg']);
  for (const want of [/RECONSIDERATION OF A DECIDED APPLICATION/, /existing color is denied/, /this is the new color/, /only clarifies what was already applied for/, /never say a violation is cured/, /no additional application fee/]) assert.ok(want.test(engine.last.additionalContext), String(want));
});
check("a letter staff saved is never replaced by Annie's newer draft", async () => {
  const db = store(seed()); const rec = await openOne(db);
  await R.saveDraft(db, rec.id, { letterBody: 'Edited by staff', outcome: 'approved', reason: 'shows the color' });
  await R.reviewReconsideration(db, rec.id, { ...engine('denied', 'Annie draft'), download: DL(db) });
  const x = db.T.acc_reconsiderations[0]; assert.deepStrictEqual([x.letter_body, x.reviewed_letter_body, x.outcome], ['Edited by staff', 'Annie draft', 'approved']);
});
check('stale: not reviewed, or evidence after the review', () => {
  assert.ok(R.staleness({}, [{ id: 's1' }])[0].includes('not reviewed'));
  assert.strictEqual(R.staleness({ review_at: '2026-11-24T00:00:00Z', review_basis: { supplements: ['s1'] } }, [{ id: 's1' }]).length, 0);
  assert.ok(/1 item of evidence arrived/.test(R.staleness({ review_at: 'x', review_basis: { supplements: ['s1'] } }, [{ id: 's1' }, { id: 's2' }])[0]));
});

// ------------------------------------------------------------ issue
const PDF = Buffer.from('%PDF revised letter');
async function ready(db, dec = DEC) {
  await R.addSupplement(db, { dec, kind: 'upload', note: 'swatch', addedBy: 'x', download: DL(db) });
  const rec = await openOne(db, dec);
  return (await R.saveDraft(db, rec.id, { letterBody: 'Dear Pat, approved on reconsideration.', outcome: 'approved', reason: 'The swatch shows the proposed color.' })).reconsideration;
}
const ARGS = (dec, rec, over = {}) => { const calls = { seal: 0, send: 0 }; return { calls, dec, rec, supplements: [{ id: 's1' }], letterBody: rec.letter_body, outcome: 'approved', reason: rec.reason, decisionRecord: { decided_by: 'ed', outcome: 'approved' }, approval: { user_id: 'owner', email: 'owner@example.test', name: 'Owner' }, toEmail: 'pat@example.test', send: true,
  renderLetter: async () => PDF, sealRecord: async ({ pdf, version }) => { calls.seal++; return { letter: { sha256: sha(pdf), archive_path: `a/v${version}-letter.pdf` }, packet: { sha256: 'p', archive_path: `a/v${version}-packet.pdf` }, documents: [{ what: 'supplemental photo: image0.jpeg', sha256: 'z' }] }; },
  composeEmail: async () => ({ from: 'annie@x', to: 'pat@example.test', subject: 'S', text: 'T', html: '<p>T</p>', archive_attachments: [{ name: 'l.pdf', sha256: sha(PDF) }] }), sendEmail: async () => { calls.send++; }, ...over }; };
check('issue: the owner-approved letter becomes version 2; the original decision and the case row do not change', async () => {
  const db = store(seed()); const rec = await ready(db); const before = JSON.stringify([db.T.acc_decisions, db.T.acc_finalizations[0]]);
  const a = ARGS(DEC, rec); const r = await R.issueRevisedDecision(db, a);
  assert.ok(r.ok, JSON.stringify(r)); assert.deepStrictEqual([a.calls.seal, a.calls.send], [1, 1]);
  const v2 = db.T.acc_finalizations[1];
  assert.deepStrictEqual([v2.version, v2.supersedes_id, v2.decision_type, v2.reconsideration_id, v2.reference_number, v2.delivery, v2.letter_sha256], [2, 'f1', 'approved', rec.id, 'RIV-ARC-2026-0007', 'email', sha(PDF)]);
  assert.strictEqual(v2.correction_reason, 'The swatch shows the proposed color.');
  const x = db.T.acc_reconsiderations[0]; assert.strictEqual(x.status, 'issued'); assert.strictEqual(x.owner_approval.user_id, 'owner'); assert.strictEqual(x.owner_approval.letter_sha256, sha(PDF));
  assert.strictEqual(JSON.stringify([db.T.acc_decisions, db.T.acc_finalizations[0]]), before);
  assert.ok(!db.writes.some((w) => w[0] === 'acc_decisions'), 'nothing is ever written to the case row');
});
check('a second revision supersedes version 2', async () => {
  const db = store(seed()); await R.issueRevisedDecision(db, ARGS(DEC, await ready(db)));
  const rec2 = await ready(db); const r = await R.issueRevisedDecision(db, ARGS(DEC, rec2));
  assert.ok(r.ok, JSON.stringify(r)); assert.deepStrictEqual([r.finalization.version, r.finalization.supersedes_id], [3, db.T.acc_finalizations[1].id]);
});
check('no owner approval, no issue; a placeholder, empty reason or missing recipient stops it before anything is sealed', async () => {
  const db = store(seed()); const rec = await ready(db);
  for (const [over, status] of [[{ approval: null }, 403], [{ letterBody: 'x [STAFF: fill]' }, 400], [{ reason: ' ' }, 400], [{ toEmail: '' }, 400], [{ outcome: 'request_more_info' }, 400]]) {
    const a = ARGS(DEC, rec, over); const r = await R.issueRevisedDecision(db, a); assert.strictEqual(r.httpStatus, status, JSON.stringify(over)); assert.deepStrictEqual([a.calls.seal, a.calls.send], [0, 0]);
  }
  assert.strictEqual(db.T.acc_finalizations.length, 1); assert.strictEqual(db.T.acc_reconsiderations[0].status, 'ready');
});
check('sealing or email failure: nothing recorded, approval cleared, back to ready', async () => {
  for (const over of [{ sealRecord: async () => { throw new Error('archive down'); } }, { sendEmail: async () => { throw new Error('mail down'); } }]) {
    const db = store(seed()); const rec = await ready(db); const r = await R.issueRevisedDecision(db, ARGS(DEC, rec, over));
    assert.ok(!r.ok && r.reverted); const x = db.T.acc_reconsiderations[0];
    assert.deepStrictEqual([x.status, x.owner_approval, db.T.acc_finalizations.length], ['ready', null, 1]);
  }
});
check('emailed but not recorded: says so and stays "issuing" (never re-sent)', async () => {
  const db = store(seed(), { failInsert: {} }); const rec = await ready(db);
  const orig = db.from; db.from = (t) => { const q = orig(t); if (t === 'acc_finalizations') { const ins = q.insert; q.insert = (p) => (p.version > 1 ? { select: () => ({ single: async () => ({ data: null, error: { message: 'db down' } }) }) } : ins(p)); } return q; };
  const r = await R.issueRevisedDecision(db, ARGS(DEC, rec));
  assert.ok(!r.ok && /WAS emailed/.test(r.error)); assert.strictEqual(db.T.acc_reconsiderations[0].status, 'issuing');
});
check('double click: one issue', async () => {
  const db = store(seed()); const rec = await ready(db); const a = ARGS(DEC, rec); const b = ARGS(DEC, rec);
  const [x, y] = await Promise.all([R.issueRevisedDecision(db, a), R.issueRevisedDecision(db, b)]);
  assert.strictEqual([x, y].filter((r) => r.ok).length, 1); assert.strictEqual(a.calls.send + b.calls.send, 1); assert.strictEqual(db.T.acc_finalizations.length, 2);
});
check('a closed reconsideration keeps its reason and cannot be issued', async () => {
  const db = store(seed()); const rec = await ready(db);
  assert.strictEqual((await R.closeReconsideration(db, rec.id, { reason: '' })).httpStatus, 400);
  assert.ok((await R.closeReconsideration(db, rec.id, { reason: 'same color' })).ok);
  assert.strictEqual((await R.issueRevisedDecision(db, ARGS(DEC, { ...rec, status: 'closed' }))).httpStatus, 409);
});

// ------------------------------------------------------------ effective decision
check('the decision in effect is the latest version; the original is kept beside it; unrevised rows are unchanged', async () => {
  const db = store({ ...seed(), acc_finalizations: [FIN1, { ...FIN1, id: 'f2', version: 2, decision_type: 'approved', finalized_at: '2026-11-25T00:00:00Z', letter_text: 'new' }] });
  const [a, b] = await E.withEffective(db, [DEC, { id: 'other', decision_type: 'denied' }]);
  assert.deepStrictEqual([a.decision_type, a.original_decision_type, a.effective.version, a.decided_at], ['approved', 'denied', 2, DEC.decided_at]);
  assert.deepStrictEqual(b, { id: 'other', decision_type: 'denied' });
});
check('a lookup failure never blanks a list and says the status is unconfirmed', async () => {
  const bad = { from: () => ({ select() { return this; }, in() { return this; }, gt() { return this; }, order: async () => ({ data: null, error: { message: 'down' } }) }) };
  const [a] = await E.withEffective(bad, [DEC]); assert.ok(a.effective_error && a.decision_type === 'denied');
});
check('the send check sees the revised record only for this case, approved and issuing', async () => {
  const base = { id: 'r1', acc_decision_id: 'acc1', status: 'issuing', owner_approval: { user_id: 'o' }, decision_record: { decided_by: 'ed', outcome: 'approved' }, outcome: 'approved' };
  const row = async (rec, id = 'r1') => E.effectiveAuthorityRow(store({ acc_reconsiderations: [rec] }), { ...DEC, decision_record: { outcome: 'denied' } }, { reconsiderationId: id });
  assert.strictEqual((await row(base)).decision_record.outcome, 'approved');
  for (const bad of [{ ...base, status: 'ready' }, { ...base, acc_decision_id: 'zzz' }, { ...base, owner_approval: null }]) assert.strictEqual((await row(bad)).decision_record, null);
  assert.strictEqual((await E.effectiveAuthorityRow(store({ acc_reconsiderations: [{ ...base, status: 'issued', issued_at: 'x' }] }), DEC)).decision_record.outcome, 'approved', 'later mail follows the decision in effect');
});

// ------------------------------------------------------------ matching
const CONV2 = 'AAQk' + 'Z'.repeat(50) + 'ALa1hpXMHB1Cp5NCHmvzlgE=';
const find = (db, over) => M.findCaseByReferenceOrThread(db, { managementCompanyId: 'mc', subject: 'Re: garage', body: '', conversationId: null, ...over });
check('a reply in the same thread matches the decided case from ANY mailbox (info@ and annie@ copies)', async () => {
  const hit = await find(store(seed()), { conversationId: CONV2 });
  assert.deepStrictEqual([hit.decided.id, hit.matched_by[0]], ['acc1', 'thread']);
  assert.strictEqual(await find(store(seed()), { conversationId: 'AAQk' + 'Z'.repeat(50) + 'OTHERTHREADOTHERTHREAD=' }), null);
});
check('the reference number matches with no shared thread; two numbers are ambiguous', async () => {
  assert.strictEqual((await find(store(seed()), { subject: 'Your architectural application (RIV-ARC-2026-0007)' })).decided.id, 'acc1');
  assert.strictEqual((await find(store(seed()), { body: 'about riv-arc-2026-0007' })).decided.id, 'acc1');
  assert.strictEqual(M.referenceOf({ subject: 'RIV-ARC-2026-0007 and RIV-ARC-2026-0008' }), null);
  assert.strictEqual(M.referenceOf({ subject: 'hi', body: 'RIV-ARC-2026-0007, RIV-ARC-2026-0008' }), null);
});
check('a withdrawn duplicate resolves to the original; an open case on the thread wins; two decided cases match neither', async () => {
  const dup = { ...DEC, id: 'dup', status: 'withdrawn', finalization_id: null, reference_number: 'RIV-ARC-2026-0058', duplicate_of_id: 'acc1' };
  assert.strictEqual((await find(store({ ...seed(), acc_decisions: [DEC, dup] }), { subject: 'RIV-ARC-2026-0058' })).decided.id, 'acc1');
  assert.ok((await find(store({ ...seed(), acc_decisions: [DEC, { ...DEC, id: 'o', status: 'pending_review' }] }), { conversationId: CONV2 })).open);
  assert.strictEqual(await find(store({ ...seed(), acc_decisions: [DEC, { ...DEC, id: 'two' }] }), { conversationId: CONV2 }), null);
});
check('a bounce or automatic reply is never filed as evidence', async () => {
  assert.strictEqual(await find(store(seed()), { subject: 'Undeliverable: decision (RIV-ARC-2026-0007)' }), null);
  assert.strictEqual(await find(store(seed()), { subject: 'RIV-ARC-2026-0007', sender: 'MAILER-DAEMON@x.test' }), null);
});
check('another company\'s case never matches', async () => { assert.strictEqual(await find(store({ acc_decisions: [{ ...DEC, management_company_id: 'other' }] }), { subject: 'RIV-ARC-2026-0007' }), null); });
check('email + address: one recent decision only; a stranger, an old decision or a second decision does not match', async () => {
  const now = Date.parse('2026-11-25T00:00:00Z'); const q = (db, over = {}) => M.findDecidedByEmailAndAddress(db, { communityId: 'c1', emails: ['PAT@example.test'], address: '1 Main St', now, ...over });
  assert.strictEqual((await q(store(seed()))).decided.id, 'acc1');
  assert.strictEqual(await q(store(seed()), { emails: ['x@y.z'] }), null);
  assert.strictEqual(await q(store(seed()), { now: Date.parse('2027-06-01T00:00:00Z') }), null);
  assert.strictEqual(await q(store({ acc_decisions: [DEC, { ...DEC, id: 'two' }] })), null);
});

// ------------------------------------------------------------ wiring
check('intake: decided cases are checked before a new application can be created; one message at a time; staff can still force a new one', () => {
  const s = src('lib/applications/email_intake.js');
  const at = (x) => { const i = s.indexOf(x); assert.ok(i > 0, x); return i; };
  assert.ok(at('strongHit = await require') < at('await extractHeader(primary)') && at('findDecidedByEmailAndAddress(supabase') < at('await createPendingAccDecision('));
  assert.ok(/oneAtATime\(msgRef \|\| \(email && email\.graph_id\)/.test(s) && /contains\('source_email_refs', \[msgRef\]\)/.test(s) && /if \(!args\.forceNew\)/.test(s));
  assert.ok(/fileReplyOnDecidedCase/.test(src('lib/email/graph_ingest.js')), 'a reply with nothing attached is filed too');
  assert.ok(require('../lib/acc/intake_exceptions').FILED.has('supplement'));
});
check('only the owner can preview, close or issue; every other write needs a signed-in person', () => {
  const s = src('api/acc_reconsideration.js');
  for (const r of ['/close', '/preview', '/issue']) { const i = s.indexOf(`router.post('/:id/reconsideration/:rid${r}'`); assert.ok(i > 0 && /const actor = await owner\(/.test(s.slice(i, i + 200)), r); }
  const writes = s.match(/router\.(post|patch)\([^]*?\n\s+const actor = await (staff|owner)\(/g) || [];
  assert.strictEqual((s.match(/router\.(post|patch)\(/g) || []).length, writes.length, 'a write route has no actor check first');
  assert.ok(/DA\.checkFinalDecision\(/.test(s) && /resolveAuthorityDocument\(dec, record\)/.test(s), 'the same decision-authority gate applies');
});
check('no fee, no charge, no new application, no violation change anywhere in the workflow', () => {
  for (const f of ['lib/acc/reconsideration.js', 'api/acc_reconsideration.js', 'lib/acc/effective.js', 'lib/acc/match_decided.js']) {
    const s = src(f).replace(/\/\/.*$/gm, '');
    assert.ok(!/createCharge|acc_fee|ar_engine|charge_type/.test(s), f + ' charges');
    assert.ok(!/from\('violations'\)/.test(s), f + ' touches violations');
    assert.ok(!/from\('acc_decisions'\)\s*\.insert/.test(s), f + ' creates an application');
    assert.ok(!/final_decided_at\s*:/.test(s), f + ' changes the billed date');
  }
});
check('the homeowner copy has no em-dash, and the email says it was reconsidered', () => {
  const m = R.composeRevisedEmail({ dec: DEC, outcome: 'approved', letterBody: 'Dear Pat Doe,\n\nx', communityName: 'Riverbend' });
  assert.ok(/reconsidering your architectural application/.test(m.text) && /has been approved\./.test(m.text) && !/—/.test(m.text + m.subject));
  assert.ok(/was not approved/.test(R.composeRevisedEmail({ dec: DEC, outcome: 'denied', letterBody: 'Dear Pat Doe,' }).text));
});
check('the complete record of a revision includes the earlier letter, the correspondence and the new files', async () => {
  const { PDFDocument } = require('pdf-lib'); const mk = async () => { const d = await PDFDocument.create(); d.addPage(); return Buffer.from(await d.save()); };
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  const form = await mk(); const files = { 'acc/app.pdf': form, 's/0.png': png };
  const pk = await require('../lib/acc/packet').buildAccPacket({ dec: { ...DEC }, letterBuffer: await mk(), download: async (p) => files[p] || null, prior: [{ what: 'earlier decision letter (version 1, denied)', bytes: await mk() }],
    supplements: [{ id: 's1', kind: 'email', received_at: '2026-11-24', from_email: 'pat@example.test', subject: 'swatch — “new” \u{1F600}', body_text: 'x'.repeat(500) + '\n' + 'word '.repeat(2000), documents: [{ path: 's/0.png', filename: 'image0.png' }, { path: null, filename: 'form.pdf', already_on_case: true }] }] });
  assert.ok(pk.ok && !pk.omitted.length, JSON.stringify(pk.omitted));
  const what = pk.included.map((x) => x.what).join('|');
  for (const w of ['decision letter', 'earlier decision letter', 'application:', 'correspondence:', 'supplemental photo: image0.png']) assert.ok(what.includes(w), w + ' missing: ' + what);
});

// ------------------------------------------------------------ the routes, over HTTP
const stub = (p, exp) => { const f = require.resolve(p); require.cache[f] = { id: f, filename: f, loaded: true, exports: exp }; };
let ACTOR = null; const SENT = [];
const OWNER_EMAIL = require('../lib/acc/decision_authority').OWNER_EMAIL;
const OWNER = { id: 'owner-id', email: OWNER_EMAIL, full_name: 'Owner', is_active: true, role: 'admin' };
const STAFF = { id: 'staff-id', email: 'staff@example.test', full_name: 'Staff Person', is_active: true, role: 'staff' };
async function withApi(db, fn, extra = {}) {
  stub('../api/_acting_user', { getActingUser: async () => ACTOR });
  stub('../lib/email/graph_send', { isConfigured: () => true, ANNIE_MAILBOX: 'annie@example.test', sendAs: async (m) => { SENT.push(m); return { sent: true }; } });
  stub('../lib/entity_resolution', { resolveProperty: async () => ({ id: 'prop1' }), normalizeAddress: () => ({}) });
  const express = require('express'); const app = express();
  app.use('/acc-review/decisions', require('../api/acc_reconsideration')({ supabase: db, BEDROCK_MGMT_CO_ID: 'mc', screenForLeaks: (t2) => ({ text: t2, blocks: [] }), withAppealNotice: (t2) => t2 + '\n\nYou may request a hearing before the Board.',
    delegationFor: async () => ({ reference: 'Guidelines 1.4.4 delegate the initial review to the Managing Agent', library_document_id: 'lib1', library_document_title: 'Guidelines', acts_as: 'committee' }), resolveAuthorityDocument: async () => null,
    renderLetterPdfBuffer: async () => { const { PDFDocument } = require('pdf-lib'); const d = await PDFDocument.create(); d.addPage(); return Buffer.from(await d.save()); }, ...extra }));
  const srv = await new Promise((r) => { const x = app.listen(0, () => r(x)); });
  const call = async (method, p, body, raw) => { const r = await fetch(`http://127.0.0.1:${srv.address().port}/acc-review/decisions${p}`, { method, headers: raw ? {} : { 'Content-Type': 'application/json' }, body: raw || (body ? JSON.stringify(body) : undefined) }); const ct = r.headers.get('content-type') || ''; return { status: r.status, body: ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()), ct }; };
  try { return await fn(call); } finally { srv.close(); }
}
check('HTTP: staff file evidence, open, draft; staff cannot issue; the owner issues version 2 with one email and no fee', async () => {
  const { PDFDocument } = require('pdf-lib'); const d0 = await PDFDocument.create(); d0.addPage(); const pdf0 = Buffer.from(await d0.save());
  const fin = { ...FIN1, letter_sha256: sha(pdf0), letter_archive_path: 'arc/1.pdf' };
  const db = store({ acc_decisions: [{ ...DEC, decision_record: { outcome: 'denied', decided_by: 'annie' } }], acc_finalizations: [fin], communities: [{ id: 'c1', hoa_legal_name: 'Riverbend Owners Association, Inc.' }] });
  db.files.set('acc/app.pdf', pdf0); db.files.set('arc/1.pdf', pdf0);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  const caseBefore = JSON.stringify(db.T.acc_decisions);
  await withApi(db, async (call) => {
    ACTOR = null; assert.strictEqual((await call('POST', '/acc1/reconsideration', { reason: 'x' })).status, 401);
    ACTOR = STAFF; const fd = new FormData(); fd.append('files', new Blob([png], { type: 'image/png' }), 'swatch.png'); fd.append('note', 'swatch');
    const up = await call('POST', '/acc1/supplements', null, fd); assert.strictEqual(up.status, 200, JSON.stringify(up.body));
    const opened = await call('POST', '/acc1/reconsideration', { reason: 'Swatch received' }); assert.strictEqual(opened.status, 200, JSON.stringify(opened.body));
    const rid = opened.body.reconsideration.id;
    const draft = { letter_body: 'Dear Pat Doe,\n\nOn reconsideration, the garage door color in your swatch is approved.', outcome: 'approved', reason: 'The swatch shows the color already applied for.' };
    assert.strictEqual((await call('PATCH', `/acc1/reconsideration/${rid}`, draft)).status, 200);
    for (const p of ['issue', 'close', 'preview']) assert.strictEqual((await call('POST', `/acc1/reconsideration/${rid}/${p}`, { ...draft, send: true, confirm_compliant: true, acknowledge_stale: true })).status, 403, p);
    assert.strictEqual(SENT.length, 0);
    ACTOR = OWNER;
    const pv = await call('POST', `/acc1/reconsideration/${rid}/preview`, draft); assert.ok(pv.status === 200 && /pdf/.test(pv.ct));
    const stale = await call('POST', `/acc1/reconsideration/${rid}/issue`, { ...draft, send: true, confirm_compliant: true }); assert.ok(stale.status === 409 && stale.body.stale, 'not reviewed by Annie: the owner must confirm');
    const noConfirm = await call('POST', `/acc1/reconsideration/${rid}/issue`, { ...draft, send: true, acknowledge_stale: true }); assert.ok(noConfirm.status === 409 && SENT.length === 0, 'the same decision-authority gate applies: ' + JSON.stringify(noConfirm.body));
    const ok = await call('POST', `/acc1/reconsideration/${rid}/issue`, { ...draft, send: true, confirm_compliant: true, acknowledge_stale: true, homeowner_name: 'Pat and Sam Doe' });
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body)); assert.deepStrictEqual([ok.body.version, ok.body.decision_type, ok.body.warnings.length], [2, 'approved', 0]);
    assert.strictEqual(SENT.length, 1); assert.deepStrictEqual([SENT[0].to, SENT[0].accDecisionId, SENT[0].accReconsiderationId], ['pat@example.test', 'acc1', rid]);
    const again = await call('POST', `/acc1/reconsideration/${rid}/issue`, { ...draft, send: true, confirm_compliant: true, acknowledge_stale: true }); assert.ok(again.status >= 400 && SENT.length === 1, 'never sent twice');
    const g = await call('GET', '/acc1/reconsideration'); assert.deepStrictEqual(g.body.versions.map((v) => [v.version, v.decision_type]), [[1, 'denied'], [2, 'approved']]); assert.strictEqual(g.body.active, null);
    const f = await call('GET', `/acc1/supplements/${g.body.supplements[0].id}/files/0`); assert.ok(f.status === 200 && f.ct.includes('image/png') && f.body.equals(png));
  });
  assert.strictEqual(JSON.stringify(db.T.acc_decisions), caseBefore, 'the case row never changes');
  const v2 = db.T.acc_finalizations[1]; const rec = db.T.acc_reconsiderations[0];
  assert.deepStrictEqual([rec.decision_record.decided_by, rec.decision_record.decided_by_user_id, rec.decision_record.recorded_by.user_id, rec.decision_record.authority_basis.acts_as], ['ed', 'owner-id', 'owner-id', 'committee']);
  assert.ok(v2.documents.some((x) => x.what === 'earlier decision letter (version 1, denied)') && v2.documents.some((x) => x.what === 'supplemental photo: swatch.png' && x.sha256 === sha(png)), JSON.stringify(v2.documents));
  assert.strictEqual(db.T.interactions.length, 1); assert.strictEqual(db.T.finalized_record_archive.length, 2);
  assert.ok(!db.writes.some((w) => /charge|ledger|violation|journal/.test(w[0])));
});
check('HTTP: withdraw a duplicate: audited first, linked, kept, its acknowledgment cancelled; a finalized case is refused', async () => {
  const db = store({ acc_decisions: [DEC, { ...DEC, id: 'dup', status: 'pending_review', decision_type: null, finalization_id: null, reference_number: 'RIV-ARC-2026-0058' }], outbound_email_drafts: [{ id: 'd1', related_type: 'acc_decision', related_id: 'dup', draft_kind: 'acknowledgment', status: 'draft' }, { id: 'd2', related_type: 'acc_decision', related_id: 'acc1', draft_kind: 'acknowledgment', status: 'draft' }] });
  await withApi(db, async (call) => {
    ACTOR = STAFF;
    assert.strictEqual((await call('POST', '/acc1/withdraw-duplicate', { duplicate_of: 'RIV-ARC-2026-0058', reason: 'x' })).status, 409, 'finalized');
    assert.strictEqual((await call('POST', '/dup/withdraw-duplicate', { duplicate_of: 'NOPE', reason: 'x' })).status, 404);
    const r = await call('POST', '/dup/withdraw-duplicate', { duplicate_of: 'riv-arc-2026-0007', reason: 'same swatch email' });
    assert.ok(r.status === 200 && r.body.acknowledgments_cancelled === 1, JSON.stringify(r.body));
  });
  const x = db.T.acc_decisions[1]; assert.deepStrictEqual([x.status, x.duplicate_of_id], ['withdrawn', 'acc1']); assert.strictEqual(db.T.audit_events.length, 1);
  assert.deepStrictEqual(db.T.outbound_email_drafts.map((d) => d.status), ['discarded', 'draft']);
  const ix = db.writes.findIndex((w) => w[0] === 'audit_events'); assert.ok(ix >= 0 && ix < db.writes.findIndex((w) => w[0] === 'acc_decisions'));
});

(async () => {
  let failed = 0;
  for (const [n, fn] of tests) { try { await fn(); console.log('  ok -', n); } catch (e) { failed++; console.error('  FAIL -', n, '\n', e.stack); } }
  console.log(`\nacc reconsideration: ${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
