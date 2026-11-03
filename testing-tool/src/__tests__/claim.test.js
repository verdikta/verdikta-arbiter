'use strict';

// Node A6b: the `claim` scenario type. Built on A4b's request builder, with prior-finding
// archives. No provider and no chain: the AI Node here is a stub on loopback; the real one
// takes the same request in the L2 claim suite (e2e, mode `testing-tool`).

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const AdmZip = require('adm-zip');
const { codeReview } = require('@verdikta/common');
const F = require('../../../e2e/src/l2/claim/fixtures');
const { writeClaimScenario } = require('../../test/helpers/claimFixture');
const { buildCodeReviewAiRequest } = require('../../../external-adapter/src/codeReview/aiRequest');
const {
  loadClaimScenario, loadClaimScenarios, buildClaimRequest, CLAIM_DEADLINE_MS
} = require('../claim-scenarios');
const { callClaim, runClaimScenario, claimHttpTimeoutMs } = require('../claim-runner');

jest.setTimeout(60000);

const TOOL = path.join(__dirname, '..', '..');
const INDEX = path.join(TOOL, 'src', 'index.js');
const VECTOR = [0, 0, 0, 100000, 700000, 200000];
const scoresOf = (vector = VECTOR) => codeReview.BUG_OUTCOMES.map((outcome, i) => ({ outcome, score: vector[i] }));

let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-claim-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

/** An AI Node on loopback: each POST takes the next scripted answer, the last repeating. */
async function stubAiNode(answers = [{ status: 200, body: { scores: scoresOf(), justification: 'The panel.', metadata: {}, model_results: [], codeReview: { promptSha256: 'd'.repeat(64) } } }]) {
  const posts = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const reply = (status, body) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (req.method === 'GET') return reply(200, { status: 'ok' });
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      posts.push({ path: req.url, body });
      const answer = answers[Math.min(posts.length - 1, answers.length - 1)];
      return reply(answer.status, answer.body);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    posts,
    close: () => new Promise((resolve) => {
      if (server.closeAllConnections) server.closeAllConnections();
      server.close(() => resolve());
    })
  };
}

describe('the request is A4b\'s builder\'s', () => {
  it('is exactly buildCodeReviewAiRequest over the archives and the recorded run', async () => {
    const made = await writeClaimScenario(dir);
    const scenario = loadClaimScenario(made.folder);
    const body = buildClaimRequest(scenario, { deadlineMs: 285000, requestTag: '[tool]' });
    expect(body).toEqual(buildCodeReviewAiRequest({
      query: codeReview.buildClaimQuery(made.spec),
      outcomes: [...codeReview.BUG_OUTCOMES],
      juryParameters: JSON.parse(JSON.stringify(codeReview.CODE_STANDARD_PANEL)),
      codeClass: 'code-standard',
      report: made.run.report,
      reportSha256: made.run.reportSha256,
      claim: { bcid: made.bcid, finding: F.FINDING },
      knownIssues: [],
      priorFindings: made.priors,
      dispute: null,
      contextPack: made.run.contextPack,
      deadlineMs: 285000,
      requestTag: '[tool]'
    }));
  });

  it('goes through the builder: replace the builder and the request changes', async () => {
    const made = await writeClaimScenario(dir);
    let viaMock;
    let seen;
    jest.isolateModules(() => {
      jest.doMock('../../../external-adapter/src/codeReview/aiRequest', () => ({
        buildCodeReviewAiRequest: (input) => { seen = input; return { marker: 'from-the-builder' }; }
      }));
      const tool = require('../claim-scenarios');
      viaMock = tool.buildClaimRequest(tool.loadClaimScenario(made.folder), { deadlineMs: 285000 });
    });
    jest.dontMock('../../../external-adapter/src/codeReview/aiRequest');
    expect(viaMock).toEqual({ marker: 'from-the-builder' });
    expect(seen.priorFindings.map((p) => p.bcid)).toEqual(made.priors.map((p) => p.bcid));
    expect(seen.deadlineMs).toBe(285000);
  });

  it('the request validates with common, the way the EA and the AI Node hold it', async () => {
    const made = await writeClaimScenario(dir);
    const body = buildClaimRequest(loadClaimScenario(made.folder), { deadlineMs: CLAIM_DEADLINE_MS });
    expect(codeReview.validateCodeReviewRequest(body.codeReview).ok).toBe(true);
    expect(codeReview.validateClassEnvelope({ AI_NODES: body.models.map((m) => ({ AI_PROVIDER: m.provider, AI_MODEL: m.model, NO_COUNTS: m.count, WEIGHT: m.weight })), ITERATIONS: body.iterations }, 'code-standard').ok).toBe(true);
    expect(body.outcomes).toEqual([...codeReview.BUG_OUTCOMES]);
  });

  it('sends the pack in order and nothing beside it', async () => {
    const made = await writeClaimScenario(dir);
    const body = buildClaimRequest(loadClaimScenario(made.folder), { deadlineMs: CLAIM_DEADLINE_MS });
    const files = made.run.contextPack.files;
    expect(body.attachments).toEqual(files.map((f) => f.text));
    expect(body.attachmentNames).toEqual(files.map((f) => f.name));
    expect(body.attachmentNames.some((n) => /^(report\.md|finding\.json|known_issues\.json)$/.test(n))).toBe(false);
  });

  it('gives a deadline the jury and the justifier can both use: 240 s and 45 s', () => {
    expect(CLAIM_DEADLINE_MS).toBe(285000);
    expect(CLAIM_DEADLINE_MS).toBeLessThanOrEqual(codeReview.MAX_DEADLINE_MS);
  });
});

