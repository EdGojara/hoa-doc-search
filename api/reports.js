// ============================================================================
// api/reports.js — Vantaca-to-Bedrock report conversion module
// ----------------------------------------------------------------------------
// Ed 2026-06-04: drag-drop a Vantaca PDF, AI auto-detects type, extracts
// structured data, Bedrock renders the customer-facing artifact.
//
// Endpoints:
//   POST /convert          upload + detect + extract + render in one shot
//   GET  /                 list past conversions (paginated)
//   GET  /:id              detail (with download link)
//   GET  /:id/source       download the original source PDF
//   GET  /:id/rendered     download the Bedrock-rendered output PDF
//   DELETE /:id            soft-delete (status='archived')
//
// Architecture:
//   - Source PDF goes into the 'documents' storage bucket under
//     reports/source/, output goes under reports/output/. No parallel
//     storage silo.
//   - converted_reports row tracks each conversion for audit + listing.
//   - Auto-detect step uses a small (cheap) Claude call; type-specific
//     extraction uses a larger call; renderer is pure local PDFKit.
// ============================================================================

const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { safeErrorMessage } = require('./_safe_error');
const { detectReportType, extractDrvSummary, extractViolationDetail, generateDrvNewsletterCopy } = require('../lib/reports/extract_vantaca_report');
const { renderBedrockDrvPdf } = require('../lib/reports/render_bedrock_drv');
const { renderBedrockViolationDetailPdf } = require('../lib/reports/render_bedrock_violation_detail');

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, files: 1 },
});

const BEDROCK_MGMT_CO_ID = '00000000-0000-0000-0000-000000000001';
const STORAGE_BUCKET = 'documents';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Helper: resolve community_id by fuzzy-matching the AI-detected community name.
async function resolveCommunityIdByName(name) {
  if (!name) return null;
  try {
    const needle = String(name).toLowerCase();
    const { data: communities } = await supabase
      .from('communities')
      .select('id, name')
      .eq('management_company_id', BEDROCK_MGMT_CO_ID);
    for (const c of (communities || [])) {
      if (String(c.name || '').toLowerCase() === needle) return c.id;
    }
    for (const c of (communities || [])) {
      const cn = String(c.name || '').toLowerCase();
      if (cn.includes(needle) || needle.includes(cn.split(' ')[0])) return c.id;
    }
  } catch (e) {
    console.warn('[reports] community resolution skipped:', e.message);
  }
  return null;
}

