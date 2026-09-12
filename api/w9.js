// ============================================================================
// api/w9.js  (Ed 2026-09-12)  — admin-only
// ----------------------------------------------------------------------------
// Generate a filled IRS Form W-9 for Bedrock or any community (HOA), from the
// legal name + EIN + address already stored on management_companies /
// communities. Returns the official form, unsigned, ready to sign.
//
//   GET /api/w9/list                     entities that can produce a W-9
//   GET /api/w9/management-company.pdf   Bedrock's W-9
//   GET /api/w9/community/:id.pdf        one HOA's W-9 (400 if no EIN on file)
// ============================================================================
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { requireAdmin } = require('./_require_admin');
const { safeErrorMessage } = require('./_safe_error');
const { renderW9 } = require('../lib/w9/render');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const router = express.Router();
const BEDROCK_MGMT_CO_ID = '00000000-0000-0000-0000-000000000001';

function sendPdf(res, bytes, filename) {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename.replace(/[^\w .-]/g, '_')}"`);
  res.send(Buffer.from(bytes));
}

// The entities that can produce a W-9 right now (have an EIN on file).
router.get('/list', async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  try {
    const { data: mc } = await supabase.from('management_companies').select('legal_name, ein').eq('id', BEDROCK_MGMT_CO_ID).maybeSingle();
    const { data: comms } = await supabase.from('communities').select('id, name, hoa_legal_name, ein').order('name');
    const communities = (comms || [])
      .filter((c) => c.name !== 'Drama Creek Estates') // demo community, not a real HOA
      .map((c) => ({ id: c.id, name: c.name, legal_name: c.hoa_legal_name || null, ein: c.ein || null, ready: !!c.ein }));
    res.json({
      management_company: mc ? { legal_name: mc.legal_name, ein: mc.ein || null, ready: !!mc.ein } : null,
      communities,
    });
  } catch (err) {
    console.error('[w9] list failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

router.get('/management-company.pdf', async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  try {
    const { data: mc } = await supabase.from('management_companies').select('legal_name, ein, address').eq('id', BEDROCK_MGMT_CO_ID).maybeSingle();
    if (!mc || !mc.ein) return res.status(400).json({ error: 'No EIN on file for the management company.' });
    // Bedrock is an LLC taxed as an S corporation (files Form 1120-S).
    const pdf = await renderW9({ name: mc.legal_name, classification: 'llc', llcLetter: 'S', address: mc.address, ein: mc.ein });
    sendPdf(res, pdf, `${mc.legal_name} W-9.pdf`);
  } catch (err) {
    console.error('[w9] management-company failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

router.get('/community/:id.pdf', async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  try {
    const { data: c } = await supabase.from('communities').select('name, hoa_legal_name, hoa_address, ein, tax_classification').eq('id', req.params.id).maybeSingle();
    if (!c) return res.status(404).json({ error: 'Community not found.' });
    if (!c.ein) return res.status(400).json({ error: `No EIN on file for ${c.name} yet.` });
    // HOAs file Form 1120-H; classify as "Other" with that description rather
    // than mislabel as a standard corporation. (Confirm with the CPA if needed.)
    const pdf = await renderW9({
      name: c.hoa_legal_name || c.name,
      classification: 'other',
      otherText: 'Homeowners association (Form 1120-H)',
      address: c.hoa_address,
      ein: c.ein,
    });
    sendPdf(res, pdf, `${(c.hoa_legal_name || c.name)} W-9.pdf`);
  } catch (err) {
    console.error('[w9] community failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// A blank official W-9 to hand a vendor to fill out.
router.get('/blank.pdf', async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  try {
    const fs = require('fs'); const path = require('path');
    const bytes = fs.readFileSync(path.join(__dirname, '..', 'templates', 'fw9.pdf'));
    sendPdf(res, bytes, 'Form W-9 (blank).pdf');
  } catch (err) {
    console.error('[w9] blank failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// A filled W-9 for any entity typed in (a vendor, a new association, etc.).
router.post('/custom', express.json({ limit: '16kb' }), async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  try {
    const b = req.body || {};
    if (!b.name) return res.status(400).json({ error: 'A legal name is required.' });
    const allowed = ['individual', 'c_corp', 's_corp', 'partnership', 'trust', 'llc', 'other'];
    const classification = allowed.includes(b.classification) ? b.classification : 'other';
    const pdf = await renderW9({
      name: String(b.name), businessName: b.business_name || '',
      classification, llcLetter: b.llc_letter || 'C', otherText: b.other_text || '',
      address: b.address || '', street: b.street || '', cityStateZip: b.city_state_zip || '',
      ein: b.ein || '',
    });
    sendPdf(res, pdf, `${String(b.name)} W-9.pdf`);
  } catch (err) {
    console.error('[w9] custom failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

module.exports = { router };
