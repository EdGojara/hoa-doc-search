// ============================================================================
// api/working_forecast.js  (Ed 2026-10-10, Financial Intelligence slice 1)
// ----------------------------------------------------------------------------
// The next-year WORKING FORECAST (management forecast, not the board budget).
// The model is computed deterministically on every read (lib/forecast/working_forecast.js);
// only human decisions are stored (migration 506). Staff-scoped (staff cookie via server.js);
// writes are admin-only and always recompute the model server-side, so the recorded
// model recommendation never comes from the browser.
//
//   GET  /:cid?year=2027&as_of=2026-09-30           model + per-line decision history
//   POST /:cid/adjustments   { year, as_of, account_id, fund_id, driver, amount_cents, assumption, evidence?, confidence, source? }
//   POST /:cid/overrides     { year, as_of, account_id, fund_id, override_cents|null, reason }
//   POST /:cid/policy        { year, expense_inflation_pct, reason }
//   POST /:cid/contracts                 multipart: file, account_id, fund_id?   attach an executed-contract document
//                                        (extract -> machine execution triage -> vendor_contracts; never verified)
//   POST /:cid/contracts/:id/verify      { file_hash, basis }   a named person verifies execution of that exact document
//   POST /:cid/contracts/:id/bind        { account_id, fund_id? }   the one GL line the contract drives
// ============================================================================
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { safeErrorMessage } = require('./_safe_error');
const { loadWorkingForecastInput } = require('../lib/forecast/working_forecast_data');
const { buildWorkingForecast, checkAdjustment, DRIVERS } = require('../lib/forecast/working_forecast');

const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });
const intake = require('../lib/contracts/intake');
const router = express.Router();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const fail = (res, where, err) => {
  if (err && err.code === 'invalid_input') return res.status(400).json({ error: err.message });
  if (err && err.code === 'not_found') return res.status(404).json({ error: err.message });
  console.error(`[working_forecast] ${where} failed:`, err && err.message);
  return res.status(500).json({ error: safeErrorMessage(err) });
};
const params = (q) => {
  const year = Number(q.year || 2027);
  const as_of = ISO.test(String(q.as_of || '')) ? String(q.as_of) : `${year - 1}-09-30`;
  if (!Number.isInteger(year) || year < 2020 || year > 2100) throw Object.assign(new Error('year_invalid'), { code: 'invalid_input' });
  return { year, as_of };
};

async function build(cid, q) {
  const { year, as_of } = params(q);
  const input = await loadWorkingForecastInput(supabase, { community_id: cid, target_year: year, as_of });
  const model = buildWorkingForecast(input);
  // Decision history per line (append-only records; the model shows only the latest).
  const k = (a, f) => `${a}|${f || ''}`;
  const adjBy = new Map(); for (const a of input.adjustments) { const x = k(a.account_id, a.fund_id); if (!adjBy.has(x)) adjBy.set(x, []); adjBy.get(x).push(a); }
  const ovrBy = new Map(); for (const o of input.overrides) { const x = k(o.account_id, o.fund_id); if (!ovrBy.has(x)) ovrBy.set(x, []); ovrBy.get(x).push(o); }
  for (const l of model.lines) l.history = { adjustments: adjBy.get(k(l.account_id, l.fund_id)) || [], overrides: ovrBy.get(k(l.account_id, l.fund_id)) || [] };
  model.persistence = input.persistence;
  model.contract_evidence = input.contract_evidence;
  model.base_budget = input.base_budget;
  return { model, input };
}

router.get('/:cid', async (req, res) => {
  try {
    const { canRenderFinancials } = require('../lib/community/lifecycle');
    const ok = await canRenderFinancials(req.params.cid);
    if (!ok.allowed) return res.status(409).json({ error: 'books_not_here', detail: ok.reason });
    const { model } = await build(req.params.cid, req.query);
    res.json(model);
  } catch (err) { fail(res, 'get', err); }
});

async function admin(req, res) { const { requireAdmin } = require('./_require_admin'); return requireAdmin(req, res); }
const notPersisted = (res) => res.status(409).json({ error: 'persistence_not_available', message: 'Saving forecast decisions needs migration 506 (pending review). The model is shown read-only until then.' });

async function ensureForecast(cid, input, actor) {
  if (input.persistence.forecast_id) return input.persistence.forecast_id;
  if (!input.base_budget) throw Object.assign(new Error('no_approved_base_year_budget'), { code: 'invalid_input' });
  const { data, error } = await supabase.from('working_forecasts').insert({ community_id: cid, fiscal_year: input.target_year, base_fiscal_year: input.base_year, base_budget_id: input.base_budget.id, created_by: actor, policy: {} }).select('id').single();
  if (error) throw error;
  return data.id;
}
function lineOf(model, account_id, fund_id) {
  return model.lines.find((l) => l.account_id === account_id && (l.fund_id || null) === (fund_id || null)) || model.lines.find((l) => l.account_id === account_id);
}

