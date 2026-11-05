'use strict';

// Node A7d: the spending ledger. Pure arithmetic and one file, so the hard stop can be read without a provider.

const fs = require('fs');
const os = require('os');
const path = require('path');
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
  test('two bytes a token and the whole output ceiling: at least what the call could cost', () => {
    expect(reservationUsd('claude-sonnet-5-5', 200000, 8000)).toBeCloseTo((100000 * 2) / 1e6 + (8000 * 10) / 1e6, 6);
  });

  test('Haiku past 100K input tokens reserves at its higher price', () => {
    expect(reservationUsd('claude-haiku-5-5', 400000, 1000)).toBeCloseTo((200000 * 0.5) / 1e6 + (1000 * 2.5) / 1e6, 6);
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
});
