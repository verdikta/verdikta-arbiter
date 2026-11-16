'use strict';

/**
 * The official solc releases, by SHA-256, for the listing check's look at the compilers in an image (node A2c, owner Q35
 * condition 2; integrity.officialCompilers). solcReleases.json comes from binaries.soliditylang.org's
 * <platform>/list.json by scripts/solc-releases.js: a release is what that list names under `releases`.
 *
 * Only the listing check reads it. A claim never does, so two arbiters on different runner versions cannot split on a new
 * release; only the runner the builder calls needs the current table.
 *
 * linux/amd64 is the class platform. linux/arm64 is a development setting (config.js, runc only): the same rule on
 * soliditylang's own arm64 list, which starts at 0.8.31. forge's own install does not always match these: below 0.4.10 on
 * amd64 it downloads crytic/solc's builds, and below 0.8.31 on arm64 nikitastupin/solc's. Those are not official here.
 */

const data = require('./solcReleases.json');

const VERSION = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/;
const SHA256 = /^[0-9a-f]{64}$/;

const SOURCE = data.source;

function newestOf(versions) {
  const num = (v) => v.split('.').map(Number);
  return versions.reduce((a, b) => {
    const [x, y] = [num(a), num(b)];
    return (x[0] - y[0] || x[1] - y[1] || x[2] - y[2]) >= 0 ? a : b;
  });
}

/**
 * A list as the look reads it.
 * @param {{platform:string, asOf:string, releases:Record<string,string>}} o - version → SHA-256
 * @returns {{platform:string, asOf:string, newest:string, releases:Map<string,string>, byHash:Map<string,string>}}
 */
function makeList({ platform, asOf, releases }) {
  const entries = Object.entries(releases);
  if (entries.length === 0) throw new TypeError(`the list for ${platform} is empty`);
  for (const [version, sha] of entries) {
    if (!VERSION.test(version) || !SHA256.test(sha)) throw new TypeError(`the list for ${platform} has a malformed entry for ${version}`);
  }
  return Object.freeze({
    platform, asOf, newest: newestOf(entries.map(([v]) => v)), releases: new Map(entries), byHash: new Map(entries.map(([v, sha]) => [sha, v]))
  });
}

/**
 * The runner's list for a platform.
 * @param {string} platform - config.platform
 * @throws {TypeError} a platform the table does not hold
 */
function officialList(platform) {
  const releases = data.platforms[platform];
  if (!releases) throw new TypeError(`no list of official solc releases for ${platform}`);
  return makeList({ platform, asOf: data.asOf, releases });
}

module.exports = { officialList, makeList, SOURCE };
