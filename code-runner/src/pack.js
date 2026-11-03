'use strict';

/**
 * The context pack (design §9.2 step 3, §10.3 item 5, §10.4; node A3b): what
 * every juror reads of the code, built once, by rule, so every arbiter's jury
 * reads the same bytes.
 *
 * Two halves. gatherPackInputs() reads the sandbox's git while no claim code has
 * run, from objects by commit id (never the work tree), in fixed forms: whole
 * blob ids, the fixed git environment (git.js), the commit prefix stripped from
 * `git grep`'s lines. assemblePack() is then a pure function of those reads and
 * the request's documents.
 *
 * The tiers, in §10.3's priority order, with their share of the class budget
 * (common's envelope; 60k tokens for code-standard):
 *
 *   1 poc            30%   poc.patch with function context, the PoC files' full text
 *   2 claim          10%   finding.json, report.md
 *   3 source         24%   the in-scope source files the finding names
 *   4 callSites       5%   call sites of the symbols the PoC exercises (at most 10 each)
 *   5 knownIssues    12%   known_issues.json
 *   6 priorFindings  19%   summaries of the prior valid findings (up to 8)
 *   7 fix             -    the fix diff
 *   8 tree            -    a shallow file tree
 *
 * Tiers 1-6 first take up to their share, in order; what is left goes back up
 * in order, then to tiers 7 and 8. So a hunter who pads poc.patch or report.md,
 * or names 200 huge files, cannot push out the known issues and prior findings
 * a juror needs to find a duplicate. Over budget the lowest tiers go first, and
 * the manifest (the first file) says what each tier kept.
 *
 * A token is ceil(UTF-8 bytes / 4), plus a fixed allowance per file for the
 * AI Node's fence lines. Real Solidity costs a provider slightly less; text
 * written to cost more can reach about 2.9 × on the tiers a hunter writes.
 *
 * Every item is one file with a fixed name: a word of the hunter's reaches no
 * name, and the AI Node's content-hash fence wraps each file alone. Every text
 * opens with the runner's own `# ` line, so none can start like the `data:` URI
 * the AI Node would decode or refuse.
 */

const crypto = require('node:crypto');
const { getCodeClass, canonicalJson, matchesAny, splitByStakeScope } = require('./common');
const { git } = require('./git');
const { Prefix } = require('./capture');
const { ABSTAIN, Abstain } = require('./result');
const { reportablePath, parseLsTreeZ } = require('./patch');

const PACK_VERSION = 1;
const PACK_SCHEMA = 'verdikta.context-pack/1';
const BYTES_PER_TOKEN = 4;
const TOKEN_RULE = 'ceil(UTF-8 bytes / 4), with a fixed allowance per file';
/** The manifest's room, and each file's for its fence lines (two lines with a hash and the file's name). */
const MANIFEST_RESERVE_BYTES = 2048;
const FILE_OVERHEAD_BYTES = 160;
/** A tier gets no file for less than this: a header and a few words help no one. */
const MIN_ITEM_BYTES = 512;

const TIERS = Object.freeze([
  Object.freeze({ name: 'poc', share: 30 }),
  Object.freeze({ name: 'claim', share: 10 }),
  Object.freeze({ name: 'source', share: 24 }),
  Object.freeze({ name: 'callSites', share: 5 }),
  Object.freeze({ name: 'knownIssues', share: 12 }),
  Object.freeze({ name: 'priorFindings', share: 19 }),
  Object.freeze({ name: 'fix', share: 0 }),
  Object.freeze({ name: 'tree', share: 0 })
]);
const TIER_NAMES = Object.freeze(TIERS.map((t) => t.name));

