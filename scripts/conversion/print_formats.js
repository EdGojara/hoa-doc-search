#!/usr/bin/env node
// Generates templates/conversion/IMPORT_FORMATS.md from lib/conversion/formats.js,
// so the published format and the loader can never drift.
//   node scripts/conversion/print_formats.js          (write the file)
//   node scripts/conversion/print_formats.js --check  (exit 1 if the file is stale)
const fs = require('fs');
const path = require('path');
const { FILES } = require('../../lib/conversion/formats');

const OUT = path.resolve(__dirname, '..', '..', 'templates', 'conversion', 'IMPORT_FORMATS.md');
const L = [];
L.push('# Conversion loader: input file formats');
L.push('');
L.push('Generated from `lib/conversion/formats.js` by `scripts/conversion/print_formats.js`. Do not edit by hand.');
L.push('');
L.push('The loader stages normalized files that Ed / ChatGPT prepare. It validates their shape, maps each row to Trusted by exact key, and evaluates the control rules you supply. It makes no accounting judgment and infers no value.');
L.push('');
L.push('## Rules for every file');
L.push('');
L.push('- Put the files in one folder (default `backups/lopf-0731-inputs/`, which git ignores). Use the exact file names below. Each file can be `.csv` (UTF-8, header row, comma separated, standard quoting) or `.xlsx` (header row on the first sheet, cells formatted as text).');
L.push('- A file that is not in the folder is reported as **not supplied**. It is never treated as empty.');
L.push('- Header names must match exactly (case and surrounding spaces are ignored). A missing required column, an unknown column, an unnamed column or a repeated column is an exception, and no row of that file is read.');
L.push('- **Dates**: `YYYY-MM-DD`. **Money**: plain dollars, up to 2 decimals, no `$`, no commas, no parentheses. A negative is a leading `-` (for example `-12.50`).');
L.push('- **Required** column: a blank cell is an exception (`FIELD_MISSING`). **Optional** column: a blank cell stays blank. The loader never fills a blank from another column, never defaults a value and never converts a format.');
L.push('- Blank lines are ignored. Every other line is one row.');
L.push('');
for (const [kind, f] of Object.entries(FILES)) {
  L.push(`## \`${f.filename}\`: ${f.title}`);
  L.push('');
  L.push('| column | required | type | allowed values / notes |');
  L.push('|---|---|---|---|');
  for (const c of f.columns) L.push(`| \`${c.name}\` | ${c.required ? 'yes' : 'no'} | ${c.type} | ${c.values ? c.values.map((v) => `\`${v}\``).join(', ') + '. ' : ''}${c.desc || ''} |`);
  L.push('');
  L.push(`Row rule: ${f.rule}.`);
  L.push('');
  L.push('Header line:');
  L.push('```');
  L.push(f.columns.map((c) => c.name).join(','));
  L.push('```');
  L.push('');
}
L.push('## How rows map to Trusted (exact keys only)');
L.push('');
L.push('Keys are compared after trimming, ignoring case and collapsing repeated spaces. Nothing looser than that is used: no abbreviations, no fuzzy matching and no guessing from names. A row whose key matches zero records, or more than one, becomes an exception.');
L.push('');
L.push('| file | key | Trusted record |');
L.push('|---|---|---|');
L.push('| ar_debits, ar_credits | `vantaca_account_id` | the one property whose `vantaca_account_id` equals it. If `property_address` is supplied, it must equal that property\'s street address. |');
L.push('| ar_former_owners | `trusted_property_id` | the property with that id in this community. `property_address`, if supplied, is validation only: it must equal the street address of that property. The loader does not decide which ownership a former balance belongs to. |');
L.push('| ap_open | `trusted_vendor_id`, `gl_account`, `fund` (if supplied) | the vendor with that id (`vendor_name` is display only), the chart-of-accounts number, the fund code |');
L.push('| gl_trial_balance, july_gl_activity | `account_number`, `fund` | the chart-of-accounts number, the fund code |');
L.push('| bank_balances, outstanding_items | `gl_account_number` (+ `bank_account_last4`) | the one active bank account with that GL account number (its last 4 must equal the supplied value) |');
L.push('');
L.push('Each file also has a natural key that must be unique within the file (`DUPLICATE_ROW_KEY` otherwise). A repeated row is reported, never merged:');
L.push('');
L.push('- AR files: account + category + effective_date + source_row');
L.push('- ap_open: trusted_vendor_id + invoice number (or, when the source has no invoice number, trusted_vendor_id + source_row)');
L.push('- gl_trial_balance: account + fund');
L.push('- bank_balances: GL account');
L.push('- outstanding_items: every column');
L.push('- july_gl_activity: `line_id` (only if supplied)');
L.push('- control_totals: `control_code`');
L.push('- control_rules: `rule_code`');
L.push('');
L.push('## Control totals and control rules (supplied by you)');
L.push('');
L.push('The loader has **no built-in comparisons**. Every check comes from `control_rules.csv`. Each rule states that `left` must equal `right`, where each side is one or more names joined by `+` and `-`. A name is either a `control_code` from `control_totals.csv` or one of the measures below. Measures are computed only from the supplied files, never from Trusted data, and only from rows without exceptions.');
L.push('');
L.push('| measure | meaning |');
L.push('|---|---|');
L.push('| `ROWS_<file>` | number of data rows |');
L.push('| `ROWS_<file>@<column>=<value>` | rows where that column equals the value exactly |');
L.push('| `SUM_<file>_<money column>` | sum of that column |');
L.push('| `SUM_<file>_<money column>@<column>=<value>` | sum over rows where the other column equals the value |');
L.push('| `DISTINCT_<file>_<column>` | number of distinct non-blank values |');
L.push('');
L.push('Examples: `SUM_ar_debits_amount`, `SUM_gl_trial_balance_ending_debit@account_number=1300`, `ROWS_outstanding_items@item_type=check`. Counts are compared as whole numbers, so a control of `579` equals 579 rows.');
L.push('');
L.push('Rule results:');
L.push('');
L.push('- **PASS**: both sides are equal, and no file the rule reads has any exception.');
L.push('- **FAIL**: the sides differ; the variance is shown.');
L.push('- **BLOCKED**: values were computed, but a file the rule reads has row exceptions, so the result cannot be trusted.');
L.push('- **PENDING_INPUT**: a file the rule reads has not been supplied.');
L.push('- **UNKNOWN_NAME**: the rule names something that is neither a supplied control code nor a valid measure (a control missing from control_totals.csv lands here: the loader cannot tell not-yet-supplied from misspelled). This is also recorded as an exception.');
L.push('');
L.push('Example `control_rules.csv`:');
L.push('```');
L.push('rule_code,left,right,note');
L.push('TB_FOOTS,SUM_gl_trial_balance_ending_debit,SUM_gl_trial_balance_ending_credit,trial balance debits equal credits');
L.push('AR_DEBITS_TO_CONTROL,SUM_ar_debits_amount,AR_DEBIT_TOTAL,debit file equals the aging debit total');
L.push('```');
L.push('');
L.push('## Exception codes');
L.push('');
L.push('| code | meaning |');
L.push('|---|---|');
for (const [c, m] of [
  ['FILE_EMPTY', 'the file has no header row'], ['FILE_NO_ROWS', 'the file has a header but no data rows'],
  ['COLUMN_MISSING', 'a required column is not in the header'], ['COLUMN_UNKNOWN', 'the header has a column that is not in the format'],
  ['COLUMN_UNNAMED', 'a header cell is blank'], ['COLUMN_DUPLICATED', 'a column name appears twice'],
  ['FIELD_MISSING', 'a required cell is blank'], ['FIELD_INVALID_MONEY', 'the value is not plain dollars'],
  ['FIELD_INVALID_DATE', 'the value is not YYYY-MM-DD'], ['FIELD_NOT_ALLOWED', 'the value is not in the allowed list'],
  ['ROW_RULE', 'the row breaks the file\'s row rule'], ['DUPLICATE_ROW_KEY', 'two rows share the file\'s natural key'],
  ['ACCOUNT_NOT_ON_ANY_PROPERTY / ACCOUNT_ON_MULTIPLE_PROPERTIES', 'the vantaca_account_id matches zero properties, or more than one'],
  ['ADDRESS_NOT_EXACT', 'the supplied address differs from the matched property\'s address'],
  ['PROPERTY_ID_NOT_FOUND', 'the trusted_property_id is not a property of this community'],
  ['VENDOR_ID_NOT_FOUND', 'the trusted_vendor_id is not a Trusted vendor'],
  ['GL_ACCOUNT_NOT_FOUND', 'the account number is not in the Trusted chart of accounts'], ['FUND_NOT_FOUND', 'the fund code is not a Trusted fund'],
  ['BANK_ACCOUNT_NOT_FOUND / BANK_ACCOUNT_AMBIGUOUS', 'the GL account number matches zero active bank accounts, or more than one'],
  ['BANK_LAST4_NOT_EXACT', 'the supplied last 4 differs from the bank account\'s last 4'], ['RULE_UNKNOWN_NAME', 'a control rule names an unknown control or measure'],
]) L.push(`| \`${c}\` | ${m} |`);
L.push('');
L.push('## Running it');
L.push('');
L.push('```');
L.push('node scripts/conversion/lopf_0731_dryrun.js --inputs=backups/lopf-0731-inputs');
L.push('```');
L.push('');
L.push('Every staged row carries a conversion source key: `<batch>:<source file sha256>:<source_row, or the file line when source_row is blank>`. It is the stable audit identity of the row, unique within the batch.');
L.push('');
L.push('The run is read-only. It writes `backups/lopf-0731-dryrun/dryrun.md`, a summary with staged row counts per file, rule PASS/FAIL and exceptions by code, and `dryrun.json`, which adds every exception with file, line, field and detail. `--stage` additionally records the run in the staging tables once migration 452 is applied. The run never posts to the GL or to any live table. The batch is **READY** only when every file is supplied, there are zero exceptions and every supplied rule is PASS.');
const text = L.join('\n') + '\n';
if (process.argv.includes('--check')) {
  const cur = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
  if (cur !== text) { console.error('templates/conversion/IMPORT_FORMATS.md is stale: run node scripts/conversion/print_formats.js'); process.exit(1); }
  console.log('IMPORT_FORMATS.md is current');
} else {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, text);
  console.log('wrote ' + path.relative(process.cwd(), OUT));
}
