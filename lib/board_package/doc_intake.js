// ===========================================================================
// board_package/doc_intake.js  (Ed 2026-07-20)
// ---------------------------------------------------------------------------
// Staff emails the AI team like they'd email a person — "please add this to
// Lakes of Pine Forest minutes" with the file attached (or the text pasted) —
// and it lands in the platform. This is the intake behind that: detect the
// intent, extract the document, and write it into the NATIVE module as a
// DRAFT record (meeting_minutes / meeting_agendas), so it's a first-class,
// searchable, exportable association record that auto-flows into this AND
// every future board packet — not a PDF stapled to one packet nobody can find.
//
// Draft, never final: filing it is safe (nothing is published or sent), but a
// human still reviews and finalizes it — same immutability discipline as the
// rest of the minutes/agenda lifecycle.
//
// Scars honored: PDF binary goes straight to Claude (never pdf-parse on a form
// PDF); raw model output is logged; every query destructures `error`;
// meeting_type is clamped to each table's CHECK set; intake is idempotent via
// intake_source_ref (mig 320) so a repeat mail pull can't double-file.
// ===========================================================================
const Anthropic = require('@anthropic-ai/sdk');
const { fetchAttachmentBuffers, htmlToText } = require('../email/graph_attachments');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const BEDROCK_MGMT_CO_ID = '00000000-0000-0000-0000-000000000001';

const MINUTES_TYPES = ['regular', 'annual', 'special', 'executive', 'organizational'];
const AGENDA_TYPES = ['regular', 'annual', 'special', 'budget', 'emergency', 'executive', 'organizational'];

// Does this email want a board doc filed? Returns { wants, docTypeHint }.
// docTypeHint is what the SENDER said ('minutes'|'agenda'|null) — the extractor
// still classifies each file from its content, but a clear ask wins ties.
function detectBoardDocIntent(text) {
  const t = String(text || '').toLowerCase();
  const minutes = /\bminutes\b/.test(t);
  const agenda = /\bagenda\b/.test(t);
  const noun = minutes || agenda;
  // A filing verb anywhere: add / attach(ed) / file / save / upload(ed) / here's...
  const verb = /\b(add|attach(ed|ing)?|file|filing|saved?|upload(ed|ing)?|record|log|put|include|enclos(ed|ing)|here'?s|here is|here are)\b/.test(t)
    || /\bplease\s+(add|file|save|record|log|upload)\b/.test(t);
  // …or the noun sits next to a qualifier that means "a real doc" — "signed
  // minutes", "March agenda", "minutes for the last meeting", "attached minutes".
  const qualified = /\b(minutes|agenda)\b[\s\S]{0,24}\b(for|from|of|attached|enclosed)\b/.test(t)
    || /\b(last|prior|previous|attached|enclosed|signed|final|approved|draft|month'?s|meeting|jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|jun(e)?|jul(y)?|aug(ust)?|sep(tember)?|oct(ober)?|nov(ember)?|dec(ember)?)\b[\s\S]{0,24}\b(minutes|agenda)\b/.test(t);
  const wants = noun && (verb || qualified);
  let docTypeHint = null;
  if (minutes && !agenda) docTypeHint = 'minutes';
  else if (agenda && !minutes) docTypeHint = 'agenda';
  return { wants: !!wants, docTypeHint };
}

const EXTRACT_PROMPT = `You are filing a board-meeting document for an HOA management company into the platform. First DECIDE what it is, then extract it.

doc_type — "minutes" if it's the RECORD of a meeting that already happened (attendance, motions, votes, "the meeting was called to order"), or "agenda" if it's the PLAN for an upcoming meeting (an ordered list of topics to discuss, no votes recorded). If genuinely unclear, use the caller's hint.

Return ONLY a JSON object, no prose:
{
  "doc_type": "minutes" | "agenda",
  "meeting_date": "YYYY-MM-DD" | null,        // the date of the meeting itself, not today
  "meeting_type": "regular" | "annual" | "special" | "executive" | "organizational" | "budget" | "emergency" | "organizational" | null,
  "title": string | null,                     // e.g. "Regular Board Meeting Minutes — March 12, 2026"
  "location": string | null,
  "called_to_order_at": string | null,        // minutes only, free text time e.g. "6:03 PM"
  "adjourned_at": string | null,              // minutes only
  "attendees": [{ "name": string, "role": string | null, "present": true }] | null,  // minutes only
  "body_markdown": string | null,             // MINUTES: the full minutes body, faithfully, in clean markdown
  "full_text": string | null,                 // AGENDA: the full agenda body as readable text
  "items": [{ "topic": string, "duration_min": number | null }] | null  // AGENDA: the ordered agenda items
}

Rules:
- Transcribe faithfully. Do NOT invent votes, attendees, dollar amounts, or dates that aren't in the document. A field you can't find is null.
- meeting_date is the MEETING's date (often in the title/header), never the date the email was sent.
- For minutes, put the readable minutes into body_markdown. For an agenda, put the readable agenda into full_text and the ordered topics into items.`;

// Extract one document (PDF buffer OR pasted text) into a structured record.
// Returns the parsed object (with doc_type) or null on failure.
async function extractBoardDoc({ buffer, text, docTypeHint }) {
  const content = [];
  if (buffer) {
    content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buffer.toString('base64') } });
  } else if (text && text.trim()) {
    content.push({ type: 'text', text: `The document is pasted below (no attachment).\n\n---\n${text.slice(0, 40000)}\n---` });
  } else {
    return null;
  }
  content.push({ type: 'text', text: `${EXTRACT_PROMPT}\n\nCaller's hint about the type: ${docTypeHint || 'none'}.` });

  let raw = '';
  try {
    const resp = await anthropic.messages.create({
      model: 'claude-sonnet-4-5', max_tokens: 4000,
      messages: [{ role: 'user', content }],
    });
    raw = (resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    console.log('[board_doc_intake] Claude returned:', raw.slice(0, 600));
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const parsed = JSON.parse(m[0]);
    parsed.doc_type = parsed.doc_type === 'agenda' ? 'agenda' : (parsed.doc_type === 'minutes' ? 'minutes' : (docTypeHint || 'minutes'));
    return parsed;
  } catch (e) {
    console.warn('[board_doc_intake] extract failed:', e.message, '| raw:', raw.slice(0, 200));
    return null;
  }
}