/** A prior finding's summary line at most, so that 8 of them always fit their tier's share. */
const MAX_SUMMARY_BYTES = 5200;
const SUMMARY_PATHS = 5;
const SUMMARY_PATH_BYTES = 200;
/** One read of git's at most; far above any budget, so a cut here is never in what the jury would have read. */
const READ_MAX_BYTES = 4 * 1024 * 1024;
/** What is kept of one file: above the largest budget. */
const MAX_BLOB_BYTES = 1024 * 1024;
const MAX_BATCH_HEADER_BYTES = 8192;
/** What is read of one line of `git grep`: the path comes first, and a site keeps MAX_SITE_BYTES of its text. */
const MAX_GREP_LINE_HEAD_BYTES = 8192;
/** The file names of a commit, as the protected reset reads them (claim.js). */
const TREE_MAX_BYTES = 16 * 1024 * 1024;
const GIT_TIMEOUT_MS = 120000;
const MAX_SYMBOLS = 16;
const MAX_SITES_PER_SYMBOL = 10;
const MAX_SITE_BYTES = 300;
/** How deep the file tree goes. */
const TREE_DEPTH = 2;
/** git's own test for a binary blob: a NUL in its first bytes. */
const BINARY_PROBE_BYTES = 8000;

/** Receivers whose calls are the framework's or the language's, not the code under test. */
const FRAMEWORK_RECEIVER = /^(?:vm|console|console2|stdJson|stdStorage|stdMath|stdError|abi|block|msg|tx|bytes|string|type|super|this)$/;
/**
 * A call `<receiver>.<name>(` or `<receiver>.<name>{value: …}(`, or `new <Name>`. Anchored at the start of a word
 * and read over a bounded part of each line: the lines are the hunter's, and a
 * 2 MB identifier must not cost the runner quadratic time.
 */
const SYMBOL = /(?<![A-Za-z0-9_$])(?:([A-Za-z_$][A-Za-z0-9_$]*)[ \t]*\.[ \t]*([A-Za-z_$][A-Za-z0-9_$]*)[ \t]*[({]|new[ \t]+([A-Za-z_$][A-Za-z0-9_$]*))/g;
const MAX_SCANNED_LINE = 4096;

function byteLength(text) {
  return Buffer.byteLength(text, 'utf8');
}

/** Tokens for a number of bytes. */
function packTokens(bytes) {
  return Math.ceil(bytes / BYTES_PER_TOKEN);
}

/** Canonical JSON of a document whose strings may hold what canonical JSON refuses: a JSON escape can write a lone surrogate. */
function wellFormedDeep(value) {
  if (typeof value === 'string') return value.toWellFormed();
  if (Array.isArray(value)) return value.map(wellFormedDeep);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k.toWellFormed(), wellFormedDeep(v)]));
  }
  return value;
}

function canon(value) {
  return canonicalJson(wellFormedDeep(value));
}

/** The longest prefix of at most `max` UTF-8 bytes on a whole character, at the last line end when that keeps at least half. */
function cutBytes(text, max) {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= max) return text;
  let end = Math.max(0, max);
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end -= 1;
  const line = buf.subarray(0, end).lastIndexOf(0x0a);
  if (line >= 0 && line + 1 >= end / 2) end = line + 1;
  return buf.subarray(0, end).toString('utf8');
}

/** A prior finding's summary (§10.3): what finding.json says, bounded; never its report.md. */
function summaryOf(prior) {
  const f = prior.finding || {};
  const paths = Array.isArray(f.affectedPaths) ? f.affectedPaths : [];
  return {
    bcid: prior.bcid,
    title: typeof f.title === 'string' ? f.title : null,
    claimedClass: f.claimedClass === undefined ? null : f.claimedClass,
    rootCause: typeof f.rootCause === 'string' ? f.rootCause : '',
    affectedPaths: paths.slice(0, SUMMARY_PATHS).map((p) => cutBytes(String(p), SUMMARY_PATH_BYTES)),
    observable: f.poc && typeof f.poc.observable === 'string' ? f.poc.observable : ''
  };
}

/**
 * One summary as one line of canonical JSON, within its bound, measured as it
 * is written (escapes included): the paths go first, last one first, then the
 * longest texts give way.
 */
