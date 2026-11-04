'use strict';

/**
 * A public repository at a commit, for a listing of kind `git` (node A7b). Fetched at run time,
 * into a cache on this host, and never into the tree: this public repository commits no third
 * party's code. What comes back is what the image is written from: the listed commit, its trees
 * and blobs, each submodule's commit, trees and blobs, and the work tree they make.
 *
 * A project in a subfolder (`repo.subdir`, a Sherlock contest's layout): a listing's forge runs at
 * the root of the listed commit and `--root` is not an allowed flag (Q31), so the listed commit is
 * one written here over the subfolder's own tree (image.rootedCommit). The tree id is the
 * upstream's, pinned in listing.json and checked here, so the files are the upstream's byte for
 * byte. The upstream's commit object stays out: it names another tree.
 *
 * Git runs as data: no user or system configuration, no prompt, no checkout and so no filter or
 * hook of the repository's, one bare store. `.gitmodules` is read only for its paths and URLs, and
 * a URL that is not https (or the ssh form of a public host, read as https) is not fetched. A
 * submodule that cannot be fetched is recorded, and fetchListedRepo stops on it: an image with a
 * folder quietly empty would not be the listing's repository. A store with one is not kept, so a
 * fetch that failed once is tried again.
 */

const { execFileSync, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { rootedCommit } = require('./image');

const MAX_SUBMODULES = 64;
const MAX_DEPTH = 8;
const FETCH_TIMEOUT_MS = 300000;
const GIT_TIMEOUT_MS = 120000;
const BATCH = 2000;
const COMMIT = /^[0-9a-f]{40}$/;
const SSH_FORM = /^(?:ssh:\/\/)?git@([A-Za-z0-9.-]+)[:/](.+)$/;
const FILE_MODES = Object.freeze({ 100644: 0o644, 100755: 0o755, 100664: 0o644 });

/** Only what git needs from this host: no configuration, identity, GIT_* or prompt of the caller's. */
function hermeticGitEnv(base = process.env) {
  const env = { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' };
  for (const key of ['PATH', 'SSL_CERT_FILE', 'SSL_CERT_DIR']) if (base[key]) env[key] = base[key];
  return env;
}

/**
 * The URL a .gitmodules entry leads to, as git resolves a relative one, or null where it must not go.
 * @param {string} parent - the repository holding the .gitmodules
 * @param {string} url
 * @param {{allowFile?:boolean}} [o]
 */
function resolveSubmoduleUrl(parent, url, { allowFile = false } = {}) {
  if (typeof url !== 'string' || url === '') return null;
  if (url.startsWith('https://')) return url;
  if (allowFile && url.startsWith('file://')) return url;
  const ssh = SSH_FORM.exec(url);
  if (ssh) return `https://${ssh[1]}/${ssh[2]}`;
  if (url.startsWith('./') || url.startsWith('../')) {
    let base = parent.replace(/\/+$/, '');
    let rest = url;
    for (;;) {
      if (rest.startsWith('./')) rest = rest.slice(2);
      else if (rest.startsWith('../')) {
        const cut = base.lastIndexOf('/');
        if (cut <= base.indexOf('://') + 2) return null;
        base = base.slice(0, cut);
        rest = rest.slice(3);
      } else break;
    }
    return `${base}/${rest}`;
  }
  return null;
}

function parseLsTree(buffer) {
  const out = [];
  for (const line of buffer.toString('latin1').split('\0')) {
    if (!line) continue;
    const m = /^([0-7]+) (blob|tree|commit) ([0-9a-f]{40})\t([\s\S]*)$/.exec(line);
    if (!m) throw new Error(`git ls-tree printed ${JSON.stringify(line.slice(0, 80))}`);
    out.push({ mode: m[1], type: m[2], id: m[3], path: Buffer.from(m[4], 'latin1').toString('utf8') });
  }
  return out;
}

/** Path → URL of a commit's .gitmodules, as the blob says; nothing else of it is read. */
function readGitmodules(g, commit) {
  let text;
  try {
    text = g(['config', '--blob', `${commit}:.gitmodules`, '--null', '--get-regexp', '^submodule\\..*\\.(path|url)$']).toString('utf8');
  } catch (_) {
    return new Map();
  }
  const names = new Map();
  for (const entry of text.split('\0')) {
    if (!entry) continue;
    const cut = entry.indexOf('\n');
    const key = cut < 0 ? entry : entry.slice(0, cut);
    const value = cut < 0 ? '' : entry.slice(cut + 1);
    const m = /^submodule\.(.*)\.(path|url)$/.exec(key);
    if (!m) continue;
    if (!names.has(m[1])) names.set(m[1], {});
    names.get(m[1])[m[2]] = value;
  }
  const out = new Map();
  for (const { path: p, url } of names.values()) if (p && url) out.set(p, url);
  return out;
}

/** Each id's type and bytes, by `git cat-file --batch`. */
function readObjects(store, env, ids, into) {
  for (let at = 0; at < ids.length; at += BATCH) {
    const chunk = ids.slice(at, at + BATCH);
    const r = spawnSync('git', ['-C', store, 'cat-file', '--batch'], { env, input: `${chunk.join('\n')}\n`, maxBuffer: 4 * 1024 * 1024 * 1024 - 1, timeout: GIT_TIMEOUT_MS });
    if (r.status !== 0) throw new Error(`git cat-file failed: ${String(r.stderr).slice(0, 300)}`);
    let pos = 0;
    for (const id of chunk) {
      const nl = r.stdout.indexOf(0x0a, pos);
      const head = r.stdout.toString('latin1', pos, nl).split(' ');
      if (head[0] !== id || head.length !== 3) throw new Error(`git cat-file answered ${head.join(' ')} for ${id}`);
      const size = Number(head[2]);
      into.set(id, { type: head[1], content: Buffer.from(r.stdout.subarray(nl + 1, nl + 1 + size)) });
      pos = nl + 1 + size + 1;
    }
  }
}

/** What a tree may hold: a path written into a layer stays under /repo, and git's own folder is the runner's. */
function badPath(p) {
  return p.startsWith('/') || p.split('/').some((part) => part === '..' || part === '.' || part === '' || part.toLowerCase() === '.git');
}

/**
 * @param {{url:string, commit:string, subdir?:string, tree?:string}} repo - a listing's repo
 * @param {object} o
 * @param {string} o.cacheDir - kept between runs, so a repository is fetched once per commit
 * @param {boolean} [o.allowFile] - file:// URLs, for the tests' local upstreams
 * @returns {Promise<{commit:string, tree:string, objects:Map<string,{type:string,content:Buffer}>,
 *   files:Array<{path:string, mode:number, bytes?:Buffer, link?:string}>, emptyDirs:string[],
 *   missing:Array<{path:string, commit:string, reason:string}>}>}
 * @throws {Error} a commit the remote does not have, or a tree that is not the one pinned
 */
async function fetchRepo(repo, { cacheDir, allowFile = false }) {
  const { url, commit, subdir = null, tree: pinned = null } = repo;
  if (!url.startsWith('https://') && !(allowFile && url.startsWith('file://'))) throw new Error(`a listing's repository is fetched over https only: ${url}`);
  if (!COMMIT.test(commit)) throw new Error(`a listing's repository names a full commit id: ${commit}`);
  const key = crypto.createHash('sha256').update(`${url}@${commit}`).digest('hex');
  const store = path.join(cacheDir, 'repos', `${key}.git`);
  const marker = path.join(store, 'vcr-fetched');
  const cached = fs.existsSync(marker);
  const env = hermeticGitEnv();
  const g = (args, { timeout = GIT_TIMEOUT_MS } = {}) => execFileSync('git', ['-C', store, ...args], { env, maxBuffer: 1024 * 1024 * 1024, timeout, stdio: ['ignore', 'pipe', 'pipe'] });
  if (!cached) {
    fs.rmSync(store, { recursive: true, force: true });
    fs.mkdirSync(store, { recursive: true });
    g(['init', '-q', '--bare', '.']);
  }
  const has = (id) => {
    try {
      g(['cat-file', '-e', `${id}^{commit}`]);
      return true;
    } catch (_) {
      return false;
    }
  };
  /** Fetched before, or fetched now. Never the network once this store is complete. */
  const get = (from, id) => {
    if (has(id)) return true;
    if (cached) return false;
    try {
      g(['-c', `protocol.file.allow=${allowFile ? 'always' : 'never'}`, 'fetch', '-q', '--depth', '1', '--no-tags', '--no-write-fetch-head', '--', from, id], { timeout: FETCH_TIMEOUT_MS });
    } catch (_) {
      return false;
    }
    return has(id);
  };
  if (!get(url, commit)) throw new Error(`${url} at ${commit} could not be fetched`);

  const ids = new Set();
  const files = [];
  const emptyDirs = [];
  const missing = [];
  let submodules = 0;

  /** One repository's tree: `at` is where its files go in the work tree, `inRepo` where this tree sits in its own repository. */
  const walk = (ownCommit, ownUrl, treeish, at, inRepo, depth) => {
    const modules = readGitmodules(g, ownCommit);
    for (const e of parseLsTree(g(['ls-tree', '-r', '-t', '-z', treeish]))) {
      if (badPath(e.path)) throw new Error(`${ownUrl} at ${ownCommit} has a path this harness will not write: ${JSON.stringify(e.path).slice(0, 120)}`);
      const whole = at ? `${at}/${e.path}` : e.path;
      if (e.type === 'tree') {
        ids.add(e.id);
      } else if (e.type === 'blob') {
        ids.add(e.id);
        if (e.mode === '120000') files.push({ path: whole, mode: 0o777, linkId: e.id });
        else if (FILE_MODES[e.mode]) files.push({ path: whole, mode: FILE_MODES[e.mode], blobId: e.id });
        else throw new Error(`${whole} has the mode ${e.mode}, which git does not write`);
      } else {
        const named = modules.get(inRepo ? `${inRepo}/${e.path}` : e.path);
        const leaveOut = (reason) => {
          missing.push({ path: whole, commit: e.id, reason });
          emptyDirs.push(whole);
        };
        const from = named ? resolveSubmoduleUrl(ownUrl, named, { allowFile }) : null;
        if (!named) leaveOut('no .gitmodules entry names this path');
        else if (!from) leaveOut(`its URL ${JSON.stringify(named).slice(0, 120)} is not one this harness fetches`);
        else if (depth >= MAX_DEPTH || submodules >= MAX_SUBMODULES) leaveOut(`more than ${MAX_SUBMODULES} submodules, or deeper than ${MAX_DEPTH}`);
        else if (!get(from, e.id)) leaveOut(`the commit could not be fetched from ${from}`);
        else {
          submodules += 1;
          ids.add(e.id);
          ids.add(g(['rev-parse', `${e.id}^{tree}`]).toString('utf8').trim());
          walk(e.id, from, e.id, whole, '', depth + 1);
        }
      }
    }
  };

  const objects = new Map();
  let listedCommit = commit;
  let tree;
  if (subdir) {
    let found;
    try {
      found = g(['rev-parse', `${commit}:${subdir}`]).toString('utf8').trim();
    } catch (_) {
      throw new Error(`${url} at ${commit} has no folder ${subdir}`);
    }
    if (found !== pinned) throw new Error(`the tree of ${subdir} at ${commit} is ${found}, not the one the listing pins, ${pinned}`);
    tree = found;
    const rooted = rootedCommit(tree);
    listedCommit = rooted.id;
    objects.set(rooted.id, { type: 'commit', content: rooted.content });
    ids.add(tree);
    walk(commit, url, tree, '', subdir, 0);
  } else {
    tree = g(['rev-parse', `${commit}^{tree}`]).toString('utf8').trim();
    ids.add(commit);
    ids.add(tree);
    walk(commit, url, commit, '', '', 0);
  }

  readObjects(store, env, [...ids], objects);
  for (const f of files) {
    if (f.linkId) {
      f.link = objects.get(f.linkId).content.toString('utf8');
      delete f.linkId;
    } else {
      f.bytes = objects.get(f.blobId).content;
      delete f.blobId;
    }
  }
  files.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  if (missing.length === 0) fs.writeFileSync(marker, 'complete\n');
  return { commit: listedCommit, tree, objects, files, emptyDirs: emptyDirs.sort(), missing };
}

/**
 * A listing's repository, whole, and the commit it names.
 * @param {{id:string, commit:string, repo:object}} listing
 * @param {object} o - as fetchRepo
 * @throws {Error} a submodule that could not be fetched, or another commit
 */
async function fetchListedRepo(listing, o) {
  const repo = await fetchRepo(listing.repo, o);
  if (repo.missing.length) {
    throw new Error(`listing ${listing.id}: ${repo.missing.map((m) => `${m.path} (${m.commit}) could not be fetched: ${m.reason}`).join('; ')}`);
  }
  if (repo.commit !== listing.commit) throw new Error(`listing ${listing.id}: its repository makes commit ${repo.commit}, and it names ${listing.commit}`);
  return repo;
}

module.exports = { fetchRepo, fetchListedRepo, resolveSubmoduleUrl, hermeticGitEnv, MAX_SUBMODULES };
