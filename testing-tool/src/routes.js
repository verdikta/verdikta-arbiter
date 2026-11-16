'use strict';

/**
 * The ids a juror's call can carry at the meter (node A19). The AI Node sends a pool model to its own provider's API
 * when it has that key, and through OpenRouter otherwise, under the OpenRouter id `openrouter-routes.json` lists
 * (ai-node's resolveOpenRouterModelId; ai-node's openrouter-routes.test.ts holds the table to it). jury-run.sh unsets
 * OPENAI_API_KEY and XAI_API_KEY, so on the Q63 panels gpt-6-luna reaches the meter as openai/gpt-6-luna, and Opus does
 * when the key file has no Anthropic key.
 */

const TABLE = require('./openrouter-routes.json');

/** OpenRouter id → { provider, model } of the pool model it stands for. */
const BY_ROUTE = new Map();
for (const [provider, models] of Object.entries(TABLE)) {
  if (!models || typeof models !== 'object') continue;
  for (const [model, id] of Object.entries(models)) BY_ROUTE.set(id, { provider, model });
}

/**
 * Every id a call to this juror can carry: its panel id, and its OpenRouter id when it has one.
 * @param {string} provider - the panel's AI_PROVIDER
 * @param {string} model - the panel's AI_MODEL
 * @returns {string[]}
 */
function routeIds(provider, model) {
  // A panel names its provider as common's validateClassEnvelope accepts it: trimmed and in any case ("OpenAI").
  const key = typeof provider === 'string' ? provider.trim().toLowerCase() : provider;
  const models = key !== 'comment' && Object.hasOwn(TABLE, key) && TABLE[key] && typeof TABLE[key] === 'object' ? TABLE[key] : {};
  return Object.hasOwn(models, model) ? [model, models[model]] : [model];
}

/**
 * The pool model an OpenRouter id stands for, or null when it is no route id the table names.
 * @param {string} id
 * @returns {{provider:string, model:string}|null}
 */
function modelOfRoute(id) {
  return BY_ROUTE.get(id) || null;
}

module.exports = { routeIds, modelOfRoute, TABLE };
