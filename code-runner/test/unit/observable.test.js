'use strict';

// Node A3d. What finding.json names (src/observable.js), by the rule a design review set under owner decision Q38: both
// fields are text, a word that is exactly one of forge's test-function prefixes names nothing unless the patch added a
// test of that name, and every other identifier is read wherever it is. Found on real repositories: a baseline test named
// `test()` (a fixture's coverage marker) made the word in `forge test` a test the finding names, so a valid PoC settled
// INVALID with the bond forfeited.

const test = require('node:test');
const assert = require('node:assert/strict');
const { claimedObservable, functionName } = require('../../src/observable');
const { TEST_FUNCTION_PREFIXES } = require('../../src/forge');

const MESSAGE = 'vault drained';
const addedTest = (name) => ({ id: `test/Exploit.t.sol > ExploitTest > ${name}()`, messages: [MESSAGE, MESSAGE, MESSAGE], recorded: [MESSAGE, MESSAGE, MESSAGE] });
const tests = [addedTest('test_drain')];
/** A listing's tests: every word the rule is about, and an ordinary test. */
const BASELINE = [...TEST_FUNCTION_PREFIXES, 'test_deposit'];
const OBSERVABLE = 'test_drain fails at the committed hash with "vault drained"';

function run(command, observable = OBSERVABLE, { added = tests, known = BASELINE } = {}) {
  return claimedObservable({ finding: { poc: { command, observable } }, tests: added, knownNames: known });
}

function assertNames(r, name) {
  assert.equal(r.status, 'fail', r.detail);
  assert.match(r.detail, new RegExp(`names ${name.replace(/\$/g, '\\$')}, which is not a test the patch added that failed`));
  assert.ok(r.named.includes(name), JSON.stringify(r.named));
}

// A valid PoC on a listing with a baseline test named test() reaches the jury.
for (const [what, command] of [
  ['the plain command', 'forge test --match-test test_drain'],
  ['a plain forge test', 'forge test'],
  ['the word as a filter', 'forge test --mt test'],
  ['the word as a filter, with =', 'forge test --mt=test'],
  ['the word as an anchored filter', 'forge test --mt \'^test$\''],
  ['a path', 'forge test --match-path test/x.t.sol'],
  ['a path and a filter', 'forge test --match-path test/x.t.sol --match-test test_drain'],
  ['forge\'s shorthand for a path', 'forge test test/x.t.sol'],
  ['another directory first', 'cd x && forge test'],
  ['a directory called test first', 'cd test && forge test'],
  ['an environment variable', 'FOUNDRY_PROFILE=x forge test'],
  ['a flag the listing\'s grammar refuses', 'forge test --mt test_drain --json'],
  ['a substitution', 'forge test --fork-url $(cat url) --match-path test/x.t.sol'],
  ['a build first', 'forge build --skip test && forge test'],
  ['every word at once', 'forge test --match-path \'test/my test/x.t.sol\' --match-contract ExploitTest --no-match-test x --fuzz-runs 256 --isolate -vvvvv']
]) {
  test(`A3d: a word that is one of forge's prefixes names nothing in the command: ${what}`, () => {
    const r = run(command);
    assert.equal(r.status, 'pass', `${command}: ${r.detail}`);
    assert.deepEqual(r.named, ['test_drain']);
  });
}

// The same in prose.
for (const [what, observable] of [
  ['test', 'test_drain: the test fails with "vault drained"'],
  ['test, called', 'test_drain and test() fail with "vault drained"'],
  ['check', 'test_drain: the check fails with "vault drained"'],
  ['invariant', 'test_drain: the invariant fails with "vault drained"'],
  ['table', 'test_drain: the table is wrong: "vault drained"'],
  ['prove', 'test_drain: these prove it: "vault drained"'],
  ['statefulFuzz', 'test_drain: statefulFuzz fails with "vault drained"']
]) {
  test(`A3d: a word that is one of forge's prefixes names nothing in the observable: ${what}`, () => {
    const r = run('forge test', observable);
    assert.equal(r.status, 'pass', r.detail);
    assert.deepEqual(r.named, ['test_drain']);
  });
}

