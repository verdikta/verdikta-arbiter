'use strict';

/**
 * The real session behind the harness: the code runner itself, in this process, over its HTTP
 * surface, on the Docker daemon DOCKER_HOST names; a throwaway registry:2 on a loopback port,
 * the runner's only allowlisted registry; the images published there, written by image.js and
 * pulled by digest by the runner's own cache.
 *
 * It holds no secret: the bearer token is random and dies with the process, nothing of the
 * caller's environment reaches the runner's configuration, and the Docker CLI gets the runner's
 * own empty DOCKER_CONFIG. What it starts, it removes: its containers carry its own instance
 * label, and the images it removes are the ones it published. The pinned base and Semgrep images
 * stay: other things on the daemon use them.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('../../src/server');
const { createDocker, runText } = require('../../src/docker');
const { loadConfig } = require('../../src/config');
const { SEMGREP } = require('../../src/semgrepPin');
const { OCI_PLATFORM } = require('../../src/common');
const { RUNNER_VERSION } = require('../../src/version');
const { request } = require('../../test/helpers/http');
const { RUNTIME, PLATFORM, ensureImage, removeAll } = require('../../test/docker/helpers');
const { REGISTRY_IMAGE, solcBytes } = require('../../test/docker/forgeFixture');
const { MANIFEST_MEDIA_TYPE, repoLayer, toolsLayer, assembleImage } = require('./image');
const { fetchBase } = require('./base');
const { DEADLINE_MS } = require('./harness');

const silent = { info() {}, warn() {}, error() {}, debug() {} };
/** A first pull on an empty daemon unpacks the whole base. The harness measures runs, not pulls. */
const PULL_TIMEOUT_SECONDS = 600;

/**
 * What a listing's image is made of.
 * @throws when the format allows the listing and this harness cannot build it yet
 */
function imageInputs(listing) {
  if (listing.repo.kind !== 'fixture') {
    throw new Error(`listing ${listing.id}: a repo of kind ${listing.repo.kind} (git) is in the format for public findings, and building its image is node A7b's`);
  }
  return { files: listing.files, imageOnly: listing.imageOnly || {}, solc: listing.solc };
}

/** The image of a listing on `platform`: the written layers and manifest, with the base's blobs to publish beside them. */
async function buildImage(listing, platform) {
  const { files, imageOnly, solc } = imageInputs(listing);
  const base = await fetchBase(platform);
  const { layer, commit } = repoLayer({ files, imageOnly });
  if (commit !== listing.commit) throw new Error(`listing ${listing.id}: its files make commit ${commit}, and it names ${listing.commit}`);
  const tools = toolsLayer({ release: solc, bytes: await solcBytes(platform, solc) });
  return { ...assembleImage({ baseManifest: base.manifest, baseConfig: base.config, layers: [tools, layer] }), base };
}

function send(port, method, target, { body = null, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: target, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    if (body && typeof body.pipe === 'function') {
      body.on('error', reject);
      body.pipe(req);
    } else {
      req.end(body || undefined);
    }
  });
}

async function uploadBlob(port, repository, digest, source, size) {
  if ((await send(port, 'HEAD', `/v2/${repository}/blobs/${digest}`)).status === 200) return;
  const start = await send(port, 'POST', `/v2/${repository}/blobs/uploads/`);
  if (start.status !== 202) throw new Error(`the registry refused an upload of ${digest}: HTTP ${start.status}`);
  const location = new URL(start.headers.location, `http://127.0.0.1:${port}`);
  location.searchParams.set('digest', digest);
  const put = await send(port, 'PUT', `${location.pathname}${location.search}`, {
    body: typeof source === 'string' ? fs.createReadStream(source) : source,
    headers: { 'content-type': 'application/octet-stream', 'content-length': size }
  });
  if (put.status !== 201) throw new Error(`the registry refused ${digest}: HTTP ${put.status} ${put.body.toString('utf8').slice(0, 200)}`);
}

async function publishImage(port, repository, image) {
  for (const layer of image.base.manifest.layers) await uploadBlob(port, repository, layer.digest, await image.base.blob(layer.digest), layer.size);
  await uploadBlob(port, repository, image.base.manifest.config.digest, await image.base.blob(image.base.manifest.config.digest), image.base.manifest.config.size);
  for (const layer of image.added) await uploadBlob(port, repository, layer.digest, layer.bytes, layer.size);
  await uploadBlob(port, repository, image.manifest.config.digest, image.configBytes, image.configBytes.length);
  const put = await send(port, 'PUT', `/v2/${repository}/manifests/${image.digest}`, {
    body: image.manifestBytes, headers: { 'content-type': MANIFEST_MEDIA_TYPE, 'content-length': image.manifestBytes.length }
  });
  if (put.status !== 201) throw new Error(`the registry refused the manifest: HTTP ${put.status} ${put.body.toString('utf8').slice(0, 300)}`);
  if (put.headers['docker-content-digest'] !== image.digest) throw new Error(`the registry names the manifest ${put.headers['docker-content-digest']}, and its bytes are ${image.digest}`);
}

