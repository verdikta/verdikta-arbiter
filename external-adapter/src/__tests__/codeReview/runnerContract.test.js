// Node A4b against the merged runner, not a double of it: the real HTTP server
// with its real request validation, report and pack (fake Docker underneath),
// and the real pack assembly at capacity. A runner change that breaks the EA's
// reading of it fails here.

const path = require('path');
const { codeReview } = require('@verdikta/common');
const { runClaim } = require('../../codeReview/claimRun');
const { SharedRuns } = require('../../codeReview/sharedRuns');
const { createDeadline } = require('../../codeReview/time');
const { buildRunRequest } = require('../../codeReview/runnerClient');
const R = require('../../../test/helpers/codeReviewRun');

const CODE_RUNNER = path.join(__dirname, '../../../../code-runner');
const { createServer } = require(path.join(CODE_RUNNER, 'src/server'));
const { assemblePack } = require(path.join(CODE_RUNNER, 'src/pack'));
const { validateRunRequest } = require(path.join(CODE_RUNNER, 'src/request'));
const { testConfig, TOKEN } = require(path.join(CODE_RUNNER, 'test/helpers/http'));
const { attestationFor } = require(path.join(CODE_RUNNER, 'test/helpers/requests'));
const { claimSandbox, POC_PATCH, FIX_PATCH, BASE } = require(path.join(CODE_RUNNER, 'test/helpers/fakeClaim'));
const { forgeSpec, finding, DEPOSIT } = require(path.join(CODE_RUNNER, 'test/helpers/claimRun'));

const silent = { info() {}, warn() {}, error() {}, debug() {} };

function contextFor(over = {}) {
  const spec = forgeSpec();
  return {
    codeClass: 'code-standard',
    trust: 'dev',
    listing: {
      cid: 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG',
      outcomes: [...codeReview.BUG_OUTCOMES],
      query: 'the listing query',
      juryParameters: JSON.parse(JSON.stringify(codeReview.CODE_STANDARD_PANEL)),
      spec,
      attestation: attestationFor(spec),
      knownIssues: [],
      baseline: { version: 1, baseCommit: BASE, framework: 'forge', runs: 3, tests: [{ id: DEPOSIT, results: ['pass', 'pass', 'pass'] }], stable: [DEPOSIT], unstable: [] }
    },
    claim: {
      bcid: 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi',
      finding: finding(),
      report: '# Reentrancy\nREPORT-MD-TEXT\n',
      pocPatch: Buffer.from(POC_PATCH),
      fixPatch: null
    },
    priorFindings: [],
    dispute: null,
    addendumText: '',
    eaGates: { disclosure: 'pass', inScope: 'pass' },
    warnings: [],
    ...over
  };
}

let server;
let target;
let ai;

async function startRunner(sb = claimSandbox()) {
  server = createServer({
    config: testConfig(), docker: sb.docker, log: silent,
    meminfo: async () => ({ availableMb: 100000, error: null }),
    statfs: async () => ({ bavail: 1e12, bsize: 1 })
  });
  target = await server.listen();
}

const options = () => ({
  config: { runner: { url: `http://${target.host}:${target.port}`, readToken: () => TOKEN }, aiNode: { url: ai.url } },
  logger: silent,
  runTag: '[contract]',
  runs: new SharedRuns(),
  deadline: createDeadline({ receivedAt: Date.now(), deadlineMs: 780000 })
});

beforeEach(async () => {
  ai = await R.startAiNode();
});

afterEach(async () => {
  await ai.close();
  if (server) await server.close();
  server = null;
});

