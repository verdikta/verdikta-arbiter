/**
 * A failed model call in words of our own, for the text of a justification.
 *
 * The justification is what the justifier model reads and what the record's reader
 * reads first, so a failed juror is described from the fields this node derives
 * (status, error_type, http_status, duration) and never with the provider's message.
 * That message, redacted, is in model_results[].error_message; whole, in the log.
 */

const ERROR_TYPE_WORDS: Record<string, string> = {
  authentication: 'authentication error',
  authorization: 'authorization error',
  rate_limit: 'rate limit',
  model_not_found: 'model not found',
  content_policy: 'content policy',
  token_limit: 'token limit',
  invalid_image: 'image rejected',
  provider_error: 'provider error',
  timeout: 'timeout',
  network: 'network error',
  parsing_error: 'unreadable reply',
};

export interface FailureFacts {
  /** A timeout of ours (the model did not answer in time), whatever the error was typed as. */
  timedOut?: boolean;
  /** error_type as the route derives it; anything not listed above reads "unclassified error". */
  errorType?: string;
  httpStatus?: number;
  durationMs?: number;
}

/** "authentication error (HTTP 401)", "timed out after 120 s", "unclassified error". */
export function describeFailure(facts: FailureFacts): string {
  if (facts.timedOut) {
    return typeof facts.durationMs === 'number' && Number.isFinite(facts.durationMs)
      ? `timed out after ${Math.round(facts.durationMs / 1000)} s`
      : 'timed out';
  }
  const known = typeof facts.errorType === 'string' && Object.prototype.hasOwnProperty.call(ERROR_TYPE_WORDS, facts.errorType);
  const words = known ? ERROR_TYPE_WORDS[facts.errorType as string] : 'unclassified error';
  const status = typeof facts.httpStatus === 'number' && Number.isInteger(facts.httpStatus) ? ` (HTTP ${facts.httpStatus})` : '';
  return `${words}${status}`;
}
