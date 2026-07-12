// ============================================================================
// lib/ea/tessa_voice.js  (Ed 2026-07-12)
// ----------------------------------------------------------------------------
// Voice dictation for Tessa. Ed taps the mic on /admin/tessa, talks, and it
// becomes the right thing: a drafted email, one or more follow-up tasks, or
// both. Two steps:
//   1. transcribeAudio(buffer, mimetype) -> text   (Deepgram pre-recorded REST;
//      same DEEPGRAM_API_KEY the phone path uses, no new provider)
//   2. routeDictation(text) -> { summary, email, tasks }  (Anthropic decides
//      whether Ed wants an email written, things tracked, or both)
// Ed's voice, no em-dashes. Nothing is sent or saved here — the API surfaces
// the result for Ed to confirm.
// ============================================================================
const Anthropic = require('@anthropic-ai/sdk');
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function sttConfigured() { return !!process.env.DEEPGRAM_API_KEY; }

// Deepgram pre-recorded transcription of a recorded clip (webm/opus, wav, m4a…).
async function transcribeAudio(buffer, mimetype) {
  if (!process.env.DEEPGRAM_API_KEY) { const e = new Error('DEEPGRAM_API_KEY not set'); e.code = 'STT_NOT_CONFIGURED'; throw e; }
  if (!buffer || !buffer.length) { const e = new Error('empty_audio'); e.code = 'EMPTY_AUDIO'; throw e; }
  const params = new URLSearchParams({ model: 'nova-2', smart_format: 'true', punctuate: 'true', language: 'en' });
  const resp = await fetch(`https://api.deepgram.com/v1/listen?${params.toString()}`, {
    method: 'POST',
    headers: { Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`, 'Content-Type': mimetype || 'audio/webm' },
    body: buffer,
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    const e = new Error(`deepgram_${resp.status}`); e.detail = t.slice(0, 300); throw e;
  }
  const j = await resp.json();
  const text = j?.results?.channels?.[0]?.alternatives?.[0]?.transcript || '';
  return String(text).trim();
}

// Turn a dictated thought into an email draft and/or follow-up tasks.
async function routeDictation(text) {
  const t = String(text || '').trim();
  if (!t) return { summary: '', email: null, tasks: [] };
  const system = `You are Tessa McCall, Ed Gojara's executive assistant at Bedrock Association
Management. Ed just dictated a thought out loud. Decide what he wants and return it.

He may want ONE or BOTH of:
  - an EMAIL written (he says to email / reach out to / tell / ask someone). Draft
    it fully in HIS first-person voice (he signs "Ed" or "Thanks, Ed"). Use commas,
    never em-dashes. Do not invent recipients, amounts, dates, or commitments he
    did not say. If he names a recipient, put it in recipient_hint (a name is fine,
    it does not need to be an email address).
  - one or more FOLLOW-UP TASKS to track (he says remind me / follow up on / I need
    to / don't let me forget). Each task is a short imperative title plus a category.

Categories: admin, banking, vendor, personal, other. Pick the closest.

Return ONLY JSON, no markdown fence:
{
  "summary": "one short line of what Ed asked for",
  "email": null OR { "recipient_hint": "name or empty", "subject": "string", "body": "full email with greeting and sign-off", "mode": "ed" },
  "tasks": [ { "title": "string", "category": "admin|banking|vendor|personal|other", "waiting_on": "who/what or empty", "due_hint": "e.g. Friday, or empty" } ]
}
If there is no email, email is null. If there are no tasks, tasks is [].`;
  const completion = await anthropic.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 1600,
    system,
    messages: [{ role: 'user', content: `Ed dictated: ${t}` }],
  });
  const raw = completion.content?.[0]?.text || '';
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try {
    const p = JSON.parse(cleaned);
    const cats = ['admin', 'banking', 'vendor', 'personal', 'other'];
    const email = p.email && p.email.body
      ? { recipient_hint: p.email.recipient_hint || '', subject: p.email.subject || '', body: p.email.body || '', mode: 'ed' }
      : null;
    const tasks = Array.isArray(p.tasks) ? p.tasks.filter((x) => x && x.title).map((x) => ({
      title: String(x.title).trim(),
      category: cats.includes(x.category) ? x.category : 'other',
      waiting_on: x.waiting_on ? String(x.waiting_on).trim() : null,
      due_hint: x.due_hint ? String(x.due_hint).trim() : null,
    })) : [];
    return { summary: p.summary || '', email, tasks };
  } catch (e) {
    return { summary: '', email: null, tasks: [], degraded: true, error: e.message };
  }
}

module.exports = { transcribeAudio, routeDictation, sttConfigured };
