'use strict';

/**
 * What the claim suite asserts, as pure functions of what it recorded, so each can be
 * tested against what it must refuse (src/__tests__/claim-suite.test.js). The rule that
 * shapes them: a claim scenario passes only on what happened, never on what did not. An
 * abstention, a run with no report, a juror that was not called: each fails here.
 */

const { ethers } = require('ethers');
const { assert } = require('../../assertions');

const SCORE_TOTAL = 1000000;
const CLASS_PLATFORM = 'linux/amd64';
const REPORT_GATES = ['applies', 'testPathsOnly', 'build', 'reproduces', 'integrity', 'claimedObservable'];

/** The code runner's answer to POST /v1/runs. `classPlatform`: this run was on linux/amd64, with no local substitution. */
function runChecks(run, { classPlatform }) {
  if (!run) return [assert('run.answered', false, 'the runner was never called')];
  const checks = [];
  const platform = run.runner && run.runner.platform;
  checks.push(assert('run.definitive', run.outcome === 'definitive', `outcome=${run.outcome}${run.abstain ? `, abstain=${JSON.stringify(run.abstain).slice(0, 300)}` : ''}`));
  checks.push(assert('run.report', Boolean(run.report) && Boolean(run.reportSha256) && !run.reportUnavailable,
    run.reportUnavailable ? `reportUnavailable: ${run.reportUnavailable}` : `reportSha256=${run.reportSha256}`));
  if (classPlatform) {
    checks.push(assert('run.platform', platform === CLASS_PLATFORM, `the run used ${platform}`));
  } else {
    // Loud on purpose: this line is how a local run says what it did not cover.
    checks.push(assert('run.platform', platform !== CLASS_PLATFORM,
      `LOCAL: forge ran on ${platform}; the harness's launcher built the report through the runner's own function, which names linux/amd64 because the schema's platform is a constant. CI runs the real class platform and refuses this launcher`));
  }
  return checks;
}

/** A report's gates, all passed: the claim reached the jury on its merits. */
function gatesPassed(report) {
  const gates = (report && report.gates) || {};
  const bad = REPORT_GATES.filter((g) => gates[g] !== 'pass');
  return assert('report.everyGatePassed', Boolean(report) && bad.length === 0, bad.length ? `not passed: ${bad.map((g) => `${g}=${gates[g]}`).join(', ')}` : '');
}

/** What the EA sent the AI Node for a claim, and what came back. */
function aiRequestChecks(call, { pack, reportSha256, deadlineLimitMs, validate }) {
  if (!call) return [assert('ai.called', false, 'the AI Node was never called')];
  const checks = [];
  const cr = call.request && call.request.codeReview;
  const verdict = cr ? validate(cr) : { ok: false, issues: [] };
  checks.push(assert('ai.codeReview', Boolean(cr) && verdict.ok, cr ? (verdict.ok ? '' : JSON.stringify(verdict.issues).slice(0, 300)) : 'no codeReview field'));
  const deadline = cr && cr.deadlineMs;
  checks.push(assert('ai.deadlineMs', Number.isInteger(deadline) && deadline > 0 && deadline <= deadlineLimitMs, `deadlineMs=${deadline}, at most ${deadlineLimitMs}`));
  checks.push(assert('ai.reportSha256', Boolean(cr) && cr.reportSha256 === reportSha256, `sent ${cr && cr.reportSha256}, the run's ${reportSha256}`));
  const files = (pack && pack.files) || [];
  const attachments = (call.request && call.request.attachments) || [];
  const names = (call.request && call.request.attachmentNames) || [];
  const sameFiles = files.length > 0 && files.length === attachments.length
    && files.every((f, i) => attachments[i] === f.text && names[i] === f.name);
  checks.push(assert('ai.pack', sameFiles, `${attachments.length} attachment(s), the pack has ${files.length} file(s)`));
  checks.push(assert('ai.answered', call.status === 200, `HTTP ${call.status}${call.status === 200 ? '' : `: ${JSON.stringify(call.response).slice(0, 300)}`}`));
  const answer = call.response && call.response.codeReview;
  checks.push(assert('ai.deadlinePlanned', Boolean(answer) && answer.deadlineMs === deadline && answer.reportSha256 === reportSha256,
    answer ? `answered deadlineMs=${answer.deadlineMs}, jurorTimeoutMs=${answer.jurorTimeoutMs}, justifierReserveMs=${answer.justifierReserveMs}` : 'no codeReview block in the answer'));
  return checks;
}

