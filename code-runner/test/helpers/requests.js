'use strict';

const LISTING_CID = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';
const BCID = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';
const IMAGE = 'ghcr.io/verdikta/stake-env@sha256:' + 'a'.repeat(64);

const POC_PATCH = [
  'diff --git a/test/Exploit.t.sol b/test/Exploit.t.sol',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/test/Exploit.t.sol',
  '@@ -0,0 +1 @@',
  '+// exploit',
  ''
].join('\n');

function spec(overrides = {}) {
  return {
    version: 1,
    kind: 'bug',
    repo: 'https://github.com/acme/vault',
    baseCommit: '7f3a9c0000000000000000000000000000000000',
    env: { image: IMAGE, from: 'foundry', platform: 'linux/amd64', unpackedBytes: 1400000000 },
    attestation: 'attestation.json',
    commands: { framework: 'forge', build: 'forge build', test: 'forge test' },
    paths: { tests: ['test/**'], protected: ['foundry.toml', 'lib/**'] },
    limits: { cpus: 2, memoryMb: 4096, buildSeconds: 90, testSeconds: 180, runSeconds: 360, maxPatchBytes: 2000000 },
    ...overrides
  };
}

/** A valid POST /v1/runs body. */
/** The attestation's env names the spec's image, platform and size (A1b checks they agree). */
function attestationFor(s) {
  if (!s || typeof s !== 'object' || !s.env || typeof s.env !== 'object') return { version: 1 };
  const { image, from, platform, unpackedBytes } = s.env;
  return { version: 1, env: { image, from, platform, unpackedBytes } };
}

function runRequest(overrides = {}) {
  const s = overrides.spec || spec();
  return {
    listingCid: LISTING_CID,
    bcid: BCID,
    spec: s,
    attestation: attestationFor(s),
    pocPatch: Buffer.from(POC_PATCH).toString('base64'),
    fixPatch: null,
    baseline: { stable: ['test/Vault.t.sol > test_deposit'], unstable: [] },
    finding: { class: 'HIGH', rootCause: 'reentrancy in withdraw', paths: ['src/Vault.sol'] },
    report: '# Reentrancy in withdraw\n',
    knownIssues: [],
    priorFindings: [],
    eaGates: { disclosure: 'pass' },
    deadline: 700000,
    ...overrides
  };
}

module.exports = { LISTING_CID, BCID, IMAGE, POC_PATCH, spec, runRequest, attestationFor };
