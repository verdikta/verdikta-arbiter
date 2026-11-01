'use strict';

/**
 * A throwaway registry:2 for the pull tests (test setup only; the runner
 * itself only ever pulls).
 *
 * It runs on the daemon host's network, listening on 127.0.0.1 only, because
 * the daemon is what talks to it: on Linux that is the host, under Docker
 * Desktop the VM, where a port published from macOS is not on 127.0.0.1.
 * The daemon treats 127.0.0.0/8 as an insecure (plain HTTP) registry by
 * default, so no daemon configuration is needed. The registry container runs
 * under the daemon's default runtime whatever CODE_RUNNER_RUNTIME is.
 *
 * Fixture images are built here, pushed, and removed from the daemon again
 * so that the runner has to pull them. Every container and image made here is
 * removed by `remove()`.
 */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runText } = require('../../src/docker');
const { REGISTRY_IMAGE } = require('./forgeFixture');
const { PLATFORM, ensureImage } = require('./helpers');

async function waitFor(fn, { timeoutMs = 30000, everyMs = 250 } = {}) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) return v;
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

/**
 * @param {object} docker
 * @param {string} instance - names the registry container and the repositories
 */
async function startRegistry(docker, instance) {
  await ensureImage(docker, REGISTRY_IMAGE);
  const name = `vcr-registry-${instance}`;
  let host = null;
  for (let attempt = 0; attempt < 10 && !host; attempt += 1) {
    const port = 20000 + crypto.randomInt(30000);
    await runText(docker, ['rm', '--force', name], { timeoutMs: 60000 });
    const up = await runText(docker, ['run', '--detach', '--name', name, '--network', 'host',
      '--env', `REGISTRY_HTTP_ADDR=127.0.0.1:${port}`, REGISTRY_IMAGE], { timeoutMs: 120000 });
    assert.equal(up.exitCode, 0, `registry: ${up.stderr}`);
    const ready = await waitFor(async () => {
      const logs = await runText(docker, ['logs', name], { timeoutMs: 30000 });
      if (/listening on 127\.0\.0\.1/.test(logs.stdout + logs.stderr)) return 'up';
      const state = await runText(docker, ['inspect', '--format', '{{.State.Running}}', name], { timeoutMs: 30000 });
      return state.stdout.trim() === 'false' ? 'down' : null;
    });
    if (ready === 'up') host = `127.0.0.1:${port}`;
  }
  assert.ok(host, 'the test registry started');

  const made = new Set();
  const dirs = [];

  /**
   * Build an image (COPY only, so no emulation is needed for another
   * platform), push it, and remove it from the daemon. Returns its digest
   * reference.
   * @param {object} o
   * @param {string} o.repo - repository under the registry
   * @param {string} [o.from] - base image (default scratch)
   * @param {string} [o.platform] - default the platform the tests run
   * @param {string} [o.content] - the file /marker holds
   * @param {boolean} [o.keep] - leave the image on the daemon
   */
  async function push({ repo, from = 'scratch', platform = PLATFORM, content = repo, keep = false }) {
    if (from !== 'scratch') await ensureImage(docker, from);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcr-pull-fixture-'));
    dirs.push(dir);
    fs.writeFileSync(path.join(dir, 'marker'), `${content}\n`);
    fs.writeFileSync(path.join(dir, 'Dockerfile'), `FROM ${from}\nCOPY marker /marker\n`);
    const tag = `${host}/${repo}:fixture`;
    made.add(tag);
    // A single manifest (no provenance index), the same under either image store.
    const b = await runText(docker, ['build', '--quiet', '--provenance=false', '--network', 'none', '--platform', platform, '--tag', tag, dir], { timeoutMs: 600000 });
    assert.equal(b.exitCode, 0, `docker build: ${b.stderr}`);
    const p = await runText(docker, ['push', tag], { timeoutMs: 300000 });
    assert.equal(p.exitCode, 0, `docker push: ${p.stderr}`);
    const m = /digest: (sha256:[0-9a-f]{64})/.exec(p.stdout);
    assert.ok(m, `the push printed a digest: ${p.stdout}`);
    const ref = `${host}/${repo}@${m[1]}`;
    made.add(ref);
    if (!keep) await forget(ref, tag);
    return ref;
  }

  /** Remove references from the daemon (test cleanup may force). */
  async function forget(...refs) {
    await runText(docker, ['image', 'rm', '--force', ...refs], { timeoutMs: 120000 });
  }

  /** Whether the daemon holds an image under this reference. */
  async function has(ref) {
    const r = await runText(docker, ['image', 'inspect', '--format', '{{.Id}}', ref], { timeoutMs: 30000 });
    return r.exitCode === 0;
  }

  /** Every manifest request the registry has logged: [{ method, repo, reference }]. */
  async function manifestRequests() {
    const logs = await runText(docker, ['logs', name], { timeoutMs: 30000, maxBytes: 16 * 1024 * 1024 });
    const out = [];
    for (const line of `${logs.stdout}\n${logs.stderr}`.split('\n')) {
      const m = /http\.request\.method=(\w+) .*http\.request\.uri="\/v2\/(.+)\/manifests\/([^"]+)"/.exec(line);
      if (m) out.push({ method: m[1], repo: m[2], reference: m[3] });
    }
    return out;
  }

  /** Overwrite a stored blob's bytes, so the registry serves content that no longer hashes to its digest. */
  async function corrupt(digest) {
    const hex = digest.replace(/^sha256:/, '');
    const file = `/var/lib/registry/docker/registry/v2/blobs/sha256/${hex.slice(0, 2)}/${hex}/data`;
    const r = await runText(docker, ['exec', name, 'sh', '-c', 'printf " " >> "$1"', 'corrupt', file], { timeoutMs: 30000 });
    assert.equal(r.exitCode, 0, r.stderr);
  }

  async function stop() {
    await runText(docker, ['rm', '--force', '--volumes', name], { timeoutMs: 60000 });
  }

  async function remove() {
    await stop();
    if (made.size) await forget(...made);
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  }

  return { host, name, push, forget, has, manifestRequests, corrupt, stop, remove, made };
}

module.exports = { startRegistry };
