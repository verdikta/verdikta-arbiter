/**
 * @fileoverview The HTTP server's socket timeout (SERVER_TIMEOUT). It matches the
 * Chainlink bridge's 840 s (design §11): a code-review evaluation works for up to
 * 780 s with nothing on the socket, and a shorter timeout would close it first.
 */

const DEFAULT_SERVER_TIMEOUT_MS = 840000;

/** @param {object} env @returns {number} milliseconds */
function serverTimeoutMs(env = process.env) {
  return parseInt(env.SERVER_TIMEOUT, 10) || DEFAULT_SERVER_TIMEOUT_MS;
}

module.exports = { DEFAULT_SERVER_TIMEOUT_MS, serverTimeoutMs };
