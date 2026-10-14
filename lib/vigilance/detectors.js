// ============================================================================
// lib/vigilance/detectors.js — what changed, compared with what we know
// ----------------------------------------------------------------------------
// Detectors are GENERIC comparisons of an incoming communication against the
// established record, never rules for one email:
//   recipient_change     a recurring series from a counterparty (same sender
//                        domain, same subject family) suddenly copies an outside
//                        address that was never on it before
//   payment_instructions a message asks us to change where or how we pay
//   sender_lookalike     the sender's domain imitates one we deal with
//   amount_outlier       a vendor bill far outside that vendor's history
// Each returns signals: { detector, subject_key, materiality, counterparty,
// observed: facts with sources, data }. Read-only. No model calls: cheap enough
// to run on every inbound message.
// ============================================================================
const OWN = (process.env.OWN_EMAIL_DOMAINS || 'bedrocktx.com,bedrocktxai.com').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const addr = (r) => String((r && (r.address || r.email || (r.emailAddress && r.emailAddress.address))) || r || '').trim().toLowerCase();
const domainOf = (a) => addr(a).split('@')[1] || '';
const isOwn = (a) => OWN.includes(domainOf(a));
const day = (d) => String(d || '').slice(0, 10);
// "RE: Reminder: Positive Pay Items Ready For Review" -> "positive pay items ready for review"
const seriesSubject = (s) => String(s || '').toLowerCase().replace(/^(\s*(re|fw|fwd|reminder|automatic reply)\s*:\s*)+/g, '').replace(/\[[^\]]*\]|#\d+|\d{3,}/g, ' ').replace(/\s+/g, ' ').trim();
const textOf = (m) => String((m && (m.body_full || m.body_preview)) || '').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');

// Who the counterparty is, from our records (banks registry, vendors), not from the text.
async function counterpartyOf(supabase, ev, cache = {}) {
  const d = ev.sender_domain;
  if (OWN.includes(d)) return { type: 'internal', domain: d };
  if (!cache.banks) {
    const { data } = await supabase.from('banks').select('id, name, contact_email, positive_pay_settings').limit(200);
    cache.banks = (data || []).map((b) => ({ id: b.id, name: b.name, domains: [domainOf(b.contact_email), String((b.positive_pay_settings || {}).notice_sender_domain || '').toLowerCase()].filter(Boolean) }));
  }
  const bank = cache.banks.find((b) => b.domains.includes(d));
  if (bank) return { type: 'bank', domain: d, name: bank.name, bank_id: bank.id };
  if (ev.resolved_vendor_id) return { type: 'vendor', domain: d, vendor_id: ev.resolved_vendor_id };
  const { data: v } = await supabase.from('vendors').select('id, name').ilike('email', `%@${d}`).limit(1);
  if (v && v[0]) return { type: 'vendor', domain: d, vendor_id: v[0].id, name: v[0].name };
  return { type: 'external', domain: d };
}

// ---------------------------------------------------------------- recipient_change
const MIN_HISTORY = 3; const ESTABLISH_DAYS = 7;
const recipientChange = {
  key: 'recipient_change',
  applies: (ev) => ev.direction === 'inbound' && !isOwn(ev.sender_email) && (ev.recipients || []).length > 1,
  async detect({ supabase, ev, cp }) {
    const series = seriesSubject(ev.subject);
    if (!series) return [];
    // a series is one SENDING ADDRESS + subject family (a person at the same domain replying is not the series)
    const { data, error } = await supabase.from('email_messages').select('id, received_at, recipients, subject').ilike('sender_email', ev.sender_email).lt('received_at', ev.received_at).order('received_at', { ascending: false }).limit(120);
    if (error) throw new Error(`series history: ${error.message}`);
    const prior = (data || []).filter((m) => seriesSubject(m.subject) === series && m.id !== ev.id);
    if (prior.length < MIN_HISTORY) return [];   // no established pattern yet: nothing to compare against
    // ESTABLISHED = on the series' first message, or on at least MIN_HISTORY earlier messages
    // spanning ESTABLISH_DAYS. A recent arrival stays "new" until then, so a sighting missed
    // once (or a case still open) is caught again on the next message instead of becoming normal.
    const t = Date.parse(ev.received_at); const earliest = prior[prior.length - 1];
    const seen = new Map();
    for (const m of prior) for (const r of (m.recipients || []).map(addr)) { const x = seen.get(r) || { n: 0, first: m.received_at }; x.n += 1; if (m.received_at < x.first) x.first = m.received_at; seen.set(r, x); }
    const onFirst = new Set((earliest.recipients || []).map(addr));
    const established = (a) => onFirst.has(a) || ((seen.get(a) || { n: 0 }).n >= MIN_HISTORY && t - Date.parse(seen.get(a).first) >= ESTABLISH_DAYS * 86400000);
    const fresh = [...new Set((ev.recipients || []).map(addr))].filter((a) => a && !established(a) && !isOwn(a) && domainOf(a) !== ev.sender_domain);
    return fresh.map((a) => ({
      detector: 'recipient_change', subject_key: `vigilance:recipient_change:${ev.sender_domain}:${a}`,
      materiality: cp.type === 'bank' || /financial|positive pay|payment|statement/i.test(`${ev.classification} ${ev.subject}`) ? 'high' : 'medium',
      counterparty: cp,
      observed: [
        { fact: `${a} is copied on "${ev.subject}" from ${ev.sender_email} received ${day(ev.received_at)}`, source: 'this message' },
        seen.get(a)
          ? { fact: `it first appeared on this series ${day(seen.get(a).first)}, after ${prior.filter((m) => m.received_at < seen.get(a).first).length} earlier messages without it (from ${day(earliest.received_at)})`, source: 'trustEd email history' }
          : { fact: `it was on none of the ${prior.length} earlier messages in this series (${day(earliest.received_at)} to ${day(prior[0].received_at)})`, source: 'trustEd email history' },
      ],
      data: { address: a, series, sender: ev.sender_email, first_seen: seen.get(a) ? seen.get(a).first : ev.received_at, series_label: ev.subject.replace(/^(\s*(re|fw|fwd|reminder)\s*:\s*)+/i, '').trim(), prior_count: prior.length, last_without: prior[0].received_at, first_reviewed: prior[prior.length - 1].received_at },
    }));
  },
};