function summaryLine(prior) {
  const summary = wellFormedDeep(summaryOf(prior));
  let line = canonicalJson(summary);
  while (byteLength(line) > MAX_SUMMARY_BYTES && summary.affectedPaths.length > 0) {
    summary.affectedPaths.pop();
    line = canonicalJson(summary);
  }
  for (const field of ['rootCause', 'observable', 'title']) {
    const over = byteLength(line) - MAX_SUMMARY_BYTES;
    if (over <= 0) break;
    if (typeof summary[field] !== 'string') continue;
    // Each byte of text cut takes at least one byte of its escaped form with it.
    summary[field] = cutBytes(summary[field], byteLength(summary[field]) - over);
    line = canonicalJson(summary);
  }
  return line;
}

/**
 * The tree's first TREE_DEPTH levels: files named, directories with a count, in git's order.
 * @param {string[]} paths - sorted
 */
function shallowTree(paths) {
  const lines = new Map();
  for (const p of paths) {
    const parts = p.split('/');
    for (let depth = 1; depth <= Math.min(parts.length, TREE_DEPTH); depth += 1) {
      const isFile = depth === parts.length;
      const key = parts.slice(0, depth).join('/') + (isFile ? '' : '/');
      if (!lines.has(key)) lines.set(key, { depth, files: 0, isFile });
      lines.get(key).files += 1;
    }
  }
  return [...lines].map(([key, l]) => `${'  '.repeat(l.depth - 1)}${key}${l.isFile ? '' : ` (${l.files} file${l.files === 1 ? '' : 's'})`}`).join('\n');
}

/**
 * The symbols the PoC exercises: what its added lines call, in order of first
 * appearance, without the framework's own, at most MAX_SYMBOLS.
 * @param {Map<string, Array<{line:number, text:string}>>} added - the PoC's added lines, by file
 */
function symbolsOf(added) {
  const seen = new Set();
  for (const lines of added.values()) {
    for (const { text } of lines) {
      for (const m of text.slice(0, MAX_SCANNED_LINE).matchAll(SYMBOL)) {
        const receiver = m[1];
        const name = m[2] || m[3];
        if (receiver && FRAMEWORK_RECEIVER.test(receiver)) continue;
        seen.add(name);
        if (seen.size === MAX_SYMBOLS) return [...seen];
      }
    }
  }
  return [...seen];
}

// ------------------------------------------------------------------ the sandbox's half

function runnerError(step, detail) {
  return new Abstain(ABSTAIN.RUNNER_ERROR, detail, { step });
}

async function read(ctx, name, args, { stdin, max = READ_MAX_BYTES } = {}) {
  const out = new Prefix(max);
  const record = await ctx.exec(git(args), { name, timeoutMs: GIT_TIMEOUT_MS, stdin, tee: out });
  return { exitCode: record.exitCode, bytes: out.bytes(), truncated: out.truncated };
}

/**
 * `git cat-file --batch`'s answer on `<commit>:<path>` lines, read as a stream
 * record by record: a blob of any size costs only what is kept of it, so an
 * early large or binary file cannot use up the read and hide the ones after it.
 * The same bytes make the same items however they arrive. A path the commit
 * lacks, or that is not a file, is no item.
 */
class BlobSink {
  constructor(paths) {
    this.paths = paths;
    this.at = 0;
    this.items = [];
    this.textLeft = READ_MAX_BYTES;
    this.header = [];
    this.headerBytes = 0;
    this.record = null;
    this.endOfRecord = false;
  }

