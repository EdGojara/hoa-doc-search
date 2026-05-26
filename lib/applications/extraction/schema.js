// ============================================================================
// lib/applications/extraction/schema.js
// ----------------------------------------------------------------------------
// Runtime validator for the typed Application object produced by
// extractApplication(). Hand-rolled (no zod dep) but matches the spec from
// brief 01 byte-for-byte. The validator is strict — a malformed object can
// never reach the rules engine.
//
// Use:
//   const { validateApplication, makeField } = require('./schema');
//   const { ok, errors } = validateApplication(app);
//   if (!ok) throw new Error('Application invalid: ' + errors.join(';'));
// ============================================================================

const DOCUMENT_TYPES = new Set([
  'application_form',
  'survey_plot_plan',
  'order_summary',
  'contractor_estimate',
  'product_brochure',
  'property_photo',
  'elevation_or_rendering',
  'unknown',
]);

const REQUEST_TYPES = new Set([
  'window_replacement',
  'door_replacement',
  'window_and_door_replacement',
  'roof_replacement',
  'patio_or_cover',
  'fence',
  'tree_removal_or_replacement',
  'paint_or_siding',
  'other',
]);

const UNIT_MATCH_STATUSES = new Set(['matched', 'mismatch', 'not_found']);
const FLAG_SEVERITIES = new Set(['block', 'warn', 'info']);

// Standard validation flag codes — the rules engine reads these enum values.
// Add new codes here (and document the meaning) — never invent ad-hoc strings.
const FLAG_CODES = new Set([
  'UNIT_ID_MISMATCH',
  'UNIT_NOT_FOUND',
  'MISSING_FIELD',
  'LOW_CONFIDENCE',
  'IMPLAUSIBLE_DATES',
  'UNREADABLE_FILE',
  'SPECS_FROM_BROCHURE_BLOCKED',
  'CLASSIFICATION_UNCERTAIN',
  'CONFLICTING_SOURCES',
  'EMPTY_SUBMISSION',
]);

/** Build a `Field<T>` per the spec — value + provenance. */
function makeField(value, provenance) {
  return {
    value: value === undefined ? null : value,
    provenance: provenance || { sourceFileId: null, page: null, confidence: 0 },
  };
}

/** Build a `Provenance` record. */
function makeProvenance(sourceFileId, page, confidence) {
  return {
    sourceFileId: sourceFileId || null,
    page: typeof page === 'number' ? page : null,
    confidence: typeof confidence === 'number' ? Math.max(0, Math.min(1, confidence)) : 0,
  };
}

function makeFlag(code, severity, message, opts = {}) {
  if (!FLAG_CODES.has(code)) throw new Error(`Unknown flag code: ${code}`);
  if (!FLAG_SEVERITIES.has(severity)) throw new Error(`Unknown flag severity: ${severity}`);
  return {
    code,
    severity,
    message: String(message || ''),
    field: opts.field || undefined,
    provenance: opts.provenance || undefined,
  };
}

// ---------------------------------------------------------------------------
// Validator — returns { ok: boolean, errors: string[] }
// ---------------------------------------------------------------------------

function isObject(x) { return x !== null && typeof x === 'object' && !Array.isArray(x); }
function isString(x) { return typeof x === 'string'; }
function isBool(x) { return typeof x === 'boolean'; }
function isNumber(x) { return typeof x === 'number' && !Number.isNaN(x); }

function validateProvenance(p, ctx, errors) {
  if (!isObject(p)) { errors.push(`${ctx} provenance not an object`); return; }
  if (p.sourceFileId !== null && !isString(p.sourceFileId)) errors.push(`${ctx}.provenance.sourceFileId must be string|null`);
  if (p.page !== null && !isNumber(p.page)) errors.push(`${ctx}.provenance.page must be number|null`);
  if (!isNumber(p.confidence) || p.confidence < 0 || p.confidence > 1) errors.push(`${ctx}.provenance.confidence must be 0..1`);
}

function validateField(f, ctx, errors, valueValidator) {
  if (!isObject(f)) { errors.push(`${ctx} not an object Field`); return; }
  if (f.value !== null && valueValidator) valueValidator(f.value, ctx + '.value', errors);
  validateProvenance(f.provenance, ctx, errors);
}

function validateSpecLineItem(s, ctx, errors) {
  if (!isObject(s)) { errors.push(`${ctx} spec line not an object`); return; }
  if (!isString(s.itemType)) errors.push(`${ctx}.itemType not a string`);
  ['location', 'dimensions', 'exteriorColor', 'material', 'finishOrStyle', 'raw'].forEach((k) => {
    validateField(s[k], `${ctx}.${k}`, errors, (v, c, e) => { if (!isString(v)) e.push(`${c} not a string`); });
  });
}

function validateFlag(f, ctx, errors) {
  if (!isObject(f)) { errors.push(`${ctx} flag not an object`); return; }
  if (!FLAG_CODES.has(f.code)) errors.push(`${ctx}.code "${f.code}" not in allowed set`);
  if (!FLAG_SEVERITIES.has(f.severity)) errors.push(`${ctx}.severity "${f.severity}" not in allowed set`);
  if (!isString(f.message)) errors.push(`${ctx}.message not a string`);
  if (f.field !== undefined && !isString(f.field)) errors.push(`${ctx}.field must be string or omitted`);
  if (f.provenance !== undefined) validateProvenance(f.provenance, ctx, errors);
}

