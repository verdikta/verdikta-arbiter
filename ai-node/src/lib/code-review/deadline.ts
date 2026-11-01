/**
 * Code mode's single deadline (design §11).
 *
 * The external adapter passes `codeReview.deadlineMs`: the milliseconds the AI
 * Node has from receipt. Code mode works from it instead of REQUEST_TIMEOUT_MS
 * and MODEL_TIMEOUT_MS: the jurors get the time left after the justifier's 45 s
 * reserve, capped at the 240 s jury budget of §11 (so a far deadline leaves the
 * EA time to retry a timed-out juror), and the justifier gets its reserve. Each
 * stage is cancelled with an AbortController when its time is up; the signal
 * reaches the provider's HTTP request, and raceAbort makes sure the route
 * answers on time even if a provider ignored it.
 */

/** Kept for the justifier after the jury (§11: jury ≤ 240 s, then justifier 45 s). */
export const JUSTIFIER_RESERVE_MS = 45000;

/** The jury's budget when the deadline is further away (§11). */
export const CODE_JURY_MAX_MS = 240000;

/** Below this much jury time the request cannot be judged; it is refused before any model call. */
export const MIN_JURY_MS = 10000;

export interface CodeReviewTimes {
  receivedAt: number;
  deadlineMs: number;
  /** receivedAt + deadlineMs: nothing may run past it. */
  deadlineAt: number;
  /** Every juror call (with its repair call) is cancelled at this time. */
  juryDeadlineAt: number;
  /** juryDeadlineAt − receivedAt. */
  jurorTimeoutMs: number;
}

/** The plan for a request received at `receivedAt`, or null when the deadline leaves no jury time. */
export function planCodeReviewTimes(deadlineMs: number, receivedAt: number): CodeReviewTimes | null {
  const jurorTimeoutMs = Math.min(CODE_JURY_MAX_MS, deadlineMs - JUSTIFIER_RESERVE_MS);
  if (!Number.isFinite(jurorTimeoutMs) || jurorTimeoutMs < MIN_JURY_MS) return null;
  return {
    receivedAt,
    deadlineMs,
    deadlineAt: receivedAt + deadlineMs,
    juryDeadlineAt: receivedAt + jurorTimeoutMs,
    jurorTimeoutMs,
  };
}

/** The justifier's time when it starts at `now`: its reserve, never past the deadline. */
export function justifierBudgetMs(times: CodeReviewTimes, now: number): number {
  return Math.max(0, Math.min(JUSTIFIER_RESERVE_MS, times.deadlineAt - now));
}

/** Rejection of a call whose AbortSignal fired; `reason` is what the caller recorded. */
export class CallAbortedError extends Error {
  constructor(readonly reason: string) {
    super(`call aborted: ${reason}`);
    this.name = 'AbortError';
  }
}

/**
 * The work's result, or a CallAbortedError as soon as `signal` aborts, whether or
 * not the work itself ever settles. The work should also get the signal, so the
 * underlying request is cancelled too; this only guarantees the caller is not
 * held past its deadline by a provider that ignores it.
 */
export function raceAbort<T>(work: Promise<T>, signal: AbortSignal, reason = 'aborted'): Promise<T> {
  if (signal.aborted) {
    work.catch(() => {});
    return Promise.reject(new CallAbortedError(reason));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new CallAbortedError(reason));
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      value => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      error => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/** An AbortController that aborts itself after `ms`; `clear` stops the timer. */
export function timedController(ms: number): { controller: AbortController; clear: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(0, ms));
  return { controller, clear: () => clearTimeout(timer) };
}
