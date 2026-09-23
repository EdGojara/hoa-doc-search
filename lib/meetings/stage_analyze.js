// ============================================================================
// lib/meetings/stage_analyze.js  (Ed 2026-09-23)
// ----------------------------------------------------------------------------
// Pipeline stage 3: Paige analyzes the current transcript's OPEN-session lines
// (lib/meetings/paige_meeting.js), then code checks every item
// (lib/meetings/intel_validate.js). Saved as a new current meeting_analyses
// row. Also used directly for "Re-analyze with speaker names" after staff map
// speakers (no re-transcription).
// ============================================================================
const { fetchAll } = require('../db/fetch_all');
const { runPaige, PROMPT_VERSION, fromTool } = require('./paige_meeting');
const { validateAnalysis } = require('./intel_validate');
const { boardRoster, speakerMappings, ROLE_LABEL } = require('./roster');
const { PermanentError } = require('./pipeline');

async function loadContext(supabase, sessionId) {
  const { data: t, error } = await supabase.from('meeting_transcripts').select('*').eq('session_id', sessionId).eq('is_current', true).maybeSingle();
  if (error) throw error;
  if (!t) throw new PermanentError('there is no transcript yet; retry from "Transcribing"');
  const [segments, mappings, roster] = await Promise.all([
    fetchAll(supabase, 'meeting_transcript_segments', { select: 'idx, speaker, start_ms, end_ms, meeting_start_ms, meeting_end_ms, text, confidence, scope', filters: { transcript_id: t.id }, orderBy: 'idx' }),
    speakerMappings(supabase, t.id), boardRoster(supabase, t.community_id),
  ]);
  const { data: a, error: aErr } = await supabase.from('meeting_audio_assemblies').select('gaps, exec_ranges').eq('session_id', sessionId).single();
  if (aErr) throw aErr;
  const { data: m, error: mErr } = await supabase.from('meetings').select('id, title, meeting_type, meeting_date, location, community_id, meeting_minutes_id').eq('id', t.meeting_id).single();
  if (mErr) throw mErr;
  const { data: c } = await supabase.from('communities').select('name, management_company_id').eq('id', t.community_id).maybeSingle();
  const { data: s } = await supabase.from('meeting_recording_sessions').select('client_started_at').eq('id', sessionId).single();
  return { transcript: t, segments, mappings, roster, gaps: a.gaps || [], exec: a.exec_ranges || [], meeting: m, community: c || {}, sessionStartedAt: s.client_started_at };
}

function speakerDescriptions(ctx) {
  const rosterById = new Map(ctx.roster.map((r) => [r.id, r]));
  const nums = [...new Set(ctx.segments.filter((s) => s.scope === 'open').map((s) => s.speaker))].filter((x) => x != null).sort((a, b) => a - b);
  const labelOf = (spk) => {
    const m = ctx.mappings.find((x) => x.speaker === spk);
    if (!m) return `Speaker ${spk + 1}`;
    if (m.role === 'board_member') { const b = rosterById.get(m.board_member_id); if (b) return `${b.name} (${b.position ? b.position + ', ' : ''}board member)`; }
    return `${m.display_name ? m.display_name + ' ' : ''}(${ROLE_LABEL[m.role]})`;
  };
  const list = nums.map((n) => `- ${labelOf(n)}${ctx.mappings.some((x) => x.speaker === n) ? ' [identified by staff]' : ''}`).join('\n') || '- (none)';
  return { labelOf, list };
}

async function analyzeSession({ supabase, sessionId, userId = null, run = runPaige }) {
  const ctx = await loadContext(supabase, sessionId);
  const open = ctx.segments.filter((s) => s.scope === 'open');
  if (!open.length) throw new PermanentError('the transcript has no open-session speech to analyze');
  const { labelOf, list } = speakerDescriptions(ctx);
  const p = await run({
    meeting: ctx.meeting, communityName: ctx.community.name || 'the Association', roster: ctx.roster,
    lines: ctx.segments, labelOf, speakerList: list, gaps: ctx.gaps, exec: ctx.exec,
  });
  const checked = validateAnalysis({ analysis: p.output, segments: ctx.segments, mappings: ctx.mappings, roster: ctx.roster, gaps: ctx.gaps, execRanges: ctx.exec });
  const { error: oldErr } = await supabase.from('meeting_analyses').update({ is_current: false }).eq('session_id', sessionId).eq('is_current', true);
  if (oldErr) throw oldErr;
  const { data: row, error } = await supabase.from('meeting_analyses').insert({
    session_id: sessionId, transcript_id: ctx.transcript.id, meeting_id: ctx.meeting.id, community_id: ctx.transcript.community_id, is_current: true, status: 'ready',
    model: p.model, prompt_version: PROMPT_VERSION, raw_output: p.raw_tool_input, checked, needs_review_count: checked.counts.needs_review, withheld_count: checked.counts.withheld,
    speaker_snapshot: ctx.mappings.map((m) => ({ speaker: m.speaker, role: m.role, board_member_id: m.board_member_id, display_name: m.display_name })),
    usage: p.usage, requested_by_user_id: userId, record_ownership: 'workpaper',
  }).select('id').single();
  if (error) throw error;
  return { analysis_id: row.id, model: p.model, motions: checked.motions.length, action_items: checked.action_items.length, needs_review: checked.counts.needs_review, withheld: checked.counts.withheld };
}

/** Re-check a stored analysis against the CURRENT speaker mappings (no model call). */
function recheck(analysisRow, ctx) {
  return validateAnalysis({ analysis: fromTool(analysisRow.raw_output), segments: ctx.segments, mappings: ctx.mappings, roster: ctx.roster, gaps: ctx.gaps, execRanges: ctx.exec });
}
const snapshotKey = (list) => JSON.stringify((list || []).map((m) => [m.speaker, m.role, m.board_member_id || null, m.display_name || null]).sort((a, b) => a[0] - b[0]));
const mappingsChanged = (analysisRow, ctx) => snapshotKey(analysisRow.speaker_snapshot) !== snapshotKey(ctx.mappings);

async function analyzeStage({ job, supabase }) {
  return analyzeSession({ supabase, sessionId: job.session_id, userId: job.requested_by_user_id });
}

module.exports = { analyzeStage, analyzeSession, loadContext, recheck, mappingsChanged };
