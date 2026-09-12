// scripts/gpt_live_probe.js — DIAGNOSTIC ONLY (Ed 2026-09-12)
// Opens a GPT-Live-1 live session and logs the real event flow so we build the
// provider against verified reality, not guessed shapes. Drives one text turn
// to see whether/how `session.delegation.created` fires and how to reply.
// Sends no audio; hard 30s timeout. Run: node -r dotenv/config scripts/gpt_live_probe.js
const OpenAI = require('openai');
const { LiveWS } = require('openai/resources/live/ws');

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL = process.env.GPT_LIVE_MODEL || 'gpt-live-1';

function log(tag, obj) {
  let s = '';
  try { s = typeof obj === 'string' ? obj : JSON.stringify(obj); } catch (_) { s = String(obj); }
  if (s && s.length > 600) s = s.slice(0, 600) + '…';
  console.log(`[${tag}]`, s || '');
}

(async () => {
  let ws;
  try { ws = new LiveWS(client); } catch (e) { console.error('CONSTRUCT FAIL:', e.message); process.exit(1); }
  console.log('LiveWS constructed; model=', MODEL);

  const done = (code) => { try { ws.close(); } catch (_) {} setTimeout(() => process.exit(code), 200); };
  const timer = setTimeout(() => { console.log('--- timeout, closing ---'); done(0); }, 10000);
  // Bind error so a server error surfaces as a log, not an unhandled crash.
  try { ws.on('error', (e) => log('WS-ERROR', (e && e.error) || e && e.message || e)); } catch (_) {}

  // Config the session as soon as the socket is open (send() queues while connecting).
  const startCfg = {
    type: 'session.start',
    session: {
      model: MODEL,
      instructions: "You are Claire, Bedrock's AI assistant. Delegate any substantive question to your application backend rather than answering yourself.",
      delegation: { type: 'client' },
    },
  };
  log('SEND', startCfg);
  try { ws.send(startCfg); } catch (e) { log('SEND-ERR', e.message); }

  // Client-delegation config accepted means the session is live. We do not drive
  // a turn here (that needs caller audio); real turns arrive as audio, the model
  // emits session.delegation.created, and we reply with session.commentary.append.
  try {
    for await (const ev of ws) {
      const t = ev && ev.type ? ev.type : '(no-type)';
      log('EVENT ' + t, ev);
      if (t === 'session.started') log('>>> SESSION LIVE — client-delegation config accepted');
      if (t === 'session.delegation.created') log('>>> DELEGATION', ev);
      if (t === 'session.closed' || t === 'close') { clearTimeout(timer); return done(0); }
    }
  } catch (e) {
    console.error('ITER FAIL:', e.message);
  }
  clearTimeout(timer); done(0);
})();