  write(chunk) {
    let buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    while (buf.length > 0) {
      if (this.record) {
        const take = Math.min(this.record.left, buf.length);
        const room = Math.min(this.record.keep - this.record.kept, take);
        if (room > 0) {
          this.record.chunks.push(Buffer.from(buf.subarray(0, room)));
          this.record.kept += room;
        }
        this.record.left -= take;
        buf = buf.subarray(take);
        if (this.record.left === 0) this.finishRecord();
      } else if (this.endOfRecord) {
        // The line feed git writes after a record's content.
        this.endOfRecord = false;
        buf = buf.subarray(1);
      } else {
        const nl = buf.indexOf(0x0a);
        const part = nl < 0 ? buf : buf.subarray(0, nl);
        if (this.headerBytes < MAX_BATCH_HEADER_BYTES) {
          this.header.push(Buffer.from(part));
          this.headerBytes += part.length;
        }
        if (nl < 0) return true;
        buf = buf.subarray(nl + 1);
        const line = Buffer.concat(this.header).toString('latin1');
        this.header = [];
        this.headerBytes = 0;
        this.startRecord(line);
      }
    }
    return true;
  }

  startRecord(line) {
    const path = this.paths[this.at];
    this.at += 1;
    const m = /^[0-9a-f]+ ([a-z]+) ([0-9]+)$/.exec(line);
    if (!m) return; // `<spec> missing`
    const size = Number(m[2]);
    // At least what tells a binary file from a text, whatever the texts before it took.
    const keep = Math.min(size, MAX_BLOB_BYTES, Math.max(BINARY_PROBE_BYTES, this.textLeft));
    this.record = { path, type: m[1], size, left: size, keep, kept: 0, chunks: [] };
    if (size === 0) this.finishRecord();
  }

  finishRecord() {
    const { path, type, size, kept, chunks } = this.record;
    this.record = null;
    this.endOfRecord = true;
    if (type !== 'blob') return;
    const content = Buffer.concat(chunks);
    const binary = content.subarray(0, BINARY_PROBE_BYTES).includes(0);
    if (!binary) this.textLeft = Math.max(0, this.textLeft - kept);
    this.items.push({ path, text: binary ? null : content.toString('utf8'), bytes: size, binary, cut: !binary && kept < size });
  }
}

/** Blobs by `<commit>:<path>`, as items. */
async function readBlobs(ctx, name, commit, paths) {
  if (paths.length === 0) return [];
  const sink = new BlobSink(paths);
  const record = await ctx.exec(git(['cat-file', '--batch']), {
    name, timeoutMs: GIT_TIMEOUT_MS, stdin: Buffer.from(paths.map((p) => `${commit}:${p}\n`).join(''), 'utf8'), tee: sink
  });
  if (record.exitCode !== 0) throw runnerError(name, `the pack's files could not be read (git exited ${record.exitCode})`);
  return sink.items;
}

/**
 * `git grep -z -n`'s answer read as a stream, line by line: only the head of
 * each line is kept, and only sites `keep` allows count, so a huge match in a
 * file out of scope cannot hide the callers after it. The same bytes make the
 * same sites however they arrive.
 */
class GrepSink {
  constructor(prefix, keep) {
    this.prefix = prefix;
    this.keep = keep;
    this.sites = [];
    this.head = [];
    this.headBytes = 0;
  }

  write(chunk) {
    let buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    while (buf.length > 0 && this.sites.length < MAX_SITES_PER_SYMBOL) {
      const nl = buf.indexOf(0x0a);
      const part = nl < 0 ? buf : buf.subarray(0, nl);
      const room = MAX_GREP_LINE_HEAD_BYTES - this.headBytes;
      if (room > 0) {
        const take = part.subarray(0, room);
        this.head.push(Buffer.from(take));
        this.headBytes += take.length;
      }
      if (nl < 0) return true;
      buf = buf.subarray(nl + 1);
      this.endLine(Buffer.concat(this.head).toString('utf8'));
      this.head = [];
      this.headBytes = 0;
    }
    return true;
  }

  endLine(raw) {
    const parts = raw.split('\0');
    if (parts.length < 3 || !parts[0].startsWith(this.prefix)) return;
    const path = parts[0].slice(this.prefix.length);
    if (!this.keep(path)) return;
    this.sites.push({ path, line: Number(parts[1]), text: cutBytes(parts.slice(2).join(' ').trim(), MAX_SITE_BYTES) });
  }
}

