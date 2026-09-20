// lib/ai/shadow/evidence_package.test.js — Phase 1 acceptance for the evidence-
// readiness layer (Ed/ChatGPT 2026-09-19). OFFLINE: extraction is injected, no
// API/DB. Grounded in the SOLAR root cause (a transient application-PDF failure
// that silently vanished while the package still read "complete").
//
// Acceptance criteria proven here:
//  1) An expected application PDF ends in EXACTLY ONE explicit state, and never
//     silently disappears while the package is READY.
//  2) A transient failure is RETRIED (bounded, deterministic) and can recover.
//  3) A required artifact stuck in EXTRACTION_FAILED makes the package NOT READY
//     and, at the gate, routes ERROR / EVIDENCE_EXTRACTION_FAILED (never BLOCK).
//  4) A package that is not READY NEVER reaches ACC reasoning (no model call).
//   node lib/ai/shadow/evidence_package.test.js
const { assembleEvidencePackage, STATE, READINESS } = require('./acc_evidence');
const { evidenceReadinessGate, EXEC } = require('../decide');
const { evaluateApplication } = require('./acc_shadow');

let failed = 0;
const assert = (n, c) => { if (!c) { failed++; console.log('  FAIL: ' + n); } else console.log('  ok:   ' + n); };

// mock deps with a controllable PDF download/transcription
function mkDeps({ dl = () => 'ok', transcript = 'Roof-mounted solar PV 10.25kW DC + Tesla Powerwall 3; roof plane south; screening noted.', guidelines = 'ARCHITECTURAL GUIDELINES: solar permitted, screen equipment, match existing.' } = {}) {
  let n = 0;
  const supabase = {
    storage: { from: () => ({ download: async () => { n++; const b = dl(n); if (b === 'throw') return { data: null, error: { message: 'network blip attempt ' + n } }; return { data: { arrayBuffer: async () => Buffer.from('%PDF-1.4 fake').buffer }, error: null }; } }) },
    from: () => ({ select: () => ({ eq: () => ({ neq: () => ({ order: () => ({ limit: async () => ({ data: [], error: null }) }) }) }) }) }),
  };
  const anthropic = { messages: { create: async () => ({ content: [{ type: 'text', text: transcript }] }) } };
  const getRelevantChunks = async () => guidelines;
  return { supabase, getRelevantChunks, anthropic };
}
const appRow = (over) => Object.assign({ id: 'solar-1', community_name: 'Waterview Estates', homeowner_address: '6019 Water Violet Ln', project_summary: '', application_pdf_storage_path: 'acc/solar/app.pdf' }, over || {});
const appPdf = (pkg) => pkg.manifest.find((m) => m.source === 'application_pdf');
const VALID_STATES = Object.values(STATE);

