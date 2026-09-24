# Conversion loader: input file formats

Generated from `lib/conversion/formats.js` by `scripts/conversion/print_formats.js`. Do not edit by hand.

The loader stages normalized files that Ed / ChatGPT prepare. It validates their shape, maps each row to Trusted by exact key, and evaluates the control rules you supply. It makes no accounting judgment and infers no value.

## Rules for every file

- Put the files in one folder (default `backups/lopf-0731-inputs/`, which git ignores). Use the exact file names below. Each file can be `.csv` (UTF-8, header row, comma separated, standard quoting) or `.xlsx` (header row on the first sheet, cells formatted as text).
- A file that is not in the folder is reported as **not supplied**. It is never treated as empty.
- Header names must match exactly (case and surrounding spaces are ignored). A missing required column, an unknown column, an unnamed column or a repeated column is an exception, and no row of that file is read.
- **Dates**: `YYYY-MM-DD`. **Money**: plain dollars, up to 2 decimals, no `$`, no commas, no parentheses. A negative is a leading `-` (for example `-12.50`).
- **Required** column: a blank cell is an exception (`FIELD_MISSING`). **Optional** column: a blank cell stays blank. The loader never fills a blank from another column, never defaults a value and never converts a format.
- Blank lines are ignored. Every other line is one row.

## `ar_debits.csv`: Homeowner debit / open balances

| column | required | type | allowed values / notes |
|---|---|---|---|
| `vantaca_account_id` | yes | text | Vantaca account number exactly as in the source report. |
| `vantaca_homeowner_id` | no | text | Vantaca Homeowner ID, if the source report carries it. |
| `owner_name` | yes | text | Owner name exactly as on the Vantaca account. |
| `property_address` | no | text | Physical lot address as supplied. ar_former_owners rows need it to map (see mapping rules). |
| `tenure_status` | yes | enum | `current`, `former`. Supplied by the preparer: current or former. |
| `charge_category` | yes | enum | `assessment`, `late_fee`, `interest`, `attorney_fee_assessment_related`, `records_request_fee`, `attorney_fee_other`, `fine`, `transfer_fee`, `resale_certificate_fee`, `nsf_fee`, `certified_letter`, `other`. Supplied by the preparer. |
| `effective_date` | yes | date | Date supplied by the preparer for this item. |
| `due_date` | no | date | Due date if supplied. Never derived from effective_date. |
| `amount` | yes | money | Amount as supplied; see the file rule for the permitted sign. |
| `aging_bucket` | no | enum | `current`, `1_30`, `31_60`, `61_90`, `91_120`, `over_120`. Aging bucket if supplied. |
| `description` | no | text | Free text. |
| `source_report` | yes | text | Source report name and run date this row came from. |
| `source_row` | no | text | Row / line identifier in the source report, for audit trace. |

Row rule: amount > 0.

Header line:
```
vantaca_account_id,vantaca_homeowner_id,owner_name,property_address,tenure_status,charge_category,effective_date,due_date,amount,aging_bucket,description,source_report,source_row
```

## `ar_credits.csv`: Homeowner prepaid / credit balances

| column | required | type | allowed values / notes |
|---|---|---|---|
| `vantaca_account_id` | yes | text | Vantaca account number exactly as in the source report. |
| `vantaca_homeowner_id` | no | text | Vantaca Homeowner ID, if the source report carries it. |
| `owner_name` | yes | text | Owner name exactly as on the Vantaca account. |
| `property_address` | no | text | Physical lot address as supplied. ar_former_owners rows need it to map (see mapping rules). |
| `tenure_status` | yes | enum | `current`, `former`. Supplied by the preparer: current or former. |
| `charge_category` | yes | enum | `assessment`, `late_fee`, `interest`, `attorney_fee_assessment_related`, `records_request_fee`, `attorney_fee_other`, `fine`, `transfer_fee`, `resale_certificate_fee`, `nsf_fee`, `certified_letter`, `other`. Supplied by the preparer. |
| `effective_date` | yes | date | Date supplied by the preparer for this item. |
| `due_date` | no | date | Due date if supplied. Never derived from effective_date. |
| `amount` | yes | money | Amount as supplied; see the file rule for the permitted sign. |
| `aging_bucket` | no | enum | `current`, `1_30`, `31_60`, `61_90`, `91_120`, `over_120`. Aging bucket if supplied. |
| `description` | no | text | Free text. |
| `source_report` | yes | text | Source report name and run date this row came from. |
| `source_row` | no | text | Row / line identifier in the source report, for audit trace. |

Row rule: amount > 0 (supplied as a positive magnitude).

