/**
 * Builders for code-review (stake-attestation) test archives: a listing
 * archive (manifest with `codeReview`, code_review.json, baseline.json,
 * known_issues.json, a dev-signed attestation.json), a claim archive
 * (finding.json, report.md, poc.patch, optional fix.patch), prior findings,
 * and the disclosure ciphertext and E1 line for a claim.
 *
 * Everything is generated per test run from @verdikta/common's own helpers
 * (dev builder key, age disclosure key pair, deterministic encryption), so no
 * key material is committed. Kept outside __tests__ so jest does not run it
 * as a suite.
 */

const AdmZip = require('adm-zip');
const { codeReview } = require('@verdikta/common');

const BASE58 = /[^1-9A-HJ-NP-Za-km-z]/g;

/** A CID that passes the request schema (Qm + 44 base58) and the line's CID rule (46 alphanumerics). */
function cid(label) {
  return ('Qm' + label.replace(BASE58, 'x') + 'a'.repeat(44)).slice(0, 46);
}

function bytes(value) {
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  return Buffer.from(JSON.stringify(value, null, 2), 'utf8');
}

/** A ZIP of { name: content } (content: Buffer, string or JSON value). */
function zip(files) {
  const archive = new AdmZip();
  for (const [name, content] of Object.entries(files)) {
    if (content === undefined) continue;
    archive.addFile(name, bytes(content));
  }
  return archive.toBuffer();
}

