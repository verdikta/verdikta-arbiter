'use strict';

// Node A7d: the meter between the AI Node and its providers. The "providers" here are loopback stubs: nothing is spent.

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { createMeter, parseArgs } = require('../meter');
const { readLedger } = require('../spend');

let dir;
let closers;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-meter-'));
  closers = [];
});
afterEach(async () => {
  for (const close of closers.reverse()) await close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const USAGE = { input_tokens: 1000, output_tokens: 100 };

/** A provider on loopback. `answer(req, body)` gives { status, body } or null to hang. */
async function stubProvider(answer) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      const reply = answer(req, body);
      if (!reply) return;
      res.writeHead(reply.status, { 'content-type': 'application/json' });
      res.end(typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  closers.push(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return { seen, url: `http://127.0.0.1:${server.address().port}` };
}

async function start({ stopUsd = 10, answer = () => ({ status: 200, body: { usage: USAGE, content: [{ type: 'text', text: 'hello' }] } }) } = {}) {
  const provider = await stubProvider(answer);
  const ledgerFile = path.join(dir, 'ledger.jsonl');
  const callsDir = path.join(dir, 'calls');
  const meter = createMeter({ ledgerFile, callsDir, stopUsd, upstreams: { anthropic: provider.url, openrouter: provider.url } });
  const { port } = await meter.listen(0);
  closers.push(() => meter.close());
  return { provider, meter, port, ledgerFile, callsDir };
}

function post(port, target, body, headers = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: target, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(text);
  });
}

const SONNET = { model: 'claude-sonnet-5-5', max_tokens: 8000, messages: [] };
const DEEPSEEK = { model: 'deepseek/deepseek-v4-pro-0813', max_tokens: 8000, stream: false, messages: [] };

describe('forwarding', () => {
  test('a call goes on with the caller\'s headers and bytes, and comes back as it was', async () => {
    const { provider, port } = await start();
    const res = await post(port, '/anthropic/v1/messages?beta=true', SONNET, { 'x-api-key': 'caller-key', 'anthropic-version': '2023-06-01' });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.text).content[0].text).toBe('hello');
    expect(provider.seen).toHaveLength(1);
    expect(provider.seen[0].url).toBe('/v1/messages?beta=true');
    expect(provider.seen[0].headers['x-api-key']).toBe('caller-key');
    expect(provider.seen[0].headers['anthropic-version']).toBe('2023-06-01');
    expect(provider.seen[0].headers['accept-encoding']).toBe('identity');
    expect(JSON.parse(provider.seen[0].body)).toEqual(SONNET);
  });

  test('OpenRouter\'s route, and its usage shape', async () => {
    const { provider, port, ledgerFile } = await start({ answer: () => ({ status: 200, body: { choices: [{ message: { content: 'x' } }], usage: { prompt_tokens: 1000000, completion_tokens: 1000000, cost: 0.5 } } }) });
    const res = await post(port, '/openrouter/api/v1/chat/completions', DEEPSEEK, { authorization: 'Bearer caller' });
    expect(res.status).toBe(200);
    expect(provider.seen[0].url).toBe('/api/v1/chat/completions');
    const [call] = readLedger(ledgerFile).calls;
    expect(call).toMatchObject({ model: 'deepseek/deepseek-v4-pro-0813', status: 200, inputTokens: 1000000, outputTokens: 1000000, basis: 'reported', reportedUsd: 0.5 });
    expect(call.usd).toBeCloseTo(0.115 + 4.6, 6);
  });

  test.each([
    ['GET', '/anthropic/v1/models'],
    ['POST', '/anthropic/v1/messages/batches'],
    ['POST', '/anthropic/v1/files'],
    ['POST', '/openrouter/api/v1/embeddings'],
    ['POST', '/v1/messages'],
    ['POST', '/anthropic/../openrouter/api/v1/chat/completions']
  ])('%s %s goes nowhere: only the two chat routes are forwarded', async (method, target) => {
    const { provider, port, ledgerFile } = await start();
    const text = JSON.stringify(SONNET);
    const status = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, method, path: target, headers: { 'content-length': method === 'POST' ? Buffer.byteLength(text) : 0 } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      req.on('error', reject);
      req.end(method === 'POST' ? text : undefined);
    });
    expect(status).toBe(404);
    expect(provider.seen).toHaveLength(0);
    expect(fs.existsSync(ledgerFile) ? readLedger(ledgerFile).calls : []).toHaveLength(0);
  });

  test.each([
    ['a model with no price', { model: 'gpt-6-sol', max_tokens: 10 }],
    ['a body that is not JSON', 'not json'],
    ['a streamed call, whose usage this meter could not read', { ...SONNET, stream: true }]
  ])('%s is refused and never sent', async (_name, body) => {
    const { provider, port } = await start();
    const res = await post(port, '/anthropic/v1/messages', body);
    expect(res.status).toBe(400);
    expect(provider.seen).toHaveLength(0);
  });

  test('the ledger and the saved answers hold no header value: a key that passed through is nowhere on disk', async () => {
    const { port, ledgerFile, callsDir } = await start();
    await post(port, '/anthropic/v1/messages', SONNET, { 'x-api-key': 'sk-secret-value', authorization: 'Bearer sk-secret-value' });
    const everything = [fs.readFileSync(ledgerFile, 'utf8'), ...fs.readdirSync(callsDir).map((name) => fs.readFileSync(path.join(callsDir, name), 'utf8'))].join('\n');
    expect(everything).not.toContain('sk-secret-value');
    expect(everything).not.toMatch(/x-api-key|authorization/i);
  });
});

