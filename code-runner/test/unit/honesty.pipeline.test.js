'use strict';

// Node A3c through the run engine, with a fake forge and a fake Semgrep that
// answers as the real one does (test/helpers/fakeClaim.js): honesty flags reach
// the report and no gate, a scan that could not finish never reads as no flags,
// and a fix's lint is a fact only. test/docker/honesty.docker.test.js holds the
// same paths to real Semgrep and real forge.

const test = require('node:test');
const assert = require('node:assert/strict');
const { codeReview } = require('@verdikta/common');
const { executeRun } = require('../../src/pipeline');
const { checkSpec } = require('../../src/classLimits');
const { claimSteps } = require('../../src/steps');
const { buildReport } = require('../../src/report');
const { health } = require('../../src/health');
const { createServer } = require('../../src/server');
const { Capacity, admitRun } = require('../../src/admission');
const { DEFAULT_PINNED_DIGESTS } = require('../../src/images');
const { REPORT_MAX_LINE, BASE_IMAGE_PINS } = require('../../src/common');
const {
  SEMGREP, RULE_FILES, HONESTY_RULES, FIX_RULES, SCAN_MEMORY_MB, SCAN_RESERVE_MS, SCAN_BUDGET_MS, ruleBytes, requireScanner
} = require('../../src/scanner');
const { claimSandbox, junit, drainFails, semgrepHit, semgrepAnswer, FIX_PATCH, BASE, POC_PATCH } = require('../helpers/fakeClaim');
const { fakeDocker, healthyDaemon } = require('../helpers/fakeDocker');
const { claimRequest, runClaim, forgeSpec, finding, DEPOSIT, IMAGE } = require('../helpers/claimRun');
const { settlementFacts } = require('../helpers/settlementFacts');
const { testConfig, request: httpRequest } = require('../helpers/http');
const { attestationFor } = require('../helpers/requests');

const CLASS = 'linux/amd64';
const PINNED = codeReview.GVISOR_RELEASE;
const STORE = 'verdikta.honesty.storage-overwrite';
const ETCH = 'verdikta.honesty.code-overwrite';
const READ = 'verdikta.honesty.filesystem-read';
const show = (r) => JSON.stringify({ outcome: r.outcome, abstain: r.abstain, issues: r.issues, gates: r.gates }, null, 1);
const built = (r, request) => buildReport(r, request, { gvisor: PINNED, platform: CLASS });
const scanWith = (answer) => ({ semgrep: answer });
const statusOf = (r) => Object.fromEntries(Object.entries(r.gates).map(([k, v]) => [k, v.status]));

// ------------------------------------------------------- the acceptance: flags, in the report, tier A, no gate

test('a clean PoC: Semgrep ran, no flag, and the report carries the empty list and the rule set', async () => {
  const sb = claimSandbox();
  const request = claimRequest();
  const r = await runClaim(sb, request);
  assert.equal(r.outcome, 'definitive', show(r));
  assert.deepEqual(r.facts.poc.honestyFlags, []);
  const { report } = built(r, request);
  assert.deepEqual(report.poc.honestyFlags, []);
  assert.equal(report.inputs.semgrepRules, codeReview.SEMGREP_RULES_VERSION);
  assert.deepEqual(r.facts.scan, { tier: 'A', semgrep: SEMGREP.version, image: SEMGREP.indexDigest, rules: codeReview.SEMGREP_RULES_VERSION, poc: { read: 1, stated: 0 }, fix: null });
  assert.equal(sb.scanExecs().filter((d) => d.kind === 'semgrep').length, 1);
});

test('a flag reaches the report as the schema has it, from the runner\'s table, and nothing the tool printed travels', async () => {
  const request = claimRequest();
  const r = await runClaim(claimSandbox(scanWith(() => ({ results: [semgrepHit(STORE, 'f0.sol', 2)] }))), request);
  const { report } = built(r, request);
  assert.equal(codeReview.validateClaimReport(report).ok, true);
  assert.equal(report.poc.honestyFlags.length, 1);
  const [flag] = report.poc.honestyFlags;
  assert.deepEqual([flag.rule, flag.file, flag.line], [STORE, 'test/Exploit.t.sol', 2]);
  assert.ok(flag.message.startsWith(HONESTY_RULES[STORE].message));
  assert.doesNotMatch(JSON.stringify(report), /text the runner must not read/);
});