/** Up to MAX_SITES_PER_SYMBOL call sites of each symbol, in git's order, among the paths `keep` allows. */
async function readCallSites(ctx, listed, symbols, keep) {
  const out = [];
  for (let i = 0; i < symbols.length; i += 1) {
    const symbol = symbols[i];
    const name = `pack:grep:${i + 1}`;
    const sink = new GrepSink(`${listed}:`, keep);
    const record = await ctx.exec(git(['grep', '-n', '-w', '-F', '-I', '-z', '--no-color', '--full-name', '-e', symbol, listed, '--']), { name, timeoutMs: GIT_TIMEOUT_MS, tee: sink });
    if (record.exitCode !== 0 && record.exitCode !== 1) throw runnerError(name, `the call sites could not be read (git exited ${record.exitCode})`);
    if (sink.sites.length) out.push({ symbol, sites: sink.sites });
  }
  return out;
}

/**
 * The pack's reads from the sandbox, while no claim code has run.
 * @param {object} ctx
 * @param {object} o
 * @param {object} o.request
 * @param {string} o.listed - the listed commit, as the forced checkout committed it
 * @param {string} o.poc - the commit that records poc.patch
 * @param {Array<{status:string, path:string}>} o.touched - what the patch touched
 * @param {Map<string, Array<{line:number, text:string}>>} o.added - its added lines under paths.tests
 */
async function gatherPackInputs(ctx, { request, listed, poc, touched, added }) {
  const diff = await read(ctx, 'pack:diff', ['diff', '-W', '--full-index', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames',
    '--diff-algorithm=myers', '--src-prefix=a/', '--dst-prefix=b/', listed, poc, '--']);
  if (diff.exitCode !== 0) throw runnerError('pack:diff', `the PoC's diff could not be read (git exited ${diff.exitCode})`);

  const pocPaths = touched.filter((t) => t.status !== 'D').map((t) => t.path);
  const pocFiles = await readBlobs(ctx, 'pack:poc', poc, pocPaths);

  const spec = request.spec;
  const scope = spec.stake && spec.stake.scope ? spec.stake.scope : null;
  const named = request.finding && Array.isArray(request.finding.affectedPaths) ? request.finding.affectedPaths : [];
  const inScope = scope ? splitByStakeScope(named, scope).inScope : named;
  const sources = await readBlobs(ctx, 'pack:source', listed, [...new Set(inScope)].filter(reportablePath));

  // Call sites in what the stake covers; without a scope, in anything but the tests and the framework's own paths.
  const skip = [...(spec.paths.tests || []), ...(spec.paths.protected || [])];
  const allowed = new Map();
  const keep = (p) => {
    if (!allowed.has(p)) allowed.set(p, scope ? splitByStakeScope([p], scope).inScope.length === 1 : !matchesAny(p, skip));
    return allowed.get(p);
  };
  const callSites = await readCallSites(ctx, listed, symbolsOf(added || new Map()), keep);

  const tree = await read(ctx, 'pack:tree', ['ls-tree', '-r', '-z', '--full-tree', '--name-only', '--end-of-options', listed], { max: TREE_MAX_BYTES });
  // A tree cut at the bound ends at its last whole name.
  const whole = tree.truncated ? tree.bytes.subarray(0, tree.bytes.lastIndexOf(0) + 1) : tree.bytes;
  const names = tree.exitCode === 0 ? parseLsTreeZ(whole) : null;
  if (!names) throw runnerError('pack:tree', `the listed commit's files could not be listed (git exited ${tree.exitCode})`);

  return {
    pocDiff: diff.bytes.toString('utf8'),
    pocDiffCut: diff.truncated,
    pocFiles,
    sources,
    callSites,
    tree: shallowTree(names.map((p) => Buffer.from(p, 'latin1').toString('utf8')))
  };
}

// ------------------------------------------------------------------ the assembly

