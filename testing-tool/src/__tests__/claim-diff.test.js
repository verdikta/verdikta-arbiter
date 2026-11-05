'use strict';

// Node A7d: "what the jury reads is the same under either runtime" is tested by this comparison, on the requests themselves.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { codeReview } = require('@verdikta/common');
const { writeClaimScenario } = require('../../test/helpers/claimFixture');
const { differences, diffExports, diffResults, render } = require('../claim-diff');

let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-diff-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const rehash = (run, report) => ({ ...run, report, reportSha256: codeReview.reportSha256(report) });
const write = (where, id, changeRun) => writeClaimScenario(path.join(dir, where), { id, priors: 0, scenario: { id }, changeRun });

describe('differences', () => {
  test('names each path, and nothing where they agree', () => {
    expect(differences({ a: 1, b: { c: [1, 2] } }, { a: 1, b: { c: [1, 3] } }).map((d) => d.path)).toEqual(['b.c.1']);
    expect(differences({ a: 1 }, { a: 1 })).toEqual([]);
    expect(differences({ a: 1 }, {}).map((d) => d.path)).toEqual(['a']);
  });
});

describe('diffExports', () => {
  test('the same exports are the same', async () => {
    await write('a', 'one');
    await write('b', 'one');
    const result = await diffExports(path.join(dir, 'a'), path.join(dir, 'b'));
    expect(result.ok).toBe(true);
    expect(result.scenarios[0]).toMatchObject({ id: 'one', attachmentsEqual: true, queryEqualButForRunValues: true });
  });

  test('another runtime\'s name is allowed, and said', async () => {
    await write('a', 'one', (run) => rehash(run, { ...run.report, inputs: { ...run.report.inputs, gvisor: 'release-20260921.0' } }));
    await write('b', 'one', (run) => rehash(run, { ...run.report, inputs: { ...run.report.inputs, gvisor: 'runc' } }));
    const result = await diffExports(path.join(dir, 'a'), path.join(dir, 'b'));
    expect(result.ok).toBe(true);
    const found = result.scenarios[0].differences.find((d) => d.path === 'codeReview.report.inputs.gvisor');
    expect(found).toMatchObject({ kind: 'runtime', a: 'release-20260921.0', b: 'runc' });
    expect(render(result)).toContain('codeReview.report.inputs.gvisor: release-20260921.0 / runc');
  });

  test('a pack that differs fails, and its text is not shown', async () => {
    const secret = 'THE-SOURCE-TEXT-OF-A-THIRD-PARTY';
    await write('a', 'one');
    await write('b', 'one', (run) => ({ ...run, contextPack: { ...run.contextPack, files: run.contextPack.files.map((f, i) => (i === 1 ? { ...f, text: `${f.text}\n${secret}` } : f)) } }));
    const result = await diffExports(path.join(dir, 'a'), path.join(dir, 'b'));
    expect(result.ok).toBe(false);
    expect(result.scenarios[0].attachmentsEqual).toBe(false);
    const unexpected = result.scenarios[0].differences.filter((d) => d.kind === 'unexpected');
    expect(unexpected.length).toBeGreaterThan(0);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(render(result)).not.toContain(secret);
    expect(render(result)).toContain('attachments DIFFER');
  });

  test('a gate or a test in the report that differs fails', async () => {
    await write('a', 'one');
    await write('b', 'one', (run) => rehash(run, { ...run.report, diff: { ...run.report.diff, poc: { ...run.report.diff.poc, added: run.report.diff.poc.added + 1 } } }));
    const result = await diffExports(path.join(dir, 'a'), path.join(dir, 'b'));
    expect(result.ok).toBe(false);
    expect(result.scenarios[0].differences.map((d) => d.path)).toContain('codeReview.report.diff.poc.added');
  });

  test('a scenario on one side only fails', async () => {
    await write('a', 'one');
    await write('a', 'two');
    await write('b', 'one');
    const result = await diffExports(path.join(dir, 'a'), path.join(dir, 'b'));
    expect(result.ok).toBe(false);
    expect(result.onlyInA).toEqual(['two']);
    expect(render(result)).toContain('two: only in the first');
  });
});

describe('diffResults', () => {
  const entry = (over = {}) => ({ id: 'c', actual: 'jury', expected: { outcome: 'VALID', class: 'LOW' }, observed: { gates: { build: 'pass' }, packSha256: 'aa', reportSha256: 'x', gateDetails: { build: 'run 1' } }, ...over });
  const file = (...cases) => ({ cases });

  test('the report\'s hash and a gate\'s words name a run, and do not count', () => {
    const other = entry({ observed: { gates: { build: 'pass' }, packSha256: 'aa', reportSha256: 'y', gateDetails: { build: 'run 2' } } });
    expect(diffResults(file(entry()), file(other))).toEqual([]);
  });

  test('a pack, a gate or a settlement that differs is named by its path', () => {
    const other = entry({ actual: 'INVALID', observed: { gates: { build: 'fail' }, packSha256: 'bb', reportSha256: 'x' } });
    expect(diffResults(file(entry()), file(other)).map((d) => d.path).sort()).toEqual(['actual', 'observed.gates.build', 'observed.packSha256']);
  });

  test('a case on one side only is said', () => {
    expect(diffResults(file(entry()), file())).toEqual([{ id: 'c', path: 'only on one side' }]);
  });
});