test('Q35: an honesty flag is a fact for the jury, never a tamper flag or a gate: gates, integrity and settlement are as without it', async () => {
  const clean = await runClaim(claimSandbox());
  const flagged = await runClaim(claimSandbox(scanWith(() => ({ results: [semgrepHit(STORE, 'f0.sol', 2), semgrepHit(ETCH, 'f0.sol', 3)] }))));
  assert.equal(flagged.facts.poc.honestyFlags.length, 2);
  assert.deepEqual(statusOf(flagged), statusOf(clean));
  assert.deepEqual(flagged.gates, clean.gates);
  assert.deepEqual(flagged.facts.poc.integrity, clean.facts.poc.integrity);
  assert.deepEqual(flagged.facts.poc.integrity.tamperFlags, []);
  assert.deepEqual(settlementFacts(flagged), settlementFacts(clean));
});

test('the flags are in the report\'s hash, in one order whatever order Semgrep answered in', async () => {
  const hits = [semgrepHit(STORE, 'f0.sol', 2), semgrepHit(ETCH, 'f0.sol', 3), semgrepHit(READ, 'f0.sol', 1)];
  const hash = async (list) => {
    const request = claimRequest();
    return built(await runClaim(claimSandbox(scanWith(() => ({ results: list }))), request), request).sha256;
  };
  const a = await hash(hits);
  assert.equal(a, await hash([...hits].reverse()));
  assert.notEqual(a, await hash([]), 'the flags move the hash, so the hash means what it says');
});

test('a claim stopped by a gate before any run has no poc, no scan and no scanner\'s sandbox', async () => {
  const sb = claimSandbox({ scripts: { 'vcr-build': () => ({ exitCode: 1 }) } });
  const request = claimRequest();
  const r = await runClaim(sb, request);
  assert.equal(r.gates.build.status, 'fail');
  assert.deepEqual(sb.scanExecs(), []);
  assert.equal(built(r, request).report.poc, null);
});

test('a claim whose reproduces gate fails is still scanned: the same list on every arbiter, whatever the verdict', async () => {
  const pass = junit([{ suite: 'test/Exploit.t.sol:ExploitTest', cases: [{ name: 'test_drain()' }] }]);
  const sb = claimSandbox({ poc: [pass, pass, pass], semgrep: () => ({ results: [semgrepHit(ETCH, 'f0.sol', 2)] }) });
  const request = claimRequest();
  const r = await runClaim(sb, request);
  assert.equal(r.gates.reproduces.status, 'fail');
  assert.equal(built(r, request).report.poc.honestyFlags[0].rule, ETCH);
});

// ------------------------------------------------------- the review focus: the sandbox

const scanCreate = (sb) => sb.docker.callsOf('create').find((c) => c.args.includes(SEMGREP.reference));

test('the Semgrep container has every sandbox\'s flags, the pinned image by digest, and limits of its own', async () => {
  const sb = claimSandbox();
  await runClaim(sb);
  const { args } = scanCreate(sb);
  const value = (flag) => args[args.indexOf(flag) + 1];
  assert.equal(value('--network'), 'none');
  assert.equal(value('--pull'), 'never', 'the runner never pulls it');
  assert.equal(value('--user'), '10001:10001');
  assert.equal(value('--cap-drop'), 'ALL');
  assert.equal(value('--security-opt'), 'no-new-privileges');
  assert.equal(value('--ipc'), 'none');
  assert.equal(value('--memory'), `${SCAN_MEMORY_MB}m`);
  assert.equal(value('--memory-swap'), `${SCAN_MEMORY_MB}m`);
  assert.ok(args.includes('--read-only'));
  assert.ok(!args.includes('--volume') && !args.includes('-v') && !args.includes('--mount'), 'nothing of the host is mounted');
  assert.ok(!args.includes(IMAGE), 'not the env image');
  // The same flags as the PoC's own, but for the image and the limits.
  const poc = sb.docker.callsOf('create')[0].args;
  const shape = (a) => a.filter((x, i) => !/^vcr-|^verdikta\.code-runner|sha256:/.test(x) && !['--memory', '--memory-swap', '--cpus', '--pids-limit'].includes(a[i - 1]));
  assert.deepEqual(shape(args).filter((x) => !/^[0-9]+$/.test(x)), shape(poc).filter((x) => !/^[0-9]+$/.test(x)));
});

test('a scan runs when the claim\'s sandboxes are gone, within what admission held', async () => {
  const sb = claimSandbox();
  const r = await runClaim(sb, claimRequest({ fixPatch: Buffer.from(FIX_PATCH) }));
  assert.equal(r.outcome, 'definitive', show(r));
  const order = sb.docker.calls.map((c) => c.args.slice(0, 3).join(' '));
  const created = order.map((c, i) => (c.startsWith('create') ? i : -1)).filter((i) => i >= 0);
  assert.equal(created.length, 3, 'the PoC\'s, the fix check\'s, the scanner\'s');
  const scanAt = created[2];
  const removedBefore = sb.docker.calls.slice(0, scanAt).filter((c) => c.args[0] === 'rm').flatMap((c) => c.args.filter((a) => /^vcr-/.test(a)));
  assert.ok(removedBefore.some((n) => n.endsWith('-1')) && removedBefore.some((n) => n.endsWith('-2')), removedBefore.join(' '));
});

