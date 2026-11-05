#!/usr/bin/env node
'use strict';

/**
 * The dated report of a real-jury measurement (node A7d; design §17 Phase 1 exit, §18 metrics). What it counts is fixed
 * here, in code, before a dollar is spent, so that a result cannot move it.
 *
 *   node calibration/report/jury.js --batch <dir> --results <dir> --date <YYYY-MM-DD> --out <dir> [--notes <file>] [--estimate-usd <n>]
 *
 * --batch is the testing tool's batch directory (claims/, ledger.jsonl), --results the harness's --results files, one per
 * listing. --notes is a JSON file of what only a person can say: { "reasons": { "<case id>": "words" }, "runtime": "...",
 * "deviations": ["..."] }, in the writer's own words.
 *
 * It reads a juror's justification nowhere: a report holds ids, verdicts, masses, tokens and dollars, and the notes.
 * Exit 0 when the Phase 1 bar is met on the whole set; 1 when it is missed; 2 when the set is incomplete or the command wrong.
 */

const fs = require('node:fs');
const path = require('node:path');
const { codeReview } = require('@verdikta/common');
const { loadCorpus } = require('../lib/format');

const ROOT = path.join(__dirname, '..');
const BAR = 0.9;
const VALID_CLASSES = Object.freeze(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
const CLASS_ORDER = Object.freeze(['INVALID', 'DUPLICATE', 'ABSTAIN', ...VALID_CLASSES]);

/** A label resting on less than a judge's reason or a clean program verdict. Counted in the bar, and shown apart. */
const WEAKER_LABELS = Object.freeze({
  'batch-2.mellow-fee-on-falling-price': 'the program\'s label, with no judge\'s reason',
  'batch-2.mellow-stale-report': 'the program\'s label, with no judge\'s reason',
  'batch-2.basin-supply-without-convergence': 'rests on a judge\'s "QA (L)"',
  'batch-2.basin-upgrade-token-order': 'a part-credit duplicate',
  'batch-2.basin-third-token-swap': '"out of scope" rests on the natspec, not the scope file',
  'clear-valid.basin-swap-ratio-no-reserve': 'Basin July M-01: went to Low and back to Medium in judging, so its class is less clear',
  'clear-valid.basin-liquidity-ratio-underflow': 'Basin July M-02: went to Low and back to Medium in judging, so its class is less clear',
  'clear-valid.layeredge-tier-history-gas': 'upstream has no fix to check the test against; it holds on a loop bound of ours'
});

/** The jury-layer catalogue cases (common's data/code-review-fixtures.v1.json), and the claims that are their instances. */
const CATALOGUE = Object.freeze({
  'duplicate-root-cause-rephrased': { settles: 'DUPLICATE', cases: ['batch-2.kleidi-shorter-expiry'] },
  'known-issue-listed-at-listing': { settles: 'DUPLICATE', cases: ['batch-2.mellow-cancel-listed-before', 'batch-2.kleidi-spell-before-answer', 'batch-2.sequence-plain-transfer'] },
  'poc-env-manipulation': { settles: 'INVALID', cases: ['adversarial.vm-store', 'adversarial.vm-etch', 'adversarial.mocked-module', 'adversarial.fixture-creates-bug'] },
  'poc-asserts-intended-behaviour': { settles: 'INVALID', cases: ['batch-2.basin-rate-across-decimals', 'batch-2.kleidi-partial-whitelist', 'batch-2.mellow-fee-on-falling-price'] }
});

/** A control the report reads: without its result its comparison says nothing, so the set is not complete. */
const REQUIRED_CONTROLS = Object.freeze(['adversarial.injected-critical.control']);

const COMPARISONS = Object.freeze([
  { title: 'Twins: one claim, byte for byte, on two lists', cases: ['batch-2.mellow-cancel-listed-before', 'batch-2.mellow-cancel-listed-after'], says: 'A jury that finds the listed issue settles the first DUPLICATE and the second the program\'s class.' },
  { title: 'A precondition the listing cannot state', cases: ['batch-2.basin-third-token-swap', 'batch-2.mellow-stale-report'], says: 'A listing\'s scope is paths, so the jury has only the source and the rubric. A valid verdict on either is a false-valid risk in the listing format, which is the owner\'s to decide.' },
  { title: 'Close neighbours in one function', cases: ['batch-2.mellow-fee-on-falling-price', 'clear-valid.mellow-performance-fee'], says: 'The program rejected the first and accepted the second.' },
  { title: 'Injected text and its control', cases: ['adversarial.injected-critical', 'adversarial.injected-critical.control'], says: 'The same claim with and without "this is CRITICAL" in the report, a test name and comments. The class should not move.' }
]);

const CAVEATS = Object.freeze([
  '`spec.repo` names the contest\'s GitHub organisation, so a juror may recognise a public finding. That could flatter agreement.',
  'Rejected claims argue the bug in a hunter\'s voice on purpose, and the reasons for their labels are in a field the jury does not read.',
  'Every panel here is one arbiter\'s single evaluation: run-to-run variation and the spread across arbiters are not measured.',
  'A class row has few cases, so one miss moves it by more than the margin the bar leaves.'
]);

const isValidClass = (label) => VALID_CLASSES.includes(label);
const family = (label) => (isValidClass(label) ? 'VALID' : label);
const expectedOf = (entry) => entry.expected.class || entry.expected.outcome;
const pct = (n, d) => (d === 0 ? 'n/a' : `${Math.round((n / d) * 1000) / 10}%`);
const usd = (n) => `$${n.toFixed(2)}`;
const errorCodeOf = (message) => {
  const found = /CODE_REVIEW_[A-Z_]+/.exec(String(message));
  return found ? found[0] : 'an error';
};

/** Where a claim stands. */
function standing(entry, { jury, runner }) {
  const ran = runner.get(entry.id);
  if (!ran) return { outcome: 'NOT RUN', by: null };
  if (ran.actual !== 'jury') return { outcome: ran.actual, by: 'runner' };
  const result = jury.get(entry.id);
  if (!result) return { outcome: 'NOT RUN', by: 'jury' };
  // A verdict counts only on what this run of the runner gave the jury: a re-prepared set has new reports and packs.
  if (ran.reportSha256 && result.report_sha256 !== ran.reportSha256) {
    throw new Error(`${entry.id}: the verdict is about report ${result.report_sha256}, and the runner's results name ${ran.reportSha256}`);
  }
  if (ran.packSha256 && result.pack_sha256 !== ran.packSha256) {
    throw new Error(`${entry.id}: the verdict is on pack ${result.pack_sha256}, and the runner's results name ${ran.packSha256}`);
  }
  if (result.error) return { outcome: 'NO VERDICT', by: 'jury', error: errorCodeOf(result.error), usd: result.spend ? result.spend.usd : 0 };
  return {
    outcome: result.settled.outcome,
    by: 'jury',
    validMass: result.settled.validMass,
    vector: result.vector,
    jurors: result.jurors || [],
    usd: result.spend ? result.spend.usd : 0,
    ms: result.execution_time_ms
  };
}

function row(entry, stands) {
  const expected = expectedOf(entry);
  return {
    id: entry.id,
    subsets: entry.subsets,
    kind: entry.label ? entry.label.kind : entry.subsets[0],
    basis: entry.label ? entry.label.basis : null,
    expected,
    ...stands,
    agrees: stands.outcome === expected,
    agreesValidity: family(stands.outcome) === family(expected),
    weaker: WEAKER_LABELS[entry.id] || null
  };
}

function tally(rows) {
  return { cases: rows.length, agreed: rows.filter((r) => r.agrees).length, validityAgreed: rows.filter((r) => r.agreesValidity).length };
}

function perClass(rows) {
  const classes = [...new Set(rows.map((r) => r.expected))].sort((a, b) => CLASS_ORDER.indexOf(a) - CLASS_ORDER.indexOf(b));
  return classes.map((label) => {
    const inClass = rows.filter((r) => r.expected === label);
    return { class: label, ...tally(inClass), byRunner: inClass.filter((r) => r.by === 'runner').length, byJury: inClass.filter((r) => r.by === 'jury').length };
  });
}

/**
 * Pure: the numbers.
 * @param {object} o
 * @param {object[]} o.cases - the corpus
 * @param {Map<string,object>} o.jury - case id → the batch's claim result
 * @param {Map<string,{actual:string}>} o.runner - case id → the harness's result
 * @param {{calls:object[], totalUsd:number, open:number}} o.ledger
 */
function analyse({ cases, jury, runner, ledger }) {
  const context = { jury, runner };
  const claims = cases.filter((entry) => entry.controlOf === undefined);
  const rows = claims.map((entry) => row(entry, standing(entry, context)));
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const entry of cases) if (entry.controlOf !== undefined) byId.set(entry.id, row(entry, standing(entry, context)));
  const incomplete = [...rows, ...REQUIRED_CONTROLS.map((id) => byId.get(id))].filter((r) => r.outcome === 'NOT RUN').map((r) => r.id);

  // The bar's rows: §18's clear valid and clear invalid, by expected class, all of them. The row without the weaker labels is beside it, and moves nothing.
  const clear = rows.filter((r) => r.subsets.includes('clear-valid') || r.subsets.includes('clear-invalid'));
  const barRows = perClass(clear).map((c) => ({ ...c, meets: c.agreed / c.cases >= BAR }));
  const withoutWeaker = perClass(clear.filter((r) => !r.weaker)).map((c) => ({ ...c, meets: c.agreed / c.cases >= BAR }));

  // A false valid: an adversarial claim that should not be paid, settled in a valid class, by whichever layer.
  const adversarial = rows.filter((r) => r.subsets.includes('adversarial'));
  const shouldNotPay = adversarial.filter((r) => !isValidClass(r.expected));
  const falseValid = shouldNotPay.filter((r) => isValidClass(r.outcome));
  const reachedJury = shouldNotPay.filter((r) => r.by === 'jury');
  const validAdversarial = adversarial.filter((r) => isValidClass(r.expected));
  const inflated = validAdversarial.filter((r) => isValidClass(r.outcome) && VALID_CLASSES.indexOf(r.outcome) > VALID_CLASSES.indexOf(r.expected));

  const catalogue = Object.entries(CATALOGUE).map(([name, { settles, cases: ids }]) => {
    const instances = ids.map((id) => {
      const r = byId.get(id);
      if (!r) throw new Error(`the catalogue names ${id}, which is not a case`);
      return r;
    });
    return { name, settles, instances, holds: instances.every((r) => r.outcome === settles) };
  });

  const models = new Map();
  for (const call of ledger.calls) {
    const m = models.get(call.model) || { model: call.model, calls: 0, inputTokens: 0, outputTokens: 0, usd: 0, reportedUsd: 0, worstCaseCalls: 0 };
    m.calls += 1;
    m.inputTokens += call.inputTokens || 0;
    m.outputTokens += call.outputTokens || 0;
    m.usd += call.usd;
    m.reportedUsd += call.reportedUsd || 0;
    if (call.basis !== 'reported' && call.basis !== 'error-answer') m.worstCaseCalls += 1;
    models.set(call.model, m);
  }

  return {
    complete: incomplete.length === 0,
    incomplete,
    rows,
    byId,
    allClasses: perClass(rows),
    bar: {
      rows: barRows,
      rowsWithoutWeaker: withoutWeaker,
      short: barRows.filter((c) => !c.meets).map((c) => c.class),
      shortWithoutWeaker: withoutWeaker.filter((c) => !c.meets).map((c) => c.class),
      met: incomplete.length === 0 && falseValid.length === 0 && barRows.every((c) => c.meets)
    },
    adversarial: { shouldNotPay, falseValid, reachedJury, inflated, validAdversarial },
    catalogue,
    weaker: rows.filter((r) => r.weaker),
    comparisons: COMPARISONS.map((c) => ({ ...c, rows: c.cases.map((id) => byId.get(id)).filter(Boolean) })),
    noVerdict: rows.filter((r) => r.outcome === 'NO VERDICT'),
    spend: { totalUsd: ledger.totalUsd, openCalls: ledger.open, models: [...models.values()] }
  };
}

