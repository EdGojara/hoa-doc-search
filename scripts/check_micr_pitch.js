// ============================================================================
// scripts/check_micr_pitch.js — the MICR line must be exactly 8 characters/inch.
// ----------------------------------------------------------------------------
// SCAR, 2026-08-21. Wells Fargo returned a Bedrock check: "the MICR line is
// incorrect and too large." Ed: "we have used it already and others have cashed
// it, our bank looked at it and said okay."
//
// Both were true. The FORMAT was correct — field order and E-13B symbols were
// proven against a cleared NewFirst check on 2026-07-16. The GEOMETRY was not:
// the line was set at 16pt with 2px of extra letter-spacing, giving 4.52
// characters per inch against a spec of exactly 8.00.
//
// It cleared anyway because NewFirst clears by image (Check 21). Image clearing
// reads a picture of the check and tolerates bad geometry; a bank that checks
// the physical spec does not. So every check printed until then was passing on
// one bank's tolerance rather than on being right, and nothing in the system
// knew the difference. A payment surface that works by luck is the definition
// of a silent failure.
//
// E-13B (ANSI X9.100-160-1) fixes the pitch at 8 CPI. Each character occupies
// .125in, and the reader locates the amount, on-us and transit fields by
// ABSOLUTE position measured from the right edge. Pitch is the coordinate
// system, not a styling choice — get it wrong and every field is in the wrong
// place even when the digits are correct.
//
// This recomputes the effective pitch from the REAL font file and the REAL CSS
// and fails the build if it leaves spec. It cannot be satisfied by a comment.
//
// Run: npm run test:micr   (wired into npm test)
// ============================================================================
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FONT = path.join(ROOT, 'public', 'fonts', 'micr.ttf');
const CSS_FILE = path.join(ROOT, 'lib', 'accounting', 'check_renderer.js');

const SPEC_CPI = 8;
const SPEC_PITCH_IN = 1 / SPEC_CPI;      // .125in per character
// ANSI allows a small pitch tolerance. Anything beyond this is a reject risk,
// and the failure we shipped was 77% off, so a tight bound costs nothing.
const TOLERANCE_IN = 0.002;

function fail(lines) {
  console.error('');
  console.error('✗ MICR pitch is out of spec. Banks will reject these checks.');
  console.error('');
  for (const l of lines) console.error('  ' + l);
  console.error('');
  console.error('  E-13B requires exactly 8 characters per inch (.125in each).');
  console.error('  The reader finds the amount, on-us and transit fields by absolute');
  console.error('  position from the right edge, so wrong pitch means wrong fields');
  console.error('  even when every digit is correct.');
  console.error('');
  process.exit(1);
}

// ---- 1. the font's real advance width --------------------------------------
if (!fs.existsSync(FONT)) {
  fail([`No MICR font at ${path.relative(ROOT, FONT)} — checks would render in a fallback`,
    'monospace font that is not magnetic-readable at any size.']);
}

const b = fs.readFileSync(FONT);
const tables = {};
const numTables = b.readUInt16BE(4);
for (let i = 0; i < numTables; i++) {
  const o = 12 + i * 16;
  tables[b.toString('ascii', o, o + 4)] = { off: b.readUInt32BE(o + 8), len: b.readUInt32BE(o + 12) };
}
if (!tables.head || !tables.hhea || !tables.hmtx) {
  fail(['The MICR font is missing head/hhea/hmtx tables — cannot verify its pitch.']);
}
const upem = b.readUInt16BE(tables.head.off + 18);
const numHMetrics = b.readUInt16BE(tables.hhea.off + 34);

// Measure the characters the renderer ACTUALLY PRINTS, looked up through cmap.
//
// Not "the widest glyph in the font" and not glyph 0. This font carries 6
// distinct advance widths across its full glyph set — .notdef and some unused
// outlines are wider than the E-13B characters — so sampling the wrong glyphs
// gives a confident, wrong pitch. Two earlier measurements of this same file
// disagreed for exactly that reason. The characters that appear on a check are
// the digits, the four E-13B symbols (A/B/C/D in this font's mapping) and the
// space, and every one of those must share one advance.
function glyphFor(ch) {
  const c = tables.cmap.off;
  const n = b.readUInt16BE(c + 2);
  let sub = null;
  for (let i = 0; i < n; i++) {
    const rec = c + 4 + i * 8;
    const platform = b.readUInt16BE(rec);
    const off = b.readUInt32BE(rec + 4);
    if (b.readUInt16BE(c + off) !== 4) continue;
    sub = c + off;
    if (platform === 3) break;
  }
  if (!sub) return null;
  const segX2 = b.readUInt16BE(sub + 6);
  const endO = sub + 14;
  const startO = endO + segX2 + 2;
  const deltaO = startO + segX2;
  const rangeO = deltaO + segX2;
  const code = ch.charCodeAt(0);
  for (let i = 0; i < segX2 / 2; i++) {
    if (code > b.readUInt16BE(endO + i * 2)) continue;
    const start = b.readUInt16BE(startO + i * 2);
    if (code < start) return 0;
    const delta = b.readInt16BE(deltaO + i * 2);
    const ro = b.readUInt16BE(rangeO + i * 2);
    if (ro === 0) return (code + delta) & 0xffff;
    const gi = b.readUInt16BE(rangeO + i * 2 + ro + (code - start) * 2);
    return gi === 0 ? 0 : (gi + delta) & 0xffff;
  }
  return 0;
}

