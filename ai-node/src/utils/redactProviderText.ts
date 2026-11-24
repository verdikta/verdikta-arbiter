/**
 * Provider text is redacted before it enters a response.
 *
 * The External Adapter uploads a response's `justification`, `model_results` and
 * `warnings` to IPFS as the public justification record, and in mode 0 the
 * `error` of an HTTP 400 as well. A failed model's error message used to be copied
 * into all of them: one of bounty 398's records quotes OpenAI's 401 with the
 * operator's key in it. OpenAI had masked most of that key; nothing made another
 * provider do the same for a key, for a response body it echoes, for a URL with a
 * key in its query, or for a request id.
 *
 * Two layers:
 *
 * 1. `redactLogText` is the doctor's `redact_log` (installer/util/arbiter-doctor.sh):
 *    its seven expressions, in its order, with its output. redactProviderText.test.ts
 *    runs the shell function and this one on the same lines. Change the two together.
 * 2. `redactProviderText` adds what a log does not need and a public record does:
 *    a key with no `key=` or `Bearer` in front of it (`sk-...`, `xai-...`, one a
 *    provider masked with asterisks, any long opaque token, which also takes
 *    request and organization ids), and a length limit.
 *
 * A provider can echo megabytes (a request with its base64 images), and this runs in
 * the route: every step is linear in the length of the text. Two of the doctor's
 * expressions are not when a backtracking engine runs them on a long unbroken token,
 * so they are written out below instead of ported.
 *
 * The unredacted message stays in the AI Node's own log. Call this where text
 * enters the response, once per value; a second pass over its output is harmless.
 */

/** A provider message in a response is at most this long, its truncation mark included. */
export const PROVIDER_TEXT_MAX_CHARS = 500;

/** No more than this much of a message is read; the rest could only be cut off again. */
const MAX_INPUT_CHARS = 20000;

const TRUNCATION_MARK = ' … [truncated]';

// POSIX [[:space:]] in the C locale, which is what redact_log runs in (LC_ALL=C), less the
// newline: sed reads a line at a time, so no expression of the doctor's ever crosses one.
const BLANK = ' \\t\\v\\f\\r';
// Where a URL ends: white space, a quote, a backslash (JSON's \"), an angle bracket or a |.
const URL_END = `${BLANK}\\n"'\\\\<>|`;
const HOST = `[^/?#${URL_END}@]+`;
const USERINFO = `[^/?#${URL_END}]*`;
const TAIL = `[^${URL_END}]*`;
const WEB_SCHEME = '(https?|wss?)';
const SECRET_VALUE = '[A-Za-z0-9._~+/-]{16,}=*';

// Expressions 1 and 2: an http(s) or ws(s) URL keeps its scheme and host[:port], with or
// without userinfo.
const WEB_URL = new RegExp(`${WEB_SCHEME}://(${HOST})[/?#]${TAIL}`, 'gi');
const WEB_URL_USERINFO = new RegExp(`${WEB_SCHEME}://${USERINFO}@(${HOST})(?:[/?#]${TAIL})?`, 'gi');
// Expression 3: any other scheme's userinfo (postgresql://user:pass@host). The doctor's
// begins with the scheme, ([A-Za-z][A-Za-z0-9+.-]*)://; here the match begins at "://" and
// the scheme is looked for behind it, so a long token is not rescanned from each letter.
const USERINFO_AFTER_SCHEME = new RegExp(`://${USERINFO}@`, 'g');
// Expressions 4 to 6: key=... and token=... (apikey=, api_key=, access_token=, ...),
// "...key": "..." and ...token: '...', Bearer ....
const KEY_EQUALS = new RegExp(`((?:key|token)=["']?)${SECRET_VALUE}`, 'gi');
const KEY_COLON = new RegExp(`((?:key|token)["']?[${BLANK}]*:[${BLANK}]*["'])${SECRET_VALUE}`, 'gi');
const BEARER = new RegExp(`(Bearer[${BLANK}]+)${SECRET_VALUE}`, 'gi');
// Expression 7, eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}, is looked for in
// each run of the characters a JWT is written in.
const JWT_RUN = /[A-Za-z0-9_.-]+/g;

function isSchemeChar(code: number): boolean {
  return isLetter(code) || (code >= 48 && code <= 57) || code === 43 || code === 45 || code === 46; // 0-9 + - .
}

