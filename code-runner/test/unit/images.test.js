'use strict';

// Acceptance (A1b):
// - pulls only by digest from the registry allowlist, after the unpacked-size
//   admission check; verifies the pulled digest and platform against
//   code_review.json and the attestation
// - LRU eviction inside the data root, never the pinned base images or an
//   image in use
// - unreachable or non-allowlisted registry, failed pull or digest mismatch
//   → abstain (registry-failure, the runner half)
// Review focus: a tag can never be pulled; eviction under concurrent runs.
//
// Driven against an in-memory image store (test/helpers/fakeImages.js);
// test/docker/pull.docker.test.js runs the same paths against registry:2.

const test = require('node:test');
const assert = require('node:assert/strict');
const { ImageCache, needBytes, DEFAULT_PINNED_DIGESTS } = require('../../src/images');
const { Abstain, RequesterError } = require('../../src/result');
const { BASE_IMAGE_PINS } = require('../../src/common');
const { fakeDocker } = require('../helpers/fakeDocker');
const { imageStore, image, virtualDisk } = require('../helpers/fakeImages');
const { testConfig } = require('../helpers/http');

const silent = { info() {}, warn() {}, error() {}, debug() {} };
const D = (c) => c.repeat(64);
const REF = (name, c) => `ghcr.io/verdikta/${name}@sha256:${D(c)}`;
const X = REF('x', 'a');
const PLENTY = async () => ({ bavail: 1e12, bsize: 1 });
const GB = 1000 * 1000 * 1000;

function config(env = {}) {
  return testConfig({ CODE_RUNNER_DATA_ROOT: '/srv/vcr/docker', CODE_RUNNER_DISK_RESERVE_MB: '0', ...env });
}

function cacheFor({ images = [], registry = {}, containers = [], statfs = PLENTY, env, pins, events = [], clock } = {}) {
  const { store, handlers } = imageStore({ images, registry, containers, events });
  const docker = fakeDocker(handlers);
  const cache = new ImageCache({ config: config(env), docker, log: silent, statfs, ...(pins ? { pins } : {}), ...(clock ? { now: clock } : {}) });
  return { cache, store, docker, events };
}

function want(ref, over = {}) {
  return { image: ref, attestedImage: ref, platform: 'linux/amd64', unpackedBytes: 1000, windowMs: 60000, ...over };
}

async function rejectsWith(promise, cls, cause) {
  let err;
  try { await promise; } catch (e) { err = e; }
  assert.ok(err instanceof cls, `expected ${cls.name}, got ${err && err.stack}`);
  if (cause) assert.equal(err.cause, cause, err.detail);
  return err;
}

function tick() {
  return new Promise((r) => setImmediate(r));
}

test('a missing image is pulled by digest after the disk check, then its digest and platform are verified', async () => {
  const events = [];
  const { cache, store, docker } = cacheFor({
    events,
    registry: { [X]: { image: image(X) } },
    statfs: async (dir) => { events.push(`statfs ${dir}`); return { bavail: 1e12, bsize: 1 }; }
  });
  const lease = await cache.acquire(want(X));
  assert.equal(lease.cache, 'pulled');
  assert.equal(lease.ref, X);
  assert.deepEqual(events, ['image inspect', 'statfs /srv/vcr/docker', `pull ${X}`, 'image inspect']);
  assert.deepEqual(store.pulls, [['pull', '--quiet', '--platform', 'linux/amd64', X]]);
  // Every docker argv names the image by its digest reference.
  for (const c of docker.calls) {
    for (const a of c.args) if (a.includes('ghcr.io')) assert.match(a, /@sha256:[0-9a-f]{64}$/);
  }
  lease.release();
});

test('a cached image that matches is used as it is: no pull, no disk check', async () => {
  let measured = false;
  const { cache, store } = cacheFor({ images: [image(X)], statfs: async () => { measured = true; return { bavail: 0, bsize: 1 }; } });
  const lease = await cache.acquire(want(X));
  assert.equal(lease.cache, 'hit');
  assert.equal(store.pulls.length, 0);
  assert.equal(measured, false);
  lease.release();
});

