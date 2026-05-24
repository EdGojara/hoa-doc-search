// ============================================================================
// bulk_upload_from_folder.js
// ----------------------------------------------------------------------------
// Walks a local folder (typically a synced OneDrive client folder), filters
// junk, dedupes against what's already in trustEd, and POSTs the survivors
// to /api/documents/upload — same endpoint the manual UI upload button hits.
// Writes a CSV log row per file so you can spot-check the run.
//
// Flow per file:
//   1. Hard skips      — wrong extension, too small, too big, system files
//   2. Hash dedup      — SHA-256 lookup against library_documents.file_hash
//   3. Claude pre-screen — Haiku decides "is this an HOA doc relevant to
//                          [community]?" with conservative-default-skip
//   4. POST upload     — existing /api/documents/upload, same dedup + extract
//                        + index-queue path as the UI
//
// Output:
//   bulk-upload-<community-slug>-<timestamp>.csv with columns:
//     path, size_bytes, sha256, outcome, doc_id, community, category,
//     pre_screen_reasoning, error
//
// Usage:
//   node scripts/bulk_upload_from_folder.js \
//     --folder "C:\Users\edget\OneDrive ... \Client - August Meadows" \
//     --community "August Meadows" \
//     [--dry-run] [--csv path.csv] [--concurrency 2]
//
// Env (.env in repo root):
//   SUPABASE_URL, SUPABASE_KEY          — for hash pre-fetch
//   ANTHROPIC_API_KEY                   — for Claude pre-screen (Haiku)
//   TRUSTED_URL                         — e.g. https://my.bedrocktxai.com
//
// Re-runnable: hash-dedup guarantees no double-uploads. Ctrl-C is safe;
// CSV is written incrementally.
// ============================================================================

require('dotenv').config({ override: true });
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');

const BEDROCK_MGMT_CO_ID = '00000000-0000-0000-0000-000000000001';

// ----------------------------------------------------------------------------
// CLI args
// ----------------------------------------------------------------------------
function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  if (!v || v.startsWith('--')) return true; // boolean flag
  return v;
}

const FOLDER = arg('folder');
const COMMUNITY_HINT = arg('community') || 'this community';
const DRY_RUN = arg('dry-run') === true;
const CONCURRENCY = Number(arg('concurrency', 2));
const CSV_OUT = arg('csv') || path.resolve(
  process.cwd(),
  `bulk-upload-${slugify(COMMUNITY_HINT)}-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`,
);

if (!FOLDER) {
  console.error('ERROR: --folder is required.');
  process.exit(1);
}
if (!fs.existsSync(FOLDER)) {
  console.error(`ERROR: folder does not exist: ${FOLDER}`);
  process.exit(1);
}

const TRUSTED_URL = (process.env.TRUSTED_URL || '').replace(/\/+$/, '');
if (!TRUSTED_URL) {
  console.error('ERROR: TRUSTED_URL env var required (e.g. https://my.bedrocktxai.com)');
  process.exit(1);
}
const STAFF_PASSWORD = process.env.STAFF_PASSWORD || '';
if (!STAFF_PASSWORD) {
  console.error('ERROR: STAFF_PASSWORD env var required (same password as the staff-login.html page).');
  process.exit(1);
}

function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'community';
}

// ----------------------------------------------------------------------------
// Hard-skip rules
// ----------------------------------------------------------------------------
const ALLOWED_EXT = new Set(['.pdf']); // upload endpoint only accepts PDFs
const KNOWN_NON_DOC_EXT = new Set([
  '.docx', '.doc', '.xlsx', '.xls', '.csv', '.txt',
  '.png', '.jpg', '.jpeg', '.gif', '.heic', '.tiff', '.bmp',
  '.mp4', '.mov', '.avi', '.mp3', '.wav',
  '.zip', '.rar', '.7z',
  '.tmp', '.ini', '.lnk', '.url', '.db', '.exe', '.bat',
]);
const SYSTEM_FILE_NAMES = new Set(['thumbs.db', 'desktop.ini', '.ds_store']);
const MIN_BYTES = 2 * 1024;            // <2KB = blank/corrupt
const MAX_BYTES = 100 * 1024 * 1024;   // >100MB = video/photo album

function hardSkipReason(filePath, stat) {
  const base = path.basename(filePath).toLowerCase();
  if (SYSTEM_FILE_NAMES.has(base)) return 'system_file';
  if (base.startsWith('~$')) return 'office_temp_lock';
  const ext = path.extname(filePath).toLowerCase();
  if (KNOWN_NON_DOC_EXT.has(ext)) return ext === '.docx' || ext === '.doc' || ext === '.xlsx' || ext === '.xls'
    ? 'filetype_unsupported'  // Office docs that would be relevant if PDF'd
    : 'filetype_irrelevant';
  if (!ALLOWED_EXT.has(ext)) return 'filetype_unknown';
  if (stat.size < MIN_BYTES) return 'too_small';
  if (stat.size > MAX_BYTES) return 'too_large';
  return null;
}

