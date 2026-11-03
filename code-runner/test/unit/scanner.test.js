'use strict';

// Node A3c, the scanner (design §9.2 step 9, §9.5): what the runner forces and measures around
// Semgrep, without Semgrep. A fake answers as the real tool does; test/docker/honesty.docker.test.js
// holds the same rules to the real one.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { codeReview } = require('@verdikta/common');
const { RUNNER_VERSION } = require('../../src/version');
const { Abstain, ABSTAIN } = require('../../src/result');
const { IMAGE_REF } = require('../../src/classLimits');
const scanner = require('../../src/scanner');
const {
  SEMGREP, RULE_FILES, HONESTY_RULES, TEXT_RULES, FIX_RULES, STATED, SCAN_LIMITS, TEXT_LIMITS, SCAN_MEMORY_MB, ruleBytes, rulesProblem, semgrepArgv, scanTar, normaliseSource,
  prepareTargets, prepareFix, readText, readChanged, parseScan, honestyFlags, KeptFlags, fixFindings, boundFindings, severityOf, imageStatus
} = scanner;
const { fakeDocker, healthyDaemon } = require('../helpers/fakeDocker');
const { execFileSync } = require('node:child_process');

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const RULES_DIR = path.join(__dirname, '..', '..', 'rules');
const PIN_HISTORY = require('../fixtures/scanner-pin-history.json');

// ------------------------------------------------------------------ the pin

test('the pin is P3b\'s reviewed release, by the index digest, and a reference the runner accepts', () => {
  assert.equal(SEMGREP.version, '1.181.0');
  assert.equal(SEMGREP.repository, 'docker.io/semgrep/semgrep');
  assert.equal(SEMGREP.indexDigest, 'sha256:81474464c1f07483ba0682a44787fd93c91397419762a04abe2bafaae396304b');
  assert.equal(SEMGREP.reference, `${SEMGREP.repository}@${SEMGREP.indexDigest}`);
  assert.match(SEMGREP.reference, IMAGE_REF);
});

test('the rule files are the ones pinned, and the bug rules are byte for byte the builder\'s', () => {
  assert.deepEqual(Object.keys(RULE_FILES).sort(), ['honesty', 'solidity']);
  for (const [name, pin] of Object.entries(RULE_FILES)) {
    assert.equal(sha256(fs.readFileSync(path.join(RULES_DIR, pin.file))), pin.sha256, name);
    assert.equal(sha256(ruleBytes(name)), pin.sha256, name);
  }
  // verdikta-applications stake-attestation/builder/src/scanTools.js: SCAN_TOOLS.rules.sha256
  assert.equal(RULE_FILES.solidity.sha256, '11900db04cec1f2a4fa469ab5adfe3b742b8d3cb749ea77f76ada23e5a6202e9');
  assert.equal(rulesProblem(), null);
});

test('the rule set the rules ship under is the id common pins, and the report carries', () => {
  assert.equal(scanner.RULES_VERSION, codeReview.SEMGREP_RULES_VERSION);
  assert.equal(scanner.RULES_VERSION, '2026.10');
  for (const pin of Object.values(RULE_FILES)) {
    assert.match(fs.readFileSync(path.join(RULES_DIR, pin.file), 'utf8'), new RegExp(`rule set ${scanner.RULES_VERSION.replace('.', '\\.')}`));
  }
});

test('the image digest and the rule hashes cannot change without a bump of RUNNER_VERSION', () => {
  // inputs.runner is what ties a report to them: the report names no image and no rule hash. An
  // entry is never edited: a new pin is a new entry under a new version in package.json.
  const entry = PIN_HISTORY[RUNNER_VERSION];
  assert.ok(entry, `no pin history for runner ${RUNNER_VERSION}: add an entry, never edit one`);
  assert.deepEqual({ image: SEMGREP.reference, honesty: RULE_FILES.honesty.sha256, solidity: RULE_FILES.solidity.sha256, text: scanner.textRulesSha256() }, entry,
    `the Semgrep pin changed under runner ${RUNNER_VERSION}: bump the version in package.json and add an entry for it`);
});

test('a rule file that is not the pinned bytes is refused before use', () => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'vcr-rules-'));
  for (const pin of Object.values(RULE_FILES)) fs.copyFileSync(path.join(RULES_DIR, pin.file), path.join(dir, pin.file));
  assert.equal(rulesProblem(dir), null);
  fs.appendFileSync(path.join(dir, RULE_FILES.honesty.file), '# changed\n');
  assert.match(rulesProblem(dir), /honesty\.yml.*not the pinned/);
  assert.throws(() => ruleBytes('honesty', dir), (e) => e instanceof Abstain && e.cause === ABSTAIN.RUNNER_ERROR);
  fs.copyFileSync(path.join(RULES_DIR, RULE_FILES.honesty.file), path.join(dir, RULE_FILES.honesty.file));
  fs.rmSync(path.join(dir, RULE_FILES.solidity.file));
  assert.match(rulesProblem(dir), /solidity\.yml/);
});

// ------------------------------------------------------------------ the rule tables

/** The ids, severities and messages of a rule file, as a small reader of its fixed layout. */
function rulesIn(file) {
  const out = new Map();
  let id = null;
  for (const line of fs.readFileSync(path.join(RULES_DIR, file), 'utf8').split('\n')) {
    const m = /^ {2}- id: (\S+)$/.exec(line);
    if (m) { id = m[1]; out.set(id, {}); continue; }
    const f = /^ {4}(severity|message): (.*)$/.exec(line);
    if (f && id) out.get(id)[f[1]] = f[2];
  }
  return out;
}

test('every honesty rule in the file has its row in the table, at the file\'s severity, and no row is without a rule', () => {
  const inFile = rulesIn(RULE_FILES.honesty.file);
  assert.deepEqual([...inFile.keys()].sort(), Object.keys(HONESTY_RULES).sort());
  for (const [id, r] of inFile) {
    assert.equal(HONESTY_RULES[id].severity, severityOf(r.severity), id);
    assert.ok(HONESTY_RULES[id].message.length > 0 && HONESTY_RULES[id].message.length <= 500, id);
  }
});

test('every bug rule in the copied file has its row, with the file\'s severity and message word for word', () => {
  const inFile = rulesIn(RULE_FILES.solidity.file);
  assert.deepEqual([...inFile.keys()].sort(), Object.keys(FIX_RULES).sort());
  for (const [id, r] of inFile) {
    assert.equal(FIX_RULES[id].severity, severityOf(r.severity), id);
    assert.equal(FIX_RULES[id].message, r.message, id);
  }
});

test('a rule\'s text can name no metavariable: nothing of a test reaches the report through it', () => {
  for (const table of [HONESTY_RULES, TEXT_RULES, FIX_RULES, STATED]) {
    for (const [id, r] of Object.entries(table)) assert.doesNotMatch(r.message, /\$[A-Z]/, id);
  }
  for (const id of [...Object.keys(HONESTY_RULES), ...Object.keys(TEXT_RULES), ...Object.keys(FIX_RULES), ...Object.keys(STATED)]) {
    assert.match(id, /^[A-Za-z0-9][A-Za-z0-9._/:-]{0,199}$/, 'common\'s RuleId');
  }
});

test('the acceptance\'s families each have a rule', () => {
  for (const id of ['storage-overwrite', 'code-overwrite', 'call-mocked', 'network-reach', 'filesystem-read', 'filesystem-write', 'clock']) {
    assert.ok(HONESTY_RULES[`verdikta.honesty.${id}`], id);
  }
});

// ------------------------------------------------------------------ the argv

test('Semgrep\'s argv is fixed: the runner\'s rule file, its flat names, every default that reads the tree turned off', () => {
  const argv = semgrepArgv({ rules: 'honesty', targets: ['f0.sol', 'f1.sol'] });
  assert.equal(argv[1], 'scan');
  for (const flag of ['--json', '--quiet', '--disable-nosem', '--no-git-ignore', '--oss-only', '--no-rewrite-rule-ids', '--disable-version-check']) {
    assert.ok(argv.includes(flag), flag);
  }
  const value = (name) => argv[argv.indexOf(name) + 1];
  assert.equal(value('--config'), `/work/rules/${RULE_FILES.honesty.file}`);
  assert.equal(value('--metrics'), 'off');
  assert.equal(value('--jobs'), '1');
  assert.equal(value('--timeout'), '0', 'no wall-clock decision inside the tool: a slow host must not change a flag');
  assert.equal(value('--max-target-bytes'), '0');
  assert.deepEqual(argv.slice(-2), ['f0.sol', 'f1.sol']);
  assert.equal(value('--output'), '/work/poc.json', 'under gVisor its stdout is cut at 64 KiB, with exit 0: the answer goes to a file');
  assert.ok(!argv.some((a) => a.startsWith('--x-')), 'not an --x- flag: Semgrep says they are not its API');
  assert.ok(!argv.includes('--baseline-commit'));
});

