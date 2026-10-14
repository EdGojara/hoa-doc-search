// Contract ingestion from a community's client folder (lib/contracts/folder_ingest). Shapes are
// Canyon Gate's: a signed scanned landscape contract, the Aegis 2027 proposal, an unsigned revision
// of the management agreement, a CPA engagement signed by the association only, an expired
// electricity contract, a flood policy and a COI. The rule under test: only a signed contract-type
// document becomes a contract record; everything else is filed as evidence and never priced.
const fs = require('fs');
const os = require('os');
const path = require('path');
const F = require('../lib/contracts/folder_ingest');
let pass = 0, fail = 0;
const check = (name, ok, info) => { if (ok) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name + (info ? ' :: ' + info : '')); } };
const AS_OF = '2026-10-14';
const both = { association_signed: true, vendor_signed: true, association_signed_date: '2026-05-01', vendor_signed_date: '2026-05-01' };
const none = { association_signed: false, vendor_signed: false };

console.log('classification');
{
  const p = (ex) => F.planDocument(ex, { as_of: AS_OF });
  const land = p({ document_kind: 'contract', vendor_name: 'Earthcare Management, Inc.', signatures: both, periodic_amount: 8168.75, effective_date: '2026-06-01', end_date: null, auto_renews: true });
  check('a signed contract becomes a contract record, active', land.disposition === 'contract' && land.contract_status === 'active' && land.category === 'vendor_contract');
  const prop = p({ document_kind: 'proposal', vendor_name: 'Aegis Aquatics, LLC', signatures: none, periodic_amount: 4454.5 });
  check('a proposal is filed as evidence and never priced, even with prices on it', prop.disposition === 'evidence_only' && /never priced/.test(prop.reason));
  const signedProp = p({ document_kind: 'proposal', vendor_name: 'The Shines Group', signatures: { association_signed: true } });
  check('a proposal stays a proposal even if someone signed the acceptance line (classification is by kind, then signature)', signedProp.disposition === 'evidence_only');
  const mgmt = p({ document_kind: 'management_agreement', vendor_name: 'Bedrock Association Management, LLC', signatures: none });
  check('an unsigned management agreement is evidence only; the executed copy is needed', mgmt.disposition === 'evidence_only' && /executed copy is needed/.test(mgmt.reason) && mgmt.category === 'management_agreement');
  const cox = p({ document_kind: 'engagement_letter', vendor_name: 'Cox CPA Services, Inc.', signatures: { association_signed: true, vendor_signed: false }, annual_amount: 5470 });
  check('an engagement letter signed by the association is a contract record (execution left for a person to verify)', cox.disposition === 'contract');
  const txu = p({ document_kind: 'contract', vendor_name: 'TXU Energy Retail Company LLC', signatures: both, end_date: '2025-11-30', auto_renews: false });
  check('a signed contract past its end date that does not auto-renew is recorded EXPIRED', txu.disposition === 'contract' && txu.contract_status === 'expired');
  const ren = p({ document_kind: 'contract', vendor_name: 'X', signatures: both, end_date: '2025-11-30', auto_renews: true });
  check('...but one that auto-renews stays active', ren.contract_status === 'active');
  const flood = p({ document_kind: 'insurance_policy', vendor_name: 'Hamann Insurance Group', signatures: none });
  check('an insurance policy is filed to the insurance category, not as a vendor contract', flood.disposition === 'evidence_only' && flood.category === 'insurance_dec_page');
  check('a COI, memo and inspection report are evidence only', ['certificate_of_insurance', 'memo', 'inspection_or_permit'].every((k) => p({ document_kind: k, vendor_name: 'A', signatures: both }).disposition === 'evidence_only'));
  const page = p({ document_kind: 'contract', vendor_name: 'A-Beautiful Pools, Inc.', signatures: both, annual_amount: 0 });
  check('a signed page with no price and no term (a signature page, a representation letter) is evidence, not a contract', page.disposition === 'evidence_only' && /no price and no term/.test(page.reason) && page.category === 'other');
  check('an unknown kind is evidence only (never defaults to binding)', p({ vendor_name: 'A', signatures: both }).disposition === 'evidence_only');
}

