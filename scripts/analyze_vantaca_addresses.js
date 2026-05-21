#!/usr/bin/env node
// =============================================================================
// analyze_vantaca_addresses.js
// -----------------------------------------------------------------------------
// One-off analyzer that reads Vantaca's "All Addresses (Current Resident)
// Export" Excel files and figures out the CORRECT property + mailing address
// per Vantaca Account.
//
// Why this exists:
//   The Vantaca import currently writes the OWNER'S MAILING address into
//   properties.street_address. That's wrong for investor-owned properties
//   where the owner's mailing isn't at the property. This script uses the
//   "(Current Resident)" version of the report — which Vantaca generates
//   with an extra row per non-owner-occupied property whose HomeownerName
//   is literally "Current Resident" and address is the PROPERTY address.
//
// Heuristic per Vantaca Account:
//   - If the account has a "Current Resident" row → that row's address is
//     the PROPERTY. The named-owner rows give the OWNER'S MAILING.
//   - If the account has no "Current Resident" row → assume owner-occupied.
//     The single named-owner row's address is both property and mailing.
//
// Output:
//   - JSON map (one line per account) to stdout for piping/storage
//   - Summary stats to stderr
//
// Usage:
//   node scripts/analyze_vantaca_addresses.js <xlsx-path> [<xlsx-path> ...]
//
// Example:
//   node scripts/analyze_vantaca_addresses.js \
//     "../Downloads/All Addresses (Current Resident) Export (10).xlsx" \
//     "../Downloads/All Addresses (Current Resident) Export (9).xlsx" \
//     > vantaca-account-properties.jsonl
// =============================================================================

const fs = require('fs');
const path = require('path');
const xlsx = require('xlsx');

function buildAddress(row) {
  const parts = [
    String(row.MailStreetNo || '').trim(),
    String(row.MailAddress1 || '').trim(),
  ].filter(Boolean);
  const street = parts.join(' ').trim();
  return {
    street,
    unit: String(row['Unit No'] || '').trim() || null,
    city: String(row.MailCity || '').trim(),
    state: String(row.MailState || '').trim(),
    zip: String(row.MailZip || '').trim(),
    addr2: String(row.MailAddress2 || '').trim() || null,
  };
}

function isCurrentResidentRow(row) {
  return String(row.HomeownerName || '').trim().toLowerCase() === 'current resident';
}

function analyzeAccount(rows) {
  const crRows = rows.filter(isCurrentResidentRow);
  const ownerRows = rows.filter((r) => !isCurrentResidentRow(r));

  let property = null;
  let mailing = null;
  let owners = [];
  let residencyType = 'unknown';
  let confidence = 'high';
  let notes = null;

  if (crRows.length > 0 && ownerRows.length > 0) {
    // Investor / non-occupied — CR row is property, owner row is mailing
    property = buildAddress(crRows[0]);
    mailing = buildAddress(ownerRows[0]);
    owners = ownerRows.map((r) => ({
      homeowner_id: r['Homeowner ID'],
      full_name: r.HomeownerName,
      first_name: r.FirstName,
      last_name: r.LastName,
      spouse_first_name: r.SpouseFirstName,
      spouse_last_name: r.SpouseLastName,
      business_name: r.BusinessName,
      deed_name: r.DeedName,
      mailing_name_override: r.MailingNameOverride,
    }));
    residencyType = (property.zip !== mailing.zip) ? 'renter' : 'unknown_off_site';
    if (crRows.length > 1) notes = 'multiple_CR_rows';
  } else if (crRows.length > 0 && ownerRows.length === 0) {
    // Only CR rows — property only, no owner info
    property = buildAddress(crRows[0]);
    mailing = property;  // mailing unknown; defaulting to property
    residencyType = 'renter';
    confidence = 'medium';
    notes = 'no_owner_row_only_CR';
  } else if (crRows.length === 0 && ownerRows.length > 0) {
    // Owner-occupied (most common case) — single row, address is both
    property = buildAddress(ownerRows[0]);
    mailing = property;
    owners = ownerRows.map((r) => ({
      homeowner_id: r['Homeowner ID'],
      full_name: r.HomeownerName,
      first_name: r.FirstName,
      last_name: r.LastName,
      spouse_first_name: r.SpouseFirstName,
      spouse_last_name: r.SpouseLastName,
      business_name: r.BusinessName,
      deed_name: r.DeedName,
      mailing_name_override: r.MailingNameOverride,
    }));
    if (ownerRows.length > 1) {
      // Multiple owner rows but no CR — joint owners OR multiple-mailing same property
      const uniqAddrs = new Set(ownerRows.map((r) => `${r.MailStreetNo} ${r.MailAddress1}|${r.MailZip}`));
      if (uniqAddrs.size > 1) {
        confidence = 'low';
        notes = 'multiple_owner_rows_with_different_addresses';
        // Best-guess: first row is property, others are alternate mailing
      }
    }
    residencyType = 'owner_occupied';
  } else {
    // No rows at all — shouldn't happen
    confidence = 'none';
    notes = 'empty_account';
  }

  return { property, mailing, owners, residencyType, confidence, notes,
           cr_row_count: crRows.length, owner_row_count: ownerRows.length };
}

function summarize(allAccounts) {
  const stats = {
    total_accounts: allAccounts.length,
    by_residency: {},
    by_confidence: {},
    needs_review: 0,
    out_of_state_owners: 0,
  };
  for (const a of allAccounts) {
    stats.by_residency[a.residencyType] = (stats.by_residency[a.residencyType] || 0) + 1;
    stats.by_confidence[a.confidence] = (stats.by_confidence[a.confidence] || 0) + 1;
    if (a.confidence === 'low' || a.confidence === 'none') stats.needs_review++;
    if (a.mailing && a.mailing.state && a.mailing.state !== 'TX') stats.out_of_state_owners++;
  }
  return stats;
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('Usage: node analyze_vantaca_addresses.js <xlsx-path> [<xlsx-path> ...]');
    process.exit(1);
  }

  const allAccounts = [];

  for (const filePath of args) {
    console.error(`\n=== ${path.basename(filePath)} ===`);
    const wb = xlsx.readFile(filePath);
    const rows = xlsx.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' });

    // Group by Account
    const byAccount = {};
    for (const r of rows) {
      const k = String(r.Account);
      if (!byAccount[k]) byAccount[k] = [];
      byAccount[k].push(r);
    }

    const assocCodes = Array.from(new Set(rows.map((r) => r['Assoc Code'])));
    console.error(`  Assoc Codes: ${assocCodes.join(', ')}`);
    console.error(`  Total rows: ${rows.length}`);
    console.error(`  Distinct accounts: ${Object.keys(byAccount).length}`);

    for (const [account, accountRows] of Object.entries(byAccount)) {
      const analysis = analyzeAccount(accountRows);
      const enriched = {
        assoc_code: accountRows[0]['Assoc Code'],
        account,
        ...analysis,
      };
      allAccounts.push(enriched);
      console.log(JSON.stringify(enriched));
    }
  }

  console.error('\n=== SUMMARY ACROSS ALL FILES ===');
  const stats = summarize(allAccounts);
  console.error(JSON.stringify(stats, null, 2));
}

if (require.main === module) main();

module.exports = { analyzeAccount, buildAddress, summarize };
