'use strict';

/**
 * poc.patch on the host side, without applying it (design §9.1: git apply
 * runs only inside the container). Two kinds of code live here:
 *
 * 1. scanPatch: the request's own bytes, before git sees them. maxPatchBytes,
 *    and the 50 MB expansion: what git would have to materialise to apply
 *    the patch. git inflates every binary hunk (forward and reverse) to the
 *    size its header declares as it parses the patch, and holds every result
 *    in memory before it writes, so a 60 KB patch can declare 60 MB of zeros
 *    (a compression bomb). The scan is a superset of what git reads: it
 *    counts every `literal`/`delta` line at its declared size (read as git's
 *    strtoul reads it, sign included), a forward delta's target at the size
 *    its header declares, every added text line, and refuses copies (a copy
 *    rebuilds a whole existing file from one header line, so the patch's
 *    bytes do not bound it). Whatever git would accept, the count is at least
 *    what git would allocate for it.
 *
 * 2. Readers of git's own answers (`-z` outputs, the -U0 diff), which come
 *    back from the sandbox as bytes. They never interpret the patch
 *    themselves: what the patch touches is what git, inside the sandbox,
 *    says it touched.
 */

const crypto = require('node:crypto');
const zlib = require('node:zlib');

/** The header lines git reads as a rename (apply.c's table: rename from/to, and the older rename old/new). */
const RENAME_HEADERS = Object.freeze(['rename from ', 'rename to ', 'rename old ', 'rename new ']);

/** git's base85 alphabet (base85.c). */
const B85 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz!#$%&()*+-;<=>?@^_`{|}~';
const B85_VALUE = new Map([...B85].map((c, i) => [c.charCodeAt(0), i]));

/** One line of a git binary hunk: a length character (A-Z = 1-26, a-z = 27-52), then base85 groups. */
function decodeBase85Line(line) {
  if (typeof line !== 'string' || line.length < 6) return null;
  const c = line.charCodeAt(0);
  let len;
  if (c >= 65 && c <= 90) len = c - 64;
  else if (c >= 97 && c <= 122) len = c - 96 + 26;
  else return null;
  const groups = Math.ceil(len / 4);
  if (line.length !== 1 + groups * 5) return null;
  const out = Buffer.alloc(groups * 4);
  for (let g = 0; g < groups; g += 1) {
    let acc = 0;
    for (let k = 0; k < 5; k += 1) {
      const v = B85_VALUE.get(line.charCodeAt(1 + g * 5 + k));
      if (v === undefined) return null;
      acc = acc * 85 + v;
    }
    if (acc > 0xffffffff) return null;
    out.writeUInt32BE(acc, g * 4);
  }
  return out.subarray(0, len);
}

/** The inverse, for tests and fixtures (at most 52 bytes per line, as git writes them). */
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
 * strtoul(…, 10) as git calls it on a binary hunk's size: leading white
 * space, an optional sign, decimal digits; no digits read as 0. A negative
 * value wraps to a huge unsigned one, and anything past 2^53 is far over any
 * limit, so both read as Number.MAX_SAFE_INTEGER.
 */
function declaredSize(rest) {
  const m = /^[ \t\n\v\f\r]*([+-]?)([0-9]*)/.exec(rest);
  const digits = m[2].replace(/^0+(?=[0-9])/, '');
  if (!digits || /^0+$/.test(digits)) return 0;
  if (m[1] === '-' || digits.length > 15) return Number.MAX_SAFE_INTEGER;
  return Number(digits);
}

/** A git delta's header: two little-endian base-128 varints, the source and target sizes. */
function deltaTargetSize(data) {
  let out;
  try {
    // At most the first 4 KiB of compressed data: enough for the header,
    // and its output is bounded however well it compresses.
    out = zlib.inflateSync(data.subarray(0, 4096), { finishFlush: zlib.constants.Z_SYNC_FLUSH });
  } catch (_) {
    return null;
  }
  let pos = 0;
  const varint = () => {
    let value = 0;
    let scale = 1;
    for (;;) {
      if (pos >= out.length || scale > 2 ** 56) return null;
      const b = out[pos++];
      value += (b & 0x7f) * scale;
      scale *= 128;
      if (!(b & 0x80)) return value;
    }
  };
  const source = varint();
  if (source === null) return null;
  return varint();
}

