#!/usr/bin/env node
'use strict';

/**
 * What differs in what the jury would read between two exports of the same claims (node A7d): one run under gVisor and
 * one under runc, say. The jury's prompt is a pure function of the AI Node's request (ai-node/src/lib/code-review/
 * claim-prompt.ts), so this compares the requests the tool would send, path by path.
 *
 *   node src/claim-diff.js <claims dir A> <claims dir B> [--json <file>] [--results <A file> <B file>]
 *
 * A value goes to the output only on the short list below, which are hashes and the runtime's name. Everything else that
 * differs is named by its path and the length and hash of each side, since a pack holds repository source: this output
 * may leave the machine, and a pack may not.
 *
 * Exit 0 when the two hold the same scenarios and differ only in EXPECTED paths; 1 otherwise.
 */

const crypto = require('crypto');
const fs = require('fs');
const { isDeepStrictEqual } = require('util');
const { loadClaimScenarios, buildClaimRequest, CLAIM_DEADLINE_MS } = require('./claim-scenarios');

/**
 * What differs between any two runs, whatever the runtime: the listing archive names the throwaway registry's port and
 * a disclosure key generated for the run, so its CID, the attestation's digest and the report's own hash move.
 */
const RUN_SPECIFIC = Object.freeze([
  /^codeReview\.report\.inputs\.listingCid$/,
  /^codeReview\.report\.inputs\.attestationSha256$/,
  /^codeReview\.reportSha256$/,
  /^prompt$/,
  /^codeReview\.deadlineMs$/
]);
/** What a change of runtime moves, and nothing else should. */
const RUNTIME_SPECIFIC = Object.freeze([/^codeReview\.report\.inputs\.gvisor$/]);
const SHOW_VALUE = Object.freeze([...RUN_SPECIFIC.slice(0, 3), ...RUNTIME_SPECIFIC]);

const matches = (list, where) => list.some((pattern) => pattern.test(where));
const digest = (value) => crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value === undefined ? null : value)).digest('hex').slice(0, 16);
const size = (value) => (typeof value === 'string' ? value.length : JSON.stringify(value === undefined ? null : value).length);

/** Every path at which two JSON values differ. */
function differences(a, b, at = '') {
  if (isDeepStrictEqual(a, b)) return [];
  if (a && b && typeof a === 'object' && typeof b === 'object' && Array.isArray(a) === Array.isArray(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].sort().flatMap((key) => differences(a[key], b[key], at ? `${at}.${key}` : key));
  }
  return [{ path: at, a, b }];
}

/** A value is shown only from the short list: a prompt holds the listing's words, and a pack a repository's. */
function describe({ path, a, b }) {
  const out = { path, kind: matches(RUN_SPECIFIC, path) ? 'run' : matches(RUNTIME_SPECIFIC, path) ? 'runtime' : 'unexpected' };
  if (matches(SHOW_VALUE, path)) return { ...out, a, b };
  return { ...out, a: { length: size(a), sha256: digest(a) }, b: { length: size(b), sha256: digest(b) } };
}

/**
 * The query names only hashes and the run's key where the two runs differ, so it is compared with those masked: a
 * difference in its words is a difference in what the jury reads.
 */
function maskRunValues(text, values) {
  return values.filter(Boolean).reduce((out, value) => out.split(value).join('<run-value>'), text);
}

/**
 * @param {string} dirA
 * @param {string} dirB
 * @returns {Promise<{ok:boolean, scenarios:object[], onlyInA:string[], onlyInB:string[]}>}
 */
