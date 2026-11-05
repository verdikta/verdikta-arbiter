'use strict';

/**
 * The conformance pass (design §16; node A8, from a design review). With
 * CODE_RUNNER_CONFORMANCE_FILE set, /health is 503 and every run is refused
 * unless that file holds a pass for exactly what is running: this
 * RUNNER_VERSION, the gVisor release and the @verdikta/common release it reads,
 * the hash common publishes, and a hash of its own installed source.
 *
 * The source hash is there because RUNNER_VERSION need not move with the code:
 * without it, a pass would survive an upgrade that changes the code, which is
 * the case this exists to catch. It covers src/ and the lockfile, and is taken
 * when the process starts, so it names the code this process loaded.
 *
 * The file is read on each check: a new pass counts with no restart, and a
 * removed one fails closed. Missing, malformed and stale all mean refused. The
 * threat is a mistaken or failed upgrade, not an operator editing their own pass.
 *
 * Unset means no check: development, the tests, the site's listing runner and
 * the self-test's own in-process runner.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { CONFORMANCE_CANARY, GVISOR_RELEASE, COMMON_VERSION } = require('./common');
const { RUNNER_VERSION } = require('./version');

const ROOT = path.join(__dirname, '..');

/** The hash of src/ and the lockfile, by a sorted walk: each file's path, then its bytes. */
function sourceSha256(root = ROOT) {
  const files = ['package-lock.json'];
  const walk = (rel) => {
    for (const entry of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const child = path.posix.join(rel, entry.name);
      if (entry.isDirectory()) walk(child);
      else files.push(child);
    }
  };
  walk('src');
  const hash = crypto.createHash('sha256');
  for (const file of files.sort()) {
    const bytes = fs.readFileSync(path.join(root, file));
    hash.update(`${file}\0${bytes.length}\0`).update(bytes);
  }
  return hash.digest('hex');
}

/** Taken once, as the process starts: the code it loaded, whatever is on disk later. */
const RUNNING_SOURCE = sourceSha256();

/** What a pass must say for this process. */
function expectedPass() {
  return {
    reportSha256: CONFORMANCE_CANARY.reportSha256,
    runner: RUNNER_VERSION,
    gvisor: GVISOR_RELEASE,
    commonVersion: COMMON_VERSION,
    sourceSha256: RUNNING_SOURCE
  };
}

/**
 * Why `file` is no pass for this process, or null when it is one.
 * @param {string} file
 * @returns {string|null}
 */
function passProblem(file) {
  let pass;
  try {
    pass = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return `no conformance pass: ${file} cannot be read (${err.code || 'not JSON'}); run code-review-sandbox.sh self-test`;
  }
  if (pass === null || typeof pass !== 'object' || Array.isArray(pass)) {
    return `no conformance pass: ${file} holds no pass; run code-review-sandbox.sh self-test`;
  }
  if (pass.pass !== true) return `the result in ${file} is not a pass; run code-review-sandbox.sh self-test`;
  const expected = expectedPass();
  for (const key of Object.keys(expected)) {
    if (pass[key] !== expected[key]) {
      return `the conformance pass in ${file} is stale: its ${key} is ${pass[key]}, and this runner has ${expected[key]}; run code-review-sandbox.sh self-test`;
    }
  }
  return null;
}

module.exports = { sourceSha256, expectedPass, passProblem };