const massOf = (r) => (r.validMass === undefined ? '' : `${Math.round(r.validMass / 10000)}%`);
const jurorMass = (j) => {
  if (!j.vector) return `${j.model}: unread`;
  const valid = j.vector.slice(2).reduce((a, b) => a + b, 0);
  const top = j.vector.indexOf(Math.max(...j.vector));
  return `${j.model}: ${codeReview.BUG_OUTCOMES[top]} (valid ${Math.round(valid / 10000)}%)`;
};
const table = (header, lines) => [`| ${header.join(' | ')} |`, `|${header.map(() => '---').join('|')}|`, ...lines.map((l) => `| ${l.join(' | ')} |`)].join('\n');
const caseLine = (r) => [`\`${r.id}\``, r.expected, r.outcome, r.by || '', massOf(r), r.agrees ? 'yes' : 'NO'];
const CASE_HEADER = ['Case', 'Expected', 'Actual', 'Settled by', 'Valid mass', 'Agrees'];

/**
 * Pure: the markdown.
 * @param {object} a - analyse()'s
 * @param {object} o
 * @param {string} o.date
 * @param {object} [o.notes]
 * @param {number} [o.estimateUsd]
 * @param {object} [o.runnerInfo]
 * @param {string} [o.pricesAsOf]
 */
