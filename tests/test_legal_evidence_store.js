// ============================================================================
// tests/test_legal_evidence_store.js  (Ed 2026-10-11)
// ----------------------------------------------------------------------------
// Evidence retention: the ORIGINAL is stored once (sha-256), restricted and
// unindexed; a second use merges links/provenance without duplicating; the
// same bytes under another association are refused; a reference is never a
// document; and the open-original link is only issued for retained evidence.
// Deterministic: an in-memory Supabase stub, no DB, no storage.
// ============================================================================
const ES = require('../lib/legal/evidence_store');

let pass = 0, fail = 0;
function ok(c, l) { if (c) { pass++; console.log('  PASS  ' + l); } else { fail++; console.log('  FAIL  ' + l); } }
async function throws(fn, re, l) { try { await fn(); ok(false, l); } catch (e) { ok(re.test(e.message) || re.test(e.code || ''), l + ' (' + e.message + ')'); } }

function stub() {
  const db = { library_documents: [], document_extracted_fields: [] };
  const uploads = [];
  let n = 0;
  const from = (table) => {
    const st = { table, op: 'select', eqs: [], payload: null, single: false, lim: null };
    const rows = () => db[table].filter((r) => st.eqs.every(([k, v]) => r[k] === v));
    const q = {
      select() { return q; }, eq(k, v) { st.eqs.push([k, v]); return q; }, limit(x) { st.lim = x; return q; },
      insert(p) { st.op = 'insert'; st.payload = p; return q; }, update(p) { st.op = 'update'; st.payload = p; return q; },
      single() { st.single = true; return q; },
      then(res, rej) {
        let out;
        if (st.op === 'insert') { const row = Object.assign({ id: table === 'library_documents' ? 'doc-' + (++n) : undefined }, st.payload); db[table].push(row); out = { data: st.single ? row : [row], error: null }; }
        else if (st.op === 'update') { rows().forEach((r) => Object.assign(r, st.payload)); out = { data: null, error: null }; }
        else { const r = rows(); out = { data: st.lim ? r.slice(0, st.lim) : r, error: null }; }
        return Promise.resolve(out).then(res, rej);
      },
    };
    return q;
  };
  const storage = { from: () => ({
    upload: async (p, buf) => { uploads.push(p); return { data: { path: p }, error: null }; },
    createSignedUrl: async (p) => ({ data: { signedUrl: 'https://signed/' + p }, error: null }),
  }) };
  return { from, storage, db, uploads };
}

const CG = 'a0000000-0000-4000-8000-000000000003', WV = 'a0000000-0000-4000-8000-000000000001';
const buf = Buffer.from('%PDF-1.4 notice to 6203 Canyon Top');
const base = { buffer: buf, filename: 'notice.pdf', mime: 'application/pdf', communityId: CG, kind: 'section_209_0064_notice', title: 'Notice',
  source: { system: 'onedrive', ref: 'BEDROCK/x/notice.pdf' }, links: { property_ids: ['p1'], ap_invoice_ids: ['i1'], review_ids: ['r1'] },
  use: { by: 'amanda', purpose: 'recovery research', proves: ['notice content'], uncertain: ['certified number blank: not proof of mailing'] } };

(async () => {
  console.log('legal evidence store');
  const s = stub();

  const a = await ES.storeEvidence(s, base);
  ok(a.created && a.sha256 === ES.sha256(buf), 'first use stores the original');
  const row = s.db.library_documents[0];
  ok(row.member_scope === 'internal_only' && row.index_status === null && row.category === 'legal_evidence', 'restricted, not queued for the shared index, legal category');
  ok(s.uploads.length === 1 && s.uploads[0] === `legal_evidence/${CG}/${a.sha256}.pdf`, 'stored under the association, named by content hash');
  const f1 = s.db.document_extracted_fields[0].fields;
  ok(f1.uses.length === 1 && f1.uses[0].uncertain.length === 1, 'what it proves and what it leaves uncertain are kept');

  const b = await ES.storeEvidence(s, base);
  ok(!b.created && b.document_id === a.document_id && s.db.library_documents.length === 1 && s.uploads.length === 1, 'same bytes again: no second copy');
  ok(s.db.document_extracted_fields[0].fields.uses.length === 1, 'a repeated run by the same agent for the same purpose is not a new use');

  await ES.storeEvidence(s, Object.assign({}, base, { links: { property_ids: ['p2'], ap_invoice_ids: ['i2'] }, use: { by: 'kat', purpose: 'posting check', proves: [], uncertain: [] }, source: { system: 'email', ref: '<m1@x>' } }));
  const f3 = s.db.document_extracted_fields[0].fields;
  ok(f3.links.property_ids.join() === 'p1,p2' && f3.links.ap_invoice_ids.join() === 'i1,i2' && f3.uses.length === 2 && f3.sources.length === 2, 'a new use merges links, uses and sources');

  await throws(() => ES.storeEvidence(s, Object.assign({}, base, { communityId: WV })), /different association|cross_community/, 'same bytes under another association are refused, never re-scoped');
  await throws(() => ES.storeEvidence(s, Object.assign({}, base, { buffer: Buffer.alloc(0) })), /original bytes required/, 'no bytes: a link or summary is not the document');
  await throws(() => ES.storeEvidence(s, Object.assign({}, base, { communityId: null })), /communityId required/, 'association boundary required');
  await throws(() => ES.storeEvidence(s, Object.assign({}, base, { kind: '' })), /kind required/, 'evidence kind required');

  const u = ES.recordUnretrievable({ kind: 'bankruptcy_filing', source: { system: 'pacer', ref: 'Negron' }, reason: 'no access' });
  ok(u.status === 'not_retained' && /not the document/.test(u.note), 'an unretrievable source is recorded as a task, never as a document');

  ok(/^https:\/\/signed\//.test(await ES.signedUrl(s, a.document_id)), 'retained evidence opens through a signed link');
  s.db.library_documents.push({ id: 'gov-1', file_path: 'cg/ccrs.pdf', management_company_id: row.management_company_id });
  s.db.document_extracted_fields.push({ document_id: 'gov-1', fields: { text: 'ccrs' } });
  ok((await ES.signedUrl(s, 'gov-1')) === null, 'a library file that is not retained evidence is refused');

  const sum = ES.evidenceSummary(Object.assign({}, row, { fields: f3 }));
  ok(sum.restricted === true && sum.uses.length === 2 && !('text' in sum), 'summary shows provenance and restriction, never the extracted text');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
