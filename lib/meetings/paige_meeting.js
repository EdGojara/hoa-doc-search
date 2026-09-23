// ============================================================================
// lib/meetings/paige_meeting.js  (Ed 2026-09-23)
// ----------------------------------------------------------------------------
// Paige's meeting intelligence: reads the verified, speaker-labeled OPEN-
// SESSION transcript and returns structured output (summary, motions + votes,
// decisions, action items, follow-ups, next-agenda suggestions, discussion
// notes for the minutes, and speaker-identity suggestions).
//
// Executive-session content is never sent: those lines are replaced by one
// marker line with the times, so Paige cannot summarize what she never saw.
// Every item must cite transcript line ids (u12, ...) and a short verbatim
// quote; lib/meetings/intel_validate.js checks all of it in code afterwards.
// The model is told to leave anything not actually said empty, never to fill
// it in.
// ============================================================================
const Anthropic = require('@anthropic-ai/sdk');
const { draftingGuidance } = require('../minutes/standards');

const PROMPT_VERSION = 'meeting-intel-v1';
const MODEL = () => process.env.MEETING_ANALYSIS_MODEL || 'claude-sonnet-5';

const hms = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60; return (h ? h + ':' + String(m).padStart(2, '0') : String(m)) + ':' + String(x).padStart(2, '0'); };

