'use strict';

// Node A7d: a real-jury run that survives its session: one result file per claim, resume, and three ways to stop by itself.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { codeReview } = require('@verdikta/common');
const { writeClaimScenario } = require('../../test/helpers/claimFixture');
const { loadClaimScenarios } = require('../claim-scenarios');
const { Ledger, readLedger } = require('../spend');
const { runClaimBatch, jurorVectors, EXIT } = require('../claim-batch');

let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-batch-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const SONNET = 'claude-sonnet-5-5';
const DEEPSEEK = 'deepseek/deepseek-v4-pro-0813';
const HAIKU = 'claude-haiku-5-5';

async function scenarios(ids) {
  const claims = path.join(dir, 'claims-in');
  for (const id of ids) await writeClaimScenario(claims, { id, priors: 0, scenario: { id } });
  return loadClaimScenarios(claims);
}

/** What the meter would have recorded for one claim: the two jurors and the justifier, with their answers saved. */
function recordCalls(batchDir, ledger, { sonnet = [0, 0, 0, 0, 1000000, 0], deepseek = [0, 0, 0, 1000000, 0, 0], usd = 0.1 } = {}) {
  const calls = path.join(batchDir, 'calls');
  fs.mkdirSync(calls, { recursive: true });
  const save = (id, model, body) => { fs.writeFileSync(path.join(calls, `${id}.json`), JSON.stringify({ id, model, status: 200, body })); return `${id}.json`; };
  const one = (model, body) => {
    const id = ledger.reserve({ usd: 1, model });
    ledger.settle(id, { usd, basis: 'reported', status: 200, inputTokens: 100, outputTokens: 10, response: save(id, model, body) });
  };
  one(SONNET, { content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: JSON.stringify({ score: sonnet, justification: 'j' }) }] });
  one(DEEPSEEK, { choices: [{ message: { content: `\`\`\`json\n${JSON.stringify({ score: deepseek, justification: 'j' })}\n\`\`\`` } }] });
  one(HAIKU, { content: [{ type: 'text', text: 'The panel found.' }] });
}

const verdict = (scenario, over = {}) => ({
  scenario_id: scenario.scenario_id,
  expected_outcome: scenario.expected_outcome,
  vector: [0, 0, 0, 500000, 500000, 0],
  settled: { outcome: 'MEDIUM', valid: true, class: 'MEDIUM', validMass: 1000000, classMass: 1000000 },
  agrees: false,
  justification: 'The panel found.',
  timestamp: '2026-11-05T00:00:00.000Z',
  execution_time_ms: 5,
  ...over
});

/** A batch whose claims are answered by `answer(scenario)`, the meter's part played by a Ledger in this process. */
async function run(list, { stopUsd = 90, answer, record = recordCalls, retryErrored = false, health } = {}) {
  const batchDir = path.join(dir, 'run');
  fs.mkdirSync(batchDir, { recursive: true });
  const ledgerFile = path.join(batchDir, 'ledger.jsonl');
  const ledger = new Ledger(ledgerFile, { stopUsd: 1000 });
  const sent = [];
  const runOne = async (scenario) => {
    sent.push(scenario.scenario_id);
    const out = answer ? answer(scenario, ledger, batchDir) : verdict(scenario);
    if (out && out.error === undefined) record(batchDir, ledger);
    return out;
  };
  const code = await runClaimBatch(list, {
    batchDir,
    ledgerFile,
    stopUsd,
    runOne,
    retryErrored,
    meterHealth: health || (async () => ({ ok: true, stopUsd, ledgerFile })),
    log: () => {}
  });
  ledger.close();
  return { code, sent, batchDir, ledgerFile };
}

const claimFile = (batchDir, id) => path.join(batchDir, 'claims', `${id}.json`);
const readClaim = (batchDir, id) => JSON.parse(fs.readFileSync(claimFile(batchDir, id), 'utf8'));

