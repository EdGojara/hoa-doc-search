// ============================================================================
// api/proposals.js  (2026-09-20)  —  Proposal domain HTTP surface
// ----------------------------------------------------------------------------
// A management proposal is a commercial document (scope, fee, onboarding, term)
// delivered AFTER a prospect asks for one. It is a different business object
// from a demo presentation, so it has its own routes here instead of riding the
// presentations endpoints. Artifacts are recorded in presentation_instances with
// artifact_type='proposal' (migration 435) so proposals and demos are
// distinguishable without relying on legacy template names.
//
//   GET    /api/proposals/templates              — available proposal templates
//   POST   /api/proposals/generate               — build + store + return a .pptx
//   GET    /api/proposals/instances              — proposal history
//   GET    /api/proposals/instances/:id/download — download a stored proposal
//   DELETE /api/proposals/instances/:id          — delete a proposal + its assets
// ============================================================================
const express = require('express');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');
const { safeErrorMessage } = require('./_safe_error');
const proposals = require('../lib/proposals');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const upload = multer({ storage: multer.memoryStorage() });
const router = express.Router();

const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
// Bedrock as management company #1. Duplicated across the codebase; see the
// BLOCKED tenant-identity decision in the closure ledger (not resolved here).
const BEDROCK_MGMT_CO_ID = '00000000-0000-0000-0000-000000000001';

router.get('/templates', (req, res) => {
  res.json({ templates: proposals.listTemplates() });
});

router.post('/generate', upload.any(), async (req, res) => {
  try {
    const templateSlug = (req.body.template_slug || '').trim();
    const template = proposals.getTemplate(templateSlug);
    if (!template) return res.status(400).json({ error: 'unknown_proposal_template: ' + templateSlug });

    let variables = {};
    if (req.body.variables) { try { variables = JSON.parse(req.body.variables); } catch { variables = {}; } }
    else { (template.variables || []).forEach((v) => { if (req.body[v.key] !== undefined) variables[v.key] = req.body[v.key]; }); }

    const ctx = {};
    const files = req.files || [];
    files.forEach((f) => { if (f.fieldname === 'cover_image') { ctx.coverImageBuffer = f.buffer; ctx.coverImageMime = f.mimetype; } });

    const title = [template.title, variables.community].filter(Boolean).join(' — ');
    const pres = template.build(variables, ctx);
    const pptxBuffer = await pres.write({ outputType: 'nodebuffer' });
    const safeStem = (variables.community || template.slug).replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'proposal';
    const filename = `${safeStem}_${template.slug}_${new Date().toISOString().slice(0, 10)}.pptx`;

    const { data: instance, error: insErr } = await supabase.from('presentation_instances').insert({
      management_company_id: BEDROCK_MGMT_CO_ID,
      artifact_type: 'proposal',
      template_slug: template.slug,
      title, variables, output_filename: filename, status: 'generated',
    }).select().single();

    if (insErr) { console.warn('[proposals] history write failed:', insErr.message); }
    else if (instance) {
      const storagePath = `proposals/${instance.id}/${filename}`;
      const { error: stErr } = await supabase.storage.from('documents').upload(storagePath, pptxBuffer, { contentType: PPTX_MIME, upsert: true });
      if (stErr) console.warn('[proposals] storage save failed:', stErr.message);
      else await supabase.from('presentation_instances').update({ output_storage_path: storagePath, updated_at: new Date().toISOString() }).eq('id', instance.id);

      for (const f of files) {
        try {
          const ext = (f.originalname.split('.').pop() || 'bin').toLowerCase();
          const assetPath = `proposals/${instance.id}/${f.fieldname}_${Date.now()}.${ext}`;
          const { error: aErr } = await supabase.storage.from('documents').upload(assetPath, f.buffer, { contentType: f.mimetype, upsert: true });
          if (!aErr) await supabase.from('presentation_assets').insert({ instance_id: instance.id, slot_key: f.fieldname, storage_path: assetPath, mime_type: f.mimetype, meta: { original_filename: f.originalname } });
        } catch (e) { console.warn('[proposals] asset save failed:', e.message); }
      }
    }

    res.setHeader('Content-Type', PPTX_MIME);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(pptxBuffer);
  } catch (err) {
    console.error('[proposals] generate failed:', err.message);
    res.status(500).json({ error: 'Proposal generation failed: ' + safeErrorMessage(err) });
  }
});

router.get('/instances', async (req, res) => {
  try {
    const { data, error } = await supabase.from('presentation_instances')
      .select('id, template_slug, title, variables, output_filename, status, created_at')
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .eq('artifact_type', 'proposal')
      .order('created_at', { ascending: false })
      .limit(100);
    if (error) throw error;
    res.json({ instances: data || [] });
  } catch (err) {
    console.error('[proposals] list failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

router.get('/instances/:id/download', async (req, res) => {
  try {
    const { data: instance, error: qErr } = await supabase.from('presentation_instances')
      .select('id, output_storage_path, output_filename, artifact_type')
      .eq('id', req.params.id)
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .eq('artifact_type', 'proposal')
      .single();
    if (qErr || !instance) return res.status(404).json({ error: 'Not found' });
    // Serve the stored artifact. No regeneration fallback: if the file is gone,
    // fail visibly rather than silently rebuilding from possibly-changed inputs.
    if (!instance.output_storage_path) return res.status(410).json({ error: 'stored proposal file is unavailable' });
    const { data: blob, error: dErr } = await supabase.storage.from('documents').download(instance.output_storage_path);
    if (dErr || !blob) return res.status(410).json({ error: 'stored proposal file could not be read' });
    const arr = await blob.arrayBuffer();
    res.setHeader('Content-Type', PPTX_MIME);
    res.setHeader('Content-Disposition', `attachment; filename="${instance.output_filename || 'proposal.pptx'}"`);
    res.send(Buffer.from(arr));
  } catch (err) {
    console.error('[proposals] download failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

router.delete('/instances/:id', async (req, res) => {
  try {
    const { data: instance, error: qErr } = await supabase.from('presentation_instances')
      .select('id, output_storage_path')
      .eq('id', req.params.id)
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .eq('artifact_type', 'proposal')
      .single();
    if (qErr || !instance) return res.status(404).json({ error: 'Not found' });
    if (instance.output_storage_path) await supabase.storage.from('documents').remove([instance.output_storage_path]);
    const { data: assets } = await supabase.from('presentation_assets').select('storage_path').eq('instance_id', req.params.id);
    if (assets && assets.length) await supabase.storage.from('documents').remove(assets.map((a) => a.storage_path));
    await supabase.from('presentation_instances').delete().eq('id', req.params.id).eq('management_company_id', BEDROCK_MGMT_CO_ID);
    res.json({ ok: true });
  } catch (err) {
    console.error('[proposals] delete failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

module.exports = router;
