/**
 * rank-and-justify in code mode: a request with a `codeReview` field (design
 * §7.2 AI Node row, §10.3, §10.5, §11; build plan A3, A5, A8).
 *
 * 1. The field is validated with @verdikta/common's validateCodeReviewRequest,
 *    the outcomes must be the six claim outcomes, and the panel, NO_COUNTS and
 *    ITERATIONS must fit the class envelope (validateClassEnvelope). Anything
 *    else is a requester error before any model is called.
 * 2. The attachments (the context pack, report.md) must be text.
 * 3. The deadline plan (deadline.ts): jurors until deadlineMs less the 45 s
 *    justifier reserve (at most 240 s), then the justifier for its reserve.
 * 4. Every juror is required; a juror timeout is the retryable 503, a provider
 *    error or unusable reply the non-retryable 400. The justifier's failure
 *    abstains too: code mode never publishes a partial justification.
 *
 * API_RESPONSE_SPECIFICATION.md, "Code mode", is the contract with the EA.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { codeReview } from '@verdikta/common';
import { buildClaimPrompt, buildCodeJustifierPrompt, PackFile } from './claim-prompt';
import { JUSTIFIER_RESERVE_MS, justifierBudgetMs, planCodeReviewTimes } from './deadline';
import { CODE_JUROR_EFFORT, CodeJuror, JurorResult, justifierModel, roundToTotal, runCodeJury, runCodeJustifier, weightedVector } from './jury';

export const CODE_REVIEW_ERRORS = {
  INVALID: 'CODE_REVIEW_INVALID',
  ENVELOPE: 'CODE_REVIEW_ENVELOPE',
  ATTACHMENT: 'CODE_REVIEW_ATTACHMENT',
  DEADLINE: 'CODE_REVIEW_DEADLINE',
  JUROR_FAILED: 'CODE_REVIEW_JUROR_FAILED',
  JUROR_TIMEOUT: 'CODE_REVIEW_JUROR_TIMEOUT',
  JUSTIFIER_FAILED: 'CODE_REVIEW_JUSTIFIER_FAILED',
  JUSTIFIER_TIMEOUT: 'CODE_REVIEW_JUSTIFIER_TIMEOUT',
  INTERNAL: 'CODE_REVIEW_INTERNAL',
} as const;

type ErrorKey = keyof typeof CODE_REVIEW_ERRORS;

/** HTTP status per error: 503 only for timeouts, which a retry can cure; 504 when the deadline itself is spent. */
const ERROR_STATUS: Record<ErrorKey, number> = {
  INVALID: 400,
  ENVELOPE: 400,
  ATTACHMENT: 400,
  DEADLINE: 504,
  JUROR_FAILED: 400,
  JUROR_TIMEOUT: 503,
  JUSTIFIER_FAILED: 400,
  JUSTIFIER_TIMEOUT: 503,
  INTERNAL: 500,
};

const RETRYABLE: ReadonlySet<ErrorKey> = new Set<ErrorKey>(['JUROR_TIMEOUT', 'JUSTIFIER_TIMEOUT']);

export interface CodeReviewResponse {
  status: number;
  body: Record<string, unknown>;
}

/** A request is in code mode when it carries a codeReview key at all (null included, and then invalid). */
export function isCodeReviewBody(body: unknown): body is Record<string, unknown> {
  return !!body && typeof body === 'object' && !Array.isArray(body)
    && Object.prototype.hasOwnProperty.call(body, 'codeReview');
}

function errorResponse(key: ErrorKey, message: string, extra: Record<string, unknown> = {}): CodeReviewResponse {
  console.error(`❌ CODE_REVIEW_${key}: ${message}`);
  return {
    status: ERROR_STATUS[key],
    body: {
      error: message,
      errorCode: CODE_REVIEW_ERRORS[key],
      retryable: RETRYABLE.has(key),
      scores: [],
      justification: '',
      ...extra,
    },
  };
}

/** Issues as the EA can log them (common's validators: code, path, detail), at most 20. */
function issueList(issues: Array<{ code: string; path: string; detail?: string }>) {
  return issues.slice(0, 20).map(({ code, path: where, detail }) => ({ code, path: where, detail }));
}

const TEXT_MEDIA = /^(text\/[a-z0-9.+-]+|application\/(json|[a-z0-9.+-]+\+json|x-ndjson|x-diff|x-patch|x-yaml|yaml|toml|xml))$/i;

/**
 * The pack as text. A plain string is text as sent (the EA's text/plain
 * encoding); a data: URI is decoded when its media type is text. Anything else
 * (an image, a PDF, a binary) is refused: the jury reads the pack verbatim.
 */
