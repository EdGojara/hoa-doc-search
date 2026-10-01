// ============================================================================
// lib/ap/bill_files.js  (Issue #14): every common invoice file format, safely
// ----------------------------------------------------------------------------
// Emma's intake used to read PDFs only, so a JPG invoice (photo / export) and a
// Word .docx invoice reached her mailbox and silently produced nothing (the
// Waterview DJ and petting-zoo bills, Sept 2026). This module turns raw email
// attachments into bill files the invoice reader can take:
//   pdf   -> sent as a PDF document
//   image -> JPEG / PNG / GIF / WEBP sent as an image (the model reads it)
//   docx  -> text extracted (mammoth) and sent as text
//   zip   -> unpacked (bounded) and each inner file classified the same way
// Anything else (HEIC, XLSX, DOC, nested ZIPs, oversize files) is returned as
// SKIPPED with a specific, actionable reason, so the caller can raise a Payables
// exception instead of dropping it. Nothing here touches the network or the DB.
// ============================================================================
const path = require('path');

const LIMITS = {
  maxFileBytes: 25 * 1024 * 1024,        // per attachment / per inner file
  maxZipBytes: 25 * 1024 * 1024,         // the zip itself
  maxZipEntries: 25,                      // files inside one zip
  maxZipTotalBytes: 60 * 1024 * 1024,     // uncompressed total of one zip
  maxDocxTextChars: 40000,
};
const IMAGE_TYPES = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp' };

