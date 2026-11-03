'use strict';

// Node A3c against the real tools: the pinned Semgrep image under the runner's
// own sandbox flags, and real forge for the claims. Every rule has its positive
// and its negative in test/fixtures/honesty/; a line marked `flag:` must raise
// exactly those rules, and no other line may raise any. Under runc locally
// (linux/arm64 on Apple silicon, the same index digest); CI runs this file under
// runc and under the pinned gVisor on amd64.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { codeReview } = require('@verdikta/common');
const { executeRun } = require('../../src/pipeline');
const { checkSpec } = require('../../src/classLimits');
const { claimSteps } = require('../../src/steps');
const { buildReport } = require('../../src/report');
const scanner = require('../../src/scanner');
const {
  RUNTIME, TEST_IMAGE, silent, dockerTestConfig, dockerFor, ensureImage, ensureTestImage, leftovers, removeAll, smallLimits
} = require('./helpers');
const { VAULT_REPO, VM_SOL, vaultBaseline, buildFixture, addFilesPatch, modifyPatch, pocFile } = require('./forgeFixture');

const { SEMGREP, SCAN_LIMITS, SCAN_TIMEOUT_MS, prepareTargets, prepareFix, scanPoc, scanFix, openScanner, boundFindings } = scanner;
const TIMEOUT = 900000;
const FIXTURES = path.join(__dirname, '..', 'fixtures', 'honesty');
const ID = (name) => `verdikta.honesty.${name}`;

const entry = (p, text, over = {}) => {
  const bytes = Buffer.isBuffer(text) ? text : Buffer.from(text);
  const added = new Set(bytes.toString('utf8').split('\n').map((_, i) => i + 1));
  return { path: p, mode: '100644', status: 'A', bytes, size: bytes.length, added, ...over };
};

/** Run `fn(handle)` in the scanner's sandbox, as a claim's scan does, and hand back what it answered. */
async function inScanner(t, fn) {
  const config = dockerTestConfig();
  const docker = dockerFor(config);
  t.after(() => removeAll(docker, config.instance).catch(() => {}));
  await ensureTestImage(docker);
  await ensureImage(docker, SEMGREP.reference);
  let answer;
  const receivedAt = Date.now();
  const result = await executeRun({
    docker, config, limits: smallLimits({ memoryMb: 512, runSeconds: 120, testSeconds: 120 }), image: TEST_IMAGE, runId: crypto.randomBytes(8).toString('hex'),
    steps: [async (ctx) => {
      await ctx.closeSandbox();
      answer = await fn(await openScanner(ctx), ctx);
    }],
    receivedAt, deadlineAt: receivedAt + TIMEOUT, active: new Set(), log: silent
  });
  assert.equal(result.outcome, 'definitive', JSON.stringify({ abstain: result.abstain, issues: result.issues }));
  assert.deepEqual(await leftovers(docker, config.instance), [], 'the run removed its sandboxes');
  return { answer, result };
}

const flagsOf = (t, entries) => inScanner(t, (handle) => scanPoc(handle, prepareTargets(entries))).then((r) => r.answer);
const summary = (flags) => flags.map((f) => `${f.rule.replace('verdikta.honesty.', '')}@${f.file}:${f.line}`).sort();

/** The lines of a fixture marked `flag: a b` (or `flag@-1:`, for the line above), as rule@line. */
function expectedOf(file, source) {
  const out = [];
  source.split('\n').forEach((line, i) => {
    const m = /\/\/ flag(@-1)?: (.*)$/.exec(line);
    if (!m) return;
    for (const rule of m[2].trim().split(/\s+/)) out.push(`${rule}@${file}:${m[1] ? i : i + 1}`);
  });
  return out.sort();
}

// ------------------------------------------------------- per rule: the positives and the negatives

