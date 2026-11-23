/**
 * Which jurors read a PDF as a PDF.
 *
 * A PDF sent as a document block reaches the model as the text of each page
 * plus an image of the page, so the juror sees its pictures, charts and scans.
 * The text the arbiter extracts itself (pdf-parse) holds none of that: on
 * bounty 398 a hunter put 16 recording frames in a 19-page PDF, and neither
 * juror (gpt-5.6-terra, claude-sonnet-5) could look at one.
 *
 * This is the one place that answers "does this provider and model take a PDF
 * block on this node". It replaces four hardcoded lists (two in the
 * rank-and-justify route, one in the attachment processor, one in the Anthropic
 * provider) that stopped at GPT-4.1 and Claude 4.x, disagreed with each other,
 * and matched the provider name case-sensitively, so every current jury fell
 * through to text extraction.
 *
 * The answer is read from the model's version, as the sampling-parameter rule
 * is (anthropic-request-params.ts): a new model in a known family needs no
 * edit here. A model id the rule cannot read gets text: text plus a note can
 * never be rejected by a provider, a document block can.
 *
 * It also follows the gateway (provider-config.ts). A class routed to
 * OpenRouter is served by OpenRouterProvider, whose chat-completions request
 * has no PDF block here, so that juror gets the text whatever the model could
 * do on its own API.
 */

import { parseClaudeVersion } from './anthropic-request-params';
import { mockProviderState } from './mock-provider';
import { isGpt5FamilyModel } from './openai-model-family';
import { resolveProviderConfig } from './provider-config';
import type { ProviderClass } from '../../config/openrouter-models';

/** The API a PDF block is sent to; its request limits apply (attachments/pdfRouting.ts). */
export type PdfProviderFamily = 'anthropic' | 'openai';

export interface NativePdfSupport {
  /** true: send the PDF itself. false: send its extracted text and say so. */
  native: boolean;
  /** Whose request the PDF block goes into; null when it is not sent as a block. */
  family: PdfProviderFamily | null;
  /** One clause for log lines and telemetry. */
  reason: string;
}

/** The id without an OpenRouter prefix ("openai/gpt-6-luna") or a fine-tune wrapper ("ft:gpt-4o-2024-08-06:org::id"). */
function bareModelId(model: string): string {
  let id = (model || '').trim().toLowerCase();
  if (id.startsWith('ft:')) id = id.slice(3).split(':')[0];
  return id.split('/').pop() || '';
}

/**
 * Claude 3.5 and later take `document` blocks with a base64 PDF, with no beta
 * header. "All active models support PDF processing"
 * (https://platform.claude.com/docs/en/build-with-claude/pdf-support#supported-platforms-and-models,
 * read 2026-11-23); Claude 3.5 Sonnet was the first that did.
 */
export function claudeModelReadsPdf(model: string): boolean {
  const version = parseClaudeVersion(model);
  if (!version) return false;
  return version.major > 3 || (version.major === 3 && version.minor >= 5);
}

/**
 * OpenAI models that take a PDF `file` part: the ones with image input, because
 * the API gives the model each page's text and an image of the page. That is
 * GPT-5 and every later GPT, the GPT-4o / 4.1 / 4.5 generations, and the
 * o-series from o1 on except o1-mini, o1-preview and o3-mini, which read no
 * images.
 */
export function openAIModelReadsPdf(model: string): boolean {
  if (isGpt5FamilyModel(model)) return true;
  const id = bareModelId(model);
  if (/^gpt-4(?:o|\.1|\.5)(?=$|[-.:])/.test(id)) return true;
  const oSeries = /^o(\d+)(?:-([a-z]+))?(?=$|[-.:])/.exec(id);
  if (oSeries) {
    if (parseInt(oSeries[1], 10) >= 4) return true;
    return oSeries[2] !== 'mini' && oSeries[2] !== 'preview';
  }
  return false;
}

/** The family whose own API reads PDFs for this class and model, or null. Says nothing about this node's route. */
export function pdfFamilyOf(providerClass: ProviderClass, model: string): PdfProviderFamily | null {
  if (providerClass === 'anthropic') return claudeModelReadsPdf(model) ? 'anthropic' : null;
  if (providerClass === 'openai') return openAIModelReadsPdf(model) ? 'openai' : null;
  // xAI, Hyperbolic, Ollama and OpenRouter requests carry no PDF block in this codebase.
  return null;
}

const textOnly = (reason: string): NativePdfSupport => ({ native: false, family: null, reason });

/**
 * Whether a juror is sent a PDF natively on this node.
 *
 * @param provider - The name a request or manifest uses ("OpenAI", "openai", "Anthropic", ...), any case.
 * @param model - The model id as the request names it.
 */
export function nativePdfSupport(provider: string, model: string): NativePdfSupport {
  // LLMFactory hands every provider name to the mock while it is on; the mock reads the prompt only.
  if (mockProviderState() === 'on') return textOnly('the test-only mock provider reads the prompt only');

  let resolution: ReturnType<typeof resolveProviderConfig>;
  try {
    resolution = resolveProviderConfig(provider);
  } catch {
    return textOnly(`unknown provider ${provider}`);
  }
  const { providerClass, backend } = resolution;
  if (backend === 'openrouter') {
    return textOnly(
      providerClass === 'openrouter'
        ? 'OpenRouter requests carry no PDF block'
        : `${providerClass} is routed through OpenRouter here, whose request carries no PDF block`,
    );
  }
  const family = pdfFamilyOf(providerClass, model);
  if (!family) {
    return textOnly(
      providerClass === 'anthropic' || providerClass === 'openai'
        ? `${model} is not a model known to read PDFs`
        : `${providerClass} requests carry no PDF block`,
    );
  }
  return { native: true, family, reason: `${family} reads PDFs natively` };
}
