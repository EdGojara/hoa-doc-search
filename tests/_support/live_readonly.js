// tests/_support/live_readonly.js — for the few HYBRID tests that fake a client
// for the code under test AND read real data on purpose. Same guard as
// no_prod_network.js, but defaulting to readonly: GET/HEAD to the Supabase host,
// never a write, never another host. The runner's setting wins when present, so
// a hybrid that is not in LIVE_READ_CHECKS still runs loopback-only under npm test.
if (process.env.TEST_NO_PROD === undefined) process.env.TEST_NO_PROD = 'readonly';
require('./no_prod_network');
