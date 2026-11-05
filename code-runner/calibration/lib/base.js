'use strict';

/**
 * The pinned forge base as a registry serves it: its manifest, config and compressed layers, by
 * digest from its own registry. A local registry:2 must hold them to accept a manifest that
 * names them, and `docker save` cannot give them: on the classic image store it gives the layers
 * recompressed or uncompressed, under other digests. Every byte is checked against the digest
 * common pins (or its index's entry for that platform), so what comes from the network cannot
 * change the image; a blob is kept in the temporary directory by its digest.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const { Readable } = require('node:stream');
const { BASE_IMAGE_PINS, OCI_PLATFORM } = require('../../src/common');
const { parseBaseIndex, digestOf } = require('./image');

const ACCEPT = [
  'application/vnd.oci.image.manifest.v1+json', 'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json', 'application/vnd.docker.distribution.manifest.list.v2+json'
].join(',');
const ATTEMPTS = 3;

async function withRetries(what, fn) {
  let last;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      if (attempt < ATTEMPTS) await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
  throw new Error(`${what}: ${last.message}`);
}

function ghcrPath() {
  const { repository } = BASE_IMAGE_PINS.foundry;
  if (!repository.startsWith('ghcr.io/')) throw new Error(`the pinned base is on ${repository}; this code knows ghcr.io's token endpoint only`);
  return repository.slice('ghcr.io/'.length);
}

async function anonymousToken(repo) {
  return withRetries('a pull token from ghcr.io', async () => {
    const r = await fetch(`https://ghcr.io/token?service=ghcr.io&scope=repository:${repo}:pull`);
    if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
    return (await r.json()).token;
  });
}

async function fetchManifest(repo, token, digest) {
  return withRetries(`the base's manifest ${digest}`, async () => {
    const r = await fetch(`https://ghcr.io/v2/${repo}/manifests/${digest}`, { headers: { authorization: `Bearer ${token}`, accept: ACCEPT } });
    if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
    const bytes = Buffer.from(await r.arrayBuffer());
    if (digestOf(bytes) !== digest) throw new Error(`the registry answered with ${digestOf(bytes)}`);
    return bytes;
  });
}

async function fileDigest(file) {
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(file), hash);
  return `sha256:${hash.digest('hex')}`;
}

/** The blob's path in the temporary directory, fetched and checked if it is not there. */
async function fetchBlob(repo, token, digest) {
  const file = path.join(os.tmpdir(), `vcr-blob-${digest.replace(':', '-')}`);
  if (fs.existsSync(file) && await fileDigest(file) === digest) return file;
  return withRetries(`the base's blob ${digest}`, async () => {
    const partial = `${file}.${process.pid}.partial`;
    try {
      const r = await fetch(`https://ghcr.io/v2/${repo}/blobs/${digest}`, { headers: { authorization: `Bearer ${token}` }, redirect: 'follow' });
      if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
      await pipeline(Readable.fromWeb(r.body), fs.createWriteStream(partial));
      const got = await fileDigest(partial);
      if (got !== digest) throw new Error(`the registry answered with ${got}`);
      fs.renameSync(partial, file);
      return file;
    } finally {
      fs.rmSync(partial, { force: true });
    }
  });
}

/**
 * @param {string} platform - linux/amd64 (the class platform's pinned manifest) or another of the pinned index
 * @returns {Promise<{manifest:object, config:object, blob:(digest:string)=>Promise<string>}>}
 */
async function fetchBase(platform) {
  const pin = BASE_IMAGE_PINS.foundry;
  const repo = ghcrPath();
  const token = await anonymousToken(repo);
  let digest = pin.digest;
  if (platform !== OCI_PLATFORM) digest = parseBaseIndex(JSON.parse(await fetchManifest(repo, token, pin.indexDigest)), platform);
  const manifest = JSON.parse(await fetchManifest(repo, token, digest));
  const configFile = await fetchBlob(repo, token, manifest.config.digest);
  return { manifest, config: JSON.parse(fs.readFileSync(configFile)), blob: (d) => fetchBlob(repo, token, d) };
}

module.exports = { fetchBase };