function fileItem(tier, slug, ext, header, body, cut = false) {
  // Well-formed as a whole: a path in the header can hold a lone surrogate a JSON escape wrote, as a body can.
  const text = `# ${header}\n${body}`.toWellFormed();
  return { tier, slug, ext, text, bytes: byteLength(text) + FILE_OVERHEAD_BYTES, cut };
}

function blobBody(item) {
  if (item.binary) return `[binary file: ${item.bytes} bytes]`;
  return item.cut ? `${item.text}\n[cut by the runner: the first ${byteLength(item.text)} of ${item.bytes} bytes were read]` : item.text;
}

/** Every item of every tier, whole, in priority order. */
function tierItems(request, inputs) {
  const known = Array.isArray(request.knownIssues) ? request.knownIssues : [];
  const priors = Array.isArray(request.priorFindings) ? request.priorFindings : [];
  const numbered = (list, tier, slug, header, body, ext = 'txt') => list.map((item, i) => fileItem(tier, `${slug}-${String(i + 1).padStart(3, '0')}`, ext, header(item), body(item), item.cut));
  const callLines = inputs.callSites.flatMap(({ symbol, sites }) => [`symbol: ${symbol}`, ...sites.map((s) => `${s.path}:${s.line}: ${s.text}`)]);
  return {
    poc: [
      ...(inputs.pocDiff === '' ? [] : [fileItem('poc', 'poc-diff', 'patch', 'poc.patch with function context (git diff -W), written by the hunter', inputs.pocDiff, inputs.pocDiffCut === true)]),
      ...numbered(inputs.pocFiles, 'poc', 'poc-file', (f) => `poc file: ${f.path}`, blobBody)
    ],
    claim: [
      fileItem('claim', 'finding', 'txt', 'finding.json, written by the hunter', canon(request.finding || {})),
      fileItem('claim', 'report', 'txt', 'report.md, written by the hunter', typeof request.report === 'string' ? request.report : '')
    ],
    source: numbered(inputs.sources, 'source', 'source', (f) => `source file: ${f.path}`, blobBody),
    callSites: callLines.length ? [fileItem('callSites', 'call-sites', 'txt', `call sites of the symbols the PoC exercises (git grep -w on the listed commit, at most ${MAX_SITES_PER_SYMBOL} each)`, callLines.join('\n'))] : [],
    knownIssues: known.length ? [fileItem('knownIssues', 'known-issues', 'txt', 'known_issues.json, one entry per line, written by the maker', known.map(canon).join('\n'))] : [],
    priorFindings: priors.length ? [fileItem('priorFindings', 'prior-findings', 'txt', 'summaries of the prior valid findings on this listing, one per line, each written by its hunter', priors.map(summaryLine).join('\n'))] : [],
    fix: request.fixPatch ? [fileItem('fix', 'fix-diff', 'patch', 'fix.patch, written by the hunter', Buffer.from(request.fixPatch).toString('utf8'))] : [],
    tree: inputs.tree ? [fileItem('tree', 'tree', 'txt', `a shallow file tree of the listed commit (${TREE_DEPTH} levels)`, inputs.tree)] : []
  };
}

/** Bytes per tier: first up to each share, in order, then what is left, in order. */
function allocate(budgetBytes, sizes) {
  let remaining = budgetBytes - MANIFEST_RESERVE_BYTES;
  const grants = {};
  for (const { name, share } of TIERS) {
    const grant = Math.min(Math.floor((budgetBytes * share) / 100), sizes[name], Math.max(0, remaining));
    grants[name] = grant;
    remaining -= grant;
  }
  for (const { name } of TIERS) {
    const more = Math.min(sizes[name] - grants[name], Math.max(0, remaining));
    grants[name] += more;
    remaining -= more;
  }
  return grants;
}