describe('the ledger', () => {
  test('a call is reserved before it is sent and settled at what the provider reported, with the answer saved', async () => {
    let reservedWhenSent = null;
    const ledgerFile = path.join(dir, 'ledger.jsonl');
    const { port, callsDir } = await start({
      answer: () => {
        reservedWhenSent = readLedger(ledgerFile).open;
        return { status: 200, body: { usage: USAGE, content: [] } };
      }
    });
    await post(port, '/anthropic/v1/messages', SONNET);
    expect(reservedWhenSent).toBe(1);
    const read = readLedger(ledgerFile);
    expect(read.open).toBe(0);
    expect(read.calls[0]).toMatchObject({ basis: 'reported', status: 200, inputTokens: 1000, outputTokens: 100 });
    expect(read.calls[0].usd).toBeCloseTo((1000 * 2 + 100 * 10) / 1e6, 9);
    expect(read.calls[0].response).toBeDefined();
    const saved = JSON.parse(fs.readFileSync(path.join(callsDir, read.calls[0].response), 'utf8'));
    expect(saved).toMatchObject({ model: 'claude-sonnet-5-5', status: 200, body: { usage: USAGE } });
  });

  test('a 200 with no readable usage stays at the worst case', async () => {
    const { port, ledgerFile } = await start({ answer: () => ({ status: 200, body: { content: [] } }) });
    await post(port, '/anthropic/v1/messages', SONNET);
    const [call] = readLedger(ledgerFile).calls;
    expect(call.basis).toBe('worst-case');
    expect(call.usd).toBeCloseTo(call.reservedUsd, 9);
    expect(call.usd).toBeGreaterThan(0.08);
  });

  test('an error answer with no usage costs nothing, and goes back as it was', async () => {
    const { port, ledgerFile } = await start({ answer: () => ({ status: 529, body: { type: 'error', error: { type: 'overloaded_error' } } }) });
    const res = await post(port, '/anthropic/v1/messages', SONNET);
    expect(res.status).toBe(529);
    expect(JSON.parse(res.text).error.type).toBe('overloaded_error');
    const [call] = readLedger(ledgerFile).calls;
    expect(call).toMatchObject({ basis: 'error-answer', status: 529, usd: 0 });
  });

  test('a provider that cannot be reached is a 502, and stays at the worst case: it may have run', async () => {
    const provider = await stubProvider(() => null);
    const ledgerFile = path.join(dir, 'ledger.jsonl');
    const meter = createMeter({ ledgerFile, callsDir: path.join(dir, 'calls'), stopUsd: 10, upstreams: { anthropic: 'http://127.0.0.1:1', openrouter: provider.url } });
    const { port } = await meter.listen(0);
    closers.push(() => meter.close());
    const res = await post(port, '/anthropic/v1/messages', SONNET);
    expect(res.status).toBe(502);
    const [call] = readLedger(ledgerFile).calls;
    expect(call.basis).toBe('upstream-error');
    expect(call.usd).toBeCloseTo(call.reservedUsd, 9);
  });

  test('a caller that hangs up cancels the provider call, which stays at the worst case', async () => {
    let providerClosed = null;
    const closed = new Promise((resolve) => { providerClosed = resolve; });
    const provider = await stubProvider((req) => {
      req.socket.once('close', providerClosed);
      return null;
    });
    const ledgerFile = path.join(dir, 'ledger.jsonl');
    const meter = createMeter({ ledgerFile, callsDir: path.join(dir, 'calls'), stopUsd: 10, upstreams: { anthropic: provider.url, openrouter: provider.url } });
    const { port } = await meter.listen(0);
    closers.push(() => meter.close());
    const text = JSON.stringify(SONNET);
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/anthropic/v1/messages', headers: { 'content-length': Buffer.byteLength(text) } });
    req.on('error', () => {});
    req.end(text);
    for (let i = 0; i < 100 && provider.seen.length === 0; i += 1) await new Promise((r) => setTimeout(r, 10));
    req.destroy();
    await closed;
    for (let i = 0; i < 100 && readLedger(ledgerFile).calls.length === 0; i += 1) await new Promise((r) => setTimeout(r, 10));
    const [call] = readLedger(ledgerFile).calls;
    expect(call.basis).toBe('aborted');
    expect(call.usd).toBeCloseTo(call.reservedUsd, 9);
  });
});

