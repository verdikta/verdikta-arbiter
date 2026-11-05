'use strict';

/**
 * A real-jury run that does not depend on the session that started it (node A7d).
 *
 *   <batch dir>/claims/<id>.json     one result per claim, written whole as it finishes
 *   <batch dir>/attempts/<id>.<n>.json  an errored result that --retry-errored replaced
 *   <batch dir>/ledger.jsonl, calls/  the meter's (meter.js)
 *   <batch dir>/summary.json         why the run ended, rewritten as it goes
 *
 * A re-run skips any claim with a result. A claim is called as the External Adapter calls it (claim-runner.js: at most
 * twice, and the second only on a retryable 503), so an errored claim has had its retry, and goes again only when asked.
 *
 * It stops by itself, and the reason is in the summary and the exit code: before a claim whose worst case would pass
 * the limit; when the meter has refused a call, or can no longer record one; after errors in a row, which is an outage or a key rather than a
 * measurement; when the AI Node cannot be reached; and when a verdict arrives with no provider call in the ledger,
 * which means the money is not going through the meter. A result on another request than the scenario's stops it too:
 * the request is everything the jury reads, and a verdict on an old one is not a verdict on this one.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { codeReview } = require('@verdikta/common');
const { buildClaimRequest, CLAIM_DEADLINE_MS } = require('./claim-scenarios');
const { runClaimScenario } = require('./claim-runner');
const { acquireLock, readLedger, worstCaseClaimUsd } = require('./spend');

const EXIT = Object.freeze({ FINISHED: 0, WITH_ERRORS: 1, BUDGET: 4, ERRORS_IN_A_ROW: 5, AI_NODE_GONE: 6, UNMETERED: 7, STALE_RESULT: 8, METER_STOPPED: 9 });
const MAX_ERRORS_IN_A_ROW = 3;
const OUTCOME_MASS = 1000000;

function writeWhole(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const partial = `${file}.partial`;
  fs.writeFileSync(partial, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(partial, file);
}

/** The reply's text, from either provider's answer, as the AI Node reads it: without thinking blocks (jury.ts). */
function replyText(body) {
  if (!body || typeof body !== 'object') return null;
  let text = null;
  if (Array.isArray(body.content)) text = body.content.filter((block) => block && block.type === 'text').map((block) => block.text).join('');
  else if (body.choices && body.choices[0] && body.choices[0].message && typeof body.choices[0].message.content === 'string') text = body.choices[0].message.content;
  return text === null ? null : text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

/** A juror's first reply, as parseCodeJurorReply takes it: one JSON object, bare or in one fence, of integers summing to the total. */
function strictScores(text) {
  if (typeof text !== 'string') return null;
  const fenced = /^```(?:json)?[ \t]*\n([\s\S]*?)\n?```$/i.exec(text);
  let parsed;
  try {
    parsed = JSON.parse(fenced ? fenced[1] : text);
  } catch (_error) {
    return null;
  }
  const score = parsed && parsed.score;
  if (!Array.isArray(score) || score.length !== codeReview.BUG_OUTCOMES.length || typeof parsed.justification !== 'string') return null;
  if (!score.every((v) => Number.isInteger(v) && v >= 0) || score.reduce((a, b) => a + b, 0) !== OUTCOME_MASS) return null;
  return score;
}

function rescale(values, sum) {
  const scaled = values.map((v) => Math.floor((v * OUTCOME_MASS) / sum));
  scaled[values.indexOf(Math.max(...values))] += OUTCOME_MASS - scaled.reduce((a, b) => a + b, 0);
  return scaled;
}

/** A repair call's reply, as parseRepairedScores takes it (ai-node/src/utils/repairModelResponse.ts): the last score list in it, rescaled the same way. */
function repairedScores(text) {
  if (typeof text !== 'string') return null;
  const found = Array.from(text.matchAll(/"score"\s*:\s*\[([^\]]*)\]/g));
  if (found.length === 0) return null;
  const items = found[found.length - 1][1].split(',').map((item) => item.trim()).filter((item) => item !== '');
  const score = items.map(Number);
  if (score.length !== codeReview.BUG_OUTCOMES.length || !score.every((v) => Number.isFinite(v) && v >= 0)) return null;
  const sum = score.reduce((a, b) => a + b, 0);
  if (sum <= 0) return null;
  return rescale(score, sum);
}

