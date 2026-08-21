// ============================================================================
// scripts/file_waterview_deputy_contracts.js  (Ed 2026-08-20)
// ----------------------------------------------------------------------------
// Files Waterview's contract-deputy agreements into the document library.
//
// Ed: "here are the historical documents can you include this in Waterviews
// files so we have accurate data."
//
// WHY THIS EXISTS. On 2026-08-20 a board email went out comparing the 2027
// renewal against "the expiring contract at $146,850". That figure came from
// the FY2024-25 agreement, which had already expired eleven months earlier. The
// current year was $179,790, and Alexis Geissler caught it from memory of the
// board approval. The correction was a 26.2% increase turning into 3.1%.
//
// The reason it happened is the reason for this script: the contracts existed
// only as loose PDFs on somebody's desktop with names like "2027 WATERVW (1)"
// and "Waterview_Estates_Contract". Nothing said which year, which agency, or
// which was in force. Filed here they carry their term, their cost and their
// agency, and supersession is recorded so "what are we paying now" has one
// answer instead of four candidate files.
//
// The signal that should have stopped me was already in the data: the Sheriff
// contract states a 3.35% cost of living line, and 26.2% contradicts it. A
// number that disagrees with another number in the same document is the check
// worth building next.
//
// The two 2027 files are UNSIGNED renewal offers, not executed agreements, so
// they go in as draft/proposed. Only the FY2025-26 agreement is current.
//
// record_ownership: association_record. An executed vendor contract belongs to
// the HOA and goes with them on termination.
//
// IDEMPOTENT: keyed on file_hash, so a re-run re-links rather than duplicating.
//
//   node scripts/file_waterview_deputy_contracts.js --dry-run
//   node scripts/file_waterview_deputy_contracts.js
// ============================================================================
require('dotenv').config();
const fs = require('fs');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const DRY = process.argv.includes('--dry-run');

const MGMT = '00000000-0000-0000-0000-000000000001';
const TMP = 'C:/Users/edget/AppData/Local/Temp/';

// Every figure below was read off the document itself, not carried over from
// the email that got it wrong.
const CONTRACTS = [
  {
    file: '2025 Waterview Contract.pdf',
    title: 'Contract Deputy Agreement, Fort Bend County Sheriff, FY 2024-25',
    period: 'FY2024-25',
    effective: '2024-10-01', expires: '2025-09-30',
    status: 'superseded', approval: 'signed',
    annual: 146850, monthly: 11630,
    notes: 'Fort Bend County Sheriff. $146,850 per year, $11,630 per month. '
         + '3.35% cost of living line of $2,500. Executed 2024-11-12. '
         + 'EXPIRED 2025-09-30. This is the agreement misquoted as current in '
         + 'the board email of 2026-08-20.',
  },
  {
    file: '2026 Waterview Contract.pdf',
    title: 'Contract Deputy Agreement, Fort Bend County Sheriff, FY 2025-26 (current)',
    period: 'FY2025-26',
    effective: '2025-10-01', expires: '2026-09-30',
    status: 'current', approval: 'signed',
    annual: 179790, monthly: 14230,
    notes: 'Fort Bend County Sheriff. One deputy, 40/80 hour. $179,790 per year, '
         + '$14,230 per month. 3.35% cost of living line of $3,320. Signed '
         + '2025-07-09. THIS IS THE AGREEMENT IN FORCE. Expires 2026-09-30.',
  },
  {
    file: '2027 WATERVW (1).pdf',
    title: 'Contract Deputy renewal offer, Fort Bend County Sheriff, FY 2026-27',
    period: 'FY2026-27',
    effective: '2026-10-01', expires: '2027-09-30',
    status: 'draft', approval: 'proposed',
    annual: 185360, monthly: 14670,
    notes: 'Fort Bend County Sheriff renewal OFFER, not executed. One deputy, '
         + '40/80 hour. $185,360 per year, $14,670 per month. Up $5,570 or 3.1% '
         + 'on FY2025-26, consistent with the stated 3.35% cost of living. '
         + 'Board decision due before 2026-08-28.',
  },
  {
    file: '2027 Waterview (1 Deputy) New.pdf',
    title: 'Contract Deputy proposal, Fort Bend County Constable Precinct 4, FY 2026-27',
    period: 'FY2026-27',
    effective: '2026-10-01', expires: '2027-09-30',
    status: 'draft', approval: 'proposed',
    annual: 163580, monthly: 12950,
    notes: 'Fort Bend County Constable Precinct 4 PROPOSAL, not executed. One '
         + 'deputy, 40/80 hour, same coverage as the Sheriff agreement. $163,580 '
         + 'per year, $12,950 per month. $21,780 less than the Sheriff renewal '
         + 'and $16,210 below FY2025-26. The file name gives no hint that this '
         + 'is the Constable rather than the Sheriff.',
  },
];

