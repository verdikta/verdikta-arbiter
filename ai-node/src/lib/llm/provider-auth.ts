/**
 * Which providers refuse this node's API key, as the cron watchdog reads it.
 *
 * The route logs one fixed line when a provider refuses the operator's key
 * (rank-and-justify/route.ts, logProviderAuthFailure), and the doctor's
 * ai.provider_auth reads it from the AI Node's log: a provider that refused the key
 * and has not answered since. The watchdog pages on the same condition
 * (installer/util/chainlink-health-watchdog.sh) and cannot take it from that log:
 * the log has no times, and it prints prompts and model replies as they come, so
 * anyone who submits evidence could write a refusal, or an answer, into it. So the
 * two events also go to logs/provider-auth.log, which holds nothing else:
 *
 *   <ISO time> PROVIDER_AUTH_FAILED: provider=<name> model=<id> role=juror|justifier http_status=<code|unknown>
 *   <ISO time> PROVIDER_AUTH_OK: provider=<name>
 *
 * OK is written once, when a provider answers after it refused (the key was
 * replaced, or the refusal was not about the key). The file is this process's
 * record: ai-node/start.sh removes it, as a restart gives the doctor a new log.
 * Nothing a requester or a provider wrote is in a line: provider and model are
 * reduced to printable characters without spaces, and no message is in it.
 *
 * This module also says what a refusal is where the route's error typing cannot:
 * see isCredentialRefusal.
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
 * A refusal of the credential that the route's error typing does not see. That typing
 * (extractProviderErrorDetails) reads the error's `status` property, and the providers
 * reached through fetch (xAI, Hyperbolic, OpenRouter, which is every class's fallback)
 * have none: their status is in the message, "[OpenRouter] HTTP 401: ...User not found",
 * which the typing files under model_not_found. So: a 401 wherever it is written, or the
 * provider's wording for a key it does not accept.
 */
export function isCredentialRefusal(error: any): boolean {
  if (providerHttpStatus(error) === 401) return true;
  return KEY_REFUSED.test(typeof error?.message === 'string' ? error.message : '');
}

/** A value of a line: printable ASCII without spaces, so the line splits on spaces and stays one line. */
function field(value: unknown): string {
  return String(value ?? '').replace(/[^\x21-\x7E]+/g, '_').slice(0, 120) || 'unknown';
}

// Providers that refused the key in this process and have not answered since, lower case.
const refusing = new Set<string>();

function append(line: string): void {
  try {
    const logDir = path.join(process.cwd(), 'logs');
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(path.join(logDir, PROVIDER_AUTH_LOG_FILE), `${new Date().toISOString()} ${line}\n`);
  } catch (writeError) {
    console.error(`Error writing to ${PROVIDER_AUTH_LOG_FILE}:`, writeError);
  }
}

/** A provider refused the key: one line for the watchdog. Call it where PROVIDER_AUTH_FAILED is logged. */
export function recordProviderRefusal(provider: string, model: string, role: ProviderRole, httpStatus?: number): void {
  const name = field(provider);
  refusing.add(name.toLowerCase());
  const status = typeof httpStatus === 'number' && Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 999 ? httpStatus : 'unknown';
  append(`PROVIDER_AUTH_FAILED: provider=${name} model=${field(model)} role=${role} http_status=${status}`);
}

/**
 * A provider answered. Call it where the doctor's ai.provider_auth finds its answer
 * (MODEL_SUCCESS, JUSTIFIER_API_RESPONSE). Writes a line only after a refusal.
 */
export function recordProviderAnswer(provider: string): void {
  const name = field(provider);
  if (refusing.delete(name.toLowerCase())) append(`PROVIDER_AUTH_OK: provider=${name}`);
}
