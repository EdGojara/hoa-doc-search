'use strict';
// ============================================================================
// lib/ea/document_check.js  (Ed 2026-10-19) — Tessa reads a returned document
// ----------------------------------------------------------------------------
// "Never assume an attachment is a completed or signed return without
// verification." Tessa reads the PDF itself (the binary, per CLAUDE.md) and
// reports what she can SEE: which form, which entity and year, and whether the
// signature line carries a signature. The result is advisory: appears_signed /
// not_signed / uncertain. Anything that does not match what Ed is waiting for
// is downgraded to uncertain with the reason. Only Ed verifies (delegation.js).
// ============================================================================
const crypto = require('crypto');

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const squash = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Normalise the model's answer against what Ed is waiting for. Pure; tested.
function normalizeCheck(raw, expect = {}) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const concerns = Array.isArray(r.concerns) ? r.concerns.map(String).filter(Boolean).slice(0, 8) : [];
  let verdict = ['appears_signed', 'not_signed', 'uncertain'].includes(r.verdict) ? r.verdict : 'uncertain';
  if (verdict === 'appears_signed' && r.signature_visible !== true) { verdict = 'uncertain'; concerns.push('No signature was described on the signature line.'); }
  if (expect.form && r.form && !squash(r.form).includes(squash(expect.form))) { if (verdict === 'appears_signed') verdict = 'uncertain'; concerns.push(`The form reads "${r.form}", not ${expect.form}.`); }
  if (expect.tax_year && r.tax_year && String(r.tax_year) !== String(expect.tax_year)) { if (verdict === 'appears_signed') verdict = 'uncertain'; concerns.push(`The tax year reads ${r.tax_year}, not ${expect.tax_year}.`); }
  if (expect.entity && r.entity_name) {
    const want = squash(expect.entity).replace(/(communityassociation|homeownersassociation|association|inc)$/, '');
    if (want && !squash(r.entity_name).includes(want)) { if (verdict === 'appears_signed') verdict = 'uncertain'; concerns.push(`The return is for "${r.entity_name}", not ${expect.entity}.`); }
  }
  // Which association? Proven only by the document: the entity name, and the EIN
  // when one is on file. A file name is never evidence. (Ed 2026-10-19.)
  //   true  the printed name matches, and the printed EIN matches when one is on file
  //   false the printed name or EIN conflicts with the association
  //   null  not provable from the document (name or EIN unreadable)
  // Anything but true makes Ed confirm the association himself (delegation.js).
  const digits = (s) => String(s || '').replace(/\D/g, '');
  const want = squash(expect.entity).replace(/(communityassociation|homeownersassociation|association|inc)$/, '');
  const got = squash(r.entity_name);
  const nameMatch = !want ? null : (!got ? null : got.includes(want));
  const einMatch = !expect.ein ? 'none_on_file' : (!r.ein ? null : digits(expect.ein) === digits(r.ein));
  if (einMatch === false) concerns.push(`The EIN on the return (${r.ein}) is not the association's EIN on file.`);
  if (expect.entity && !got) concerns.push('The association name on the return could not be read.');
  if (expect.ein && !r.ein) concerns.push('The EIN on the return could not be read.');
  if (einMatch === 'none_on_file') concerns.push('No EIN is on file for this association, so only the printed name could be compared.');
  const association_match = (nameMatch === false || einMatch === false) ? false
    : (nameMatch === true && (einMatch === true || einMatch === 'none_on_file')) ? true : null;
  if (association_match !== true && verdict === 'appears_signed') verdict = 'uncertain';
  if (!r.form) concerns.push('The form type could not be read.');
  return {
    verdict, signature_visible: r.signature_visible === true, signer_printed_name: r.signer_printed_name || null, signed_date: r.signed_date || null,
    form: r.form || null, entity_name: r.entity_name || null, ein: r.ein || null, tax_year: r.tax_year ? String(r.tax_year) : null, pages: Number.isInteger(r.pages) ? r.pages : null,
    association_match,
    concerns: [...new Set(concerns)],
  };
}

const PROMPT = (expect) => `You are checking a document that came back by email. Ed is waiting for a SIGNED ${expect.form || 'document'}${expect.entity ? ` for ${expect.entity}` : ''}${expect.tax_year ? `, tax year ${expect.tax_year}` : ''}.
Report ONLY what is visible on the pages. Do not infer a signature from a typed name, a "/s/", or the word "signed": a signature is handwriting or an image of one on the signature line. If the scan is unclear, say uncertain.
Read the entity name and the EIN exactly as printed on the return.
Return ONLY JSON: {"verdict":"appears_signed"|"not_signed"|"uncertain","signature_visible":true|false,"signer_printed_name":"","signed_date":"","form":"","entity_name":"","ein":"","tax_year":"","pages":0,"concerns":["anything a careful reviewer should look at"]}`;

async function checkReturnedDocument({ buffer, filename, expect = {}, anthropic = null }) {
  if (!buffer || !buffer.length) throw Object.assign(new Error('The document could not be read.'), { code: 'no_bytes' });
  const client = anthropic || new (require('../ai/anthropic'))({ apiKey: process.env.ANTHROPIC_API_KEY });
  const { route: aiRoute } = require('../ai/router');
  const resp = await client.messages.create({
    model: aiRoute('tessa.document_check'), max_tokens: 800,
    messages: [{ role: 'user', content: [
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buffer.toString('base64') } },
      { type: 'text', text: PROMPT(expect) },
    ] }],
  });
  const text = (resp.content || []).map((b) => b.text || '').join('').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  let raw = null; try { raw = JSON.parse(text); } catch (_) { raw = null; }
  console.log('[tessa.document_check] model returned:', JSON.stringify({ filename, raw: raw || text.slice(0, 300) }));
  const advisory = normalizeCheck(raw, expect);
  if (!raw) advisory.concerns.unshift('Tessa could not read a clear answer from the document.');
  return { advisory, raw_extracted: raw, sha256: sha256(buffer), filename };
}

module.exports = { checkReturnedDocument, normalizeCheck, sha256 };