describe('prior-finding archives', () => {
  it('reads each as { bcid, finding, report }, in file-name order, and sends only their ids in the field', async () => {
    const made = await writeClaimScenario(dir, { priors: 3 });
    const scenario = loadClaimScenario(made.folder);
    expect(scenario.input.priorFindings).toEqual(made.priors);
    const body = buildClaimRequest(scenario, { deadlineMs: CLAIM_DEADLINE_MS });
    expect(body.codeReview.priorFindings).toEqual(made.priors.map((p) => p.bcid));
    const field = JSON.stringify(body.codeReview);
    for (const prior of made.priors) expect(field).not.toContain(prior.finding.rootCause);
  });

  it('takes only finding.json and report.md from one: nothing else in the archive reaches the input', async () => {
    const made = await writeClaimScenario(dir, { priors: 1 });
    const scenario = loadClaimScenario(made.folder);
    expect(Object.keys(scenario.input.priorFindings[0]).sort()).toEqual(['bcid', 'finding', 'report']);
  });

  it('works with none', async () => {
    const made = await writeClaimScenario(dir, { priors: 0 });
    fs.rmSync(path.join(made.folder, 'priors'), { recursive: true });
    const body = buildClaimRequest(loadClaimScenario(made.folder), { deadlineMs: CLAIM_DEADLINE_MS });
    expect(body.codeReview.priorFindings).toEqual([]);
  });

  it('refuses a prior the pack does not hold: the jury would be told of a finding it cannot read', async () => {
    const made = await writeClaimScenario(dir, {
      changeRun: (run) => ({ ...run, contextPack: { ...run.contextPack, files: run.contextPack.files.filter((f) => f.tier !== 'priorFindings') } })
    });
    expect(() => loadClaimScenario(made.folder)).toThrow(/prior.*pack/is);
    expect(made.priors).toHaveLength(2);
  });

  it('refuses a pack holding priors the scenario has no archive for', async () => {
    const made = await writeClaimScenario(dir);
    fs.rmSync(path.join(made.folder, 'priors', '02-prior.zip'));
    expect(() => loadClaimScenario(made.folder)).toThrow(/prior.*pack/is);
  });

  it.each([
    ['no finding.json', (zip) => zip.deleteFile('finding.json'), /finding\.json/],
    ['no report.md', (zip) => zip.deleteFile('report.md'), /report\.md/],
    ['an empty report.md', (zip) => zip.updateFile('report.md', Buffer.from('  ')), /report\.md/],
    ['a finding common refuses', (zip) => zip.updateFile('finding.json', Buffer.from('{"version":1}')), /finding\.json/],
    ['a finding that is not JSON', (zip) => zip.updateFile('finding.json', Buffer.from('nope')), /finding\.json/]
  ])('refuses a prior with %s', async (_name, change, message) => {
    const made = await writeClaimScenario(dir, { priors: 1 });
    const file = path.join(made.folder, 'priors', '01-prior.zip');
    const zip = new AdmZip(file);
    change(zip);
    fs.writeFileSync(file, zip.toBuffer());
    expect(() => loadClaimScenario(made.folder)).toThrow(message);
  });

  it('refuses more than the request can carry', async () => {
    const made = await writeClaimScenario(dir, { priors: codeReview.MAX_PRIOR_FINDINGS + 1 });
    expect(() => loadClaimScenario(made.folder)).toThrow(/at most 8/);
  });

  it('refuses the claim as its own prior, and a prior twice', async () => {
    const made = await writeClaimScenario(dir, { priors: 1 });
    fs.writeFileSync(path.join(made.folder, 'priors', '09-self.zip'), made.claimBytes);
    expect(() => loadClaimScenario(made.folder)).toThrow(/own prior|itself/);
    const other = await writeClaimScenario(dir, { id: 'other', priors: 1 });
    fs.copyFileSync(path.join(other.folder, 'priors', '01-prior.zip'), path.join(other.folder, 'priors', '02-again.zip'));
    expect(() => loadClaimScenario(other.folder)).toThrow(/more than once/);
  });
});