/** A tier's items within its grant: whole while they fit, then one cut, then none. */
function fillTier(items, grant) {
  const kept = [];
  let left = grant;
  for (const item of items) {
    if (item.bytes <= left) {
      kept.push(item);
      left -= item.bytes;
      continue;
    }
    if (left >= MIN_ITEM_BYTES) {
      const note = (shown) => `\n[cut by the runner: the first ${shown} of ${item.bytes - FILE_OVERHEAD_BYTES} bytes]`;
      const room = left - FILE_OVERHEAD_BYTES - byteLength(note(item.bytes));
      const head = cutBytes(item.text, room);
      const text = `${head}${note(byteLength(head))}`;
      kept.push({ ...item, text, bytes: byteLength(text) + FILE_OVERHEAD_BYTES, cut: true, partial: true });
    }
    break;
  }
  return kept;
}

function tierStatus(items, kept) {
  if (items.length === 0) return 'empty';
  if (kept.length === 0) return 'dropped';
  return kept.length === items.length && kept.every((k) => !k.cut) ? 'full' : 'truncated';
}

/**
 * The context pack, once: a pure function of the request's documents and the
 * sandbox's reads.
 * @param {object} o
 * @param {object} o.request - finding, report, knownIssues, priorFindings, fixPatch, codeClass
 * @param {object} o.inputs - gatherPackInputs()'s
 * @param {string} [o.codeClass] - default: the request's, else code-standard
 * @param {number} [o.budgetTokens] - default: the class envelope's
 * @returns {{version:number, codeClass:string, budgetTokens:number, usedTokens:number, sha256:string, tiers:object[], files:Array<{name:string, tier:string, text:string}>}}
 */
function assemblePack({ request, inputs, codeClass = request.codeClass || 'code-standard', budgetTokens }) {
  const budget = budgetTokens === undefined ? getCodeClass(codeClass).envelope.contextPackTokens : budgetTokens;
  const items = tierItems(request, inputs);
  const sizes = Object.fromEntries(TIER_NAMES.map((name) => [name, items[name].reduce((n, i) => n + i.bytes, 0)]));
  const grants = allocate(budget * BYTES_PER_TOKEN, sizes);
  const files = [];
  const tiers = TIERS.map(({ name }, index) => {
    const kept = fillTier(items[name], grants[name]);
    const rank = index + 1;
    for (const k of kept) files.push({ name: `${String(rank).padStart(2, '0')}-${k.slug}.${k.ext}`, tier: name, text: k.text, bytes: k.bytes });
    const bytesIncluded = kept.reduce((n, k) => n + k.bytes, 0);
    return {
      rank, name, status: tierStatus(items[name], kept), items: items[name].length, itemsIncluded: kept.length,
      bytes: sizes[name], bytesIncluded, tokens: packTokens(bytesIncluded)
    };
  });
  const manifest = canonicalJson({
    schema: PACK_SCHEMA,
    codeClass,
    budgetTokens: budget,
    tokenRule: TOKEN_RULE,
    note: 'The pack\'s tiers, in priority order. A tier marked dropped or truncated did not fit the budget: what it left out is no evidence of anything.',
    tiers
  });
  const usedBytes = files.reduce((n, f) => n + f.bytes, 0) + byteLength(manifest) + FILE_OVERHEAD_BYTES;
  const outFiles = [{ name: '00-manifest.json', tier: 'manifest', text: manifest }, ...files.map(({ name, tier, text }) => ({ name, tier, text }))];
  const usedTokens = packTokens(usedBytes);
  const sha256 = crypto.createHash('sha256').update(canonicalJson({ version: PACK_VERSION, codeClass, budgetTokens: budget, usedTokens, tiers, files: outFiles }), 'utf8').digest('hex');
  return { version: PACK_VERSION, codeClass, budgetTokens: budget, usedTokens, sha256, tiers, files: outFiles };
}

module.exports = { gatherPackInputs, assemblePack, packTokens, symbolsOf, summaryOf, summaryLine, shallowTree, BlobSink, GrepSink, TIER_NAMES, TIERS, BYTES_PER_TOKEN, FILE_OVERHEAD_BYTES };