/** A port free on this host's loopback now. Docker must be told one: under Docker Desktop, a port it allocates itself is open on the Mac and not in the VM, where the daemon pulls from. */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function startRegistry(docker, instance, wantedPort) {
  const name = `vcr-cal-registry-${instance}`;
  const port = wantedPort || await freePort();
  const publish = `127.0.0.1:${port}:5000`;
  const up = await runText(docker, ['run', '--detach', '--name', name, '--publish', publish, REGISTRY_IMAGE], { timeoutMs: 120000 });
  if (up.exitCode !== 0) {
    await runText(docker, ['rm', '--force', '--volumes', name], { timeoutMs: 60000 });
    throw new Error(`the local registry did not start on ${publish}: ${up.stderr.trim().slice(0, 400)}`);
  }
  const stop = async () => { await runText(docker, ['rm', '--force', '--volumes', name], { timeoutMs: 60000 }); };
  try {
    const until = Date.now() + 30000;
    for (;;) {
      const answered = await send(port, 'GET', '/v2/').catch(() => null);
      if (answered && answered.status === 200) break;
      if (Date.now() > until) throw new Error('the local registry did not answer in 30 s');
      await new Promise((r) => setTimeout(r, 250));
    }
    return { port, stop };
  } catch (err) {
    await stop();
    throw err;
  }
}

/**
 * @param {object} [o]
 * @param {number} [o.registryPort] - a fixed loopback port (the canary's); default: whichever is free
 * @param {object} [o.log]
 */
async function createSession({ registryPort = 0, log = silent } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vcr-calibration-'));
  const instance = `cal${crypto.randomBytes(5).toString('hex')}`;
  const token = crypto.randomBytes(32).toString('hex');
  const dockerHost = process.env.DOCKER_HOST || null;
  const dockerConfigDir = path.join(tmp, 'docker-config');
  fs.mkdirSync(dockerConfigDir, { recursive: true, mode: 0o700 });
  const docker = createDocker({ dockerHost, dockerConfigDir, baseEnv: process.env });
  const closers = [() => fs.rmSync(tmp, { recursive: true, force: true })];
  const close = async () => {
    while (closers.length) {
      try {
        await closers.pop()();
      } catch (err) {
        log.warn('cleanup', { error: err.message });
      }
    }
  };
  try {
    await ensureImage(docker, SEMGREP.reference);
    await ensureImage(docker, REGISTRY_IMAGE);
    const registry = await startRegistry(docker, instance, registryPort);
    closers.push(registry.stop);
    const host = `127.0.0.1:${registry.port}`;
    const config = loadConfig({
      CODE_RUNNER_TOKEN: token,
      CODE_RUNNER_RUNTIME: RUNTIME,
      CODE_RUNNER_PLATFORM: PLATFORM,
      CODE_RUNNER_INSTANCE: instance,
      CODE_RUNNER_STATE_DIR: tmp,
      CODE_RUNNER_REGISTRY_ALLOWLIST: host,
      CODE_RUNNER_PULL_TIMEOUT_SECONDS: String(PULL_TIMEOUT_SECONDS),
      ...(dockerHost ? { DOCKER_HOST: dockerHost } : {})
    }, { root: tmp });
    config.listen = { host: '127.0.0.1', port: 0 };
    config.gcIntervalMs = 0;
    const runner = createServer({ config, docker, log });
    const address = await runner.listen();
    closers.push(() => removeAll(docker, instance));
    closers.push(() => runner.close());
    const target = { host: address.host, port: address.port };
    const ask = (options) => request(target, { token, ...options });
    const health = await ask({ path: '/health' });
    if (health.status !== 200) throw new Error(`the runner is not healthy: ${JSON.stringify((health.body && health.body.reasons) || health.raw)}`);

    const published = new Set();
    closers.splice(1, 0, async () => {
      if (published.size) await runText(docker, ['image', 'rm', '--force', ...published], { timeoutMs: 120000 });
    });
    return {
      runtime: RUNTIME,
      platform: PLATFORM,
      classPlatform: OCI_PLATFORM,
      runner: { version: RUNNER_VERSION, runtime: RUNTIME, platform: PLATFORM, gvisor: health.body.gvisor },
      async publish(listing, { repository = `verdikta/calibration/${listing.id}` } = {}) {
        const image = await buildImage(listing, PLATFORM);
        await publishImage(registry.port, repository, image);
        const ref = `${host}/${repository}@${image.digest}`;
        published.add(ref);
        return { image: ref, digest: image.digest };
      },
      async listingCheck(publishedImage, listing, view) {
        const res = await ask({ method: 'POST', path: '/v1/listing-checks', body: { spec: view.spec, image: publishedImage.image, deadline: DEADLINE_MS } });
        return { status: res.status, body: res.body };
      },
      async run(body) {
        const res = await ask({ method: 'POST', path: '/v1/runs', body });
        return { status: res.status, body: res.body };
      },
      close
    };
  } catch (err) {
    await close();
    throw err;
  }
}

module.exports = { createSession, buildImage, imageInputs };
