'use strict';

/**
 * Class hard limits: the runner's law (design §9.1). The runner applies them
 * whatever the spec says; a spec above them is the requester's broken package
 * (§12), refused before any pull or work.
 *
 * LOCAL COPY of @verdikta/common src/codeReview/constants.js
 * (CLASS_HARD_LIMITS, SPEC_LIMIT_MAXIMA) and of the bounds in its
 * schemas/code_review.v1.json (Limits, Env). Node A3b replaces this module with
 * the package; until then the values must match it exactly
 * (test/unit/classLimits.test.js pins them). Byte sizes are decimal.
 *
 * Issues have common's shape, `{ code, path, detail }`, and its codes
 * (LIMIT_ABOVE_CLASS_MAX, IMAGE_ABOVE_CLASS_MAX, LIMIT_TEST_ABOVE_RUN), so the
 * EA's handling does not change when the source does.
 */

const OCI_PLATFORM = 'linux/amd64';

const CLASS_HARD_LIMITS = Object.freeze({
  cpus: 2,
  memoryMb: 4096,
  pids: 4096,
  buildSeconds: 90,
  runSeconds: 360,
  imageCompressedBytes: 2000000000,
  imageUnpackedBytes: 6000000000,
  maxPatchBytes: 2000000,
  patchExpansionBytes: 50000000,
  platform: OCI_PLATFORM
});

/** Spec `limits` keys and the hard maximum each may not exceed. */
const SPEC_LIMIT_MAXIMA = Object.freeze({
  cpus: CLASS_HARD_LIMITS.cpus,
  memoryMb: CLASS_HARD_LIMITS.memoryMb,
  buildSeconds: CLASS_HARD_LIMITS.buildSeconds,
  testSeconds: CLASS_HARD_LIMITS.runSeconds,
  runSeconds: CLASS_HARD_LIMITS.runSeconds,
  maxPatchBytes: CLASS_HARD_LIMITS.maxPatchBytes
});

/** The schema's minimum for each spec limit. */
const SPEC_LIMIT_MINIMA = Object.freeze({
  cpus: 1,
  memoryMb: 256,
  buildSeconds: 1,
  testSeconds: 1,
  runSeconds: 1,
  maxPatchBytes: 1
});

/** common's Env.image pattern: a repository pinned by digest, nothing else. */
const IMAGE_REF = /^[a-z0-9][a-z0-9._/-]*(?::[0-9]+)?(?:\/[a-z0-9._-]+)*@sha256:[0-9a-f]{64}$/;

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Check the parts of code_review.json the runner enforces, and compute the
 * effective limits.
 *
 * @param {unknown} spec - the parsed code_review.json
 * @returns {{ ok: boolean, issues: {code:string,path:string,detail:string}[], limits: object|null }}
 *   `limits` (when ok): cpus, memoryMb, pids, buildSeconds, testSeconds,
 *   runSeconds, maxPatchBytes, patchExpansionBytes, platform. Keys the spec
 *   cannot set (pids, patchExpansionBytes, platform) are always the class's.
 */
function checkSpec(spec) {
  const issues = [];
  const issue = (code, path, detail) => issues.push({ code, path, detail });

  if (!isPlainObject(spec)) {
    issue('SCHEMA', '/spec', 'must be an object');
    return { ok: false, issues, limits: null };
  }

  const env = spec.env;
  if (!isPlainObject(env)) {
    issue('SCHEMA', '/spec/env', 'must be an object with image, platform and unpackedBytes');
  } else {
    if (typeof env.image !== 'string' || !IMAGE_REF.test(env.image)) {
      issue('SCHEMA', '/spec/env/image', 'must be an image pinned by digest (name@sha256:<64 hex>)');
    }
    if (env.platform !== CLASS_HARD_LIMITS.platform) {
      issue('PLATFORM_NOT_ALLOWED', '/spec/env/platform', `the class runs ${CLASS_HARD_LIMITS.platform} only`);
    }
    if (!Number.isInteger(env.unpackedBytes) || env.unpackedBytes < 1) {
      issue('SCHEMA', '/spec/env/unpackedBytes', 'must be a positive integer');
    } else if (env.unpackedBytes > CLASS_HARD_LIMITS.imageUnpackedBytes) {
      issue('IMAGE_ABOVE_CLASS_MAX', '/spec/env/unpackedBytes',
        `${env.unpackedBytes} exceeds the class maximum of ${CLASS_HARD_LIMITS.imageUnpackedBytes} bytes unpacked`);
    }
  }

  const requested = spec.limits === undefined ? {} : spec.limits;
  if (!isPlainObject(requested)) {
    issue('SCHEMA', '/spec/limits', 'must be an object');
  } else {
    for (const key of Object.keys(requested)) {
      const path = `/spec/limits/${key}`;
      if (!Object.prototype.hasOwnProperty.call(SPEC_LIMIT_MAXIMA, key)) {
        issue('UNKNOWN_FIELD', path, `a spec may set only ${Object.keys(SPEC_LIMIT_MAXIMA).join(', ')}`);
        continue;
      }
      const value = requested[key];
      if (!Number.isInteger(value)) {
        issue('SCHEMA', path, 'must be an integer');
      } else if (value < SPEC_LIMIT_MINIMA[key]) {
        issue('SCHEMA', path, `must be at least ${SPEC_LIMIT_MINIMA[key]}`);
      } else if (value > SPEC_LIMIT_MAXIMA[key]) {
        issue('LIMIT_ABOVE_CLASS_MAX', path, `${value} exceeds the class maximum of ${SPEC_LIMIT_MAXIMA[key]}`);
      }
    }
    if (Number.isInteger(requested.testSeconds) && Number.isInteger(requested.runSeconds)
        && requested.testSeconds > requested.runSeconds) {
      issue('LIMIT_TEST_ABOVE_RUN', '/spec/limits/testSeconds',
        `testSeconds (${requested.testSeconds}) exceeds runSeconds (${requested.runSeconds})`);
    }
  }

  if (issues.length) return { ok: false, issues, limits: null };

  const pick = (key) => (requested[key] === undefined ? SPEC_LIMIT_MAXIMA[key] : requested[key]);
  const limits = Object.freeze({
    cpus: pick('cpus'),
    memoryMb: pick('memoryMb'),
    pids: CLASS_HARD_LIMITS.pids,
    buildSeconds: pick('buildSeconds'),
    testSeconds: pick('testSeconds'),
    runSeconds: pick('runSeconds'),
    maxPatchBytes: pick('maxPatchBytes'),
    patchExpansionBytes: CLASS_HARD_LIMITS.patchExpansionBytes,
    platform: CLASS_HARD_LIMITS.platform
  });
  return { ok: true, issues: [], limits };
}

module.exports = { CLASS_HARD_LIMITS, SPEC_LIMIT_MAXIMA, SPEC_LIMIT_MINIMA, IMAGE_REF, OCI_PLATFORM, checkSpec };