// What kind of file is this, from its name and (when present) content type.
function classifyFile(name, contentType) {
  const n = String(name || '').toLowerCase();
  const ct = String(contentType || '').toLowerCase();
  const ext = path.extname(n);
  if (ct.includes('pdf') || ext === '.pdf') return { kind: 'pdf', mediaType: 'application/pdf' };
  if (IMAGE_TYPES[ext]) return { kind: 'image', mediaType: IMAGE_TYPES[ext] };
  if (/^image\/(jpeg|png|gif|webp)$/.test(ct)) return { kind: 'image', mediaType: ct };
  if (ext === '.docx' || ct.includes('wordprocessingml')) return { kind: 'docx', mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
  if (ext === '.zip' || ct === 'application/zip' || ct === 'application/x-zip-compressed') return { kind: 'zip', mediaType: 'application/zip' };
  if (ext === '.heic' || ext === '.heif' || ct.includes('heic') || ct.includes('heif')) return { kind: 'unsupported', reason: 'iPhone HEIC photo: open it and enter the bill (or ask the sender for a JPG/PDF)' };
  if (ext === '.doc' || ct === 'application/msword') return { kind: 'unsupported', reason: 'old Word (.doc) file: open it and enter the bill' };
  if (['.xls', '.xlsx', '.csv'].includes(ext) || ct.includes('sheet') || ct.includes('excel')) return { kind: 'unsupported', reason: 'spreadsheet attachment: open it and enter the bill if it is one' };
  return { kind: 'unsupported', reason: `unsupported attachment type (${ext || ct || 'unknown'}): open it and enter the bill if it is one` };
}

// A zip entry name we refuse to unpack: path traversal, absolute paths, OS junk.
function unsafeEntryName(name) {
  const n = String(name || '');
  if (!n || n.endsWith('/')) return 'directory';
  if (n.includes('\0')) return 'invalid name';
  if (/^([a-zA-Z]:)?[\\/]/.test(n) || n.split(/[\\/]/).some((p) => p === '..')) return 'unsafe path';
  if (/(^|\/)__MACOSX\//.test(n) || /(^|\/)\.DS_Store$/.test(n) || /(^|\/)\._/.test(n)) return 'os metadata';
  return null;
}

async function expandZip(buffer, zipName, limits = LIMITS) {
  const files = []; const skipped = [];
  if (buffer.length > limits.maxZipBytes) { skipped.push({ name: zipName, reason: `zip larger than ${Math.round(limits.maxZipBytes / 1048576)} MB: open it and enter the bills` }); return { files, skipped }; }
  let zip;
  try { zip = await require('jszip').loadAsync(buffer); }
  catch (e) { skipped.push({ name: zipName, reason: 'zip could not be opened (corrupt or password-protected): open it and enter the bills' }); return { files, skipped }; }
  const entries = Object.values(zip.files).filter((e) => !e.dir);
  // jszip sanitizes '../' out of e.name on load; judge the ORIGINAL name so a
  // traversal entry is reported and refused, not silently renamed.
  const rawName = (e) => e.unsafeOriginalName || e.name;
  const usable = entries.filter((e) => !unsafeEntryName(rawName(e)));
  for (const e of entries) { const why = unsafeEntryName(rawName(e)); if (why && why !== 'directory' && why !== 'os metadata') skipped.push({ name: `${zipName}/${rawName(e)}`, reason: `zip entry skipped (${why})` }); }
  if (usable.length > limits.maxZipEntries) { skipped.push({ name: zipName, reason: `zip holds ${usable.length} files (limit ${limits.maxZipEntries}): open it and enter the bills` }); return { files, skipped }; }
  let total = 0;
  for (const e of usable) {
    const inner = `${zipName}/${e.name}`;
    const c = classifyFile(e.name, '');
    if (c.kind === 'zip') { skipped.push({ name: inner, reason: 'zip inside a zip: open it and enter the bills' }); continue; }
    if (c.kind === 'unsupported') { skipped.push({ name: inner, reason: c.reason }); continue; }
    // Zip-bomb guard: refuse on the DECLARED size before inflating anything.
    const declared = e._data && Number(e._data.uncompressedSize);
    if (declared && (declared > limits.maxFileBytes || total + declared > limits.maxZipTotalBytes)) { skipped.push({ name: inner, reason: 'file inside the zip is too large: open it and enter the bill' }); continue; }
    const buf = await e.async('nodebuffer');
    total += buf.length;
    if (buf.length > limits.maxFileBytes) { skipped.push({ name: inner, reason: 'file inside the zip is too large: open it and enter the bill' }); continue; }
    if (total > limits.maxZipTotalBytes) { skipped.push({ name: zipName, reason: 'zip unpacks too large: open it and enter the remaining bills' }); break; }
    files.push({ name: path.basename(e.name), from_zip: zipName, buffer: buf, ...c });
  }
  return { files, skipped };
}

async function docxToText(buffer, limits = LIMITS) {
  const { value } = await require('mammoth').extractRawText({ buffer });
  return String(value || '').replace(/\n{3,}/g, '\n\n').trim().slice(0, limits.maxDocxTextChars);
}

// attachments: [{ name, contentType, size, buffer|null, unavailable? }]
// -> { seen: n, files: [{ name, kind, mediaType, buffer?, text? }], skipped: [{ name, reason }] }
async function prepareBillFiles(attachments, limits = LIMITS) {
  const files = []; const skipped = [];
  const list = (attachments || []).filter((a) => !a.isInline);
  for (const a of list) {
    if (!a.buffer) { skipped.push({ name: a.name, reason: a.unavailable || 'attachment bytes could not be downloaded from the mailbox: open the email and enter the bill' }); continue; }
    if (a.buffer.length > limits.maxFileBytes) { skipped.push({ name: a.name, reason: `attachment larger than ${Math.round(limits.maxFileBytes / 1048576)} MB: open it and enter the bill` }); continue; }
    const c = classifyFile(a.name, a.contentType);
    if (c.kind === 'unsupported') { skipped.push({ name: a.name, reason: c.reason }); continue; }
    if (c.kind === 'zip') { const z = await expandZip(a.buffer, a.name, limits); files.push(...z.files); skipped.push(...z.skipped); continue; }
    files.push({ name: a.name, buffer: a.buffer, ...c });
  }
  for (const f of files) {
    if (f.kind !== 'docx') continue;
    try { f.text = await docxToText(f.buffer, limits); if (!f.text) { f.unreadable = 'Word file has no readable text: open it and enter the bill'; } }
    catch (e) { f.unreadable = 'Word file could not be read: open it and enter the bill'; }
  }
  const unreadable = files.filter((f) => f.unreadable);
  for (const f of unreadable) skipped.push({ name: f.name, reason: f.unreadable });
  return { seen: list.length, files: files.filter((f) => !f.unreadable), skipped };
}

// The model input block for one bill file (shared by every reader).
function contentBlockFor(file) {
  if (Buffer.isBuffer(file)) file = { kind: 'pdf', buffer: file };
  if (file.kind === 'image') return { type: 'image', source: { type: 'base64', media_type: file.mediaType || 'image/jpeg', data: file.buffer.toString('base64') } };
  if (file.kind === 'docx') return { type: 'text', text: `The bill below was sent as a Word document; this is its text:\n\n${file.text || ''}` };
  return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: file.buffer.toString('base64') } };
}

module.exports = { classifyFile, expandZip, docxToText, prepareBillFiles, contentBlockFor, unsafeEntryName, LIMITS };
