// ============================================================================
// lib/acc/finalized.js  (Issue #14, Ed 2026-10-02)
// ----------------------------------------------------------------------------
// Read access to a FINALIZED ACC case's historical evidence (migration 480):
//   finalizationFor(supabase, dec)        -> the acc_finalizations row(s)
//   sealedArtifact(supabase, dec, kind)   -> the sealed letter / packet bytes
//                                            from the write-once archive, only
//                                            if their sha256 matches the record
// A finalized case always serves its sealed historical artifacts; nothing here
// rebuilds or writes anything.
// ============================================================================
const crypto = require('crypto');
const { ARCHIVE_BUCKET } = require('../record_archive');

async function finalizationFor(supabase, dec) {
  if (!dec || !dec.finalization_id) return null;
  const { data, error } = await supabase.from('acc_finalizations').select('*').eq('acc_decision_id', dec.id).order('version', { ascending: true });
  if (error || !data || !data.length) return null;
  const original = data.find((r) => r.id === dec.finalization_id) || data[0];
  return { original, versions: data, latest: data[data.length - 1] };
}

async function sealedArtifact(supabase, dec, kind) {
  const f = await finalizationFor(supabase, dec);
  if (!f) return null;
  const rec = f.latest;
  const path = kind === 'packet' ? rec.packet_archive_path : rec.letter_archive_path;
  const want = kind === 'packet' ? rec.packet_sha256 : rec.letter_sha256;
  if (!path) return null;
  const { data, error } = await supabase.storage.from(ARCHIVE_BUCKET).download(path);
  if (error || !data) throw new Error(`sealed ${kind} not found in the archive (${path})`);
  const buf = Buffer.from(await data.arrayBuffer());
  const got = crypto.createHash('sha256').update(buf).digest('hex');
  if (want && got !== want) throw new Error(`sealed ${kind} failed its hash check (expected ${want.slice(0, 12)}…, got ${got.slice(0, 12)}…)`);
  return buf;
}

module.exports = { finalizationFor, sealedArtifact };