async function diffExports(dirA, dirB) {
  const [listA, listB] = await Promise.all([loadClaimScenarios(dirA), loadClaimScenarios(dirB)]);
  const byId = (list) => new Map(list.map((scenario) => [scenario.scenario_id, scenario]));
  const [a, b] = [byId(listA), byId(listB)];
  const onlyInA = [...a.keys()].filter((id) => !b.has(id));
  const onlyInB = [...b.keys()].filter((id) => !a.has(id));
  const scenarios = [];
  for (const [id, left] of a) {
    const right = b.get(id);
    if (!right) continue;
    const request = (scenario) => buildClaimRequest(scenario, { deadlineMs: CLAIM_DEADLINE_MS });
    const [ra, rb] = [request(left), request(right)];
    const found = differences(ra, rb).map(describe);
    const runValues = (s) => [s.stake && s.stake.disclosureKey, s.input.report.inputs.listingCid, s.input.report.inputs.attestationSha256];
    const queryEqual = maskRunValues(ra.prompt, runValues(left)) === maskRunValues(rb.prompt, runValues(right));
    scenarios.push({
      id,
      attachmentsEqual: isDeepStrictEqual(ra.attachments, rb.attachments) && isDeepStrictEqual(ra.attachmentNames, rb.attachmentNames),
      queryEqualButForRunValues: queryEqual,
      packTokens: left.input.contextPack.usedTokens,
      requestBytes: { a: Buffer.byteLength(JSON.stringify(ra)), b: Buffer.byteLength(JSON.stringify(rb)) },
      differences: found.filter((d) => d.kind !== 'run' || d.path !== 'prompt' || !queryEqual)
    });
  }
  const unexpected = (s) => s.differences.some((d) => d.kind === 'unexpected') || !s.queryEqualButForRunValues || !s.attachmentsEqual;
  return { ok: onlyInA.length === 0 && onlyInB.length === 0 && !scenarios.some(unexpected), scenarios, onlyInA, onlyInB };
}

/**
 * The harness's --results of the same listing from two runs, every case, also those no jury reads: what the runner
 * observed must be the same. The report's own hash and a gate's words are left out: both name a run.
 * @param {object} a - a verdikta.calibration-results/1
 * @param {object} b
 * @returns {Array<{id:string, path:string}>}
 */
function diffResults(a, b) {
  const comparable = ({ observed = {}, actual, expected }) => {
    const { reportSha256: _hash, gateDetails: _words, ...rest } = observed;
    return { actual, expected, observed: rest };
  };
  const byId = (file) => new Map(file.cases.map((entry) => [entry.id, entry]));
  const [left, right] = [byId(a), byId(b)];
  const out = [];
  for (const id of new Set([...left.keys(), ...right.keys()])) {
    if (!left.has(id) || !right.has(id)) out.push({ id, path: 'only on one side' });
    else for (const found of differences(comparable(left.get(id)), comparable(right.get(id)))) out.push({ id, path: found.path });
  }
  return out;
}

function render(result) {
  const lines = [];
  for (const s of result.scenarios) {
    const moved = s.differences.filter((d) => d.kind !== 'run').map((d) => (d.kind === 'runtime' ? `${d.path}: ${d.a} / ${d.b}` : `UNEXPECTED ${d.path}`));
    lines.push(`${s.id}: pack ${s.packTokens} tokens, request ${s.requestBytes.a} bytes, attachments ${s.attachmentsEqual ? 'same' : 'DIFFER'}, query ${s.queryEqualButForRunValues ? 'same' : 'DIFFERS'}${moved.length ? `; ${moved.join('; ')}` : ''}`);
  }
  for (const id of result.onlyInA) lines.push(`${id}: only in the first`);
  for (const id of result.onlyInB) lines.push(`${id}: only in the second`);
  lines.push(result.ok ? `claim-diff: ${result.scenarios.length} scenario(s): what the jury reads is the same, but for the runtime's name and the run's own hashes` : 'claim-diff: what the jury reads DIFFERS');
  return lines.join('\n');
}

if (require.main === module) {
  const [dirA, dirB, ...rest] = process.argv.slice(2);
  const option = (name, count) => {
    const at = rest.indexOf(name);
    return at < 0 ? null : rest.slice(at + 1, at + 1 + count);
  };
  const json = option('--json', 1);
  const results = option('--results', 2);
  if (!dirA || !dirB || (json && json.length !== 1) || (results && results.length !== 2)) {
    process.stderr.write('usage: claim-diff <claims dir A> <claims dir B> [--json <file>] [--results <A file> <B file>]\n');
    process.exit(2);
  }
  diffExports(dirA, dirB).then((result) => {
    const observed = results ? diffResults(...results.map((file) => JSON.parse(fs.readFileSync(file, 'utf8')))) : [];
    process.stdout.write(`${render(result)}\n`);
    for (const { id, path: where } of observed) process.stdout.write(`${id}: the runner observed something else at ${where}\n`);
    if (results) process.stdout.write(`claim-diff: results compared, ${observed.length} difference(s)\n`);
    if (json) fs.writeFileSync(json[0], `${JSON.stringify({ ...result, observed }, null, 2)}\n`);
    process.exit(result.ok && observed.length === 0 ? 0 : 1);
  }, (error) => {
    process.stderr.write(`claim-diff: ${error.message}\n`);
    process.exit(2);
  });
}

module.exports = { differences, diffExports, diffResults, render };