/**
 * What each juror said, for the report: the AI Node gives only the panel's average. A reply it could not read is followed
 * by a repair call, and a retry repeats the jury, so the last answer that was read counts. The average is the check: if
 * these vectors do not give the claim's vector, they are not what was used, and none is reported.
 * @param {object[]} calls - this claim's ledger rows
 * @param {{AI_NODES: Array<{AI_MODEL:string, WEIGHT:number}>}} juryParameters
 * @param {string} callsDir
 * @param {number[]|null} [claimVector]
 * @returns {Array<{model:string, vector:number[]|null}>}
 */
function jurorVectors(calls, juryParameters, callsDir, claimVector = null) {
  const jurors = juryParameters.AI_NODES.map(({ AI_MODEL: model }) => {
    let vector = null;
    let repairNext = false;
    for (const call of calls) {
      if (call.model !== model || !call.response) continue;
      const saved = JSON.parse(fs.readFileSync(path.join(callsDir, call.response), 'utf8'));
      if (saved.status < 200 || saved.status >= 300) continue;
      const text = replyText(saved.body);
      if (repairNext) {
        vector = repairedScores(text);
        repairNext = false;
      } else {
        vector = strictScores(text);
        repairNext = vector === null;
      }
    }
    return { model, vector };
  });
  if (!claimVector || jurors.some((juror) => !juror.vector)) return jurors;
  const total = juryParameters.AI_NODES.reduce((sum, node) => sum + node.WEIGHT, 0);
  const consistent = claimVector.every((mass, i) => {
    const mean = juryParameters.AI_NODES.reduce((sum, node, j) => sum + (jurors[j].vector[i] * node.WEIGHT) / total, 0);
    return Math.abs(mean - mass) <= 1;
  });
  return consistent ? jurors : jurors.map(({ model }) => ({ model, vector: null }));
}

const costOf = (calls) => calls.reduce((sum, call) => sum + call.usd, 0);

const requestDigest = (request) => crypto.createHash('sha256').update(JSON.stringify(request)).digest('hex');

async function assertMeter(meterHealth, { stopUsd, ledgerFile }) {
  let health;
  try {
    health = await meterHealth();
  } catch (error) {
    throw new Error(`the meter did not answer (${error.message}): a real-jury batch does not run unmetered`);
  }
  if (!health || health.ok !== true) throw new Error('the meter is not healthy: a real-jury batch does not run unmetered');
  if (health.stopped) throw new Error('the meter has stopped: it refused a call, or cannot record one');
  if (!(health.stopUsd <= stopUsd)) throw new Error(`the meter's limit is USD ${health.stopUsd}, over the USD ${stopUsd} this run was given`);
  if (path.resolve(health.ledgerFile) !== path.resolve(ledgerFile)) throw new Error(`the meter writes another ledger than ${ledgerFile}`);
}

/**
 * @param {object[]} scenarios - loadClaimScenarios'
 * @param {object} o
 * @param {string} o.batchDir
 * @param {string} o.ledgerFile - the meter's
 * @param {number} o.stopUsd
 * @param {Function} o.meterHealth - () => the meter's GET /health
 * @param {string} [o.aiNodeUrl]
 * @param {boolean} [o.retryErrored]
 * @param {string} [o.justifierModel]
 * @param {Function} [o.runOne] - for tests
 * @param {Function} [o.log]
 * @returns {Promise<number>} EXIT
 */
async function runClaimBatch(scenarios, {
  batchDir, ledgerFile, stopUsd, meterHealth, aiNodeUrl, retryErrored = false, justifierModel = 'claude-haiku-5-5',
  runOne = (scenario) => runClaimScenario(scenario, { aiNodeUrl }), log = (line) => process.stdout.write(`${line}\n`)
}) {
  await assertMeter(meterHealth, { stopUsd, ledgerFile });
  fs.mkdirSync(batchDir, { recursive: true });
  const releaseLock = acquireLock(path.join(batchDir, 'batch.lock'), 'this batch directory');
  try {
    return await runLocked(scenarios, { batchDir, ledgerFile, stopUsd, meterHealth, retryErrored, justifierModel, runOne, log });
  } finally {
    releaseLock();
  }
}

