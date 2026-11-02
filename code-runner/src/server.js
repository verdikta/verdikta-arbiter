'use strict';

/**
 * The HTTP surface (design §7.2, §9.1):
 *
 *   GET  /health   → 200 when a run would be admitted, 503 otherwise
 *   POST /v1/runs  → 200 definitive | 503 abstain | 400 requester_error
 *
 * Every request needs `Authorization: Bearer <token>`, checked before the
 * route or the body is looked at. The listener is 127.0.0.1 / ::1 or a Unix
 * socket (mode 0600); listen() refuses anything else unless the config allows
 * remote binds.
 */

const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { checkBearer } = require('./auth');
const { isLoopbackHost } = require('./config');
const { validateRunRequest, imageBindingIssues } = require('./request');
const { checkSpec } = require('./classLimits');
const { executeRun } = require('./pipeline');
const { health } = require('./health');
const { claimSteps } = require('./steps');
const { checkClaim } = require('./claim');
const { Capacity } = require('./admission');
const { ImageCache } = require('./images');
const { RUNNER_VERSION } = require('./version');
const { OUTCOME, ABSTAIN, RequesterError } = require('./result');

const nullLog = { info() {}, warn() {}, error() {}, debug() {} };

function send(res, status, body, headers = {}) {
  if (res.headersSent || res.destroyed) return;
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': payload.length, ...headers });
  res.end(payload);
}

