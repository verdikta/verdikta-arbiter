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
/** A listing's tests: the fixture's coverage marker and an ordinary test. */
const BASELINE = ['test', 'test_deposit'];
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

// The second acceptance: a valid PoC on a listing with a baseline test named test() reaches the jury.
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
  ['parentheses in a path', 'forge test --match-path \'test/unit (old)/Exploit.t.sol\' --mt test_drain'],
  ['an escaped space in a path', 'forge test --match-path test/my\\ test/Exploit.t.sol --mt test_drain'],
  ['a path to skip', 'forge test --no-match-path test/Old.t.sol --mt test_drain'],
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
  ['a quoted choice', 'forge build --skip \'test\' && forge test --mt test_drain'],
  ['a substitution', 'forge test --mt test_drain --fork-url $(cat url)'],
  ['a default in an expansion', 'forge test --mt test_drain --fork-url ${RPC_URL:-http://localhost:8545}'],
  ['backquotes', 'forge test --mt test_drain --fork-url `cat url`'],
  ['ANSI-C quoting', 'forge test --mt $\'^test_drain$\' --match-path test/Exploit.t.sol'],
  ['a path to a program', '/usr/local/bin/forge test --mt test_drain'],
  ['a path inside a directory called test', 'forge test --match-path a/test/Exploit.t.sol --mt test_drain'],
  ['a file called test', 'forge test --match-path test.t.sol --mt test_drain'],
  ['a choice with =', 'forge build --skip=test && forge test --mt test_drain'],
  // Named only in the observable.
  ['no filter at all', 'forge test'],
  ['the path alone', 'forge test --match-path test/Exploit.t.sol']
];

