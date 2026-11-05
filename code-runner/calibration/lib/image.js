'use strict';

/**
 * A fixture env image, written rather than built, so that its digest is a function of pinned
 * inputs on every host (the report's hash covers the digest: design §16's canary only works if
 * two hosts get one image). A `docker build` cannot give that: the digest depends on the image
 * store and on timestamps, and a `git commit` in a RUN leaves an index holding inode numbers.
 *
 * The image is what the attested builder's final stage makes (verdikta-applications,
 * stake-attestation/builder/src/dockerfile.js): FROM the pinned base, its fixed ENV, no RUN, solc
 * under XDG_DATA_HOME, /repo owned by the sandbox user. Its manifest is the base's own with two
 * layers appended. The base's descriptors stay as they are, compressed: a daemon that holds the
 * base fetches only the two new layers. (Rewriting them uncompressed fails on the containerd
 * image store, which then has the snapshots but not the blobs, and reports an image with no
 * platform: tried and measured, see the PR's design section.)
 *
 * The new layers are uncompressed tar with fixed metadata, in byte order, and the git objects
 * use stored deflate blocks: no zlib or gzip version shows in the bytes. Nothing here reads a
 * clock, a host name or the file system.
 *
 * A listing of kind `git` (node A7b) has the same two layers, from a fetched repository: the
 * repository's own objects as one pack written here (gitRepoLayer), and, when its spec has a
 * `commands.setup`, a third layer of what that build wrote (prebuiltLayer). That third layer comes
 * from running forge, so such an image's digest is not a function of pinned inputs. Nothing rests on
 * it: no such case pins a report hash.
 */

const crypto = require('node:crypto');
const { crc32 } = require('./archives');

/** The fixed author, date and message of a fixture's listed commit. */
const COMMIT_WHO = 'Verdikta calibration <calibration@verdikta.invalid> 1700000000 +0000';
const COMMIT_MESSAGE = 'listed commit\n';
/** The sandbox user, who owns /repo in an attested image. */
const SANDBOX_UID = 10001;
const LAYER_MEDIA_TYPE = 'application/vnd.oci.image.layer.v1.tar';
const CONFIG_MEDIA_TYPE = 'application/vnd.oci.image.config.v1+json';
const MANIFEST_MEDIA_TYPE = 'application/vnd.oci.image.manifest.v1+json';

const TOOLS = '/opt/verdikta/tools';
/** The builder's fixed ENV: the pinned base's PATH with the tools last. */
const ENV = Object.freeze([
  `PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:${TOOLS}/bin`,
  `XDG_DATA_HOME=${TOOLS}/share`,
  `VERDIKTA_TOOLS=${TOOLS}`
]);

/** A root commit over `tree`, with the fixed author, date and message. */
function commitContent(tree) {
  return Buffer.from(`tree ${tree}\nauthor ${COMMIT_WHO}\ncommitter ${COMMIT_WHO}\n\n${COMMIT_MESSAGE}`);
}

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const digestOf = (bytes) => `sha256:${sha256(bytes)}`;

/** A zlib stream of stored blocks: valid for every inflater, and the same bytes from every zlib. */
function storedDeflate(bytes) {
  const parts = [Buffer.from([0x78, 0x01])];
  let at = 0;
  do {
    const size = Math.min(0xffff, bytes.length - at);
    const head = Buffer.alloc(5);
    head[0] = at + size >= bytes.length ? 1 : 0;
    head.writeUInt16LE(size, 1);
    head.writeUInt16LE(~size & 0xffff, 3);
    parts.push(head, bytes.subarray(at, at + size));
    at += size;
  } while (at < bytes.length);
  let a = 1;
  let b = 0;
  for (const byte of bytes) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  const adler = Buffer.alloc(4);
  adler.writeUInt32BE(((b << 16) | a) >>> 0);
  parts.push(adler);
  return Buffer.concat(parts);
}

/**
 * The listed commit of a fixture: loose objects of a tree of plain files, one fixed commit on no parent.
 * @param {Record<string, Buffer>} files - repository-relative path → bytes
 * @returns {{commit:string, tree:string, objects:Map<string,Buffer>}} ids (SHA-1) and each object's loose form
 */
