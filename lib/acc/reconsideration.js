// ============================================================================
// lib/acc/reconsideration.js  (Ed 2026-11-24, migration 576)
// ----------------------------------------------------------------------------
// RECONSIDERATION AND REVISED DECISIONS. A decided ACC application is never
// reopened or rewritten (Issue #14). When more evidence arrives afterwards:
//
//   addSupplement / addEmailSupplement   file it on the SAME application, append
//       only, every file hashed. The case row is not touched.
//   openReconsideration                  one active reconsideration per case.
//   reviewReconsideration                Annie re-reads the whole record plus the
//       supplemental evidence and RECOMMENDS. She never issues this one.
//   saveDraft                            staff / Ed edit the letter and outcome.
//   issueRevisedDecision                 the OWNER approves this exact letter and
//       outcome; it is sealed, sent, and recorded as the next decision version.
//   closeReconsideration                 the decision in effect stands (reason kept).
//
// Not here, on purpose: no application fee, no charge, no billing row, no new
// reference number, no change to acc_decisions, no change to any violation. An
// approval of proposed work is not evidence that the work was done.
// ============================================================================
const crypto = require('crypto');
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const ACTIVE = ['open', 'ready', 'issuing'];
const OUTCOMES = ['approved', 'approved_with_conditions', 'denied'];
const PLACEHOLDER_RE = /\[\s*STAFF\s*:/i;
const day = (x) => String(x || '').slice(0, 10);
const isMissing = (e) => !!e && /does not exist|schema cache|could not find the/i.test(e.message || '');
const NEEDS_576 = 'Migration 576 must be applied before supplemental evidence and revised decisions can be used.';
const normOutcome = (o) => { const v = String(o || '').toLowerCase().trim(); return v === 'approved_no_conditions' ? 'approved' : v; };
const fail = (status, error, extra = {}) => ({ ok: false, httpStatus: status, error, ...extra });

async function must(q, what) {
  const { data, error } = await q;
  if (error) { const e = new Error(isMissing(error) ? NEEDS_576 : `${what}: ${error.message}`); e.httpStatus = isMissing(error) ? 503 : 500; e.missing = isMissing(error); throw e; }
  return data;
}

const listSupplements = (supabase, decisionId) => must(supabase.from('acc_case_supplements').select('*').eq('acc_decision_id', decisionId).order('received_at', { ascending: true }).limit(500), 'supplemental evidence could not be read');
const listReconsiderations = (supabase, decisionId) => must(supabase.from('acc_reconsiderations').select('*').eq('acc_decision_id', decisionId).order('opened_at', { ascending: true }).limit(200), 'reconsiderations could not be read');
const getReconsideration = (supabase, id) => must(supabase.from('acc_reconsiderations').select('*').eq('id', id).maybeSingle(), 'the reconsideration could not be read');
async function latestFinalization(supabase, decisionId) {
  const rows = await must(supabase.from('acc_finalizations').select('*').eq('acc_decision_id', decisionId).order('version', { ascending: false }).limit(1), 'the decision record could not be read');
  return (rows || [])[0] || null;
}
// The decision in effect before a reconsideration: the latest sealed version, or,
// for a case decided before sealed records existed, the original on the case row.
async function priorDecision(supabase, dec) {
  const f = await latestFinalization(supabase, dec.id);
  if (f) return f;
  if (dec.finalization_id) throw new Error('the sealed decision record for this case could not be found');
  return { id: null, version: 1, legacy: true, decision_type: dec.decision_type, letter_text: dec.letter_body || null, finalized_at: dec.decided_at || dec.updated_at || null };
}
const snapshotOf = (p) => ({ version: p.version, decision_type: p.decision_type || null, finalized_at: p.finalized_at || null, finalization_id: p.id || null, letter_text: p.letter_text || null, letter_sha256: p.letter_sha256 || null, sealed: !p.legacy });
async function activeReconsideration(supabase, decisionId) {
  const rows = await must(supabase.from('acc_reconsiderations').select('*').eq('acc_decision_id', decisionId).in('status', ACTIVE).limit(1), 'reconsiderations could not be read');
  return (rows || [])[0] || null;
}

// ---------------------------------------------------------------- evidence
// Hashes of every file already on the case, so the same attachment forwarded
// three times is recorded once. A file that cannot be read is simply not matched.
async function knownHashes(supabase, dec, supplements, download) {
  const set = new Set();
  for (const s of supplements || []) for (const d of s.documents || []) if (d.sha256) set.add(d.sha256);
  const paths = require('./documents').caseDocuments(dec).map((d) => d.path);
  for (const p of paths) {
    try { const b = await download(p); if (b && b.length) set.add(sha256(b)); } catch (e) { console.warn('[acc supplement] could not hash', p, e.message); }
  }
  return set;
}

const safeName = (n) => require('./documents').safeName(n);
const typeOf = (f) => String(f.mimetype || f.contentType || f.mime || '').toLowerCase();

// files: [{ buffer, originalname|filename, mimetype|contentType }]
// Stores the files, then appends one evidence row. A file that fails to store
// stops the whole thing: evidence is never recorded with a file missing.
async function addSupplement(supabase, { dec, kind, files = [], sourceRef = null, emailMessageId = null, fromEmail = null, fromName = null, subject = null, bodyText = null, note = null, receivedAt = null, matchedBy = [], possibleNewRequest = false, actorId = null, addedBy, download, now = () => new Date() }) {
  if (!dec || dec.status !== 'decided') return fail(409, 'Supplemental evidence is filed on a decided application; an open one takes documents directly.');
  if (!String(addedBy || '').trim()) return fail(400, 'who added it is required');
  if (!files.length && !String(bodyText || '').trim() && !String(note || '').trim()) return fail(400, 'Add a file, an email or a note.');
  const existing = await listSupplements(supabase, dec.id);
  if (sourceRef) { const dup = existing.find((s) => s.source_ref === sourceRef); if (dup) return { ok: true, status: 'exists', supplement: dup }; }
  const known = files.length ? await knownHashes(supabase, dec, existing, download) : new Set();
  const documents = []; const stored = []; const stamp = now().getTime();
  for (let i = 0; i < files.length; i++) {
    const f = files[i]; const name = f.originalname || f.filename || `file_${i + 1}`;
    if (!f.buffer || !f.buffer.length) return fail(422, `"${name}" is empty or could not be read. Nothing was filed.`);
    const hash = sha256(f.buffer);
    const base = { filename: name, mime: typeOf(f) || null, sha256: hash, bytes: f.buffer.length };
    if (known.has(hash)) { documents.push({ ...base, path: null, already_on_case: true }); continue; }
    known.add(hash);
    const path = `acc_decisions/${dec.id}/supplements/${stamp}_${i}_${safeName(name)}`;
    const up = await supabase.storage.from('documents').upload(path, f.buffer, { contentType: typeOf(f) || 'application/octet-stream', upsert: false });
    if (up && up.error) {
      if (stored.length) await supabase.storage.from('documents').remove(stored).catch(() => {});
      return fail(502, `"${name}" could not be stored (${up.error.message || up.error}). Nothing was filed; try again.`);
    }
    stored.push(path); documents.push({ ...base, path });
  }
  const row = {
    acc_decision_id: dec.id, community_id: dec.community_id || null, kind, source_ref: sourceRef, email_message_id: emailMessageId,
    from_email: fromEmail, from_name: fromName, subject, body_text: bodyText ? String(bodyText).slice(0, 20000) : null, note: note ? String(note).slice(0, 2000) : null,
    documents, received_at: receivedAt || now().toISOString(), matched_by: matchedBy, possible_new_request: !!possibleNewRequest,
    added_by_user_id: actorId, added_by: String(addedBy).slice(0, 200),
  };
  const { data, error } = await supabase.from('acc_case_supplements').insert(row).select('*').single();
  if (error) {
    if (stored.length) await supabase.storage.from('documents').remove(stored).catch(() => {});
    if (String(error.code) === '23505') return { ok: true, status: 'exists' };   // filed at the same moment by another mailbox
    return fail(isMissing(error) ? 503 : 500, isMissing(error) ? NEEDS_576 : `the evidence could not be recorded (${error.message})`);
  }
  return { ok: true, status: 'added', supplement: data, new_documents: documents.filter((d) => d.path).length };
}

// One email = one piece of evidence, however many mailboxes received it.
const emailSourceRef = (m) => (m.internet_message_id ? `msg:${m.internet_message_id}` : `email:${m.graph_id || m.id}`);

// Attach an email trustEd already ingested, with the attachments it archived.
async function addEmailSupplement(supabase, { dec, emailId, actorId = null, addedBy, note = null, matchedBy = ['staff'], download }) {
  const m = await must(supabase.from('email_messages').select('id, graph_id, internet_message_id, subject, sender_email, sender_name, body_full, body_preview, received_at, direction, has_attachments, community_id, resolved_property_id').eq('id', emailId).maybeSingle(), 'the email could not be read');
  if (!m) return fail(404, 'That email is not in trustEd.');
  if (m.community_id && dec.community_id && m.community_id !== dec.community_id) return fail(409, 'That email belongs to another association.');
  const atts = await must(supabase.from('email_attachments').select('filename, mime, storage_path').eq('email_message_id', m.id).limit(50), 'its attachments could not be read');
  if (m.has_attachments && !(atts || []).length) return fail(409, 'The attachments on that email are not archived in trustEd yet. Try again in a minute, or upload the files.');
  const files = [];
  for (const a of atts || []) {
    const b = await download(a.storage_path);
    if (!b || !b.length) return fail(502, `"${a.filename}" could not be read. Nothing was filed.`);
    files.push({ buffer: b, originalname: a.filename, mimetype: a.mime });
  }
  return addSupplement(supabase, { dec, kind: 'email', files, sourceRef: emailSourceRef(m), emailMessageId: m.id, fromEmail: m.sender_email, fromName: m.sender_name, subject: m.subject, bodyText: m.body_full || m.body_preview, note, receivedAt: m.received_at, matchedBy, actorId, addedBy, download });
}

// ---------------------------------------------------------------- reconsideration
async function openReconsideration(supabase, { dec, reason, actorId = null, openedBy }) {
  if (!dec || dec.status !== 'decided') return fail(409, 'Only a decided application can be reconsidered.');
  if (!String(reason || '').trim()) return fail(400, 'Say why the decision is being reconsidered.');
  const prior = await priorDecision(supabase, dec);
  const cur = await activeReconsideration(supabase, dec.id);
  if (cur) return { ok: true, status: 'exists', reconsideration: cur };
  const { data, error } = await supabase.from('acc_reconsiderations').insert({ acc_decision_id: dec.id, community_id: dec.community_id || null, prior_finalization_id: prior.id, prior_snapshot: snapshotOf(prior), opened_reason: String(reason).slice(0, 1000), opened_by_user_id: actorId, opened_by: String(openedBy || '').slice(0, 200) || 'staff' }).select('*').single();
  if (error) {
    if (String(error.code) === '23505') { const now2 = await activeReconsideration(supabase, dec.id); if (now2) return { ok: true, status: 'exists', reconsideration: now2 }; }
    return fail(isMissing(error) ? 503 : 500, isMissing(error) ? NEEDS_576 : error.message);
  }
  return { ok: true, status: 'opened', reconsideration: data };
}

// What Annie is told, on top of the property history. Reviewed, not the letter.
function reconsiderationContext({ dec, prior, supplements, reason }) {
  const ev = supplements.map((s, i) => `${i + 1}. ${day(s.received_at)} ${s.kind === 'email' ? `email from ${s.from_email || 'the applicant'}: "${String(s.subject || '').slice(0, 160)}"` : 'uploaded by staff'}${(s.documents || []).length ? `; files: ${(s.documents || []).map((d) => d.filename).join(', ')}` : ''}${s.note ? `; note: ${s.note}` : ''}\n${String(s.body_text || '').slice(0, 2500)}`).join('\n\n');
  return `RECONSIDERATION OF A DECIDED APPLICATION (${dec.reference_number || dec.id}). This is the SAME application, not a new one.
Decision now in effect: ${String(prior.decision_type).replace(/_/g, ' ')}, issued ${day(prior.finalized_at)} (version ${prior.version}). Its letter said:
"""${String(prior.letter_text || '').slice(0, 4000)}"""
Why it is being reconsidered: ${reason}
SUPPLEMENTAL EVIDENCE received since:
${ev || '(none)'}

Decide whether this evidence changes the decision for the same request. Read what the earlier decision actually decided before judging it. State exactly what the new evidence shows. Do not say the applicant changed the proposal unless the original application and the new evidence differ; if the evidence only clarifies what was already applied for, say that. Do not reopen what is not affected. Records trustEd already holds (inspection photos, earlier photos) count; never ask for something already on file.
Approval of proposed work is not evidence that the work was done: never say a violation is cured, closed or resolved.
THE LETTER, if a decision is made: say it is a reconsideration based on the supplemental information received on the date(s) above; state the decision, limited to what the evidence supports; say the earlier decision remains part of the record; say no additional application fee applies; plain, warm and brief; no section numbers, no internal process, no em-dashes.`;
}

async function reviewReconsideration(supabase, reconId, { runEngine, classifyRecommendation, download, trigger = 'staff', now = () => new Date().toISOString() }) {
  const rec = await getReconsideration(supabase, reconId);
  if (!rec) return fail(404, 'Reconsideration not found');
  if (!['open', 'ready'].includes(rec.status)) return fail(409, `This reconsideration is ${rec.status}.`);
  const dec = await must(supabase.from('acc_decisions').select('*').eq('id', rec.acc_decision_id).maybeSingle(), 'the application could not be read');
  const prior = await priorDecision(supabase, dec);
  const supplements = await listSupplements(supabase, dec.id);
  const D = require('./documents');
  const want = D.caseDocuments(dec).map((d) => ({ path: d.path, filename: d.filename, form: d.kind === 'application' }))
    .concat(supplements.flatMap((s) => (s.documents || []).filter((d) => d.path).map((d) => ({ path: d.path, filename: d.filename, mime: d.mime, form: false }))));
  const files = []; const unreadable = [];
  for (const w of want) {
    try {
      const b = await download(w.path); if (!b || !b.length) throw new Error('empty file');
      const pdf = /pdf/i.test(w.mime || '') || /\.pdf$/i.test(w.path) || /\.pdf$/i.test(w.filename || '');
      const mime = pdf ? 'application/pdf' : (b[0] === 0x89 && b[1] === 0x50) ? 'image/png' : 'image/jpeg';
      files.push({ fieldname: w.form ? 'pdf' : 'images', buffer: b, mimetype: mime, originalname: w.filename });
    } catch (e) { unreadable.push({ filename: w.filename, error: e.message }); }
  }
  const history = await require('./property_history').propertyHistory(supabase, { communityId: dec.community_id, address: dec.homeowner_address, excludeId: dec.id });
  const context = reconsiderationContext({ dec, prior, supplements, reason: rec.opened_reason });
  const out = await runEngine({ community: dec.community_name, files, typedDetails: files.length ? undefined : context, additionalContext: [context, history].filter(Boolean).join('\n\n'), isAdmin: true });
  const reviewText = String(out.review || '').replace(/^\*\*\*[^\n]*\n+/, '').replace(/\n+\*\*\* END[^\n]*$/, '').trim();
  const recommendation = normOutcome(await classifyRecommendation(reviewText, out.letter_body));
  const at = now();
  const basis = { trigger, at, supplements: supplements.map((s) => s.id), documents: files.map((f) => f.originalname), unreadable, removed_conditions: Array.isArray(out.letter_pruned) ? out.letter_pruned : [] };
  // A letter staff already saved is kept; Annie's newer draft sits beside it.
  const keepDraft = !!rec.letter_saved_at;
  const patch = { review_text: reviewText || null, recommendation, reviewed_letter_body: out.letter_body || null, review_at: at, review_basis: basis, status: OUTCOMES.includes(recommendation) ? 'ready' : (keepDraft ? 'ready' : 'open'), updated_at: at,
    ...(keepDraft ? {} : { letter_body: out.letter_body || null, outcome: OUTCOMES.includes(recommendation) ? recommendation : null }) };
  const { data, error } = await supabase.from('acc_reconsiderations').update(patch).eq('id', rec.id).in('status', ['open', 'ready']).select('*').maybeSingle();
  if (error) return fail(500, `Annie's review could not be saved (${error.message})`);
  if (!data) return fail(409, 'The reconsideration changed while Annie was reviewing; reload.');
  return { ok: true, status: 'reviewed', reconsideration: data, recommendation, unreadable };
}

async function saveDraft(supabase, reconId, { letterBody, outcome, reason, actorId = null, now = () => new Date().toISOString() }) {
  const o = normOutcome(outcome);
  if (!OUTCOMES.includes(o)) return fail(400, 'Choose approve, approve with conditions or deny.');
  if (!String(letterBody || '').trim()) return fail(400, 'The letter is empty.');
  if (!String(reason || '').trim()) return fail(400, 'Say what the supplemental evidence shows (kept with the decision version).');
  const { data, error } = await supabase.from('acc_reconsiderations').update({ letter_body: letterBody, outcome: o, reason: String(reason).slice(0, 2000), letter_saved_at: now(), letter_saved_by: actorId, status: 'ready', updated_at: now() })
    .eq('id', reconId).in('status', ['open', 'ready']).select('*').maybeSingle();
  if (error) return fail(isMissing(error) ? 503 : 500, isMissing(error) ? NEEDS_576 : error.message);
  if (!data) return fail(409, 'This reconsideration is no longer open.');
  return { ok: true, reconsideration: data };
}

async function closeReconsideration(supabase, reconId, { reason, actorId = null, now = () => new Date().toISOString() }) {
  if (!String(reason || '').trim()) return fail(400, 'Say why the decision in effect stands.');
  const { data, error } = await supabase.from('acc_reconsiderations').update({ status: 'closed', closed_at: now(), closed_by_user_id: actorId, closed_reason: String(reason).slice(0, 1000), updated_at: now() })
    .eq('id', reconId).in('status', ['open', 'ready']).select('*').maybeSingle();
  if (error) return fail(isMissing(error) ? 503 : 500, isMissing(error) ? NEEDS_576 : error.message);
  if (!data) return fail(409, 'This reconsideration is no longer open.');
  return { ok: true, reconsideration: data };
}

// Evidence received after Annie's review (or after the letter was saved).
function staleness(rec, supplements) {
  const t = (x) => (x ? Date.parse(x) : NaN);
  const basis = new Set((rec.review_basis && rec.review_basis.supplements) || []);
  const unseen = (supplements || []).filter((s) => !basis.has(s.id));
  const reasons = [];
  if (!rec.review_at) reasons.push('Annie has not reviewed the supplemental evidence yet.');
  else if (unseen.length) reasons.push(`${unseen.length} item${unseen.length === 1 ? '' : 's'} of evidence arrived after Annie's review. Ask Annie to review again, or confirm you reviewed it.`);
  if (rec.letter_saved_at && rec.review_at && t(rec.letter_saved_at) + 1000 < t(rec.review_at)) reasons.push("The saved letter is older than Annie's latest review.");
  return reasons;
}

// The case as the authority gate sees a reconsideration: same request, Annie's
// review of the supplemental evidence, this decision record.
function authorityRow(dec, rec, decisionRecord, letterBody) {
  return { ...dec, status: 'pending_review', decision_type: rec.outcome, decision_record: decisionRecord, letter_body: letterBody, ai_letter_body: null, current_letter_body: null,
    current_ai_recommendation: rec.recommendation, current_review_at: rec.review_at, current_review_text: rec.review_text };
}

// ---------------------------------------------------------------- issue
// Same order and guarantees as lib/acc/finalize: CLAIM -> FILE -> SEND ->
// RECORD -> COMPLETE. The claim records the owner's approval of this exact
// letter and outcome; a failure before the email puts the reconsideration back
// exactly as it was and nothing was sent.
//   approval  { user_id, email, name }  the signed-in OWNER (the caller verified)
//   deps      renderLetter, sealRecord, composeEmail, sendEmail
async function issueRevisedDecision(supabase, args) {
  const { dec, rec, supplements, letterBody, outcome, reason, decisionRecord, approval, toEmail, send, propertyId = null, now = () => new Date().toISOString() } = args;
  const { renderLetter, sealRecord, composeEmail, sendEmail } = args;
  if (!approval || !approval.user_id || !approval.email) return fail(403, 'A revised ACC decision needs the owner\'s approval. Nothing was sent.');
  if (!OUTCOMES.includes(outcome)) return fail(400, 'Choose approve, approve with conditions or deny.');
  if (!String(letterBody || '').trim()) return fail(400, 'The letter is empty.');
  if (PLACEHOLDER_RE.test(letterBody)) return fail(400, 'The letter still has a [STAFF: ...] placeholder. Fill it in or remove it before sending.');
  if (!String(reason || '').trim()) return fail(400, 'Say what the supplemental evidence shows (kept with the decision version).');
  if (send && !String(toEmail || '').trim()) return fail(400, 'Enter the homeowner\'s email, or use "Record without emailing".');
  if (dec.status !== 'decided' || rec.acc_decision_id !== dec.id || rec.status !== 'ready') return fail(409, `This reconsideration is not ready to issue (${rec.status}). Nothing was sent.`);
  const prior = await priorDecision(supabase, dec);
  if ((prior.id || null) !== (rec.prior_finalization_id || null)) return fail(409, 'A newer decision is on file for this application. Close this reconsideration and open a new one. Nothing was sent.');

  let pdf;
  try { pdf = await renderLetter(letterBody); } catch (e) { return fail(500, `The letter could not be rendered (${e.message}). Nothing was sent.`); }
  const letterHash = sha256(pdf);
  const ownerApproval = { user_id: approval.user_id, email: approval.email, name: approval.name || null, at: now(), outcome, letter_sha256: letterHash };

  // 1) CLAIM (with the owner's approval)
  const claim = await supabase.from('acc_reconsiderations').update({ status: 'issuing', outcome, letter_body: letterBody, reason: String(reason).slice(0, 2000), decision_record: decisionRecord, owner_approval: ownerApproval, updated_at: now() })
    .eq('id', rec.id).eq('status', 'ready').select('*');
  if (claim.error) return fail(500, `The approval could not be recorded (${claim.error.message}). Nothing was sent.`);
  if (!claim.data || !claim.data.length) return fail(409, 'Someone else is already issuing this, or it changed. Nothing was sent.');
  const revert = async () => {
    const r = await supabase.from('acc_reconsiderations').update({ status: 'ready', outcome: rec.outcome ?? null, letter_body: rec.letter_body ?? null, reason: rec.reason ?? null, decision_record: rec.decision_record ?? null, owner_approval: null, updated_at: now() }).eq('id', rec.id).eq('status', 'issuing');
    return !r.error;
  };
  const putBack = (ok) => (ok ? ' and the reconsideration is back where it was' : '; it could NOT be put back automatically, so tell Ed');

  // 2) FILE
  let filing;
  try { filing = await sealRecord({ pdf, prior, version: prior.version + 1 }); if (!filing || filing.letter.sha256 !== letterHash) throw new Error('the sealed letter does not match the approved letter'); }
  catch (e) { const ok = await revert(); return fail(500, `The record could not be filed (${e.message}). Nothing was sent${putBack(ok)}.`, { reverted: ok }); }

  // 3) SEND
  const email = { attempted: false, sent: false }; let composed = null;
  if (send) {
    email.attempted = true;
    try { composed = await composeEmail({ pdf, prior }); await sendEmail(composed); email.sent = true; email.sent_at = now(); }
    catch (e) { email.error = e.message; const ok = await revert(); return fail(502, `The letter was filed but could not be emailed: ${e.userMessage || e.message}. No revised decision was recorded${putBack(ok)}.`, { email, reverted: ok }); }
  }

  // 4) RECORD the new version (append-only; the database re-checks the approval)
  const ins = await supabase.from('acc_finalizations').insert({
    acc_decision_id: dec.id, version: prior.version + 1, supersedes_id: prior.id, correction_reason: String(reason).slice(0, 2000), reconsideration_id: rec.id,
    community_id: dec.community_id || null, property_id: propertyId, reference_number: dec.reference_number || null, homeowner_name: dec.homeowner_name || null, homeowner_address: dec.homeowner_address || null,
    decision_type: outcome, letter_text: letterBody, letter_sha256: filing.letter.sha256, letter_archive_path: filing.letter.archive_path,
    packet_sha256: filing.packet ? filing.packet.sha256 : null, packet_archive_path: filing.packet ? filing.packet.archive_path : null,
    documents: filing.documents || [], delivery: email.sent ? 'email' : 'none',
    email: email.sent ? { from: composed.from, to: composed.to, subject: composed.subject, text: composed.text, html: composed.html, attachments: composed.archive_attachments || [], sent_at: email.sent_at } : null,
    decided_by_user_id: approval.user_id,
  }).select('*').single();
  if (ins.error) {
    if (!email.sent) { const ok = await revert(); return fail(500, `The revised decision could not be recorded (${ins.error.message}). Nothing was sent${putBack(ok)}.`, { reverted: ok }); }
    return fail(500, `The homeowner WAS emailed, but the revised decision could not be recorded (${ins.error.message}). It shows as "issuing"; do not resend. Tell Ed.`, { email, filing });
  }

  // 5) COMPLETE
  const done = await supabase.from('acc_reconsiderations').update({ status: 'issued', issued_at: now(), finalization_id: ins.data.id, updated_at: now() }).eq('id', rec.id).eq('status', 'issuing').select('*').maybeSingle();
  if (done.error || !done.data) return fail(500, `The revised decision is recorded (version ${ins.data.version})${email.sent ? ' and the homeowner was emailed' : ''}, but the reconsideration could not be closed out (${done.error ? done.error.message : 'it changed'}). Do not resend. Tell Ed.`, { finalization: ins.data, email });
  return { ok: true, finalization: ins.data, reconsideration: done.data, email, composed, filing };
}

// Where a case being reconsidered sits in the ACC Requests screen.
function queueStage(rc) {
  if (rc.status === 'issuing') return { stage: 'ready_to_send', detail: 'Reconsideration: issuing the revised decision' };
  if (rc.status === 'ready') return { stage: 'pending_ed', detail: `Reconsideration: ${rc.recommendation && rc.recommendation !== 'request_more_info' ? `Annie recommends ${String(rc.recommendation).replace(/_/g, ' ')}` : 'letter drafted'}; needs Ed's approval` };
  return { stage: 'submitted', detail: rc.review_at ? 'Reconsideration: Annie needs more information' : 'Reconsideration: supplemental evidence to review' };
}

// Short cover email; the attached letter is the one statement of the decision.
function composeRevisedEmail({ dec, outcome, letterBody, communityName }) {
  const { salutation, street } = require('../email/acc_cover_note');
  const where = street(dec.homeowner_address);
  const result = outcome === 'denied' ? 'After reconsidering your architectural application with the additional information you sent, it was not approved.'
    : `After reconsidering your architectural application with the additional information you sent, it has been approved${outcome === 'approved_with_conditions' ? ' with conditions' : ''}.`;
  return {
    subject: `ACC Application Decision, Reconsidered – ${where || communityName || 'your application'}`,
    text: [salutation(letterBody, dec.homeowner_name), result, 'Please see the attached letter for the complete decision.', "If you have any questions, please reply to this email and I'll be happy to help.", 'Best,'].join('\n\n'),
  };
}

module.exports = { ACTIVE, OUTCOMES, NEEDS_576, normOutcome, sha256, listSupplements, listReconsiderations, getReconsideration, activeReconsideration, latestFinalization, priorDecision, snapshotOf,
  addSupplement, addEmailSupplement, emailSourceRef, openReconsideration, reconsiderationContext, reviewReconsideration, saveDraft, closeReconsideration, staleness, queueStage, authorityRow, issueRevisedDecision, composeRevisedEmail };
