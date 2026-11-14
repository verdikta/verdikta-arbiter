'use strict';

// Node A7d: the spending ledger. Pure arithmetic and one file, so the hard stop can be read without a provider.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { codeReview } = require('@verdikta/common');
const { PRICES, usageOf, reservationUsd, Ledger, readLedger, worstCaseClaimUsd } = require('../spend');

let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-spend-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('usageOf', () => {
  test('Anthropic: each kind of input token at its own price, output at the output price', () => {
    const u = usageOf('claude-sonnet-5-5', { usage: { input_tokens: 1000000, output_tokens: 100000, cache_read_input_tokens: 1000000, cache_creation_input_tokens: 1000000 } });
    expect(u).toMatchObject({ inputTokens: 1000000, outputTokens: 100000, cacheReadTokens: 1000000, cacheWriteTokens: 1000000 });
    expect(u.listUsd).toBeCloseTo(2 + 1 + 0.2 + 2.5, 6);
    expect(u.usd).toBeCloseTo(u.listUsd, 6);
  });

  test('OpenRouter: list price, unless the provider reports it billed more', () => {
    const list = usageOf('deepseek/deepseek-v4-pro-0813', { usage: { prompt_tokens: 1000000, completion_tokens: 1000000 } });
    expect(list.listUsd).toBeCloseTo(0.115 + 4.6, 6);
    expect(list.reportedUsd).toBeNull();
    const higher = usageOf('deepseek/deepseek-v4-pro-0813', { usage: { prompt_tokens: 1000000, completion_tokens: 1000000, cost: 9 } });
    expect(higher.reportedUsd).toBe(9);
    expect(higher.usd).toBe(9);
    const lower = usageOf('deepseek/deepseek-v4-pro-0813', { usage: { prompt_tokens: 1000000, completion_tokens: 1000000, cost: 0.01 } });
    expect(lower.usd).toBeCloseTo(lower.listUsd, 6);
  });

  test('Haiku past 100K input tokens is at its higher price', () => {
    const below = usageOf('claude-haiku-5-5', { usage: { input_tokens: 100000, output_tokens: 0 } });
    expect(below.listUsd).toBeCloseTo(0.01, 6);
    const above = usageOf('claude-haiku-5-5', { usage: { input_tokens: 100001, output_tokens: 1000000 } });
    expect(above.listUsd).toBeCloseTo((100001 * 0.5) / 1e6 + 2.5, 6);
  });

  test.each([[{}], [{ usage: null }], [{ usage: { input_tokens: 'x', output_tokens: 1 } }], [{ usage: { input_tokens: 1 } }], [{ usage: { prompt_tokens: -1, completion_tokens: 1 } }], [null]])(
    'a body with no readable usage gives null: %j', (body) => {
      expect(usageOf('claude-sonnet-5-5', body)).toBeNull();
    }
  );

  test('a model with no price throws: it could not be counted', () => {
    expect(() => usageOf('gpt-6-sol', { usage: { input_tokens: 1, output_tokens: 1 } })).toThrow(/price/);
  });
});

describe('reservationUsd', () => {
  test('one byte a token and the whole output ceiling: no input could cost more', () => {
    expect(reservationUsd('claude-sonnet-5-5', 200000, 8000)).toBeCloseTo((200000 * 2) / 1e6 + (8000 * 10) / 1e6, 6);
  });

  test.each([['constructor'], ['__proto__'], ['toString'], ['hasOwnProperty']])('%s is no model: it has no price, and so never a NaN', (model) => {
    expect(() => reservationUsd(model, 10, 10)).toThrow(/price/);
    expect(() => usageOf(model, { usage: { input_tokens: 1, output_tokens: 1 } })).toThrow(/price/);
  });

  test('Haiku past 100K input tokens reserves at its higher price', () => {
    expect(reservationUsd('claude-haiku-5-5', 200000, 1000)).toBeCloseTo((200000 * 0.5) / 1e6 + (1000 * 2.5) / 1e6, 6);
  });

  test('a call that names no ceiling reserves the large default, never nothing', () => {
    expect(reservationUsd('claude-sonnet-5-5', 0, undefined)).toBeCloseTo((64000 * 10) / 1e6, 6);
  });
});

