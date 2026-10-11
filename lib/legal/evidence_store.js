// ============================================================================
// lib/legal/evidence_store.js — retain the evidence an agent relied on
// (Ed 2026-10-11)
// ----------------------------------------------------------------------------
// When a person or an agent uses a document or an email as evidence for a
// decision, trustEd keeps the ORIGINAL (the file's bytes, or the email's full
// RFC 822 message with headers and attachments), not a summary or a link.
//
// Reuses what exists: the private `documents` storage bucket and the canonical
// `library_documents` table (sha-256 dedup per management company), with the
// provenance, links and what-it-proves kept in `document_extracted_fields`.
//
// Restricted by default. Legal evidence (attorney reports, demand letters,
// bankruptcy material) is stored with member_scope 'internal_only' and
// index_status NULL, so it is never queued into the shared document index that
// homeowner-facing assistants search (that index has no access filter today).
// Category 'legal_evidence' is in no portal allowlist.
//
// Idempotent: the same bytes are stored once; a second use only merges new
// links/provenance into the existing record. Originals are never altered or
// deleted. If the original cannot be retrieved, recordUnretrievable() keeps the
// source reference as an ingestion task; a reference is never treated as
// equivalent to the stored document.
// ============================================================================
const crypto = require('crypto');
const path = require('path');
const { BEDROCK_MGMT_CO_ID } = require('../company');
const { fetchAllQuery } = require('../db/fetch_all');

const CATEGORY = 'legal_evidence';
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const uniq = (xs) => [...new Set((xs || []).filter((x) => x != null && x !== ''))];
const must = (r, what) => { if (r && r.error) throw Object.assign(new Error(`${what}: ${r.error.message}`), { cause: r.error }); return r ? r.data : null; };

function mergeFields(prev, add) {
  const p = prev || {};
  const out = Object.assign({}, p, {
    evidence_kinds: uniq([...(p.evidence_kinds || []), add.kind]),
    links: {
      property_ids: uniq([...((p.links || {}).property_ids || []), ...((add.links || {}).property_ids || [])]),
      ap_invoice_ids: uniq([...((p.links || {}).ap_invoice_ids || []), ...((add.links || {}).ap_invoice_ids || [])]),
      matter_refs: uniq([...((p.links || {}).matter_refs || []), ...((add.links || {}).matter_refs || [])]),
      review_ids: uniq([...((p.links || {}).review_ids || []), ...((add.links || {}).review_ids || [])]),
      owners: uniq([...((p.links || {}).owners || []), ...((add.links || {}).owners || [])]),
      parent_document_ids: uniq([...((p.links || {}).parent_document_ids || []), ...((add.links || {}).parent_document_ids || [])]),
    },
    sources: [...(p.sources || [])],
    uses: [...(p.uses || [])],
  });
  if (add.source && !out.sources.some((s) => s.system === add.source.system && s.ref === add.source.ref)) out.sources.push(add.source);
  // One entry per (who, purpose): a repeated run is not a new use.
  if (add.use && !out.uses.some((u) => u.by === add.use.by && u.purpose === add.use.purpose)) out.uses.push(Object.assign({ at: new Date().toISOString() }, add.use));
  if (add.text && !p.text) out.text = String(add.text).slice(0, 200000);
  if (add.doc_date && !p.doc_date) out.doc_date = add.doc_date;
  if (add.mime && !p.mime) out.mime = add.mime;
  return out;
}

// storeEvidence(supabase, { buffer, filename, mime, communityId, kind, title,
//   docDate, source: { system, ref, location, sender, received_at, internet_message_id, subject },
//   links: { property_ids, ap_invoice_ids, matter_refs, review_ids, owners, parent_document_ids },
//   use: { by, purpose, proves: [], uncertain: [] }, text })
// -> { document_id, created, sha256, file_path }
async function storeEvidence(supabase, e) {
  if (!supabase) throw new Error('supabase required');
  if (!e || !Buffer.isBuffer(e.buffer) || !e.buffer.length) throw new Error('original bytes required (a link or summary is not the document)');
  if (!e.communityId) throw new Error('communityId required (association boundary)');
  if (!e.kind) throw new Error('evidence kind required');
  const hash = sha256(e.buffer);
  const existing = must(await supabase.from('library_documents').select('id, file_path, community_id').eq('management_company_id', BEDROCK_MGMT_CO_ID).eq('file_hash', hash).limit(1), 'dedup lookup');
  const fieldsFor = async (docId) => {
    const cur = must(await supabase.from('document_extracted_fields').select('fields').eq('document_id', docId).limit(1), 'fields read');
    const merged = mergeFields(cur && cur[0] ? cur[0].fields : null, { kind: e.kind, links: e.links, source: e.source, use: e.use, text: e.text, doc_date: e.docDate, mime: e.mime });
    if (cur && cur[0]) must(await supabase.from('document_extracted_fields').update({ fields: merged }).eq('document_id', docId), 'fields update');
    else must(await supabase.from('document_extracted_fields').insert({ document_id: docId, fields: merged }), 'fields insert');
  };
  if (existing && existing[0]) {
    if (existing[0].community_id && existing[0].community_id !== e.communityId) {
      // Same bytes filed under another association: never re-scoped silently.
      throw Object.assign(new Error('this file is already stored under a different association'), { code: 'cross_community' });
    }
    await fieldsFor(existing[0].id);
    return { document_id: existing[0].id, created: false, sha256: hash, file_path: existing[0].file_path };
  }
  const ext = path.extname(e.filename || '') || (e.mime === 'message/rfc822' ? '.eml' : '');
  const filePath = `legal_evidence/${e.communityId}/${hash}${ext}`;
  const up = await supabase.storage.from('documents').upload(filePath, e.buffer, { contentType: e.mime || 'application/octet-stream', upsert: false });
  if (up.error && !/exists|duplicate/i.test(up.error.message || '')) throw Object.assign(new Error(`storage upload: ${up.error.message}`), { cause: up.error });
  const row = must(await supabase.from('library_documents').insert({
    management_company_id: BEDROCK_MGMT_CO_ID, community_id: e.communityId, category: CATEGORY,
    title: String(e.title || e.filename || e.kind).slice(0, 300), file_name_original: e.filename || null, file_name_normalized: e.filename || null,
    file_path: filePath, file_hash: hash, file_size_bytes: e.buffer.length, effective_date: e.docDate || null, status: 'current',
    member_scope: 'internal_only', index_status: null, uploaded_by: null,   // a user id column; who stored it is in fields.uses
    notes: 'Legal evidence: restricted (internal only); not indexed into the shared document search. Provenance and links in document_extracted_fields.',
  }).select('id').single(), 'library insert');
  await fieldsFor(row.id);
  return { document_id: row.id, created: true, sha256: hash, file_path: filePath };
}

