'use strict';

// Node A1b against a real daemon and a local registry:2 (test/docker/registry.js):
// - pulls only by digest, from the allowlist (here an explicit dev entry for
//   the local registry), after the size check; the pulled digest and
//   platform are verified before anything runs
// - registry-failure, the runner half: an unreachable or non-allowlisted
//   registry, a failed pull, a digest the registry serves wrong bytes for
//   and an image of another platform all abstain, and nothing runs
// - LRU eviction on the daemon: never a pinned base image, an image a run
//   holds or an image a container uses
// - one execution slot: a second run while one is in flight is refused
// Under runc locally; CI runs this file under runc and under gVisor (runsc).

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createServer } = require('../../src/server');
const { ImageCache } = require('../../src/images');
const { runText } = require('../../src/docker');
const { request } = require('../helpers/http');
const { runRequest, spec, attestationFor } = require('../helpers/requests');
const { PLATFORM, TEST_IMAGE, silent, instanceId, dockerTestConfig, dockerFor, ensureTestImage, leftovers, removeAll } = require('./helpers');
const { startRegistry } = require('./registry');

const TIMEOUT = 600000;
const OTHER_PLATFORM = PLATFORM === 'linux/s390x' ? 'linux/ppc64le' : 'linux/s390x';
const meminfo = async () => ({ availableMb: 1e6, error: null });
const roomy = async () => ({ bavail: 1e12, bsize: 1 });

/** One registry for the file; each test uses its own repositories under it. */
const instance = instanceId();
const base = dockerTestConfig();
const builder = dockerFor(base);
let registryP = null;
function registry() {
  if (!registryP) registryP = startRegistry(builder, instance);
  return registryP;
}
test.after(async () => {
  if (registryP) await (await registryP).remove();
});

function body(image, over = {}) {
  const s = spec({
    env: { image, from: 'foundry', platform: 'linux/amd64', unpackedBytes: 200000000 },
    limits: { cpus: 1, memoryMb: 512, runSeconds: 120, testSeconds: 60 }
  });
  return runRequest({ spec: s, attestation: attestationFor(s), ...over });
}

async function serve(t, { allowlist, stepsFor = () => [], env = {}, statfs = roomy } = {}) {
  const config = dockerTestConfig({ ...(allowlist ? { CODE_RUNNER_REGISTRY_ALLOWLIST: allowlist } : {}), ...env });
  const docker = dockerFor(config);
  t.after(() => removeAll(docker, config.instance).catch(() => {}));
  const runner = createServer({ config, docker, log: silent, stepsFor, statfs, meminfo });
  const address = await runner.listen();
  t.after(() => runner.close());
  return { config, docker, runner, target: { host: address.host, port: address.port } };
}

const newRequests = async (reg, since) => (await reg.manifestRequests()).slice(since);

test('pulls by digest from an explicit dev registry entry, verifies it and runs it; the registry only ever sees digests', { timeout: TIMEOUT }, async (t) => {
  const reg = await registry();
  await ensureTestImage(builder);
  const repo = `vcr-${instance}/runs`;
  const image = await reg.push({ repo, from: TEST_IMAGE, content: 'pulled-by-digest' });
  assert.equal(await reg.has(image), false, 'the image is not on the daemon before the run');
  const before = (await reg.manifestRequests()).length;
  const seen = [];
  const { docker, config, target } = await serve(t, {
    allowlist: `ghcr.io/verdikta,${reg.host}/vcr-${instance}`,
    stepsFor: () => [async (ctx) => { seen.push((await ctx.exec(['cat', '/marker'], { name: 'marker', timeoutMs: 30000 })).stdout.text.trim()); }]
  });
  const first = await request(target, { method: 'POST', path: '/v1/runs', body: body(image) });
  assert.equal(first.status, 200, first.raw);
  assert.equal(first.body.outcome, 'definitive');
  assert.equal(first.body.image.cache, 'pulled');
  assert.equal(first.body.image.ref, image);
  assert.deepEqual(seen, ['pulled-by-digest'], 'the sandbox ran the pulled image');
  assert.ok(await reg.has(image), 'the image stays cached');
  const requests = await newRequests(reg, before);
  assert.ok(requests.length > 0, 'the daemon asked the registry');
  for (const r of requests) assert.match(r.reference, /^sha256:[0-9a-f]{64}$/, `a manifest request by ${r.method} ${r.reference}`);
  // Cached: the second run neither asks the registry nor pulls.
  const again = (await reg.manifestRequests()).length;
  const second = await request(target, { method: 'POST', path: '/v1/runs', body: body(image) });
  assert.equal(second.status, 200, second.raw);
  assert.equal(second.body.image.cache, 'hit');
  assert.equal((await reg.manifestRequests()).length, again);
  assert.deepEqual(seen, ['pulled-by-digest', 'pulled-by-digest']);
  assert.deepEqual(await leftovers(docker, config.instance), []);
});

