'use strict';

// Node A3a attempt 3 (R11-F1; owner decision Q31): a listing's build and
// test commands are plain `forge build` / `forge test` with allowlisted
// flags, parsed strictly by src/commands.js and run by the runner as an
// argv. Every route round 12 found (and the ones round 11 named) is a
// refused command here; ordinary Foundry commands parse; the arguments forge
// gets are exactly the parsed ones. The pipeline and listing sides are in
// forgeargv.test.js; real forge in test/docker/integrity.docker.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCommand, commandIssues, forgeArgs, tokenize, COMMANDS, FLAGS } = require('../../src/commands');

/** The commands of @verdikta/common's code_review.bug.json fixture (and the design's §8.1 example). */
const COMMON_FIXTURE = Object.freeze({
  framework: 'forge',
  build: 'forge build',
  test: 'forge test',
  testFiles: 'forge test --match-path $FILES',
  testIds: 'forge test --match-test $TEST_IDS'
});

const VALUES = Object.freeze({ FILES: '{test/A.t.sol,test/B.t.sol}', TEST_IDS: '^(?:test_a\\(\\))$' });

function args(key, text) {
  const p = parseCommand(key, text);
  assert.ok(p.ok, `${key}: ${JSON.stringify(text)} should parse: ${p.issue && p.issue.detail}`);
  return forgeArgs(p, VALUES);
}

test('the common fixture\'s commands parse, and forge gets exactly the subcommand and the runner\'s placeholders, filled', () => {
  for (const key of ['build', 'test', 'testFiles', 'testIds']) assert.deepEqual(commandIssues(COMMON_FIXTURE, key), [], key);
  assert.deepEqual(args('build', COMMON_FIXTURE.build), ['build']);
  assert.deepEqual(args('test', COMMON_FIXTURE.test), ['test']);
  assert.deepEqual(args('testFiles', COMMON_FIXTURE.testFiles), ['test', '--match-path={test/A.t.sol,test/B.t.sol}']);
  assert.deepEqual(args('testIds', COMMON_FIXTURE.testIds), ['test', '--match-test=^(?:test_a\\(\\))$']);
});

test('accepted: each allowlisted flag, its visible alias and its = form, in any order; a quoted value reaches forge as one argument, unchanged', () => {
  const ok = [
    ['build', 'forge build --skip test', ['build', '--skip=test']],
    ['build', 'forge build --skip=script', ['build', '--skip=script']],
    ['build', '  forge   build  ', ['build']],
    ['test', 'forge test -vvv', ['test', '-vvv']],
    ['test', 'forge test -v --fuzz-runs 1000 --isolate', ['test', '-v', '--fuzz-runs=1000', '--isolate']],
    ['test', 'forge test --fuzz-runs=1000000 -vvvvv', ['test', '--fuzz-runs=1000000', '-vvvvv']],
    ['test', 'forge test --match-contract \'Vault.*Test\' --no-match-test testFork', ['test', '--match-contract=Vault.*Test', '--no-match-test=testFork']],
    ['test', 'forge test --mt test_x --nmt test_y --mc A --nmc B --mp test/A.t.sol --nmp \'test/fork/**\'',
      ['test', '--match-test=test_x', '--no-match-test=test_y', '--match-contract=A', '--no-match-contract=B', '--match-path=test/A.t.sol', '--no-match-path=test/fork/**']],
    ['test', 'forge test --no-match-contract \'Fork; rm -rf /work $(id) `x` | y > z\'', ['test', '--no-match-contract=Fork; rm -rf /work $(id) `x` | y > z']],
    ['test', 'forge test --match-test \'-starts-with-a-dash\'', ['test', '--match-test=-starts-with-a-dash']],
    ['test', 'forge test --match-test=test_a,test_b:x@y%z+1', ['test', '--match-test=test_a,test_b:x@y%z+1']],
    ['testFiles', 'forge test --match-path $FILES', ['test', `--match-path=${VALUES.FILES}`]],
    ['testFiles', 'forge test -vv --mp ${FILES} --fuzz-runs 10 --isolate', ['test', '-vv', `--match-path=${VALUES.FILES}`, '--fuzz-runs=10', '--isolate']],
    ['testIds', 'forge test --match-test $TEST_IDS', ['test', `--match-test=${VALUES.TEST_IDS}`]],
    ['testIds', 'forge test --match-path $FILES --mt ${TEST_IDS} -vvvv', ['test', `--match-path=${VALUES.FILES}`, `--match-test=${VALUES.TEST_IDS}`, '-vvvv']]
  ];
  for (const [key, text, want] of ok) assert.deepEqual(args(key, text), want, `${key}: ${text}`);
});