console.log('vendor and account matching from billing evidence');
{
  const vendors = [{ id: 'v1', name: 'Earthcare Management, Inc.' }, { id: 'v2', name: 'Aegis Aquatics, LLC' }, { id: 'v3', name: 'Comcast' }, { id: 'v4', name: 'Comcast Business' }];
  const spendByVendor = { v1: { a5200: 3949200, a5125: 286500, a5220: 70900, a5100: 12400 }, v2: { a5300: 758400, a5310: 74300, a5330: 27700 } };
  const e = F.matchVendorAccount('EarthCare Management Inc', { vendors, spendByVendor });
  check('the vendor matches by normalized name and the dominant account (>=80%) is bound', e.vendor_id === 'v1' && e.account_id === 'a5200', JSON.stringify(e));
  const a = F.matchVendorAccount('Aegis Aquatics', { vendors, spendByVendor });
  check('Aegis: 88% on 5300, bound', a.account_id === 'a5300');
  const c = F.matchVendorAccount('Comcast', { vendors, spendByVendor });
  check('two vendor records under one name: ambiguous, nothing bound', c.vendor_id === null && /ambiguous/.test(c.note));
  const n = F.matchVendorAccount('Gate Sentry, LLC', { vendors, spendByVendor });
  check('no vendor record: nothing bound, and it says so', n.vendor_id === null && /no vendor record/.test(n.note));
  const split = F.matchVendorAccount('Earthcare', { vendors, spendByVendor: { v1: { a: 50, b: 50 } } });
  check('billing split across accounts: vendor linked, account left for review', split.vendor_id === 'v1' && split.account_id === null);
}

console.log('folder run (plan only, no writes)');
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fi-'));
  fs.mkdirSync(path.join(dir, 'POOL'));
  fs.writeFileSync(path.join(dir, 'Landscape Contract.pdf'), 'pdf-a');
  fs.writeFileSync(path.join(dir, 'POOL', 'Aegis 2027.pdf'), 'pdf-b');
  fs.writeFileSync(path.join(dir, 'Code of Conduct.docx'), 'docx');
  fs.writeFileSync(path.join(dir, 'Old Landscape Contract.pdf'), 'pdf-c');
  const q = (rows) => { const b = { select: () => b, eq: () => b, gt: () => b, lte: () => b, is: () => b, in: () => b, order: () => b, limit: () => Promise.resolve({ data: rows, error: null }) }; return b; };
  const writes = [];
  const supabase = { from: (t) => { if (t === 'vendor_contracts' || t === 'library_documents') { const b = q([]); b.insert = (r) => { writes.push(t); return b; }; return b; } return q([]); } };
  const ex = { 'pdf-a': { document_kind: 'contract', vendor_name: 'Earthcare Management, Inc.', signatures: both, periodic_amount: 8168.75, effective_date: '2026-06-01' }, 'pdf-b': { document_kind: 'proposal', vendor_name: 'Aegis Aquatics, LLC', signatures: none },
    'pdf-c': { document_kind: 'contract', vendor_name: 'GreenScape Associates, LLC', signatures: { association_signed: true, vendor_signed: true }, periodic_amount: 7593.26, periodic_frequency: 'monthly', effective_date: null, end_date: null } };
  const r = await F.ingestFolder(supabase, { community_id: 'c', folder: dir, source_label: 'OneDrive/Client - X/Contracts', as_of: AS_OF, extract: async (buf) => ex[buf.toString()] });
  const by = (s) => r.find((x) => x.source.endsWith(s));
  check('the source path is preserved on every result', by('Aegis 2027.pdf').source === 'OneDrive/Client - X/Contracts/POOL/Aegis 2027.pdf');
  check('plan only: the contract would be recorded, the proposal would be filed as evidence', by('Landscape Contract.pdf').outcome === 'would_record_contract' && by('Aegis 2027.pdf').outcome === 'would_file_as_evidence');
  check('a signed, undated contract from a vendor that has not billed in 12 months is NOT recorded active (a predecessor\'s contract left in the folder)', by('Old Landscape Contract.pdf').outcome === 'would_file_as_evidence' && /no evidence it is in force/.test(by('Old Landscape Contract.pdf').plan.reason));
  check('an unreadable format is skipped and named, never silently dropped', by('Code of Conduct.docx').outcome === 'skipped');
  check('plan only writes nothing', writes.length === 0);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
