# Synthetic conversion fixture

Fake homeowner accounts, addresses, invoice numbers and bank digits. Real LOPF chart-of-accounts numbers and fund codes, so GL rows map. Rows with bad values are deliberate: they show each exception path. Run:

    node scripts/conversion/lopf_0731_dryrun.js --inputs=tests/fixtures/conversion/synthetic --out=backups/lopf-0731-dryrun-sample