/**
 * The provider layer, from the mock provider's call log: every juror of the panel, once,
 * with web off, an abort signal, the class's output tokens and effort high, on one prompt
 * that holds the report and the pack; then the justifier, web off.
 */
function providerChecks(calls, { panel, justifier, reportSha256, markers, maxTokens }) {
  const isJuror = (c) => panel.some((p) => p.model === c.model && p.provider === c.provider);
  const jurors = calls.filter(isJuror);
  const checks = [];
  const missing = panel.filter((p) => jurors.filter((c) => c.model === p.model && c.provider === p.provider).length !== 1);
  checks.push(assert('provider.everyJuror', missing.length === 0 && jurors.length === panel.length,
    missing.length ? `not called exactly once: ${missing.map((p) => `${p.provider}:${p.model}`).join(', ')}` : `${jurors.length} juror(s): ${jurors.map((c) => c.model).join(', ')}`));
  checks.push(assert('provider.answered', jurors.length > 0 && jurors.every((c) => c.outcome === 'answered'), jurors.map((c) => `${c.model}=${c.outcome}`).join(', ')));
  const all = calls.filter((c) => isJuror(c) || (c.model === justifier.model && c.provider === justifier.provider));
  checks.push(assert('provider.webOff', all.length > 0 && all.every((c) => c.options && c.options.webAccess === false), all.map((c) => `${c.model}: webAccess=${c.options && c.options.webAccess}`).join(', ')));
  checks.push(assert('provider.signal', all.length > 0 && all.every((c) => c.options && c.options.signal === true), 'the deadline reaches a provider through its abort signal'));
  checks.push(assert('provider.envelope', jurors.length > 0 && jurors.every((c) => c.options && c.options.maxTokens === maxTokens && c.options.effort === 'high'),
    jurors.map((c) => `${c.model}: maxTokens=${c.options && c.options.maxTokens}, effort=${c.options && c.options.effort}`).join('; ')));
  const holds = (c) => c.prompt.includes(reportSha256) && markers.every((m) => c.prompt.includes(m));
  checks.push(assert('provider.reportAndPack', jurors.length > 0 && jurors.every(holds), `the report's hash and ${markers.length} marker(s) from the report and the pack`));
  checks.push(assert('provider.onePrompt', jurors.length > 0 && jurors.every((c) => c.prompt === jurors[0].prompt), 'the same bytes for every juror'));
  const just = calls.filter((c) => c.model === justifier.model && c.provider === justifier.provider);
  checks.push(assert('provider.justifier', just.length === 1 && just[0].outcome === 'answered', `${just.length} call(s) to ${justifier.provider}:${justifier.model}`));
  return checks;
}

/**
 * The vault's documented deposit rule reached the jury (A15): the pack's source tier holds src/Vault.sol with the
 * line, and every juror of the panel read it. Without it the jurors split on what deposit must do.
 */
function depositRuleChecks(pack, calls, { panel, rule }) {
  const sources = ((pack && pack.files) || []).filter((f) => f.tier === 'source');
  const vault = sources.find((f) => typeof f.text === 'string' && f.text.startsWith('# source file: src/Vault.sol\n'));
  const jurors = calls.filter((c) => panel.some((p) => p.model === c.model && p.provider === c.provider));
  const reading = jurors.filter((c) => typeof c.prompt === 'string' && Boolean(rule) && c.prompt.includes(rule));
  return [
    assert('pack.depositRule', Boolean(rule) && Boolean(vault) && vault.text.includes(rule),
      vault ? 'src/Vault.sol is in the source tier' : `no src/Vault.sol among ${sources.length} source file(s)`),
    assert('provider.depositRule', Boolean(rule) && jurors.length === panel.length && reading.length === jurors.length,
      `${reading.length} of ${jurors.length} juror prompt(s) hold it, for a panel of ${panel.length}`)
  ];
}

