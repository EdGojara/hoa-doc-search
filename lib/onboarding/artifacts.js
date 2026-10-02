// ============================================================================
// lib/onboarding/artifacts.js  (Issue #15) — Stage 0: immutable source intake
// ----------------------------------------------------------------------------
// A source artifact is an original legacy report/export, recorded exactly as
// received: bytes hash, size, filename, provider, report type, period/cutoff,
// community, batch, who supplied it and when. The record is frozen; any later
// read must re-hash the bytes and match (verifyArtifact) or the stage refuses
// to use them. Nothing here touches the database; persistence is the
// onboarding_artifacts table in the schema proposal (migration 481).
// ============================================================================
const crypto = require('crypto');

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

const REQUIRED = ['community_id', 'source_system', 'artifact_type', 'filename', 'batch_code'];

function makeArtifact(buffer, meta = {}) {
  if (!Buffer.isBuffer(buffer)) throw new Error('artifact bytes must be a Buffer');
  for (const k of REQUIRED) if (!meta[k]) throw new Error(`artifact_${k}_required`);
  if (!meta.cutoff_date && !meta.period_end) throw new Error('artifact_cutoff_or_period_end_required');
  return Object.freeze({
    batch_code: meta.batch_code,
    community_id: meta.community_id,
    source_system: String(meta.source_system).toLowerCase(),
    artifact_type: meta.artifact_type,
    filename: meta.filename,
    version_label: meta.version_label || null,
    period_start: meta.period_start || null,
    period_end: meta.period_end || null,
    cutoff_date: meta.cutoff_date || meta.period_end,
    sha256: sha256(buffer),
    bytes: buffer.length,
    supplied_by: meta.supplied_by || null,
    received_at: meta.received_at || new Date().toISOString(),
    derived_from_sha256: meta.derived_from_sha256 || null, // e.g. extracted text of an original PDF
    provenance: Object.freeze({ ...(meta.provenance || {}) }),
  });
}

// Bytes handed to a later stage must be the bytes that were recorded.
function verifyArtifact(artifact, buffer) {
  const actual = sha256(buffer);
  if (actual !== artifact.sha256 || buffer.length !== artifact.bytes) {
    const e = new Error(`artifact_hash_mismatch: ${artifact.filename}`);
    e.code = 'ARTIFACT_HASH_MISMATCH'; e.expected = artifact.sha256; e.actual = actual;
    throw e;
  }
  return true;
}

module.exports = { makeArtifact, verifyArtifact, sha256 };