function gitObjects(files) {
  const objects = new Map();
  const put = (type, content) => {
    const full = Buffer.concat([Buffer.from(`${type} ${content.length}\0`), content]);
    const id = crypto.createHash('sha1').update(full).digest('hex');
    objects.set(id, storedDeflate(full));
    return id;
  };
  const root = new Map();
  for (const [rel, bytes] of Object.entries(files)) {
    const parts = rel.split('/');
    let at = root;
    for (const part of parts.slice(0, -1)) {
      if (!at.has(part)) at.set(part, new Map());
      at = at.get(part);
    }
    at.set(parts[parts.length - 1], bytes);
  }
  const writeTree = (dir) => {
    const entries = [...dir.entries()].map(([name, value]) => {
      const isTree = value instanceof Map;
      return { name, isTree, id: isTree ? writeTree(value) : put('blob', value) };
    });
    // git's order: a tree sorts as if its name ended in "/".
    entries.sort((x, y) => Buffer.compare(Buffer.from(`${x.name}${x.isTree ? '/' : ''}`), Buffer.from(`${y.name}${y.isTree ? '/' : ''}`)));
    return put('tree', Buffer.concat(entries.flatMap((e) => [Buffer.from(`${e.isTree ? '40000' : '100644'} ${e.name}\0`), Buffer.from(e.id, 'hex')])));
  };
  const tree = writeTree(root);
  const commit = put('commit', commitContent(tree));
  return { commit, tree, objects };
}

function tarHeader(entryPath, { mode, size, type, uid, gid, link = null }) {
  let name = Buffer.from(entryPath);
  let prefix = Buffer.alloc(0);
  if (name.length > 100) {
    const text = entryPath;
    const cut = text.lastIndexOf('/', 155);
    if (cut <= 0 || Buffer.byteLength(text.slice(cut + 1)) > 100 || Buffer.byteLength(text.slice(0, cut)) > 155) {
      throw new Error(`the path ${text.slice(0, 60)}… is too long for a tar header`);
    }
    prefix = Buffer.from(text.slice(0, cut));
    name = Buffer.from(text.slice(cut + 1));
  }
  const head = Buffer.alloc(512);
  name.copy(head, 0);
  const octal = (value, at, width) => head.write(`${value.toString(8).padStart(width, '0')}\0`, at, width + 1, 'latin1');
  octal(mode, 100, 7);
  octal(uid, 108, 7);
  octal(gid, 116, 7);
  octal(size, 124, 11);
  octal(0, 136, 11); // mtime
  head.write('        ', 148, 8, 'latin1');
  head.write(type, 156, 1, 'latin1');
  if (link !== null) {
    if (Buffer.byteLength(link) > 100) throw new Error(`the link ${entryPath} leads to a path too long for a tar header`);
    head.write(link, 157, 100, 'utf8');
  }
  head.write('ustar\0' + '00', 257, 8, 'latin1');
  prefix.copy(head, 345);
  let sum = 0;
  for (const byte of head) sum += byte;
  head.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'latin1');
  return head;
}

/**
 * An uncompressed tar of `entries`, in byte order of path, with mtime 0.
 * @param {Array<{path:string, dir?:boolean, link?:string, bytes?:Buffer, mode:number, uid:number, gid:number}>} entries
 */