describe('the recorded run is this claim\'s', () => {
  it('refuses a report for another claim, another listing or another patch', async () => {
    const swap = (field, value) => (run) => ({ ...run, report: { ...run.report, inputs: { ...run.report.inputs, [field]: value } } });
    const cases = [['bcid', `Qm${'x'.repeat(44)}`, /bcid/], ['listingCid', `Qm${'x'.repeat(44)}`, /listingCid/], ['pocPatchSha256', 'f'.repeat(64), /pocPatchSha256/]];
    for (const [field, value, message] of cases) {
      const made = await writeClaimScenario(dir, { id: `swap-${field}`, changeRun: swap(field, value) });
      expect(() => loadClaimScenario(made.folder)).toThrow(message);
    }
  });

  it('refuses a hash that is not the report\'s', async () => {
    const made = await writeClaimScenario(dir, { changeRun: (run) => ({ ...run, reportSha256: 'e'.repeat(64) }) });
    expect(() => loadClaimScenario(made.folder)).toThrow(/REQUEST_REPORT_HASH_MISMATCH|does not validate/);
  });

  it('refuses a run whose gates did not all pass: production calls no model on it', async () => {
    const made = await writeClaimScenario(dir, { shape: { stop: 'testPathsOnly' } });
    expect(() => loadClaimScenario(made.folder)).toThrow(/testPathsOnly/);
  });

  it.each([
    ['no pack', (run) => ({ ...run, contextPack: null }), /contextPack/],
    ['another class\'s pack', (run) => ({ ...run, contextPack: { ...run.contextPack, codeClass: 'code-premium' } }), /class/],
    ['a pack over its budget', (run) => ({ ...run, contextPack: { ...run.contextPack, usedTokens: 70000 } }), /budget/],
    ['a file that would read as a data URI', (run) => ({ ...run, contextPack: { ...run.contextPack, files: [{ name: 'x', text: 'data:text/plain,hi' }] } }), /data/]
  ])('refuses %s', async (_name, changeRun, message) => {
    const made = await writeClaimScenario(dir, { priors: 0, changeRun });
    expect(() => loadClaimScenario(made.folder)).toThrow(message);
  });
});

