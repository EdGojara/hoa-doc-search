# CONV-LPF-20260731 dry run

Mode: DRY_RUN_READ_ONLY. Generated 2026-09-24T05:34:24.563Z. Baseline 2026-07-31.
READY: NO (all files present, zero exceptions, every supplied rule PASS)

## Staged rows

| file | rows read | valid rows | mapped rows | rows with exceptions | sha256 |
|---|---:|---:|---:|---:|---|
| ar_debits | 2 | 1 | 0 | 2 | 09f43d2e5fd1 |
| ar_credits | 1 | 0 | 0 | 1 | 4d28e49e4164 |
| ar_former_owners | 1 | 0 | 0 | 1 | f99c201b6c07 |
| ap_open | 1 | 1 | 1 | 0 | 1b2a0fccee28 |
| gl_trial_balance | 3 | 3 | 3 | 0 | f5c6f042cdcc |
| bank_balances | 1 | 1 | 0 | 1 | d9f4b0686b0d |
| outstanding_items | 1 | 1 | 1 | 0 | f03c4360f001 |
| july_gl_activity | 2 | 2 | 2 | 0 | dc48767ba7fa |
| control_totals | 5 | 5 | n/a | 0 | fb2d9d86d4c5 |
| control_rules | 8 | 8 | n/a | 1 | 84b6a42f7a4f |

## Control rules: 5 PASS, 1 FAIL, 1 BLOCKED, 0 PENDING_INPUT, 1 UNKNOWN_NAME


| rule | status | left | right | variance |
|---|---|---:|---:|---:|
| TB_FOOTS | PASS | $100.00 | $100.00 | $0.00 |
| TB_DEBITS_TO_CONTROL | PASS | $100.00 | $100.00 | $0.00 |
| AP_TO_CONTROL | PASS | $60.00 | $60.00 | $0.00 |
| OS_CHECKS | PASS | $10.00 | $10.00 | $0.00 |
| JULY_FOOTS | PASS | $25.00 | $25.00 | $0.00 |
| CASH_TO_CONTROL | FAIL | $100.00 | $99.00 | $1.00 |
| AR_TO_CONTROL | BLOCKED | $250.00 | $300.00 | -$50.00 |
| UNKNOWN_DEMO | UNKNOWN_NAME | PREPAID_TOTAL |  |  |


## Exceptions: 6

- FIELD_INVALID_MONEY              1
- FIELD_MISSING                    1
- FIELD_INVALID_DATE               1
- ACCOUNT_NOT_ON_ANY_PROPERTY      1
- BANK_LAST4_NOT_EXACT             1
- RULE_UNKNOWN_NAME                1

Full list with file / line / field / detail in dryrun.json -> exceptions.list.

## August-forward fingerprint
f2a5ca2ee1edde4c3d209f3a3468ae5dbd16fc4f15924b189ef9416931b7e930 ({"jes":44,"lines":196,"apInv":22,"apPay":14,"checks":9})
