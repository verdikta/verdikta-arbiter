#!/usr/bin/env node
'use strict';

/**
 * Keeps src/solcReleases.json, the runner's list of official solc releases, current (node A2c, owner Q35 condition 2).
 *
 *   node scripts/solc-releases.js --check   exit 1 when upstream has a release the table lacks, or differs from it
 *   node scripts/solc-releases.js --write   add what upstream has, and refuse to change a hash already in the table
 *
 * Official means: named under `releases` in binaries.soliditylang.org's <platform>/list.json, with the SHA-256 that
 * list gives its build. A prerelease is a build but no release. The table only grows, and an entry that changes
 * upstream stops the script: a release's bytes do not change, so that is for a person to look at.
 */

const fs = require('node:fs');
const path = require('node:path');

const TABLE = path.join(__dirname, '..', 'src', 'solcReleases.json');
const SOURCE = 'https://binaries.soliditylang.org';
const DIRS = Object.freeze({ 'linux/amd64': 'linux-amd64', 'linux/arm64': 'linux-arm64' });
const VERSION = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/;
const SHA256 = /^0x[0-9a-f]{64}$/;

/**
 * The releases of a list.json: version → SHA-256 (lowercase hex, no prefix), ordered by version.
 * @throws {Error} a list that does not read as one, rather than a table with less in it
 */
function upstreamReleases(list) {
  const releases = list && typeof list.releases === 'object' && list.releases;
  const builds = list && Array.isArray(list.builds) && list.builds;
  if (!releases || !builds || Object.keys(releases).length === 0) throw new Error('the list has no releases');
  const byPath = new Map(builds.map((b) => [b && b.path, b]));
  const out = {};
  for (const [version, file] of Object.entries(releases)) {
    if (!VERSION.test(version)) throw new Error(`the release ${JSON.stringify(version)} is not x.y.z`);
    const build = byPath.get(file);
    if (!build || !SHA256.test(String(build.sha256))) throw new Error(`the release ${version} has no build with a SHA-256 in the list`);
    out[version] = build.sha256.slice(2);
  }
  return sorted(out);
}

/** Ordered by version, so the file's diff is one line per release. */
function sorted(releases) {
  const num = (v) => v.split('.').map(Number);
  const cmp = (a, b) => { const [x, y] = [num(a), num(b)]; return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]; };
  return Object.fromEntries(Object.keys(releases).sort(cmp).map((v) => [v, releases[v]]));
}

/**
 * The table with upstream's new releases added.
 * @returns {{added:string[], table:object}}
 * @throws {Error} a release the table holds that upstream changed or no longer lists
 */
function merged(current, upstream) {
  for (const [version, sha] of Object.entries(current)) {
    if (!(version in upstream)) throw new Error(`${version} is in the table and upstream no longer lists it`);
    if (upstream[version] !== sha) throw new Error(`${version} changed upstream: ${sha} in the table, ${upstream[version]} there`);
  }
  const added = Object.keys(upstream).filter((v) => !(v in current));
  return { added, table: sorted({ ...current, ...upstream }) };
}

async function fetchList(dir) {
  const url = `${SOURCE}/${dir}/list.json`;
  const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (res.status !== 200) throw new Error(`GET ${url}: HTTP ${res.status}`);
  return res.json();
}

async function main(argv) {
  const mode = argv[0];
  if (mode !== '--check' && mode !== '--write') throw new Error('usage: solc-releases.js --check | --write');
  const data = fs.existsSync(TABLE) ? JSON.parse(fs.readFileSync(TABLE, 'utf8')) : { source: SOURCE, asOf: null, platforms: {} };
  let behind = 0;
  const platforms = {};
  for (const [platform, dir] of Object.entries(DIRS)) {
    const { added, table } = merged(data.platforms[platform] || {}, upstreamReleases(await fetchList(dir)));
    platforms[platform] = table;
    behind += added.length;
    process.stdout.write(`${platform}: ${Object.keys(table).length} releases${added.length ? `, not in the table: ${added.join(', ')}` : ', all in the table'}\n`);
  }
  if (mode === '--check') return behind === 0 ? 0 : 1;
  const next = { source: SOURCE, asOf: new Date().toISOString().slice(0, 10), platforms };
  fs.writeFileSync(TABLE, `${JSON.stringify(next, null, 1)}\n`);
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (err) => { process.stderr.write(`${err.message}\n`); process.exitCode = 2; });
}

module.exports = { upstreamReleases, merged, sorted };