/** Refused with COMMAND_NOT_ALLOWED, the detail naming the offending token. */
function refused(key, text, token) {
  const p = parseCommand(key, text);
  assert.equal(p.ok, false, `${key}: ${JSON.stringify(text)} must be refused`);
  assert.equal(p.issue.code, 'COMMAND_NOT_ALLOWED', `${key}: ${JSON.stringify(text)}: ${p.issue.code} ${p.issue.detail}`);
  assert.equal(p.issue.path, `/spec/commands/${key}`);
  assert.ok(p.issue.detail.startsWith(`commands.${key}: ${JSON.stringify(token)} is not allowed: `), `${key}: ${JSON.stringify(text)} names ${JSON.stringify(token)}: ${p.issue.detail}`);
  assert.deepEqual(commandIssues({ [key]: text }, key), [p.issue], 'commandIssues gives the same issue');
  return p.issue.detail;
}

test('refused: every R11-F1 route (another profile, config file, root or path, the environment, forge by path, env -u), named by its token', () => {
  // Round 11: a profile that moves out/ and cache/; round 12: the poison removed and forge called by its path.
  refused('testFiles', 'FOUNDRY_PROFILE=ci forge test --match-path $FILES', 'FOUNDRY_PROFILE=ci');
  refused('build', 'env FOUNDRY_PROFILE=ci forge build', 'env');
  refused('test', 'env -u FOUNDRY_CONFIG FOUNDRY_PROFILE=ci /usr/local/bin/forge test', 'env');
  refused('build', 'env -i forge build', 'env');
  refused('build', '/usr/local/bin/forge build', '/usr/local/bin/forge');
  refused('build', './forge build', './forge');
  refused('build', 'bin/forge build', 'bin/forge');
  refused('build', 'FOUNDRY_CONFIG=/tmp/x.toml forge build', 'FOUNDRY_CONFIG=/tmp/x.toml');
  for (const [flag, value] of [
    ['--profile', 'ci'], ['--config-path', 'foundry.toml'], ['--root', '/work'], ['--out', 'ci-out'], ['--cache-path', 'ci-cache'], ['--lib-paths', 'vendor'],
    ['--remappings', 'a=b'], ['--remappings-env', 'X'], ['--contracts', 'src2'], ['--build-info-path', 'x'], ['--use', '0.8.20'], ['--evm-version', 'cancun'],
    ['--optimize', 'true'], ['--via-ir', null], ['--force', null], ['--offline', null], ['--hardhat', null], ['--hh', null], ['--no-cache', null], ['--ffi', null]
  ]) {
    for (const key of ['build', 'test', 'testFiles', 'testIds']) {
      const base = { build: 'forge build', test: 'forge test', testFiles: 'forge test --match-path $FILES', testIds: 'forge test --match-test $TEST_IDS' }[key];
      refused(key, `${base} ${flag}${value === null ? '' : ` ${value}`}`, flag);
      if (value !== null) refused(key, `${base} ${flag}=${value}`, `${flag}=${value}`);
    }
  }
});

