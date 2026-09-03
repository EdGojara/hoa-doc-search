// =============================================================================
// tests/test_amanda_insurance_rfp.js — Amanda produces an insurance RFP on request
// =============================================================================
//
// Ed 2026-09-03: "create that capability for amanda ... if i email Amanda to
// prepare one for any community she will send one back to me."
//
// Guards: (1) Amanda recognizes an RFP request and not a proposal review or a
// homeowner reply; (2) she resolves the community from the email; (3) the
// completeness guard sits IN FRONT of the send — an incomplete program produces
// a "here's what's missing" reply, never a half RFP with a PDF attached.
//
// Uses a tiny mock supabase; the incomplete/no-program paths return before any
// PDF render, so there's no puppeteer/network dependency.
//
// Run: node tests/test_amanda_insurance_rfp.js   (wired into npm test)
// =============================================================================

const assert = require('assert');
const { isInsuranceRfpRequest, resolveRfpCommunity, draftAmandaInsuranceRfp } = require('../lib/community/amanda_insurance_rfp');
const { buildCommunityRfp } = require('../lib/insurance_rfp_build');

let failures = 0;
async function check(name, fn) {
  try { await fn(); console.log(`  PASS  ${name}`); }
  catch (e) { failures++; console.log(`  FAIL  ${name}`); console.log(`        ${e.message}`); }
}

// --- tiny mock supabase --------------------------------------------------------
function chain(data, singleData) {
  const o = {};
  for (const m of ['select', 'eq', 'order', 'limit', 'in']) o[m] = () => o;
  o.maybeSingle = async () => ({ data: singleData !== undefined ? singleData : null });
  o.then = (resolve) => resolve({ data });
  return o;
}
function mockSb(tables) { return { from: (t) => tables[t] || chain([]) }; }

const WATERVIEW = { id: 'c1', name: 'Waterview Estates' };
function sbWith(programs, policies, docs) {
  return mockSb({
    communities: chain([WATERVIEW], WATERVIEW),
    insurance_programs: chain(programs),
    insurance_policies: chain(policies),
    library_documents: chain(docs),
  });
}

const COMPLETE = [
  { coverage_line: 'Property', limits: [{ amount: '$941,600' }] },
  { coverage_line: 'General Liability', limits: [{ amount: '$1,000,000' }] },
  { coverage_line: 'Directors & Officers', limits: [{ amount: '$1,000,000' }] },
  { coverage_line: 'Umbrella/Excess Liability', limits: [{ amount: '$5,000,000' }] },
  { coverage_line: 'Crime/Fidelity', limits: [{ amount: '$100,000' }] },
  { coverage_line: 'Cyber', limits: [{ amount: '$1,000,000' }] },
  { coverage_line: 'Workers Compensation', limits: [{ amount: '$1,000,000' }] },
];
const INCOMPLETE = [
  { coverage_line: 'General Liability', limits: [{ amount: '$1,000,000' }] },
  { coverage_line: 'Directors & Officers', limits: [{ amount: '$1,000,000' }] },
  { coverage_line: 'Umbrella/Excess Liability', limits: [{ amount: '$5,000,000' }] },
  { coverage_line: 'Workers Compensation', limits: [{ amount: '$1,000,000' }] },
  { coverage_line: 'Crime/Fidelity', limits: [] },
];
const SRC_DOCS = [{ file_name_original: 'POLICY - PROP.pdf' }, { file_name_original: 'POLICY - CYBER.pdf' }, { file_name_original: 'POLICY - CRIME.pdf' }];
const activeProgram = (srcIds) => ({ id: 'p1', status: 'active', entity: { named_insured: 'Waterview Estates Owners Association, Inc' }, source_document_ids: srcIds, statement_of_values: [], notes: [] });