function tarLayer(entries) {
  const sorted = [...entries].sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  const parts = [];
  for (const e of sorted) {
    if (e.dir) {
      parts.push(tarHeader(`${e.path}/`, { mode: e.mode, size: 0, type: '5', uid: e.uid, gid: e.gid }));
    } else if (e.link !== undefined) {
      parts.push(tarHeader(e.path, { mode: e.mode, size: 0, type: '2', uid: e.uid, gid: e.gid, link: e.link }));
    } else {
      parts.push(tarHeader(e.path, { mode: e.mode, size: e.bytes.length, type: '0', uid: e.uid, gid: e.gid }), e.bytes);
      const pad = (512 - (e.bytes.length % 512)) % 512;
      if (pad) parts.push(Buffer.alloc(pad));
    }
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

/** `files` with an entry for every directory on the way to them. */
function entriesOf(files, { uid, gid, fileMode = 0o644, dirs = [] }) {
  const all = new Set(dirs);
  for (const file of Object.keys(files)) {
    const parts = file.split('/');
    for (let i = 1; i < parts.length; i += 1) all.add(parts.slice(0, i).join('/'));
  }
  for (const dir of [...all]) {
    const parts = dir.split('/');
    for (let i = 1; i < parts.length; i += 1) all.add(parts.slice(0, i).join('/'));
  }
  return [
    ...[...all].map((dir) => ({ path: dir, dir: true, mode: 0o755, uid, gid })),
    ...Object.entries(files).map(([file, bytes]) => ({ path: file, bytes, mode: fileMode, uid, gid }))
  ];
}

/**
 * /repo: the tracked files, the listed commit's objects, and what only the image has (an
 * installed dependency, untracked), owned by the sandbox user as the builder leaves them.
 * @param {object} o
 * @param {Record<string,Buffer>} o.files - tracked files
 * @param {Record<string,Buffer>} [o.imageOnly] - files in the image and not in the commit
 * @returns {{layer:Buffer, commit:string}}
 */
function repoLayer({ files, imageOnly = {} }) {
  const { commit, objects } = gitObjects(files);
  const tree = {};
  for (const [rel, bytes] of Object.entries({ ...files, ...imageOnly })) tree[`repo/${rel}`] = bytes;
  for (const [id, bytes] of objects) tree[`repo/.git/objects/${id.slice(0, 2)}/${id.slice(2)}`] = bytes;
  tree['repo/.git/HEAD'] = Buffer.from('ref: refs/heads/main\n');
  tree['repo/.git/config'] = Buffer.from('[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n');
  tree['repo/.git/refs/heads/main'] = Buffer.from(`${commit}\n`);
  return { layer: tarLayer(entriesOf(tree, { uid: SANDBOX_UID, gid: SANDBOX_UID })), commit };
}

/**
 * The tools: official solc releases where the builder's setup installs them, under XDG_DATA_HOME.
 * @param {object} o
 * @param {string} [o.release] - one release, e.g. 0.8.31
 * @param {Buffer} [o.bytes] - its binary, checked by SHA-256 by whoever fetched it
 * @param {Array<{release:string, bytes:Buffer}>} [o.releases] - or several
 * @returns {Buffer}
 */
function toolsLayer({ release, bytes, releases = null }) {
  const tools = TOOLS.slice(1);
  const list = releases || [{ release, bytes }];
  const files = Object.fromEntries(list.map((r) => [`${tools}/share/svm/${r.release}/solc-${r.release}`, r.bytes]));
  return tarLayer(entriesOf(files, { uid: 0, gid: 0, fileMode: 0o755, dirs: [`${tools}/bin`] }));
}

/**
 * The listed commit of a project in a subfolder: a root commit over the subfolder's own tree, a pure function of the tree's id.
 * @param {string} tree
 * @returns {{id:string, content:Buffer}}
 */
function rootedCommit(tree) {
  const content = commitContent(tree);
  const id = crypto.createHash('sha1').update(Buffer.concat([Buffer.from(`commit ${content.length}\0`), content])).digest('hex');
  return { id, content };
}

const PACK_TYPE = Object.freeze({ commit: 1, tree: 2, blob: 3 });

/**
 * One pack and its index of `objects`, by id, with stored deflate blocks: the same objects give the same bytes on every
 * host. One pack and not loose objects: a repository holds thousands, and the runner copies each file into every sandbox.
 * @param {Map<string,{type:string,content:Buffer}>} objects - SHA-1 id → object
 * @returns {{name:string, pack:Buffer, idx:Buffer}}
 */
function packFiles(objects) {
  const ids = [...objects.keys()].sort();
  const head = Buffer.alloc(12);
  head.write('PACK', 0, 'latin1');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(ids.length, 8);
  const parts = [head];
  const crcs = [];
  const offsets = [];
  let at = head.length;
  for (const id of ids) {
    const { type, content } = objects.get(id);
    if (!PACK_TYPE[type]) throw new TypeError(`no pack type for ${type}`);
    const sizeBytes = [];
    let size = content.length;
    let b = (PACK_TYPE[type] << 4) | (size & 0x0f);
    size = Math.floor(size / 16);
    while (size > 0) {
      sizeBytes.push(b | 0x80);
      b = size & 0x7f;
      size = Math.floor(size / 128);
    }
    sizeBytes.push(b);
    const entry = Buffer.concat([Buffer.from(sizeBytes), storedDeflate(content)]);
    offsets.push(at);
    crcs.push(crc32(entry));
    parts.push(entry);
    at += entry.length;
  }
  if (at >= 0x80000000) throw new Error('a pack over 2 GiB needs 64-bit offsets, which this harness does not write');
  const body = Buffer.concat(parts);
  const trailer = crypto.createHash('sha1').update(body).digest();
  const pack = Buffer.concat([body, trailer]);

  const fanout = Buffer.alloc(256 * 4);
  let seen = 0;
  for (let i = 0; i < 256; i += 1) {
    while (seen < ids.length && parseInt(ids[seen].slice(0, 2), 16) <= i) seen += 1;
    fanout.writeUInt32BE(seen, i * 4);
  }
  const u32s = (list) => {
    const out = Buffer.alloc(list.length * 4);
    list.forEach((v, i) => out.writeUInt32BE(v, i * 4));
    return out;
  };
  const idxBody = Buffer.concat([
    Buffer.from([0xff, 0x74, 0x4f, 0x63, 0, 0, 0, 2]), fanout, Buffer.concat(ids.map((id) => Buffer.from(id, 'hex'))), u32s(crcs), u32s(offsets), trailer
  ]);
  const idx = Buffer.concat([idxBody, crypto.createHash('sha1').update(idxBody).digest()]);
  return { name: `pack-${trailer.toString('hex')}`, pack, idx };
}

/**
 * /repo of a listing of kind `git`: the work tree with its modes and links, the objects as one pack, an empty folder for a
 * submodule left out (the runner's checkout makes the same), owned by the sandbox user.
 * @param {object} o
 * @param {string} o.commit - the listed commit
 * @param {Map<string,{type:string,content:Buffer}>} o.objects
 * @param {Array<{path:string, mode:number, bytes?:Buffer, link?:string}>} o.files
 * @param {string[]} [o.emptyDirs]
 * @returns {{layer:Buffer, commit:string}}
 */
function gitRepoLayer({ commit, objects, files, emptyDirs = [] }) {
  const { name, pack, idx } = packFiles(objects);
  const owner = { uid: SANDBOX_UID, gid: SANDBOX_UID };
  const plain = {
    [`repo/.git/objects/pack/${name}.pack`]: pack,
    [`repo/.git/objects/pack/${name}.idx`]: idx,
    'repo/.git/HEAD': Buffer.from('ref: refs/heads/main\n'),
    'repo/.git/config': Buffer.from('[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n'),
    'repo/.git/refs/heads/main': Buffer.from(`${commit}\n`)
  };
  const dirs = new Set(['repo', ...emptyDirs.map((d) => `repo/${d}`)]);
  const entries = [...files.map((f) => (f.link !== undefined
    ? { path: `repo/${f.path}`, link: f.link, mode: 0o777, ...owner }
    : { path: `repo/${f.path}`, bytes: f.bytes, mode: f.mode, ...owner }))];
  for (const e of [...entries, ...Object.keys(plain).map((p) => ({ path: p }))]) {
    const parts = e.path.split('/');
    for (let i = 1; i < parts.length; i += 1) dirs.add(parts.slice(0, i).join('/'));
  }
  for (const dir of [...dirs]) {
    const parts = dir.split('/');
    for (let i = 1; i < parts.length; i += 1) dirs.add(parts.slice(0, i).join('/'));
  }
  return {
    commit,
    layer: tarLayer([
      ...[...dirs].map((dir) => ({ path: dir, dir: true, mode: 0o755, ...owner })),
      ...entries,
      ...Object.entries(plain).map(([p, bytes]) => ({ path: p, bytes, mode: 0o644, ...owner }))
    ])
  };
}

/** A tar's entries: plain files, folders and links, a GNU or pax long name read as the name. */
function parseTar(buffer) {
  const out = [];
  let at = 0;
  let longName = null;
  const text = (from, width) => {
    const slice = buffer.subarray(from, from + width);
    const end = slice.indexOf(0);
    return slice.toString('utf8', 0, end < 0 ? width : end);
  };
  while (at + 512 <= buffer.length) {
    const headAt = at;
    const head = buffer.subarray(at, at + 512);
    if (head.every((b) => b === 0)) break;
    const size = parseInt(text(at + 124, 12).trim() || '0', 8);
    const type = String.fromCharCode(head[156] || 0x30);
    const bytes = buffer.subarray(at + 512, at + 512 + size);
    at += 512 + Math.ceil(size / 512) * 512;
    if (type === 'L') {
      longName = bytes.toString('utf8').replace(/\0+$/, '');
      continue;
    }
    if (type === 'x') {
      const m = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(bytes.toString('utf8'));
      if (m) longName = m[1];
      continue;
    }
    if (type === 'K' || type === 'g') continue;
    const prefix = text(headAt + 345, 155);
    const name = longName || (prefix ? `${prefix}/${text(headAt, 100)}` : text(headAt, 100));
    longName = null;
    const clean = name.replace(/^\.\//, '').replace(/\/$/, '');
    if (clean === '' || clean === '.') continue;
    if (type === '5') out.push({ path: clean, type: 'dir' });
    else if (type === '0' || type === '\0') out.push({ path: clean, type: 'file', bytes });
    else out.push({ path: clean, type: `other:${type}` });
  }
  return out;
}

/**
 * What the listing's `commands.setup` wrote, as the attested builder's image keeps it (out/, cache/ in /repo): a tar from
 * the container, rewritten with fixed metadata, under /repo, owned by the sandbox user.
 * @param {Buffer} tarBytes
 * @returns {Buffer}
 * @throws {Error} a path that leaves the folder, a link or device, or nothing at all
 */
function prebuiltLayer(tarBytes) {
  const entries = parseTar(tarBytes);
  const files = {};
  for (const e of entries) {
    if (e.path.startsWith('/') || e.path.split('/').includes('..')) throw new Error(`the build's output has a path that leaves its folder: ${e.path.slice(0, 120)}`);
    if (e.type === 'file') files[`repo/${e.path}`] = e.bytes;
    else if (e.type !== 'dir') throw new Error(`the build's output has something other than a file or folder at ${e.path.slice(0, 120)}`);
  }
  if (Object.keys(files).length === 0) throw new Error('the build wrote nothing');
  return tarLayer(entriesOf(files, { uid: SANDBOX_UID, gid: SANDBOX_UID }));
}

/**
 * The image: the base's manifest and config with `layers` appended.
 * @param {object} o
 * @param {object} o.baseManifest - parsed; its bytes checked against its pinned digest by the caller
 * @param {object} o.baseConfig - parsed; its bytes checked against the manifest's digest by the caller
 * @param {Buffer[]} o.layers
 * @returns {{digest:string, manifest:object, manifestBytes:Buffer, configBytes:Buffer, added:Array<{digest:string,size:number,bytes:Buffer}>}}
 */
function assembleImage({ baseManifest, baseConfig, layers }) {
  const added = layers.map((bytes) => ({ digest: digestOf(bytes), size: bytes.length, bytes }));
  const config = JSON.parse(JSON.stringify(baseConfig));
  config.config.Env = [...ENV];
  config.rootfs.diff_ids = [...config.rootfs.diff_ids, ...added.map((l) => l.digest)];
  // One entry per layer: `docker history` is how the listing check reads an image's size.
  config.history = [...(config.history || []), ...added.map((_, i) => ({ comment: `verdikta fixture layer ${i + 1}` }))];
  const configBytes = Buffer.from(JSON.stringify(config));
  const manifest = {
    schemaVersion: 2,
    mediaType: MANIFEST_MEDIA_TYPE,
    config: { mediaType: CONFIG_MEDIA_TYPE, digest: digestOf(configBytes), size: configBytes.length },
    layers: [...baseManifest.layers, ...added.map((l) => ({ mediaType: LAYER_MEDIA_TYPE, digest: l.digest, size: l.size }))]
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  return { digest: digestOf(manifestBytes), manifest, manifestBytes, configBytes, added };
}

/** The manifest of `platform` (os/arch) in the pinned multi-platform index. */
function parseBaseIndex(index, platform) {
  const [os, architecture] = platform.split('/');
  const found = (index.manifests || []).find((m) => m.platform && m.platform.os === os && m.platform.architecture === architecture);
  if (!found) throw new Error(`the pinned base's index has no ${platform} manifest`);
  return found.digest;
}

module.exports = {
  ENV, MANIFEST_MEDIA_TYPE, SANDBOX_UID, sha256, digestOf, storedDeflate, gitObjects, tarLayer, repoLayer, toolsLayer, assembleImage, parseBaseIndex,
  rootedCommit, packFiles, gitRepoLayer, parseTar, prebuiltLayer
};
