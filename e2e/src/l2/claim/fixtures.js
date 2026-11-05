'use strict';

/**
 * The claim archives: a listing of the code runner's fixture repository (a vault whose
 * deposit credits one wei too many), and the claims against it. Everything is made per run
 * with @verdikta/common's own helpers: a dev builder key, an age disclosure key pair, a real
 * disclosure of each claim. No key is committed.
 *
 * One builder for both tiers: the L2 suite runs what makeClaimSet builds through the real
 * pipeline on every PR, and scripts/build-l4-claims.js pins the same for L4.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const { codeReview } = require('@verdikta/common');

const REPORT_MARKER = 'CLAIM-REPORT-MARKER-5f81: deposit credits one wei more than it receives';
const POC_MARKER = 'CLAIM-POC-MARKER-c07a';
const POC_TEST_ID = 'test/Exploit.t.sol > ExploitTest > test_deposit_credits_exactly()';

const u8 = (b) => new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
const bytes = (v) => (Buffer.isBuffer(v) ? v : Buffer.from(typeof v === 'string' ? v : JSON.stringify(v, null, 2), 'utf8'));

function zip(files) {
  const archive = new AdmZip();
  for (const [name, content] of Object.entries(files)) archive.addFile(name, bytes(content));
  return archive.toBuffer();
}

function specFor({ image, baseCommit, disclosureKey }) {
  return {
    version: 1,
    kind: 'bug',
    repo: 'https://github.com/acme/vault',
    baseCommit,
    artifact: { kind: 'contract', address: '0x1234567890abcdef1234567890ABCDEF12345678', chainId: 31337 },
    env: { image, from: 'foundry', platform: 'linux/amd64', unpackedBytes: 2000000000 },
    attestation: 'attestation.json',
    commands: {
      framework: 'forge', build: 'forge build', test: 'forge test',
      testFiles: 'forge test --match-path $FILES', testIds: 'forge test --match-test $TEST_IDS'
    },
    baseline: 'baseline.json',
    paths: { tests: ['test/**'], protected: ['foundry.toml', 'lib/**', '.gitignore'] },
    limits: { cpus: 1, memoryMb: 1024, buildSeconds: 90, testSeconds: 120, runSeconds: 360, maxPatchBytes: 2000000 },
    stake: {
      awards: { LOW: '0', MEDIUM: '0.1 ETH', HIGH: '0.4 ETH', CRITICAL: '2 ETH' },
      lowestClassCounted: 'MEDIUM',
      bondWei: '20000000000000000',
      fixWindowDays: 30,
      disputeWindowHours: 72,
      disclosureGraceHours: 48,
      revealWindowDays: 7,
      scope: { include: ['src/**'], exclude: ['test/**'] },
      knownIssues: 'known_issues.json',
      severityRubric: 'immunefi-v2.3',
      disclosureKey,
      valueAtRiskUsd: 1000
    }
  };
}

/**
 * A listing signed for dev trust.
 * @param {object} o
 * @param {string} o.image - the env image, by digest
 * @param {string} o.baseCommit
 * @param {object} o.baseline - the repository's baseline.json
 * @returns {{ buffer: Buffer, spec: object, builderPublicKey: string, disclosure: object }}
 */
function makeListing({ image, baseCommit, baseline, builderKey = codeReview.createDevBuilderKey() }) {
  const disclosure = codeReview.generateDisclosureKeyPair();
  const spec = specFor({ image, baseCommit, disclosureKey: disclosure.recipient });
  const specBytes = bytes(spec);
  const baselineBytes = bytes(baseline);
  const knownIssuesBytes = bytes([]);
  const statement = codeReview.createAttestationStatement({
    files: { codeReview: specBytes, baseline: baselineBytes, knownIssues: knownIssuesBytes },
    trust: 'dev',
    tools: { runner: '1.0.0' }
  });
  const attestation = codeReview.signAttestation(statement, builderKey.privateKey);
  const buffer = zip({
    'manifest.json': {
      version: '1.0',
      primary: { filename: 'primary_query.json' },
      juryParameters: JSON.parse(JSON.stringify(codeReview.CODE_STANDARD_PANEL)),
      codeReview: 'code_review.json'
    },
    'primary_query.json': { query: codeReview.buildClaimQuery(spec), outcomes: [...codeReview.BUG_OUTCOMES], references: [] },
    'code_review.json': specBytes,
    'baseline.json': baselineBytes,
    'known_issues.json': knownIssuesBytes,
    'attestation.json': attestation
  });
  return { buffer, spec, builderPublicKey: builderKey.publicKey, disclosure, builderKey };
}