(async () => {
  await check('recognizes an insurance RFP request', () => {
    const yes = [
      { subject: 'Insurance RFP', body_full: 'Amanda, please prepare the insurance RFP for Waterview.' },
      { body_full: 'can you put together an insurance request for proposal for Drama Creek?' },
      { subject: 'need insurance rfp', body_full: 'produce one for August Meadows' },
    ];
    for (const e of yes) assert.ok(isInsuranceRfpRequest(e), `should fire: ${JSON.stringify(e)}`);
  });

  await check('does NOT fire on a proposal review or a homeowner reply', () => {
    const no = [
      { subject: 'Insurance renewal proposal', body_full: 'Please review the attached insurance proposal.' },
      { body_full: 'Hi Amanda, please help me respond to the homeowner about their fence.' },
      { body_full: 'Can you review this vendor contract for insurance requirements?' },
    ];
    for (const e of no) assert.ok(!isInsuranceRfpRequest(e), `should NOT fire: ${JSON.stringify(e)}`);
  });

  await check('resolves the community named in the email', async () => {
    const sb = sbWith([], [], []);
    const r = await resolveRfpCommunity(sb, { body_full: 'prepare the insurance RFP for Waterview please' }, null);
    assert.ok(r && r.id === 'c1', `expected Waterview; got ${JSON.stringify(r)}`);
  });

  await check('buildCommunityRfp BLOCKS an incomplete program (no render)', async () => {
    const sb = sbWith([activeProgram(['d1', 'd2', 'd3'])], INCOMPLETE, SRC_DOCS);
    const res = await buildCommunityRfp({ supabase: sb, communityId: 'c1' });
    assert.strictEqual(res.ok, false, 'should block');
    assert.ok(!res.pdfBuffer, 'no PDF on a blocked build');
    assert.ok(res.completeness.blockers.some((b) => b.startsWith('Property:')), 'names Property');
  });

  await check('buildCommunityRfp passes a complete program (render:false)', async () => {
    const sb = sbWith([activeProgram([])], COMPLETE, []);
    const res = await buildCommunityRfp({ supabase: sb, communityId: 'c1', render: false });
    assert.strictEqual(res.ok, true, `expected ok; ${JSON.stringify(res.completeness && res.completeness.blockers)}`);
    assert.strictEqual(res.program.coverages.length, 7);
  });

  await check('Amanda replies with the missing lines and NO attachment when incomplete', async () => {
    const sb = sbWith([activeProgram(['d1', 'd2', 'd3'])], INCOMPLETE, SRC_DOCS);
    const d = await draftAmandaInsuranceRfp({
      email: { sender_name: 'Ed Gojara', subject: 'Insurance RFP', body_full: 'prepare the insurance RFP for Waterview' },
      supabase: sb, communityId: 'c1', communityName: 'Waterview Estates',
    });
    assert.ok(d.draftable, 'draftable');
    assert.ok(!d.attachments, 'must NOT attach a half RFP');
    assert.ok(/Property/.test(d.body), 'body names the missing Property line');
    assert.ok(/Hi Ed/.test(d.body), 'greets the requester');
  });

  await check('Amanda attaches the RFP with the shape persistDraftAttachments expects', async () => {
    const sb = sbWith([activeProgram([])], COMPLETE, []);
    const fakeBuild = async () => ({ ok: true, filename: 'Waterview_Insurance_RFP.pdf', pdfBuffer: Buffer.from('%PDF-1.4 fake'), program: { coverages: COMPLETE.map((c) => ({ line: c.coverage_line })) }, community: 'Waterview Estates' });
    const d = await draftAmandaInsuranceRfp({
      email: { sender_name: 'Ed', subject: 'Insurance RFP', body_full: 'prepare the insurance RFP for Waterview' },
      supabase: sb, communityId: 'c1', communityName: 'Waterview Estates', _build: fakeBuild,
    });
    assert.ok(d.attachments && d.attachments.length === 1, 'one attachment');
    const a = d.attachments[0];
    // persistDraftAttachments filters on `a.content`; `buffer` silently drops it.
    assert.ok(Buffer.isBuffer(a.content) && a.content.length, 'attachment carries a content buffer');
    assert.ok(a.content && !a.buffer, 'uses content, not buffer');
    assert.ok(/Attached is the insurance RFP/.test(d.body), 'body promises the attachment');
  });

  await check('Amanda asks which community when none is named', async () => {
    const sb = sbWith([], [], []);
    const d = await draftAmandaInsuranceRfp({
      email: { sender_name: 'Ed', subject: 'Insurance RFP', body_full: 'can you prepare an insurance rfp?' },
      supabase: sb, communityId: null, communityName: null,
    });
    assert.ok(d.draftable && /which community/i.test(d.body), 'asks which community');
  });

  if (failures) { console.log(`\n${failures} check(s) failed`); process.exit(1); }
  console.log('\nAll Amanda insurance-RFP checks passed.');
})();