describe('one result file per claim', () => {
  test('each finished claim has its file, with what it cost and what each juror said', async () => {
    const list = await scenarios(['a', 'b']);
    const { code, batchDir } = await run(list);
    expect(code).toBe(EXIT.FINISHED);
    const a = readClaim(batchDir, 'a');
    expect(a.settled.outcome).toBe('MEDIUM');
    expect(a.spend.usd).toBeCloseTo(0.3, 6);
    expect(a.spend.calls.map((c) => c.model)).toEqual([SONNET, DEEPSEEK, HAIKU]);
    expect(a.spend.calls[0]).toMatchObject({ inputTokens: 100, outputTokens: 10, basis: 'reported' });
    expect(a.jurors).toEqual([
      { model: SONNET, vector: [0, 0, 0, 0, 1000000, 0] },
      { model: DEEPSEEK, vector: [0, 0, 0, 1000000, 0, 0] }
    ]);
    expect(readClaim(batchDir, 'b').spend.usd).toBeCloseTo(0.3, 6);
  });

  test('a file appears whole or not at all, as each claim finishes, and the summary says what happened', async () => {
    const list = await scenarios(['a', 'b']);
    const seen = [];
    const { batchDir } = await run(list, {
      answer: (scenario) => {
        seen.push(fs.existsSync(path.join(dir, 'run', 'claims')) ? fs.readdirSync(path.join(dir, 'run', 'claims')) : []);
        return verdict(scenario);
      }
    });
    expect(seen).toEqual([[], ['a.json']]);
    const summary = JSON.parse(fs.readFileSync(path.join(batchDir, 'summary.json'), 'utf8'));
    expect(summary).toMatchObject({ reason: 'finished', chosen: 2, withVerdict: 2, withError: 0, notRun: [] });
    expect(summary.totalUsd).toBeCloseTo(0.6, 6);
  });
});

describe('resume', () => {
  test('a re-run skips a claim that has a result, and calls nothing for it', async () => {
    const list = await scenarios(['a', 'b']);
    await run([list[0]]);
    const again = await run(list);
    expect(again.code).toBe(EXIT.FINISHED);
    expect(again.sent).toEqual(['b']);
  });

  test('an errored claim keeps its result and is skipped: it had the retry the adapter would give', async () => {
    const list = await scenarios(['a']);
    await run(list, { answer: (s) => ({ scenario_id: s.scenario_id, error: 'the AI Node answered 400 CODE_REVIEW_JUROR_FAILED after 1 call(s)', settled: null }) });
    const again = await run(list);
    expect(again.sent).toEqual([]);
    expect(again.code).toBe(EXIT.WITH_ERRORS);
  });

  test('--retry-errored runs it once more and keeps the earlier attempt beside it', async () => {
    const list = await scenarios(['a']);
    await run(list, { answer: (s) => ({ scenario_id: s.scenario_id, error: 'boom', settled: null }) });
    const again = await run(list, { retryErrored: true });
    expect(again.sent).toEqual(['a']);
    expect(again.code).toBe(EXIT.FINISHED);
    expect(readClaim(again.batchDir, 'a').settled.outcome).toBe('MEDIUM');
    const attempts = fs.readdirSync(path.join(again.batchDir, 'attempts'));
    expect(attempts).toEqual(['a.1.json']);
    expect(JSON.parse(fs.readFileSync(path.join(again.batchDir, 'attempts', attempts[0]), 'utf8')).error).toBe('boom');
  });

  test('--retry-errored leaves a verdict alone: a disagreement is a measurement', async () => {
    const list = await scenarios(['a']);
    await run(list);
    const again = await run(list, { retryErrored: true });
    expect(again.sent).toEqual([]);
  });
});

