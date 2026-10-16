// ============================================================================
// lib/vendors/rfp_document_render.js
// ----------------------------------------------------------------------------
// One render pipeline for the structured RFP (lib/vendors/rfp_document.js):
//   audience 'vendor' - what every bidder receives. No decision state, no Board or
//                       management items, no baseline reference, no price.
//   audience 'board'  - the vendor copy plus a Board review cover: the decision
//                       state in its exact wording, the governing instruction, Board
//                       requirements, Board open items and the recommended deadline.
// Management-only items are never rendered; they show in the app only.
// Renders from the VALIDATED document only; the caller validates first.
// Printable HTML (the browser saves it as PDF). Sends nothing.
// ============================================================================

const BRAND = require('../brand');
const { DECISION_STATE_KEYS, DECISION_STATE_LABELS, COMPLIANCE_RESPONSES } = require('./rfp_document');

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const longDate = (iso) => { if (!iso) return ''; const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number); const wd = new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' }); return `${wd}, ${MONTHS[m - 1]} ${d}, ${y}`; };
const DISPOSITION = { reused: 'Reused', replacement: 'Replacement', new: 'New' };
const BASIS_LABEL = { board: 'Board requirement', baseline: 'From the current proposals or system', management: 'Management recommendation' };
const RESPONSE_LABEL = { comply: 'Comply', exception: 'Exception', not_applicable: 'Not Applicable' };