async function waterviewId() {
  const { data, error } = await supabase.from('communities')
    .select('id, name').ilike('name', '%waterview%').maybeSingle();
  if (error) throw new Error('community lookup failed: ' + error.message);
  if (!data) throw new Error('Waterview not found');
  return data;
}

(async () => {
  const community = await waterviewId();
  console.log('Filing into ' + community.name + (DRY ? '  [DRY RUN]' : ''));

  const filed = [];
  for (const c of CONTRACTS) {
    const path = TMP + c.file;
    if (!fs.existsSync(path)) { console.warn('  ! missing on disk: ' + c.file); continue; }
    const buf = fs.readFileSync(path);
    const hash = crypto.createHash('sha256').update(buf).digest('hex');

    // Idempotent on the file's own bytes.
    const { data: existing, error: exErr } = await supabase.from('library_documents')
      .select('id, title').eq('file_hash', hash).maybeSingle();
    if (exErr) throw new Error('hash lookup failed: ' + exErr.message);

    if (existing) {
      console.log('  exists   ' + c.period.padEnd(11) + existing.title);
      filed.push({ ...c, id: existing.id });
      continue;
    }

    const id = crypto.randomUUID();
    const storagePath = MGMT + '/' + community.id + '/vendor_contract/' + id + '.pdf';



    const row = {
      id,
      management_company_id: MGMT,
      community_id: community.id,
      category: 'vendor_contract',
      period_label: c.period,
      effective_date: c.effective,
      expiration_date: c.expires,
      status: c.status,
      approval_status: c.approval,
      title: c.title,
      file_name_original: c.file,
      file_name_normalized: c.title.replace(/[^A-Za-z0-9]+/g, '_') + '.pdf',
      file_path: storagePath,
      file_hash: hash,
      file_size_bytes: buf.length,
      created_by_mgmt_company: 'Bedrock',
      source_origin: 'library',
      extraction_model: 'claude-sonnet-4-5',
      extraction_confidence: 'high',
      notes: c.notes,
    };

    if (DRY) { console.log('  would file ' + c.period.padEnd(11) + c.title); filed.push({ ...c, id }); continue; }

    // Row FIRST, then the bytes. The reverse order left an orphaned object in
    // storage when the first run was rejected on a column type, and an orphan
    // is invisible: nothing lists it and nothing points at it.
    const { error: insErr } = await supabase.from('library_documents').insert(row);
    if (insErr) throw new Error('insert failed for ' + c.file + ': ' + insErr.message);
    const up = await supabase.storage.from('documents')
      .upload(storagePath, buf, { contentType: 'application/pdf', upsert: false });
    if (up.error) {
      // Leave no half-filed document: the row without its file is worse than
      // neither, because the library would show it and the link would 404.
      await supabase.from('library_documents').delete().eq('id', id);
      throw new Error('upload failed for ' + c.file + ', row rolled back: ' + up.error.message);
    }
    console.log('  filed    ' + c.period.padEnd(11) + c.title);
    filed.push({ ...c, id });
  }

  // Record the chain, so "what superseded what" is answerable without reading
  // four PDFs and comparing dates.
  const fy25 = filed.find((f) => f.period === 'FY2024-25');
  const fy26 = filed.find((f) => f.period === 'FY2025-26');
  if (!DRY && fy25 && fy26) {
    const { error } = await supabase.from('library_documents')
      .update({
        supersedes_library_document_id: fy25.id,
        supersession_recorded_at: new Date().toISOString(),
      }).eq('id', fy26.id);
    if (error) console.warn('  ! supersession link failed: ' + error.message);
    else console.log('\n  linked   FY2025-26 supersedes FY2024-25');

    const { error: e2 } = await supabase.from('library_documents')
      .update({ superseded_by_id: fy26.id, superseded_at: '2025-10-01T00:00:00Z' })
      .eq('id', fy25.id);
    if (e2) console.warn('  ! back-link failed: ' + e2.message);
  }

  console.log('\nWaterview contract deputy history now on file:');
  const { data: all, error: allErr } = await supabase.from('library_documents')
    .select('period_label, title, status, approval_status, effective_date, expiration_date')
    .eq('community_id', community.id).eq('category', 'vendor_contract')
    .ilike('title', '%Contract Deputy%')
    .order('effective_date', { ascending: true });
  if (allErr) throw new Error(allErr.message);
  (all || []).forEach((d) => console.log('  ' + String(d.period_label).padEnd(11)
    + String(d.status).padEnd(12) + String(d.approval_status).padEnd(10)
    + String(d.effective_date) + ' to ' + String(d.expiration_date)));
})().catch((e) => { console.error('filing failed:', e.message); process.exit(1); });
