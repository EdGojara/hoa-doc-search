// ============================================================================
// tests/test_acc_documents.js  (Issue #14, Ed 2026-10-02)
// ----------------------------------------------------------------------------
// ACC cases are reviewed against the documents actually on the case.
// Scar: WAT-ARC-2026-0025 (6019 Sweetspire Ridge). The homeowner emailed her
// application AND a survey; the engine read only the first PDF, so the analysis
// said "Survey ... Not submitted", and the survey was archived as photo_2.pdf.
//
// Covered (Ed's list):
//   follow-up to an existing case with a PDF survey      multiple attachments
//   attachment dedup / idempotency                        ingestion failure surfaced
//   awaiting-info / pending case receiving the document  current review sees it
//   no false "missing survey" after ingestion             no automatic decision/send
// Real lib/acc/pending_intake.js + lib/acc/documents.js against an in-memory
// store; the review engine is a stand-in that records what it was given.
// ============================================================================
require('dotenv').config({ quiet: true });
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const tests = []; const check = (n, fn) => tests.push([n, fn]);
const src = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

// ---------------------------------------------------------------- fakes
function makeDb(rows, { failUpload = () => false, missing479 = false } = {}) {
  const T = { acc_decisions: rows.map((r) => ({ ...r })) }; const writes = []; const objects = new Map();
  const has479 = (cols) => !missing479 || !cols.some((c) => /document_manifest|document_intake_errors|current_review/.test(c));
  const from = (t) => {
    const f = []; let mode = 'select'; let sel = '*'; let payload = null; let single = false;
    const api = {
      select(s) { if (mode === 'select') sel = s || '*'; return api; },
      eq(c, v) { f.push((r) => r[c] === v); return api; }, in(c, vs) { f.push((r) => vs.includes(r[c])); return api; },
      limit() { return api; }, maybeSingle() { single = true; return api; }, single() { single = true; return api; },
      update(p) { mode = 'update'; payload = p; return api; }, insert(p) { mode = 'insert'; payload = p; return api; },
      then(res, rej) {
        return Promise.resolve().then(() => {
          const rows2 = T[t].filter((r) => f.every((p) => p(r)));
          if (mode === 'update') {
            if (!has479(Object.keys(payload))) return { data: null, error: { message: 'column acc_decisions.document_manifest does not exist' } };
            rows2.forEach((r) => Object.assign(r, payload)); writes.push({ t, payload }); return { data: null, error: null };
          }
          if (sel !== '*' && !has479(sel.split(',').map((x) => x.trim()))) return { data: null, error: { message: 'column acc_decisions.document_manifest does not exist' } };
          let out = rows2.map((r) => ({ ...r }));
          if (missing479 && sel === '*') out = out.map((r) => { const c = { ...r }; for (const k of Object.keys(c)) if (/document_manifest|document_intake_errors|current_review|current_ai|current_letter/.test(k)) delete c[k]; return c; });
          return { data: single ? (out[0] || null) : out, error: null };
        }).then(res, rej);
      },
    };
    return api;
  };
  const storage = { from: () => ({
    upload: async (p, buf) => { if (failUpload(p)) return { data: null, error: { message: 'storage unavailable' } }; objects.set(p, buf); return { data: { path: p }, error: null }; },
    download: async (p) => { if (!objects.has(p)) return { data: null, error: { message: 'not found' } }; const b = objects.get(p); return { data: { arrayBuffer: async () => b }, error: null }; },
  }) };
  return { T, writes, objects, from, storage, row: () => T.acc_decisions[0] };
}
let engineCalls = [];
function loadIntake(db) {
  const reg = path.join(__dirname, '..', 'lib', 'acc', 'engine_registry.js');
  const sbPath = require.resolve('@supabase/supabase-js');
  const anPath = require.resolve('../lib/ai/anthropic');
  const piPath = require.resolve('../lib/acc/pending_intake');
  const saved = { sb: require.cache[sbPath], an: require.cache[anPath], reg: require.cache[reg] };
  delete require.cache[piPath];
  require.cache[sbPath] = { id: sbPath, filename: sbPath, loaded: true, exports: { createClient: () => db } };
  require.cache[reg] = { id: reg, filename: reg, loaded: true, exports: {
    isReady: () => true,
    runEngine: async ({ files }) => {
      engineCalls.push(files.map((f) => ({ fieldname: f.fieldname, name: f.originalname })));
      const hasSurvey = files.some((f) => /survey/i.test(f.originalname || ''));
      return { review: hasSurvey ? '| Survey / plot plan | ✅ Received (Survey of 6019 Sweetspire Ridge_circled.pdf) |' : '| Survey / plot plan | ❌ Not submitted |', letter_body: hasSurvey ? 'Dear Pat, approved.' : 'Dear Pat, please send the survey.', extracted: {} };
    },
  } };
  class FakeAnthropic { constructor() { this.messages = { create: async ({ messages }) => ({ content: [{ text: /✅ Received/.test(messages[0].content) ? 'approved_with_conditions' : 'request_more_info' }] }) }; } }
  require.cache[anPath] = { id: anPath, filename: anPath, loaded: true, exports: FakeAnthropic };
  const mod = require('../lib/acc/pending_intake');
  require.cache[sbPath] = saved.sb; if (saved.an) require.cache[anPath] = saved.an; else delete require.cache[anPath];
  if (saved.reg) require.cache[reg] = saved.reg; else delete require.cache[reg];
  delete require.cache[piPath];
  return mod;
}
const pdf = (name) => ({ fieldname: 'images', buffer: Buffer.from('%PDF ' + name), mimetype: 'application/pdf', originalname: name });
const jpg = (name) => ({ fieldname: 'images', buffer: Buffer.from('JPG ' + name), mimetype: 'image/jpeg', originalname: name });
const CASE = (over = {}) => ({ id: 'acc1', status: 'pending_review', decision_type: null, decided_at: null, community_name: 'Waterview Estates',
  application_pdf_storage_path: 'acc_decisions/acc1/application.pdf', photo_storage_paths: [], supporting_docs_storage_paths: [], source_email_refs: [],
  ai_review_text: '| Survey / plot plan | ❌ Not submitted |', ai_recommendation: 'request_more_info', ai_letter_body: 'Dear Pat, please send the survey.',
  document_manifest: [], document_intake_errors: [], current_review_text: null, current_ai_recommendation: null, current_letter_body: null, current_review_at: null, current_review_basis: null, ...over });