test('every rule raises on its positives, on exactly those lines, under the real engine', { timeout: TIMEOUT }, async (t) => {
  const source = fs.readFileSync(path.join(FIXTURES, 'positive.sol'), 'utf8');
  // More flags than the report keeps: read the rules' own answer, unbounded.
  const { answer } = await inScanner(t, async (handle) => {
    const input = prepareTargets([entry('test/positive.sol', source)]);
    const { targets, texts } = input;
    await handle.exec(['/bin/tar', '-xf', '-', '-C', '/work'], {
      name: 'unpack', timeoutMs: 30000, workdir: '/work',
      stdin: scanner.scanTar([{ name: 'rules/honesty.yml', bytes: scanner.ruleBytes('honesty') }, ...targets.map((x) => ({ name: `src/${x.name}`, bytes: x.bytes }))])
    });
    const r = await handle.exec(scanner.semgrepArgv({ rules: 'honesty', targets: targets.map((x) => x.name) }), { name: 'scan', timeoutMs: SCAN_TIMEOUT_MS, workdir: '/work/src' });
    const out = await handle.readFile('/work/poc.json', { maxBytes: scanner.OUTPUT_MAX_BYTES, name: 'answer', timeoutMs: 30000 });
    const scan = scanner.parseScan({ stdout: out.bytes, exitCode: r.exitCode, truncated: out.overLimit }, targets, { table: scanner.HONESTY_RULES });
    return scanner.honestyFlags(scan, targets, [], scanner.readText(texts), texts);
  });
  assert.deepEqual(summary(answer), expectedOf('test/positive.sol', source));
});

test('no false positive on the ordinary idioms of a Foundry test: vm.warp forward, vm.prank, deal and the rest', { timeout: TIMEOUT }, async (t) => {
  const source = fs.readFileSync(path.join(FIXTURES, 'idioms.sol'), 'utf8');
  assert.match(source, /vm\.warp\(block\.timestamp \+ 1 days\)/);
  assert.match(source, /vm\.prank\(address\(1\)\)/);
  assert.match(source, /deal\(address\(this\), 1 ether\)/);
  assert.deepEqual(await flagsOf(t, [entry('test/idioms.sol', source)]), []);
});

test('no false positive across the fixture repository\'s tests', { timeout: TIMEOUT }, async (t) => {
  const files = Object.entries(VAULT_REPO).filter(([p]) => p.endsWith('.sol')).map(([p, text]) => entry(p, text));
  assert.ok(files.some((f) => f.path === 'test/Vm.sol') && files.some((f) => f.path === 'test/Vault.t.sol'));
  assert.deepEqual(await flagsOf(t, files), []);
});

// ------------------------------------------------------- attack: a hunter's configuration has no effect

const EXPLOIT = [
  'pragma solidity ^0.8.20;',
  'contract E { function t() public {',
  '  vm.store(address(1), bytes32(0), bytes32(0)); // nosemgrep',
  '  vm.etch(address(1), hex"00"); // nosem: verdikta.honesty.code-overwrite',
  '} }',
  ''
].join('\n');
const WANT = ['code-overwrite@test/Exploit.t.sol:4', 'storage-overwrite@test/Exploit.t.sol:3'];

test('a .semgrepignore, a .semgrep.yml, a .gitignore and inline nosem comments in a hunter\'s patch change nothing', { timeout: TIMEOUT }, async (t) => {
  const planted = 'rules:\n  - {id: hunter.planted, languages: [solidity], severity: ERROR, message: m, pattern: vm.warp(...)}\n';
  const flags = await flagsOf(t, [
    entry('test/Exploit.t.sol', EXPLOIT),
    entry('test/.semgrepignore', '*\n'),
    entry('.semgrepignore', '*\n'),
    entry('.semgrep.yml', planted),
    entry('.semgrep.yaml', planted),
    entry('.semgrep/rule.yml', planted),
    entry('test/.gitignore', '*\n'),
    entry('.gitignore', 'test/\n'),
    entry('.semgrepconfig', 'x\n')
  ]);
  assert.deepEqual(summary(flags), WANT, 'no rule of the hunter\'s runs, and its files raise nothing of their own');
});

test('on the same bytes with and without a hunter\'s configuration, the flags on the test are the same', { timeout: TIMEOUT }, async (t) => {
  const plain = await flagsOf(t, [entry('test/Exploit.t.sol', EXPLOIT)]);
  assert.deepEqual(summary(plain), WANT);
});

test('a test under test/, vendor/ or node_modules/ is read: Semgrep\'s own ignore list reads no path of the runner\'s', { timeout: TIMEOUT }, async (t) => {
  const flags = await flagsOf(t, [
    entry('test/A.t.sol', EXPLOIT), entry('vendor/B.t.sol', EXPLOIT), entry('node_modules/C.t.sol', EXPLOIT), entry('tests/D.t.sol', EXPLOIT)
  ]);
  for (const f of ['test/A.t.sol', 'vendor/B.t.sol', 'node_modules/C.t.sol', 'tests/D.t.sol']) {
    assert.ok(flags.some((x) => x.file === f && x.rule === ID('storage-overwrite')), f);
  }
});

