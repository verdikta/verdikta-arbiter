/**
 * Code mode's single deadline (design §11).
 *
 * The external adapter passes `codeReview.deadlineMs`: the milliseconds the AI
 * Node has from receipt. Code mode works from it instead of REQUEST_TIMEOUT_MS
 * and MODEL_TIMEOUT_MS: the jurors get the time left after the justifier's 45 s
 * reserve, capped at the 480 s jury budget of §11 (so a far deadline leaves the
 * EA time to retry a timed-out juror), and the justifier gets everything left
 * before the deadline when it starts: at least its reserve, and more when the
 * jury finished early. The cap only ever shortens what the deadline leaves, and
 * the justifier ends at the deadline, so nothing here runs past deadlineMs. A
 * justifier timeout therefore comes only at the deadline, when the EA has no
 * time left to retry (external-adapter/src/codeReview/time.js, juryWorthCalling).
 * Each stage is cancelled with an AbortController when its time is
 * up; the signal reaches the provider's HTTP request, and raceAbort makes sure
 * the route answers on time even if a provider ignored it. A juror's HTTP call
 * holds for its whole window (llm/juror-transport.ts: Node's fetch alone gives
 * up after 300 s without response headers).
 */

/**
 * Kept for the justifier after the jury's window (§11: jury ≤ 480 s, then the justifier
 * with at least 45 s and whatever the deadline leaves). A reserve, not the justifier's cap.
 */
export const JUSTIFIER_RESERVE_MS = 45000;

/**
 * The jury's budget when the deadline is further away (§11). 240 s until A11: slower
 * jurors with better accuracy or cost may sit on a panel (owner, 2026-11-09).
 */
export const CODE_JURY_MAX_MS = 480000;

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

/**
 * The justifier's time when it starts at `now`: everything left before the deadline, never
 * past it. After the jury's window that is at least JUSTIFIER_RESERVE_MS.
 */
export function justifierBudgetMs(times: CodeReviewTimes, now: number): number {
  return Math.max(0, times.deadlineAt - now);
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
