/**
 * Builders for code-mode test requests (design §10.3, §11).
 *
 * The JSON fixtures beside this file are copies of verdikta-common's
 * test/fixtures/code-review/{claim_report.valid.json, finding.valid.json} at
 * 3ba67cd and {claim_query.bug.txt, code_review.bug.json} at 85560a0 (the
 * source of 1.9.0-attest.4), the files common's own tests validate; the npm
 * package does not ship them. The query is buildClaimQuery's pinned output for
 * the example listing, code_review.bug.json (claim-prompt.test.ts holds the two
 * to the pinned release). The spec's copy leaves out stake.disclosureKey, a public
 * age recipient the query does not read: bugSpec() fills in one made at test time,
 * so nothing key-shaped is committed for the secret scan to read.
 */
import fs from 'fs';
import path from 'path';
import { codeReview } from '@verdikta/common';

const FIXTURES = path.join(__dirname, 'fixtures', 'code-review');

export function validReport(): codeReview.ClaimReport {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, 'claim_report.valid.json'), 'utf8'));
}

export function validFinding(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, 'finding.valid.json'), 'utf8'));
}

export function claimQuery(): string {
  return fs.readFileSync(path.join(FIXTURES, 'claim_query.bug.txt'), 'utf8');
}

/** common's example listing spec, the one claim_query.bug.txt is built from, with a disclosure key made now. */
export function bugSpec(): Parameters<typeof codeReview.buildClaimQuery>[0] {
  const spec = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'code_review.bug.json'), 'utf8'));
  spec.stake.disclosureKey = codeReview.generateDisclosureKeyPair().recipient;
  return spec;
}

/** A codeReview field that validates, for the given deadline. */
export function codeReviewField(overrides: Record<string, unknown> = {}): Record<string, any> {
  const report = (overrides.report as codeReview.ClaimReport | undefined) ?? validReport();
  return {
    version: 1,
    codeClass: 'code-standard',
    deadlineMs: 600000,
    report,
    reportSha256: codeReview.reportSha256(report),
    claim: { bcid: report.inputs.bcid, finding: validFinding() },
    knownIssues: [],
    priorFindings: [],
    dispute: null,
    ...overrides,
  };
}

/** The EA's request body in code mode: the listing query, the six outcomes, the panel, the pack. */
export function codeModeBody(options: {
  codeReview?: Record<string, unknown>;
  models?: Array<{ provider: string; model: string; weight: number; count?: number }>;
  attachments?: string[];
  attachmentNames?: string[];
  iterations?: number;
  outcomes?: string[];
  prompt?: string;
} = {}): Record<string, any> {
  const panel = codeReview.CODE_STANDARD_PANEL.AI_NODES.map(node => ({
    provider: node.AI_PROVIDER,
    model: node.AI_MODEL,
    weight: node.WEIGHT,
    count: node.NO_COUNTS,
  }));
  return {
    prompt: options.prompt ?? claimQuery(),
    outcomes: options.outcomes ?? [...codeReview.BUG_OUTCOMES],
    models: options.models ?? panel,
    iterations: options.iterations ?? 1,
    attachments: options.attachments ?? ['## poc.patch\n+function testReenterDrainsVault() public { ... }\n'],
    attachmentNames: options.attachmentNames ?? ['context-pack.md'],
    requestTag: 'test-run',
    codeReview: 'codeReview' in options ? options.codeReview : codeReviewField(),
  };
}

/** A juror reply the parser accepts. */
export function jurorReply(score: number[], justification = 'The PoC reproduces the reentrancy.'): string {
  return JSON.stringify({ score, justification });
}
