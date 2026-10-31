'use strict';

/**
 * The shared bearer token. Compared through SHA-256 digests with
 * timingSafeEqual, so neither the content nor the length leaks through
 * timing.
 */

const crypto = require('node:crypto');

function digest(s) {
  return crypto.createHash('sha256').update(String(s), 'utf8').digest();
}

/**
 * @param {string|undefined} header - the Authorization header
 * @param {string} token - the configured token
 */
function checkBearer(header, token) {
  if (typeof header !== 'string' || typeof token !== 'string' || token === '') return false;
  const m = /^Bearer ([\x21-\x7e]+)$/i.exec(header);
  if (!m) return false;
  return crypto.timingSafeEqual(digest(m[1]), digest(token));
}

module.exports = { checkBearer };
