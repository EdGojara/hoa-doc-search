// tests/test_recover_historical_letters.js — the pure planning gate of
// scripts/recover_historical_letters.js (Issue #11). Synthetic data only.
const crypto = require('crypto');
const { planEntry, recoveryKey } = require('../scripts/recover_historical_letters');

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { if (cond) { pass++; console.log('PASS ', name); } else { fail++; console.log('FAIL ', name, extra); } };
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

const C = 'a0000000-0000-4000-8000-000000000001';
const V = 'b0000000-0000-4000-8000-000000000001';
const P = 'c0000000-0000-4000-8000-000000000001';
const PDF = Buffer.from('%PDF-1.7 sample letter bytes');
const OTHER = Buffer.from('%PDF-1.7 different bytes');
const violation = { id: V, community_id: C, property_id: P, current_stage: 'voided' };
const rejected = { id: 'i1', violation_id: V, status: 'rejected', created_at: '2026-07-30T20:51:12Z', type: 'letter_209' };
const draft = { id: 'i2', violation_id: V, status: 'draft', created_at: '2026-07-31T15:18:31Z', type: 'letter_209', content: `${V}/d.pdf` };
const base = (o = {}) => ({ violation_id: V, mailed_on: '2026-07-30', provenance: 'reconstructed', sha256: sha(PDF), reason: 'mailed per receipt',
  reconstruction: { renderer_commit: '0fc480f5' }, prior_interaction_id: 'i1', source: { file: 'x.pdf' }, ...o });
const facts = (o = {}) => ({ violation, prior: rejected, bytes: PDF, priorBytes: null, existingRecovery: null, feeAutopost: false, ...o });

let r = planEntry(base(), facts(), C);
check('a reconstructed mailing on a voided case plans a NEW sent record (the case is not reopened)', r.ok && r.action === 'new_sent', JSON.stringify(r));
r = planEntry(base({ sha256: sha(OTHER) }), facts(), C);
check('bytes that differ from the reviewed PDF block the entry', !r.ok && r.problems.some((p) => /does not match the reviewed/.test(p)));
r = planEntry(base(), facts({ bytes: Buffer.from('not a pdf') }), C);
check('a non-PDF source blocks', !r.ok && r.problems.some((p) => /not a PDF/.test(p)));
r = planEntry(base({ mailed_at: '2026-07-31T02:00:00Z' }), facts(), C);
check('an acceptance time that is 07-30 21:00 Central is on the receipt date', r.ok, JSON.stringify(r));
r = planEntry(base({ mailed_at: '2026-07-31T15:00:00Z' }), facts(), C);
check('an acceptance time on another day blocks', !r.ok && r.problems.some((p) => /is not on/.test(p)));
r = planEntry(base({ reconstruction: null }), facts(), C);
check('a reconstruction without method detail blocks', !r.ok);
r = planEntry(base({ provenance: 'recovered_original' }), facts(), C);
check('an original carrying reconstruction detail blocks', !r.ok);
r = planEntry(base(), facts({ violation: { ...violation, community_id: 'other' } }), C);
check('a violation from another community blocks', !r.ok && r.problems.some((p) => /another community/.test(p)));
r = planEntry(base(), facts({ prior: { ...rejected, created_at: '2026-08-02T10:00:00Z' } }), C);
check('a prior letter created after the mailing date blocks', !r.ok && r.problems.some((p) => /after the mailing date/.test(p)));
r = planEntry(base(), facts({ prior: { ...rejected, violation_id: 'other' } }), C);
check('a prior letter from another violation blocks', !r.ok);
r = planEntry(base(), facts({ existingRecovery: { sha256: sha(PDF) } }), C);
check('idempotent: an existing recovery with the same bytes is skipped', r.ok && r.action === 'already_recorded');
r = planEntry(base(), facts({ existingRecovery: { sha256: sha(OTHER) } }), C);
check('an existing recovery with different bytes blocks loudly', !r.ok && r.action === 'already_recorded');

const orig = base({ provenance: 'recovered_original', reconstruction: undefined, mailed_on: '2026-07-31', prior_interaction_id: 'i2', reuse_draft: true });
r = planEntry(orig, facts({ prior: draft, priorBytes: PDF }), C);
check('a surviving draft with identical bytes is reused (marked mailed, not duplicated)', r.ok && r.action === 'reuse_draft', JSON.stringify(r));
r = planEntry(orig, facts({ prior: draft, priorBytes: OTHER }), C);
check('reuse is refused when the draft PDF is not byte-identical', !r.ok);
r = planEntry(orig, facts({ prior: { ...draft, status: 'sent' }, priorBytes: PDF }), C);
check('a partial reuse run can resume (draft already marked sent, same bytes)', r.ok && r.action === 'reuse_draft', JSON.stringify(r));
r = planEntry(orig, facts({ prior: { ...draft, status: 'sent' }, priorBytes: OTHER }), C);
check('an unrelated sent letter is not taken over', !r.ok);
r = planEntry(base({ mailed_on: '2026-08-03' }), facts({ feeAutopost: true, prior: { ...rejected, created_at: '2026-08-01T10:00:00Z' } }), C);
check('refuses when certified-fee autopost could fire on the new mail piece', !r.ok && r.problems.some((p) => /autopost/.test(p)));
r = planEntry(base(), facts({ feeAutopost: true }), C);
check('July mailings are before the autopost start date, so autopost cannot fire', r.ok);
check('recovery key is property:date:violation', recoveryKey(P, '2026-07-30', V) === `${P}:2026-07-30:${V}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
