/**
 * The result of a text-mode evaluation, written out by the arbiter itself.
 *
 * The justification's prose comes from a model (the justifier) that used to be given a bare
 * vector, `[567500,432500]`, and the jurors' texts: no outcome names, no juror scores, no
 * weights, nothing about a juror that failed. On bounty 398 it explained a result of
 * FUND 432,500 as "FUND = 865,000 on a 1,000,000-sum scale", one juror's score, and a
 * reader of the record could not tell which number had settled the submission. Two other
 * records of that bounty were one juror's verdict because the other had timed out or been
 * refused by its provider, which only `model_results` showed.
 *
 * This block is computed from the same numbers the response carries, is printed above the
 * justifier's text, and is what the justifier is asked to explain.
 */

export interface JurorRecord {
  provider: string;
  model: string;
  weight: number;
  /** The juror's own scores, in outcome order; absent when it gave none that count. */
  scores?: number[];
  /** Why it has no score, in a few words (jurorFailure). */
  failure?: string;
}

export const RESULT_RECORD_HEADING = 'RESULT (computed by the arbiter from the jurors\' scores)';

const TOTAL = 1000000;

function integer(value: number): string {
  return Math.floor(value).toLocaleString('en-US');
}

/** 432500 -> "43.25%": the share of 1,000,000, with no more decimals than it needs. */
function percent(value: number): string {
  return `${parseFloat(((Math.floor(value) / TOTAL) * 100).toFixed(2))}%`;
}

function outcomeName(outcomes: string[] | undefined, index: number): string {
  return outcomes?.[index] ?? `outcome ${index + 1}`;
}

/**
 * Why a juror has no score, without the provider's own text (which can quote a key or a
 * URL, and is in `model_results[].error_message` for the operator).
 */
export function jurorFailure(result: {
  status: string;
  duration_ms?: number;
  error_type?: string;
  http_status?: number;
}): string {
  if (result.status === 'timeout') {
    return `timed out after ${Math.round((result.duration_ms ?? 0) / 1000)} s`;
  }
  if (result.status === 'parsing_error') {
    return 'its reply could not be read as scores';
  }
  // error_type is one of the route's own categories; "provider_error" reads "provider error".
  const kind = result.error_type && result.error_type !== 'unknown' ? result.error_type.replace(/_/g, ' ').replace(/ error$/, '') : 'provider';
  // A status is a number, or it is not printed: this text never carries what a provider wrote.
  const status = typeof result.http_status === 'number' && Number.isInteger(result.http_status) ? ` (HTTP ${result.http_status})` : '';
  return `${kind} error${status}`;
}

/**
 * @param aggregate - The scores the response reports, in outcome order.
 * @param jurors - Every juror of the panel, in the request's order.
 */
export function resultRecord(outcomes: string[] | undefined, aggregate: number[], jurors: JurorRecord[]): string {
  const answered = jurors.filter(juror => juror.scores !== undefined);
  const lines: string[] = [RESULT_RECORD_HEADING];

  aggregate.forEach((score, index) => {
    lines.push(`- ${outcomeName(outcomes, index)}: ${integer(score)} of ${integer(TOTAL)} (${percent(score)})`);
  });

  const basis =
    answered.length === jurors.length
      ? 'the result is their weighted average'
      : answered.length === 1
        ? 'the result is that one juror\'s scores'
        : 'the result is the weighted average of those that answered';
  lines.push(`JURORS (${answered.length} of ${jurors.length} answered; ${basis})`);

  for (const juror of jurors) {
    const who = `${juror.provider} ${juror.model}, weight ${juror.weight}`;
    if (juror.scores) {
      const scores = juror.scores.map((score, index) => `${outcomeName(outcomes, index)} ${integer(score)}`).join('; ');
      lines.push(`- ${who}: ${scores}`);
    } else {
      lines.push(`- ${who}: no score, not counted (${juror.failure ?? 'failed'})`);
    }
  }

  return lines.join('\n');
}

/** The justification as it is returned: the record, then the text written for it. */
export function withResultRecord(record: string, text: string): string {
  return text ? `${record}\n\n${text}` : record;
}

/** What the justifier is asked: to explain the recorded result, not to derive one. */
export function justifierPrompt(record: string, jurorJustifications: string[]): string {
  return `${record}

The block above is the result of a jury's evaluation. It is final, and its numbers are the only numbers that describe the result.

The jurors' own justifications follow.

${jurorJustifications.join('\n\n')}

Write the justification for this result: why each juror scored as it did, and how the result follows from the jurors' scores and weights. Where the jurors disagree, say what each concluded and why; never present one juror's scores, or a figure of your own, as the result. Do not recompute, rescale or round the result into other numbers. A juror listed with no score took no part in the result: say so, and do not guess what it would have concluded. Do not repeat the block; it is printed above your text.`;
}