(async () => {
  console.log('\n=== evidence-readiness Phase 1 (solar regression) ===');

  // 1) PDF fails ALL retries -> EXTRACTION_FAILED, attempts recorded, readiness EXTRACTION_FAILED
  {
    const pkg = await assembleEvidencePackage(appRow(), mkDeps({ dl: () => 'throw' }), { attempts: 3 });
    const a = appPdf(pkg);
    assert('fail-all: application_pdf state = EXTRACTION_FAILED', a.state === STATE.EXTRACTION_FAILED);
    assert('fail-all: retried exactly 3 times', a.attempts === 3);
    assert('fail-all: readiness = EXTRACTION_FAILED', pkg.readiness === READINESS.EXTRACTION_FAILED);
    const g = evidenceReadinessGate(pkg);
    assert('fail-all: gate execution = ERROR (NOT block)', g.execution === EXEC.ERROR);
    assert('fail-all: gate reason = EVIDENCE_EXTRACTION_FAILED', g.reason_code === 'EVIDENCE_EXTRACTION_FAILED');
    assert('fail-all: gate business = UNRESOLVED', g.business_decision === 'UNRESOLVED');
  }

  // 2) transient: fail attempt 1, succeed attempt 2 -> recovers to PRESENT_READABLE, READY
  {
    const pkg = await assembleEvidencePackage(appRow(), mkDeps({ dl: (n) => (n === 1 ? 'throw' : 'ok') }), { attempts: 3 });
    const a = appPdf(pkg);
    assert('transient: application_pdf recovered to PRESENT_READABLE', a.state === STATE.PRESENT_READABLE);
    assert('transient: took 2 attempts', a.attempts === 2);
    assert('transient: readiness = READY', pkg.readiness === READINESS.READY);
    assert('transient: gate lets it proceed (null)', evidenceReadinessGate(pkg) === null);
  }

  // 3) empty transcription is a FAILURE, not readable content -> EXTRACTION_FAILED
  {
    const pkg = await assembleEvidencePackage(appRow(), mkDeps({ transcript: '   ' }), { attempts: 3 });
    assert('empty-transcript: application_pdf = EXTRACTION_FAILED', appPdf(pkg).state === STATE.EXTRACTION_FAILED);
    assert('empty-transcript: readiness = EXTRACTION_FAILED', pkg.readiness === READINESS.EXTRACTION_FAILED);
  }

  // 4) no PDF path + no substantive summary -> NOT_APPLICABLE + INCOMPLETE (ask for it)
  {
    const pkg = await assembleEvidencePackage(appRow({ application_pdf_storage_path: null, project_summary: '' }), mkDeps(), { attempts: 3 });
    assert('no-pdf: application_pdf = NOT_APPLICABLE', appPdf(pkg).state === STATE.NOT_APPLICABLE);
    assert('no-pdf: readiness = INCOMPLETE', pkg.readiness === READINESS.INCOMPLETE);
    assert('no-pdf: gate = NEED_INFO / EVIDENCE_MISSING', (() => { const g = evidenceReadinessGate(pkg); return g.business_decision === 'NEED_INFO' && g.reason_code === 'EVIDENCE_MISSING'; })());
  }

  // 5) governing docs retrieval THROWS (required) -> EXTRACTION_FAILED
  {
    const deps = mkDeps(); deps.getRelevantChunks = async () => { throw new Error('retrieval down'); };
    const pkg = await assembleEvidencePackage(appRow(), deps, { attempts: 2 });
    assert('gov-throw: governing_docs = EXTRACTION_FAILED', pkg.manifest.find((m) => m.source === 'governing_docs').state === STATE.EXTRACTION_FAILED);
    assert('gov-throw: readiness = EXTRACTION_FAILED', pkg.readiness === READINESS.EXTRACTION_FAILED);
  }

  // 6) ACCEPTANCE: the application PDF ALWAYS lands in exactly one valid state,
  //    and is NEVER absent from the manifest while READY.
  for (const scenario of [
    { name: 'ok', deps: mkDeps() },
    { name: 'fail-all', deps: mkDeps({ dl: () => 'throw' }) },
    { name: 'transient', deps: mkDeps({ dl: (n) => (n <= 2 ? 'throw' : 'ok') }) },
  ]) {
    const pkg = await assembleEvidencePackage(appRow(), scenario.deps, { attempts: 3 });
    const a = appPdf(pkg);
    assert(`acceptance[${scenario.name}]: application_pdf present in manifest with a valid state`, !!a && VALID_STATES.includes(a.state));
    if (pkg.readiness === READINESS.READY) assert(`acceptance[${scenario.name}]: READY implies application_pdf is PRESENT_READABLE (never silently gone)`, a.state === STATE.PRESENT_READABLE);
  }

  // 7) package is frozen + content-hashed (shared identical bytes to both models)
  {
    const pkg = await assembleEvidencePackage(appRow(), mkDeps(), { attempts: 3 });
    assert('package is frozen', Object.isFrozen(pkg) && Object.isFrozen(pkg.manifest));
    assert('package carries a content_hash', typeof pkg.content_hash === 'string' && pkg.content_hash.length === 64);
  }

  // 8) a NOT-READY package NEVER reaches reasoning — callModel must not be invoked
  {
    const pkg = await assembleEvidencePackage(appRow(), mkDeps({ dl: () => 'throw' }), { attempts: 3 });
    let called = false;
    const rec = await evaluateApplication({ evidencePackage: pkg, community_name: 'Waterview Estates', human_decision_type: 'approved' }, { callModel: async () => { called = true; return { ok: true, text: '{}' }; } });
    assert('gated: no model call reached', called === false);
    assert('gated: shadow_status ok (isolated, not an error path)', rec.shadow_status === 'ok');
    assert('gated: business = UNRESOLVED, execution = ERROR', rec.business_decision === 'UNRESOLVED' && rec.execution === EXEC.ERROR);
    assert('gated: reason = EVIDENCE_EXTRACTION_FAILED, flagged gated_before_reasoning', rec.reason_code === 'EVIDENCE_EXTRACTION_FAILED' && rec.gated_before_reasoning === true);
  }

  console.log(failed ? `\nEVIDENCE PACKAGE TEST FAILED: ${failed}\n` : '\nEVIDENCE PACKAGE PHASE 1 PASSED.\n');
  process.exit(failed ? 1 : 0);
})();
