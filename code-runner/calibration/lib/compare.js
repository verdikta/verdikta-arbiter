'use strict';

/**
 * What a run showed, against what a case says it must show. Pure, so that the same code judges
 * a real run and a test's, and so that --self-check can alter an expected result and re-compare
 * against the real observation.
 *
 * The comparison is exact on everything that names a reason: a case whose gates match by
 * accident still fails on the test's message, a flag's line or a run's result.
 */

const { isDeepStrictEqual } = require('node:util');
const { codeReview } = require('@verdikta/common');
const { getPath } = require('./format');

const NO_FLAGS = Object.freeze({ existingTestsModified: [], skipMarkersAdded: [], protectedPathsTouched: [] });
const CLASS_ORDER = Object.freeze(['INVALID', 'DUPLICATE', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL', 'ABSTAIN', 'REQUESTER_ERROR']);

const located = (list) => (list || []).map((f) => ({ rule: f.rule, file: f.file, line: f.line }));
const placed = (list) => (list || []).map((f) => ({ kind: f.kind, file: f.file, line: f.line }));

/**
 * The observation of one POST /v1/runs answer.
 * @param {object} answer - the response body
 * @param {object} request - the validated request (for a development report)
 * @param {object} o
 * @param {Function} o.settle - settleReport
 * @param {Function} [o.developmentReport] - (answer, request) => a report, where the runner has none to give (arm64)
 */
function observe(answer, request, { settle, developmentReport }) {
  if (answer.outcome === 'requester_error') {
    return { result: 'requester_error', issues: (answer.issues || []).map((i) => i.code) };
  }
  if (answer.outcome === 'abstain') {
    const a = answer.abstain || {};
    return { result: 'abstain', abstain: { cause: a.cause, step: a.step }, detail: a.detail };
  }
  const report = answer.report || developmentReport(answer, request);
  let settlement;
  try {
    settlement = settle(report);
  } catch (err) {
    if (!err || typeof err.code !== 'string' || !err.code.startsWith('CODE_REVIEW_')) throw err;
    settlement = { kind: 'unreadable', detail: err.message };
  }
  const poc = report.poc;
  const fix = report.fix;
  const integrity = (poc && poc.integrity) || {};
  const factTests = answer.facts && answer.facts.poc && Array.isArray(answer.facts.poc.tests) ? answer.facts.poc.tests : [];
  return {
    result: 'definitive',
    reportSource: answer.report ? 'runner' : 'assembled-for-development',
    gates: report.gates,
    gateDetails: Object.fromEntries(Object.entries(answer.gates || {}).map(([g, v]) => [g, v.detail])),
    settlement,
    integrityFailed: codeReview.INTEGRITY_CHECKS.filter((check) => integrity[check] === false),
    tamperFlags: placed(integrity.tamperFlags),
    honestyFlags: located(poc && poc.honestyFlags),
    tests: poc ? poc.tests : [],
    rawRuns: Object.fromEntries(factTests.map((t) => [t.id, t.runs])),
    flags: report.flags,
    findings: located(report.findings),
    fix: fix && fix.present ? { applies: fix.applies, builds: fix.builds, pocPasses: fix.pocPasses, regressionCount: fix.regressionCount } : null,
    pack: answer.contextPack && Array.isArray(answer.contextPack.files) ? answer.contextPack.files.map((f) => ({ tier: f.tier, text: f.text })) : [],
    packSha256: answer.contextPack ? answer.contextPack.sha256 : null,
    reportSha256: answer.reportSha256 || null
  };
}

/** The label of what happened, in the outcome set's words. */
function actualLabel(observed) {
  if (observed.result === 'abstain') return 'ABSTAIN';
  if (observed.result === 'requester_error') return 'REQUESTER_ERROR';
  const { kind } = observed.settlement;
  if (kind === 'invalid') return 'INVALID';
  if (kind === 'duplicate') return 'DUPLICATE';
  if (kind === 'jury') return 'jury';
  return String(kind).toUpperCase();
}

/**
 * @param {object} expected - a case's expected.runner
 * @param {object} observed - observe()'s
 * @returns {Array<{path:string, expected:*, actual:*}>} empty when they agree
 */
function compareCase(expected, observed) {
  const out = [];
  const same = (at, want, got) => {
    if (!isDeepStrictEqual(want, got)) out.push({ path: at, expected: want === undefined ? null : want, actual: got === undefined ? null : got });
  };
  if (expected.result !== observed.result) {
    // Which abstention, or which refusal: the first thing a reader of this line needs.
    const why = observed.result === 'abstain' ? ` (${observed.abstain.cause} at ${observed.abstain.step}: ${observed.detail})` : observed.result === 'requester_error' ? ` (${observed.issues.join(', ')})` : '';
    out.push({ path: 'result', expected: expected.result, actual: `${observed.result}${why}` });
    return out;
  }
  if (expected.result === 'abstain') {
    same('abstain.cause', expected.abstain.cause, observed.abstain.cause);
    same('abstain.step', expected.abstain.step, observed.abstain.step);
    return out;
  }
  if (expected.result === 'requester_error') {
    same('issues', expected.issues, observed.issues);
    return out;
  }
  for (const gate of new Set([...Object.keys(expected.gates), ...Object.keys(observed.gates || {})])) {
    same(`gates.${gate}`, expected.gates[gate], (observed.gates || {})[gate]);
  }
  for (const [gate, words] of Object.entries(expected.gateDetails || {})) {
    const got = (observed.gateDetails || {})[gate];
    if (typeof got !== 'string' || !got.includes(words)) out.push({ path: `gateDetails.${gate}`, expected: words, actual: got === undefined ? null : got });
  }
  const { reason: _words, ...settled } = observed.settlement || {};
  for (const key of new Set([...Object.keys(expected.settlement), ...Object.keys(settled)])) {
    same(`settlement.${key}`, expected.settlement[key], settled[key]);
  }
  same('integrityFailed', expected.integrityFailed || expected.settlement.failedChecks || [], observed.integrityFailed || []);
  same('tamperFlags', placed(expected.tamperFlags), placed(observed.tamperFlags));
  same('honestyFlags', located(expected.honestyFlags), located(observed.honestyFlags));
  same('tests.length', expected.tests.length, (observed.tests || []).length);
  expected.tests.forEach((t, i) => {
    const got = (observed.tests || [])[i] || {};
    for (const key of ['id', 'runs', 'kind', 'message']) same(`tests.${i}.${key}`, t[key], got[key]);
  });
  same('rawRuns', expected.rawRuns || Object.fromEntries(expected.tests.map((t) => [t.id, t.runs])), observed.rawRuns);
  same('flags', expected.flags || NO_FLAGS, observed.flags);
  same('findings', located(expected.findings), located(observed.findings));
  same('fix', expected.fix === undefined ? null : expected.fix, observed.fix);
  const pack = expected.pack || {};
  (pack.contains || []).forEach((want, i) => {
    const found = (observed.pack || []).some((f) => f.tier === want.tier && f.text.includes(want.text));
    if (!found) out.push({ path: `pack.contains.${i}`, expected: want, actual: 'not in that tier of the pack' });
  });
  (pack.absent || []).forEach((words, i) => {
    const at = (observed.pack || []).find((f) => f.text.includes(words));
    if (at) out.push({ path: `pack.absent.${i}`, expected: `no ${JSON.stringify(words)}`, actual: `in tier ${at.tier}` });
  });
  return out;
}

/** The relation between a case and its control, on what was observed. */
function relationProblems(control, observedCase, observedControl) {
  const out = [];
  for (const p of control.differsIn || []) {
    if (isDeepStrictEqual(getPath(observedCase, p), getPath(observedControl, p))) out.push(`relation: ${p} did not differ between the case and its control (differsIn)`);
  }
  for (const p of control.sameIn || []) {
    if (!isDeepStrictEqual(getPath(observedCase, p), getPath(observedControl, p))) out.push(`relation: ${p} differed between the case and its control (sameIn)`);
  }
  return out;
}

function clone(v) {
  return JSON.parse(JSON.stringify(v));
}

function setPath(root, parts, value) {
  let at = root;
  for (const part of parts.slice(0, -1)) at = at[part];
  at[parts[parts.length - 1]] = value;
}

function alteredLeaf(value) {
  if (typeof value === 'string') return `${value}-altered`;
  if (typeof value === 'number') return value + 1;
  if (typeof value === 'boolean') return !value;
  return 'altered';
}

/**
 * Every way to change an expected result by one value, each of which the comparison must notice.
 * Not `pack.absent`, which any other text satisfies, and not the removal of an item of what the
 * pack must contain: those relax a check, and do not state another reason.
 * @param {object} runner - expected.runner
 * @yields {{label:string, runner:object}}
 */
function* mutations(runner) {
  function* walk(value, parts) {
    const label = parts.join('.');
    if (Array.isArray(value)) {
      const inPack = parts[0] === 'pack';
      if (!inPack) {
        const longer = clone(runner);
        setPath(longer, parts, [...value, value.length && typeof value[0] === 'string' ? 'altered' : { rule: 'verdikta.altered.rule', file: 'x', line: 1, id: 'x', runs: [], kind: 'x', message: 'x' }]);
        yield { label: `${label}: one more`, runner: longer };
        if (value.length > 0) {
          const shorter = clone(runner);
          setPath(shorter, parts, value.slice(0, -1));
          yield { label: `${label}: one fewer`, runner: shorter };
        }
      }
      for (let i = 0; i < value.length; i += 1) yield* walk(value[i], [...parts, String(i)]);
      return;
    }
    if (value !== null && typeof value === 'object') {
      for (const [key, v] of Object.entries(value)) yield* walk(v, [...parts, key]);
      return;
    }
    const changed = clone(runner);
    setPath(changed, parts, alteredLeaf(value));
    yield { label, runner: changed };
  }
  const { pack, ...rest } = runner;
  for (const [key, value] of Object.entries(rest)) yield* walk(value, [key]);
  if (pack && pack.contains) yield* walk(pack.contains, ['pack', 'contains']);
}

const classOf = (expected) => expected.class || expected.outcome;

/**
 * Agreement per expected class. `reachJury` is the part of a class the runner cannot decide: A7d measures those.
 * @param {Array<{id:string, expected:{outcome:string,class:string|null}, actual:string, disagreements:object[]}>} results
 */
function agreement(results) {
  const rows = new Map();
  for (const r of results) {
    const key = classOf(r.expected);
    if (!rows.has(key)) rows.set(key, { class: key, cases: 0, agreed: 0, disagreed: 0, settledByRunner: 0, reachJury: 0, abstained: 0 });
    const row = rows.get(key);
    row.cases += 1;
    if (r.disagreements.length) row.disagreed += 1;
    else row.agreed += 1;
    if (r.actual === 'jury') row.reachJury += 1;
    else if (r.actual === 'ABSTAIN') row.abstained += 1;
    else if (r.actual === 'INVALID' || r.actual === 'DUPLICATE') row.settledByRunner += 1;
  }
  const order = (k) => {
    const at = CLASS_ORDER.indexOf(k);
    return at < 0 ? CLASS_ORDER.length : at;
  };
  const sorted = [...rows.values()].sort((a, b) => order(a.class) - order(b.class));
  return { total: results.length, disagreed: results.filter((r) => r.disagreements.length).length, rows: sorted };
}

/** What fired on a case, in a few words: the gates that failed, the settlement's check, the flags' rules, the abstention. */
function firedSummary(observed) {
  if (!observed) return '';
  if (observed.result === 'abstain') return `abstain: ${observed.abstain.cause} at ${observed.abstain.step}`;
  if (observed.result === 'requester_error') return `refused: ${observed.issues.join(', ')}`;
  const failed = Object.entries(observed.gates || {}).filter(([, status]) => status === 'fail').map(([gate]) => gate);
  const check = observed.settlement && observed.settlement.check;
  const rules = [...new Set((observed.honestyFlags || []).map((f) => f.rule.replace('verdikta.honesty.', '')))];
  const words = [failed.length ? `failed: ${failed.join(', ')}${check ? ` (${check})` : ''}` : 'every gate passed'];
  if (rules.length) words.push(`flags: ${rules.join(', ')}`);
  return words.join('; ');
}

function renderReport({ results, runner, note = null }) {
  const lines = [];
  const pad = (s, n) => String(s).padEnd(n);
  const width = Math.max(4, ...results.map((r) => r.id.length));
  lines.push(`calibration: ${results.length} cases, runner ${runner.version} under ${runner.runtime} on ${runner.platform} (gVisor: ${runner.gvisor})`);
  if (note) lines.push(`calibration: ${note}`);
  lines.push('');
  lines.push(`${pad('case', width)}  ${pad('expected', 9)}  ${pad('actual', 9)}  ${pad('agrees', 6)}  what fired`);
  for (const r of results) {
    lines.push(`${pad(r.id, width)}  ${pad(classOf(r.expected), 9)}  ${pad(r.actual, 9)}  ${pad(r.disagreements.length ? 'NO' : 'yes', 6)}  ${firedSummary(r.observed)}`.trimEnd());
    for (const d of r.disagreements) {
      if (typeof d === 'string') lines.push(`  ${d}`);
      else lines.push(`  ${d.path}: expected ${JSON.stringify(d.expected)}, actual ${JSON.stringify(d.actual)}`);
    }
  }
  const table = agreement(results);
  lines.push('');
  lines.push('per class (expected; "reach jury" is what the runner leaves to the jury, which A7d measures)');
  lines.push(`${pad('class', 16)}  ${pad('cases', 5)}  ${pad('agree', 5)}  ${pad('differ', 6)}  ${pad('settled', 7)}  ${pad('reach jury', 10)}  abstain`);
  for (const row of table.rows) {
    lines.push(`${pad(row.class, 16)}  ${pad(row.cases, 5)}  ${pad(row.agreed, 5)}  ${pad(row.disagreed, 6)}  ${pad(row.settledByRunner, 7)}  ${pad(row.reachJury, 10)}  ${row.abstained}`);
  }
  lines.push('');
  lines.push(table.disagreed
    ? `calibration: ${table.disagreed} of ${table.total} cases disagree`
    : `calibration: all ${table.total} cases agree`);
  return lines.join('\n');
}

module.exports = { observe, compareCase, relationProblems, mutations, agreement, renderReport, actualLabel, classOf };
