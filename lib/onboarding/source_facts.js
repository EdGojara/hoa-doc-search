// ============================================================================
// lib/onboarding/source_facts.js  (Ed 2026-10-17) — the persisted normalized source
// ----------------------------------------------------------------------------
// The normalize stage turns the source reports into canonical rows ONCE and the
// batch keeps them: a FACT SET (migration 535: onboarding_source_fact_sets +
// onboarding_source_facts). Every later stage (source controls, snapshot,
// activity bridge, preflight) reconciles from these stored facts, never by
// re-reading the source documents. Each fact keeps its provenance: the source
// file's sha256, the page/line locator, the printed text, and the cutoff the
// history was sliced to.
//
//   factsFromParsed(parsed, { cutoff, slices })  -> { facts, fact_count, facts_sha256 }
//   parsedFromFacts(facts)                       -> the parsed source, exactly as stored
//   verifyFacts(facts, { fact_count, facts_sha256 })
//
// One fact per report header (domain '_report': type, period / as_of, printed
// totals, defects, slice record) and one per canonical row, in a deterministic
// order. The set's sha256 is canonical JSON over every fact, so a changed,
// missing or extra fact is detected on read. Pure: no database client here.
// ============================================================================
const crypto = require('crypto');
const { canonicalJson } = require('./preflight');

const REPORT = '_report';
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

function factsFromParsed(parsed, { cutoff = null } = {}) {
  const facts = []; let seq = 0;
  for (const type of Object.keys(parsed || {}).sort()) {
    const report = parsed[type] || {};
    const { rows = [], ...header } = report;
    facts.push({ seq: ++seq, artifact_type: type, domain: REPORT, artifact_sha256: null, source_account_key: null, slice_cutoff: report.slice ? report.slice.cutoff : null, locator: null, raw: null, fact: header });
    for (const r of rows) {
      const { provenance = {}, ...row } = r;
      facts.push({ seq: ++seq, artifact_type: type, domain: row.domain, artifact_sha256: provenance.artifact_sha256 || null, source_account_key: row.source_account_key || null,
        slice_cutoff: report.slice ? cutoff || report.slice.cutoff : null, locator: provenance.locator || null, raw: provenance.raw === undefined ? null : provenance.raw, fact: row });
    }
  }
  return { facts, fact_count: facts.length, facts_sha256: sha(canonicalJson(facts.map(stable))) };
}

// The stored shape of a fact (what the database round-trips), for hashing.
function stable(f) {
  return { seq: Number(f.seq), artifact_type: f.artifact_type, domain: f.domain, artifact_sha256: f.artifact_sha256 || null, source_account_key: f.source_account_key || null,
    slice_cutoff: f.slice_cutoff ? String(f.slice_cutoff).slice(0, 10) : null, locator: f.locator === undefined ? null : f.locator, raw: f.raw === undefined ? null : f.raw, fact: f.fact };
}

function verifyFacts(facts, { fact_count, facts_sha256 }) {
  const list = (facts || []).map(stable).sort((a, b) => a.seq - b.seq);
  if (list.length !== Number(fact_count)) return { ok: false, problem: `the fact set holds ${list.length} facts; ${fact_count} were sealed` };
  if (list.some((f, i) => f.seq !== i + 1)) return { ok: false, problem: 'the fact sequence has a gap or a duplicate' };
  const h = sha(canonicalJson(list));
  if (h !== facts_sha256) return { ok: false, problem: 'the stored facts do not hash to the sealed fingerprint' };
  return { ok: true };
}

function parsedFromFacts(facts) {
  const list = (facts || []).map(stable).sort((a, b) => a.seq - b.seq);
  const parsed = {};
  for (const f of list) {
    if (f.domain === REPORT) { parsed[f.artifact_type] = { ...f.fact, rows: [] }; continue; }
    if (!parsed[f.artifact_type]) throw new Error(`fact ${f.seq}: no report header for ${f.artifact_type}`);
    const provenance = { artifact_sha256: f.artifact_sha256, locator: f.locator, ...(f.raw !== null ? { raw: f.raw } : {}) };
    parsed[f.artifact_type].rows.push({ ...f.fact, provenance });
  }
  return parsed;
}

module.exports = { factsFromParsed, parsedFromFacts, verifyFacts, stable, REPORT };