test('what reaches the sandbox is the rule file and flat names, whatever the patch calls its files', async () => {
  const hostile = ['.semgrepignore', '.semgrep.yml', '.semgrep/rule.yml', 'test/.semgrepignore', '.gitignore', 'test/Exploit.t.sol'];
  const raw = hostile.map((p, i) => `:000000 100644 ${'0'.repeat(40)} ${String(i).repeat(40)} A\0${p}\0`).join('');
  const blobs = Object.fromEntries(hostile.map((p, i) => [String(i).repeat(40), p === 'test/Exploit.t.sol' ? 'contract E {}\n' : '*\n']));
  const sb = claimSandbox({ blobs, git: { 'diff --raw': () => ({ stdout: Buffer.from(raw, 'latin1') }) } });
  const r = await runClaim(sb);
  assert.equal(r.outcome, 'definitive', show(r));
  const unpack = sb.scanExecs().find((d) => d.kind === 'tar');
  const names = [];
  for (let at = 0; at + 512 <= unpack.stdin.length;) {
    const head = unpack.stdin.subarray(at, at + 512);
    if (head.every((b) => b === 0)) break;
    names.push(head.toString('latin1', 0, 100).replace(/\0.*$/, ''));
    at += 512 + Math.ceil(parseInt(head.toString('latin1', 124, 136), 8) / 512) * 512;
  }
  assert.ok(names.includes(`rules/${RULE_FILES.honesty.file}`));
  for (const n of names.filter((x) => !x.startsWith('rules/'))) assert.match(n, /^src\/f[0-9]+\.sol$/);
  assert.ok(unpack.stdin.includes(ruleBytes('honesty')), 'the pinned bytes');
  const [semgrep] = sb.scanExecs().filter((d) => d.kind === 'semgrep');
  for (const p of hostile) assert.ok(!semgrep.argv.join(' ').includes(p), p);
  assert.equal(semgrep.workdir, '/work/src');
  assert.ok(semgrep.argv.includes('--disable-nosem'));
});

test('the bytes are read from git before any claim code, by the commit, so nothing a test does changes what it is judged on', async () => {
  const sb = claimSandbox();
  await runClaim(sb);
  const order = sb.pocExecs().map((d) => (d.kind === 'git' ? `git ${d.sub[0]}` : d.kind));
  const lastBeforeBuild = order.lastIndexOf('git cat-file', order.indexOf('vcr-build'));
  assert.ok(lastBeforeBuild >= 0 && lastBeforeBuild < order.indexOf('vcr-build'));
  assert.ok(!order.slice(order.indexOf('vcr-build')).includes('git cat-file'), 'no read after the build');
  const raw = sb.pocExecs().filter((d) => d.kind === 'git' && d.sub[0] === 'diff' && d.sub.includes('--raw') && !d.sub.includes('--cached'));
  assert.equal(raw.length, 1);
  assert.ok(raw[0].sub.includes(sb.repo.commit), 'from the listed commit');
});

// ------------------------------------------------------- never "no flags"

test('a scan that fails on the host or in the tool abstains: no report that reads as no flags', async (t) => {
  const failures = {
    'exit 2': () => ({ exitCode: 2, stdout: '{}' }),
    'not JSON': () => ({ exitCode: 0, stdout: 'Traceback' }),
    'a version off the pin': () => ({ version: '1.180.0' }),
    'an error kind the runner does not know': () => ({ errors: [{ type: 'Timeout', level: 'warn', path: 'f0.sol' }] }),
    'a rule it was not given': () => ({ results: [semgrepHit('hunter.planted')] }),
    'a rule it skipped': () => ({ skipped: [{ rule_id: STORE, details: 'needs another engine' }] })
  };
  for (const [name, semgrep] of Object.entries(failures)) {
    await t.test(name, async () => {
      const r = await runClaim(claimSandbox({ semgrep }));
      assert.equal(r.outcome, 'abstain', show(r));
      assert.equal(r.abstain.cause, 'runner_error');
      assert.equal(r.abstain.step, 'scan');
    });
  }
});

