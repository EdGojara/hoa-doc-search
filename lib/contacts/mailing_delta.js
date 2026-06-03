// ============================================================================
// lib/contacts/mailing_delta.js
// ----------------------------------------------------------------------------
// "What's changed since I verified the roster?" — categorized comparison of
// the canonical (verified) trustEd roster against a Vantaca Mailing
// Addresses Export. Built 2026-06-03 after a manual reconciliation on
// Waterview showed the categories below are the natural shape of the
// signal vs. the noise.
//
// CATEGORIES OF DELTAS:
//   1. transfers              same property address, NEW Vantaca account # +
//                              OLD trustEd account # both present → property
//                              changed hands; the cleanest action is to
//                              update the new owner on the roster
//   2. real_mailing_changes   matched account, mailing fields actually
//                              different (owner moved, address corrected,
//                              etc.) — operator decides per-row whether
//                              Vantaca's value is right
//   3. parse_bugs             matched account, trustEd has obviously broken
//                              fields (state isn't 2 letters, zip is blank,
//                              etc.) — Vantaca has clean data; safe to copy
//   4. real_name_diffs        matched account, name tokens differ
//                              meaningfully (not just "&" formatting) —
//                              review per-row
//   5. format_only_noise      matched account, name tokens are the same
//                              just arranged differently (e.g. "John &
//                              Mary Smith" vs "John Smith & Mary Smith") —
//                              ignore; trustEd's cleaned format is fine
//
// INPUT SHAPE:
//   - trustedRows: array of contact+property rows from v_current_property_owners
//                  (must include vantaca_account_id, full_name, street_address,
//                   city, state, zip, mailing_street, mailing_city,
//                   mailing_state, mailing_zip, contact_id)
//   - vantacaBuffer: the uploaded Vantaca Mailing Addresses Export (xlsx)
//
// OUTPUT:
//   { transfers, real_mailing_changes, parse_bugs, real_name_diffs,
//     format_only_noise_count, matched_count, vantaca_row_count,
//     trusted_row_count, accounts_only_in_trusted, accounts_only_in_vantaca }
// ============================================================================

const xlsx = require('xlsx');

function _norm(s)     { return String(s == null ? '' : s).trim(); }
function _upper(s)    { return _norm(s).toUpperCase(); }
function _collapse(s) { return _norm(s).replace(/\s+/g, ' ').toLowerCase(); }
function _zipNorm(s)  { return _norm(s).split('-')[0]; }

// Tokenize a name into a sorted set so "John & Mary Smith" matches
// "John Smith & Mary Smith" — both reduce to {john, mary, smith}.
// Strips middle initials, "&", commas, suffix tokens (Jr/Sr/III).
function _nameTokens(s) {
  return _collapse(s)
    .replace(/[&,]/g, ' ')
    .replace(/\b(jr|sr|ii|iii|iv)\b/g, '')
    .replace(/\b[a-z]\.\s*/g, '')
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(' ');
}

// Parse a Vantaca mailing export. Auto-detects two shapes:
//
//   A) "Homeowner Contact Information" — 3-sheet xlsx with Address /
//      Email / Phone tabs. The Address sheet has columns:
//        Account | HomeownerName | Street No | Address1 | Address2 |
//        Unit No | City | State/Province | Zip | International Address |
//        Address Type | Label | Primary Mailing
//      Multiple rows per account (one per address-on-file). We filter
//      to Primary Mailing = "Yes" to get exactly one canonical mailing
//      row per account. This is the report shape Ed found 2026-06-03
//      that finally answered the "Primary vs alternates" problem.
//
//   B) "Mailing Addresses Export" — single-sheet xlsx with columns:
//        Account | HomeownerName | FirstName | LastName | Spouse* |
//        BusinessName | DeedName | MailingNameOverride | StreetNo |
//        Address1 | Address2 | Unit No | City | MailState | MailZip | ...
//      Returns ALL mailing addresses; no Primary filter. Treat every
//      row as the canonical mailing (will mis-flag when an account has
//      alternates). Kept for back-compat; the new "Homeowner Contact
//      Information" export is preferred.
//
// Returns a Map keyed by Account number with the structured fields.
function parseVantacaMailingExport(buffer) {
  const wb = xlsx.read(buffer, { type: 'buffer' });
  // Prefer the Address sheet (shape A) if present; otherwise fall back
  // to the first sheet (shape B).
  let sheetName, useShapeA = false;
  if (wb.SheetNames.includes('Address')) {
    sheetName = 'Address';
    useShapeA = true;
  } else {
    sheetName = wb.SheetNames[0];
  }
  const sheet = wb.Sheets[sheetName];
  if (!sheet) return new Map();
  const rows = xlsx.utils.sheet_to_json(sheet, { defval: '', raw: false });
  const map = new Map();

  for (const r of rows) {
    const account = _norm(r['Account']);
    if (!account) continue;

    if (useShapeA) {
      // SHAPE A — filter to Primary Mailing = "Yes"
      const isPrimary = _norm(r['Primary Mailing']).toLowerCase() === 'yes';
      if (!isPrimary) continue;
      const baseStreet = [
        _norm(r['Street No']),
        _norm(r['Address1']),
        _norm(r['Address2']),
      ].filter(Boolean).join(' ').trim();
      const unit = _norm(r['Unit No']);
      const fullStreet = unit ? `${baseStreet} ${unit}` : baseStreet;
      map.set(account, {
        account,
        owner_name: _norm(r['HomeownerName']),
        mailing_street: fullStreet,
        mailing_city:   _norm(r['City']),
        mailing_state:  _upper(r['State/Province']),
        mailing_zip:    _norm(r['Zip']),
        raw: r,
      });
      continue;
    }

    // SHAPE B (legacy) — single mailing row per account, no Primary
    // filter available
    const baseStreet = [
      _norm(r['StreetNo']),
      _norm(r['Address1']),
      _norm(r['Address2']),
    ].filter(Boolean).join(' ').trim();
    const unit = _norm(r['Unit No']);
    const fullStreet = unit ? `${baseStreet} ${unit}` : baseStreet;

    let name = _norm(r['HomeownerName']);
    if (!name) name = [_norm(r['FirstName']), _norm(r['LastName'])].filter(Boolean).join(' ');
    const spouse = [_norm(r['SpouseFirstName']), _norm(r['SpouseLastName'])].filter(Boolean).join(' ');
    if (spouse) name = name ? `${name} & ${spouse}` : spouse;
    if (!name) name = _norm(r['BusinessName']) || _norm(r['DeedName']) || _norm(r['MailingNameOverride']);

    map.set(account, {
      account,
      owner_name: name,
      mailing_street: fullStreet,
      mailing_city:   _norm(r['City']),
      mailing_state:  _upper(r['MailState']),
      mailing_zip:    _norm(r['MailZip']),
      raw: r,
    });
  }
  return map;
}

