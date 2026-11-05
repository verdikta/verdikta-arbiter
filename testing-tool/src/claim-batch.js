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
 * the limit; when the meter has refused a call; after errors in a row, which is an outage or a key rather than a
 * measurement; when the AI Node cannot be reached; and when a verdict arrives with no provider call in the ledger,
 * which means the money is not going through the meter.
 */

const fs = require('fs');
const path = require('path');
const { codeReview } = require('@verdikta/common');
const { buildClaimRequest, CLAIM_DEADLINE_MS } = require('./claim-scenarios');
const { runClaimScenario } = require('./claim-runner');
const { readLedger, worstCaseClaimUsd } = require('./spend');

const EXIT = Object.freeze({ FINISHED: 0, WITH_ERRORS: 1, BUDGET: 4, ERRORS_IN_A_ROW: 5, AI_NODE_GONE: 6, UNMETERED: 7 });
const MAX_ERRORS_IN_A_ROW = 3;
const OUTCOME_MASS = 1000000;

function writeWhole(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const partial = `${file}.partial`;
  fs.writeFileSync(partial, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(partial, file);
}

/** The reply's text, from either provider's answer. */
function replyText(body) {
  if (!body || typeof body !== 'object') return null;
  if (Array.isArray(body.content)) return body.content.filter((block) => block && block.type === 'text').map((block) => block.text).join('');
  const content = body.choices && body.choices[0] && body.choices[0].message && body.choices[0].message.content;
  return typeof content === 'string' ? content : null;
}

/** One juror's scores from one reply: the JSON object code mode asks for, bare or in one fence, on any scale (a repair's). */
function scoresIn(text) {
  if (typeof text !== 'string') return null;
  const fenced = /^```(?:json)?[ \t]*\n([\s\S]*?)\n?```$/i.exec(text.trim());
  let parsed;
  try {
    parsed = JSON.parse(fenced ? fenced[1] : text.trim());
  } catch (_error) {
    return null;
  }
  const score = parsed && parsed.score;
  if (!Array.isArray(score) || score.length !== codeReview.BUG_OUTCOMES.length || !score.every((v) => typeof v === 'number' && v >= 0)) return null;
  const sum = score.reduce((a, b) => a + b, 0);
  if (sum <= 0) return null;
  return sum === OUTCOME_MASS ? score : score.map((v) => Math.round((v * OUTCOME_MASS) / sum));
}

/**
 * What each juror said, for the report: the AI Node gives only the panel's average. The last readable answer of the
 * model counts: a repair call follows prose, and a retry repeats the jury.
 * @param {object[]} calls - this claim's ledger rows
 * @param {{AI_NODES: Array<{AI_MODEL:string}>}} juryParameters
 * @param {string} callsDir
 * @returns {Array<{model:string, vector:number[]|null}>}
 */
function jurorVectors(calls, juryParameters, callsDir) {
  return juryParameters.AI_NODES.map(({ AI_MODEL: model }) => {
    let vector = null;
    for (const call of calls) {
      if (call.model !== model || !call.response) continue;
      const saved = JSON.parse(fs.readFileSync(path.join(callsDir, call.response), 'utf8'));
      const scores = scoresIn(replyText(saved.body));
      if (scores) vector = scores;
    }
    return { model, vector };
  });
}

const costOf = (calls) => calls.reduce((sum, call) => sum + call.usd, 0);

async function assertMeter(meterHealth, { stopUsd, ledgerFile }) {
  let health;
  try {
    health = await meterHealth();
  } catch (error) {
    throw new Error(`the meter did not answer (${error.message}): a real-jury batch does not run unmetered`);
  }
  if (!health || health.ok !== true) throw new Error('the meter is not healthy: a real-jury batch does not run unmetered');
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
    if (earlier && !(earlier.error && retryErrored)) continue;

    const request = buildClaimRequest(scenario, { deadlineMs: CLAIM_DEADLINE_MS });
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
      jurors: jurorVectors(calls, scenario.input.juryParameters, callsDir),
      spend: {
        usd: costOf(calls),
        calls: calls.map(({ model, status, basis, usd, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reportedUsd }) => ({ model, status, basis, usd, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reportedUsd }))
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

module.exports = { runClaimBatch, jurorVectors, scoresIn, EXIT, MAX_ERRORS_IN_A_ROW };