describe('worstCaseClaimUsd', () => {
  const panel = { AI_NODES: [{ AI_MODEL: 'claude-sonnet-5-5' }, { AI_MODEL: 'deepseek/deepseek-v4-pro-0813' }] };

  test('every juror, a repair call each, the justifier, all twice for the retry the adapter allows', () => {
    const once = (m, bytes, tokens) => reservationUsd(m, bytes, tokens);
    const juryOnce = once('claude-sonnet-5-5', 100000, 8000) + once('deepseek/deepseek-v4-pro-0813', 100000, 8000);
    const repairs = once('claude-sonnet-5-5', 40000, 8000) + once('deepseek/deepseek-v4-pro-0813', 40000, 8000);
    const justifier = once('claude-haiku-5-5', 90000, 8192);
    expect(worstCaseClaimUsd({ promptBytes: 100000, juryParameters: panel, justifierModel: 'claude-haiku-5-5', jurorOutputTokens: 8000 }))
      .toBeCloseTo(2 * (juryOnce + repairs + justifier), 6);
  });

  test('a panel model with no price throws', () => {
    expect(() => worstCaseClaimUsd({ promptBytes: 1, juryParameters: { AI_NODES: [{ AI_MODEL: 'nope' }] }, justifierModel: 'claude-haiku-5-5', jurorOutputTokens: 8000 })).toThrow(/price/);
  });
});

