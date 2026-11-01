/**
 * Code mode's jury and justifier calls (design §10.3, §10.5, §11; build plan A3).
 *
 * Every juror is required (no Jev in the MVP): the first juror that fails ends
 * the request and the others are cancelled, since their answers can no longer
 * be used. The jury is cancelled at its deadline. Cancelling aborts each
 * juror's AbortController; the signal goes into the provider call, which
 * aborts its HTTP request, and raceAbort releases the route at once even if a
 * provider ignores it. Web access is off for every call, and jurors run with
 * the class envelope's output tokens at effort high.
 */

import { LLMFactory } from '../llm/llm-factory';
import { parseModelResponse } from '../../utils/parseModelResponse';
import { parseRepairedScores, replyJustification } from '../../utils/repairModelResponse';
import { buildCodeRepairPrompt } from './claim-prompt';
import { CallAbortedError, raceAbort, timedController } from './deadline';

/** Every juror in the MVP panels is a frontier juror (no Jev): effort high (§10.3). */
export const CODE_JUROR_EFFORT = 'high' as const;

export interface CodeJuror {
  /** As the class pool names it, lower case (the factory's provider class). */
  provider: string;
  model: string;
  weight: number;
}

export type JurorStatus = 'success' | 'failed' | 'parsing_error' | 'timeout' | 'cancelled';

export interface JurorResult {
  provider: string;
  model: string;
  status: JurorStatus;
  duration_ms: number;
  error_message?: string;
  http_status?: number;
  vector?: number[];
  justification?: string;
}

export interface JuryOutcome {
  /** ok: every juror answered. failed: a juror failed (provider error or no usable scores). timeout: the jury deadline passed. */
  kind: 'ok' | 'failed' | 'timeout';
  results: JurorResult[];
}

class JurorParseError extends Error {
  constructor() {
    super('gave no usable scores, also after the repair call');
    this.name = 'JurorParseError';
  }
}

