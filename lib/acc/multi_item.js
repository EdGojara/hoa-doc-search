// ============================================================================
// lib/acc/multi_item.js  (Ed 2026-11-26)
// ----------------------------------------------------------------------------
// ONE APPLICATION, SEVERAL IMPROVEMENTS, DIFFERENT OUTCOMES.
// Scar: WAT-ARC-2026-0054 (5322 Millwood Pass) covers a front door color, exterior
// touch-up painting and a fence gate. Annie's single letter approved the gate and
// asked for information on the two paint items; a case carries ONE decision, so
// the decision guard (correctly) held the whole letter and nothing moved.
//
// Now, when Annie's request for information would also approve or deny
// something, she plans the application per improvement (workflow
// acc.multi_item_plan, validated deterministically), then:
//   * every improvement with a final outcome becomes its own linked case
//     (reference REF-n, same documents, same receipt, same correspondents) and
//     goes through the SAME authority gate: issued only when it is Annie's to
//     decide under the community's written delegation; otherwise it waits for
//     its decision owner like any other case;
//   * the original case keeps the improvements that need information, with a
//     request-only letter;
//   * the homeowner gets ONE email listing each improvement, its status, what is
//     missing and the next steps, with the decision letter(s) and the request
//     letter attached (the decision's finalize path sends it, so the sealed
//     record holds the exact email).
// Nothing is sent on the historical backlog; every existing guard still applies.
// ============================================================================
const { route: aiRoute } = require('../ai/router');
const DA = require('./decision_authority');

const FINAL = ['approved', 'approved_no_conditions', 'approved_with_conditions', 'denied'];
const ALL = [...FINAL, 'request_more_info'];

// Does a request-for-information letter also decide something?
function mixesOutcomes(letterBody) {
  const chk = DA.checkOutboundText(String(letterBody || ''));
  return !chk.ok && !!(chk.approval || chk.denial);
}

function validatePlan(plan) {
  const errors = [];
  const items = Array.isArray(plan && plan.items) ? plan.items : [];
  if (items.length < 2) errors.push('fewer than two improvements');
  items.forEach((it, i) => {
    if (!it || !String(it.title || '').trim()) errors.push(`item ${i + 1}: no title`);
    if (!ALL.includes(it && it.outcome)) errors.push(`item ${i + 1}: unknown outcome`);
    if (it && it.outcome === 'request_more_info' && !(Array.isArray(it.missing) && it.missing.length)) errors.push(`item ${i + 1}: request without the missing items`);
    if (it && FINAL.includes(it.outcome) && !String(it.letter_body || '').trim()) errors.push(`item ${i + 1}: decision without a letter`);
  });
  const rfi = items.filter((it) => it.outcome === 'request_more_info');
  if (rfi.length && !String(plan.request_letter_body || '').trim()) errors.push('no request letter');
  // The request letter must not approve or deny anything (the guard would hold it).
  if (rfi.length && !DA.checkOutboundText(String(plan.request_letter_body || '')).ok) errors.push('the request letter still decides something');
  if (!items.some((it) => FINAL.includes(it.outcome))) errors.push('no improvement has a final outcome (not a mixed case)');
  return errors;
}

async function planItems(row, { anthropic = null } = {}) {
  const client = anthropic || new (require('../ai/anthropic'))({ apiKey: process.env.ANTHROPIC_API_KEY });
  const review = String(row.current_review_text || row.ai_review_text || '').slice(0, 14000);
  const letter = String(row.current_letter_body || row.letter_body || row.ai_letter_body || '').slice(0, 8000);
  const prompt = `An HOA architectural reviewer (Annie) reviewed ONE application that covers several separate improvements, and wrote the review and letter below. Split it per improvement. Use only what the review and letter say; do not invent requirements, conditions or outcomes.

Return ONLY JSON:
{"items":[{"n":1,"title":"short name of the improvement","outcome":"approved_no_conditions|approved_with_conditions|denied|request_more_info","missing":["each item still needed, plain language"],"letter_body":"for a final outcome only: a complete, standalone formal letter for THIS improvement alone, with the same salutation, the same conditions and the same contact line as the original; empty for request_more_info"}],
 "request_letter_body":"a complete formal letter covering ONLY the improvements that need information: what is needed for each and that a decision follows once received. It must not approve or deny anything, and must not mention the other improvements' outcomes."}

REVIEW:
${review}

LETTER:
${letter}`;
  const r = await client.messages.create({ model: aiRoute('acc.multi_item_plan'), max_tokens: 4000, messages: [{ role: 'user', content: prompt }] });
  const text = (r.content && r.content[0] && r.content[0].text) || '';
  console.log('[acc-multi-item] plan returned:', text.slice(0, 2000));
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('the per-improvement plan was not JSON');
  return JSON.parse(m[0]);
}