test('the answer is read from the file Semgrep wrote, never its stdout: under gVisor stdout is cut at 64 KiB with exit 0', async () => {
  const hit = semgrepHit(STORE, 'f0.sol', 2);
  const sb = claimSandbox({ scripts: { semgrep: (d, b) => {
    b.files = { ...(b.files || {}), [d.argv[d.argv.indexOf('--output') + 1]]: JSON.stringify({ version: SEMGREP.version, results: [hit], errors: [], paths: { scanned: ['f0.sol'] }, engine_requested: 'OSS', skipped_rules: [] }) };
    return { stdout: '{"version":"1.181.0","results":[],"errors":[],"paths":{"scanned":["f0.sol"]},"engine_requested":"OSS","skipped_rules":[]}' };
  } } });
  const r = await runClaim(sb);
  assert.equal(r.outcome, 'definitive', show(r));
  assert.deepEqual(r.facts.poc.honestyFlags.map((f) => f.rule), [STORE], 'the file, not the clean stdout');
  const cut = await runClaim(claimSandbox({ semgrep: () => ({ cutAt: 65536, results: Array.from({ length: 400 }, (_, i) => semgrepHit(STORE, 'f0.sol', i + 1)) }) }));
  assert.equal(cut.outcome, 'abstain', 'an answer cut short is not JSON, and never reads as no flags');
  assert.equal(cut.abstain.step, 'scan');
});

test('an answer over the bound is cut: the run abstains, it does not parse what it kept', async () => {
  const r = await runClaim(claimSandbox({ scripts: { cat: () => ({ stdout: Buffer.alloc(70 * 1024 * 1024, 0x20) }) } }));
  assert.equal(r.outcome, 'abstain', show(r));
  assert.match(r.abstain.detail, /cut at/);
});

test('a Semgrep that hits the memory limit, or is killed, abstains like any step', async () => {
  const oom = await runClaim(claimSandbox({ semgrep: () => ({ exitCode: 137 }) }));
  assert.equal(oom.outcome, 'abstain', show(oom));
  assert.equal(oom.abstain.step, 'scan:poc');
});

test('a parse failure, a match cap and a file past a limit each settle as stated facts: the same on every host, and the gates as they were', async () => {
  const cases = {
    'a parse failure': { semgrep: () => ({ errors: [{ type: 'Syntax error', level: 'warn', path: 'f0.sol' }] }), rule: 'verdikta.honesty.unread-file' },
    'a partial parse': { semgrep: () => ({ errors: [{ type: ['PartialParsing', [{ start: { line: 2 }, end: { line: 2 } }]], level: 'warn', path: 'f0.sol' }] }), rule: 'verdikta.honesty.unread-part' },
    'a match cap': { semgrep: () => ({ errors: [{ type: 'Too many matches', level: 'warn', path: 'f0.sol', rule_id: ETCH }] }), rule: 'verdikta.honesty.unread-file' },
    'the memory bound': { semgrep: () => ({ errors: [{ type: 'Out of memory', level: 'warn', path: 'f0.sol' }] }), rule: 'verdikta.honesty.unread-file' },
    'a file it does not say it read': { semgrep: () => ({ scanned: [] }), rule: 'verdikta.honesty.not-scanned' }
  };
  const clean = await runClaim(claimSandbox());
  for (const [name, { semgrep, rule }] of Object.entries(cases)) {
    const request = claimRequest();
    const r = await runClaim(claimSandbox({ semgrep }), request);
    assert.equal(r.outcome, 'definitive', `${name}: ${show(r)}`);
    assert.ok(r.facts.poc.honestyFlags.some((f) => f.rule === rule), name);
    assert.deepEqual(statusOf(r), statusOf(clean), name);
    assert.equal(codeReview.validateClaimReport(built(r, request).report).ok, true, name);
  }
});

test('a PoC file past the limits never reaches Semgrep and is stated, and with no target left no sandbox is opened', async () => {
  const id = 'a'.repeat(40);
  const sb = claimSandbox({ blobs: { [id]: Buffer.alloc(70000, 0x20) } });
  const r = await runClaim(sb);
  assert.equal(r.outcome, 'definitive', show(r));
  assert.deepEqual(r.facts.poc.honestyFlags.map((f) => [f.rule, f.file, f.line]), [['verdikta.honesty.not-scanned', 'test/Exploit.t.sol', null]]);
  assert.deepEqual(sb.scanExecs(), []);
  assert.equal(scanCreate(sb), undefined);
});

// ------------------------------------------------------- the bound and the report's rules

test('nothing a hunter writes can make a report invalid: a line past the bound, 60 flags, every rule', async () => {
  const hits = [];
  for (let i = 1; i <= 60; i += 1) hits.push(semgrepHit(READ, 'f0.sol', i));
  hits.push(semgrepHit(STORE, 'f0.sol', REPORT_MAX_LINE + 5));
  const request = claimRequest();
  const r = await runClaim(claimSandbox(scanWith(() => ({ results: hits }))), request);
  const { report, warnings } = built(r, request);
  assert.equal(codeReview.validateClaimReport(report).ok, true);
  assert.equal(report.poc.honestyFlags.length, 50);
  assert.ok(report.poc.honestyFlags.some((f) => f.rule === STORE && f.line === null), 'the high one is kept, file-level past the bound');
  assert.ok(report.poc.honestyFlags.some((f) => f.rule === 'verdikta.honesty.truncated'));
  assert.deepEqual(warnings.filter((w) => /PATH/.test(w.code)), [], 'no text names a host path');
});

