// ============================================================================
// lib/accounting/kat_review.js  (Ed 2026-08-19)
// ----------------------------------------------------------------------------
// Accounting emails Kat a financial document; Kat reviews it and replies.
//
// Mirrors lib/community/amanda_review.js deliberately — same memory table, same
// "history is only feedback that was actually sent" rule, same refusal to print
// rule ids in prose. One difference, and it is the whole point:
//
//   AMANDA reviews what the document SAYS.
//   KAT also checks whether it is TRUE in the ledger.
//
// The book checks run against live data and their findings are FACTS. The model
// is told to treat them as authoritative and never to soften or second-guess
// them — it is writing the letter around a set of findings, not deciding
// whether they happened. Anything it notices in the document itself is clearly
// separated from that.
//
// Kat REPORTS. She never posts, recodes, reverses or moves money. Every finding
// names what a person should do and the person decides.
// ============================================================================
const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');
const { standardsPrompt } = require('./kat_standards');
const { runBookChecks } = require('./kat_book_checks');
const { extractText, loadPriorReviews, recordReview } = require('../community/amanda_review');

const MODEL = process.env.KAT_REVIEW_MODEL || 'claude-sonnet-4-5';

function _sb() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
}

/** Which of Kat's surfaces is this? */
function classifyFinancialDoc({ filename, subject, text }) {
  const hay = `${filename || ''} ${subject || ''} ${String(text || '').slice(0, 1500)}`.toLowerCase();
  if (/\brecon(cil|)|bank\s*rec\b/.test(hay)) return 'reconciliation';
  if (/\bjournal\s*entry|adjusting\s*entry|\bJE\b/i.test(hay)) return 'journal_entry';
  if (/\bcoding|code this|which account|gl\s*code/.test(hay)) return 'ap_coding';
  if (/\bbalance\s*sheet|income\s*statement|financial|budget\s*vs|profit\s*(and|&)\s*loss|\bP&L\b/i.test(hay)) return 'financials';
  return 'financials';
}

/** "July 2026", "07/2026", "Jul-26" -> a stable period label for memory. */
function parsePeriod(text) {
  const t = String(text || '');
  const MON = { january:1, february:2, march:3, april:4, may:5, june:6, july:7, august:8, september:9, october:10, november:11, december:12,
                jan:1, feb:2, mar:3, apr:4, jun:6, jul:7, aug:8, sep:9, sept:9, oct:10, nov:11, dec:12 };
  let m = t.match(/\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?,?\s+(20\d{2})\b/i);
  if (m) return `${m[2]}-${String(MON[m[1].toLowerCase()]).padStart(2, '0')}`;
  m = t.match(/\b(0?[1-9]|1[0-2])\/(20\d{2})\b/);
  if (m) return `${m[2]}-${String(m[1]).padStart(2, '0')}`;
  return null;
}

async function matchCommunity(text, supabase) {
  const { data } = await supabase.from('communities').select('id, name');
  const hay = String(text || '').toLowerCase();
  let best = null;
  for (const c of data || []) {
    const n = String(c.name || '').toLowerCase();
    if (!n) continue;
    if (hay.includes(n)) { best = c; break; }
    const short = n.replace(/\b(homeowners?|association|hoa|inc\.?|estates?|at .*)\b/g, '').trim();
    if (short.length > 4 && hay.includes(short)) best = best || c;
  }
  return best;
}

/**
 * @returns {Promise<null|{draftable:true, subject, body, docType, findings, ...}>}
 */