function scoreChecks(got, expected) {
  return [assert('scores.juryAverage', Array.isArray(got) && got.length === expected.length && got.every((v, i) => Number(v) === expected[i]),
    `got ${JSON.stringify(got)}, the jurors' weighted average is ${JSON.stringify(expected)}`)];
}

/** All weight on the first outcome, INVALID. */
function invalidScoreChecks(got) {
  const ok = Array.isArray(got) && got.length === 6 && Number(got[0]) === SCORE_TOTAL && got.slice(1).every((v) => Number(v) === 0);
  return [assert('scores.allOnInvalid', ok, `got ${JSON.stringify(got)}`)];
}

/** Nothing reached the AI Node or a provider between two counts. */
function noAiChecks(before, after) {
  return [
    assert('noAi.aiNode', after.aiCalls === before.aiCalls, `${after.aiCalls - before.aiCalls} call(s) to the AI Node`),
    assert('noAi.provider', after.providerCalls === before.providerCalls, `${after.providerCalls - before.providerCalls} provider call(s)`)
  ];
}

/** The commitment is the first 128 bits of sha256(abi.encode(operator, scores, salt)), as the aggregator checks it at reveal. */
function commitmentChecks(commitment, scores, cidWithSalt, operator) {
  const salt = String(cidWithSalt).split(':')[1];
  if (!Array.isArray(scores) || !/^[0-9a-f]{20}$/.test(salt || '')) {
    return [assert('commit.recomputed', false, `scores=${JSON.stringify(scores)}, salt=${salt}`)];
  }
  const encoded = ethers.AbiCoder.defaultAbiCoder().encode(['address', 'uint256[]', 'uint256'], [operator, scores.map(BigInt), BigInt(`0x${salt}`)]);
  const recomputed = BigInt(`0x${ethers.sha256(encoded).slice(2, 34)}`).toString();
  return [assert('commit.recomputed', recomputed === String(commitment), `committed ${commitment}, the reveal hashes to ${recomputed}`)];
}

/**
 * The env image came from the registry, by digest: not by tag, not from what the daemon had.
 * What follows the push is the pull. (Under Docker's containerd store it also asks for a
 * `sha256-…` tag, the referrers fallback for that digest.)
 */
function pullChecks(run, manifestRequests, image) {
  const digest = String(image).split('@')[1];
  const repo = String(image).split('@')[0].split('/').slice(1).join('/');
  const requests = manifestRequests.filter((r) => r.repo === repo);
  const pushedAt = requests.map((r) => r.method).lastIndexOf('PUT');
  const pull = requests.slice(pushedAt + 1);
  return [
    assert('image.pulled', Boolean(run && run.image) && run.image.cache === 'pulled', `cache=${run && run.image && run.image.cache}`),
    assert('image.byDigest', pull.some((r) => r.reference === digest) && pull.every((r) => r.reference.startsWith('sha256')),
      `after the push, ${pull.length} manifest request(s) for ${repo}: ${[...new Set(pull.map((r) => `${r.method} ${r.reference.slice(0, 19)}`))].join(', ')}`)
  ];
}

/** Every CID a scenario fetched came from here. */
function ipfsChecks(ipfs) {
  return [assert('ipfs.noMisses', ipfs.misses.length === 0, ipfs.misses.length ? `asked for what it does not hold: ${ipfs.misses.join(', ')}` : `${ipfs.fetches.length} fetch(es), ${ipfs.pins.length} pin(s)`)];
}

module.exports = {
  SCORE_TOTAL, CLASS_PLATFORM, runChecks, gatesPassed, aiRequestChecks, providerChecks, depositRuleChecks, scoreChecks, invalidScoreChecks, noAiChecks, commitmentChecks, pullChecks, ipfsChecks
};
