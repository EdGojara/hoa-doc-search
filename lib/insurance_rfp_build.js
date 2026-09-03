// ============================================================================
// lib/insurance_rfp_build.js  (Ed 2026-09-03)
// ----------------------------------------------------------------------------
// One place that turns a community's FILED insurance program (the policy of
// record) into a finished, Bedrock-branded RFP PDF a broker can quote from —
// with the completeness guard in front of it.
//
// Extracted so BOTH the admin "Generate RFP" endpoint AND Amanda (when a staffer
// emails amanda@ asking her to prepare an RFP) build the RFP the same way and
// hit the same guard. The guard refuses to render a program that's missing a
// carried line (the Waterview scar): callers get { ok:false, completeness } and
// tell the requester what's missing instead of sending half a program.
//
//   buildCommunityRfp({ supabase, communityId, opts }) ->
//     { ok, completeness, pdfBuffer?, filename?, program, community }
// ============================================================================

const { renderInsuranceRfpHTML, normalizeInsuranceProgram } = require('./insurance_rfp');
const { validateProgramCompleteness } = require('./insurance_rfp_validate');

function centsToStr(c) {
  if (c == null) return null;
  const n = Number(c) / 100;
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: c % 100 ? 2 : 0, maximumFractionDigits: 2 });
}

// Stored program + policy rows -> the shape lib/insurance_rfp expects.
function dbToRendererProgram(program, policies) {
  const entity = (program.entity && Object.keys(program.entity).length) ? program.entity : {
    named_insured: program.named_insured, mailing_address: program.mailing_address,
    property_location: program.property_location, association_type: program.association_type,
    units_or_lots: program.units_or_lots,
  };
  return {
    entity,
    coverages: (policies || []).map((p) => ({
      line: p.coverage_line, carrier: p.carrier, policy_number: p.policy_number,
      effective_date: p.effective_date, expiration_date: p.expiration_date,
      limits: p.limits || [], deductibles: p.deductibles || [], key_terms: p.key_terms || [],
      annual_premium: centsToStr(p.annual_premium_cents),
    })),
    statement_of_values: program.statement_of_values || [],
    notes: program.notes || [],
  };
}

async function htmlToPdfBuffer(html) {
  const puppeteer = require('puppeteer');
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });
  try {
    const page = await browser.newPage();
    try { await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 20000 }); } catch (_) {}
    return Buffer.from(await page.pdf({ format: 'Letter', printBackground: true, margin: { top: 0, right: 0, bottom: 0, left: 0 }, preferCSSPageSize: true }));
  } finally { try { await browser.close(); } catch (_) {} }
}

// Fetch the active program for a community and, unless requireComplete is false,
// run the completeness guard. Returns { ok, completeness, program, ... } — and a
// pdfBuffer only when ok (or when the caller opts out of the guard).
async function buildCommunityRfp({ supabase, communityId, opts = {}, requireComplete = true, render = true }) {
  const { data: comm } = await supabase.from('communities').select('id, name').eq('id', communityId).maybeSingle();
  const communityName = comm ? comm.name : (opts.community || '');

  const { data: programs } = await supabase.from('insurance_programs')
    .select('*').eq('community_id', communityId)
    .order('policy_period_start', { ascending: false, nullsFirst: false })
    .order('created_at', { ascending: false }).limit(5);
  const active = (programs || []).find((p) => p.status === 'active') || (programs || [])[0] || null;
  if (!active) {
    return { ok: false, no_program: true, completeness: null, program: null, community: communityName };
  }

  const { data: policies } = await supabase.from('insurance_policies').select('*')
    .eq('program_id', active.id).order('sort_order', { ascending: true, nullsFirst: false }).limit(100);

  let sourceNames = [];
  const srcIds = Array.isArray(active.source_document_ids) ? active.source_document_ids : [];
  if (srcIds.length) {
    const { data: srcDocs } = await supabase.from('library_documents')
      .select('file_name_original, title').in('id', srcIds);
    sourceNames = (srcDocs || []).map((d) => (d && (d.file_name_original || d.title)) || '');
  }

  const program = normalizeInsuranceProgram(dbToRendererProgram(active, policies || []));
  const completeness = validateProgramCompleteness(program, sourceNames);

  if (!completeness.ok && requireComplete) {
    return { ok: false, completeness, program, community: communityName, programRow: active };
  }
  if (!render) {
    return { ok: true, completeness, program, community: communityName, programRow: active };
  }

  const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'America/Chicago' });
  const html = renderInsuranceRfpHTML(program, { community: communityName, rfpDate: today, ...opts });
  const pdfBuffer = await htmlToPdfBuffer(html);
  const filename = `${(communityName || 'Community').replace(/[^a-zA-Z0-9]+/g, '_')}_Insurance_RFP.pdf`;
  return { ok: true, completeness, pdfBuffer, filename, program, community: communityName, programRow: active };
}

module.exports = { buildCommunityRfp, dbToRendererProgram, htmlToPdfBuffer, centsToStr };
