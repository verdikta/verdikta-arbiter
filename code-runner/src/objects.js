'use strict';

/**
 * git objects as data (design §9.2 step 3; owner decision Q25, "force the
 * checkout"). The runner reads the listed commit's commit, tree and blob
 * objects out of the env image as raw bytes and re-hashes every one before
 * it uses it: `<type> <size>\0<content>`, SHA-1, or SHA-256 for a SHA-256
 * repository (the listed commit's length says which). What a store answers
 * for an id is never trusted; what hashes to the id is.
 *
 * - hashObject: the id git gives an object
 * - parseCommitTree, parseTree: the fields the checkout needs, read strictly
 *   (a tree's entries in git's order, no duplicate, no name git would refuse
 *   to check out as a path component: empty, `.`, `..`, `/`, `.git`)
 * - BatchReader: `git cat-file --batch` / `--batch-check` output, streamed,
 *   capped, never stopping the producer
 * - treeObjects: the tree objects of a list of files, as git writes them
 * - packObjects, commitObject: the pack that puts the verified blobs, the
 *   runner's trees and its commit into the fresh repository
 *
 * Paths are byte strings ('latin1': one character per byte), so any name git
 * can hold round-trips and code-unit order is byte order.
 */

const crypto = require('node:crypto');
const zlib = require('node:zlib');

const ALGORITHMS = Object.freeze({ 40: 'sha1', 64: 'sha256' });

/** The object format of a repository whose listed commit is `id`: 'sha1' or 'sha256'. */
function algorithmOf(id) {
  const algo = typeof id === 'string' && /^[0-9a-f]+$/.test(id) ? ALGORITHMS[id.length] : undefined;
  if (!algo) throw new TypeError(`not a full object id: ${JSON.stringify(id)}`);
  return algo;
}

const hexLength = (algo) => (algo === 'sha256' ? 64 : 40);

/** The id of an object: the hash of `<type> <size>\0` and its content. */
function hashObject(algo, type, content) {
  return crypto.createHash(algo).update(`${type} ${content.length}\0`).update(content).digest('hex');
}

/** A commit's tree: its first header line, `tree <id>` (git requires it first). Null when malformed. */
function parseCommitTree(content, algo) {
  const head = content.subarray(0, 5 + hexLength(algo) + 1).toString('latin1');
  const m = new RegExp(`^tree ([0-9a-f]{${hexLength(algo)}})\n$`).exec(head);
  return m ? m[1] : null;
}

const KIND = Object.freeze({ tree: 'tree', blob: 'blob', exec: 'exec', link: 'link', gitlink: 'gitlink' });
/** The mode a kind has in a tree git writes. */
const MODE = Object.freeze({ tree: '40000', blob: '100644', exec: '100755', link: '120000', gitlink: '160000' });

/** Why git would refuse a tree entry's name as a path component, or null. */
function badName(name) {
  if (name.length === 0) return 'an empty name';
  if (name.length > 255) return 'a name longer than 255 bytes';
  if (name.includes('/')) return `a name with "/" (${JSON.stringify(name.slice(0, 80))})`;
  if (name === '.' || name === '..') return `the name ${JSON.stringify(name)}`;
  if (name.toLowerCase() === '.git') return `an entry named ${JSON.stringify(name)}`;
  return null;
}

/** git's tree order: names compared byte by byte, a tree's name as if it ended in '/'. */
function sortKey(entry) {
  return entry.kind === KIND.tree ? `${entry.name}/` : entry.name;
}

/**
 * A tree object's entries, read strictly.
 * @returns {{ok:true, entries:Array<{name:string, kind:string, id:string}>} | {ok:false, reason:string}}
 *   names are byte strings; kind is tree, blob (100644), exec (100755), link (120000) or gitlink (160000)
 */
