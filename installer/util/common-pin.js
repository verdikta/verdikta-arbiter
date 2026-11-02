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
 *
 *        node common-pin.js --agree <repoRoot>
 *   the same-version check: the AI Node, the External Adapter and the code
 *   runner (COMMON_COMPONENTS) must each pin one exact release, the same one.
 *   Prints it and exits 0, or names each component's pin and exits 1.
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

/** The components that judge a claim and must read one @verdikta/common release, by directory. */
const COMMON_COMPONENTS = Object.freeze(['ai-node', 'external-adapter', 'code-runner']);

/**
 * @param {string} repoRoot - the directory holding the components
 * @returns {{ agree: boolean, pins: Record<string, string|null> }} agree: every
 *   component pins an exact version and they are all the same one
 */
function commonPinAgreement(repoRoot) {
  const pins = {};
  for (const component of COMMON_COMPONENTS) pins[component] = exactCommonPin(path.join(repoRoot, component));
  const values = Object.values(pins);
  return { agree: values.every(Boolean) && new Set(values).size === 1, pins };
}

module.exports = { EXACT_VERSION, COMMON_COMPONENTS, exactCommonPin, commonPinAgreement };

if (require.main === module && process.argv[2] === '--agree') {
  const { agree, pins } = commonPinAgreement(process.argv[3] || process.cwd());
  if (agree) {
    console.log(pins[COMMON_COMPONENTS[0]]);
    process.exit(0);
  }
  console.error(`@verdikta/common pins disagree: ${COMMON_COMPONENTS.map((c) => `${c}:${pins[c] || 'none'}`).join(', ')}`);
  process.exit(1);
}

if (require.main === module) {
  const pin = exactCommonPin(process.argv[2] || process.cwd());
  if (pin) {
    console.log(pin);
    process.exit(0);
  }
  process.exit(1);
}
