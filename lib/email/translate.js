// ============================================================================
// lib/email/translate.js  (Ed 2026-09-13)
// ----------------------------------------------------------------------------
// Translate a staff-approved English email reply into a resident's language at
// SEND time. The English draft is authored, reviewed, edited, and stored by the
// team in English (English governs the record, and it "works for our team");
// only the outgoing copy is translated, so a Spanish/Mandarin resident reads the
// reply in their own language and the English original is preserved for the file.
//
// Guardrails: keep names, addresses, emails, URLs, phone numbers, and any dollar
// amounts / dates / deadlines EXACTLY as written (never localize or alter a
// binding figure); natural, warm, conversational register in the target
// language, not stiff machine translation; output ONLY the translated body.
//
// This is for CONVERSATIONAL email replies. Formal statutory letters (violation
// notices, §209, fine assessments, ACC decisions) are a separate path and are
// NOT translated here — they stay in the governed English wording.
// ============================================================================
const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.EMAIL_TRANSLATE_MODEL || 'claude-sonnet-4-6';

const LANG_NAME = {
  es: 'Spanish (natural, conversational Latin American Spanish)',
  zh: 'Mandarin Chinese (Simplified, natural and conversational)',
  vi: 'Vietnamese (natural, conversational)',
  ko: 'Korean (natural, conversational)',
  hi: 'Hindi (natural, conversational)',
};

/**
 * Translate an approved English reply body into the resident's language.
 * Returns the translated string, or the original English on any failure /
 * unsupported language (so a translation problem NEVER blocks a send).
 * @param {string} englishBody
 * @param {string} langCode  ISO 639-1 (es|zh|vi|ko). 'en'/empty => unchanged.
 */
async function translateForResident(englishBody, langCode) {
  const text = String(englishBody || '').trim();
  const lang = String(langCode || '').toLowerCase();
  if (!text || !lang || lang === 'en') return text;
  const target = LANG_NAME[lang];
  if (!target) return text; // unknown language — send English rather than guess

  const sys = `You translate a homeowner-association email reply from English into ${target}. This goes directly to a resident, so it must read like a warm, competent person wrote it in that language — not a literal machine translation.

RULES:
- Translate the MEANING faithfully and naturally. Do not add, drop, soften, or embellish anything.
- Keep EXACTLY as written, do not translate or localize: people's names, company/community names, email addresses, URLs, phone numbers, and the NUMERIC VALUE of any amount, date, or figure ("$700", "$25", "3", "30", "10%"). BUT translate the ordinary words around them, including unit words: "3 business days" -> the target-language phrase for that (e.g. Spanish "3 días hábiles"), "per quarter" -> the target-language phrase. Keep the number; translate the words.
- Preserve the paragraph/line breaks.
- Do NOT add a greeting or sign-off that isn't in the original (the branded signature is added separately).
- Output ONLY the translated email body. No preamble, no notes, no quotes.`;

  try {
    const resp = await anthropic.messages.create({
      model: MODEL, max_tokens: 1200, system: sys,
      messages: [{ role: 'user', content: text }],
    });
    const out = ((resp.content[0] && resp.content[0].text) || '').trim();
    return out || text;
  } catch (e) {
    console.warn('[translate] failed, sending English:', e.message);
    return text;
  }
}

// Identify the language a resident wrote in, so we can record it and default
// their future communication to it. Returns a supported ISO code (es|zh|vi|ko),
// 'en' for English or anything else / unsupported, or null on failure. Cheap
// model call; callers gate it (e.g. only run when preferred_language is unset).
const DETECT_MODEL = process.env.EMAIL_DETECT_MODEL || 'claude-haiku-4-5-20251001';
async function detectLanguage(text) {
  const t = String(text || '').trim();
  if (t.length < 8) return null; // too short to tell
  try {
    const resp = await anthropic.messages.create({
      model: DETECT_MODEL, max_tokens: 4,
      system: 'Identify the language this message is WRITTEN IN. Reply with ONLY one lowercase code: es (Spanish), zh (Chinese/Mandarin), vi (Vietnamese), ko (Korean), hi (Hindi), or en (English or any other language). Judge by the bulk of the text; ignore names, email addresses, and quoted signatures. Output only the two-letter code.',
      messages: [{ role: 'user', content: t.slice(0, 1500) }],
    });
    const code = (((resp.content[0] && resp.content[0].text) || '').trim().toLowerCase().match(/[a-z]{2}/) || [])[0];
    return ['es', 'zh', 'vi', 'ko', 'hi', 'en'].includes(code) ? code : null;
  } catch (e) {
    console.warn('[translate] language detect failed:', e.message);
    return null;
  }
}

module.exports = { translateForResident, detectLanguage, LANG_NAME };
