/**
 * A deterministic mock provider for tests and the local pipeline (build plan A5, A6a).
 *
 * Enabled only by the test-only flag VERDIKTA_TEST_MOCK_PROVIDER=1, and only
 * outside production builds: `next build` inlines NODE_ENV as "production", so
 * a production build can never construct it, and the factory refuses every
 * request while the flag is set there instead of quietly using real providers.
 * With the flag on, every provider name resolves to this provider, so a real
 * code-review panel (anthropic / openrouter / openai ids from the class pool)
 * runs end to end without a key or a network call.
 *
 * Behaviour per model id comes from VERDIKTA_TEST_MOCK_SCRIPT (JSON), read on
 * every call:
 *
 *   { "<model id>" | "*": Behaviour | Behaviour[] }
 *   Behaviour = { scores?: number[], justification?: string, reply?: string,
 *                 delayMs?: number, hang?: boolean, error?: string, status?: number }
 *
 * An array is a per-call sequence (call n uses entry n, the last entry repeats).
 * Without an entry the reply is a pure function of the model and the prompt:
 * an even score split over the outcome count the prompt asks for, or plain
 * text when it asks for no scores (the justifier). Every call honours its
 * AbortSignal: an abort rejects at once and clears the pending timer.
 */

import crypto from 'crypto';
import { LLMProvider } from './llm-provider-interface';

export const MOCK_PROVIDER_FLAG = 'VERDIKTA_TEST_MOCK_PROVIDER';
export const MOCK_SCRIPT_ENV = 'VERDIKTA_TEST_MOCK_SCRIPT';

export type MockProviderState = 'off' | 'on' | 'refused';

/** 'refused' when the flag is set in a production build; 'on' when set elsewhere; else 'off'. */
export function mockProviderState(): MockProviderState {
  if (process.env[MOCK_PROVIDER_FLAG] !== '1') return 'off';
  // A literal process.env.NODE_ENV: next build replaces it, so this branch is fixed per build.
  if (process.env.NODE_ENV === 'production') return 'refused';
  return 'on';
}

export const MOCK_REFUSED_MESSAGE =
  `${MOCK_PROVIDER_FLAG} is set, but the mock provider is test-only and refused in production builds; unset it`;

interface MockBehaviour {
  scores?: number[];
  justification?: string;
  reply?: string;
  delayMs?: number;
  hang?: boolean;
  error?: string;
  status?: number;
}

export interface MockCall {
  provider: string;
  model: string;
  prompt: string;
  options: { webAccess: unknown; maxTokens: unknown; effort: unknown; signal: boolean };
  outcome: 'pending' | 'answered' | 'failed' | 'aborted';
  signalAborted: boolean;
  startedAt: number;
  endedAt: number | null;
}

let calls: MockCall[] = [];
let callCounts = new Map<string, number>();

/** Every call since the last reset, in order (tests read these). */
export function mockProviderCalls(): MockCall[] {
  return calls;
}

export function resetMockProvider(): void {
  calls = [];
  callCounts = new Map();
}

function readScript(): Record<string, MockBehaviour | MockBehaviour[]> {
  const raw = process.env[MOCK_SCRIPT_ENV];
  if (!raw) return {};
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${MOCK_SCRIPT_ENV} must be a JSON object keyed by model id`);
  }
  return parsed;
}

function behaviourFor(model: string, callIndex: number): MockBehaviour {
  const script = readScript();
  const entry = script[model] ?? script['*'];
  if (!entry) return {};
  if (Array.isArray(entry)) return entry[Math.min(callIndex, entry.length - 1)] ?? {};
  return entry;
}

/** The outcome count a scoring prompt asks for, or null for a prompt that asks for no scores. */
function requestedOutcomeCount(prompt: string): number | null {
  const scored = /must contain exactly (\d+) (?:integers|elements)/i.exec(prompt);
  if (scored) return parseInt(scored[1], 10);
  // the score-repair prompt: {"score": [<1>, <2>, ...]}
  const repair = /\{"score": \[((?:<\d+>, )*<\d+>)\]\}/.exec(prompt);
  if (repair) return repair[1].split(',').length;
  return null;
}

function evenSplit(n: number): number[] {
  const base = Math.floor(1000000 / n);
  const vector = Array(n).fill(base);
  vector[0] += 1000000 - base * n;
  return vector;
}

function defaultReply(model: string, prompt: string): string {
  const digest = crypto.createHash('sha256').update(`${model}\n${prompt}`).digest('hex').slice(0, 12);
  const n = requestedOutcomeCount(prompt);
  if (n === null) return `Deterministic mock text from ${model} (${digest}).`;
  return JSON.stringify({ score: evenSplit(n), justification: `Deterministic mock juror ${model} (${digest}).` });
}

function abortError(): Error {
  return Object.assign(new Error('The mock provider call was aborted.'), { name: 'AbortError' });
}

/** Resolve after `ms` (never when `ms` is Infinity), or reject at once when the signal aborts. */
function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    if (ms <= 0) {
      resolve();
      return;
    }
    const timer = Number.isFinite(ms) ? setTimeout(done, ms) : null;
    function done() {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }
    function onAbort() {
      if (timer) clearTimeout(timer);
      reject(abortError());
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export class MockProvider implements LLMProvider {
  constructor(private readonly providerName: string = 'mock') {}

  async initialize(): Promise<void> {
    if (mockProviderState() !== 'on') throw new Error(MOCK_REFUSED_MESSAGE);
  }

  async getModels(): Promise<Array<{ name: string; supportsImages: boolean; supportsAttachments: boolean }>> {
    return [{ name: 'mock', supportsImages: false, supportsAttachments: true }];
  }

  supportsImages(): boolean {
    return false;
  }

  supportsAttachments(): boolean {
    return true;
  }

  async generateResponse(prompt: string, model: string, options?: any): Promise<string> {
    if (mockProviderState() !== 'on') throw new Error(MOCK_REFUSED_MESSAGE);
    const signal: AbortSignal | undefined = options?.signal;
    const index = callCounts.get(model) ?? 0;
    callCounts.set(model, index + 1);
    const call: MockCall = {
      provider: this.providerName,
      model,
      prompt,
      options: { webAccess: options?.webAccess, maxTokens: options?.maxTokens, effort: options?.effort, signal: !!signal },
      outcome: 'pending',
      signalAborted: false,
      startedAt: Date.now(),
      endedAt: null,
    };
    calls.push(call);
    const finish = (outcome: MockCall['outcome']) => {
      call.outcome = outcome;
      call.signalAborted = !!signal?.aborted;
      call.endedAt = Date.now();
    };

    const behaviour = behaviourFor(model, index);
    try {
      await wait(behaviour.hang ? Infinity : behaviour.delayMs ?? 0, signal);
    } catch (error) {
      finish('aborted');
      throw error;
    }
    if (behaviour.error) {
      finish('failed');
      throw Object.assign(new Error(behaviour.error), behaviour.status ? { status: behaviour.status } : {});
    }
    finish('answered');
    if (behaviour.reply !== undefined) return behaviour.reply;
    if (behaviour.scores) {
      return JSON.stringify({ score: behaviour.scores, justification: behaviour.justification ?? `Scripted mock juror ${model}.` });
    }
    return defaultReply(model, prompt);
  }

  async generateResponseWithImage(prompt: string, model: string): Promise<string> {
    return this.generateResponse(prompt, model);
  }

  async generateResponseWithAttachments(prompt: string, model: string, _attachments: unknown[], options?: any): Promise<string> {
    return this.generateResponse(prompt, model, options);
  }
}