const REF = { type: 'array', items: { type: 'string' }, description: 'The transcript line ids that support this item, e.g. ["u12","u13"]. Required.' };
const QUOTE = { type: 'string', description: 'A short VERBATIM quote (max ~25 words) copied exactly from one of the cited lines.' };
const PERSON = (what) => ({ type: 'string', description: `${what}: the person's name, or "Speaker N" if not identified. Empty string "" if not stated.` });
const COUNT = (what) => ({ type: 'integer', description: `${what}. Use -1 if not stated or not countable from the recording.` });
const NAMES = { type: 'array', items: { type: 'string' } };
const obj = (required, properties, description) => ({ type: 'object', required, properties, ...(description ? { description } : {}) });
// Kept FLAT on purpose (one level of objects inside arrays): deeply nested
// objects made the model return some fields as text instead of structure.
const TOOL = {
  name: 'record_meeting_analysis',
  description: 'Record the structured analysis of the board meeting transcript.',
  input_schema: obj(
    ['short_summary', 'executive_summary', 'directors_present', 'others_present', 'quorum_stated', 'call_to_order', 'adjournment', 'motions', 'decisions', 'action_items', 'follow_ups', 'next_agenda_items', 'discussion_topics', 'speaker_suggestions', 'uncertainties'],
    {
      short_summary: { type: 'string', description: '2-3 plain sentences: what this meeting covered and decided.' },
      executive_summary: { type: 'string', description: 'A fuller OVERVIEW paragraph for board members who missed the meeting (nothing to do with the executive session).' },
      directors_present: { type: 'array', description: 'Board members shown present by the transcript (roll call, introductions, or speaking).', items: obj(['name', 'refs'], { name: { type: 'string' }, refs: REF }) },
      others_present: { type: 'array', items: obj(['name', 'role', 'affiliation', 'refs'], { name: { type: 'string' }, role: { type: 'string', enum: ['manager', 'vendor', 'homeowner', 'other'] }, affiliation: { type: 'string', description: 'Company, or "" if none/unknown.' }, refs: REF }) },
      quorum_stated: { type: 'boolean', description: 'true only if someone SAID a quorum is present.' },
      call_to_order: { type: 'array', maxItems: 1, description: 'The call to order (one entry, or empty if not on the recording).', items: obj(['time_stated', 'by', 'refs', 'quote'], { time_stated: { type: 'string', description: 'The time as spoken, e.g. "7:02 PM"; "" if not said.' }, by: PERSON('Who called it to order'), refs: REF, quote: QUOTE }) },
      adjournment: { type: 'array', maxItems: 1, description: 'The adjournment (one entry, or empty if not on the recording).', items: obj(['time_stated', 'refs', 'quote'], { time_stated: { type: 'string', description: '"" if not said.' }, refs: REF, quote: QUOTE }) },
      motions: { type: 'array', items: obj(['motion_text', 'mover', 'seconder', 'vote_method', 'yes', 'no', 'abstain', 'yes_names', 'no_names', 'abstain_names', 'result', 'refs', 'quote'], {
        motion_text: { type: 'string', description: 'The motion as made, close to the words used.' },
        mover: PERSON('Who made the motion'), seconder: PERSON('Who seconded it'),
        vote_method: { type: 'string', enum: ['voice', 'roll_call', 'show_of_hands', 'unanimous_consent', 'not_stated'] },
        yes: COUNT('Votes in favor'), no: COUNT('Votes opposed'), abstain: COUNT('Abstentions'),
        yes_names: NAMES, no_names: NAMES, abstain_names: NAMES,
        result: { type: 'string', enum: ['passed', 'failed', 'tabled', 'withdrawn', 'not_stated'] },
        refs: REF, quote: QUOTE }) },
      decisions: { type: 'array', description: 'Decisions or directions the board gave that were NOT formal motions. Do not repeat motions, action items or follow-ups here.', items: obj(['text', 'refs', 'quote'], { text: { type: 'string' }, refs: REF, quote: QUOTE }) },
      action_items: { type: 'array', items: obj(['task', 'responsible', 'due', 'refs', 'quote'], {
        task: { type: 'string' }, responsible: PERSON('Who will do it'), due: { type: 'string', description: 'Only if a deadline was actually said, in the words used (e.g. "by Friday"); otherwise "".' }, refs: REF, quote: QUOTE }) },
      follow_ups: { type: 'array', items: obj(['text', 'refs', 'quote'], { text: { type: 'string' }, refs: REF, quote: QUOTE }) },
      next_agenda_items: { type: 'array', items: obj(['text', 'refs'], { text: { type: 'string' }, refs: REF }) },
      discussion_topics: { type: 'array', items: obj(['topic', 'minutes_note', 'refs'], {
        topic: { type: 'string' }, minutes_note: { type: 'string', description: 'One or two neutral sentences suitable for formal minutes, following the house rules.' }, refs: REF }) },
      speaker_suggestions: { type: 'array', description: 'Who an unidentified speaker probably is, ONLY when the transcript shows it (they introduced themselves, or were addressed by name just before speaking).', items: obj(['speaker', 'name', 'role', 'refs', 'quote'], {
        speaker: { type: 'integer', description: 'The number shown, e.g. 3 for "Speaker 3".' }, name: { type: 'string' }, role: { type: 'string', enum: ['board_member', 'manager', 'vendor', 'homeowner', 'other'] }, refs: REF, quote: QUOTE }) },
      uncertainties: { type: 'array', items: obj(['note', 'refs'], { note: { type: 'string' }, refs: REF }) },
    }),
};

// Shape check before anything is trusted. Returns a list of problems ([] = ok).
function shapeProblems(o) {
  const p = [];
  if (!o || typeof o !== 'object') return ['output is not an object'];
  for (const k of ['short_summary', 'executive_summary']) if (typeof o[k] !== 'string') p.push(`${k} must be a string`);
  for (const k of TOOL.input_schema.required.filter((x) => TOOL.input_schema.properties[x].type === 'array')) {
    if (!Array.isArray(o[k])) { p.push(`${k} must be an array`); continue; }
    const req = TOOL.input_schema.properties[k].items.required;
    o[k].forEach((it, i) => {
      if (!it || typeof it !== 'object' || Array.isArray(it)) { p.push(`${k}[${i}] must be an object`); return; }
      for (const f of req) if (!(f in it)) p.push(`${k}[${i}].${f} is missing`);
      if ('refs' in it && !Array.isArray(it.refs)) p.push(`${k}[${i}].refs must be an array`);
    });
  }
  if (typeof o.quorum_stated !== 'boolean') p.push('quorum_stated must be true/false');
  return p;
}

