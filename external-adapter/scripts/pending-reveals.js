#!/usr/bin/env node
/**
 * Commits this adapter made that still wait for their reveal (services/commitStore.js `pending`).
 * A reveal request that arrives while the adapter is stopped fails its Chainlink run and is not retried:
 * the slot is a failed reveal for the keeper. Run before a restart or an upgrade, and wait while it
 * lists any: exit 0 when none is pending, 1 when some are. COMMIT_STORE_DIR as for the adapter.
 *   node scripts/pending-reveals.js [--within-minutes 15]   (60 for rounds with an hour's timeout)
 */
require('dotenv').config();
const store = require('../src/services/commitStore');
const i = process.argv.indexOf('--within-minutes');
const minutes = i > 0 ? Number(process.argv[i + 1]) : 15;
store.pending({ withinMs: (Number.isFinite(minutes) && minutes > 0 ? minutes : 15) * 60 * 1000 }).then((list) => {
  if (!list.length) { console.log(`No reveal pending in ${store.dir}.`); process.exit(0); }
  console.log(`${list.length} commit(s) wait for their reveal (${store.dir}):`);
  for (const p of list) console.log(`  ${p.hash}…  round ${p.aggId}  committed ${Math.round(p.ageMs / 1000)} s ago`);
  process.exit(1);
}).catch((e) => { console.error(`Cannot read the commit store: ${e.code || e.message}`); process.exit(2); });