const seedApp = (db) => db.objects.set('acc_decisions/acc1/application.pdf', Buffer.from('%PDF form'));
const D = require('../lib/acc/documents');

// ---------------------------------------------------------------- tagging (the root cause)
check('multiple attachments: only the FIRST pdf is the form; a second pdf (the survey) and photos are supporting files the engine reads', () => {
  const files = D.tagFilesForEngine([
    { filename: 'Beyk_ARA.pdf', isPdf: true, buffer: Buffer.from('a'), contentType: 'application/pdf' },
    { filename: 'image0.jpeg', isPdf: false, buffer: Buffer.from('b'), contentType: 'image/jpeg' },
    { filename: 'Survey of 6019 Sweetspire Ridge_circled.pdf', isPdf: true, buffer: Buffer.from('c'), contentType: 'application/pdf' },
  ]);
  assert.deepStrictEqual(files.map((f) => [f.fieldname, f.originalname]), [['pdf', 'Beyk_ARA.pdf'], ['images', 'image0.jpeg'], ['images', 'Survey of 6019 Sweetspire Ridge_circled.pdf']]);
});
check('engine: reads EVERY pdf (not just the first) and is told every file by its original name', () => {
  const s = src('server.js'); const e = s.slice(s.indexOf('async function assessAndDraftAcc'), s.indexOf('const extractResponse = await anthropic.messages.create', s.indexOf('async function assessAndDraftAcc')));
  assert.ok(/const imageFiles = pdfFiles\.slice\(1\)\.concat\(files\.filter\(\(f\) => f\.fieldname === 'images'\)\);/.test(e));
  assert.ok(/FILES IN THIS PACKAGE/.test(e) && /IS the survey for this review; do not call the survey missing/.test(e));
  assert.ok(/require\('\.\.\/acc\/documents'\)\.tagFilesForEngine\(atts\)/.test(src('lib/applications/email_intake.js')));
});

