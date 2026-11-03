'use strict';

// Node A3b: the runner reads its hard limits, the pinned image digest, the
// platform, the fuzz seed, the gVisor and Semgrep versions and the test-paths
// gate from @verdikta/common, pinned exactly to the same prerelease as the EA,
// the AI Node and e2e (external-adapter's commonPin.test.js checks the four
// agree). The A1/A2a local copies are gone.

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

test('the hard limits, the platform and the rule versions are the package\'s own objects', () => {
  const { codeReview } = require('@verdikta/common');
  const { CLASS_HARD_LIMITS, SPEC_LIMIT_MAXIMA, OCI_PLATFORM } = require('../../src/classLimits');
  assert.equal(common.CLASS_HARD_LIMITS, codeReview.CLASS_HARD_LIMITS);
  assert.equal(CLASS_HARD_LIMITS, codeReview.CLASS_HARD_LIMITS);
  assert.equal(SPEC_LIMIT_MAXIMA, codeReview.SPEC_LIMIT_MAXIMA);
  assert.equal(OCI_PLATFORM, codeReview.OCI_PLATFORM);
  assert.equal(common.OCI_PLATFORM, codeReview.OCI_PLATFORM);
  assert.equal(common.GVISOR_RELEASE, codeReview.GVISOR_RELEASE);
  assert.equal(common.SEMGREP_RULES_VERSION, codeReview.SEMGREP_RULES_VERSION);
  assert.equal(common.getCodeClass('code-standard').envelope.contextPackTokens, codeReview.getCodeClass('code-standard').envelope.contextPackTokens);
});

test('the spec\'s minima and the image pattern come from common\'s schema', () => {
  const schema = require('@verdikta/common/schemas/code_review.v1.json');
  const { SPEC_LIMIT_MINIMA, IMAGE_REF } = require('../../src/classLimits');
  for (const [key, def] of Object.entries(schema.definitions.Limits.properties)) assert.equal(SPEC_LIMIT_MINIMA[key], def.minimum, key);
  assert.equal(IMAGE_REF.source, new RegExp(schema.definitions.Env.properties.image.pattern).source);
});

test('no local copy is left in src/: not the limits, the platform, the seed, the pins or a glob matcher', () => {
  const SRC = path.join(ROOT, 'src');
  const LOCAL = [
    [/\bcpus:\s*2\b/, 'the class CPU limit'],
    [/\bmemoryMb:\s*4096\b/, 'the class memory limit'],
    [/\bimageUnpackedBytes:\s*6000000000\b/, 'the unpacked image limit'],
    [/OCI_PLATFORM\s*=\s*['"]/, 'the platform'],
    [/['"]0x76657264696b7461['"]/, 'the fuzz seed'],
    [/sha256:f00b023f/, 'the base image digest'],
    [/release-2026[0-9]{4}/, 'the gVisor release'],
    [/['"]2026\.[0-9]+['"]/, 'the Semgrep rule set'],
    [/function\s+(?:matchesAny|globToRegExp|compileGlob|pocPatchPathsGate)\b/, 'a glob matcher or the path gate']
  ];
  for (const name of fs.readdirSync(SRC).filter((f) => f.endsWith('.js'))) {
    const code = fs.readFileSync(path.join(SRC, name), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
    for (const [re, what] of LOCAL) assert.doesNotMatch(code, re, `${name} holds its own copy of ${what}`);
  }
});

test('the report limits the runner cuts to are common\'s', () => {
  const { REPORT_LIMITS, POC_RUNS } = require('@verdikta/common/src/codeReview/report');
  const claim = require('../../src/claim');
  assert.equal(claim.RUNS, POC_RUNS);
  assert.equal(common.REPORT_LIMITS, REPORT_LIMITS);
});

test('poc-patch-edits-source: the catalogue\'s case, by id, settles the same through common\'s helper and through the runner\'s pipeline', async () => {
  const { codeReview } = require('@verdikta/common');
  const entry = codeReview.loadFixtures().cases.find((c) => c.id === 'poc-patch-edits-source');
  assert.equal(entry.common.helper, 'pocPatchPathsGate');
  assert.equal(entry.common.status, 'implemented');
  assert.equal(entry.settles, 'INVALID');

  const { claimSandbox } = require('../helpers/fakeClaim');
  const { claimRequest, runClaim } = require('../helpers/claimRun');
  const { buildReport } = require('../../src/report');
  const request = claimRequest();
  const touched = ['src/Vault.sol', 'test/Exploit.t.sol'];
  const helper = codeReview.pocPatchPathsGate(touched, request.spec);
  assert.deepEqual(helper, { pass: false, outside: ['src/Vault.sol'], protected: [] });
  assert.equal(common.pocPatchPathsGate, codeReview.pocPatchPathsGate, 'the same function, not a copy');

  const r = await runClaim(claimSandbox({ git: { 'diff --name-status': () => ({ stdout: Buffer.from(touched.map((p) => `A\0${p}\0`).join('')) }) } }), request);
  assert.equal(r.gates.testPathsOnly.status, 'fail', 'testPathsOnly fails, as the catalogue says');
  assert.match(r.gates.testPathsOnly.detail, /src\/Vault\.sol outside paths\.tests/);
  const { report } = buildReport(r, request, { gvisor: 'runc', platform: 'linux/amd64' });
  assert.equal(report.gates.testPathsOnly, 'fail');
  assert.equal(report.poc, null);
  assert.equal(r.contextPack, null, 'a patch that edits source has no pack: it never reaches a jury');
});