// ------------------------------------------------------- attack: a missed flag

test('solc\'s line ends: code after a CR in a comment is flagged, on git\'s line', { timeout: TIMEOUT }, async (t) => {
  const source = 'pragma solidity ^0.8.20;\ncontract E { function t() public {\n// harmless\rvm.store(a, b, c);\n} }\n';
  assert.deepEqual(summary(await flagsOf(t, [entry('test/E.sol', source)])), ['storage-overwrite@test/E.sol:3']);
});

test('tricks around comments and strings do not hide a call', { timeout: TIMEOUT }, async (t) => {
  const source = [
    'pragma solidity ^0.8.20;',
    'contract E { function t() public {',
    '  string memory a = "//"; vm.etch(address(1), hex"00");', // flag at 3
    '  /* /* */ vm.etch(address(2), hex"00");', // flag at 4
    '  /*/ x /*/ vm.etch(address(3), hex"00");', // flag at 5
    '  string memory b = \'/*\'; vm.etch(address(4), hex"00"); string memory c = \'*/\';', // flag at 6
    '  bytes memory d = hex"00"; vm.etch(address(5), d);', // flag at 7
    '  string memory e = unicode"é //"; vm.etch(address(6), hex"00");', // flag at 8
    '  unchecked { if (true) { for (;;) { vm.etch(address(7), hex"00"); } } }', // flag at 9
    '  (bool ok, ) = true ? (true, hex"") : (vm.etch(address(8), hex"00"), hex"");', // flag at 10
    '} }',
    ''
  ].join('\n');
  const flags = await flagsOf(t, [entry('test/E.sol', source)]);
  const lines = flags.filter((f) => f.rule === ID('code-overwrite')).map((f) => f.line).sort((a, b) => a - b);
  assert.deepEqual(lines, [3, 4, 5, 6, 7, 8, 9, 10], JSON.stringify(flags));
});

test('a byte that is not UTF-8 and a NUL neither stop the rules that read code nor the ones that read text', { timeout: TIMEOUT }, async (t) => {
  const source = Buffer.concat([
    Buffer.from('pragma solidity ^0.8.20;\ncontract E { function t() public {\n  vm.etch(a, b); // '),
    Buffer.from([0xff, 0xfe]),
    Buffer.from('\n  target.call(abi.encodeWithSelector(0x70ca10bb));\n} }\n')
  ]);
  assert.deepEqual(summary(await flagsOf(t, [entry('test/E.sol', source)])), ['cheatcode-signature@test/E.sol:4', 'code-overwrite@test/E.sol:3']);
});

test('Solidity under another name is read as Solidity: forge compiles an import of any name', { timeout: TIMEOUT }, async (t) => {
  const flags = await flagsOf(t, [entry('test/Helper.txt', EXPLOIT)]);
  assert.deepEqual(summary(flags), ['code-overwrite@test/Helper.txt:4', 'storage-overwrite@test/Helper.txt:3']);
});

test('a JSON fixture is no flag: it does not parse by design', { timeout: TIMEOUT }, async (t) => {
  assert.deepEqual(await flagsOf(t, [entry('test/fixture.json', '{"a": [1, 2, {"b": null}]}\n'), entry('test/E.sol', 'contract E {}\n')]), []);
});

// ------------------------------------------------------- attack: a scan that could not finish never reads as no flags

test('a parse failure is stated and the cheatcode names in the file stay flags', { timeout: TIMEOUT }, async (t) => {
  const source = 'pragma solidity ^0.8.20;\ncontract E { function t() public {\n  @@@ vm.etch(a, b); $$$ x.store(a, b, c); @@@\n} }\n';
  const flags = await flagsOf(t, [entry('test/E.sol', source)]);
  assert.ok(flags.some((f) => f.rule === ID('unread-part') || f.rule === ID('unread-file')), JSON.stringify(flags));
  assert.ok(flags.some((f) => f.rule === ID('code-overwrite') || f.rule === ID('unread-reach')), JSON.stringify(flags));
});

