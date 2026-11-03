'use strict';

/**
 * A complete claim scenario folder for the testing tool's tests: A6a's listing and claim
 * builders, A4b's report and pack, real CIDs of the archives' bytes. This is also the
 * worked example of the format the README describes.
 *
 * Kept outside __tests__ so jest does not run it as a suite.
 */

const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const Hash = require('ipfs-only-hash');
const { codeReview } = require('@verdikta/common');
const F = require('../../../e2e/src/l2/claim/fixtures');
const R = require('../../../external-adapter/test/helpers/codeReviewRun');
const { assemblePack } = require('../../../code-runner/src/pack');

const IMAGE = `registry.example/vault@sha256:${'b'.repeat(64)}`;
const BASE_COMMIT = 'a'.repeat(40);
const POC_PATCH = Buffer.from('diff --git a/test/Exploit.t.sol b/test/Exploit.t.sol\n');
const BASELINE = Object.freeze({
  version: 1, baseCommit: BASE_COMMIT, framework: 'forge', runs: 3,
  tests: [{ id: 'test/Vault.t.sol > VaultTest > test_deposit()', results: ['pass', 'pass', 'pass'] }],
  stable: ['test/Vault.t.sol > VaultTest > test_deposit()'], unstable: []
});

/** What the runner reads from the sandbox for the pack (code-runner/src/pack.js, gatherPackInputs). */
const listOf = (items) => ({ asked: items.length, items, omitted: {} });
const PACK_INPUTS = Object.freeze({
  pocDiff: POC_PATCH.toString('utf8'),
  pocFiles: listOf([{ path: 'test/Exploit.t.sol', text: 'contract ExploitTest {}\n', bytes: 24, cut: false }]),
  sources: listOf([{ path: 'src/Vault.sol', text: 'contract Vault {}\n', bytes: 18, cut: false }]),
  callSites: { ...listOf([]), symbols: { found: 0, withSites: 0, noSites: 0, overCap: 0, longLines: 0 } },
  tree: 'src/ (1 file)\ntest/ (2 files)\nfoundry.toml\n'
});

const priorFinding = (n) => ({
  ...F.FINDING,
  title: `Prior finding ${n}`,
  rootCause: `Prior root cause ${n}: another path through the deposit accounting.`
});

/**
 * Write a scenario folder.
 * @param {string} root - the claims directory
 * @param {object} [o]
 * @param {string} [o.id]
 * @param {number} [o.priors=2]
 * @param {object} [o.scenario] - scenario.json's other fields
 * @param {(run: object) => object} [o.changeRun] - rewrite run.json
 * @param {object} [o.listingFiles] - listing members to replace, before its CID is taken
 * @param {object} [o.shape] - the report's shape (see codeReviewRun.reportFor)
 * @returns {Promise<object>} what went in: folder, listing, claim, priors, run, spec
 */
async function writeClaimScenario(root, { id = 'vault-over-credit', priors = 2, scenario = {}, changeRun = (run) => run, shape, listingFiles = {} } = {}) {
  const folder = path.join(root, id);
  fs.mkdirSync(path.join(folder, 'priors'), { recursive: true });

  const listing = F.makeListing({ image: IMAGE, baseCommit: BASE_COMMIT, baseline: BASELINE });
  if (Object.keys(listingFiles).length > 0) {
    const zip = new AdmZip(listing.buffer);
    for (const [name, value] of Object.entries(listingFiles)) zip.updateFile(name, Buffer.from(JSON.stringify(value)));
    listing.buffer = zip.toBuffer();
  }
  const claimBytes = F.makeClaim({ pocPatch: POC_PATCH });
  const listingCid = await Hash.of(listing.buffer);
  const bcid = await Hash.of(claimBytes);

  const priorList = [];
  for (let n = 1; n <= priors; n += 1) {
    const finding = priorFinding(n);
    const bytes = F.makeClaim({ pocPatch: POC_PATCH, finding, name: `prior-${n}` });
    const prior = { bcid: await Hash.of(bytes), finding, report: `# Vault.deposit over-credits\n\n${F.REPORT_MARKER}\n` };
    priorList.push(prior);
    fs.writeFileSync(path.join(folder, 'priors', `${String(n).padStart(2, '0')}-prior.zip`), bytes);
  }

  const attestation = JSON.parse(codeReview.canonicalJson({ version: 1 }));
  const body = {
    listingCid,
    bcid,
    spec: listing.spec,
    attestation,
    pocPatch: POC_PATCH.toString('base64'),
    fixPatch: null,
    finding: F.FINDING,
    report: `# Vault.deposit over-credits\n\n${F.REPORT_MARKER}\n`,
    priorFindings: priorList
  };
  const answer = R.definitive(body, shape).json;
  // The runner's real pack, so what the tool reads of it is the runner's form.
  const contextPack = assemblePack({ request: { ...body, knownIssues: [], codeClass: 'code-standard' }, inputs: PACK_INPUTS });
  const run = changeRun({ report: answer.report, reportSha256: answer.reportSha256, contextPack });

  fs.writeFileSync(path.join(folder, 'listing.zip'), listing.buffer);
  fs.writeFileSync(path.join(folder, 'claim.zip'), claimBytes);
  fs.writeFileSync(path.join(folder, 'run.json'), JSON.stringify(run));
  fs.writeFileSync(path.join(folder, 'scenario.json'), JSON.stringify({ id, expected_outcome: 'HIGH', tags: ['vault'], notes: 'A test claim', ...scenario }));

  return { folder, id, listing, listingCid, bcid, claimBytes, priors: priorList, run, spec: listing.spec };
}

module.exports = { writeClaimScenario, priorFinding, POC_PATCH, IMAGE, BASE_COMMIT };
