#!/usr/bin/env node

/**
 * The exact @verdikta/common pin of a component (AI Node, External Adapter).
 *
 * A component that pins @verdikta/common to one exact version (for example
 * the stake-attestation prerelease 1.9.0-attest.1, which carries the
 * code-review gates) needs exactly that release, and its AI Node and adapter
 * must agree on it. The installer's version preference (VERDIKTA_COMMON_VERSION,
 * `latest` by default) only applies to components that pin a range: an exact
 * pin wins, so install and upgrade never replace it with another release.
 *
 * Usage: node common-pin.js <componentDir>
 *   prints the pinned version and exits 0, or exits 1 when the component pins
 *   no exact version (a range, a dist-tag, or no package.json).
 */

const fs = require('fs');
const path = require('path');

/** One exact semver version, a prerelease included; no range operators, no tags. */
const EXACT_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * @param {string} componentDir - the directory holding the component's package.json
 * @returns {string|null} the exact version pinned in dependencies, or null
 */
function exactCommonPin(componentDir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(componentDir, 'package.json'), 'utf8'));
    const spec = pkg && pkg.dependencies && pkg.dependencies['@verdikta/common'];
    return typeof spec === 'string' && EXACT_VERSION.test(spec) ? spec : null;
  } catch (_error) {
    return null;
  }
}

module.exports = { EXACT_VERSION, exactCommonPin };

if (require.main === module) {
  const pin = exactCommonPin(process.argv[2] || process.cwd());
  if (pin) {
    console.log(pin);
    process.exit(0);
  }
  process.exit(1);
}
