// ============================================================================
// lib/onboarding/community/vantaca_transfers.js  (Issue #15) — Vantaca "Ownership Transfers"
// ----------------------------------------------------------------------------
// Parses the Vantaca Ownership Transfer Report (layout text of the original PDF)
// into TRANSFER EVIDENCE: property, current owner, owner mailing address,
// contact, settlement date, processed date, previous owner, with provenance.
// The report states its own period ("Ownership Transfers for 1/1/2026 -
// 7/31/2026"): it proves the transfers in that period and nothing about owners
// who acquired before it (their start dates stay unknown). It carries no account
// number, so the property is linked by its lot address in resolve.js.
// Columns are read by the header's positions; wrapped lines continue the record
// above. A record without a settlement date is a defect, never guessed.
// ============================================================================
const isoOf = (s) => { const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(s || '').trim()); return m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : null; };
const COLS = ['property', 'current_owner', 'mailing', 'contact', 'settlement', 'processed', 'previous_owner'];

function parseOwnershipTransfers(text, { file = null, file_sha256 = null } = {}) {
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  const defects = [];
  const pm = /Ownership Transfers for\s+(\d{1,2}\/\d{1,2}\/\d{4})\s*-\s*(\d{1,2}\/\d{1,2}\/\d{4})/i.exec(text);
  const association = (lines.find((l) => l.trim()) || '').trim();
  const generated = (/Report generated on\s+(\d{1,2}\/\d{1,2}\/\d{4})/i.exec(text) || [])[1];
  const hi = lines.findIndex((l) => /\bProperty\b/.test(l) && /\bSettlement\b/.test(l) && /\bProcessed\b/.test(l));
  if (!pm || hi < 0) return { period: null, association, generated_on: isoOf(generated), transfers: [], defects: [{ code: pm ? 'TRANSFER_HEADER_NOT_FOUND' : 'TRANSFER_PERIOD_NOT_FOUND' }] };
  const h = lines[hi];
  // column starts from the header words, in order (the second "Owner" is the previous owner)
  const starts = []; let from = 0;
  for (const word of ['Property', 'Owner', 'Address', 'Contact', 'Settlement', 'Processed', 'Owner']) { const i = h.indexOf(word, from); if (i < 0) return { period: null, association, transfers: [], defects: [{ code: 'TRANSFER_COLUMNS_NOT_FOUND', word }] }; starts.push(i); from = i + word.length; }
  // Column boundaries are the header positions, made word-safe per line: a word that
  // straddles a boundary belongs to the column it starts in (text never splits mid-word).
  const cut = (line) => {
    const b = starts.map((st, k) => {
      if (k === 0) return 0;
      let x = Math.max(0, st - 1);
      if (x < line.length && /\S/.test(line[x]) && x > 0 && /\S/.test(line[x - 1])) {
        let ws = x; while (ws > 0 && /\S/.test(line[ws - 1])) ws--;
        if (ws >= st - 2) x = ws; else { while (x < line.length && /\S/.test(line[x])) x++; }
      }
      return x;
    });
    return COLS.map((c, k) => line.slice(b[k], k + 1 < b.length ? b[k + 1] : undefined).trim());
  };
  const transfers = []; let cur = null;
  for (let i = hi + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    if (/Report generated on|^\s*Page \d+/i.test(line)) continue;
    const cells = cut(line);
    // A record line carries the settlement and processed dates past the contact column.
    // Long contact text can spill into the date column, so the dates are located by
    // position on the line, and the contact cell ends where the first date begins.
    const dates = [...line.matchAll(/\b\d{1,2}\/\d{1,2}\/\d{4}\b/g)].filter((m) => m.index > starts[3]);
    if (dates.length >= 2) {
      const [d1, d2] = dates;
      cells[3] = line.slice(Math.max(0, starts[3] - 2), d1.index).trim();
      cells[4] = d1[0]; cells[5] = d2[0];
      cells[6] = line.slice(d2.index + d2[0].length).trim();
      cur = { cells: cells.map((c) => [c]), line: i + 1 }; transfers.push(cur); continue;
    }
    if (!cur) { defects.push({ code: 'TRANSFER_TEXT_BEFORE_FIRST_RECORD', line: i + 1 }); continue; }
    cells.forEach((c, k) => { if (c) cur.cells[k].push(c); });
  }
  const out = transfers.map((t) => {
    const j = (k) => t.cells[k].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
    const contact = t.cells[3].join(' ');
    return {
      property_text: j(0), current_owner: j(1), mailing_text: j(2),
      emails: [...new Set((contact.match(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g) || []).map((e) => e.toLowerCase()))],
      phones: [...new Set((contact.match(/\(?\d{3}\)?[ .-]?\d{3}-\d{4}/g) || []).map((p) => p.replace(/\D/g, '')))],
      settlement_date: isoOf(t.cells[4][0]), processed_date: isoOf(t.cells[5][0]), previous_owner: j(6),
      provenance: { provider: 'vantaca', report: 'Ownership Transfer Report', file, file_sha256, line: t.line },
    };
  });
  for (const t of out) if (!t.property_text || !t.current_owner) defects.push({ code: 'TRANSFER_INCOMPLETE', line: t.provenance.line });
  return { period: { start: isoOf(pm[1]), end: isoOf(pm[2]) }, association, generated_on: isoOf(generated), transfers: out, defects };
}

module.exports = { parseOwnershipTransfers };
