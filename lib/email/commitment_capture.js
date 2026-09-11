// ============================================================================
// lib/email/commitment_capture.js  (Ed 2026-09-11)
// ----------------------------------------------------------------------------
// "What's the best way to make sure things like this happen?" A teammate writes
// "I'll ask Tessa to get it on the calendar" or "let me know what works and I'll
// schedule it" — a real commitment — and today it lives only in the prose of a
// sent email. If the other side goes quiet, it dies silently.
//
// This reads an email the team JUST SENT, pulls out the genuine action items,
// and turns each into a tracked follow-up (ea_followups). Two kinds:
//   - owner 'us'   -> we promised something. status 'open', a soft due date.
//   - owner 'them' -> ball is in their court. status 'waiting', waiting_on = the
//                     recipient, a chase date so a quiet reply gets nudged.
//
// Nothing here sends or schedules. It only records what must not be forgotten,
// so it surfaces on the follow-up / Upcoming board instead of relying on memory.
// ============================================================================
const Anthropic = require('@anthropic-ai/sdk');
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.COMMITMENT_MODEL || 'claude-haiku-4-5-20251001';

const CATEGORIES = new Set(['admin', 'banking', 'vendor', 'personal', 'other']);

const PROMPT = `You read an email that Bedrock Association Management (an HOA manager) has just SENT, and extract the genuine COMMITMENTS and OPEN FOLLOW-UPS — the things someone must remember or the ball drops.

Return ONLY a JSON array (no prose, no code fence). Each item:
{
  "text": "<the action in a few plain words, e.g. 'Schedule ACH walkthrough with Melody'>",
  "owner": "us" | "them",
  "category": "admin" | "banking" | "vendor" | "personal" | "other",
  "chase_days": <integer 2-7, ONLY when owner is "them": how long to wait for their reply before a gentle nudge>
}

Rules:
- owner "us": WE promised to do something ("I'll schedule", "I'll send you", "I'll ask Tessa to get it on the calendar", "we'll follow up", "I'll have someone call you"). These are ours to execute.
- owner "them": we asked THEM and are now waiting ("let me know what works", "send me your availability", "once you've had a chance", "whenever you're ready"). We wait, then nudge.
- category: banking for banks/positive-pay/ACH; vendor for vendors/invoices; admin for scheduling/paperwork/internal; personal for Ed's personal items; else other.
- Extract ONLY real action items. Skip greetings, thanks, and statements that need no action. If there are none, return [].
- Keep it to at most 3 — the most important.`;

/**
 * Extract commitments from a sent email body. Returns an array (possibly empty).
 * Best-effort: any failure returns [].
 */
async function extractCommitments({ body, subject } = {}) {
  const text = String(body || '').trim();
  if (text.length < 20) return [];
  try {
    const c = await anthropic.messages.create({
      model: MODEL, max_tokens: 500, system: PROMPT,
      messages: [{ role: 'user', content: `Subject: ${subject || ''}\n\n${text.slice(0, 6000)}` }],
    });
    const raw = (c.content?.[0]?.text || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((x) => x && x.text && (x.owner === 'us' || x.owner === 'them'))
      .slice(0, 3)
      .map((x) => ({
        text: String(x.text).trim().slice(0, 200),
        owner: x.owner,
        category: CATEGORIES.has(x.category) ? x.category : 'other',
        chase_days: x.owner === 'them' ? Math.min(7, Math.max(2, parseInt(x.chase_days, 10) || 3)) : null,
      }));
  } catch (_) { return []; }
}

/**
 * Extract commitments from a just-sent email and record each as an ea_followups
 * row. Returns { created: [...] }. Best-effort — never throws.
 *
 * @param supabase
 * @param {object} opts { body, subject, persona, recipient, communityId, sourceEmailId }
 */
async function captureCommitments(supabase, { body, subject, persona, recipient, sourceEmailId } = {}) {
  const created = [];
  try {
    const items = await extractCommitments({ body, subject });
    if (!items.length) return { created };
    const today = new Date();
    for (const it of items) {
      const due = new Date(today);
      due.setDate(due.getDate() + (it.owner === 'them' ? it.chase_days : 2));
      const row = {
        title: it.text,
        detail: subject ? `From "${subject}"` : null,
        category: it.category,
        status: it.owner === 'them' ? 'waiting' : 'open',
        waiting_on: it.owner === 'them' ? (recipient || null) : null,
        due_date: due.toISOString().slice(0, 10),
        related_email_id: sourceEmailId || null,
        created_by: persona || 'ai-team',
      };
      const { data, error } = await supabase.from('ea_followups').insert(row).select('id, title, status, waiting_on, due_date').single();
      if (error) { console.warn('[commitment_capture] insert failed:', error.message); continue; }
      created.push(data);
    }
  } catch (e) { console.warn('[commitment_capture] skipped:', e.message); }
  return { created };
}

module.exports = { extractCommitments, captureCommitments };
