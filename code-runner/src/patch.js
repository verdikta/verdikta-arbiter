'use strict';

/**
 * poc.patch on the host side (design §9.1: git apply runs only inside the
 * container). Two kinds of code live here:
 *
 * 1. scanPatch: the request's own bytes, before git sees them. The checks
 *    that do not depend on parsing the patch's meaning: maxPatchBytes, no NUL
 *    byte, and no copy or rename header (each rebuilds a whole existing file
 *    from one header line, so the patch's bytes do not bound what git writes,
 *    and git apply's numstat names only the destinations). What the patch
 *    would expand to is no longer counted from the text; it is measured after
 *    git applies the patch in the sandbox (claim.js, the applies step, owner
 *    decision Q26: "measure instead").
 *
 * 2. Readers of git's own answers (`-z` outputs, the -U0 diff, the raw diff),
 *    which come back from the sandbox as bytes. They never interpret the
 *    patch themselves: what the patch touches, and how large its result is,
 *    is what git, inside the sandbox, says.
 */

const crypto = require('node:crypto');

/** The header lines git reads as a rename (apply.c's table: rename from/to, and the older rename old/new). */
const RENAME_HEADERS = Object.freeze(['rename from ', 'rename to ', 'rename old ', 'rename new ']);

/** The inverse of git's base85 (base85.c), for tests and fixtures to build binary patches (≤ 52 bytes per line). */
const B85 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz!#$%&()*+-;<=>?@^_`{|}~';
function encodeBase85Line(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > 52) throw new RangeError('1 to 52 bytes per line');
  const len = bytes.length;
  const head = len <= 26 ? String.fromCharCode(64 + len) : String.fromCharCode(96 + len - 26);
  const padded = Buffer.alloc(Math.ceil(len / 4) * 4);
  bytes.copy(padded);
  let out = head;
  for (let g = 0; g < padded.length; g += 4) {
    let acc = padded.readUInt32BE(g);
    const chars = [];
    for (let k = 0; k < 5; k += 1) {
      chars.unshift(B85[acc % 85]);
      acc = Math.floor(acc / 85);
    }
    out += chars.join('');
  }
  return out;
}

/**
 * The host-side checks of poc.patch (part of the `applies` gate's `input`
 * basis), without parsing what the patch means. What it expands to is not
 * counted here; it is measured after the patch is applied.
 * @param {Buffer} bytes
 * @param {{maxPatchBytes:number}} limits
 * @returns {{ok:boolean, code?:string, reason?:string, bytes:number, sha256:string, binaryHunks:number}}
 */
function scanPatch(bytes, { maxPatchBytes }) {
  const base = { bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), binaryHunks: 0 };
  const fail = (code, reason) => ({ ...base, ok: false, code, reason });
  if (bytes.length > maxPatchBytes) {
    return fail('PATCH_TOO_LARGE', `poc.patch is ${bytes.length} bytes; the listing allows ${maxPatchBytes} (maxPatchBytes)`);
  }
  // Round 19: git reads a header field as a C string, so a NUL ends it where a byte scan would not. No patch git
  // writes holds one (binary content is base85), so any NUL is refused before git sees the patch.
  if (bytes.includes(0)) {
    return fail('PATCH_NUL', 'poc.patch holds a NUL byte: no patch git writes does (binary content is base85), and git reads a header field only up to one');
  }
  const lines = bytes.toString('latin1').split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].replace(/\r$/, '');
    if (line.startsWith('copy from ') || line.startsWith('copy to ')) {
      return fail('PATCH_COPY', 'poc.patch copies a file (a "copy from" header): a copy rebuilds a whole existing file from one line, so its size is not bounded by the patch; a PoC adds or edits test files');
    }
    // R15-F1: git reloads a rename's source for every rename of it, so one file renamed to many names multiplies it,
    // and git apply's numstat names only the destinations. Every header form git reads (apply.c: rename from/to, and
    // the old rename old/new) is refused, like a copy; a moved file is a deletion and an addition (git diff --no-renames).
    if (RENAME_HEADERS.some((h) => line.startsWith(h))) {
      return fail('PATCH_RENAME', 'poc.patch renames a file (a "rename from" header): git rebuilds a renamed file from the existing one, once for every rename of it, so the patch does not bound what it writes; a PoC adds or edits test files (write it with git diff --no-renames)');
    }
    if (line === 'GIT binary patch') base.binaryHunks += 1;
  }
  return { ...base, ok: true };
}

