'use strict';

// Acceptance: class hard limits applied whatever the spec says; above them →
// requester error before any work (a local module until A3b uses common).

const test = require('node:test');
const assert = require('node:assert/strict');
const { CLASS_HARD_LIMITS, SPEC_LIMIT_MAXIMA, checkSpec } = require('../../src/classLimits');
const { spec } = require('../helpers/requests');

test('the local copy carries @verdikta/common CLASS_HARD_LIMITS (src/codeReview/constants.js) value for value', () => {
  assert.deepEqual({ ...CLASS_HARD_LIMITS }, {
    cpus: 2,
    memoryMb: 4096,
    pids: 4096,
    buildSeconds: 90,
    runSeconds: 360,
    imageCompressedBytes: 2000000000,
    imageUnpackedBytes: 6000000000,
    maxPatchBytes: 2000000,
    patchExpansionBytes: 50000000,
    platform: 'linux/amd64'
  });
  assert.deepEqual({ ...SPEC_LIMIT_MAXIMA }, {
    cpus: 2, memoryMb: 4096, buildSeconds: 90, testSeconds: 360, runSeconds: 360, maxPatchBytes: 2000000
  });
  assert.ok(Object.isFrozen(CLASS_HARD_LIMITS));
});

test('a spec without limits gets the class maxima', () => {
  const s = spec();
  delete s.limits;
  const r = checkSpec(s);
  assert.equal(r.ok, true, JSON.stringify(r.issues));
  assert.deepEqual(r.limits, {
    cpus: 2, memoryMb: 4096, pids: 4096, buildSeconds: 90, testSeconds: 360, runSeconds: 360,
    maxPatchBytes: 2000000, patchExpansionBytes: 50000000, platform: 'linux/amd64'
  });
});

test('a spec may lower the limits', () => {
  const r = checkSpec(spec({ limits: { cpus: 1, memoryMb: 1024, buildSeconds: 30, testSeconds: 60, runSeconds: 120, maxPatchBytes: 1000 } }));
  assert.equal(r.ok, true, JSON.stringify(r.issues));
  assert.equal(r.limits.cpus, 1);
  assert.equal(r.limits.memoryMb, 1024);
  assert.equal(r.limits.runSeconds, 120);
  assert.equal(r.limits.maxPatchBytes, 1000);
  // Not settable by the spec at all.
  assert.equal(r.limits.pids, 4096);
  assert.equal(r.limits.patchExpansionBytes, 50000000);
});

test('every limit above its class maximum is a LIMIT_ABOVE_CLASS_MAX issue', () => {
  const over = { cpus: 3, memoryMb: 4097, buildSeconds: 91, testSeconds: 361, runSeconds: 361, maxPatchBytes: 2000001 };
  const r = checkSpec(spec({ limits: over }));
  assert.equal(r.ok, false);
  assert.equal(r.limits, null);
  for (const key of Object.keys(over)) {
    assert.ok(r.issues.some((i) => i.code === 'LIMIT_ABOVE_CLASS_MAX' && i.path === `/spec/limits/${key}`), key);
  }
});

test('the spec cannot reach a limit or flag it does not own', () => {
  for (const key of ['pids', 'network', 'runtime', 'privileged', 'memorySwap', 'user']) {
    const r = checkSpec(spec({ limits: { [key]: 1 } }));
    assert.equal(r.ok, false, key);
    assert.ok(r.issues.some((i) => i.code === 'UNKNOWN_FIELD' && i.path === `/spec/limits/${key}`), key);
  }
});

test('limits must be integers at or above their minimum', () => {
  for (const [key, value] of [['cpus', 1.5], ['cpus', 0], ['memoryMb', 255], ['buildSeconds', -1], ['runSeconds', '360'], ['maxPatchBytes', null]]) {
    const r = checkSpec(spec({ limits: { [key]: value } }));
    assert.equal(r.ok, false, `${key}=${value}`);
    assert.ok(r.issues.some((i) => i.path === `/spec/limits/${key}`), `${key}=${value}`);
  }
  const r = checkSpec(spec({ limits: { testSeconds: 300, runSeconds: 200 } }));
  assert.ok(r.issues.some((i) => i.code === 'LIMIT_TEST_ABOVE_RUN'));
});

test('the image must be pinned by digest, on the class platform, within the unpacked maximum', () => {
  const env = spec().env;
  const bad = [
    [{ ...env, image: 'ghcr.io/verdikta/stake-env:latest' }, '/spec/env/image', 'SCHEMA'],
    [{ ...env, image: '--privileged' }, '/spec/env/image', 'SCHEMA'],
    [{ ...env, image: `ghcr.io/x@sha256:${'a'.repeat(64)} --network=host` }, '/spec/env/image', 'SCHEMA'],
    [{ ...env, platform: 'linux/arm64' }, '/spec/env/platform', 'PLATFORM_NOT_ALLOWED'],
    [{ ...env, unpackedBytes: 6000000001 }, '/spec/env/unpackedBytes', 'IMAGE_ABOVE_CLASS_MAX'],
    [{ ...env, unpackedBytes: 0 }, '/spec/env/unpackedBytes', 'SCHEMA'],
    [undefined, '/spec/env', 'SCHEMA']
  ];
  for (const [value, issuePath, code] of bad) {
    const s = spec({ env: value });
    if (value === undefined) delete s.env;
    const r = checkSpec(s);
    assert.equal(r.ok, false, issuePath);
    assert.ok(r.issues.some((i) => i.path === issuePath && i.code === code), `${issuePath}: ${JSON.stringify(r.issues)}`);
  }
});