describe('the listing and the scenario file', () => {
  const rewrite = (file, name, value) => {
    const zip = new AdmZip(file);
    zip.updateFile(name, Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)));
    fs.writeFileSync(file, zip.toBuffer());
  };
  const read = (file, name) => JSON.parse(new AdmZip(file).getEntry(name).getData().toString('utf8'));

  it('refuses a panel outside the class envelope, and outcomes that are not the six', async () => {
    const a = await writeClaimScenario(dir, { id: 'a' });
    const listingA = path.join(a.folder, 'listing.zip');
    rewrite(listingA, 'manifest.json', { ...read(listingA, 'manifest.json'), juryParameters: { AI_NODES: [{ AI_PROVIDER: 'OpenAI', AI_MODEL: 'gpt-4o', NO_COUNTS: 1, WEIGHT: 1 }], ITERATIONS: 1 } });
    expect(() => loadClaimScenario(a.folder)).toThrow(/envelope/);

    const b = await writeClaimScenario(dir, { id: 'b' });
    const listingB = path.join(b.folder, 'listing.zip');
    rewrite(listingB, 'primary_query.json', { ...read(listingB, 'primary_query.json'), outcomes: ['Yes', 'No'] });
    expect(() => loadClaimScenario(b.folder)).toThrow(/outcomes/);
  });

  it('refuses a listing with no codeReview key: that is a text scenario', async () => {
    const a = await writeClaimScenario(dir);
    const listing = path.join(a.folder, 'listing.zip');
    const { codeReview: _dropped, ...manifest } = read(listing, 'manifest.json');
    rewrite(listing, 'manifest.json', manifest);
    expect(() => loadClaimScenario(a.folder)).toThrow(/codeReview/);
  });

  it('names known issues by id, from the listing', async () => {
    const a = await writeClaimScenario(dir);
    expect(loadClaimScenario(a.folder).input.knownIssues).toEqual([]);
  });

  it('refuses a claim with no finding, and an expected outcome that does not exist', async () => {
    const a = await writeClaimScenario(dir, { id: 'a' });
    const zip = new AdmZip(path.join(a.folder, 'claim.zip'));
    zip.deleteFile('finding.json');
    fs.writeFileSync(path.join(a.folder, 'claim.zip'), zip.toBuffer());
    expect(() => loadClaimScenario(a.folder)).toThrow(/finding\.json/);

    const b = await writeClaimScenario(dir, { id: 'b', scenario: { expected_outcome: 'SEVERE' } });
    expect(() => loadClaimScenario(b.folder)).toThrow(/expected_outcome/);
  });

  it('a missing file is named', async () => {
    const a = await writeClaimScenario(dir);
    fs.rmSync(path.join(a.folder, 'run.json'));
    expect(() => loadClaimScenario(a.folder)).toThrow(/run\.json/);
  });
});

describe('loadClaimScenarios', () => {
  it('reads every folder with a scenario.json, in order, and filters by id and tag', async () => {
    await writeClaimScenario(dir, { id: 'b', scenario: { tags: ['x'] } });
    await writeClaimScenario(dir, { id: 'a', scenario: { tags: ['y'] } });
    fs.mkdirSync(path.join(dir, 'not-a-scenario'));
    expect(loadClaimScenarios(dir).map((s) => s.scenario_id)).toEqual(['a', 'b']);
    expect(loadClaimScenarios(dir, { scenarioIds: ['b'] }).map((s) => s.scenario_id)).toEqual(['b']);
    expect(loadClaimScenarios(dir, { tags: ['y'] }).map((s) => s.scenario_id)).toEqual(['a']);
  });

  it('an id that is not there is an error, not an empty run', async () => {
    await writeClaimScenario(dir, { id: 'a' });
    expect(() => loadClaimScenarios(dir, { scenarioIds: ['a', 'nope'] })).toThrow(/nope/);
  });

  it('a directory with none is an error', () => {
    expect(() => loadClaimScenarios(dir)).toThrow(/No claim scenarios/);
    expect(() => loadClaimScenarios(path.join(dir, 'missing'))).toThrow(/No claim scenarios|not found/);
  });
});

describe('calling the AI Node', () => {
  it('sends the builder\'s body to rank-and-justify once on success', async () => {
    const node = await stubAiNode();
    try {
      const body = { prompt: 'p' };
      const answer = await callClaim(node.url, body, { deadlineMs: 285000 });
      expect(answer.scores).toEqual(scoresOf());
      expect(node.posts).toEqual([{ path: '/api/rank-and-justify', body }]);
    } finally {
      await node.close();
    }
  });

  it('retries once, on 503 with retryable: true, as the EA does', async () => {
    const retryable = { status: 503, body: { errorCode: 'CODE_REVIEW_JUROR_TIMEOUT', retryable: true } };
    const node = await stubAiNode([retryable, { status: 200, body: { scores: scoresOf(), justification: 'j' } }]);
    try {
      await callClaim(node.url, { prompt: 'p' }, { deadlineMs: 285000 });
      expect(node.posts).toHaveLength(2);
    } finally {
      await node.close();
    }
    const twice = await stubAiNode([retryable]);
    try {
      await expect(callClaim(twice.url, { prompt: 'p' }, { deadlineMs: 285000 })).rejects.toThrow(/CODE_REVIEW_JUROR_TIMEOUT/);
      expect(twice.posts).toHaveLength(2);
    } finally {
      await twice.close();
    }
  });

  it.each([
    ['a provider error', 400, { errorCode: 'CODE_REVIEW_JUROR_FAILED' }],
    ['a refused request', 400, { errorCode: 'CODE_REVIEW_INVALID', retryable: false }],
    ['a 503 not marked retryable', 503, { errorCode: 'X' }],
    ['a spent deadline', 504, { errorCode: 'CODE_REVIEW_DEADLINE', retryable: true }],
    ['an internal error', 500, { errorCode: 'CODE_REVIEW_INTERNAL' }]
  ])('never repeats %s: a repeat is a second provider bill', async (_name, status, body) => {
    const node = await stubAiNode([{ status, body }]);
    try {
      await expect(callClaim(node.url, { prompt: 'p' }, { deadlineMs: 285000 })).rejects.toThrow(String(status));
      expect(node.posts).toHaveLength(1);
    } finally {
      await node.close();
    }
  });

  it('waits past the deadline, not the tool\'s 60 s: the AI Node answers at its deadline', () => {
    expect(claimHttpTimeoutMs(285000)).toBeGreaterThan(285000);
    expect(claimHttpTimeoutMs(285000)).toBeLessThanOrEqual(300000);
  });
});