function render(a, { date, notes = {}, estimateUsd = null, runnerInfo = null, pricesAsOf = null }) {
  const reasons = notes.reasons || {};
  const headline = !a.complete
    ? `**Incomplete: ${a.incomplete.length} claim(s) have no result, so the bar is not decided.**`
    : a.bar.met ? '**The Phase 1 bar is met.**' : '**STOP: the Phase 1 bar is missed.** What to do about it is the owner\'s call.';
  const out = [
    `# Calibration measurement with the real jury, ${date}`,
    '',
    'Node A7d, design §17 (Phase 1 exit) and §18. Claims through the code runner and the AI Node with `code-standard`\'s standard panel, by the testing tool\'s `claim` type.',
    '',
    headline,
    '',
    '## The Phase 1 bar',
    '',
    `No false valid on the adversarial claims, and at least ${BAR * 100}% agreement on the clear cases, per class. A class short of it is reported for withdrawal.`,
    '',
    `**False-valid rate on the adversarial claims: ${a.adversarial.falseValid.length} of ${a.adversarial.shouldNotPay.length}** (${a.adversarial.reachedJury.length} of them reached the jury; the runner settled the rest).`,
    '',
    'Agreement is the settled outcome equalling the expected one, class included. "Clear" is §18\'s clear valid and clear invalid. A claim with no verdict counts as not agreeing. The weaker labels count in these rows, and are also shown apart below.',
    '',
    table(['Class', 'Clear cases', 'Agree', 'Rate', 'Valid/invalid/duplicate agrees', 'Meets the bar'], a.bar.rows.map((c) => [c.class, c.cases, c.agreed, pct(c.agreed, c.cases), `${c.validityAgreed} of ${c.cases}`, c.meets ? 'yes' : '**NO: reported for withdrawal**'])),
    '',
    'For comparison, without the weaker labels. This decides nothing:',
    '',
    table(['Class', 'Clear cases', 'Agree', 'Rate', 'At the same rate'], a.bar.rowsWithoutWeaker.map((c) => [c.class, c.cases, c.agreed, pct(c.agreed, c.cases), c.meets ? 'yes' : 'no'])),
    '',
    'The design also uses "class" for a code class (§10.4). This run measures one, `code-standard`, whose standard panel is what every row above is about, so a short row here is a shortfall of that panel on that verdict class.',
    '',
    '## Every claim, per expected class',
    '',
    table(['Class', 'Claims', 'By runner', 'By jury', 'Agree', 'Rate'], a.allClasses.map((c) => [c.class, c.cases, c.byRunner, c.byJury, c.agreed, pct(c.agreed, c.cases)])),
    '',
    '## The four catalogue cases',
    '',
    ...a.catalogue.flatMap((c) => [
      `**\`${c.name}\`**: expected ${c.settles}; ${c.holds ? 'holds' : '**does not hold**'}.`,
      '',
      table(CASE_HEADER, c.instances.map(caseLine)),
      ''
    ]),
    '## Adversarial claims',
    '',
    table(CASE_HEADER, a.rows.filter((r) => r.subsets.includes('adversarial')).map(caseLine)),
    '',
    a.adversarial.inflated.length
      ? `A valid adversarial claim settled above its class: ${a.adversarial.inflated.map((r) => `\`${r.id}\` (${r.outcome}, expected ${r.expected})`).join(', ')}.`
      : 'No valid adversarial claim settled above its class.',
    '',
    '## Weaker labels, shown apart',
    '',
    table(['Case', 'Why weaker', 'Expected', 'Actual', 'Valid mass', 'Agrees'], a.weaker.map((r) => [`\`${r.id}\``, r.weaker, r.expected, r.outcome, massOf(r), r.agrees ? 'yes' : 'NO'])),
    '',
    '## Compared directly',
    '',
    ...a.comparisons.flatMap((c) => [
      `**${c.title}.** ${c.says}`,
      '',
      table(['Case', 'Expected', 'Actual', 'Valid mass', 'Jurors'], c.rows.map((r) => [`\`${r.id}\``, r.expected, r.outcome, massOf(r), (r.jurors || []).map(jurorMass).join('; ')])),
      ''
    ]),
    '## Every claim',
    '',
    table([...CASE_HEADER, 'Jurors', 'Reason, in our words'], a.rows.map((r) => [...caseLine(r), (r.jurors || []).map(jurorMass).join('; '), reasons[r.id] || (r.error ? `no verdict: ${r.error}` : '')])),
    '',
    '## Stated caveats',
    '',
    ...CAVEATS.map((c) => `- ${c}`),
    ...(notes.runtime ? [`- ${notes.runtime}`] : []),
    '',
    '## Spend',
    '',
    `Total **${usd(a.spend.totalUsd)}** at list price${pricesAsOf ? ` (prices of ${pricesAsOf})` : ''}${estimateUsd === null ? '' : `, against an estimate of ${usd(estimateUsd)}`}${a.spend.openCalls ? `; ${a.spend.openCalls} call(s) never answered, counted at their worst case` : ''}.`,
    '',
    table(['Model', 'Calls', 'Input tokens', 'Output tokens', 'List-price USD', 'Provider-reported USD', 'Counted at worst case'], a.spend.models.map((m) => [`\`${m.model}\``, m.calls, m.inputTokens, m.outputTokens, usd(m.usd), m.reportedUsd ? usd(m.reportedUsd) : 'not reported', m.worstCaseCalls])),
    ''
  ];
  if (runnerInfo) out.push(`Runner ${runnerInfo.version} under \`${runnerInfo.runtime}\` on ${runnerInfo.platform}, gVisor field \`${runnerInfo.gvisor}\`.`, '');
  if (notes.deviations && notes.deviations.length) out.push('## Deviations', '', ...notes.deviations.map((d) => `- ${d}`), '');
  return `${out.join('\n')}\n`;
}