test('the report keeps common\'s canonical order for flags, and the kept set does not depend on the order it arrived in', async () => {
  const hits = [];
  for (let i = 1; i <= 60; i += 1) hits.push(semgrepHit(i % 2 ? READ : STORE, 'f0.sol', i));
  const list = async (h) => {
    const request = claimRequest();
    return built(await runClaim(claimSandbox(scanWith(() => ({ results: h }))), request), request);
  };
  const a = await list(hits);
  const b = await list([...hits].reverse());
  assert.equal(a.sha256, b.sha256);
  const lines = a.report.poc.honestyFlags.map((f) => f.line);
  assert.deepEqual(lines, [...lines].sort((x, y) => (x === null ? -1 : y === null ? 1 : x - y)));
});

// ------------------------------------------------------- the fix path: facts only

const withFix = (over = {}) => claimRequest({ fixPatch: Buffer.from(FIX_PATCH), ...over });

test('with fix.patch: forge fmt --check through forge\'s own argv, then Semgrep --baseline-commit over the fixed files, in the report as findings', async () => {
  const sb = claimSandbox({
    scripts: { 'forge-fmt': () => ({ exitCode: 1, stdout: 'Diff in src/Vault.sol:\n1 1 | secret line\n' }) },
    semgrep: (d) => (d.argv.includes('--baseline-commit') ? { results: [semgrepHit('verdikta.solidity.selfdestruct', 'f0.sol', 4)] } : {})
  });
  const request = withFix();
  const r = await runClaim(sb, request);
  assert.equal(r.outcome, 'definitive', show(r));
  const { report } = built(r, request);
  assert.deepEqual(report.findings, [
    { tool: 'semgrep', rule: 'verdikta.solidity.selfdestruct', severity: 'medium', file: 'src/Vault.sol', line: 4, message: FIX_RULES['verdikta.solidity.selfdestruct'].message, triage: null },
    { tool: 'forge-fmt', rule: 'forge-fmt.unformatted', severity: 'info', file: 'src/Vault.sol', line: null, message: 'forge fmt --check would change this file.', triage: null }
  ]);
  assert.doesNotMatch(JSON.stringify(report), /secret line/, 'its diff quotes source: only the path is kept');
  const fmt = sb.fixExecs().find((d) => d.kind === 'forge-fmt');
  assert.deepEqual(fmt.argv.slice(1), ['fmt', '--check', '/work/src/Vault.sol']);
  assert.ok(fmt.fixedEnv, 'through env -i, as every forge the runner starts');
  assert.ok('FOUNDRY_SOLC' in fmt.fixedEnv, 'with the pinned compiler');
  const base = sb.scanExecs().filter((d) => d.kind === 'semgrep').find((d) => d.argv.includes('--baseline-commit'));
  assert.equal(base.argv[base.argv.indexOf('--baseline-commit') + 1], 'c'.repeat(40), 'the commit the runner built, from its own bytes');
  assert.ok(base.argv.includes(`/work/rules/${RULE_FILES.solidity.file}`));
  assert.equal(base.workdir, '/work/repo');
});

test('a fix\'s lint is a fact: it decides no gate, and a dirty fix settles as a clean one', async () => {
  const clean = await runClaim(claimSandbox(), withFix());
  const r = await runClaim(claimSandbox({
    scripts: { 'forge-fmt': () => ({ exitCode: 1, stdout: 'Diff in src/Vault.sol:\n' }) },
    semgrep: (d) => (d.argv.includes('--baseline-commit') ? { results: [semgrepHit('verdikta.solidity.tx-origin-auth', 'f0.sol', 1)] } : {})
  }), withFix());
  assert.equal(r.facts.findings.length, 2);
  assert.deepEqual(clean.facts.findings, []);
  assert.deepEqual(statusOf(r), statusOf(clean));
  assert.deepEqual(settlementFacts(r), settlementFacts(clean));
  assert.deepEqual(r.facts.fix.integrity, clean.facts.fix.integrity);
  assert.equal(r.facts.fix.builds, clean.facts.fix.builds);
});

test('exit 1 from forge fmt means a diff or a parse failure: what it printed says which', async () => {
  const r = await runClaim(claimSandbox({ scripts: { 'forge-fmt': () => ({ exitCode: 1, stderr: 'Error: solar reported errors:\n' }) } }), withFix());
  assert.deepEqual(r.facts.findings.map((f) => f.rule), ['forge-fmt.unreadable']);
});

