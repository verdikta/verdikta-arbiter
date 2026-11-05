'use strict';

// Acceptance (A1b): the runner pulls only by digest, and only from the
// registry allowlist (default ghcr.io/verdikta; a local registry:2 only as an
// explicit dev entry). Review focus: a tag or mutable reference can never be
// pulled.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseImageRef, parseAllowlist, allowedBy, pullArgs, DEFAULT_REGISTRY_ALLOWLIST
} = require('../../src/registry');

const D = 'a'.repeat(64);
const E = 'b'.repeat(64);

test('an image reference is parsed and normalised the way Docker resolves it', () => {
  const ghcr = parseImageRef(`ghcr.io/verdikta/stake-env@sha256:${D}`);
  assert.deepEqual(ghcr, {
    domain: 'ghcr.io', path: 'verdikta/stake-env', tag: null, digest: `sha256:${D}`,
    repository: 'ghcr.io/verdikta/stake-env', canonical: `ghcr.io/verdikta/stake-env@sha256:${D}`
  });
  // No registry host: Docker Hub, and a single name is an official image.
  assert.equal(parseImageRef(`ubuntu@sha256:${D}`).canonical, `docker.io/library/ubuntu@sha256:${D}`);
  assert.equal(parseImageRef(`acme/env@sha256:${D}`).canonical, `docker.io/acme/env@sha256:${D}`);
  assert.equal(parseImageRef(`index.docker.io/acme/env@sha256:${D}`).canonical, `docker.io/acme/env@sha256:${D}`);
  // A host is a first component with a dot or a port, or localhost.
  assert.equal(parseImageRef(`127.0.0.1:5000/vcr/env@sha256:${D}`).domain, '127.0.0.1:5000');
  assert.equal(parseImageRef(`localhost/env@sha256:${D}`).domain, 'localhost');
  assert.equal(parseImageRef(`localhost:5000/env@sha256:${D}`).repository, 'localhost:5000/env');
});

test('a tag or any other mutable reference is not an image the runner can pull', () => {
  const refused = [
    'ghcr.io/verdikta/stake-env',
    'ghcr.io/verdikta/stake-env:latest',
    `ghcr.io/verdikta/stake-env:v1@sha256:${D}`,
    `ghcr.io/verdikta/stake-env@sha256:${D.slice(1)}`,
    `ghcr.io/verdikta/stake-env@sha512:${D}${D}`,
    `ghcr.io/verdikta/stake-env@sha256:${D.toUpperCase()}`,
    `GHCR.io/verdikta/stake-env@sha256:${D}`,
    `ghcr.io/Verdikta/stake-env@sha256:${D}`,
    `https://ghcr.io/verdikta/stake-env@sha256:${D}`,
    `ghcr.io//stake-env@sha256:${D}`,
    `ghcr.io/verdikta/stake-env/@sha256:${D}`,
    `-ghcr.io/verdikta/stake-env@sha256:${D}`,
    `ghcr.io/verdikta/stake-env@sha256:${D} `,
    `ghcr.io/verdikta/stake-env@sha256:${D}\n`,
    `ghcr.io/verdikta/../env@sha256:${D}`,
    `ghcr.io/verdikta/stake-env@sha256:${D}@sha256:${E}`,
    `a/b:123/c@sha256:${D}`,
    `${'a'.repeat(256)}@sha256:${D}`,
    '',
    42,
    null
  ];
  for (const ref of refused) {
    assert.throws(() => parseImageRef(ref), TypeError, JSON.stringify(ref));
  }
  // A daemon listing holds tags too; they parse, but only as references, never as something to pull.
  const tagged = parseImageRef('ghcr.io/verdikta/stake-env:latest', { digestRequired: false });
  assert.equal(tagged.tag, 'latest');
  assert.equal(tagged.digest, null);
  assert.equal(tagged.canonical, null);
  assert.throws(() => pullArgs('ghcr.io/verdikta/stake-env:latest', 'linux/amd64'), TypeError);
});

