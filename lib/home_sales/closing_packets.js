// ============================================================================
// lib/home_sales/closing_packets.js  (Ed 2026-11-26)
// ----------------------------------------------------------------------------
// Every closing packet scanned in Home Sales is FILED the moment it is read:
// the PDF/image in storage plus one library_documents row carrying what was
// read (property, settlement date, buyer, seller, title company, every check).
//
// WHY: the scan used to keep the packet and its reading only in the browser.
// A closing that stopped before it was recorded (the builder proration waiting
// for confirmation, a refused transfer, staff closing the tab) left nothing in
// trustEd: 8206 Rustic Pine Trail settled 9/22/2026, its title packet and two
// checks were scanned, and trustEd still showed the builder as owner with no
// trace of the sale. Now the packet is on file, linked to the lot, and listed
// under "Closing packets not yet recorded" until a recorded closing points at
// it (home_sales.source_document_id).
//
// Storage: the same rails Mail Scan uses (bucket 'documents', library_documents
// category 'scanned_mail', source_origin 'mail_scan'), told apart by
// extraction_notes.kind = 'closing_packet'. Idempotent by file hash.
// Record ownership: association_record (closing documents for the lot).
// ============================================================================
const crypto = require('crypto');

const KIND = 'closing_packet';
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// The reading as stored. PURE.
function packetNotes({ extracted, match, propertyId, fileName }) {
  const ex = extracted || {};
  return {
    kind: KIND,
    property_id: propertyId || null,
    property_match_status: match ? match.status : null,
    property_address: ex.property_address || null,
    closing_date: ex.closing_date || null,
    seller_name: ex.seller_name || null,
    buyer_name: ex.buyer_name || null,
    buyer_mailing_address: ex.buyer_mailing_address || null,
    title_company_name: ex.title_company_name || null,
    document_type: ex.document_type || null,
    checks: Array.isArray(ex.checks) ? ex.checks.map((c) => ({
      check_number: c.check_number || null, amount_cents: c.amount_cents == null ? null : Number(c.amount_cents),
      check_date: c.check_date || null, payee: c.payee || null, memo: c.memo || null, classification: c.classification || null,
    })) : [],
    check_total_cents: ex.check_total_cents == null ? null : Number(ex.check_total_cents),
    notes: ex.notes || null,
    file_name: fileName || null,
  };
}

function packetTitle(notes) {
  return `Closing packet: ${notes.property_address || 'property not read'}${notes.closing_date ? ` (settled ${notes.closing_date})` : ''}`.slice(0, 300);
}