test('the short Docker Hub form in a daemon\'s listing is the same image as its canonical reference', async () => {
  const ref = `docker.io/library/ubuntu@sha256:${D('c')}`;
  const familiar = image(`ubuntu@sha256:${D('c')}`);
  const { cache } = cacheFor({ images: [familiar], env: { CODE_RUNNER_REGISTRY_ALLOWLIST: 'docker.io/library/ubuntu' } });
  // The daemon is asked by canonical name and answers with the familiar one.
  familiar.refs.push(ref);
  const lease = await cache.acquire(want(`ubuntu@sha256:${D('c')}`));
  assert.equal(lease.cache, 'hit');
  assert.equal(lease.ref, ref);
  lease.release();
});

test('a cached image of another platform is pulled again for the platform that runs', async () => {
  const arm = image(X, { id: 'sha256:arm', architecture: 'arm64' });
  const { cache, store } = cacheFor({ images: [arm], registry: { [X]: { image: image(X) } } });
  const lease = await cache.acquire(want(X));
  assert.equal(lease.cache, 'pulled');
  assert.equal(store.pulls.length, 1);
  lease.release();
});

test('the unpacked-size admission: not enough room and nothing to evict refuses before any pull', async () => {
  const { cache, store } = cacheFor({
    registry: { [X]: { image: image(X) } },
    statfs: async () => ({ bavail: 5 * GB, bsize: 1 }),
    env: { CODE_RUNNER_DISK_RESERVE_MB: '1024' }
  });
  const err = await rejectsWith(cache.acquire(want(X, { unpackedBytes: 3 * GB })), Abstain, 'admission_refused');
  assert.equal(err.step, 'pull');
  assert.match(err.detail, /5000000000 bytes free/);
  assert.match(err.detail, /needs 5000000000/, 'the need: unpacked plus its compressed layers');
  assert.equal(store.pulls.length, 0);
  // Unpacked plus the compressed layers being extracted (at most the class's 2 GB), plus the reserve.
  assert.equal(needBytes(3 * GB), 3 * GB + 2 * GB);
  assert.equal(needBytes(1000), 2000);
});

test('registry-failure (runner half): a registry not on the allowlist abstains before any Docker call', async () => {
  const other = `ghcr.io/evil/x@sha256:${D('a')}`;
  const { cache, docker } = cacheFor({ registry: { [other]: { image: image(other) } } });
  const err = await rejectsWith(cache.acquire(want(other)), Abstain, 'registry_not_allowed');
  assert.equal(err.step, 'pull');
  assert.match(err.detail, /ghcr\.io\/evil\/x/);
  assert.match(err.detail, /ghcr\.io\/verdikta/);
  assert.equal(docker.calls.length, 0);
});

test('registry-failure (runner half): an unreachable registry, a failed pull or a pull past its timeout abstains', async () => {
  const unreachable = cacheFor({ registry: { [X]: { fail: 'Error response from daemon: Get "https://ghcr.io/v2/": dial tcp 140.82.1.1:443: connect: connection refused' } } });
  const e1 = await rejectsWith(unreachable.cache.acquire(want(X)), Abstain, 'pull_failed');
  assert.match(e1.detail, /connection refused/);
  assert.equal(unreachable.cache.status().pullsInFlight, 0);

  const unknown = cacheFor({});
  const e2 = await rejectsWith(unknown.cache.acquire(want(X)), Abstain, 'pull_failed');
  assert.match(e2.detail, /manifest unknown/);

  const slow = cacheFor({ registry: { [X]: { hang: true } }, env: { CODE_RUNNER_PULL_TIMEOUT_SECONDS: '1' } });
  const e3 = await rejectsWith(slow.cache.acquire(want(X)), Abstain, 'pull_failed');
  assert.match(e3.detail, /did not finish/);

  const noDaemon = cacheFor({ registry: { [X]: { fail: 'Cannot connect to the Docker daemon at unix:///run/vcr.sock. Is the docker daemon running?' } } });
  await rejectsWith(noDaemon.cache.acquire(want(X)), Abstain, 'docker_unreachable');
});

