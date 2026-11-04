'use strict';

// Node A3d. What finding.json names (src/observable.js): the words of the forge command are not test names, and a
// finding that names another test still fails, however it is phrased. Found on real repositories: a baseline test named
// `test()` (a fixture's coverage marker) made the word in `forge test` a test the finding names, so a valid PoC settled
// INVALID with the bond forfeited.

const test = require('node:test');
const assert = require('node:assert/strict');
const { claimedObservable, functionName } = require('../../src/observable');

const ADDED = 'test/Exploit.t.sol > ExploitTest > test_drain()';
const MESSAGE = 'vault drained';
const tests = [{ id: ADDED, messages: [MESSAGE, MESSAGE, MESSAGE], recorded: [MESSAGE, MESSAGE, MESSAGE] }];
/** Every word a forge command is made of as a baseline test, besides the fixture's `test()` and an ordinary test. */
const BASELINE = ['test', 'test_deposit', 'forge', 'match', 'path', 'contract', 'no', 'mt', 'mp', 'mc', 'nmt', 'nmp', 'nmc', 'fuzz', 'runs', 'isolate', 'skip', 'script', 'build', 'v', 'vvv', 't', 'sol', 'invariant', 'check'];
const OBSERVABLE = 'test_drain fails at the committed hash with "vault drained"';

function run(command, observable = OBSERVABLE, { added = tests, known = BASELINE } = {}) {
  return claimedObservable({ finding: { poc: { command, observable } }, tests: added, knownNames: known });
}

/** The rule before A3d: every identifier of both texts. A valid finding it passed must still pass. */
function namedBefore(command, observable, known, added) {
  const tokens = new Set([...`${command}\n${observable}`.matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/g)].map((m) => m[0]));
  const names = new Set([...known, ...added.map((t) => functionName(t.id))]);
  return [...tokens].filter((t) => names.has(t)).sort();
}

// The first acceptance's other half: a valid PoC on a listing with a baseline test named test() reaches the jury.
const OWN_WORDS = [
  ['the plain command', 'forge test --match-test test_drain'],
  ['an alias', 'forge test --mt test_drain'],
  ['with =', 'forge test --match-test=test_drain'],
  ['an anchored regex', 'forge test --match-test \'^test_drain$\''],
  ['a path', 'forge test --match-path test/Exploit.t.sol --match-test test_drain'],
  ['a path alias', 'forge test --mp test/Exploit.t.sol --mt test_drain'],
  ['a path with =', 'forge test --match-path=test/Exploit.t.sol --mt test_drain'],
  ['a quoted glob', 'forge test --match-path \'test/**/*.t.sol\' --mt test_drain'],
  ['a path with a space', 'forge test --match-path \'test/my test/Exploit.t.sol\' --mt test_drain'],
  ['a path with a space, double-quoted', 'forge test --mp "test/my test/Exploit.t.sol" --mt test_drain'],
  ['a path with a space, with =', 'forge test --match-path=\'test/my test/Exploit.t.sol\' --mt test_drain'],
  ['a path to skip', 'forge test --no-match-path test/invariant/Old.t.sol --mt test_drain'],
  ['a contract', 'forge test --match-contract ExploitTest --match-test test_drain'],
  ['every switch', 'forge test --match-test test_drain --fuzz-runs 256 --isolate -vvvvv'],
  ['verbosity first', 'forge test -vvv --match-test test_drain'],
  ['a line break', 'forge test\n  --match-test test_drain'],
  ['two spaces', 'forge  test   --match-test   test_drain'],
  // Outside the listing's grammar: poc.command is the hunter's text, and the runner never runs it.
  ['a flag the grammar refuses', 'forge test --match-test test_drain --json'],
  ['an environment variable', 'FOUNDRY_PROFILE=ci forge test --mt test_drain'],
  ['a directory first', 'cd contracts && forge test --mt test_drain'],
  ['a build first', 'forge build --skip test && forge test --mt test_drain'],
  // Named only in the observable.
  ['no filter at all', 'forge test'],
  ['the path alone', 'forge test --match-path test/Exploit.t.sol']
];

for (const [label, command] of OWN_WORDS) {
  test(`the words of the forge command are not test names: ${label}`, () => {
    const r = run(command);
    assert.equal(r.status, 'pass', `${command}: ${r.detail}`);
    assert.deepEqual(r.named, ['test_drain']);
  });
}