test('registry-failure (runner half): a registry not on the allowlist abstains and is never contacted', { timeout: TIMEOUT }, async (t) => {
  const reg = await registry();
  const image = await reg.push({ repo: `vcr-${instance}/not-allowed` });
  const before = (await reg.manifestRequests()).length;
  const { docker, config, target } = await serve(t, {});
  const res = await request(target, { method: 'POST', path: '/v1/runs', body: body(image) });
  assert.equal(res.status, 503, res.raw);
  assert.equal(res.body.abstain.cause, 'registry_not_allowed');
  assert.deepEqual(await newRequests(reg, before), [], 'no request reached the registry');
  assert.equal(await reg.has(image), false);
  assert.deepEqual(await leftovers(docker, config.instance), [], 'no sandbox was made');
});

test('registry-failure (runner half): an unreachable registry and a digest the registry lacks abstain pull_failed', { timeout: TIMEOUT }, async (t) => {
  // A registry that answered once and is gone: its port refuses connections.
  const gone = await startRegistry(builder, `${instance}-gone`);
  t.after(() => gone.remove());
  const image = await gone.push({ repo: `vcr-${instance}/gone` });
  await gone.stop();
  const a = await serve(t, { allowlist: gone.host });
  const res = await request(a.target, { method: 'POST', path: '/v1/runs', body: body(image) });
  assert.equal(res.status, 503, res.raw);
  assert.equal(res.body.abstain.cause, 'pull_failed');
  assert.equal(res.body.abstain.step, 'pull');
  assert.deepEqual(await leftovers(a.docker, a.config.instance), []);

  const reg = await registry();
  const missing = `${reg.host}/vcr-${instance}/missing@sha256:${crypto.randomBytes(32).toString('hex')}`;
  const b = await serve(t, { allowlist: reg.host });
  const res2 = await request(b.target, { method: 'POST', path: '/v1/runs', body: body(missing) });
  assert.equal(res2.status, 503, res2.raw);
  assert.equal(res2.body.abstain.cause, 'pull_failed');
  assert.deepEqual(await leftovers(b.docker, b.config.instance), []);
});

test('digest mismatch: a registry serving bytes that do not hash to the digest makes the pull fail; the run abstains', { timeout: TIMEOUT }, async (t) => {
  const reg = await registry();
  const image = await reg.push({ repo: `vcr-${instance}/corrupt` });
  await reg.corrupt(image.split('@')[1]);
  const { docker, config, target } = await serve(t, { allowlist: reg.host });
  const res = await request(target, { method: 'POST', path: '/v1/runs', body: body(image) });
  assert.equal(res.status, 503, res.raw);
  assert.equal(res.body.abstain.cause, 'pull_failed');
  assert.match(res.body.abstain.detail, /digest|verif/i);
  assert.equal(await reg.has(image), false, 'nothing was stored under the digest');
  assert.deepEqual(await leftovers(docker, config.instance), []);
});

test('an image of another platform pulls, fails verification and is never run (image_mismatch)', { timeout: TIMEOUT }, async (t) => {
  const reg = await registry();
  const image = await reg.push({ repo: `vcr-${instance}/foreign`, platform: OTHER_PLATFORM });
  const { docker, config, target } = await serve(t, { allowlist: reg.host });
  const res = await request(target, { method: 'POST', path: '/v1/runs', body: body(image) });
  assert.equal(res.status, 503, res.raw);
  assert.equal(res.body.abstain.cause, 'image_mismatch');
  assert.match(res.body.abstain.detail, new RegExp(OTHER_PLATFORM));
  assert.deepEqual(await leftovers(docker, config.instance), [], 'no sandbox was made');
});