/**
 * The bytes git materialised applying the patch, measured from the runner's
 * own index: `git diff --cached --raw -z --no-renames HEAD` names every
 * touched path and its postimage object. Each created or modified regular or
 * executable file (not a deletion, not a gitlink) contributes its staged
 * blob's size, counted once per path — so a blob reused at many paths counts
 * at every path, as git wrote it. Parses the raw `-z` records; `sizes` maps
 * each postimage id to its size (`git cat-file --batch-check`).
 * @param {Buffer} rawZ - `git diff --cached --raw -z` output
 * @param {string} hexLen - the id length of the repository (40 or 64)
 * @returns {{ok:true, ids:string[], paths:number} | {ok:false, reason:string}}
 */
function parseRawZ(rawZ, hexLen) {
  const fields = zFields(rawZ);
  if (fields === null) return { ok: false, reason: 'the raw diff did not end with a NUL' };
  const ids = [];
  let paths = 0;
  // Records alternate meta, path (a rename/copy would add a second path, but both are refused before apply).
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const meta = fields[i];
    const m = new RegExp(`^:[0-7]{6} ([0-7]{6}) [0-9a-f]{${hexLen}} ([0-9a-f]{${hexLen}}) ([A-Z])$`).exec(meta);
    if (!m) return { ok: false, reason: `an unreadable raw record: ${meta.slice(0, 80)}` };
    paths += 1;
    const [, dstMode, dstId, status] = m;
    if (status === 'D') continue;
    // A blob (regular or executable); a gitlink (160000) or an absent postimage adds no file bytes here.
    if ((dstMode === '100644' || dstMode === '100755' || dstMode === '120000') && !/^0+$/.test(dstId)) ids.push(dstId);
  }
  if (fields.length % 2 !== 0) return { ok: false, reason: 'a raw record without a path' };
  return { ok: true, ids, paths };
}

/**
 * `git cat-file --batch-check='%(objectsize)'` over `ids`: one line each, a
 * decimal size or `<id> missing`. Returns the sum, counting each line (so a
 * repeated id sums repeatedly), or null when a line is unreadable or missing.
 */
function sumObjectSizes(text, count) {
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  if (lines.length !== count) return null;
  let total = 0;
  for (const l of lines) {
    if (!/^[0-9]+$/.test(l)) return null;
    total += Number(l);
  }
  return total;
}

/** `-z` fields: NUL-terminated, the last one followed by a NUL (so a trailing empty field). */
function zFields(buf) {
  const s = buf.toString('utf8');
  if (s === '') return [];
  if (!s.endsWith('\0')) return null;
  return s.slice(0, -1).split('\0');
}

/** `git diff --name-status -z --no-renames`: [{ status: A|M|D|T, path }] or null. */
function parseNameStatusZ(buf) {
  const f = zFields(buf);
  if (!f || f.length % 2 !== 0) return null;
  const out = [];
  for (let i = 0; i < f.length; i += 2) {
    if (!/^[AMDT]$/.test(f[i]) || f[i + 1] === '') return null;
    out.push({ status: f[i], path: f[i + 1] });
  }
  return out;
}

/** `git diff --numstat -z --no-renames` and `git apply --numstat -z`: [{ added, removed, binary, path }] or null. */
function parseNumstatZ(buf) {
  const f = zFields(buf);
  if (!f) return null;
  const out = [];
  for (const rec of f) {
    const m = /^([0-9]+|-)\t([0-9]+|-)\t([\s\S]+)$/.exec(rec);
    if (!m) return null;
    const binary = m[1] === '-' && m[2] === '-';
    if (!binary && (m[1] === '-' || m[2] === '-')) return null;
    out.push({ added: binary ? 0 : Number(m[1]), removed: binary ? 0 : Number(m[2]), binary, path: m[3] });
  }
  return out;
}

/** `git ls-tree -r -z --name-only`: the paths. */
function parseLsTreeZ(buf) {
  const f = zFields(buf);
  return f ? f.filter((p) => p !== '') : null;
}

const C_ESCAPES = Object.freeze({ a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 });