// The review focus: a finding that names the wrong test and still passes. Each still fails, naming the test.
const NAMES_ANOTHER = [
  ['--match-test', 'forge test --match-test test_deposit', 'test_deposit'],
  ['--mt', 'forge test --mt test_deposit', 'test_deposit'],
  ['--match-test=', 'forge test --match-test=test_deposit', 'test_deposit'],
  ['--mt=', 'forge test --mt=test_deposit', 'test_deposit'],
  ['a quoted value', 'forge test --match-test \'test_deposit\'', 'test_deposit'],
  ['a double-quoted value', 'forge test --match-test "test_deposit"', 'test_deposit'],
  ['an anchored regex', 'forge test --match-test \'^test_deposit$\'', 'test_deposit'],
  ['an anchored regex, double-quoted', 'forge test --mt "^test_deposit$"', 'test_deposit'],
  ['an anchored regex, with =', 'forge test --mt=\'^test_deposit$\'', 'test_deposit'],
  ['a regex beside the added test', 'forge test --match-test \'test_drain|test_deposit\'', 'test_deposit'],
  // R1-F1: words inside a quoted value are not flags, so none can swallow the word after it.
  ['a flag inside a quoted value', 'forge test --match-test \'test_drain|(?: --match-path )?test_deposit\'', 'test_deposit'],
  ['a flag inside a double-quoted value', 'forge test --match-test "test_drain|(?: --match-path )?test_deposit"', 'test_deposit'],
  ['a flag inside a quoted value, with =', 'forge test --mt=\'test_drain|(?: --mp )?test_deposit\'', 'test_deposit'],
  ['a quoted word that spells a flag', 'forge test \'--match-path\' test_deposit', 'test_deposit'],
  ['a quote that never closes', 'forge test --match-test \'test_drain --match-path test/x.sol test_deposit', 'test_deposit'],
  ['--no-match-test', 'forge test --no-match-test test_deposit', 'test_deposit'],
  ['--nmt=', 'forge test --nmt=test_deposit', 'test_deposit'],
  ['--match-contract', 'forge test --match-contract test_deposit', 'test_deposit'],
  ['--no-match-contract', 'forge test --nmc test_deposit', 'test_deposit'],
  ['the fixture\'s test, as the value of --match-test', 'forge test --match-test test', 'test'],
  ['the fixture\'s test, with =', 'forge test --mt=test', 'test'],
  ['a test name as an argument', 'forge test test_deposit', 'test_deposit'],
  ['a test name as a flag forge does not have', 'forge test --test_deposit', 'test_deposit'],
  ['a test name as the value of a flag forge does not have', 'forge test --only=test_deposit', 'test_deposit'],
  ['a test name after a switch that takes none', 'forge test --isolate=test_deposit', 'test_deposit'],
  ['a test name as the value of a switch', 'forge test --isolate test_deposit', 'test_deposit'],
  ['a test name as a count', 'forge test --fuzz-runs test_deposit', 'test_deposit'],
  ['a test name as a choice', 'forge test --skip test_deposit', 'test_deposit'],
  ['the words twice', 'forge test test', 'test'],
  ['forge alone', 'forge --match-test test', 'test'],
  ['test before forge', 'test forge test', 'test'],
  ['a path flag followed by a filter, not its value', 'forge test --match-path --match-test test_deposit', 'test_deposit'],
  ['another command', 'npx hardhat test', 'test']
];

for (const [label, command, name] of NAMES_ANOTHER) {
  test(`a finding that names another test fails: ${label}`, () => {
    // A real baseline: the fixture's marker and an ordinary test (a function called `match` is not a forge test).
    const r = run(command, OBSERVABLE, { known: ['test', 'test_deposit'] });
    assert.equal(r.status, 'fail', `${command}: ${r.detail}`);
    assert.match(r.detail, new RegExp(`names ${name}, which is not a test the patch added that failed`));
    assert.ok(r.named.includes(name));
  });
}

test('the observable is read whole: a test named there fails, whatever the command says', () => {
  for (const observable of [
    'test_deposit fails with "vault drained"',
    'test_drain and test_deposit fail with "vault drained"',
    'test() fails with "vault drained", as test_drain does',
    'VaultTest.test_deposit() reverts, then test_drain fails with "vault drained"'
  ]) {
    const r = run('forge test --match-test test_drain', observable);
    assert.equal(r.status, 'fail', observable);
    assert.match(r.detail, /which is not a test the patch added that failed/);
  }
});

test('the observable\'s own word is still a name: a known limit, for the owner (the hunter tool warns of it)', () => {
  // `test` in prose reads as the baseline's test() today. This node changes only how the command is read.
  const r = run('forge test --match-test test_drain', 'test_drain: the test fails with "vault drained"');
  assert.equal(r.status, 'fail');
  assert.match(r.detail, /names test, which is not a test the patch added that failed/);
});