// Convert the flat tool output into the shape the validator and minutes use
// ("" / -1 sentinels become null).
function fromTool(o) {
  const s = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const n = (v) => (Number.isInteger(v) && v >= 0 ? v : null);
  const cto = (o.call_to_order || [])[0] || null, adj = (o.adjournment || [])[0] || null;
  return {
    short_summary: o.short_summary, executive_summary: o.executive_summary,
    attendance: { directors_present: o.directors_present || [], others_present: (o.others_present || []).map((x) => ({ ...x, affiliation: s(x.affiliation) })), quorum_stated: !!o.quorum_stated,
      refs: [...new Set((o.directors_present || []).flatMap((d) => d.refs || []))] },
    call_to_order: cto ? { time_stated: s(cto.time_stated), by: s(cto.by), refs: cto.refs || [], quote: s(cto.quote) } : { time_stated: null, by: null, refs: [] },
    adjournment: adj ? { time_stated: s(adj.time_stated), refs: adj.refs || [], quote: s(adj.quote) } : { time_stated: null, refs: [] },
    motions: (o.motions || []).map((m) => ({ motion_text: m.motion_text, mover: s(m.mover), seconder: s(m.seconder),
      vote: { method: m.vote_method || 'not_stated', yes: n(m.yes), no: n(m.no), abstain: n(m.abstain), yes_names: m.yes_names || [], no_names: m.no_names || [], abstain_names: m.abstain_names || [] },
      result: m.result, refs: m.refs || [], quote: s(m.quote) })),
    decisions: o.decisions || [], follow_ups: o.follow_ups || [], next_agenda_items: o.next_agenda_items || [], discussion_topics: o.discussion_topics || [], uncertainties: o.uncertainties || [],
    action_items: (o.action_items || []).map((a) => ({ task: a.task, responsible: s(a.responsible), due: s(a.due), refs: a.refs || [], quote: s(a.quote) })),
    speaker_suggestions: o.speaker_suggestions || [],
  };
}

/**
 * Build the transcript text Paige reads.
 * lines: [{ idx, speaker, start_ms, meeting_start_ms, text, scope }]
 * labelOf(speaker) -> "Speaker 2" | "Tally Hawthorne (Treasurer, board member)"
 * gaps: [{ at_audio_ms, ms, reason }]; exec: [{ audio_from_ms, audio_to_ms }]
 */
function renderTranscript({ lines, labelOf, gaps = [], exec = [] }) {
  const out = [];
  const events = [
    ...gaps.map((g) => ({ at: g.at_audio_ms, text: `[--- RECORDING GAP: about ${Math.round(g.ms / 1000)} s not recorded (${String(g.reason).replace(/_/g, ' ')}). Nothing said during it is known. ---]` })),
    ...exec.map((r) => ({ at: r.audio_from_ms, text: `[--- EXECUTIVE SESSION (${hms(r.audio_from_ms)} to ${hms(r.audio_to_ms)}): content withheld. Do not guess at it; it must not appear in any output. ---]` })),
  ].sort((a, b) => a.at - b.at);
  let e = 0;
  for (const l of lines) {
    while (e < events.length && events[e].at <= l.start_ms) out.push(events[e++].text);
    if (l.scope === 'executive') continue;
    out.push(`[u${l.idx} | ${hms(l.start_ms)} | ${labelOf(l.speaker)}] ${l.text}`);
  }
  while (e < events.length) out.push(events[e++].text);
  // collapse repeated exec markers (one per range is enough)
  return out.filter((x, i) => !(x.startsWith('[--- EXECUTIVE') && out[i - 1] === x)).join('\n');
}

