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
 * The tiers, in §10.3's priority order (common's CONTEXT_PACK_TIERS), with
 * their share of the class budget (common's envelope; 60k tokens for
 * code-standard):
 *
 *   poc            30%   poc.patch with function context, the PoC files' full text
 *   claim          10%   finding.json, report.md
 *   source         24%   the in-scope source files the finding names
 *   documents       *    the maker's documents the listing names (stake.documents)
 *   callSites       5%   call sites of the symbols the PoC exercises (at most 10 each)
 *   knownIssues    12%   known_issues.json
 *   priorFindings  19%   summaries of the prior valid findings (up to 8)
 *   fix             -    the fix diff
 *   tree            -    a shallow file tree
 *
 * The documents tier exists only when the listing names documents (owner
 * decision Q61 (a); node A19). Its share and its cap are common's, in bytes
 * (STAKE_DOCUMENT_LIMITS.tierBytes: 10% and 20% of the class budget). Without
 * it every other tier keeps its rank, file names and bytes, so the ranks run
 * 1-8 without documents and 1-9 with them.
 *
 * The tiers with a share first take up to it, in order; what is left goes back
 * up in order (the documents up to their cap), then to the fix and the tree.
 * So a hunter who pads poc.patch or report.md, or names 200 huge files, cannot
 * push out the known issues and prior findings a juror needs to find a
 * duplicate, nor the documents' share. Over budget the lowest tiers go first.
 *
 * Nothing leaves silently (design review of the Q38 stop). Everything gathered
 * from a list goes through one account (Tally): an item is delivered, or omitted
 * with a reason from a fixed list. The manifest (the first file) gives each tier's
 * `asked`, `delivered` and `omitted`, with asked = delivered + the sum of omitted,
 * counts and fixed codes only, and a tier's status is computed from them: it cannot
 * say `full` when something was left out for a cap, a read limit, a size bound or the
 * budget. The other reasons are facts about the request or the repository, which no
 * larger limit would have changed (out of scope, not in the commit, not a file, a
 * binary file); they are counted and leave the status alone.
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
// common's document selection and text rule are called through the module, so a test can make them fail.
const common = require('./common');
const { git } = require('./git');
const { Prefix } = require('./capture');
const { ABSTAIN, Abstain, RequesterError } = require('./result');
const { parseLsTreeZ } = require('./patch');
const { KIND } = require('./objects');

const { getCodeClass, canonicalJson, matchesAny, splitByStakeScope, CONTEXT_PACK_TIERS, STAKE_DOCUMENT_LIMITS } = common;

const PACK_VERSION = 1;
const PACK_SCHEMA = 'verdikta.context-pack/1';
const BYTES_PER_TOKEN = 4;
const TOKEN_RULE = 'ceil(UTF-8 bytes / 4), with a fixed allowance per file';
/** The manifest's room, and each file's for its fence lines (two lines with a hash and the file's name). */
const MANIFEST_RESERVE_BYTES = 3072;
/** The manifest's more room when it has a documents tier: one more tier, with reasons of its own. */
const DOCUMENTS_MANIFEST_RESERVE_BYTES = 1024;
const FILE_OVERHEAD_BYTES = 160;
/** A tier gets no file for less than this: a header and a few words help no one. */
const MIN_ITEM_BYTES = 512;
/** Room for the line that says how many entries of a list did not fit. */
const LEFT_OUT_NOTE_BYTES = 64;

/**
 * Why something asked for is not in the pack. Facts about the request or the
 * repository: no larger cap, read limit or budget would have delivered it. A binary
 * file is here by that test: the jury reads text, whatever the budget. The
 * documents' own (common's "Which files count"): a document the source tier
 * holds (`inSource`), a symbolic link, a submodule, and a file that is not
 * UTF-8 text (`notText`).
 */
const FACT_REASONS = Object.freeze(['outOfScope', 'notInCommit', 'notAFile', 'notAskable', 'duplicate', 'binary', 'noDiff', 'inSource', 'symlink', 'submodule', 'notText']);
/**
 * Left out for a cap, a read limit, a size bound or the budget: a tier with one of these is not `full`. `tooLarge`: a
 * document over common's maxFileBytes, left unread.
 */
const LOSS_REASONS = Object.freeze(['overBudget', 'pastCap', 'unreadable', 'unread', 'tooLarge']);
const REASONS = new Set([...FACT_REASONS, ...LOSS_REASONS]);

/** Each tier's share of the class budget, in percent. The documents' share and cap are common's, in bytes. */
const SHARES = Object.freeze({ poc: 30, claim: 10, source: 24, callSites: 5, knownIssues: 12, priorFindings: 19, fix: 0, tree: 0 });
const DOCUMENTS = 'documents';
/** common's order of the tiers: a tier the runner does not build would be one the jury never gets, so it stops the runner. */
const TIER_NAMES = Object.freeze([...CONTEXT_PACK_TIERS]);
for (const name of TIER_NAMES) {
  if (name !== DOCUMENTS && !Object.prototype.hasOwnProperty.call(SHARES, name)) throw new Error(`@verdikta/common names a context pack tier the runner does not build: ${name}`);
}
if (TIER_NAMES.length !== Object.keys(SHARES).length + 1) throw new Error('@verdikta/common\'s context pack tiers are not the runner\'s');
const TIERS = Object.freeze(TIER_NAMES.map((name) => Object.freeze({ name, share: name === DOCUMENTS ? null : SHARES[name] })));

