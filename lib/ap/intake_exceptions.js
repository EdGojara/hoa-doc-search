// ============================================================================
// lib/ap/intake_exceptions.js  (Ed 2026-08-01)
// ----------------------------------------------------------------------------
// The holding pen for emailed bills Emma captured but couldn't auto-file (no
// community / no vendor / no total / no date). They leave her inbox and wait
// here so Payables has ONE list of stragglers to clear. recordException is
// idempotent per (source email, PDF). promoteException supplies the missing
// piece and loads it through the SAME commitInvoice path as every other bill.
// ============================================================================
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const REASONS = new Set(['no_community', 'no_vendor', 'vendor_ambiguous', 'no_total', 'no_date', 'other']);

// autoIntake reports needs_review with a human phrase ("association not matched",
// "no invoice total"); normalize to our reason enum.
function mapReason(reason) {
  const r = String(reason || '').toLowerCase();
  if (REASONS.has(r)) return r;
  if (/ambig/.test(r)) return 'vendor_ambiguous';
  if (/associat|communit/.test(r)) return 'no_community';
  if (/vendor/.test(r)) return 'no_vendor';
  if (/total|amount/.test(r)) return 'no_total';
  if (/date/.test(r)) return 'no_date';
  return 'other';
}

// Write (or no-op) an exception for a bill we couldn't place. Best-effort — never
// throws into ingest. Returns { ok, id? } or { ok:false, reason }.
async function recordException({ emailMessageId, sourceRef, reason, extracted, storagePath, sha256, communityId, suggestedVendorId } = {}) {
  try {
    const ex = extracted || {};
    const row = {
      email_message_id: emailMessageId || null,
      intake_source_ref: sourceRef || null,
      reason: mapReason(reason),
      status: 'pending',
      vendor_name: ex.vendor_name || null,
      community_hint: ex.community_hint || null,
      invoice_number: ex.invoice_number || null,
      account_number: ex.account_number || null,
      total_cents: (ex.total_cents && ex.total_cents > 0) ? ex.total_cents : null,
      invoice_date: ex.invoice_date || null,
      community_id: communityId || null,
      suggested_vendor_id: suggestedVendorId || null,
      storage_path: storagePath || null,
      file_sha256: sha256 || null,
      extracted: ex,
    };
    // Idempotent: a re-pull of the same email + bill must not stack duplicates.
    if (sourceRef && sha256) {
      const { data: dup } = await supabase.from('ap_intake_exceptions')
        .select('id, status').eq('intake_source_ref', sourceRef).eq('file_sha256', sha256).limit(1);
      if (dup && dup.length) return { ok: true, id: dup[0].id, existing: true };
    }
    let { data, error } = await supabase.from('ap_intake_exceptions').insert(row).select('id').single();
    if (error) {
      // Lost the race to the unique index — return the winner.
      if (String(error.code) === '23505' && sourceRef && sha256) {
        const { data: w } = await supabase.from('ap_intake_exceptions').select('id').eq('intake_source_ref', sourceRef).eq('file_sha256', sha256).limit(1);
        if (w && w.length) return { ok: true, id: w[0].id, existing: true };
      }
      return { ok: false, reason: error.message };
    }
    return { ok: true, id: data.id };
  } catch (e) { return { ok: false, reason: e.message }; }
}

// Pending exceptions for the Payables "needs attention" list, newest first.
async function listExceptions({ limit = 200 } = {}) {
  const { data, error } = await supabase.from('ap_intake_exceptions')
    .select('id, email_message_id, reason, vendor_name, community_hint, invoice_number, account_number, total_cents, invoice_date, community_id, suggested_vendor_id, storage_path, created_at, community:community_id(name), suggested_vendor:suggested_vendor_id(name)')
    .eq('status', 'pending').order('created_at', { ascending: false }).limit(limit);
  if (error) throw error;
  return data || [];
}

// Supply the missing piece and load it through commitInvoice. Returns the commit
// outcome; on a successful load, marks the exception resolved + links the invoice
// and marks the source email handled (it's off the inbox for good).
async function promoteException(id, { communityId, vendorId, vendorName, resolvedBy } = {}) {
  const { data: exc, error } = await supabase.from('ap_intake_exceptions').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  if (!exc) return { ok: false, error: 'not_found' };
  if (exc.status !== 'pending') return { ok: false, error: 'not_pending' };
  const cid = communityId || exc.community_id;
  if (!cid) return { ok: false, error: 'need_community', detail: 'Pick the community this bill belongs to.' };

  // Vendor: an explicit id, else the one we suggested, else resolve/create from a
  // name the operator typed or the bill's own printed vendor (an AP clerk sets up
  // a new vendor from the invoice — creating it isn't paying; approval still gates).
  let vid = vendorId || exc.suggested_vendor_id;
  if (!vid) {
    const nm = (vendorName && vendorName.trim()) || exc.vendor_name || (exc.extracted && exc.extracted.vendor_name);
    if (nm) {
      try {
        const { resolveVendor } = require('./intake');
        const rv = await resolveVendor({ name: nm });
        if (rv.vendor) vid = rv.vendor.id;
        else {
          const { ensureVendorForInvoice } = require('./vendor_master');
          const e = await ensureVendorForInvoice({ extracted: { ...(exc.extracted || {}), vendor_name: nm }, actor: resolvedBy || 'Emma (AP)' });
          if (e.vendor) vid = e.vendor.id;
        }
      } catch (_) { /* fall through to the need_vendor prompt */ }
    }
  }
  if (!vid) return { ok: false, error: 'need_vendor', detail: 'Pick (or type) the vendor for this bill.' };

  const { commitInvoice } = require('./intake');
  const result = await commitInvoice({
    extracted: exc.extracted || {}, vendorId: vid, communityId: cid,
    sha256: exc.file_sha256 || null, storagePath: exc.storage_path || null,
    intakeMethod: 'email', sourceRef: exc.intake_source_ref || null,
  });
  if (result.outcome === 'loaded' || result.outcome === 'held_suspected_duplicate' || result.outcome === 'blocked_duplicate') {
    const invId = result.invoice_id || result.duplicate_of || null;
    await supabase.from('ap_intake_exceptions').update({
      status: 'resolved', resolved_invoice_id: invId, resolved_by: resolvedBy || 'staff', resolved_at: new Date().toISOString(),
    }).eq('id', id);
    if (exc.email_message_id) { try { await supabase.from('email_messages').update({ triage_status: 'handled' }).eq('id', exc.email_message_id); } catch (_) {} }
    return { ok: true, outcome: result.outcome, invoice_id: invId };
  }
  // Still can't commit (usually no total/date on the bill) — report why; stays pending.
  return { ok: false, error: result.outcome || 'not_loaded', detail: result.reason || 'Could not load — the bill is missing a total or date; open it and enter them in Payables.' };
}

async function dismissException(id, { by, notes } = {}) {
  const { data: exc } = await supabase.from('ap_intake_exceptions').select('email_message_id, status').eq('id', id).maybeSingle();
  if (!exc) return { ok: false, error: 'not_found' };
  await supabase.from('ap_intake_exceptions').update({
    status: 'dismissed', resolved_by: by || 'staff', resolved_at: new Date().toISOString(), notes: notes || null,
  }).eq('id', id);
  if (exc.email_message_id) { try { await supabase.from('email_messages').update({ triage_status: 'handled' }).eq('id', exc.email_message_id); } catch (_) {} }
  return { ok: true };
}

module.exports = { recordException, listExceptions, promoteException, dismissException };