function parseTree(content, algo) {
  const idBytes = hexLength(algo) / 2;
  const entries = [];
  const names = new Set();
  let prev = null;
  let pos = 0;
  const bad = (reason) => ({ ok: false, reason });
  while (pos < content.length) {
    const sp = content.indexOf(0x20, pos);
    if (sp <= pos || sp - pos > 7) return bad('an entry without a mode');
    const modeText = content.toString('latin1', pos, sp);
    if (!/^[0-7]+$/.test(modeText)) return bad(`the mode ${JSON.stringify(modeText)}`);
    const mode = parseInt(modeText, 8);
    const nul = content.indexOf(0, sp + 1);
    if (nul < 0) return bad('an entry whose name does not end');
    if (nul + 1 + idBytes > content.length) return bad('an entry whose id is cut short');
    const name = content.toString('latin1', sp + 1, nul);
    const id = content.toString('hex', nul + 1, nul + 1 + idBytes);
    pos = nul + 1 + idBytes;
    // git's canon_mode: the type bits decide; a regular file is 100644 or 100755 by its owner-execute bit.
    let kind;
    switch (mode & 0o170000) {
      case 0o040000: kind = KIND.tree; break;
      case 0o100000: kind = mode & 0o100 ? KIND.exec : KIND.blob; break;
      case 0o120000: kind = KIND.link; break;
      case 0o160000: kind = KIND.gitlink; break;
      default: return bad(`the mode ${modeText}`);
    }
    const why = badName(name);
    if (why) return bad(why);
    if (names.has(name)) return bad(`the name ${JSON.stringify(name.slice(0, 80))} twice`);
    names.add(name);
    const entry = { name, kind, id };
    const key = sortKey(entry);
    if (prev !== null && !(prev < key)) return bad('entries out of git\'s order');
    prev = key;
    entries.push(entry);
  }
  return { ok: true, entries };
}

/**
 * The tree objects git builds for `files` (each { path, kind, id }, path a
 * byte string): one per directory, entries in git's order, modes as git
 * writes them.
 * @returns {{id:string, objects:Map<string, Buffer>}} the root tree's id and every tree's content by id
 */
function treeObjects(files, algo) {
  const root = new Map();
  for (const f of files) {
    const parts = f.path.split('/');
    let dir = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      let next = dir.get(parts[i]);
      if (!next) { next = { kind: KIND.tree, children: new Map() }; dir.set(parts[i], next); }
      if (next.kind !== KIND.tree) throw new Error(`a file and a directory at ${parts.slice(0, i + 1).join('/')}`);
      dir = next.children;
    }
    const leaf = parts[parts.length - 1];
    if (dir.has(leaf)) throw new Error(`two entries at ${f.path}`);
    dir.set(leaf, { kind: f.kind, id: f.id });
  }
  const objects = new Map();
  const write = (dir) => {
    const entries = [...dir].map(([name, node]) => ({ name, kind: node.kind, id: node.kind === KIND.tree ? write(node.children) : node.id }));
    entries.sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : 1));
    const content = Buffer.concat(entries.flatMap((e) => [Buffer.from(`${MODE[e.kind]} ${e.name}\0`, 'latin1'), Buffer.from(e.id, 'hex')]));
    const id = hashObject(algo, 'tree', content);
    objects.set(id, content);
    return id;
  };
  return { id: write(root), objects };
}

/**
 * `git cat-file --batch` (or `--batch-check`) output, read as it streams.
 * One record per requested id: `<id> missing`, or `<id> <type> <size>` and,
 * for --batch, the content and a newline. An object above `maxObjectBytes`,
 * or content past `maxTotalBytes`, is counted, not kept, and makes the read
 * `overflow`. `write` always returns true: the producer is never stopped
 * (its exit code is the answer).
 */
class BatchReader {
  constructor({ algo, check = false, maxObjectBytes, maxTotalBytes }) {
    this.check = check;
    this.maxObjectBytes = maxObjectBytes;
    this.maxTotalBytes = maxTotalBytes;
    this.header = new RegExp(`^([0-9a-f]{${hexLength(algo)}}) (?:(missing)|(blob|tree|commit|tag) ([0-9]{1,15}))$`);
    this.records = [];
    this.line = [];
    this.lineBytes = 0;
    this.current = null;
    this.need = 0;
    this.kept = 0;
    this.overflow = false;
    this.error = null;
  }

