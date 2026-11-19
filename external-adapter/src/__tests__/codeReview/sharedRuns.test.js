// Node A4b: the shared run (design §9.2 step 1, build plan A7): one runner call
// per listing CID + bCID + runner and rule versions + a hash of the prior
// findings, however many of the operator's jobs ask.

const { runKey, SharedRuns, priorFindingsHash } = require('../../codeReview/sharedRuns');

const BASE = Object.freeze({
  listingCid: 'QmListing',
  bcid: 'QmClaim',
  runnerVersion: '0.1.0',
  rulesVersion: '2026.10',
  codeClass: 'code-standard',
  priorFindings: Object.freeze([])
});
const prior = (bcid, title = 'A title') => ({ bcid, finding: { title }, report: `report of ${bcid}` });

describe('runKey', () => {
  it('is a hash, the same for the same inputs', () => {
    expect(runKey(BASE)).toMatch(/^[0-9a-f]{64}$/);
    expect(runKey({ ...BASE })).toBe(runKey(BASE));
  });

  it.each([
    ['the listing CID', { listingCid: 'QmOtherListing' }],
    ['the bCID', { bcid: 'QmOtherClaim' }],
    ['the runner version', { runnerVersion: '0.1.1' }],
    ['the rule version', { rulesVersion: '2026.11' }],
    ['the code class', { codeClass: 'code-premium' }],
    ['the prior findings', { priorFindings: [prior('QmPrior')] }]
  ])('changes with %s', (_label, change) => {
    expect(runKey({ ...BASE, ...change })).not.toBe(runKey(BASE));
  });

  it('no two fields can blur into each other', () => {
    const a = runKey({ ...BASE, listingCid: 'Qma', bcid: 'bQmc' });
    const b = runKey({ ...BASE, listingCid: 'Qmab', bcid: 'Qmc' });
    expect(a).not.toBe(b);
    const c = runKey({ ...BASE, listingCid: 'x","y', bcid: 'z' });
    const d = runKey({ ...BASE, listingCid: 'x', bcid: 'y","z' });
    expect(c).not.toBe(d);
  });

  it('the prior findings are hashed in request order: the pack lists them in that order', () => {
    const one = runKey({ ...BASE, priorFindings: [prior('QmA'), prior('QmB')] });
    const two = runKey({ ...BASE, priorFindings: [prior('QmB'), prior('QmA')] });
    expect(one).not.toBe(two);
  });

  it('the hash covers what a prior finding says, not only its CID', () => {
    expect(priorFindingsHash([prior('QmA', 'one')])).not.toBe(priorFindingsHash([prior('QmA', 'two')]));
    expect(priorFindingsHash([])).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('SharedRuns', () => {
  const deferred = () => {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  };

  it('jobs asking for one key at once share one start', async () => {
    const runs = new SharedRuns();
    const gate = deferred();
    const start = jest.fn(() => gate.promise);
    const all = [runs.run('k', start), runs.run('k', start), runs.run('k', start)];
    gate.resolve({ value: 1 });
    expect(await Promise.all(all)).toEqual([{ value: 1 }, { value: 1 }, { value: 1 }]);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('two keys never share', async () => {
    const runs = new SharedRuns();
    const start = jest.fn(async () => ({ value: start.mock.calls.length }));
    const [a, b] = await Promise.all([runs.run('a', start), runs.run('b', start)]);
    expect(start).toHaveBeenCalledTimes(2);
    expect(a).not.toEqual(b);
  });

  it('a later job within the time to live is served without a start', async () => {
    let t = 1000;
    const runs = new SharedRuns({ ttlMs: 100, now: () => t });
    const start = jest.fn(async () => ({ value: 1 }));
    await runs.run('k', start);
    t += 99;
    await runs.run('k', start);
    expect(start).toHaveBeenCalledTimes(1);
    t += 1;
    await runs.run('k', start);
    expect(start).toHaveBeenCalledTimes(2);
  });

  it('a failure reaches everyone waiting, is not kept, and the next job starts again', async () => {
    const runs = new SharedRuns();
    const gate = deferred();
    const start = jest.fn(() => gate.promise);
    const first = runs.run('k', start);
    const second = runs.run('k', start);
    gate.reject(new Error('abstained'));
    await expect(first).rejects.toThrow('abstained');
    await expect(second).rejects.toThrow('abstained');
    const again = jest.fn(async () => ({ value: 2 }));
    await expect(runs.run('k', again)).resolves.toEqual({ value: 2 });
    expect(again).toHaveBeenCalledTimes(1);
  });

  it('a synchronous throw from start is a rejection, and is not kept', async () => {
    const runs = new SharedRuns();
    await expect(runs.run('k', () => { throw new Error('boom'); })).rejects.toThrow('boom');
    await expect(runs.run('k', async () => 'ok')).resolves.toBe('ok');
  });

  it('a kept result is frozen: no job can change what another reads', async () => {
    const runs = new SharedRuns();
    const value = await runs.run('k', async () => ({ report: { gates: { build: 'pass' } }, list: [{ a: 1 }] }));
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.report.gates)).toBe(true);
    expect(Object.isFrozen(value.list[0])).toBe(true);
  });

  it('is bounded: the least recently used result goes first, and a run in flight is never dropped', async () => {
    const runs = new SharedRuns({ maxEntries: 2 });
    const gate = deferred();
    const startInFlight = jest.fn(() => gate.promise);
    const inFlight = runs.run('flying', startInFlight);
    await runs.run('a', async () => 'a');
    await runs.run('b', async () => 'b');
    await runs.run('c', async () => 'c');
    expect(runs.stats().entries).toBeLessThanOrEqual(2 + 1);
    const second = runs.run('flying', startInFlight);
    gate.resolve('flying');
    await Promise.all([inFlight, second]);
    expect(startInFlight).toHaveBeenCalledTimes(1);

    const startA = jest.fn(async () => 'a again');
    await runs.run('a', startA);
    expect(startA).toHaveBeenCalledTimes(1);
  });

  it('an unawaited failure raises no unhandled rejection', async () => {
    const seen = [];
    const onUnhandled = (reason) => seen.push(reason);
    process.on('unhandledRejection', onUnhandled);
    const runs = new SharedRuns();
    const first = runs.run('k', async () => { throw new Error('nobody waits'); });
    await first.catch(() => {});
    await new Promise((resolve) => setImmediate(resolve));
    process.off('unhandledRejection', onUnhandled);
    expect(seen).toEqual([]);
  });
});