router.post('/:cid/adjustments', async (req, res) => {
  try {
    const u = await admin(req, res); if (!u) return;
    const b = req.body || {};
    const pre = checkAdjustment({ driver: b.driver, amount_cents: b.amount_cents });
    if (pre) return res.status(400).json({ ...pre, allowed: DRIVERS });
    const amount = Number(b.amount_cents);
    if (String(b.assumption || '').trim().length < 10) return res.status(400).json({ error: 'assumption_required', message: 'Write the assumption (10+ characters).' });
    if (!['high', 'medium', 'low'].includes(b.confidence)) return res.status(400).json({ error: 'confidence_invalid' });
    const { model, input } = await build(req.params.cid, b);
    if (!input.persistence.available) return notPersisted(res);
    const line = lineOf(model, b.account_id, b.fund_id);
    if (!line) return res.status(404).json({ error: 'line_not_found' });
    const isNorm = b.driver === 'one_time' || b.driver === 'omitted_recurring';
    const vs = checkAdjustment({ driver: b.driver, amount_cents: amount, base_cents: line.base.cents });   // sign + removal-exceeds-base (signs also enforced by 506)
    if (vs) return res.status(400).json(vs);
    const fid = await ensureForecast(req.params.cid, input, u.email);
    // A normalization records the base (server-computed) and as-of it was made against, so a
    // later change in the books is detected instead of removing the same cost twice.
    const { error } = await supabase.from('working_forecast_adjustments').insert({ forecast_id: fid, community_id: req.params.cid, account_id: line.account_id, fund_id: line.fund_id,
      driver: b.driver, amount_cents: amount, assumption: String(b.assumption).trim(), evidence: b.evidence || null, confidence: b.confidence, source: ['management', 'board', 'contract'].includes(b.source) ? b.source : 'management', actor: u.email,
      base_cents: isNorm ? line.base.cents : null, base_as_of: isNorm ? input.as_of : null });
    if (error) throw error;
    const after = await build(req.params.cid, b);
    res.json({ ok: true, line: lineOf(after.model, line.account_id, line.fund_id), summary: after.model.summary });
  } catch (err) { fail(res, 'adjustments', err); }
});

router.post('/:cid/overrides', async (req, res) => {
  try {
    const u = await admin(req, res); if (!u) return;
    const b = req.body || {};
    const value = b.override_cents === null || b.override_cents === '' || b.override_cents === undefined ? null : Number(b.override_cents);
    if (value !== null && !Number.isInteger(value)) return res.status(400).json({ error: 'override_cents_must_be_an_integer_or_null' });
    if (String(b.reason || '').trim().length < 10) return res.status(400).json({ error: 'reason_required', message: 'Write the reason (10+ characters).' });
    const { model, input } = await build(req.params.cid, b);
    if (!input.persistence.available) return notPersisted(res);
    const line = lineOf(model, b.account_id, b.fund_id);
    if (!line) return res.status(404).json({ error: 'line_not_found' });
    const fid = await ensureForecast(req.params.cid, input, u.email);
    const { error } = await supabase.from('working_forecast_overrides').insert({ forecast_id: fid, community_id: req.params.cid, account_id: line.account_id, fund_id: line.fund_id,
      model_recommendation_cents: line.recommendation_cents, model_sha256: model.model_sha256, override_cents: value, reason: String(b.reason).trim(), actor: u.email });
    if (error) throw error;
    const after = await build(req.params.cid, b);
    res.json({ ok: true, line: lineOf(after.model, line.account_id, line.fund_id), summary: after.model.summary });
  } catch (err) { fail(res, 'overrides', err); }
});

router.post('/:cid/policy', async (req, res) => {
  try {
    const u = await admin(req, res); if (!u) return;
    const b = req.body || {};
    const pct = Number(b.expense_inflation_pct);
    if (!Number.isFinite(pct) || pct < -10 || pct > 25) return res.status(400).json({ error: 'expense_inflation_pct_invalid' });
    if (String(b.reason || '').trim().length < 10) return res.status(400).json({ error: 'reason_required', message: 'Write the reason / source for the rate (10+ characters).' });
    const { input } = await build(req.params.cid, b);
    if (!input.persistence.available) return notPersisted(res);
    const fid = await ensureForecast(req.params.cid, input, u.email);
    const policy = { expense_inflation_pct: pct, inflation_source: `${String(b.reason).trim()} (set by ${u.email})`, inflation_confidence: 'medium' };
    const { error } = await supabase.from('working_forecasts').update({ policy, updated_by: u.email }).eq('id', fid);
    if (error) throw error;
    res.json({ ok: true, policy });
  } catch (err) { fail(res, 'policy', err); }
});