// File one scanned packet. Returns { id, deduped }. Throws on a real failure.
async function fileClosingPacket(supabase, { communityId, managementCompanyId, buffer, fileName, mime, extracted, match, propertyId }) {
  if (!communityId) throw new Error('community_id_required');
  if (!buffer || !buffer.length) throw new Error('file_required');
  const hash = sha256(buffer);
  const notes = packetNotes({ extracted, match, propertyId, fileName });
  const { data: found, error: fErr } = await supabase.from('library_documents').select('id, extraction_notes').eq('file_hash', hash).maybeSingle();
  if (fErr) throw new Error(fErr.message);
  if (found) {
    // A re-scan of a packet already on file: keep the row; record the property if it was not known.
    let prior = null; try { prior = JSON.parse(found.extraction_notes || 'null'); } catch (_) { prior = null; }
    // The same file filed first by Mail Scan: that row BECOMES the packet (one row, no duplicate).
    if (!prior || prior.kind !== KIND) {
      const { error } = await supabase.from('library_documents').update({ title: packetTitle(notes), extraction_notes: JSON.stringify({ ...notes, mail_scan: prior || null }).slice(0, 60000) }).eq('id', found.id);
      if (error) throw new Error(error.message);
      return { id: found.id, deduped: true, converted_from_mail_scan: true };
    }
    if (prior && prior.kind === KIND && !prior.property_id && notes.property_id) {
      const { error } = await supabase.from('library_documents').update({ extraction_notes: JSON.stringify({ ...prior, property_id: notes.property_id, property_match_status: notes.property_match_status }) }).eq('id', found.id);
      if (error) throw new Error(error.message);
    }
    return { id: found.id, deduped: true };
  }
  const safe = String(fileName || 'closing-packet.pdf').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
  const path = `home-sales/${communityId}/${hash.slice(0, 12)}-${safe}`;
  const { error: upErr } = await supabase.storage.from('documents').upload(path, buffer, { contentType: mime || 'application/pdf', upsert: true });
  if (upErr && !/already exists/i.test(upErr.message || '')) throw new Error(upErr.message);
  const { data: doc, error: dErr } = await supabase.from('library_documents').insert({
    management_company_id: managementCompanyId, community_id: communityId,
    category: 'scanned_mail', title: packetTitle(notes),
    file_name_original: fileName || null, file_path: path, file_hash: hash, file_size_bytes: buffer.length,
    extraction_notes: JSON.stringify(notes).slice(0, 60000),
    created_by_mgmt_company: 'Bedrock', source_origin: 'mail_scan', uploaded_at: new Date().toISOString(),
  }).select('id').single();
  if (dErr) throw new Error(dErr.message);
  return { id: doc.id, deduped: false };
}

// Closing packets on file for a community that no recorded closing points at.
async function listUnrecordedPackets(supabase, communityId) {
  const { data: docs, error } = await supabase.from('library_documents')
    .select('id, title, file_name_original, uploaded_at, extraction_notes')
    .eq('community_id', communityId).eq('category', 'scanned_mail').like('extraction_notes', `%"kind":"${KIND}"%`)
    .order('uploaded_at', { ascending: false }).limit(500);
  if (error) throw new Error(error.message);
  const ids = (docs || []).map((d) => d.id);
  if (!ids.length) return [];
  const { data: sales, error: sErr } = await supabase.from('home_sales').select('id, source_document_id').in('source_document_id', ids);
  if (sErr) throw new Error(sErr.message);
  const used = new Set((sales || []).map((s) => s.source_document_id));
  const parsed = (docs || []).filter((d) => !used.has(d.id)).map((d) => {
    let n = {}; try { n = JSON.parse(d.extraction_notes || '{}'); } catch (_) { n = {}; }
    return { id: d.id, title: d.title, file_name: d.file_name_original, uploaded_at: d.uploaded_at, ...n };
  });
  const closed = await closedSalesFor(supabase, parsed.map((p) => p.property_id).filter(Boolean));
  return parsed.filter((p) => !recordedByLotAndDate(p, closed)).map((p) => ({ ...p, next_action: packetNextAction(p).next_action }));
}

// A closing recorded for the packet's lot and settlement date counts as recorded
// even when the sale was saved without the packet link (e.g. a Home Sales page
// opened before packets were filed). Read-only; nothing is relinked here.
async function closedSalesFor(supabase, propertyIds) {
  const ids = [...new Set(propertyIds)];
  if (!ids.length) return [];
  const { data, error } = await supabase.from('home_sales').select('id, property_id, closing_date, status').in('property_id', ids).eq('status', 'closed').limit(1000);
  if (error) throw new Error(error.message);
  return data || [];
}
function recordedByLotAndDate(notes, closedSales) {
  return !!(notes && notes.property_id && notes.closing_date
    && (closedSales || []).some((s) => s.property_id === notes.property_id && String(s.closing_date).slice(0, 10) === String(notes.closing_date).slice(0, 10)));
}

