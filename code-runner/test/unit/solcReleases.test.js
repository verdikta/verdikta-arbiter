'use strict';

// Node A2c: the runner's list of official solc releases (owner Q35 condition 2), what it holds and how it is kept current.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { officialList, makeList, SOURCE } = require('../../src/solcReleases');
const { svmEntryProblem } = require('../../src/integrity');
const { upstreamReleases, merged } = require('../../scripts/solc-releases');
const { SOLC } = require('../docker/forgeFixture');

const HEX = /^[0-9a-f]{64}$/;
const list = (o) => makeList({ platform: 'linux/amd64', asOf: '2026-11-02', releases: o });
const h = (c) => c.repeat(64);

test('the table: every release a plain x.y.z with a lowercase SHA-256; the class platform from 0.4.10, arm64 from 0.8.31; no hash twice', () => {
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, '../../src/solcReleases.json'), 'utf8'));
  assert.equal(data.source, 'https://binaries.soliditylang.org');
  assert.match(data.asOf, /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/);
  assert.deepEqual(Object.keys(data.platforms).sort(), ['linux/amd64', 'linux/arm64']);
  for (const [platform, releases] of Object.entries(data.platforms)) {
    const hashes = Object.values(releases);
    assert.ok(hashes.length > 0, platform);
    for (const [v, sha] of Object.entries(releases)) {
      assert.match(v, /^[0-9]+\.[0-9]+\.[0-9]+$/, `${platform} ${v}`);
      assert.match(sha, HEX, `${platform} ${v}`);
    }
    assert.equal(new Set(hashes).size, hashes.length, `${platform}: no hash twice`);
  }
  assert.ok(data.platforms['linux/amd64']['0.4.10']);
  assert.equal(data.platforms['linux/amd64']['0.4.9'], undefined, 'crytic/solc\'s builds, which forge downloads below 0.4.10, are not official');
  assert.ok(data.platforms['linux/arm64']['0.8.31']);
  assert.equal(data.platforms['linux/arm64']['0.8.30'], undefined, 'nikitastupin/solc\'s builds, which forge downloads below 0.8.31 on arm64, are not official');
});

test('the Docker fixtures\' compilers, pinned by SHA-256 from binaries.soliditylang.org, are the table\'s', () => {
  assert.equal(officialList('linux/amd64').releases.get('0.8.31'), SOLC['linux/amd64'].sha256);
  assert.equal(officialList('linux/arm64').releases.get('0.8.31'), SOLC['linux/arm64'].sha256);
});

test('makeList: both ways round, the newest by number, its platform and date; a malformed entry is a programming error', () => {
  const l = list({ '0.8.9': h('a'), '0.8.10': h('b') });
  assert.equal(l.platform, 'linux/amd64');
  assert.equal(l.asOf, '2026-11-02');
  assert.equal(l.newest, '0.8.10');
  assert.equal(l.releases.get('0.8.9'), h('a'));
  assert.equal(l.byHash.get(h('b')), '0.8.10');
  assert.throws(() => list({ '0.8.9': 'nope' }), /0\.8\.9/);
  assert.throws(() => list({ 'v0.8.9': h('a') }), /v0\.8\.9/);
  assert.throws(() => officialList('linux/riscv64'), /linux\/riscv64/);
  assert.equal(SOURCE, 'https://binaries.soliditylang.org');
});

