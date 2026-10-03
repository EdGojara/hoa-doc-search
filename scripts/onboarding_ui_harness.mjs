// scripts/onboarding_ui_harness.mjs  (Issue #15 Milestone 2)
// Local, self-contained harness for the Onboarding Engine page: serves the real
// public/onboarding.html and the real api/onboarding router + service, backed by
// an IN-MEMORY Postgres (PGlite) running the real 452/481/482 migrations, with
// the synthetic "Example Creek" fixture. Auth is stubbed: ?as=admin in the page
// URL (cookie) makes you a non-owner admin; default is the owner.
// Touches no real database. Run: node scripts/onboarding_ui_harness.mjs [port]
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const express = require('express');
const { PGlite } = await import('@electric-sql/pglite');
const { onboardingWorld, COMM } = await import('../tests/sql/onboarding_world.mjs');
const { buildRouter } = require('../api/onboarding.js');
const { createOnboardingService } = require('../lib/onboarding/service.js');

const world = await onboardingWorld(PGlite, { through: 482 });
const mem = new Map();
const storage = { async putOnce(p, b) { if (!mem.has(p)) mem.set(p, Buffer.from(b)); }, async get(p) { return Buffer.from(mem.get(p)); } };
const service = createOnboardingService({ rpc: world.rpc, storage });
const OWNER_EMAIL = 'owner@example.test';
const who = (req) => (/as=admin/.test(req.headers.cookie || '') ? { user: { id: 'staffer' }, email: 'staff@example.test', role: 'admin' } : { user: { id: 'ed' }, email: OWNER_EMAIL, role: 'admin' });
const auth = { OWNER_EMAIL, async requireAdmin(req) { return who(req); }, async requireOwner(req, res) { const u = who(req); if (u.email !== OWNER_EMAIL) { res.status(403).json({ error: 'owner_only' }); return null; } return u; } };

// Seed: one batch through normalize, in source controls with a FAIL (deliberately wrong authoritative cash).
const OWNER = { kind: 'human', id: 'ed', role: 'owner' };
const FX = path.join(REPO, 'tests', 'fixtures', 'onboarding', 'synthetic-vantaca');
const B = await service.createBatch(OWNER, { community_id: COMM, batch_code: 'CONV-EX-20260331', as_of_date: '2026-03-31', source_system: 'vantaca' });
for (const t of ['gl_trial_balance', 'balance_sheet', 'ar_aging', 'homeowner_transactions']) await service.registerArtifact(OWNER, B, { buffer: fs.readFileSync(path.join(FX, `${t}.txt`)), filename: `${t}.txt`, artifact_type: t });
let r = await service.runStage(OWNER, B); await service.advance(OWNER, B, { completion_id: r.completion_id, to: 'normalize' });
r = await service.runStage(OWNER, B); await service.advance(OWNER, B, { completion_id: r.completion_id, to: 'source_controls' });
await service.runStage(OWNER, B, { roles: { ar_account: '1300', prepaid_account: '2400' }, authoritative: { ar: { label: 'AR = 510.00', cents: 51000, derive: { kind: 'gl_ending', account: '1300' } }, cash: { label: 'Cash = 1,400.00 (deliberately wrong)', cents: 140000, derive: { kind: 'gl_ending', account: '1000' } } } });

const app = express();
app.get('/api/auth/config', (req, res) => res.json({ enabled: false }));
app.use('/api/onboarding', buildRouter({ service, auth, listCommunities: async () => [{ id: COMM, name: 'Example Creek' }] }));
app.get('/admin/onboarding', (req, res) => { if (req.query.as) res.setHeader('Set-Cookie', `as=${req.query.as}; Path=/`); res.sendFile(path.join(REPO, 'public', 'onboarding.html')); });
const port = Number(process.argv[2] || process.env.PORT || 5175);
app.listen(port, () => console.log(`onboarding UI harness on http://localhost:${port}/admin/onboarding (batch ${B})`));