describe('the merged runner answers what the EA reads', () => {
  it('a clean claim: health, run, report and pack, through to a request the AI Node would accept', async () => {
    await startRunner();
    const result = await runClaim(contextFor(), options());
    expect(ai.state.calls).toHaveLength(1);
    const body = ai.state.calls[0];
    const checked = codeReview.validateCodeReviewRequest(body.codeReview);
    expect(checked.issues).toEqual([]);
    expect(body.attachmentNames[0]).toBe('00-manifest.json');
    expect(body.attachments.join('\n')).toContain('REPORT-MD-TEXT');
    expect(JSON.stringify(body.codeReview)).not.toContain('REPORT-MD-TEXT');
    expect(result.justification).toContain(codeReview.reportSha256(body.codeReview.report));
  });

  it('an abstaining run: the EA abstains', async () => {
    await startRunner(claimSandbox({ scripts: { 'vcr-build': () => ({ exitCode: 137 }) } }));
    await expect(runClaim(contextFor(), options())).rejects.toThrow(/CODE_REVIEW_RUNNER_ABSTAIN.*cause oom, step build\b/);
    expect(ai.state.calls).toHaveLength(0);
  });

  it('a build that fails: a deterministic INVALID from the real report', async () => {
    await startRunner(claimSandbox({ scripts: { 'vcr-build': () => ({ exitCode: 1 }) } }));
    const result = await runClaim(contextFor(), options());
    expect(result.scores[0].score).toBe(1000000);
    expect(result.metadata).toMatchObject({ gate: 'build' });
    expect(ai.state.calls).toHaveLength(0);
  });

  it('a development run on linux/arm64, with no report: the EA abstains', async () => {
    const { imageInspect } = require(path.join(CODE_RUNNER, 'test/helpers/fakeDocker'));
    const handlers = { image: (args) => (args[1] === 'inspect' ? imageInspect(args, { platform: 'linux/arm64' }) : { stdout: '' }) };
    const sb = claimSandbox({ handlers });
    server = createServer({
      config: testConfig({ CODE_RUNNER_PLATFORM: 'linux/arm64' }), docker: sb.docker, log: silent,
      meminfo: async () => ({ availableMb: 100000, error: null }),
      statfs: async () => ({ bavail: 1e12, bsize: 1 })
    });
    target = await server.listen();
    await expect(runClaim(contextFor(), options())).rejects.toThrow(/CODE_REVIEW_REPORT_UNAVAILABLE/);
    expect(ai.state.calls).toHaveLength(0);
  });

  it('fixture: registry-failure, on the real runner: the pull fails, the EA abstains', async () => {
    const { imageInspect } = require(path.join(CODE_RUNNER, 'test/helpers/fakeDocker'));
    const { SEMGREP } = require(path.join(CODE_RUNNER, 'src/semgrepPin'));
    const handlers = {
      // The env image is what is missing: the scanner's is warmed by the installer (A8), and the runner never pulls it.
      image: (args) => (args[1] === 'inspect' ? imageInspect(args, { present: (ref) => ref === SEMGREP.reference }) : { stdout: '' }),
      pull: () => ({ exitCode: 1, stderr: 'dial tcp: lookup ghcr.io: no such host\n' })
    };
    await startRunner(claimSandbox({ handlers }));
    await expect(runClaim(contextFor(), options())).rejects.toThrow(/CODE_REVIEW_RUNNER_ABSTAIN.*pull_failed/);
    expect(ai.state.calls).toHaveLength(0);
  });

  it('the scanner\'s image missing: the runner reports itself unhealthy, the EA abstains before any run', async () => {
    const { imageInspect } = require(path.join(CODE_RUNNER, 'test/helpers/fakeDocker'));
    const { SEMGREP } = require(path.join(CODE_RUNNER, 'src/semgrepPin'));
    const handlers = { image: (args) => (args[1] === 'inspect' ? imageInspect(args, { present: (ref) => ref !== SEMGREP.reference }) : { stdout: '' }) };
    const sb = claimSandbox({ handlers });
    await startRunner(sb);
    await expect(runClaim(contextFor(), options())).rejects.toThrow(/CODE_REVIEW_RUNNER_UNHEALTHY/);
    expect(sb.docker.callsOf('create')).toHaveLength(0);
    expect(ai.state.calls).toHaveLength(0);
  });

  it('the EA\'s request passes the runner\'s own validation, with a fix patch and prior findings', () => {
    const context = contextFor({
      priorFindings: [{ bcid: 'QmPChd2hVbrJ6bfo3WBcTW4iZnpHm8TEzWkLHmLpXhF68A', finding: finding(), report: '# prior\n' }]
    });
    context.claim.fixPatch = Buffer.from(FIX_PATCH);
    const checked = validateRunRequest(buildRunRequest(context, 700000));
    expect(checked.issues).toEqual([]);
    expect(checked.request.deadlineMs).toBe(700000);
    expect(checked.request.fixPatch.toString('utf8')).toBe(FIX_PATCH);
  });

  it('known issues go as the listing has them, which the runner validates', () => {
    const body = { title: 'Known', class: 'LOW', paths: ['src/Vault.sol'], description: 'An accepted rounding behaviour of the vault.' };
    const context = contextFor();
    context.listing.knownIssues = [{ id: codeReview.knownIssueId(body), ...body }];
    expect(validateRunRequest(buildRunRequest(context, 700000)).issues).toEqual([]);
  });

  it('a lone surrogate in finding.json: the real runner takes it, and the AI Node\'s request holds a form with a canonical JSON', async () => {
    await startRunner();
    const context = contextFor();
    context.claim.finding = finding({ title: 'Lone \ud83d surrogate' });
    await runClaim(context, options());
    const body = ai.state.calls[0];
    expect(codeReview.validateCodeReviewRequest(body.codeReview).issues).toEqual([]);
    expect(() => codeReview.canonicalJson(body.codeReview.claim.finding)).not.toThrow();
  });

  it('an empty fix patch goes as absent, which the runner accepts', () => {
    const context = contextFor();
    context.claim.fixPatch = Buffer.alloc(0);
    const body = buildRunRequest(context, 700000);
    expect(body.fixPatch).toBeNull();
    expect(validateRunRequest(body).ok).toBe(true);
  });
});