Header line:
```
vantaca_account_id,vantaca_homeowner_id,owner_name,property_address,tenure_status,charge_category,effective_date,due_date,amount,aging_bucket,description,source_report,source_row
```

## `ar_former_owners.csv`: Former-owner balances

| column | required | type | allowed values / notes |
|---|---|---|---|
| `vantaca_account_id` | yes | text | Vantaca account number exactly as in the source report. |
| `vantaca_homeowner_id` | no | text | Vantaca Homeowner ID, if the source report carries it. |
| `owner_name` | yes | text | Owner name exactly as on the Vantaca account. |
| `property_address` | no | text | Physical lot address as supplied. ar_former_owners rows need it to map (see mapping rules). |
| `tenure_status` | yes | enum | `current`, `former`. Supplied by the preparer: current or former. |
| `charge_category` | yes | enum | `assessment`, `late_fee`, `interest`, `attorney_fee_assessment_related`, `records_request_fee`, `attorney_fee_other`, `fine`, `transfer_fee`, `resale_certificate_fee`, `nsf_fee`, `certified_letter`, `other`. Supplied by the preparer. |
| `effective_date` | yes | date | Date supplied by the preparer for this item. |
| `due_date` | no | date | Due date if supplied. Never derived from effective_date. |
| `amount` | yes | money | Amount as supplied; see the file rule for the permitted sign. |
| `aging_bucket` | no | enum | `current`, `1_30`, `31_60`, `61_90`, `91_120`, `over_120`. Aging bucket if supplied. |
| `description` | no | text | Free text. |
| `source_report` | yes | text | Source report name and run date this row came from. |
| `source_row` | no | text | Row / line identifier in the source report, for audit trace. |

Row rule: tenure_status = former; amount non-zero (sign as supplied).

Header line:
```
vantaca_account_id,vantaca_homeowner_id,owner_name,property_address,tenure_status,charge_category,effective_date,due_date,amount,aging_bucket,description,source_report,source_row
```

## `ap_open.csv`: Open AP

| column | required | type | allowed values / notes |
|---|---|---|---|
| `vendor_name` | yes | text | Vendor name; must equal a Trusted vendor name exactly. |
| `vantaca_vendor_id` | no | text | Vantaca vendor id if supplied. |
| `invoice_number` | yes | text | Invoice number as supplied. |
| `invoice_date` | yes | date | Invoice date. |
| `due_date` | no | date | Due date if supplied. |
| `gl_account` | yes | text | Account number; must equal a Trusted chart-of-accounts number exactly. |
| `fund` | no | text | Fund code; if supplied must equal a Trusted fund code exactly. |
| `original_amount` | yes | money | Original invoice amount. |
| `amount_open` | yes | money | Open amount. |
| `description` | no | text | Free text. |
| `source_report` | yes | text | Source report name and run date. |
| `source_row` | no | text | Row / line identifier in the source report. |

Row rule: amount_open > 0 and amount_open <= original_amount.

Header line:
```
vendor_name,vantaca_vendor_id,invoice_number,invoice_date,due_date,gl_account,fund,original_amount,amount_open,description,source_report,source_row
```

## `gl_trial_balance.csv`: GL trial balance (ending balances)

| column | required | type | allowed values / notes |
|---|---|---|---|
| `account_number` | yes | text | Must equal a Trusted chart-of-accounts number exactly. |
| `account_name` | yes | text | As in the source report (informational). |
| `fund` | yes | text | Must equal a Trusted fund code exactly. |
| `ending_debit` | yes | money | Ending debit amount as supplied (0 if none). |
| `ending_credit` | yes | money | Ending credit amount as supplied (0 if none). |
| `source_report` | yes | text | Source report name and run date. |

Row rule: ending_debit >= 0 and ending_credit >= 0.

Header line:
```
account_number,account_name,fund,ending_debit,ending_credit,source_report
```

## `bank_balances.csv`: Bank balances and bank reconciliation summary

| column | required | type | allowed values / notes |
|---|---|---|---|
| `gl_account_number` | yes | text | Must equal the gl_account_number of exactly one active Trusted bank account. |
| `bank_account_last4` | yes | text | Must equal that bank account's last 4. |
| `statement_date` | yes | date | Statement closing date. |
| `statement_ending_balance` | yes | money | As supplied. |
| `outstanding_checks_total` | yes | money | As supplied. |
| `deposits_in_transit_total` | yes | money | As supplied. |
| `other_reconciling_total` | yes | money | As supplied (0 if none). |
| `reconciled_book_balance` | yes | money | As supplied. Not recomputed by the loader. |
| `source_report` | yes | text | Source report name and run date. |

Row rule: none beyond types.