const FINDING = Object.freeze({
  version: 1,
  title: 'Vault.deposit over-credits',
  claimedClass: 'HIGH',
  rootCause: 'Vault.deposit credits one wei more than it receives, so balances overstate deposits and the vault can be drained.',
  affectedPaths: ['src/Vault.sol'],
  poc: {
    command: 'forge test --match-test test_deposit_credits_exactly',
    observable: 'test_deposit_credits_exactly fails at the committed hash with "2 != 1"'
  },
  fixIncluded: false
});

/** A claim archive: the submitted-work contract plus finding.json, report.md and poc.patch. */
function makeClaim({ pocPatch, finding = FINDING, name = 'e2e-claim' }) {
  return zip({
    'manifest.json': { version: '1.0', name, primary: { filename: 'primary_query.json' } },
    'primary_query.json': { query: 'Claim: Vault.deposit over-credits (see report.md).' },
    'finding.json': finding,
    'report.md': `# Vault.deposit over-credits\n\n${REPORT_MARKER}\n`,
    'poc.patch': pocPatch
  });
}

/** The claim's disclosure: the ciphertext, pinned, and the line the addendum carries (erratum E1). */
async function discloseClaim(claimBuffer, recipient, ipfs) {
  const secrets = codeReview.generateDisclosureSecrets();
  const ciphertext = Buffer.from(codeReview.encryptForDisclosure(u8(claimBuffer), recipient, secrets));
  const ciphertextCid = await ipfs.put(ciphertext);
  return codeReview.formatDisclosureLine({
    archiveSha256: codeReview.disclosureSha256(u8(claimBuffer)),
    ciphertextSha256: codeReview.disclosureSha256(u8(ciphertext)),
    ciphertextCid,
    contentKey: secrets.contentKey,
    ephemeralKey: secrets.ephemeralKey
  });
}

/** A listing archive signed elsewhere, read for what claims against it need: its disclosure key. */
function readListingArchive(buffer) {
  const archive = new AdmZip(buffer);
  const read = (name) => {
    const entry = archive.getEntry(name);
    if (!entry) throw new Error(`the listing archive has no ${name}`);
    return JSON.parse(entry.getData().toString('utf8'));
  };
  const manifest = read('manifest.json');
  if (typeof manifest.codeReview !== 'string') throw new Error('the archive\'s manifest has no codeReview key: it is not a listing');
  const spec = read(manifest.codeReview);
  return { buffer, spec, builderPublicKey: null, builderKey: null, disclosure: { recipient: spec.stake.disclosureKey } };
}

/**
 * A listing's dispute archive, cids[0] of a dispute request: the same members, with common's dispute
 * panel (verdikta-applications/stake-attestation/server/src/listing/archives.js). The attestation
 * covers the spec, the baseline and the known issues, so it stands for both.
 */
function disputeArchive(listingBuffer) {
  const archive = new AdmZip(listingBuffer);
  const files = {};
  for (const entry of archive.getEntries()) files[entry.entryName] = entry.getData();
  const manifest = JSON.parse(files['manifest.json'].toString('utf8'));
  manifest.juryParameters = JSON.parse(JSON.stringify(codeReview.CODE_STANDARD_DISPUTE_PANEL));
  return zip({ ...files, 'manifest.json': manifest });
}

/** The maker's argument in a dispute: pinned, and named by CID in the addendum's second line (erratum E2). */
const DISPUTE_STATEMENT = 'The maker disputes this claim: the extra wei is documented behaviour of the fixture vault, not a defect.\n';

/**
 * A digest in the listing's own repository that no registry holds: the runner's allowlist takes
 * it, the pull fails (design §12: registry or image-pull failure, error, no commit).
 */
function absentDigest(image) {
  const repository = String(image).split('@')[0];
  return `${repository}@sha256:${crypto.createHash('sha256').update(`verdikta-l4-registry-failure\n${image}`).digest('hex')}`;
}

/** The claims the fault plan names, and the fault each is for (the External Adapter's VERDIKTA_CANARY_FAULTS). */
const FAULT_CLAIMS = Object.freeze({
  faultNearLimit: 'near-limit-juror',
  faultProviderTimeout: 'provider-timeout',
  faultSlowJustifier: 'slow-justifier',
  faultCancellation: 'cancellation'
});

