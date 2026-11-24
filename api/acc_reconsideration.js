// ============================================================================
// api/acc_reconsideration.js  (Ed 2026-11-24, migration 576)
// ----------------------------------------------------------------------------
// Staff routes for what happens AFTER an ACC decision (lib/acc/reconsideration.js).
// All under /acc-review/decisions/:id, behind the staff gate, and every write
// names the signed-in person.
//
//   GET  /:id/reconsideration                    evidence, reconsiderations, decision versions
//   POST /:id/supplements            (files)     file documents / a note on the decided case
//   POST /:id/supplements/email      {email_message_id}  file an email trustEd already has
//   GET  /:id/supplements/:sid/files/:i          open one filed document
//   POST /:id/supplements/:sid/new-application   it was a different request after all
//   POST /:id/reconsideration        {reason}    open one
//   POST /:id/reconsideration/:rid/review        Annie reviews and recommends
//   PATCH /:id/reconsideration/:rid              save the letter, outcome, reason
//   POST /:id/reconsideration/:rid/close         OWNER: the decision in effect stands
//   POST /:id/reconsideration/:rid/preview       OWNER: the exact letter PDF
//   POST /:id/reconsideration/:rid/issue         OWNER: approve, seal, send, record
//   POST /:id/withdraw-duplicate     {duplicate_of, reason}  retire a duplicate (audited)
//
// deps (from server.js): supabase, BEDROCK_MGMT_CO_ID, renderLetterPdfBuffer,
//   screenForLeaks, withAppealNotice, delegationFor, resolveAuthorityDocument
// ============================================================================
const express = require('express');
const multer = require('multer');
const { getActingUser } = require('./_acting_user');
const { safeErrorMessage } = require('./_safe_error');
const DA = require('../lib/acc/decision_authority');
const R = require('../lib/acc/reconsideration');