function clampType(list, val, fallback) {
  return list.includes(String(val)) ? String(val) : fallback;
}

// Write one extracted doc into its native module as a draft. Idempotent on
// srcRef. Returns { filed:true, docType, id, meeting_date, title } or a reason.
async function fileBoardDoc({ supabase, communityId, mgmtCoId, parsed, srcRef, createdBy }) {
  if (!parsed) return { filed: false, reason: 'could not read the document' };
  const docType = parsed.doc_type;

  const table = docType === 'agenda' ? 'meeting_agendas' : 'meeting_minutes';
  // Idempotency: same email+attachment already filed? (destructure error — a
  // broken query must not read as "not found" and cause a double-file.)
  const { data: existing, error: exErr } = await supabase.from(table)
    .select('id, meeting_date, title').eq('intake_source_ref', srcRef).maybeSingle();
  if (exErr) throw exErr;
  if (existing) return { filed: false, already: true, docType, id: existing.id, meeting_date: existing.meeting_date, title: existing.title };

  if (docType === 'agenda') {
    const type = clampType(AGENDA_TYPES, parsed.meeting_type, 'regular');
    const fullText = (parsed.full_text && parsed.full_text.trim())
      || (Array.isArray(parsed.items) ? parsed.items.map((i, n) => `${n + 1}. ${i.topic}`).join('\n') : '');
    if (!fullText.trim()) return { filed: false, reason: 'no agenda content found in the document' };
    const row = {
      management_company_id: mgmtCoId, community_id: communityId,
      meeting_date: parsed.meeting_date || null, meeting_type: type,
      location: parsed.location || null,
      title: parsed.title || `${type[0].toUpperCase() + type.slice(1)} Meeting Agenda`,
      full_text: fullText,
      items: Array.isArray(parsed.items) && parsed.items.length ? parsed.items : null,
      status: 'draft', created_by: createdBy, intake_source_ref: srcRef,
    };
    const { data, error } = await supabase.from('meeting_agendas').insert(row).select('id, meeting_date, title').single();
    if (error) throw error;
    return { filed: true, docType, id: data.id, meeting_date: data.meeting_date, title: data.title };
  }

  // minutes
  const type = clampType(MINUTES_TYPES, parsed.meeting_type, 'regular');
  const body = (parsed.body_markdown && parsed.body_markdown.trim()) || '';
  if (!body) return { filed: false, reason: 'no minutes content found in the document' };
  const row = {
    management_company_id: mgmtCoId, community_id: communityId,
    meeting_date: parsed.meeting_date || null, meeting_type: type,
    title: parsed.title || `${type[0].toUpperCase() + type.slice(1)} Board Meeting Minutes`,
    location: parsed.location || null,
    called_to_order_at: parsed.called_to_order_at || null,
    adjourned_at: parsed.adjourned_at || null,
    attendees: Array.isArray(parsed.attendees) && parsed.attendees.length ? parsed.attendees : null,
    body_markdown: body,
    status: 'draft', ai_drafted: true, ai_model: 'claude-sonnet-4-5',
    created_by: createdBy, intake_source_ref: srcRef,
  };
  const { data, error } = await supabase.from('meeting_minutes').insert(row).select('id, meeting_date, title').single();
  if (error) throw error;
  return { filed: true, docType, id: data.id, meeting_date: data.meeting_date, title: data.title };
}

