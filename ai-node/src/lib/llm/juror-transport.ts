/**
 * The HTTP transport of a code-mode juror's call (design §11; build plan A11).
 *
 * Node's fetch (undici) ends a request whose response headers have not arrived within
 * 300 s (`headersTimeout`), or whose body stays silent for 300 s (`bodyTimeout`). A
 * non-streaming reasoning reply sends no headers until it is complete, so a juror slower
 * than 300 s was cut there, and code mode, which needs every juror, abstained. Every
 * client a code pool can name runs on that fetch: OpenRouter and xAI call it directly,
 * and the openai and @anthropic-ai/sdk clients use it underneath (their retries then sent
 * the same request again, which a provider may bill again).
 *
 * A juror's call, the one that carries `deadlineAt`, therefore gets a dispatcher of its
 * own, whose two limits are the time left to that deadline plus JUROR_TRANSPORT_GRACE_MS:
 * above the juror's window, so they never fire first. The juror's AbortSignal, aborted at
 * the deadline, is still what ends the call; the grace only bounds how long the transport
 * would wait if a signal were ever lost. The dispatcher belongs to that one call and is
 * destroyed when the call settles, so no connection it opened outlives it. Text mode and
 * the justifier pass no `deadlineAt` and keep Node's default dispatcher, as before.
 *
 * The Agent is undici's, pinned to the major Node 20 bundles (6), and goes to Node's own
 * fetch as its `dispatcher` option, which Next.js's fetch wrapper passes on.
 */
import { Agent } from 'undici';

/** How far past the juror's deadline the transport's own limits sit. */
export const JUROR_TRANSPORT_GRACE_MS = 15000;

/** headersTimeout and bodyTimeout for a call whose deadline is `deadlineAt`: the time left, plus the grace. */
export function jurorTransportTimeoutMs(deadlineAt: number, now: number = Date.now()): number {
  return Math.max(0, deadlineAt - now) + JUROR_TRANSPORT_GRACE_MS;
}

/** undici's Agent with both limits at `limitMs`, which it keeps readable. */
export class JurorAgent extends Agent {
  constructor(readonly limitMs: number) {
    super({ headersTimeout: limitMs, bodyTimeout: limitMs });
  }
}

export interface JurorTransport {
  /** For fetch's `dispatcher` option (directly, or through an SDK's `fetchOptions`). */
  dispatcher: JurorAgent;
  /** The dispatcher's headersTimeout and bodyTimeout. */
  timeoutMs: number;
  /** Destroys the dispatcher: its connections close, and a request still on one is aborted. */
  close(): void;
}

/** A dispatcher for one juror call that must end by `deadlineAt`. */
export function createJurorTransport(deadlineAt: number, now: number = Date.now()): JurorTransport {
  const dispatcher = new JurorAgent(jurorTransportTimeoutMs(deadlineAt, now));
  return {
    dispatcher,
    timeoutMs: dispatcher.limitMs,
    close: () => {
      dispatcher.destroy().catch(() => {});
    },
  };
}

/**
 * The transport for a call with these controls: one of its own for a juror's call (a
 * deadline), none for anything else. The caller closes it when the call settles.
 */
export function jurorTransportFor(controls?: { deadlineAt?: number } | null): JurorTransport | null {
  return controls?.deadlineAt === undefined ? null : createJurorTransport(controls.deadlineAt);
}

/** `init` with the transport's dispatcher, for Node's fetch; `init` itself when there is none. */
export function withDispatcher(init: RequestInit, transport: JurorTransport | null): RequestInit {
  return transport ? ({ ...init, dispatcher: transport.dispatcher } as RequestInit) : init;
}
