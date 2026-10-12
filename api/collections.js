// ============================================================================
// api/collections.js  (Ed 2026-10-12)  mounted at /api/collections
// ----------------------------------------------------------------------------
// Certified collections notices, inside Receivables (Accounting -> Homeowners ->
// Collections, public/collections.js). Logic: lib/collections/notices.js.
//
// Gates: preparing, verifying, approving, printing and recording mailings need an
// identified staff user (requireActingUser), the same authority the DRV mail queue
// uses; approval also needs Kat's verification and an owner-approved template.
// Approving a template's wording and setting a community's homeowner fee are the
// owner's (requireAdmin). Nothing here mails anything; a fee posts only when staff
// record that a notice was actually mailed.
// ============================================================================
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { safeErrorMessage } = require('./_safe_error');
const { requireActingUser, actorDisplayName } = require('./_acting_user');
const { requireAdmin } = require('./_require_admin');
const N = require('../lib/collections/notices');

const router = express.Router();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
router.use(express.json({ limit: '256kb' }));

const who = (actor) => `${actorDisplayName(actor)}${actor && actor.email ? ` <${actor.email}>` : ''}`;
const STATUS = { invalid_input: 400, not_eligible: 409, conflict: 409, duplicate: 409, date_mismatch: 409, blocked: 409, template_not_approved: 409, verification_failed: 409, forbidden: 403 };
function fail(res, err, where) {
  const msg = String(err && err.message);
  if (/collection_notice|collection_fee_autopost/.test(msg) && /does not exist|schema cache|not find/i.test(msg)) return res.status(503).json({ error: 'migration_515_required', message: 'Collections notices need migration 515 (Documents -> Migration status).' });
  const code = STATUS[err && err.code];
  if (code) return res.status(code).json({ error: err.code, message: err.message, accounts: err.accounts, verification: err.verification });
  console.error(`[collections] ${where} failed:`, msg);
  return res.status(500).json({ error: safeErrorMessage(err) });
}
const signed = async (path) => { if (!path) return null; try { const { data } = await supabase.storage.from('documents').createSignedUrl(path, 900); return data ? data.signedUrl : null; } catch (_) { return null; } };

router.get('/eligible', async (req, res) => {
  try {
    if (!req.query.community_id) return res.status(400).json({ error: 'community_id_required' });
    res.json(await N.eligibleAccounts(supabase, req.query.community_id));
  } catch (e) { fail(res, e, 'eligible'); }
});

router.get('/batches', async (req, res) => {
  try {
    if (!req.query.community_id) return res.status(400).json({ error: 'community_id_required' });
    const { data: batches, error } = await supabase.from('collection_notice_batches').select('id, status, notice_date, prepared_by, prepared_at, verified_at, verification, approved_by, approved_at, printed_at, cancelled_reason, batch_pdf_path')
      .eq('community_id', req.query.community_id).order('created_at', { ascending: false }).limit(50);
    if (error) throw error;
    const ids = (batches || []).map((b) => b.id);
    const { data: ns, error: ne } = ids.length ? await supabase.from('collection_notices').select('batch_id, status, amount_due_cents, fee_cents').in('batch_id', ids) : { data: [], error: null };
    if (ne) throw ne;
    res.json({ batches: (batches || []).map((b) => { const mine = (ns || []).filter((n) => n.batch_id === b.id && n.status !== 'cancelled'); return { ...b, notices: mine.length, mailed: mine.filter((n) => n.status === 'mailed').length, total_due_cents: mine.reduce((s, n) => s + Number(n.amount_due_cents), 0) }; }) });
  } catch (e) { fail(res, e, 'batches'); }
});

router.get('/batches/:id', async (req, res) => {
  try {
    const { data: b, error } = await supabase.from('collection_notice_batches').select('*').eq('id', req.params.id).single();
    if (error) throw error;
    const { data: ns, error: ne } = await supabase.from('collection_notices').select('id, property_id, status, owner_name, account_number, notice_date, deadline_date, ledger_balance_cents, fee_cents, amount_due_cents, certified_tracking_number, mailed_date, regular_mail_confirmed, cancelled_reason, pdf_path, fee_journal_entry_id, mailing_address')
      .eq('batch_id', req.params.id).order('owner_name');
    if (ne) throw ne;
    res.json({ batch: { ...b, batch_pdf_url: await signed(b.batch_pdf_path) }, notices: await Promise.all((ns || []).map(async (n) => ({ ...n, pdf_url: await signed(n.pdf_path) }))) });
  } catch (e) { fail(res, e, 'batch'); }
});

router.post('/batches', async (req, res) => {
  try {
    const actor = await requireActingUser(req, res); if (!actor) return;
    const b = req.body || {};
    if (!b.community_id) return res.status(400).json({ error: 'community_id_required' });
    res.json(await N.prepareBatch(supabase, { communityId: b.community_id, noticeDate: b.notice_date || undefined, propertyIds: Array.isArray(b.property_ids) && b.property_ids.length ? b.property_ids : null, preparedBy: `Amanda (AI), requested by ${who(actor)}` }));
  } catch (e) { fail(res, e, 'prepare'); }
});