// ---------------------------------------------------------------- follow-up with a survey
check('follow-up to an existing case with a PDF survey: stored as a supporting document under its ORIGINAL name, in the manifest', async () => {
  const db = makeDb([CASE()]); seedApp(db); engineCalls = [];
  const I = loadIntake(db);
  const r = await I.attachDocsToApplication({ applicationId: 'acc1', files: [pdf('Survey of 6019 Sweetspire Ridge_circled.pdf')], sourceRef: 'email:G2' });
  assert.strictEqual(r.status, 'attached'); assert.strictEqual(r.added, 1);
  const x = db.row();
  assert.strictEqual(x.supporting_docs_storage_paths.length, 1); assert.ok(/Survey_of_6019_Sweetspire_Ridge_circled\.pdf$/.test(x.supporting_docs_storage_paths[0]));
  assert.deepStrictEqual(x.photo_storage_paths, [], 'a PDF is never filed as a photo');
  const m = x.document_manifest[0]; assert.deepStrictEqual([m.filename, m.kind, m.source_ref], ['Survey of 6019 Sweetspire Ridge_circled.pdf', 'supporting', 'email:G2']);
  assert.ok(x.source_email_refs.includes('email:G2'));
});
check('current review sees the new attachment: engine gets the form AND the survey by name; original analysis untouched', async () => {
  const db = makeDb([CASE()]); seedApp(db); engineCalls = [];
  const I = loadIntake(db);
  const r = await I.attachDocsToApplication({ applicationId: 'acc1', files: [pdf('Survey of 6019 Sweetspire Ridge_circled.pdf')], sourceRef: 'email:G2' });
  assert.strictEqual(r.review.status, 'reviewed');
  const call = engineCalls[engineCalls.length - 1];
  assert.deepStrictEqual(call.map((f) => f.fieldname), ['pdf', 'images']);
  assert.ok(call.some((f) => /Survey of 6019/.test(f.name)));
  const x = db.row();
  assert.ok(/✅ Received/.test(x.current_review_text)); assert.strictEqual(x.current_ai_recommendation, 'approved_with_conditions');
  assert.ok(x.current_review_basis.documents.some((d) => /Survey/.test(d.filename)) && x.current_review_basis.trigger === 'documents_received');
  assert.ok(/❌ Not submitted/.test(x.ai_review_text) && x.ai_recommendation === 'request_more_info', 'original analysis kept as history');
});
check('no false "missing survey" after ingestion: current review + recommendation reflect the survey; the queue/detail prefer the current one', async () => {
  const db = makeDb([CASE()]); seedApp(db);
  const I = loadIntake(db);
  await I.attachDocsToApplication({ applicationId: 'acc1', files: [pdf('Survey of 6019 Sweetspire Ridge_circled.pdf')], sourceRef: 'email:G2' });
  assert.ok(!/Not submitted/.test(db.row().current_review_text));
  const ui = src('public/index.html');
  assert.ok(/const rec = a\.current_ai_recommendation \|\| a\.ai_recommendation \|\| a\.decision_type \|\| '';/.test(ui));
  assert.ok(/a\.letter_body \|\| a\.current_letter_body \|\| a\.ai_letter_body/.test(ui));
  assert.ok(/accDecisionBadge\(a\.current_ai_recommendation \|\| a\.ai_recommendation, '🤖'\)/.test(ui));
  const s = src('server.js');
  assert.ok(/dec\.current_review_text \|\| dec\.ai_review_text/.test(s), 'Annie drafts from the current review');
  assert.ok(/const _docNames = require\('\.\/lib\/acc\/documents'\)\.caseDocuments\(dec\)\.map\(\(d\) => d\.filename\);/.test(s), 'survey guard reads real filenames');
});
check('Sweetspire as it is today (survey stored as photo_2.pdf): re-review treats it as a supporting document and reads it', async () => {
  const db = makeDb([CASE({ photo_storage_paths: ['acc_decisions/acc1/photo_1.jpg', 'acc_decisions/acc1/photo_2.pdf'] })]); seedApp(db);
  db.objects.set('acc_decisions/acc1/photo_1.jpg', Buffer.from('JPG')); db.objects.set('acc_decisions/acc1/photo_2.pdf', Buffer.from('%PDF survey'));
  assert.deepStrictEqual(D.caseDocuments(db.row()).map((d) => d.kind), ['application', 'photo', 'supporting']);
  engineCalls = []; const I = loadIntake(db);
  const r = await I.reassessCase('acc1', 'staff');
  assert.strictEqual(r.status, 'reviewed'); assert.strictEqual(engineCalls[0].length, 3, 'all three stored documents reach the engine');
  assert.strictEqual(engineCalls[0][0].fieldname, 'pdf');
});
check('awaiting-info case receiving the requested document: back to pending_review (waiting on us), current review refreshed', async () => {
  const db = makeDb([CASE({ status: 'awaiting_info', decision_type: 'request_more_info' })]); seedApp(db);
  const I = loadIntake(db);
  await I.attachDocsToApplication({ applicationId: 'acc1', files: [pdf('Survey.pdf')], sourceRef: 'email:G3' });
  assert.strictEqual(db.row().status, 'pending_review'); assert.ok(db.row().current_review_at); assert.ok(db.row().last_document_added_at);
});

