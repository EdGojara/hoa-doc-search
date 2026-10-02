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