/** The flag's value for this claim set: exact claims, no other way to name one. */
function faultPlan({ claims }) {
  return Object.entries(FAULT_CLAIMS).map(([key, fault]) => `${claims[key].cid}=${fault}`).join(',');
}

/**
 * A listing and the claims against it:
 *  - valid; out of the listing's scope (the EA's inScope gate, before any runner call); a PoC
 *    that edits the code under test (the runner's testPathsOnly gate);
 *  - A3b's PoCs, reused from code-runner/test/docker/determinismPocs.js: time-dependent,
 *    randomness-dependent, flaky;
 *  - four more of the valid PoC, each its own CID, for the fault plan to name;
 *  - a dispute: the valid PoC again, the listing's dispute archive and the statement pinned, and
 *    the addendum ClaimLogic.dispute composes;
 *  - on a second listing, whose image digest no registry holds: a claim, and its control, out of scope;
 *  - on a third, only when a fresh image is named: the cold-cache claim.
 *
 * Every claim on this set's listings is signed by one builder key, so the canaries trust one.
 *
 * @param {object} o
 * @param {object} o.repo - the code runner's fixture repository (code-runner/test/docker/forgeFixture.js)
 * @param {(bytes: Buffer) => Promise<string>} o.put - pins bytes and gives their CID
 * @param {string} [o.image] - the env image, by digest (with baseCommit, for a listing made here)
 * @param {string} [o.baseCommit]
 * @param {object} [o.listing] - a listing already made (makeListing, readListingArchive)
 * @param {string} [o.coldImage] - an image the canaries have not pulled, for the cold-cache listing
 * @param {object} [o.registryListing] - with a listing made elsewhere: its registry-failure listing, signed too
 * @param {object} [o.coldListing] - with a listing made elsewhere: its cold-cache listing, signed too
 * @returns {Promise<{ listing: object, listingCid: string, registryFailure: object|null, coldListing: object|null, claims: Record<string, { buffer: Buffer, cid: string, addendum: string, requestCid: string, listingCid?: string }> }>}
 */