function isLetter(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function redactUserinfoAfterScheme(text: string): string {
  return text.replace(USERINFO_AFTER_SCHEME, (match: string, offset: number) => {
    // A scheme is a letter and what follows it up to "://".
    for (let i = offset - 1; i >= 0 && isSchemeChar(text.charCodeAt(i)); i--) {
      if (isLetter(text.charCodeAt(i))) return '://<redacted>@';
    }
    return match;
  });
}

function redactJwts(text: string): string {
  return text.replace(JWT_RUN, (run: string) => {
    if (!run.includes('eyJ')) return run;
    const parts = run.split('.');
    let out = '';
    for (let i = 0; i < parts.length;) {
      // "eyJ" and eight more in this part, then two whole parts of eight or more.
      const at = i + 2 < parts.length && parts[i + 1].length >= 8 && parts[i + 2].length >= 8 ? parts[i].indexOf('eyJ') : -1;
      if (at >= 0 && parts[i].length - at >= 11) {
        out += `${parts[i].slice(0, at)}<redacted-jwt>`;
        i += 3;
      } else {
        out += parts[i];
        i += 1;
      }
      if (i < parts.length) out += '.';
    }
    return out;
  });
}

/**
 * The doctor's redact_log on a string, line by line as sed reads it: URLs keep scheme and
 * host, key/token/Bearer values and JWTs go.
 */
export function redactLogText(text: string): string {
  let out = text
    .replace(WEB_URL, '$1://$2/<redacted>')
    .replace(WEB_URL_USERINFO, '$1://$2/<redacted>');
  out = redactUserinfoAfterScheme(out)
    .replace(KEY_EQUALS, '$1<redacted>')
    .replace(KEY_COLON, '$1<redacted>')
    .replace(BEARER, '$1<redacted>');
  return redactJwts(out);
}

// A token is a run of the characters a key, an id or a masked key is written in.
const TOKEN = /[A-Za-z0-9_*.-]+/g;
// Nothing a reader needs is one token this long.
const LONGEST_READABLE_TOKEN = 200;
// A key a provider masked is still part of the key: "sk-ut1et***...***Zd9U", "xa***Xy".
// Markdown's **bold** has no letter before three asterisks, nor four before a letter.
const MASKED = /[A-Za-z0-9_-]\*{3,}|\*{4,}[A-Za-z0-9]/;
// OpenAI, Anthropic (sk-ant-) and OpenRouter (sk-or-) keys, whole or cut short ("sk-...Zd9U").
const SK_KEY = /(?:^|[^A-Za-z0-9])sk-[A-Za-z0-9_*.-]*[A-Za-z0-9]/;
// An xAI key. Not "xAI-grok-4", which is how the route writes a provider and its model.
const XAI_KEY = /(?:^|[^A-Za-z0-9])xai-(?:[A-Za-z0-9_]{16,}|[.*]+[A-Za-z0-9])/;
// A long token with a long run of letters and digits mixed has no meaning to a reader:
// a key of a shape not listed here, a request id (req_...), an organization id, a hash.
// Nor has a very long run of either. A model id is made of short words and numbers
// ("gpt-4o-mini-search-preview-2025-03-11"), an error code of short words.
const OPAQUE_MIN_TOKEN = 24;
const OPAQUE_MIN_MIXED_RUN = 12;
const OPAQUE_MIN_RUN = 40;

function isSecretShaped(token: string): boolean {
  if (token.length > LONGEST_READABLE_TOKEN) return true;
  if (MASKED.test(token) || SK_KEY.test(token) || XAI_KEY.test(token)) return true;
  return token.length >= OPAQUE_MIN_TOKEN && token.split(/[-._*]/).some(run =>
    run.length >= OPAQUE_MIN_RUN || (run.length >= OPAQUE_MIN_MIXED_RUN && /[0-9]/.test(run) && /[A-Za-z]/.test(run)));
}

function redactToken(token: string): string {
  // A sentence's full stop is not part of the token before it.
  let end = token.length;
  while (end > 0 && token.charCodeAt(end - 1) === 46) end--;
  return end > 0 && isSecretShaped(token.slice(0, end)) ? `<redacted>${token.slice(end)}` : token;
}

function isWordEnd(char: string): boolean {
  return char === '' || char === ' ' || char === '\n' || char === '\t' || char === '\r' || char === '"' || char === '\'';
}

/** At most `maxChars` with the mark: cut at a space when one is near, never inside a <redacted> mark. */
function truncate(text: string, maxChars: number): string {
  const budget = Math.max(0, maxChars - TRUNCATION_MARK.length);
  let kept = text;
  if (text.length > budget) {
    kept = text.slice(0, budget);
    const space = Math.max(kept.lastIndexOf(' '), kept.lastIndexOf('\n'), kept.lastIndexOf('\t'));
    if (space >= budget - 80) {
      kept = kept.slice(0, space);
    } else {
      const open = kept.lastIndexOf('<');
      if (open >= budget - 16 && !kept.includes('>', open)) kept = kept.slice(0, open);
      // Not half of a surrogate pair.
      const last = kept.charCodeAt(kept.length - 1);
      if (last >= 0xd800 && last <= 0xdbff) kept = kept.slice(0, -1);
    }
  }
  return kept.trimEnd() + TRUNCATION_MARK;
}

/**
 * Text that came from a model provider (an error message, a response body), fit for a
 * response: no key, no URL beyond scheme and host, no long opaque id, at most `maxChars`.
 */
export function redactProviderText(text: unknown, maxChars: number = PROVIDER_TEXT_MAX_CHARS): string {
  let input = typeof text === 'string' ? text : text === undefined || text === null ? '' : String(text);
  let cut = false;
  if (input.length > MAX_INPUT_CHARS) {
    // The word the cut falls in is dropped whole: half a key is still part of a key.
    let end = MAX_INPUT_CHARS;
    if (!isWordEnd(input.charAt(end))) while (end > 0 && !isWordEnd(input.charAt(end - 1))) end--;
    input = input.slice(0, end);
    cut = true;
  }
  const redacted = redactLogText(input)
    .replace(TOKEN, redactToken)
    // A second pass over "https://host/<redacted>" would add a second mark.
    .replace(/(?:<redacted>){2,}/g, '<redacted>');
  return cut || redacted.length > maxChars ? truncate(redacted, maxChars) : redacted;
}
