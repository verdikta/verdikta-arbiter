'use strict';

// The runner reads the pinned forge base, the fuzz seed and the test-paths
// gate from @verdikta/common, pinned exactly to the same prerelease as the
// EA, the AI Node and e2e (external-adapter's commonPin.test.js checks the
// four agree).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const common = require('../../src/common');

const PINNED = '1.9.0-attest.1';
const ROOT = path.join(__dirname, '..', '..');

test('package.json pins @verdikta/common exactly, and the lockfile resolves that version', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(manifest.dependencies['@verdikta/common'], PINNED);
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
  assert.equal(lock.packages[''].dependencies['@verdikta/common'], PINNED);
  assert.equal(lock.packages['node_modules/@verdikta/common'].version, PINNED);
  assert.equal(require('@verdikta/common/package.json').version, PINNED);
});

test('the values are the package\'s own (the deep imports are what the package exports)', () => {
  const { codeReview } = require('@verdikta/common');
  assert.equal(common.FORGE_FUZZ_SEED, codeReview.FORGE_FUZZ_SEED);
  assert.equal(common.FORGE_FUZZ_SEED, '0x76657264696b7461');
  assert.deepEqual(common.BASE_IMAGE_PINS, codeReview.BASE_IMAGE_PINS);
  assert.equal(common.BASE_IMAGE_PINS.foundry.version, 'v1.8.5');
  assert.match(common.BASE_IMAGE_PINS.foundry.reference, /^ghcr\.io\/foundry-rs\/foundry:v1\.8\.5@sha256:[0-9a-f]{64}$/);
  assert.equal(common.pocPatchPathsGate, codeReview.pocPatchPathsGate);
  assert.equal(common.matchesAny, codeReview.matchesAny);
});

test('poc-patch-edits-source: the gate common implements is the one the runner applies', () => {
  const spec = { paths: { tests: ['test/**'], protected: ['foundry.toml', 'lib/**'] } };
  assert.deepEqual(common.pocPatchPathsGate(['src/Vault.sol', 'test/Exploit.t.sol'], spec), { pass: false, outside: ['src/Vault.sol'], protected: [] });
  assert.deepEqual(common.pocPatchPathsGate(['test/Exploit.t.sol'], spec), { pass: true, outside: [], protected: [] });
});