describe('it stops by itself', () => {
  test('before a claim whose worst case would pass the limit, with nothing sent for it', async () => {
    const list = await scenarios(['a', 'b']);
    // The fixture's prompt is small: a worst case under USD 1, and the first claim's calls leave too little.
    const { code, sent, batchDir } = await run(list, { stopUsd: 1, record: (b, l) => recordCalls(b, l, { usd: 0.3 }) });
    expect(code).toBe(EXIT.BUDGET);
    expect(sent).toEqual(['a']);
    const summary = JSON.parse(fs.readFileSync(path.join(batchDir, 'summary.json'), 'utf8'));
    expect(summary).toMatchObject({ reason: 'budget', notRun: ['b'] });
  });

  test('when the meter refused a call: that claim gets no result, since it is not a measurement', async () => {
    const list = await scenarios(['a', 'b']);
    const { code, sent, batchDir, ledgerFile } = await run(list, {
      answer: (s, ledger) => {
        const realLimit = ledger.stopUsd;
        ledger.stopUsd = 0;
        ledger.reserve({ usd: 1, model: SONNET });
        ledger.stopUsd = realLimit;
        return { scenario_id: s.scenario_id, error: 'the AI Node answered 400 CODE_REVIEW_JUROR_FAILED after 1 call(s)', settled: null };
      }
    });
    expect(code).toBe(EXIT.BUDGET);
    expect(sent).toEqual(['a']);
    expect(fs.existsSync(claimFile(batchDir, 'a'))).toBe(false);
    expect(readLedger(ledgerFile).refused).toHaveLength(1);
  });

  test('after three errors in a row, and a verdict between them resets the count', async () => {
    const list = await scenarios(['a', 'b', 'c', 'd', 'e', 'f', 'g']);
    const errored = new Set(['a', 'b', 'd', 'e', 'f']);
    const { code, sent, batchDir } = await run(list, {
      answer: (s) => (errored.has(s.scenario_id) ? { scenario_id: s.scenario_id, error: 'x', settled: null } : verdict(s))
    });
    expect(code).toBe(EXIT.ERRORS_IN_A_ROW);
    expect(sent).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
    expect(JSON.parse(fs.readFileSync(path.join(batchDir, 'summary.json'), 'utf8')).reason).toBe('errors-in-a-row');
  });

  test('when the AI Node cannot be reached: no result, and nothing further is tried', async () => {
    const list = await scenarios(['a', 'b']);
    const { code, sent, batchDir } = await run(list, { answer: (s) => ({ scenario_id: s.scenario_id, error: 'connect ECONNREFUSED', transport: true, settled: null }) });
    expect(code).toBe(EXIT.AI_NODE_GONE);
    expect(sent).toEqual(['a']);
    expect(fs.existsSync(claimFile(batchDir, 'a'))).toBe(false);
  });

  test('a verdict with no call in the ledger means the run is not metered: it stops at once', async () => {
    const list = await scenarios(['a', 'b']);
    const { code, sent, batchDir } = await run(list, { record: () => {} });
    expect(code).toBe(EXIT.UNMETERED);
    expect(sent).toEqual(['a']);
    expect(JSON.parse(fs.readFileSync(path.join(batchDir, 'summary.json'), 'utf8')).reason).toBe('unmetered');
  });
});

describe('it does not start', () => {
  test.each([
    ['no meter', async () => { throw new Error('ECONNREFUSED'); }, /meter/],
    ['a meter with a higher limit than asked', async ({ stopUsd, ledgerFile }) => ({ ok: true, stopUsd: stopUsd + 1, ledgerFile }), /limit/],
    ['a meter writing another ledger', async ({ stopUsd }) => ({ ok: true, stopUsd, ledgerFile: '/elsewhere' }), /ledger/]
  ])('with %s', async (_name, meterHealth, message) => {
    const list = await scenarios(['a']);
    const batchDir = path.join(dir, 'run');
    fs.mkdirSync(batchDir, { recursive: true });
    const ledgerFile = path.join(batchDir, 'ledger.jsonl');
    const runOne = jest.fn();
    await expect(runClaimBatch(list, { batchDir, ledgerFile, stopUsd: 90, runOne, meterHealth: () => meterHealth({ stopUsd: 90, ledgerFile }), log: () => {} })).rejects.toThrow(message);
    expect(runOne).not.toHaveBeenCalled();
  });
});