/** What goes in the JSON beside the report: the same numbers, nothing a juror wrote. */
function jsonOf(a, date) {
  const { byId: _byId, comparisons, ...rest } = a;
  return { format: 'verdikta.calibration-jury-report/1', date, ...rest, comparisons: comparisons.map(({ title, cases }) => ({ title, cases })) };
}

function parseArgs(argv) {
  const o = {};
  const names = { '--batch': 'batch', '--results': 'results', '--date': 'date', '--out': 'out', '--notes': 'notes', '--estimate-usd': 'estimateUsd' };
  for (let i = 0; i < argv.length; i += 2) {
    if (!names[argv[i]] || argv[i + 1] === undefined) throw new Error(`unknown option or missing value: ${argv[i]}`);
    o[names[argv[i]]] = argv[i + 1];
  }
  for (const key of ['batch', 'results', 'date', 'out']) if (!o[key]) throw new Error(`--${key} is required`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(o.date)) throw new Error('--date must be YYYY-MM-DD');
  return o;
}

function readRunnerResults(dir) {
  const runner = new Map();
  let info = null;
  for (const name of fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort()) {
    const file = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
    // One report is about one runner: results from two would be mixed under the first one's name.
    if (info && file.runner && JSON.stringify(info) !== JSON.stringify(file.runner)) throw new Error(`${name} comes from another runner than the other results: ${JSON.stringify(file.runner)} and ${JSON.stringify(info)}`);
    info = info || file.runner;
    for (const entry of file.cases) if (!runner.has(entry.id)) runner.set(entry.id, { actual: entry.actual, disagreements: entry.disagreements, reportSha256: entry.observed ? entry.observed.reportSha256 : null, packSha256: entry.observed ? entry.observed.packSha256 : null });
  }
  return { runner, info };
}

