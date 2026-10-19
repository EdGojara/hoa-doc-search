'use strict';
// ============================================================================
// lib/email/persona_sender.js  (Ed 2026-10-19) — who a reply is sent AS
// ----------------------------------------------------------------------------
// ONE answer to "which mailbox and signature does this teammate send with?",
// used by both send paths (Communications /:id/send and outbound drafts) and
// served to the Communications page so its labels can never disagree with what
// actually sends.
//
// Scar: the page and the send route each kept their own hand-written persona
// lists, and a teammate missing from a list silently fell back to Claire. Amanda
// once "sent from claire@" on screen; Maggie's first website draft showed Claire's
// sender and signature. Darby, Phoebe and Vivian had no send branch at all and
// would have gone out as Claire. Now:
//   - a teammate with a dedicated signature module keeps it (unchanged output);
//   - every other roster teammate gets the roster-driven signature and their own
//     mailbox (graph_send.personaMailbox);
//   - the shared general queue (or no owner) answers as Claire, the front office;
//   - Tessa (owner-only EA) and anything unknown are REFUSED: never sent as Claire.
// ============================================================================
const graphSend = require('./graph_send');

// Teammates whose signature lives in its own module (kept exactly as before).
const DEDICATED = {
  claire:  () => require('./claire_signature').buildClaireEmail,
  emma:    () => require('./emma_signature').buildEmmaEmail,
  miranda: () => require('./miranda_signature').buildMirandaEmail,
  annie:   () => require('./annie_signature').buildAnnieEmail,
  paige:   () => require('./paige_signature').buildPaigeEmail,
  kat:     () => require('./kat_signature').buildKatEmail,
  amanda:  () => require('./amanda_signature').buildAmandaEmail,
  reese:   () => require('./reese_signature').buildReeseEmail,
};
// Roster teammates who send with the generic, roster-driven signature.
const ROSTER_SIGNED = ['isabella', 'mei', 'priya', 'maggie', 'darby', 'phoebe', 'vivian'];
const FRONT_OFFICE_ALIASES = ['', 'general', 'claire'];
const NOT_FROM_COMMUNICATIONS = { tessa: 'Tessa is Ed\'s private assistant: reply from Tessa\'s desk, not Communications.' };

function norm(p) { return String(p || '').trim().toLowerCase(); }

// { ok: true, persona, name, first, mailbox, label, build(body, communityName, quotedHtml) -> { html, attachments } }
// or { ok: false, persona, reason } — never a silent Claire fallback for a named teammate.
function resolveSender(persona) {
  const p = norm(persona);
  if (NOT_FROM_COMMUNICATIONS[p]) return { ok: false, persona: p, reason: NOT_FROM_COMMUNICATIONS[p] };
  const key = FRONT_OFFICE_ALIASES.includes(p) ? 'claire' : p;
  const mailbox = key === 'claire' ? graphSend.CLAIRE_MAILBOX : (graphSend.personaMailbox(key) !== graphSend.CLAIRE_MAILBOX ? graphSend.personaMailbox(key) : null);
  if (!mailbox) return { ok: false, persona: p, reason: `No sending mailbox is configured for "${p}". Nothing was sent; reassign the email or add the teammate's mailbox.` };
  let build, name;
  try { name = require('./persona_signature').identity(key).name; } catch (_) { name = null; }
  if (DEDICATED[key]) build = DEDICATED[key]();
  else if (ROSTER_SIGNED.includes(key)) build = (body, comm, q) => require('./persona_signature').buildPersonaEmail(key, body, comm, q);
  else return { ok: false, persona: p, reason: `"${p}" has no signature configured. Nothing was sent.` };
  if (!name) return { ok: false, persona: p, reason: `"${p}" is not on the team roster. Nothing was sent.` };
  const first = key === 'claire' ? 'Claire' : name.split(' ')[0];
  return { ok: true, persona: key, name: key === 'claire' ? 'Claire' : name, first, mailbox, label: `${key === 'claire' ? 'Claire' : name} (Bedrock AI)`, build };
}

// What the Communications page shows for each teammate (the same resolution the send uses).
function senderDirectory() {
  const out = {};
  for (const p of ['claire', ...Object.keys(DEDICATED).filter((k) => k !== 'claire'), ...ROSTER_SIGNED, 'general', 'tessa']) {
    const s = resolveSender(p);
    out[p] = s.ok ? { sendable: true, name: s.name, first: s.first, mailbox: s.mailbox } : { sendable: false, reason: s.reason };
  }
  return out;
}

module.exports = { resolveSender, senderDirectory, DEDICATED_PERSONAS: Object.keys(DEDICATED), ROSTER_SIGNED };