test('LRU eviction on the daemon: never a pinned base image, an image a run holds or an image a container uses', { timeout: TIMEOUT }, async (t) => {
  const reg = await registry();
  const names = ['lru-a', 'lru-b', 'lru-e', 'lru-c', 'lru-d', 'lru-f'];
  const refs = {};
  for (const n of names) refs[n] = await reg.push({ repo: `vcr-${instance}/${n}` });
  const [A, B, E, C, D, F] = names.map((n) => refs[n]);
  const config = dockerTestConfig({ CODE_RUNNER_REGISTRY_ALLOWLIST: `${reg.host}/vcr-${instance}`, CODE_RUNNER_DISK_RESERVE_MB: '0' });
  const docker = dockerFor(config);
  // A virtual disk: each of this test's images present takes SLOT bytes.
  const SLOT = 1000000;
  let capacity = 0;
  const statfs = async () => {
    let used = 0;
    for (const r of Object.values(refs)) if (await reg.has(r)) used += SLOT;
    return { bavail: Math.max(0, capacity - used), bsize: 1 };
  };
  const cache = new ImageCache({ config, docker, log: silent, statfs, pins: [B.split('@')[1]] });
  t.after(() => cache.close());
  const want = (image) => ({ image, attestedImage: image, platform: PLATFORM, unpackedBytes: SLOT / 2, windowMs: 120000 });

  capacity = 10 * SLOT;
  for (const r of [A, B, E]) (await cache.acquire(want(r))).release();
  const holdC = await cache.acquire(want(C));
  // A container uses A (created, never started: an image a container uses is in use).
  const holder = `vcr-a1b-holder-${instance}`;
  const made = await runText(docker, ['create', '--pull', 'never', '--platform', PLATFORM, '--name', holder, '--entrypoint', '/marker', A], { timeoutMs: 60000 });
  assert.equal(made.exitCode, 0, made.stderr);
  t.after(() => runText(docker, ['rm', '--force', holder], { timeoutMs: 60000 }));

  // Full disk: D must evict. A (container), B (pinned) and C (held) survive; E, the next least recently used, goes.
  capacity = 4 * SLOT;
  const holdD = await cache.acquire(want(D));
  assert.equal(holdD.cache, 'pulled');
  for (const r of [A, B, C, D]) assert.ok(await reg.has(r), `${r} survives`);
  assert.equal(await reg.has(E), false, 'E was evicted');

  // Nothing left to evict: F is refused before any pull.
  const before = (await reg.manifestRequests()).length;
  await assert.rejects(cache.acquire(want(F)), (err) => err.cause === 'admission_refused' && /nothing more can be evicted/.test(err.detail));
  assert.equal((await reg.manifestRequests()).length, before, 'F was never requested');
  for (const r of [A, B, C, D]) assert.ok(await reg.has(r), `${r} survives the refusal`);

  // Released, C is the least recently used candidate and makes room for F.
  holdC.release();
  const holdF = await cache.acquire(want(F));
  assert.equal(await reg.has(C), false, 'C was evicted once released');
  for (const r of [A, B, D, F]) assert.ok(await reg.has(r), r);
  holdD.release();
  holdF.release();
});

test('one execution slot: a second run while one is in flight is refused (admission_refused)', { timeout: TIMEOUT }, async (t) => {
  await ensureTestImage(builder);
  let started = false;
  let finish;
  const { target } = await serve(t, {
    allowlist: 'docker.io/library/ubuntu',
    stepsFor: () => [async (ctx) => {
      started = true;
      await new Promise((r) => { finish = r; });
      await ctx.exec(['true'], { name: 'noop', timeoutMs: 30000 });
    }]
  });
  const first = request(target, { method: 'POST', path: '/v1/runs', body: body(TEST_IMAGE) });
  while (!started) await new Promise((r) => setTimeout(r, 50));
  const second = await request(target, { method: 'POST', path: '/v1/runs', body: body(TEST_IMAGE) });
  assert.equal(second.status, 503, second.raw);
  assert.equal(second.body.abstain.cause, 'admission_refused');
  assert.match(second.body.abstain.detail, /execution slot/);
  finish();
  const res = await first;
  assert.equal(res.status, 200, res.raw);
  assert.equal(res.body.image.cache, 'hit');
});