describe('the runner\'s 16 MiB request limit', () => {
  const { MAX_BODY_BYTES } = require(path.join(CODE_RUNNER, 'src/config'));
  const { checkSpec } = require(path.join(CODE_RUNNER, 'src/classLimits'));
  const { scanPatch } = require(path.join(CODE_RUNNER, 'src/patch'));
  const { maxPatchBytes } = require('../../codeReview/frontGates');
  const sized = (body) => Buffer.byteLength(JSON.stringify(body), 'utf8');

  it('padded report.md and prior reports: the real server takes the request, the real pack cuts them, the jury judges', async () => {
    await startRunner();
    const padded = `REPORT-MD-TEXT\n${'padding '.repeat(3 * 1024 * 1024)}`;
    expect(padded.length).toBeGreaterThan(MAX_BODY_BYTES);
    const context = contextFor({
      priorFindings: [{ bcid: 'QmPChd2hVbrJ6bfo3WBcTW4iZnpHm8TEzWkLHmLpXhF68A', finding: finding(), report: padded }]
    });
    context.claim.report = padded;
    const result = await runClaim(context, options());
    expect(result.scores).toEqual(R.juryScores());
    expect(ai.state.calls[0].attachments.join('\n')).toContain('REPORT-MD-TEXT');
    const pack = ai.state.calls[0].attachments.join('');
    expect(Buffer.byteLength(pack)).toBeLessThanOrEqual(codeReview.getCodeClass('code-standard').envelope.contextPackTokens * 4);
  });

  it('what a claim and its priors can add, at the worst JSON escaping their schemas allow, stays under the limit', () => {
    // every character a control character, which JSON writes as \\u00XX; a path may hold them
    const worstText = (n) => '\u0001'.repeat(n);
    const worstFinding = (over = {}) => ({
      version: 1, title: worstText(120), claimedClass: 'CRITICAL', rootCause: worstText(2000),
      affectedPaths: Array.from({ length: 200 }, (_, i) => `${i}${worstText(508)}`),
      poc: { command: worstText(2000), observable: worstText(1000) }, fixIncluded: true, ...over
    });
    expect(codeReview.validateFinding(worstFinding()).ok).toBe(true);
    const limit = codeReview.SPEC_LIMIT_MAXIMA.maxPatchBytes;
    const context = contextFor({
      priorFindings: Array.from({ length: 8 }, (_, i) => ({ bcid: `Qm${String(i + 1).repeat(44)}`, finding: worstFinding(), report: worstText(20 * 1024 * 1024) }))
    });
    context.claim.finding = worstFinding();
    context.claim.report = worstText(20 * 1024 * 1024);
    context.claim.pocPatch = Buffer.alloc(limit, 0xff);
    context.claim.fixPatch = Buffer.alloc(limit, 0xff);
    const listingOnly = sized(buildRunRequest(contextFor(), 700000));
    const total = sized(buildRunRequest(context, 700000));
    const claimsPart = total - listingOnly;
    expect(total).toBeLessThan(MAX_BODY_BYTES);
    // what is left of the limit is the listing's, and a listing check can hold it to that
    expect(MAX_BODY_BYTES - claimsPart).toBeGreaterThan(3 * 1024 * 1024);
  });

  it('a listing alone over the limit: the real server answers 413, the EA abstains', async () => {
    await startRunner();
    const context = contextFor();
    const id = 'x'.repeat(1024);
    context.listing.baseline = {
      ...context.listing.baseline,
      tests: Array.from({ length: 20000 }, (_, i) => ({ id: `${id.slice(0, 1000)}${i}`, results: ['pass', 'pass', 'pass'] }))
    };
    expect(sized(buildRunRequest(context, 700000))).toBeGreaterThan(MAX_BODY_BYTES);
    await expect(runClaim(context, options())).rejects.toThrow(/CODE_REVIEW_RUNNER_(ANSWER|UNREACHABLE)/);
    expect(ai.state.calls).toHaveLength(0);
  });

  it('the EA reads a listing\'s patch limit as the runner does, with one and without', () => {
    const named = forgeSpec();
    expect(maxPatchBytes(named)).toBe(checkSpec(named).limits.maxPatchBytes);
    const none = forgeSpec();
    delete none.limits;
    expect(maxPatchBytes(none)).toBe(checkSpec(none).limits.maxPatchBytes);
    expect(maxPatchBytes(none)).toBe(2000000);
  });

  it('and draws the line where the runner\'s applies gate does', () => {
    const limits = { maxPatchBytes: 5000 };
    expect(scanPatch(Buffer.alloc(5001, 0x20), limits).reason).toMatch(/5001 bytes.*5000/);
    expect(scanPatch(Buffer.alloc(5000, 0x20), limits).reason || '').not.toMatch(/maxPatchBytes/);
  });
});