test('forge fmt dying on a file is a stated finding: a fix\'s lint cannot abstain the claim (a long sum aborts it with exit 134)', async () => {
  const r = await runClaim(claimSandbox({ scripts: { 'forge-fmt': () => ({ exitCode: 134 }) } }), withFix());
  assert.equal(r.outcome, 'definitive', show(r));
  assert.deepEqual(r.facts.findings.map((f) => [f.tool, f.rule, f.file]), [['forge-fmt', 'forge-fmt.unreadable', 'src/Vault.sol']]);
  assert.match(r.facts.findings[0].message, /134/);
});

test('forge fmt killed for memory is the host\'s: it abstains, as any step', async () => {
  const r = await runClaim(claimSandbox({ scripts: { 'forge-fmt': () => ({ exitCode: 137 }) } }), withFix());
  assert.equal(r.outcome, 'abstain', show(r));
  assert.equal(r.abstain.cause, 'oom');
});

test('a fixed file past the limits, or a fix that changes forge\'s configuration: forge fmt says it did not read it, never clean', async () => {
  const big = claimSandbox({ blobs: { ['b'.repeat(40)]: Buffer.alloc(70000, 0x20) } });
  const r = await runClaim(big, withFix());
  assert.equal(r.outcome, 'definitive', show(r));
  assert.deepEqual(r.facts.findings.map((f) => [f.tool, f.rule, f.file]).sort(), [['forge-fmt', 'forge-fmt.not-run', 'src/Vault.sol'], ['semgrep', 'verdikta.scan.not-scanned', 'src/Vault.sol']].sort());
  const config = claimSandbox({
    fix: {
      nameStatus: 'M\0foundry.toml\0M\0src/Vault.sol\0',
      numstat: '1\t0\tfoundry.toml\x001\t1\tsrc/Vault.sol\0',
      raw: `:100644 100644 ${'1'.repeat(40)} ${'b'.repeat(40)} M\0src/Vault.sol\0`
    }
  });
  const spec = forgeSpec({ paths: { tests: ['test/**'], protected: ['lib/**'] } });
  const c = await runClaim(config, withFix({ spec }));
  assert.equal(c.outcome, 'definitive', show(c));
  assert.equal(c.facts.fix.builds, 'fail');
  assert.ok(c.facts.findings.some((f) => f.rule === 'forge-fmt.not-run' && f.file === 'src/Vault.sol'), JSON.stringify(c.facts.findings));
});

test('a fix\'s non-Solidity files are outside the rules\' language; a .semgrepignore in a fix has no effect', async () => {
  const raw = `:000000 100644 ${'0'.repeat(40)} ${'d'.repeat(40)} A\0.semgrepignore\0:100644 100644 ${'1'.repeat(40)} ${'b'.repeat(40)} M\0src/Vault.sol\0`;
  const sb = claimSandbox({ fix: { raw }, blobs: { ['d'.repeat(40)]: '*\n' } });
  const r = await runClaim(sb, withFix());
  assert.equal(r.outcome, 'definitive', show(r));
  const unpack = sb.scanExecs().filter((d) => d.kind === 'tar').pop();
  assert.ok(!unpack.stdin.includes(Buffer.from('.semgrepignore')));
  const base = sb.scanExecs().filter((d) => d.kind === 'semgrep').pop();
  assert.deepEqual(base.argv.slice(-1), ['f0.sol']);
});

test('a fix that does not apply has no lint and no finding: the fix check says so itself', async () => {
  const sb = claimSandbox({ fix: { applyExit: 1 } });
  const r = await runClaim(sb, withFix());
  assert.equal(r.facts.fix.applies, 'fail');
  assert.equal(r.facts.findings, undefined);
  assert.deepEqual(built(r, withFix()).report.findings, []);
  assert.equal(sb.scanExecs().filter((d) => d.kind === 'semgrep').length, 1, 'the PoC is still scanned');
});

test('a scan of a fix that fails on the host abstains the run, as every step of the fix check does', async () => {
  const r = await runClaim(claimSandbox({ semgrep: (d) => (d.argv.includes('--baseline-commit') ? { exitCode: 2, stdout: '' } : {}) }), withFix());
  assert.equal(r.outcome, 'abstain', show(r));
  assert.equal(r.abstain.step, 'scan');
});

