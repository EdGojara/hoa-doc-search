// ============================================================================
// vantaca_import.js
// ----------------------------------------------------------------------------
// Parses uploaded Vantaca exports (.xlsx, .xls, .csv) into a normalized
// shape trustEd's contact/property tables understand. Auto-detects columns
// via fuzzy header matching so the same import path works regardless of
// which Vantaca export type staff uses (owner roster, current resident,
// account roster, etc.).
//
// Returns:
//   { rows: NormalizedRow[], mapping: {fieldName: detectedHeader}, errors: [] }
//
// Where NormalizedRow is:
//   {
//     account_id, street_address, unit, city, state, zip,
//     owner_name, owner_email, owner_phone, mailing_address,
//     resident_name, resident_email, resident_phone, residency_type,
//     vesting, lot_number, raw  // raw original row for traceability
//   }
//
// Diff is computed downstream against the live properties + ownerships +
// residencies tables — this module just normalizes the upload payload.
// ============================================================================

const xlsx = require('xlsx');

// Field detection rules: each entry is { field, patterns, excludePatterns? } where
// any pattern match (case-insensitive, normalized whitespace/punctuation) on a
// column header maps that column to the field. Order matters within patterns —
// more specific patterns first so generic ones don't shadow them. excludePatterns
// (optional) prevents a header from matching even if patterns would (used to keep
// "Homeowner ID" out of the owner_name slot).
const FIELD_PATTERNS = [
  { field: 'account_id',      patterns: ['account #', 'account number', 'account id', 'acct #', 'acct id', 'vantaca id', 'account'] },
  // Vantaca often splits address into house # + street name (MailStreetNo + MailAddress1).
  // house_number is its own field; the parser concatenates it onto street_address.
  { field: 'house_number',    patterns: ['mail street no', 'street no', 'street number', 'house number', 'house #', 'street #', 'streetno', 'mailstreetno'] },
  { field: 'street_address',  patterns: ['property address', 'street address', 'site address', 'home address', 'mailaddress1', 'mail address 1', 'mail address', 'mailing street', 'address 1', 'address1', 'street', 'address', 'property'] },
  { field: 'unit',            patterns: ['unit no', 'unit #', 'unit number', 'unit', 'apartment', 'apt'] },
  { field: 'city',            patterns: ['mail city', 'mailcity', 'property city', 'city'] },
  { field: 'state',           patterns: ['mail state', 'mailstate', 'property state', 'state'] },
  { field: 'zip',             patterns: ['mail zip', 'mailzip', 'zip code', 'zipcode', 'zip', 'postal code', 'postal'] },
  { field: 'lot_number',      patterns: ['lot #', 'lot number', 'lot/block', 'lot', 'block'] },
  // owner_name MUST not match ID/code/number columns like "Homeowner ID" or "Owner #".
  // We try the most specific name patterns first (HomeownerName as one token, Owner Name as a phrase).
  // Fall back to building from first/last when nothing direct matches.
  { field: 'owner_name',      patterns: ['homeownername', 'owner name', 'owners name', 'owner(s)', 'homeowner name', 'title holder', 'name on title', 'owner', 'homeowner'], excludePatterns: ['id', '#', 'number', 'code', 'no'] },
  { field: 'first_name',      patterns: ['firstname', 'first name', 'owner first'] },
  { field: 'last_name',       patterns: ['lastname', 'last name', 'owner last'] },
  { field: 'spouse_first',    patterns: ['spousefirstname', 'spouse first', 'spouse first name', 'co-owner first'] },
  { field: 'spouse_last',     patterns: ['spouselastname', 'spouse last', 'spouse last name', 'co-owner last'] },
  { field: 'business_name',   patterns: ['businessname', 'business name', 'entity name', 'llc name', 'trust name'] },
  { field: 'deed_name',       patterns: ['deedname', 'deed name', 'name on deed'] },
  { field: 'mailing_override',patterns: ['mailingnameoverride', 'mailing name override', 'mailing name'] },
  { field: 'owner_email',     patterns: ['owner email', 'primary email', 'email address', 'email'] },
  { field: 'owner_phone',     patterns: ['owner phone', 'primary phone', 'phone number', 'phone', 'mobile', 'cell'] },
  { field: 'mailing_address', patterns: ['mailing address', 'mail to', 'billing address', 'ship to'] },
  { field: 'resident_name',   patterns: ['resident name', 'tenant name', 'occupant name', 'resident', 'tenant', 'occupant'] },
  { field: 'resident_email',  patterns: ['resident email', 'tenant email'] },
  { field: 'resident_phone',  patterns: ['resident phone', 'tenant phone'] },
  { field: 'residency_type',  patterns: ['occupancy type', 'occupancy', 'resident type', 'owner occupied', 'rental status'] },
  { field: 'vesting',         patterns: ['vesting', 'title type', 'ownership type'] },
  { field: 'mail_rel_type',   patterns: ['mailreltype', 'mail rel type', 'mail relationship type', 'mail rel'] },
];

