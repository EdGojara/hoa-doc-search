'use strict';
// ============================================================================
// lib/ea/tessa_reply_body.js  (Ed 2026-10-19) — no doubled signature
// ----------------------------------------------------------------------------
// Tessa's signature block already carries her name, title, "Bedrock Association
// Management" and her contact line. A reply typed with its own sign-off
// ("Best regards,\nTessa McCall\nBedrock Association Management") would print
// the name and company twice. This removes the TRAILING lines that repeat what
// the signature block says, and keeps the closing ("Best regards,") and
// everything else exactly as written. Deterministic; nothing is reworded.
// ============================================================================
const norm = (s) => String(s || '').replace(/[\s.,;:!-]+$/g, '').replace(/^\s+/, '').toLowerCase();

function signatureLines(identity) {
  const me = identity || {};
  const first = String(me.name || '').split(/\s+/)[0];
  return new Set([me.name, first, me.title, 'Bedrock Association Management', 'Bedrock', me.email, me.phone]
    .filter(Boolean).map(norm).filter(Boolean));
}

function stripDuplicateSignOff(body, identity) {
  const lines = String(body || '').replace(/\r\n/g, '\n').split('\n');
  const repeats = signatureLines(identity);
  let end = lines.length;
  // Walk up from the bottom past blank lines and lines the signature repeats.
  while (end > 0 && (lines[end - 1].trim() === '' || repeats.has(norm(lines[end - 1])))) end -= 1;
  const removed = lines.slice(end).filter((l) => l.trim() !== '');
  return { body: lines.slice(0, end).join('\n').trimEnd(), removed };
}

module.exports = { stripDuplicateSignOff, signatureLines };