function buildPrompt({ meeting, communityName, roster, transcriptText, speakerList }) {
  return `You are Paige, Bedrock's board-operations specialist. You are reviewing the transcript of a homeowners association board meeting that was recorded as a drafting aid, to prepare a review package for staff.

MEETING
- Association: ${communityName}
- Meeting: ${meeting.title} (${meeting.meeting_type}), ${meeting.meeting_date}

CURRENT BOARD ROSTER (from Trusted)
${roster.length ? roster.map((r) => `- ${r.name}${r.position ? ` (${r.position})` : ''}`).join('\n') : '- (no roster on file)'}

SPEAKERS IN THIS TRANSCRIPT
${speakerList}
Speakers shown as "Speaker N" have not been identified by staff yet. You may use what is SAID (introductions, being addressed by name just before speaking) to tell who someone is; put those in speaker_suggestions with the supporting line. Never guess from voice or style.

ABSOLUTE RULES
1. Do not invent anything. If something was not said (a second, a vote count, a due date, a responsible person, a time), leave it null or "not_stated". An empty field is correct; a plausible guess is a failure.
2. Every item must cite the transcript line ids (refs) that support it, and the quote must be copied EXACTLY from one of those lines.
3. Vote counts: give numbers only if they were stated or can be counted from individual votes heard on the recording. "Hearing none, the motion passes" with no individual votes is method "voice" and counts null unless numbers were said.
4. Movers, seconders and responsible people: use the name if the transcript establishes who spoke (by the speaker label or an introduction); otherwise "Speaker N".
5. Executive session content is withheld from you on purpose. You may say that the board met in executive session and, if it was announced in OPEN session, its stated purpose. Never say anything about what was or was not discussed, decided, or voted on inside it (not even "no other matters were addressed").
6. Recording gaps: nothing said during a gap is known. If an item might be incomplete because of a gap, add an uncertainty.
7. discussion_topics.minutes_note must follow the house rules for minutes below.
8. "executive_summary" means an OVERVIEW summary for the board, not the executive session.

${draftingGuidance()}

TRANSCRIPT (open session; line id | time in recording | speaker)
${transcriptText}

Call record_meeting_analysis with the complete analysis.`;
}

async function runPaige({ meeting, communityName, roster, lines, labelOf, speakerList, gaps, exec, client, model = MODEL() }) {
  const anthropic = client || new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  if (!client && !process.env.ANTHROPIC_API_KEY) { const e = new Error('ANTHROPIC_API_KEY is not set on the server'); e.permanent = true; throw e; }
  const transcriptText = renderTranscript({ lines, labelOf, gaps, exec });
  const prompt = buildPrompt({ meeting, communityName, roster, transcriptText, speakerList });
  const messages = [{ role: 'user', content: prompt }];
  const usage = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    const r = await anthropic.messages.create({ model, max_tokens: 16000, tools: [TOOL], tool_choice: { type: 'tool', name: TOOL.name }, messages });
    usage.push(r.usage || null);
    if (r.stop_reason === 'max_tokens') throw new Error('Paige\'s analysis was cut off (output too long)');
    const use = (r.content || []).find((c) => c.type === 'tool_use' && c.name === TOOL.name);
    const problems = use ? shapeProblems(use.input) : ['no structured analysis returned'];
    if (!problems.length) return { output: fromTool(use.input), raw_tool_input: use.input, model: r.model || model, usage, attempts: attempt, prompt_chars: prompt.length, transcript_text: transcriptText };
    if (attempt === 2) throw new Error('Paige\'s analysis was malformed twice: ' + problems.slice(0, 5).join('; '));
    // One corrective retry, telling the model exactly what was wrong.
    messages.push({ role: 'assistant', content: r.content });
    messages.push({ role: 'user', content: [
      ...(use ? [{ type: 'tool_result', tool_use_id: use.id, is_error: true, content: 'Malformed: ' + problems.slice(0, 20).join('; ') }] : []),
      { type: 'text', text: 'The analysis was malformed. Call record_meeting_analysis again with every field as a proper JSON value (arrays as arrays, objects as objects).' },
    ] });
  }
}

module.exports = { runPaige, renderTranscript, buildPrompt, TOOL, PROMPT_VERSION, MODEL, hms, shapeProblems, fromTool };