function _normHeader(h) {
  return String(h || '').toLowerCase().trim().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ');
}

// Walk every cell header, find the best match for each known field.
// Returns { field: { header, columnIndex } } — only fields that matched.
// Two-pass:
//   pass 1 — try EXACT matches (h.norm === pat). This locks in unambiguous
//            columns like "Account" → account_id, "HomeownerName" → owner_name
//            before any loose substring match can steal them.
//   pass 2 — substring matches with excludePatterns to keep ID columns out of
//            name fields.
// Once a column is claimed by one field, it can't be claimed by another.
function detectColumnMapping(headers) {
  const normalized = headers.map((h, i) => ({ raw: h, norm: _normHeader(h), idx: i }));
  const mapping = {};
  const claimed = new Set();  // column indexes already mapped

  function _matchField(field, patterns, excludePatterns, exactOnly) {
    if (mapping[field]) return;
    for (const pat of patterns) {
      const candidates = normalized.filter((h) => {
        if (claimed.has(h.idx)) return false;
        if (exactOnly) return h.norm === pat;
        return h.norm === pat || h.norm.includes(pat);
      });
      if (candidates.length === 0) continue;
      // Apply excludePatterns: skip headers containing any excluded token.
      const filtered = excludePatterns && excludePatterns.length
        ? candidates.filter((h) => {
            const tokens = h.norm.split(' ');
            return !excludePatterns.some((ex) =>
              h.norm === ex || tokens.includes(ex) || h.norm.endsWith(' ' + ex)
            );
          })
        : candidates;
      if (filtered.length === 0) continue;
      const winner = filtered[0];
      mapping[field] = { header: winner.raw, columnIndex: winner.idx };
      claimed.add(winner.idx);
      return;
    }
  }

  // Pass 1: exact matches only
  for (const { field, patterns, excludePatterns } of FIELD_PATTERNS) {
    _matchField(field, patterns, excludePatterns, true);
  }
  // Pass 2: substring fallback
  for (const { field, patterns, excludePatterns } of FIELD_PATTERNS) {
    _matchField(field, patterns, excludePatterns, false);
  }
  return mapping;
}

// Coerce a residency-type-like string into our enum.
// Vantaca exports vary wildly: "Owner Occupied", "OO", "Rental", "RN", "N/A", ""
function _normalizeResidencyType(v) {
  if (v == null) return null;
  const s = String(v).toLowerCase().trim();
  if (!s || s === 'n/a' || s === 'unknown') return null;
  if (s.includes('owner') || s === 'oo') return 'owner_occupied';
  if (s.includes('rent') || s.includes('tenant') || s.includes('lease') || s === 'rn') return 'renter';
  if (s.includes('vacant') || s.includes('empty')) return 'vacant';
  if (s.includes('family')) return 'family_member';
  return null;
}