test('a pull that reports success without the image on the disk abstains', async () => {
  const wrong = `ghcr.io/verdikta/x@sha256:${D('f')}`;
  // The daemon says the pull worked, but no image carries the reference asked for.
  const { cache, store } = cacheFor({ registry: { [X]: { image: image(wrong) } } });
  const err = await rejectsWith(cache.acquire(want(X)), Abstain, 'pull_failed');
  assert.match(err.detail, /not on the disk/);
  assert.equal(store.pulls.length, 1);
  assert.equal(cache.status().inUse, 0);
});

test('the pulled image must be of the platform that runs, and the attestation must name the image code_review.json names', async () => {
  // A single-platform image of another architecture pulls fine and must not run.
  const s390 = cacheFor({ registry: { [X]: { image: image(X, { architecture: 's390x' }) } } });
  const e1 = await rejectsWith(s390.cache.acquire(want(X)), Abstain, 'image_mismatch');
  assert.match(e1.detail, /linux\/s390x/);
  assert.match(e1.detail, /linux\/amd64/);
  assert.equal(s390.cache.status().inUse, 0);

  // arm64's v8 variant is plain linux/arm64 (runc development on Apple silicon).
  const arm = cacheFor({ images: [image(X, { architecture: 'arm64', variant: 'v8' })] });
  const lease = await arm.cache.acquire(want(X, { platform: 'linux/arm64' }));
  assert.equal(lease.cache, 'hit');
  lease.release();

  const fresh = cacheFor({ images: [image(X)] });
  await rejectsWith(fresh.cache.acquire(want(X, { attestedImage: REF('x', 'b') })), RequesterError);
  assert.equal(fresh.docker.calls.length, 0);
});

test('a reference that resolves to an image without that digest is a mismatch', async () => {
  const other = `ghcr.io/verdikta/x@sha256:${D('e')}`;
  const { store, handlers } = imageStore({ images: [image(other)] });
  // A daemon that resolves X to the image carrying only `other`.
  const inspect = handlers.image;
  handlers.image = (args) => {
    if (args[1] === 'inspect') return inspect(args.map((a) => (a === X ? other : a)));
    return inspect(args);
  };
  const cache = new ImageCache({ config: config(), docker: fakeDocker(handlers), log: silent, statfs: PLENTY });
  const err = await rejectsWith(cache.acquire(want(X)), Abstain, 'image_mismatch');
  assert.match(err.detail, new RegExp(D('a')));
  assert.equal(store.pulls.length, 0, 'a cached image that does not match is refused without being run');
});

// ---- LRU eviction -------------------------------------------------------

const A = REF('a', '1');
const B = REF('b', '2');
const C = REF('c', '3');
const U = REF('u', '4');
const P = `ghcr.io/verdikta/base@sha256:${D('5')}`;

/** A store with A, B, C used in that order, P pinned, U used by a container, plus images that are not the runner's. */
async function lruSetup({ capacity, extra = {} } = {}) {
  let t = 0;
  const clock = () => { t += 1; return t; };
  const foreign = image(`docker.io/library/postgres@sha256:${D('6')}`);
  const dangling = { ...image('dangling'), refs: [] };
  const mixed = image(`ghcr.io/verdikta/m@sha256:${D('7')}`);
  mixed.refs.push(`docker.io/acme/m:latest`);
  const images = [image(A), image(B), image(C), image(U), image(P), foreign, dangling, mixed];
  const perImage = 2000;
  const fx = cacheFor({
    images,
    containers: [images[3].id],
    registry: { [X]: { image: image(X) }, [REF('y', 'b')]: { image: image(REF('y', 'b')) } },
    pins: [`sha256:${D('5')}`],
    clock,
    ...extra
  });
  fx.cache.statfs = virtualDisk(fx.store, { capacity: capacity === undefined ? images.length * perImage : capacity, perImage });
  for (const ref of [A, B, C]) (await fx.cache.acquire(want(ref))).release();
  return { ...fx, perImage, images };
}

