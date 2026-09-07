// ============================================================================
// lib/newsletters/resident_qa.js  (Ed 2026-09-07)
// ----------------------------------------------------------------------------
// "You Asked, We Answered" — Phoebe reads the month's resident inbox and surfaces
// the 3 most common GENERAL questions with warm answers. Real questions residents
// actually asked, generalized so no one's private matter is ever exposed. One of
// the most-read sections in a good HOA newsletter, and only we can produce it,
// because we hold the inbox. (Validated by outside review.)
//
// Guardrail: community-LEVEL only. Never a name, address, complaint, dispute, or
// private matter — turn one resident's specific into the general question many
// neighbors share. No legal conclusions; point specifics back to the team.
// ============================================================================

const Anthropic = require('@anthropic-ai/sdk');
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function gatherResidentQA(supabase, communityId) {
  const since = new Date(Date.now() - 40 * 864e5).toISOString();
  let rows = [];
  try {
    const { data, error } = await supabase.from('email_messages')
      .select('subject, ai_summary, classification')
      .eq('community_id', communityId).eq('direction', 'inbound')
      .gte('created_at', since).limit(80);
    if (error) throw error;
    rows = data || [];
  } catch (e) { console.warn('[resident_qa] fetch:', e.message); return []; }
  if (rows.length < 4) return []; // not enough signal to claim "residents asked"

  // Summaries + subjects only — never raw private bodies.
  const lines = rows.map((r) => `- [${r.classification || 'general'}] ${(r.subject || '').slice(0, 90)} — ${(r.ai_summary || '').slice(0, 120)}`).join('\n');
  const sys = `You are Phoebe Hart, Bedrock's community engagement coordinator, writing a warm "You Asked, We Answered" section for a community newsletter.
From the month's resident inbox (summaries only), identify the 3 MOST COMMON general questions neighbors had this month, and write a short, warm, helpful answer to each.
Rules: GENERAL and community-LEVEL only — NEVER name or reference an individual, an address, a complaint, a dispute, or any private matter. Turn one person's specific into the general question many neighbors share. No legal conclusions; for anything specific, warmly point them to the team (info@bedrocktx.com). Answers 2-3 sentences, friendly and plain. Return STRICT JSON.`;
  const user = `This month's inbox (summaries only):\n${lines}\n\nReturn JSON: { "qa": [ { "q": "a common resident question (<=14 words, ends with ?)", "a": "a warm, helpful answer (2-3 sentences)" } ] } — up to 3 items, fewer if there isn't clear signal.`;
  try {
    const resp = await anthropic.messages.create({
      model: 'claude-sonnet-4-5', max_tokens: 900, system: sys,
      tools: [{
        name: 'resident_qa', description: 'Top general resident questions + warm answers.',
        input_schema: { type: 'object', properties: { qa: { type: 'array', items: { type: 'object', properties: { q: { type: 'string' }, a: { type: 'string' } }, required: ['q', 'a'] } } }, required: ['qa'] },
      }],
      tool_choice: { type: 'tool', name: 'resident_qa' },
      messages: [{ role: 'user', content: user }],
    });
    const tu = (resp.content || []).find((c) => c.type === 'tool_use');
    return ((tu && tu.input && tu.input.qa) || []).filter((x) => x && x.q && x.a).slice(0, 3);
  } catch (e) { console.warn('[resident_qa] AI:', e.message); return []; }
}

module.exports = { gatherResidentQA };
