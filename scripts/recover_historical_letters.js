#!/usr/bin/env node
// ============================================================================
// scripts/recover_historical_letters.js  (Issue #11)
// ----------------------------------------------------------------------------
// Restore Trusted's record of certified notices that were physically mailed on
// a past date but whose record was lost (drafts mailed outside the Mail Queue,
// later rejected or deleted by draft cleanup). Needs migration 475.
//
//   node scripts/recover_historical_letters.js <manifest.json>          dry run
//   node scripts/recover_historical_letters.js <manifest.json> --apply  write
//
// The manifest lives OUTSIDE the repo (it carries tracking numbers and points
// at the reviewed PDFs). Shape:
//   { community_id, recovered_by, entries: [{
//       violation_id, mailed_on: 'YYYY-MM-DD', mailed_at?: ISO (receipt acceptance time),
//       tracking_number?, return_receipt_requested?: bool, receipt_evidence?: {...},
//       provenance: 'recovered_original' | 'reconstructed',
//       source: { bucket: 'violation-letters', path } | { file },
//       sha256, prior_interaction_id?, reuse_draft?: bool,
//       reconstruction?: {...}, reason }] }
//
// What one entry writes (in this order; each step is safe to re-run):
//   1. the exact bytes into sent-letters-archive (write-once) and a working copy
//      in violation-letters so existing viewers open it;
//   2. the mailed-notice interaction: the July draft itself when reuse_draft is
//      set and its PDF is byte-identical, otherwise a NEW 'sent' row. created_at
//      is the true write time; sent_at is the mailing time;
//   3. a letter_mail_pieces row (provider 'manual', certified, tracking number);
//   4. a sent_letter_archive row (hash of the exact bytes);
//   5. the letter_recovery_records row, which seals the interaction (475).
// Never touched: violations (voided / superseded stay so), the July rejected
// rows, any owner ledger, AR or GL. Certified fees are NOT posted here; the
// script refuses a community whose certified-fee autopost could fire on these
// mail pieces.
// ============================================================================
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ACTOR = 'historical_letter_recovery';
const SENT_ARCHIVE_BUCKET = 'sent-letters-archive';
const LETTERS_BUCKET = 'violation-letters';
const CERTIFIED_FEE_START = '2026-08-01'; // lib/enforcement/certified_fee.js
const TYPE_TO_STAGE = { letter_209: 'certified_209', letter_courtesy_1: 'courtesy_1', letter_courtesy_2: 'courtesy_2' };

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const centralDate = (iso) => new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
const recoveryKey = (propertyId, mailedOn, violationId) => `${propertyId}:${mailedOn}:${violationId}`;
const archivePath = (e, communityId) => `${communityId}/${e.violation_id}/recovered-${e.mailed_on}-${e.sha256.slice(0, 12)}.pdf`;
const workingPath = (e) => `${e.violation_id}/recovered-certified_209-${e.mailed_on}-${e.sha256.slice(0, 12)}.pdf`;

// Pure: decide what one entry needs, from facts already read. Returns
// { ok, action, problems[], ... }. action: 'already_recorded' | 'reuse_draft' | 'new_sent'.
function planEntry(e, facts, communityId) {
  const problems = [];
  const v = facts.violation;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(e.mailed_on || '')) problems.push('mailed_on must be YYYY-MM-DD (the certified receipt date)');
  if (e.mailed_at && centralDate(e.mailed_at) !== e.mailed_on) problems.push(`mailed_at ${e.mailed_at} is not on ${e.mailed_on} (Central)`);
  if (!['recovered_original', 'reconstructed'].includes(e.provenance)) problems.push('provenance must be recovered_original or reconstructed');
  if (e.provenance === 'reconstructed' && !e.reconstruction) problems.push('a reconstruction must record how it was made');
  if (e.provenance === 'recovered_original' && e.reconstruction) problems.push('an original must not carry reconstruction detail');
  if (!e.reason || !String(e.reason).trim()) problems.push('reason is required');
  if (!/^[0-9a-f]{64}$/.test(e.sha256 || '')) problems.push('sha256 (of the reviewed PDF) is required');
  if (!v) problems.push('violation not found');
  else if (v.community_id !== communityId) problems.push('violation belongs to another community');
  const bytes = facts.bytes;
  if (!bytes) problems.push('PDF bytes could not be read from the source');
  else {
    if (bytes.slice(0, 5).toString() !== '%PDF-') problems.push('source is not a PDF');
    if (sha256(bytes) !== e.sha256) problems.push(`source bytes hash ${sha256(bytes).slice(0, 12)} does not match the reviewed ${String(e.sha256).slice(0, 12)}`);
  }
  const prior = facts.prior;
  if (e.prior_interaction_id) {
    if (!prior) problems.push('prior interaction not found');
    else {
      if (prior.violation_id !== e.violation_id) problems.push('prior interaction belongs to another violation');
      // 'sent' is accepted only when resuming a reuse_draft run that already marked this draft mailed.
      const resuming = e.reuse_draft && prior.status === 'sent' && facts.priorBytes && sha256(facts.priorBytes) === e.sha256;
      if (!['draft', 'rejected'].includes(prior.status) && !resuming) problems.push(`prior interaction is '${prior.status}', expected a July draft or rejected row`);
      if (e.mailed_on && centralDate(prior.created_at) > e.mailed_on) problems.push('prior interaction was created after the mailing date');
    }
  }
  const existing = facts.existingRecovery;
  if (existing) {
    if (existing.sha256 !== e.sha256) problems.push('a recovery for this key already exists with DIFFERENT bytes; investigate');
    return { ok: problems.length === 0, action: 'already_recorded', problems };
  }
  let action = 'new_sent';
  if (e.reuse_draft) {
    if (!prior || !['draft', 'sent'].includes(prior.status)) problems.push('reuse_draft needs a prior interaction that is still a draft');
    else if (!facts.priorBytes || sha256(facts.priorBytes) !== e.sha256) problems.push('reuse_draft needs the draft PDF to be byte-identical to the reviewed PDF');
    else action = 'reuse_draft';
  }
  if (facts.feeAutopost && e.mailed_on >= CERTIFIED_FEE_START) problems.push('certified-fee autopost is on and this mailing is on/after its start date; the mail piece would post a fee');
  return { ok: problems.length === 0, action, problems };
}