test('findings past the bound keep the most severe, with a note, and the report validates', async () => {
  const hits = [];
  for (let i = 1; i <= 70; i += 1) hits.push(semgrepHit('verdikta.solidity.selfdestruct', 'f0.sol', i));
  hits.push(semgrepHit('verdikta.solidity.tx-origin-auth', 'f0.sol', 100));
  const request = withFix();
  const r = await runClaim(claimSandbox({ semgrep: (d) => (d.argv.includes('--baseline-commit') ? { results: hits } : {}) }), request);
  const { report } = built(r, request);
  assert.equal(codeReview.validateClaimReport(report).ok, true);
  assert.equal(report.findings.length, 50);
  assert.equal(report.findings[0].rule, 'verdikta.solidity.tx-origin-auth', 'severity first');
  assert.ok(report.findings.some((f) => f.rule === 'verdikta.scan.truncated'));
});

// ------------------------------------------------------- a missing or unrunnable scan, before any work

function serverBody(over = {}) {
  const spec = forgeSpec();
  return {
    listingCid: 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG',
    bcid: 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi',
    spec,
    attestation: attestationFor(spec),
    pocPatch: Buffer.from(POC_PATCH).toString('base64'),
    fixPatch: null,
    baseline: { version: 1, baseCommit: BASE, framework: 'forge', runs: 3, tests: [{ id: DEPOSIT, results: ['pass', 'pass', 'pass'] }], stable: [DEPOSIT], unstable: [] },
    finding: finding(),
    report: '# A claim\n',
    knownIssues: [],
    priorFindings: [],
    eaGates: { disclosure: 'pass', inScope: 'pass' },
    deadline: 700000,
    ...over
  };
}

async function serve(t, docker) {
  const config = testConfig();
  const srv = createServer({ config, docker, meminfo: async () => ({ availableMb: 100000, error: null }), statfs: async () => ({ bavail: 1e12, bsize: 1 }) });
  const target = await srv.listen();
  t.after(() => srv.close());
  return target;
}

const missingScanner = (ref) => !ref.includes(SEMGREP.indexDigest);

test('the image missing: /health says so, a run abstains before the env image or any sandbox, and the runner never pulls it', async (t) => {
  const docker = fakeDocker(healthyDaemon({ imagePresent: missingScanner }));
  const target = await serve(t, docker);
  const h = await httpRequest(target, { path: '/health' });
  assert.equal(h.body.ok, false);
  assert.ok(h.body.reasons.some((x) => /Semgrep image .* is not on this host/.test(x)), h.body.reasons.join(' '));
  assert.equal(h.body.scanner.present, false);
  const res = await httpRequest(target, { method: 'POST', path: '/v1/runs', body: serverBody() });
  assert.equal(res.status, 503);
  assert.equal(res.body.outcome, 'abstain');
  assert.equal(res.body.abstain.cause, 'image_unavailable');
  assert.equal(res.body.abstain.step, 'admission');
  assert.deepEqual(docker.callsOf('create'), [], 'before any sandbox');
  assert.deepEqual(docker.callsOf('pull'), [], 'no pull, of it or of the env image');
});

test('the image present: /health reports what it measured, and it is healthy', async () => {
  const h = await health({ config: testConfig(), docker: fakeDocker(healthyDaemon()), statfs: async () => ({ bavail: 1, bsize: 1 }) });
  assert.equal(h.ok, true, h.reasons.join(' '));
  assert.deepEqual({ ...h.scanner, rulesProblem: undefined }, {
    image: SEMGREP.reference, version: SEMGREP.version, rules: codeReview.SEMGREP_RULES_VERSION, present: true, digest: SEMGREP.indexDigest, platform: 'linux/amd64', problem: null, rulesProblem: undefined
  });
  assert.equal(h.scanner.rulesProblem, null);
});

test('an image of the wrong platform is a mismatch, measured: the same abstention before any work', async () => {
  const line = `${[JSON.stringify('sha256:aa'), '[]', JSON.stringify([`semgrep/semgrep@${SEMGREP.indexDigest}`]), '"linux"', '"arm64"', 'null', '1000'].join('\t')}\n`;
  const docker = fakeDocker(healthyDaemon({ image: () => ({ stdout: line }) }));
  await assert.rejects(requireScanner({ docker, config: { platform: 'linux/amd64' } }), (e) => e.cause === 'image_mismatch');
});

test('a Semgrep image gone by the time the scan opens abstains too, as an unavailable image', async () => {
  const sb = claimSandbox({
    handlers: {
      create: (args) => (args.includes(SEMGREP.reference) ? { exitCode: 125, stderr: 'Error response from daemon: No such image\n' } : { stdout: 'c0ffee\n' })
    }
  });
  const r = await runClaim(sb);
  assert.equal(r.outcome, 'abstain', show(r));
  assert.equal(r.abstain.cause, 'image_unavailable');
});