/** Whether the listing names documents: stake.documents is a list with an entry. Without it, or with an empty list, the pack has no documents tier. */
function namesDocuments(spec) {
  const stake = spec && typeof spec === 'object' ? spec.stake : null;
  return Boolean(stake && typeof stake === 'object' && Array.isArray(stake.documents) && stake.documents.length > 0);
}

const DOCUMENT_HEADER = 'the maker\'s document at the listed commit (stake.documents): ';

/**
 * A prior finding's summary line at most, so that 8 of them always fit their tier's share: without documents. With
 * them and every tier full, common's contract has the prior findings give up the documents' share first.
 */
const MAX_SUMMARY_BYTES = 5200;
/** A known issue's line at most: a share of the tier, so that the listing's first ones always fit it, and a description of 2,000 characters fits this. */
const MAX_KNOWN_ISSUE_BYTES = 8192;
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
 * An entry as one line of canonical JSON, within its bound, measured as it is
 * written (escapes included): the list goes first, last item first, then the
 * texts give way in order. So what identifies an entry stays, and no single entry
 * can use up its tier. `cut` says it holds less than the document's.
 * @param {object} entry - a copy this may change
 * @param {{max:number, list:string, texts:string[], cut?:boolean}} o
 * @returns {{text:string, cut:boolean}}
 */
function boundedLine(entry, { max, list, texts, cut: alreadyCut = false }) {
  let cut = alreadyCut;
  let line = canonicalJson(entry);
  while (byteLength(line) > max && entry[list].length > 0) {
    entry[list].pop();
    cut = true;
    line = canonicalJson(entry);
  }
  for (const field of texts) {
    const over = byteLength(line) - max;
    if (over <= 0) break;
    if (typeof entry[field] !== 'string') continue;
    // Each byte of text cut takes at least one byte of its escaped form with it.
    entry[field] = cutBytes(entry[field], byteLength(entry[field]) - over);
    cut = true;
    line = canonicalJson(entry);
  }
  return { text: line, cut };
}

/** A prior finding's summary, as one line within its bound. */
function summaryEntry(prior) {
  const f = prior.finding || {};
  const shortened = (Array.isArray(f.affectedPaths) ? f.affectedPaths : []).some((p, i) => i >= SUMMARY_PATHS || byteLength(String(p)) > SUMMARY_PATH_BYTES);
  return boundedLine(wellFormedDeep(summaryOf(prior)), { max: MAX_SUMMARY_BYTES, list: 'affectedPaths', texts: ['rootCause', 'observable', 'title'], cut: shortened });
}

/** A known issue, as one line within its bound: its id, title and class stay, then what its description can keep. */
function knownIssueEntry(issue) {
  const copy = wellFormedDeep(issue);
  if (!Array.isArray(copy.paths)) copy.paths = [];
  return boundedLine(copy, { max: MAX_KNOWN_ISSUE_BYTES, list: 'paths', texts: ['description', 'title'] });
}