function renderRfpHtml(doc, { audience = 'vendor' } = {}) {
  const board = audience === 'board';
  const C = BRAND.colors;
  const sec = (s, n) => `<section><h2>${n}. ${esc(s.title)}</h2>${(s.body || []).map((p) => `<p>${esc(p)}</p>`).join('')}${(s.items || []).length ? `<ul>${s.items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>` : ''}${s.key === 'camera_schedule' ? cameraTable(doc) : ''}${s.key === 'pricing' ? pricingForm(doc) : ''}</section>`;
  const t = doc.camera_totals || {};
  const bidderQs = (doc.clarification_items || []).filter((c) => c.audience === 'all_bidders');
  const boardQs = (doc.clarification_items || []).filter((c) => c.audience === 'board');
  const deadline = doc.schedule && (doc.schedule.recommended_response_deadline_display || longDate(doc.schedule.recommended_response_deadline));

  const cover = board ? `
    <div class="review">
      <div class="tag">For Board review. Draft, not issued. No company has received this RFP.</div>
      <table class="kv">${DECISION_STATE_KEYS.map((k) => `<tr><th>${esc(DECISION_STATE_LABELS[k])}</th><td>${esc(doc.decision_state[k])}</td></tr>`).join('')}</table>
      ${doc.governing_instruction ? `<p><b>Instruction:</b> ${esc(doc.governing_instruction.summary)} (${esc(doc.governing_instruction.from_role || '')}, ${esc(longDate(doc.governing_instruction.received_at))})</p>` : ''}
      <p><b>Board requirements reflected:</b></p><ul>${(doc.board_requirements || []).map((r) => `<li>${esc(r.text)}</li>`).join('')}</ul>
      <p><b>Scope source:</b> the current proposal on file, converted to vendor-neutral language. Its vendor, product names and pricing are not in the RFP.</p>
      <p><b>Recommended response deadline:</b> ${esc(deadline)}. ${esc(doc.schedule && doc.schedule.basis)}</p>
      ${boardQs.length ? `<p><b>Board items to confirm before the RFP is issued:</b></p><ol>${boardQs.map((c) => `<li>${esc(c.text)}</li>`).join('')}</ol>` : ''}
    </div>` : '';

  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(doc.community)} ${esc(doc.title)}</title>
<style>
  body{font-family:${BRAND.fonts.sans};color:#1f2937;max-width:900px;margin:24px auto;padding:0 20px;font-size:13.5px;line-height:1.5}
  h1{font-family:${BRAND.fonts.serif};color:${C.navy};font-size:26px;margin:0 0 4px}
  h2{color:${C.navy};font-size:16px;border-bottom:2px solid ${C.gold};padding-bottom:3px;margin-top:26px}
  .sub{color:${C.stone};margin:0 0 14px}
  table{border-collapse:collapse;width:100%;margin:8px 0;font-size:12.5px}
  th,td{border:1px solid #d1d5db;padding:5px 7px;text-align:left;vertical-align:top}
  th{background:${C.lightGray}}
  .kv th{width:34%}
  .review{border:2px solid ${C.gold};border-radius:8px;padding:12px 16px;margin:14px 0;background:#fffdf5}
  .tag{font-weight:700;color:#92400e;margin-bottom:8px}
  .blank{min-width:90px}
  .id{white-space:nowrap}
  .meta td{border:none;padding:2px 10px 2px 0}
  @media print{.review{break-after:page} section{break-inside:avoid-page}}
</style></head><body>
  <h1>${esc(doc.title)}</h1>
  <p class="sub">${esc(doc.association_legal_name || doc.community)}. Issued by ${esc(doc.issuer)}.</p>
  ${cover}
  <table class="meta">
    <tr><td><b>Status</b></td><td>${doc.document_status === 'issued' ? `Issued ${esc(longDate(doc.issued_at))}` : 'Draft for review, not issued'}</td></tr>
    <tr><td><b>Responses due</b></td><td>${esc(deadline)}</td></tr>
    <tr><td><b>Cameras</b></td><td>${t.total} total: ${t.reused} reused, ${t.replacement} replacement, ${t.new} new</td></tr>
    <tr><td><b>Locations</b></td><td>${esc(Object.keys(t.by_location || {}).join(', '))}</td></tr>
  </table>
  <h2>Project summary</h2><p>${esc(doc.project && doc.project.summary)}</p>
  ${(doc.sections || []).map((s, i) => sec(s, i + 1)).join('')}
  <h2>Compliance matrix</h2>
  <p>Answer every line Comply, Exception or Not Applicable. Explain every Exception and Not Applicable.</p>
  <table><tr><th>ID</th><th>Requirement</th>${board ? '<th>Basis</th>' : ''}<th class="blank">${COMPLIANCE_RESPONSES.map((r) => RESPONSE_LABEL[r]).join(' / ')}</th><th class="blank">Explanation</th></tr>
  ${(doc.compliance_matrix || []).map((r) => `<tr><td class="id">${esc(r.id)}</td><td>${esc(r.requirement)}</td>${board ? `<td>${esc(BASIS_LABEL[r.basis] || '')}</td>` : ''}<td></td><td></td></tr>`).join('')}</table>
  <h2>Required contract package</h2><p>${esc(doc.contract_package_note || '')}</p>
  <ul>${(doc.contract_package || []).map((c) => `<li>${esc(c.label)}</li>`).join('')}</ul>
  ${bidderQs.length ? `<h2>Required clarifications</h2><ol>${bidderQs.map((c) => `<li>${esc(c.text)}</li>`).join('')}</ol>` : ''}
  <h2>Schedule</h2>
  <table><tr><th>Milestone</th><th>Date</th><th>Note</th></tr>${((doc.schedule && doc.schedule.timeline) || []).filter((m) => board || !m.board_only).map((m) => `<tr><td>${esc(m.milestone)}</td><td>${esc(longDate(m.date))}</td><td>${esc(m.note)}</td></tr>`).join('')}</table>
  <h2>How to submit</h2><p>${esc(doc.submission && doc.submission.instructions)}</p>
  <p><b>Submit to:</b> ${esc(doc.submission && doc.submission.submit_to_email)}</p>
</body></html>`;
}

function cameraTable(doc) {
  return `<table><tr><th>ID</th><th>Location</th><th>Type</th><th>Coverage</th><th>Camera type</th><th>Notes</th><th class="blank">Bidder: make, model, license</th></tr>
  ${(doc.camera_schedule || []).map((c) => `<tr><td class="id">${esc(c.id)}</td><td>${esc(c.location)}${c.mounting ? `<br><small>${esc(c.mounting)}</small>` : ''}</td><td>${esc(DISPOSITION[c.disposition] || c.disposition)}</td><td>${esc(c.function)}</td><td>${esc(c.minimum_spec)}</td><td>${esc(c.notes)}</td><td></td></tr>`).join('')}</table>`;
}

function pricingForm(doc) {
  const pf = doc.pricing_form || {};
  return `<h3>Pricing form</h3>
  <table><tr><th>One-time charge</th><th class="blank">Amount</th></tr>${(pf.one_time || []).map((l) => `<tr><td>${esc(l.label)}</td><td></td></tr>`).join('')}</table>
  <p><b>Recurring charges.</b> List every recurring charge, required or optional, one row each, with:</p>
  <ul>${(pf.recurring_fields || []).map((f) => `<li>${esc(f.label)}</li>`).join('')}</ul>
  <table><tr><th>Total</th><th>Definition</th><th class="blank">Amount</th></tr>${(pf.totals || []).map((x) => `<tr><td>${esc(x.label)}</td><td>${esc(x.formula)}</td><td></td></tr>`).join('')}</table>
  <ul>${(pf.rules || []).map((r) => `<li>${esc(r)}</li>`).join('')}</ul>`;
}

module.exports = { renderRfpHtml };
