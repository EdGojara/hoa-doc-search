// ============================================================================
// lib/ai/customer_writing_standard.js  (Ed 2026-09-20)
// ----------------------------------------------------------------------------
// ONE shared, channel-neutral customer-facing writing standard for Trusted AI.
// It lives here (not in the voice stack) on purpose: it applies to voice, chat,
// email, board Amanda and Ask CLMA alike, so no non-voice surface should have to
// depend on voice-specific architecture just to obtain writing style.
//
// Two parts, used together:
//   CUSTOMER_WRITING_STANDARD  the instruction, included in customer-facing
//                              system prompts.
//   stripEmDashes(text)        a deterministic backstop applied to customer-facing
//                              OUTPUT, because the model does not reliably obey the
//                              "no em dashes" instruction on its own (same lesson
//                              as CLAUDE.md: when instruction-following fails, add a
//                              check, not another paragraph). It only normalizes
//                              punctuation. It never changes wording, facts,
//                              citations, numbers, or meaning.
// ============================================================================

const CUSTOMER_WRITING_STANDARD =
  'Write naturally and conversationally. Do not use em dashes. Use normal '
  + 'punctuation such as commas, periods, colons, and parentheses. Avoid '
  + 'repetitive AI-style constructions, unnecessarily formal language, excessive '
  + 'structure, and other patterns that make responses sound machine-generated.';

// Replace em dashes (and en dashes used as punctuation) with natural punctuation.
// Deterministic and content-preserving: only dash characters and adjacent
// whitespace are touched.
function stripEmDashes(text) {
  if (text == null) return text;
  let s = String(text);
  // Em dash (U+2014) and horizontal bar (U+2015) acting as a clause break -> comma.
  s = s.replace(/\s*[—―]\s*/g, ', ');
  // En dash (U+2013) used as punctuation between spaces -> comma; tight en dash
  // (number ranges, "5–10") -> hyphen so ranges stay readable.
  s = s.replace(/\s+–\s+/g, ', ').replace(/–/g, '-');
  // Tidy artifacts the replacement can create.
  s = s.replace(/,\s*,/g, ',').replace(/\s+([.,;:!?])/g, '$1');
  return s;
}

module.exports = { CUSTOMER_WRITING_STANDARD, stripEmDashes };