function u8(buffer) {
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

function exampleSpec(disclosureKey) {
  return {
    version: 1,
    kind: 'bug',
    repo: 'https://github.com/acme/vault',
    baseCommit: '9c1e4f0a3b7d2e5c8f1a4b6d9e0c3f5a7b2d4e6f',
    artifact: { kind: 'contract', address: '0x1234567890abcdef1234567890ABCDEF12345678', chainId: 8453 },
    env: {
      image: 'ghcr.io/verdikta/stake-env@sha256:4e1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9',
      from: 'foundry',
      platform: 'linux/amd64',
      unpackedBytes: 1200000000
    },
    attestation: 'attestation.json',
    commands: {
      framework: 'forge',
      build: 'forge build',
      test: 'forge test',
      testFiles: 'forge test --match-path $FILES',
      testIds: 'forge test --match-test $TEST_IDS'
    },
    baseline: 'baseline.json',
    paths: { tests: ['test/**'], protected: ['foundry.toml', 'lib/**', '.github/**'] },
    limits: { cpus: 2, memoryMb: 4096, buildSeconds: 90, testSeconds: 180, runSeconds: 360, maxPatchBytes: 2000000 },
    stake: {
      awards: { LOW: '0', MEDIUM: '0.1 ETH', HIGH: '0.4 ETH', CRITICAL: '2 ETH' },
      lowestClassCounted: 'MEDIUM',
      bondWei: '20000000000000000',
      fixWindowDays: 30,
      disputeWindowHours: 72,
      disclosureGraceHours: 48,
      revealWindowDays: 7,
      scope: { include: ['contracts/**'], exclude: ['test/**', 'script/**'] },
      knownIssues: 'known_issues.json',
      severityRubric: 'immunefi-v2.3',
      disclosureKey,
      valueAtRiskUsd: 1250000
    }
  };
}

function exampleBaseline(baseCommit) {
  return {
    version: 1,
    baseCommit,
    framework: 'forge',
    runs: 3,
    tests: [
      { id: 'test/Vault.t.sol > VaultTest > test_deposit', results: ['pass', 'pass', 'pass'] },
      { id: 'test/Oracle.t.sol > OracleTest > test_staleness_window', results: ['pass', 'fail', 'pass'] }
    ],
    stable: ['test/Vault.t.sol > VaultTest > test_deposit'],
    unstable: ['test/Oracle.t.sol > OracleTest > test_staleness_window'],
    timings: { buildSeconds: 14.2, testSeconds: [21.5, 20.9, 22.1] }
  };
}

function exampleKnownIssues() {
  const body = {
    title: 'Rounding favours the vault on withdraw',
    class: 'LOW',
    paths: ['contracts/Vault.sol'],
    description: 'Share-to-asset conversion on withdraw rounds down by up to one wei in the vault\'s favour.'
  };
  return [{ id: codeReview.knownIssueId(body), ...body }];
}

/**
 * A listing archive. Options:
 *  - builderKey: the dev builder key that signs (default: a fresh one)
 *  - disclosure: { identity, recipient } (default: a fresh age key pair)
 *  - mutateSpec(spec): edit code_review.json before it is hashed and signed
 *  - juryParameters: the manifest's panel (default: common's CODE_STANDARD_PANEL)
 *  - outcomes: the primary file's outcomes (default: BUG_OUTCOMES)
 *  - attestation: 'signed' (default) | 'none' | 'tampered' (signed, then a byte of code_review.json changes)
 *  - trust: the trust mode the statement is signed for (default 'dev')
 *  - files: extra/overriding archive members ({ name: content | undefined })
 *  - manifest: extra manifest fields
 */
function makeListing(options = {}) {
  const builderKey = options.builderKey || codeReview.createDevBuilderKey();
  const disclosure = options.disclosure || codeReview.generateDisclosureKeyPair();
  const spec = exampleSpec(disclosure.recipient);
  if (options.mutateSpec) options.mutateSpec(spec);
  const specBytes = bytes(spec);
  const baselineBytes = bytes(exampleBaseline(spec.baseCommit));
  const knownIssuesBytes = bytes(exampleKnownIssues());

  let attestation;
  if (options.attestation !== 'none') {
    const statement = codeReview.createAttestationStatement({
      files: { codeReview: specBytes, baseline: baselineBytes, knownIssues: knownIssuesBytes },
      trust: options.trust || 'dev',
      issuedAt: '2026-11-01T00:00:00Z',
      tools: { runner: '1.0.0' }
    });
    attestation = codeReview.signAttestation(statement, builderKey.privateKey);
  }

  let query;
  try {
    query = codeReview.buildClaimQuery(spec);
  } catch (_error) {
    query = 'Judge the claim against the listing (the spec is deliberately invalid in this fixture).';
  }

  const manifest = {
    version: '1.0',
    primary: { filename: 'primary_query.json' },
    juryParameters: options.juryParameters || JSON.parse(JSON.stringify(codeReview.CODE_STANDARD_PANEL)),
    codeReview: 'code_review.json',
    ...(options.manifest || {})
  };

  const files = {
    'manifest.json': manifest,
    'primary_query.json': { query, outcomes: options.outcomes || [...codeReview.BUG_OUTCOMES], references: [] },
    'code_review.json': options.attestation === 'tampered'
      ? Buffer.from(specBytes.toString('utf8').replace('"forge build"', '"forge  build"'), 'utf8')
      : specBytes,
    'baseline.json': baselineBytes,
    'known_issues.json': knownIssuesBytes,
    'attestation.json': attestation,
    ...(options.files || {})
  };
  return { buffer: zip(files), spec, builderKey, disclosure, attestation };
}

const FINDING = Object.freeze({
  version: 1,
  title: 'Reentrancy in Vault.withdraw',
  claimedClass: 'HIGH',
  rootCause: 'Vault.withdraw sends ETH with call before it zeroes balances[msg.sender], so a receiver fallback can re-enter withdraw and drain the vault.',
  affectedPaths: ['contracts/Vault.sol'],
  poc: {
    command: 'forge test --match-test testReenterDrainsVault',
    observable: 'testReenterDrainsVault fails at the committed hash: the attacker ends with more ETH than it deposited'
  },
  fixIncluded: false
});

/** Text that must never appear in a log line (the claim's contents). */
const REPORT_MARKER = 'SECRET-REPORT-BODY-7f3a: the attacker re-enters withdraw from its fallback';
const PATCH_MARKER = 'SECRET-POC-BODY-91c2';

const POC_PATCH = [
  'diff --git a/test/Reenter.t.sol b/test/Reenter.t.sol',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/test/Reenter.t.sol',
  '@@ -0,0 +1,3 @@',
  '+// ' + PATCH_MARKER,
  '+contract ReenterTest { function testReenterDrainsVault() public { assert(false); } }',
  '+',
  ''
].join('\n');

const FIX_PATCH = [
  'diff --git a/contracts/Vault.sol b/contracts/Vault.sol',
  '--- a/contracts/Vault.sol',
  '+++ b/contracts/Vault.sol',
  '@@ -1,1 +1,1 @@',
  '-uint x;',
  '+uint y;',
  ''
].join('\n');

/**
 * A claim archive following the submitted-work contract plus the claim members.
 * Options: finding (object | string | undefined to omit), report, pocPatch, fixPatch,
 * files (extra/overriding members), name (manifest name).
 */
function makeClaim(options = {}) {
  const has = (key) => Object.prototype.hasOwnProperty.call(options, key);
  const manifest = { version: '1.0', primary: { filename: 'primary_query.json' } };
  if (options.name) manifest.name = options.name;
  const files = {
    'manifest.json': manifest,
    'primary_query.json': { query: 'Claim: reentrancy in Vault.withdraw (see report.md).' },
    'finding.json': has('finding') ? options.finding : FINDING,
    'report.md': has('report') ? options.report : `# Reentrancy\n\n${REPORT_MARKER}\n`,
    'poc.patch': has('pocPatch') ? options.pocPatch : POC_PATCH,
    'fix.patch': has('fixPatch') ? options.fixPatch : undefined,
    ...(options.files || {})
  };
  return { buffer: zip(files) };
}

/** A prior valid finding's archive (a claim archive judged earlier). */
function makePrior(label = 'prior') {
  return makeClaim({
    finding: { ...FINDING, title: `Prior finding ${label}`, rootCause: `${FINDING.rootCause} (${label})` },
    report: `# Prior ${label}\n\nAn earlier valid finding.\n`
  });
}

/**
 * Encrypt a claim archive to the listing's disclosure key and write its E1 line.
 * Options: ciphertextCid, tamperCiphertext (flip a byte of what is pinned AND of the
 * committed ciphertext hash, so only re-encryption can catch it), archiveSha256 (override).
 */
function discloseClaim(claimBuffer, recipient, options = {}) {
  const secrets = codeReview.generateDisclosureSecrets();
  let ciphertext = Buffer.from(codeReview.encryptForDisclosure(u8(claimBuffer), recipient, secrets));
  if (options.tamperCiphertext) {
    ciphertext = Buffer.from(ciphertext);
    ciphertext[ciphertext.length - 1] ^= 0x01;
  }
  const fields = {
    archiveSha256: options.archiveSha256 || codeReview.disclosureSha256(u8(claimBuffer)),
    ciphertextSha256: codeReview.disclosureSha256(u8(ciphertext)),
    ciphertextCid: options.ciphertextCid || cid('Ciphertext'),
    contentKey: secrets.contentKey,
    ephemeralKey: secrets.ephemeralKey
  };
  return { ciphertext, fields, line: codeReview.formatDisclosureLine(fields), secrets };
}

module.exports = {
  cid,
  zip,
  u8,
  exampleSpec,
  makeListing,
  makeClaim,
  makePrior,
  discloseClaim,
  FINDING,
  POC_PATCH,
  FIX_PATCH,
  REPORT_MARKER,
  PATCH_MARKER
};