async function runLocked(scenarios, { batchDir, ledgerFile, stopUsd, meterHealth, retryErrored, justifierModel, runOne, log }) {
  const callsDir = path.join(batchDir, 'calls');
  const fileOf = (id) => path.join(batchDir, 'claims', `${id}.json`);
  const readResult = (id) => (fs.existsSync(fileOf(id)) ? JSON.parse(fs.readFileSync(fileOf(id), 'utf8')) : null);

  const finish = (reason, code) => {
    const results = scenarios.map((scenario) => readResult(scenario.scenario_id));
    const { totalUsd, open } = readLedger(ledgerFile);
    writeWhole(path.join(batchDir, 'summary.json'), {
      reason,
      chosen: scenarios.length,
      withVerdict: results.filter((r) => r && !r.error).length,
      withError: results.filter((r) => r && r.error).length,
      notRun: scenarios.filter((_s, i) => !results[i]).map((s) => s.scenario_id),
      totalUsd,
      openCalls: open,
      stopUsd
    });
    log(`claim batch: ${reason}; USD ${totalUsd.toFixed(4)} of ${stopUsd}`);
    return code;
  };

  let errorsInARow = 0;
  for (const scenario of scenarios) {
    const id = scenario.scenario_id;
    const earlier = readResult(id);
    const request = buildClaimRequest(scenario, { deadlineMs: CLAIM_DEADLINE_MS });
    const requestSha256 = requestDigest(request);
    if (earlier && earlier.request_sha256 !== requestSha256) {
      log(`claim batch: ${id}: its saved result is on request ${earlier.request_sha256}, and this scenario's is ${requestSha256}`);
      return finish('stale-result', EXIT.STALE_RESULT);
    }
    if (earlier && !(earlier.error && retryErrored)) continue;

    const worstCase = worstCaseClaimUsd({
      promptBytes: Buffer.byteLength(JSON.stringify(request)),
      juryParameters: scenario.input.juryParameters,
      justifierModel,
      jurorOutputTokens: codeReview.getCodeClass(scenario.codeClass).envelope.jurorOutputTokens
    });
    const before = readLedger(ledgerFile);
    if (before.totalUsd + worstCase > stopUsd) {
      log(`claim batch: ${id}: its worst case of USD ${worstCase.toFixed(4)} could take USD ${before.totalUsd.toFixed(4)} past USD ${stopUsd}`);
      return finish('budget', EXIT.BUDGET);
    }

    log(`claim batch: ${id}…`);
    const result = await runOne(scenario);
    const after = readLedger(ledgerFile);
    const calls = after.calls.slice(before.calls.length);

    if (after.refused.length > before.refused.length) {
      log(`claim batch: ${id}: the meter refused a call, so this claim has no result`);
      return finish('budget', EXIT.BUDGET);
    }
    const health = await meterHealth().catch(() => null);
    if (!health || health.stopped) {
      log(`claim batch: ${id}: the meter ${health ? 'has stopped' : 'did not answer'}, so this claim has no result`);
      return finish('meter-stopped', EXIT.METER_STOPPED);
    }
    if (result.transport) {
      log(`claim batch: ${id}: the AI Node could not be reached: ${result.error}`);
      return finish('ai-node-gone', EXIT.AI_NODE_GONE);
    }
    if (!result.error && calls.length === 0) {
      log(`claim batch: ${id}: a verdict with no provider call in the ledger: the AI Node is not going through the meter`);
      return finish('unmetered', EXIT.UNMETERED);
    }

    if (earlier) {
      const attempts = path.join(batchDir, 'attempts');
      fs.mkdirSync(attempts, { recursive: true });
      let n = 1;
      while (fs.existsSync(path.join(attempts, `${id}.${n}.json`))) n += 1;
      fs.renameSync(fileOf(id), path.join(attempts, `${id}.${n}.json`));
    }
    writeWhole(fileOf(id), {
      ...result,
      request_sha256: requestSha256,
      pack_sha256: scenario.input.contextPack.sha256,
      jurors: jurorVectors(calls, scenario.input.juryParameters, callsDir, result.vector),
      spend: {
        usd: costOf(calls),
        calls: calls.map(({ model, status, basis, usd, inputTokens, outputTokens, reasoningTokens, cacheReadTokens, cacheWriteTokens, reportedUsd, maxTokens, finishReason, durationMs }) => ({ model, status, basis, usd, inputTokens, outputTokens, reasoningTokens, cacheReadTokens, cacheWriteTokens, reportedUsd, maxTokens, finishReason, durationMs }))
      }
    });
    log(`claim batch: ${id}: ${result.error ? `error: ${result.error}` : `settles ${result.settled.outcome}`}; USD ${costOf(calls).toFixed(4)}`);

    errorsInARow = result.error ? errorsInARow + 1 : 0;
    if (errorsInARow >= MAX_ERRORS_IN_A_ROW) return finish('errors-in-a-row', EXIT.ERRORS_IN_A_ROW);
  }
  const anyError = scenarios.some((scenario) => {
    const result = readResult(scenario.scenario_id);
    return result && result.error;
  });
  return finish('finished', anyError ? EXIT.WITH_ERRORS : EXIT.FINISHED);
}

module.exports = { runClaimBatch, jurorVectors, EXIT, MAX_ERRORS_IN_A_ROW };