describe('the hard stop', () => {
  test('a call whose worst case would pass the limit is refused with a 402 and never sent', async () => {
    const { provider, port, ledgerFile } = await start({ stopUsd: 0.01 });
    const res = await post(port, '/anthropic/v1/messages', SONNET);
    expect(res.status).toBe(402);
    expect(JSON.parse(res.text).error.type).toBe('spend_stop');
    expect(provider.seen).toHaveLength(0);
    expect(readLedger(ledgerFile).refused).toHaveLength(1);
  });

  test('calls in flight count at their worst case: two together cannot pass it', async () => {
    const release = [];
    const provider = await stubProvider(() => null);
    const ledgerFile = path.join(dir, 'ledger.jsonl');
    const stopUsd = 0.09;
    const meter = createMeter({ ledgerFile, callsDir: path.join(dir, 'calls'), stopUsd, upstreams: { anthropic: provider.url, openrouter: provider.url } });
    const { port } = await meter.listen(0);
    closers.push(() => meter.close());
    release.push(post(port, '/anthropic/v1/messages', SONNET).catch(() => null));
    for (let i = 0; i < 100 && provider.seen.length === 0; i += 1) await new Promise((r) => setTimeout(r, 10));
    const second = await post(port, '/anthropic/v1/messages', SONNET);
    expect(second.status).toBe(402);
    expect(provider.seen).toHaveLength(1);
  });

  test('the total survives a restart of the meter', async () => {
    const { port, meter } = await start({ stopUsd: 0.1 });
    await post(port, '/anthropic/v1/messages', SONNET);
    await meter.close();
    const again = createMeter({ ledgerFile: path.join(dir, 'ledger.jsonl'), callsDir: path.join(dir, 'calls'), stopUsd: 0.083, upstreams: { anthropic: 'http://127.0.0.1:1', openrouter: 'http://127.0.0.1:1' } });
    const { port: next } = await again.listen(0);
    closers.push(() => again.close());
    const res = await post(next, '/anthropic/v1/messages', SONNET);
    expect(res.status).toBe(402);
  });

  test('GET /health names the limit, the ledger and the total, and spends nothing', async () => {
    const { port, ledgerFile } = await start({ stopUsd: 7 });
    await post(port, '/anthropic/v1/messages', SONNET);
    const body = await new Promise((resolve) => {
      http.get({ host: '127.0.0.1', port, path: '/health' }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
      });
    });
    expect(body).toMatchObject({ ok: true, stopUsd: 7, stopped: false, ledgerFile });
    expect(body.totalUsd).toBeCloseTo((1000 * 2 + 100 * 10) / 1e6, 9);
  });
});

describe('the command line', () => {
  test('needs a ledger, a calls directory, a port and a limit', () => {
    expect(() => parseArgs(['--ledger', 'l'])).toThrow(/--calls/);
    expect(parseArgs(['--ledger', 'l', '--calls', 'c', '--port', '5000', '--stop-usd', '90'])).toMatchObject({ ledgerFile: 'l', callsDir: 'c', port: 5000, stopUsd: 90 });
  });

  test.each([['0'], ['-1'], ['ninety'], ['Infinity']])('refuses a limit of %s', (stop) => {
    expect(() => parseArgs(['--ledger', 'l', '--calls', 'c', '--port', '5000', '--stop-usd', stop])).toThrow(/--stop-usd/);
  });

  test('binds to loopback only', async () => {
    const { meter } = await start();
    expect(meter.address().address).toBe('127.0.0.1');
  });
});
