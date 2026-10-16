# RFP / Bid Workflow comparison fixtures

Real proposal sets that Amanda must classify, normalize and recommend on correctly.
Run: `node tests/test_amanda_rfp_comparison.js` (also in `npm test`), or the readable
report: `node scripts/amanda_rfp_dry_run.js`.

Each fixture JSON has:

- `board_email`: the message as received (subject, body, attachment names and sizes)
- `proposals`: one item per proposal, in the shape `lib/vendors/proposal_extract.js`
  produces and `validateProposal()` accepts, transcribed from the real documents
  (a packet with several proposals becomes several items with `document.pages`)
- `db_seed`: a snapshot of the community's books state (accounts, trial balance,
  bank accounts, reconciliations, periods, budget), labelled as a snapshot, never live
- `expected`: classifications, recommended key, costs (cents, `tolerance_cents`),
  not-viable keys, open-item topics, confidence labels

Adding a case: drop a new JSON next to this one with the same keys, then add a loop
over the directory in the test if more than one fixture exists. Never invent a figure:
every number must trace to a page of a real document.
