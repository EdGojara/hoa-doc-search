// scripts/media_studio_ui_harness.js  (Issue #10 Media Studio V1)
// Local, self-contained harness for the Media Studio page: serves the real
// public/media-studio.html and the real api/media_studio router + lib/media,
// with auth stubbed to the owner, SYNTHETIC cast canon (no registry read), a
// temp project store, and a canned Amanda draft (no model call). Touches no
// database, no model and no renderer. Run: node scripts/media_studio_ui_harness.js [port]
const path = require('path');
const os = require('os');
const fs = require('fs');
const express = require('express');

process.env.MEDIA_STUDIO_DIR = process.env.MEDIA_STUDIO_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'media-studio-ui-'));
const { buildRouter } = require('../api/media_studio');

const pin = (c) => c.repeat(64);
const canon = async (slug) => (slug === 'amanda_albright'
  ? { ok: true, slug, pins: { face: { version: 3, spec_sha256: pin('a') }, body: { version: 1, spec_sha256: pin('b') }, wardrobe: { version: 1, spec_sha256: pin('d') }, guardrails: { version: 1, spec_sha256: pin('e') } }, face_sha256: pin('c'), voice_approved: false }
  : { ok: false, slug, reason: `${slug}: no approved visual canon (synthetic harness)` });
const auth = { async requireOwner() { return { user: { id: 'owner' }, email: 'owner@example.test', role: 'admin' }; } };
// Canned Amanda draft: rewrites the creative text only (the real path goes through the same validator).
const anthropic = { messages: { create: async ({ messages }) => {
  const shots = JSON.parse(messages[0].content.split('do not add or remove shots):\n')[1].split('\n\nReturn JSON')[0]);
  const out = { logline: 'Calm, confident and ready: what every lifeguard on our pools should know.', objective: 'Every lifeguard leaves knowing the procedure and where it lives.', tone: 'Calm, clear, respectful of the viewer\'s time.',
    shots: shots.map((s) => ({ shot_key: s.shot_key, title: s.title, intent: s.intent, action: s.action, dialogue: s.speaks ? `${s.dialogue}` : null })) };
  return { content: [{ type: 'text', text: JSON.stringify(out) }] };
} } };

const app = express();
app.use('/api/media-studio', buildRouter({ auth, canon, anthropic }));
app.get('/api/auth/config', (req, res) => res.json({ enabled: false }));
app.get(['/', '/admin/media-studio'], (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'media-studio.html')));
const port = Number(process.argv[2]) || 5176;
app.listen(port, () => console.log(`Media Studio harness on http://localhost:${port}/admin/media-studio (store: ${process.env.MEDIA_STUDIO_DIR})`));