test('naming nothing still fails: the words of the command name no test on their own', () => {
  const r = run('forge test', 'the vault is drained in one call: "vault drained"');
  assert.equal(r.status, 'fail');
  assert.match(r.detail, /names none of the tests the patch added \(test_drain\)/);
  assert.deepEqual(r.named, []);
});

test('a test the patch added is named wherever the command says it: nothing that passed before fails now', () => {
  // An added test called test() and a plain `forge test`, or an added test's name inside a path: both passed before A3d.
  const own = 'test/Exploit.t.sol > ExploitTest > test()';
  const added = [{ id: own, messages: [MESSAGE, MESSAGE, MESSAGE], recorded: [MESSAGE, MESSAGE, MESSAGE] }];
  const plain = run('forge test', 'fails with "vault drained"', { added });
  assert.equal(plain.status, 'pass', plain.detail);
  assert.deepEqual(plain.named, ['test']);
  const inPath = run('forge test --match-path test/test_drain.t.sol', 'fails with "vault drained"');
  assert.equal(inPath.status, 'pass', inPath.detail);
  assert.deepEqual(inPath.named, ['test_drain']);
});

test('the fix only turns a failure into a pass, where the other name was a word of the command (an anchored name apart)', () => {
  const observables = [OBSERVABLE, 'fails with "vault drained"', 'test_drain shows "no such text"', 'test_deposit fails with "vault drained"', 'test: "vault drained"'];
  const commands = [...OWN_WORDS.map(([, c]) => c), ...NAMES_ANOTHER.map(([, c]) => c), 'forge test --mp test/test_drain.t.sol', ''];
  for (const command of commands) {
    for (const observable of observables) {
      const now = run(command, observable);
      // The verdict the rule before gave, on this finding.
      const before = namedBefore(command, observable, BASELINE, tests);
      const otherBefore = before.filter((n) => n !== 'test_drain');
      const namesAdded = before.includes('test_drain');
      if (now.status === 'pass') {
        // Nothing new is named: what it passes on is a test the patch added (`$`, the regex's end, was read as part of it).
        assert.ok(namesAdded || /\$/.test(command), `${JSON.stringify(command)} ${JSON.stringify(observable)}`);
        assert.deepEqual(now.named, ['test_drain']);
      }
      if (otherBefore.length === 0 && namesAdded && /"vault drained"/.test(observable)) {
        assert.equal(now.status, 'pass', `passed before: ${JSON.stringify(command)} ${JSON.stringify(observable)}: ${now.detail}`);
      }
      if (now.status === 'fail' && /names .*, which is not/.test(now.detail)) {
        // Named by the text that can name: never a word only the command's own grammar put there.
        const other = /names (\S+), which/.exec(now.detail)[1];
        if (!/\$/.test(command)) assert.ok(otherBefore.includes(other), `${other} was not named before: ${JSON.stringify(command)}`);
      }
    }
  }
});

test('a finding with no text to read still fails closed', () => {
  assert.equal(claimedObservable({ finding: {}, tests, knownNames: BASELINE }).status, 'fail');
  assert.equal(claimedObservable({ finding: { poc: { command: 'forge test --mt test_drain' } }, tests, knownNames: BASELINE }).status, 'fail');
  // No command: the observable alone can name the test.
  assert.equal(claimedObservable({ finding: { poc: { observable: OBSERVABLE } }, tests, knownNames: BASELINE }).status, 'pass');
  assert.equal(claimedObservable({ finding: { poc: { command: 42, observable: OBSERVABLE } }, tests, knownNames: BASELINE }).status, 'pass');
});

test('an anchored regex names the test it anchors: the only thing this node adds to what can name one', () => {
  const r = run('forge test --match-test \'^test_drain$\'', 'fails with "vault drained"');
  assert.equal(r.status, 'pass', r.detail);
  assert.deepEqual(r.named, ['test_drain']);
  // A filter is not evaluated: only what is spelled counts, with or without its end.
  assert.equal(run('forge test --match-test \'test_d.*\'', 'fails with "vault drained"').status, 'fail');
  assert.equal(run('forge test --match-test \'^test_de.*$\'').status, 'pass');
});

test('the rule does not read object keys as flags', () => {
  // Words a plain object answers to must not be taken for flags of the grammar.
  for (const command of ['forge test --constructor', 'forge test --__proto__ test_deposit', 'forge test --toString=test_deposit']) {
    const r = run(command, 'test_drain fails with "vault drained"');
    assert.ok(['pass', 'fail'].includes(r.status));
    if (command.includes('test_deposit')) assert.equal(r.status, 'fail', command);
  }
});
