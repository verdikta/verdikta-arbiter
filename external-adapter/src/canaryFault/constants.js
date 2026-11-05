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
 * What each fault asks of the AI Node, per attempt. The actions are all the switch can do:
 * hold a real answer, or start a real call late.
 */
const FAULTS = Object.freeze({
  'near-limit-juror': Object.freeze({ action: 'hold-juror-answer', firstAttemptOnly: false }),
  'provider-timeout': Object.freeze({ action: 'late-juror', firstAttemptOnly: true }),
  'slow-justifier': Object.freeze({ action: 'hold-justifier-answer', firstAttemptOnly: false }),
  cancellation: Object.freeze({ action: 'late-juror', firstAttemptOnly: false })
});

module.exports = { CANARY_CLASS_ID, CANARY_CHAIN_ID, CANARY_AGGREGATOR, FAULTS };