test('refused: hidden flag aliases (absent from --help) and any flag the allowlist does not name; the runner\'s own flags', () => {
  // Round 12: --compiler-version is forge 1.8.5's hidden alias of --use. An allowlist needs no list of aliases.
  const hidden = refused('test', 'forge test --compiler-version /work/toolchain/solc', '--compiler-version');
  assert.match(hidden, /configuration/);
  for (const flag of ['--jobs', '--threads', '--verbosity', '--gas-report', '--json', '--md', '--rerun', '--allow-failure', '--fail-fast', '--list', '--debug',
    '--symbolic', '--symbolic-solver-command', '--fork-url', '--rpc-url', '--watch', '--decode-internal', '--fuzz-input-file', '--no-match-coverage',
    '--match', '--match-tes', '--isolate-x', '--', '---match-test']) {
    refused('test', `forge test ${flag}`, flag);
  }
  assert.match(refused('testFiles', 'forge test --match-path $FILES --junit', '--junit'), /the runner adds it itself/);
  assert.match(refused('testIds', 'forge test --match-test $TEST_IDS --fuzz-seed 0x1', '--fuzz-seed'), /the runner adds it itself/);
  refused('test', 'forge test --fuzz-seed=0x1', '--fuzz-seed=0x1');
});

test('refused: short options and short-option clusters (forge\'s -o, -C, -R, -q, -j …), and verbosity beyond -vvvvv or twice', () => {
  for (const flag of ['-o', '-C', '-R', '-q', '-j', '-w', '-r', '-s', '-l', '-D', '-h', '-V', '-x']) refused('test', `forge test ${flag} x`, flag);
  for (const flag of ['-oout', '-vC', '-vvo', '-Csrc', '-Ra=b', '-vq', '-vvvvvv', '-']) refused('test', `forge test ${flag}`, flag);
  refused('test', 'forge test -v -vv', '-vv');
  refused('build', 'forge build -vvv', '-vvv');
});

test('refused: each shell metacharacter class outside a quoted value, a line break or control character anywhere', () => {
  const cases = [
    ['build', 'forge build; rm -rf /', 'build;'],
    ['build', 'forge build ;', ';'],
    ['build', 'forge build && echo', '&&'],
    ['build', 'forge build&', 'build&'],
    ['build', 'forge build || true', '||'],
    ['build', 'forge build | tee x', '|'],
    ['build', 'forge build > /tmp/x', '>'],
    ['build', 'forge build 2>&1', '2>&1'],
    ['build', 'forge build < /dev/null', '<'],
    ['build', 'forge build $(id)', '$(id)'],
    ['build', 'forge build `id`', '`id`'],
    ['build', 'forge build $HOME', '$HOME'],
    ['testIds', 'forge test --match-test $TEST_IDS$X', '$TEST_IDS$X'],
    ['testFiles', 'forge test --match-path=$FILES', '--match-path=$FILES'],
    ['test', 'forge test --match-path test/*.t.sol', 'test/*.t.sol'],
    ['test', 'forge test --match-test test_?', 'test_?'],
    ['test', 'forge test --match-test [ab]', '[ab]'],
    ['test', 'forge test --match-test (a)', '(a)'],
    ['test', 'forge test --mt {a,b}', '{a,b}'],
    ['test', 'forge test --mt "a b"', '"a'],
    ['test', 'forge test --mt a\\ b', 'a\\'],
    ['build', 'forge build # comment', '#'],
    ['build', 'forge build ~', '~'],
    ['build', '! forge build', '!'],
    ['test', 'forge test --mt ^test', '^test'],
    ['build', 'forge build\nforge test', 'build\nforge'],
    ['build', 'forge build\r', 'build\r'],
    ['build', 'forge\tbuild', 'forge\tbuild'],
    ['build', 'forge build\u0000', 'build\u0000'],
    ['test', 'forge test --mt café', 'café'],
    ['test', 'forge test --mt \'a\nb\'', '\'a\nb\''],
    ['test', 'forge test --mt \'café\'', '\'café\'']
  ];
  for (const [key, text, token] of cases) refused(key, text, token);
});

