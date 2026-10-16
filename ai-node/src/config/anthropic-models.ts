/**
 * Mapping from dotted Anthropic model names to real Anthropic API model IDs.
 *
 * Evaluation packages in the wild reference Anthropic models with dotted
 * version notation (e.g. "claude-sonnet-4.5" — the OpenRouter naming style),
 * but the Anthropic API only accepts dash-form IDs ("claude-sonnet-4-5").
 * Passing a dotted name straight to the API returns a 404 for every request.
 *
 * Every target ID below was cross-checked against Anthropic's current model
 * list (2026-08). Dotted names whose underlying models Anthropic has retired
 * (claude-3.5-sonnet, claude-3.5-haiku, claude-3.7-sonnet) are deliberately
 * absent: no live API ID exists for them, so they must not be listed in
 * modelConfig.anthropic either.
 */
const ANTHROPIC_MODEL_MAP: Record<string, string> = {
  'claude-sonnet-4.5': 'claude-sonnet-4-5',
  'claude-haiku-4.5': 'claude-haiku-4-5',
  'claude-sonnet-4.6': 'claude-sonnet-4-6',
  'claude-opus-4.6': 'claude-opus-4-6',
};

/**
 * Resolves a model name to the ID the Anthropic API accepts.
 *
 * Resolution order:
 *   1. Exact match in ANTHROPIC_MODEL_MAP
 *   2. Generic "claude-<family>-<major>.<minor>" -> dash-form conversion,
 *      so future dotted entries (e.g. "claude-opus-4.7") keep working
 *   3. Pass through unchanged (dash-form IDs, and names like "claude-2.1"
 *      whose dot is part of the literal API ID)
 */
export function resolveAnthropicModelId(model: string): string {
  if (ANTHROPIC_MODEL_MAP[model]) {
    return ANTHROPIC_MODEL_MAP[model];
  }

  const familyDotted = model.match(/^(claude-[a-z]+-\d+)\.(\d+)$/);
  if (familyDotted) {
    return `${familyDotted[1]}-${familyDotted[2]}`;
  }

  return model;
}