// Heuristic: is this trustEd row obviously broken? Used to flag parse
// bugs where Vantaca's data is reliable. Three patterns we care about:
//   - mailing_state isn't 2 letters AND mailing_zip is empty
//   - mailing_state isn't 2 letters AND mailing_zip is shorter than 5
//   - mailing_zip contains characters that aren't digits or hyphen
function _trustedRowLooksBroken(t) {
  const stateOK = /^[A-Z]{2}$/.test(_upper(t.mailing_state));
  const zip = _norm(t.mailing_zip);
  const zipOK = /^\d{5}(-\d{4})?$/.test(zip);
  return (!stateOK && (zip === '' || zip.length < 5)) || (!zipOK && zip !== '');
}

// Inverse check: does the Vantaca row look broken? If Vantaca's value
// is obvious garbage (zip with letters, state not 2 letters, etc.)
// AND trustEd has clean values, the operator should KEEP trustEd's
// data. We flag these as vantaca_garbage to keep them out of the
// "real mailing change" bucket where they'd look like legitimate
// changes worth applying.
function _vantacaRowLooksBroken(v) {
  const stateOK = /^[A-Z]{2}$/.test(_upper(v.mailing_state));
  const zip = _norm(v.mailing_zip);
  const zipOK = /^\d{5}(-\d{4})?$/.test(zip);
  // Don't flag a totally-empty vantaca mailing as broken (that's just
  // "no mailing on file"). Broken means content-but-malformed.
  const hasAnyContent = _norm(v.mailing_street) || _norm(v.mailing_city) || zip || _norm(v.mailing_state);
  if (!hasAnyContent) return false;
  return (!stateOK && _norm(v.mailing_state) !== '') || (!zipOK && zip !== '');
}

// Has trustEd's value clean (passes basic validation)? Used in combo
// with _vantacaRowLooksBroken to confirm we should keep trustEd.
function _trustedRowLooksClean(t) {
  const stateOK = /^[A-Z]{2}$/.test(_upper(t.mailing_state));
  const zip = _norm(t.mailing_zip);
  const zipOK = /^\d{5}(-\d{4})?$/.test(zip);
  return stateOK && zipOK;
}