/**
 * The host-side checks of poc.patch (the `applies` gate's input part).
 * @param {Buffer} bytes
 * @param {{maxPatchBytes:number, patchExpansionBytes:number}} limits
 * @returns {{ok:boolean, code?:string, reason?:string, bytes:number, sha256:string, expansionBytes:number, binaryHunks:number}}
 */
function scanPatch(bytes, { maxPatchBytes, patchExpansionBytes }) {
  const base = { bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), expansionBytes: 0, binaryHunks: 0 };
  const fail = (code, reason) => ({ ...base, ok: false, code, reason });
  if (bytes.length > maxPatchBytes) {
    return fail('PATCH_TOO_LARGE', `poc.patch is ${bytes.length} bytes; the listing allows ${maxPatchBytes} (maxPatchBytes)`);
  }
  // latin1: one character per byte, so lengths are byte counts.
  const lines = bytes.toString('latin1').split('\n');
  let expansion = 0;
  for (let i = 0; i < lines.length && expansion <= patchExpansionBytes; i += 1) {
    const line = lines[i].replace(/\r$/, '');
    const c = line.charCodeAt(0);
    if (c === 43 /* + */) {
      expansion += lines[i].length; // the line without its '+', plus its newline
      continue;
    }
    if (line.startsWith('copy from ') || line.startsWith('copy to ')) {
      return fail('PATCH_COPY', 'poc.patch copies a file (a "copy from" header): a copy rebuilds a whole existing file from one line, so its size is not bounded by the patch; a PoC adds or edits test files');
    }
    // R15-F1: git reloads a rename's source for every rename of it, so one
    // file renamed to many names multiplies it, and git apply's numstat names
    // only the destinations. Every header form git reads (apply.c: rename
    // from/to, and the old rename old/new) is refused, like a copy; a moved
    // file is a deletion and an addition (git diff --no-renames).
    if (RENAME_HEADERS.some((h) => line.startsWith(h))) {
      return fail('PATCH_RENAME', 'poc.patch renames a file (a "rename from" header): git rebuilds a renamed file from the existing one, once for every rename of it, so the patch does not bound what it writes; a PoC adds or edits test files (write it with git diff --no-renames)');
    }
    if (line === 'GIT binary patch') {
      base.binaryHunks += 1;
      continue;
    }
    // git parses a binary patch's forward and reverse hunks and inflates
    // each to its declared size while it reads the patch (even for
    // --numstat): every literal and delta line counts, wherever it is.
    const literal = line.startsWith('literal ');
    if (!literal && !line.startsWith('delta ')) continue;
    expansion += declaredSize(line.slice(literal ? 8 : 6));
    if (!literal && i > 0 && lines[i - 1].replace(/\r$/, '') === 'GIT binary patch') {
      // A forward delta also rebuilds its target, at the size its header declares.
      const data = [];
      for (let j = i + 1; j < lines.length; j += 1) {
        const l = lines[j].replace(/\r$/, '');
        if (l === '') break;
        const decoded = decodeBase85Line(l);
        if (!decoded) break;
        data.push(decoded);
      }
      const target = data.length ? deltaTargetSize(Buffer.concat(data)) : null;
      if (target === null) {
        return fail('PATCH_BINARY_UNREADABLE', 'poc.patch has a binary delta whose target size cannot be read');
      }
      expansion += target;
    }
  }
  base.expansionBytes = expansion;
  if (expansion > patchExpansionBytes) {
    return fail('PATCH_EXPANSION', `poc.patch would expand to at least ${expansion} bytes; the class allows ${patchExpansionBytes} (patchExpansionBytes)`);
  }
  return { ...base, ok: true };
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
  scanPatch, decodeBase85Line, encodeBase85Line, parseNameStatusZ, parseNumstatZ, parseLsTreeZ, parseAddedLines, unquoteCStyle, reportablePath
};