// ---- Checks in a packet -> Check Receipts (Emma) ----------------------------
// Every check payable to the ASSOCIATION in a filed packet becomes one Check
// Receipt in status 'scanned': physically received, nothing more. Posting to
// the ledger, deposit and bank clearance happen only through the existing
// Check Receipts steps (record -> deposit with the bank's confirmation ->
// reconcile to the bank line); nothing here marks a check posted or deposited.
// Checks payable to Bedrock (its own transfer fee) are not Association money:
// they stay listed on the packet and never enter the Association's receipts.
// Idempotent: one receipt per (packet, check number, amount).
const STAGE = {
  scanned: 'received (scanned), not posted', matched: 'received and matched, not posted', recorded: 'posted to the ledger, not deposited',
  deposited: 'deposited, not yet cleared by the bank', reconciled: 'cleared the bank', exception: 'needs a person', returned: 'returned by the bank', voided: 'voided',
};
const isAssocCheck = (c) => c && (c.classification === 'ASSOCIATION_PAYMENT' || (/association|hoa/i.test(String(c.payee || '')) && !/bedrock/i.test(String(c.payee || ''))));
const receiptKey = (documentId, c) => crypto.createHash('sha256').update(`closing_packet:${documentId}:${c.check_number || ''}:${c.amount_cents || ''}`).digest('hex');

async function registerPacketChecks(supabase, { documentId, communityId, notes, actor = 'emma (closing packet intake)', gate = null }) {
  const out = { created: [], existing: [], skipped: [] };
  const checks = (notes && notes.checks || []).filter((c) => isAssocCheck(c) && Number(c.amount_cents) > 0);
  if (!checks.length) return out;
  try { await (gate || ((cid, what) => require('../community/lifecycle').assertCanDo('financials', cid, what)))(communityId, 'Registering checks from a closing packet'); }
  catch (e) { out.skipped.push({ reason: e.message }); console.warn('[closing-packets] checks not registered:', JSON.stringify({ documentId, reason: e.message })); return out; }
  for (const c of checks) {
    const key = receiptKey(documentId, c);
    const { data: ex, error: exErr } = await supabase.from('homeowner_check_receipts').select('id, status').eq('front_sha256', key).limit(1);
    if (exErr) throw new Error(exErr.message);
    if (ex && ex.length) { out.existing.push(ex[0].id); continue; }
    const row = {
      community_id: communityId, scan_batch_id: documentId, status: 'scanned', front_document_id: documentId, front_sha256: key,
      check_number: c.check_number || null, amount_cents: Number(c.amount_cents), check_date: c.check_date || null,
      payer_name: notes.title_company_name || null, payee_name: c.payee || null, memo: c.memo || null,
      property_id: notes.property_id || null,
      extracted: { source: 'closing_packet', closing_packet_document_id: documentId, settlement_date: notes.closing_date || null,
        seller_name: notes.seller_name || null, buyer_name: notes.buyer_name || null,
        note: 'Physically received in a scanned closing packet. Not posted, not deposited. Which account it applies to (seller, buyer, fee) is decided at recording.' },
      created_by: actor,
    };
    const { data, error } = await supabase.from('homeowner_check_receipts').insert(row).select('id').single();
    if (error) { if (String(error.code) === '23505') { out.existing.push(null); continue; } throw new Error(error.message); }
    out.created.push(data.id);
  }
  return out;
}

async function packetReceipts(supabase, documentId) {
  const { data, error } = await supabase.from('homeowner_check_receipts').select('id, status, check_number, amount_cents, check_date, deposit_id')
    .eq('front_document_id', documentId).limit(50);
  if (error) throw new Error(error.message);
  return data || [];
}