test('refused: quoting other than one whole value in single quotes; positional arguments; an environment assignment anywhere', () => {
  refused('test', 'forge test --mt \'abc', '\'abc');
  refused('test', 'forge test --mt=\'a b\'', '--mt=\'a');
  refused('test', 'forge test --mt \'a\'b', '\'a\'b');
  refused('build', '\'forge\' build', '\'forge\'');
  refused('build', 'forge \'build\'', '\'build\'');
  refused('test', 'forge test \'--match-test\' x', '\'--match-test\'');
  refused('test', 'forge test --isolate \'x\'', '\'x\'');
  refused('build', 'forge build src', 'src');
  refused('test', 'forge test test/A.t.sol', 'test/A.t.sol');
  refused('build', 'forge build FOUNDRY_PROFILE=ci', 'FOUNDRY_PROFILE=ci');
  for (const program of ['sh', 'bash', 'exec', 'command', 'nice', 'time', 'timeout', 'xargs', 'make', 'npx', 'cast', 'anvil', 'forge-1.8']) {
    refused('build', `${program} forge build`, program);
  }
});

test('refused: another forge subcommand, or none', () => {
  refused('build', 'forge', 'forge');
  refused('build', 'forge test', 'test');
  refused('test', 'forge build', 'build');
  for (const sub of ['script', 'coverage', 'snapshot', 'config', 'clean', 'install', 'update', 'fmt', 'inspect', 'bind', 'flatten', 'selectors']) {
    refused('test', `forge ${sub}`, sub);
  }
  refused('test', 'forge $FILES', '$FILES');
});

test('refused: values out of their kind (counts, choices, empty or overlong patterns, a value that reads as a flag), a flag given twice', () => {
  refused('test', 'forge test --fuzz-runs 0', '0');
  refused('test', 'forge test --fuzz-runs 1000001', '1000001');
  refused('test', 'forge test --fuzz-runs 01', '01');
  refused('test', 'forge test --fuzz-runs 1e3', '1e3');
  refused('test', 'forge test --fuzz-runs=-1', '-1');
  refused('test', 'forge test --fuzz-runs', '--fuzz-runs');
  refused('test', 'forge test --fuzz-runs -vv', '--fuzz-runs');
  refused('test', 'forge test --fuzz-runs=', '--fuzz-runs=');
  refused('build', 'forge build --skip tests', 'tests');
  refused('build', 'forge build --skip \'*.t.sol\'', '\'*.t.sol\'');
  refused('build', 'forge build --skip test --skip script', '--skip');
  refused('test', 'forge test --match-test', '--match-test');
  refused('test', 'forge test --match-test \'\'', '\'\'');
  refused('test', `forge test --match-test ${'a'.repeat(513)}`, 'a'.repeat(513));
  refused('test', 'forge test --mt a --match-test b', '--match-test');
  refused('test', 'forge test --isolate --isolate', '--isolate');
  refused('test', 'forge test --isolate=true', '--isolate=true');
});

test('placeholders: only where the runner fills them, only unquoted, and required where the runner needs them (COMMAND_PLACEHOLDER)', () => {
  refused('build', 'forge build $FILES', '$FILES');
  refused('test', 'forge test --match-path $FILES', '$FILES');
  refused('testFiles', 'forge test --match-test $FILES', '--match-test');
  refused('testFiles', 'forge test --match-path $TEST_IDS', '$TEST_IDS');
  refused('testFiles', 'forge test --match-path $FILES --match-test $TEST_IDS', '--match-test');
  refused('testIds', 'forge test --match-test $FILES', '$FILES');
  refused('testFiles', 'forge test --match-path \'$FILES\'', '\'$FILES\'');
  refused('testFiles', 'forge test --match-path test/Exploit.t.sol', 'test/Exploit.t.sol');
  refused('testIds', 'forge test --match-test $TEST_IDS --match-path test/A.t.sol', 'test/A.t.sol');
  // In the PoC's runs the runner chooses the tests: no other filter.
  for (const flag of ['--no-match-test', '--no-match-path', '--match-contract', '--no-match-contract', '--nmc', '--mc']) {
    refused('testFiles', `forge test --match-path $FILES ${flag} x`, flag);
    refused('testIds', `forge test --match-test $TEST_IDS ${flag} x`, flag);
  }
  for (const [key, text] of [['testFiles', 'forge test'], ['testFiles', 'forge test -vv'], ['testIds', 'forge test --match-path $FILES']]) {
    const p = parseCommand(key, text);
    assert.equal(p.ok, false);
    assert.equal(p.issue.code, 'COMMAND_PLACEHOLDER', text);
  }
});

