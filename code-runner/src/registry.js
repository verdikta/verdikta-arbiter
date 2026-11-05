'use strict';

/**
 * Image references and the registry allowlist (design §9.2 step 2, node A1b).
 *
 * The runner pulls an env image only by digest and only from an allow-listed
 * registry. A digest names content: the daemon checks every byte it fetches
 * against it, so the only thing a registry decides is whether the pull
 * works. The allowlist bounds where the daemon reaches out to.
 *
 * References are read the way Docker resolves them (distribution/reference):
 * the first component is a registry host when it has a dot or a port or is
 * `localhost`; otherwise the image is on Docker Hub (`docker.io`, and a
 * single name is an official image, `library/<name>`). The runner always
 * hands Docker the canonical form, `host/path@sha256:<hex>`, so what is
 * pulled is exactly what was checked. Anything Docker would read differently
 * from how it is written (upper case, empty or dotted components, a tag next
 * to the digest) is refused.
 *
 * pullArgs() is the only place a `docker pull` argv is built
 * (test/unit/policy.test.js holds src/ to that); it takes a digest reference
 * and nothing else, so a tag or any other mutable reference can never be
 * pulled.
 */

const { PLATFORMS } = require('./sandbox');

const DEFAULT_REGISTRY_ALLOWLIST = 'ghcr.io/verdikta';

/** A host name of lower-case labels, an IPv4 address, or a bracketed IPv6 address; an optional port. */
const DOMAIN = /^(?:(?:[a-z0-9]|[a-z0-9][a-z0-9-]*[a-z0-9])(?:\.(?:[a-z0-9]|[a-z0-9][a-z0-9-]*[a-z0-9]))*|\[[0-9a-f:]+\])(?::[0-9]{1,5})?$/;
/** A path component: lower-case alphanumerics joined by `.`, `_`, `__` or dashes. */
const COMPONENT = /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*$/;
const TAG = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const MAX_NAME = 255;

const LOOPBACK_HOST = /^(?:localhost|127\.(?:[0-9]{1,3})\.(?:[0-9]{1,3})\.(?:[0-9]{1,3})|\[::1\])$/;

function looksLikeHost(component) {
  return component.includes('.') || component.includes(':') || component === 'localhost' || component.startsWith('[');
}

function hostOf(domain) {
  if (domain.startsWith('[')) return domain.slice(0, domain.indexOf(']') + 1);
  const colon = domain.lastIndexOf(':');
  return colon === -1 ? domain : domain.slice(0, colon);
}

/**
 * Split a name (`host/a/b` or `a/b`) into a normalised domain and path.
 * @returns {{domain:string, path:string}}
 * @throws {TypeError}
 */
function splitName(name, what) {
  if (name.length === 0 || name.length > MAX_NAME) throw new TypeError(`${what}: the name must be 1 to ${MAX_NAME} characters`);
  const parts = name.split('/');
  let domain = 'docker.io';
  if (parts.length > 1 && looksLikeHost(parts[0])) domain = parts.shift();
  if (!DOMAIN.test(domain)) throw new TypeError(`${what}: ${JSON.stringify(domain)} is not a registry host`);
  for (const c of parts) {
    if (!COMPONENT.test(c)) throw new TypeError(`${what}: ${JSON.stringify(c)} is not a repository path component`);
  }
  if (domain === 'index.docker.io') domain = 'docker.io';
  if (domain === 'docker.io' && parts.length === 1) parts.unshift('library');
  return { domain, path: parts.join('/') };
}

/**
 * Parse an image reference.
 *
 * @param {unknown} ref
 * @param {{digestRequired?: boolean}} [o] - true (the default): only
 *   `name@sha256:<hex>`, the one form the runner pulls or runs. false: also
 *   `name:tag` (and `name:tag@digest`), for reading a daemon's listing.
 * @returns {{domain:string, path:string, tag:string|null, digest:string|null, repository:string, canonical:string|null}}
 *   `canonical` is `repository@digest` (null without a digest).
 * @throws {TypeError}
 */
