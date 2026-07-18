// ===========================================================================
// record_archive.js  (Ed 2026-07-18)
// ---------------------------------------------------------------------------
// Seal a FINALIZED document (one that goes out and must never change) into the
// write-once `finalized-docs-archive` bucket + the append-only
// finalized_record_archive hash ledger (migration 311). Used for ARC/ACC
// decision letters + the applications they were decided from; the home for
// future finalized classes (board packets, estoppels, vendor contracts).
//
// Best-effort + non-fatal: never blocks a send. The backfill script
// (_seal_arc_records) reconciles anything a live call missed.
// ===========================================================================
const crypto = require('crypto');
const ARCHIVE_BUCKET = 'finalized-docs-archive';

async function sealFinalizedRecord(supabase, {
  record_type, record_id, community_id, archive_path,
  source_bucket = 'documents', source_path, buffer, sent_at, metadata,
}) {
  try {
    if (!record_type || !archive_path) return;
    // write-once — never overwrite an already-sealed record
    const { data: existing } = await supabase.storage.from(ARCHIVE_BUCKET).download(archive_path);
    if (existing) {
      const eb = Buffer.from(await existing.arrayBuffer());
      return { archive_path, sha256: crypto.createHash('sha256').update(eb).digest('hex'), bytes: eb.length, already: true };
    }

    let buf = buffer;
    if (!buf) {
      if (!source_path) return null;
      const { data: blob } = await supabase.storage.from(source_bucket).download(source_path);
      if (!blob) { console.warn('[record-archive] source missing:', source_path); return null; }
      buf = Buffer.from(await blob.arrayBuffer());
    }
    const sha = crypto.createHash('sha256').update(buf).digest('hex');
    const { error: upErr } = await supabase.storage.from(ARCHIVE_BUCKET).upload(archive_path, buf, { contentType: 'application/pdf', upsert: false });
    if (upErr && !/exists|already/i.test(upErr.message)) { console.warn('[record-archive] upload failed:', upErr.message); return null; }

    const { error: insErr } = await supabase.from('finalized_record_archive').insert({
      record_type, record_id: record_id || null, community_id: community_id || null,
      archive_path, source_path: source_path || null, sha256: sha, bytes: buf.length,
      sent_at: sent_at || null, metadata: metadata || null,
    });
    if (insErr && !/duplicate|unique|exists/i.test(insErr.message) && !/relation .* does not exist/i.test(insErr.message)) {
      console.warn('[record-archive] ledger insert failed:', insErr.message);
    }
    console.log(`[record-archive] sealed ${record_type} ${record_id} → ${archive_path} (sha ${sha.slice(0, 12)}…)`);
    return { archive_path, sha256: sha, bytes: buf.length };
  } catch (e) {
    console.warn('[record-archive] sealFinalizedRecord failed (non-fatal):', e.message);
    return null;
  }
}

module.exports = { sealFinalizedRecord, ARCHIVE_BUCKET };
