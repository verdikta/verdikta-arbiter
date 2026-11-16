'use strict';

// A7b: "no third-party text is committed" is a check, not a promise. These hold the check itself; the run compares each
// real claim with the real repository and report.

const test = require('node:test');
const assert = require('node:assert/strict');
const { tokens, indexTexts, longestSharedRun, htmlToText, claimProblems, LIMITS } = require('../../calibration/lib/provenance');

const THEIRS = 'The boundary handling compares the old tier count against the new tier count and only updates the rank at the old boundary so a staker who should move up is left behind in the lower tier forever';

test('tokens are words and identifiers, without case, punctuation or layout', () => {
  assert.deepEqual(tokens('assertEq(paid,  Stated, "x_y");\n// Note'), ['asserteq', 'paid', 'stated', 'x_y', 'note']);
});

test('a copied run is measured, whatever its layout or case', () => {
  const index = indexTexts([THEIRS]);
  const words = THEIRS.split(' ');
  const copied = `We found this. ${words.slice(4, 24).join('\n').toUpperCase()}. And more words of our own here.`;
  assert.equal(longestSharedRun(copied, index), 20);
});

test('text of our own shares less than the shortest run measured', () => {
  const index = indexTexts([THEIRS]);
  assert.equal(longestSharedRun('The tier count at the boundary is wrong, so interest is short.', index), 0);
});

test('the shortest run measured is a few words: a shared identifier is not a copy', () => {
  const index = indexTexts(['function claimInterest() external nonReentrant whenNotPaused']);
  assert.equal(longestSharedRun('call claimInterest() and read the balance', index), 0);
});

test('HTML reads as its text', () => {
  assert.equal(htmlToText('<p>One &amp; <b>two</b></p><script>var x = "no";</script><style>p{}</style>three').replace(/\s+/g, ' ').trim(), 'One & two three');
});

function entry(over = {}) {
  return {
    id: 'clear-valid.one',
    claim: { finding: { title: 'Mine', rootCause: 'My words.' }, report: '# Mine\n\nWords of our own.\n', poc: Buffer.from('+contract Mine {}\n') },
    ...over
  };
}

test('a claim of our own has no problem, and each file is held to its limit', () => {
  const sources = { report: indexTexts([THEIRS]), repo: indexTexts(['contract Theirs { function deposit(uint256 amount) external { balance += amount; } }']) };
  const measured = [];
  assert.deepEqual(claimProblems(entry(), sources, { measured }), []);
  assert.equal(measured.length, 3);
  const words = THEIRS.split(' ').slice(0, LIMITS.prose + 1).join(' ');
  const copied = entry({ claim: { ...entry().claim, report: `# Mine\n\n${words}\n` } });
  const problems = claimProblems(copied, sources);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /clear-valid\.one: report\.md shares a run of \d+ tokens with the program's report/);
  assert.ok(!problems[0].includes('boundary handling'), 'the message quotes nothing of theirs');
});

test('a copied finding field and a copied test are caught too, by their own limits', () => {
  const words = THEIRS.split(' ').slice(0, LIMITS.prose + 1).join(' ');
  const sources = { report: indexTexts([THEIRS]), repo: indexTexts([]) };
  assert.match(claimProblems(entry({ claim: { ...entry().claim, finding: { rootCause: words } } }), sources)[0], /finding\.json/);
  const code = Array.from({ length: LIMITS.code + 1 }, (_, i) => `token${i}`).join(' ');
  const codeSources = { report: indexTexts([]), repo: indexTexts([code]) };
  assert.match(claimProblems(entry({ claim: { ...entry().claim, poc: Buffer.from(`+${code}\n`) } }), codeSources)[0], /poc\.patch shares a run of \d+ tokens with the repository/);
  const shorter = Array.from({ length: LIMITS.code - 1 }, (_, i) => `token${i}`).join(' ');
  assert.deepEqual(claimProblems(entry({ claim: { ...entry().claim, poc: Buffer.from(`+${shorter}\n`) } }), codeSources), []);
});
