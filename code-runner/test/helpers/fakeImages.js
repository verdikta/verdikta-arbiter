'use strict';

/**
 * An in-memory model of a daemon's image store, registry and containers, as
 * handlers for test/helpers/fakeDocker.js: `image inspect|ls|rm`, `pull`,
 * `ps` and `container inspect`. The image cache (src/images.js) is driven
 * against it; test/docker/pull.docker.test.js runs the same paths against a
 * real daemon and a local registry:2.
 *
 * An image is { id, refs, os, architecture, variant, size }. `refs` hold
 * canonical references (`ghcr.io/x@sha256:…`, `ghcr.io/x:tag`). `registry`
 * maps a canonical digest reference to what a pull of it gives: an image
 * (added to the store with that reference), `{ fail: stderr }`, or
 * `{ hang: true }` (never answers; the caller's timeout or abort ends it).
 */

const crypto = require('node:crypto');
const { healthyInfo, never } = require('./fakeDocker');

function imageId(seed) {
  return `sha256:${crypto.createHash('sha256').update(String(seed)).digest('hex')}`;
}

function image(ref, over = {}) {
  return { id: imageId(ref), refs: [ref], os: 'linux', architecture: 'amd64', variant: null, size: 1000, ...over };
}

function imageStore({ images = [], registry = {}, containers = [], events = [] } = {}) {
  const store = {
    images: images.map((i) => ({ ...i, refs: [...i.refs] })),
    registry,
    /** image ids that containers use */
    containers: [...containers],
    pulls: [],
    removed: [],
    events
  };
  const find = (key) => store.images.find((i) => i.id === key || i.refs.includes(key));
  const line = (i) => [
    JSON.stringify(i.id),
    JSON.stringify(i.refs.filter((r) => !r.includes('@'))),
    JSON.stringify(i.refs.filter((r) => r.includes('@'))),
    JSON.stringify(i.os),
    JSON.stringify(i.architecture),
    JSON.stringify(i.variant),
    JSON.stringify(i.size)
  ].join('\t');

  const handlers = {
    info: () => ({ stdout: healthyInfo() }),
    image: (args) => {
      events.push(`image ${args[1]}`);
      if (args[1] === 'inspect') {
        const keys = args.slice(args.indexOf('--format') + 2);
        const found = keys.map(find);
        const stdout = found.filter(Boolean).map(line).join('\n') + (found.some(Boolean) ? '\n' : '');
        const missing = keys.filter((k, n) => !found[n]);
        if (missing.length) return { exitCode: 1, stdout, stderr: missing.map((k) => `Error response from daemon: No such image: ${k}`).join('\n') };
        return { stdout };
      }
      if (args[1] === 'ls') return { stdout: store.images.map((i) => `${i.id}\n`).join('') };
      if (args[1] === 'rm') {
        if (args.includes('--force') || args.includes('-f')) throw new Error('the image cache must never force a removal');
        for (const ref of args.slice(2)) {
          const i = find(ref);
          if (!i) return { exitCode: 1, stderr: `Error response from daemon: No such image: ${ref}` };
          if (i.refs.length === 1 && store.containers.includes(i.id)) {
            return { exitCode: 1, stderr: `Error response from daemon: conflict: unable to remove repository reference "${ref}" (must force) - container 0123 is using its referenced image ${i.id}` };
          }
          i.refs = i.refs.filter((r) => r !== ref);
          if (i.refs.length === 0) {
            store.images = store.images.filter((x) => x !== i);
            store.removed.push(i.id);
          }
        }
        return { stdout: '' };
      }
      return { exitCode: 1, stderr: `unknown image command ${args[1]}` };
    },
    pull: (args) => {
      const ref = args[args.length - 1];
      events.push(`pull ${ref}`);
      store.pulls.push(args);
      const entry = store.registry[ref];
      if (!entry) return { exitCode: 1, stderr: `Error response from daemon: manifest for ${ref} not found: manifest unknown` };
      if (entry.hang) return never();
      const answer = () => {
        if (entry.fail) return { exitCode: entry.exitCode || 1, stderr: entry.fail };
        const pulled = { ...entry.image, refs: [...entry.image.refs] };
        const existing = store.images.find((i) => i.id === pulled.id);
        if (existing) existing.refs = [...new Set([...existing.refs, ...pulled.refs])];
        else {
          // A pull moves the reference off another image (another platform of the same index);
          // an image left without references is gone.
          const moved = store.images.filter((i) => i.refs.some((r) => pulled.refs.includes(r)));
          for (const i of moved) i.refs = i.refs.filter((r) => !pulled.refs.includes(r));
          store.images = store.images.filter((i) => !moved.includes(i) || i.refs.length > 0);
          store.images.push(pulled);
        }
        return { stdout: `${ref}\n` };
      };
      return entry.wait ? entry.wait.then(answer) : answer();
    },
    ps: () => ({ stdout: store.containers.map((id, n) => `c${n}\n`).join('') }),
    container: (args) => {
      if (args[1] !== 'inspect') return { exitCode: 1, stderr: 'unknown container command' };
      const names = args.slice(args.indexOf('--format') + 2);
      return { stdout: names.map((name) => `${JSON.stringify(store.containers[Number(name.slice(1))])}\n`).join('') };
    }
  };
  return { store, handlers };
}

/** A statfs whose free space is `capacity` less `perImage` for every image in the store matching `counts`. */
function virtualDisk(store, { capacity, perImage, counts = () => true, events }) {
  return async (dir) => {
    if (events) events.push(`statfs ${dir}`);
    const used = store.images.filter(counts).length * perImage;
    return { bavail: Math.max(0, capacity - used), bsize: 1 };
  };
}

module.exports = { imageStore, image, imageId, virtualDisk };