test('a file nothing can parse is stated; its names are flags; the file beside it stands', { timeout: TIMEOUT }, async (t) => {
  const flags = await flagsOf(t, [entry('test/A.sol', '{{{{ @@@@ vm.store(a, b, c);\n%%%% \'\n'), entry('test/B.sol', EXPLOIT)]);
  assert.ok(flags.some((f) => f.file === 'test/A.sol' && /unread-(?:file|part)/.test(f.rule)), JSON.stringify(flags));
  assert.ok(flags.some((f) => f.file === 'test/A.sol' && f.rule === ID('unread-reach')), JSON.stringify(flags));
  assert.ok(flags.some((f) => f.file === 'test/B.sol' && f.rule === ID('storage-overwrite')));
});

test('padding past Semgrep\'s match cap erases nothing: every result of that file is gone, and the file says so, names and all', { timeout: TIMEOUT }, async (t) => {
  // 10,001 matches of one rule within the file limit: Semgrep drops every result of the file, with exit 0.
  const padded = `pragma solidity ^0.8.20;\ncontract E { function t() public {\nx.etch(a, b);\nvm.ffi(c);\n${'a.etch.etch;'.repeat(2)}\nz = a${'.etch'.repeat(10500)};\n} }\n`;
  assert.ok(padded.length <= SCAN_LIMITS.fileBytes, String(padded.length));
  const flags = await flagsOf(t, [entry('test/Pad.sol', padded), entry('test/B.sol', EXPLOIT)]);
  assert.ok(flags.some((f) => f.file === 'test/Pad.sol' && f.rule === ID('unread-file')), JSON.stringify(summary(flags)));
  assert.ok(flags.some((f) => f.file === 'test/Pad.sol' && f.rule === ID('code-overwrite') && f.line === null));
  assert.ok(flags.some((f) => f.file === 'test/Pad.sol' && f.rule === ID('unread-reach') && f.line === 4), 'vm.ffi, by its name');
  assert.ok(flags.some((f) => f.file === 'test/B.sol' && f.rule === ID('storage-overwrite')), 'a cap stays within its file');
});

test('a comment full of cheatcode names cannot reach any cap: the rules that read text are not in Semgrep', { timeout: TIMEOUT }, async (t) => {
  const source = `pragma solidity ^0.8.20;\ncontract E { function t() public {\nvm.etch(a, b);\n// ${'store( '.repeat(9000)}\n} }\n`;
  assert.ok(source.length <= SCAN_LIMITS.fileBytes);
  assert.deepEqual(summary(await flagsOf(t, [entry('test/E.sol', source)])), ['code-overwrite@test/E.sol:3']);
});

test('the limits hold on the worst shapes measured: each answers before the step\'s timer, the honest rule still found or the file stated', { timeout: TIMEOUT }, async (t) => {
  const fill = (u, n) => u.repeat(Math.ceil(n / u.length)).slice(0, n);
  const room = SCAN_LIMITS.fileBytes - 200;
  const head = 'pragma solidity ^0.8.20;\ncontract E { function t() public {\nvm.etch(a, b);\n';
  const tail = '\n} }\n';
  const shapes = {
    'a long member chain': `z = a${fill('.etch', room)};`,
    'a long sum': `x = ${fill('a+', room)}a;`,
    'many matches': fill('a.etch;\n', room),
    'nested parentheses': `${fill('(', room / 2)}1${fill(')', room / 2)};`,
    'a long ternary': `x = ${fill('a?b:', room)}c;`,
    'an else-if ladder': `${fill('if(a){}else ', room)}{}`
  };
  // 'many matches' is also the regression for gVisor: its answer of some 2.7 MB is cut at 64 KiB on stdout, with exit 0.
  for (const [name, body] of Object.entries(shapes)) {
    const t0 = Date.now();
    const flags = await flagsOf(t, [entry('test/E.sol', head + body + tail)]);
    t.diagnostic(`${name}: ${Date.now() - t0} ms under ${RUNTIME}`);
    assert.ok(flags.length > 0, name);
    assert.ok(flags.some((f) => f.line === 3 || f.rule === ID('unread-file') || f.rule === ID('truncated')), `${name}: ${JSON.stringify(summary(flags)).slice(0, 300)}`);
    assert.ok(Date.now() - t0 < SCAN_TIMEOUT_MS, `${name} took ${Date.now() - t0} ms`);
  }
});

// ------------------------------------------------------- the sandbox's isolation, on the real runtime