export function stripThinkingBlocks(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

function httpStatusOf(error: any): number | undefined {
  const status = error?.status ?? error?.response?.status ?? error?.statusCode;
  return typeof status === 'number' ? status : undefined;
}

async function askJuror(
  juror: CodeJuror,
  prompt: string,
  outcomes: string[],
  signal: AbortSignal,
  maxTokens: number,
): Promise<{ vector: number[]; justification: string }> {
  const provider = await LLMFactory.getProvider(juror.provider) as any;
  const options = { webAccess: false, signal, maxTokens, effort: CODE_JUROR_EFFORT };
  const reply = stripThinkingBlocks(await provider.generateResponse(prompt, juror.model, options));
  console.log(`⚖️ CODE_JUROR_REPLY: ${juror.provider}:${juror.model} (${reply.length} chars)\n${reply}`);
  const parsed = parseModelResponse(reply, outcomes);
  // The vector decides an award: every component a non-negative integer (the parser checks the sum).
  if (parsed.decisionVector && parsed.decisionVector.every(value => Number.isInteger(value) && value >= 0)) {
    return { vector: parsed.decisionVector, justification: parsed.justification || reply };
  }
  if (signal.aborted) throw new CallAbortedError('jury deadline');
  // One repair call, as in text mode, inside the juror's own time and signal; the
  // reply is quoted in a hash fence (claim-prompt.ts, buildCodeRepairPrompt).
  const answer = await provider.generateResponse(buildCodeRepairPrompt(reply, outcomes), juror.model, { ...options, effort: 'low' });
  const repaired = parseRepairedScores(answer, outcomes.length);
  if (repaired) return { vector: repaired, justification: replyJustification(reply) };
  throw new JurorParseError();
}

/** Run every juror in parallel until all answer, one fails, or `juryDeadlineAt` passes. */
export async function runCodeJury(input: {
  jurors: CodeJuror[];
  prompt: string;
  outcomes: string[];
  maxTokens: number;
  juryDeadlineAt: number;
}): Promise<JuryOutcome> {
  const controllers = input.jurors.map(() => new AbortController());
  // What ended the jury first: a juror's failure or the deadline (set once).
  const state: { first: 'failed' | 'timeout' | null } = { first: null };
  const abortAll = () => controllers.forEach(controller => controller.abort());
  const timer = setTimeout(() => {
    state.first = state.first ?? 'timeout';
    abortAll();
  }, Math.max(0, input.juryDeadlineAt - Date.now()));

  const results = await Promise.all(input.jurors.map(async (juror, index): Promise<JurorResult> => {
    const signal = controllers[index].signal;
    const startedAt = Date.now();
    const base = { provider: juror.provider, model: juror.model };
    try {
      const answer = await raceAbort(askJuror(juror, input.prompt, input.outcomes, signal, input.maxTokens), signal);
      return { ...base, status: 'success', duration_ms: Date.now() - startedAt, ...answer };
    } catch (error: any) {
      const duration_ms = Date.now() - startedAt;
      if (signal.aborted) {
        const timedOut = state.first === 'timeout';
        return {
          ...base,
          status: timedOut ? 'timeout' : 'cancelled',
          duration_ms,
          error_message: timedOut
            ? `no answer within the ${input.juryDeadlineAt - startedAt} ms the deadline leaves the jury; the call was cancelled`
            : 'cancelled: another juror failed, and every juror is required',
        };
      }
      // Every juror is required: one failure decides the request, so stop the others now.
      state.first = state.first ?? 'failed';
      abortAll();
      return {
        ...base,
        status: error instanceof JurorParseError ? 'parsing_error' : 'failed',
        duration_ms,
        error_message: error?.message || String(error),
        http_status: httpStatusOf(error),
      };
    }
  }));
  clearTimeout(timer);

  if (results.every(result => result.status === 'success')) return { kind: 'ok', results };
  const failed = results.some(result => result.status === 'failed' || result.status === 'parsing_error');
  return { kind: failed && state.first === 'failed' ? 'failed' : 'timeout', results };
}

/** JUSTIFIER_MODEL as provider and model, split at the first colon. */
export function justifierModel(): { provider: string; model: string } | null {
  const spec = process.env.JUSTIFIER_MODEL?.trim();
  if (!spec) return null;
  const colon = spec.indexOf(':');
  if (colon <= 0 || colon === spec.length - 1) return null;
  return { provider: spec.slice(0, colon), model: spec.slice(colon + 1) };
}

export type JustifierOutcome =
  | { kind: 'ok'; text: string }
  | { kind: 'timeout' }
  | { kind: 'failed'; message: string; httpStatus?: number };

/** The justifier, cancelled after `budgetMs`. Code mode never falls back to the jurors' own text. */
export async function runCodeJustifier(prompt: string, budgetMs: number): Promise<JustifierOutcome> {
  const target = justifierModel();
  if (!target) return { kind: 'failed', message: 'JUSTIFIER_MODEL is not set as provider:model' };
  const { controller, clear } = timedController(budgetMs);
  try {
    const provider = await LLMFactory.getProvider(target.provider) as any;
    const work = provider.generateResponse(prompt, target.model, { webAccess: false, signal: controller.signal });
    const text = stripThinkingBlocks(await raceAbort<string>(work, controller.signal, 'justifier reserve'));
    if (!text) return { kind: 'failed', message: `${target.provider}:${target.model} returned an empty justification` };
    return { kind: 'ok', text };
  } catch (error: any) {
    if (controller.signal.aborted) return { kind: 'timeout' };
    return { kind: 'failed', message: error?.message || String(error), httpStatus: httpStatusOf(error) };
  } finally {
    clear();
  }
}

/** The weighted average over every juror (§10.5: scoring is unchanged). */
export function weightedVector(results: JurorResult[], weights: number[]): number[] {
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const length = results[0]?.vector?.length ?? 0;
  const vector = new Array(length).fill(0);
  results.forEach((result, i) => {
    result.vector!.forEach((value, j) => {
      vector[j] += (value * weights[i]) / total;
    });
  });
  return vector;
}