class BodyError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxBytes) {
      reject(new BodyError(413, `the body exceeds ${maxBytes} bytes`));
      return;
    }
    const chunks = [];
    let size = 0;
    let done = false;
    req.on('data', (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > maxBytes) {
        done = true;
        reject(new BodyError(413, `the body exceeds ${maxBytes} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => { if (!done) { done = true; resolve(Buffer.concat(chunks)); } });
    req.on('error', (err) => { if (!done) { done = true; reject(err); } });
  });
}

function toResponse(result) {
  return {
    outcome: result.outcome,
    runId: result.runId,
    runner: { version: RUNNER_VERSION, runtime: result.runtime, platform: result.platform },
    limits: result.limits,
    abstain: result.abstain,
    // How the env image was had (A1b): { ref, cache: hit|pulled|shared, durationMs }; not part of the report.
    image: result.image || null,
    steps: result.steps,
    gates: result.gates,
    facts: result.facts || {},
    // The Verification Report, its hash and the context pack arrive with node A3b.
    report: null,
    reportSha256: null,
    contextPack: null
  };
}

/**
 * @param {object} o
 * @param {object} o.config - loadConfig()
 * @param {object} o.docker - createDocker()
 * @param {Function} [o.stepsFor] - (request, limits) => steps (default: claimSteps)
 * @param {Function|null} [o.checkRequest] - request => issues the steps would refuse, checked before
 *   admission or any pull (default: the claim pipeline's checkClaim with the default steps)
 * @param {object} [o.log]
 * @param {Function} [o.statfs] - for /health and the pull's disk check
 * @param {Function} [o.meminfo] - the host's available memory, for admission (default /proc/meminfo)
 * @param {string[]} [o.pins] - digests the image cache never evicts (default: @verdikta/common's base images)
 */
function createServer({ config, docker, stepsFor = claimSteps, checkRequest = stepsFor === claimSteps ? checkClaim : null, log = nullLog, statfs, meminfo, pins }) {
  /** Container names of live runs: the GC leaves them alone. */
  const active = new Set();
  /** Execution slots and the memory reserve (A1b). */
  const capacity = new Capacity({ config, log, ...(meminfo ? { meminfo } : {}) });
  /** The env images: pull, verify, cache, evict (A1b). */
  const images = new ImageCache({ config, docker, log, ...(statfs ? { statfs } : {}), ...(pins ? { pins } : {}) });
  /** runId → { controller, done } for the runs in flight. */
  const runs = new Map();
  /** Set by close(): no new run is admitted. */
  let closing = false;

  async function handleRun(req, res, receivedAt) {
    const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (type !== 'application/json') {
      req.resume();
      send(res, 415, { error: 'unsupported_media_type', detail: 'send application/json' }, { connection: 'close' });
      return;
    }
    let raw;
    try {
      raw = await readBody(req, config.maxBodyBytes);
    } catch (err) {
      // Drain (and drop) the rest; the connection closes after the answer.
      req.resume();
      send(res, err.status || 400, { error: err.status === 413 ? 'payload_too_large' : 'bad_request', detail: err.message }, { connection: 'close' });
      return;
    }
    let body;
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch (_) {
      send(res, 400, { outcome: OUTCOME.REQUESTER_ERROR, issues: [{ code: 'INVALID_JSON', path: '/', detail: 'the body is not JSON' }] });
      return;
    }

    const v = validateRunRequest(body);
    const issues = [...v.issues];
    let limits = null;
    if (body && typeof body === 'object' && body.spec && typeof body.spec === 'object' && !Array.isArray(body.spec)) {
      const s = checkSpec(body.spec);
      issues.push(...s.issues);
      limits = s.limits;
      if (s.ok) issues.push(...imageBindingIssues(body.spec, body.attestation));
    }
    const refuse = (list) => {
      log.info('run refused: requester error', { codes: [...new Set(list.map((i) => i.code))] });
      send(res, 400, { outcome: OUTCOME.REQUESTER_ERROR, issues: list });
    };
    if (issues.length) {
      refuse(issues);
      return;
    }
    const request = v.request;
    // What the steps would find wrong in the request itself (an unsupported
    // framework, a missing command, a broken baseline) is the requester's
    // error now, before admission or any pull (§12). A step builder's own
    // bug still reaches the engine and abstains (runner_error).
    const early = checkRequest ? checkRequest(request) : [];
    if (early.length) {
      refuse(early);
      return;
    }
    let steps;
    try {
      steps = stepsFor(request, limits);
    } catch (err) {
      if (err instanceof RequesterError) {
        refuse(err.issues);
        return;
      }
      steps = [async () => { throw err; }];
    }

    if (closing) {
      send(res, 503, { outcome: OUTCOME.ABSTAIN, abstain: { cause: ABSTAIN.ADMISSION_REFUSED, step: 'admission', detail: 'the runner is shutting down' } });
      return;
    }
    const runId = crypto.randomBytes(8).toString('hex');
    const controller = new AbortController();
    res.on('close', () => { if (!res.writableFinished) controller.abort('cancel'); });
    // The caller may already have gone while the body was read.
    if (res.destroyed || (req.socket && req.socket.destroyed)) controller.abort('cancel');

    let resolveDone;
    const done = new Promise((r) => { resolveDone = r; });
    runs.set(runId, { controller, done });
    let result;
    try {
      result = await executeRun({
        docker, config, limits, image: request.spec.env.image, runId, steps,
        receivedAt, deadlineAt: receivedAt + request.deadlineMs, signal: controller.signal, active, log,
        admit: (o) => capacity.admit(o),
        images,
        attestedImage: request.attestation.env.image,
        unpackedBytes: request.spec.env.unpackedBytes
      });
    } finally {
      runs.delete(runId);
      resolveDone();
    }
    log.info('run finished', {
      runId, listingCid: request.listingCid, bcid: request.bcid, outcome: result.outcome,
      cause: result.abstain ? result.abstain.cause : null, step: result.abstain ? result.abstain.step : null,
      image: result.image ? result.image.cache : null, ms: Date.now() - receivedAt
    });
    if (result.outcome === OUTCOME.REQUESTER_ERROR) {
      send(res, 400, { outcome: OUTCOME.REQUESTER_ERROR, runId, issues: result.issues });
      return;
    }
    send(res, result.outcome === OUTCOME.DEFINITIVE ? 200 : 503, toResponse(result));
  }

  async function handler(req, res) {
    const receivedAt = Date.now();
    if (!checkBearer(req.headers.authorization, config.token)) {
      req.resume();
      send(res, 401, { error: 'unauthorized' }, { 'www-authenticate': 'Bearer', connection: 'close' });
      return;
    }
    const pathname = String(req.url || '/').split('?')[0];
    try {
      if (pathname === '/health') {
        if (req.method !== 'GET') {
          req.resume();
          send(res, 405, { error: 'method_not_allowed' }, { allow: 'GET' });
          return;
        }
        const body = await health({ config, docker, capacity, images, ...(statfs ? { statfs } : {}) });
        send(res, body.ok ? 200 : 503, body);
        return;
      }
      if (pathname === '/v1/runs') {
        if (req.method !== 'POST') {
          req.resume();
          send(res, 405, { error: 'method_not_allowed' }, { allow: 'POST' });
          return;
        }
        await handleRun(req, res, receivedAt);
        return;
      }
      req.resume();
      send(res, 404, { error: 'not_found' });
    } catch (err) {
      log.error('request failed', { error: err.message });
      send(res, 500, { outcome: OUTCOME.ABSTAIN, abstain: { cause: ABSTAIN.RUNNER_ERROR, step: null, detail: 'internal error' } });
    }
  }

  const server = http.createServer((req, res) => { handler(req, res); });
  // Bounds on receiving a request; a run's own time is bounded by its deadline.
  server.headersTimeout = 30000;
  server.requestTimeout = 120000;
  server.keepAliveTimeout = 5000;

  function listenOn(options) {
    return new Promise((resolve, reject) => {
      const onError = (err) => { server.off('listening', onListening); reject(err); };
      const onListening = () => { server.off('error', onError); resolve(); };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(options);
    });
  }

  async function clearStaleSocket(socketPath) {
    let st;
    try {
      st = fs.lstatSync(socketPath);
    } catch (err) {
      if (err.code === 'ENOENT') return;
      throw err;
    }
    if (!st.isSocket()) throw new Error(`${socketPath} exists and is not a socket`);
    const inUse = await new Promise((resolve) => {
      const c = net.connect(socketPath);
      c.once('connect', () => { c.destroy(); resolve(true); });
      c.once('error', () => resolve(false));
    });
    if (inUse) throw new Error(`${socketPath} is in use by another process`);
    fs.unlinkSync(socketPath);
  }

  async function listen() {
    if (config.listen.socket) {
      const socketPath = config.listen.socket;
      await clearStaleSocket(socketPath);
      const previous = process.umask(0o177);
      try {
        await listenOn({ path: socketPath });
      } finally {
        process.umask(previous);
      }
      fs.chmodSync(socketPath, 0o600);
      return { socketPath };
    }
    const { host, port } = config.listen;
    if (!isLoopbackHost(host) && !config.allowRemoteBind) {
      throw new Error(`refusing to listen on ${host}: not a loopback address (CODE_RUNNER_ALLOW_REMOTE_BIND=true is the remote mode)`);
    }
    await listenOn({ host, port });
    const addr = server.address();
    return { host: addr.address, port: addr.port };
  }

  /**
   * Stop: admit nothing new, cancel every run in flight and wait until each
   * has removed its sandboxes, then close the connections.
   */
  async function close() {
    closing = true;
    const stopped = new Promise((resolve) => { server.close(() => resolve()); });
    while (runs.size > 0) {
      const pending = [...runs.values()];
      for (const r of pending) r.controller.abort('cancel');
      await Promise.all(pending.map((r) => r.done));
    }
    // A pull no run waits for any more is stopped too.
    images.close();
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    await stopped;
  }

  return { server, listen, close, active, runs, capacity, images };
}

module.exports = { createServer };
