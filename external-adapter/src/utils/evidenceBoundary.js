/**
 * Filesystem admission boundary around @verdikta/common's evidence processing.
 * Common still owns archive extraction, manifest schemas and parsing. Until it
 * provides confinement itself, check inputs BEFORE calling it, and check files
 * again when constructing the AI payload. No paths from evidence are trusted.
 */
const fs = require('fs');
const path = require('path');
const unzipper = require('unzipper');

class UnsafeEvidenceError extends Error {
  constructor(reason, { deterministic = false } = {}) {
    super(`Unsafe evidence: ${reason}`);
    this.name = 'UnsafeEvidenceError';
    this.code = 'UNSAFE_EVIDENCE';
    // Only syntax/ZIP-type checks are properties of the submitted bytes. A
    // runtime confinement failure must never become a verdict against a party.
    this.deterministic = deterministic;
  }
}

function isUnsafeEvidenceError(error) {
  return error instanceof UnsafeEvidenceError;
}

function assertRelativePath(value) {
  // ZIP/manifest paths are portable POSIX paths. Reject Windows drive/UNC/ADS
  // spellings as well, so the same archive is safe on every supported host.
  // eslint-disable-next-line no-control-regex -- reject NUL and control bytes in untrusted filenames
  const unsafeCharacters = /[\\:\x00-\x1f\x7f]/;
  if (typeof value !== 'string' || !value || unsafeCharacters.test(value) ||
      path.posix.isAbsolute(value) || path.win32.isAbsolute(value) ||
      value.split('/').includes('..') || !value.split('/').some(p => p && p !== '.')) {
    throw new UnsafeEvidenceError('file references must be relative paths without traversal', { deterministic: true });
  }
  return value;
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '' && relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** Check every existing component, including the leaf, without following links. */
function resolveEvidenceFile(root, filename, { allowMissing = false } = {}) {
  assertRelativePath(filename);
  if (!fs.lstatSync(root).isDirectory()) throw new UnsafeEvidenceError('evidence root is not a directory');
  const realRoot = fs.realpathSync(root);
  const target = path.resolve(realRoot, filename);
  if (!isWithin(realRoot, target)) throw new UnsafeEvidenceError('file is outside its evidence root');
  const parts = path.relative(realRoot, target).split(path.sep);
  let current = realRoot;
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if (allowMissing && error.code === 'ENOENT') return target;
      throw error;
    }
    if (stat.isSymbolicLink() || (i < parts.length - 1 ? !stat.isDirectory() : !stat.isFile()) ||
        (stat.isFile() && stat.nlink !== 1)) {
      throw new UnsafeEvidenceError('evidence must contain only directories and single-link regular files');
    }
  }
  return target;
}

/** A parser-generated absolute path must belong to an explicitly supplied root. */
function resolveAttachmentPath(roots, file) {
  if (!file.path) return resolveEvidenceFile(roots[0], file.filename);
  if (typeof file.path !== 'string' || !path.isAbsolute(file.path)) {
    throw new UnsafeEvidenceError('parsed attachment path must be absolute');
  }
  for (const root of roots) {
    // Accept the lexical spelling and the canonical spelling (/var vs
    // /private/var on macOS). Both are derived from trusted extraction roots.
    for (const base of [path.resolve(root), fs.realpathSync(root)]) {
      if (isWithin(base, file.path)) {
        return resolveEvidenceFile(root, path.relative(base, file.path));
      }
    }
  }
  throw new UnsafeEvidenceError('attachment is outside this request\'s evidence roots');
}

