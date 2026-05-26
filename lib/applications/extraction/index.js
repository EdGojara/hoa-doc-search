// ============================================================================
// lib/applications/extraction/index.js
// ----------------------------------------------------------------------------
// Public entry point for the Application Extraction Layer (brief 01).
//
// Pipeline (two passes per the brief):
//   1. Intake — receive form fields + file references (Buffers + meta)
//   2. Pass A: per-file classify + extract (Claude multimodal)
//   3. Pass B: normalize + merge into the strict Application schema
//   4. Reconcile address → unit_id (flag, never silently fix)
//   5. Validate the final object against the schema
//   6. (Optional) persist to application_extractions table
//
// Usage:
//   const { extractApplication } = require('./lib/applications/extraction');
//   const result = await extractApplication({
//     applicationId, communityId,
//     formFields: { homeowner_name, homeowner_email, property_address,
//                   request_summary, project_completion_date, ... },
//     files: [{ fileId, buffer, mimeType, originalName }],
//   });
//
// extractApplication() NEVER throws. Errors degrade into validation flags.
// ============================================================================

const { classifyDocument } = require('./classify_document');
const { extractDocument } = require('./extract_document');
const { normalizeAndMerge } = require('./normalize_merge');
const { reconcileUnit } = require('./reconcile_unit');
const { validateApplication } = require('./schema');

const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const EXTRACTOR_VERSION = 'v1';

/**
 * Run a single file through Pass A: classify, then extract.
 * Returns a "classified doc" object for normalize_merge to consume.
 */
async function runPassAForFile(file, opts = {}) {
  const logger = opts.logger || console;
  const fileId = file.fileId || file.id || file.originalName || 'unknown';

  // Step 1: classify
  const classification = await classifyDocument({
    buffer: file.buffer,
    mimeType: file.mimeType,
    originalName: file.originalName,
  }, { logger });

  if (classification.error) {
    logger.warn(`[extract_application] classify error for ${fileId}: ${classification.error}`);
    return {
      fileId,
      documentType: 'unknown',
      documentConfidence: 0,
      extracted: {},
      pageCount: 0,
      error: classification.error,
    };
  }

  // Step 2: extract (per type)
  const extraction = await extractDocument({
    buffer: file.buffer,
    mimeType: file.mimeType,
    documentType: classification.documentType,
    originalName: file.originalName,
  }, { logger });

  if (extraction.error) {
    logger.warn(`[extract_application] extract error for ${fileId} (${classification.documentType}): ${extraction.error}`);
  }

  return {
    fileId,
    documentType: classification.documentType,
    documentConfidence: classification.confidence,
    classificationRationale: classification.rationale,
    extracted: extraction.extracted || {},
    pageCount: extraction.pageCount || 0,
    error: extraction.error,
    errorMessage: extraction.errorMessage,
    usage: {
      classify: classification.usage,
      extract: extraction.usage,
    },
  };
}

/**
 * Main entry point — Brief 01.
 *
 * @param {object} submission
 * @param {string} submission.applicationId — caller-supplied id (e.g. community_applications.id)
 * @param {string} submission.communityId
 * @param {object} submission.formFields — { homeowner_name, homeowner_email, property_address, request_summary, ... }
 * @param {Array} submission.files — [{ fileId, buffer, mimeType, originalName }]
 * @param {object} [opts]
 * @param {object} [opts.logger=console]
 * @param {boolean} [opts.persist=true] — write to application_extractions on success
 * @param {string} [opts.triggeredBy='submit']
 * @returns {Promise<{ application, validation, persistResult }>}
 */
