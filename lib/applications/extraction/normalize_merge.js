// ============================================================================
// lib/applications/extraction/normalize_merge.js
// ----------------------------------------------------------------------------
// Pass B — combine the Pass A intermediates + form fields into the strict
// `Application` schema. Resolves request_type from controlled vocabulary.
// Routes spec extraction through order_summary + contractor_estimate ONLY
// (never brochure). Surfaces validation flags for missing/low-confidence/
// inconsistent data.
//
// Pure function (no Claude calls, no DB). Takes:
//   { formFields, classifiedDocs, fileMeta, unitReconciliation,
//     applicationId, communityId }
// Returns: the strict Application object.
// ============================================================================

const {
  DOCUMENT_TYPES, REQUEST_TYPES, FLAG_CODES,
  makeField, makeProvenance, makeFlag,
} = require('./schema');

// Confidence threshold below which we raise LOW_CONFIDENCE
const LOW_CONFIDENCE_THRESHOLD = 0.55;

// ---------------------------------------------------------------------------
// requestType inference — rule-based, fast + deterministic
// ---------------------------------------------------------------------------
function inferRequestType(formText, classifiedDocs) {
  const sources = [formText || ''];
  for (const d of classifiedDocs) {
    if (d.documentType === 'application_form') {
      const e = d.extracted || {};
      sources.push(e.request_summary || '');
    }
  }
  const blob = sources.join(' ').toLowerCase();
  const hasWindow = /\bwindow/.test(blob);
  const hasDoor = /\bdoor/.test(blob);
  const hasRoof = /\broof|shingle/.test(blob);
  const hasPatio = /\bpatio|pergola|cover\b/.test(blob);
  const hasFence = /\bfence/.test(blob);
  const hasTree = /\btree|landscape/.test(blob);
  const hasPaint = /\bpaint|siding|stain\b/.test(blob);

  if (hasWindow && hasDoor) return 'window_and_door_replacement';
  if (hasWindow) return 'window_replacement';
  if (hasDoor) return 'door_replacement';
  if (hasRoof) return 'roof_replacement';
  if (hasPatio) return 'patio_or_cover';
  if (hasFence) return 'fence';
  if (hasTree) return 'tree_removal_or_replacement';
  if (hasPaint) return 'paint_or_siding';
  return 'other';
}

// ---------------------------------------------------------------------------
// Pull a field with provenance from the first doc that has it
// ---------------------------------------------------------------------------
function firstFieldFromDocs(classifiedDocs, docType, fieldKey, fileMeta) {
  for (const d of classifiedDocs) {
    if (d.documentType !== docType) continue;
    const value = d.extracted?.[fieldKey];
    if (value != null && value !== '') {
      return makeField(String(value).trim(), makeProvenance(d.fileId, d.extracted?._provenance?.page_seen || 1, d.documentConfidence));
    }
  }
  return makeField(null, makeProvenance(null, null, 0));
}