Header line:
```
gl_account_number,bank_account_last4,statement_date,statement_ending_balance,outstanding_checks_total,deposits_in_transit_total,other_reconciling_total,reconciled_book_balance,source_report
```

## `outstanding_items.csv`: Outstanding checks, deposits in transit, other reconciling items

| column | required | type | allowed values / notes |
|---|---|---|---|
| `gl_account_number` | yes | text | Must equal the gl_account_number of exactly one active Trusted bank account. |
| `item_type` | yes | enum | `check`, `deposit_in_transit`, `other`. Supplied by the preparer. |
| `check_number` | no | text | Required when item_type = check. |
| `item_date` | yes | date | Item date. |
| `payee` | no | text | Payee / payor. |
| `amount` | yes | money | As supplied. |
| `cleared_date` | no | date | Date it cleared, if supplied. |
| `source_report` | yes | text | Source report name and run date. |

Row rule: check_number required when item_type = check.

Header line:
```
gl_account_number,item_type,check_number,item_date,payee,amount,cleared_date,source_report
```

## `july_gl_activity.csv`: GL activity for the conversion month (every posted line)

| column | required | type | allowed values / notes |
|---|---|---|---|
| `posting_date` | yes | date | Posting date. |
| `account_number` | yes | text | Must equal a Trusted chart-of-accounts number exactly. |
| `fund` | no | text | If supplied, must equal a Trusted fund code exactly. |
| `debit` | yes | money | Debit amount as supplied (0 if none). |
| `credit` | yes | money | Credit amount as supplied (0 if none). |
| `description` | yes | text | Line description as exported. |
| `reference` | no | text | Invoice / check / receipt reference if exported separately. |
| `vendor_name` | no | text | Vendor if exported separately. |
| `homeowner_account` | no | text | Homeowner account if exported separately. |
| `journal_type` | no | text | Source transaction type if exported. |
| `line_id` | no | text | Source ledger line id; if supplied must be unique in the file. |
| `source_report` | yes | text | Source report name and run date. |

Row rule: debit >= 0 and credit >= 0.

Header line:
```
posting_date,account_number,fund,debit,credit,description,reference,vendor_name,homeowner_account,journal_type,line_id,source_report
```

## `control_totals.csv`: Control totals (supplied externally)

| column | required | type | allowed values / notes |
|---|---|---|---|
| `control_code` | yes | text | Any code the preparer chooses (letters, digits, _). Referenced by control_rules.csv. Must be unique. |
| `amount` | yes | money | Value as supplied. Counts are supplied the same way (579 = 579). |
| `as_of` | yes | date | As-of date of the control. |
| `source_report` | yes | text | Report the control was taken from. |
| `note` | no | text | Free text. |

Row rule: control_code matches ^[A-Za-z0-9_]+$.

Header line:
```
control_code,amount,as_of,source_report,note
```

## `control_rules.csv`: Control rules (supplied externally): each rule says left must equal right

| column | required | type | allowed values / notes |
|---|---|---|---|
| `rule_code` | yes | text | Unique rule name. |
| `left` | yes | text | Expression: control codes and/or loader measures joined by + and - (see Measures). |
| `right` | yes | text | Expression, same syntax. |
| `note` | no | text | What the rule proves, in words. |

Row rule: left/right contain only names, +, -.

Header line:
```
rule_code,left,right,note
```

## How rows map to Trusted (exact keys only)

Keys are compared after trimming, ignoring case and collapsing repeated spaces. Nothing looser than that is used: no abbreviations, no fuzzy matching and no guessing from names. A row whose key matches zero records, or more than one, becomes an exception.

| file | key | Trusted record |
|---|---|---|
| ar_debits, ar_credits | `vantaca_account_id` | the one property whose `vantaca_account_id` equals it. If `property_address` is supplied, it must equal that property's street address. |
| ar_former_owners | `property_address` | the one property whose street address equals it. The loader does not decide which ownership a former balance belongs to. |
| ap_open | `vendor_name`, `gl_account`, `fund` (if supplied) | the one vendor with that exact name, the chart-of-accounts number, the fund code |
| gl_trial_balance, july_gl_activity | `account_number`, `fund` | the chart-of-accounts number, the fund code |
| bank_balances, outstanding_items | `gl_account_number` (+ `bank_account_last4`) | the one active bank account with that GL account number (its last 4 must equal the supplied value) |

Each file also has a natural key that must be unique within the file (`DUPLICATE_ROW_KEY` otherwise). A repeated row is reported, never merged:

- AR files: account + category + effective_date + source_row
- ap_open: vendor + invoice number
- gl_trial_balance: account + fund
- bank_balances: GL account
- outstanding_items: every column
- july_gl_activity: `line_id` (only if supplied)
- control_totals: `control_code`
- control_rules: `rule_code`

## Control totals and control rules (supplied by you)

The loader has **no built-in comparisons**. Every check comes from `control_rules.csv`. Each rule states that `left` must equal `right`, where each side is one or more names joined by `+` and `-`. A name is either a `control_code` from `control_totals.csv` or one of the measures below. Measures are computed only from the supplied files, never from Trusted data, and only from rows without exceptions.

| measure | meaning |
|---|---|
| `ROWS_<file>` | number of data rows |
| `ROWS_<file>@<column>=<value>` | rows where that column equals the value exactly |
| `SUM_<file>_<money column>` | sum of that column |
| `SUM_<file>_<money column>@<column>=<value>` | sum over rows where the other column equals the value |
| `DISTINCT_<file>_<column>` | number of distinct non-blank values |

Examples: `SUM_ar_debits_amount`, `SUM_gl_trial_balance_ending_debit@account_number=1300`, `ROWS_outstanding_items@item_type=check`. Counts are compared as whole numbers, so a control of `579` equals 579 rows.

Rule results:

- **PASS**: both sides are equal, and no file the rule reads has any exception.
- **FAIL**: the sides differ; the variance is shown.
- **BLOCKED**: values were computed, but a file the rule reads has row exceptions, so the result cannot be trusted.
- **PENDING_INPUT**: a referenced file or control total has not been supplied.
- **UNKNOWN_NAME**: the rule names something that is neither a control code nor a valid measure. This is also recorded as an exception.

Example `control_rules.csv`:
```
rule_code,left,right,note
TB_FOOTS,SUM_gl_trial_balance_ending_debit,SUM_gl_trial_balance_ending_credit,trial balance debits equal credits
AR_DEBITS_TO_CONTROL,SUM_ar_debits_amount,AR_DEBIT_TOTAL,debit file equals the aging debit total
```

## Exception codes

| code | meaning |
|---|---|
| `FILE_EMPTY` | the file has no header row |
| `FILE_NO_ROWS` | the file has a header but no data rows |
| `COLUMN_MISSING` | a required column is not in the header |
| `COLUMN_UNKNOWN` | the header has a column that is not in the format |
| `COLUMN_UNNAMED` | a header cell is blank |
| `COLUMN_DUPLICATED` | a column name appears twice |
| `FIELD_MISSING` | a required cell is blank |
| `FIELD_INVALID_MONEY` | the value is not plain dollars |
| `FIELD_INVALID_DATE` | the value is not YYYY-MM-DD |
| `FIELD_NOT_ALLOWED` | the value is not in the allowed list |
| `ROW_RULE` | the row breaks the file's row rule |
| `DUPLICATE_ROW_KEY` | two rows share the file's natural key |
| `ACCOUNT_NOT_ON_ANY_PROPERTY / ACCOUNT_ON_MULTIPLE_PROPERTIES` | the vantaca_account_id matches zero properties, or more than one |
| `ADDRESS_NOT_EXACT` | the supplied address differs from the matched property's address |
| `FORMER_NO_ADDRESS` | a former-owner row has no property_address |
| `ADDRESS_NOT_ON_ANY_PROPERTY / ADDRESS_ON_MULTIPLE_PROPERTIES` | the former-owner address matches zero properties, or more than one |
| `VENDOR_NOT_FOUND / VENDOR_NAME_AMBIGUOUS` | the vendor name matches zero Trusted vendors, or more than one |
| `GL_ACCOUNT_NOT_FOUND` | the account number is not in the Trusted chart of accounts |
| `FUND_NOT_FOUND` | the fund code is not a Trusted fund |
| `BANK_ACCOUNT_NOT_FOUND / BANK_ACCOUNT_AMBIGUOUS` | the GL account number matches zero active bank accounts, or more than one |
| `BANK_LAST4_NOT_EXACT` | the supplied last 4 differs from the bank account's last 4 |
| `RULE_UNKNOWN_NAME` | a control rule names an unknown control or measure |

## Running it

```
node scripts/conversion/lopf_0731_dryrun.js --inputs=backups/lopf-0731-inputs
```

The run is read-only. It writes `backups/lopf-0731-dryrun/dryrun.md`, a summary with staged row counts per file, rule PASS/FAIL and exceptions by code, and `dryrun.json`, which adds every exception with file, line, field and detail. `--stage` additionally records the run in the staging tables once migration 452 is applied. The run never posts to the GL or to any live table. The batch is **READY** only when every file is supplied, there are zero exceptions and every supplied rule is PASS.