test('svmEntryProblem: the one rule for what may be under svm/', () => {
  const l = list({ '0.8.31': h('a'), '0.8.32': h('b') });
  const f = (hash) => ({ type: 'f', hash });
  assert.equal(svmEntryProblem('0.8.31/solc-0.8.31', f(h('a')), l), null);
  assert.equal(svmEntryProblem('.global-version', f(h('e')), l), null);
  assert.equal(svmEntryProblem('0.8.31/.lock', f(h('e')), l), null);
  assert.equal(svmEntryProblem('0.8.99/.lock', f(h('e')), l), null, 'a marker holds no bytes anything runs');
  assert.match(svmEntryProblem('0.8.31/solc-0.8.31', f(h('b')), l), /is not official 0\.8\.31/);
  assert.match(svmEntryProblem('0.8.31/solc-0.8.31', f(h('c')), l), /is not official 0\.8\.31/);
  assert.match(svmEntryProblem('0.8.33/solc-0.8.33', f(h('a')), l), /0\.8\.33 is not on the list/);
  assert.match(svmEntryProblem('0.8.31/solc-0.8.31', f(null), l), /cannot be read/);
  assert.match(svmEntryProblem('0.8.31/solc-0.8.31', { type: 'l', hash: null }, l), /is a link/);
  assert.match(svmEntryProblem('0.8.31/solc-0.8.31', { type: 'p', hash: null }, l), /not a plain file/);
  assert.match(svmEntryProblem('0.8.31', { type: 'd', hash: null }, l), /cannot be read/);
  for (const rel of ['solc', 'solc-0.8.31', '0.8.31/solc', '0.8.31/solc-0.8.32', 'v0.8.31/solc-0.8.31', '0.8.31-pre.1/solc-0.8.31-pre.1', '0.8.31+x/solc-0.8.31+x', '00.8.31/solc-00.8.31', '0.8.31/x/solc-0.8.31', '.lock', 'x/.lock', '0.8.31/.global-version']) {
    assert.match(svmEntryProblem(rel, f(h('a')), l), /not a file forge's install leaves/, rel);
  }
  // A marker is a plain file or nothing.
  assert.match(svmEntryProblem('.global-version', { type: 'l', hash: null }, l), /is a link/);
});

const LIST_JSON = {
  builds: [
    { path: 'solc-linux-amd64-v0.8.31-pre.1+commit.b59566f6', version: '0.8.31', prerelease: 'pre.1', longVersion: '0.8.31-pre.1+commit.b59566f6', sha256: `0x${h('f')}` },
    { path: 'solc-linux-amd64-v0.8.31+commit.fd3a2265', version: '0.8.31', build: 'commit.fd3a2265', longVersion: '0.8.31+commit.fd3a2265', sha256: `0x${h('a')}` },
    { path: 'solc-linux-amd64-v0.8.32+commit.ebbd65e5', version: '0.8.32', build: 'commit.ebbd65e5', longVersion: '0.8.32+commit.ebbd65e5', sha256: `0x${h('b')}` }
  ],
  releases: { '0.8.32': 'solc-linux-amd64-v0.8.32+commit.ebbd65e5', '0.8.31': 'solc-linux-amd64-v0.8.31+commit.fd3a2265' },
  latestRelease: '0.8.32'
};

test('solc-releases.js: official means named under `releases`, so a prerelease is left out; a list that does not read is an error, never an empty table', () => {
  assert.deepEqual(upstreamReleases(LIST_JSON), { '0.8.31': h('a'), '0.8.32': h('b') });
  assert.throws(() => upstreamReleases({}), /no releases/);
  assert.throws(() => upstreamReleases({ builds: [], releases: {} }), /no releases/);
  assert.throws(() => upstreamReleases({ ...LIST_JSON, releases: { '0.8.33': 'solc-linux-amd64-v0.8.33+commit.x' } }), /0\.8\.33/);
  assert.throws(() => upstreamReleases({ ...LIST_JSON, builds: [{ ...LIST_JSON.builds[1], sha256: 'nope' }, LIST_JSON.builds[2]] }), /0\.8\.31/);
  assert.throws(() => upstreamReleases({ ...LIST_JSON, releases: { 'v0.8.31': LIST_JSON.releases['0.8.31'] } }), /v0\.8\.31/);
});

test('solc-releases.js: an update adds what upstream has; it never changes or drops a hash already in the table', () => {
  const current = { '0.8.31': h('a') };
  assert.deepEqual(merged(current, { '0.8.31': h('a'), '0.8.32': h('b') }), { added: ['0.8.32'], table: { '0.8.31': h('a'), '0.8.32': h('b') } });
  assert.deepEqual(merged(current, { '0.8.31': h('a') }), { added: [], table: { '0.8.31': h('a') } });
  assert.throws(() => merged(current, { '0.8.31': h('c') }), /0\.8\.31.*changed/);
  assert.throws(() => merged(current, { '0.8.32': h('b') }), /0\.8\.31.*no longer/);
});
