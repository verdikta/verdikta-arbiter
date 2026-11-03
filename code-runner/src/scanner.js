'use strict';

/**
 * Honesty flags and the fix check's lint (design §9.2 step 9, §9.5, §10.6;
 * node A3c). Semgrep runs in a sandbox of its own, on the image pinned below,
 * over bytes the runner read out of git before any claim code ran. The flags
 * are tier-A facts for the jury's fourth question: they reach
 * `poc.honestyFlags`, never `poc.integrity` and never a gate.
 *
 * What the runner forces, because a tool's defaults kept failing here:
 *
 * - **The tree is the runner's.** Only the files' bytes reach the sandbox, on
 *   stdin, under names the runner chooses (`f0.sol`), beside no other file, so
 *   nothing a hunter's patch holds can be a `.semgrepignore`, a `.semgrep.yml`
 *   or a path Semgrep's own ignore list skips (it skips `test/`). A flag's path
 *   comes back through the runner's own table.
 * - **What solc reads, the scanner reads.** The bytes are put in one form first
 *   (normaliseSource), and a line number is carried back to git's. solc's docs
 *   end a line comment at any of LF, VF, FF, CR, NEL, LS and PS. Measured, solc
 *   0.8.31 runs code after a lone CR and refuses the rest, and Semgrep's parser
 *   honours a CR too, so today this is a safeguard: the solc is the maker's choice.
 * - **Only the rule id and the lines of an answer are read.** Severity and text
 *   come from the tables below, so nothing a test says reaches the report.
 * - **No wall-clock decision inside the tool** (`--timeout 0`), so a slow host
 *   cannot change a flag: what bounds the work is the measured limits below,
 *   and the step's own timer, which abstains.
 *
 * What it measures, because a scan that could not finish must never read as
 * "no flags" (a hunter gains from that):
 *
 * - The file is the cause: a parse failure, a limit, a file the tool does not
 *   say it read, a rule past Semgrep's match cap. Each is a stated fact with a
 *   fixed rule id, the same on every host, ranked above every rule so padding
 *   cannot push it out. None of them hides a cheatcode's name: the text rules
 *   below run here, in the runner, over every file a rule can read, needing no
 *   parse, and in a file the parser did not wholly read a cheatcode's name is a flag.
 * - The host or the tool is the cause: any other error kind, a non-zero exit,
 *   an answer the runner cannot account for, a step timeout, OOM, a missing
 *   image. The run abstains.
 *
 * Why some rules are here and not in rules/honesty.yml: past 10,000 matches of
 * one rule in one file Semgrep drops every result of that file, with a warning
 * and exit 0. A pattern-regex rule matches comments too, where a hunter can
 * write that many cheaply, so one such rule could erase every flag in the file.
 *
 * Why the pin is here and not in @verdikta/common: common pins rule-set
 * versions, not this digest (§7.2, §9.3). The builder's baseline scan pins the
 * same release in verdikta-applications, with no check between the two
 * repositories. That is acceptable because nothing
 * needs them to agree: what the builder finds goes to the maker privately and is
 * never hashed, and `inputs.runner` ties a report to this pin, which
 * test/unit/scanner.test.js holds to RUNNER_VERSION.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { ABSTAIN, Abstain, RequesterError } = require('./result');
const { runText, isUnreachableText } = require('./docker');
const { BatchReader, algorithmOf } = require('./objects');
const { SEMGREP_RULES_VERSION, REPORT_LIMITS, REPORT_MAX_LINE, OCI_PLATFORM, CLASS_HARD_LIMITS } = require('./common');
const { git } = require('./git');
const { parseRawEntries } = require('./patch');
const { platformOf, parseInspectLines, INSPECT_FORMAT } = require('./images');
const { Prefix } = require('./capture');
const { SEMGREP } = require('./semgrepPin');
const forge = require('./forge');
const { discoverForge } = require('./integrity');

const RULES_VERSION = SEMGREP_RULES_VERSION;
const RULES_DIR = path.join(__dirname, '..', 'rules');
/** The rule files by name, with the bytes each must be. `solidity.yml` is the builder's file, byte for byte. */
const RULE_FILES = Object.freeze({
  honesty: Object.freeze({ file: 'honesty.yml', sha256: '9b3cb089c4211070fd4c4fb5766b825469c3d6fbfeb0d7dd5319ae59b18dcb0f' }),
  solidity: Object.freeze({ file: 'solidity.yml', sha256: '11900db04cec1f2a4fa469ab5adfe3b742b8d3cb749ea77f76ada23e5a6202e9' })
});

/**
 * The bounds on what Semgrep reads: measured, not timed. Its time on a crafted
 * file grows with size, and with each result it prints; its memory on
 * solidity.yml's ellipsis rule has no bound of its own; past 10,000 matches of one
 * rule it drops the file's results. At these sizes the worst shape took 156 s
 * under gVisor on a GitHub runner (`a.etch;` over 64 KiB, about 8,000 flags) and
 * 69 s under runc, with `--max-memory` holding the ellipsis rule to a stated fact,
 * and no shape crashed it (README, "Honesty flags"). Past one of these a file is
 * a stated fact, and the text rules still read it.
 */
const SCAN_LIMITS = Object.freeze({ files: 64, fileBytes: 64 * 1024, totalBytes: 64 * 1024 });
/** What the text rules read: past this a file is read by no rule, and says so. A patch cannot add this much (maxPatchBytes). */
const TEXT_LIMITS = Object.freeze({ fileBytes: 2 * 1024 * 1024, totalBytes: 8 * 1024 * 1024 });
/** Semgrep's own bound on a rule over a file (--max-memory, MiB): past it a per-file `Out of memory`, a stated fact. Below the container's. */
const SEMGREP_MAX_MEMORY_MB = 1024;
/** The scanner's own sandbox, whatever the listing asks of its own (the spec may say 256 MiB); the flags are every sandbox's. */
const SCAN_MEMORY_MB = 2048;
const SCAN_SANDBOX_LIMITS = Object.freeze({ cpus: CLASS_HARD_LIMITS.cpus, memoryMb: SCAN_MEMORY_MB, pids: 512 });
/** One scan's timer: more than twice the worst case the limits allow, so reaching it says something about the host, and the run abstains. */
const SCAN_TIMEOUT_MS = 240000;
/**
 * The scan's own budget, outside runSeconds: a claim's run may spend its whole
 * runSeconds, and a listing's derived limits know nothing of a hunter's file, so
 * a hostile file could otherwise turn any listing's run into an abstention. The
 * deadline still bounds it. An honest scan takes seconds.
 */
const SCAN_BUDGET_MS = 420000;
/**
 * What admission and the pull's window leave for the scan: an honest one's seconds, with room. Holding the whole
 * budget would cost a large listing its cold pull, for a case only a hostile file reaches. The deadline bounds the rest.
 */
const SCAN_RESERVE_MS = 60000;
const UNPACK_TIMEOUT_MS = 30000;
/** forge fmt's timer: its worst shape at the limits above took 13 s. */
const FMT_TIMEOUT_MS = 90000;
const READ_TIMEOUT_MS = 60000;
const CONFIG_MAX_BYTES = 1024 * 1024;
/** What Semgrep may answer: far above what the limits above can make it (about 340 bytes a result, at most some 13,000 results). */
const OUTPUT_MAX_BYTES = 64 * 1024 * 1024;
const STEP = 'scan';

const MAX_KEPT = 50;

const SEVERITY_OF = Object.freeze({ ERROR: 'high', WARNING: 'medium', INFO: 'low' });
function severityOf(semgrepSeverity) {
  return SEVERITY_OF[semgrepSeverity];
}

