// ============================================================================
// lib/insurance_rfp_validate.js  (Ed 2026-09-03)
// ----------------------------------------------------------------------------
// COMPLETENESS GUARD for the insurance RFP capability.
//
// THE SCAR: Waterview's generated RFP asked brokers to quote 5 lines when the
// association actually carries 7. It silently dropped a $941,600 Hartford
// PROPERTY policy, dropped CYBER entirely, and rendered CRIME as "not
// purchased" — because the program was extracted from only the casualty PDFs
// somebody happened to upload, and `renderInsuranceRfpHTML` never throws. A
// clean, professional, HALF-COMPLETE RFP went out under Bedrock's name.
//
// This is the exact family CLAUDE.md already names twice:
//   • "A catastrophic-output surface needs a validator, because the renderer
//      never throws" (builder ARC letters).
//   • "Preview screens that show counts without cross-checking against truth"
//      (bedrock-vote 1000 vs 1171) — cross-check the OUTPUT against an
//      INDEPENDENT source in the same call, and refuse the action on divergence.
//
// The independent truth here is the set of source policy PDFs the program was
// built from. Bedrock files them as `POLICY - PROP`, `POLICY - CYBER`,
// `POLICY - CRIME`, etc. If a source file plainly denotes a coverage line that
// is missing (or empty) in the extracted program, we DROPPED it — block the RFP
// and say exactly which line, rather than mail a competitor half the program.
//
// Pure functions, no I/O — unit-tested in tests/test_insurance_rfp_validate.js.
// ============================================================================

// Canonical line keys. Everything (extracted line names, filenames, human
// labels) collapses to one of these so matching is punctuation/case-proof.
const LINE = {
  GL: 'General Liability',
  DO: 'Directors & Officers',
  PROPERTY: 'Property',
  UMBRELLA: 'Umbrella/Excess Liability',
  CRIME: 'Crime/Fidelity',
  CYBER: 'Cyber',
  WC: 'Workers Compensation',
  FLOOD: 'Flood',
  EQUIP: 'Equipment Breakdown',
  ORDINANCE: 'Ordinance or Law',
  HNOA: 'Hired/Non-Owned Auto',
  OTHER: 'Other',
};

// Lines a Texas HOA program is expected to carry. Absence is a BLOCKER even
// when no source file was supplied — the operator must consciously acknowledge
// "this community genuinely has no Property/D&O/GL" rather than ship silently.
const MUST_HAVE = [LINE.GL, LINE.DO, LINE.PROPERTY];

// Normalize any line-ish string ("Directors & Officers", "D&O", "workers' comp")
// to a canonical key. Returns null if it doesn't map to a known line.
function canonicalLine(s) {
  if (!s) return null;
  const k = String(s).toLowerCase().replace(/[^a-z]/g, '');
  if (!k) return null;
  if (k.includes('cyber')) return LINE.CYBER;
  if (k.includes('crime') || k.includes('fidelity')) return LINE.CRIME;
  if (k.includes('property')) return LINE.PROPERTY;
  if (k.includes('flood')) return LINE.FLOOD;
  if (k.includes('equipmentbreakdown') || k.includes('boilermachinery')) return LINE.EQUIP;
  if (k.includes('ordinance')) return LINE.ORDINANCE;
  if (k.includes('directors') || k.includes('officers') || k === 'do' || k === 'dando') return LINE.DO;
  if (k.includes('umbrella') || k.includes('excess') || k === 'xs') return LINE.UMBRELLA;
  if (k.includes('workerscomp') || k.includes('workerscompensation') || k === 'wc' || k.includes('employersliability')) return LINE.WC;
  if (k.includes('hirednonowned') || k.includes('nonowned') || k === 'hnoa') return LINE.HNOA;
  if (k.includes('generalliability') || k.includes('businessowners') || k === 'gl' || k === 'cgl' || k === 'bop') return LINE.GL;
  if (k.includes('liability')) return LINE.GL; // last resort: bare "liability" → GL
  return null;
}

