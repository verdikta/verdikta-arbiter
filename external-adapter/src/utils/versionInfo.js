/**
 * @fileoverview Self-reported arbiter version information.
 *
 * Arbiters are only observable remotely through chain + IPFS, so the version
 * must travel with each response: the evaluate handler embeds this block in
 * every justification uploaded to IPFS, and the server exposes it at
 * GET /version for local/ops inspection (arbiter-doctor).
 *
 * Sources (all best-effort — a missing source yields null, never an error):
 *  - adapter:        external-adapter/package.json version
 *  - aiNode:         sibling ai-node/package.json version (repo and install
 *                    layouts both place ai-node next to external-adapter)
 *  - verdiktaCommon: installed @verdikta/common version
 *  - release:        VERSION stamp written by installer/bin/install.sh and
 *                    upgrade-arbiter.sh at the install root (or EA root),
 *                    e.g. "51b3d4f 2026-07-02T15:00:00Z"
 */

const fs = require('fs');
const path = require('path');

const EA_ROOT = path.join(__dirname, '..', '..');

function readJsonVersion(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')).version || null;
  } catch (_) {
    return null;
  }
}

function readReleaseStamp() {
  // Install layout: $INSTALL_DIR/VERSION (EA lives at $INSTALL_DIR/external-adapter).
  // Also accept a stamp inside the EA directory itself.
  const candidates = [
    path.join(EA_ROOT, '..', 'VERSION'),
    path.join(EA_ROOT, 'VERSION'),
  ];
  for (const file of candidates) {
    try {
      const value = fs.readFileSync(file, 'utf8').trim();
      if (value) return value;
    } catch (_) { /* try next */ }
  }
  return null;
}

/** Collect version info once at startup; the values cannot change at runtime. */
function collectVersionInfo() {
  return {
    adapter: readJsonVersion(path.join(EA_ROOT, 'package.json')),
    aiNode: readJsonVersion(path.join(EA_ROOT, '..', 'ai-node', 'package.json')),
    verdiktaCommon: readJsonVersion(
      path.join(EA_ROOT, 'node_modules', '@verdikta', 'common', 'package.json')
    ),
    release: readReleaseStamp(),
  };
}

const versionInfo = collectVersionInfo();

module.exports = { versionInfo, collectVersionInfo };