/** The honesty rules in rules/honesty.yml: what a flag says. The file holds the matching; this holds the words. */
const HONESTY_RULES = Object.freeze({
  'verdikta.honesty.storage-overwrite': { severity: 'high', message: 'Writes an account\'s storage directly (vm.store, forge-std\'s stdstore or the like) instead of reaching that state through the code.' },
  'verdikta.honesty.store-shaped-call': { severity: 'medium', message: 'Uses store in the shape of the vm.store cheatcode (three arguments, or its selector) on a receiver other than vm: the cheatcode through an alias, or a contract\'s own function. The test shows which.' },
  'verdikta.honesty.code-overwrite': { severity: 'high', message: 'Replaces the code at an address (vm.etch, deployCodeTo or a delegation cheatcode).' },
  'verdikta.honesty.call-mocked': { severity: 'high', message: 'Mocks a call (vm.mockCall or the like). If the mocked address is the module under test, the test does not exercise it.' },
  'verdikta.honesty.process-started': { severity: 'high', message: 'Starts a process on the host through ffi.' },
  'verdikta.honesty.cheatcode-raw-call': { severity: 'high', message: 'Calls the cheatcode address with a low-level call, which these rules cannot read by cheatcode name.' },
  'verdikta.honesty.network-reach': { severity: 'medium', message: 'Reaches for the network: a fork, an RPC endpoint or a replayed transaction.' },
  'verdikta.honesty.filesystem-write': { severity: 'medium', message: 'Writes, copies or removes files through a cheatcode.' },
  'verdikta.honesty.clock': { severity: 'medium', message: 'Moves block time or block numbers backwards, or to the end of their type, or reads or waits on the host\'s own clock: beyond the forward moves the framework gives a test.' },
  'verdikta.honesty.filesystem-read': { severity: 'low', message: 'Reads files or file metadata through a cheatcode.' },
  'verdikta.honesty.block-environment': { severity: 'low', message: 'Sets what a block commits to (block hash, randomness, fees, coinbase, chain id), an account\'s nonce or the process\'s environment.' }
});

/**
 * The rules that read text, run in the runner's own process over the normal form, so what a hunter writes must not cost
 * it time: a slow pattern would stop its deadline and cancellation timers. So no pattern holds a quantifier (a test holds
 * that), and what needs one is read token by token (scanCode), which cannot backtrack. No parse, and no match cap. They read
 * comments too, which costs little: these strings have no business in a test's comments, and the flag says what the jury should read.
 */
