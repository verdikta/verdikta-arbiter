/**
 * One-number questions (v2 aggregator, verdikta-dispatcher `beacon` branch).
 *
 * A request with exactly one outcome asks each juror for a single score from 0 to 1,000,000,
 * revealed as `[score]`. The score is never scaled to add up to 1,000,000: with one outcome that
 * scaling would always give `[1000000]` and say nothing. The query says what the score measures
 * and what 0 and 1,000,000 mean. One outcome is the whole signal; verdikta-common's
 * MANIFEST_SPECIFICATION.md ("One-number questions") states the rule.
 *
 * Requests with two or more outcomes are scored as before: a split that adds up to 1,000,000.
 */

/** The total a split adds up to, and the top of a one-number score. */
export const SCORE_TOTAL = 1000000;

/** True when the request asks for one number: exactly one outcome. */
export function isOneNumberQuestion(outcomes?: string[]): boolean {
  return Array.isArray(outcomes) && outcomes.length === 1;
}

/** True when `value` is a usable one-number score: finite, from 0 to 1,000,000. */
export function isValidOneNumber(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= SCORE_TOTAL;
}
