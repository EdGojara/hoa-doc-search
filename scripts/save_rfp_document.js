#!/usr/bin/env node
// ============================================================================
// scripts/save_rfp_document.js  (Ed 2026-10-16: vendor-neutral RFP inside trustEd)
// ----------------------------------------------------------------------------
// Writes a structured, vendor-neutral RFP (lib/vendors/rfp_document.js) onto an
// EXISTING RFP / Bid Workflow record: bid_requests.structured_rfp + scope_summary.
// The document is a DRAFT FOR REVIEW. This script never issues it, never sends it,
// never contacts or creates a vendor, never changes bid_requests.status, and never
// touches vendor_proposals.
//
//   node scripts/save_rfp_document.js --plan=scripts/plans/canyon_gate_camera_rfp.json          dry run
//   node scripts/save_rfp_document.js --plan=scripts/plans/canyon_gate_camera_rfp.json --apply  write
//   add --html=<dir> to also write the vendor and Board copies for review (local files only)
//
// Dry run uses a read-only client that throws on any write, and prints the exact
// row, fields and document it would write. Before any write it checks, read-only:
//   - the bid_request exists, belongs to the plan's community, and is not awarded/cancelled
//   - the baseline proposal is on this record, its file hash matches the plan, and its
//     line items are an APPROVED stored version; the camera schedule reconciles to them
//   - the governing instruction email exists with the expected sender, subject and text
//   - the document validates (sections, pricing form, compliance matrix, neutrality,
//     exact decision-state wording)
// Idempotent: the same content already saved is "0 updates, already saved". A saved
// document past draft_for_review (approved to issue, issued, closed) is never overwritten.
// ============================================================================
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const R = require('../lib/vendors/rfp_document');
const { renderRfpHtml } = require('../lib/vendors/rfp_document_render');
const V = require('../lib/vendors/line_item_versions');

function parseArgs(argv) {
  const a = { apply: argv.includes('--apply') };
  for (const x of argv) { const m = x.match(/^--(plan|html)=(.+)$/); if (m) a[m[1]] = m[2]; }
  return a;
}

const must = async (label, query) => { const { data, error } = await query; if (error) throw new Error(`${label} read failed: ${error.message}`); return data; };

/** Read-only gathering of everything the document depends on. */
async function readInputs(db, plan) {
  const br = await must('bid_requests', db.from('bid_requests').select('id, community_id, community, title, status, service_category, structured_rfp, scope_summary, bid_deadline').eq('id', plan.bid_request_id).maybeSingle());
  if (!br) throw new Error(`bid_request ${plan.bid_request_id} not found`);
  const bp = await must('vendor_proposals', db.from('vendor_proposals').select('id, bid_request_id, community_id, file_hash, extracted_data').eq('id', plan.baseline.proposal_id).maybeSingle());
  if (!bp) throw new Error(`baseline proposal ${plan.baseline.proposal_id} not found`);
  const gi = plan.governing_instruction;
  const em = await must('email_messages', db.from('email_messages').select('id, mailbox, sender_email, subject, received_at, community_id, body_full, body_preview').eq('id', gi.email_message_id).maybeSingle());
  return { br, bp, em };
}