test('a baseline scan adds only the commit the runner made, and takes the bug rules', () => {
  const id = 'a'.repeat(40);
  const argv = semgrepArgv({ rules: 'solidity', targets: ['f0.sol'], baseline: id });
  assert.equal(argv[argv.indexOf('--baseline-commit') + 1], id);
  assert.equal(argv[argv.indexOf('--config') + 1], `/work/rules/${RULE_FILES.solidity.file}`);
  assert.equal(argv[argv.indexOf('--output') + 1], '/work/fix.json');
  assert.throws(() => semgrepArgv({ rules: 'solidity', targets: ['f0.sol'], baseline: '--config=/x' }), TypeError);
});

test('only a target the runner named reaches the argv', () => {
  for (const bad of ['.semgrepignore', 'test/Exploit.t.sol', '../x.sol', '--config=/x.yml', 'f0.sol --x', 'F0.sol', 'f.sol', 'f0.yml']) {
    assert.throws(() => semgrepArgv({ rules: 'honesty', targets: [bad] }), TypeError, bad);
  }
  assert.throws(() => semgrepArgv({ rules: 'honesty', targets: [] }), TypeError);
  assert.throws(() => semgrepArgv({ rules: 'other', targets: ['f0.sol'] }), TypeError);
});

// ------------------------------------------------------------------ the input