async function makeClaimSet({ repo, put, image, baseCommit, listing: given = null, coldImage = null, registryListing = null, coldListing: givenCold = null }) {
  const listing = given || makeListing({ image, baseCommit, baseline: repo.vaultBaseline(baseCommit) });
  const listingCid = await put(listing.buffer);
  const { TIME_POC, RANDOM_POC, FLAKY_POC } = require(path.join(__dirname, '..', '..', '..', '..', 'code-runner', 'test', 'docker', 'determinismPocs'));
  const poc = repo.addFilesPatch({
    'test/Exploit.t.sol': repo.pocFile('ExploitTest', [
      `    // ${POC_MARKER}`,
      '    function test_deposit_credits_exactly() public { Vault v = new Vault(); v.deposit(1); vm.assertEq(v.balanceOf(address(this)), 1); }'
    ])
  });
  const claimOn = async (on, onCid, buffer) => {
    const cid = await put(buffer);
    const addendum = await discloseClaim(buffer, on.disclosure.recipient, { put });
    return { buffer, cid, addendum, requestCid: `${onCid},${cid}:${addendum}`, ...(on === listing ? {} : { listingCid: onCid }) };
  };
  const claimOf = (buffer) => claimOn(listing, listingCid, buffer);
  const pocClaim = (name) => claimOf(makeClaim({ pocPatch: poc, name }));
  const outOfScope = { pocPatch: poc, name: 'e2e-out-of-scope', finding: { ...FINDING, affectedPaths: ['test/Vault.t.sol'] } };
  const vault = repo.VAULT_REPO['src/Vault.sol'];
  // The randomness PoC's messages all move, so the finding names the deposit test beside it.
  const exploit = repo.pocFile('ExploitTest', ['    function test_deposit_credits_exactly() public { Vault v = new Vault(); v.deposit(1); vm.assertEq(v.balanceOf(address(this)), 1); }']);
  const claims = {
    valid: await claimOf(makeClaim({ pocPatch: poc })),
    outOfScope: await claimOf(makeClaim(outOfScope)),
    editsSource: await claimOf(makeClaim({
      name: 'e2e-edits-source',
      pocPatch: repo.modifyPatch('src/Vault.sol', vault, vault.replace('amount + 1', 'amount + 2'))
    })),
    timeDependent: await claimOf(makeClaim({ name: 'e2e-time-dependent', pocPatch: repo.addFilesPatch({ 'test/Clock.t.sol': TIME_POC }) })),
    randomnessDependent: await claimOf(makeClaim({ name: 'e2e-randomness-dependent', pocPatch: repo.addFilesPatch({ 'test/Random.t.sol': RANDOM_POC, 'test/Exploit.t.sol': exploit }) })),
    flaky: await claimOf(makeClaim({ name: 'e2e-flaky', pocPatch: repo.addFilesPatch({ 'test/Flaky.t.sol': FLAKY_POC }) })),
    faultNearLimit: await pocClaim('e2e-fault-near-limit'),
    faultProviderTimeout: await pocClaim('e2e-fault-provider-timeout'),
    faultSlowJustifier: await pocClaim('e2e-fault-slow-justifier'),
    faultCancellation: await pocClaim('e2e-fault-cancellation')
  };

  const dispute = await pocClaim('e2e-dispute');
  const disputeListingCid = await put(disputeArchive(listing.buffer));
  const statementCid = await put(Buffer.from(DISPUTE_STATEMENT, 'utf8'));
  const disputeAddendum = `${dispute.addendum}\n${codeReview.DISPUTE_LINE_PREFIX}${statementCid}`;
  claims.dispute = { ...dispute, disputeListingCid, statementCid, disputeAddendum, disputeRequestCid: `${disputeListingCid},${dispute.cid}:${disputeAddendum}` };

  const signed = (imageRef) => makeListing({ image: imageRef, baseCommit: listing.spec.baseCommit, baseline: repo.vaultBaseline(listing.spec.baseCommit), builderKey: listing.builderKey });
  const registryFailure = registryListing || (listing.builderKey ? signed(absentDigest(listing.spec.env.image)) : null);
  if (registryFailure) {
    const cid = await put(registryFailure.buffer);
    claims.registryFailure = await claimOn(registryFailure, cid, makeClaim({ pocPatch: poc, name: 'e2e-registry-failure' }));
    claims.registryControl = await claimOn(registryFailure, cid, makeClaim({ ...outOfScope, name: 'e2e-registry-control' }));
  }
  const coldListing = givenCold || (coldImage && listing.builderKey ? signed(coldImage) : null);
  if (coldListing) {
    const cid = await put(coldListing.buffer);
    claims.coldCache = { ...await claimOn(coldListing, cid, makeClaim({ pocPatch: poc, name: 'e2e-cold-cache' })), image: coldListing.spec.env.image };
  }
  return { listing, listingCid, registryFailure, coldListing, claims };
}

/** What L4 reads (archives/l4-claim/claim-set.json): CIDs and lines, no archive and no private key. */
function claimSetFile(set) {
  const { listing, listingCid, claims } = set;
  const OPTIONAL = ['listingCid', 'disputeListingCid', 'disputeAddendum', 'statementCid', 'image'];
  const entry = (claim) => ({
    cid: claim.cid,
    addendum: claim.addendum,
    ...Object.fromEntries(OPTIONAL.filter((field) => claim[field] !== undefined).map((field) => [field, claim[field]]))
  });
  return {
    version: 1,
    builderPublicKey: listing.builderPublicKey,
    image: listing.spec.env.image,
    baseCommit: listing.spec.baseCommit,
    listingCid,
    faultPlan: faultPlan(set),
    claims: Object.fromEntries(Object.entries(claims).map(([key, claim]) => [key, entry(claim)]))
  };
}

/** The project's canonical text-mode archive (archives/contract-vuln), as scripts/build-archive.js zips it. */
function textArchive() {
  const dir = path.join(__dirname, '..', '..', '..', 'archives', 'contract-vuln');
  const files = {};
  for (const f of fs.readdirSync(dir).sort()) files[f] = fs.readFileSync(path.join(dir, f));
  return zip(files);
}

module.exports = { REPORT_MARKER, POC_MARKER, POC_TEST_ID, FINDING, DISPUTE_STATEMENT, FAULT_CLAIMS, makeListing, readListingArchive, makeClaim, makeClaimSet, claimSetFile, faultPlan, absentDigest, disputeArchive, discloseClaim, textArchive };
