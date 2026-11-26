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
  return (docs || []).filter((d) => !used.has(d.id)).map((d) => {
    let n = {}; try { n = JSON.parse(d.extraction_notes || '{}'); } catch (_) { n = {}; }
    return { id: d.id, title: d.title, file_name: d.file_name_original, uploaded_at: d.uploaded_at, ...n, next_action: packetNextAction(n).next_action };
  });
}

// ---- The next action for a filed packet, and Amanda's oversight -------------
const DAY = 86400000;
const addDays = (ymd, n) => new Date(Date.parse(`${String(ymd).slice(0, 10)}T12:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const money = (c) => (c == null ? '?' : `$${(Number(c) / 100).toFixed(2)}`);
const isAssoc = (c) => c && (c.classification === 'ASSOCIATION_PAYMENT' || (/association|hoa/i.test(String(c.payee || '')) && !/bedrock/i.test(String(c.payee || ''))));

// PURE. notes = packetNotes(...) as stored; recorded = a home sale points at the packet.
function packetNextAction(notes, { recorded = false, today = new Date().toISOString().slice(0, 10) } = {}) {
  const n = notes || {};
  if (recorded) return { done: true, next_action: 'Closing recorded from this packet.' };
  const checks = (n.checks || []).filter((c) => c && c.amount_cents != null);
  const voids = checks.filter((c) => c.check_date).map((c) => ({ ...c, void_on: addDays(c.check_date, 90) })).sort((a, b) => a.void_on.localeCompare(b.void_on));
  const steps = [];
  if (!n.property_id) steps.push('match the packet to its lot');
  if (voids.length) steps.push(`confirm the original checks are in hand and deposited (${voids.map((c) => `#${c.check_number || '?'} ${money(c.amount_cents)} to ${c.payee || '?'}, void ${c.void_on}`).join('; ')})`);
  if (checks.some(isAssoc)) steps.push('Kat reconciles what the title company paid the Association against the ledger before anything posts');
  steps.push(`record the closing in Home Sales with the settlement date${n.closing_date ? ` ${n.closing_date}` : ''}`);
  const firstVoid = voids.length ? voids[0].void_on : null;
  // Escalate a week before the first check voids; otherwise two days from filing.
  const due = firstVoid ? addDays(firstVoid, -7) : addDays(today, 2);
  return { done: false, next_action: `Reese: ${steps.join('; ')}.`, next_action_due: `${due}T14:00:00Z`, first_void: firstVoid,
    priority: firstVoid && Date.parse(`${firstVoid}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`) <= 21 * DAY ? 'high' : 'normal' };
}

// Amanda's subject evaluator (lib/manager/subjects.js KINDS.closing_packet). PURE.
function evaluatePacket(row) {
  const n = row && row.notes ? row.notes : {};
  const refs = { table: 'library_documents', id: row.id, property_id: n.property_id || null, closing_date: n.closing_date || null };
  const base = { domain: 'ops', objective_type: 'resale', owner_kind: 'workflow', owner_key: 'home_sales.closing_packet', community_id: row.community_id || null, subject_refs: refs };
  const na = packetNextAction(n, { recorded: row.recorded, today: row.today });
  if (na.done) return { ...base, basis: { recorded: true }, action: 'clear', outcome: 'resolved', reason: 'closing recorded from the packet' };
  return { ...base, basis: { property_id: n.property_id || null, closing_date: n.closing_date || null, checks: (n.checks || []).length, recorded: false },
    action: 'track', outcome: 'review', autonomy_class: 'REVIEW', priority: na.priority,
    title: `Closing packet not recorded: ${n.property_address || 'lot not identified'}${n.closing_date ? ` (settled ${n.closing_date})` : ''}`.slice(0, 300),
    next_action: na.next_action, next_action_due: na.next_action_due, reason: 'scanned closing packet with no recorded closing' };
}

async function loadPacketSubject(supabase, id) {
  const { data: d, error } = await supabase.from('library_documents').select('id, community_id, extraction_notes').eq('id', id).maybeSingle();
  if (error) throw new Error(error.message);
  if (!d) return null;
  let notes = {}; try { notes = JSON.parse(d.extraction_notes || '{}'); } catch (_) { notes = {}; }
  if (notes.kind !== KIND) return null;
  const { data: s, error: sErr } = await supabase.from('home_sales').select('id').eq('source_document_id', id).limit(1);
  if (sErr) throw new Error(sErr.message);
  return { id: d.id, community_id: d.community_id, notes, recorded: !!(s && s.length) };
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

module.exports = { fileClosingPacket, listUnrecordedPackets, packetNotes, packetTitle, packetNextAction, evaluatePacket, loadPacketSubject, trackPacket, KIND };