// ----------------------------------------------------------------------------
// POST /convert — upload + auto-detect + extract + render
// ----------------------------------------------------------------------------
router.post('/convert', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'file_required' });
    if (req.file.mimetype !== 'application/pdf') return res.status(400).json({ error: 'pdf_only' });
    if (req.file.size === 0) return res.status(400).json({ error: 'file_empty' });

    const sourceHash = crypto.createHash('sha256').update(req.file.buffer).digest('hex');

    // Re-upload behavior (Ed 2026-06-04): treat every drop as a fresh
    // conversion request. If the same file hash already has a row
    // (rendered or failed), purge it and replace with a new attempt
    // through the latest extraction + renderer pipeline. This lets the
    // operator iterate on the same file as I tighten the prompt without
    // manual cleanup or a separate "re-render" button.
    const { data: existing } = await supabase
      .from('converted_reports')
      .select('*')
      .eq('source_file_hash', sourceHash)
      .neq('status', 'archived')
      .maybeSingle();
    if (existing) {
      console.log(`[reports] purging ${existing.status} row ${existing.id} (re-upload of same file)`);
      try {
        if (existing.source_file_path) {
          await supabase.storage.from(STORAGE_BUCKET).remove([existing.source_file_path]);
        }
        if (existing.output_file_path) {
          await supabase.storage.from(STORAGE_BUCKET).remove([existing.output_file_path]);
        }
      } catch (e) { console.warn('[reports] storage cleanup skipped:', e.message); }
      await supabase.from('converted_reports').delete().eq('id', existing.id);
    }

    // 1. Auto-detect report type.
    let detection = { parsed: { type: 'unknown', confidence: 'low' }, raw: '' };
    try {
      detection = await detectReportType(req.file.buffer);
    } catch (e) {
      console.warn('[reports] detect failed:', e?.message);
    }
    const detectedType = detection.parsed?.type || 'unknown';
    const detectedCommunityName = detection.parsed?.community_name || null;
    const communityId = await resolveCommunityIdByName(detectedCommunityName);

    // 2. Upload source PDF to storage.
    const reportId = crypto.randomUUID();
    const sourcePath = `${BEDROCK_MGMT_CO_ID}/reports/source/${reportId}.pdf`;
    const { error: srcErr } = await supabase.storage
      .from(STORAGE_BUCKET)
      .upload(sourcePath, req.file.buffer, { contentType: 'application/pdf', upsert: false });
    if (srcErr) {
      console.error('[reports] source upload failed:', srcErr.message);
      return res.status(500).json({ error: safeErrorMessage(srcErr) });
    }

    // 3. Insert converted_reports row (status='extracted', will update after render).
    const periodLabel = detection.parsed?.period_label || null;
    const periodStart = detection.parsed?.period_start || null;
    const periodEnd = detection.parsed?.period_end || null;
    const { data: row, error: insErr } = await supabase
      .from('converted_reports')
      .insert({
        id: reportId,
        community_id: communityId,
        source_type: detectedType,
        period_label: periodLabel,
        period_start: periodStart,
        period_end: periodEnd,
        source_file_path: sourcePath,
        source_file_name: req.file.originalname,
        source_file_hash: sourceHash,
        source_file_size_bytes: req.file.size,
        extraction_confidence: detection.parsed?.confidence || 'medium',
        ai_extracted: detection.parsed || {},
        raw_extraction: detection.raw || null,
        status: 'extracted',
      })
      .select()
      .single();
    if (insErr) {
      console.error('[reports] insert failed:', insErr.message);
      try { await supabase.storage.from(STORAGE_BUCKET).remove([sourcePath]); } catch (_) {}
      return res.status(500).json({ error: safeErrorMessage(insErr) });
    }

    // 4. Type-specific extraction + render. First class: vantaca_drv_summary.
    if (detectedType === 'vantaca_drv_summary') {
      let drvExtract = { parsed: null, raw: '' };
      try {
        drvExtract = await extractDrvSummary(req.file.buffer);
      } catch (e) {
        console.warn('[reports] DRV extraction failed:', e?.message);
      }

      if (!drvExtract.parsed) {
        // Surface the structured failure reason from the extractor so the
        // operator can see whether it was max_tokens, JSON parse, missing
        // violations array, or empty response. Plus the first 600 chars of
        // raw so debugging doesn't require fishing in Render logs.
        const detail = drvExtract.failure_reason || 'DRV summary extraction returned no parseable data';
        const rawExcerpt = (drvExtract.raw || '').slice(0, 600);
        await supabase
          .from('converted_reports')
          .update({
            status: 'failed',
            error_message: detail,
            raw_extraction: drvExtract.raw,
          })
          .eq('id', reportId);
        return res.status(422).json({
          error: 'extraction_failed',
          detail,
          raw_excerpt: rawExcerpt,
          stop_reason: drvExtract.stop_reason || null,
          detected: detection.parsed,
          report: { ...row, status: 'failed', error_message: detail },
        });
      }

      // Use the data-derived community name + period if more specific than detect step.
      const finalCommunityName = drvExtract.parsed.community_name || detectedCommunityName || '(community)';
      const finalPeriodLabel = drvExtract.parsed.period_label || periodLabel || '';
      const resolvedCommunityId = communityId || await resolveCommunityIdByName(finalCommunityName);

      // Generate the message paragraphs + top-3-to-watch via a separate
      // Claude call. Keeps extraction strictly data, narrative strictly
      // model-generated with tight controls + fallback on parse fail.
      let copy = { parsed: null };
      try {
        copy = await generateDrvNewsletterCopy(
          finalCommunityName,
          finalPeriodLabel,
          drvExtract.parsed.metrics || {},
          drvExtract.parsed.top_categories || []
        );
      } catch (e) {
        console.warn('[reports] DRV copy gen threw:', e?.message);
      }
      const copyOut = copy.parsed || { message_paragraphs: [], top_3_to_watch: [] };

      let renderedPdf;
      try {
        renderedPdf = await renderBedrockDrvPdf({
          community_name: finalCommunityName,
          period_label: finalPeriodLabel,
          metrics: drvExtract.parsed.metrics || {},
          top_categories: drvExtract.parsed.top_categories || [],
          message_paragraphs: copyOut.message_paragraphs,
          top_3_to_watch: copyOut.top_3_to_watch,
        });
      } catch (rEr) {
        console.error('[reports] DRV render failed:', rEr.stack || rEr.message);
        await supabase
          .from('converted_reports')
          .update({ status: 'failed', error_message: 'Render failed: ' + rEr.message })
          .eq('id', reportId);
        return res.status(500).json({ error: safeErrorMessage(rEr) });
      }

      // Upload rendered PDF.
      const outName = `${finalCommunityName.replace(/[^A-Za-z0-9]+/g, '_')}_DRV_${(finalPeriodLabel || 'Summary').replace(/[^A-Za-z0-9]+/g, '_')}.pdf`;
      const outPath = `${BEDROCK_MGMT_CO_ID}/reports/output/${reportId}.pdf`;
      const { error: outErr } = await supabase.storage
        .from(STORAGE_BUCKET)
        .upload(outPath, renderedPdf, { contentType: 'application/pdf', upsert: false });
      if (outErr) {
        console.error('[reports] output upload failed:', outErr.message);
        await supabase
          .from('converted_reports')
          .update({ status: 'failed', error_message: 'Output upload: ' + outErr.message })
          .eq('id', reportId);
        return res.status(500).json({ error: safeErrorMessage(outErr) });
      }

      const { data: updated } = await supabase
        .from('converted_reports')
        .update({
          community_id: resolvedCommunityId || communityId,
          output_file_path: outPath,
          output_file_name: outName,
          period_label: finalPeriodLabel || null,
          period_start: drvExtract.parsed.period_start || periodStart,
          period_end: drvExtract.parsed.period_end || periodEnd,
          ai_extracted: drvExtract.parsed,
          raw_extraction: drvExtract.raw,
          status: 'rendered',
          rendered_at: new Date().toISOString(),
        })
        .eq('id', reportId)
        .select()
        .single();

      return res.json({ report: updated, ai_extracted: drvExtract.parsed });
    }

    // Vantaca violation detail (single-violation drilldown).
    if (detectedType === 'vantaca_violation_detail') {
      let vd = { parsed: null, raw: '' };
      try { vd = await extractViolationDetail(req.file.buffer); }
      catch (e) { console.warn('[reports] violation_detail extraction failed:', e?.message); }

      if (!vd.parsed) {
        const detail = vd.failure_reason || 'Violation detail extraction returned no parseable data';
        const rawExcerpt = (vd.raw || '').slice(0, 600);
        await supabase.from('converted_reports')
          .update({ status: 'failed', error_message: detail, raw_extraction: vd.raw })
          .eq('id', reportId);
        return res.status(422).json({
          error: 'extraction_failed', detail, raw_excerpt: rawExcerpt,
          stop_reason: vd.stop_reason || null, detected: detection.parsed,
          report: { ...row, status: 'failed', error_message: detail },
        });
      }

      const finalCommunityName = vd.parsed.community_name || detectedCommunityName || '(community)';
      const resolvedCommunityId = communityId || await resolveCommunityIdByName(finalCommunityName);
      let renderedPdf;
      try {
        renderedPdf = await renderBedrockViolationDetailPdf({ community_name: finalCommunityName, ...vd.parsed });
      } catch (rEr) {
        console.error('[reports] violation_detail render failed:', rEr.stack || rEr.message);
        await supabase.from('converted_reports')
          .update({ status: 'failed', error_message: 'Render failed: ' + rEr.message })
          .eq('id', reportId);
        return res.status(500).json({ error: safeErrorMessage(rEr) });
      }
      const propTag = (vd.parsed.property_address || 'Property').replace(/[^A-Za-z0-9]+/g, '_').slice(0, 40);
      const outName = `${finalCommunityName.replace(/[^A-Za-z0-9]+/g, '_')}_Violation_${propTag}.pdf`;
      const outPath = `${BEDROCK_MGMT_CO_ID}/reports/output/${reportId}.pdf`;
      const { error: outErr } = await supabase.storage
        .from(STORAGE_BUCKET).upload(outPath, renderedPdf, { contentType: 'application/pdf', upsert: false });
      if (outErr) {
        await supabase.from('converted_reports')
          .update({ status: 'failed', error_message: 'Output upload: ' + outErr.message })
          .eq('id', reportId);
        return res.status(500).json({ error: safeErrorMessage(outErr) });
      }
      const { data: updated } = await supabase
        .from('converted_reports')
        .update({
          community_id: resolvedCommunityId || communityId,
          output_file_path: outPath,
          output_file_name: outName,
          ai_extracted: vd.parsed,
          raw_extraction: vd.raw,
          status: 'rendered',
          rendered_at: new Date().toISOString(),
        })
        .eq('id', reportId).select().single();
      return res.json({ report: updated, ai_extracted: vd.parsed });
    }

    // Other types: extraction + render not built yet. Source is stored, AI
    // detected the type, but the render template doesn't exist. Return the
    // row so the operator sees it and we add the template next.
    return res.json({
      report: row,
      message: `Source type '${detectedType}' detected but renderer not yet built. Source PDF is stored; conversion will be implemented as the template ships.`,
    });
  } catch (err) {
    console.error('[reports] /convert failed:', err.stack || err.message);
    return res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ----------------------------------------------------------------------------
// GET / — list past conversions
// ----------------------------------------------------------------------------
router.get('/', async (req, res) => {
  try {
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || '50', 10)));
    const offset = Math.max(0, parseInt(req.query.offset || '0', 10));
    const status = (req.query.status || 'all').toString();
    let q = supabase
      .from('converted_reports')
      .select('id, community_id, source_type, period_label, period_start, period_end, source_file_name, source_file_path, output_file_name, output_file_path, status, error_message, extraction_confidence, rendered_at, created_at, communities:community_id(name)', { count: 'exact' })
      .order('created_at', { ascending: false });
    if (status !== 'all') q = q.eq('status', status);
    q = q.range(offset, offset + limit - 1);
    const { data, error, count } = await q;
    if (error) return res.status(500).json({ error: safeErrorMessage(error) });
    res.json({ reports: data || [], total: count || 0, limit, offset });
  } catch (err) {
    console.error('[reports] GET / failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ----------------------------------------------------------------------------
// GET /:id — detail
// ----------------------------------------------------------------------------
router.get('/:id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('converted_reports')
      .select('*, communities:community_id(name)')
      .eq('id', req.params.id)
      .maybeSingle();
    if (error) return res.status(500).json({ error: safeErrorMessage(error) });
    if (!data) return res.status(404).json({ error: 'not_found' });
    res.json({ report: data });
  } catch (err) {
    console.error('[reports] GET /:id failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// Helpers to serve PDFs from storage
async function streamPdfByPath(filePath, downloadName, res) {
  if (!filePath) return res.status(404).json({ error: 'file_not_available' });
  const { data, error } = await supabase.storage.from(STORAGE_BUCKET).download(filePath);
  if (error || !data) return res.status(404).json({ error: 'file_missing' });
  const buf = Buffer.from(await data.arrayBuffer());
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${downloadName.replace(/"/g, '')}"`);
  res.send(buf);
}

router.get('/:id/source', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('converted_reports')
      .select('source_file_path, source_file_name')
      .eq('id', req.params.id)
      .maybeSingle();
    if (error || !data) return res.status(404).json({ error: 'not_found' });
    return streamPdfByPath(data.source_file_path, data.source_file_name || 'source.pdf', res);
  } catch (err) {
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

router.get('/:id/rendered', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('converted_reports')
      .select('output_file_path, output_file_name')
      .eq('id', req.params.id)
      .maybeSingle();
    if (error || !data) return res.status(404).json({ error: 'not_found' });
    return streamPdfByPath(data.output_file_path, data.output_file_name || 'bedrock-report.pdf', res);
  } catch (err) {
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const { error } = await supabase
      .from('converted_reports')
      .update({ status: 'archived' })
      .eq('id', req.params.id);
    if (error) return res.status(500).json({ error: safeErrorMessage(error) });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ----------------------------------------------------------------------------
// POST /manual-drv  — Bypass AI entirely. Operator types the data in; we
// render the newsletter PDF and store the row. Ed 2026-06-04: shipped after
// 5 rounds of broken AI extraction so the operator can produce the monthly
// LOPF newsletter without depending on the detect/extract pipeline.
//
// Body (JSON):
//   {
//     community_name: string,
//     period_label: string,          // "May 2026"
//     period_start: "YYYY-MM-DD" | null,
//     period_end:   "YYYY-MM-DD" | null,
//     metrics: {
//       first_notices_issued, second_notices_issued,
//       violations_resolved, certified_letters_sent
//     },
//     top_categories: [{ category, percentage }],
//     message_paragraphs: [p1, p2, p3] | null,   // null -> AI fills in
//     top_3_to_watch:     [s1, s2, s3]   | null,  // null -> AI fills in
//   }
// ----------------------------------------------------------------------------
router.post('/manual-drv', express.json({ limit: '64kb' }), async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.community_name) return res.status(400).json({ error: 'community_name_required' });
    if (!b.period_label)    return res.status(400).json({ error: 'period_label_required' });
    if (!b.metrics)         return res.status(400).json({ error: 'metrics_required' });

    const reportId = crypto.randomUUID();
    const communityId = await resolveCommunityIdByName(b.community_name);

    // Use operator-provided copy if given; otherwise generate via AI from
    // the metrics + top categories. Falls back to deterministic templates
    // inside generateDrvNewsletterCopy if the model call fails.
    let messageParagraphs = Array.isArray(b.message_paragraphs) && b.message_paragraphs.length === 3
      ? b.message_paragraphs
      : null;
    let top3 = Array.isArray(b.top_3_to_watch) && b.top_3_to_watch.length === 3
      ? b.top_3_to_watch
      : null;
    if (!messageParagraphs || !top3) {
      try {
        const copy = await generateDrvNewsletterCopy(
          b.community_name, b.period_label, b.metrics, b.top_categories || []
        );
        if (copy?.parsed?.message_paragraphs) messageParagraphs = messageParagraphs || copy.parsed.message_paragraphs;
        if (copy?.parsed?.top_3_to_watch)     top3 = top3 || copy.parsed.top_3_to_watch;
      } catch (e) { console.warn('[reports/manual-drv] copy gen failed:', e?.message); }
    }

    let renderedPdf;
    try {
      renderedPdf = await renderBedrockDrvPdf({
        community_name: b.community_name,
        period_label: b.period_label,
        metrics: b.metrics,
        top_categories: b.top_categories || [],
        message_paragraphs: messageParagraphs || [],
        top_3_to_watch: top3 || [],
      });
    } catch (rEr) {
      console.error('[reports/manual-drv] render failed:', rEr.stack || rEr.message);
      return res.status(500).json({ error: safeErrorMessage(rEr) });
    }

    // Store as a converted_reports row so it shows up in Past Conversions
    // alongside AI-converted reports. source_file_path is null since there's
    // no source PDF — operator typed the data.
    const outName = `${b.community_name.replace(/[^A-Za-z0-9]+/g, '_')}_DRV_${(b.period_label || 'Summary').replace(/[^A-Za-z0-9]+/g, '_')}.pdf`;
    const outPath = `${BEDROCK_MGMT_CO_ID}/reports/output/${reportId}.pdf`;
    const { error: outErr } = await supabase.storage
      .from(STORAGE_BUCKET).upload(outPath, renderedPdf, { contentType: 'application/pdf', upsert: false });
    if (outErr) {
      console.error('[reports/manual-drv] output upload failed:', outErr.message);
      return res.status(500).json({ error: safeErrorMessage(outErr) });
    }

    const { data: row, error: insErr } = await supabase
      .from('converted_reports')
      .insert({
        id: reportId,
        community_id: communityId,
        source_type: 'vantaca_drv_summary',
        period_label: b.period_label,
        period_start: b.period_start || null,
        period_end: b.period_end || null,
        source_file_path: null,                      // no source — manual entry
        source_file_name: '(manual entry)',
        source_file_hash: null,
        source_file_size_bytes: null,
        output_file_path: outPath,
        output_file_name: outName,
        extraction_confidence: 'high',                // operator-typed = high confidence
        ai_extracted: {
          metrics: b.metrics,
          top_categories: b.top_categories || [],
          message_paragraphs: messageParagraphs,
          top_3_to_watch: top3,
        },
        status: 'rendered',
        rendered_at: new Date().toISOString(),
      })
      .select()
      .single();
    if (insErr) {
      console.error('[reports/manual-drv] insert failed:', insErr.message);
      try { await supabase.storage.from(STORAGE_BUCKET).remove([outPath]); } catch (_) {}
      return res.status(500).json({ error: safeErrorMessage(insErr) });
    }
    return res.json({ report: row });
  } catch (err) {
    console.error('[reports/manual-drv] failed:', err.stack || err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

module.exports = router;