/** git's C-style quoting of a path (quote.c), undone; a plain path is returned as is; null when malformed. */
function unquoteCStyle(s) {
  if (typeof s !== 'string') return null;
  if (!s.startsWith('"')) return s;
  if (s.length < 2 || !s.endsWith('"')) return null;
  const body = s.slice(1, -1);
  const bytes = [];
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch === '"') return null;
    if (ch !== '\\') {
      for (const b of Buffer.from(ch, 'utf8')) bytes.push(b);
      continue;
    }
    const next = body[i + 1];
    if (next === undefined) return null;
    if (/[0-3]/.test(next) && /^[0-7]{3}$/.test(body.slice(i + 1, i + 4))) {
      bytes.push(parseInt(body.slice(i + 1, i + 4), 8));
      i += 3;
    } else if (Object.prototype.hasOwnProperty.call(C_ESCAPES, next)) {
      bytes.push(C_ESCAPES[next]);
      i += 1;
    } else {
      return null;
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

const HUNK = /^@@ -([0-9]+)(?:,([0-9]+))? \+([0-9]+)(?:,([0-9]+))? @@/;

/**
 * The added lines of `git diff -U0 --src-prefix=a/ --dst-prefix=b/`, per file,
 * with their line numbers in the new file. Hunk bodies are consumed by their
 * declared line counts, so an added line that reads like a header is still
 * an added line. Binary files have no hunks: their content is never read.
 * @param {Buffer} buf
 * @returns {{ok:true, files:Map<string, Array<{line:number, text:string}>>} | {ok:false, reason:string}}
 */
function parseAddedLines(buf) {
  const lines = buf.toString('utf8').split('\n');
  const files = new Map();
  let current = null;
  let inFile = false;
  for (let i = 0; i < lines.length; i += 1) {
    const l = lines[i];
    if (l.startsWith('diff --git ')) {
      inFile = true;
      current = null;
      continue;
    }
    if (!inFile) {
      if (l === '' && i === lines.length - 1) break;
      return { ok: false, reason: 'the diff does not start with a file header' };
    }
    if (l.startsWith('+++ ')) {
      const target = l.slice(4);
      if (target === '/dev/null') { current = null; continue; }
      const p = unquoteCStyle(target);
      if (p === null || !p.startsWith('b/')) return { ok: false, reason: `an unreadable file name in the diff: ${target.slice(0, 80)}` };
      current = p.slice(2);
      if (!files.has(current)) files.set(current, []);
      continue;
    }
    const h = HUNK.exec(l);
    if (h) {
      let oldCount = h[2] === undefined ? 1 : Number(h[2]);
      let newCount = h[4] === undefined ? 1 : Number(h[4]);
      let lineNo = Number(h[3]);
      if (newCount > 0 && current === null) return { ok: false, reason: 'added lines outside a file' };
      const out = current === null ? null : files.get(current);
      while (oldCount > 0 || newCount > 0) {
        i += 1;
        if (i >= lines.length) return { ok: false, reason: 'a hunk that ends early' };
        const b = lines[i];
        const k = b.charCodeAt(0);
        if (k === 43 /* + */ && newCount > 0) { out.push({ line: lineNo, text: b.slice(1) }); lineNo += 1; newCount -= 1; }
        else if (k === 45 /* - */ && oldCount > 0) { oldCount -= 1; }
        else if (k === 32 /* space */ && oldCount > 0 && newCount > 0) { oldCount -= 1; newCount -= 1; lineNo += 1; }
        else if (k === 92 /* \ */) { /* "\ No newline at end of file" */ }
        else return { ok: false, reason: 'a hunk line that does not match its header' };
      }
      if (lines[i + 1] !== undefined && lines[i + 1].startsWith('\\')) i += 1;
      continue;
    }
    // Other header lines (index, modes, --- a/…, Binary files … differ) carry no content.
  }
  return { ok: true, files };
}

/**
 * A path a Verification Report can carry (common's RepoPath): relative,
 * `/`-separated, no `.`, `..` or empty segment, no whitespace, control
 * character or backslash, at most 512 characters.
 */
function reportablePath(p) {
  if (typeof p !== 'string' || p.length < 1 || p.length > 512) return false;
  if (/[\s\\\u0000-\u001f\u007f]/.test(p) || p.startsWith('/')) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

module.exports = {
  scanPatch, parseRawZ, sumObjectSizes, encodeBase85Line, parseNameStatusZ, parseNumstatZ, parseLsTreeZ, parseAddedLines, unquoteCStyle, reportablePath
};