describe('jurorVectors', () => {
  const answerFile = (name, model, body) => {
    fs.writeFileSync(path.join(dir, name), JSON.stringify({ model, status: 200, body }));
    return { model, status: 200, response: name };
  };
  const panel = { AI_NODES: [{ AI_MODEL: SONNET }, { AI_MODEL: DEEPSEEK }] };
  const vector = [0, 0, 0, 0, 1000000, 0];

  test('a repair call\'s scores replace the prose before it, rescaled, and a juror with none is null', () => {
    const calls = [
      answerFile('1.json', SONNET, { content: [{ type: 'text', text: 'PHASE 1 ... prose' }] }),
      answerFile('2.json', SONNET, { content: [{ type: 'text', text: '{"score":[0,0,0,0,100,0]}' }] }),
      answerFile('3.json', DEEPSEEK, { choices: [{ message: { content: 'not json' } }] })
    ];
    expect(jurorVectors(calls, panel, dir)).toEqual([{ model: SONNET, vector }, { model: DEEPSEEK, vector: null }]);
  });

  test('{"score": null} from a repair is no vector, and an unsaved answer is no vector', () => {
    const calls = [answerFile('1.json', SONNET, { content: [{ type: 'text', text: '{"score":null}' }] }), { model: DEEPSEEK, status: null }];
    expect(jurorVectors(calls, panel, dir)).toEqual([{ model: SONNET, vector: null }, { model: DEEPSEEK, vector: null }]);
  });

  test('the second attempt\'s answer is the one that counted', () => {
    const calls = [
      answerFile('1.json', SONNET, { content: [{ type: 'text', text: '{"score":[1000000,0,0,0,0,0],"justification":"a"}' }] }),
      answerFile('2.json', SONNET, { content: [{ type: 'text', text: `{"score":${JSON.stringify(vector)},"justification":"b"}` }] })
    ];
    expect(jurorVectors(calls, panel, dir)[0].vector).toEqual(vector);
  });

  test('a score list of another length is no vector', () => {
    const calls = [answerFile('1.json', SONNET, { content: [{ type: 'text', text: '{"score":[1000000]}' }] })];
    expect(jurorVectors(calls, panel, dir)[0].vector).toBeNull();
    expect(vector).toHaveLength(codeReview.BUG_OUTCOMES.length);
  });
});

describe('the command', () => {
  const { runClaimCommand } = require('../claim-command');
  const quiet = async (fn) => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const code = await fn();
      return { code, errors: spy.mock.calls.flat().join('\n') };
    } finally {
      spy.mockRestore();
      log.mockRestore();
    }
  };

  test.each([
    [{ batchDir: 'x' }],
    [{ batchDir: 'x', meterUrl: 'http://127.0.0.1:1' }],
    [{ meterUrl: 'http://127.0.0.1:1', stopUsd: '90' }]
  ])('a batch needs all three flags: %j', async (flags) => {
    const { code, errors } = await quiet(() => runClaimCommand({ jury: 'real', ...flags }, {}));
    expect(code).toBe(1);
    expect(errors).toMatch(/--batch-dir, --meter-url and --stop-usd/);
  });

  test.each([['0'], ['-5'], ['lots']])('--stop-usd %s is refused', async (stopUsd) => {
    const { code, errors } = await quiet(() => runClaimCommand({ jury: 'real', batchDir: 'x', meterUrl: 'http://127.0.0.1:1', stopUsd }, {}));
    expect(code).toBe(1);
    expect(errors).toMatch(/--stop-usd/);
  });

  test('--retry-errored without a batch is refused', async () => {
    const { code, errors } = await quiet(() => runClaimCommand({ jury: 'real', retryErrored: true }, {}));
    expect(code).toBe(1);
    expect(errors).toMatch(/--retry-errored/);
  });

  test('a batch with no meter calls no model and exits 1', async () => {
    await writeClaimScenario(path.join(dir, 'claims'), { id: 'a', priors: 0, scenario: { id: 'a' } });
    const http = require('http');
    let posts = 0;
    const node = http.createServer((req, res) => {
      if (req.method === 'POST') posts += 1;
      req.resume();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"status":"ok"}');
    });
    await new Promise((resolve) => node.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${node.address().port}`;
    const { code, errors } = await quiet(() => runClaimCommand({
      jury: 'real', claimsDir: path.join(dir, 'claims'), batchDir: path.join(dir, 'run'), meterUrl: 'http://127.0.0.1:1', stopUsd: '90'
    }, { aiNodeUrl: url, timeoutMs: 5000, maxRetries: 0 }));
    node.closeAllConnections();
    await new Promise((resolve) => node.close(resolve));
    expect(code).toBe(1);
    expect(errors).toMatch(/meter/);
    expect(posts).toBe(0);
  });
});
