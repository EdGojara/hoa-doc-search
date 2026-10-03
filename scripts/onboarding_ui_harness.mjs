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

const world = await onboardingWorld(PGlite, { through: 485 });
const mem = new Map();
const storage = { async putOnce(p, b) { if (!mem.has(p)) mem.set(p, Buffer.from(b)); }, async get(p) { return Buffer.from(mem.get(p)); } };
// Synthetic Trusted activity for the bridge view (no client data).
const tje = (id, d, mod, amt, extra = {}) => ({ id, posting_date: d, source_module: mod, status: 'posted', total_debits_cents: amt, total_credits_cents: amt, description: '', ...extra });
const trusted = { journal_entries: [tje('t-legacy', '2026-02-01', 'vantaca_import', 61000), tje('t-inv-src', '2026-04-05', 'ap_invoice', 15000, { description: 'AP invoice EX-0001 — Example Landscaping LLC' }),
  tje('t-inv-new', '2026-08-25', 'ap_invoice', 55000, { description: 'AP invoice 2608EX — Manager' }), tje('t-ach', '2026-03-05', 'payment_intake', 15000, { description: 'AP payment ach' }),
  tje('t-void', '2026-08-14', 'payment_intake', 47630, { status: 'voided', void_reversal_je_id: 't-rev', description: 'AP payment check #29' }), tje('t-rev', '2026-09-04', 'reversal', 47630, { reverses_je_id: 't-void' }),
  tje('t-bad', '2026-09-11', 'ap_invoice', 84204, { description: 'AP invoice 321 — Utility' })],
  journal_entry_lines: [{ id: 'l1', journal_entry_id: 't-inv-new', account_id: 'x5810', debit_cents: 55000, credit_cents: 0 }, { id: 'l2', journal_entry_id: 't-inv-new', account_id: 'x2000', debit_cents: 0, credit_cents: 55000 }, { id: 'l3', journal_entry_id: 't-bad', account_id: 'x5105', debit_cents: 84204, credit_cents: 0 }, { id: 'l4', journal_entry_id: 't-bad', account_id: 'x2000', debit_cents: 0, credit_cents: 84204 }],
  ap_invoices: [{ id: 'i-src', vendor_invoice_number: 'EX-0001', invoice_date: '2026-04-05', total_cents: 15000, posting_journal_entry_id: 't-inv-src' }, { id: 'i-new', vendor_invoice_number: '2608EX', invoice_date: '2026-08-25', total_cents: 55000, posting_journal_entry_id: 't-inv-new' }, { id: 'i-bad', vendor_invoice_number: '321', invoice_date: '2026-09-11', total_cents: 41960, posting_journal_entry_id: 't-bad' }],
  ap_payments: [], ar_charges: [], ar_payments: [], payments: [{ id: 't-pay', amount_cents: 100, status: 'pending', livemode: null, journal_entry_id: null, created_at: '2026-03-20T00:00:00Z' }], homeowner_transactions: [] };
const trustedReader = async () => ({ trusted: JSON.parse(JSON.stringify(trusted)), accountNumber: (id) => String(id).replace('x', ''), accountOfProperty: () => null });
const service = createOnboardingService({ rpc: world.rpc, storage, trustedReader });
const OWNER_EMAIL = 'owner@example.test';
const who = (req) => (/as=admin/.test(req.headers.cookie || '') ? { user: { id: 'staffer' }, email: 'staff@example.test', role: 'admin' } : { user: { id: 'ed' }, email: OWNER_EMAIL, role: 'admin' });
const auth = { OWNER_EMAIL, async requireAdmin(req) { return who(req); }, async requireOwner(req, res) { const u = who(req); if (u.email !== OWNER_EMAIL) { res.status(403).json({ error: 'owner_only' }); return null; } return u; } };

// Seed: one batch through normalize, in source controls with a FAIL (deliberately wrong authoritative cash).
const OWNER = { kind: 'human', id: 'ed', role: 'owner' };
const FX = path.join(REPO, 'tests', 'fixtures', 'onboarding', 'synthetic-vantaca');
const B = await service.createBatch(OWNER, { community_id: COMM, batch_code: 'CONV-EX-20260331', as_of_date: '2026-03-31', source_system: 'vantaca' });
for (const t of ['gl_trial_balance', 'balance_sheet', 'ar_aging', 'homeowner_transactions', 'prepaid_homeowners']) await service.registerArtifact(OWNER, B, { buffer: fs.readFileSync(path.join(FX, `${t}.txt`)), filename: `${t}.txt`, artifact_type: t });
let r = await service.runStage(OWNER, B); await service.advance(OWNER, B, { completion_id: r.completion_id, to: 'normalize' });
r = await service.runStage(OWNER, B); await service.advance(OWNER, B, { completion_id: r.completion_id, to: 'source_controls' });
await service.runStage(OWNER, B, { roles: { ar_account: '1300', prepaid_account: '2400' }, authoritative: { ar: { label: 'AR = 510.00', cents: 51000, derive: { kind: 'gl_ending', account: '1300' } }, cash: { label: 'Cash = 1,400.00 (deliberately wrong)', cents: 140000, derive: { kind: 'gl_ending', account: '1000' } } } });

// Second batch walked to the snapshot stage (synthetic data; the waiver here is test-fixture only).
const B2 = await service.createBatch(OWNER, { community_id: COMM, batch_code: 'CONV-EX-SNAPSHOT', as_of_date: '2026-03-31', source_system: 'vantaca' });
for (const t of ['gl_trial_balance', 'balance_sheet', 'ar_aging', 'homeowner_transactions', 'prepaid_homeowners']) await service.registerArtifact(OWNER, B2, { buffer: fs.readFileSync(path.join(FX, `${t}.txt`)), filename: `${t}.txt`, artifact_type: t });
r = await service.runStage(OWNER, B2); await service.advance(OWNER, B2, { completion_id: r.completion_id, to: 'normalize' });
r = await service.runStage(OWNER, B2); await service.advance(OWNER, B2, { completion_id: r.completion_id, to: 'source_controls' });
r = await service.runStage(OWNER, B2, { roles: { ar_account: '1300', prepaid_account: '2400' } }); await service.advance(OWNER, B2, { completion_id: r.completion_id, to: 'snapshot' });
r = await service.runStage(OWNER, B2, { ap_account: '2400' });
await service.waive(OWNER, B2, { completion_id: r.completion_id, code: 'snapshot.ap_detail_supports_gl', reason: 'harness fixture: synthetic AP gap' });
await service.advance(OWNER, B2, { completion_id: r.completion_id, to: 'activity_bridge' });
await service.runStage(OWNER, B2);

const app = express();
app.use('/js', express.static(path.join(REPO, 'public', 'js')));
app.get('/api/auth/config', (req, res) => res.json({ enabled: false }));
app.use('/api/onboarding', buildRouter({ service, auth, listCommunities: async () => [{ id: COMM, name: 'Example Creek' }] }));
app.get('/admin/onboarding', (req, res) => { if (req.query.as) res.setHeader('Set-Cookie', `as=${req.query.as}; Path=/`); res.sendFile(path.join(REPO, 'public', 'onboarding.html')); });
const port = Number(process.argv[2] || process.env.PORT || 5175);
app.listen(port, () => console.log(`onboarding UI harness on http://localhost:${port}/admin/onboarding (batch ${B})`));
