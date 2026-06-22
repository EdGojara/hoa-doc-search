// ============================================================================
// crypto_field.js — at-rest encryption for a single sensitive string field
// (e.g. a bank account number stored in bank_accounts.account_number_encrypted).
//
// AES-256-GCM with a key derived from FIELD_ENCRYPTION_KEY (preferred) or, so it
// works in prod without a new secret, a SHA-256 of SUPABASE_KEY. Routing numbers
// are PUBLIC and are NOT encrypted — only the account number is.
//
// Stored value is self-describing by prefix so we can rotate later:
//   'gcm:<base64(iv|tag|ciphertext)>'  — encrypted (key present)
//   'plain:<base64>'                   — dev fallback when no key is configured
// ============================================================================
const crypto = require('crypto');

function _key() {
  const src = process.env.FIELD_ENCRYPTION_KEY || process.env.SUPABASE_KEY || '';
  if (!src) return null;
  return crypto.createHash('sha256').update(String(src)).digest(); // 32 bytes
}

function encryptField(plain) {
  if (plain == null || String(plain) === '') return null;
  const k = _key();
  if (!k) return 'plain:' + Buffer.from(String(plain), 'utf8').toString('base64');
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', k, iv);
  const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return 'gcm:' + Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
}

function decryptField(stored) {
  if (stored == null || stored === '') return null;
  const s = String(stored);
  if (s.startsWith('plain:')) return Buffer.from(s.slice(6), 'base64').toString('utf8');
  if (s.startsWith('gcm:')) {
    const k = _key();
    if (!k) return null;
    const raw = Buffer.from(s.slice(4), 'base64');
    const iv = raw.subarray(0, 12), tag = raw.subarray(12, 28), enc = raw.subarray(28);
    const d = crypto.createDecipheriv('aes-256-gcm', k, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
  }
  return s; // legacy / already-plain
}

function last4(s) {
  const d = String(s || '').replace(/\D/g, '');
  return d.length >= 4 ? d.slice(-4) : d;
}

module.exports = { encryptField, decryptField, last4 };