// ---------------------------------------------------------------- executed-contract evidence
const contractsNotReady = (res) => res.status(409).json({ error: 'persistence_not_available', message: 'Contract evidence needs migration 506 (pending review).' });
async function contractOf(cid, id) {
  const { data, error } = await supabase.from('vendor_contracts').select('id, community_id, file_hash, execution_status, document_version').eq('id', id).maybeSingle();
  if (error) { if (/does not exist|schema cache/i.test(error.message || '')) return { notReady: true }; throw error; }
  if (!data || data.community_id !== cid) return null;
  return data;
}
async function accountOk(cid, account_id) {
  const { data, error } = await supabase.from('chart_of_accounts').select('id, community_id, account_type').eq('id', account_id).maybeSingle();
  if (error) throw error;
  return data && data.community_id === cid && ['revenue', 'expense'].includes(data.account_type);
}

router.post('/:cid/contracts', upload.single('file'), async (req, res) => {
  try {
    const u = await admin(req, res); if (!u) return;
    if (!req.file) return res.status(400).json({ error: 'file_required' });
    const account_id = req.body.account_id || null; const fund_id = req.body.fund_id || null;
    if (account_id && !(await accountOk(req.params.cid, account_id))) return res.status(400).json({ error: 'account_must_be_a_revenue_or_expense_account_of_this_community' });
    const { extractVendorContract } = require('../lib/accounting/vendor_contract_extractor');
    const extraction = await extractVendorContract(req.file.buffer, req.file.mimetype, req.file.originalname);
    // File the document in the community library under the community's own management
    // company; the contract record cites that library document and its hash.
    const filed = await intake.fileContractDocument(supabase, { community_id: req.params.cid, buffer: req.file.buffer, filename: req.file.originalname, mimetype: req.file.mimetype, extraction });
    const { file_hash, file_path } = filed;
    const row = intake.contractRecord({ management_company_id: filed.management_company_id, community_id: req.params.cid, extraction, file_path, file_hash, file_size_bytes: req.file.size,
      source_document_id: filed.library_document_id, forecast_account_id: account_id, forecast_fund_id: fund_id, intake_source: 'upload', actor: u.email });
    const { data: ins, error } = await supabase.from('vendor_contracts').insert(row).select('id, execution_status, execution_confidence, execution_reason, document_version').single();
    if (error) { if (/column .* does not exist|schema cache/i.test(error.message || '')) return contractsNotReady(res); throw error; }
    const { error: ee } = await supabase.from('vendor_contract_events').insert({ vendor_contract_id: ins.id, event: 'recorded', to_status: ins.execution_status, file_hash, document_version: ins.document_version, actor: u.email,
      detail: { filename: req.file.originalname, intake_source: 'upload', account_id, library_document_id: filed.library_document_id, library_document_reused: filed.reused } });
    if (ee) throw ee;
    res.json({ ok: true, contract: { ...ins, file_hash, file_path, library_document_id: filed.library_document_id, vendor: row.vendor_name_raw }, extraction });
  } catch (err) { fail(res, 'contracts attach', err); }
});

router.post('/:cid/contracts/:id/verify', async (req, res) => {
  try {
    const u = await admin(req, res); if (!u) return;
    const b = req.body || {};
    if (!/^[0-9a-f]{64}$/.test(String(b.file_hash || ''))) return res.status(400).json({ error: 'file_hash_required', message: 'Verify against the document you reviewed (its sha256).' });
    if (String(b.basis || '').trim().length < 10) return res.status(400).json({ error: 'basis_required', message: 'Say what you checked (signatures, dates, which copy).' });
    const c = await contractOf(req.params.cid, req.params.id);
    if (c && c.notReady) return contractsNotReady(res);
    if (!c) return res.status(404).json({ error: 'contract_not_found' });
    const { data, error } = await supabase.rpc('verify_vendor_contract', { p_contract_id: c.id, p_file_hash: b.file_hash, p_actor: u.email, p_source: String(b.basis).trim() });
    if (error) return res.status(409).json({ error: 'verification_refused', message: error.message });
    res.json({ ok: true, result: data });
  } catch (err) { fail(res, 'contracts verify', err); }
});

router.post('/:cid/contracts/:id/bind', async (req, res) => {
  try {
    const u = await admin(req, res); if (!u) return;
    const b = req.body || {};
    if (!b.account_id || !(await accountOk(req.params.cid, b.account_id))) return res.status(400).json({ error: 'account_must_be_a_revenue_or_expense_account_of_this_community' });
    const c = await contractOf(req.params.cid, req.params.id);
    if (c && c.notReady) return contractsNotReady(res);
    if (!c) return res.status(404).json({ error: 'contract_not_found' });
    const { error } = await supabase.from('vendor_contracts').update({ forecast_account_id: b.account_id, forecast_fund_id: b.fund_id || null }).eq('id', c.id);
    if (error) throw error;
    const { error: ee } = await supabase.from('vendor_contract_events').insert({ vendor_contract_id: c.id, event: 'bound', actor: u.email, detail: { account_id: b.account_id, fund_id: b.fund_id || null } });
    if (ee) throw ee;
    res.json({ ok: true });
  } catch (err) { fail(res, 'contracts bind', err); }
});

module.exports = router;
