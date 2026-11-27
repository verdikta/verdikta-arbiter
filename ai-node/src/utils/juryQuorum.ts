/**
 * How many of a request's jurors must answer before the arbiter answers at all.
 *
 * Every one of them, by default. Until 2026-11 the default was half: a two-model jury was
 * answered by one model when the other timed out, could not be parsed, or was refused by its
 * provider, and the arbiter committed that one model's scores as the jury's. In a month of
 * bounty records (20 October to 21 November 2026) 12 of 314 two-juror evaluations went that
 * way, and three of bounty 398's six: on its third submission two arbiters each ran a
 * different lone juror and rejected it for different reasons.
 *
 * Below the minimum the route answers 400. The External Adapter then returns an error in
 * commit mode and commits nothing, so the round is decided by the arbiters that ran the
 * whole jury, or by nobody. Code mode has always required every juror.
 *
 * MIN_SUCCESSFUL_MODELS_PERCENT is the operator's override: a share of the jurors, above 0
 * and at most 1. 0.5 is the rule before this one.
 */

/** Every juror. */
export const DEFAULT_MIN_SUCCESSFUL_MODELS_PERCENT = 1;

/**
 * The share of jurors that must answer, from MIN_SUCCESSFUL_MODELS_PERCENT.
 *
 * A value that is not a number is not a setting, so the default holds. A number outside the
 * range is held to it: above 1 means every juror, 0 or less means one juror (requiredJurors
 * never returns less than one, where the unchecked value let a jury of no answers through).
 *
 * @param raw - The environment variable as it is set, if it is.
 */
export function minSuccessfulModelsPercent(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_MIN_SUCCESSFUL_MODELS_PERCENT;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    console.warn(`⚠️ MIN_SUCCESSFUL_MODELS_PERCENT is not a number; every juror is required`);
    return DEFAULT_MIN_SUCCESSFUL_MODELS_PERCENT;
  }
  return Math.min(1, Math.max(0, value));
}

/**
 * @param jurors - The number of models in the request's jury.
 * @param percent - The share that must answer (minSuccessfulModelsPercent).
 * @returns The number of jurors that must answer: at least one, at most all.
 */
export function requiredJurors(jurors: number, percent: number): number {
  return Math.min(jurors, Math.max(1, Math.ceil(jurors * percent)));
}