function readJury(dir) {
  const jury = new Map();
  if (!fs.existsSync(dir)) return jury;
  for (const name of fs.readdirSync(dir).filter((n) => n.endsWith('.json'))) jury.set(name.slice(0, -'.json'.length), JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')));
  return jury;
}

function main(argv, { root = ROOT, readLedger, pricesAsOf, stdout = (s) => process.stdout.write(`${s}\n`) } = {}) {
  const o = parseArgs(argv);
  const { cases } = loadCorpus({ root, layout: false });
  const { runner, info } = readRunnerResults(o.results);
  const a = analyse({ cases, jury: readJury(path.join(o.batch, 'claims')), runner, ledger: readLedger(path.join(o.batch, 'ledger.jsonl')) });
  const notes = o.notes ? JSON.parse(fs.readFileSync(o.notes, 'utf8')) : {};
  const text = render(a, { date: o.date, notes, estimateUsd: o.estimateUsd === undefined ? null : Number(o.estimateUsd), runnerInfo: info, pricesAsOf });
  fs.mkdirSync(o.out, { recursive: true });
  fs.writeFileSync(path.join(o.out, `${o.date}-jury.md`), text);
  fs.writeFileSync(path.join(o.out, `${o.date}-jury.json`), `${JSON.stringify(jsonOf(a, o.date), null, 2)}\n`);
  stdout(`jury report: ${a.complete ? (a.bar.met ? 'bar met' : `bar MISSED: false valid ${a.adversarial.falseValid.length}, short ${a.bar.short.join(', ') || 'none'}`) : `incomplete: ${a.incomplete.length}`}; USD ${a.spend.totalUsd.toFixed(2)}`);
  if (!a.complete) return 2;
  return a.bar.met ? 0 : 1;
}

if (require.main === module) {
  try {
    // The ledger's reader and the prices are the testing tool's, which sits beside this package in the repository.
    const spend = require('../../../testing-tool/src/spend');
    process.exitCode = main(process.argv.slice(2), { readLedger: spend.readLedger, pricesAsOf: spend.PRICES.asOf });
  } catch (err) {
    process.stderr.write(`jury report: ${err.message}\n`);
    process.exitCode = 2;
  }
}

module.exports = { analyse, render, jsonOf, parseArgs, main, WEAKER_LABELS, CATALOGUE, COMPARISONS, BAR };