router.post('/batches/:id/verify', async (req, res) => {
  try { const actor = await requireActingUser(req, res); if (!actor) return; res.json(await N.verifyBatch(supabase, req.params.id)); } catch (e) { fail(res, e, 'verify'); }
});
router.post('/batches/:id/approve', async (req, res) => {
  try { const actor = await requireActingUser(req, res); if (!actor) return; res.json({ batch: await N.approveBatch(supabase, req.params.id, { actor: who(actor) }) }); } catch (e) { fail(res, e, 'approve'); }
});
router.post('/batches/:id/printed', async (req, res) => {
  try { const actor = await requireActingUser(req, res); if (!actor) return; res.json(await N.markPrinted(supabase, req.params.id, { actor: who(actor) })); } catch (e) { fail(res, e, 'printed'); }
});
router.post('/batches/:id/redate', async (req, res) => {
  try { const actor = await requireActingUser(req, res); if (!actor) return; res.json(await N.redateBatch(supabase, req.params.id, { noticeDate: (req.body || {}).notice_date, actor: who(actor) })); } catch (e) { fail(res, e, 'redate'); }
});
router.post('/batches/:id/cancel', async (req, res) => {
  try { const actor = await requireActingUser(req, res); if (!actor) return; res.json(await N.cancelBatch(supabase, req.params.id, { reason: (req.body || {}).reason, actor: who(actor) })); } catch (e) { fail(res, e, 'cancel batch'); }
});

router.post('/notices/:id/mail', async (req, res) => {
  try {
    const actor = await requireActingUser(req, res); if (!actor) return;
    const b = req.body || {};
    res.json(await N.recordMailing(supabase, req.params.id, { trackingNumber: b.tracking_number, mailedDate: b.mailed_date, regularMailConfirmed: b.regular_mail_confirmed === true, actor: who(actor) }));
  } catch (e) { fail(res, e, 'mail'); }
});
router.post('/notices/:id/cancel', async (req, res) => {
  try { const actor = await requireActingUser(req, res); if (!actor) return; res.json(await N.cancelNotice(supabase, req.params.id, { reason: (req.body || {}).reason, actor: who(actor) })); } catch (e) { fail(res, e, 'cancel notice'); }
});

// Preview a notice exactly as it will print (drafts render from the fixed snapshot).
router.get('/notices/:id/preview', async (req, res) => {
  try {
    const { data: n, error } = await supabase.from('collection_notices').select('*').eq('id', req.params.id).single();
    if (error) throw error;
    if (n.pdf_path) { const url = await signed(n.pdf_path); if (url) return res.redirect(url); }
    const { data: t, error: te } = await supabase.from('collection_notice_templates').select('*').eq('id', n.template_id).single();
    if (te) throw te;
    const { data: c, error: ce } = await supabase.from('communities').select('id, name, legal_name, hoa_legal_name').eq('id', n.community_id).single();
    if (ce) throw ce;
    res.set('Content-Type', 'text/html').send(N.renderNoticeHTML({ template: t, snapshot: n.statement_snapshot, notice: n, community: c }).replace('<body>', '<body><div style="position:fixed;top:0;left:0;right:0;background:#fef3c7;color:#92400e;font:bold 12px Arial;padding:6px;text-align:center;z-index:9">DRAFT PREVIEW: not approved, not mailed</div>'));
  } catch (e) { fail(res, e, 'preview'); }
});

// The homeowner account's collections history (issued notices, mailing evidence, fees).
router.get('/property/:propertyId', async (req, res) => {
  try {
    const { data, error } = await supabase.from('collection_notices').select('id, status, notice_date, deadline_date, amount_due_cents, fee_cents, certified_tracking_number, mailed_date, regular_mail_confirmed, pdf_path, cancelled_reason')
      .eq('property_id', req.params.propertyId).order('notice_date', { ascending: false }).limit(50);
    if (error) throw error;
    res.json({ notices: await Promise.all((data || []).map(async (n) => ({ ...n, pdf_url: await signed(n.pdf_path) }))) });
  } catch (e) { fail(res, e, 'property'); }
});

// Owner: approve a template's wording for mailing (counsel questions travel with it).
router.post('/templates/:id/approve', async (req, res) => {
  try {
    const admin = await requireAdmin(req, res); if (!admin) return;
    const actor = await requireActingUser(req, res); if (!actor) return;
    const { data: t, error } = await supabase.from('collection_notice_templates').select('id, community_id, status').eq('id', req.params.id).single();
    if (error) throw error;
    if (t.status === 'approved') return res.json({ status: 'already_approved' });
    const { error: re } = await supabase.from('collection_notice_templates').update({ status: 'retired', updated_at: new Date().toISOString() }).eq('community_id', t.community_id).eq('status', 'approved');
    if (re) throw re;
    const { data: u, error: ue } = await supabase.from('collection_notice_templates').update({ status: 'approved', approved_by: who(actor), approved_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', t.id).select('*').single();
    if (ue) throw ue;
    res.json({ template: u });
  } catch (e) { fail(res, e, 'approve template'); }
});

// Owner: the community's homeowner-recoverable certified-letter fee and whether it posts.
router.put('/settings', async (req, res) => {
  try {
    const admin = await requireAdmin(req, res); if (!admin) return;
    const b = req.body || {};
    const cents = Number(b.fee_cents);
    if (!b.community_id || !Number.isInteger(cents) || cents < 0) return res.status(400).json({ error: 'invalid_input', message: 'community_id and a whole-cent fee are required' });
    const { data, error } = await supabase.from('communities').update({ certified_collection_fee_cents: cents, collection_fee_autopost: b.autopost === true }).eq('id', b.community_id).select('id, certified_collection_fee_cents, collection_fee_autopost').single();
    if (error) throw error;
    res.json({ community: data, fee: (await N.loadConfig(supabase, b.community_id)).fee });
  } catch (e) { fail(res, e, 'settings'); }
});

module.exports = router;