function packFiles(attachments: unknown, names: unknown): PackFile[] | string {
  if (attachments === undefined || attachments === null) return [];
  if (!Array.isArray(attachments)) return 'attachments must be an array of strings';
  const nameList = Array.isArray(names) ? names : [];
  const files: PackFile[] = [];
  for (let i = 0; i < attachments.length; i++) {
    const item = attachments[i];
    const name = typeof nameList[i] === 'string' && nameList[i] ? nameList[i] as string : `attachment-${i + 1}`;
    if (typeof item !== 'string') return `attachment ${i + 1} (${name}) is not a string`;
    if (!item.startsWith('data:')) {
      files.push({ name, text: item });
      continue;
    }
    const comma = item.indexOf(',');
    const header = comma < 0 ? '' : item.slice(5, comma);
    const [mediaType, ...params] = header.split(';');
    if (comma < 0 || !TEXT_MEDIA.test(mediaType.trim())) {
      return `attachment ${i + 1} (${name}) is ${mediaType || 'not a valid data: URI'}; code mode takes text only`;
    }
    const data = item.slice(comma + 1);
    try {
      const text = params.some(param => param.trim().toLowerCase() === 'base64')
        ? Buffer.from(data, 'base64').toString('utf8')
        : decodeURIComponent(data);
      files.push({ name, text });
    } catch {
      return `attachment ${i + 1} (${name}) could not be decoded`;
    }
  }
  return files;
}

interface ModelEntry {
  provider?: unknown;
  model?: unknown;
  weight?: unknown;
  count?: unknown;
}

