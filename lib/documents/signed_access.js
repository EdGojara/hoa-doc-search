'use strict';
// ============================================================================
// lib/documents/signed_access.js  (Ed 2026-10-19) — who may get a link to a stored file
// ----------------------------------------------------------------------------
// GET /api/homeowner/file used to sign ANY path the caller typed into the URL.
// Anyone past the staff gate who learned a storage path (e.g. a filed tax
// return's) could get a link to it. Now a link is issued only when ALL hold:
//   1. the path is well formed (no "..", no leading "/", no backslash, no
//      control or percent characters, a sane length);
//   2. it resolves to an actual RECORD of the kind asked for (a letter that went
//      out, an inspection photo, an account attachment, a library document, a
//      payment-plan agreement, a journal-entry scan, ...). Unknown -> refused;
//   3. every record that names that path is checked, and ANY library document
//      at that path is checked too, whatever kind was asked for: a restricted
//      one (a signed tax return) makes the path restricted. A restricted
//      CATEGORY FOLDER in the path ("/tax_return/") also counts, as a second,
//      independent signal, never the only one;
//   4. the record's association is one Bedrock manages (management company);
//   5. a restricted path needs the OWNER, proven by a signed-in token. The staff
//      gate cookie is shared and names nobody, so it never suffices.
// The URL that is signed is the record's stored path, never the caller's text.
// Restricted documents reach staff ONLY through Tessa's audited mailing route
// (api/tessa_mailing.js), which serves the one document tied to their task.
// ============================================================================
const { RESTRICTED_CATEGORIES, isRestricted } = require('./restricted');

// Where a path in each bucket may legitimately come from, per kind asked for.
const SOURCES = {
  'violation-letters': [
    { kinds: ['letter'], table: 'interactions', col: 'content', usable: (r) => /letter/i.test(r.type || '') },
  ],
  documents: [
    { kinds: ['document', 'photo'], table: 'library_documents', col: 'file_path', library: true },
    { kinds: ['photo'], table: 'inspection_photos', col: 'storage_path' },
    { kinds: ['photo', 'document'], table: 'account_attachments', col: 'file_path', usable: (r, kind) => !r.kind || r.kind === kind },
    { kinds: ['document'], table: 'payment_plans', col: 'source_document_path' },
    { kinds: ['document'], table: 'journal_entries', col: 'source_document_path' },
    { kinds: ['document'], table: 'arc_historical_decisions', col: 'source_document_path' },
    { kinds: ['document'], table: 'owner_ar_snapshots', col: 'source_storage_path' },
    { kinds: ['document'], table: 'appraisal_records', col: 'source_storage_path' },
  ],
};
const BUCKET_FOR_KIND = { letter: 'violation-letters', photo: 'documents', document: 'documents' };

function wellFormed(path) {
  const p = String(path == null ? '' : path);
  if (!p || p.length > 600) return false;
  if (p.startsWith('/') || p.includes('..') || p.includes('\\') || p.includes('//') || /%|[\u0000-\u001f\u007f]/.test(p)) return false;
  return true;
}
const missingTable = (e) => /does not exist|schema cache|could not find/i.test((e && e.message) || '');
const restrictedFolder = (p) => [...RESTRICTED_CATEGORIES].some((c) => String(p).split('/').includes(c));

// Find every record naming this path in this bucket. Errors other than "this
// table is not in this database" are raised: a failed lookup must not read as
// "nothing restricted here".
async function recordsFor(supabase, bucket, path) {
  const out = [];
  for (const s of SOURCES[bucket] || []) {
    const { data, error } = await supabase.from(s.table).select('*').eq(s.col, path).limit(5);
    if (error) { if (missingTable(error)) continue; throw Object.assign(new Error(`${s.table} lookup failed: ${error.message}`), { code: 'lookup_failed' }); }
    for (const r of data || []) out.push({ source: s, row: r });
  }
  return out;
}

async function bedrockCommunities(supabase, ids, mcId) {
  const uniq = [...new Set(ids.filter(Boolean))];
  if (!uniq.length) return new Set();
  const { data, error } = await supabase.from('communities').select('id, management_company_id').in('id', uniq);
  if (error) throw Object.assign(new Error(`communities lookup failed: ${error.message}`), { code: 'lookup_failed' });
  return new Set((data || []).filter((c) => !mcId || c.management_company_id === mcId).map((c) => c.id));
}

// -> { ok: true, bucket, path, restricted, record: {table, id} }
//  | { ok: false, status, error, detail }
async function authorizeFileLink(supabase, { kind, path, viewer = null, isOwner = false, mcId = null }) {
  const bucket = BUCKET_FOR_KIND[kind];
  const no = (status, error, detail) => ({ ok: false, status, error, detail });
  if (!bucket) return no(400, 'bad_kind', 'kind must be letter, photo or document.');
  if (!wellFormed(path)) return no(400, 'bad_path', 'That is not a valid file reference.');
  let recs;
  try { recs = await recordsFor(supabase, bucket, path); }
  catch (e) { console.error('[signed_access] lookup failed', JSON.stringify({ kind, error: e.message })); return no(503, 'lookup_failed', 'The file could not be checked right now. Nothing was opened.'); }

  // Restricted if ANY library document at this path is, or the path sits in a
  // restricted category folder: never just one signal.
  const libs = recs.filter((r) => r.source.library);
  const restricted = libs.some((r) => isRestricted(r.row)) || (bucket === 'documents' && restrictedFolder(path));
  const usable = recs.filter((r) => r.source.kinds.includes(kind) && (!r.source.usable || r.source.usable(r.row, kind)));
  if (!usable.length && !restricted) return no(404, 'file_not_found', 'No record on file points at that file.');

  if (restricted && !isOwner) {
    console.warn('[signed_access] refused a restricted file', JSON.stringify({ kind, viewer: viewer || 'staff-gate', path_hint: String(path).split('/').slice(-2, -1)[0] || null }));
    return no(404, 'file_not_found', 'No record on file points at that file.');   // do not confirm it exists
  }
  if (!usable.length) return no(404, 'file_not_found', 'No record on file points at that file.');

  // The association must be one Bedrock manages (and a library document must be ours).
  if (libs.some((r) => mcId && r.row.management_company_id && r.row.management_company_id !== mcId)) return no(404, 'file_not_found', 'No record on file points at that file.');
  const commIds = usable.map((r) => r.row.community_id).filter(Boolean);
  if (commIds.length) {
    let ours;
    try { ours = await bedrockCommunities(supabase, commIds, mcId); }
    catch (e) { console.error('[signed_access] community check failed', e.message); return no(503, 'lookup_failed', 'The file could not be checked right now. Nothing was opened.'); }
    if (!commIds.every((id) => ours.has(id))) return no(404, 'file_not_found', 'No record on file points at that file.');
  }
  const rec = usable[0];
  if (restricted) console.log('[signed_access] owner opened a restricted file', JSON.stringify({ table: rec.source.table, id: rec.row.id, viewer }));
  return { ok: true, bucket, path: rec.row[rec.source.col], restricted, record: { table: rec.source.table, id: rec.row.id } };
}

module.exports = { authorizeFileLink, wellFormed, SOURCES, BUCKET_FOR_KIND };