describe('Ledger', () => {
  const file = () => path.join(dir, 'ledger.jsonl');

  test('a reservation counts until it settles, and then what it settled at counts', () => {
    const ledger = new Ledger(file(), { stopUsd: 1 });
    const id = ledger.reserve({ usd: 0.5, model: 'claude-sonnet-5-5' });
    expect(id).not.toBeNull();
    expect(ledger.totalUsd()).toBeCloseTo(0.5, 6);
    ledger.settle(id, { usd: 0.1, basis: 'reported', status: 200, inputTokens: 10, outputTokens: 2 });
    expect(ledger.totalUsd()).toBeCloseTo(0.1, 6);
    ledger.close();
    const read = readLedger(file());
    expect(read.totalUsd).toBeCloseTo(0.1, 6);
    expect(read.open).toBe(0);
    expect(read.calls).toHaveLength(1);
    expect(read.calls[0]).toMatchObject({ id, model: 'claude-sonnet-5-5', usd: 0.1, basis: 'reported', status: 200, inputTokens: 10, outputTokens: 2 });
  });

  test('a reservation that would pass the stop is refused, and recorded', () => {
    const ledger = new Ledger(file(), { stopUsd: 1 });
    expect(ledger.reserve({ usd: 0.6, model: 'a' })).not.toBeNull();
    expect(ledger.reserve({ usd: 0.41, model: 'b' })).toBeNull();
    expect(ledger.stopped()).toBe(true);
    expect(ledger.reserve({ usd: 0.4, model: 'c' })).not.toBeNull();
    ledger.close();
    const read = readLedger(file());
    expect(read.refused).toHaveLength(1);
    expect(read.refused[0]).toMatchObject({ model: 'b', usd: 0.41 });
    expect(read.totalUsd).toBeCloseTo(1, 6);
  });

  test('exactly the stop is allowed: "would pass" is the rule', () => {
    const ledger = new Ledger(file(), { stopUsd: 1 });
    expect(ledger.reserve({ usd: 1, model: 'a' })).not.toBeNull();
    ledger.close();
  });

  test('a restart carries the total, and a call that never settled stays at its reservation', () => {
    const first = new Ledger(file(), { stopUsd: 1 });
    const settled = first.reserve({ usd: 0.5, model: 'a' });
    first.settle(settled, { usd: 0.2, basis: 'reported', status: 200 });
    first.reserve({ usd: 0.3, model: 'b' }); // the meter dies here
    first.close();
    expect(readLedger(file())).toMatchObject({ open: 1 });
    const second = new Ledger(file(), { stopUsd: 1 });
    expect(second.totalUsd()).toBeCloseTo(0.5, 6);
    expect(second.reserve({ usd: 0.51, model: 'c' })).toBeNull();
    expect(second.reserve({ usd: 0.5, model: 'c' })).not.toBeNull();
    second.close();
  });

  test('a torn last line is a write that never finished: it is ignored, and no earlier line may be torn', () => {
    const ledger = new Ledger(file(), { stopUsd: 1 });
    ledger.reserve({ usd: 0.5, model: 'a' });
    ledger.close();
    fs.appendFileSync(file(), '{"kind":"settle","id":');
    expect(readLedger(file()).totalUsd).toBeCloseTo(0.5, 6);
    fs.appendFileSync(file(), '\n{"kind":"reserve","id":"x","usd":0.1,"model":"b"}\n');
    expect(() => readLedger(file())).toThrow(/line 2/);
  });

  test('a restart cuts a torn tail off, so a new row is not joined to it', () => {
    const first = new Ledger(file(), { stopUsd: 1 });
    first.reserve({ usd: 0.5, model: 'a' });
    first.close();
    fs.appendFileSync(file(), '{"kind":"settle","id":');
    const second = new Ledger(file(), { stopUsd: 1 });
    second.reserve({ usd: 0.25, model: 'b' });
    second.close();
    const read = readLedger(file());
    expect(read.totalUsd).toBeCloseTo(0.75, 6);
    expect(read.open).toBe(2);
  });

  test('a write that fails stops the ledger: the call is not authorised, then or later', () => {
    const ledger = new Ledger(file(), { stopUsd: 1 });
    const real = fs.writeSync;
    const spy = jest.spyOn(fs, 'writeSync').mockImplementationOnce(() => { throw Object.assign(new Error('no space'), { code: 'ENOSPC' }); });
    expect(() => ledger.reserve({ usd: 0.1, model: 'a' })).toThrow(/no space/);
    spy.mockRestore();
    expect(fs.writeSync).toBe(real);
    expect(() => ledger.reserve({ usd: 0.1, model: 'a' })).toThrow(/nothing further/);
    ledger.close();
  });

  test('a short write is finished, and is one whole row', () => {
    const ledger = new Ledger(file(), { stopUsd: 1 });
    const real = fs.writeSync;
    const spy = jest.spyOn(fs, 'writeSync').mockImplementation((fd, bytes, at) => real(fd, bytes, at, Math.min(7, bytes.length - at)));
    ledger.reserve({ usd: 0.1, model: 'a' });
    spy.mockRestore();
    ledger.close();
    expect(readLedger(file()).open).toBe(1);
  });

  test('NaN cannot be reserved: it would disable the limit for everything after it', () => {
    const ledger = new Ledger(file(), { stopUsd: 1 });
    expect(() => ledger.reserve({ usd: NaN, model: 'a' })).toThrow(/cannot be counted/);
    expect(ledger.totalUsd()).toBe(0);
    ledger.close();
  });

  test('settling that fails leaves the call at its reservation', () => {
    const ledger = new Ledger(file(), { stopUsd: 1 });
    const id = ledger.reserve({ usd: 0.5, model: 'a' });
    const spy = jest.spyOn(fs, 'writeSync').mockImplementationOnce(() => { throw new Error('no space'); });
    expect(() => ledger.settle(id, { usd: 0.1, basis: 'reported', status: 200 })).toThrow(/no space/);
    spy.mockRestore();
    expect(ledger.totalUsd()).toBeCloseTo(0.5, 6);
    ledger.close();
  });

  test('a second writer is refused, and a failed write counts as stopped', () => {
    const ledger = new Ledger(file(), { stopUsd: 1 });
    expect(() => new Ledger(file(), { stopUsd: 1 })).toThrow(new RegExp(`already held by process ${process.pid}`));
    expect(ledger.stopped()).toBe(false);
    const spy = jest.spyOn(fs, 'writeSync').mockImplementationOnce(() => { throw new Error('no space'); });
    expect(() => ledger.reserve({ usd: 0.1, model: 'a' })).toThrow(/no space/);
    spy.mockRestore();
    expect(ledger.stopped()).toBe(true);
    ledger.close();
    expect(fs.existsSync(`${file()}.lock`)).toBe(false);
  });

  test('a lock is never taken over: a dead holder\'s is left for a person, and says so', () => {
    fs.writeFileSync(`${file()}.lock`, '99999999\n');
    expect(() => new Ledger(file(), { stopUsd: 1 })).toThrow(/99999999, which no longer runs/);
    expect(fs.readFileSync(`${file()}.lock`, 'utf8').trim()).toBe('99999999');
    fs.rmSync(`${file()}.lock`);
    new Ledger(file(), { stopUsd: 1 }).close();
  });

  test('a lock file naming nothing is a holder it cannot read, and no process 0', () => {
    fs.writeFileSync(`${file()}.lock`, '');
    expect(() => new Ledger(file(), { stopUsd: 1 })).toThrow(/an unknown process/);
  });

  test('a lock leaves no working file behind', () => {
    const ledger = new Ledger(file(), { stopUsd: 1 });
    expect(fs.readdirSync(dir).sort()).toEqual(['ledger.jsonl', 'ledger.jsonl.lock']);
    ledger.close();
  });

  test('a missing ledger is an empty one', () => {
    expect(readLedger(path.join(dir, 'none.jsonl'))).toMatchObject({ totalUsd: 0, open: 0, calls: [], refused: [] });
  });

  test('settling an unknown call throws: it would be spend with no reservation', () => {
    const ledger = new Ledger(file(), { stopUsd: 1 });
    expect(() => ledger.settle('nope', { usd: 1, basis: 'reported', status: 200 })).toThrow(/unknown/);
    ledger.close();
  });

  test('the prices are dated, and name where they came from', () => {
    expect(PRICES.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(PRICES.source).toMatch(/openrouter/i);
  });

  test('A19: a call through OpenRouter is priced by the pool model its id stands for, and an id no table names is still refused', () => {
    const native = reservationUsd('gpt-6-luna', 300000, 32000);
    expect(reservationUsd('openai/gpt-6-luna', 300000, 32000)).toBe(native);
    expect(reservationUsd('anthropic/claude-opus-5.5', 1000, 100)).toBe(reservationUsd('claude-opus-5-5', 1000, 100));
    expect(usageOf('openai/gpt-6-luna', { usage: { prompt_tokens: 100000, completion_tokens: 100000 } }).listUsd).toBeCloseTo(0.06, 6);
    // Past 272K input tokens, Luna's higher rate, by either id.
    expect(usageOf('openai/gpt-6-luna', { usage: { prompt_tokens: 1000000, completion_tokens: 1000000 } }).listUsd).toBeCloseTo(0.95, 6);
    expect(() => reservationUsd('openai/gpt-7', 1000, 100)).toThrow(/no list price/);
    expect(() => reservationUsd('comment', 1000, 100)).toThrow(/no list price/);
  });

  test('A19: every code-class pool model the AI Node can send through OpenRouter has its route id, and each priced panel juror is priced by either id', () => {
    const { routeIds, modelOfRoute } = require('../routes');
    for (const codeClass of Object.values(codeReview.CODE_CLASSES)) {
      for (const { provider, model } of codeClass.models) {
        const ids = routeIds(provider, model);
        expect(ids[0]).toBe(model);
        if (provider === 'openrouter') expect(ids).toEqual([model]);
        else expect(modelOfRoute(ids[1])).toEqual({ provider, model });
      }
    }
    const jurors = [codeReview.CODE_STANDARD_PANEL, codeReview.CODE_STANDARD_DISPUTE_PANEL].flatMap((panel) => panel.AI_NODES);
    for (const node of jurors) for (const id of routeIds(node.AI_PROVIDER, node.AI_MODEL)) expect(() => reservationUsd(id, 1000, 100)).not.toThrow();
  });

  test('every juror of the pinned release\'s panels has a list price: a batch on them is counted, never refused', () => {
    const jurors = [codeReview.CODE_STANDARD_PANEL, codeReview.CODE_STANDARD_DISPUTE_PANEL].flatMap((panel) => panel.AI_NODES.map((node) => node.AI_MODEL));
    for (const model of jurors) expect(Object.hasOwn(PRICES.models, model)).toBe(true);
  });
});
