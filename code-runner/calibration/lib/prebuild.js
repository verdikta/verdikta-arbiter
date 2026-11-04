'use strict';

/**
 * A listing's `commands.setup`, before any sandbox (node A7b). The attested builder runs the maker's
 * setup in /repo, and what it leaves stays in the image (design §8.2; src/checkout.js step 4 keeps
 * out/ and cache/). A class build must finish in 30 s (3 x measured <= the class's 90 s), which a real
 * repository's first compile on 2 CPUs under gVisor does not, so a maker builds in setup, and so does
 * this: the same plain `forge build` the listing's own grammar allows (the loader holds it to that),
 * with no network, as the sandbox user, in /work. Forge's compile cache is by content and relative
 * paths, so it holds when the runner copies the image to /work again.
 *
 * What it wrote comes back as a third layer. It comes from running solc and forge, so unlike the
 * fixtures' images this digest is not a function of pinned inputs; no case pins a report hash. It is
 * kept by the digest of the image it was built on and the command, which together name every input.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runText } = require('../../src/docker');
const forge = require('../../src/forge');
const { parseCommand, forgeArgs } = require('../../src/commands');
const { ensureImage } = require('../../test/docker/helpers');
const { prebuiltLayer, ENV } = require('./image');

const TIMEOUT_MS = 15 * 60 * 1000;
const UID = '10001';
const FORGE = '/usr/local/bin/forge';
const STDERR_KEPT = 4000;

/** Fetched repositories, reports and prebuilt layers, kept between runs (CI's cache, by commit). */
function cacheRoot() {
  return process.env.VCR_CALIBRATION_CACHE || path.join(os.tmpdir(), 'vcr-calibration-cache');
}

/** Where a build's output is kept: the same image and the same command give the same build. */
function prebuiltCacheName(digest, setup) {
  return `${crypto.createHash('sha256').update(`${digest}\n${setup}`).digest('hex')}.tar`;
}

function setupScript(args) {
  const quote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  const pathValue = ENV.find((e) => e.startsWith('PATH=')).slice('PATH='.length);
  const env = Object.entries(forge.forgeEnvironment(pathValue)).map(([k, v]) => quote(`${k}=${v}`)).join(' ');
  return [
    'set -eu',
    'cd /repo',
    'tar --exclude=./.git -cf - . | tar -xpf - -C /work',
    'touch /tmp/vcr-before',
    'sleep 1',
    'cd /work',
    `/usr/bin/env -i ${env} ${FORGE} ${args.map(quote).join(' ')} >&2`,
    'find . -type f -newer /tmp/vcr-before -print0 | LC_ALL=C sort -z | tar --null --no-recursion --verbatim-files-from -T - -cf -'
  ].join('\n');
}

/**
 * @param {object} docker - the session's
 * @param {string} image - the listing's image so far, by digest, in the session's registry
 * @param {string} setup - commands.setup, which the loader already parsed
 * @param {{digest:string, platform:string}} o
 * @returns {Promise<Buffer>} the third layer
 * @throws {Error} the build failed: the listing cannot be built in the image
 */
async function prebuild(docker, image, setup, { digest, platform }) {
  const file = path.join(cacheRoot(), 'prebuilt', prebuiltCacheName(digest, setup));
  if (fs.existsSync(file)) return prebuiltLayer(fs.readFileSync(file));
  const parsed = parseCommand('build', setup);
  if (!parsed.ok) throw new Error(`commands.setup: ${parsed.issue.detail}`);
  await ensureImage(docker, image);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const partial = `${file}.${process.pid}.partial`;
  const out = fs.openSync(partial, 'w');
  let stderr = Buffer.alloc(0);
  const tmpfs = (dir, size) => ['--tmpfs', `${dir}:rw,exec,size=${size},uid=${UID},gid=${UID},mode=0755`];
  let result;
  try {
    result = await docker.run([
      'run', '--rm', '--pull', 'never', '--network', 'none', '--platform', platform, '--user', `${UID}:${UID}`, '--read-only',
      ...tmpfs('/work', '4g'), ...tmpfs('/tmp', '1g'), ...tmpfs('/home/sandbox', '1g'), '--entrypoint', '/bin/sh', image, '-c', setupScript(forgeArgs(parsed))
    ], {
      timeoutMs: TIMEOUT_MS,
      stdout: { write: (b) => { fs.writeSync(out, b); return true; } },
      stderr: { write: (b) => { stderr = Buffer.concat([stderr, b]).subarray(-STDERR_KEPT); return true; } }
    });
  } finally {
    fs.closeSync(out);
  }
  await runText(docker, ['image', 'rm', '--force', image], { timeoutMs: 120000 });
  if (result.exitCode !== 0) {
    fs.rmSync(partial, { force: true });
    throw new Error(`commands.setup (${setup}) failed in the image, exit ${result.exitCode}${result.timedOut ? ', timed out' : ''}: ${stderr.toString('utf8').slice(-1500)}`);
  }
  fs.renameSync(partial, file);
  return prebuiltLayer(fs.readFileSync(file));
}

module.exports = { prebuild, cacheRoot, setupScript, prebuiltCacheName };
