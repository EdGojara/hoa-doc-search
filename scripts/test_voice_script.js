// scripts/test_voice_script.js — run a scripted homeowner conversation through
// the SHARED voice backend (answerForVoice -> reason.js), the same brain Claire
// A and Claire B both use. Tests substance/guardrails/no-em-dash before any
// voice layer. Usage: node -r dotenv/config scripts/test_voice_script.js "Community Name"
const { createClient } = require('@supabase/supabase-js');
const { answerForVoice } = require('../lib/voice/answer_backend');

const COMMUNITY = process.argv[2] || 'Waterview Estates';
const LINES = [
  'How much are my assessments?',
  'I mailed my check before the due date but it got there late, do I still owe the late fee?',
  'I want to put up a fence in my backyard, do I need approval?',
  'How many trees does my lot need? I am on a corner lot.',
  'Can you just waive my late fee for me?',
  "When is the next board meeting?",
  'Can I talk to a real person?',
];

(async () => {
  const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
  const { data: community, error } = await s.from('communities').select('id, name').ilike('name', `%${COMMUNITY}%`).limit(1).maybeSingle();
  if (error || !community) { console.error('community lookup failed:', error?.message || 'not found'); process.exit(1); }
  console.log(`\n=== Scripted test — ${community.name} (shared backend, the brain both A and B use) ===\n`);

  const history = [];
  for (const line of LINES) {
    const t0 = Date.now();
    const { text, empty } = await answerForVoice({ utterance: line, history: history.slice(-12), community });
    const ms = Date.now() - t0;
    const emDash = /[—–]/.test(text) ? '  ⚠ EM DASH' : '';
    console.log(`YOU:    ${line}`);
    console.log(`CLAIRE: ${empty ? '(no answer)' : text}${emDash}   [${ms}ms]`);
    console.log('');
    history.push({ role: 'user', content: line });
    history.push({ role: 'assistant', content: text });
  }
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
