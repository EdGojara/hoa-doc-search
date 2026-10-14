// ============================================================================
// lib/contracts/folder_ingest.js  (Ed 2026-10-14: "a reusable contract-ingestion
// workflow, not a manual Canyon Gate-only import")
// ----------------------------------------------------------------------------
// Brings a community's agreements in from the client folder the platform already
// reaches (the synced OneDrive client folder), with no download and re-upload by a
// person. Per document:
//
//   read bytes -> extract (vendor_contract_extractor: Claude reads the binary, so
//   scanned PDFs work) -> classify what the document IS -> file the ORIGINAL into
//   library_documents with its source path -> only a signed contract-type document
//   becomes a vendor_contracts row (machine status at most likely_executed) ->
//   vendor + GL account matched from billing evidence when it is unambiguous.
//
// Controls (Ed: "Never assume a contract is active or a proposed price is binding
// without evidence"):
//   - A proposal, memo, COI, policy, inspection or unsigned agreement is filed as
//     evidence and NEVER becomes a contract record, so it is never priced.
//   - An agreement past its end date that does not auto-renew is recorded 'expired'.
//   - Nothing is verified here: verification is a named person in the app.
//   - Idempotent: the same bytes are never filed or recorded twice.
// Community differences live in the folder and the data, never in this code.
// ============================================================================

const fs = require('fs');
const path = require('path');
const { contractRecord, fileContractDocument, sha256 } = require('./intake');
const { normName } = require('../budget/contract_review');

const CONTRACT_KINDS = ['contract', 'renewal_or_amendment', 'engagement_letter', 'management_agreement'];
const READABLE = /\.(pdf|xlsx|xls|csv)$/i;

// What happens to one extracted document. Pure: no I/O.
function planDocument(ex, { as_of }) {
  const kind = ex.document_kind || 'other';
  const sig = ex.signatures || {};
  const signed = !!(sig.association_signed || sig.vendor_signed);
  const category = kind === 'management_agreement' ? 'management_agreement' : kind === 'insurance_policy' ? 'insurance_dec_page' : CONTRACT_KINDS.includes(kind) && signed ? 'vendor_contract' : 'other';
  const label = { proposal: 'Proposal', memo: 'Memo', certificate_of_insurance: 'Certificate of insurance', insurance_policy: 'Insurance policy', inspection_or_permit: 'Inspection/permit', other: 'Document' }[kind];
  const base = { kind, signed, category };
  if (!CONTRACT_KINDS.includes(kind)) return { ...base, disposition: 'evidence_only', label, reason: `${label || kind} on its face: filed as evidence, not a contract, never priced.` };
  if (!ex.vendor_name) return { ...base, disposition: 'evidence_only', label: 'Unidentified agreement', reason: 'No counterparty could be read: filed as evidence for review.' };
  if (!signed) return { ...base, disposition: 'evidence_only', label: 'Unsigned agreement', reason: 'No signature appears on this copy: filed as evidence; the executed copy is needed before its terms are relied on.' };
  const priced = !!(ex.annual_amount || ex.total_amount || ex.periodic_amount != null || (ex.rate_schedule || []).length || (ex.unit_pricing || []).length || (ex.one_time_fees || []).length);
  if (!priced && !ex.effective_date && !ex.end_date) return { ...base, category: base.category === 'vendor_contract' ? 'other' : base.category, disposition: 'evidence_only', label: 'Signed page without terms', reason: 'Signed, but this copy carries no price and no term (a signature page or letter): filed as evidence; the full agreement is needed.' };
  const expired = ex.end_date && ex.end_date < as_of && !ex.auto_renews;
  return { ...base, disposition: 'contract', contract_status: expired ? 'expired' : 'active', label: 'Agreement',
    reason: expired ? `Signed, but ended ${ex.end_date} and does not auto-renew: recorded as expired.` : 'Signed agreement: recorded for review (machine-read; a person verifies execution).' };
}

// The billing evidence for a vendor name: the vendor record and its dominant GL account.
// Matched only when unambiguous (one vendor; one account carrying >= 80% of 12 months' billing).
function matchVendorAccount(vendorName, { vendors, spendByVendor }) {
  const n = normName(vendorName);
  if (!n) return { vendor_id: null, account_id: null, note: 'no vendor name' };
  const hits = vendors.filter((v) => { const m = normName(v.name); return m && (m === n || m.startsWith(n) || n.startsWith(m)); });
  if (hits.length !== 1) return { vendor_id: null, account_id: null, note: hits.length ? `ambiguous: ${hits.map((v) => v.name).join(' / ')}` : 'no vendor record bills this community under that name' };
  const v = hits[0];
  const by = spendByVendor[v.id] || {};
  const total = Object.values(by).reduce((a, b) => a + b, 0);
  const [top, cents] = Object.entries(by).sort((a, b) => b[1] - a[1])[0] || [];
  const share = total ? cents / total : 0;
  return { vendor_id: v.id, vendor_name: v.name, account_id: share >= 0.8 ? top : null, billed: total > 0,
    note: share >= 0.8 ? `billing evidence: ${Math.round(share * 100)}% of 12 months on one account` : total ? `billing split across accounts (${Math.round(share * 100)}% max): account left for review` : 'vendor has no billing in 12 months' };
}

function listFiles(root) {
  const out = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else out.push(p); } };
  walk(root);
  return out.sort();
}