// Main comparison entry point.
function computeMailingDelta(trustedRows, vantacaMap) {
  const trustedByAccount = new Map();
  const trustedByPropAddress = new Map();
  for (const tr of trustedRows) {
    const acct = _norm(tr.vantaca_account_id);
    if (acct) trustedByAccount.set(acct, tr);
    const propKey = _collapse(`${tr.street_address}|${tr.city}|${_zipNorm(tr.zip)}`);
    if (!trustedByPropAddress.has(propKey)) trustedByPropAddress.set(propKey, []);
    trustedByPropAddress.get(propKey).push(tr);
  }

  const transfers = [];
  const real_mailing_changes = [];
  const parse_bugs = [];
  const vantaca_garbage = [];  // Vantaca data is broken; KEEP trustEd
  const real_name_diffs = [];
  let format_only_noise_count = 0;
  let matched_count = 0;

  const trustedAccountKeys = new Set(trustedByAccount.keys());
  const vantacaAccountKeys = new Set(vantacaMap.keys());

  const accounts_only_in_trusted = [...trustedAccountKeys].filter(k => !vantacaAccountKeys.has(k));
  const accounts_only_in_vantaca = [...vantacaAccountKeys].filter(k => !trustedAccountKeys.has(k));

  // Detect transfers: Vantaca-only account whose mailing address matches
  // a trustEd property address. The old account # is closed in Vantaca;
  // the new one points at the same physical property.
  for (const vAcct of accounts_only_in_vantaca) {
    const vr = vantacaMap.get(vAcct);
    const propKey = _collapse(`${vr.mailing_street}|${vr.mailing_city}|${_zipNorm(vr.mailing_zip)}`);
    const tCandidates = trustedByPropAddress.get(propKey);
    if (!tCandidates || tCandidates.length === 0) continue;
    // Pick the trustEd row whose account is ONLY in trustEd (i.e., the
    // old account that got closed) — defensive in case multiple trustEd
    // rows share a property address.
    const oldTr = tCandidates.find(t => accounts_only_in_trusted.includes(_norm(t.vantaca_account_id))) || tCandidates[0];
    transfers.push({
      property: {
        street_address: oldTr.street_address,
        city: oldTr.city,
        state: oldTr.state,
        zip: oldTr.zip,
      },
      old_account: _norm(oldTr.vantaca_account_id),
      old_owner_name: oldTr.full_name || '',
      old_contact_id: oldTr.owner_contact_id || oldTr.contact_id || null,
      new_account: vAcct,
      new_owner_name: vr.owner_name,
      new_mailing: {
        street: vr.mailing_street,
        city:   vr.mailing_city,
        state:  vr.mailing_state,
        zip:    vr.mailing_zip,
      },
    });
  }

  // Field-level diffs on matched accounts
  for (const [acct, tr] of trustedByAccount) {
    const vr = vantacaMap.get(acct);
    if (!vr) continue;
    matched_count++;

    // Owner name
    const tName = _collapse(tr.full_name);
    const vName = _collapse(vr.owner_name);
    if (tName !== vName) {
      if (_nameTokens(tr.full_name) === _nameTokens(vr.owner_name)) {
        format_only_noise_count++;
      } else {
        real_name_diffs.push({
          account: acct,
          contact_id: tr.owner_contact_id || tr.contact_id || null,
          property_address: tr.street_address,
          trusted_name: tr.full_name,
          vantaca_name: vr.owner_name,
        });
      }
    }

    // Mailing block
    const tBlob = _collapse(`${tr.mailing_street}|${tr.mailing_city}|${tr.mailing_state}|${_zipNorm(tr.mailing_zip)}`);
    const vBlob = _collapse(`${vr.mailing_street}|${vr.mailing_city}|${vr.mailing_state}|${_zipNorm(vr.mailing_zip)}`);
    if (tBlob === vBlob) continue;

    // Pick the right bucket:
    //   - trustEd looks broken + Vantaca looks clean → parse_bugs
    //     (safe to copy from Vantaca; pre-checked in UI)
    //   - Vantaca looks broken + trustEd looks clean → vantaca_garbage
    //     (DO NOT apply; surfaced as "Vantaca has invalid data, keep
    //      trustEd value")
    //   - everything else → real_mailing_changes (operator reviews)
    const tBroken = _trustedRowLooksBroken(tr);
    const vBroken = _vantacaRowLooksBroken(vr);
    const tClean  = _trustedRowLooksClean(tr);
    let bucket;
    if (tBroken && !vBroken)      bucket = parse_bugs;
    else if (vBroken && tClean)   bucket = vantaca_garbage;
    else                          bucket = real_mailing_changes;

    bucket.push({
      account: acct,
      contact_id: tr.owner_contact_id || tr.contact_id || null,
      property_address: tr.street_address,
      owner_name: tr.full_name,
      trusted: {
        street: tr.mailing_street || '',
        city:   tr.mailing_city || '',
        state:  tr.mailing_state || '',
        zip:    tr.mailing_zip || '',
      },
      vantaca: {
        street: vr.mailing_street,
        city:   vr.mailing_city,
        state:  vr.mailing_state,
        zip:    vr.mailing_zip,
      },
    });
  }

  return {
    summary: {
      trusted_row_count: trustedRows.length,
      vantaca_row_count: vantacaMap.size,
      matched_count,
      transfers_count: transfers.length,
      real_mailing_changes_count: real_mailing_changes.length,
      parse_bugs_count: parse_bugs.length,
      vantaca_garbage_count: vantaca_garbage.length,
      real_name_diffs_count: real_name_diffs.length,
      format_only_noise_count,
      accounts_only_in_trusted_count: accounts_only_in_trusted.length,
      accounts_only_in_vantaca_count: accounts_only_in_vantaca.length,
    },
    transfers,
    real_mailing_changes,
    parse_bugs,
    vantaca_garbage,
    real_name_diffs,
    accounts_only_in_trusted,
    accounts_only_in_vantaca,
  };
}

module.exports = {
  parseVantacaMailingExport,
  computeMailingDelta,
};
