/**
 * @fileoverview Reading named files out of an extracted archive, safely.
 *
 * The listing names its own members (code_review.json, attestation.json,
 * baseline.json, known_issues.json) and the schema does not restrict the
 * names, so a name is resolved inside the extracted directory and refused if
 * it is not a plain relative path to a regular file there: no absolute
 * paths, no `.` or `..` segments, no backslashes, no symlink out of the
 * archive. Every check is a function of the archive bytes, so every arbiter
 * decides alike; an I/O error other than "not there" propagates (transient).
 */

const fs = require('fs');
const path = require('path');

const MAX_NAME_LENGTH = 255;

/** Why a member name is not a plain relative path, or null when it is. */
function nameProblem(name) {
  if (typeof name !== 'string' || name.length === 0) return 'is not a file name';
  if (name.length > MAX_NAME_LENGTH) return `is longer than ${MAX_NAME_LENGTH} characters`;
  if (name.includes('\\') || name.includes('\0') || name.startsWith('/')) return 'is not a plain relative path';
  if (name.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return 'is not a plain relative path';
  }
  return null;
}

/**
 * @param {string} root - the extracted archive directory
 * @param {string} name - the member's name inside it
 * @returns {Promise<{ status: 'ok', bytes: Buffer } | { status: 'missing' } | { status: 'unsafe', reason: string }>}
 */
async function readMember(root, name) {
  const problem = nameProblem(name);
  if (problem) return { status: 'unsafe', reason: `the name ${problem}` };

  const rootReal = await fs.promises.realpath(root);
  let real;
  try {
    real = await fs.promises.realpath(path.join(rootReal, ...name.split('/')));
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return { status: 'missing' };
    if (error && error.code === 'ELOOP') return { status: 'unsafe', reason: 'the name resolves through a symlink loop' };
    throw error;
  }
  const relative = path.relative(rootReal, real);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    return { status: 'unsafe', reason: 'the name resolves outside the archive' };
  }
  const stat = await fs.promises.stat(real);
  if (!stat.isFile()) return { status: 'unsafe', reason: 'the name is not a regular file' };
  return { status: 'ok', bytes: await fs.promises.readFile(real) };
}

const UTF8 = new TextDecoder('utf-8', { fatal: true });

/** The bytes as UTF-8 text, or null when they are not valid UTF-8. */
function utf8(bytes) {
  try {
    return UTF8.decode(bytes);
  } catch (_error) {
    return null;
  }
}

/**
 * Does the file look like a patch git can apply: a `diff --git` header, or a
 * unified diff's `---` / `+++` pair followed by a hunk? A structural check
 * only; whether it applies, and what it touches, is the runner's (`applies`,
 * `testPathsOnly`).
 * @param {Buffer} bytes
 * @returns {boolean}
 */
function looksLikePatch(bytes) {
  if (!bytes || bytes.length === 0 || bytes.includes(0)) return false;
  const lines = bytes.toString('latin1').split('\n').map((line) => line.replace(/\r$/, ''));
  for (let i = 0; i < lines.length; i += 1) {
    if (/^diff --git \S+ \S+/.test(lines[i])) return true;
    if (lines[i].startsWith('--- ') && i + 2 < lines.length
        && lines[i + 1].startsWith('+++ ') && lines[i + 2].startsWith('@@ ')) {
      return true;
    }
  }
  return false;
}

/**
 * A JSON object member. Returns the object, or the reason it is not one
 * (never the engine's parse message, which can quote the file).
 * @param {Buffer} bytes
 * @returns {{ value: object } | { problem: string }}
 */
function jsonObject(bytes) {
  const text = utf8(bytes);
  if (text === null) return { problem: 'is not valid UTF-8' };
  let value;
  try {
    value = JSON.parse(text);
  } catch (_error) {
    return { problem: 'is not valid JSON' };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { problem: 'is not a JSON object' };
  return { value };
}

module.exports = { readMember, utf8, looksLikePatch, jsonObject, nameProblem };