function parseImageRef(ref, { digestRequired = true } = {}) {
  if (typeof ref !== 'string' || ref === '') throw new TypeError('an image reference must be a non-empty string');
  const what = JSON.stringify(ref.length > 300 ? `${ref.slice(0, 300)}…` : ref);
  const at = ref.split('@');
  if (at.length > 2) throw new TypeError(`${what}: more than one @`);
  let digest = null;
  if (at.length === 2) {
    if (!DIGEST.test(at[1])) throw new TypeError(`${what}: the digest must be sha256:<64 lower-case hex>`);
    digest = at[1];
  }
  let name = at[0];
  let tag = null;
  const lastSlash = name.lastIndexOf('/');
  const colon = name.indexOf(':', lastSlash + 1);
  if (colon !== -1) {
    tag = name.slice(colon + 1);
    name = name.slice(0, colon);
    if (!TAG.test(tag)) throw new TypeError(`${what}: ${JSON.stringify(tag)} is not a tag`);
  }
  if (digestRequired) {
    if (tag !== null) throw new TypeError(`${what}: a tag is mutable; the image must be named by its digest alone`);
    if (digest === null) throw new TypeError(`${what}: the image must be pinned by digest (name@sha256:<hex>)`);
  } else if (tag === null && digest === null) {
    throw new TypeError(`${what}: neither a tag nor a digest`);
  }
  const { domain, path } = splitName(name, what);
  const repository = `${domain}/${path}`;
  return { domain, path, tag, digest, repository, canonical: digest ? `${repository}@${digest}` : null };
}

/**
 * Parse CODE_RUNNER_REGISTRY_ALLOWLIST: entries separated by commas or white
 * space, each a registry host (with its port, if any) and an optional
 * repository prefix, e.g. `ghcr.io/verdikta` or `127.0.0.1:5000`. An image
 * matches an entry when its host is the entry's, exactly, and its path is the
 * entry's path or lies below it on a `/` boundary. No tags, digests, schemes
 * or wildcards. Entries on a loopback host (`localhost`, 127.0.0.0/8,
 * `[::1]`) are marked `dev`: a local registry:2 for development and tests,
 * which is plain HTTP and exists on one machine only.
 *
 * @param {string} text
 * @returns {{entries: {entry:string, domain:string, path:string, dev:boolean}[], problems: string[]}}
 */
function parseAllowlist(text) {
  const entries = [];
  const problems = [];
  for (const raw of String(text || '').split(/[\s,]+/).filter(Boolean)) {
    const quoted = JSON.stringify(raw);
    if (/[@*?]/.test(raw) || raw.includes('://')) {
      problems.push(`${quoted}: an entry is a registry host and an optional repository prefix, with no digest, tag, scheme or wildcard`);
      continue;
    }
    const parts = raw.split('/');
    if (!looksLikeHost(parts[0])) {
      problems.push(`${quoted}: an entry starts with a registry host (Docker Hub is docker.io/<namespace>)`);
      continue;
    }
    let domain = parts.shift();
    if (!DOMAIN.test(domain)) {
      problems.push(`${quoted}: ${JSON.stringify(domain)} is not a registry host (lower case, optional :port)`);
      continue;
    }
    const bad = parts.find((c) => !COMPONENT.test(c));
    if (bad !== undefined) {
      problems.push(`${quoted}: ${JSON.stringify(bad)} is not a repository path component (no tag, no empty component, lower case)`);
      continue;
    }
    if (domain === 'index.docker.io') domain = 'docker.io';
    const path = parts.join('/');
    entries.push({ entry: path ? `${domain}/${path}` : domain, domain, path, dev: LOOPBACK_HOST.test(hostOf(domain)) });
  }
  if (entries.length === 0 && problems.length === 0) problems.push('the allowlist is empty: every pull would be refused');
  return { entries, problems };
}

/**
 * The entry that allows a parsed reference, or null.
 * @param {{domain:string, path:string}} ref - from parseImageRef
 * @param {{domain:string, path:string}[]} entries - from parseAllowlist
 */
function allowedBy(ref, entries) {
  for (const e of entries) {
    if (ref.domain !== e.domain) continue;
    if (e.path === '' || ref.path === e.path || ref.path.startsWith(`${e.path}/`)) return e;
  }
  return null;
}

/**
 * The exact `docker pull` argv for an image: by its canonical digest
 * reference, for one platform. Nothing else is ever pulled.
 * @param {string} ref - name@sha256:<hex>
 * @param {string} platform - one of PLATFORMS
 * @returns {string[]}
 * @throws {TypeError} for a tag, a missing digest or another platform
 */
function pullArgs(ref, platform) {
  const parsed = parseImageRef(ref);
  if (!PLATFORMS.includes(platform)) throw new TypeError(`platform must be one of ${PLATFORMS.join(', ')}, got ${JSON.stringify(platform)}`);
  return ['pull', '--quiet', '--platform', platform, parsed.canonical];
}

module.exports = { DEFAULT_REGISTRY_ALLOWLIST, parseImageRef, parseAllowlist, allowedBy, pullArgs };