// Child case for one improvement with a final outcome (idempotent by intake_source_ref).
async function childCase(supabase, parent, item) {
  const ref = `split:${parent.id}:${item.n}`;
  const { data: ex, error: ee } = await supabase.from('acc_decisions').select('*').eq('intake_source_ref', ref).limit(1);
  if (ee) throw new Error(ee.message);
  if (ex && ex.length) return ex[0];
  const row = {
    management_company_id: parent.management_company_id, community_id: parent.community_id, community_name: parent.community_name,
    homeowner_name: parent.homeowner_name, homeowner_address: parent.homeowner_address,
    project_summary: item.title, reference_number: parent.reference_number ? `${parent.reference_number}-${item.n}` : null,
    status: 'pending_review', source: parent.source, submitter_email: parent.submitter_email,
    ai_recommendation: item.outcome === 'approved' ? 'approved_no_conditions' : item.outcome,
    ai_review_text: `Part of ${parent.reference_number || 'the application'} (improvement ${item.n} of several).\n\n${parent.current_review_text || parent.ai_review_text || ''}`,
    ai_letter_body: item.letter_body, intake_source_ref: ref,
    application_pdf_storage_path: parent.application_pdf_storage_path, photo_storage_paths: parent.photo_storage_paths || [],
    supporting_docs_storage_paths: parent.supporting_docs_storage_paths || [],
    created_at: parent.created_at, acknowledged_at: parent.acknowledged_at, acknowledged_to: parent.acknowledged_to,
    correspondent_emails: parent.correspondent_emails || [], conversation_id: parent.conversation_id || null,
    source_email_refs: parent.source_email_refs || [],
  };
  if (parent.received_at) { row.received_at = parent.received_at; row.received_at_basis = parent.received_at_basis; }
  let ins = await supabase.from('acc_decisions').insert(row).select('*').single();
  if (ins.error && /received_at/.test(ins.error.message || '')) { delete row.received_at; delete row.received_at_basis; ins = await supabase.from('acc_decisions').insert(row).select('*').single(); }
  if (ins.error) throw new Error(`improvement case not created: ${ins.error.message}`);
  return ins.data;
}

/**
 * respondMultiItem(supabase, parentId, { issuer, plan? }) -> { status, children, email_sent, detail }
 * issuer: the finalize core registered by server.js (lib/acc/annie_issue).
 */
