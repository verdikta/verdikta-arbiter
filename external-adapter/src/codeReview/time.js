/**
 * @fileoverview The single deadline of a code-review evaluation (design §11).
 *
 * The Chainlink job gives the adapter 840 s. The adapter keeps 60 s of that
 * for the commit, so its deadline is receipt + 780 s, and everything it calls
 * is told the time remaining when the call is sent: `deadline` to the runner,
 * `deadlineMs` to the AI Node. Nothing is retried once the jury could no longer
 * finish, and nothing is committed past the deadline.
 */

const { CodeReviewAbstain } = require('./errors');

/** The 840 s bridge timeout less the commit reserve. */
const DEFAULT_DEADLINE_MS = 780000;
/** Kept after the deadline for the commit: the response, the transaction. */
const COMMIT_RESERVE_MS = 60000;
/** The AI Node's own reserve for the justifier (ai-node/src/lib/code-review/deadline.ts). */
const JUSTIFIER_RESERVE_MS = 45000;
/** The least jury time worth a provider's bill. The AI Node refuses below 10 s; a juror with a full pack at effort high needs far more. */
const JUROR_FLOOR_MS = 60000;

/** Is an AI call worth making with this much left? Strictly more than the justifier's reserve and the floor. */
function juryWorthCalling(remainingMs) {
  return remainingMs > JUSTIFIER_RESERVE_MS + JUROR_FLOOR_MS;
}

/**
 * @param {object} o
 * @param {number} o.receivedAt - when the request reached the adapter, epoch ms
 * @param {number} o.deadlineMs - the budget from receipt
 * @param {() => number} [o.now]
 */
function createDeadline({ receivedAt, deadlineMs, now = Date.now }) {
  const at = receivedAt + deadlineMs;
  /** Whole milliseconds left: never below zero, and never above the budget if the clock steps back. */
  const remaining = () => Math.max(0, Math.min(deadlineMs, Math.floor(at - now())));
  const passed = () => now() > at;
  const expired = (what) => new CodeReviewAbstain('CODE_REVIEW_DEADLINE', `the ${deadlineMs} ms deadline passed before the ${what}; the arbiter abstains`);

  return {
    at,
    deadlineMs,
    remaining,
    passed,
    expired,
    assertOpen(what) {
      if (passed()) throw expired(what);
    },
    /**
     * A signal that fires at the deadline, or after `maxMs` when that is
     * sooner (`byDeadline` says which), and what stops it.
     */
    abortAtDeadline({ maxMs = Infinity } = {}) {
      const controller = new AbortController();
      const left = remaining();
      const timer = setTimeout(() => controller.abort(), Math.min(maxMs, left));
      return { signal: controller.signal, byDeadline: left <= maxMs, clear: () => clearTimeout(timer) };
    },
    /**
     * The work's own answer, or the deadline's abstention if it comes first.
     * The work itself is left alone: it may be another job's shared run.
     */
    race(work, what) {
      let timer;
      const limit = new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(expired(what)), remaining());
      });
      return Promise.race([work, limit]).finally(() => clearTimeout(timer));
    }
  };
}

module.exports = { DEFAULT_DEADLINE_MS, COMMIT_RESERVE_MS, JUSTIFIER_RESERVE_MS, JUROR_FLOOR_MS, juryWorthCalling, createDeadline };