// ---------------------------------------------------------------------------
// Build SpecLineItem[] — ONLY from order_summary / contractor_estimate
// ---------------------------------------------------------------------------
function buildSpecs(classifiedDocs) {
  const specs = [];
  let foundInBrochureOnly = false; // tracking for SPECS_FROM_BROCHURE_BLOCKED

  for (const d of classifiedDocs) {
    if (d.documentType === 'order_summary') {
      const lines = d.extracted?.line_items || [];
      for (const li of lines) {
        if (!li) continue;
        const page = d.extracted?._provenance?.page_seen || 1;
        const baseProv = (conf) => makeProvenance(d.fileId, page, conf ?? d.documentConfidence ?? 0.8);
        specs.push({
          itemType: String(li.item_type || 'unknown_item'),
          location: makeField(li.location_on_property || null, baseProv()),
          dimensions: makeField(li.dimensions_as_stated || null, baseProv()),
          exteriorColor: makeField(li.exterior_color || null, baseProv()),
          material: makeField(li.material || null, baseProv()),
          finishOrStyle: makeField(li.glass_type_or_grille || li.interior_color || null, baseProv()),
          raw: makeField(li.raw_line || '', baseProv()),
        });
      }
    } else if (d.documentType === 'contractor_estimate') {
      // Contractor estimates have less-structured line items — surface them
      // but mark with lower confidence than order_summary if order_summary also exists
      const lines = d.extracted?.line_items || [];
      const orderSummaryExists = classifiedDocs.some((x) => x.documentType === 'order_summary');
      for (const li of lines) {
        if (!li) continue;
        const page = d.extracted?._provenance?.page_seen || 1;
        const baseProv = makeProvenance(d.fileId, page, orderSummaryExists ? 0.5 : 0.7);
        // Estimates describe scope (e.g., "Concrete Slab (14'x12'x5\")") — try
        // to surface as a spec even without color/material if it's a build item
        specs.push({
          itemType: String(li.description || '').slice(0, 64),
          location: makeField(null, baseProv),
          dimensions: makeField(li.description || null, baseProv),
          exteriorColor: makeField(null, baseProv),
          material: makeField(null, baseProv),
          finishOrStyle: makeField(null, baseProv),
          raw: makeField(li.description || '', baseProv),
        });
      }
    } else if (d.documentType === 'product_brochure') {
      // Brochure cannot source specs. Track only — block flag if these were
      // the only source.
      foundInBrochureOnly = true;
    }
  }

  // If we found a brochure but no other source of specs, brochureOnly stands
  if (foundInBrochureOnly && specs.length === 0) {
    return { specs: [], brochureOnly: true };
  }
  return { specs, brochureOnly: false };
}

// ---------------------------------------------------------------------------
// Aggregate existing/proposed condition summaries
// ---------------------------------------------------------------------------
function aggregateConditionSummaries(classifiedDocs, sourceType, fieldName) {
  const parts = [];
  let firstProv = null;
  for (const d of classifiedDocs) {
    if (d.documentType !== sourceType) continue;
    const val = d.extracted?.[fieldName];
    if (val && String(val).trim()) {
      parts.push(String(val).trim());
      if (!firstProv) firstProv = makeProvenance(d.fileId, d.extracted?._provenance?.page_seen || 1, d.documentConfidence);
    }
  }
  if (parts.length === 0) return makeField(null, makeProvenance(null, null, 0));
  return makeField(parts.join('; '), firstProv);
}