test('Semgrep\'s sandbox: uid 10001, no capability, no network, a read-only root, nothing of the host', { timeout: TIMEOUT }, async (t) => {
  const script = [
    'id -u',
    'grep -E "^Cap(Eff|Prm):" /proc/self/status',
    'touch /x 2>/dev/null && echo root-writable || echo root-read-only',
    'touch /usr/bin/x 2>/dev/null && echo usr-writable || echo usr-read-only',
    'touch /src/x 2>/dev/null && echo src-writable || echo src-read-only',
    'touch /work/x && echo work-writable',
    'python3 -c "import socket;s=socket.socket();s.settimeout(3);s.connect((\'1.1.1.1\',443))" 2>/dev/null && echo network || echo no-network',
    'ls /sys/class/net 2>/dev/null | grep -v "^lo$" | wc -l',
    'mount | grep -cE " (/var/run/docker.sock|/host|/repo) " || true'
  ].join('\n');
  const { answer } = await inScanner(t, async (handle) => {
    const out = new (require('../../src/capture').Prefix)(4096);
    await handle.exec(['/bin/sh', '-c', script, 'vcr-isolation'], { name: 'isolation', timeoutMs: 30000, workdir: '/work', tee: out });
    return out.bytes().toString('utf8');
  });
  const lines = answer.split('\n');
  assert.equal(lines[0], '10001');
  assert.ok(/CapEff:\s+0+$/m.test(answer), answer);
  for (const want of ['root-read-only', 'usr-read-only', 'src-read-only', 'work-writable', 'no-network']) assert.ok(lines.includes(want), `${want}: ${answer}`);
});

test('the same bytes twice give the same flags, in the same order', { timeout: TIMEOUT }, async (t) => {
  const source = fs.readFileSync(path.join(FIXTURES, 'positive.sol'), 'utf8');
  const a = await flagsOf(t, [entry('test/positive.sol', source)]);
  const b = await flagsOf(t, [entry('test/positive.sol', source)]);
  assert.deepEqual(a, b);
  assert.equal(a.length, 50, 'the bound');
  assert.ok(a.some((f) => f.rule === ID('truncated')));
});

// ------------------------------------------------------- a claim, through the pipeline

const VM = VM_SOL.replace('    function assume(bool c) external pure;', [
  '    function assume(bool c) external pure;',
  '    function store(address a, bytes32 s, bytes32 v) external;',
  '    function warp(uint256 t) external;',
  '    function prank(address a) external;'
].join('\n'));

const LEGACY = [
  '// SPDX-License-Identifier: MIT',
  'pragma solidity ^0.8.0;',
  '',
  'contract Legacy {',
  '    address public owner;',
  '',
  '    function f() public view {',
  '        require(tx.origin == owner, "no");',
  '    }',
  '}',
  ''
].join('\n');
const LEGACY_FIXED = LEGACY.replace('    function f() public view {', [
  '    function g(address payable t) public { selfdestruct(t); }',
  '',
  '    function f() public view {'
].join('\n'));

const builder = dockerFor(dockerTestConfig());
let fixtureBuilt = null;
function fixture() {
  if (!fixtureBuilt) {
    fixtureBuilt = buildFixture(builder, { files: { ...VAULT_REPO, 'test/Vm.sol': VM, 'src/Legacy.sol': LEGACY }, instance: `h${crypto.randomBytes(4).toString('hex')}` });
  }
  return fixtureBuilt;
}
test.after(async () => {
  if (fixtureBuilt) await (await fixtureBuilt).remove().catch(() => {});
});

const POC = pocFile('ExploitTest', [
  '    function test_drain() public {',
  '        vm.warp(block.timestamp + 1 days);',
  '        vm.prank(address(1));',
  '        vm.store(address(this), bytes32(uint256(0)), bytes32(uint256(1)));',
  '        require(false, "vault drained");',
  '    }'
]);