// ---------------------------------------------------------------- payment_instructions
const PAY_CHANGE = /\b(new|updated?|changed?|change (?:of|to)|revised)\b[^.]{0,60}\b(bank(?:ing)?|account|routing|ach|wire|remit(?:tance)?|payment)\s*(?:details|info(?:rmation)?|instructions|number|address)?\b|\bplease (?:send|remit|direct) (?:all )?(?:future )?payments? to\b|\bwire instructions\b/i;
const paymentInstructions = {
  key: 'payment_instructions',
  applies: (ev) => ev.direction === 'inbound' && !isOwn(ev.sender_email),
  async detect({ ev, cp }) {
    const t = `${ev.subject} ${textOf(ev)}`;
    const m = t.match(PAY_CHANGE);
    if (!m || cp.type === 'bank') return [];   // banks' own notices are handled by their processing
    return [{ detector: 'payment_instructions', subject_key: `vigilance:payment_instructions:${ev.sender_domain}`, materiality: 'high', counterparty: cp,
      observed: [{ fact: `${ev.sender_email} asks to change payment details ("${m[0].slice(0, 90)}") on ${day(ev.received_at)}`, source: 'this message' }],
      data: { phrase: m[0].slice(0, 120) } }];
  },
};

// ---------------------------------------------------------------- sender_lookalike
function lev(a, b) { const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]); for (let j = 1; j <= b.length; j++) dp[0][j] = j; for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); return dp[a.length][b.length]; }
const senderLookalike = {
  key: 'sender_lookalike',
  applies: (ev) => ev.direction === 'inbound' && !isOwn(ev.sender_email),
  async detect({ supabase, ev, cp, cache }) {
    if (cp.type === 'bank') return [];
    if (!cache.known) {
      const { data: vs } = await supabase.from('vendors').select('email').not('email', 'is', null).limit(5000);
      cache.known = [...new Set([...OWN, ...(cache.banks || []).flatMap((b) => b.domains), ...(vs || []).map((v) => domainOf(v.email))].filter((d) => d && d.length >= 6))];
    }
    const d = ev.sender_domain; if (!d || cache.known.includes(d)) return [];
    const near = cache.known.find((k) => Math.abs(k.length - d.length) <= 2 && lev(k, d) <= 2);
    if (!near) return [];
    return [{ detector: 'sender_lookalike', subject_key: `vigilance:sender_lookalike:${d}`, materiality: 'high', counterparty: cp,
      observed: [{ fact: `the sender's domain ${d} differs by ${lev(near, d)} character(s) from ${near}, a domain we deal with`, source: 'trustEd banks, vendors and our own domains' }], data: { domain: d, resembles: near } }];
  },
};

// ---------------------------------------------------------------- amount_outlier
const amountOutlier = {
  key: 'amount_outlier',
  applies: (ev) => ev.direction === 'inbound' && !!ev.resolved_vendor_id && /vendor_financial/.test(ev.classification || ''),
  async detect({ supabase, ev, cp }) {
    const amts = ((ev.extracted && ev.extracted.amounts) || []).map((s) => Math.round(Number(String(s).replace(/[^0-9.]/g, '')) * 100)).filter((x) => x > 0);
    if (!amts.length) return [];
    const amt = Math.max(...amts);
    const { data } = await supabase.from('ap_invoices').select('total_cents').eq('vendor_id', ev.resolved_vendor_id).order('invoice_date', { ascending: false }).limit(24);
    const hist = (data || []).map((r) => Number(r.total_cents)).filter((x) => x > 0).sort((a, b) => a - b);
    if (hist.length < 4) return [];
    const med = hist[Math.floor(hist.length / 2)];
    if (!(amt > 3 * med && amt - med > 100000)) return [];
    return [{ detector: 'amount_outlier', subject_key: `vigilance:amount_outlier:${ev.resolved_vendor_id}:${amt}`, materiality: 'medium', counterparty: cp,
      observed: [{ fact: `this bill shows $${(amt / 100).toFixed(2)}; the vendor's last ${hist.length} bills have a median of $${(med / 100).toFixed(2)}`, source: 'trustEd AP history' }], data: { amount_cents: amt, median_cents: med, history: hist.length } }];
  },
};

const DETECTORS = [recipientChange, paymentInstructions, senderLookalike, amountOutlier];

module.exports = { DETECTORS, counterpartyOf, seriesSubject, domainOf, addr, isOwn, textOf, lev };
