// ============================================================================
// lib/characters/hash.js  (Ed 2026-09-26)  Trusted Character System
// ----------------------------------------------------------------------------
// Content addressing for canonical character media, and a faithful copy of
// Postgres' jsonb text form so a component spec's hash can be re-verified
// outside the database (the database computes spec_sha256; this proves it).
// ============================================================================
const crypto = require('crypto');

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// Sniff media type + dimensions from the first bytes. Never trusts a filename.
function sniffMedia(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (b.length >= 24 && b.slice(0, 8).toString('hex') === '89504e470d0a1a0a') {
    return { media_type: 'image/png', ext: 'png', kind: 'image', width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2; let w = null; let h = null;
    while (i < b.length - 9) {
      if (b[i] !== 0xff) { i++; continue; }
      const m = b[i + 1];
      if (m >= 0xc0 && m <= 0xc3) { h = b.readUInt16BE(i + 5); w = b.readUInt16BE(i + 7); break; }
      i += 2 + b.readUInt16BE(i + 2);
    }
    return { media_type: 'image/jpeg', ext: 'jpg', kind: 'image', width: w, height: h };
  }
  if (b.length >= 30 && b.slice(0, 4).toString() === 'RIFF' && b.slice(8, 12).toString() === 'WEBP') {
    const c = b.slice(12, 16).toString(); let w = null; let h = null;
    if (c === 'VP8X') { w = 1 + b.readUIntLE(24, 3); h = 1 + b.readUIntLE(27, 3); }
    else if (c === 'VP8 ') { w = b.readUInt16LE(26) & 0x3fff; h = b.readUInt16LE(28) & 0x3fff; }
    else if (c === 'VP8L') { const bits = b.readUInt32LE(21); w = (bits & 0x3fff) + 1; h = ((bits >> 14) & 0x3fff) + 1; }
    return { media_type: 'image/webp', ext: 'webp', kind: 'image', width: w, height: h };
  }
  if (b.length >= 12 && b.slice(0, 4).toString() === 'RIFF' && b.slice(8, 12).toString() === 'WAVE') {
    return { media_type: 'audio/wav', ext: 'wav', kind: 'audio', width: null, height: null };
  }
  if (b.length >= 3 && (b.slice(0, 3).toString() === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0))) {
    return { media_type: 'audio/mpeg', ext: 'mp3', kind: 'audio', width: null, height: null };
  }
  return null;
}

// sha256/<aa>/<sha256>.<ext> — the key IS the proof of content.
function storageKeyFor(sha, ext) {
  if (!/^[0-9a-f]{64}$/.test(sha)) throw new Error('storageKeyFor: bad sha256');
  if (!/^[a-z0-9]{2,5}$/.test(ext || '')) throw new Error('storageKeyFor: bad extension');
  return `sha256/${sha.slice(0, 2)}/${sha}.${ext}`;
}

// Postgres jsonb::text: object keys ordered by (byte length, then bytes), duplicate
// keys collapsed, ", " and ": " separators. Integers only (specs forbid floats so
// numeric scale can't differ between JS and Postgres).
function pgJsonbText(v) {
  if (v === null) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') {
    if (!Number.isInteger(v)) throw new Error('pgJsonbText: non-integer numbers are not allowed in specs');
    return String(v);
  }
  if (typeof v === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(pgJsonbText).join(', ') + ']';
  if (typeof v === 'object') {
    const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort((a, b) => {
      const la = Buffer.byteLength(a); const lb = Buffer.byteLength(b);
      if (la !== lb) return la - lb;
      return Buffer.compare(Buffer.from(a), Buffer.from(b));
    });
    if (!keys.length) return '{}';
    return '{' + keys.map((k) => JSON.stringify(k) + ': ' + pgJsonbText(v[k])).join(', ') + '}';
  }
  throw new Error('pgJsonbText: unsupported value');
}

function specSha256(spec) {
  return sha256Hex(Buffer.from(pgJsonbText(spec), 'utf8'));
}

module.exports = { sha256Hex, sniffMedia, storageKeyFor, pgJsonbText, specSha256 };
