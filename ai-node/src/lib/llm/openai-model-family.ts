/**
 * OpenAI model families, read from the model id: bare (`gpt-6-luna`), OpenRouter's
 * (`openai/gpt-6-luna`) or a fine-tune's (`ft:gpt-5:org:…`).
 *
 * GPT-5 and every later GPT (`gpt-6-luna`, `gpt-6-sol`, `gpt-6-astra`, …) are reasoning
 * models: on Chat Completions they take `max_completion_tokens` and `reasoning_effort`, and
 * they reject `max_tokens`. The providers' checks were written for "gpt-5" ids, so a GPT-6
 * id went to LangChain with 1,000 output tokens in text mode, got no reasoning effort as a
 * justifier, and OpenRouter gave it a non-reasoning model's output ceiling (node A14).
 */

// "gpt-6-luna", "gpt-5.1-codex", "openai/gpt-6-sol", "ft:gpt-5:org": the major after "gpt-".
// The digits must end there, so "gpt-4o" or "gpt-oss-120b" never reads as a version.
const GPT_MAJOR_RE = /(?:^|[/:])gpt-(\d+)(?=$|[.:-])/;

/** The GPT major version in a model id, or null when the id names none. */
export function gptMajorVersion(model: string): number | null {
  const match = GPT_MAJOR_RE.exec((model || '').trim().toLowerCase());
  return match ? parseInt(match[1], 10) : null;
}

/** true for GPT-5 and every later GPT: the reasoning family that takes max_completion_tokens and reasoning_effort. */
export function isGpt5FamilyModel(model: string): boolean {
  // Anything the old check took ("gpt-5" anywhere in the id) still counts.
  if ((model || '').toLowerCase().includes('gpt-5')) return true;
  const major = gptMajorVersion(model);
  return major !== null && major >= 5;
}
