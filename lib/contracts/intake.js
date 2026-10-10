// ============================================================================
// lib/contracts/intake.js  (Ed 2026-10-10, Financial Intelligence slice 1)
// ----------------------------------------------------------------------------
// Executed-contract evidence pipeline. The architecture is the full path; today
// only the MANUAL attach path is wired, and email intake is a stub:
//
//   email event -> document classification -> contract extraction
//     -> likely-executed determination -> human verification if required
//     -> contract record (vendor_contracts) -> forecast driver
//
// Stage contracts (each is replaceable without touching the others):
//   onEmailEvent(message)             STUB: returns the plan, writes nothing
//   classifyDocument(file)            STUB for email; manual attach is already a contract
//   extract(file)                     lib/accounting/vendor_contract_extractor.js (copied-as-written terms)
//   determineExecution(extraction)    deterministic, machine-only: at most likely_executed
//   contractRecord(...)               the vendor_contracts row (migration 506 columns)
//   verify(...)                       a NAMED PERSON, against the exact document hash
//                                     (verify_vendor_contract(), migration 506)
//
// A machine never reaches verified_executed: signatures on a page are evidence,
// not a legal conclusion.
// ============================================================================

const crypto = require('crypto');

// Machine execution triage. Scores are a review priority, not a legal finding.
function determineExecution(extraction) {
  const sig = (extraction && extraction.signatures) || null;
  const warnings = (extraction && extraction.warnings) || [];
  let status = 'detected', score = 0.2, reason;
  if (!sig) reason = 'No signature information could be read from the document.';
  else if (sig.association_signed && sig.vendor_signed && sig.association_signed_date && sig.vendor_signed_date) {
    status = 'likely_executed'; score = 0.85;
    reason = `Signature blocks for both parties appear signed and dated (association ${sig.association_signer || 'signer not named'} ${sig.association_signed_date}; vendor ${sig.vendor_signer || 'signer not named'} ${sig.vendor_signed_date}). Machine-read; needs human verification.`;
  } else if (sig.association_signed && sig.vendor_signed) {
    status = 'likely_executed'; score = 0.7; reason = 'Both parties appear to have signed, but at least one signature is undated. Machine-read; needs human verification.';
  } else if (sig.association_signed || sig.vendor_signed) {
    score = 0.45; reason = `Only the ${sig.association_signed ? 'association' : 'vendor'} signature appears on the document.`;
  } else reason = 'No signatures appear on the document (a proposal or unsigned copy).';
  if (warnings.length) { score = Math.max(0, Math.round((score - 0.1) * 100) / 100); reason += ` Extraction warnings: ${warnings.join('; ')}`; }
  return { execution_status: status, execution_confidence: score, execution_reason: reason };
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// The vendor_contracts row for a manually attached (or, later, emailed) document.
function contractRecord({ management_company_id, community_id, extraction, file_path, file_hash, file_size_bytes, forecast_account_id = null, forecast_fund_id = null,
  source_message_id = null, source_document_id = null, intake_source = 'upload', actor = null }) {
  const ex = determineExecution(extraction);
  return {
    management_company_id, community_id, vendor_name_raw: extraction.vendor_name || null, service_category: extraction.service_category || 'other', service_description: extraction.service_description || null,
    effective_date: extraction.effective_date, end_date: extraction.end_date, term_months: extraction.term_months,
    total_amount: extraction.total_amount || null, annualized_amount: extraction.annual_amount || null,
    escalator_kind: extraction.escalator_kind || 'none', escalator_pct: extraction.escalator_pct, payment_terms: extraction.payment_terms, auto_renews: !!extraction.auto_renews, renewal_notice_days: extraction.renewal_notice_days,
    signatories: extraction.signatures || null,
    periodic_amount: extraction.periodic_amount, periodic_frequency: extraction.periodic_frequency, rate_schedule: extraction.rate_schedule || [], one_time_fees: extraction.one_time_fees || [],
    unit_pricing: extraction.unit_pricing && extraction.unit_pricing.length ? extraction.unit_pricing : null, termination_notice_date: extraction.termination_notice_date,
    extracted_assumptions: [(extraction.warnings || []).length ? `Extraction warnings: ${extraction.warnings.join('; ')}` : null, extraction.term_quotes ? `Term quotes: ${JSON.stringify(extraction.term_quotes)}` : null].filter(Boolean).join('\n') || null,
    extracted_data: extraction, file_path, file_hash, file_size_bytes,
    ...ex, source_message_id, source_document_id, intake_source, forecast_account_id, forecast_fund_id, status: 'active',
    notes: actor ? `Attached by ${actor}` : null,
  };
}

// STUB: the future email detector. It returns what WOULD happen and writes nothing.
function onEmailEvent(message) {
  return {
    stub: true, message_id: (message && message.id) || null,
    plan: ['classify attachments (contract vs invoice vs proposal)', 'extract terms with vendor_contract_extractor', 'determineExecution (machine: at most likely_executed)',
      'record vendor_contracts with source_message_id + attachment hash', 'route to human verification', 'verified contracts feed the working-forecast contract driver'],
    note: 'Email contract intake is not wired yet; attach contracts manually on the working forecast.',
  };
}

module.exports = { determineExecution, contractRecord, onEmailEvent, sha256 };