function claimOf(fx, over = {}) {
  const spec = {
    version: 1, kind: 'bug', repo: 'https://github.com/acme/vault', baseCommit: fx.baseCommit,
    env: { image: fx.image, from: 'foundry', platform: 'linux/amd64', unpackedBytes: 2000000000 },
    attestation: 'attestation.json',
    commands: { framework: 'forge', build: 'forge build', test: 'forge test', testFiles: 'forge test --match-path $FILES', testIds: 'forge test --match-test $TEST_IDS' },
    paths: { tests: ['test/**'], protected: ['foundry.toml', 'lib/**', '.gitignore'] },
    limits: { cpus: 1, memoryMb: 1024, buildSeconds: 90, testSeconds: 120, runSeconds: 360, maxPatchBytes: 2000000 }
  };
  return {
    listingCid: 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG',
    bcid: 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi',
    spec, attestation: { version: 1, env: spec.env }, pocPatch: addFilesPatch({ 'test/Exploit.t.sol': POC, 'test/.semgrepignore': '*\n' }), fixPatch: null,
    baseline: vaultBaseline(fx.baseCommit),
    finding: {
      version: 1, claimedClass: 'HIGH', rootCause: 'Vault.deposit credits one wei more than it receives.', affectedPaths: ['src/Vault.sol'],
      poc: { command: 'forge test', observable: 'the test fails with "vault drained"' }
    },
    report: '# A report\n', knownIssues: [], priorFindings: [], eaGates: { disclosure: 'pass', inScope: 'pass' }, deadlineMs: 800000,
    ...over
  };
}

async function runReal(t, request) {
  const config = dockerTestConfig();
  const docker = dockerFor(config);
  t.after(() => removeAll(docker, config.instance).catch(() => {}));
  const lim = checkSpec(request.spec);
  assert.ok(lim.ok, JSON.stringify(lim.issues));
  const receivedAt = Date.now();
  const result = await executeRun({
    docker, config, limits: lim.limits, image: request.spec.env.image, runId: crypto.randomBytes(8).toString('hex'),
    steps: claimSteps(request, lim.limits), receivedAt, deadlineAt: receivedAt + request.deadlineMs, active: new Set(), log: silent,
    preflight: scanner.requireScanner, toolReserveMs: scanner.SCAN_RESERVE_MS, minMemoryMb: scanner.SCAN_MEMORY_MB, sandboxes: request.fixPatch ? 2 : 1
  });
  assert.equal(result.outcome, 'definitive', JSON.stringify({ abstain: result.abstain, issues: result.issues, gates: result.gates }));
  assert.deepEqual(await leftovers(docker, config.instance), [], 'the run removed every sandbox, the scanner\'s too');
  t.diagnostic(`the scan: ${result.steps.filter((s) => /^scan:/.test(s.name)).reduce((n, s) => n + s.durationMs, 0)} ms under ${RUNTIME}`);
  return { result, ...buildReport(result, request, { gvisor: result.gvisor, platform: 'linux/amd64' }) };
}

test('a real claim: the flags in a real PoC reach a valid report, on the patch\'s lines; forward clock moves and prank do not; no gate moves', { timeout: TIMEOUT }, async (t) => {
  const fx = await fixture();
  const { result, report, sha256 } = await runReal(t, claimOf(fx));
  assert.equal(codeReview.validateClaimReport(report).ok, true);
  assert.equal(result.gates.reproduces.status, 'pass', JSON.stringify(result.gates));
  assert.equal(result.gates.integrity.status, 'pass', JSON.stringify(result.gates));
  assert.deepEqual(report.poc.integrity.tamperFlags, []);
  const line = POC.split('\n').findIndex((l) => l.includes('vm.store(')) + 1;
  assert.deepEqual(report.poc.honestyFlags.map((f) => [f.rule, f.file, f.line]), [[ID('storage-overwrite'), 'test/Exploit.t.sol', line]]);
  assert.match(report.poc.honestyFlags[0].message, /The patch added this line/);
  assert.equal(report.inputs.semgrepRules, codeReview.SEMGREP_RULES_VERSION);
  assert.deepEqual(result.facts.scan.image, SEMGREP.indexDigest);

  const again = await runReal(t, claimOf(fx));
  assert.equal(again.sha256, sha256, 'the same report hash on a second run');
});

