# Legal invoice fixtures (Issue #9 step 2b)

These are SYNTHETIC replicas of the three attorney-invoice layouts we receive:
RMWBH, Daughtry & Farine, and Winstead. Every name, address and number is
invented. The real invoices hold homeowner data and never go in this public
repo.

Each `*.json` has these keys:
- `invoice` / `ap_lines`: the payable as the AP intake stored it. The line text
  often names no owner or address.
- `raw`: what the invoice reader (`lib/legal/pdf_extract.js`) returns for the
  PDF, meaning the model's JSON.
- `expect`: what `lib/legal/pdf_matters.js` must conclude:
  - status and number of matters;
  - the AP line → matter map, by line number;
  - the service basis per matter;
  - work types;
  - referenced-date counts.

`tests/test_legal_pdf_matters.js` runs every file here, and it is wired to
`npm test`. To add a new layout, drop a JSON with the same keys in this folder
and re-run. No test code changes.