test('missing or over-long commands keep their own codes; every parse is total (no exception) on hostile input', () => {
  for (const v of [undefined, null, '', '   ', 7, {}, ['forge', 'build']]) assert.equal(parseCommand('build', v).issue.code, 'COMMAND_MISSING', JSON.stringify(v));
  assert.equal(parseCommand('build', `forge build ${' '.repeat(2000)}`).issue.code, 'COMMAND_INVALID');
  assert.throws(() => parseCommand('setup', 'forge build'), /no forge command/, 'setup is not parsed: it runs only when the image is built');
  const alphabet = ['forge', 'build', 'test', ' ', '\'', '$FILES', '$TEST_IDS', '--mt', '-v', '=', ';', '\n', 'x', '--skip', '--fuzz-runs', '1', 'é', '"', '\\'];
  let seed = 7;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  for (let i = 0; i < 5000; i += 1) {
    let s = '';
    const len = rnd(12);
    for (let k = 0; k < len; k += 1) s += alphabet[rnd(alphabet.length)];
    for (const key of Object.keys(COMMANDS)) {
      const p = parseCommand(key, s);
      if (p.ok) {
        // Whatever parses, forge gets only the subcommand, allowlisted flags and their values, one element each.
        const a = forgeArgs(p, VALUES);
        assert.equal(a[0], COMMANDS[key].subcommand);
        for (const x of a.slice(1)) {
          const name = x.startsWith('--') ? x.split('=')[0] : x;
          assert.ok(/^-v{1,5}$/.test(x) || COMMANDS[key].flags.includes(name), `${key}: ${JSON.stringify(s)} -> ${x}`);
        }
      } else {
        assert.ok(['COMMAND_NOT_ALLOWED', 'COMMAND_MISSING', 'COMMAND_INVALID', 'COMMAND_PLACEHOLDER'].includes(p.issue.code));
      }
    }
  }
});

test('the allowlists are what the PR states: build --skip test|script; test the matching filters, -v…-vvvvv, --fuzz-runs, --isolate; the PoC runs only their placeholders', () => {
  assert.deepEqual(COMMANDS.build.flags, ['--skip']);
  assert.deepEqual(FLAGS['--skip'].choices, ['test', 'script']);
  assert.deepEqual(COMMANDS.test.flags, ['--match-test', '--no-match-test', '--match-contract', '--no-match-contract', '--match-path', '--no-match-path', '--fuzz-runs', '--isolate']);
  assert.deepEqual(COMMANDS.testFiles.flags, ['--match-path', '--fuzz-runs', '--isolate']);
  assert.deepEqual(COMMANDS.testIds.flags, ['--match-test', '--match-path', '--fuzz-runs', '--isolate']);
  assert.equal(FLAGS['--fuzz-runs'].max, 1000000);
  for (const key of ['test', 'testFiles', 'testIds']) assert.equal(COMMANDS[key].verbosity, true);
  assert.equal(COMMANDS.build.verbosity, false);
  // Nothing in any allowlist sets a path, a profile, the compiler or forge's report.
  for (const f of Object.keys(FLAGS)) assert.ok(!/out|path$|root|profile|config|use|remap|lib|contracts|junit|seed|json/.test(f.replace('--match-path', '').replace('--no-match-path', '')), f);
});

test('tokenize: spaces separate; a whole single-quoted token is one value; the placeholders are whole tokens', () => {
  const t = tokenize('forge  test --mt \'a b\' $FILES ${TEST_IDS} x;y');
  assert.deepEqual(t.map((x) => [x.text, x.quoted, x.placeholder, x.bad]), [
    ['forge', false, null, null], ['test', false, null, null], ['--mt', false, null, null], ['a b', true, null, null], ['$FILES', false, 'FILES', null],
    ['${TEST_IDS}', false, 'TEST_IDS', null], ['x;y', false, null, 'a command separator, `&` or a pipe']
  ]);
});