async function draftKatFinancialReview({ email, attachments = [], supabase = null, senderFirstName = null }) {
  const sb = supabase || _sb();
  if (!process.env.ANTHROPIC_API_KEY) return { draftable: false, reason: 'no_api_key' };

  const doc = (attachments || []).find((a) => /\.(pdf|xlsx?|csv|docx)$/i.test(a.filename || ''));
  const docText = doc ? await extractText(doc) : '';
  const bodyText = String(email.body_full || email.body || email.body_preview || '').replace(/<[^>]+>/g, ' ');
  const haystack = `${email.subject || ''}\n${bodyText}\n${docText}`;

  const community = await matchCommunity(haystack, sb);
  const period = parsePeriod(haystack);
  const docType = classifyFinancialDoc({ filename: doc && doc.filename, subject: email.subject, text: docText || bodyText });
  const first = senderFirstName || String(email.sender_name || '').trim().split(/\s+/)[0] || 'there';

  // THE FACTS. Portfolio-wide for cross-community; scoped otherwise.
  const checks = await runBookChecks(sb, { communityId: community ? community.id : null });

  // Only feedback that was actually SENT counts as history — same rule as
  // Amanda's, learned when she accused Martha of ignoring an unsent review.
  const history = await loadPriorReviews({
    staffEmail: email.sender_email, documentType: docType,
    excludeFilename: (doc && doc.filename) || null,
  });

  const bookBlock = checks.results.filter((r) => r.ok === false && !r.error).map((r) => {
    const lines = (r.findings || []).slice(0, 8).map((f) => {
      const amt = f.amount_cents != null ? ` $${(f.amount_cents / 100).toFixed(2)}` : '';
      return `    - ${f.detail}${amt}${f.description ? ` (${f.description})` : ''}${f.check_number ? ` check #${f.check_number}` : ''}${f.last_import ? ` [last import ${f.last_import}, ${f.days_stale} days]` : ''}`;
    }).join('\n');
    return `  [${r.rule_id}] ${(r.findings || []).length} finding(s)\n${lines}`;
  }).join('\n');

  const historyBlock = history.length
    ? 'WHAT YOU TOLD THIS PERSON BEFORE (newest first). Rule ids only. Use it to say what is FIXED and what is RECURRING. Never claim anything not on this list.\n'
      + history.map((h) => `  - ${String(h.created_at).slice(0, 10)}: ${(h.finding_ids || []).join(', ') || 'nothing flagged'}`).join('\n')
    : 'No prior review of this type has been sent to this person. Treat it as the first and do not imply any history.';

  const prompt = `You are Kat Reed, accounting manager at Bedrock Association Management, reviewing work sent to you by a member of the accounting team. You are writing the reply email.

WHO SENT IT: ${email.sender_name || email.sender_email} ("${first}")
SUBJECT: ${email.subject || '(none)'}
THEIR NOTE: ${bodyText.trim().slice(0, 900) || '(none)'}
DOCUMENT: ${doc ? doc.filename : '(none attached)'}
COMMUNITY: ${community ? community.name : '(not identified)'}
PERIOD: ${period || '(not stated)'}

DOCUMENT CONTENT (may be truncated):
${(docText || '(no readable document)').slice(0, 9000)}

THE STANDARDS YOU REVIEW AGAINST:
${standardsPrompt()}

WHAT THE LEDGER ACTUALLY SAYS. These were checked against live data just now.
They are FACTS. Do not soften them, do not hedge them, do not re-derive them.
If this block is empty, the automated checks found nothing and you should say so.
${bookBlock || '  (all automated checks clean)'}

${historyBlock}

HOW TO WRITE IT:
- Answer any question they actually asked, first.
- Lead with whatever has the largest consequence, not the first thing you noticed.
- The ledger findings above outrank anything you infer from the document. Say plainly where they came from ("checking the ledger for that period") so it does not read as an opinion.
- Name what a PERSON should do about each one. You report and recommend; you never post, recode, reverse or move money, and you should not imply otherwise.
- Say what they got right, specifically, if they did.
- You are a colleague and a manager, not a grader. Be direct and warm.
- You have no calendar and cannot attend anything. NEVER propose a meeting, a call or "20 minutes". If something needs more than written feedback, hand it to Ed.
- Plain sentences. No em-dashes. No bullet-point walls.
- Sign as Kat. No AI disclosure line: this is internal mail to a colleague who knows the team.

RETURN STRICT JSON, no code fences:
{"findings":[{"rule_id":"<id from the standards, or 'general'>","severity":"blocking|should_fix|minor","note":"<8 words max>"}],
 "fixed_since_last":["<rule_id corrected since the last review>"],
 "body":"<the reply email body>"}
Every problem you raise in the body must appear in findings, and nothing you do not raise.
RULE IDS BELONG ONLY IN THE findings ARRAY. Never write one in the body.`;

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const r = await anthropic.messages.create({
    model: MODEL, max_tokens: 2000,
    messages: [{ role: 'user', content: prompt }],
  });

  const raw = String(r.content?.[0]?.text || '').trim();
  if (!raw) return { draftable: false, reason: 'empty_draft' };

  let findings = [], fixedSince = [], body = raw;
  try {
    const j = JSON.parse(raw.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim());
    if (j && typeof j.body === 'string' && j.body.trim()) {
      body = j.body.trim()
        .replace(/\s*[[(]\s*[a-z][a-z0-9_]{4,}\s*[\])]/g, '')
        .replace(/[^\S\n]+\n/g, '\n')
        .replace(/[^\S\n]{2,}/g, ' ')
        .trim();
      findings = Array.isArray(j.findings) ? j.findings : [];
      fixedSince = Array.isArray(j.fixed_since_last) ? j.fixed_since_last : [];
    }
  } catch (_) {
    console.warn('[kat_review] model did not return JSON — review usable, no memory recorded');
  }

  return {
    draftable: true,
    docType,
    reviewed: (doc && doc.filename) || '(no attachment)',
    community, period,
    subject: /^re:/i.test(email.subject || '') ? email.subject : `Re: ${email.subject || 'your draft'}`,
    body, findings, fixed_since_last: fixedSince,
    book_findings: checks.total_findings,
    priorReviews: history.length,
  };
}

module.exports = { draftKatFinancialReview, classifyFinancialDoc, parsePeriod, recordReview };