module.exports = function accReconsiderationRouter(deps) {
  const { supabase, BEDROCK_MGMT_CO_ID, renderLetterPdfBuffer, screenForLeaks, withAppealNotice, delegationFor, resolveAuthorityDocument } = deps;
  const router = express.Router({ mergeParams: true });
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024, files: 10, fields: 20, fieldSize: 64 * 1024, parts: 40 } });
  const json = express.json({ limit: '64kb' });
  const download = async (p) => { const { data, error } = await supabase.storage.from('documents').download(p); if (error || !data) return null; return Buffer.from(await data.arrayBuffer()); };
  const who = (a) => a.full_name || a.email;
  const reply = (res, r, body) => (r.ok ? res.json({ ok: true, ...(body || r) }) : res.status(r.httpStatus || 500).json({ error: r.error }));

  async function loadCase(req, res) {
    const { data, error } = await supabase.from('acc_decisions').select('*').eq('id', req.params.id).eq('management_company_id', BEDROCK_MGMT_CO_ID).maybeSingle();
    if (error) throw error;
    if (!data) { res.status(404).json({ error: 'Application not found' }); return null; }
    return data;
  }
  async function staff(req, res) {
    const a = await getActingUser(req);
    if (!DA.isHumanActor(a)) { res.status(401).json({ error: 'Sign in to do this.' }); return null; }
    return a;
  }
  async function owner(req, res, what) {
    const a = await staff(req, res); if (!a) return null;
    if (!DA.isOwnerActor(a)) { res.status(403).json({ code: 'owner_only', error: `Only Ed can ${what}.` }); return null; }
    return a;
  }
  async function loadRecon(req, res, dec) {
    const rec = await R.getReconsideration(supabase, req.params.rid);
    if (!rec || rec.acc_decision_id !== dec.id) { res.status(404).json({ error: 'Reconsideration not found' }); return null; }
    return rec;
  }
  const route = (fn) => async (req, res) => {
    try { await fn(req, res); }
    catch (err) {
      console.error('[acc-reconsideration]', req.method, req.path, 'failed:', err.message);
      if (!res.headersSent) res.status(err.httpStatus || 500).json({ error: err.missing ? R.NEEDS_576 : safeErrorMessage(err) });
    }
  };

  router.get('/:id/reconsideration', route(async (req, res) => {
    const dec = await loadCase(req, res); if (!dec) return;
    if (dec.status !== 'decided') return res.json({ available: false });
    let supplements; let recons;
    try { [supplements, recons] = await Promise.all([R.listSupplements(supabase, dec.id), R.listReconsiderations(supabase, dec.id)]); }
    catch (e) { if (e.missing) return res.json({ available: false, reason: R.NEEDS_576 }); throw e; }
    const active = recons.find((r) => R.ACTIVE.includes(r.status)) || null;
    const { data: fins, error: fErr } = await supabase.from('acc_finalizations').select('id, version, decision_type, finalized_at, correction_reason, delivery, reconsideration_id').eq('acc_decision_id', dec.id).order('version', { ascending: true });
    if (fErr) throw fErr;
    const versions = (fins || []).slice();
    if (!versions.some((v) => v.version === 1)) versions.unshift({ id: null, version: 1, decision_type: dec.decision_type, finalized_at: dec.decided_at, correction_reason: null, delivery: null, unsealed: true });
    // Emails for this property since the decision that are not filed here yet.
    let candidates = [];
    try {
      const { resolveProperty } = require('../lib/entity_resolution');
      const prop = dec.community_id ? await resolveProperty(supabase, dec.community_id, dec.homeowner_address).catch(() => null) : null;
      if (prop && prop.id) {
        const { data: em, error: eErr } = await supabase.from('email_messages').select('id, internet_message_id, graph_id, subject, sender_email, received_at, has_attachments')
          .eq('direction', 'inbound').eq('resolved_property_id', prop.id).gte('received_at', dec.decided_at || dec.created_at).order('received_at', { ascending: false }).limit(60);
        if (eErr) throw eErr;
        const filed = new Set(supplements.map((s) => s.source_ref)); const seen = new Set();
        candidates = (em || []).filter((m) => { const k = R.emailSourceRef(m); if (filed.has(k) || seen.has(k)) return false; seen.add(k); return true; }).slice(0, 25);
      }
    } catch (e) { console.warn('[acc-reconsideration] email candidates skipped:', e.message); }
    const delegation = await delegationFor(dec.community_id);
    const { data: dups, error: dErr } = await supabase.from('acc_decisions').select('id, reference_number, status, created_at').eq('duplicate_of_id', dec.id);
    if (dErr) console.warn('[acc-reconsideration] duplicates lookup failed:', dErr.message);
    res.json({ available: true, supplements, reconsiderations: recons, active, stale: active ? R.staleness(active, supplements) : [], versions, candidates, duplicates: dups || [],
      delegation: delegation ? { reference: delegation.reference || null, document: delegation.library_document_title || null, acts_as: delegation.acts_as || null } : null });
  }));

  router.post('/:id/supplements', upload.array('files', 10), route(async (req, res) => {
    const actor = await staff(req, res); if (!actor) return;
    const dec = await loadCase(req, res); if (!dec) return;
    const r = await R.addSupplement(supabase, { dec, kind: 'upload', files: req.files || [], note: (req.body || {}).note || null, actorId: actor.id, addedBy: who(actor), matchedBy: ['staff'], download });
    reply(res, r);
  }));
  router.post('/:id/supplements/email', json, route(async (req, res) => {
    const actor = await staff(req, res); if (!actor) return;
    const dec = await loadCase(req, res); if (!dec) return;
    const id = String((req.body || {}).email_message_id || '');
    if (!id) return res.status(400).json({ error: 'Choose an email.' });
    const r = await R.addEmailSupplement(supabase, { dec, emailId: id, actorId: actor.id, addedBy: who(actor), download });
    reply(res, r);
  }));
  router.get('/:id/supplements/:sid/files/:i', route(async (req, res) => {
    const dec = await loadCase(req, res); if (!dec) return;
    const s = (await R.listSupplements(supabase, dec.id)).find((x) => x.id === req.params.sid);
    const d = s && (s.documents || [])[Number(req.params.i)];
    if (!d || !d.path) return res.status(404).json({ error: 'File not found' });
    const b = await download(d.path);
    if (!b) return res.status(404).json({ error: 'The stored file could not be read.' });
    const mime = /^(image\/(png|jpeg|gif|webp)|application\/pdf)$/i.test(d.mime || '') ? d.mime : 'application/octet-stream';
    res.setHeader('Content-Type', mime); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Disposition', `${mime === 'application/octet-stream' ? 'attachment' : 'inline'}; filename="${String(d.filename || 'file').replace(/[^A-Za-z0-9._ -]+/g, '_')}"`);
    res.send(b);
  }));
  // Intake filed it here, but it is a different request: run it as its own
  // application. The evidence row stays (append-only).
  router.post('/:id/supplements/:sid/new-application', json, route(async (req, res) => {
    const actor = await staff(req, res); if (!actor) return;
    const dec = await loadCase(req, res); if (!dec) return;
    const s = (await R.listSupplements(supabase, dec.id)).find((x) => x.id === req.params.sid);
    if (!s || !s.email_message_id) return res.status(404).json({ error: 'Only an email can be filed as a new application here.' });
    const { data: m, error } = await supabase.from('email_messages').select('*').eq('id', s.email_message_id).maybeSingle();
    if (error) throw error;
    if (!m) return res.status(404).json({ error: 'The email is no longer in trustEd.' });
    const out = await require('../lib/applications/email_intake').intakeApplicationFromEmail({ email: m, extracted: m.extracted || {}, communityId: dec.community_id, allowBodyOnly: true, forceNew: true });
    if (!out || !['created', 'exists'].includes(out.status)) return res.status(422).json({ error: `It could not be filed as a new application (${(out && out.status) || 'unknown'}).` });
    res.json({ ok: true, status: out.status, application_id: out.application_id, reference: out.reference || null });
  }));

  router.post('/:id/reconsideration', json, route(async (req, res) => {
    const actor = await staff(req, res); if (!actor) return;
    const dec = await loadCase(req, res); if (!dec) return;
    reply(res, await R.openReconsideration(supabase, { dec, reason: (req.body || {}).reason, actorId: actor.id, openedBy: who(actor) }));
  }));
  router.post('/:id/reconsideration/:rid/review', json, route(async (req, res) => {
    const actor = await staff(req, res); if (!actor) return;
    const dec = await loadCase(req, res); if (!dec) return;
    const rec = await loadRecon(req, res, dec); if (!rec) return;
    const { runEngine, isReady } = require('../lib/acc/engine_registry');
    if (!isReady()) return res.status(503).json({ error: 'The review engine is not available right now. Try again shortly.' });
    const { classifyRecommendation } = require('../lib/acc/pending_intake');
    reply(res, await R.reviewReconsideration(supabase, rec.id, { runEngine, classifyRecommendation, download, trigger: 'staff' }));
  }));
  router.patch('/:id/reconsideration/:rid', json, route(async (req, res) => {
    const actor = await staff(req, res); if (!actor) return;
    const dec = await loadCase(req, res); if (!dec) return;
    const rec = await loadRecon(req, res, dec); if (!rec) return;
    const b = req.body || {};
    reply(res, await R.saveDraft(supabase, rec.id, { letterBody: b.letter_body, outcome: b.outcome, reason: b.reason, actorId: actor.id }));
  }));
  router.post('/:id/reconsideration/:rid/close', json, route(async (req, res) => {
    const actor = await owner(req, res, 'decide that the decision in effect stands'); if (!actor) return;
    const dec = await loadCase(req, res); if (!dec) return;
    const rec = await loadRecon(req, res, dec); if (!rec) return;
    reply(res, await R.closeReconsideration(supabase, rec.id, { reason: (req.body || {}).reason, actorId: actor.id }));
  }));

  // The letter exactly as it would go out: leak screen, denial appeal notice, letterhead.
  function finalLetter(body, outcome) {
    const screen = screenForLeaks(String(body || ''), { audience: 'customer', autoRewrite: true, formalLetter: true });
    if (screen.blocks.length) { const e = new Error('blocked'); e.blocked = screen.blocks; throw e; }
    return outcome === 'denied' ? withAppealNotice(screen.text) : screen.text;
  }
  const blockedReply = (res, e) => res.status(400).json({ error: 'The letter contains internal-only phrases: ' + e.blocked.map((b) => `"${b.matches.join('", "')}"`).join(', ') });
  const render = (dec, body, bodyText, dateStr) => renderLetterPdfBuffer({ community: dec.community_name, homeowner_name: String(body.homeowner_name || '').trim() || dec.homeowner_name, homeowner_address: dec.homeowner_address,
    project_summary: `Reconsideration: ${String(dec.project_summary || 'architectural application').replace(/\s*[–—]\s*/g, ', ')}`, reference_number: dec.reference_number, body_text: bodyText, association_name: body._association_name, ...(dateStr ? { date_str: dateStr } : {}) });
  async function associationName(communityId) {
    if (!communityId) return null;
    const { data, error } = await supabase.from('communities').select('hoa_legal_name, legal_name').eq('id', communityId).maybeSingle();
    if (error) { console.warn('[acc-reconsideration] association name lookup failed:', error.message); return null; }
    return (data && (data.hoa_legal_name || data.legal_name)) || null;
  }

  router.post('/:id/reconsideration/:rid/preview', json, route(async (req, res) => {
    const actor = await owner(req, res, 'preview a decision letter that has not been issued'); if (!actor) return;
    const dec = await loadCase(req, res); if (!dec) return;
    const rec = await loadRecon(req, res, dec); if (!rec) return;
    const b = req.body || {}; let text;
    try { text = finalLetter(b.letter_body != null ? b.letter_body : rec.letter_body, R.normOutcome(b.outcome || rec.outcome)); } catch (e) { if (e.blocked) return blockedReply(res, e); throw e; }
    if (!text.trim()) return res.status(400).json({ error: 'The letter is empty.' });
    const pdf = await render(dec, { ...b, _association_name: await associationName(dec.community_id) }, text);
    res.setHeader('Content-Type', 'application/pdf'); res.setHeader('Cache-Control', 'no-store'); res.setHeader('Content-Disposition', 'inline; filename="revised_decision_preview.pdf"');
    res.send(pdf);
  }));

  router.post('/:id/reconsideration/:rid/issue', json, route(async (req, res) => {
    const actor = await owner(req, res, 'approve and issue a revised ACC decision'); if (!actor) return;
    const dec = await loadCase(req, res); if (!dec) return;
    let rec = await loadRecon(req, res, dec); if (!rec) return;
    const b = req.body || {};
    const supplements = await R.listSupplements(supabase, dec.id);
    if (!supplements.length) return res.status(409).json({ error: 'No supplemental evidence is filed on this application. Nothing was sent.' });
    const stale = R.staleness(rec, supplements);
    if (stale.length && b.acknowledge_stale !== true) return res.status(409).json({ stale: true, reasons: stale, error: stale[0] });

    const outcome = R.normOutcome(b.outcome || rec.outcome);
    let letter;
    try { letter = finalLetter(b.letter_body != null ? b.letter_body : rec.letter_body, outcome); } catch (e) { if (e.blocked) return blockedReply(res, e); throw e; }
    const reason = String(b.reason || rec.reason || '').trim();
    const saved = await R.saveDraft(supabase, rec.id, { letterBody: letter, outcome, reason, actorId: actor.id });
    if (!saved.ok) return reply(res, saved);
    rec = saved.reconsideration;

    // Who decided, under what authority: Ed's own decision on the community's
    // written delegation, or the committee's / Board's documented decision.
    // Same rules and same gate as any ACC decision (lib/acc/decision_authority).
    const delegation = await delegationFor(dec.community_id);
    const input = b.decision_record && typeof b.decision_record === 'object' ? { ...b.decision_record, outcome } : {
      decided_by: 'ed', outcome, clearly_compliant: b.confirm_compliant === true,
      authority_kind: delegation && delegation.library_document_id ? 'written_delegation' : '',
      authority_reference: (delegation && delegation.reference) || '', authority_library_document_id: (delegation && delegation.library_document_id) || '',
      notes: 'Reconsideration on supplemental evidence',
    };
    const built = DA.recordDecision(actor, input, dec);
    if (built.error) return res.status(403).json({ error: `${built.error}. Nothing was sent.` });
    const record = { ...built.rec, evaluated_by: rec.review_at ? 'annie' : built.rec.evaluated_by, reconsideration_id: rec.id, evaluator_recommendation: rec.recommendation || null };
    if (delegation && delegation.acts_as === 'committee' && record.authority_basis.kind === 'written_delegation') record.authority_basis.acts_as = 'committee';
    const docErr = await resolveAuthorityDocument(dec, record);
    if (docErr) return res.status(409).json({ error: `Decision record incomplete: ${docErr}. Nothing was sent.` });
    const gate = DA.checkFinalDecision({ ...R.authorityRow(dec, rec, record, letter), acc_delegation: delegation }, { decisionType: outcome, texts: [letter], actor, requireIssuer: true });
    if (!gate.ok) return res.status(gate.status || 409).json({ code: gate.code, error: gate.error });

    const assoc = await associationName(dec.community_id);
    const toEmail = String(b.to_email || dec.submitter_email || '').trim();
    const graph = require('../lib/email/graph_send');
    const attempt = Date.now().toString(36);
    let propertyId = null;
    try { const { resolveProperty } = require('../lib/entity_resolution'); const p = dec.community_id ? await resolveProperty(supabase, dec.community_id, dec.homeowner_address).catch(() => null) : null; propertyId = (p && p.id) || null; } catch (_) { /* stays null */ }
    let letterPath = null;

    const out = await R.issueRevisedDecision(supabase, {
      dec, rec, supplements, letterBody: letter, outcome, reason, decisionRecord: record,
      approval: { user_id: actor.id, email: String(actor.email || '').toLowerCase(), name: actor.full_name || null },
      toEmail, send: b.send === true, propertyId,
      renderLetter: (text) => render(dec, { ...b, _association_name: assoc }, text),
      sealRecord: async ({ pdf, prior, version }) => {
        const { sealFinalizedRecord } = require('../lib/record_archive');
        const base = `acc_decision/${dec.community_id || 'unknown'}/${dec.id}/v${version}-${attempt}`;
        const meta = { decision_type: outcome, reference_number: dec.reference_number || null, version, reconsideration_id: rec.id };
        const L = await sealFinalizedRecord(supabase, { record_type: 'acc_letter', record_id: dec.id, community_id: dec.community_id || null, archive_path: `${base}-letter.pdf`, buffer: pdf, sent_at: new Date().toISOString(), metadata: meta });
        if (!L || !L.sha256) throw new Error('the letter could not be sealed');
        // The earlier decision letter travels inside the complete record.
        let priorLetter = null;
        try { priorLetter = await require('../lib/acc/finalized').sealedArtifact(supabase, dec, 'letter'); } catch (e) { throw new Error(`the earlier decision letter could not be read (${e.message})`); }
        if (!priorLetter && dec.letter_pdf_storage_path) priorLetter = await download(dec.letter_pdf_storage_path);
        const pk = await require('../lib/acc/packet').buildAccPacket({ dec, letterBuffer: pdf, download, supplements, prior: priorLetter ? [{ what: `earlier decision letter (version ${prior.version}, ${String(prior.decision_type || '').replace(/_/g, ' ')})`, bytes: priorLetter }] : [] });
        if (!pk.ok) throw new Error(pk.error);
        if (pk.omitted.length) throw new Error('these could not be included in the complete record: ' + pk.omitted.map((o) => o.what).join(', '));
        const P = await sealFinalizedRecord(supabase, { record_type: 'acc_packet', record_id: dec.id, community_id: dec.community_id || null, archive_path: `${base}-packet.pdf`, buffer: pk.bytes, sent_at: new Date().toISOString(), metadata: { ...meta, included: pk.included.map((x) => x.what) } });
        if (!P || !P.sha256) throw new Error('the complete record could not be sealed');
        letterPath = `acc_decisions/${dec.id}/letter_v${version}_${attempt}.pdf`;
        const up = await supabase.storage.from('documents').upload(letterPath, pdf, { contentType: 'application/pdf', upsert: false });
        if (up && up.error) throw new Error(`the letter could not be stored (${up.error.message || up.error})`);
        return { letter: { sha256: L.sha256, archive_path: L.archive_path }, packet: { sha256: P.sha256, archive_path: P.archive_path },
          documents: pk.included.filter((x) => x.what !== 'decision letter').map((x) => ({ what: x.what, path: x.path, sha256: x.sha256, bytes: x.bytes, pages: x.pages, ...(x.supplement_id ? { supplement_id: x.supplement_id } : {}) })) };
      },
      composeEmail: async ({ pdf }) => {
        if (!graph.isConfigured()) throw new Error('email_not_configured');
        const m = R.composeRevisedEmail({ dec, outcome, letterBody: letter, communityName: dec.community_name });
        const builtMail = require('../lib/email/annie_signature').buildAnnieEmail(m.text, dec.community_name);
        const name = `${String(dec.reference_number || 'ACC_decision').replace(/[^A-Za-z0-9._-]+/g, '_')}_revised.pdf`;
        return { from: graph.ANNIE_MAILBOX, to: toEmail, subject: m.subject, text: m.text, html: builtMail.html,
          attachments: [...(builtMail.attachments || []), { '@odata.type': '#microsoft.graph.fileAttachment', name, contentType: 'application/pdf', contentBytes: pdf.toString('base64') }],
          archive_attachments: [{ name, content_type: 'application/pdf', sha256: R.sha256(pdf), bytes: pdf.length }] };
      },
      // Re-verified at the transport: this case, this approved reconsideration, its applicant only.
      sendEmail: async (c) => {
        const sent = await graph.sendAs({ from: c.from, to: c.to, subject: c.subject, html: c.html, attachments: c.attachments, communityId: dec.community_id || null, accDecisionId: dec.id, accReconsiderationId: rec.id });
        if (sent && sent.suppressed) throw new Error(`the email was not sent (${sent.reason || 'suppressed'})`);
      },
    });
    if (!out.ok) { console.error('[acc-reconsideration] issue failed:', dec.id, out.error); return res.status(out.httpStatus || 500).json({ error: out.error, email: out.email || null, reverted: out.reverted }); }

    // Homeowner timeline + Annie's sent mail. The decision is already recorded,
    // so a logging failure is reported, never undone. No fee, no charge.
    const warnings = [];
    const label = `${outcome.replace(/_/g, ' ')}${dec.reference_number ? ' (' + dec.reference_number + ')' : ''}`;
    if (dec.community_id) {
      const { error } = await supabase.from('interactions').insert({ community_id: dec.community_id, property_id: propertyId, type: 'letter_other', direction: 'outbound', delivery_method: out.email.sent ? 'email' : 'portal',
        subject: `ACC revised decision: ${label}, version ${out.finalization.version}`, content: letter.slice(0, 4000), attachments: [{ type: 'acc_letter', storage_path: letterPath, label: 'ACC revised decision letter', sha256: out.finalization.letter_sha256 }],
        source: 'forward', status: 'sent', sent_at: new Date().toISOString(), sent_by_user_id: actor.id, ai_drafted: !!rec.reviewed_letter_body });
      if (error) { console.warn('[acc-reconsideration] timeline log failed:', error.message); warnings.push('The homeowner timeline entry was not saved.'); }
    }
    if (out.email.sent) {
      const { error } = await supabase.from('email_messages').insert({ mailbox: graph.ANNIE_MAILBOX, direction: 'outbound', sender_email: graph.ANNIE_MAILBOX, sender_name: 'Annie Reeves (Bedrock AI)', recipients: [toEmail], subject: out.composed.subject, body_preview: out.composed.text.slice(0, 400), body_full: out.composed.text,
        classification: 'outbound_reply', classification_confidence: 'high', persona: 'annie', ai_summary: `Annie sent the revised ACC decision (${outcome.replace(/_/g, ' ')}) for ${dec.homeowner_address || ''}`.trim(), resolved_property_id: propertyId, community_id: dec.community_id || null,
        triage_status: 'handled', record_ownership: 'association_record', reviewed_at: new Date().toISOString(), received_at: new Date().toISOString() });
      if (error) { console.warn('[acc-reconsideration] sent-mail log failed:', error.message); warnings.push("Annie's sent-mail entry was not saved."); }
    }
    // Portal status shows the decision in effect. final_decided_at is left alone:
    // it is the date the application was billed by.
    if (dec.community_application_id) {
      const { error } = await supabase.from('community_applications').update({ final_status: outcome === 'denied' ? 'denied' : 'approved', decision_letter_html: letter, updated_at: new Date().toISOString() }).eq('id', dec.community_application_id);
      if (error) { console.warn('[acc-reconsideration] portal status not updated:', error.message); warnings.push('The homeowner portal status was not updated.'); }
    }
    res.json({ ok: true, version: out.finalization.version, decision_type: outcome, email: out.email, finalization_id: out.finalization.id, warnings });
  }));

  // Retire an open application that duplicates another. The record, its documents
  // and its correspondence are kept and it names the original; its unsent
  // acknowledgments are cancelled. Never a finalized case. Audited first.
  router.post('/:id/withdraw-duplicate', json, route(async (req, res) => {
    const actor = await staff(req, res); if (!actor) return;
    const dec = await loadCase(req, res); if (!dec) return;
    const b = req.body || {};
    const reason = String(b.reason || '').trim(); const want = String(b.duplicate_of || '').trim();
    if (!want || !reason) return res.status(400).json({ error: 'Say which application this duplicates and why.' });
    if (dec.finalization_id || !['pending_review', 'awaiting_info', 'withdrawn'].includes(dec.status)) return res.status(409).json({ error: `This application is ${dec.status}; only an open application can be withdrawn as a duplicate.` });
    if (dec.status === 'withdrawn' && dec.duplicate_of_id) return res.status(409).json({ error: 'It is already withdrawn as a duplicate.' });
    const isId = /^[0-9a-f-]{36}$/i.test(want);
    let q = supabase.from('acc_decisions').select('id, reference_number, community_id, status, duplicate_of_id').eq('management_company_id', BEDROCK_MGMT_CO_ID);
    q = isId ? q.eq('id', want) : q.eq('reference_number', want.toUpperCase());
    const { data: orig, error: oErr } = await q.limit(2);
    if (oErr) throw oErr;
    if (!orig || orig.length !== 1) return res.status(404).json({ error: 'The original application was not found.' });
    const o = orig[0];
    if (o.id === dec.id || o.community_id !== dec.community_id || o.duplicate_of_id || ['withdrawn', 'archived'].includes(o.status)) return res.status(409).json({ error: 'The original must be another live application in the same association.' });
    const { recordAuditEvent, routeOf } = require('../lib/audit/record_event');
    await recordAuditEvent(supabase, { community_id: dec.community_id, actor_user_id: actor.id, actor_name: who(actor), entity_type: 'acc_decision', entity_id: dec.id, action: 'acc.withdrawn_duplicate', previous_value: { status: dec.status, reference_number: dec.reference_number }, new_value: { status: 'withdrawn', duplicate_of_id: o.id, duplicate_of_reference: o.reference_number }, reason, route: routeOf(req) });
    const up = await supabase.from('acc_decisions').update({ status: 'withdrawn', duplicate_of_id: o.id, updated_at: new Date().toISOString() }).eq('id', dec.id).eq('status', dec.status).is('finalization_id', null).select('id');
    if (up.error) throw Object.assign(new Error(up.error.message), { missing: /duplicate_of_id/.test(up.error.message), httpStatus: /duplicate_of_id/.test(up.error.message) ? 503 : 500 });
    if (!up.data || !up.data.length) return res.status(409).json({ error: 'The application changed while saving; reload and try again.' });
    const dr = await supabase.from('outbound_email_drafts').update({ status: 'discarded' }).eq('related_type', 'acc_decision').eq('related_id', dec.id).eq('draft_kind', 'acknowledgment').eq('status', 'draft').select('id');
    if (dr.error) console.warn('[acc-reconsideration] acknowledgment drafts not cancelled:', dr.error.message);
    res.json({ ok: true, duplicate_of: o.reference_number, acknowledgments_cancelled: dr.error ? null : (dr.data || []).length, ...(dr.error ? { warning: 'Withdrawn, but its unsent acknowledgments could not be cancelled. Check the Draft Queue.' } : {}) });
  }));

  return router;
};