// ----------------------------------------------------------------------------
// Folder walk
// ----------------------------------------------------------------------------
async function walkFolder(root) {
  const out = [];
  async function recurse(dir) {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await recurse(full);
      else if (e.isFile()) out.push(full);
    }
  }
  await recurse(root);
  return out;
}

// ----------------------------------------------------------------------------
// Hash + supabase pre-fetch
// ----------------------------------------------------------------------------
async function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(filePath);
    s.on('data', (b) => h.update(b));
    s.on('end', () => resolve(h.digest('hex')));
    s.on('error', reject);
  });
}

async function fetchExistingHashes(supabase) {
  const hashes = new Map(); // hash -> { id, title }
  const PAGE = 1000;
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from('library_documents')
      .select('id, file_hash, file_name_original, title')
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .not('file_hash', 'is', null)
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`hash fetch failed: ${error.message}`);
    if (!data || data.length === 0) break;
    for (const r of data) hashes.set(r.file_hash, { id: r.id, title: r.title || r.file_name_original });
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return hashes;
}

// ----------------------------------------------------------------------------
// Claude pre-screen (Haiku)
// ----------------------------------------------------------------------------
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function preScreen(filePath, fileBuffer, communityHint) {
  const folderContext = path.dirname(filePath).split(path.sep).slice(-3).join(' / ');
  const filename = path.basename(filePath);
  const base64 = fileBuffer.toString('base64');

  const prompt =
`You are filtering files before they get uploaded into trustEd, an HOA management platform for "${communityHint}".

File: ${filename}
Folder path: ${folderContext}

Decide if this PDF is an HOA management document RELEVANT to running ${communityHint}.

RELEVANT examples: governing docs (CC&Rs, bylaws, plats, amendments, resolutions, policies), financials (budgets, financial statements, audits, tax returns, AR reports, reserve studies), operational (vendor contracts, vendor invoices, board meeting minutes, board packets, agendas), compliance/legal (violation notices, ACC/ARC decisions, attorney letters, statutory notices, insurance certificates, claim files, settlement documents), records (transfer fee requests, estoppels, homeowner correspondence), property (key fob lists, ARC applications, deeds, surveys), insurance (D&O, GL, property, claim correspondence, adjuster reports), incident/claim evidence (police reports, accident reports, repair quotes, damage assessments — when these support an HOA matter).

**FOLDER CONTEXT IS STRONG SIGNAL.** The folder path matters as much as the document content. If the folder name clearly identifies this as an HOA-related matter (examples: "2024 Tennis Court Claim", "Vendor Bids 2025", "Annual Meeting Files 2026", "Board Minutes 2024", "Pool Insurance Claim", "Roof Replacement Project"), include the file even if the document itself is authored by a third party (insurance company, police, attorney, vendor, governmental agency, adjuster, contractor). A police crash report inside a "Tennis Court Claim" folder is HOA evidence, not personal auto insurance noise. A vendor invoice inside a "2025 Landscaping Bids" folder is HOA-relevant, even though the invoice is on the vendor's letterhead.

**THIRD-PARTY COUNTERPARTY DOCS — INCLUDE THEM.** When an HOA has a claim, lawsuit, vendor dispute, contract negotiation, or any operational matter against (or with) a third party, the records of that matter live in the HOA's file. This includes documents written from the third party's perspective: the at-fault driver's insurance correspondence (Root, Geico, State Farm — when they're the AT-FAULT party's carrier in a damage claim against the HOA's common property), the opposing party's attorney letters in a dispute, the vendor's own quote/invoice/contract in a procurement file, the adjuster's notes when they're working for the OPPOSING insurance carrier. Do NOT skip these as "personal" or "unrelated" just because the document body addresses the third party. If they're in an HOA-matter folder, they're HOA records — the HOA's file ABOUT that matter, even though the doc was authored by someone else. The HOA is a party to the matter; their records of the other side's documentation belong with the case file.

NOT RELEVANT examples: blank/corrupted scans, personal Ed Gojara files unrelated to HOA work (personal tax returns, personal medical, personal home purchases), marketing material from random vendors who don't work for the HOA, junk mail PDFs, broken / mostly-empty pages, old drafts marked-up but never finalized, files clearly off-topic to the folder's context.

NOT RELEVANT — one-off retail receipts: Amazon orders, Costco trips, Home Depot purchases, Office Depot, Walmart, Target, Staples, etc. Even if the items were purchased for HOA use (pool supplies, office supplies, clubhouse stuff), one-off retail receipts are noise — they're not structured vendor records and don't belong in document search. Real vendor records look like recurring service contracts, invoices from a named service vendor with terms, or multi-page agreements — NOT a 1-page Amazon order confirmation.

NOT RELEVANT — documents clearly for a DIFFERENT community that Bedrock doesn't manage. If the doc is titled for or addresses a community other than ${communityHint} (and isn't a Bedrock-portfolio-wide doc like a template or training material), mark relevant=no.

When in doubt about junk vs. real, mark relevant=no — we'd rather miss a few than junk up the system.

Reply with ONLY valid JSON, no preamble:
{"relevant": true|false, "doc_type": "<short label like 'ccrs', 'budget', 'minutes', 'vendor_contract', 'junk', 'unknown'>", "confidence": "high"|"medium"|"low", "reasoning": "<one short sentence>"}`;

  const resp = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 300,
    messages: [{
      role: 'user',
      content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } },
        { type: 'text', text: prompt },
      ],
    }],
  });

  const text = (resp.content || []).map((b) => b.text || '').join('').trim();
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return { relevant: false, doc_type: 'unparseable', confidence: 'low', reasoning: 'pre-screen returned non-JSON' };
  try {
    return JSON.parse(jsonMatch[0]);
  } catch (_) {
    return { relevant: false, doc_type: 'unparseable', confidence: 'low', reasoning: 'pre-screen JSON parse failed' };
  }
}

