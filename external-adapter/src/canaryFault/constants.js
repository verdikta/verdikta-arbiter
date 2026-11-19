/**
 * @fileoverview What the canary fault switch is held to, as constants: nothing a node reads
 * can move them (docs/release-runbook.md §3b; decision D9).
 */

const CANARY_CLASS_ID = 5555;
/** Base Sepolia. */
const CANARY_CHAIN_ID = 84532;
/** The aggregator on Base Sepolia (docs/deployments.md). If it is redeployed the switch refuses until this changes. */
const CANARY_AGGREGATOR = '0xe8a385E473EA710c5a88Cc72681a16a26fe380e4';

/**
 * provider-timeout's first attempt is told this deadline (or what is left, if less): the
 * justifier's 45 s and the 60 s juror floor, the least jury the adapter ever calls
 * (codeReview/time.js). Its real 503 then comes at 60 s, and the retry has what a claim with no
 * fault has: the whole jury cap for any run up to 195 s from receipt, at most 60 s less after
 * that. At the time left, a first attempt that ran to the 480 s cap would leave a retry 255 s
 * less the run, or none from 195 s on, and the scenario would test the panel's speed (A13).
 */
const PROVIDER_TIMEOUT_FIRST_DEADLINE_MS = 105000;

/**
 * What each fault asks of the AI Node, per attempt. The actions are all the switch can do:
 * hold a real answer, or start a real call late. `firstAttemptDeadlineMs` is the one other
 * thing: a shorter deadline for the first attempt, never a longer one (codeReview/claimRun.js
 * takes the smaller of it and what is left). null: every attempt is told what is left.
 */
const FAULTS = Object.freeze({
  'near-limit-juror': Object.freeze({ action: 'hold-juror-answer', firstAttemptOnly: false, firstAttemptDeadlineMs: null }),
  'provider-timeout': Object.freeze({ action: 'late-juror', firstAttemptOnly: true, firstAttemptDeadlineMs: PROVIDER_TIMEOUT_FIRST_DEADLINE_MS }),
  'slow-justifier': Object.freeze({ action: 'hold-justifier-answer', firstAttemptOnly: false, firstAttemptDeadlineMs: null }),
  // At the deadline (design §18): each attempt is told what is left, the first one too.
  cancellation: Object.freeze({ action: 'late-juror', firstAttemptOnly: false, firstAttemptDeadlineMs: null })
});

module.exports = { CANARY_CLASS_ID, CANARY_CHAIN_ID, CANARY_AGGREGATOR, FAULTS };
