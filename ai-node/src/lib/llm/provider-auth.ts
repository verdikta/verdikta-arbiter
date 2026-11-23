/**
 * A provider that refuses the operator's API key is logged with one fixed line:
 *
 *   PROVIDER_AUTH_FAILED: provider=<name> model=<id> role=juror|justifier http_status=<code|none>
 *
 * A failed juror is left out of the aggregation, so a revoked key turns a
 * two-model jury into one model's verdict while every request still succeeds.
 * The line is what tells the operator. It goes to two places:
 *
 * - the AI Node's log (stderr), as it is written above;
 * - logs/provider-auth.log, with an ISO time in front. The cron watchdog
 *   (installer/util/chainlink-health-watchdog.sh) reads this file and not the
 *   main log: the main log has no times, and it prints prompts and model
 *   replies as they come, so a submitter could write this line into it.
 *
 * Nothing a requester or a provider wrote is in the line: provider and model
 * are reduced to printable characters without spaces, and the provider's message
 * is not in it.
 */
import fs from 'fs';
import path from 'path';

export type ProviderRole = 'juror' | 'justifier';

export const PROVIDER_AUTH_LOG_FILE = 'provider-auth.log';

// What providers say about a key they do not accept, whatever status they send with it
// (xAI answers "Incorrect API key provided" with a 400).
const KEY_REFUSED = new RegExp([
  '\\b(?:incorrect|invalid|revoked|expired|disabled|deactivated)\\s+(?:x-)?api[\\s_-]?key\\b',
  '\\bapi[\\s_-]?key\\s+(?:is\\s+|was\\s+|has\\s+been\\s+)?(?:not\\s+valid|invalid|incorrect|revoked|expired|disabled|deactivated)\\b',
  '\\binvalid_api_key\\b',
  '\\bauthentication_error\\b',
].join('|'), 'i');

/**
 * The HTTP status of a failed provider call: the SDK's `status`, or the one the fetch
 * providers and attachment-errors.ts write into the message ("[xAI] HTTP 401: ...").
 */
export function providerHttpStatus(error: any): number | undefined {
  const status = error?.status ?? error?.response?.status ?? error?.statusCode;
  if (typeof status === 'number') return status;
  const message = typeof error?.message === 'string' ? error.message : '';
  const written = /\bHTTP (\d{3})\b/.exec(message) ?? /^(\d{3}) /.exec(message);
  return written ? Number(written[1]) : undefined;
}

/**
 * Whether a failed provider call is the provider refusing the credential: a 401, or its
 * wording for a key it does not accept. A 403 alone is not: providers send it for a model
 * the key may not use, a region and moderation, each of which a request can cause.
 */
export function isCredentialRefusal(error: any): boolean {
  if (providerHttpStatus(error) === 401) return true;
  return KEY_REFUSED.test(typeof error?.message === 'string' ? error.message : '');
}

/** A value of the line: printable ASCII without spaces, so the line splits on spaces and stays one line. */
function field(value: unknown): string {
  return String(value ?? '').replace(/[^\x21-\x7E]+/g, '_').slice(0, 120) || 'unknown';
}

export function providerAuthFailedLine(provider: string, model: string, role: ProviderRole, httpStatus?: number): string {
  return `PROVIDER_AUTH_FAILED: provider=${field(provider)} model=${field(model)} role=${role} http_status=${httpStatus ?? 'none'}`;
}

/**
 * Log the line if `error` is a provider refusing the credential. Call it once where a
 * provider call fails. Returns whether it was one.
 */
export function reportCredentialRefusal(provider: string, model: string, role: ProviderRole, error: unknown): boolean {
  if (!isCredentialRefusal(error)) return false;
  const line = providerAuthFailedLine(provider, model, role, providerHttpStatus(error));
  console.error(line);
  try {
    const logDir = path.join(process.cwd(), 'logs');
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(path.join(logDir, PROVIDER_AUTH_LOG_FILE), `${new Date().toISOString()} ${line}\n`);
  } catch (writeError) {
    console.error(`Error writing to ${PROVIDER_AUTH_LOG_FILE}:`, writeError);
  }
  return true;
}
