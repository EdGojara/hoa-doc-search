# Synthetic Vantaca fixture (Issue #15)

Fully synthetic "Example Creek" community in the layout `pdftotext -layout` produces from Vantaca reports. No real names, addresses, account numbers or balances. The repo is public; real client packages are never committed. The real Quail Ridge package is exercised by `tests/onboarding_quail_ridge_local.js` only when it exists on the machine.

The files tie to each other exactly:
- **GL Trial Balance:** 1/1–3/31/2026, debits = credits = 1,385.73.
- **Balance Sheet:** assets 3,945.73 = liabilities 85.00 + equity 3,860.73. Equity is GL 3000 (3,400.00) plus the P&L result (460.73), per the Vantaca display rule.
- **AR aging:** 510.00.
- **Homeowner transaction history:** debit balances 510.00 and credits (85.00).

It deliberately includes the layouts that broke the Quail Ridge package's normalized GL CSV:
- amounts without a leading zero (`.38`, `.35`);
- payment and invoice lines whose description wraps onto a second line;
- descriptions that start with a street number (`101 Example Lane: ...`), which are not ledger ids;
- an account (1300) that continues across a page break, with its header repeated;
- `-` as an explicit zero.

`gl_transactions_defective.csv` reproduces the package parser's defect. It is a normalized CSV missing the interest lines and the wrapped payment lines. The regression test proves it cannot pass source extraction controls: the parsed lines fail to add to the GL's printed per-account totals.

`balance_sheet_funds.txt` is the same fictional community in Vantaca's **fund-column** Balance Sheet layout ("Balance Sheet as of 3/31/2026", columns Operating / Reserve / Adopt a School / Total; the layout Canyon Gate and Lakes of Pine Forest print). Every fund balances on its own (Operating 50,250.25 = 3,750.00 + 46,500.25; Reserve 252,100.50 = 0 + 252,100.50; Adopt a School 3,000.00 = 500.00 + 2,500.00) and the Total column is 305,350.75. It includes a cash account split across two funds with one side negative (1250) and a fund balance split across all three (3050). `tests/test_vantaca_balance_sheet_funds.js` proves it parses with each column kept, and that malformed variants (an amount between columns, a missing Total, two amounts in one column, funds not adding to Total, an amount under the wrong fund, a header with no Total, columns changing between pages) fail instead of being guessed. The real Canyon Gate file is exercised by `tests/onboarding_canyon_gate_bs_local.js` only when it exists on the machine.