/** Pure: checks + the document + the exact patch. */
function planWrite(plan, { br, bp, em }, { now = new Date().toISOString() } = {}) {
  const errors = [];
  if (br.community_id !== plan.community_id) errors.push(`bid_request community ${br.community_id} is not the plan's ${plan.community_id}`);
  if (['awarded', 'cancelled'].includes(br.status)) errors.push(`bid_request status is ${br.status}; an RFP is not drafted onto a closed record`);
  if (bp.bid_request_id !== br.id) errors.push('baseline proposal is not on this RFP record');
  if (bp.file_hash !== plan.baseline.document_sha256) errors.push('baseline proposal file hash does not match the plan');
  const av = V.currentApproved(bp.extracted_data);
  if (!av) errors.push('baseline proposal has no APPROVED stored line-item version');
  const item = av && (av.items || []).find((i) => (i.document || {}).sha256 === plan.baseline.document_sha256);
  if (av && !item) errors.push('approved version has no item for the baseline document');

  // Governing instruction: the email must be what the plan says it is.
  const gi = plan.governing_instruction;
  let governing = null;
  if (!em) errors.push(`governing instruction email ${gi.email_message_id} not found (email ingest is manual; pull the inbox first)`);
  else {
    const body = String(em.body_full || em.body_preview || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
    if (String(em.sender_email || '').toLowerCase() !== gi.expect_sender.toLowerCase()) errors.push(`governing email sender is ${em.sender_email}, expected ${gi.expect_sender}`);
    if (em.subject !== gi.expect_subject) errors.push(`governing email subject is "${em.subject}", expected "${gi.expect_subject}"`);
    if (!body.toLowerCase().includes(gi.expect_text.toLowerCase())) errors.push('governing email text does not contain the expected instruction');
    if (em.community_id && em.community_id !== plan.community_id) errors.push('governing email is filed to a different community');
    governing = { source: 'email_messages', email_message_id: em.id, mailbox: em.mailbox, received_at: em.received_at, from_role: gi.from_role, subject: em.subject, instruction: gi.expect_text, summary: gi.summary };
  }

  const prev = br.structured_rfp && br.structured_rfp.schema === R.SCHEMA ? br.structured_rfp : null;
  if (br.structured_rfp && !prev) errors.push('bid_request already carries a structured_rfp of another shape; not overwritten');
  if (prev && prev.document_status !== 'draft_for_review') errors.push(`saved RFP is ${prev.document_status}; it is never overwritten by a script`);

  const doc = R.buildRfpDocument(plan, { governingInstruction: governing, baselineLineItemVersion: av ? av.version : null, version: prev ? prev.version : 1 });
  const validation = R.validateRfpDocument(doc, { baselineItem: item || null, expectedDecisionState: plan.expected_decision_state });
  errors.push(...validation.errors);

  const unchanged = !!prev && prev.content_sha256 === doc.content_sha256;
  if (prev && !unchanged) doc.version = (prev.version || 1) + 1;
  doc.prepared_at = unchanged ? prev.prepared_at : now;
  doc.audit = [...((prev && prev.audit) || []), ...(unchanged ? [] : [{
    at: now, action: prev ? 'rfp_redrafted' : 'rfp_drafted', version: doc.version, content_sha256: doc.content_sha256, previous_sha256: prev ? prev.content_sha256 : null,
    by: 'scripts/save_rfp_document.js', governing_email_message_id: governing && governing.email_message_id,
    note: 'Draft for Ed and Board review. Not issued, not sent, no company contacted, no award.',
  }])];
  const patch = { structured_rfp: doc, scope_summary: doc.project.summary };
  return { ok: errors.length === 0, errors, warnings: validation.warnings, unchanged, doc, patch, item };
}

function printPlan(res, br) {
  const d = res.doc;
  const line = (k, v) => console.log(`  ${k.padEnd(28)} ${v}`);
  console.log(`\nbid_requests ${br.id} (${br.title}), status ${br.status} (unchanged by this script)`);
  line('fields written', Object.keys(res.patch).join(', '));
  line('document_status', d.document_status);
  line('version', d.version);
  line('content_sha256', d.content_sha256);
  line('governing instruction', d.governing_instruction ? `${d.governing_instruction.email_message_id} ${d.governing_instruction.received_at} "${d.governing_instruction.subject}"` : 'MISSING');
  line('baseline', `${d.baseline.proposal_id} line items v${d.baseline.line_item_version} (pricing not copied)`);
  line('cameras', `${d.camera_totals.total} = ${d.camera_totals.reused} reused + ${d.camera_totals.replacement} replacement + ${d.camera_totals.new} new`);
  for (const [loc, t] of Object.entries(d.camera_totals.by_location)) line(`  ${loc}`, `${t.total} (${t.reused} reused, ${t.replacement} replacement, ${t.new} new)`);
  line('sections', `${d.sections.length}: ${d.sections.map((s) => s.key).join(', ')}`);
  line('compliance requirements', d.compliance_matrix.length);
  line('pricing one-time lines', d.pricing_form.one_time.map((l) => l.key).join(', '));
  line('pricing totals', d.pricing_form.totals.map((l) => l.key).join(', '));
  line('contract package', d.contract_package.map((l) => l.key).join(', '));
  line('clarification items', ['all_bidders', 'board', 'management'].map((a) => `${a} ${d.clarification_items.filter((c) => c.audience === a).length}`).join(', '));
  line('response deadline', d.schedule.recommended_response_deadline_display);
  for (const k of R.DECISION_STATE_KEYS) line(R.DECISION_STATE_LABELS[k], d.decision_state[k]);
  line('scope_summary', res.patch.scope_summary);
  if (res.warnings.length) console.log(`  warnings: ${res.warnings.join('; ')}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.plan) { console.error('usage: --plan=<plan.json> [--apply] [--html=<dir>]'); process.exit(2); }
  const plan = JSON.parse(fs.readFileSync(args.plan, 'utf8'));
  const { createClient } = require('@supabase/supabase-js');
  const { readOnly } = require('./amanda_rfp_dry_run');
  const raw = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
  const ro = readOnly(raw);
  console.log(`save_rfp_document: ${args.apply ? 'APPLY' : 'DRY RUN (read-only client; nothing is written)'}`);

  const inputs = await readInputs(ro, plan);
  const res = planWrite(plan, inputs);
  printPlan(res, inputs.br);
  if (args.html) {
    fs.mkdirSync(args.html, { recursive: true });
    for (const audience of ['vendor', 'board']) { const f = path.join(args.html, `rfp_${audience}.html`); fs.writeFileSync(f, renderRfpHtml(res.doc, { audience })); console.log(`  wrote ${f}`); }
    fs.writeFileSync(path.join(args.html, 'structured_rfp.json'), JSON.stringify(res.doc, null, 2));
  }
  if (!res.ok) { console.error(`\nREFUSED (${res.errors.length}):\n  - ${res.errors.join('\n  - ')}`); process.exit(1); }
  if (res.unchanged) { console.log('\n0 updates, already saved (same content hash).'); return; }
  if (!args.apply) { console.log('\nDRY RUN: 1 update planned (bid_requests.structured_rfp, scope_summary). Re-run with --apply to write.'); return; }

  const { data, error } = await raw.from('bid_requests').update(res.patch).eq('id', plan.bid_request_id).select('id, structured_rfp').single();
  if (error) { console.error(`\nWRITE FAILED: ${error.message}`); process.exit(1); }
  const saved = data.structured_rfp || {};
  if (saved.content_sha256 !== res.doc.content_sha256) { console.error('\nWRITE CHECK FAILED: saved content hash differs from planned'); process.exit(1); }
  console.log(`\nAPPLIED: bid_requests ${data.id} structured_rfp v${saved.version} ${saved.content_sha256.slice(0, 12)} (draft_for_review). Not issued.`);
}

if (require.main === module) main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
module.exports = { planWrite, readInputs };