for (const [label, command] of OWN_WORDS) {
  test(`the word test in a command is no test's name: ${label}`, () => {
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
  // R1-F1, R4-F1: every identifier is read, so nothing a shell would do with the words matters.
  ['a flag inside a quoted value', 'forge test --match-test \'test_drain|(?: --match-path )?test_deposit\'', 'test_deposit'],
  ['a flag inside a double-quoted value', 'forge test --match-test "test_drain|(?: --match-path )?test_deposit"', 'test_deposit'],
  ['a flag inside a quoted value, with =', 'forge test --mt=\'test_drain|(?: --mp )?test_deposit\'', 'test_deposit'],
  ['a quoted word that spells a flag', 'forge test \'--match-path\' test_deposit', 'test_deposit'],
  ['a quote that never closes', 'forge test --match-test \'test_drain --match-path test/x.sol test_deposit', 'test_deposit'],
  ['an escaped quote inside a double-quoted value', 'forge test --match-test "test_drain|(?: \\" --match-path )?test_deposit"', 'test_deposit'],
  ['ANSI-C quoting', 'forge test --match-test $\'(?x)test_drain|[\\\' --mp ]{0}[/]?test_deposit \'', 'test_deposit'],
  ['an escaped space', 'forge test --match-test test_drain\\ --match-path\\ test_deposit', 'test_deposit'],
  ['a separator after a path', 'forge test --mt test_drain --mp test/E.t.sol;forge${IFS}test${IFS}--mt${IFS}test_deposit', 'test_deposit'],
  ['a substitution', 'forge test --match-path $(echo test_deposit)', 'test_deposit'],
  ['backquotes', 'forge test --match-path `echo a/test_deposit`', 'test_deposit'],
  ['a default in an expansion', 'forge test --match-path ${X:-"a/ --mp b/test_deposit"}', 'test_deposit'],
  ['a brace expansion', 'forge test --mp {a/,--mt,test_deposit}', 'test_deposit'],
  ['a name as a path', 'forge test --match-path test_deposit', 'test_deposit'],
  ['a name inside a path', 'forge test --match-path a/test_deposit/?', 'test_deposit'],
  ['a name as a path, quoted', 'forge test --mp \'test_deposit\'', 'test_deposit'],
  ['a name as a path, with =', 'forge test --no-match-path=test_deposit', 'test_deposit'],
  ['--no-match-test', 'forge test --no-match-test test_deposit', 'test_deposit'],
  ['--nmt=', 'forge test --nmt=test_deposit', 'test_deposit'],
  ['--match-contract', 'forge test --match-contract test_deposit', 'test_deposit'],
  ['--no-match-contract', 'forge test --nmc test_deposit', 'test_deposit'],
  ['a test name as an argument', 'forge test test_deposit', 'test_deposit'],
  ['a test name as a flag forge does not have', 'forge test --test_deposit', 'test_deposit'],
  ['a test name as the value of a flag forge does not have', 'forge test --only=test_deposit', 'test_deposit'],
  ['a test name after a switch that takes none', 'forge test --isolate=test_deposit', 'test_deposit'],
  ['a test name as the value of a switch', 'forge test --isolate test_deposit', 'test_deposit'],
  ['a test name as a count', 'forge test --fuzz-runs test_deposit', 'test_deposit'],
  ['a test name as a choice', 'forge test --skip test_deposit', 'test_deposit'],
  ['another command', 'npx hardhat test --grep test_deposit', 'test_deposit'],
  // The fixture's own test, where a name is written.
  ['the marker, as the value of --match-test', 'forge test --match-test test', 'test'],
  ['the marker, with =', 'forge test --mt=test', 'test'],
  ['the marker, quoted', 'forge test --match-test \'test\'', 'test'],
  ['the marker, anchored', 'forge test --mt \'^test$\'', 'test'],
  ['the marker, anchored, with =', 'forge test --mt=\'^test$\'', 'test'],
  ['the marker beside the added test', 'forge test --mt \'test_drain|test\'', 'test'],
  ['the marker, ANSI-C quoted', 'forge test --mt $\'test\'', 'test'],
  ['the marker, to --no-match-test', 'forge test --no-match-test test', 'test'],
  ['the marker, to --match-contract', 'forge test --match-contract test', 'test'],
  ['the marker, with no forge test before it', 'forge --match-test test', 'test'],
  // R4-F1, R5-F1: anywhere but the command's own uses, the word counts.
  ['the marker, after a separator', 'forge test --mt test_drain --mp test/E.t.sol;forge${IFS}test${IFS}--mt${IFS}test', 'test'],
  ['the marker, to a quoted flag', 'forge test "--mt" test', 'test'],
  ['the marker, to a flag quoted in part', 'forge test --m\'t\' test', 'test'],
  ['the marker, to a quoted flag, with =', 'forge test \'--mt=test\'', 'test'],
  ['the marker, after = and a hyphen', 'forge test --match-test=-?test', 'test'],
  ['the marker, after a hyphen', 'forge test --mt -?test', 'test'],
  ['the marker, as a filter that reads like a path', 'forge test --mt test/?', 'test'],
  ['the same, quoted', 'forge test --mt \'test/?\'', 'test'],
  ['the same, with =', 'forge test --mt=test/?', 'test'],
  ['the marker, ANSI-C quoted around a path flag', 'forge test --mt $\'(?x)test_drain|[\\\' --mp ]{0}[/]?test \'', 'test'],
  ['the marker, ANSI-C quoted around a comment', 'forge test --mt $\'(?x)test_drain|#\\\' forge \n test \'', 'test'],
  ['the marker, as a word on its own', 'forge test test', 'test'],
  ['the marker, before forge', 'test forge test', 'test'],
  ['the marker, as a path with no slash', 'forge test --match-path test', 'test'],
  ['the marker, as a path with =', 'forge test --mp=test', 'test'],
  ['the marker, as a switch\'s value', 'forge test --isolate=test', 'test'],
  ['the marker, as a count', 'forge test --fuzz-runs test', 'test'],
  ['the marker, as a flag forge does not have', 'forge test --test', 'test'],
  ['the marker, to another program', 'npx hardhat test', 'test'],
  // Only ever a failure: a hunter who writes this is told before committing.
  ['the marker, as a directory to change to', 'cd test && forge test --mt test_drain', 'test']
];

for (const [label, command, name] of NAMES_ANOTHER) {
  test(`a finding that names another test fails: ${label}`, () => {
    const r = run(command);
    assert.equal(r.status, 'fail', `${command}: ${r.detail}`);
    assert.match(r.detail, /names \S+, which is not a test the patch added that failed/);
    assert.ok(r.named.includes(name), JSON.stringify(r.named));
  });
}

test('a path through a directory named like another baseline test reads as naming it: a known limit, only ever a failure, which the hunter tool warns of', () => {
  const r = run('forge test --match-path test/invariant/Exploit.t.sol --mt test_drain', OBSERVABLE, { known: ['test', 'invariant'] });
  assert.equal(r.status, 'fail');
  assert.match(r.detail, /names invariant, which is not a test the patch added that failed/);
  // The filter alone reaches the jury.
  assert.equal(run('forge test --mt test_drain', OBSERVABLE, { known: ['test', 'invariant'] }).status, 'pass');
});

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
  // An added test called test() and a plain `forge test`, and an added test's name inside a path: both passed before A3d.
  const own = 'test/Exploit.t.sol > ExploitTest > test()';
  const added = [{ id: own, messages: [MESSAGE, MESSAGE, MESSAGE], recorded: [MESSAGE, MESSAGE, MESSAGE] }];
  const plain = run('forge test', 'fails with "vault drained"', { added });
  assert.equal(plain.status, 'pass', plain.detail);
  assert.deepEqual(plain.named, ['test']);
  const inPath = run('forge test --match-path test/test_drain.t.sol', 'fails with "vault drained"');
  assert.equal(inPath.status, 'pass', inPath.detail);
  assert.deepEqual(inPath.named, ['test_drain']);
});

test('the fix only turns a failure into a pass, where the other name was the word test (an anchored name apart)', () => {
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
        // Named by the text that can name: nothing the rule before did not read.
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