// ---------------------------------------------------------------------------
// Implausibility checks on dates
// ---------------------------------------------------------------------------
function checkDates(startField, completionField, flags) {
  const s = startField?.value;
  const c = completionField?.value;
  if (s && c) {
    if (String(s).trim() === String(c).trim()) {
      flags.push(makeFlag('IMPLAUSIBLE_DATES', 'warn',
        `project_start and project_completion are identical (${s})`,
        { field: 'dates.projectCompletion' }));
    } else {
      // Try to compare as dates
      const sd = Date.parse(s);
      const cd = Date.parse(c);
      if (!isNaN(sd) && !isNaN(cd) && cd < sd) {
        flags.push(makeFlag('IMPLAUSIBLE_DATES', 'warn',
          `project_completion (${c}) is before project_start (${s})`,
          { field: 'dates.projectCompletion' }));
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Main entry: normalize + merge
// ---------------------------------------------------------------------------
/**
 * @param {object} args
 * @param {object} args.formFields — raw form fields from portal submission
 * @param {Array} args.classifiedDocs — Pass A intermediates: [{ fileId, documentType, documentConfidence, extracted, error?, pageCount }]
 * @param {Array} args.fileMeta — [{ fileId, originalName, mimeType, pages }]
 * @param {object} args.unitReconciliation — { unitMatchStatus, unitId, addressOfRecord }
 * @param {string} args.applicationId
 * @param {string} args.communityId
 * @returns {object} Application
 */
function normalizeAndMerge({
  formFields = {},
  classifiedDocs = [],
  fileMeta = [],
  unitReconciliation = { unitMatchStatus: 'not_found', unitId: null, addressOfRecord: null },
  applicationId,
  communityId,
}) {
  const flags = [];

  // ---- Form-sourced fields (preferred) ----
  const formProv = makeProvenance(null, null, 1.0); // form fields are user-submitted, max confidence
  const homeowner = {
    name: formFields.homeowner_name
      ? makeField(formFields.homeowner_name, formProv)
      : firstFieldFromDocs(classifiedDocs, 'application_form', 'homeowner_name', fileMeta),
    email: formFields.homeowner_email
      ? makeField(formFields.homeowner_email, formProv)
      : firstFieldFromDocs(classifiedDocs, 'application_form', 'homeowner_email', fileMeta),
    phone: formFields.homeowner_phone
      ? makeField(formFields.homeowner_phone, formProv)
      : firstFieldFromDocs(classifiedDocs, 'application_form', 'homeowner_phone', fileMeta),
    addressAsSubmitted: formFields.property_address
      ? makeField(formFields.property_address, formProv)
      : firstFieldFromDocs(classifiedDocs, 'application_form', 'property_address', fileMeta),
    addressOfRecord: unitReconciliation.addressOfRecord || null,
  };

  // unitId
  const unitId = unitReconciliation.unitId
    ? makeField(unitReconciliation.unitId, makeProvenance(null, null, 0.95))
    : makeField(null, makeProvenance(null, null, 0));

  // Request type + description
  const requestType = inferRequestType(formFields.request_summary, classifiedDocs);
  const requestTypeField = makeField(
    REQUEST_TYPES.has(requestType) ? requestType : 'other',
    makeProvenance(null, null, requestType === 'other' ? 0.5 : 0.9)
  );
  const description = formFields.request_summary
    ? makeField(formFields.request_summary, formProv)
    : firstFieldFromDocs(classifiedDocs, 'application_form', 'request_summary', fileMeta);

  // Specs — ONLY from order_summary + contractor_estimate
  const { specs, brochureOnly } = buildSpecs(classifiedDocs);
  if (brochureOnly) {
    flags.push(makeFlag('SPECS_FROM_BROCHURE_BLOCKED', 'block',
      'The only source for spec values in this packet is a product_brochure. Brochures show every option, not the items ordered. Specs blocked until an order_summary or contractor_estimate is provided.'));
  }

  // Existing / proposed condition
  const existingCondition = aggregateConditionSummaries(classifiedDocs, 'property_photo', 'existing_condition_summary');
  const proposedCondition = aggregateConditionSummaries(classifiedDocs, 'elevation_or_rendering', 'proposed_condition_summary');

  // Dates
  const dates = {
    submittedAt: formFields.submitted_at
      ? makeField(formFields.submitted_at, formProv)
      : makeField(new Date().toISOString(), makeProvenance(null, null, 0.9)),
    projectStart: formFields.project_start_date
      ? makeField(formFields.project_start_date, formProv)
      : firstFieldFromDocs(classifiedDocs, 'application_form', 'project_start_date', fileMeta),
    projectCompletion: formFields.project_completion_date
      ? makeField(formFields.project_completion_date, formProv)
      : firstFieldFromDocs(classifiedDocs, 'application_form', 'project_completion_date', fileMeta),
  };
  checkDates(dates.projectStart, dates.projectCompletion, flags);

  // attachmentsPresent
  const presentTypes = new Set(classifiedDocs.filter((d) => !d.error).map((d) => d.documentType));
  const attachmentsPresent = {};
  for (const dt of DOCUMENT_TYPES) attachmentsPresent[dt] = presentTypes.has(dt);

  // documents array (audit blob)
  const documents = classifiedDocs.map((d) => ({
    documentType: d.documentType,
    sourceFileId: d.fileId,
    pages: d.pageCount || 1,
    extracted: d.extracted || {},
    confidence: typeof d.documentConfidence === 'number' ? d.documentConfidence : 0,
  }));

  // ---- Flags: unit reconciliation ----
  if (unitReconciliation.unitMatchStatus === 'mismatch') {
    flags.push(makeFlag('UNIT_ID_MISMATCH', 'block',
      'Submitted address matches a unit in a DIFFERENT community than the one this application is filed under. Reconcile before evaluation.',
      { field: 'unitId' }));
  } else if (unitReconciliation.unitMatchStatus === 'not_found') {
    flags.push(makeFlag('UNIT_NOT_FOUND', 'block',
      'Submitted address could not be matched to any active unit in community_addresses. Verify the address or add it to the community roster.',
      { field: 'unitId' }));
  }

  // ---- Flags: file-level errors ----
  for (const d of classifiedDocs) {
    if (d.error) {
      flags.push(makeFlag('UNREADABLE_FILE', 'warn',
        `File could not be processed: ${d.error}${d.errorMessage ? ' — ' + d.errorMessage : ''}`,
        { provenance: makeProvenance(d.fileId, null, 0) }));
    }
    if (d.documentType === 'unknown' && !d.error) {
      flags.push(makeFlag('CLASSIFICATION_UNCERTAIN', 'info',
        `Document classified as unknown (confidence: ${d.documentConfidence?.toFixed(2)}).`,
        { provenance: makeProvenance(d.fileId, null, d.documentConfidence) }));
    }
  }

  // ---- Flags: missing critical fields ----
  if (!homeowner.name.value) flags.push(makeFlag('MISSING_FIELD', 'warn', 'homeowner.name missing', { field: 'homeowner.name' }));
  if (!homeowner.email.value && !homeowner.phone.value) {
    flags.push(makeFlag('MISSING_FIELD', 'warn', 'no contact channel (email AND phone both missing)', { field: 'homeowner' }));
  }
  if (!description.value) {
    flags.push(makeFlag('MISSING_FIELD', 'warn', 'request.description missing — no homeowner explanation of project', { field: 'request.description' }));
  }
  if (classifiedDocs.length === 0) {
    flags.push(makeFlag('EMPTY_SUBMISSION', 'block', 'No files attached and form fields produced no application content.'));
  }

  // ---- Flags: low confidence on populated fields ----
  for (const [path, f] of [
    ['homeowner.name', homeowner.name],
    ['homeowner.email', homeowner.email],
    ['homeowner.phone', homeowner.phone],
    ['homeowner.addressAsSubmitted', homeowner.addressAsSubmitted],
    ['request.requestType', requestTypeField],
    ['request.description', description],
  ]) {
    if (f.value != null && f.provenance.confidence < LOW_CONFIDENCE_THRESHOLD) {
      flags.push(makeFlag('LOW_CONFIDENCE', 'info', `${path} extracted with low confidence (${f.provenance.confidence.toFixed(2)})`, { field: path, provenance: f.provenance }));
    }
  }

  // ---- Overall confidence + ready-for-evaluation gate ----
  const allConfidences = [
    homeowner.name.provenance.confidence,
    homeowner.email.provenance.confidence,
    requestTypeField.provenance.confidence,
    ...documents.map((d) => d.confidence || 0),
  ].filter((x) => typeof x === 'number');
  const extractionConfidence = allConfidences.length > 0
    ? allConfidences.reduce((s, x) => s + x, 0) / allConfidences.length
    : 0;

  const hasBlock = flags.some((f) => f.severity === 'block');
  const readyForEvaluation = !hasBlock;

  return {
    applicationId,
    communityId,
    unitId,
    unitMatchStatus: unitReconciliation.unitMatchStatus,
    homeowner,
    request: {
      requestType: requestTypeField,
      description,
      specs,
      existingCondition,
      proposedCondition,
    },
    dates,
    attachmentsPresent,
    documents,
    validationFlags: flags,
    extractionConfidence: Number(extractionConfidence.toFixed(3)),
    readyForEvaluation,
  };
}

module.exports = { normalizeAndMerge, inferRequestType };