describe('runClaimScenario', () => {
  const run = async (node, made) => runClaimScenario(loadClaimScenario(made.folder), { aiNodeUrl: node.url });

  it('settles the verdict by the listing\'s stake and compares it with the expected outcome', async () => {
    const made = await writeClaimScenario(dir);
    const node = await stubAiNode();
    try {
      const result = await run(node, made);
      expect(result).toMatchObject({
        scenario_id: made.id,
        jury_id: 'listing',
        expected_outcome: 'HIGH',
        agrees: true,
        report_sha256: made.run.reportSha256,
        prompt_sha256: 'd'.repeat(64)
      });
      expect(result.settled).toEqual(expect.objectContaining({ outcome: 'HIGH', valid: true }));
      expect(result.error).toBeUndefined();
      expect(JSON.stringify(result)).toBeTruthy();
      expect(node.posts[0].body.codeReview.deadlineMs).toBe(CLAIM_DEADLINE_MS);
    } finally {
      await node.close();
    }
  });

  it('records a disagreement as a result, not an error', async () => {
    const made = await writeClaimScenario(dir, { scenario: { expected_outcome: 'INVALID' } });
    const node = await stubAiNode();
    try {
      const result = await run(node, made);
      expect(result.agrees).toBe(false);
      expect(result.error).toBeUndefined();
    } finally {
      await node.close();
    }
  });

  it('records an AI Node refusal as an error result', async () => {
    const made = await writeClaimScenario(dir);
    const node = await stubAiNode([{ status: 400, body: { errorCode: 'CODE_REVIEW_INVALID', error: 'no' } }]);
    try {
      const result = await run(node, made);
      expect(result.error).toMatch(/400/);
      expect(result.scores).toEqual([]);
      expect(result.agrees).toBeNull();
    } finally {
      await node.close();
    }
  });

  it('an answer that is not the six outcomes is an error, not a verdict', async () => {
    const made = await writeClaimScenario(dir);
    const node = await stubAiNode([{ status: 200, body: { scores: [{ outcome: 'Yes', score: 1000000 }], justification: 'j' } }]);
    try {
      const result = await run(node, made);
      expect(result.error).toMatch(/outcomes/);
    } finally {
      await node.close();
    }
  });
});

/** The tool as an operator runs it. */
function tool(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [INDEX, ...args], { cwd: dir, env: { PATH: process.env.PATH, ...env } });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { out += c; });
    child.on('close', (code) => resolve({ code, out }));
  });
}