// ---------------------------------------------------------------- dedup / failures
check('dedup / idempotency: the same email is filed once (intake checks source_email_refs); the manifest never duplicates a path', async () => {
  assert.ok(/openApp\.source_email_refs\.includes\(srcRef\)\) \{\s*\n\s*return \{ status: 'exists'/.test(src('lib/applications/email_intake.js')));
  const db = makeDb([CASE()]);
  await D.recordCaseDocuments(db, 'acc1', { manifest: [{ path: 'p1', filename: 'a.pdf' }] });
  await D.recordCaseDocuments(db, 'acc1', { manifest: [{ path: 'p1', filename: 'a.pdf' }, { path: 'p2', filename: 'b.pdf' }] });
  assert.deepStrictEqual(db.row().document_manifest.map((m) => m.path), ['p1', 'p2']);
});
check('ingestion failure surfaced: a failed upload is recorded on the case (not a path to a missing file); a fetch failure is recorded too', async () => {
  const db = makeDb([CASE()], { failUpload: (p) => /Survey/.test(p) }); seedApp(db);
  const I = loadIntake(db);
  const r = await I.attachDocsToApplication({ applicationId: 'acc1', files: [pdf('Survey.pdf'), jpg('house.jpg')], sourceRef: 'email:G4',
    intakeErrors: [{ filename: 'plans.pdf', source_ref: 'email:G4', stage: 'fetch', error: 'could not download the attachment bytes' }] });
  const x = db.row();
  assert.strictEqual(x.supporting_docs_storage_paths.length, 0, 'no path recorded for the failed upload');
  assert.strictEqual(x.photo_storage_paths.length, 1);
  assert.deepStrictEqual(x.document_intake_errors.map((e) => [e.filename, e.stage]), [['plans.pdf', 'fetch'], ['Survey.pdf', 'store']]);
  assert.strictEqual(r.failed, 2);
  const ui = src('public/index.html'); assert.ok(/could not be \$\{errs\.some\(\(e\) => e\.stage === 'fetch'\) \? 'fetched or ' : ''\}stored/.test(ui));
  const ga = src('lib/email/graph_attachments.js');
  assert.ok(/out\.failed\.push\(\{ filename: a\.name \|\| null, error: 'could not download the attachment bytes' \}\)/.test(ga) && /none\.listError = /.test(ga));
  assert.ok(/status: 'attachments_unavailable'/.test(src('lib/applications/email_intake.js')));
});
check('before migration 479: documents still stored and linked; errors logged loudly; re-review refused with a clear reason', async () => {
  const db = makeDb([CASE()], { missing479: true }); seedApp(db);
  const I = loadIntake(db); const errs = []; const o = console.error; console.error = (...a) => errs.push(a.join(' '));
  try {
    const r = await I.attachDocsToApplication({ applicationId: 'acc1', files: [pdf('Survey.pdf')], sourceRef: 'email:G5', intakeErrors: [{ filename: 'x.pdf', stage: 'fetch', error: 'boom' }] });
    assert.strictEqual(r.status, 'attached'); assert.strictEqual(db.row().supporting_docs_storage_paths.length, 1);
    assert.strictEqual(r.review.status, 'unavailable');
  } finally { console.error = o; }
  assert.ok(errs.some((e) => /"x\.pdf" NOT stored/.test(e)));
});

// ---------------------------------------------------------------- never decides
check('no automatic decision or send: intake + re-review never set a decision, decided status, decided_at, or touch the original analysis', async () => {
  const db = makeDb([CASE()]); seedApp(db);
  const I = loadIntake(db);
  await I.attachDocsToApplication({ applicationId: 'acc1', files: [pdf('Survey.pdf')], sourceRef: 'email:G6' });
  await I.reassessCase('acc1', 'staff');
  const keys = new Set(db.writes.flatMap((w) => Object.keys(w.payload)));
  for (const k of ['decision_type', 'decided_at', 'decided_by_user_id', 'acknowledged_at', 'letter_body', 'ai_review_text', 'ai_recommendation', 'ai_letter_body']) assert.ok(!keys.has(k), `wrote ${k}`);
  assert.ok(!db.writes.some((w) => w.payload.status && w.payload.status !== 'pending_review'));
  assert.strictEqual(db.row().decision_type, null); assert.strictEqual(db.row().decided_at, null);
  for (const f of ['lib/acc/documents.js', 'lib/acc/pending_intake.js']) assert.ok(!/graph_send|sendAs\(|require\('\.\/finalize'\)/.test(src(f)), f + ' sends nothing');
  assert.ok(/app\.post\('\/acc-review\/decisions\/:id\/reassess'/.test(src('server.js')));
});

(async () => {
  let pass = 0, fail = 0;
  console.log('ACC documents: every attachment reaches the review (Issue #14)');
  for (const [n, fn] of tests) { try { await fn(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n      ' + (e.stack || e.message).split('\n').slice(0, 3).join('\n      ')); } }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