test('A3d: each prefix is named exactly, and only that word: a longer name is a test', () => {
  for (const prefix of TEST_FUNCTION_PREFIXES) {
    assert.equal(run(`forge test --mt ${prefix}`).status, 'pass', prefix);
    assert.equal(run('forge test', `test_drain: ${prefix} fails with "vault drained"`).status, 'pass', prefix);
    const longer = `${prefix}_x`;
    assertNames(run(`forge test --mt ${longer}`, OBSERVABLE, { known: [longer] }), longer);
    assertNames(run('forge test', `test_drain and ${longer} fail with "vault drained"`, { known: [longer] }), longer);
    // Case and spelling are the text's: `Test` is no test here, and no prefix either.
    assert.equal(run(`forge test --mt ${prefix.toUpperCase()}`).status, 'pass', prefix);
  }
});

// The review focus: a finding that names the wrong test and still passes. In either field, wherever the text spells it.
for (const [what, command] of [
  ['--match-test', 'forge test --match-test test_deposit'],
  ['--mt', 'forge test --mt test_deposit'],
  ['with =', 'forge test --match-test=test_deposit'],
  ['quoted', 'forge test --match-test \'test_deposit\''],
  ['double-quoted', 'forge test --match-test "test_deposit"'],
  ['anchored', 'forge test --match-test \'^test_deposit$\''],
  ['beside the added test', 'forge test --match-test \'test_drain|test_deposit\''],
  ['--no-match-test', 'forge test --no-match-test test_deposit'],
  ['--match-contract', 'forge test --match-contract test_deposit'],
  ['as a path', 'forge test --match-path test_deposit'],
  ['inside a path', 'forge test --match-path test/test_deposit/x.t.sol'],
  ['as an argument', 'forge test test_deposit'],
  ['as a flag forge does not have', 'forge test --test_deposit'],
  ['after a separator', 'forge test;forge test --mt test_deposit'],
  ['inside a substitution', 'forge test --mt $(printf test_deposit)'],
  ['inside ANSI-C quoting', 'forge test --mt $\'test_drain|\\\' --mp test_deposit\''],
  ['after a quote left open', 'forge test --mt \'test_drain test_deposit'],
  ['in another command', 'npx hardhat test --grep test_deposit']
]) {
  test(`A3d: a finding naming another baseline test fails, in the command: ${what}`, () => {
    assertNames(run(command), 'test_deposit');
  });
}

for (const [what, observable] of [
  ['as the subject', 'test_deposit fails with "vault drained"'],
  ['beside the added test', 'test_drain and test_deposit fail with "vault drained"'],
  ['called', 'VaultTest.test_deposit() reverts, then test_drain fails with "vault drained"'],
  ['in a quote', 'test_drain fails with "vault drained" in "test_deposit"']
]) {
  test(`A3d: a finding naming another baseline test fails, in the observable: ${what}`, () => {
    assertNames(run('forge test', observable), 'test_deposit');
  });
}

test('A3d: a command that says only forge test, and no added name, names nothing', () => {
  for (const [command, observable] of [
    ['forge test', 'the vault is drained in one call: "vault drained"'],
    ['forge test --mt test', 'the test fails: "vault drained"'],
    ['forge test --match-path test/x.t.sol', 'the invariant is broken: "vault drained"']
  ]) {
    const r = run(command, observable);
    assert.equal(r.status, 'fail', command);
    assert.match(r.detail, /names none of the tests the patch added \(test_drain\)/);
    assert.deepEqual(r.named, []);
  }
});

test('A3d: a test the patch added is named wherever the text spells it, and a prefix that is one counts', () => {
  const own = [addedTest('test')];
  for (const [command, observable] of [
    ['forge test', 'fails with "vault drained"'],
    ['forge test --match-path test/x.t.sol', 'fails with "vault drained"'],
    ['forge build', 'the test fails with "vault drained"']
  ]) {
    const r = run(command, observable, { added: own });
    assert.equal(r.status, 'pass', `${command}: ${r.detail}`);
    assert.deepEqual(r.named, ['test']);
  }
  // Nowhere in the text: nothing is named.
  assert.match(run('forge build', 'fails with "vault drained"', { added: own }).detail, /names none of the tests/);
  // Beside another test the patch added: its message must be the one quoted, as ever.
  const both = [addedTest('test'), { id: 'test/Exploit.t.sol > ExploitTest > test_drain()', messages: ['other', 'other', 'other'], recorded: ['other', 'other', 'other'] }];
  assert.deepEqual(run('forge test', 'test_drain fails with "other"', { added: both }).named, ['test', 'test_drain']);
  // A name in a path counts for an added test, as at the base.
  assert.deepEqual(run('forge test --mp test/test_drain.t.sol', 'fails with "vault drained"').named, ['test_drain']);
});

