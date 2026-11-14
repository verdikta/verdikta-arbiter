'use strict';

/**
 * The Semgrep image the scanner runs (src/scanner.js) and the image cache never
 * evicts (src/images.js): semgrep/semgrep 1.181.0 (2026-10-14), the multi-platform
 * index, the release the builder's baseline scan reviewed (verdikta-applications
 * stake-attestation/builder/src/scanTools.js). A change here needs a new
 * RUNNER_VERSION: `inputs.runner` is what ties a report to it.
 */
const SEMGREP = Object.freeze({
  version: '1.181.0',
  repository: 'docker.io/semgrep/semgrep',
  indexDigest: 'sha256:81474464c1f07483ba0682a44787fd93c91397419762a04abe2bafaae396304b',
  reference: 'docker.io/semgrep/semgrep@sha256:81474464c1f07483ba0682a44787fd93c91397419762a04abe2bafaae396304b',
  binary: '/usr/bin/semgrep'
});

module.exports = { SEMGREP };