// The original could not be retrieved: keep the reference as an ingestion task.
// Returned to the caller to record on the activity; never stored as a document.
function recordUnretrievable({ kind, source, reason, needed }) {
  return { status: 'not_retained', kind, source, reason, needed: needed || 'access or an export of the original', note: 'A source reference is not the document; the original still needs to be ingested.' };
}

// Evidence already retained for an invoice / matter / property (staff use).
// Found by its links, not its category: a document already in the library
// under another category (an attorney report filed earlier) that was later
// relied on carries the same evidence fields and must show up too.
async function findEvidence(supabase, { communityId, apInvoiceId, matterRef, propertyId } = {}) {
  if (!communityId) throw new Error('communityId required');
  const links = {};
  if (apInvoiceId) links.ap_invoice_ids = [apInvoiceId];
  if (propertyId) links.property_ids = [propertyId];
  const fields = await fetchAllQuery(() => {
    const q = supabase.from('document_extracted_fields').select('document_id, fields').not('fields->evidence_kinds', 'is', null);
    return Object.keys(links).length ? q.contains('fields', { links }) : q;
  }, { orderBy: 'document_id' });
  if (!fields.length) return [];
  const byId = new Map(fields.map((x) => [x.document_id, x.fields]));
  const docs = [];
  const ids = [...byId.keys()];
  for (let i = 0; i < ids.length; i += 200) {
    docs.push(...must(await supabase.from('library_documents').select('id, title, category, file_name_original, file_path, file_hash, file_size_bytes, effective_date, uploaded_at, member_scope')
      .eq('management_company_id', BEDROCK_MGMT_CO_ID).eq('community_id', communityId).in('id', ids.slice(i, i + 200)), 'evidence docs'));
  }
  const digits = (m) => String(m).replace(/\D/g, '');
  return docs.map((d) => Object.assign({}, d, { fields: byId.get(d.id) || {} }))
    .filter((d) => !matterRef || ((d.fields.links || {}).matter_refs || []).some((m) => digits(m) === digits(matterRef)))
    .sort((a, b) => String(a.fields.doc_date || a.effective_date || '').localeCompare(String(b.fields.doc_date || b.effective_date || '')));
}

// What staff see in a list: provenance and the honest proves / uncertain split,
// never the extracted text (that stays with the document).
function evidenceSummary(d) {
  const f = d.fields || {};
  return {
    id: d.id, title: d.title, file_name: d.file_name_original || null, size_bytes: d.file_size_bytes || null,
    doc_date: f.doc_date || d.effective_date || null, kinds: f.evidence_kinds || [],
    sources: (f.sources || []).map((s) => ({ system: s.system, ref: s.system === 'email' ? (s.subject || s.ref) : s.ref, received_at: s.received_at || null, sender: s.sender || null, attachment: s.attachment || null })),
    uses: (f.uses || []).map((u) => ({ by: u.by, purpose: u.purpose, at: u.at || null, proves: u.proves || [], uncertain: u.uncertain || [] })),
    parent_document_ids: (f.links || {}).parent_document_ids || [],
    restricted: !['all_members', 'selected_members'].includes(d.member_scope),
  };
}

// A short-lived link to the original, only for a document that is retained
// evidence (so this cannot be used to open arbitrary library files).
async function signedUrl(supabase, documentId, seconds = 300) {
  const f = must(await supabase.from('document_extracted_fields').select('fields').eq('document_id', documentId).limit(1), 'evidence fields');
  if (!f || !f[0] || !((f[0].fields || {}).evidence_kinds || []).length) return null;
  const d = must(await supabase.from('library_documents').select('file_path').eq('id', documentId).eq('management_company_id', BEDROCK_MGMT_CO_ID).limit(1), 'evidence doc');
  if (!d || !d[0] || !d[0].file_path) return null;
  const r = await supabase.storage.from('documents').createSignedUrl(d[0].file_path, seconds);
  if (r.error) throw Object.assign(new Error(`signed url: ${r.error.message}`), { cause: r.error });
  return r.data.signedUrl;
}

module.exports = { storeEvidence, recordUnretrievable, findEvidence, evidenceSummary, signedUrl, mergeFields, CATEGORY, sha256 };