test('A3d R11-F1: `$` in the observable belongs to the identifier; in the command it is also a regex\'s end', () => {
  const added = [addedTest('test_balance$')];
  const baseline = ['test', 'test_balance', 'test_base'];
  // An added test_balance$ beside a baseline test_balance, named in the observable.
  const named = run('forge test', 'test_balance$() fails with "vault drained"', { added, known: baseline });
  assert.equal(named.status, 'pass', named.detail);
  assert.deepEqual(named.named, ['test_balance$']);
  // A baseline test anchored in the command.
  assertNames(run('forge test --mt \'^test_base$\'', OBSERVABLE, { known: baseline }), 'test_base');
  assertNames(run('forge test --mt=^test_base$', OBSERVABLE, { known: baseline }), 'test_base');
  // An added test anchored in the command is named by it.
  const anchored = run('forge test --mt \'^test_drain$\'', 'fails with "vault drained"');
  assert.equal(anchored.status, 'pass', anchored.detail);
  assert.deepEqual(anchored.named, ['test_drain']);
  // In the command it counts as itself too: a name ending in `$` is also the name before it, so this one names both.
  const both = run('forge test --mt test_balance$', 'fails with "vault drained"', { added, known: baseline });
  assert.deepEqual(both.named, ['test_balance', 'test_balance$']);
  assertNames(both, 'test_balance');
});

test('A3d: a shell is out of scope: a name counts when it is spelled, and nothing is evaluated', () => {
  // Spelled in pieces or built at run time: not read, by the rule. The gate still needs the added test's failure quoted.
  for (const command of ['forge test --mt te""st_deposit', 'forge test --mt $(printf te; printf st_deposit)', 'forge test --mt \'test_dep.*\'']) {
    assert.equal(run(command).status, 'pass', command);
  }
});

test('A3d: what passed before still passes, but for a baseline test anchored in the command', () => {
  const before = (command, observable, known, added) => {
    const tokens = new Set([...`${command}\n${observable}`.matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/g)].map((m) => m[0]));
    const names = new Set([...known, ...added.map((t) => functionName(t.id))]);
    return [...tokens].filter((t) => names.has(t)).sort();
  };
  const commands = ['forge test', 'forge test --mt test_drain', 'forge test --mt test', 'forge test --mt test_deposit', 'forge test --mp test/test_drain.t.sol', 'cd x && forge test', '', 'test_drain'];
  const observables = [OBSERVABLE, 'fails with "vault drained"', 'test_drain shows "no such text"', 'test_deposit fails with "vault drained"', 'test: "vault drained"', 'test_drain: the test fails with "vault drained"'];
  for (const command of commands) {
    for (const observable of observables) {
      const now = run(command, observable);
      const old = before(command, observable, BASELINE, tests);
      const otherWords = old.filter((n) => n !== 'test_drain' && !TEST_FUNCTION_PREFIXES.includes(n));
      // A prefix never makes the difference, so only an ordinary name or a missing quote can fail it.
      if (otherWords.length) assert.equal(now.status, 'fail', `${command} ${observable}`);
      if (now.status === 'pass') {
        assert.ok(old.includes('test_drain'), `${command} ${observable}`);
        assert.deepEqual(now.named, ['test_drain']);
      }
    }
  }
});

test('A3d: a finding with no text to read still fails closed', () => {
  assert.equal(claimedObservable({ finding: {}, tests, knownNames: BASELINE }).status, 'fail');
  assert.equal(claimedObservable({ finding: { poc: { command: 'forge test --mt test_drain' } }, tests, knownNames: BASELINE }).status, 'fail');
  // No command: the observable alone can name the test.
  assert.equal(claimedObservable({ finding: { poc: { observable: OBSERVABLE } }, tests, knownNames: BASELINE }).status, 'pass');
  assert.equal(claimedObservable({ finding: { poc: { command: 42, observable: OBSERVABLE } }, tests, knownNames: BASELINE }).status, 'pass');
});