async function extractApplication(submission, opts = {}) {
  const logger = opts.logger || console;
  const persist = opts.persist !== false;
  const triggeredBy = opts.triggeredBy || 'submit';
  const t0 = Date.now();

  if (!submission || !submission.applicationId || !submission.communityId) {
    throw new Error('extractApplication: applicationId and communityId required');
  }

  const files = Array.isArray(submission.files) ? submission.files : [];
  const formFields = submission.formFields || {};

  logger.log(`[extract_application ${submission.applicationId}] starting Pass A on ${files.length} files`);

  // ---- Pass A: per-file classify + extract (parallel) ----
  const classifiedDocs = await Promise.all(files.map((f) => runPassAForFile(f, { logger })));

  logger.log(`[extract_application ${submission.applicationId}] Pass A done; classifications: ${classifiedDocs.map((d) => d.documentType).join(', ')}`);

  // ---- Reconcile address → unit_id ----
  // Address used: form's property_address, fallback to first detected application_form's property_address
  let submittedAddress = formFields.property_address;
  if (!submittedAddress) {
    const formDoc = classifiedDocs.find((d) => d.documentType === 'application_form');
    submittedAddress = formDoc?.extracted?.property_address || null;
  }
  // If still nothing, try the survey
  if (!submittedAddress) {
    const survey = classifiedDocs.find((d) => d.documentType === 'survey_plot_plan');
    submittedAddress = survey?.extracted?.property_street_address || null;
  }
  const unitReconciliation = await reconcileUnit({
    submittedAddress, communityId: submission.communityId,
  }, { logger });
  logger.log(`[extract_application ${submission.applicationId}] reconcile: ${unitReconciliation.unitMatchStatus} (addr="${submittedAddress || ''}")`);

  // ---- Pass B: normalize + merge ----
  const application = normalizeAndMerge({
    formFields,
    classifiedDocs,
    fileMeta: files.map((f) => ({ fileId: f.fileId || f.id, originalName: f.originalName, mimeType: f.mimeType })),
    unitReconciliation,
    applicationId: submission.applicationId,
    communityId: submission.communityId,
  });

  // ---- Validate the strict schema ----
  const validation = validateApplication(application);
  if (!validation.ok) {
    logger.warn(`[extract_application ${submission.applicationId}] schema validation errors: ${validation.errors.join('; ')}`);
  }

  // ---- Persist (optional) ----
  let persistResult = null;
  if (persist) {
    try {
      const blockFlagCount = application.validationFlags.filter((f) => f.severity === 'block').length;
      const warnFlagCount = application.validationFlags.filter((f) => f.severity === 'warn').length;
      const aggregateUsage = classifiedDocs.reduce((acc, d) => {
        if (d.usage?.classify) {
          acc.input += d.usage.classify.input_tokens || 0;
          acc.output += d.usage.classify.output_tokens || 0;
        }
        if (d.usage?.extract) {
          acc.input += d.usage.extract.input_tokens || 0;
          acc.output += d.usage.extract.output_tokens || 0;
        }
        return acc;
      }, { input: 0, output: 0 });

      const { data, error } = await supabase
        .from('application_extractions')
        .insert({
          application_id: submission.applicationId,
          community_id: submission.communityId,
          application_json: application,
          request_type: application.request.requestType.value,
          unit_match_status: application.unitMatchStatus,
          extraction_confidence: application.extractionConfidence,
          ready_for_evaluation: application.readyForEvaluation,
          validation_flags: application.validationFlags,
          block_flag_count: blockFlagCount,
          warn_flag_count: warnFlagCount,
          attachments_present: application.attachmentsPresent,
          ai_model: 'claude-haiku-4-5 (classify) + claude-sonnet-4-5 (extract)',
          ai_total_input_tokens: aggregateUsage.input,
          ai_total_output_tokens: aggregateUsage.output,
          ai_total_duration_ms: Date.now() - t0,
          documents_processed: classifiedDocs.length,
          triggered_by: triggeredBy,
          extractor_version: EXTRACTOR_VERSION,
        })
        .select('id')
        .single();
      if (error) {
        logger.warn(`[extract_application ${submission.applicationId}] persist failed: ${error.message}`);
      }
      persistResult = { extraction_id: data?.id, error: error?.message };
    } catch (err) {
      logger.warn(`[extract_application ${submission.applicationId}] persist threw: ${err.message}`);
      persistResult = { extraction_id: null, error: err.message };
    }
  }

  logger.log(`[extract_application ${submission.applicationId}] done in ${Date.now() - t0}ms; readyForEvaluation=${application.readyForEvaluation}; flags=${application.validationFlags.length} (${application.validationFlags.filter((f) => f.severity === 'block').length} block)`);

  return { application, validation, persistResult };
}

module.exports = {
  extractApplication,
  // Re-exports for downstream consumption
  classifyDocument,
  extractDocument,
  normalizeAndMerge,
  reconcileUnit,
  validateApplication,
  EXTRACTOR_VERSION,
};
