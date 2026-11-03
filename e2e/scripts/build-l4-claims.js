#!/usr/bin/env node
'use strict';

/**
 * Build the archives the L4 claim scenarios send, and pin them: G2's preparation.
 *
 * The same builder as the L2 claim suite (src/l2/claim/fixtures.js), so what is pinned here
 * has been through the real pipeline in CI. It signs the listing with a dev builder key made
 * here, whose private half is dropped at once: the public half goes in the canaries'
 * CODE_REVIEW_DEV_KEYS (dev trust is refused off a test chain). A listing signed elsewhere,
 * by the production builder, comes in with --listing-file.
 *
 *   node scripts/build-l4-claims.js --image <repo@sha256:…> --base-commit <hash> --dry-run
 *   IPFS_PINNING_KEY=<jwt> node scripts/build-l4-claims.js --image <repo@sha256:…> --base-commit <hash> --pin
 *   IPFS_PINNING_KEY=<jwt> node scripts/build-l4-claims.js --listing-file <listing.zip> --pin
 *
 * --dry-run touches neither the network nor a file. --pin writes --out (default
 * archives/l4-claim/claim-set.json), which holds CIDs, each claim's disclosure line and the
 * builder's public key. The lines' keys are a throwaway fixture's, and the same lines go
 * on-chain in the clear when L4 sends them. Needs `npm ci` in code-runner/ (the fixture repository).
 */

require('dotenv').config();
const fs = require('fs');
const os = require('os');
const path = require('path');
const { program } = require('commander');
const Hash = require('ipfs-only-hash');
const { createClient, codeReview } = require('@verdikta/common');
const F = require('../src/l2/claim/fixtures');
const { validateClaimSet } = require('../src/scenario-loader');

const ROOT = path.join(__dirname, '..');
const DEFAULT_OUT = 'archives/l4-claim/claim-set.json';
const IMAGE = /^[^@\s]+@sha256:[0-9a-f]{64}$/;
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

function runnerRepo() {
  try {
    return require(path.join(ROOT, '..', 'code-runner', 'test', 'docker', 'forgeFixture'));
  } catch (error) {
    throw new Error(`cannot load the code runner's fixture repository (npm ci in code-runner/?): ${error.message}`);
  }
}

/** Pins through @verdikta/common's client, and holds Pinata to the CID the bytes have. */
function pinner() {
  if (!process.env.IPFS_PINNING_KEY) throw new Error('--pin needs IPFS_PINNING_KEY (a Pinata JWT)');
  const client = createClient({
    ipfs: {
      pinningService: process.env.IPFS_PINNING_SERVICE || 'https://api.pinata.cloud',
      pinningKey: process.env.IPFS_PINNING_KEY,
      timeout: 30000
    },
    logging: { level: 'error', console: false, file: false }
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-l4-pin-'));
  let count = 0;
  return {
    put: async (bytes) => {
      const expected = await Hash.of(bytes);
      const file = path.join(dir, `archive-${count += 1}`);
      fs.writeFileSync(file, bytes);
      const cid = await client.ipfsClient.uploadToIPFS(file);
      if (cid !== expected) throw new Error(`the pinning service answered ${cid} for bytes whose CID is ${expected}`);
      return cid;
    },
    close: () => {
      client.ipfsClient.cleanup();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

async function main(opts) {
  if (Boolean(opts.dryRun) === Boolean(opts.pin)) throw new Error('pass exactly one of --dry-run and --pin');
  let listing = null;
  if (opts.listingFile) {
    if (opts.image || opts.baseCommit) throw new Error('--listing-file names the image and the commit itself: drop --image and --base-commit');
    listing = F.readListingArchive(fs.readFileSync(path.resolve(opts.listingFile)));
  } else {
    if (!IMAGE.test(opts.image || '')) throw new Error('--image must name the env image by digest: <repository>@sha256:<64 hex>');
    if (!COMMIT.test(opts.baseCommit || '')) throw new Error('--base-commit must be a whole commit hash');
  }

  const pin = opts.pin ? pinner() : null;
  try {
    const set = await F.makeClaimSet({
      repo: runnerRepo(),
      put: pin ? pin.put : (bytes) => Hash.of(bytes),
      image: opts.image,
      baseCommit: opts.baseCommit,
      listing
    });
    const spec = codeReview.validateCodeReviewSpec(set.listing.spec);
    if (!spec.ok) throw new Error(`the listing's spec does not validate: ${JSON.stringify(spec.issues)}`);
    const value = validateClaimSet(F.claimSetFile(set));

    console.log(`Listing            ${value.listingCid}`);
    for (const [key, claim] of Object.entries(value.claims)) console.log(`Claim ${key.padEnd(12)} ${claim.cid}`);
    if (value.builderPublicKey) {
      console.log('\nOn every canary, for dev trust (refused off a test chain):');
      console.log(`  CODE_REVIEW_DEV_KEYS=${value.builderPublicKey}`);
    }
    if (opts.dryRun) {
      console.log('\nDry run: nothing was pinned and no file was written.');
      return;
    }
    const out = path.resolve(ROOT, opts.out);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, `${JSON.stringify(value, null, 2)}\n`);
    console.log(`\nWrote ${out}. Commit it on the branch the L4 run dispatches from.`);
  } finally {
    if (pin) pin.close();
  }
}

program
  .option('--image <ref>', 'the env image, by digest, where every canary\'s runner may pull it')
  .option('--base-commit <hash>', 'the fixture repository\'s commit in that image')
  .option('--listing-file <zip>', 'a listing archive signed elsewhere, instead of --image and --base-commit')
  .option('--out <file>', 'the claim set to write', DEFAULT_OUT)
  .option('--dry-run', 'build and check everything; pin nothing, write nothing')
  .option('--pin', 'pin every archive (needs IPFS_PINNING_KEY) and write the claim set')
  .parse(process.argv);

main(program.opts()).then(() => process.exit(0)).catch((error) => {
  console.error(`build-l4-claims: ${error.message}`);
  process.exit(1);
});