async function main() {
  const file = process.argv[2];
  const apply = process.argv.includes('--apply');
  if (!file) { console.error('usage: recover_historical_letters.js <manifest.json> [--apply]'); process.exit(2); }
  const m = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
  if (!m.community_id || !m.recovered_by || !Array.isArray(m.entries) || !m.entries.length) throw new Error('manifest needs community_id, recovered_by and entries');

  const { createClient } = require('@supabase/supabase-js');
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
  const must = async (q, what) => { const { data, error } = await q; if (error) throw new Error(what + ': ' + error.message); return data; };
  const download = async (bucket, p) => { const { data, error } = await sb.storage.from(bucket).download(p); if (error || !data) return null; return Buffer.from(await data.arrayBuffer()); };

  const comm = await must(sb.from('communities').select('id, name, certified_fee_autopost').eq('id', m.community_id).single(), 'community');
  // Before migration 475 is applied a dry run still validates every entry; --apply refuses.
  const probe = await sb.from('letter_recovery_records').select('id').limit(1);
  const has475 = !probe.error;
  if (!has475 && apply) throw new Error('migration 475 is not applied (letter_recovery_records missing); apply it first');
  if (!has475) console.log('NOTE: migration 475 not applied yet; validating only.\n');

  // Read everything and plan every entry before any write (all-or-nothing gate).
  const plans = [];
  for (const e of m.entries) {
    const violation = await must(sb.from('violations').select('id, community_id, property_id, current_stage').eq('id', e.violation_id).maybeSingle(), 'violation');
    const prior = e.prior_interaction_id ? await must(sb.from('interactions').select('id, violation_id, observation_id, type, status, content, created_at, bundle_id').eq('id', e.prior_interaction_id).maybeSingle(), 'prior interaction') : null;
    const bytes = e.source && e.source.file ? (fs.existsSync(e.source.file) ? fs.readFileSync(e.source.file) : null)
      : e.source && e.source.bucket ? await download(e.source.bucket, e.source.path) : null;
    const priorBytes = e.reuse_draft && prior && prior.content ? await download(LETTERS_BUCKET, prior.content) : null;
    const key = violation ? recoveryKey(violation.property_id, e.mailed_on, e.violation_id) : null;
    const existingRecovery = key && has475 ? await must(sb.from('letter_recovery_records').select('id, sha256, interaction_id').eq('recovery_key', key).maybeSingle(), 'existing recovery') : null;
    const p = planEntry(e, { violation, prior, bytes, priorBytes, existingRecovery, feeAutopost: !!comm.certified_fee_autopost }, m.community_id);
    plans.push({ e, violation, prior, bytes, key, ...p });
    console.log(`${e.violation_id.slice(0, 8)} mailed ${e.mailed_on} ${e.provenance.padEnd(18)} ${p.action.padEnd(16)} ${p.ok ? 'ok' : 'BLOCKED: ' + p.problems.join('; ')}`);
  }
  if (plans.some((p) => !p.ok)) throw new Error('one or more entries are blocked; nothing written');
  if (!apply) { console.log(`\nDRY RUN (${comm.name}): nothing written. Re-run with --apply after review.`); return; }

  for (const p of plans) {
    if (p.action === 'already_recorded') continue;
    const { e, violation, prior, bytes } = p;
    const sentAt = e.mailed_at || `${e.mailed_on}T12:00:00-05:00`;
    const arch = archivePath(e, m.community_id);
    const work = workingPath(e);
    // 1. bytes: write-once archive + working copy (an existing object must be the same bytes)
    for (const [bucket, objPath] of [[SENT_ARCHIVE_BUCKET, arch], [LETTERS_BUCKET, work]]) {
      if (p.action === 'reuse_draft' && bucket === LETTERS_BUCKET) continue;
      const { error } = await sb.storage.from(bucket).upload(objPath, bytes, { contentType: 'application/pdf', upsert: false });
      if (error && !/exists|already|duplicate/i.test(error.message)) throw new Error(`${bucket} upload failed: ${error.message}`);
      if (error) { const have = await download(bucket, objPath); if (!have || sha256(have) !== e.sha256) throw new Error(`${bucket}/${objPath} exists with different bytes`); }
    }
    // 2. the mailed-notice interaction
    let interactionId;
    const note = `Certified notice mailed ${e.mailed_on}; Trusted record restored ${new Date().toISOString().slice(0, 10)} (${e.provenance.replace('_', ' ')}). See letter_recovery_records.`;
    if (p.action === 'reuse_draft') {
      await must(sb.from('interactions').update({ status: 'sent', sent_at: sentAt, delivery_method: 'certified_mail', certified_tracking_number: e.tracking_number || null, notes: note })
        .eq('id', prior.id).eq('status', 'draft'), 'mark draft mailed');
      interactionId = prior.id;
    } else {
      const found = await must(sb.from('interactions').select('id').eq('violation_id', e.violation_id).eq('content', work).eq('status', 'sent').maybeSingle(), 'find restored interaction');
      interactionId = found && found.id;
      if (!interactionId) {
        const row = await must(sb.from('interactions').insert({
          community_id: m.community_id, property_id: violation.property_id, violation_id: e.violation_id,
          observation_id: (prior && prior.observation_id) || null, type: (prior && prior.type) || 'letter_209', direction: 'outbound',
          subject: `Certified notice mailed ${e.mailed_on} (record restored)`, content: work, delivery_method: 'certified_mail',
          certified_tracking_number: e.tracking_number || null, status: 'sent', sent_at: sentAt, ai_drafted: false, source: 'manual', notes: note,
        }).select('id').single(), 'insert restored interaction');
        interactionId = row.id;
      }
    }
    // 3. mail piece (unified mailed-letter trail)
    await must(sb.from('letter_mail_pieces').upsert({
      interaction_id: interactionId, community_id: m.community_id, property_id: violation.property_id, violation_id: e.violation_id,
      bundle_id: (prior && prior.bundle_id) || null, stage_at_send: TYPE_TO_STAGE[(prior && prior.type) || 'letter_209'] || 'certified_209',
      letter_pdf_storage_path: p.action === 'reuse_draft' ? prior.content : work, provider: 'manual', delivery_method: 'certified_mail',
      return_receipt_requested: !!e.return_receipt_requested, tracking_number: e.tracking_number || null, status: 'submitted',
      submitted_at: sentAt, mailed_at: sentAt,
      events: [{ ts: new Date().toISOString(), type: 'historical_recovery', note: `Mailed ${e.mailed_on} per certified receipt; record restored by ${ACTOR}` }],
    }, { onConflict: 'interaction_id' }), 'mail piece');
    // 4. sealed-archive ledger
    const { error: aErr } = await sb.from('sent_letter_archive').insert({
      interaction_id: interactionId, community_id: m.community_id, violation_id: e.violation_id, property_id: violation.property_id,
      letter_type: (prior && prior.type) || 'letter_209', sent_at: sentAt, postmark_date: e.mailed_on,
      archive_path: arch, source_path: e.source.path || e.source.file, sha256: e.sha256, bytes: bytes.length,
    });
    if (aErr && !/duplicate|unique/i.test(aErr.message)) throw new Error('sent_letter_archive: ' + aErr.message);
    // 5. provenance row (seals the interaction)
    await must(sb.from('letter_recovery_records').insert({
      recovery_key: p.key, community_id: m.community_id, property_id: violation.property_id, violation_id: e.violation_id,
      interaction_id: interactionId, prior_interaction_id: e.prior_interaction_id || null, mailed_on: e.mailed_on, mailed_at: e.mailed_at || null,
      delivery_method: 'certified_mail', provenance: e.provenance, source_path: e.source.path || path.basename(e.source.file),
      sha256: e.sha256, bytes: bytes.length, archive_path: arch, reconstruction: e.reconstruction || null,
      receipt_evidence: { receipt_date: e.mailed_on, tracking_number: e.tracking_number || null, acceptance_time: e.mailed_at || null,
        sent_at_basis: e.mailed_at ? 'receipt_acceptance_time' : 'receipt_date_only_noon_central', ...(e.receipt_evidence || {}) },
      reason: e.reason, recovered_by: m.recovered_by,
    }), 'recovery record');
    console.log(`recorded ${e.violation_id.slice(0, 8)} mailed ${e.mailed_on} -> interaction ${interactionId.slice(0, 8)} (${p.action})`);
  }
}

if (require.main === module) main().catch((err) => { console.error('ERR', err.message); process.exit(1); });
module.exports = { planEntry, recoveryKey, archivePath, workingPath };