async function loadBillingEvidence(supabase, community_id, as_of) {
  const from = new Date(new Date(as_of).getTime() - 365 * 86400000).toISOString().slice(0, 10);
  const must = (r, w) => { if (r.error) throw new Error(`${w}: ${r.error.message}`); return r.data; };
  const inv = must(await supabase.from('ap_invoices').select('id, vendor_id').eq('community_id', community_id).gt('invoice_date', from).lte('invoice_date', as_of).is('voided_at', null).order('id').limit(5000), 'invoices');
  const ids = inv.map((i) => i.id); const vOf = Object.fromEntries(inv.map((i) => [i.id, i.vendor_id]));
  const spendByVendor = {};
  for (let k = 0; k < ids.length; k += 200) {
    for (const l of must(await supabase.from('ap_invoice_lines').select('invoice_id, gl_account_id, amount_cents').in('invoice_id', ids.slice(k, k + 200)).limit(5000), 'lines')) {
      const v = vOf[l.invoice_id]; if (!v || !l.gl_account_id) continue;
      (spendByVendor[v] = spendByVendor[v] || {})[l.gl_account_id] = (spendByVendor[v][l.gl_account_id] || 0) + Number(l.amount_cents);
    }
  }
  const vids = Object.keys(spendByVendor);
  const vendors = vids.length ? must(await supabase.from('vendors').select('id, name').in('id', vids), 'vendors') : [];
  return { vendors, spendByVendor };
}

// Ingest every readable document under `folder` (or the listed `paths`: files or folders
// under it) for one community. apply=false extracts and plans without writing.
// `extract` is injectable for tests.
async function ingestFolder(supabase, { community_id, folder, paths = null, source_label, actor = 'Emma (AI team)', as_of, apply = false, extract, cache = {}, log = console }) {
  as_of = as_of || new Date().toISOString().slice(0, 10);
  const evidence = await loadBillingEvidence(supabase, community_id, as_of);
  const results = [];
  const files = paths ? paths.flatMap((p) => (fs.statSync(p).isDirectory() ? listFiles(p) : [p])) : listFiles(folder);
  for (const file of files) {
    const rel = path.relative(folder, file).split(path.sep).join('/');
    const source = `${source_label ? `${source_label}/` : ''}${rel}`;
    if (!READABLE.test(file)) { results.push({ source, outcome: 'skipped', reason: 'format the extractor cannot read (open and save as PDF to include it)' }); continue; }
    const buffer = fs.readFileSync(file);
    const file_hash = sha256(buffer);
    const { data: dup, error: de } = await supabase.from('vendor_contracts').select('id').eq('community_id', community_id).eq('file_hash', file_hash).limit(1);
    if (de) throw de;
    if (dup.length) { results.push({ source, outcome: 'already_recorded', contract_id: dup[0].id }); continue; }
    const { data: filed, error: fe } = await supabase.from('library_documents').select('id, category').eq('community_id', community_id).eq('file_hash', file_hash).limit(1);
    if (fe) throw fe;
    if (filed.length && filed[0].category !== 'vendor_contract') { results.push({ source, outcome: 'already_filed', library_document_id: filed[0].id }); continue; }
    let ex = cache[file_hash];
    if (!ex) {
      try { ex = await extract(buffer, /\.pdf$/i.test(file) ? 'application/pdf' : 'application/octet-stream', path.basename(file)); cache[file_hash] = ex; }
      catch (err) { log.warn(`[folder_ingest] extraction failed for ${source}: ${err.message}`); results.push({ source, outcome: 'extraction_failed', reason: err.message }); continue; }
    }
    let plan = planDocument(ex, { as_of });
    const match = plan.disposition === 'contract' ? matchVendorAccount(ex.vendor_name, evidence) : null;
    // No dated term and no billing in 12 months: nothing shows this agreement is current
    // (typically a predecessor's contract left in the folder). Evidence, never active.
    if (plan.disposition === 'contract' && !ex.effective_date && !ex.end_date && !(match && match.billed)) {
      plan = { ...plan, disposition: 'evidence_only', category: 'other', label: 'Agreement not shown current', contract_status: undefined,
        reason: 'Signed, but it states no dates and the vendor has not billed this community in 12 months: no evidence it is in force; filed as evidence.' };
    }
    const row = { source, file_hash, plan, match, extraction: ex };
    if (apply) {
      const notes = `Source: ${source}. Filed by ${actor} on ${as_of} (${plan.reason})`;
      const title = plan.disposition === 'contract' ? null
        : `${plan.label || 'Document'}: ${ex.vendor_name || path.basename(file, path.extname(file))}${ex.effective_date ? ` - ${ex.effective_date.slice(0, 4)}` : ''}`;
      const doc = await fileContractDocument(supabase, { community_id, buffer, filename: path.basename(file), mimetype: 'application/pdf', extraction: ex, category: plan.category, title, notes });
      row.library_document_id = doc.library_document_id; row.reused = doc.reused;
      if (plan.disposition === 'contract') {
        const rec = contractRecord({ management_company_id: doc.management_company_id, community_id, extraction: ex, file_path: doc.file_path, file_hash, file_size_bytes: buffer.length,
          forecast_account_id: match.account_id, source_document_id: doc.library_document_id, intake_source: 'upload', actor });
        rec.vendor_id = match.vendor_id; rec.status = plan.contract_status;
        rec.notes = `${notes}. Vendor/account match: ${match.note}.`;
        const { data: ins, error: ie } = await supabase.from('vendor_contracts').insert(rec).select('id, execution_status').single();
        if (ie) { log.warn(`[folder_ingest] contract insert failed for ${source}: ${ie.message}`); row.outcome = 'contract_insert_failed'; row.reason = ie.message; results.push(row); continue; }
        row.contract_id = ins.id; row.execution_status = ins.execution_status;
      }
    }
    row.outcome = plan.disposition === 'contract' ? (apply ? 'contract_recorded' : 'would_record_contract') : (apply ? 'filed_as_evidence' : 'would_file_as_evidence');
    results.push(row);
  }
  return results;
}

module.exports = { ingestFolder, planDocument, matchVendorAccount, listFiles, CONTRACT_KINDS };