test('a real fix: forge fmt --check and Semgrep --baseline-commit give what the fix brought in, and only that; a .semgrepignore in it has no effect', { timeout: TIMEOUT }, async (t) => {
  const fx = await fixture();
  const helper = 'contract Helper { function h(address payable t) public { selfdestruct(t); } }\n';
  const fixPatch = Buffer.concat([modifyPatch('src/Legacy.sol', LEGACY, LEGACY_FIXED), addFilesPatch({ '.semgrepignore': '*\n', 'src/Helper.txt': helper })]);
  const { result, report } = await runReal(t, claimOf(fx, { fixPatch }));
  assert.equal(result.facts.fix.applies, 'pass', JSON.stringify(result.facts.fix.detail));
  assert.equal(result.facts.fix.builds, 'pass', JSON.stringify(result.facts.fix.detail));
  assert.deepEqual(report.findings.map((f) => [f.tool, f.rule, f.file]).sort(), [
    ['forge-fmt', 'forge-fmt.unformatted', 'src/Legacy.sol'],
    ['semgrep', 'verdikta.solidity.selfdestruct', 'src/Helper.txt'],
    ['semgrep', 'verdikta.solidity.selfdestruct', 'src/Legacy.sol']
  ].sort());
  const line = LEGACY_FIXED.split('\n').findIndex((l) => l.includes('selfdestruct')) + 1;
  assert.equal(report.findings.find((f) => f.tool === 'semgrep' && f.file === 'src/Legacy.sol').line, line);
  assert.ok(!report.findings.some((f) => f.rule === 'verdikta.solidity.tx-origin-auth'), 'the listed commit\'s own finding is the baseline\'s');
  assert.equal(result.gates.reproduces.status, 'pass', 'the fix decides no gate');
});

test('a real forge fmt on a crafted file forge build never compiles (a long sum aborts it on arm64 with exit 134) is a stated finding, and the claim stands', { timeout: TIMEOUT }, async (t) => {
  const fx = await fixture();
  const crafted = `pragma solidity ^0.8.0;\ncontract C { function f() public pure returns (uint256) { return ${'1+'.repeat(30000)}1; } }\n`;
  assert.ok(crafted.length <= SCAN_LIMITS.fileBytes);
  const { result, report } = await runReal(t, claimOf(fx, { fixPatch: addFilesPatch({ 'docs/Crafted.sol': crafted }) }));
  assert.equal(result.facts.fix.applies, 'pass', JSON.stringify(result.facts.fix.detail));
  assert.equal(result.facts.fix.builds, 'pass', JSON.stringify(result.facts.fix.detail));
  // Where the stack gives out is the platform's: amd64's frames carry this sum, arm64's do not. Either way a stated finding.
  assert.deepEqual(report.findings.map((f) => [f.tool, f.file]), [['forge-fmt', 'docs/Crafted.sol']]);
  assert.ok(['forge-fmt.unreadable', 'forge-fmt.unformatted'].includes(report.findings[0].rule), report.findings[0].rule);
  assert.equal(result.gates.reproduces.status, 'pass');
});

test('the bug rules\' slowest shape, within the limits, answers before the step\'s timer', { timeout: TIMEOUT }, async (t) => {
  const fill = (u, n) => u.repeat(Math.ceil(n / u.length)).slice(0, n);
  const head = 'pragma solidity ^0.8.20;\ncontract A { mapping(address=>uint) m; function a(address t) external {\n';
  const source = `${head}${fill('t.call{value: 1}("");x();y();z();\n', SCAN_LIMITS.fileBytes - 200)}\n} }\n`;
  const t0 = Date.now();
  const { answer } = await inScanner(t, (handle) => scanFix(handle, prepareFix([entry('src/Big.sol', source, { oldBytes: null })])));
  t.diagnostic(`the bug rules' slowest shape: ${Date.now() - t0} ms under ${RUNTIME}`);
  assert.ok(answer.length > 0);
  assert.ok(Date.now() - t0 < SCAN_TIMEOUT_MS);
});

test('a fixed file that makes the bug rules use their whole memory bound is a stated finding, not a killed scan', { timeout: TIMEOUT }, async (t) => {
  const fill = (u, n) => u.repeat(Math.ceil(n / u.length)).slice(0, n);
  const body = fill('t.call{value: 1}("");m[t] = 1;\n', 32 * 1024);
  const source = `pragma solidity ^0.8.20;\ncontract A { mapping(address=>uint) m; function a(address t) external {\n${body}\n} }\n`;
  const input = prepareFix([entry('src/Big.sol', source, { oldBytes: null })]);
  const { answer } = await inScanner(t, (handle) => scanFix(handle, input));
  const findings = boundFindings(answer);
  assert.deepEqual(findings.map((f) => [f.tool, f.rule, f.file]), [['semgrep', 'verdikta.scan.unread-file', 'src/Big.sol']]);
  assert.match(findings[0].message, /1024 MiB/);
});
