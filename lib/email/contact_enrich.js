// ============================================================================
// lib/email/contact_enrich.js  (Ed 2026-07-13)
// ----------------------------------------------------------------------------
// When an inbound email resolves to a homeowner with HIGH confidence (the
// sender IS that person), capture the sender's own contact details — their
// email address and the phone in their signature — onto the contact record if
// not already on file. New methods land in contact_methods (the canonical
// N-value store, subtype 'captured', unverified) and sync into the flat
// primary_* columns when those are empty, so the homeowner becomes searchable
// and callable from what they told us. Best-effort: never throws, never
// overwrites an existing primary, never touches medium/low-confidence links.
// ============================================================================
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function normalizePhone(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  // US 10-digit (or 11 with leading 1). Reject anything else (extensions, junk).
  if (d.length === 11 && d[0] === '1') return d.slice(1);
  return d.length === 10 ? d : null;
}
function fmtPhone(d) { return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`; }

// Add email/phone the sender gave us to `contactId` if missing. Returns the
// list of what was added (for logging). `opts.email`, `opts.phone` are raw.
async function enrichContactFromEmail(sb, contactId, opts = {}) {
  const added = [];
  if (!contactId) return added;
  try {
    const { data: c } = await sb.from('contacts')
      .select('primary_email, secondary_email, primary_phone').eq('id', contactId).maybeSingle();
    if (!c) return added;

    // Existing methods (canonical store) for dedupe.
    let methods = [];
    try {
      const { data: cm } = await sb.from('contact_methods').select('method_type, value').eq('contact_id', contactId);
      methods = cm || [];
    } catch (_) { /* table optional */ }
    const hasEmail = (e) => {
      const le = e.toLowerCase();
      return (c.primary_email || '').toLowerCase().includes(le) ||
             (c.secondary_email || '').toLowerCase().includes(le) ||
             methods.some((m) => m.method_type === 'email' && (m.value || '').toLowerCase().includes(le));
    };
    const hasPhone = (d) => {
      const inFlat = String(c.primary_phone || '').replace(/\D/g, '').includes(d);
      return inFlat || methods.some((m) => m.method_type === 'phone' && String(m.value || '').replace(/\D/g, '').includes(d));
    };

    // Email
    const email = String(opts.email || '').trim().toLowerCase();
    if (email && EMAIL_RE.test(email) && !hasEmail(email)) {
      const isFirst = !c.primary_email;
      await sb.from('contact_methods').insert({ contact_id: contactId, method_type: 'email', value: email, subtype: 'captured', is_primary: isFirst, notes: 'captured from email' });
      if (isFirst) await sb.from('contacts').update({ primary_email: email }).eq('id', contactId);
      added.push(`email ${email}`);
    }

    // Phone
    const d = normalizePhone(opts.phone);
    if (d && !hasPhone(d)) {
      const isFirst = !c.primary_phone;
      await sb.from('contact_methods').insert({ contact_id: contactId, method_type: 'phone', value: fmtPhone(d), subtype: 'cell', is_primary: isFirst, notes: 'captured from email signature' });
      if (isFirst) await sb.from('contacts').update({ primary_phone: fmtPhone(d) }).eq('id', contactId);
      added.push(`phone ${fmtPhone(d)}`);
    }
  } catch (e) { console.warn('[contact_enrich] failed:', e.message); }
  return added;
}

module.exports = { enrichContactFromEmail, normalizePhone };