describe('test --type claim', () => {
  let claims;
  let results;
  beforeEach(() => {
    claims = path.join(dir, 'claims');
    results = path.join(dir, 'results');
    fs.mkdirSync(claims);
  });
  const claimArgs = () => ['test', '--type', 'claim', '--claims-dir', claims, '--results-dir', results];

  it('--dry-run validates every scenario and calls nothing', async () => {
    await writeClaimScenario(claims);
    const node = await stubAiNode();
    try {
      const r = await tool([...claimArgs(), '--dry-run', '--ai-node-url', node.url]);
      expect(r.out).toMatch(/vault-over-credit/);
      expect(r.code).toBe(0);
      expect(node.posts).toEqual([]);
      expect(fs.existsSync(results)).toBe(false);
    } finally {
      await node.close();
    }
  });

  it('--dry-run fails on a broken scenario', async () => {
    const made = await writeClaimScenario(claims);
    fs.rmSync(path.join(made.folder, 'run.json'));
    const r = await tool([...claimArgs(), '--dry-run']);
    expect(r.out).toMatch(/run\.json/);
    expect(r.code).toBe(1);
  });

  it.each([
    ['no --jury', []],
    ['--jury anything else', ['--jury', 'mock']]
  ])('%s: refused, since a real panel spends money, and no call', async (_name, extra) => {
    await writeClaimScenario(claims);
    const node = await stubAiNode();
    try {
      const r = await tool([...claimArgs(), ...extra, '--ai-node-url', node.url]);
      expect(r.out).toMatch(/--jury real/);
      expect(r.code).toBe(1);
      expect(node.posts).toEqual([]);
    } finally {
      await node.close();
    }
  });

  it('--juries does not apply: the panel is the listing\'s', async () => {
    await writeClaimScenario(claims);
    const r = await tool([...claimArgs(), '--jury', 'real', '--juries', '1']);
    expect(r.out).toMatch(/listing/);
    expect(r.code).toBe(1);
  });

  it('--jury real runs the scenarios and saves the results where it is told', async () => {
    const made = await writeClaimScenario(claims);
    const node = await stubAiNode();
    try {
      const r = await tool([...claimArgs(), '--jury', 'real', '--ai-node-url', node.url]);
      expect(r.code).toBe(0);
      expect(node.posts).toHaveLength(1);
      expect(node.posts[0].body.codeReview.claim.bcid).toBe(made.bcid);
      const runs = fs.readdirSync(results);
      expect(runs).toHaveLength(1);
      const summary = JSON.parse(fs.readFileSync(path.join(results, runs[0], 'summary.json'), 'utf8'));
      expect(summary.results[0]).toMatchObject({ scenario_id: made.id, agrees: true });
      expect(summary.statistics).toMatchObject({ successfulTests: 1, failedTests: 0 });
    } finally {
      await node.close();
    }
  });

  it('exits 1 when a request errored, and 0 on a disagreement', async () => {
    await writeClaimScenario(claims, { scenario: { expected_outcome: 'INVALID' } });
    const node = await stubAiNode();
    try {
      expect((await tool([...claimArgs(), '--jury', 'real', '--ai-node-url', node.url])).code).toBe(0);
    } finally {
      await node.close();
    }
    const refusing = await stubAiNode([{ status: 400, body: { errorCode: 'CODE_REVIEW_INVALID' } }]);
    try {
      expect((await tool([...claimArgs(), '--jury', 'real', '--ai-node-url', refusing.url])).code).toBe(1);
    } finally {
      await refusing.close();
    }
  });

  it('exits 1 when the AI Node cannot be reached', async () => {
    await writeClaimScenario(claims);
    const r = await tool([...claimArgs(), '--jury', 'real', '--ai-node-url', 'http://127.0.0.1:9']);
    expect(r.code).toBe(1);
  });

  it('refuses a type it does not know', async () => {
    const r = await tool(['test', '--type', 'nonsense', '--dry-run']);
    expect(r.out).toMatch(/nonsense/);
    expect(r.code).toBe(1);
  });

  it('the CSV path is untouched: no --type still reads scenarios.csv and the juries', async () => {
    const node = await stubAiNode();
    try {
      const csv = path.join(dir, 'scenarios.csv');
      fs.writeFileSync(csv, 'scenario_id,prompt,outcomes,attachment_archive,expected_winner,tags,notes\nsimple,"Approve?","Yes,No",,,,\n');
      const r = await tool(['test', '--scenarios', csv, '--dry-run', '--ai-node-url', node.url]);
      expect(r.out).toMatch(/Dry run complete/);
      expect(r.code).toBe(0);
      expect(node.posts).toEqual([]);
    } finally {
      await node.close();
    }
  });
});

describe('docs', () => {
  it('the README says how to run the claim type and what a scenario folder holds', () => {
    const readme = fs.readFileSync(path.join(TOOL, 'README.md'), 'utf8');
    for (const text of ['--type claim', '--jury real', 'scenario.json', 'listing.zip', 'claim.zip', 'priors/', 'run.json']) {
      expect(readme).toContain(text);
    }
  });
});