// Light cleanup — trim, collapse spaces, strip surrounding quotes.
function _clean(v) {
  if (v == null) return null;
  const s = String(v).trim().replace(/\s+/g, ' ').replace(/^["']|["']$/g, '');
  return s || null;
}

// Simple address split: if "1234 Main St APT 4B" comes through as one field,
// try to peel off the unit. Heuristic — leaves complex cases to staff review.
function _splitAddress(full) {
  if (!full) return { street: null, unit: null };
  const m = String(full).match(/^(.+?)\s+(?:apt|unit|#|ste|suite)\.?\s*([A-Za-z0-9-]+)\s*$/i);
  if (m) return { street: m[1].trim(), unit: m[2].trim() };
  return { street: full.trim(), unit: null };
}

// Parse an uploaded buffer (xlsx/xls/csv) and return normalized rows.
function parseVantacaExport(buffer, filename) {
  let workbook;
  try {
    workbook = xlsx.read(buffer, { type: 'buffer', cellDates: true });
  } catch (e) {
    return { rows: [], mapping: {}, errors: [`Could not parse file: ${e.message}`] };
  }
  if (!workbook.SheetNames.length) {
    return { rows: [], mapping: {}, errors: ['File contains no sheets.'] };
  }
  // Use the first sheet by default. Vantaca exports are typically single-sheet.
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const aoa = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: null, blankrows: false });
  if (aoa.length < 2) {
    return { rows: [], mapping: {}, errors: ['File has no data rows (expected header + at least 1 row).'] };
  }

  const headers = aoa[0].map((h) => (h == null ? '' : String(h)));
  const mapping = detectColumnMapping(headers);

  if (!mapping.street_address) {
    return {
      rows: [], mapping, headers,
      errors: ['Could not detect an address column. Expected one of: Property Address, Street Address, Site Address, Address, Property.'],
    };
  }

  const rows = [];
  const errors = [];
  for (let r = 1; r < aoa.length; r++) {
    const row = aoa[r];
    const getField = (f) => {
      const m = mapping[f];
      return m ? _clean(row[m.columnIndex]) : null;
    };
    const rawStreet = getField('street_address');
    if (!rawStreet) continue; // Skip rows without an address.

    // Address may be combined with unit; split if so.
    const explicitUnit = getField('unit');
    const split = explicitUnit ? { street: rawStreet, unit: explicitUnit } : _splitAddress(rawStreet);

    // Vantaca split-address: house number is its own column, street name is its own.
    // Concatenate ONLY when street_address doesn't already begin with a digit.
    const houseNum = getField('house_number');
    if (houseNum && split.street && !/^\d/.test(split.street)) {
      split.street = `${houseNum} ${split.street}`;
    }

    // Owner name composition with Vantaca-conventional fallback priority:
    // MailingNameOverride > BusinessName > DeedName > HomeownerName > FirstName + LastName (+ Spouse).
    let ownerName = getField('mailing_override')
                 || getField('business_name')
                 || getField('deed_name')
                 || getField('owner_name');
    if (!ownerName) {
      const first  = getField('first_name');
      const last   = getField('last_name');
      const sFirst = getField('spouse_first');
      const sLast  = getField('spouse_last');
      const primary = [first, last].filter(Boolean).join(' ').trim();
      const spouse  = [sFirst, sLast].filter(Boolean).join(' ').trim();
      if (primary && spouse) ownerName = `${primary} & ${spouse}`;
      else if (primary)      ownerName = primary;
      else if (spouse)       ownerName = spouse;
    }

    const norm = {
      account_id:       getField('account_id'),
      street_address:   split.street,
      unit:             split.unit,
      city:             getField('city'),
      state:            getField('state') || 'TX',
      zip:              getField('zip'),
      lot_number:       getField('lot_number'),
      owner_name:       ownerName || null,
      owner_email:      getField('owner_email'),
      owner_phone:      getField('owner_phone'),
      mailing_address:  getField('mailing_address'),
      resident_name:    getField('resident_name'),
      resident_email:   getField('resident_email'),
      resident_phone:   getField('resident_phone'),
      residency_type:   _normalizeResidencyType(getField('residency_type')),
      vesting:          getField('vesting'),
      mail_rel_type:    getField('mail_rel_type'),
      _source_row:      r + 1,  // 1-indexed including header
    };
    rows.push(norm);
  }

  return { rows, mapping, headers, errors };
}

// ============================================================================
// Diff engine — takes a community_id + normalized rows + a supabase client,
// returns the structured diff WITHOUT applying anything.
//
// Output shape:
// {
//   new_properties:        [{row, suggested_property}]
//   property_field_changes: [{property_id, address, changes: {field: {from, to}}}]
//   new_contacts:          [{name, email, phone, row}]
//   new_ownerships:        [{property_id, address, contact_name, ...}]
//   ownership_changes:     [{property_id, address, prior_owner, new_owner}]
//   new_residencies:       [{property_id, address, resident_name, type}]
//   email_additions:       [{contact_id, name, new_email}]
//   phone_additions:       [{contact_id, name, new_phone}]
//   ignored:               [{row, reason}]
// }
// ============================================================================
async function computeDiff(supabase, communityId, normalizedRows) {
  const diff = {
    new_properties:         [],
    property_field_changes: [],
    new_contacts:           [],
    new_ownerships:         [],
    ownership_changes:      [],
    new_residencies:        [],
    email_additions:        [],
    phone_additions:        [],
    duplicate_rows:         [],  // multi-row-per-property in the SAME upload (renter + owner, etc.)
    ignored:                [],
  };
  if (!normalizedRows || normalizedRows.length === 0) return diff;

  // ---------------------------------------------------------------------------
  // In-batch dedup. Two patterns we need to collapse:
  //
  //   (a) Multiple rows for the SAME account_id with DIFFERENT addresses —
  //       Vantaca's "All Addresses" export emits property_address + separate
  //       mailing_address as two rows for non-occupant owners. The owner's
  //       Sugar Land mailing address gets a row, AND their Quail Ridge
  //       property gets a row. Same Account number on both.
  //
  //   (b) Multiple rows for the SAME address (e.g., owner row + renter row).
  //       Less common in this export type but supported.
  //
  // Strategy: dedup by account_id when present, falling back to address key.
  // When we collapse duplicates with DIFFERENT addresses, prefer the row whose
  // address looks like a property in the community (matched against the most
  // common zip code in the batch — usually the community's zip). The other
  // row becomes the contact's mailing_address.
  // ---------------------------------------------------------------------------

  // First, find the modal zip — the zip that appears most often in the upload.
  // This is almost certainly the community's primary zip code, and any row
  // matching it is more likely a property address than a mailing address.
  const zipCounts = new Map();
  for (const row of normalizedRows) {
    if (row.zip) zipCounts.set(row.zip, (zipCounts.get(row.zip) || 0) + 1);
  }
  let communityZip = null;
  let maxZipCount = 0;
  for (const [z, c] of zipCounts) {
    if (c > maxZipCount) { communityZip = z; maxZipCount = c; }
  }

  const seenInBatch = new Map();      // key -> canonical row
  const deduped = [];
  for (const row of normalizedRows) {
    // Prefer account_id as the dedup key — it's stable across address variations.
    // Fall back to address key when account_id is absent (rare in Vantaca exports).
    const key = row.account_id ? `acct:${row.account_id}` : `addr:${_addressKey(row.street_address, row.unit)}`;
    if (!seenInBatch.has(key)) {
      seenInBatch.set(key, row);
      deduped.push(row);
      continue;
    }
    const canonical = seenInBatch.get(key);

    // If the canonical row's zip doesn't match the community but THIS row's does,
    // swap them — this row's address is the actual property; canonical's was the
    // owner's mailing address.
    const canonicalIsCommunity = !communityZip || canonical.zip === communityZip;
    const rowIsCommunity       = !communityZip || row.zip === communityZip;
    if (!canonicalIsCommunity && rowIsCommunity) {
      // Promote `row` to canonical; demote canonical's address to mailing_address.
      const priorMailingAddr = `${canonical.street_address || ''}${canonical.unit ? ' #' + canonical.unit : ''}, ${canonical.city || ''} ${canonical.state || ''} ${canonical.zip || ''}`.trim();
      // Replace fields in place so the array reference stays valid.
      Object.assign(canonical, {
        street_address: row.street_address,
        unit:           row.unit,
        city:           row.city,
        state:          row.state,
        zip:            row.zip,
        mailing_address: canonical.mailing_address || priorMailingAddr,
      });
    } else if (canonicalIsCommunity && !rowIsCommunity) {
      // Canonical is the property; this dup is the mailing address.
      const dupMailingAddr = `${row.street_address || ''}${row.unit ? ' #' + row.unit : ''}, ${row.city || ''} ${row.state || ''} ${row.zip || ''}`.trim();
      canonical.mailing_address = canonical.mailing_address || dupMailingAddr;
    }

    // Promote owner / resident info from the dup if canonical was empty.
    if (!canonical.owner_name && row.owner_name) {
      canonical.owner_name  = row.owner_name;
      canonical.owner_email = canonical.owner_email || row.owner_email;
      canonical.owner_phone = canonical.owner_phone || row.owner_phone;
    }
    if (!canonical.resident_name && row.resident_name) {
      canonical.resident_name  = row.resident_name;
      canonical.resident_email = canonical.resident_email || row.resident_email;
      canonical.resident_phone = canonical.resident_phone || row.resident_phone;
    }
    if (!canonical.residency_type && row.residency_type) {
      canonical.residency_type = row.residency_type;
    }
    diff.duplicate_rows.push({
      address:        row.street_address + (row.unit ? ' #' + row.unit : ''),
      first_row:      canonical._source_row,
      duplicate_row:  row._source_row,
      account_id:     row.account_id,
      duplicate_owner:    row.owner_name,
      duplicate_resident: row.resident_name,
      reason:         row.account_id ? 'same Account — likely mailing-vs-property addr' : 'same address',
    });
  }
  normalizedRows = deduped;

  // Pull existing properties for this community (id + street/unit + vantaca_account_id).
  const { data: existingProps } = await supabase
    .from('properties')
    .select('id, street_address, unit, city, zip, vantaca_account_id, lot_number')
    .eq('community_id', communityId);
  const propsByAddress = new Map();
  const propsByAccount = new Map();
  (existingProps || []).forEach((p) => {
    const key = _addressKey(p.street_address, p.unit);
    propsByAddress.set(key, p);
    if (p.vantaca_account_id) propsByAccount.set(p.vantaca_account_id, p);
  });

  // Pull contacts referenced by these properties' current ownerships, for owner-change detection.
  const propIds = (existingProps || []).map((p) => p.id);
  const ownershipsByProp = new Map();
  if (propIds.length > 0) {
    const { data: ownerships } = await supabase
      .from('property_ownerships')
      .select('id, property_id, contact_id, start_date, end_date, is_primary, contacts(id, full_name, primary_email, primary_phone)')
      .in('property_id', propIds)
      .is('end_date', null);
    (ownerships || []).forEach((o) => {
      if (!ownershipsByProp.has(o.property_id)) ownershipsByProp.set(o.property_id, []);
      ownershipsByProp.get(o.property_id).push(o);
    });
  }

  for (const row of normalizedRows) {
    const addrKey = _addressKey(row.street_address, row.unit);
    let existingProp = (row.account_id && propsByAccount.get(row.account_id)) || propsByAddress.get(addrKey);

    if (!existingProp) {
      // Brand-new property to create.
      diff.new_properties.push({
        row: row._source_row,
        property: {
          street_address: row.street_address,
          unit: row.unit,
          city: row.city,
          state: row.state,
          zip: row.zip,
          lot_number: row.lot_number,
          vantaca_account_id: row.account_id,
        },
        proposed_owner: row.owner_name ? {
          full_name: row.owner_name,
          primary_email: row.owner_email,
          primary_phone: row.owner_phone,
          mailing_address: row.mailing_address,
          vesting: row.vesting,
        } : null,
      });
      continue;
    }

    // Check for property-level field changes (zip / lot / city / vantaca_account_id).
    const fieldChanges = {};
    if (row.zip && row.zip !== existingProp.zip) fieldChanges.zip = { from: existingProp.zip, to: row.zip };
    if (row.city && row.city !== existingProp.city) fieldChanges.city = { from: existingProp.city, to: row.city };
    if (row.lot_number && row.lot_number !== existingProp.lot_number) fieldChanges.lot_number = { from: existingProp.lot_number, to: row.lot_number };
    if (row.account_id && row.account_id !== existingProp.vantaca_account_id) {
      fieldChanges.vantaca_account_id = { from: existingProp.vantaca_account_id, to: row.account_id };
    }
    if (Object.keys(fieldChanges).length > 0) {
      diff.property_field_changes.push({
        property_id: existingProp.id,
        address: _addressLabel(existingProp),
        changes: fieldChanges,
      });
    }

    // Owner change detection.
    const currentOwners = ownershipsByProp.get(existingProp.id) || [];
    const currentPrimary = currentOwners.find((o) => o.is_primary) || currentOwners[0];
    if (row.owner_name) {
      const incomingName = row.owner_name.toLowerCase().trim();
      const existingName = (currentPrimary && currentPrimary.contacts && currentPrimary.contacts.full_name || '').toLowerCase().trim();
      if (!currentPrimary) {
        diff.new_ownerships.push({
          property_id: existingProp.id,
          address: _addressLabel(existingProp),
          contact_name: row.owner_name,
          contact_email: row.owner_email,
          contact_phone: row.owner_phone,
          vesting: row.vesting,
        });
      } else if (existingName !== incomingName && existingName && incomingName) {
        diff.ownership_changes.push({
          property_id: existingProp.id,
          address: _addressLabel(existingProp),
          prior_owner: currentPrimary.contacts && currentPrimary.contacts.full_name,
          new_owner: row.owner_name,
          new_email: row.owner_email,
          new_phone: row.owner_phone,
        });
      } else if (currentPrimary && currentPrimary.contacts) {
        // Same owner — check for email/phone additions.
        const c = currentPrimary.contacts;
        if (row.owner_email && row.owner_email.toLowerCase() !== (c.primary_email || '').toLowerCase()) {
          diff.email_additions.push({
            contact_id: c.id, name: c.full_name, new_email: row.owner_email, old_email: c.primary_email,
          });
        }
        if (row.owner_phone && row.owner_phone !== c.primary_phone) {
          diff.phone_additions.push({
            contact_id: c.id, name: c.full_name, new_phone: row.owner_phone, old_phone: c.primary_phone,
          });
        }
      }
    }

    // Residency / renter detection — flag if this row indicates a renter
    // we haven't recorded, or if the owner-vs-resident name diverges.
    if (row.residency_type === 'renter' || (row.resident_name && row.resident_name.toLowerCase() !== (row.owner_name || '').toLowerCase())) {
      diff.new_residencies.push({
        property_id: existingProp.id,
        address: _addressLabel(existingProp),
        resident_name: row.resident_name || row.owner_name,
        resident_email: row.resident_email,
        resident_phone: row.resident_phone,
        residency_type: row.residency_type || 'renter',
      });
    }
  }

  return diff;
}

function _addressKey(street, unit) {
  return `${(street || '').toLowerCase().trim()}|${(unit || '').toLowerCase().trim()}`;
}
function _addressLabel(p) {
  return p.unit ? `${p.street_address} #${p.unit}` : p.street_address;
}

module.exports = {
  parseVantacaExport,
  detectColumnMapping,
  computeDiff,
};