test('what launching the tool\'s image finds wrong is the runner\'s install, not the requester\'s package', async () => {
  const sb = claimSandbox({
    handlers: {
      inspect: (args) => {
        const out = args.some((a) => a.includes('.Mounts')) ? { stdout: '{"mounts":[],"readOnly":true}\n' } : null;
        if (out && args.includes('vcr-0123456789abcdef-2')) return { stdout: '{"mounts":[{"Destination":"/data"}],"readOnly":true}\n' };
        return out || { stdout: JSON.stringify({ Running: true, OOMKilled: false, ExitCode: 0, Status: 'running' }) };
      }
    }
  });
  const r = await runClaim(sb);
  assert.equal(r.outcome, 'abstain', show(r));
  assert.equal(r.abstain.cause, 'runner_error');
  assert.equal(r.issues, undefined);
});

test('the cache never evicts the Semgrep image, though no claim names it', () => {
  assert.ok(DEFAULT_PINNED_DIGESTS.includes(SEMGREP.indexDigest));
  assert.ok(DEFAULT_PINNED_DIGESTS.includes(BASE_IMAGE_PINS.foundry.digest));
});

// ------------------------------------------------------- the scan's budget

const smallRun = (runSeconds) => {
  const spec = { ...forgeSpec(), limits: { cpus: 1, memoryMb: 512, buildSeconds: 30, testSeconds: runSeconds, runSeconds, maxPatchBytes: 2000000 } };
  return claimRequest({ spec });
};
const execute = (sb, request) => {
  const lim = checkSpec(request.spec);
  assert.ok(lim.ok, JSON.stringify(lim.issues));
  const receivedAt = Date.now();
  return executeRun({
    docker: sb.docker, config: testConfig(), limits: lim.limits, image: IMAGE, runId: '0123456789abcdef',
    steps: claimSteps(request, lim.limits), receivedAt, deadlineAt: receivedAt + 60000, active: new Set(), log: { info() {}, warn() {}, error() {}, debug() {} },
    admit: async () => {}
  });
};

test('a hostile file cannot turn a listing\'s run into an abstention: the scan has its own budget, outside runSeconds', async () => {
  const slow = async (d, box) => {
    await new Promise((resolve) => { setTimeout(resolve, 1500); });
    return semgrepAnswer(d, null, box);
  };
  const r = await execute(claimSandbox({ scripts: { semgrep: slow } }), smallRun(1));
  assert.equal(r.outcome, 'definitive', show(r));
});

test('the budget is one claim code never had: a PoC past runSeconds still abstains', async () => {
  const slowPoc = async () => {
    await new Promise((resolve) => { setTimeout(resolve, 1500); });
    return { exitCode: 1, stdout: drainFails() };
  };
  const r = await execute(claimSandbox({ poc: [slowPoc, slowPoc, slowPoc] }), smallRun(1));
  assert.equal(r.outcome, 'abstain', show(r));
  assert.equal(r.abstain.cause, 'step_timeout');
});

test('a run admits only when the deadline leaves runSeconds and the scan\'s reserve; the reserve is an honest scan\'s, not the whole budget', async () => {
  const docker = fakeDocker(healthyDaemon());
  const config = testConfig();
  const limits = { runSeconds: 10, memoryMb: 512, cpus: 1 };
  const now = Date.now();
  await assert.rejects(admitRun({ config, docker, limits, stopAt: now + 11000, now, toolReserveMs: SCAN_RESERVE_MS }), (e) => /the scan/.test(e.detail));
  await admitRun({ config, docker, limits, stopAt: now + 11000 + SCAN_RESERVE_MS, now, toolReserveMs: SCAN_RESERVE_MS });
  assert.ok(SCAN_RESERVE_MS < SCAN_BUDGET_MS);
  // The largest listing, on the EA's deadline (§11), keeps its cold pull's window.
  const { CLASS_HARD_LIMITS } = require('../../src/common');
  assert.ok(740000 - CLASS_HARD_LIMITS.runSeconds * 1000 - SCAN_RESERVE_MS >= 90000 * 3);
});

test('admission holds the scanner\'s memory when the spec asks less for its own sandboxes, and the spec\'s when it asks more', async () => {
  const config = { ...testConfig(), slots: 5 };
  const held = async (memoryMb, sandboxes) => {
    const cap = new Capacity({ config, meminfo: async () => ({ availableMb: 1000000, error: null }) });
    const ticket = await cap.admit({ docker: fakeDocker(healthyDaemon()), limits: { runSeconds: 1, memoryMb, cpus: 1 }, stopAt: Date.now() + 60000, sandboxes, minMemoryMb: SCAN_MEMORY_MB });
    return ticket.memoryMb;
  };
  assert.equal(await held(256, 1), SCAN_MEMORY_MB);
  assert.equal(await held(4096, 2), 8192);
});