// ---- The next action for a filed packet, and Amanda's oversight -------------
const DAY = 86400000;
const addDays = (ymd, n) => new Date(Date.parse(`${String(ymd).slice(0, 10)}T12:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const money = (c) => (c == null ? '?' : `$${(Number(c) / 100).toFixed(2)}`);
const isAssoc = (c) => c && (c.classification === 'ASSOCIATION_PAYMENT' || (/association|hoa/i.test(String(c.payee || '')) && !/bedrock/i.test(String(c.payee || ''))));

// PURE. notes = packetNotes(...) as stored; recorded = a home sale points at the packet.
function packetNextAction(notes, { recorded = false, today = new Date().toISOString().slice(0, 10), filedAt = null, receipts = null } = {}) {
  const n = notes || {};
  // receipts: the packet's Association checks in Check Receipts. The item is done only
  // when the closing is recorded AND every Association check has cleared the bank.
  const assoc = (n.checks || []).filter((c) => isAssocCheck(c) && Number(c.amount_cents) > 0);
  const allCleared = receipts == null ? !assoc.length : (assoc.length === 0 || (receipts.length >= assoc.length && receipts.every((r) => ['reconciled', 'voided'].includes(r.status))));
  if (recorded && allCleared) return { done: true, next_action: 'Closing recorded and every Association check cleared the bank.' };
  const checks = (n.checks || []).filter((c) => c && c.amount_cents != null);
  const voids = checks.filter((c) => c.check_date).map((c) => ({ ...c, void_on: addDays(c.check_date, 90) })).sort((a, b) => a.void_on.localeCompare(b.void_on));
  const steps = [];
  const stageOf = (c) => { const r = (receipts || []).find((x) => String(x.check_number || '') === String(c.check_number || '') && Number(x.amount_cents) === Number(c.amount_cents)); return r ? r.status : null; };
  if (!n.property_id) steps.push('Reese: match the packet to its lot');
  if (voids.length) steps.push(`checks: ${voids.map((c) => `#${c.check_number || '?'} ${money(c.amount_cents)} to ${c.payee || '?'} (void ${c.void_on}; ${isAssocCheck(c) ? (STAGE[stageOf(c)] || 'not yet in Check Receipts') : 'Bedrock fee, not Association money'})`).join('; ')}`);
  if (assoc.some((c) => !['recorded', 'deposited', 'reconciled'].includes(stageOf(c)))) steps.push('Kat reconciles what the title company paid against the ledger and records each Association check once approved (no posting before that)');
  if (assoc.some((c) => ['recorded'].includes(stageOf(c)))) steps.push('Emma prepares the deposit; it counts only on the bank\'s confirmation');
  if (assoc.some((c) => ['deposited'].includes(stageOf(c)))) steps.push('Kat reconciles the deposit to the bank line');
  if (!recorded) steps.push(`Reese: record the closing in Home Sales with the settlement date${n.closing_date ? ` ${n.closing_date}` : ''}`);
  const firstVoid = voids.length ? voids[0].void_on : null;
  // Ed 2026-11-26: the first action (the packet's disposition: checks in hand,
  // deposited, outstanding, lost or reissue) is due the NEXT BUSINESS DAY after
  // the packet is filed, never a week before a check voids.
  const { addBusinessDays } = require('../builder_arc/deadlines');
  const from = filedAt || `${today}T15:00:00Z`;
  const nextBiz = addBusinessDays(new Date(from).toISOString(), 1).slice(0, 10);
  // Checks not yet deposited that void within 21 days are critical (Ed: December 14, 15, 21 first).
  const undeposited = voids.filter((c) => isAssocCheck(c) && !['deposited', 'reconciled', 'voided'].includes(stageOf(c)));
  const soonest = undeposited.length ? undeposited[0].void_on : null;
  const daysLeft = soonest ? Math.round((Date.parse(`${soonest}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / DAY) : null;
  return { done: false, next_action: `${steps.join('; ')}.`, next_action_due: `${nextBiz}T23:00:00Z`, first_void: firstVoid, soonest_undeposited_void: soonest,
    priority: daysLeft != null && daysLeft <= 21 ? 'critical' : (checks.length ? 'high' : 'normal') };
}

