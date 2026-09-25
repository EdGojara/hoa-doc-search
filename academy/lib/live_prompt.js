// academy/lib/live_prompt.js
// ----------------------------------------------------------------------------
// Loads Amanda's LIVE production system prompts WITHOUT importing or modifying
// lib/community/amanda_reply.js (its prompt builders are not exported). The
// source file is read as text and the three audience templates are evaluated
// with the community name, so the Academy always evaluates exactly what
// production sends. If the source changes shape, this throws loudly rather than
// silently evaluating a stale copy.
//
// Also loads the shared rule text Amanda's reply path appends (finance primer,
// contact-routing rule, no-overpromise rule) from their real modules.
// Learned guidance (persona_learned_guidance, DB) is optional and read-only.
// ----------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..', '..');
const REPLY_SRC = path.join(ROOT, 'lib', 'community', 'amanda_reply.js');
const STAFF_SRC = path.join(ROOT, 'lib', 'community', 'amanda_staff_assist.js');

function extractTemplate(src, constName) {
  const start = src.indexOf(`const ${constName} = (communityName) => \``);
  if (start < 0) throw new Error(`live prompt ${constName} not found in amanda_reply.js (source changed?)`);
  const bodyStart = src.indexOf('`', start) + 1;
  const end = src.indexOf('`;', bodyStart);
  if (end < 0) throw new Error(`live prompt ${constName} not terminated`);
  const body = src.slice(bodyStart, end);
  if (body.includes('`')) throw new Error(`live prompt ${constName} contains a nested template`);
  // eslint-disable-next-line no-new-func
  return new Function('communityName', 'return `' + body + '`;');
}

function extractStaffPersona(src) {
  const a = src.indexOf('You are Amanda Albright, Senior Community Manager at Bedrock Association Management. A member of your own team');
  const b = src.indexOf('WHO WROTE:', a);
  if (a < 0 || b < 0) throw new Error('staff-assist persona text not found in amanda_staff_assist.js (source changed?)');
  return src.slice(a, b).trim();
}

let _cache = null;
function loadLivePrompts() {
  if (_cache) return _cache;
  const replySrc = fs.readFileSync(REPLY_SRC, 'utf8');
  const staffSrc = fs.readFileSync(STAFF_SRC, 'utf8');
  const homeowner = extractTemplate(replySrc, 'AMANDA_SYSTEM');
  const board = extractTemplate(replySrc, 'AMANDA_BOARD_SYSTEM');
  const vendor = extractTemplate(replySrc, 'AMANDA_VENDOR_SYSTEM');
  const staffPersona = extractStaffPersona(staffSrc);
  const { CONTACT_ROUTING_RULE, NO_OVERPROMISE_RULE } = require(path.join(ROOT, 'lib', 'team', 'operator_core'));
  const { FINANCE_PRIMER } = require(path.join(ROOT, 'lib', 'team', 'knowledge', 'finance_primer'));
  if (!CONTACT_ROUTING_RULE || !NO_OVERPROMISE_RULE || !FINANCE_PRIMER) throw new Error('shared Amanda rule text missing');
  // The finance addendum amanda_reply appends (kept verbatim-checked below).
  const m = replySrc.match(/FINANCE_PRIMER\s*\n\s*\+\s*'([^']+)'/);
  if (!m) throw new Error('finance addendum not found in amanda_reply.js (source changed?)');
  const financeAddendum = m[1].replace(/\\n/g, '\n').replace(/\\'/g, "'").trim();
  _cache = {
    homeowner, board, vendor, staffPersona, CONTACT_ROUTING_RULE, NO_OVERPROMISE_RULE, FINANCE_PRIMER, financeAddendum,
    fingerprint: crypto.createHash('sha256').update(replySrc).update(staffSrc).digest('hex').slice(0, 16),
  };
  return _cache;
}

// The system prompt production would use for this audience (amanda_reply.js
// lines ~172-179), minus DB-loaded learned guidance unless supplied.
function systemFor(audience, communityName, { learnedGuidance = '' } = {}) {
  const L = loadLivePrompts();
  if (audience === 'staff') {
    // amanda_staff_assist builds its prompt inline; the fixed persona paragraphs
    // are live, the per-email scaffolding is the Academy's.
    return `${L.staffPersona}\n\nCOMMUNITY: ${communityName || '(none)'}`;
  }
  const base = ({ board: L.board, vendor: L.vendor }[audience] || L.homeowner)(communityName);
  const finance = L.FINANCE_PRIMER + '\n\n' + L.financeAddendum;
  let system = (audience === 'vendor' ? base : base + '\n\n' + finance) + '\n\n' + L.CONTACT_ROUTING_RULE + '\n\n' + L.NO_OVERPROMISE_RULE;
  if (learnedGuidance) system += `\n\n${learnedGuidance}`;
  return system;
}

module.exports = { loadLivePrompts, systemFor };