async function respondMultiItem(supabase, parentId, { issuer, plan = null, anthropic = null } = {}) {
  const { data: parent, error } = await supabase.from('acc_decisions').select('*').eq('id', parentId).maybeSingle();
  if (error || !parent) return { status: 'skipped', detail: error ? error.message : 'case not found' };
  if (require('./backlog_hold').isBacklogHeld(parent)) return { status: 'skipped', detail: 'backlog hold' };
  const p = plan || await planItems(parent, { anthropic });
  const errs = validatePlan(p);
  if (errs.length) return { status: 'needs_person', detail: `per-improvement plan not usable: ${errs.join('; ')}` };

  // Each final outcome: its own case, through the same authority gate.
  const finals = p.items.filter((it) => FINAL.includes(it.outcome));
  const rfis = p.items.filter((it) => it.outcome === 'request_more_info');
  const children = [];
  for (const it of finals) children.push({ item: it, row: await childCase(supabase, parent, it) });
  // The original case keeps the improvements that need information.
  {
    const patch = { project_summary: rfis.map((x) => x.title).join('; ') || parent.project_summary, letter_body: p.request_letter_body || null, letter_draft_review_at: DA.reviewAt(parent), letter_draft_saved_at: new Date().toISOString() };
    const { error: ue } = await supabase.from('acc_decisions').update(patch).eq('id', parent.id).in('status', ['pending_review', 'awaiting_info']);
    if (ue) return { status: 'error', detail: `the original case was not narrowed: ${ue.message}` };
  }
  if (!issuer) return { status: 'skipped', detail: 'issuer not registered (server not started)', children: children.map((c) => c.row.reference_number) };

  // Which decisions are Annie's to issue now (community delegation, routine).
  const issuable = [];
  for (const c of children) {
    const del = await supabase.from('communities').select('acc_delegation').eq('id', c.row.community_id).maybeSingle();
    const a = DA.authorityFor({ ...c.row, acc_delegation: del.data && del.data.acc_delegation });
    c.route = a.route; c.annie = a.annie;
    if (a.route === 'annie_decides' && a.annie && a.annie.ok && a.annie.outcome === c.row.ai_recommendation) issuable.push(c);
  }
  const statusLine = (it, c) => {
    if (it.outcome === 'request_more_info') return { title: it.title, status: 'needs information', missing: it.missing };
    if (c && issuable.includes(c)) return { title: it.title, status: it.outcome === 'denied' ? 'not approved (decision letter attached)' : it.outcome === 'approved_with_conditions' ? 'approved with conditions (approval letter attached)' : 'approved (approval letter attached)', missing: [] };
    return { title: it.title, status: 'under review by the decision-maker named in the governing documents; we will follow up with the decision', missing: [] };
  };
  const items = p.items.map((it) => statusLine(it, children.find((c) => c.item === it)));
  const to = require('./acknowledge').receiptRecipients(parent).join(', ') || parent.submitter_email;
  const companion = rfis.length ? { case_id: parent.id, reference_number: parent.reference_number, project_summary: rfis.map((x) => x.title).join('; '), letter_text: p.request_letter_body, items } : { items };

  let sent = false; let detail = '';
  if (issuable.length) {
    // The first decision carries the one coordinated email; any further decisions
    // are sealed alongside (their letters are attached to the same email).
    const [lead, ...rest] = issuable;
    for (const c of rest) {
      const r = await issuer(c.row.id, { decision_type: c.row.ai_recommendation, body_text: c.item.letter_body, to_email: to, send: false });
      if (!(r && r.status === 200)) detail += ` ${c.row.reference_number}: ${(r && r.json && r.json.error) || 'not recorded'}.`;
    }
    const r = await issuer(lead.row.id, { decision_type: lead.row.ai_recommendation, body_text: lead.item.letter_body, to_email: to, send: true,
      companion: { ...companion, extra_decision_case_ids: rest.map((c) => c.row.id) } });
    sent = !!(r && r.status === 200 && r.json && r.json.email && r.json.email.sent);
    if (!sent) return { status: 'needs_person', detail: `coordinated email not sent: ${(r && r.json && (r.json.error || r.json.code)) || 'unknown'}${detail}`, children: children.map((c) => c.row.reference_number) };
    // The request letter went out inside that email: record it on the original
    // case (no second email), so the request is not sent again.
    if (rfis.length) {
      const rr = await issuer(parent.id, { decision_type: 'request_more_info', body_text: p.request_letter_body, to_email: to, send: false });
      if (!(rr && rr.status === 200)) console.error(`[acc-multi-item] ${parent.reference_number}: request sent in the coordinated email but not recorded: ${(rr && rr.json && rr.json.error) || 'unknown'}`);
    }
  } else if (rfis.length) {
    // No decision is Annie's to issue: the request goes, listing every improvement's status.
    const r = await issuer(parent.id, { decision_type: 'request_more_info', body_text: p.request_letter_body, to_email: to, send: true, companion: { items } });
    sent = !!(r && r.status === 200 && r.json && r.json.email && r.json.email.sent);
    if (!sent) return { status: 'needs_person', detail: `request not sent: ${(r && r.json && (r.json.error || r.json.code)) || 'unknown'}` };
  }
  console.log(`[acc-multi-item] ${parent.reference_number}: ${p.items.length} improvements, ${issuable.length} decided by Annie, ${rfis.length} need information, one email ${sent ? 'sent' : 'not sent'}`);
  return { status: sent ? 'sent' : 'recorded', email_sent: sent, children: children.map((c) => ({ reference: c.row.reference_number, route: c.route, issued: issuable.includes(c) })), items };
}

module.exports = { respondMultiItem, planItems, validatePlan, mixesOutcomes, childCase };