const PRINTED = '0123456789ABCD '.split('');
const byChar = new Map();
for (const ch of PRINTED) {
  const g = glyphFor(ch);
  if (g === null) fail(['The MICR font has no usable cmap — cannot verify its pitch.']);
  if (!g) fail([`The MICR font has no glyph for '${ch}', which the renderer prints.`]);
  byChar.set(ch, b.readUInt16BE(tables.hmtx.off + Math.min(g, numHMetrics - 1) * 4));
}
const advances = new Set(byChar.values());
if (advances.size !== 1) {
  const detail = [...byChar.entries()].map(([c, a]) => `'${c}'=${a}`).join(' ');
  fail(['E-13B is monospaced, but the printed characters have different advance widths:',
    `  ${detail}`,
    'Characters would not land on the .125in grid the reader expects.']);
}
const advance = [...advances][0];
const advanceEm = advance / upem;

// ---- 2. the CSS the renderer actually uses ---------------------------------
const css = fs.readFileSync(CSS_FILE, 'utf8');
const block = css.match(/\.micr\s*\{([\s\S]*?)\}/);
if (!block) fail([`Could not find the .micr rule in ${path.relative(ROOT, CSS_FILE)}.`]);

const rule = block[1];
const sizeMatch = rule.match(/font-size:\s*([\d.]+)\s*(pt|px|in)/);
if (!sizeMatch) fail(['The .micr rule has no explicit font-size. It must be pinned, not inherited.']);

const sizeVal = parseFloat(sizeMatch[1]);
const sizeIn = sizeMatch[2] === 'pt' ? sizeVal / 72 : sizeMatch[2] === 'px' ? sizeVal / 96 : sizeVal;

// letter-spacing is the other half. The font's advance IS the pitch, so any
// tracking at all pushes every downstream character out of position.
const lsMatch = rule.match(/letter-spacing:\s*([\d.-]+)\s*(pt|px|in|em)?/);
let lsIn = 0;
if (lsMatch) {
  const v = parseFloat(lsMatch[1]);
  const unit = lsMatch[2] || '';
  lsIn = unit === 'pt' ? v / 72 : unit === 'in' ? v : unit === 'em' ? v * sizeIn : v / 96;
}

const pitchIn = advanceEm * sizeIn + lsIn;
const cpi = 1 / pitchIn;
const idealPt = (SPEC_PITCH_IN / advanceEm) * 72;

// ---- 3. verdict -------------------------------------------------------------
const problems = [];
if (Math.abs(pitchIn - SPEC_PITCH_IN) > TOLERANCE_IN) {
  problems.push(`font-size ${sizeMatch[1]}${sizeMatch[2]}${lsIn ? ` + letter-spacing ${lsMatch[1]}${lsMatch[2] || 'px'}` : ''}`
    + ` gives ${pitchIn.toFixed(4)}in per character = ${cpi.toFixed(2)} CPI (spec: ${SPEC_CPI.toFixed(2)}).`);
  problems.push(`This font's advance is ${advanceEm.toFixed(4)}em, so the correct size is ${idealPt.toFixed(2)}pt with letter-spacing 0.`);
  if (lsIn) problems.push('letter-spacing must be 0: the font\'s own advance is the pitch.');
}

// The clear band and the reserved amount field are the other two things a bank
// checks, and both are cheap to assert from the same rule.
if (!/right:\s*[\d.]+in/.test(rule)) {
  problems.push('The .micr rule is not positioned from the RIGHT edge. MICR fields are located'
    + ' by distance from the right edge, and the rightmost 12 positions must stay blank for the'
    + ' bank of first deposit to encode the amount.');
}
const bottomMatch = rule.match(/bottom:\s*([\d.]+)in/);
if (!bottomMatch) {
  problems.push('The .micr rule has no explicit bottom offset; it must sit inside the .625in clear band.');
} else {
  const bottom = parseFloat(bottomMatch[1]);
  if (bottom < 0.125 || bottom > 0.25) {
    problems.push(`bottom: ${bottom}in is outside the .125-.25in the spec allows for character bottoms.`);
  }
}

if (problems.length) fail(problems);

console.log(`MICR pitch check: ok — ${sizeMatch[1]}${sizeMatch[2]} on a ${advanceEm.toFixed(4)}em font `
  + `= ${pitchIn.toFixed(4)}in/char (${cpi.toFixed(2)} CPI, spec ${SPEC_CPI.toFixed(2)})`);