function summaryLine(prior) {
  return summaryEntry(prior).text;
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
 * appearance, without the framework's own, the first MAX_SYMBOLS of them, and
 * how many went past that and how many lines were too long to read whole.
 * @param {Map<string, Array<{line:number, text:string}>>} added - the PoC's added lines, by file
 * @returns {{symbols:string[], overCap:number, longLines:number}}
 */
function scanSymbols(added) {
  const seen = new Set();
  let longLines = 0;
  for (const lines of added.values()) {
    for (const { text } of lines) {
      if (text.length > MAX_SCANNED_LINE) longLines += 1;
      for (const m of text.slice(0, MAX_SCANNED_LINE).matchAll(SYMBOL)) {
        const receiver = m[1];
        const name = m[2] || m[3];
        if (receiver && FRAMEWORK_RECEIVER.test(receiver)) continue;
        seen.add(name);
      }
    }
  }
  const all = [...seen];
  return { symbols: all.slice(0, MAX_SYMBOLS), overCap: Math.max(0, all.length - MAX_SYMBOLS), longLines };
}

function symbolsOf(added) {
  return scanSymbols(added).symbols;
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

/** asked = delivered + the sum of omitted, or the account is the runner's own bug. */
function checkAccount(what, asked, delivered, omitted) {
  const sum = Object.values(omitted).reduce((n, c) => n + c, 0);
  if (asked !== delivered + sum) throw new Error(`the pack's account of ${what} does not add up: asked ${asked}, delivered ${delivered}, omitted ${sum}`);
}

/**
 * The account of one list: the one way an item leaves it. An item is delivered,
 * or omitted with a reason from the fixed list; account() refuses a list that
 * does not add up, so a filter cannot drop an item without naming why.
 */
class Tally {
  constructor(asked) {
    this.asked = asked;
    this.items = [];
    this.omitted = {};
  }

  deliver(item) {
    this.items.push(item);
  }

  omit(reason, count = 1) {
    if (!REASONS.has(reason)) throw new TypeError(`no such reason: ${reason}`);
    if (count > 0) this.omitted[reason] = (this.omitted[reason] || 0) + count;
  }

  account() {
    checkAccount('a list', this.asked, this.items.length, this.omitted);
    return { asked: this.asked, items: this.items, omitted: { ...this.omitted } };
  }
}

/**
 * `git cat-file --batch`'s answer on `<commit>:<path>` lines, read as a stream
 * record by record: a blob of any size costs only what is kept of it, so an
 * early large or binary file cannot use up the read and hide the ones after it.
 * The same bytes make the same account however they arrive. A text is delivered
 * (`cut` when the read limit left part of it out); anything else is omitted with
 * its reason.
 */
class BlobSink {
  constructor(paths, tally = new Tally(paths.length)) {
    this.paths = paths;
    this.tally = tally;
    this.at = 0;
    this.textLeft = READ_MAX_BYTES;
    this.header = [];
    this.headerBytes = 0;
    this.record = null;
    this.endOfRecord = false;
  }

  get items() {
    return this.tally.items;
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
    if (!m) {
      // `<spec> missing`, or a gitlink's `<id> missing`.
      this.tally.omit('notInCommit');
      return;
    }
    const size = Number(m[2]);
    this.record = { path, type: m[1], size, left: size, keep: this.keepFor(size), kept: 0, chunks: [] };
    if (size === 0) this.finishRecord();
  }

  /** How much of a record of `size` bytes is kept: at least what tells a binary file from a text, whatever the texts before it took. */
  keepFor(size) {
    return Math.min(size, MAX_BLOB_BYTES, Math.max(BINARY_PROBE_BYTES, this.textLeft));
  }

  finishRecord() {
    const { path, type, size, kept, chunks } = this.record;
    this.record = null;
    this.endOfRecord = true;
    this.accept({ path, type, size, kept, content: Buffer.concat(chunks) });
  }

  /** One record read: delivered, or omitted with its reason. */
  accept({ path, type, size, kept, content }) {
    if (type !== 'blob') {
      this.tally.omit('notAFile');
      return;
    }
    if (content.subarray(0, BINARY_PROBE_BYTES).includes(0)) {
      this.tally.omit('binary');
      return;
    }
    this.textLeft = Math.max(0, this.textLeft - kept);
    this.tally.deliver({ path, text: content.toString('utf8'), bytes: size, cut: kept < size });
  }

  /** The stream ended: a path git never answered for is named as such. */
  finish() {
    if (this.record) this.finishRecord();
    this.tally.omit('unread', this.paths.length - this.at);
    this.at = this.paths.length;
  }
}

/**
 * The documents' records (common's "Which files count"): each read whole, since a
 * document is at most maxFileBytes and whether it is text is decided on the whole
 * file (isDocumentText), and kept only when it is.
 */
class DocumentSink extends BlobSink {
  keepFor(size) {
    return Math.min(size, STAKE_DOCUMENT_LIMITS.maxFileBytes);
  }

  accept({ path, type, size, kept, content }) {
    if (type !== 'blob') this.tally.omit('notAFile');
    // git's own size over the bound: the listed sizes said otherwise, and nothing past the bound is read.
    else if (kept < size) this.tally.omit('tooLarge');
    else if (!common.isDocumentText(content)) this.tally.omit('notText');
    else this.tally.deliver({ path, text: content.toString('utf8'), bytes: size, cut: false });
  }
}

/** A path `git cat-file --batch` can be asked for: one line, no NUL. */
function askablePath(p) {
  return typeof p === 'string' && p !== '' && !/[\r\n\0]/.test(p);
}

/**
 * The one gathering path for files: every path asked for ends delivered, or
 * omitted with its reason. These paths never reach the report, so nothing else
 * is asked of them: what common's finding schema and the stake's scope accept is
 * the jury's to read.
 * @param {object} ctx
 * @param {string} name - the exec's name
 * @param {string} commit
 * @param {unknown[]} paths - what was asked for
 * @param {Function} [inScope] - a path's one form when it is in scope, else null
 * @returns {Promise<{asked:number, items:object[], omitted:object}>}
 */
async function gatherFiles(ctx, name, commit, paths, inScope = (p) => p) {
  const tally = new Tally(paths.length);
  const ask = new Set();
  for (const raw of paths) {
    if (!askablePath(raw)) {
      tally.omit('notAskable');
      continue;
    }
    const p = inScope(raw);
    if (p === null) tally.omit('outOfScope');
    else if (ask.has(p)) tally.omit('duplicate');
    else ask.add(p);
  }
  if (ask.size > 0) {
    const list = [...ask];
    const sink = new BlobSink(list, tally);
    const record = await ctx.exec(git(['cat-file', '--batch']), {
      name, timeoutMs: GIT_TIMEOUT_MS, stdin: Buffer.from(list.map((p) => `${commit}:${p}\n`).join(''), 'utf8'), tee: sink
    });
    if (record.exitCode !== 0) throw runnerError(name, `the pack's files could not be read (git exited ${record.exitCode})`);
    sink.finish();
  }
  return tally.account();
}

/** The finding's affected paths, as the source tier and the documents' selection read them. */
function affectedPathsOf(request) {
  return request.finding && Array.isArray(request.finding.affectedPaths) ? request.finding.affectedPaths : [];
}

/**
 * common's selection of the listing's documents (selectDocuments) over the listed commit's own entries, or null when
 * the listing names none. Pure: no read. Each sandbox runs it right after its forced checkout, before the patch and any
 * maker command (claim.js, fix.js), so a listing whose documents common refuses is the requester's broken package in
 * both, and no claim on it runs anything of the maker's. A path that is not UTF-8 is no candidate: it has no spelling
 * a glob or the file's header can carry.
 * @param {object} spec - code_review.json
 * @param {Array<{path:string, kind:string, size:number|null}>} listedFiles - the listed commit's own entries (checkout.js)
 * @param {unknown[]} affectedPaths - the finding's
 * @returns {{selection:{paths:string[], inSource:string[], pastCap:string[]}, byName:Map<string, object>}|null}
 * @throws {RequesterError} DOCUMENTS_MATCH_TOO_COSTLY, or STAKE_DOCUMENTS_INVALID for any other error from the selection
 */
function chooseDocuments(spec, listedFiles, affectedPaths) {
  if (!namesDocuments(spec)) return null;
  if (!Array.isArray(listedFiles)) throw new Error('the listed commit\'s own files were not listed');
  const byName = new Map();
  for (const entry of listedFiles) {
    const bytes = Buffer.from(entry.path, 'latin1');
    const name = bytes.toString('utf8');
    if (Buffer.from(name, 'utf8').equals(bytes)) byName.set(name, entry);
  }
  try {
    return { selection: common.selectDocuments([...byName.keys()], spec.stake, affectedPaths), byName };
  } catch (err) {
    const costly = Boolean(err && err.code === 'DOCUMENTS_MATCH_TOO_COSTLY');
    throw new RequesterError([{
      code: costly ? 'DOCUMENTS_MATCH_TOO_COSTLY' : 'STAKE_DOCUMENTS_INVALID',
      path: '/spec/stake/documents',
      detail: costly ? err.message : `stake.documents could not be matched against the listed commit's files (${err && err.name ? err.name : 'an error'} from @verdikta/common)`
    }]);
  }
}

/**
 * The documents tier's reads (owner decision Q61 (a); common's "Stake
 * documents"): common's selectDocuments over the listed commit's own entries,
 * then every selected regular file of at most maxFileBytes read whole from the
 * listed commit by commit id, and kept when common counts it as text. Every file
 * the selection names ends delivered or under its reason: the source tier's
 * (`inSource`), past the cap, a symbolic link, a submodule, too large (never
 * read), a path that is not one line, not text. The selection is chooseDocuments',
 * made at the sandbox's preparation (`chosen`), or here when none is given.
 * @param {object} ctx
 * @param {object} o
 * @param {string} o.commit - the listed commit, as the forced checkout committed it
 * @param {object} o.stake - the spec's stake block
 * @param {unknown[]} o.affectedPaths - the finding's
 * @param {Array<{path:string, kind:string, size:number|null}>} o.listedFiles - the listed commit's own entries (checkout.js)
 * @param {object|null} [o.chosen] - chooseDocuments' answer for this claim
 * @returns {Promise<{asked:number, items:object[], omitted:object}>}
 * @throws {RequesterError} the selection failed
 */
async function gatherDocuments(ctx, { commit, stake, affectedPaths, listedFiles, chosen = null }) {
  const { selection, byName } = chosen || chooseDocuments({ stake }, listedFiles, affectedPaths);
  const tally = new Tally(selection.paths.length + selection.inSource.length + selection.pastCap.length);
  tally.omit('inSource', selection.inSource.length);
  tally.omit('pastCap', selection.pastCap.length);
  const ask = [];
  for (const p of selection.paths) {
    const entry = byName.get(p);
    if (!entry) throw new Error('common selected a document the listed commit does not list');
    if (entry.kind === KIND.link) tally.omit('symlink');
    else if (entry.kind === KIND.gitlink) tally.omit('submodule');
    else if (entry.kind !== KIND.blob && entry.kind !== KIND.exec) tally.omit('notAFile');
    else if (!(entry.size <= STAKE_DOCUMENT_LIMITS.maxFileBytes)) tally.omit('tooLarge');
    else if (!askablePath(p)) tally.omit('notAskable');
    else ask.push(p);
  }
  if (ask.length > 0) {
    const sink = new DocumentSink(ask, tally);
    const record = await ctx.exec(git(['cat-file', '--batch']), {
      name: 'pack:documents', timeoutMs: GIT_TIMEOUT_MS, stdin: Buffer.from(ask.map((p) => `${commit}:${p}\n`).join(''), 'utf8'), tee: sink
    });
    if (record.exitCode !== 0) throw runnerError('pack:documents', `the listing's documents could not be read (git exited ${record.exitCode})`);
    sink.finish();
  }
  return tally.account();
}

/**
 * `git grep -z -n`'s answer read as a stream, line by line: only the head of
 * each line is kept, so a huge match costs nothing and hides nothing after it.
 * Every line is accounted for: a site, past the cap, out of scope, or unreadable
 * (a path longer than the head). The same bytes make the same account however they arrive.
 */
class GrepSink {
  constructor(prefix, keep) {
    this.prefix = prefix;
    this.keep = keep;
    this.sites = [];
    this.pastCap = 0;
    this.outOfScope = 0;
    this.unreadable = 0;
    this.head = [];
    this.headBytes = 0;
    this.overflow = false;
  }

  write(chunk) {
    let buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    while (buf.length > 0) {
      const nl = buf.indexOf(0x0a);
      const part = nl < 0 ? buf : buf.subarray(0, nl);
      const room = MAX_GREP_LINE_HEAD_BYTES - this.headBytes;
      if (part.length > room) this.overflow = true;
      if (room > 0) {
        const take = part.subarray(0, room);
        this.head.push(Buffer.from(take));
        this.headBytes += take.length;
      }
      if (nl < 0) return true;
      buf = buf.subarray(nl + 1);
      this.endLine();
    }
    return true;
  }

  endLine() {
    const parts = Buffer.concat(this.head).toString('utf8').split('\0');
    const overflow = this.overflow;
    this.head = [];
    this.headBytes = 0;
    this.overflow = false;
    if (parts.length < 3 || !parts[0].startsWith(this.prefix)) {
      this.unreadable += 1;
      return;
    }
    const path = parts[0].slice(this.prefix.length);
    if (!this.keep(path)) {
      this.outOfScope += 1;
      return;
    }
    if (this.sites.length >= MAX_SITES_PER_SYMBOL) {
      this.pastCap += 1;
      return;
    }
    const whole = parts.slice(2).join(' ').trim();
    const text = cutBytes(whole, MAX_SITE_BYTES);
    this.sites.push({ path, line: Number(parts[1]), text, cut: overflow || text !== whole });
  }

  /** The stream ended: a last line without its line feed is not read as a site. */
  finish() {
    if (this.headBytes > 0) {
      this.unreadable += 1;
      this.head = [];
      this.headBytes = 0;
    }
  }
}

/**
 * The call sites, as an account of sites, with the symbols' own counts beside it:
 * `symbols` are what was searched for, `asked` the lines git answered with.
 * found = withSites + noSites + overCap.
 */
async function gatherCallSites(ctx, listed, added, keep) {
  const { symbols, overCap, longLines } = scanSymbols(added);
  const items = [];
  const omitted = {};
  const omit = (reason, n) => { if (n > 0) omitted[reason] = (omitted[reason] || 0) + n; };
  let withSites = 0;
  for (let i = 0; i < symbols.length; i += 1) {
    const symbol = symbols[i];
    const name = `pack:grep:${i + 1}`;
    const sink = new GrepSink(`${listed}:`, keep);
    const record = await ctx.exec(git(['grep', '-n', '-w', '-F', '-I', '-z', '--no-color', '--full-name', '-e', symbol, listed, '--']), { name, timeoutMs: GIT_TIMEOUT_MS, tee: sink });
    if (record.exitCode !== 0 && record.exitCode !== 1) throw runnerError(name, `the call sites could not be read (git exited ${record.exitCode})`);
    sink.finish();
    omit('pastCap', sink.pastCap);
    omit('outOfScope', sink.outOfScope);
    omit('unreadable', sink.unreadable);
    if (sink.sites.length) withSites += 1;
    for (const site of sink.sites) items.push({ symbol, ...site });
  }
  const asked = items.length + Object.values(omitted).reduce((n, c) => n + c, 0);
  return {
    asked, items, omitted,
    symbols: { found: symbols.length + overCap, withSites, noSites: symbols.length - withSites, overCap, longLines }
  };
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
 * @param {Array<{path:string, kind:string, size:number|null}>} [o.listedFiles] - the listed commit's own entries, for the documents
 * @param {object|null} [o.documents] - chooseDocuments' answer, made at the preparation
 */
async function gatherPackInputs(ctx, { request, listed, poc, touched, added, listedFiles, documents: chosen = null }) {
  const diff = await read(ctx, 'pack:diff', ['diff', '-W', '--full-index', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames',
    '--diff-algorithm=myers', '--src-prefix=a/', '--dst-prefix=b/', listed, poc, '--']);
  if (diff.exitCode !== 0) throw runnerError('pack:diff', `the PoC's diff could not be read (git exited ${diff.exitCode})`);

  const pocPaths = touched.filter((t) => t.status !== 'D').map((t) => t.path);
  const pocFiles = await gatherFiles(ctx, 'pack:poc', poc, pocPaths);

  const spec = request.spec;
  const scope = spec.stake && spec.stake.scope ? spec.stake.scope : null;
  const named = affectedPathsOf(request);
  const sources = await gatherFiles(ctx, 'pack:source', listed, named, scope
    ? (p) => { const { inScope } = splitByStakeScope([p], scope); return inScope.length ? inScope[0] : null; }
    : (p) => p);

  // The maker's documents, right after the source (owner decision Q61 (a)); nothing is read for a listing that names none.
  const documents = namesDocuments(spec)
    ? await gatherDocuments(ctx, { commit: listed, stake: spec.stake, affectedPaths: named, listedFiles, chosen })
    : null;

  // Call sites in what the stake covers; without a scope, in anything but the tests and the framework's own paths.
  const skip = [...(spec.paths.tests || []), ...(spec.paths.protected || [])];
  const allowed = new Map();
  const keep = (p) => {
    if (!allowed.has(p)) allowed.set(p, scope ? splitByStakeScope([p], scope).inScope.length === 1 : !matchesAny(p, skip));
    return allowed.get(p);
  };
  const callSites = await gatherCallSites(ctx, listed, added || new Map(), keep);

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
    documents,
    callSites,
    tree: shallowTree(names.map((p) => Buffer.from(p, 'latin1').toString('utf8'))),
    treeCut: tree.truncated
  };
}

// ------------------------------------------------------------------ the assembly

function fileItem(slug, ext, header, body, cut = false) {
  // Well-formed as a whole: a path in the header can hold a lone surrogate a JSON escape wrote, as a body can.
  const text = `# ${header}\n${body}`.toWellFormed();
  return { slug, ext, text, bytes: byteLength(text) + FILE_OVERHEAD_BYTES, cut };
}

/** A file of one entry per line, each whole or not at all, so what it delivers can be counted. `entries`: { text, cut }. */
function linesItem(slug, header, entries) {
  const head = `# ${header}`.toWellFormed();
  const lines = entries.map((e) => ({ text: e.text.toWellFormed(), cut: e.cut === true }));
  return { slug, ext: 'txt', head, lines, bytes: byteLength(head) + lines.reduce((n, l) => n + 1 + byteLength(l.text), 0) + FILE_OVERHEAD_BYTES };
}

function blobBody(item) {
  return item.cut ? `${item.text}\n[cut by the runner: the first ${byteLength(item.text)} of ${item.bytes} bytes were read]` : item.text;
}

/** How many things a tier's items hold: a file is one, a file of lines holds one per line. */
function unitsOf(item) {
  return item.lines ? item.lines.length : 1;
}

/**
 * Every tier, whole, in priority order: its items, and what its gathering already
 * left out. Each tier's `asked` is in the units its items hold: files, or entries
 * of a list, or (call sites) the lines git answered with.
 */
function tierAccounts(request, inputs) {
  const known = Array.isArray(request.knownIssues) ? request.knownIssues : [];
  const priors = Array.isArray(request.priorFindings) ? request.priorFindings : [];
  const numbered = (list, slug, header) => list.items.map((f, i) => fileItem(`${slug}-${String(i + 1).padStart(3, '0')}`, 'txt', header(f), blobBody(f), f.cut === true));
  const oneFile = (item) => ({ asked: 1, omitted: {}, items: [item] });
  const none = { asked: 0, omitted: {}, items: [] };
  const hasDiff = inputs.pocDiff !== '';
  const sites = inputs.callSites;
  return {
    poc: {
      asked: 1 + inputs.pocFiles.asked,
      omitted: { ...inputs.pocFiles.omitted, ...(hasDiff ? {} : { noDiff: 1 }) },
      items: [
        ...(hasDiff ? [fileItem('poc-diff', 'patch', 'poc.patch with function context (git diff -W), written by the hunter', inputs.pocDiff, inputs.pocDiffCut === true)] : []),
        ...numbered(inputs.pocFiles, 'poc-file', (f) => `poc file: ${f.path}`)
      ]
    },
    claim: {
      asked: 2,
      omitted: {},
      items: [
        fileItem('finding', 'txt', 'finding.json, written by the hunter', canon(request.finding || {})),
        fileItem('report', 'txt', 'report.md, written by the hunter', typeof request.report === 'string' ? request.report : '')
      ]
    },
    source: { asked: inputs.sources.asked, omitted: { ...inputs.sources.omitted }, items: numbered(inputs.sources, 'source', (f) => `source file: ${f.path}`) },
    documents: inputs.documents
      ? { asked: inputs.documents.asked, omitted: { ...inputs.documents.omitted }, items: numbered(inputs.documents, 'document', (f) => `${DOCUMENT_HEADER}${f.path}`) }
      : null,
    callSites: {
      asked: sites.asked,
      omitted: { ...sites.omitted },
      symbols: sites.symbols,
      // A symbol past the cap, and a line too long to read whole, are left out of what was searched for.
      extraLoss: sites.symbols.overCap + sites.symbols.longLines,
      items: sites.items.length ? [linesItem('call-sites', `call sites of the symbols the PoC exercises (git grep -w on the listed commit, at most ${MAX_SITES_PER_SYMBOL} each), one per line: symbol: path:line: text`,
        sites.items.map((x) => ({ text: `${x.symbol}: ${x.path}:${x.line}: ${x.text}`, cut: x.cut })))] : []
    },
    knownIssues: {
      asked: known.length,
      omitted: {},
      items: known.length ? [linesItem('known-issues', 'known_issues.json, one entry per line, written by the maker', known.map(knownIssueEntry))] : []
    },
    priorFindings: {
      asked: priors.length,
      omitted: {},
      items: priors.length ? [linesItem('prior-findings', 'summaries of the prior valid findings on this listing, one per line, each written by its hunter', priors.map(summaryEntry))] : []
    },
    fix: request.fixPatch ? oneFile(fileItem('fix-diff', 'patch', 'fix.patch, written by the hunter', Buffer.from(request.fixPatch).toString('utf8'))) : none,
    tree: inputs.tree ? oneFile(fileItem('tree', 'txt', `a shallow file tree of the listed commit (${TREE_DEPTH} levels)`, inputs.tree, inputs.treeCut === true)) : none
  };
}

/**
 * Bytes per tier: first up to each share, in order, then what is left, in order, never past a tier's cap.
 * @param {number} budgetBytes
 * @param {Record<string, number>} sizes
 * @param {Array<{name:string, shareBytes:number, capBytes:number}>} plan - the pack's tiers, in order
 * @param {number} reserveBytes - the manifest's room
 */
function allocate(budgetBytes, sizes, plan, reserveBytes) {
  let remaining = budgetBytes - reserveBytes;
  const grants = {};
  for (const { name, shareBytes, capBytes } of plan) {
    const grant = Math.min(shareBytes, Math.min(sizes[name], capBytes), Math.max(0, remaining));
    grants[name] = grant;
    remaining -= grant;
  }
  for (const { name, capBytes } of plan) {
    const more = Math.min(Math.min(sizes[name], capBytes) - grants[name], Math.max(0, remaining));
    grants[name] += more;
    remaining -= more;
  }
  return grants;
}

/**
 * The pack's tiers in order, with their shares and caps in bytes: common's order, without the documents tier when the
 * listing names none. The documents' share is common's `reserved`, its cap common's `max`, both for the pack's class.
 * The manifest's room grows with the tier, so a pack without documents is laid out as it was.
 * @returns {{plan:Array<{name:string, shareBytes:number, capBytes:number}>, reserveBytes:number}}
 */
function tierPlan(request, codeClass, budgetBytes) {
  const documents = namesDocuments(request.spec);
  const limits = documents ? STAKE_DOCUMENT_LIMITS.tierBytes[codeClass] : null;
  if (documents && !limits) throw new Error(`@verdikta/common has no documents tier bytes for the class ${codeClass}`);
  const plan = TIER_NAMES.filter((name) => name !== DOCUMENTS || documents).map((name) => (name === DOCUMENTS
    ? { name, shareBytes: limits.reserved, capBytes: limits.max }
    : { name, shareBytes: Math.floor((budgetBytes * SHARES[name]) / 100), capBytes: Infinity }));
  return { plan, reserveBytes: MANIFEST_RESERVE_BYTES + (documents ? DOCUMENTS_MANIFEST_RESERVE_BYTES : 0) };
}

/** The file's lines that fit in `left`: whole lines only, with a line saying how many did not. Null when none does. */
function fitLines(item, left) {
  if (item.bytes <= left) return { ...item, text: [item.head, ...item.lines.map((l) => l.text)].join('\n'), kept: item.lines };
  let room = left - byteLength(item.head) - FILE_OVERHEAD_BYTES - LEFT_OUT_NOTE_BYTES;
  const kept = [];
  // In order; one that does not fit does not stop a smaller one after it.
  for (const line of item.lines) {
    const need = 1 + byteLength(line.text);
    if (need > room) continue;
    kept.push(line);
    room -= need;
  }
  if (kept.length === 0) return null;
  const text = [item.head, ...kept.map((l) => l.text), `[the runner left out ${item.lines.length - kept.length} more]`].join('\n');
  return { ...item, text, bytes: byteLength(text) + FILE_OVERHEAD_BYTES, kept };
}

/**
 * A tier's items within its grant: whole while they fit, then one cut (a file of
 * lines by whole lines), then none.
 * @returns {{kept:object[], delivered:number, cut:number}}
 */
function fillTier(items, grant) {
  const kept = [];
  let delivered = 0;
  let cut = 0;
  let left = grant;
  for (const item of items) {
    if (item.lines) {
      const fit = fitLines(item, left);
      if (fit) {
        kept.push(fit);
        delivered += fit.kept.length;
        cut += fit.kept.filter((l) => l.cut).length;
        left -= fit.bytes;
      }
      if (!fit || fit.kept.length < item.lines.length) break;
      continue;
    }
    if (item.bytes <= left) {
      kept.push(item);
      delivered += 1;
      if (item.cut) cut += 1;
      left -= item.bytes;
      continue;
    }
    if (left >= MIN_ITEM_BYTES) {
      const note = (shown) => `\n[cut by the runner: the first ${shown} of ${item.bytes - FILE_OVERHEAD_BYTES} bytes]`;
      const room = left - FILE_OVERHEAD_BYTES - byteLength(note(item.bytes));
      const head = cutBytes(item.text, room);
      const text = `${head}${note(byteLength(head))}`;
      kept.push({ ...item, text, bytes: byteLength(text) + FILE_OVERHEAD_BYTES });
      delivered += 1;
      cut += 1;
    }
    break;
  }
  return { kept, delivered, cut };
}

/** A tier's status, from its counts alone. */
function tierStatus({ delivered, omitted, cut, extraLoss = 0 }) {
  const lost = LOSS_REASONS.reduce((n, r) => n + (omitted[r] || 0), 0) + cut + extraLoss;
  if (lost === 0) return delivered > 0 ? 'full' : 'empty';
  return delivered > 0 ? 'truncated' : 'dropped';
}

/**
 * The context pack, once: a pure function of the request's documents and the
 * sandbox's reads.
 * @param {object} o
 * @param {object} o.request - finding, report, knownIssues, priorFindings, fixPatch, codeClass, and spec.stake.documents
 * @param {object} o.inputs - gatherPackInputs()'s
 * @param {string} [o.codeClass] - default: the request's, else code-standard
 * @param {number} [o.budgetTokens] - default: the class envelope's
 * @returns {{version:number, codeClass:string, budgetTokens:number, usedTokens:number, sha256:string, tiers:object[], files:Array<{name:string, tier:string, text:string}>}}
 */
function assemblePack({ request, inputs, codeClass = request.codeClass || 'code-standard', budgetTokens }) {
  const budget = budgetTokens === undefined ? getCodeClass(codeClass).envelope.contextPackTokens : budgetTokens;
  const { plan, reserveBytes } = tierPlan(request, codeClass, budget * BYTES_PER_TOKEN);
  const accounts = tierAccounts(request, inputs);
  if (plan.some((t) => t.name === DOCUMENTS) && !accounts[DOCUMENTS]) throw new Error('the listing names documents, and the pack has no account of them');
  const sizes = Object.fromEntries(plan.map(({ name }) => [name, accounts[name].items.reduce((n, i) => n + i.bytes, 0)]));
  const grants = allocate(budget * BYTES_PER_TOKEN, sizes, plan, reserveBytes);
  const files = [];
  const tiers = plan.map(({ name }, index) => {
    const account = accounts[name];
    const { kept, delivered, cut } = fillTier(account.items, grants[name]);
    const rank = index + 1;
    for (const k of kept) files.push({ name: `${String(rank).padStart(2, '0')}-${k.slug}.${k.ext}`, tier: name, text: k.text, bytes: k.bytes });
    const bytesIncluded = kept.reduce((n, k) => n + k.bytes, 0);
    const overBudget = account.items.reduce((n, i) => n + unitsOf(i), 0) - delivered;
    const omitted = { ...account.omitted, ...(overBudget > 0 ? { overBudget } : {}) };
    checkAccount(name, account.asked, delivered, omitted);
    return {
      rank, name, status: tierStatus({ delivered, omitted, cut, extraLoss: account.extraLoss }), asked: account.asked, delivered, omitted, cut,
      ...(account.symbols ? { symbols: account.symbols } : {}),
      bytes: sizes[name], bytesIncluded, tokens: packTokens(bytesIncluded)
    };
  });
  const manifest = canonicalJson({
    schema: PACK_SCHEMA,
    codeClass,
    budgetTokens: budget,
    tokenRule: TOKEN_RULE,
    note: 'The pack\'s tiers, in priority order. For each: asked = delivered + the sum of omitted, and cut counts what was delivered in part. A tier marked dropped or truncated lost something to a cap, a read limit, a size bound or the budget; what it left out is no evidence of anything.',
    tiers
  });
  const usedBytes = files.reduce((n, f) => n + f.bytes, 0) + byteLength(manifest) + FILE_OVERHEAD_BYTES;
  const outFiles = [{ name: '00-manifest.json', tier: 'manifest', text: manifest }, ...files.map(({ name, tier, text }) => ({ name, tier, text }))];
  const usedTokens = packTokens(usedBytes);
  const sha256 = crypto.createHash('sha256').update(canonicalJson({ version: PACK_VERSION, codeClass, budgetTokens: budget, usedTokens, tiers, files: outFiles }), 'utf8').digest('hex');
  return { version: PACK_VERSION, codeClass, budgetTokens: budget, usedTokens, sha256, tiers, files: outFiles };
}

module.exports = {
  gatherPackInputs, assemblePack, chooseDocuments, affectedPathsOf, packTokens, symbolsOf, scanSymbols, summaryOf, summaryLine, shallowTree, Tally, BlobSink, GrepSink, DocumentSink,
  namesDocuments, TIER_NAMES, TIERS, FACT_REASONS, LOSS_REASONS, BYTES_PER_TOKEN, FILE_OVERHEAD_BYTES, MANIFEST_RESERVE_BYTES, DOCUMENTS_MANIFEST_RESERVE_BYTES
};
