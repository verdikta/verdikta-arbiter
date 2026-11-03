'use strict';

/**
 * The claim suite's archives: a listing of the code runner's fixture repository (a vault
 * whose deposit credits one wei too many), and the claims against it. Everything is made
 * per run with @verdikta/common's own helpers: a dev builder key, an age disclosure key
 * pair, a real disclosure of each claim. No key is committed.
 */

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
function makeListing({ image, baseCommit, baseline }) {
  const builderKey = codeReview.createDevBuilderKey();
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
  return { buffer, spec, builderPublicKey: builderKey.publicKey, disclosure };
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

/** The project's canonical text-mode archive (archives/contract-vuln), as scripts/build-archive.js zips it. */
function textArchive() {
  const dir = path.join(__dirname, '..', '..', '..', 'archives', 'contract-vuln');
  const files = {};
  for (const f of fs.readdirSync(dir).sort()) files[f] = fs.readFileSync(path.join(dir, f));
  return zip(files);
}

module.exports = { REPORT_MARKER, POC_MARKER, POC_TEST_ID, FINDING, makeListing, makeClaim, discloseClaim, textArchive };