function sha256(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

/** The juror prompt goes to the interaction log once per request (it is the same for every juror). */
function logPrompt(requestTag: string, prompt: string) {
  const line = `[${new Date().toISOString()}] Code-review jury prompt (${requestTag}, sha256 ${sha256(prompt)}):\n${prompt}\n`;
  try {
    const logDir = path.join(process.cwd(), 'logs');
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(path.join(logDir, 'llm-interactions.log'), line);
  } catch (error) {
    console.error('Error writing to log file:', error);
  }
}

/** A juror's state for an error body: no provider wording, which the EA's retry check reads as fatal. */
function jurorSummary(results: JurorResult[]) {
  return results.map(result => ({
    juror: `${result.provider}:${result.model}`,
    status: result.status,
    duration_ms: result.duration_ms,
    ...(result.error_message && { message: result.error_message }),
    ...(result.http_status !== undefined && { http_status: result.http_status }),
  }));
}

export async function handleCodeReviewRequest(body: Record<string, unknown>, receivedAt: number): Promise<CodeReviewResponse> {
  try {
    return await judge(body, receivedAt);
  } catch (error: any) {
    return errorResponse('INTERNAL', `code review failed unexpectedly: ${error?.message || String(error)}`);
  }
}

async function judge(body: Record<string, unknown>, receivedAt: number): Promise<CodeReviewResponse> {
  const requestTag = typeof body.requestTag === 'string' && body.requestTag ? body.requestTag : `req_${receivedAt}`;

  // 1. The field, by common's schema and rules.
  const validation = codeReview.validateCodeReviewRequest(body.codeReview);
  if (!validation.ok) {
    const first = validation.issues[0];
    return errorResponse('INVALID', `the codeReview field is invalid: ${first.code} at ${first.path}${first.detail ? ` (${first.detail})` : ''}`, {
      issues: issueList(validation.issues),
    });
  }
  const request = body.codeReview as codeReview.CodeReviewRequest;
  if (typeof body.prompt !== 'string' || !body.prompt.trim()) {
    return errorResponse('INVALID', 'code mode needs "prompt": the listing\'s query');
  }
  const query = body.prompt;
  // The disclosure keys must never reach a model: the EA strips the addendum's machine lines (§14, E1, E2).
  const machineLine = query.split('\n').find(line => /^\s*verdikta-(disclosure|dispute):/.test(line));
  if (machineLine !== undefined) {
    return errorResponse('INVALID', `the prompt carries a ${machineLine.trim().split(':')[0]}: line; strip the addendum's machine lines before the jury`);
  }

  // 2. The envelope: the six outcomes, the panel, NO_COUNTS and ITERATIONS.
  const outcomeCheck = codeReview.validateBugOutcomes(body.outcomes);
  if (!outcomeCheck.ok) {
    return errorResponse('ENVELOPE', `outcomes must be ${codeReview.BUG_OUTCOMES.join(', ')}, in that order`, {
      issues: issueList(outcomeCheck.issues),
    });
  }
  const outcomes = [...codeReview.BUG_OUTCOMES];
  const models = body.models;
  const juryParameters = {
    NUMBER_OF_OUTCOMES: outcomes.length,
    AI_NODES: Array.isArray(models)
      ? (models as ModelEntry[]).map(entry => ({
        AI_PROVIDER: entry?.provider,
        AI_MODEL: entry?.model,
        NO_COUNTS: entry?.count === undefined ? 1 : entry.count,
        WEIGHT: entry?.weight,
      }))
      : models,
    ...(body.iterations !== undefined && { ITERATIONS: body.iterations }),
  };
  const envelopeCheck = codeReview.validateClassEnvelope(juryParameters, request.codeClass);
  if (!envelopeCheck.ok) {
    const first = envelopeCheck.issues[0];
    return errorResponse('ENVELOPE', `the panel is outside the ${request.codeClass} envelope: ${first.code} at ${first.path}`, {
      issues: issueList(envelopeCheck.issues),
    });
  }
  const jurors: CodeJuror[] = (models as Array<{ provider: string; model: string; weight: number }>).map(entry => ({
    // the factory's provider class, as the envelope compared it (trimmed, any case)
    provider: entry.provider.trim().toLowerCase(),
    model: entry.model,
    weight: entry.weight,
  }));
  const envelope = codeReview.getCodeClass(request.codeClass)!.envelope;

  // 3. The pack is text.
  const pack = packFiles(body.attachments, body.attachmentNames);
  if (typeof pack === 'string') return errorResponse('ATTACHMENT', pack);

  // 4. The deadline.
  const times = planCodeReviewTimes(request.deadlineMs, receivedAt);
  if (!times) {
    return errorResponse('DEADLINE', `deadlineMs ${request.deadlineMs} leaves no time for the jury after the ${JUSTIFIER_RESERVE_MS} ms justifier reserve`);
  }
  if (!justifierModel()) return errorResponse('INTERNAL', 'JUSTIFIER_MODEL is not set as provider:model');

  const prompt = buildClaimPrompt({ query, request, pack, outcomes });
  const promptSha256 = sha256(prompt);
  console.log(`⚖️ CODE_REVIEW_START: ${requestTag} class=${request.codeClass} report=${request.reportSha256} prompt=${promptSha256} deadlineMs=${request.deadlineMs} jurorTimeoutMs=${times.jurorTimeoutMs} panel=${jurors.map(j => `${j.provider}:${j.model}@${j.weight}`).join(',')}`);
  logPrompt(requestTag, prompt);

  // 5. The jury: every juror required.
  const jury = await runCodeJury({
    jurors,
    prompt,
    outcomes,
    maxTokens: envelope.jurorOutputTokens,
    juryDeadlineAt: times.juryDeadlineAt,
  });
  if (jury.kind !== 'ok') {
    const culprit = jury.results.find(r => r.status === (jury.kind === 'timeout' ? 'timeout' : 'failed'))
      ?? jury.results.find(r => r.status === 'parsing_error')
      ?? jury.results.find(r => r.status !== 'success' && r.status !== 'cancelled')!;
    const juror = `${culprit.provider}:${culprit.model}`;
    const what = culprit.status === 'parsing_error' ? culprit.error_message : `failed: ${culprit.error_message}`;
    return jury.kind === 'timeout'
      ? errorResponse('JUROR_TIMEOUT', `juror ${juror} did not answer within the ${times.jurorTimeoutMs} ms the deadline leaves the jury; every juror call was cancelled`, {
        jurors: jurorSummary(jury.results),
      })
      : errorResponse('JUROR_FAILED', `juror ${juror} ${what}; every juror is required in code mode`, {
        jurors: jurorSummary(jury.results),
      });
  }

  // 6. The vector, then the justifier within its reserve.
  const vector = roundToTotal(weightedVector(jury.results, jurors.map(j => j.weight)));
  const budget = justifierBudgetMs(times, Date.now());
  if (budget <= 0) return errorResponse('DEADLINE', 'the deadline passed before the justifier could start');
  const justifier = await runCodeJustifier(buildCodeJustifierPrompt({
    outcomes,
    scores: vector,
    jurors: jury.results.map(r => ({ juror: `${r.provider}:${r.model}`, justification: r.justification || '' })),
    reportSha256: request.reportSha256,
  }), budget);
  if (justifier.kind === 'timeout') {
    return errorResponse('JUSTIFIER_TIMEOUT', `the justifier did not finish within its ${budget} ms; the arbiter abstains rather than publish a partial justification`);
  }
  if (justifier.kind === 'failed') {
    return errorResponse('JUSTIFIER_FAILED', `the justifier failed: ${justifier.message}; the arbiter abstains rather than publish a partial justification`);
  }

  const totalMs = Date.now() - receivedAt;
  console.log(`⚖️ CODE_REVIEW_DONE: ${requestTag} in ${totalMs} ms, vector ${JSON.stringify(vector)}`);
  return {
    status: 200,
    body: {
      scores: outcomes.map((outcome, i) => ({ outcome, score: vector[i] })),
      justification: justifier.text,
      metadata: {
        models_requested: jurors.length,
        models_successful: jurors.length,
        models_failed: 0,
        success_threshold_met: true,
        total_duration_ms: totalMs,
      },
      model_results: jury.results.map(r => ({ provider: r.provider, model: r.model, status: r.status, duration_ms: r.duration_ms })),
      codeReview: {
        codeClass: request.codeClass,
        reportSha256: request.reportSha256,
        promptSha256,
        deadlineMs: request.deadlineMs,
        jurorTimeoutMs: times.jurorTimeoutMs,
        justifierReserveMs: JUSTIFIER_RESERVE_MS,
        maxTokens: envelope.jurorOutputTokens,
        effort: CODE_JUROR_EFFORT,
      },
      ...(validation.warnings.length > 0 && {
        warnings: validation.warnings.map(w => ({ type: w.code, message: `${w.path}: ${w.detail ?? w.code}`, severity: 'warning' })),
      }),
    },
  };
}