// Top-level: ingest every board doc on an email (attachments first, else the
// pasted body). Returns { results: [...], attempted } — the caller shapes the
// reply. Community must already be resolved by the caller.
async function ingestBoardDocs({ email, supabase, mailbox, community, docTypeHint }) {
  const srcBase = `email:${email.graph_id}`;
  const createdBy = `email:${(email.sender_email || 'staff')}`;
  const mgmtCoId = (community && community.management_company_id) || BEDROCK_MGMT_CO_ID;
  const results = [];

  let pdfs = [];
  try { if (email.graph_id && mailbox) pdfs = await fetchAttachmentBuffers(mailbox, email.graph_id); }
  catch (e) { console.warn('[board_doc_intake] attachment fetch failed:', e.message); }

  if (pdfs.length) {
    for (const pdf of pdfs) {
      const srcRef = `${srcBase}#${pdf.filename}`;
      const parsed = await extractBoardDoc({ buffer: pdf.buffer, docTypeHint });
      try {
        const out = await fileBoardDoc({ supabase, communityId: community.id, mgmtCoId, parsed, srcRef, createdBy });
        results.push({ ...out, filename: pdf.filename });
      } catch (e) {
        console.warn('[board_doc_intake] file failed:', e.message);
        results.push({ filed: false, reason: 'the platform could not save it', filename: pdf.filename });
      }
    }
    return { results, attempted: pdfs.length, mode: 'attachment' };
  }

  // No attachment — try the pasted body (staff often just paste the minutes).
  const bodyText = htmlToText(email.body_full || email.body || email.body_preview || '');
  if (bodyText && bodyText.length > 400) {
    const srcRef = `${srcBase}#body`;
    const parsed = await extractBoardDoc({ text: bodyText, docTypeHint });
    try {
      const out = await fileBoardDoc({ supabase, communityId: community.id, mgmtCoId, parsed, srcRef, createdBy });
      results.push({ ...out, filename: null });
    } catch (e) {
      console.warn('[board_doc_intake] file (body) failed:', e.message);
      results.push({ filed: false, reason: 'the platform could not save it', filename: null });
    }
    return { results, attempted: 1, mode: 'body' };
  }

  return { results, attempted: 0, mode: 'none' };
}

module.exports = { detectBoardDocIntent, ingestBoardDocs, extractBoardDoc, fileBoardDoc };