const TEXT_RULES = Object.freeze({
  // A cheatcode's signature or selector: the raw route needs one of these, whatever names the address.
  'verdikta.honesty.cheatcode-signature': {
    severity: 'high',
    message: 'Names a cheatcode that changes state by its signature or selector, the form a low-level call needs.',
    pattern: /\b(?:store\(address,bytes32,bytes32\)|etch\(address,bytes\)|setArbitraryStorage\(address\)|copyStorage\(address,address\)|loadAllocs\(string\)|mockCall\(address,|mockCallRevert\(address,|mockFunction\(address,|ffi\(string\[\]\)|tryFfi\(string\[\]\))|\b0x(?:70ca10bb|b4d6c782|e1631837|203dac0d|b3a056d7|b96213e4|81409b91|dbaad147|d23cd037|adf84d21|89160467|f45c1ce7)\b/gi
  },
  // The address by value: Vm(0x71...), or a raw call in Solidity or assembly. Calls through a handle the rules above can read by name.
  'verdikta.honesty.cheatcode-address': {
    severity: 'medium',
    message: 'Names the cheatcode address by value. Calls made through it may not be readable by cheatcode name.',
    pattern: /\b0x7109709ecfa91a80626ff3989d68f67f5b1dd12d\b/gi
  },
  // store with named arguments, which Semgrep's Solidity patterns cannot spell (scanCode).
  'verdikta.honesty.store-named-arguments': {
    severity: 'medium',
    message: 'Calls store with named arguments: the vm.store cheatcode, through an alias or not, or a contract\'s own function. The test shows which.'
  }
});

/**
 * A cheatcode's name as code uses it: a member (`x.store`, a call or a reference) or a call. A flag only in a file the
 * parser did not wholly read (a comment may say it anywhere else). A best effort beside the fact that always stands, that
 * the file was not wholly read: text cannot follow every alias.
 */
const REACH_NAMES = new Set('store|setArbitraryStorage|copyStorage|loadAllocs|checked_write|checked_write_int|etch|deployCodeTo|attachDelegation|signAndAttachDelegation|mockCall|mockCallRevert|mockCalls|mockFunction|ffi|tryFfi|createFork|createSelectFork|selectFork|rollFork|rpc|rpcUrl|rpcUrls|rpcUrlStructs|eth_getLogs|transact|writeFile|writeFileBinary|writeLine|writeJson|writeToml|copyFile|removeFile|removeDir|createDir|dumpState|readFile|readFileBinary|readLine|readDir|readLink|fsMetadata|unixTime|rewind'.split('|'));
/** Common names on contracts, which the rules read on vm alone (rules/honesty.yml). warp and roll count on vm whatever the argument, which cannot be judged here. */
const REACH_ON_VM = new Set('exists|isFile|isDir|sleep|setBlockhash|prevrandao|difficulty|chainId|fee|coinbase|txGasPrice|blobBaseFee|blobhashes|setNonce|setNonceUnsafe|resetNonce|setEnv|setEvmVersion|warp|roll'.split('|'));

/** The bug rules: solidity.yml's severities and messages, word for word (test/unit/scanner.test.js). */
const FIX_RULES = Object.freeze({
  'verdikta.solidity.tx-origin-auth': { severity: 'high', message: 'tx.origin is used for authorization; a contract the authorized account calls can act as that account.' },
  'verdikta.solidity.value-call-before-state-write': { severity: 'high', message: 'Ether is sent with a low-level call before a later mapping write in the same block; a reentrant caller sees the old state.' },
  'verdikta.solidity.unchecked-low-level-call': { severity: 'medium', message: 'The result of a low-level call is ignored; a failed call goes unnoticed.' },
  'verdikta.solidity.unchecked-erc20-transfer': { severity: 'medium', message: 'The boolean an ERC-20 transfer returns is ignored; a token that returns false on failure is treated as paid.' },
  'verdikta.solidity.arbitrary-transfer-from': { severity: 'high', message: 'transferFrom takes tokens from an address the caller chooses; anyone can spend another holder\'s allowance.' },
  'verdikta.solidity.delegatecall-to-parameter': { severity: 'high', message: 'delegatecall to an address the caller supplies runs any code with this contract\'s storage and balance.' },
  'verdikta.solidity.predictable-randomness': { severity: 'medium', message: 'Block values are used as randomness; a block producer, or a contract in the same block, can foresee them.' },
  'verdikta.solidity.selfdestruct': { severity: 'medium', message: 'selfdestruct sends the contract\'s balance to an address of the caller\'s choosing.' }
});

/** What the runner states itself, when a scan could not say. Fixed ids, ranked above every rule. */
const STATED = Object.freeze({
  'verdikta.honesty.not-scanned': { message: 'The honesty rules did not read this file.' },
  'verdikta.honesty.unread-file': { message: 'The rules that read code found nothing in this file because the scanner did not read it. The rules that read text still ran.' },
  'verdikta.honesty.unread-part': { message: 'The scanner could not parse part of this file, so a rule that reads code found nothing there. The rules that read text still ran.' },
  'verdikta.honesty.unread-reach': { message: 'In a file the scanner could not wholly read, this line names a cheatcode that changes state or reaches outside the test.' },
  'verdikta.honesty.truncated': { message: 'More flags than the report lists.' },
  'verdikta.scan.not-scanned': { message: 'The bug rules did not read this fixed file.' },
  'verdikta.scan.unread-file': { message: 'The bug rules found nothing in this fixed file because the scanner did not read it.' },
  'verdikta.scan.unread-part': { message: 'The scanner could not parse part of this fixed file, so the bug rules found nothing there.' },
  'verdikta.scan.no-baseline': { message: 'The listed version of this fixed file is past what a scan reads, so what the bug rules find in it is not told apart from what the listed commit already had.' },
  'verdikta.scan.truncated': { message: 'More findings than the report lists.' },
  'forge-fmt.unformatted': { message: 'forge fmt --check would change this file.' },
  'forge-fmt.unreadable': { message: 'forge fmt could not parse this file.' },
  'forge-fmt.not-run': { message: 'forge fmt did not read this fixed file.' }
});

const UNSCANNED_WORDS = Object.freeze({
  'too-large': `It is over the ${SCAN_LIMITS.fileBytes} bytes a file may have for the rules that read code. The rules that read text still ran.`,
  'unread': `It is over the ${TEXT_LIMITS.fileBytes} bytes any rule reads in a file, or the files before it in path order use up what a scan reads.`,
  'not-a-file': 'It is not a regular file (a symbolic link or a submodule).',
  'too-many-files': `The patch has more than the ${SCAN_LIMITS.files} files a scan takes, and this one sorts after them.`,
  'too-many-bytes': `The files before it in path order use up the ${SCAN_LIMITS.totalBytes} bytes a scan takes.`,
  'no-answer': 'The scanner was given it and did not report reading it.'
});

const UNREAD_WORDS = Object.freeze({
  parse: 'It could not parse the file.',
  memory: `A rule used the ${SEMGREP_MAX_MEMORY_MB} MiB a rule may use on one file.`,
  cap: 'One rule passed the scanner\'s limit of matches in one file, and past that limit the scanner drops every result for the file.'
});
const CAPPED_WORDS = 'This rule had more matches than the scanner lists in one file, so its lines are not listed.';
const ADDED_WORDS = 'The patch added this line.';
const EXISTING_WORDS = 'This line was already in the listed file; the patch changed others in it.';

/**
 * Where Semgrep writes its answer. Under gVisor its stdout is cut at 65,536 bytes
 * with exit 0, and in a file it is whole (measured: 2.7 MB), so stdout is never read.
 */
const ANSWER_FILE = Object.freeze({ honesty: '/work/poc.json', solidity: '/work/fix.json' });
const TARGET = /^f[0-9]+\.sol$/;
const COMMIT = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const TAR_NAME = /^(?:rules|src|base|fixed)\/[A-Za-z0-9._-]+$/;

// ------------------------------------------------------------------ the rules

function rulesFile(name, dir) {
  const pin = RULE_FILES[name];
  if (!pin) throw new TypeError(`no rule file ${JSON.stringify(name)}`);
  return { pin, where: path.join(dir, pin.file) };
}

/** Why the rule files on disk are not the pinned bytes, or null. */
function rulesProblem(dir = RULES_DIR) {
  for (const name of Object.keys(RULE_FILES)) {
    const { pin, where } = rulesFile(name, dir);
    let bytes;
    try {
      bytes = fs.readFileSync(where);
    } catch (err) {
      return `the rule file ${pin.file} cannot be read: ${err.code || err.message}`;
    }
    const got = crypto.createHash('sha256').update(bytes).digest('hex');
    if (got !== pin.sha256) return `the rule file ${pin.file} is not the pinned rule set ${RULES_VERSION} (SHA-256 ${got})`;
  }
  return null;
}

/** A rule file's bytes, checked against its pin before use. */
function ruleBytes(name, dir = RULES_DIR) {
  const { pin, where } = rulesFile(name, dir);
  let bytes;
  try {
    bytes = fs.readFileSync(where);
  } catch (err) {
    throw new Abstain(ABSTAIN.RUNNER_ERROR, `the rule file ${pin.file} cannot be read: ${err.code || err.message}`, { step: STEP });
  }
  const got = crypto.createHash('sha256').update(bytes).digest('hex');
  if (got !== pin.sha256) throw new Abstain(ABSTAIN.RUNNER_ERROR, `the rule file ${pin.file} is not the pinned rule set ${RULES_VERSION} (SHA-256 ${got})`, { step: STEP });
  return bytes;
}

// ------------------------------------------------------------------ the image

/**
 * The image as the daemon has it: its digest and platform, measured.
 * @returns {Promise<{image:string, version:string, rules:string, present:boolean, digest:string|null, platform:string|null, problem:string|null}>}
 */
async function imageStatus({ docker, platform = OCI_PLATFORM, signal }) {
  const out = { image: SEMGREP.reference, version: SEMGREP.version, rules: RULES_VERSION, present: false, digest: null, platform: null, problem: null };
  const r = await runText(docker, ['image', 'inspect', '--format', INSPECT_FORMAT, SEMGREP.reference], { timeoutMs: 30000, signal });
  if (r.spawnError) return { ...out, problem: `the docker CLI could not be started: ${r.spawnError}` };
  if (r.exitCode !== 0) {
    if (isUnreachableText(r.stderr)) return { ...out, problem: 'the Docker daemon could not be reached' };
    return { ...out, problem: /No such image/i.test(r.stderr)
      ? `the Semgrep image ${SEMGREP.reference} is not on this host: the installer warms it, the runner never pulls it`
      : `docker image inspect failed for the Semgrep image: ${String(r.stderr).split('\n')[0].slice(0, 200)}` };
  }
  const [info] = parseInspectLines(r.stdout);
  if (!info) return { ...out, problem: 'docker image inspect returned something unreadable for the Semgrep image' };
  const measured = { ...out, present: true, platform: platformOf(info), digest: info.repoDigests.some((d) => d.endsWith(`@${SEMGREP.indexDigest}`)) ? SEMGREP.indexDigest : null };
  if (!measured.digest) return { ...measured, problem: `the Semgrep image on this host does not carry the pinned digest ${SEMGREP.indexDigest}` };
  if (measured.platform !== platform) return { ...measured, problem: `the Semgrep image on this host is ${measured.platform}; this runner runs ${platform}` };
  return measured;
}

/** Before a claim's run (the engine's preflight): the scan will be able to run, or the run abstains now, not after the PoC. */
async function requireScanner({ docker, config, signal }) {
  const problem = rulesProblem();
  if (problem) throw new Abstain(ABSTAIN.RUNNER_ERROR, problem, { step: STEP });
  const status = await imageStatus({ docker, platform: config.platform, signal });
  if (status.problem) {
    throw new Abstain(status.present ? ABSTAIN.IMAGE_MISMATCH : ABSTAIN.IMAGE_UNAVAILABLE, status.problem, { step: 'admission' });
  }
}

// ------------------------------------------------------------------ the argv and the input

/**
 * Semgrep's whole argv: the runner's rule file, the runner's names, every
 * default that reads the tree or the clock turned off. No shell reads it.
 * @param {object} o
 * @param {'honesty'|'solidity'} o.rules
 * @param {string[]} o.targets - names the runner chose (`f0.sol`)
 * @param {string} [o.baseline] - the base commit of the repository the runner built
 */
function semgrepArgv({ rules, targets, baseline = null }) {
  const pin = RULE_FILES[rules];
  if (!pin) throw new TypeError(`no rule file ${JSON.stringify(rules)}`);
  if (!Array.isArray(targets) || targets.length === 0 || !targets.every((t) => typeof t === 'string' && TARGET.test(t))) {
    throw new TypeError('the targets must be names the runner chose');
  }
  if (baseline !== null && (typeof baseline !== 'string' || !COMMIT.test(baseline))) throw new TypeError('the baseline must be a full commit id');
  return [
    SEMGREP.binary, 'scan',
    '--config', `/work/rules/${pin.file}`,
    '--json', '--quiet',
    '--output', ANSWER_FILE[rules],
    '--metrics', 'off',
    '--disable-version-check',
    '--disable-nosem',
    '--no-git-ignore',
    '--oss-only',
    '--no-rewrite-rule-ids',
    '--jobs', '1',
    '--timeout', '0',
    '--max-target-bytes', '0',
    '--max-memory', String(SEMGREP_MAX_MEMORY_MB),
    ...(baseline ? ['--baseline-commit', baseline] : []),
    ...targets
  ];
}

function octal(n, width) {
  return `${n.toString(8).padStart(width - 1, '0')}\0`;
}

function tarHeader(name, size) {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, 'ascii');
  h.write(octal(0o644, 8), 100, 'ascii');
  h.write(octal(10001, 8), 108, 'ascii');
  h.write(octal(10001, 8), 116, 'ascii');
  h.write(octal(size, 12), 124, 'ascii');
  h.write(octal(0, 12), 136, 'ascii');
  h.fill(0x20, 148, 156);
  h.write('0', 156, 1, 'ascii');
  h.write('ustar\0', 257, 'ascii');
  h.write('00', 263, 'ascii');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
  return h;
}

/**
 * The sandbox's stdin: a tar of plain files under the runner's own names, so
 * tar has nothing to interpret.
 * @param {Array<{name:string, bytes:Buffer}>} entries
 */
function scanTar(entries) {
  const parts = [];
  for (const { name, bytes } of entries) {
    if (!TAR_NAME.test(name) || name.length > 99) throw new TypeError(`not a name the runner chose: ${JSON.stringify(name)}`);
    parts.push(tarHeader(name, bytes.length), bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

const IDENTITY_LINE = (line) => line;
/** The line ends solc's documentation names, other than a line feed (a lone CR; CRLF stays one line end). */
const EXOTIC_LINE_END = /\r(?!\n)|[\v\f\u0085\u2028\u2029]/;
const ANY_LINE_END = /\r\n|\n|\r|[\v\f\u0085\u2028\u2029]/g;

/**
 * The bytes in the form the scanner should read: well-formed UTF-8 with no NUL
 * (a regex rule fails on a whole file otherwise), and every line end solc
 * honours a line feed. `lineOf` carries a scanned line back to git's.
 * @param {Buffer} source
 * @returns {{bytes:Buffer, lineOf:function(number):number}}
 */
function normaliseSource(source) {
  const text = source.toString('utf8').replace(/\0/g, '?');
  const bytes = Buffer.from(text, 'utf8');
  if (!EXOTIC_LINE_END.test(text)) return { bytes: bytes.equals(source) ? source : bytes, lineOf: IDENTITY_LINE };
  // gitLines[n]: git's line of scanned line n + 1. Only a line feed moves git's count.
  const gitLines = [1];
  let line = 1;
  for (const m of text.matchAll(ANY_LINE_END)) {
    if (m[0].endsWith('\n')) line += 1;
    gitLines.push(line);
  }
  const normal = text.replace(new RegExp(EXOTIC_LINE_END.source, 'g'), '\n');
  return {
    bytes: Buffer.from(normal, 'utf8'),
    lineOf: (scanned) => gitLines[Math.min(scanned - 1, gitLines.length - 1)]
  };
}

/**
 * Which files the rules read and which are stated, by the measured limits, in
 * an order that is a function of the claim alone: Solidity by path, then the
 * rest by path. forge compiles an imported file of any name, so a `Helper.txt`
 * is read as Solidity too, but only a `.sol` file's
 * parse failure is a stated fact: a JSON fixture that does not parse is not a scan
 * that failed. A file past a limit is stated by any name, since padding a `.txt`
 * must hide nothing, and a name in what no parser read still counts (honestyFlags).
 * @param {Array<{path:string, mode:string, status:string, size:number, bytes:Buffer|null, added?:Set<number>}>} entries
 * @returns {{targets:object[], unscanned:Array<{path:string, reason:string}>, texts:object[]}}
 *   `targets`: what Semgrep reads, under the runner's names; `texts`: what the text rules read (every target and more)
 */
function prepareTargets(entries) {
  const targets = [];
  const unscanned = [];
  const texts = [];
  let total = 0;
  const isSolidity = (e) => e.path.endsWith('.sol');
  const list = entries.filter((e) => e.status !== 'D').sort((a, b) => Number(isSolidity(b)) - Number(isSolidity(a)) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const e of list) {
    const solidity = isSolidity(e);
    const state = (reason) => unscanned.push({ path: e.path, reason });
    if (e.mode !== '100644' && e.mode !== '100755') {
      state('not-a-file');
      continue;
    }
    if (!e.bytes) {
      state('unread');
      continue;
    }
    const { bytes, lineOf } = normaliseSource(e.bytes);
    const file = { path: e.path, bytes, raw: e.bytes, lineOf, added: e.added || new Set(), solidity };
    texts.push(file);
    // What Semgrep reads: invalid UTF-8 grows threefold in the normal form.
    if (bytes.length > SCAN_LIMITS.fileBytes) {
      state('too-large');
    } else if (targets.length >= SCAN_LIMITS.files) {
      state('too-many-files');
    } else if (total + bytes.length > SCAN_LIMITS.totalBytes) {
      state('too-many-bytes');
    } else {
      total += bytes.length;
      targets.push({ ...file, name: `f${targets.length}.sol` });
    }
  }
  return { targets, unscanned, texts };
}

/** The offsets of a text's line feeds, for a match's line. */
function lineFeeds(text) {
  const at = [];
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) at.push(i);
  return at;
}

/** The 1-based line of an offset: how many line feeds come before it, plus one. */
function lineAt(feeds, offset) {
  let lo = 0;
  let hi = feeds.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (feeds[mid] < offset) lo = mid + 1;
    else hi = mid;
  }
  return lo + 1;
}

/**
 * The text rules over what prepareTargets read: their hits, and every line that
 * names a cheatcode, which counts only where the parser did not read. Read on the
 * text with its comments blanked, as solc reads them, so a comment before a call
 * hides nothing, and on the text as written.
 * @param {object[]} texts
 * @returns {{hits:Array<{rule:string, path:string, line:number}>, reach:Map<string, number[]>}} lines are scanned lines
 */
function readText(texts) {
  const hits = [];
  const reach = new Map();
  for (const file of texts) {
    const text = file.bytes.toString('utf8');
    const feeds = lineFeeds(text);
    const forms = [text, blankComments(text)];
    const found = new Map(Object.keys(TEXT_RULES).map((rule) => [rule, new Set()]));
    const lines = new Set();
    for (const form of forms) {
      for (const [rule, { pattern }] of Object.entries(TEXT_RULES)) {
        if (pattern) for (const m of form.matchAll(pattern)) found.get(rule).add(m.index);
      }
      const code = scanCode(form);
      for (const at of code.named) found.get('verdikta.honesty.store-named-arguments').add(at);
      for (const at of code.reach) lines.add(lineAt(feeds, at));
    }
    for (const [rule, offsets] of found) for (const at of offsets) hits.push({ rule, path: file.path, line: lineAt(feeds, at) });
    if (lines.size) reach.set(file.path, [...lines].sort((x, y) => x - y));
  }
  return { hits, reach };
}

const isSpace = (c) => c === 32 || (c >= 9 && c <= 13);
const isWord = (c) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 36;

/**
 * Where a cheatcode's name stands in code, token by token. One pass, and each look
 * ahead stops at the next token or two, so its time is linear in the text whatever
 * the text is: there is nothing to backtrack over.
 * @param {string} text
 * @returns {{reach:number[], named:number[]}} offsets
 */
function scanCode(text) {
  const n = text.length;
  const next = (from) => {
    let i = from;
    while (i < n && isSpace(text.charCodeAt(i))) i += 1;
    return i;
  };
  const wordAt = (from) => {
    let e = from;
    while (e < n && isWord(text.charCodeAt(e))) e += 1;
    return text.slice(from, e);
  };
  /** An argument of warp or roll the framework's forward move is not: 0, the end of a type, block.timestamp - x (block.number - x). */
  const pastClock = (name, open) => {
    const a = next(open + 1);
    const w = wordAt(a);
    if (w === '0') return text[next(a + 1)] === ')';
    if (w === 'type') return text[next(a + 4)] === '(';
    if (w !== 'block') return false;
    const dot = next(a + 5);
    if (text[dot] !== '.') return false;
    const f = next(dot + 1);
    const field = wordAt(f);
    return field === (name === 'warp' ? 'timestamp' : 'number') && text[next(f + field.length)] === '-';
  };
  const reach = [];
  const named = [];
  let lastWord = '';
  let onlyParens = false;
  let member = false;
  let memberOfVm = false;
  let i = 0;
  while (i < n) {
    const c = text.charCodeAt(i);
    if (isSpace(c)) {
      i += 1;
    } else if (isWord(c)) {
      const word = wordAt(i);
      const after = next(i + word.length);
      const a = text[after];
      if ((REACH_NAMES.has(word) && (member || a === '(' || a === '{'))
        || (memberOfVm && REACH_ON_VM.has(word))
        || (member && (word === 'warp' || word === 'roll') && a === '(' && pastClock(word, after))) reach.push(i);
      if (word === 'store' && member && a === '(' && text[next(after + 1)] === '{') named.push(i);
      lastWord = word;
      onlyParens = true;
      member = false;
      memberOfVm = false;
      i += word.length;
    } else {
      member = c === 46;
      memberOfVm = member && onlyParens && lastWord === 'vm';
      // `(vm).x`: closing parentheses keep the word as the receiver; anything else ends it.
      if (c !== 41) onlyParens = false;
      i += 1;
    }
  }
  return { reach, named };
}

/**
 * The text with its comments blanked, every offset and line feed kept, as solc
 * lexes them: a `//` or `/*` in a string opens no comment, a quote in a comment
 * opens no string, a backslash escapes in a string, and a string ends at its line.
 */
function blankComments(text) {
  let out = '';
  let from = 0;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"' || c === "'") {
      i += 1;
      while (i < text.length && text[i] !== c && text[i] !== '\n') i += text[i] === '\\' ? 2 : 1;
      i += 1;
    } else if (c === '/' && (text[i + 1] === '/' || text[i + 1] === '*')) {
      let end;
      if (text[i + 1] === '/') {
        end = text.indexOf('\n', i + 2);
        if (end < 0) end = text.length;
      } else {
        end = text.indexOf('*/', i + 2);
        end = end < 0 ? text.length : end + 2;
      }
      out += text.slice(from, i) + text.slice(i, end).replace(/[^\n]/g, ' ');
      from = end;
      i = end;
    } else {
      i += 1;
    }
  }
  return out + text.slice(from);
}

const NO_TEXT = Object.freeze({ hits: [], reach: new Map() });

/** The text rules' own hash: they live in this file, and a change to one is a change of the pin (test/unit/scanner.test.js). */
function textRulesSha256() {
  const form = {
    rules: Object.fromEntries(Object.entries(TEXT_RULES).map(([id, r]) => [id, [r.severity, r.message, r.pattern ? r.pattern.source : null, r.pattern ? r.pattern.flags : null]])),
    names: [[...REACH_NAMES], [...REACH_ON_VM]],
    code: [scanCode.toString(), blankComments.toString()]
  };
  return crypto.createHash('sha256').update(JSON.stringify(form)).digest('hex');
}

// ------------------------------------------------------------------ the answer

function toolFailed(detail) {
  return new Abstain(ABSTAIN.RUNNER_ERROR, `the Semgrep scan: ${detail}`, { step: STEP });
}

const PARSE_FAILURES = new Set(['Syntax error', 'Lexical error', 'Other syntax error', 'Parse error']);

/**
 * Semgrep's answer, held to account: every result and error must be one the
 * runner can name, or the run abstains. Only the rule id, the path and the
 * lines are read from a result, so no text of the file travels.
 * @param {{stdout:Buffer, exitCode:number, truncated:boolean}} run
 * @param {Array<{name:string}>} targets
 * @param {{table:object}} o - the rules this scan ran
 * @returns {{hits:object[], partial:Map, unreadable:Map, capped:object[], missing:string[]}}
 * @throws {Abstain}
 */
function parseScan({ stdout, exitCode, truncated }, targets, { table }) {
  if (exitCode !== 0) throw toolFailed(`Semgrep exited ${exitCode}`);
  if (truncated) throw toolFailed(`its answer was cut at ${OUTPUT_MAX_BYTES} bytes`);
  let doc;
  try {
    doc = JSON.parse(Buffer.from(stdout).toString('utf8'));
  } catch (_) {
    throw toolFailed('its answer is not JSON');
  }
  if (!doc || doc.version !== SEMGREP.version) throw toolFailed(`it reports version ${JSON.stringify(doc && doc.version)}, not the pinned ${SEMGREP.version}`);
  if (!Array.isArray(doc.results)) throw toolFailed('its answer has no results');
  if (!Array.isArray(doc.errors)) throw toolFailed('its answer has no errors list');
  if (!doc.paths || !Array.isArray(doc.paths.scanned)) throw toolFailed('its answer does not list what it scanned');
  // A rule it skipped found nothing, and says so only here: the same as "no flags" to anything that reads no further.
  if (!Array.isArray(doc.skipped_rules) || doc.skipped_rules.length > 0) throw toolFailed(`it skipped rules: ${String(JSON.stringify(doc.skipped_rules)).slice(0, 200)}`);
  if (doc.engine_requested !== 'OSS') throw toolFailed(`it used the ${JSON.stringify(String(doc.engine_requested)).slice(0, 40)} engine, not the one pinned`);

  const names = new Set(targets.map((t) => t.name));
  const known = (p, what) => {
    if (!names.has(p)) throw toolFailed(`${what} names a path it was not given: ${JSON.stringify(String(p)).slice(0, 80)}`);
    return p;
  };
  const lineIn = (l, what) => {
    if (!Number.isSafeInteger(l) || l < 1) throw toolFailed(`${what} has an unreadable line`);
    return l;
  };
  const hits = doc.results.map((r) => {
    if (!r || !Object.prototype.hasOwnProperty.call(table, r.check_id)) throw toolFailed(`a result names a rule the runner does not know: ${JSON.stringify(String(r && r.check_id)).slice(0, 80)}`);
    const start = lineIn(r.start && r.start.line, 'a result');
    const end = lineIn(r.end && r.end.line, 'a result');
    return { rule: r.check_id, name: known(r.path, 'a result'), start, end: Math.max(start, end) };
  });

  const partial = new Map();
  // Why a file was not read at all: `parse`, `memory`, or `cap` (Semgrep drops every result of a file past one rule's cap).
  const unreadable = new Map();
  const capped = [];
  for (const e of doc.errors) {
    const kind = e && (Array.isArray(e.type) ? e.type[0] : e.type);
    if (kind === 'PartialParsing') {
      const name = known(e.path, 'a parse error');
      const spans = Array.isArray(e.spans) ? e.spans : (Array.isArray(e.type) && Array.isArray(e.type[1]) ? e.type[1] : []);
      const list = spans.map((s) => [lineIn(s.start && s.start.line, 'a span'), lineIn(s.end && s.end.line, 'a span')]);
      if (list.length === 0) unreadable.set(name, 'parse');
      else partial.set(name, [...(partial.get(name) || []), ...list]);
    } else if (PARSE_FAILURES.has(kind)) {
      unreadable.set(known(e.path, 'a parse error'), 'parse');
    } else if (kind === 'Too many matches') {
      if (!Object.prototype.hasOwnProperty.call(table, e.rule_id)) throw toolFailed(`a match cap names a rule the runner does not know: ${JSON.stringify(String(e.rule_id)).slice(0, 80)}`);
      const name = known(e.path, 'a match cap');
      capped.push({ rule: e.rule_id, name });
      unreadable.set(name, 'cap');
    } else if (kind === 'Out of memory') {
      // Semgrep's own bound (--max-memory), per file, so a measured limit and not the host's: a fact about the file.
      unreadable.set(known(e.path, 'a memory limit'), 'memory');
    } else {
      // Anything else is the host or the tool, not a fact about the file (§12): never "no flags".
      throw toolFailed(`it reports ${JSON.stringify(String(kind)).slice(0, 80)}${e && e.path ? ' on a file' : ''}`);
    }
  }
  const scanned = new Set(doc.paths.scanned);
  return { hits, partial, unreadable, capped, missing: targets.map((t) => t.name).filter((n) => !scanned.has(n)) };
}

function reportLine(target, scannedLine) {
  const line = target.lineOf(scannedLine);
  return Number.isSafeInteger(line) && line >= 1 && line <= REPORT_MAX_LINE ? line : null;
}

/** The lines the parser skipped, as the report may say them, bounded. */
function spansInWords(target, spans) {
  const shown = spans.slice(0, 10).map(([s, e]) => {
    const a = target.lineOf(s);
    const b = target.lineOf(e);
    return a === b ? `${a}` : `${a} to ${b}`;
  });
  return `Lines ${shown.join(', ')}${spans.length > 10 ? ` and ${spans.length - 10} more` : ''}.`;
}

/** Flags the kept-set order ranks first among equals: the patch added their lines (a side table: the schema holds only the report's fields). */
const ADDED_FLAGS = new WeakSet();

/**
 * The honesty flags of one scan, unbounded.
 * @param {object} scan - parseScan's answer
 * @param {object[]} targets
 * @param {Array<{path:string, reason:string}>} [unscanned]
 * @param {object} [text] - readText's answer
 * @param {object[]} [texts] - what the text rules read, for its lines
 * @returns {Array<{rule:string, file:string, line:number|null, message:string}>}
 */
function honestyFlags(scan, targets, unscanned = [], text = NO_TEXT, texts = targets) {
  const byName = new Map(targets.map((t) => [t.name, t]));
  const byPath = new Map(texts.map((t) => [t.path, t]));
  const flags = new Map();
  const put = (rule, file, line, message, added = false) => {
    const key = `${rule}\u0000${file}\u0000${line}`;
    const had = flags.get(key);
    if (had) {
      if (added) ADDED_FLAGS.add(had);
      return;
    }
    const flag = { rule, file, line, message };
    if (added) ADDED_FLAGS.add(flag);
    flags.set(key, flag);
  };
  const stated = (id, file, line, more = '') => put(id, file, line, more ? `${STATED[id].message} ${more}` : STATED[id].message);

  for (const hit of scan.hits) {
    const t = byName.get(hit.name);
    let added = false;
    for (let l = hit.start; l <= hit.end && !added; l += 1) added = t.added.has(t.lineOf(l));
    put(hit.rule, t.path, reportLine(t, hit.start), `${HONESTY_RULES[hit.rule].message} ${added ? ADDED_WORDS : EXISTING_WORDS}`, added);
  }
  for (const { rule, name } of scan.capped) {
    put(rule, byName.get(name).path, null, `${HONESTY_RULES[rule].message} ${CAPPED_WORDS}`, true);
  }
  for (const hit of text.hits) {
    const t = byPath.get(hit.path);
    const added = t.added.has(t.lineOf(hit.line));
    put(hit.rule, t.path, reportLine(t, hit.line), `${TEXT_RULES[hit.rule].message} ${added ? ADDED_WORDS : EXISTING_WORDS}`, added);
  }

  // Where the parser did not read the whole file, a cheatcode's name on any line is a flag: what it lost can be wider
  // than the spans it reports, and a comment that names one in such a file costs a line a juror reads past.
  const read = new Set(targets.map((t) => t.path));
  for (const name of scan.unreadable.keys()) read.delete(byName.get(name).path);
  for (const name of scan.partial.keys()) read.delete(byName.get(name).path);
  for (const name of scan.missing) read.delete(byName.get(name).path);
  for (const [file, lines] of text.reach) {
    if (read.has(file)) continue;
    const t = byPath.get(file);
    for (const line of lines) stated('verdikta.honesty.unread-reach', file, reportLine(t, line));
  }

  // What could not be read is stated by any name, but for a parse failure off `.sol`: a JSON fixture does not parse, by design.
  for (const [name, spans] of scan.partial) {
    const t = byName.get(name);
    if (t.solidity !== false) stated('verdikta.honesty.unread-part', t.path, reportLine(t, spans[0][0]), spansInWords(t, spans));
  }
  for (const [name, why] of scan.unreadable) {
    const t = byName.get(name);
    if (why !== 'parse' || t.solidity !== false) stated('verdikta.honesty.unread-file', t.path, null, UNREAD_WORDS[why]);
  }
  for (const name of scan.missing) stated('verdikta.honesty.not-scanned', byName.get(name).path, null, UNSCANNED_WORDS['no-answer']);
  for (const u of unscanned) stated('verdikta.honesty.not-scanned', u.path, null, UNSCANNED_WORDS[u.reason]);
  return [...flags.values()];
}

/** A fix's findings from one baseline scan, unbounded. */
function fixFindings(scan, targets, unscanned = []) {
  const byName = new Map(targets.map((t) => [t.name, t]));
  const out = new Map();
  const put = (tool, rule, severity, file, line, message) => {
    out.set(`${rule}\u0000${file}\u0000${line}`, { tool, rule, severity, file, line, message, triage: null });
  };
  const stated = (id, file, line, more = '') => put('semgrep', id, 'medium', file, line, more ? `${STATED[id].message} ${more}` : STATED[id].message);
  for (const hit of scan.hits) {
    const t = byName.get(hit.name);
    put('semgrep', hit.rule, FIX_RULES[hit.rule].severity, t.path, reportLine(t, hit.start), FIX_RULES[hit.rule].message);
  }
  for (const { rule, name } of scan.capped) put('semgrep', rule, FIX_RULES[rule].severity, byName.get(name).path, null, `${FIX_RULES[rule].message} ${CAPPED_WORDS}`);
  for (const [name, spans] of scan.partial) {
    const t = byName.get(name);
    if (t.solidity !== false) stated('verdikta.scan.unread-part', t.path, reportLine(t, spans[0][0]), spansInWords(t, spans));
  }
  for (const [name, why] of scan.unreadable) {
    const t = byName.get(name);
    if (why !== 'parse' || t.solidity !== false) stated('verdikta.scan.unread-file', t.path, null, UNREAD_WORDS[why]);
  }
  for (const name of scan.missing) stated('verdikta.scan.not-scanned', byName.get(name).path, null, UNSCANNED_WORDS['no-answer']);
  for (const u of unscanned) stated('verdikta.scan.not-scanned', u.path, null, UNSCANNED_WORDS[u.reason]);
  return [...out.values()];
}

// ------------------------------------------------------------------ the bound

const compareText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const compareLine = (a, b) => (a === b ? 0 : a === null ? -1 : b === null ? 1 : a - b);
const SEVERITY_RANK = Object.freeze({ critical: 0, high: 1, medium: 2, low: 3, info: 4 });

/** common's canonical order for honesty flags: file, line (file-level first), rule, message. */
function compareFlagsCanonically(a, b) {
  return compareText(a.file, b.file) || compareLine(a.line, b.line) || compareText(a.rule, b.rule) || compareText(a.message, b.message);
}

function flagRank(flag) {
  if (STATED[flag.rule]) return 0;
  const rule = HONESTY_RULES[flag.rule] || TEXT_RULES[flag.rule];
  return rule ? SEVERITY_RANK[rule.severity] : SEVERITY_RANK.info;
}

/**
 * At most 50 flags: by rule severity (what the runner states first), then the
 * lines the patch added, then canonically; the rest counted by rule in one note
 * with a fixed id, so padding cannot hide that a rule fired. Handed out in
 * common's canonical order: the schema holds no severity for a flag.
 */
function boundFlags(flags) {
  const canonical = [...flags].sort(compareFlagsCanonically);
  if (canonical.length <= MAX_KEPT) return canonical;
  const ranked = [...flags].sort((a, b) => flagRank(a) - flagRank(b)
    || Number(ADDED_FLAGS.has(b)) - Number(ADDED_FLAGS.has(a))
    || compareFlagsCanonically(a, b));
  const kept = ranked.slice(0, MAX_KEPT - 1);
  const dropped = ranked.slice(MAX_KEPT - 1);
  const counts = new Map();
  for (const f of dropped) counts.set(f.rule, (counts.get(f.rule) || 0) + 1);
  const named = [...counts].sort(([a], [b]) => compareText(a, b)).map(([rule, n]) => `${rule}: ${n}`).join(', ');
  const note = {
    rule: 'verdikta.honesty.truncated',
    file: [...dropped].sort(compareFlagsCanonically)[0].file,
    line: null,
    message: `${STATED['verdikta.honesty.truncated'].message} ${dropped.length} more are not listed, by rule: ${named}.`.slice(0, REPORT_LIMITS.text)
  };
  return [...kept, note].sort(compareFlagsCanonically);
}

function compareFindings(a, b) {
  return SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || compareText(a.file, b.file) || compareLine(a.line, b.line)
    || compareText(a.tool, b.tool) || compareText(a.rule, b.rule) || compareText(a.message, b.message);
}

/**
 * At most 50 findings: what qualifies the rest first (a fact the runner states), then by severity; the rest counted in
 * one note. Handed out in common's order (severity first), which the report's hash puts them in anyway.
 */
function boundFindings(findings) {
  const sorted = [...findings].sort(compareFindings);
  if (sorted.length <= MAX_KEPT) return sorted;
  const stated = (f) => f.rule.startsWith('verdikta.scan.');
  const ranked = [...sorted.filter(stated), ...sorted.filter((f) => !stated(f))];
  const kept = ranked.slice(0, MAX_KEPT - 1);
  const dropped = ranked.slice(MAX_KEPT - 1);
  const note = {
    tool: 'semgrep',
    rule: 'verdikta.scan.truncated',
    severity: 'info',
    file: dropped[0].file,
    line: null,
    message: `${STATED['verdikta.scan.truncated'].message} ${dropped.length} more are not listed.`,
    triage: null
  };
  return [...kept.sort(compareFindings), note];
}

// ------------------------------------------------------------------ reading git, before any claim code

/**
 * What a commit changed against another, read from git's objects by id, while
 * no claim code has run: every path's mode and status, and the bytes of the ones
 * within the limits.
 * @param {object} ctx
 * @param {object} o
 * @param {string} o.step - exec name prefix
 * @param {string} o.from
 * @param {string} o.to
 * @param {boolean} [o.old] - read the bytes on the `from` side as well (the baseline)
 * @returns {Promise<Array<{path:string, mode:string, status:string, size:number, bytes:Buffer|null, oldBytes?:Buffer|null}>>}
 */
async function readChanged(ctx, { step, from, to, old = false }) {
  const algo = algorithmOf(from);
  const out = new Prefix(16 * 1024 * 1024);
  const raw = await ctx.exec(git(['diff', '--raw', '-z', '--no-renames', `--abbrev=${from.length}`, from, to, '--']), { name: `${step}:raw`, timeoutMs: READ_TIMEOUT_MS, tee: out });
  const parsed = raw.exitCode === 0 && !out.truncated ? parseRawEntries(out.bytes(), from.length) : null;
  if (!parsed || !parsed.ok) throw toolFailed(`the changed files could not be read: ${parsed ? parsed.reason : `git exited ${raw.exitCode}`}`);
  const read = async (name, ids) => {
    const map = new Map();
    if (ids.length === 0) return map;
    const reader = new BatchReader({ algo, maxObjectBytes: TEXT_LIMITS.fileBytes, maxTotalBytes: TEXT_LIMITS.totalBytes });
    const record = await ctx.exec(git(['cat-file', '--batch']), { name, timeoutMs: READ_TIMEOUT_MS, stdin: Buffer.from(ids.map((id) => `${id}\n`).join('')), tee: reader });
    const done = reader.finish();
    if (record.exitCode !== 0 || !done.ok) throw toolFailed(`the changed files could not be read: ${done.ok ? `git exited ${record.exitCode}` : done.reason}`);
    for (const r of done.records) {
      if (r.missing || r.type !== 'blob') throw toolFailed('a changed file could not be read from git');
      map.set(r.id, r);
    }
    return map;
  };
  // Solidity first, as prepareTargets reads them: what the text rules' total lets through must not depend on a fixture's name.
  const entries = parsed.entries.sort((a, b) => Number(b.path.endsWith('.sol')) - Number(a.path.endsWith('.sol')) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const isBlob = (mode) => mode === '100644' || mode === '100755';
  const news = await read(`${step}:read`, [...new Set(entries.filter((e) => e.status !== 'D' && isBlob(e.mode)).map((e) => e.id))]);
  const olds = old ? await read(`${step}:read-base`, [...new Set(entries.filter((e) => isBlob(e.oldMode) && !/^0+$/.test(e.oldId)).map((e) => e.oldId))]) : new Map();
  return entries.map((e) => {
    const r = news.get(e.id);
    const o = olds.get(e.oldId);
    return {
      path: e.path, mode: e.mode, status: e.status, size: r && Number.isSafeInteger(r.size) ? r.size : 0, bytes: r && r.content ? r.content : null,
      ...(old ? { oldBytes: o && o.content ? o.content : null, oldTooLarge: Boolean(o && !o.content) } : {})
    };
  });
}

// ------------------------------------------------------------------ the sandbox

/**
 * The sandbox the scans share: the pinned image, every sandbox's flags, fixed
 * limits, never the run's env image.
 */
function openScanner(ctx) {
  return ctx.openSandbox({ image: SEMGREP.reference, limits: SCAN_SANDBOX_LIMITS, tool: true });
}

async function unpack(handle, name, entries) {
  const r = await handle.exec(['/bin/tar', '-xf', '-', '-C', '/work'], { name, timeoutMs: UNPACK_TIMEOUT_MS, stdin: scanTar(entries), workdir: '/work' });
  if (r.exitCode !== 0) throw toolFailed(`its input could not be unpacked (tar exited ${r.exitCode})`);
}

async function runSemgrep(handle, name, { rules, targets, baseline = null, workdir, table }) {
  const r = await handle.exec(semgrepArgv({ rules, targets: targets.map((t) => t.name), baseline }), { name, timeoutMs: SCAN_TIMEOUT_MS, workdir });
  // A failed run leaves no answer to read: its exit code is the answer (parseScan).
  if (r.exitCode !== 0) return parseScan({ stdout: Buffer.alloc(0), exitCode: r.exitCode, truncated: false }, targets, { table });
  const answer = await handle.readFile(ANSWER_FILE[rules], { maxBytes: OUTPUT_MAX_BYTES, name: `${name}:answer`, timeoutMs: UNPACK_TIMEOUT_MS });
  if (answer.exitCode !== 0 && !answer.overLimit) throw toolFailed(`its answer could not be read (cat exited ${answer.exitCode})`);
  return parseScan({ stdout: answer.bytes, exitCode: 0, truncated: answer.overLimit }, targets, { table });
}

/**
 * The honesty flags of a PoC's files: the text rules here, then Semgrep over
 * what it may read. Nothing for Semgrep needs no sandbox.
 * @param {object|null} handle - the scanner's sandbox, when there are targets
 * @param {{targets:object[], unscanned:object[], texts:object[]}} input
 * @returns {Promise<object[]>} the flags, bounded
 */
async function scanPoc(handle, { targets, unscanned, texts }) {
  const text = readText(texts);
  if (targets.length === 0) return boundFlags(honestyFlags(NOTHING_SCANNED, targets, unscanned, text, texts));
  await unpack(handle, 'scan:poc:unpack', [
    { name: `rules/${RULE_FILES.honesty.file}`, bytes: ruleBytes('honesty') },
    ...targets.map((t) => ({ name: `src/${t.name}`, bytes: t.bytes }))
  ]);
  const scan = await runSemgrep(handle, 'scan:poc', { rules: 'honesty', targets, workdir: '/work/src', table: HONESTY_RULES });
  return boundFlags(honestyFlags(scan, targets, unscanned, text, texts));
}

const NOTHING_SCANNED = Object.freeze({ hits: [], partial: new Map(), unreadable: new Map(), capped: [], missing: [] });

/** Builds the baseline's repository from the runner's bytes alone: no `.git` a claim could have touched. Prints the base commit. */
const BASELINE_REPO_SCRIPT = [
  'set -eu',
  'export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null',
  'export GIT_AUTHOR_NAME=verdikta GIT_AUTHOR_EMAIL=runner@verdikta.invalid GIT_COMMITTER_NAME=verdikta GIT_COMMITTER_EMAIL=runner@verdikta.invalid',
  'export GIT_AUTHOR_DATE="1700000000 +0000" GIT_COMMITTER_DATE="1700000000 +0000"',
  'mkdir -p /work/base /work/fixed /work/repo',
  'cd /work/repo',
  'git init -q --template= -b main .',
  'for f in /work/base/*; do [ -e "$f" ] && cp "$f" .; done',
  'git add -A',
  'git commit -q --no-gpg-sign --allow-empty -m base',
  'base=$(git rev-parse --verify HEAD)',
  'git rm -q -r -f --ignore-unmatch .',
  'for f in /work/fixed/*; do [ -e "$f" ] && cp "$f" .; done',
  'git add -A',
  'git commit -q --no-gpg-sign --allow-empty -m fixed',
  'printf "vcr-base %s\\n" "$base"'
].join('\n');

/**
 * The bug rules over a fix's files, with --baseline-commit: what the fix
 * brought in, not what the listed commit already had.
 * @param {object|null} handle - the scanner's sandbox, when there are targets
 * @param {{targets:object[], unscanned:object[], oldBytes:Map<string,Buffer>}} input
 * @returns {Promise<object[]>} the findings, unbounded
 */
async function scanFix(handle, { targets, unscanned, oldBytes, noBaseline = [] }) {
  const stated = noBaseline.map((file) => ({ tool: 'semgrep', rule: 'verdikta.scan.no-baseline', severity: 'medium', file, line: null, message: STATED['verdikta.scan.no-baseline'].message, triage: null }));
  if (targets.length === 0) return [...stated, ...fixFindings(NOTHING_SCANNED, targets, unscanned)];
  await unpack(handle, 'scan:fix:unpack', [
    { name: `rules/${RULE_FILES.solidity.file}`, bytes: ruleBytes('solidity') },
    ...targets.filter((t) => oldBytes.has(t.path)).map((t) => ({ name: `base/${t.name}`, bytes: oldBytes.get(t.path) })),
    ...targets.map((t) => ({ name: `fixed/${t.name}`, bytes: t.bytes }))
  ]);
  const out = new Prefix(4096);
  const r = await handle.exec(['/bin/sh', '-c', BASELINE_REPO_SCRIPT, 'vcr-scan-repo'], { name: 'scan:fix:repo', timeoutMs: UNPACK_TIMEOUT_MS, workdir: '/work', tee: out });
  const m = /^vcr-base ([0-9a-f]{40})$/m.exec(out.bytes().toString('utf8'));
  if (r.exitCode !== 0 || !m) throw toolFailed(`the baseline's repository could not be built (exit ${r.exitCode})`);
  const scan = await runSemgrep(handle, 'scan:fix', { rules: 'solidity', targets, baseline: m[1], workdir: '/work/repo', table: FIX_RULES });
  return [...stated, ...fixFindings(scan, targets, unscanned)];
}

/**
 * What the lint reads of a fix: every file it changed, as a PoC's are read (forge
 * compiles an import of any name), with the listed bytes for the baseline, held to
 * the same limits. A preimage past them is not scanned: its findings then are not
 * told apart from the listed commit's, and the report says so.
 * @param {object[]} entries - readChanged's answer, with `old`
 * @returns {{targets:object[], unscanned:object[], oldBytes:Map<string,Buffer>, noBaseline:string[]}}
 */
function prepareFix(entries) {
  const { targets, unscanned } = prepareTargets(entries);
  const byPath = new Map(entries.map((e) => [e.path, e]));
  const oldBytes = new Map();
  const noBaseline = [];
  let total = 0;
  for (const { path: p } of targets) {
    const e = byPath.get(p);
    if (e.oldTooLarge) {
      noBaseline.push(p);
    } else if (e.oldBytes) {
      const bytes = normaliseSource(e.oldBytes).bytes;
      if (bytes.length > SCAN_LIMITS.fileBytes || total + bytes.length > SCAN_LIMITS.totalBytes) {
        noBaseline.push(p);
      } else {
        total += bytes.length;
        oldBytes.set(p, bytes);
      }
    }
  }
  return { targets, unscanned, oldBytes, noBaseline: noBaseline.sort() };
}

function fmtFinding(rule, file, more = '') {
  return { tool: 'forge-fmt', rule, severity: 'info', file, line: null, message: more ? `${STATED[rule].message} ${more}` : STATED[rule].message, triage: null };
}

/**
 * forge fmt --check over a fix's `.sol` files (a style fact: another name is not
 * its business), last, in a fresh sandbox of the env image holding only the listed
 * `foundry.toml` and the fixed bytes: no claim code has run there and none runs
 * beside it, so a fix's own code cannot reach what forge fmt reads, and its time is
 * not the run's. One file a call, since a file it cannot parse goes unreported
 * beside another. Exit 1 says either; which one is what it printed. Its diff
 * quotes source, so only the path is kept.
 * @param {object} ctx - the run's context, with the claim's sandboxes closed
 * @param {{targets:object[], unscanned:object[], config:Buffer|null, solc:string}} lint
 * @returns {Promise<object[]>} findings
 */
async function fmtFindings(ctx, { targets, unscanned, config, configProblem = null, solc }) {
  const out = unscanned.filter((u) => u.path.endsWith('.sol')).map((u) => fmtFinding('forge-fmt.not-run', u.path, UNSCANNED_WORDS[u.reason]));
  const files = targets.filter((t) => t.solidity);
  if (files.length === 0) return out;
  const notRun = (why) => [...out, ...files.map((t) => fmtFinding('forge-fmt.not-run', t.path, why))];
  if (configProblem) return notRun(`The listed foundry.toml is over the ${CONFIG_MAX_BYTES} bytes it reads, and its defaults would not be the listing's.`);
  const handle = await ctx.openSandbox();
  let found;
  try {
    found = await discoverForge(handle, 'scan:fmt:forge');
  } catch (err) {
    // A forge in the work tree is in the claim's sandboxes and not here: a fact about this step, never the requester's error.
    if (!(err instanceof RequesterError)) throw err;
    await handle.close();
    return notRun('This sandbox has no forge: the image\'s may live in the work tree, which it does not hold.');
  }
  const tool = { ...found, solc };
  const write = async (name, bytes) => {
    const r = await handle.exec(['/bin/sh', '-c', 'cat > "$1"', 'vcr-fmt-write', `${forge.FORGE_WORKDIR}/${name}`], { name: `scan:fmt:write:${name}`, timeoutMs: UNPACK_TIMEOUT_MS, stdin: bytes, workdir: forge.FORGE_WORKDIR });
    if (r.exitCode !== 0) throw toolFailed(`forge fmt's input could not be written (exit ${r.exitCode})`);
  };
  if (config) await write('foundry.toml', config);
  for (const t of files) await write(t.name, t.raw);
  for (const t of files) {
    let r;
    try {
      r = await handle.exec(forge.forgeArgv(tool, ['fmt', '--check', `${forge.FORGE_WORKDIR}/${t.name}`]), { name: `scan:fmt:${t.name}`, timeoutMs: FMT_TIMEOUT_MS, workdir: forge.FORGE_WORKDIR });
    } catch (err) {
      // A long sum or chain can overflow its stack (exit 134 on arm64): the file's doing, and a fix's lint decides nothing,
      // so it must not abstain the claim. A memory kill or a timeout is the host's, and stays an abstention.
      if (!(err instanceof Abstain) || err.cause !== ABSTAIN.KILLED_BY_SIGNAL) throw err;
      out.push(fmtFinding('forge-fmt.unreadable', t.path, err.detail));
      continue;
    }
    if (r.exitCode === 0) continue;
    if (/^Diff in /m.test(r.stdout.text)) out.push(fmtFinding('forge-fmt.unformatted', t.path));
    else out.push(fmtFinding('forge-fmt.unreadable', t.path, `forge fmt exited ${r.exitCode}.`));
  }
  await handle.close();
  return out;
}

/**
 * The listed commit's foundry.toml, from git's objects, while no claim code has
 * run: what forge fmt reads. `problem`: past the bound, which is not the same as
 * none, since forge fmt would then read its defaults as the listing's.
 * @returns {Promise<{config:Buffer|null, problem:string|null}>}
 */
async function readListedConfig(ctx, commit) {
  const out = new Prefix(CONFIG_MAX_BYTES + 256);
  const r = await ctx.exec(git(['cat-file', '--batch']), { name: 'fixscan:config', timeoutMs: READ_TIMEOUT_MS, stdin: Buffer.from(`${commit}:foundry.toml\n`), tee: out });
  if (r.exitCode !== 0) throw toolFailed(`the listed foundry.toml could not be read (git exited ${r.exitCode})`);
  const bytes = out.bytes();
  const nl = bytes.indexOf(0x0a);
  const m = nl < 0 ? null : /^[0-9a-f]+ blob ([0-9]+)$/.exec(bytes.subarray(0, nl).toString('latin1'));
  if (!m) return { config: null, problem: null };
  const size = Number(m[1]);
  if (size > CONFIG_MAX_BYTES) return { config: null, problem: 'too-large' };
  if (bytes.length < nl + 1 + size) throw toolFailed('the listed foundry.toml came back incomplete');
  return { config: Buffer.from(bytes.subarray(nl + 1, nl + 1 + size)), problem: null };
}

module.exports = {
  SEMGREP, RULES_VERSION, RULE_FILES, HONESTY_RULES, TEXT_RULES, FIX_RULES, STATED, SCAN_LIMITS, TEXT_LIMITS, SCAN_MEMORY_MB, SEMGREP_MAX_MEMORY_MB, SCAN_SANDBOX_LIMITS, SCAN_TIMEOUT_MS, SCAN_BUDGET_MS, SCAN_RESERVE_MS, FMT_TIMEOUT_MS, OUTPUT_MAX_BYTES,
  severityOf, ruleBytes, rulesProblem, imageStatus, requireScanner, semgrepArgv, scanTar, normaliseSource, prepareTargets, prepareFix, readText, textRulesSha256, parseScan, honestyFlags, fixFindings,
  boundFlags, boundFindings, readChanged, openScanner, scanPoc, scanFix, fmtFindings, readListedConfig, BASELINE_REPO_SCRIPT
};