/**
 * Validate an Application object. Returns { ok, errors }.
 */
function validateApplication(app) {
  const errors = [];
  if (!isObject(app)) return { ok: false, errors: ['app is not an object'] };

  // Top-level identifiers
  if (!isString(app.applicationId)) errors.push('applicationId must be string');
  if (!isString(app.communityId)) errors.push('communityId must be string');

  validateField(app.unitId, 'unitId', errors, (v, c, e) => { if (!isString(v)) e.push(`${c} not a string`); });
  if (!UNIT_MATCH_STATUSES.has(app.unitMatchStatus)) errors.push(`unitMatchStatus "${app.unitMatchStatus}" not in allowed set`);

  // Homeowner block
  if (!isObject(app.homeowner)) errors.push('homeowner must be an object');
  else {
    ['name', 'email', 'phone', 'addressAsSubmitted'].forEach((k) => {
      validateField(app.homeowner[k], `homeowner.${k}`, errors,
        (v, c, e) => { if (!isString(v)) e.push(`${c} not a string`); });
    });
    if (app.homeowner.addressOfRecord !== null && !isString(app.homeowner.addressOfRecord)) {
      errors.push('homeowner.addressOfRecord must be string|null');
    }
  }

  // Request block
  if (!isObject(app.request)) errors.push('request must be an object');
  else {
    validateField(app.request.requestType, 'request.requestType', errors,
      (v, c, e) => { if (!REQUEST_TYPES.has(v)) e.push(`${c} "${v}" not in allowed set`); });
    validateField(app.request.description, 'request.description', errors,
      (v, c, e) => { if (!isString(v)) e.push(`${c} not a string`); });
    validateField(app.request.existingCondition, 'request.existingCondition', errors,
      (v, c, e) => { if (!isString(v)) e.push(`${c} not a string`); });
    validateField(app.request.proposedCondition, 'request.proposedCondition', errors,
      (v, c, e) => { if (!isString(v)) e.push(`${c} not a string`); });
    if (!Array.isArray(app.request.specs)) errors.push('request.specs must be an array');
    else app.request.specs.forEach((s, i) => validateSpecLineItem(s, `request.specs[${i}]`, errors));
  }

  // Dates block
  if (!isObject(app.dates)) errors.push('dates must be an object');
  else {
    ['submittedAt', 'projectStart', 'projectCompletion'].forEach((k) => {
      validateField(app.dates[k], `dates.${k}`, errors,
        (v, c, e) => { if (!isString(v)) e.push(`${c} not a string`); });
    });
  }

  // attachmentsPresent — Record<DocumentType, boolean>
  if (!isObject(app.attachmentsPresent)) errors.push('attachmentsPresent must be an object');
  else {
    for (const dt of DOCUMENT_TYPES) {
      if (!(dt in app.attachmentsPresent)) errors.push(`attachmentsPresent missing key ${dt}`);
      else if (!isBool(app.attachmentsPresent[dt])) errors.push(`attachmentsPresent.${dt} not a boolean`);
    }
  }

  // documents — Array
  if (!Array.isArray(app.documents)) errors.push('documents must be an array');
  else app.documents.forEach((d, i) => {
    if (!DOCUMENT_TYPES.has(d.documentType)) errors.push(`documents[${i}].documentType "${d.documentType}" not in allowed set`);
    if (!isString(d.sourceFileId)) errors.push(`documents[${i}].sourceFileId must be string`);
    if (!isNumber(d.pages)) errors.push(`documents[${i}].pages must be number`);
    if (!isObject(d.extracted)) errors.push(`documents[${i}].extracted must be an object`);
    if (!isNumber(d.confidence) || d.confidence < 0 || d.confidence > 1) errors.push(`documents[${i}].confidence must be 0..1`);
  });

  // Validation flags
  if (!Array.isArray(app.validationFlags)) errors.push('validationFlags must be an array');
  else app.validationFlags.forEach((f, i) => validateFlag(f, `validationFlags[${i}]`, errors));

  // Final flags
  if (!isNumber(app.extractionConfidence) || app.extractionConfidence < 0 || app.extractionConfidence > 1) {
    errors.push('extractionConfidence must be 0..1');
  }
  if (!isBool(app.readyForEvaluation)) errors.push('readyForEvaluation must be boolean');

  // Cross-field invariants
  if (Array.isArray(app.validationFlags)) {
    const hasBlock = app.validationFlags.some((f) => f && f.severity === 'block');
    if (hasBlock && app.readyForEvaluation === true) {
      errors.push('readyForEvaluation must be false when any block-severity flag is present');
    }
  }

  return { ok: errors.length === 0, errors };
}

module.exports = {
  DOCUMENT_TYPES,
  REQUEST_TYPES,
  UNIT_MATCH_STATUSES,
  FLAG_SEVERITIES,
  FLAG_CODES,
  makeField,
  makeProvenance,
  makeFlag,
  validateApplication,
};