test('the pull argv names the canonical digest reference and the platform, nothing else', () => {
  assert.deepEqual(pullArgs(`ghcr.io/verdikta/stake-env@sha256:${D}`, 'linux/amd64'),
    ['pull', '--quiet', '--platform', 'linux/amd64', `ghcr.io/verdikta/stake-env@sha256:${D}`]);
  // A short form is pulled by the name Docker would resolve it to.
  assert.deepEqual(pullArgs(`ubuntu@sha256:${D}`, 'linux/arm64'),
    ['pull', '--quiet', '--platform', 'linux/arm64', `docker.io/library/ubuntu@sha256:${D}`]);
  for (const bad of ['ghcr.io/verdikta/stake-env', 'ghcr.io/verdikta/stake-env:v1', `ghcr.io/verdikta/stake-env:v1@sha256:${D}`, `--all-tags@sha256:${D}`]) {
    assert.throws(() => pullArgs(bad, 'linux/amd64'), TypeError, bad);
  }
  assert.throws(() => pullArgs(`ghcr.io/verdikta/stake-env@sha256:${D}`, 'linux/s390x'), TypeError);
  assert.throws(() => pullArgs(`ghcr.io/verdikta/stake-env@sha256:${D}`, '--all-tags'), TypeError);
});

test('the default allowlist is ghcr.io/verdikta, matched on whole path components', () => {
  assert.equal(DEFAULT_REGISTRY_ALLOWLIST, 'ghcr.io/verdikta');
  const { entries, problems } = parseAllowlist(DEFAULT_REGISTRY_ALLOWLIST);
  assert.deepEqual(problems, []);
  assert.deepEqual(entries, [{ entry: 'ghcr.io/verdikta', domain: 'ghcr.io', path: 'verdikta', dev: false }]);
  const ok = (ref) => allowedBy(parseImageRef(ref), entries);
  assert.ok(ok(`ghcr.io/verdikta/stake-env@sha256:${D}`));
  assert.ok(ok(`ghcr.io/verdikta/team/stake-env@sha256:${D}`));
  assert.equal(ok(`ghcr.io/verdikta-evil/stake-env@sha256:${D}`), null, 'a prefix that is not a whole component');
  assert.equal(ok(`ghcr.io/other/stake-env@sha256:${D}`), null);
  assert.equal(ok(`ghcr.io.evil.example/verdikta/stake-env@sha256:${D}`), null);
  assert.equal(ok(`ghcr.io:443/verdikta/stake-env@sha256:${D}`), null, 'the host and port are matched exactly');
  assert.equal(ok(`verdikta/stake-env@sha256:${D}`), null, 'Docker Hub is another registry');
  assert.equal(ok(`127.0.0.1:5000/verdikta/stake-env@sha256:${D}`), null);
});

test('a local registry is allowed only as an explicit entry, marked dev', () => {
  const { entries, problems } = parseAllowlist(' ghcr.io/verdikta , 127.0.0.1:5000 ,localhost:5001/vcr\n[::1]:5002/x ');
  assert.deepEqual(problems, []);
  assert.deepEqual(entries.map((e) => [e.entry, e.dev]), [
    ['ghcr.io/verdikta', false], ['127.0.0.1:5000', true], ['localhost:5001/vcr', true], ['[::1]:5002/x', true]
  ]);
  assert.ok(allowedBy(parseImageRef(`127.0.0.1:5000/anything/at/all@sha256:${D}`), entries), 'a registry-wide entry');
  assert.equal(allowedBy(parseImageRef(`127.0.0.1:5001/x@sha256:${D}`), entries), null, 'another port');
  assert.ok(allowedBy(parseImageRef(`localhost:5001/vcr/env@sha256:${D}`), entries));
  assert.equal(allowedBy(parseImageRef(`localhost:5001/other@sha256:${D}`), entries), null);
});

test('an allowlist entry names a registry host and an optional repository prefix, nothing more', () => {
  for (const bad of [
    'ghcr.io/verdikta:latest', `ghcr.io/verdikta@sha256:${D}`, 'https://ghcr.io/verdikta', 'ghcr.io/verdikta/',
    'ghcr.io/*', '*', 'verdikta', 'ghcr.io//verdikta', 'GHCR.io/verdikta', 'ghcr.io/Verdikta', 'ghcr.io/verdikta?x'
  ]) {
    const r = parseAllowlist(bad);
    assert.equal(r.entries.length, 0, bad);
    assert.equal(r.problems.length, 1, bad);
  }
  assert.equal(parseAllowlist('').problems.length, 1, 'an empty allowlist would refuse every pull');
  // docker.io must be named explicitly, and index.docker.io is the same registry.
  const hub = parseAllowlist('index.docker.io/acme');
  assert.deepEqual(hub.entries.map((e) => e.entry), ['docker.io/acme']);
  assert.ok(allowedBy(parseImageRef(`acme/env@sha256:${D}`), hub.entries));
});