// ----------------------------------------------------------------------------
// Staff-gate login — POST password → parse Set-Cookie → reuse cookie on every
// upload. The server's staff-auth middleware (server.js ~line 475) rejects
// anything without a valid `bedrock_gate` cookie.
// ----------------------------------------------------------------------------
let _gateCookie = null;
async function ensureLoggedIn() {
  if (_gateCookie) return _gateCookie;
  const res = await fetch(`${TRUSTED_URL}/api/staff-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: STAFF_PASSWORD }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`staff-login failed (HTTP ${res.status}): ${body.slice(0, 200)}`);
  }
  const setCookie = res.headers.get('set-cookie') || '';
  const m = setCookie.match(/bedrock_gate=([^;]+)/);
  if (!m) throw new Error('staff-login response missing bedrock_gate cookie');
  _gateCookie = `bedrock_gate=${m[1]}`;
  console.log('[bulk-upload] staff-gate login OK');
  return _gateCookie;
}

// ----------------------------------------------------------------------------
// Upload to trustEd
// ----------------------------------------------------------------------------
async function uploadToTrusted(filePath, fileBuffer) {
  const filename = path.basename(filePath);
  const blob = new Blob([fileBuffer], { type: 'application/pdf' });
  const form = new FormData();
  form.append('pdf', blob, filename);

  const res = await fetch(`${TRUSTED_URL}/api/documents/upload`, {
    method: 'POST',
    headers: { Cookie: _gateCookie },
    body: form,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) {}

  if (res.status === 409 && json && json.duplicate) {
    return { outcome: 'skipped_dup_at_server', existing_id: json.existing?.id || null };
  }
  if (!res.ok) {
    return { outcome: 'error', error: `HTTP ${res.status}: ${(json && json.error) || text.slice(0, 200)}` };
  }
  if (json && json.semantic_duplicate) {
    return {
      outcome: 'uploaded_semantic_dup_flag',
      doc_id: json.document?.id,
      community: json.matched_community?.name || null,
      category: json.document?.category || null,
      semantic_dup_id: json.semantic_duplicate.id,
    };
  }
  return {
    outcome: 'uploaded',
    doc_id: json && json.document ? json.document.id : null,
    community: json && json.matched_community ? json.matched_community.name : null,
    category: json && json.document ? json.document.category : null,
  };
}

// ----------------------------------------------------------------------------
// CSV writer (incremental)
// ----------------------------------------------------------------------------
function csvEscape(v) {
  if (v == null) return '';
  const s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}
const CSV_HEADER = [
  'path', 'size_bytes', 'sha256', 'outcome', 'doc_id', 'community',
  'category', 'pre_screen_doc_type', 'pre_screen_confidence',
  'pre_screen_reasoning', 'existing_id', 'error',
];
const csvStream = fs.createWriteStream(CSV_OUT, { flags: 'w' });
csvStream.write(CSV_HEADER.join(',') + '\n');
function csvRow(row) {
  csvStream.write(CSV_HEADER.map((k) => csvEscape(row[k])).join(',') + '\n');
}

// ----------------------------------------------------------------------------
// Per-file processor
// ----------------------------------------------------------------------------
async function processFile(filePath, existingHashes) {
  const row = { path: filePath };
  let stat;
  try {
    stat = await fsp.stat(filePath);
    row.size_bytes = stat.size;
  } catch (e) {
    row.outcome = 'error';
    row.error = `stat failed: ${e.message}`;
    csvRow(row);
    return row;
  }

  // 1. Hard skips (cheap)
  const skipReason = hardSkipReason(filePath, stat);
  if (skipReason) {
    row.outcome = `skipped_${skipReason}`;
    csvRow(row);
    return row;
  }

  // 2. Hash dedup (cheap)
  try {
    row.sha256 = await sha256File(filePath);
  } catch (e) {
    row.outcome = 'error';
    row.error = `hash failed: ${e.message}`;
    csvRow(row);
    return row;
  }
  const existing = existingHashes.get(row.sha256);
  if (existing) {
    row.outcome = 'skipped_already_in_trusted';
    row.existing_id = existing.id;
    csvRow(row);
    return row;
  }

  // 3. Read bytes once for both pre-screen + upload
  let fileBuffer;
  try {
    fileBuffer = await fsp.readFile(filePath);
  } catch (e) {
    row.outcome = 'error';
    row.error = `read failed: ${e.message}`;
    csvRow(row);
    return row;
  }

  // 4. Claude pre-screen (Haiku)
  let verdict;
  try {
    verdict = await preScreen(filePath, fileBuffer, COMMUNITY_HINT);
  } catch (e) {
    row.outcome = 'error';
    row.error = `pre-screen failed: ${e.message}`;
    csvRow(row);
    return row;
  }
  row.pre_screen_doc_type = verdict.doc_type;
  row.pre_screen_confidence = verdict.confidence;
  row.pre_screen_reasoning = verdict.reasoning;

  if (!verdict.relevant) {
    row.outcome = 'skipped_not_relevant';
    csvRow(row);
    return row;
  }
  if (verdict.confidence === 'low') {
    // Conservative default: skip on low confidence too. Logged so you can
    // review and re-upload manually if needed.
    row.outcome = 'skipped_low_confidence';
    csvRow(row);
    return row;
  }

  // 5. Upload
  if (DRY_RUN) {
    row.outcome = 'dry_run_would_upload';
    csvRow(row);
    return row;
  }

  let result;
  try {
    result = await uploadToTrusted(filePath, fileBuffer);
  } catch (e) {
    row.outcome = 'error';
    row.error = `upload failed: ${e.message}`;
    csvRow(row);
    return row;
  }
  Object.assign(row, result);
  csvRow(row);
  return row;
}

// ----------------------------------------------------------------------------
// Concurrency pool
// ----------------------------------------------------------------------------
async function runWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (true) {
      const i = idx++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: limit }, worker));
  return results;
}

// ----------------------------------------------------------------------------
// Main
// ----------------------------------------------------------------------------
(async () => {
  console.log(`[bulk-upload] folder:    ${FOLDER}`);
  console.log(`[bulk-upload] community: ${COMMUNITY_HINT}`);
  console.log(`[bulk-upload] target:    ${TRUSTED_URL}`);
  console.log(`[bulk-upload] csv out:   ${CSV_OUT}`);
  console.log(`[bulk-upload] dry run:   ${DRY_RUN}`);
  console.log(`[bulk-upload] concurrency: ${CONCURRENCY}`);
  console.log('');

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

  if (!DRY_RUN) await ensureLoggedIn();

  console.log('[bulk-upload] fetching existing hashes from trustEd…');
  const existingHashes = await fetchExistingHashes(supabase);
  console.log(`[bulk-upload]   found ${existingHashes.size} existing hashed docs`);

  console.log('[bulk-upload] walking folder…');
  const files = await walkFolder(FOLDER);
  console.log(`[bulk-upload]   found ${files.length} files`);
  console.log('');

  const counters = {};
  let done = 0;
  const total = files.length;

  await runWithConcurrency(files, CONCURRENCY, async (filePath) => {
    const row = await processFile(filePath, existingHashes);
    counters[row.outcome] = (counters[row.outcome] || 0) + 1;
    done += 1;
    const tag = (row.outcome || 'unknown').padEnd(30);
    console.log(`[${String(done).padStart(4)}/${total}] ${tag} ${path.basename(filePath)}`);
  });

  csvStream.end();

  console.log('');
  console.log('[bulk-upload] summary:');
  Object.entries(counters)
    .sort((a, b) => b[1] - a[1])
    .forEach(([k, v]) => console.log(`  ${k.padEnd(34)} ${v}`));
  console.log('');
  console.log(`[bulk-upload] CSV log written to: ${CSV_OUT}`);
})().catch((e) => {
  console.error('[bulk-upload] FATAL:', e);
  process.exit(1);
});