// Amanda's subject evaluator (lib/manager/subjects.js KINDS.closing_packet). PURE.
function evaluatePacket(row) {
  const n = row && row.notes ? row.notes : {};
  const refs = { table: 'library_documents', id: row.id, property_id: n.property_id || null, closing_date: n.closing_date || null };
  const base = { domain: 'ops', objective_type: 'resale', owner_kind: 'workflow', owner_key: 'home_sales.closing_packet', community_id: row.community_id || null, subject_refs: refs };
  const na = packetNextAction(n, { recorded: row.recorded, today: row.today, filedAt: row.filed_at || null, receipts: row.receipts || null });
  if (na.done) return { ...base, basis: { recorded: true }, action: 'clear', outcome: 'resolved', reason: 'closing recorded from the packet' };
  return { ...base, basis: { property_id: n.property_id || null, closing_date: n.closing_date || null, checks: (n.checks || []).length, recorded: !!row.recorded, receipts: (row.receipts || []).map((r) => `${r.check_number}:${r.status}`).sort() },
    action: 'track', outcome: 'review', autonomy_class: 'REVIEW', priority: na.priority,
    title: `${row.recorded ? 'Closing packet, checks not cleared' : 'Closing packet not recorded'}: ${n.property_address || 'lot not identified'}${n.closing_date ? ` (settled ${n.closing_date})` : ''}${na.soonest_undeposited_void ? `, check voids ${na.soonest_undeposited_void}` : ''}`.slice(0, 300),
    next_action: na.next_action, next_action_due: na.next_action_due, reason: 'scanned closing packet with no recorded closing' };
}

async function loadPacketSubject(supabase, id) {
  const { data: d, error } = await supabase.from('library_documents').select('id, community_id, extraction_notes, uploaded_at').eq('id', id).maybeSingle();
  if (error) throw new Error(error.message);
  if (!d) return null;
  let notes = {}; try { notes = JSON.parse(d.extraction_notes || '{}'); } catch (_) { notes = {}; }
  if (notes.kind !== KIND) return null;
  const { data: s, error: sErr } = await supabase.from('home_sales').select('id').eq('source_document_id', id).limit(1);
  if (sErr) throw new Error(sErr.message);
  const linked = !!(s && s.length);
  const recorded = linked || recordedByLotAndDate(notes, await closedSalesFor(supabase, [notes.property_id].filter(Boolean)));
  return { id: d.id, community_id: d.community_id, notes, recorded, filed_at: d.uploaded_at || null, receipts: await packetReceipts(supabase, id) };
}

// After a packet is filed (Home Sales scan, Mail Scan, backfill): Emma registers
// its Association checks as received, then Amanda's item is opened/refreshed.
// Never breaks the caller's flow.
async function processFiledPacket(supabase, documentId, wakeReason) {
  try {
    const row = await loadPacketSubject(supabase, documentId);
    if (row) await registerPacketChecks(supabase, { documentId, communityId: row.community_id, notes: row.notes });
  } catch (e) {
    console.warn('[home-sales] packet checks not registered:', JSON.stringify({ documentId, error: e.message }));
  }
  return trackPacket(supabase, documentId, wakeReason);
}

// Open / refresh / resolve Amanda's objective for one packet. Never breaks the caller's flow.
async function trackPacket(supabase, documentId, wakeReason) {
  try {
    const { apply } = require('../manager/state');
    const row = await loadPacketSubject(supabase, documentId);
    if (!row) return null;
    return await apply(supabase, 'closing_packet', documentId, evaluatePacket(row), { wakeReason: wakeReason || 'closing_packet_filed' });
  } catch (e) {
    console.warn('[home-sales] closing packet oversight not updated:', JSON.stringify({ documentId, error: e.message }));
    return null;
  }
}

module.exports = { registerPacketChecks, packetReceipts, processFiledPacket, isAssocCheck, STAGE, recordedByLotAndDate, fileClosingPacket, listUnrecordedPackets, packetNotes, packetTitle, packetNextAction, evaluatePacket, loadPacketSubject, trackPacket, KIND };