/** Final read boundary: do not follow a swapped leaf or open a FIFO/device. */
async function readEvidenceFile(roots, file, encoding) {
  const filename = resolveAttachmentPath(roots, file);
  const before = fs.lstatSync(filename);
  let handle;
  try {
    handle = await fs.promises.open(filename,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch (error) {
    if (error.code === 'ELOOP') throw new UnsafeEvidenceError('evidence became a symbolic link');
    throw error;
  }
  try {
    const after = await handle.stat();
    if (!after.isFile() || after.nlink !== 1 || before.dev !== after.dev || before.ino !== after.ino) {
      throw new UnsafeEvidenceError('evidence file changed during read');
    }
    return await handle.readFile(encoding);
  } finally {
    await handle.close();
  }
}

let cidModule;
async function assertBareCID(value) {
  // The lexical check rules out URI fragments, paths, whitespace and percent
  // escapes; the CID library checks the entire multibase/multihash structure.
  if (typeof value !== 'string' || value.length > 512 || !/^[A-Za-z0-9]+$/.test(value)) {
    throw new UnsafeEvidenceError('expected a bare CID, without a path, query or fragment', { deterministic: true });
  }
  cidModule ||= import('multiformats/cid');
  const { CID } = await cidModule;
  try {
    CID.parse(value);
  } catch {
    throw new UnsafeEvidenceError('invalid CID', { deterministic: true });
  }
}

/** Preflight ALL references before common can read or download any of them. */
async function assertManifestReferences(manifest, root) {
  if (!manifest || typeof manifest !== 'object') return; // schema validation remains common's job
  const sections = [
    ['primary', [manifest.primary]],
    ['additional', Array.isArray(manifest.additional) ? manifest.additional : []],
    ['support', Array.isArray(manifest.support) ? manifest.support : []]
  ];
  for (const [section, files] of sections) {
    for (const file of files) {
      if (!file || typeof file !== 'object') continue;
      if (Object.prototype.hasOwnProperty.call(file, 'path')) {
        throw new UnsafeEvidenceError('manifest entries cannot supply internal file paths', { deterministic: true });
      }
      if (file.filename !== undefined) resolveEvidenceFile(root, file.filename, { allowMissing: true });
      if (file.hash !== undefined) {
        const cid = typeof file.hash === 'object' && file.hash !== null ? file.hash.cid : file.hash;
        await assertBareCID(cid);
        // Common currently uses these names for downloads. Prevent a supplied
        // archive from placing a link at a future write destination as well.
        resolveEvidenceFile(root, `${section}_${cid}`, { allowMissing: true });
      }
    }
  }
}

async function assertSafeManifest(root) {
  const text = await readEvidenceFile([root], { filename: 'manifest.json' }, 'utf8');
  await assertManifestReferences(JSON.parse(text), root);
}

/** Inspect ZIP paths/types before letting the shared extractor touch the disk. */
async function extractEvidenceArchive(archiveService, data, name, destination) {
  const directory = await unzipper.Open.buffer(data);
  for (const entry of directory.files) {
    assertRelativePath(entry.path);
    const kind = (entry.externalFileAttributes >>> 16) & 0xf000;
    if (kind !== 0 && kind !== 0x8000 && kind !== 0x4000) {
      throw new UnsafeEvidenceError('ZIP links and special files are not allowed', { deterministic: true });
    }
  }
  // name is supplied by the adapter, never by a manifest. Still reject any
  // path component before it reaches common's path construction.
  assertRelativePath(name);
  if (name.includes('/')) throw new UnsafeEvidenceError('invalid archive name');
  const extracted = await archiveService.extractArchive(data, name, destination);
  const realDestination = fs.realpathSync(destination);
  if (!fs.lstatSync(extracted).isDirectory() || !isWithin(realDestination, fs.realpathSync(extracted))) {
    throw new UnsafeEvidenceError('extractor returned a path outside its destination');
  }
  return extracted;
}

module.exports = {
  UnsafeEvidenceError, isUnsafeEvidenceError, assertBareCID, assertRelativePath,
  resolveEvidenceFile, resolveAttachmentPath, readEvidenceFile,
  assertManifestReferences, assertSafeManifest, extractEvidenceArchive
};