// Infer the coverage line a SOURCE POLICY FILENAME denotes, using Bedrock's
// filing convention (`POLICY - PROP.pdf`, `POLICY - D&O.pdf`, `POLICY - XS.pdf`,
// `POLICY - CRIME - CAIS.pdf`, `POLICY - GL - BOP - CHUBB.pdf`, ...). Ordered
// most-specific first; the first token that hits wins. Returns a canonical LINE
// or null when the filename carries no line signal (cover letters, ACORDs, etc.)
const FILENAME_RULES = [
  [/cyber/i, LINE.CYBER],
  [/crime|fidelity/i, LINE.CRIME],
  [/\bflood\b/i, LINE.FLOOD],
  [/equip|boiler|machinery/i, LINE.EQUIP],
  [/\bprop(erty)?\b/i, LINE.PROPERTY],
  [/d\s*&?\s*o\b|directors|officers/i, LINE.DO],
  [/\bxs\b|umbrella|excess/i, LINE.UMBRELLA],
  [/\bwc\b|workers|employ(er|ers)?\s*liab/i, LINE.WC],
  [/hired|non[-\s_]*owned|\bhnoa\b/i, LINE.HNOA],
  [/\bgl\b|\bcgl\b|\bbop\b|general\s*liab|businessowners/i, LINE.GL],
];
function inferLineFromFilename(name) {
  if (!name) return null;
  const base = String(name).replace(/\.[a-z0-9]+$/i, ''); // strip extension
  for (const [rx, line] of FILENAME_RULES) if (rx.test(base)) return line;
  return null;
}

// A coverage record is "substantive" if it actually carries limits — a line
// present with zero limits (e.g. Crime rendered as all-"N/A"/"not purchased")
// is exactly the Waterview crime failure and must NOT count as covered.
function hasLimits(cov) {
  return Array.isArray(cov && cov.limits) && cov.limits.some((l) => l && (l.amount || l.label));
}

// ----------------------------------------------------------------------------
// validateProgramCompleteness(program, sourceFilenames, opts)
//   program         : { coverages:[{line,limits,...}], ... }  (normalized)
//   sourceFilenames : string[] — the policy PDFs the program was built from
//   opts.expectLines: optional canonical lines the caller knows are required
//
// Returns { ok, blockers[], warnings[], linesPresent[], linesEmpty[],
//           linesFromSources[], missingFromSources[] }
// `ok` is false when there is ANY blocker. Callers refuse to render (HTTP 409 /
// non-zero exit) unless the operator explicitly acknowledges.
// ----------------------------------------------------------------------------
function validateProgramCompleteness(program, sourceFilenames = [], opts = {}) {
  const covs = (program && Array.isArray(program.coverages)) ? program.coverages : [];

  const present = new Set();   // lines with real limits
  const empty = new Set();     // lines present but with no limits (suspect)
  for (const c of covs) {
    const line = canonicalLine(c && c.line);
    if (!line) continue;
    if (hasLimits(c)) present.add(line);
    else empty.add(line);
  }

  const fromSources = new Set();
  for (const f of (sourceFilenames || [])) {
    const line = inferLineFromFilename(f);
    if (line) fromSources.add(line);
  }

  const blockers = [];
  const warnings = [];
  const missingFromSources = [];

  // (1) Independent cross-check: a source PDF says a line exists, program doesn't.
  for (const line of fromSources) {
    if (present.has(line)) continue;
    missingFromSources.push(line);
    if (empty.has(line)) {
      blockers.push(`${line}: a source policy document was provided but the RFP shows it with no limits (reads as "not purchased"). Re-extract from the ${line} declarations.`);
    } else {
      blockers.push(`${line}: a source policy document was provided but no ${line} coverage was captured. This line was DROPPED from the RFP.`);
    }
  }

  // (2) Baseline must-haves for a Texas HOA program.
  for (const line of MUST_HAVE) {
    if (present.has(line) || fromSources.has(line)) continue; // (source-implied ones already blocked above)
    if (empty.has(line)) blockers.push(`${line}: present but with no limits — confirm and re-extract, or remove.`);
    else blockers.push(`${line}: expected on a Texas HOA program but not present. Confirm the ${line} policy was included.`);
  }

  // (3) Caller-declared expectations (e.g. prior-year line set).
  for (const raw of (opts.expectLines || [])) {
    const line = canonicalLine(raw);
    if (line && !present.has(line) && !blockers.some((b) => b.startsWith(line + ':'))) {
      warnings.push(`${line}: expected (prior term / caller-declared) but not present this term — confirm it was intentionally dropped.`);
    }
  }

  // (4) Empty (no-limit) lines that weren't already blocked → warn.
  for (const line of empty) {
    if (present.has(line)) continue;
    if (blockers.some((b) => b.startsWith(line + ':'))) continue;
    warnings.push(`${line}: present but no limits parsed — verify before sending.`);
  }

  return {
    ok: blockers.length === 0,
    blockers,
    warnings,
    linesPresent: [...present],
    linesEmpty: [...empty],
    linesFromSources: [...fromSources],
    missingFromSources,
  };
}

module.exports = {
  validateProgramCompleteness,
  inferLineFromFilename,
  canonicalLine,
  LINE,
  MUST_HAVE,
};
