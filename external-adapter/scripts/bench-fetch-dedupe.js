#!/usr/bin/env node
/**
 * Reproduce a dispatcher fan-out against real IPFS gateways and measure it:
 * N "jobs" of this operator each fetch the same archive CIDs concurrently,
 * exactly as fetchAndTriageArchives does, with or without the per-CID fetch
 * cache (#69). Reports per-job wall time and the number of gateway downloads.
 *
 * Usage:
 *   node scripts/bench-fetch-dedupe.js [--jobs 3] [--cids Qm…,Qm…] [--no-cache] [--rounds 1]
 *
 * Defaults reproduce the mainnet request from #69 (agg 0xdd76…14ce, 3 jobs,
 * 2 CIDs). Uses the same @verdikta/common client configuration as the adapter
 * (IPFS_GATEWAY / IPFS_GATEWAY_TOKEN honoured). Each run downloads from public
 * gateways: do not loop it.
 */

require('dotenv').config();
const { createClient } = require('@verdikta/common');
const { buildIpfsGatewayConfig } = require('../src/utils/ipfsGatewayConfig');
const { installCidFetchCache, cidFetchCacheOptionsFromEnv, runWithRequestContext } = require('../src/services/cidFetchCache');

const DEFAULT_CIDS = [
  'QmTFXHUBXsQZwPSTUTqhLTfhxZEDDK2JVA6YjirCYsxEdx',
  'QmYKuRqTv3ACc9bFSLAM1chLzBosim36W1wCC5jFk715PP'
];

function parseArgs(argv) {
  const opts = { jobs: 3, cids: DEFAULT_CIDS, cache: true, rounds: 1 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--jobs') opts.jobs = parseInt(argv[++i], 10);
    else if (a === '--cids') opts.cids = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--no-cache') opts.cache = false;
    else if (a === '--rounds') opts.rounds = parseInt(argv[++i], 10);
    else throw new Error(`Unknown argument: ${a}`);
  }
  return opts;
}

(async () => {
  const opts = parseArgs(process.argv);
  const verdikta = createClient({
    ipfs: { timeout: 30000, ...buildIpfsGatewayConfig(process.env).ipfs },
    logging: { level: 'warn', console: true, file: false, colors: false }
  });
  const { ipfsClient, archiveService } = verdikta;

  // Count real gateway downloads underneath whatever wrapping follows.
  let downloads = 0;
  const raw = ipfsClient.fetchFromIPFS.bind(ipfsClient);
  ipfsClient.fetchFromIPFS = (cid) => { downloads++; return raw(cid); };
  const cache = opts.cache ? installCidFetchCache(ipfsClient, cidFetchCacheOptionsFromEnv(process.env)) : null;

  console.log(`mode=${opts.cache ? 'cache' : 'no-cache'} jobs=${opts.jobs} cids=${opts.cids.length} gateways=${JSON.stringify(ipfsClient.gateways)}`);
  for (let round = 1; round <= opts.rounds; round++) {
    downloads = 0;
    const t0 = Date.now();
    const perJob = await Promise.all(Array.from({ length: opts.jobs }, (_, j) => {
      const runTag = `[bench job-${j + 1}]`;
      return runWithRequestContext({ runTag }, async () => {
        const start = Date.now();
        const outcomes = await Promise.allSettled(opts.cids.map((cid) => archiveService.getArchive(cid)));
        const failed = outcomes.filter((o) => o.status === 'rejected').length;
        return { job: j + 1, ms: Date.now() - start, failed };
      });
    }));
    const total = Date.now() - t0;
    console.log(`round ${round}: total ${total} ms, downloads=${downloads} (${opts.jobs * opts.cids.length} requested)`);
    for (const r of perJob) console.log(`  job-${r.job}: ${r.ms} ms${r.failed ? ` (${r.failed} failed)` : ''}`);
    if (cache) console.log(`  cache: ${JSON.stringify(cache.stats())}`);
  }
  ipfsClient.cleanup();
})().catch((err) => { console.error(`bench failed: ${err.message}`); process.exit(1); });
