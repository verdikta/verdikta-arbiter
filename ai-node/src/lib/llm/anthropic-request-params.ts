/**
 * Per-model request parameters for the Anthropic provider.
 *
 * The Anthropic API removed the sampling parameters (`temperature`, `top_p`,
 * `top_k`) on Claude Opus 4.7/4.8 and on the whole Claude 5 family (Opus 5,
 * Sonnet 5, Fable/Mythos). Sending one returns HTTP 400
 * "`temperature` is deprecated for this model." — which is what took every
 * Anthropic jury member down when the ClassID map moved to claude-sonnet-5 /
 * claude-opus-5 (bounty 71, 2026-09-18). Claude ≤ 4.6 and Haiku 4.5 still accept
 * `temperature` (but not `temperature` together with `top_p`), and the panel has
 * always run those at 0.7.
 *
 * The rule is derived from the version in the model ID, and an ID the rule
 * cannot parse gets NO sampling parameters: the API default is accepted by every
 * model, so omitting can never cause a 400 while sending can.
 */

/** What the panel has always used on the models that accept it. */
export const LEGACY_TEMPERATURE = 0.7;

/**
 * Output-token ceiling for models the version rule classifies as modern. The
 * pinned @langchain/anthropic only knows Claude ≤ 4.1 in its max_tokens table
 * and gives everything else 2048; Claude 4 gets 8192 there, so modern models
 * get the same. All of them support far more, so this is a ceiling, not a cost.
 */
export const MODERN_MAX_TOKENS = 8192;

export interface ClaudeVersion {
  major: number;
  minor: number;
}

export interface AnthropicChatParams {
  temperature?: number;
  maxTokens?: number;
}

// "claude-opus-4-7", "claude-sonnet-5", "claude-3-5-sonnet-20241022",
// "claude-sonnet-4.6", "claude-2.1", "claude-fable-5-1", "anthropic/claude-sonnet-5" …
// A 1–2 digit minor must not be followed by another digit, so a date suffix
// ("claude-sonnet-4-20250514") is never read as a minor version.
const VERSION_RE = /^claude-(?:(?:opus|sonnet|haiku|fable|mythos|instant)-)?(\d+)(?:[.-](\d{1,2})(?!\d))?/i;

export function parseClaudeVersion(model: string): ClaudeVersion | null {
  const id = (model || '').trim().toLowerCase().split('/').pop() || '';
  const match = VERSION_RE.exec(id);
  if (!match) return null;
  return { major: parseInt(match[1], 10), minor: match[2] ? parseInt(match[2], 10) : 0 };
}

/**
 * true for Claude ≤ 4.6 (temperature accepted); false for Opus 4.7+, every
 * Claude 5+, and anything the version rule cannot read.
 */
export function acceptsSamplingParams(model: string): boolean {
  const version = parseClaudeVersion(model);
  if (!version) return false;
  if (version.major >= 5) return false;
  if (version.major === 4 && version.minor >= 7) return false;
  return true;
}

/** Constructor fields for LangChain's ChatAnthropic, chosen per model. */
export const SAMPLING_FREE_PARAMS: Readonly<AnthropicChatParams> = Object.freeze({ maxTokens: MODERN_MAX_TOKENS });

export function anthropicChatParams(model: string): AnthropicChatParams {
  return acceptsSamplingParams(model)
    ? { temperature: LEGACY_TEMPERATURE }
    : { ...SAMPLING_FREE_PARAMS };
}

/**
 * true when the API rejected the request because of a sampling parameter — the
 * one failure that is safe to retry without them. The status comes from the
 * SDK's typed APIError (`status`); which parameter was rejected only exists in
 * the message text ("`temperature` is deprecated for this model.").
 */
export function isSamplingParamRejection(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const { status, message } = error as { status?: unknown; message?: unknown };
  return status === 400 && typeof message === 'string' && /\b(temperature|top_p|top_k)\b/i.test(message);
}

/**
 * LangChain hands back a string when the reply is a single text block and a
 * list of content blocks otherwise (for example a `thinking` block followed by
 * the text). Only the text blocks are the answer.
 */
export function extractTextContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const textBlocks = content.filter(
      (block): block is { type: 'text'; text: string } =>
        !!block && typeof block === 'object' &&
        (block as { type?: unknown }).type === 'text' &&
        typeof (block as { text?: unknown }).text === 'string'
    );
    if (textBlocks.length > 0) return textBlocks.map(block => block.text).join('');
  }
  throw new Error('Unexpected response format from Anthropic: no text content');
}