const present = (store, ref) => store.images.some((i) => i.refs.includes(ref));

test('LRU eviction frees the data root least recently used first, and only as much as the pull needs', async () => {
  const { cache, store } = await lruSetup();
  // Full disk: X (needs 2000) evicts A, the least recently used, and stops.
  const lease = await cache.acquire(want(X));
  assert.equal(lease.cache, 'pulled');
  assert.equal(present(store, A), false);
  for (const ref of [B, C, U, P, X]) assert.ok(present(store, ref), ref);
  lease.release();
  // The next pull takes B (C was used after it).
  const y = await cache.acquire(want(REF('y', 'b')));
  assert.equal(present(store, B), false);
  assert.ok(present(store, C));
  y.release();
});

test('LRU eviction never removes a pinned base image, an image a container uses, an image that is not the runner\'s, or a dangling one', async () => {
  const { cache, store, images } = await lruSetup();
  // Make room for X by evicting all of A, B and C; the rest must survive.
  cache.statfs = virtualDisk(store, { capacity: images.length * 2000 - 2000, perImage: 2000 });
  const err = await rejectsWith(cache.acquire(want(X, { unpackedBytes: 4000 })), Abstain, 'admission_refused');
  assert.match(err.detail, /nothing more can be evicted/);
  for (const ref of [A, B, C]) assert.equal(present(store, ref), false, `${ref} evicted`);
  assert.ok(present(store, P), 'the pinned base image stays');
  assert.ok(present(store, U), 'the image a container uses stays');
  assert.ok(present(store, `docker.io/library/postgres@sha256:${D('6')}`), 'a non-allowlisted image stays');
  assert.ok(present(store, `ghcr.io/verdikta/m@sha256:${D('7')}`), 'an image with a reference outside the allowlist stays');
  assert.equal(store.images.filter((i) => i.refs.length === 0).length, 1, 'the dangling image stays');
  assert.equal(store.pulls.length, 0);
});

test('the base images pinned in @verdikta/common are never evicted by default', () => {
  const pin = BASE_IMAGE_PINS.foundry;
  assert.ok(DEFAULT_PINNED_DIGESTS.includes(pin.digest));
  assert.ok(DEFAULT_PINNED_DIGESTS.includes(pin.indexDigest));
});

test('an image in use by a run is never evicted; once released it is a candidate again', async () => {
  const { cache, store } = await lruSetup();
  const holdA = await cache.acquire(want(A));
  const x = await cache.acquire(want(X));
  assert.ok(present(store, A), 'A is in use');
  assert.equal(present(store, B), false, 'B, the next least recently used, went instead');
  x.release();
  holdA.release();
  holdA.release(); // idempotent
  const y = await cache.acquire(want(REF('y', 'b')));
  assert.equal(present(store, C), false, 'C (used before A was used again) is evicted next');
  assert.ok(present(store, A));
  y.release();
});

test('eviction under concurrent runs: a pull in flight holds its space and its image; the second run evicts or is refused', async () => {
  let finish;
  const wait = new Promise((r) => { finish = r; });
  const Y = REF('y', 'b');
  const { cache, store } = await lruSetup({ extra: {} });
  store.registry[X] = { image: image(X), wait };
  // Free space for exactly one more image beyond what is there.
  cache.statfs = virtualDisk(store, { capacity: (store.images.length + 1) * 2000, perImage: 2000 });
  const first = cache.acquire(want(X));
  while (cache.status().pullsInFlight === 0) await tick();
  assert.equal(cache.status().pendingBytes, 2000, 'the first pull reserved its space');
  // The second run cannot count the first's space as free: it must evict A.
  const second = await cache.acquire(want(Y));
  assert.equal(present(store, A), false);
  assert.ok(present(store, B) && present(store, C));
  finish();
  const x = await first;
  assert.equal(x.cache, 'pulled');
  // Both images are in use: nothing of theirs is evicted for a third.
  cache.statfs = virtualDisk(store, { capacity: store.images.length * 2000, perImage: 2000 });
  store.registry[REF('z', 'c')] = { image: image(REF('z', 'c')) };
  const third = await cache.acquire(want(REF('z', 'c')));
  assert.ok(present(store, X) && present(store, Y), 'images in use survive');
  assert.equal(present(store, B), false, 'B was evicted instead');
  for (const l of [second, x, third]) l.release();
});

