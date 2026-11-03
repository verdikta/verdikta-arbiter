// Node A4b: the request to the AI Node, as a pure function (reused by the
// testing tool). The payload at pack capacity, from the runner's real pack
// assembly, is in runnerContract.test.js.

const { codeReview } = require('@verdikta/common');
const { buildCodeReviewAiRequest } = require('../../codeReview/aiRequest');
const codeReviewMode = require('../../codeReview');
const H = require('../../../test/helpers/codeReviewFixtures');
const R = require('../../../test/helpers/codeReviewRun');

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

function input(over = {}) {
  const spec = H.exampleSpec('age1example');
  const body = {
    listingCid: H.cid('Listing'),
    bcid: H.cid('Claim'),
    spec,
    attestation: { version: 1 },
    pocPatch: Buffer.from(H.POC_PATCH).toString('base64'),
    fixPatch: null,
    finding: H.FINDING,
    report: '# report',
    priorFindings: [{ bcid: H.cid('PriorA'), finding: { title: 'Prior A' }, report: 'prior report' }]
  };
  const answer = R.definitive(body).json;
  return {
    query: 'the listing query',
    outcomes: [...codeReview.BUG_OUTCOMES],
    juryParameters: JSON.parse(JSON.stringify(codeReview.CODE_STANDARD_PANEL)),
    codeClass: 'code-standard',
    report: answer.report,
    reportSha256: answer.reportSha256,
    claim: { bcid: body.bcid, finding: H.FINDING },
    knownIssues: H.exampleKnownIssues(),
    priorFindings: body.priorFindings,
    dispute: null,
    contextPack: answer.contextPack,
    deadlineMs: 500000,
    requestTag: '[EA job]',
    ...over
  };
}

describe('buildCodeReviewAiRequest', () => {
  it('is exported from the module and from the code-review entry point', () => {
    expect(codeReviewMode.buildCodeReviewAiRequest).toBe(buildCodeReviewAiRequest);
  });

  it('is pure: the same input, the same request; the input untouched; no clock', () => {
    const frozen = deepFreeze(input());
    const spy = jest.spyOn(Date, 'now');
    const one = buildCodeReviewAiRequest(frozen);
    const two = buildCodeReviewAiRequest(frozen);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    expect(two).toEqual(one);
  });

  it('holds the listing\'s query, outcomes and panel in the AI Node\'s names', () => {
    const value = input();
    const out = buildCodeReviewAiRequest(value);
    expect(out.prompt).toBe('the listing query');
    expect(out.outcomes).toEqual(value.outcomes);
    expect(out.models).toEqual(value.juryParameters.AI_NODES.map((n) => ({ provider: n.AI_PROVIDER, model: n.AI_MODEL, weight: n.WEIGHT, count: n.NO_COUNTS })));
    expect(out.iterations).toBe(value.juryParameters.ITERATIONS);
    expect(out.requestTag).toBe('[EA job]');
  });

  it('the pack\'s files, in order, are the only attachments', () => {
    const value = input();
    const out = buildCodeReviewAiRequest(value);
    expect(out.attachments).toEqual(value.contextPack.files.map((f) => f.text));
    expect(out.attachmentNames).toEqual(value.contextPack.files.map((f) => f.name));
  });

  it('the field validates against common\'s code_review_request schema', () => {
    const out = buildCodeReviewAiRequest(input());
    const checked = codeReview.validateCodeReviewRequest(out.codeReview);
    expect(checked.issues).toEqual([]);
    expect(checked.ok).toBe(true);
    expect(Object.keys(out.codeReview).sort()).toEqual(['claim', 'codeClass', 'deadlineMs', 'dispute', 'knownIssues', 'priorFindings', 'report', 'reportSha256', 'version']);
  });

  it('known issues and prior findings go by id, not text', () => {
    const value = input();
    const out = buildCodeReviewAiRequest(value);
    expect(out.codeReview.knownIssues).toEqual(value.knownIssues.map((k) => k.id));
    expect(out.codeReview.priorFindings).toEqual([H.cid('PriorA')]);
    const field = JSON.stringify(out.codeReview);
    expect(field).not.toContain('Prior A');
    expect(field).not.toContain('prior report');
    expect(field).not.toContain(value.knownIssues[0].description);
  });

  it('the deadline it is given is the deadline it sends', () => {
    expect(buildCodeReviewAiRequest(input({ deadlineMs: 123456 })).codeReview.deadlineMs).toBe(123456);
  });

  it('a dispute travels with its CID; none is null', () => {
    const dispute = { statementCid: H.cid('Statement'), statement: 'the maker argues' };
    expect(buildCodeReviewAiRequest(input({ dispute })).codeReview.dispute).toEqual(dispute);
    expect(buildCodeReviewAiRequest(input()).codeReview.dispute).toBeNull();
  });

  it('a panel with no ITERATIONS leaves it out, and the AI Node takes its default', () => {
    const juryParameters = JSON.parse(JSON.stringify(codeReview.CODE_STANDARD_PANEL));
    delete juryParameters.ITERATIONS;
    expect('iterations' in buildCodeReviewAiRequest(input({ juryParameters }))).toBe(false);
  });

  it('a lone surrogate in finding.json (a JSON escape of the hunter\'s) cannot stop the jury: the AI Node reads a canonical form', () => {
    const finding = { ...H.FINDING, rootCause: `${H.FINDING.rootCause} \ud83d lone`, title: 'Lone \udc00 surrogate' };
    expect(() => codeReview.canonicalJson(finding)).toThrow();
    const out = buildCodeReviewAiRequest(input({ claim: { bcid: H.cid('Claim'), finding } }));
    expect(() => codeReview.canonicalJson(out.codeReview.claim.finding)).not.toThrow();
    expect(out.codeReview.claim.finding.title).toBe('Lone \ufffd surrogate');
    expect(codeReview.validateCodeReviewRequest(out.codeReview).ok).toBe(true);
  });

  it('a well-formed finding goes unchanged, a surrogate pair included', () => {
    const finding = { ...H.FINDING, title: 'Pair \ud83d\ude00 here' };
    expect(buildCodeReviewAiRequest(input({ claim: { bcid: H.cid('Claim'), finding } })).codeReview.claim.finding).toEqual(finding);
  });

  it('needs nothing but its input: the module requires nothing outside itself, for the testing tool', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(path.join(__dirname, '../../codeReview/aiRequest.js'), 'utf8');
    expect(source).not.toMatch(/require\(/);
  });
});
