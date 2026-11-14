#!/usr/bin/env node
'use strict';

/**
 * The meter (node A7d): a loopback reverse proxy between the AI Node and its providers, so a real-jury run has a
 * record of every provider call and a limit it cannot pass, with no Claude session awake and no change to the AI Node
 * being measured.
 *
 * Every HTTP attempt passes through here, which is what a count inside the AI Node would miss: LangChain's own retries,
 * the repair calls, the justifier, a juror cancelled at the deadline. A call is reserved at its worst case and synced to
 * the ledger before it is sent. Past the limit it is answered 402 and never sent.
 *
 *   node src/meter.js --ledger <file> --calls <dir> --port <port> --stop-usd <usd>
 *   ANTHROPIC_BASE_URL=http://127.0.0.1:<port>/anthropic
 *   OPENROUTER_BASE_URL=http://127.0.0.1:<port>/openrouter/api/v1
 *
 * It holds no key. The AI Node's credentials pass through in their headers, and no header is ever logged or stored.
 * The provider's answers are saved under --calls, since they are the only record of what each juror said. They hold
 * what a juror wrote, which can quote repository source, so that directory stays where the run is.
 */

const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const { Ledger, reservationUsd, usageOf } = require('./spend');

const DEFAULT_UPSTREAMS = Object.freeze({ anthropic: 'https://api.anthropic.com', openrouter: 'https://openrouter.ai' });
const MAX_BODY_BYTES = 32 * 1024 * 1024;
/** Sent on from the caller: nothing else. */
const DROPPED_HEADERS = new Set(['host', 'connection', 'content-length', 'accept-encoding', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-authorization', 'te', 'trailer']);

/** Why the provider stopped, and how much of the output was reasoning, for the record: neither holds text. */
function endOf(body) {
  const choice = body && Array.isArray(body.choices) ? body.choices[0] : null;
  const details = body && body.usage ? body.usage.completion_tokens_details : null;
  const reasoningTokens = details && Number.isInteger(details.reasoning_tokens) ? details.reasoning_tokens : null;
  const finishReason = choice && typeof choice.finish_reason === 'string' ? choice.finish_reason : (body && typeof body.stop_reason === 'string' ? body.stop_reason : null);
  return { finishReason, reasoningTokens };
}

/** The two calls this run makes, and nothing else. */
function routeOf(url) {
  const [pathname, query] = url.split('?');
  const suffix = query === undefined ? '' : `?${query}`;
  if (pathname === '/anthropic/v1/messages') return { provider: 'anthropic', target: `/v1/messages${suffix}` };
  if (pathname === '/openrouter/api/v1/chat/completions') return { provider: 'openrouter', target: `/api/v1/chat/completions${suffix}` };
  return null;
}

function send(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function refuse(res, status, type, message) {
  send(res, status, { type: 'error', error: { type, message } });
}

function parseJson(bytes) {
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch (_error) {
    return null;
  }
}

/**
 * @param {object} o
 * @param {string} o.ledgerFile
 * @param {string} o.callsDir
 * @param {number} o.stopUsd
 * @param {{anthropic:string, openrouter:string}} [o.upstreams] - for tests
 */
function createMeter({ ledgerFile, callsDir, stopUsd, upstreams = DEFAULT_UPSTREAMS }) {
  fs.mkdirSync(callsDir, { recursive: true, mode: 0o700 });
  const ledger = new Ledger(ledgerFile, { stopUsd });
  let closing = null;

  function saveAnswer(id, model, status, bytes) {
    const name = `${id}.json`;
    const parsed = parseJson(bytes);
    fs.writeFileSync(path.join(callsDir, name), JSON.stringify({ id, model, status, body: parsed === null ? bytes.toString('utf8') : parsed }), { mode: 0o600 });
    return name;
  }

  function forward(req, res, route, model, reservedUsd, id, body) {
    const upstream = new URL(upstreams[route.provider]);
    const headers = {};
    for (const [name, value] of Object.entries(req.headers)) if (!DROPPED_HEADERS.has(name)) headers[name] = value;
    headers.host = upstream.host;
    headers['content-length'] = body.length;
    // The answer is read here, so it comes as plain JSON.
    headers['accept-encoding'] = 'identity';

    const startedAt = Date.now();
    let settled = false;
    const settle = (fields) => {
      // Past close() the reservation stands, which is the worst case the call could have cost.
      if (settled || closing) return;
      settled = true;
      try {
        ledger.settle(id, { ...fields, durationMs: Date.now() - startedAt });
      } catch (error) {
        // The call stays at its reservation, and the ledger now refuses every call.
        process.stderr.write(`meter: the ledger could not record a call's cost: ${error.message}\n`);
      }
    };
    const client = upstream.protocol === 'https:' ? https : http;
    const out = client.request({
      protocol: upstream.protocol, hostname: upstream.hostname, port: upstream.port, method: 'POST', path: route.target, headers
    }, (answer) => {
      const chunks = [];
      answer.on('data', (c) => chunks.push(c));
      answer.on('error', () => {
        settle({ usd: reservedUsd, basis: 'upstream-error', status: answer.statusCode });
        res.destroy();
      });
      answer.on('end', () => {
        const bytes = Buffer.concat(chunks);
        const parsed = parseJson(bytes);
        const usage = usageOf(model, parsed);
        const response = saveAnswer(id, model, answer.statusCode, bytes);
        const end = endOf(parsed);
        if (usage) {
          settle({ ...usage, ...end, basis: 'reported', status: answer.statusCode, response });
        } else if (answer.statusCode >= 200 && answer.statusCode < 300) {
          settle({ ...end, usd: reservedUsd, basis: 'worst-case', status: answer.statusCode, response });
        } else {
          settle({ ...end, usd: 0, basis: 'error-answer', status: answer.statusCode, response });
        }
        const { 'content-length': _length, 'transfer-encoding': _encoding, connection: _connection, ...passed } = answer.headers;
        res.writeHead(answer.statusCode, { ...passed, 'content-length': bytes.length });
        res.end(bytes);
      });
    });
    out.on('error', () => {
      // Sent or not, it cannot be told apart from here, so it stays at the worst case.
      settle({ usd: reservedUsd, basis: res.destroyed ? 'aborted' : 'upstream-error', status: null });
      if (!res.headersSent && !res.destroyed) refuse(res, 502, 'upstream_error', 'the meter could not reach the provider');
    });
    res.on('close', () => {
      if (res.writableEnded) return;
      settle({ usd: reservedUsd, basis: 'aborted', status: null });
      out.destroy();
    });
    out.end(body);
  }

  function metered(req, res, route) {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size <= MAX_BODY_BYTES) chunks.push(c);
    });
    req.on('end', () => {
      if (size > MAX_BODY_BYTES) return refuse(res, 400, 'meter_refused', 'the request is larger than this meter takes');
      const body = Buffer.concat(chunks);
      const parsed = parseJson(body);
      if (!parsed || typeof parsed !== 'object' || typeof parsed.model !== 'string') return refuse(res, 400, 'meter_refused', 'the request is not JSON naming a model');
      if (parsed.stream === true) return refuse(res, 400, 'meter_refused', 'a streamed call cannot be metered');
      let reservedUsd;
      try {
        reservedUsd = reservationUsd(parsed.model, body.length, parsed.max_tokens);
      } catch (_error) {
        return refuse(res, 400, 'meter_refused', `no list price for ${parsed.model}, so this call cannot be counted`);
      }
      let id;
      try {
        id = ledger.reserve({ usd: reservedUsd, model: parsed.model, maxTokens: parsed.max_tokens });
      } catch (error) {
        process.stderr.write(`meter: a call was refused: ${error.message}\n`);
        return refuse(res, 402, 'spend_stop', 'the ledger could not record this call, so it is not sent');
      }
      if (id === null) return refuse(res, 402, 'spend_stop', `this call could take the run past its limit of USD ${stopUsd}`);
      return forward(req, res, route, parsed.model, reservedUsd, id, body);
    });
  }

  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      return send(res, 200, { ok: true, stopUsd, totalUsd: ledger.totalUsd(), stopped: ledger.stopped(), ledgerFile: path.resolve(ledgerFile) });
    }
    const route = req.method === 'POST' ? routeOf(req.url) : null;
    if (!route) {
      req.resume();
      return refuse(res, 404, 'meter_refused', 'the meter forwards two routes only');
    }
    return metered(req, res, route);
  });

  return {
    listen(port) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => resolve(server.address()));
      });
    },
    address: () => server.address(),
    close() {
      if (!closing) {
        closing = new Promise((resolve) => {
          server.close(() => {
            ledger.close();
            resolve();
          });
          server.closeAllConnections();
        });
      }
      return closing;
    }
  };
}

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i += 2) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (value === undefined) throw new Error(`${flag} needs a value`);
    if (flag === '--ledger') o.ledgerFile = value;
    else if (flag === '--calls') o.callsDir = value;
    else if (flag === '--port') o.port = Number(value);
    else if (flag === '--stop-usd') o.stopUsd = Number(value);
    // A stub in place of a provider: the no-spend end-to-end of the README's "A paid run".
    else if (flag === '--upstream-anthropic') o.upstreams = { ...(o.upstreams || DEFAULT_UPSTREAMS), anthropic: value };
    else if (flag === '--upstream-openrouter') o.upstreams = { ...(o.upstreams || DEFAULT_UPSTREAMS), openrouter: value };
    else throw new Error(`unknown option ${flag}`);
  }
  for (const [key, flag] of [['ledgerFile', '--ledger'], ['callsDir', '--calls'], ['port', '--port'], ['stopUsd', '--stop-usd']]) {
    if (o[key] === undefined) throw new Error(`${flag} is required`);
  }
  if (!Number.isInteger(o.port) || o.port < 1 || o.port > 65535) throw new Error('--port must be a port number');
  if (!Number.isFinite(o.stopUsd) || o.stopUsd <= 0) throw new Error('--stop-usd must be a positive number of dollars');
  return o;
}

if (require.main === module) {
  (async () => {
    const options = parseArgs(process.argv.slice(2));
    const meter = createMeter(options);
    const { port } = await meter.listen(options.port);
    process.stdout.write(`meter: on 127.0.0.1:${port}, limit USD ${options.stopUsd}\n`);
    const stop = () => { meter.close().finally(() => process.exit(0)); };
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
  })().catch((error) => {
    process.stderr.write(`meter: ${error.message}\n`);
    process.exit(1);
  });
}

module.exports = { createMeter, parseArgs, routeOf };