/** tar entries back from a stream: name, size, type. */
function untar(buf) {
  const out = [];
  for (let at = 0; at + 512 <= buf.length;) {
    const head = buf.subarray(at, at + 512);
    if (head.every((b) => b === 0)) break;
    const name = head.toString('latin1', 0, 100).replace(/\0.*$/, '');
    const size = parseInt(head.toString('latin1', 124, 136), 8);
    const sum = parseInt(head.toString('latin1', 148, 155), 8);
    let check = 0;
    for (let i = 0; i < 512; i += 1) check += i >= 148 && i < 156 ? 0x20 : head[i];
    assert.equal(check, sum, 'the checksum');
    out.push({ name, type: head.toString('latin1', 156, 157), mode: head.toString('latin1', 100, 107), content: Buffer.from(buf.subarray(at + 512, at + 512 + size)) });
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

const entry = (p, text, over = {}) => ({ path: p, mode: '100644', status: 'A', bytes: Buffer.from(text), size: Buffer.byteLength(text), ...over });

test('a file reaches the scanner under the runner\'s name, so nothing in the tree can be its configuration', () => {
  const hostile = [
    '.semgrepignore', '.semgrep.yml', '.semgrep/rule.yml', 'test/.semgrepignore', '.semgrepignore.sol', '.gitignore', 'test/.git/config', '.semgrep.yaml', 'test/a b.sol'
  ].map((p) => entry(p, '*\n'));
  const { targets } = prepareTargets([...hostile, entry('test/Exploit.t.sol', 'contract E {}\n')]);
  const tar = untar(scanTar(targets.map((t) => ({ name: `src/${t.name}`, bytes: t.bytes }))));
  assert.deepEqual(tar.map((e) => e.name), targets.map((_, i) => `src/f${i}.sol`));
  for (const e of tar) {
    assert.equal(e.type, '0', 'a plain file, never a link');
    assert.match(e.name, /^src\/f[0-9]+\.sol$/);
  }
  assert.ok(targets.some((t) => t.path === 'test/Exploit.t.sol'));
});

test('a path is the report\'s business only: order is by path, whatever order git answered in', () => {
  const a = prepareTargets([entry('test/B.sol', 'b'), entry('test/A.sol', 'a')]);
  const b = prepareTargets([entry('test/A.sol', 'a'), entry('test/B.sol', 'b')]);
  assert.deepEqual(a.targets.map((t) => [t.name, t.path]), [['f0.sol', 'test/A.sol'], ['f1.sol', 'test/B.sol']]);
  assert.deepEqual(a.targets.map((t) => t.path), b.targets.map((t) => t.path));
});

test('what the rules cannot read is stated, by a measured limit, never dropped; the text rules read further than Semgrep', () => {
  const big = Buffer.alloc(SCAN_LIMITS.fileBytes + 1, 0x20);
  const atLimit = Buffer.alloc(SCAN_LIMITS.fileBytes, 0x20);
  const { targets, unscanned, texts } = prepareTargets([
    entry('test/Big.sol', '', { bytes: big, size: big.length }),
    entry('test/Huge.sol', '', { bytes: null, size: TEXT_LIMITS.fileBytes + 1 }),
    entry('test/AtLimit.sol', '', { bytes: atLimit, size: atLimit.length }),
    entry('test/Link.sol', 'target', { mode: '120000' }),
    entry('test/Sub.sol', '', { mode: '160000', bytes: null, size: 0 })
  ]);
  assert.deepEqual(targets.map((t) => t.path), ['test/AtLimit.sol']);
  assert.deepEqual(texts.map((t) => t.path), ['test/AtLimit.sol', 'test/Big.sol']);
  assert.deepEqual(unscanned.map((u) => [u.path, u.reason]), [['test/Big.sol', 'too-large'], ['test/Huge.sol', 'unread'], ['test/Link.sol', 'not-a-file'], ['test/Sub.sol', 'not-a-file']]);
});

test('past the file count and the total bytes, the rest in path order is stated', () => {
  const files = [];
  for (let i = 0; i < SCAN_LIMITS.files + 3; i += 1) files.push(entry(`test/T${String(i).padStart(4, '0')}.sol`, 'x'));
  const { targets, unscanned } = prepareTargets(files);
  assert.equal(targets.length, SCAN_LIMITS.files);
  assert.deepEqual(unscanned.map((u) => u.reason), ['too-many-files', 'too-many-files', 'too-many-files']);

  const chunk = Buffer.alloc(SCAN_LIMITS.fileBytes, 0x20);
  const bulk = [];
  for (let i = 0; i <= Math.ceil(SCAN_LIMITS.totalBytes / SCAN_LIMITS.fileBytes); i += 1) bulk.push(entry(`test/B${i}.sol`, '', { bytes: chunk, size: chunk.length }));
  const r = prepareTargets(bulk);
  assert.ok(r.targets.reduce((n, t) => n + t.bytes.length, 0) <= SCAN_LIMITS.totalBytes);
  assert.ok(r.unscanned.length >= 1 && r.unscanned.every((u) => u.reason === 'too-many-bytes'));
});

test('the limits measure the bytes Semgrep reads: invalid UTF-8 cannot grow a file past them', () => {
  const invalid = Buffer.alloc(SCAN_LIMITS.fileBytes, 0xff);
  const { targets, unscanned } = prepareTargets([entry('test/Grown.sol', '', { bytes: invalid, size: invalid.length })]);
  assert.deepEqual(targets, []);
  assert.deepEqual(unscanned, [{ path: 'test/Grown.sol', reason: 'too-large' }]);
  const third = Buffer.alloc(Math.floor(SCAN_LIMITS.totalBytes / 3) - 1, 0xff);
  const r = prepareTargets([entry('test/A.sol', '', { bytes: third, size: third.length }), entry('test/B.sol', '', { bytes: third, size: third.length })]);
  assert.ok(r.targets.reduce((n, t) => n + t.bytes.length, 0) <= SCAN_LIMITS.totalBytes);
});

test('a deleted file is not a target; an empty one is', () => {
  const { targets, unscanned } = prepareTargets([entry('test/Gone.sol', '', { status: 'D', bytes: null, size: 0 }), entry('test/Empty.sol', '')]);
  assert.deepEqual(targets.map((t) => t.path), ['test/Empty.sol']);
  assert.deepEqual(unscanned, []);
});

// ------------------------------------------------------------------ the normal form: what solc reads, the scanner reads

test('every line terminator solc honours ends a line for the scanner too, so a comment cannot hide code solc runs', () => {
  for (const [name, t] of Object.entries({ cr: '\r', vt: '\v', ff: '\f', nel: '\u0085', ls: '\u2028', ps: '\u2029' })) {
    const { bytes, lineOf } = normaliseSource(Buffer.from(`// a comment${t}vm.store(a, b, c);\nnext();\n`));
    assert.deepEqual(bytes.toString('utf8').split('\n'), ['// a comment', 'vm.store(a, b, c);', 'next();', ''], name);
    // git's line numbers count line feeds: both are its line 1.
    assert.equal(lineOf(1), 1, name);
    assert.equal(lineOf(2), 1, name);
    assert.equal(lineOf(3), 2, name);
  }
});

test('CRLF stays one line, and a file with ordinary line ends is unchanged, byte for byte', () => {
  const crlf = Buffer.from('a();\r\nb();\r\n');
  const n = normaliseSource(crlf);
  assert.ok(n.bytes.equals(crlf));
  assert.equal(n.lineOf(2), 2);
  const plain = Buffer.from('pragma solidity ^0.8.0;\ncontract C {}\n');
  assert.ok(normaliseSource(plain).bytes.equals(plain));
});

test('a byte that is not UTF-8, and NUL, are replaced where they sit: a regex rule would otherwise fail on the whole file', () => {
  const { bytes, lineOf } = normaliseSource(Buffer.concat([Buffer.from('vm.etch(a, b); // '), Buffer.from([0xff, 0xfe, 0x00]), Buffer.from('\nnext();\n')]));
  assert.ok(bytes.toString('utf8').isWellFormed());
  assert.equal(bytes.indexOf(0), -1);
  assert.equal(Buffer.from(bytes.toString('utf8'), 'utf8').equals(bytes), true);
  assert.equal(bytes.toString('utf8').split('\n')[0].startsWith('vm.etch(a, b); // '), true);
  assert.equal(bytes.toString('utf8').split('\n')[1], 'next();');
  assert.equal(lineOf(2), 2);
});

// ------------------------------------------------------------------ reading Semgrep's answer

const scanOf = (results = [], errors = [], scanned = ['f0.sol'], over = {}) => Buffer.from(JSON.stringify({
  version: SEMGREP.version, results, errors, paths: { scanned }, engine_requested: 'OSS', skipped_rules: [], ...over
}));
const hit = (rule, file = 'f0.sol', line = 3, end = line) => ({
  check_id: rule, path: file, start: { line, col: 1, offset: 0 }, end: { line: end, col: 2, offset: 1 },
  extra: { message: 'vault.drain(secret) on $X and more', severity: 'INFO', lines: 'source text that must not travel', metadata: { hunter: 'yes' } }
});
const STORE = 'verdikta.honesty.storage-overwrite';
const ETCH = 'verdikta.honesty.code-overwrite';
const READ = 'verdikta.honesty.filesystem-read';
const STATED_ID = (name) => `verdikta.honesty.${name}`;
const targetsOf = (...paths) => paths.map((p, i) => ({ name: `f${i}.sol`, path: p, lineOf: (l) => l, added: new Set([1, 2, 3, 4, 5]), solidity: true }));
const parsed = (bytes, targets = targetsOf('test/E.sol'), table = HONESTY_RULES, exitCode = 0) => parseScan({ stdout: bytes, exitCode, truncated: false }, targets, { table });

test('a rule\'s severity, message and id come from the runner\'s table: nothing the tool printed reaches a flag', () => {
  const flags = honestyFlags(parsed(scanOf([hit(STORE)])), targetsOf('test/E.sol'));
  assert.deepEqual(flags.map((f) => [f.rule, f.file, f.line]), [[STORE, 'test/E.sol', 3]]);
  assert.ok(flags[0].message.startsWith(HONESTY_RULES[STORE].message));
  assert.doesNotMatch(JSON.stringify(flags), /secret|source text|hunter/);
});

test('whatever the tool says, an answer the runner cannot account for abstains: it never reads as no flags', () => {
  const abstains = (fn, re) => assert.throws(fn, (e) => e instanceof Abstain && e.cause === ABSTAIN.RUNNER_ERROR && re.test(e.detail));
  const t = targetsOf('test/E.sol');
  abstains(() => parsed(Buffer.from('not json')), /JSON/);
  abstains(() => parseScan({ stdout: scanOf(), exitCode: 2, truncated: false }, t, { table: HONESTY_RULES }), /exited 2/);
  abstains(() => parseScan({ stdout: scanOf(), exitCode: 0, truncated: true }, t, { table: HONESTY_RULES }), /cut/);
  abstains(() => parsed(scanOf([], [], ['f0.sol'], { version: '1.180.0' })), /version/);
  abstains(() => parsed(scanOf([], [], ['f0.sol'], { skipped_rules: [{ rule_id: STORE, details: 'x' }] })), /skipped/);
  abstains(() => parsed(scanOf([], [], ['f0.sol'], { skipped_rules: undefined })), /skipped/);
  abstains(() => parsed(scanOf([], [], ['f0.sol'], { engine_requested: 'PRO' })), /engine/);
  abstains(() => parsed(scanOf([], [], ['f0.sol'], { paths: undefined })), /scanned/);
  abstains(() => parsed(scanOf(undefined, [], ['f0.sol'], { results: undefined })), /results/);
  abstains(() => parsed(scanOf([hit('hunter.planted')])), /rule/);
  abstains(() => parsed(scanOf([hit(STORE, 'test/Exploit.t.sol')])), /path/);
  abstains(() => parsed(scanOf([{ ...hit(STORE), start: { line: 'x' } }])), /line/);
});

for (const kind of ['Timeout', 'Stack overflow', 'Fatal error', 'Rule parse error', 'Internal matching error', 'SemgrepError', 'Something new']) {
  test(`a host's or the tool's own failure abstains, not a fact about the file: ${kind}`, () => {
    assert.throws(() => parsed(scanOf([], [{ type: kind, level: 'warn', path: 'f0.sol', message: 'x' }])),
      (e) => e instanceof Abstain && e.cause === ABSTAIN.RUNNER_ERROR && e.detail.includes(kind));
  });
}

// The text rules over a target's own bytes.
function withText(source, added = [1, 2, 3, 4, 5, 6, 7, 8, 9]) {
  const { bytes, lineOf } = normaliseSource(Buffer.from(source));
  const target = { name: 'f0.sol', path: 'test/E.sol', bytes, lineOf, added: new Set(added) };
  return { target, targets: [target], text: readText([target]) };
}
const nine = ['pragma solidity ^0.8.0;', 'vm.store(a, b, c);', '// c', 'x();', 'vm.etch(a, b);', '// d', 'y();', 'z();', 'vm.ffi(a);', ''].join('\n');

test('a parse failure is a stated fact on the file, and the cheatcode names on its lines stay flags', () => {
  const { targets, text } = withText(nine);
  const flags = honestyFlags(parsed(scanOf([], [{ type: 'Syntax error', level: 'warn', path: 'f0.sol', message: 'x' }]), targets), targets, [], text);
  assert.deepEqual(flags.map((f) => [f.rule, f.line]).sort(), [
    [STATED_ID('unread-file'), null], [STATED_ID('unread-reach'), 2], [STATED_ID('unread-reach'), 5], [STATED_ID('unread-reach'), 9]
  ].sort());
  assert.match(flags.find((f) => f.rule === STATED_ID('unread-file')).message, /could not parse/);
});

test('a partial parse names its lines, and in that file a name counts on any line: what the parser lost is wider than it says', () => {
  const { targets, text } = withText(nine);
  const partial = { type: ['PartialParsing', []], level: 'warn', path: 'f0.sol', spans: [{ start: { line: 4 }, end: { line: 5 } }, { start: { line: 8 }, end: { line: 8 } }] };
  const flags = honestyFlags(parsed(scanOf([hit(STORE, 'f0.sol', 2)], [partial]), targets), targets, [], text);
  assert.deepEqual(flags.map((f) => [f.rule, f.line]).sort(), [
    [STATED_ID('unread-part'), 4], [STATED_ID('unread-reach'), 2], [STATED_ID('unread-reach'), 5], [STATED_ID('unread-reach'), 9], [STORE, 2]
  ].sort());
  assert.match(flags.find((f) => f.rule === STATED_ID('unread-part')).message, /4 to 5.*8/);
});

test('a span Semgrep gives inside its type is read too (its JSON has both forms)', () => {
  const { targets, text } = withText(nine);
  const partial = { type: ['PartialParsing', [{ path: 'f0.sol', start: { line: 5, col: 1, offset: 0 }, end: { line: 5, col: 2, offset: 1 } }]], level: 'warn', path: 'f0.sol' };
  const flags = honestyFlags(parsed(scanOf([], [partial]), targets), targets, [], text);
  assert.deepEqual(flags.filter((f) => f.rule === STATED_ID('unread-part')).map((f) => f.line), [5]);
});

test('a name on a file that parsed is no flag: the rules that read code judged it', () => {
  const { targets, text } = withText(nine);
  assert.deepEqual(honestyFlags(parsed(scanOf(), targets), targets, [], text), []);
});

test('Semgrep drops every result of a file past one rule\'s cap: the rule is stated, the file is unread, and the names on its lines stay flags', () => {
  const { targets, text } = withText(nine);
  const capped = { type: 'Too many matches', level: 'warn', path: 'f0.sol', rule_id: ETCH, message: 'x' };
  const flags = honestyFlags(parsed(scanOf([], [capped]), targets), targets, [], text);
  assert.deepEqual(flags.map((f) => [f.rule, f.line]).sort(), [
    [ETCH, null], [STATED_ID('unread-file'), null], [STATED_ID('unread-reach'), 2], [STATED_ID('unread-reach'), 5], [STATED_ID('unread-reach'), 9]
  ].sort());
  assert.match(flags.find((f) => f.rule === ETCH).message, /more matches than the scanner lists/);
  assert.match(flags.find((f) => f.rule === STATED_ID('unread-file')).message, /drops every result/);
});

test('the text rules run over a file past Semgrep\'s limit, and on it a cheatcode\'s name is a flag', () => {
  const big = Buffer.concat([Buffer.from('vm.etch(a, b);\n'), Buffer.alloc(SCAN_LIMITS.fileBytes, 0x20), Buffer.from('\nf(0x70ca10bb);\n')]);
  const input = prepareTargets([entry('test/Big.sol', '', { bytes: big, size: big.length, added: new Set([1, 3]) })]);
  assert.deepEqual(input.targets, []);
  const flags = honestyFlags({ hits: [], partial: new Map(), unreadable: new Map(), capped: [], missing: [] }, input.targets, input.unscanned, readText(input.texts), input.texts);
  assert.deepEqual(flags.map((f) => [f.rule, f.line]).sort(), [
    [STATED_ID('not-scanned'), null], [STATED_ID('unread-reach'), 1], ['verdikta.honesty.cheatcode-signature', 3]
  ].sort());
});

test('each text rule reads what Semgrep\'s Solidity patterns cannot, and no ordinary line', () => {
  const lines = (source) => readText([{ path: 'p', bytes: Buffer.from(source) }]).hits.flatMap((h) => h.lines.map((line) => [h.rule, line]));
  assert.deepEqual(lines('a();\nx.call(abi.encodeWithSignature("store(address,bytes32,bytes32)", a, b, c));\n'), [['verdikta.honesty.cheatcode-signature', 2]]);
  assert.deepEqual(lines('x.call(abi.encodeWithSelector(0xB4D6C782, a, b));\n'), [['verdikta.honesty.cheatcode-signature', 1]]);
  assert.deepEqual(lines('Vm v = Vm(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);\n'), [['verdikta.honesty.cheatcode-address', 1]]);
  assert.deepEqual(lines('assembly { let ok := call(gas(), 0x7109709ecfa91a80626ff3989d68f67f5b1dd12d, 0, 0, 0, 0, 0) }\n'), [['verdikta.honesty.cheatcode-address', 1]]);
  assert.deepEqual(lines('Cheat(a).store({a: b,\n c: d});\n'), [['verdikta.honesty.store-named-arguments', 1]]);
  assert.deepEqual(lines('Cheat(a) . /*x*/ store /*y*/ ( /*z*/ {a: b, c: d});\n'), [['verdikta.honesty.store-named-arguments', 1]]);
  assert.deepEqual(lines('vault.store(1);\nstore({a: 1});\nvault.storeAll({a: 1});\n'), []);
  assert.deepEqual(lines('vault.store(1); address(vault).call(hex"00"); uint256 fee = 0x70ca10bb00; string s = "store(uint256)"; 0x7109709ecfa91a80626ff3989d68f67f5b1dd12d00;\n'), []);
});

test('R4-F1: the text rules run in the runner\'s own process, so none of them can backtrack: no pattern holds a quantifier', () => {
  for (const [id, rule] of Object.entries(TEXT_RULES)) {
    if (!rule.pattern) continue;
    const bare = rule.pattern.source.replace(/\\./g, 'x').replace(/\(\?:/g, '(');
    assert.doesNotMatch(bare, /[*+?{]/, `${id} holds a quantifier`);
  }
});

test('R4-F1: on what a hunter can write at the limit, the text rules take no time to speak of', () => {
  const n = TEXT_LIMITS.fileBytes;
  const fill = (u) => u.repeat(Math.ceil(n / u.length)).slice(0, n);
  const shapes = {
    'vm and spaces': `vm${' '.repeat(n)}!`,
    'vm and spaces, again and again': fill(`vm${' '.repeat(1000)}!`),
    'vm and closing parentheses': `vm${') '.repeat(n / 2)}!`,
    'a dot and spaces': `.${' '.repeat(n)}!`,
    'dots': fill('.'),
    'dots and spaces': fill(`.${' '.repeat(1000)}`),
    'a name and spaces': `store${' '.repeat(n)}!`,
    'names and spaces': fill(`store${' '.repeat(1000)}`),
    '.warp( and spaces': fill(`.warp(${' '.repeat(1000)}`),
    '.store( and spaces': fill(`.store(${' '.repeat(1000)}`),
    'block . block .': fill('.warp(block . '),
    'open comments': fill('/*'),
    'line comments': fill('//\n'),
    'quotes': fill('"'),
    'backslashes in a string': `"${fill('\\')}`,
    'one long word': fill('a'),
    'words': fill('a '),
    'names': fill('.store '),
    'hex': fill('0x'),
    'store(': fill('store('),
    'line feeds': fill('\n')
  };
  for (const [name, source] of Object.entries(shapes)) {
    const bytes = Buffer.from(source);
    const t0 = Date.now();
    readText([{ path: 'p', bytes }]);
    assert.ok(Date.now() - t0 < 5000, `${name}: ${Date.now() - t0} ms for ${bytes.length} bytes`);
  }
});

test('R4-F1: the bound on what the text rules read is what a patch can add, not much more', () => {
  const { CLASS_HARD_LIMITS } = require('../../src/common');
  assert.ok(TEXT_LIMITS.fileBytes >= CLASS_HARD_LIMITS.maxPatchBytes, 'a file a patch adds is always read');
  assert.ok(TEXT_LIMITS.fileBytes <= 2 * CLASS_HARD_LIMITS.maxPatchBytes);
  assert.ok(TEXT_LIMITS.totalBytes <= 4 * TEXT_LIMITS.fileBytes);
});

// ------------------------------------------------------------------ R6-F1: the total the text rules read

const BLOB = Buffer.from('vm.store\n'.repeat(Math.floor(1900000 / 9)));
const flipped = (i, over = {}) => entry(`test/p${String(i).padStart(2, '0')}.txt`, '', { status: 'M', modeOnly: true, bytes: BLOB, size: BLOB.length, ...over });

test('R6-F1: the total is 2 MiB, and it holds everything a patch can create', () => {
  const { CLASS_HARD_LIMITS } = require('../../src/common');
  assert.equal(TEXT_LIMITS.totalBytes, 2 * 1024 * 1024);
  assert.ok(TEXT_LIMITS.totalBytes >= CLASS_HARD_LIMITS.maxPatchBytes, 'the files a patch creates always fit: their bytes are in the patch');
});

test('R6-F1: the budget is charged per path: 25 paths sharing one blob read it once, and the rest say so', () => {
  const list = [];
  for (let i = 0; i < 25; i += 1) list.push(flipped(i));
  const { texts, unscanned, targets } = prepareTargets(list);
  assert.deepEqual(texts.map((t) => t.path), ['test/p00.txt']);
  assert.ok(texts.reduce((n, t) => n + t.raw.length, 0) <= TEXT_LIMITS.totalBytes);
  assert.deepEqual(targets, []);
  assert.equal(unscanned.length, 25, 'one too large for Semgrep, 24 read by no rule: none of them silent');
  assert.deepEqual(unscanned.filter((u) => u.reason === 'unread').map((u) => u.path), list.slice(1).map((e) => e.path));
  assert.equal(unscanned.find((u) => u.path === 'test/p00.txt').reason, 'too-large');
});

test('R6-F1: which paths are read is a function of the claim: any order in, the same paths out', () => {
  const list = [];
  for (let i = 0; i < 25; i += 1) list.push(flipped(i, { bytes: Buffer.from(`${i}\n`.repeat(100000)), size: 0 }));
  const shuffled = [...list].sort((a, b) => sha256(a.path).localeCompare(sha256(b.path)));
  const a = prepareTargets(list);
  const b = prepareTargets(shuffled);
  assert.deepEqual(a.texts.map((t) => t.path), b.texts.map((t) => t.path));
  assert.deepEqual(a.unscanned, b.unscanned);
});

test('R6-F1: padding cannot crowd out what the patch created: it is read first, whatever its name', () => {
  const list = [];
  for (let i = 0; i < 25; i += 1) list.push(flipped(i));
  // A file the patch modified takes the budget before a mode change; a created helper before either.
  const edited = entry('test/a-edited.txt', '', { status: 'M', bytes: BLOB, size: BLOB.length });
  const helper = entry('test/zzz-helper.txt', 'vm.store(a, b, c);\n', { status: 'A' });
  const { texts, unscanned } = prepareTargets([...list, edited, helper]);
  assert.deepEqual(texts.map((t) => t.path).sort(), ['test/a-edited.txt', 'test/zzz-helper.txt']);
  assert.equal(unscanned.find((u) => u.path === 'test/p00.txt').reason, 'unread');
  assert.equal(unscanned.filter((u) => u.reason === 'unread').length, 25);
});

test('R6-F1: as much as a patch can create is always read, by any name, beside any padding', () => {
  const { CLASS_HARD_LIMITS } = require('../../src/common');
  const created = Buffer.alloc(CLASS_HARD_LIMITS.maxPatchBytes - 19, 0x20);
  const list = [];
  for (let i = 0; i < 25; i += 1) list.push(flipped(i));
  list.push(entry('test/a.txt', '', { status: 'A', bytes: created, size: created.length }), entry('test/zzz.txt', 'vm.store(a, b, c);\n', { status: 'A' }));
  assert.deepEqual(prepareTargets(list).texts.map((t) => t.path).sort(), ['test/a.txt', 'test/zzz.txt']);
});

test('R6-F1: Solidity goes first among what the patch changed: a data file cannot crowd one out', () => {
  const data = entry('test/a.json', '', { status: 'M', bytes: BLOB, size: BLOB.length });
  const big = Buffer.alloc(1500000, 0x20);
  const sol = entry('test/z.sol', '', { status: 'M', bytes: big, size: big.length });
  assert.deepEqual(prepareTargets([data, sol]).texts.map((t) => t.path), ['test/z.sol']);
});

test('R6-F1: past the kept bound a flag is counted and never built: its message is not even asked for', () => {
  const kept = new KeptFlags();
  let asked = 0;
  for (let i = 1; i <= 200000; i += 1) {
    kept.add(READ, 'test/F.sol', i, false, () => { asked += 1; return 'm'; });
    assert.ok(kept.size <= 50);
  }
  assert.equal(asked, 50);
  const flags = kept.finish();
  assert.equal(flags.length, 50);
  assert.match(flags.find((f) => f.rule === STATED_ID('truncated')).message, /199951 more/);
});

test('R6-F1: the sink keeps what a whole sort would: any order in, the same 49 and note out, and the note\'s file is the first dropped', () => {
  const all = [];
  for (let i = 1; i <= 1000; i += 1) {
    const rule = [READ, STORE, ETCH, STATED_ID('not-scanned')][i % 4];
    all.push({ rule, file: `test/F${i % 11}.sol`, line: i % 3 ? i : null, added: i % 5 === 0 });
  }
  const seen = new Set();
  const unique = all.filter((f) => { const k = `${f.rule}|${f.file}|${f.line}`; if (seen.has(k)) return false; seen.add(k); return true; });
  const rank = (f) => (f.rule === STATED_ID('not-scanned') ? 0 : HONESTY_RULES[f.rule].severity === 'high' ? 1 : HONESTY_RULES[f.rule].severity === 'medium' ? 2 : 3);
  const text = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const line = (a, b) => (a === b ? 0 : a === null ? -1 : b === null ? 1 : a - b);
  const sorted = [...unique].sort((a, b) => rank(a) - rank(b) || Number(b.added) - Number(a.added) || text(a.file, b.file) || line(a.line, b.line) || text(a.rule, b.rule));
  const feed = (list) => {
    const kept = new KeptFlags();
    for (const f of list) kept.add(f.rule, f.file, f.line, f.added, 'm');
    return kept.finish();
  };
  const a = feed(unique);
  assert.deepEqual(a, feed([...unique].reverse()));
  assert.deepEqual(a, feed([...unique].sort((x, y) => sha256(`${x.rule}${x.file}${x.line}`).localeCompare(sha256(`${y.rule}${y.file}${y.line}`)))));
  const key = (f) => `${f.rule}|${f.file}|${f.line}`;
  const note = a.find((f) => f.rule === STATED_ID('truncated'));
  assert.deepEqual(a.filter((f) => f !== note).map(key).sort(), sorted.slice(0, 49).map(key).sort());
  assert.equal(note.file, sorted.slice(49).map((f) => f.file).sort(text)[0]);
  assert.match(note.message, new RegExp(`${sorted.length - 49} more`));
});

test('R6-F1: on a file no parser read, the patch\'s own lines are kept before the file\'s old ones', () => {
  const lines = Array.from({ length: 120 }, (_, i) => `vm.store(a, b, c); // ${i}`).join('\n');
  const added = new Set([100, 101]);
  const input = prepareTargets([entry('test/Big.txt', Buffer.concat([Buffer.from(`${lines}\n`), Buffer.alloc(SCAN_LIMITS.fileBytes, 0x20)]), { added })]);
  const flags = honestyFlags({ hits: [], partial: new Map(), unreadable: new Map(), capped: [], missing: [] }, input.targets, input.unscanned, readText(input.texts), input.texts);
  assert.equal(flags.length, 50);
  for (const l of added) assert.ok(flags.some((f) => f.line === l && f.rule === STATED_ID('unread-reach')), `the patch's line ${l} is kept`);
});

test('R6-F1: two results of a rule on one line are one flag, with the added words if the patch wrote either', () => {
  const t = targetsOf('test/E.sol');
  t[0].added = new Set([2]);
  const flags = honestyFlags(parsed(scanOf([hit(STORE, 'f0.sol', 1, 1), hit(STORE, 'f0.sol', 1, 2)]), t), t);
  assert.equal(flags.length, 1);
  assert.match(flags[0].message, /The patch added this line/);
});

test('R6-F1: through readChanged too: one cat-file of the shared blob, every path charged', async () => {
  const id = 'a'.repeat(40);
  const created = 'b'.repeat(40);
  const zero = '0'.repeat(40);
  const records = [];
  for (let i = 0; i < 25; i += 1) records.push(`:100644 100755 ${id} ${id} M\0test/p${String(i).padStart(2, '0')}.txt\0`);
  records.push(`:000000 100644 ${zero} ${created} A\0test/zzz-helper.txt\0`);
  const helper = Buffer.from('vm.store(a, b, c);\n');
  const asked = [];
  const ctx = {
    exec: async (argv, { tee, stdin }) => {
      if (argv.includes('--raw')) tee.write(Buffer.from(records.join(''), 'latin1'));
      else {
        asked.push(stdin.toString().trim().split('\n'));
        for (const want of asked[asked.length - 1]) {
          const bytes = want === id ? BLOB : helper;
          tee.write(Buffer.concat([Buffer.from(`${want} blob ${bytes.length}\n`), bytes, Buffer.from('\n')]));
        }
      }
      return { exitCode: 0 };
    }
  };
  const entries = await readChanged(ctx, { step: 's', from: 'c'.repeat(40), to: 'd'.repeat(40) });
  assert.deepEqual(asked, [[created, id]], 'what the patch created is asked for first, and the shared blob once');
  assert.equal(entries.filter((e) => e.modeOnly).length, 25);
  assert.equal(entries.find((e) => e.path === 'test/zzz-helper.txt').modeOnly, false);
  const { texts, unscanned } = prepareTargets(entries);
  assert.deepEqual(texts.map((t) => t.path), ['test/p00.txt', 'test/zzz-helper.txt']);
  assert.equal(unscanned.filter((u) => u.reason === 'unread').length, 24);
});

test('R6-F1: the worst case holds in a small heap, in the time the README says: what it holds follows the bound, not the input', () => {
  const script = path.join(__dirname, '..', 'helpers', 'scanWorst.js');
  const run = (heapMiB, ...args) => JSON.parse(execFileSync(process.execPath, [`--max-old-space-size=${heapMiB}`, script, ...args], { encoding: 'utf8', timeout: 60000 }));
  // 40 MiB could not hold these flags as objects: a flag is about 200 bytes, and there are hundreds of thousands.
  const flood = run(40, 'vm.store\n', '25');
  assert.equal(flood.read, 1);
  assert.equal(flood.stated, 25);
  assert.equal(flood.flags, 50);
  assert.ok(flood.textBytes <= TEXT_LIMITS.totalBytes);
  assert.ok(flood.notListed > 200000, JSON.stringify(flood));
  assert.ok(flood.blockedMs < 5000, JSON.stringify(flood));
  const dense = run(40, '.ffi\n', '25');
  assert.ok(dense.notListed > 400000, JSON.stringify(dense));
  assert.ok(dense.blockedMs < 5000, JSON.stringify(dense));
  // 33,000 paths, about what a patch of 2,000,000 bytes can name by mode changes, each a stated fact or read: 50 flags kept.
  const paths = run(40, '.ffi\n', '33000', '1024');
  assert.equal(paths.flags, 50);
  assert.ok(paths.read + paths.stated >= 33000, JSON.stringify(paths));
  assert.ok(paths.blockedMs < 5000, JSON.stringify(paths));
  // The same 33,000 sharing one 2 MB blob: a path past the budget costs a length, not a normal form of 2 MB (an instant to read, seconds to redo).
  const shared = run(64, '.ffi\r', '33000', '2000000');
  assert.equal(shared.read, 1);
  assert.ok(shared.blockedMs < 5000, JSON.stringify(shared));
  // The line map's worst shape, one line end a byte: the most it costs, and it is bounded too.
  const ends = run(128, '\r', '25');
  assert.equal(ends.read, 1);
  assert.ok(ends.blockedMs < 5000, JSON.stringify(ends));
});

test('the text rules take the same bytes twice and answer the same: their patterns hold no state between files', () => {
  const file = { path: 'p', bytes: Buffer.from('f(0x70ca10bb); g(0x70ca10bb);\n') };
  assert.deepEqual(readText([file, file]).hits.map((h) => h.lines), [[1], [1]]);
});

test('Semgrep\'s own memory bound on a file is a stated fact, measured, and the names on its lines stay flags', () => {
  const { targets, text } = withText(nine);
  const flags = honestyFlags(parsed(scanOf([], [{ type: 'Out of memory', level: 'warn', path: 'f0.sol', message: 'x' }]), targets), targets, [], text);
  assert.ok(flags.some((f) => f.rule === STATED_ID('unread-file') && /1024 MiB/.test(f.message)));
  assert.ok(flags.some((f) => f.rule === STATED_ID('unread-reach') && f.line === 2));
  assert.ok(semgrepArgv({ rules: 'honesty', targets: ['f0.sol'] }).join(' ').includes('--max-memory 1024'));
});

test('a data file that does not parse is not a scan that failed; a name in it still counts, and forge compiles an import of any name', () => {
  const data = entry('test/data.json', '{"a": 1}\n');
  const helper = entry('test/Helper.txt', 'contract H { function h() public { vm.store(a, b, c); } }\n', { added: new Set([1]) });
  const notes = entry('test/notes.md', 'then call vm.etch(a, b) here\n', { added: new Set([1]) });
  const sol = entry('test/E.sol', 'contract E {}\n');
  const input = prepareTargets([data, helper, notes, sol]);
  assert.deepEqual(input.targets.map((t) => [t.name, t.path]), [['f0.sol', 'test/E.sol'], ['f1.sol', 'test/Helper.txt'], ['f2.sol', 'test/data.json'], ['f3.sol', 'test/notes.md']], 'Solidity first: a large fixture cannot use up the budget before it');
  const errors = [{ type: 'Syntax error', level: 'warn', path: 'f2.sol' }, { type: 'Syntax error', level: 'warn', path: 'f3.sol' }];
  const scan = parsed(scanOf([hit(STORE, 'f1.sol', 1)], errors, ['f0.sol', 'f1.sol', 'f2.sol', 'f3.sol']), input.targets);
  const flags = honestyFlags(scan, input.targets, input.unscanned, readText(input.texts), input.texts);
  assert.deepEqual(flags.map((f) => [f.rule, f.file]).sort(), [[STORE, 'test/Helper.txt'], [STATED_ID('unread-reach'), 'test/notes.md']].sort());
});

test('R1-F1: past Semgrep\'s limit a file is stated whatever its name: forge compiles an import of any name, so padding a .txt hides nothing', () => {
  const big = Buffer.alloc(SCAN_LIMITS.fileBytes + 1, 0x20);
  const input = prepareTargets([
    entry('test/Helper.txt', '', { bytes: big, size: big.length }),
    entry('test/Big.sol', '', { bytes: big, size: big.length }),
    entry('test/huge.txt', '', { bytes: null, size: TEXT_LIMITS.fileBytes + 1 }),
    entry('test/link.txt', 'target', { mode: '120000' })
  ]);
  assert.deepEqual(input.targets, []);
  assert.deepEqual(input.unscanned, [
    { path: 'test/Big.sol', reason: 'too-large' }, { path: 'test/Helper.txt', reason: 'too-large' },
    { path: 'test/huge.txt', reason: 'unread' }, { path: 'test/link.txt', reason: 'not-a-file' }
  ]);
});

test('R1-F1: on what no parser read, a cheatcode\'s name counts by itself: a comment before its call, or a reference without one, hides nothing', () => {
  const padded = Buffer.concat([
    Buffer.from('vm.store /* c */ (a, b, c);\nx = vm.store;\nvm /* c */ . /* d */ etch(a, b);\ncheat.mockCall // c\n (a, b, c);\nabi.encodeCall(vm.ffi, (a));\n'),
    Buffer.alloc(SCAN_LIMITS.fileBytes, 0x20)
  ]);
  const input = prepareTargets([entry('test/Helper.txt', '', { bytes: padded, size: padded.length, added: new Set([1, 2, 3, 4, 5, 6]) })]);
  const flags = honestyFlags({ hits: [], partial: new Map(), unreadable: new Map(), capped: [], missing: [] }, input.targets, input.unscanned, readText(input.texts), input.texts);
  assert.deepEqual(flags.filter((f) => f.rule === STATED_ID('unread-reach')).map((f) => f.line).sort(), [1, 2, 3, 4, 6]);
  assert.ok(flags.some((f) => f.rule === STATED_ID('not-scanned') && f.file === 'test/Helper.txt'));
});

test('R1-F1: comments are read as solc reads them: a // in a string is no comment, whatever follows it', () => {
  const lines = (source) => readText([{ path: 'p', bytes: Buffer.from(source) }]).reach.get('p');
  assert.deepEqual(lines('string memory a = "//"; vm.store(x, y, z);\n'), [1]);
  assert.deepEqual(lines('string memory marker = "//"; vm. /*a*/ store /*b*/ (a, b, c);\n'), [1]);
  assert.deepEqual(lines("string memory m = '/*'; vm. /*a*/ etch /*b*/ (a, b); string memory n = '*/';\n"), [1]);
  assert.deepEqual(lines('string memory q = "\\"//"; vm. /*a*/ store(a, b, c);\n'), [1], 'an escaped quote does not end the string');
  assert.deepEqual(lines('// "\nvm. /*a*/ store(a, b, c);\n'), [2], 'a quote in a comment opens no string');
  assert.deepEqual(lines('/* " */ vm. /*a*/ store(a, b, c);\n'), [1]);
});

test('R1-F1: every name a rule reads has its fallback: a parse failure cannot hide one the rules would have flagged', () => {
  // By name from the rule file, so a new rule cannot forget it. warp and roll count only with their arguments, on code.
  const yaml = fs.readFileSync(path.join(RULES_DIR, RULE_FILES.honesty.file), 'utf8');
  const names = new Set();
  for (const line of yaml.split('\n')) {
    const m = /^\s+- pattern: (?:\$[A-Z]\.|vm\.|Vm\.)?([A-Za-z_]+)(?:\(\.\.\.\))?$/.exec(line);
    if (m) names.add(m[1]);
  }
  assert.ok(names.size > 40, String(names.size));
  for (const name of names) {
    const { reach } = readText([{ path: 'p', bytes: Buffer.from(`vm.${name}(a);\n`) }]);
    assert.deepEqual(reach.get('p'), [1], name);
  }
});

test('R1-F1: names common on contracts count on vm alone, as the rules read them, however it is parenthesised', () => {
  const lines = (source) => readText([{ path: 'p', bytes: Buffer.from(source) }]).reach.get('p');
  for (const name of ['exists', 'isFile', 'isDir', 'sleep', 'fee', 'chainId', 'coinbase', 'setNonce', 'setEnv']) {
    assert.deepEqual(lines(`vm . /*a*/ ${name} (a);\n`), [1], name);
    assert.deepEqual(lines(`(vm).${name}(a);\n`), [1], `(vm).${name}`);
    assert.deepEqual(lines(`((vm)) . ${name}(a);\n`), [1], `((vm)).${name}`);
    assert.equal(lines(`registry.${name}(a);\n`), undefined, name);
  }
});

test('R1-F1: the clock, on what no parser read: vm\'s warp and roll count whatever the argument, since their argument cannot be judged there; another receiver\'s by the rules\' arguments', () => {
  const lines = (source) => readText([{ path: 'p', bytes: Buffer.from(source) }]).reach.get('p');
  for (const source of ['vm.warp(0);', '(vm).warp(0);', 'vm.warp(block.timestamp - 1);', 'vm.roll(0);', 'vm . /*a*/ roll(type(uint256).max);']) {
    assert.deepEqual(lines(`${source}\n`), [1], source);
  }
  for (const source of ['cheat.warp(0);', 'cheat.warp(type(uint64).max);', 'cheat . warp ( block . timestamp - 1 );', 'cheat.roll(0);', 'cheat.roll(block.number - 1);']) {
    assert.deepEqual(lines(`${source}\n`), [1], source);
  }
  for (const source of ['vault.warp(1);', 'vault.roll(1);', 'cheat.warp(block.timestamp + 1);']) {
    assert.equal(lines(`${source}\n`), undefined, source);
  }
});

test('ordinary words on a line nobody parsed are not a cheatcode: a name needs its call or its member access', () => {
  const { reach } = readText([{ path: 'p', bytes: Buffer.from('{"store": 1, "etch": "the rpc value"}\nwe store it and read files\n') }]);
  assert.equal(reach.get('p'), undefined);
});

test('R2-F1: only a parse failure is silent on another name: a memory bound, a cap or a file not reported read is stated by any name', () => {
  const t = [{ name: 'f0.sol', path: 'test/Helper.txt', lineOf: (l) => l, added: new Set(), solidity: false }];
  const flagsOn = (errors, scanned = ['f0.sol']) => honestyFlags(parsed(scanOf([], errors, scanned), t), t).map((f) => f.rule);
  assert.deepEqual(flagsOn([{ type: 'Syntax error', level: 'warn', path: 'f0.sol' }]), []);
  assert.deepEqual(flagsOn([{ type: ['PartialParsing', [{ start: { line: 1 }, end: { line: 1 } }]], level: 'warn', path: 'f0.sol' }]), []);
  assert.deepEqual(flagsOn([{ type: 'Out of memory', level: 'warn', path: 'f0.sol' }]), [STATED_ID('unread-file')]);
  assert.deepEqual(flagsOn([{ type: 'Too many matches', level: 'warn', path: 'f0.sol', rule_id: ETCH }]).sort(), [ETCH, STATED_ID('unread-file')].sort());
  assert.deepEqual(flagsOn([], []), [STATED_ID('not-scanned')]);
  const fixed = (errors, scanned = ['f0.sol']) => fixFindings(parseScan({ stdout: scanOf([], errors, scanned), exitCode: 0, truncated: false }, t, { table: FIX_RULES }), t).map((f) => f.rule);
  assert.deepEqual(fixed([{ type: 'Syntax error', level: 'warn', path: 'f0.sol' }]), []);
  assert.deepEqual(fixed([{ type: 'Out of memory', level: 'warn', path: 'f0.sol' }]), ['verdikta.scan.unread-file']);
  assert.deepEqual(fixed([], []), ['verdikta.scan.not-scanned']);
});

test('a file the tool does not say it read is stated: a clean answer about nothing is not a clean answer', () => {
  const t = targetsOf('test/A.sol', 'test/B.sol');
  const flags = honestyFlags(parsed(scanOf([], [], ['f0.sol']), t), t);
  assert.deepEqual(flags.map((f) => [f.rule, f.file]), [[STATED_ID('not-scanned'), 'test/B.sol']]);
});

test('a file past a limit is a stated flag with its reason, and the flags of the rest stand', () => {
  const t = targetsOf('test/A.sol');
  const flags = honestyFlags(parsed(scanOf([hit(STORE)]), t), t, [{ path: 'test/Big.sol', reason: 'too-large' }, { path: 'test/L.sol', reason: 'not-a-file' }]);
  assert.deepEqual(flags.map((f) => [f.rule, f.file]).sort(), [[STORE, 'test/A.sol'], [STATED_ID('not-scanned'), 'test/Big.sol'], [STATED_ID('not-scanned'), 'test/L.sol']].sort());
  assert.match(flags.find((f) => f.file === 'test/Big.sol').message, new RegExp(String(SCAN_LIMITS.fileBytes)));
  assert.match(flags.find((f) => f.file === 'test/L.sol').message, /not a regular file/);
});

test('a line past the report\'s bound is file-level: nothing a hunter writes can make a report invalid', () => {
  const t = [{ name: 'f0.sol', path: 'test/E.sol', lineOf: () => 10000001, added: new Set() }];
  const flags = honestyFlags(parsed(scanOf([hit(STORE)]), t), t);
  assert.equal(flags[0].line, null);
});

test('a line is git\'s: the normal form\'s line map carries a flag back', () => {
  const n = normaliseSource(Buffer.from('// x\u2028vm.store(a, b, c);\nnext();\n'));
  const t = [{ name: 'f0.sol', path: 'test/E.sol', lineOf: n.lineOf, added: new Set([1]) }];
  assert.equal(honestyFlags(parsed(scanOf([hit(STORE, 'f0.sol', 2)]), t), t)[0].line, 1);
});

test('a flag says whether the patch added its lines: a maker\'s line in a changed file is not put on the hunter', () => {
  const t = [{ name: 'f0.sol', path: 'test/E.sol', lineOf: (l) => l, added: new Set([3]) }];
  const flags = honestyFlags(parsed(scanOf([hit(STORE, 'f0.sol', 3), hit(ETCH, 'f0.sol', 9), hit(READ, 'f0.sol', 2, 3)]), t), t);
  const by = Object.fromEntries(flags.map((f) => [f.rule, f.message]));
  assert.match(by[STORE], /The patch added/);
  assert.match(by[ETCH], /already in the listed file/);
  assert.match(by[READ], /The patch added/, 'a match that spans a line the patch added');
});

test('the same match twice is one flag, and two rules on a line stay two', () => {
  const t = targetsOf('test/E.sol');
  const flags = honestyFlags(parsed(scanOf([hit(STORE), hit(STORE), hit(ETCH)]), t), t);
  assert.deepEqual(flags.map((f) => f.rule).sort(), [ETCH, STORE].sort());
});

// ------------------------------------------------------------------ the bound

const flagOf = (rule, file, line) => ({ rule, file, line, message: 'm' });
function boundFlags(flags) {
  const kept = new KeptFlags();
  for (const f of flags) kept.add(f.rule, f.file, f.line, false, f.message);
  return kept.finish();
}

test('under the bound everything stays', () => {
  const all = [];
  for (let i = 1; i <= 50; i += 1) all.push(flagOf(READ, 'test/E.sol', i));
  assert.deepEqual(boundFlags(all).length, 50);
  assert.ok(!boundFlags(all).some((f) => f.rule === STATED_ID('truncated')));
});

test('past the bound the kept 50 go by rule severity, and the rest are counted by rule in a note with a fixed id', () => {
  const all = [];
  for (let i = 1; i <= 60; i += 1) all.push(flagOf(READ, 'test/A.sol', i));
  all.push(flagOf(STORE, 'test/Z.sol', 99));
  all.push(flagOf('verdikta.honesty.clock', 'test/Z.sol', 98));
  const kept = boundFlags(all);
  assert.equal(kept.length, 50);
  assert.ok(kept.some((f) => f.rule === STORE), 'the high one is kept, though its file sorts last');
  assert.ok(kept.some((f) => f.rule === 'verdikta.honesty.clock'));
  const note = kept.find((f) => f.rule === STATED_ID('truncated'));
  assert.ok(note);
  assert.match(note.message, /13 more/);
  assert.match(note.message, new RegExp(`${READ.replace(/\./g, '\\.')}: 13`));
});

test('padding cannot hide a rule: a stated fact outranks every rule, and a dropped rule is named in the note', () => {
  const all = [];
  for (let i = 1; i <= 80; i += 1) all.push(flagOf(STORE, 'test/Pad.sol', i));
  all.push(flagOf(ETCH, 'test/Pad.sol', 200));
  all.push(flagOf(READ, 'test/Real.sol', 1));
  all.push({ rule: STATED_ID('unread-file'), file: 'test/Hide.sol', line: null, message: 'm' });
  const kept = boundFlags(all);
  assert.ok(kept.some((f) => f.rule === STATED_ID('unread-file')));
  const note = kept.find((f) => f.rule === STATED_ID('truncated'));
  assert.match(note.message, /filesystem-read: 1/, 'the low rule that fell off is still named');
});

test('the bound is a function of the flags: any order in, the same kept set in common\'s canonical order out', () => {
  const all = [];
  for (let i = 1; i <= 70; i += 1) all.push(flagOf(i % 3 ? READ : STORE, `test/F${i % 7}.sol`, i));
  const a = boundFlags(all);
  const b = boundFlags([...all].reverse());
  assert.deepEqual(a, b);
  const canon = [...a].sort((x, y) => (x.file < y.file ? -1 : x.file > y.file ? 1 : (x.line ?? 0) - (y.line ?? 0) || (x.rule < y.rule ? -1 : 1)));
  assert.deepEqual(a, canon);
});

// ------------------------------------------------------------------ fix-mode findings

test('a fix\'s findings carry the rule\'s own severity and text, with triage null', () => {
  const t = targetsOf('src/Vault.sol');
  const rule = 'verdikta.solidity.selfdestruct';
  const findings = fixFindings(parseScan({ stdout: scanOf([hit(rule)]), exitCode: 0, truncated: false }, t, { table: FIX_RULES }), t);
  assert.deepEqual(findings, [{ tool: 'semgrep', rule, severity: FIX_RULES[rule].severity, file: 'src/Vault.sol', line: 3, message: FIX_RULES[rule].message, triage: null }]);
});

test('a fixed file the scan could not read is a stated finding, not a clean one', () => {
  const t = targetsOf('src/Vault.sol');
  const findings = fixFindings(parseScan({ stdout: scanOf([], [{ type: 'Syntax error', level: 'warn', path: 'f0.sol' }]), exitCode: 0, truncated: false }, t, { table: FIX_RULES }), t, [{ path: 'src/Big.sol', reason: 'too-large' }]);
  assert.deepEqual(findings.map((f) => [f.tool, f.rule, f.file]).sort(), [['semgrep', 'verdikta.scan.not-scanned', 'src/Big.sol'], ['semgrep', 'verdikta.scan.unread-file', 'src/Vault.sol']].sort());
});

test('findings past the bound keep the most severe, with a note, and any order in gives the same list', () => {
  const all = [];
  for (let i = 1; i <= 70; i += 1) all.push({ tool: 'semgrep', rule: 'verdikta.solidity.selfdestruct', severity: 'medium', file: 'src/A.sol', line: i, message: 'm', triage: null });
  all.push({ tool: 'semgrep', rule: 'verdikta.solidity.tx-origin-auth', severity: 'high', file: 'src/Z.sol', line: 1, message: 'm', triage: null });
  const kept = boundFindings(all);
  assert.equal(kept.length, 50);
  assert.ok(kept.some((f) => f.severity === 'high'));
  const note = kept.find((f) => f.rule === 'verdikta.scan.truncated');
  assert.ok(note);
  assert.match(note.message, /22 more/);
  assert.deepEqual(kept, boundFindings([...all].reverse()));
});

test('R2-F2: what qualifies the findings outlives the bound: a stated fact is kept whatever its severity', () => {
  const all = [];
  for (let i = 1; i <= 70; i += 1) all.push({ tool: 'semgrep', rule: 'verdikta.solidity.selfdestruct', severity: 'high', file: 'src/A.sol', line: i, message: 'm', triage: null });
  all.push({ tool: 'semgrep', rule: 'verdikta.scan.no-baseline', severity: 'medium', file: 'src/Z.sol', line: null, message: 'm', triage: null });
  all.push({ tool: 'semgrep', rule: 'verdikta.scan.unread-file', severity: 'medium', file: 'src/Y.sol', line: null, message: 'm', triage: null });
  const kept = boundFindings(all);
  assert.equal(kept.length, 50);
  assert.ok(kept.some((f) => f.rule === 'verdikta.scan.no-baseline'));
  assert.ok(kept.some((f) => f.rule === 'verdikta.scan.unread-file'));
  const sev = kept.filter((f) => f.rule !== 'verdikta.scan.truncated').map((f) => f.severity);
  assert.deepEqual(sev, [...sev].sort((a, b) => ['critical', 'high', 'medium', 'low', 'info'].indexOf(a) - ['critical', 'high', 'medium', 'low', 'info'].indexOf(b)), 'common\'s order');
});

// ------------------------------------------------------------------ the image

test('the image is measured: its digest and platform, or why not', async () => {
  const line = (digests, os, arch) => `${[JSON.stringify('sha256:aa'), '[]', JSON.stringify(digests), JSON.stringify(os), JSON.stringify(arch), 'null', '1000'].join('\t')}\n`;
  const docker = (stdout, exitCode = 0, stderr = '') => fakeDocker(healthyDaemon({ image: () => ({ exitCode, stdout, stderr }) }));
  const ok = await imageStatus({ docker: docker(line([`semgrep/semgrep@${SEMGREP.indexDigest}`], 'linux', 'amd64')), platform: 'linux/amd64' });
  assert.deepEqual({ present: ok.present, problem: ok.problem, digest: ok.digest, platform: ok.platform }, { present: true, problem: null, digest: SEMGREP.indexDigest, platform: 'linux/amd64' });
  const other = await imageStatus({ docker: docker(line(['semgrep/semgrep@sha256:bb'], 'linux', 'amd64')), platform: 'linux/amd64' });
  assert.match(other.problem, /does not carry/);
  const arch = await imageStatus({ docker: docker(line([`semgrep/semgrep@${SEMGREP.indexDigest}`], 'linux', 'arm64')), platform: 'linux/amd64' });
  assert.match(arch.problem, /linux\/arm64/);
  const none = await imageStatus({ docker: docker('', 1, 'Error response from daemon: No such image: x'), platform: 'linux/amd64' });
  assert.equal(none.present, false);
  assert.match(none.problem, /not on this host/);
  const noDaemon = await imageStatus({ docker: docker('', 1, 'Cannot connect to the Docker daemon at unix:///x'), platform: 'linux/amd64' });
  assert.match(noDaemon.problem, /could not be reached/);
});

test('R1-F2: a fix\'s lint reads every file it changed as Solidity, since forge compiles an import of any name, with the listed bytes for the baseline', () => {
  const r = prepareFix([
    entry('docs/README.md', 'text'),
    entry('src/Helper.txt', 'contract H {}\n'),
    entry('src/New.sol', 'contract N {}\n', { oldBytes: null }),
    entry('src/Vault.sol', '// a\u2028b\n', { status: 'M', oldBytes: Buffer.from('// c\u2028d\n') }),
    entry('src/Gone.sol', '', { status: 'D', bytes: null, size: 0 })
  ]);
  assert.deepEqual(r.targets.map((t) => t.path), ['src/New.sol', 'src/Vault.sol', 'docs/README.md', 'src/Helper.txt']);
  assert.deepEqual([...r.oldBytes.keys()], ['src/Vault.sol']);
  assert.equal(r.oldBytes.get('src/Vault.sol').toString('utf8'), '// c\nd\n');
});

test('R1-F3: the listed bytes are held to the same limits: a large preimage is not scanned, and the fix\'s findings say they are not told apart from it', () => {
  const big = Buffer.alloc(SCAN_LIMITS.fileBytes + 1, 0x20);
  const half = Buffer.alloc(SCAN_LIMITS.totalBytes / 2 + 10, 0x20);
  const r = prepareFix([
    entry('src/Shrunk.sol', 'contract S {}\n', { status: 'M', oldBytes: big }),
    entry('src/Huge.sol', 'contract H {}\n', { status: 'M', oldBytes: null, oldTooLarge: true }),
    entry('src/A.sol', 'contract A {}\n', { status: 'M', oldBytes: half }),
    entry('src/B.sol', 'contract B {}\n', { status: 'M', oldBytes: half })
  ]);
  assert.deepEqual(r.targets.map((t) => t.path), ['src/A.sol', 'src/B.sol', 'src/Huge.sol', 'src/Shrunk.sol']);
  assert.deepEqual([...r.oldBytes.keys()], ['src/A.sol'], 'within the file limit and the total, in the targets\' order');
  assert.deepEqual(r.noBaseline, ['src/B.sol', 'src/Huge.sol', 'src/Shrunk.sol']);
  const total = [...r.oldBytes.values()].reduce((n, b) => n + b.length, 0);
  assert.ok(total <= SCAN_LIMITS.totalBytes);
});

test('the scanner\'s memory is a fixed bound, inside the class\'s, whatever the listing asks of its own sandboxes', () => {
  const { CLASS_HARD_LIMITS } = require('../../src/common');
  assert.ok(Number.isInteger(SCAN_MEMORY_MB) && SCAN_MEMORY_MB >= 256 && SCAN_MEMORY_MB <= CLASS_HARD_LIMITS.memoryMb);
});
