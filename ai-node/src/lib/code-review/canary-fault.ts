/**
 * The canary fault switch on the AI Node (decision D9; design §11, §18).
 *
 * This process has no chain access, so it cannot measure a class. The External Adapter does
 * (external-adapter/src/canaryFault/), and mints a directive for one attempt: an action and an
 * HMAC over the action, the claim and the report, with a key this node holds too. Here a
 * directive is acted on only if it verifies against that key. With no key the field is
 * ignored, on any node, and a direct POST to this port can do nothing.
 *
 * What it can do is wait. A hold takes a signal and gives back nothing: it never sees a
 * score, a justification or the prompt. It runs inside the raced work, like a provider call, so
 * a stage's deadline ends it whatever it does.
 *
 *   hold-juror-answer      the first juror's real answer, until 5 s before the jury deadline
 *   late-juror             the first juror's real call starts 3 s before the jury deadline, so it
 *                          is on the wire when the deadline aborts it; an answer that came back
 *                          anyway is held to the abort
 *   hold-justifier-answer  the real justification, until 5 s before the justifier's end
 *
 * The key is read here and nowhere else, at each request, under a computed name: next build
 * cannot inline it. No install or upgrade path sets it (docs/release-runbook.md, 3b). Unrelated
 * to the mock provider, which is test-only: this runs on real canaries with real providers.
 */

import crypto from 'crypto';

export const CANARY_FAULT_KEY_ENV = 'VERDIKTA_CANARY_FAULT_KEY';

const KEY_RULE = /^[\x21-\x7e]{32,}$/;
const MAC_RULE = /^[0-9a-f]{64}$/;
const JUROR_ANSWER_MARGIN_MS = 5000;
const LATE_JUROR_MARGIN_MS = 3000;
const JUSTIFIER_MARGIN_MS = 5000;

export type CanaryFaultState = 'off' | 'armed' | 'refused';
export type CanaryAction = 'hold-juror-answer' | 'late-juror' | 'hold-justifier-answer';

const ACTIONS: ReadonlySet<string> = new Set<CanaryAction>(['hold-juror-answer', 'late-juror', 'hold-justifier-answer']);

export interface CanaryHolds {
  beforeFirstJuror(signal: AbortSignal): Promise<void>;
  afterFirstJuror(signal: AbortSignal): Promise<void>;
  afterJustifier(signal: AbortSignal, endsAt: number): Promise<void>;
}

export const NO_HOLDS: CanaryHolds = {
  beforeFirstJuror: async () => {},
  afterFirstJuror: async () => {},
  afterJustifier: async () => {},
};

function usableKey(): string | null {
  const raw = process.env[CANARY_FAULT_KEY_ENV];
  if (typeof raw !== 'string') return null;
  const key = raw.trim();
  return KEY_RULE.test(key) ? key : null;
}

/** off: no key. refused: a key this code will not use, so it never acts. armed: it would verify a directive. */
export function canaryFaultState(): CanaryFaultState {
  const raw = process.env[CANARY_FAULT_KEY_ENV];
  if (typeof raw !== 'string' || raw.trim() === '') return 'off';
  return usableKey() ? 'armed' : 'refused';
}

/** The EA computes the same (external-adapter/src/canaryFault/index.js). */
export function directiveMac(key: string, action: string, bcid: string, reportSha256: string): string {
  return crypto.createHmac('sha256', key).update(`verdikta-canary-fault/1\n${action}\n${bcid}\n${reportSha256}`).digest('hex');
}

/** The action a directive asks for, when it verifies for this claim and report; otherwise null. */
export function readCanaryDirective(raw: unknown, binding: { bcid: string; reportSha256: string }): CanaryAction | null {
  const key = usableKey();
  if (!key || !raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const fields = Object.keys(raw);
  if (fields.length !== 2 || !fields.includes('action') || !fields.includes('mac')) return null;
  const { action, mac } = raw as { action: unknown; mac: unknown };
  if (typeof action !== 'string' || !ACTIONS.has(action) || typeof mac !== 'string' || !MAC_RULE.test(mac)) return null;
  const expected = Buffer.from(directiveMac(key, action, binding.bcid, binding.reportSha256), 'hex');
  return crypto.timingSafeEqual(expected, Buffer.from(mac, 'hex')) ? (action as CanaryAction) : null;
}

function holdAborted(): Error {
  return Object.assign(new Error('the hold was aborted'), { name: 'AbortError' });
}

/** Resolves at `at`, or rejects at once when the signal aborts. `at` is Infinity for "until the abort". */
function holdUntil(at: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(holdAborted());
      return;
    }
    const left = at - Date.now();
    if (left <= 0) {
      resolve();
      return;
    }
    const timer = Number.isFinite(left) ? setTimeout(done, left) : null;
    function done() {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }
    function onAbort() {
      if (timer) clearTimeout(timer);
      reject(holdAborted());
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** The holds of a verified action, over this request's own times. */
export function holdsFor(action: CanaryAction, times: { juryDeadlineAt: number }): CanaryHolds {
  return {
    beforeFirstJuror: signal => (action === 'late-juror' ? holdUntil(times.juryDeadlineAt - LATE_JUROR_MARGIN_MS, signal) : Promise.resolve()),
    afterFirstJuror: signal => {
      if (action === 'hold-juror-answer') return holdUntil(times.juryDeadlineAt - JUROR_ANSWER_MARGIN_MS, signal);
      if (action === 'late-juror') return holdUntil(Infinity, signal);
      return Promise.resolve();
    },
    afterJustifier: (signal, endsAt) => (action === 'hold-justifier-answer' ? holdUntil(endsAt - JUSTIFIER_MARGIN_MS, signal) : Promise.resolve()),
  };
}