  write(chunk) {
    let buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    while (buf.length > 0 && !this.error) {
      if (this.current) {
        const take = Math.min(this.need, buf.length);
        const r = this.current;
        if (r.content) buf.copy(r.content, r.filled, 0, Math.min(take, r.content.length - r.filled));
        r.filled += take;
        this.need -= take;
        buf = buf.subarray(take);
        if (this.need === 0) {
          if (r.filled === r.size + 1) {
            // The content is followed by one newline, which is not part of it.
            if (r.content && r.content[r.size] !== 0x0a) { this.error = `no newline after ${r.id}`; break; }
            if (r.content) r.content = r.content.subarray(0, r.size);
            delete r.filled;
            this.records.push(r);
            this.current = null;
          }
        }
        continue;
      }
      const nl = buf.indexOf(0x0a);
      const part = nl < 0 ? buf : buf.subarray(0, nl);
      this.lineBytes += part.length;
      if (this.lineBytes > 200) { this.error = 'a header line longer than 200 bytes'; break; }
      this.line.push(Buffer.from(part));
      if (nl < 0) break;
      buf = buf.subarray(nl + 1);
      const text = Buffer.concat(this.line).toString('latin1');
      this.line = [];
      this.lineBytes = 0;
      const m = this.header.exec(text);
      if (!m) { this.error = `an unreadable line: ${JSON.stringify(text.slice(0, 120))}`; break; }
      if (m[2]) { this.records.push({ id: m[1], missing: true }); continue; }
      const size = Number(m[4]);
      const r = { id: m[1], type: m[3], size };
      if (this.check) { this.records.push(r); continue; }
      const keep = size <= this.maxObjectBytes && this.kept + size <= this.maxTotalBytes;
      if (keep) { r.content = Buffer.allocUnsafe(size + 1); this.kept += size; } else { r.content = null; this.overflow = true; }
      r.filled = 0;
      this.current = r;
      this.need = size + 1;
    }
    return true;
  }

  /** @returns {{ok:true, records:object[], overflow:boolean} | {ok:false, reason:string}} */
  finish() {
    if (this.error) return { ok: false, reason: this.error };
    if (this.current || this.lineBytes > 0) return { ok: false, reason: 'the output ends inside a record' };
    return { ok: true, records: this.records, overflow: this.overflow };
  }
}

const PACK_TYPE = Object.freeze({ commit: 1, tree: 2, blob: 3 });

/**
 * A pack (version 2) of `objects` ({ type, content }), undeltified, for
 * `git index-pack --stdin`: git stores the runner's bytes and computes their
 * ids itself, and judges no path (read-tree does, after). Each entry is its
 * type and size, then its zlib-deflated content; the pack ends with the
 * repository's hash of everything before it.
 */
function packObjects(algo, objects) {
  const head = Buffer.alloc(12);
  head.write('PACK', 0, 'latin1');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(objects.length, 8);
  const parts = [head];
  for (const { type, content } of objects) {
    if (!PACK_TYPE[type]) throw new TypeError(`no pack type for ${type}`);
    const bytes = [];
    let size = content.length;
    let b = (PACK_TYPE[type] << 4) | (size & 0x0f);
    size = Math.floor(size / 16);
    while (size > 0) {
      bytes.push(b | 0x80);
      b = size & 0x7f;
      size = Math.floor(size / 128);
    }
    bytes.push(b);
    parts.push(Buffer.from(bytes), zlib.deflateSync(content, { level: 1 }));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, crypto.createHash(algo).update(body).digest()]);
}

/** A root commit's content: the tree, a fixed identity and date, the message. */
function commitObject({ tree, ident, date, message }) {
  return Buffer.from(`tree ${tree}\nauthor ${ident} ${date}\ncommitter ${ident} ${date}\n\n${message}`, 'utf8');
}

module.exports = {
  algorithmOf, hexLength, hashObject, parseCommitTree, parseTree, badName, treeObjects, BatchReader, packObjects, commitObject, KIND, MODE
};