describe('acceptance 4: the actual EA→AI Node payload at pack capacity', () => {
  const STANDARD = codeReview.getCodeClass('code-standard').envelope.contextPackTokens;

  function atCapacity() {
    const padding = (word, bytes) => word.repeat(Math.ceil(bytes / word.length)).slice(0, bytes);
    const knownBody = (i) => ({
      title: `Known issue ${i}`, class: 'LOW', paths: ['src/Vault.sol'],
      description: `KNOWN-ISSUE-TEXT ${i} ${padding('accepted behaviour ', 1900)}`
    });
    const knownIssues = Array.from({ length: 256 }, (_, i) => ({ id: codeReview.knownIssueId(knownBody(i)), ...knownBody(i) }));
    const priorFindings = Array.from({ length: 8 }, (_, i) => ({
      bcid: `Qm${String(i + 1).repeat(44)}`,
      finding: finding({ title: `PRIOR-TITLE-${i}`, rootCause: `PRIOR-ROOT-${i} ${padding('root cause text ', 1200)}` }),
      report: `PRIOR-REPORT-${i}\n${padding('prior narrative ', 40000)}`
    }));
    const report = `REPORT-MD-TEXT\n${padding('a long narrative ', 400000)}`;
    const request = {
      finding: finding(), report, knownIssues, priorFindings, fixPatch: Buffer.from(padding('+fix line\n', 300000)), codeClass: 'code-standard'
    };
    const list = (items) => ({ asked: items.length, items, omitted: {} });
    const inputs = {
      pocDiff: `diff --git a/test/E.t.sol b/test/E.t.sol\n${padding('+exploit line\n', 500000)}`,
      pocFiles: list([{ path: 'test/E.t.sol', text: padding('contract line;\n', 500000), bytes: 500000, cut: false }]),
      sources: list(Array.from({ length: 40 }, (_, i) => ({ path: `src/S${i}.sol`, text: padding('contract source;\n', 100000), bytes: 100000, cut: false }))),
      callSites: {
        ...list(Array.from({ length: 160 }, (_, i) => ({ symbol: `f${i % 16}`, path: 'src/Vault.sol', line: i + 1, text: padding('call site ', 200), cut: false }))),
        symbols: { found: 16, withSites: 16, noSites: 0, overCap: 0, longLines: 0 }
      },
      tree: padding('src/ (1 file)\n', 100000)
    };
    return { request, pack: assemblePack({ request, inputs }) };
  }

  it('the real pack, full to its budget, in a request the schema accepts, with priors only inside it', async () => {
    const { request, pack } = atCapacity();
    expect(pack.budgetTokens).toBe(STANDARD);
    expect(pack.usedTokens).toBeGreaterThan(STANDARD * 0.95);
    expect(pack.usedTokens).toBeLessThanOrEqual(STANDARD);
    expect(pack.tiers.find((tier) => tier.name === 'priorFindings').delivered).toBe(8);

    const tests = Array.from({ length: 200 }, (_, i) => ({ id: `test/E.t.sol > T > t${String(i).padStart(3, '0')}()`, runs: R.FAIL3, message: `m${i}`.padEnd(1800, 'x') }));
    const findings = Array.from({ length: 50 }, (_, i) => ({ tool: 'semgrep', rule: `rule-${i}`, severity: 'high', file: 'src/Vault.sol', line: i + 1, message: 'f'.repeat(1800), triage: null }));
    const runner = await R.startRunner({
      answer: (body) => {
        const answer = R.definitive(body, { tests, findings });
        answer.json.contextPack = pack;
        return answer;
      }
    });

    const context = contextFor({ priorFindings: request.priorFindings });
    context.listing.knownIssues = request.knownIssues;
    context.claim.report = request.report;
    context.claim.fixPatch = request.fixPatch;
    try {
      await runClaim(context, {
        config: { runner: { url: runner.url, readToken: () => TOKEN }, aiNode: { url: ai.url } },
        logger: silent,
        runTag: '[capacity]',
        runs: new SharedRuns(),
        deadline: createDeadline({ receivedAt: Date.now(), deadlineMs: 780000 })
      });
    } finally {
      await runner.close();
    }

    expect(ai.state.calls).toHaveLength(1);
    const body = ai.state.calls[0];

    // what the AI Node validates on receipt
    const checked = codeReview.validateCodeReviewRequest(body.codeReview);
    expect(checked.issues).toEqual([]);
    expect(codeReview.validateBugOutcomes(body.outcomes).ok).toBe(true);
    expect(Object.keys(body).sort()).toEqual(['attachmentNames', 'attachments', 'codeReview', 'iterations', 'models', 'outcomes', 'prompt', 'requestTag']);
    // the panel, read back as the AI Node reads it (ai-node/src/lib/code-review/handler.ts)
    const juryParameters = {
      NUMBER_OF_OUTCOMES: body.outcomes.length,
      AI_NODES: body.models.map((m) => ({ AI_PROVIDER: m.provider, AI_MODEL: m.model, NO_COUNTS: m.count === undefined ? 1 : m.count, WEIGHT: m.weight })),
      ITERATIONS: body.iterations
    };
    expect(codeReview.validateClassEnvelope(juryParameters, body.codeReview.codeClass).issues).toEqual([]);

    // the pack, whole, in order, and nothing beside it
    expect(body.attachments).toEqual(pack.files.map((f) => f.text));
    expect(body.attachmentNames).toEqual(pack.files.map((f) => f.name));
    expect(new Set(body.attachmentNames).size).toBe(body.attachmentNames.length);
    expect(body.attachments.every((text) => !text.startsWith('data:'))).toBe(true);

    // prior findings and known issues by id in the field; their text only in the pack
    expect(body.codeReview.priorFindings).toEqual(request.priorFindings.map((p) => p.bcid));
    expect(body.codeReview.knownIssues).toEqual(request.knownIssues.map((k) => k.id));
    const field = JSON.stringify(body.codeReview);
    for (const text of ['PRIOR-TITLE-0', 'PRIOR-ROOT-0', 'PRIOR-REPORT-0', 'KNOWN-ISSUE-TEXT', 'REPORT-MD-TEXT']) {
      expect(field).not.toContain(text);
      expect(body.prompt).not.toContain(text);
    }
    const attachments = body.attachments.join('\n');
    expect(attachments).toContain('PRIOR-TITLE-7');
    expect(attachments).toContain('PRIOR-ROOT-7');
    expect(attachments).not.toContain('PRIOR-REPORT-0'); // a prior's report.md never reaches a juror (§13.3)
    expect(attachments).toContain('KNOWN-ISSUE-TEXT');
    expect(attachments).toContain('REPORT-MD-TEXT');

    // and it fits through the server the AI Node would be
    expect(Buffer.byteLength(JSON.stringify(body))).toBeLessThan(2 * 1024 * 1024);
  });
});
