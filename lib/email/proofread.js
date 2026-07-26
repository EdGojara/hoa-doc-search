// ============================================================================
// lib/email/proofread.js  (Ed 2026-07-26)
// ----------------------------------------------------------------------------
// "Make it so Claire and the platform edit my edits." When a human sends or
// approves an email, catch and fix clear SPELLING errors and typos first — so a
// typo never reaches a homeowner or board, and (because Ed's edits train Claire)
// the encode-Ed signal stays clean.
//
// Deliberately conservative. It fixes ONLY misspellings/typos — never wording,
// tone, punctuation style, names, emails, numbers, or content — and never
// touches a quoted "----- Forwarded message -----" block. Multiple guards make
// it fail SAFE (return the original untouched) rather than risk a rewrite:
//   - skips empty / very long text
//   - rejects any result that changed length materially (a rewrite, not a fix)
//   - any error → original unchanged
// ============================================================================
const Anthropic = require('@anthropic-ai/sdk');
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const FWD_MARKER = '----- Forwarded message -----';

const SYS = `You are a careful copy editor for professional emails. Fix ONLY clear spelling mistakes and obvious typos.

Do NOT change: wording, phrasing, sentence structure, tone, punctuation style, capitalization choices, line breaks, names, email addresses, URLs, numbers, dates, or any content or meaning. Do NOT rewrite, shorten, expand, reword, or reformat. Do NOT add or remove sentences. Do NOT add commentary.

If there are no clear spelling errors, return the text EXACTLY as given, unchanged. Output ONLY the corrected email text — nothing else.`;

// Proofread a single block of prose. Returns { text, changed }.
async function proofreadCopy(text) {
  const orig = String(text == null ? '' : text);
  const trimmed = orig.trim();
  if (!trimmed || trimmed.length > 8000) return { text: orig, changed: false };
  try {
    const r = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2600,
      system: SYS,
      messages: [{ role: 'user', content: trimmed }],
    });
    let out = (r.content && r.content[0] && r.content[0].text ? r.content[0].text : '').replace(/^\s+|\s+$/g, '');
    if (!out) return { text: orig, changed: false };
    // Reject a rewrite — spelling fixes barely change length.
    const ratio = out.length / Math.max(1, trimmed.length);
    if (ratio < 0.85 || ratio > 1.2) return { text: orig, changed: false };
    const changed = out !== trimmed;
    // Preserve the original's leading/trailing whitespace shape by returning the
    // corrected body (callers re-assemble surrounding structure).
    return { text: changed ? out : orig, changed };
  } catch (_) {
    return { text: orig, changed: false };
  }
}

// Proofread an email body, leaving any forwarded/quoted history block untouched.
async function proofreadEmailBody(body) {
  const s = String(body == null ? '' : body);
  const idx = s.indexOf(FWD_MARKER);
  if (idx === -1) return proofreadCopy(s);
  const head = s.slice(0, idx);
  const tail = s.slice(idx); // the forwarded block — never edited
  const pr = await proofreadCopy(head);
  const joined = (pr.text.replace(/\s+$/, '')) + '\n\n' + tail;
  return { text: joined, changed: pr.changed };
}

module.exports = { proofreadCopy, proofreadEmailBody };
