#!/usr/bin/env node
// Are the vendored files byte for byte what vendored.json says they came from? (issue #196)
//
// Offline, as VendoredFiles.t.sol checks it: every file under arbiter-operator/foundry/lib is listed in
// vendored.json with its SHA-256, and nothing else is there. With --upstream, also against each source:
//   - an npm source: the registry's integrity for that version is the one recorded, the tarball downloaded
//     from the recorded URL has it, and each file is the tarball's entry, byte for byte;
//   - a git source: the tag names the recorded commit, and each file is that commit's blob, byte for byte.
//
//   node arbiter-operator/foundry/ci/check-vendored-sources.js [--upstream]
//
// Needs node 20 (fetch), tar and git on PATH for --upstream, and https to registry.npmjs.org and
// github.com. Exit 0 when everything matches, 1 otherwise.
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const LIB = path.resolve(__dirname, '../lib');
const MANIFEST = 'vendored.json';

const problems = [];
const sha256 = (bytes) => '0x' + crypto.createHash('sha256').update(bytes).digest('hex');

function listFiles(dir, rel = '') {
  const out = [];
  for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const p = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) problems.push(`${p} is a symbolic link`);
    else if (entry.isDirectory()) out.push(...listFiles(dir, p));
    else out.push(p);
  }
  return out;
}

function offline(manifest) {
  const listed = manifest.files.map((f) => f.path);
  const sorted = [...listed].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  if (new Set(listed).size !== listed.length || listed.some((p, i) => p !== sorted[i])) problems.push('vendored.json paths are not unique and sorted');
  const present = new Set(listFiles(LIB));
  present.delete(MANIFEST);
  for (const f of manifest.files) {
    if (!present.has(f.path)) { problems.push(`${f.path} is listed but missing`); continue; }
    present.delete(f.path);
    const got = sha256(fs.readFileSync(path.join(LIB, f.path)));
    if (got !== f.sha256) problems.push(`${f.path}: sha256 ${got}, vendored.json has ${f.sha256}`);
    if (!manifest.sources.some((s) => s.id === f.source)) problems.push(`${f.path}: unknown source ${f.source}`);
  }
  for (const p of present) problems.push(`${p} is vendored but not listed in vendored.json`);
}

function compare(file, upstream, where) {
  const local = fs.readFileSync(path.join(LIB, file.path));
  if (!local.equals(upstream)) problems.push(`${file.path} differs from ${where}`);
  else if (sha256(upstream) !== file.sha256) problems.push(`${file.path}: ${where} has sha256 ${sha256(upstream)}`);
}

async function npmSource(source, files, tmp) {
  const meta = await (await fetch(`https://registry.npmjs.org/${source.package.replace('/', '%2f')}/${source.version}`)).json();
  if (meta.dist.integrity !== source.integrity) problems.push(`${source.id}: the registry says ${meta.dist.integrity} for ${source.package}@${source.version}`);
  if (meta.dist.tarball !== source.tarball) problems.push(`${source.id}: the registry's tarball is ${meta.dist.tarball}`);
  const response = await fetch(source.tarball);
  if (!response.ok) throw new Error(`${source.tarball}: HTTP ${response.status}`);
  const tarball = Buffer.from(await response.arrayBuffer());
  const integrity = 'sha512-' + crypto.createHash('sha512').update(tarball).digest('base64');
  if (integrity !== source.integrity) problems.push(`${source.id}: the tarball's integrity is ${integrity}`);
  const dir = fs.mkdtempSync(path.join(tmp, `${source.id}-`));
  fs.writeFileSync(path.join(dir, 'package.tgz'), tarball);
  fs.mkdirSync(path.join(dir, 'x'));
  execFileSync('tar', ['-xzf', path.join(dir, 'package.tgz'), '-C', path.join(dir, 'x')]);
  for (const f of files) {
    const entry = path.join(dir, 'x', f.from);
    if (!fs.existsSync(entry)) problems.push(`${f.path}: ${f.from} is not in ${source.tarball}`);
    else compare(f, fs.readFileSync(entry), `${f.from} in ${source.package}@${source.version}`);
  }
  console.log(`${source.id}: ${source.package}@${source.version}, ${files.length} files`);
}

function gitSource(source, files, tmp) {
  const dir = path.join(fs.mkdtempSync(path.join(tmp, `${source.id}-`)), 'repo');
  const git = (...a) => execFileSync('git', ['-c', 'advice.detachedHead=false', ...a], { maxBuffer: 64 << 20 });
  // One commit's trees; each blob is fetched when it is read.
  git('clone', '--quiet', '--filter=blob:none', '--no-checkout', '--depth', '1', '--branch', source.tag, `${source.repository}.git`, dir);
  const commit = git('-C', dir, 'rev-parse', 'HEAD^{commit}').toString().trim();
  if (commit !== source.commit) problems.push(`${source.id}: tag ${source.tag} names ${commit}, vendored.json has ${source.commit}`);
  for (const f of files) compare(f, git('-C', dir, 'cat-file', 'blob', `${source.commit}:${f.from}`), `${f.from} at ${source.repository} ${source.tag}`);
  console.log(`${source.id}: ${source.repository} ${source.tag} (${commit}), ${files.length} files`);
}

async function main() {
  const manifest = JSON.parse(fs.readFileSync(path.join(LIB, MANIFEST), 'utf8'));
  offline(manifest);
  console.log(`offline: ${manifest.files.length} files listed`);
  if (process.argv.includes('--upstream')) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vendored-'));
    try {
      for (const source of manifest.sources) {
        const files = manifest.files.filter((f) => f.source === source.id);
        if (files.length === 0) problems.push(`${source.id}: no file comes from it`);
        else if (source.kind === 'npm') await npmSource(source, files, tmp);
        else if (source.kind === 'git') gitSource(source, files, tmp);
        else problems.push(`${source.id}: unknown kind ${source.kind}`);
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
  for (const p of problems) console.log(`PROBLEM: ${p}`);
  console.log(problems.length ? `FAIL: ${problems.length} problem(s)` : 'OK: the vendored files are the recorded bytes');
  process.exit(problems.length ? 1 : 0);
}

main().catch((err) => {
  console.error(`ERROR: ${err.message}`);
  process.exit(1);
});