test('two runs that need the same image share one pull and one reservation', async () => {
  let finish;
  const wait = new Promise((r) => { finish = r; });
  const { cache, store } = cacheFor({ registry: { [X]: { image: image(X), wait } } });
  const one = cache.acquire(want(X));
  const two = cache.acquire(want(X));
  while (cache.status().pullsInFlight === 0) await tick();
  await tick();
  assert.equal(cache.status().pendingBytes, 2000);
  finish();
  const [a, b] = await Promise.all([one, two]);
  assert.deepEqual([a.cache, b.cache].sort(), ['pulled', 'shared']);
  assert.equal(store.pulls.length, 1);
  assert.equal(cache.status().inUse, 1);
  a.release();
  assert.equal(cache.status().inUse, 1);
  b.release();
  assert.equal(cache.status().inUse, 0);
});

test('a run whose time runs out while it waits for a pull abstains; the pull carries on for the others', async () => {
  let finish;
  const wait = new Promise((r) => { finish = r; });
  const { cache, store } = cacheFor({ registry: { [X]: { image: image(X), wait } } });
  const err = await rejectsWith(cache.acquire(want(X, { windowMs: 50 })), Abstain, 'pull_failed');
  assert.match(err.detail, /did not finish in the time/);
  assert.equal(cache.status().pullsInFlight, 1, 'the pull was not cancelled');
  assert.equal(cache.status().inUse, 0, 'the run that gave up holds nothing');
  const later = cache.acquire(want(X));
  finish();
  const lease = await later;
  assert.equal(lease.cache, 'shared');
  assert.equal(store.pulls.length, 1);
  lease.release();

  const ac = new AbortController();
  const hung = cacheFor({ registry: { [X]: { hang: true } } });
  const p = hung.cache.acquire(want(X, { signal: ac.signal }));
  while (hung.cache.status().pullsInFlight === 0) await tick();
  ac.abort('cancel');
  await rejectsWith(p, Abstain, 'cancelled');
  hung.cache.close();
});

test('free space that cannot be measured refuses a pull under runsc and is allowed, with a warning, under runc', async () => {
  const enoent = async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); };
  const runsc = cacheFor({ registry: { [X]: { image: image(X) } }, statfs: enoent, env: { CODE_RUNNER_RUNTIME: 'runsc' } });
  const err = await rejectsWith(runsc.cache.acquire(want(X)), Abstain, 'admission_refused');
  assert.match(err.detail, /could not be measured/);
  assert.equal(runsc.store.pulls.length, 0);

  const warned = [];
  const { store, handlers } = imageStore({ registry: { [X]: { image: image(X) } } });
  const runc = new ImageCache({ config: config(), docker: fakeDocker(handlers), statfs: enoent,
    log: { ...silent, warn: (msg) => warned.push(msg) } });
  const lease = await runc.acquire(want(X));
  assert.equal(lease.cache, 'pulled');
  assert.equal(store.pulls.length, 1);
  assert.ok(warned.some((m) => /free space/.test(m)));
  lease.release();
});

test('status() reports the allowlist, the images in use and the pulls in flight', async () => {
  const { cache } = cacheFor({ images: [image(X)], env: { CODE_RUNNER_REGISTRY_ALLOWLIST: 'ghcr.io/verdikta,127.0.0.1:5000' } });
  const lease = await cache.acquire(want(X));
  assert.deepEqual(cache.status(), {
    allowlist: [{ entry: 'ghcr.io/verdikta', dev: false }, { entry: '127.0.0.1:5000', dev: true }],
    inUse: 1,
    pullsInFlight: 0,
    pendingBytes: 0
  });
  lease.release();
});
