import { requireServiceAuth } from '../../../lib/service-auth';
import { NextResponse } from 'next/server';
import { LLMFactory } from '../../../lib/llm/llm-factory';
import { prePromptConfig } from '../../../config/prePromptConfig';
import { postPromptConfig } from '../../../config/postPromptConfig';
import { parseModelResponse } from '../../../utils/parseModelResponse';
import { repairModelScores, replyJustification } from '../../../utils/repairModelResponse';
import { PreparedAttachments, logAttachmentSummary, prepareAttachments } from '../../../utils/attachment-processor';
import {
  normalizeImageAttachments,
  appendAttachmentNotes,
  attachmentRefs,
  UnprocessableImageError,
} from '../../../lib/attachments/normalizeImages';
import {
  JurorAttachments,
  JurorPdfInput,
  attachmentsForJuror,
  describePdfInputs,
  imagesOnly,
  withoutAttachments,
} from '../../../lib/attachments/pdfRouting';
import { NativePdfSupport, nativePdfSupport } from '../../../lib/llm/pdf-support';
import { WebRetrieval, describeWebRetrieval, mergeWebRetrievals } from '../../../lib/llm/web-retrieval';
import { handleCodeReviewRequest, isCodeReviewBody } from '../../../lib/code-review/handler';
import { JurorRecord, jurorFailure, justifierPrompt, resultRecord, withResultRecord } from '../../../utils/resultRecord';
import fs from 'fs';
import path from 'path';

// Load the justifier model name from environment variables
const JUSTIFIER_MODEL = process.env.JUSTIFIER_MODEL || 'default-justifier-model';
const [justifierProviderName, justifierModelName] = process.env.JUSTIFIER_MODEL?.split(':') || ['JustifierProvider', 'default-model'];

// Timeout configuration (optimized for 300s total budget)
const MODEL_TIMEOUT_MS = parseInt(process.env.MODEL_TIMEOUT_MS || '120000'); // 120 seconds default
const REQUEST_TIMEOUT_MS = parseInt(process.env.REQUEST_TIMEOUT_MS || '240000'); // 240 seconds default

interface ModelInput {
  provider: string;
  model: string;
  weight: number;
  count?: number;
}

interface RankAndJustifyInput {
  prompt: string;
  outcomes?: string[];  // Optional array of outcome descriptions
  models: ModelInput[];
  iterations?: number;
  attachments?: string[];
  attachmentNames?: string[];  // Optional original file names, index-aligned with attachments
  requestTag?: string;         // Optional caller id (job run / aggregation) for log lines
}

interface ScoreOutcome {
  outcome: string;
  score: number;
}

interface RankAndJustifyOutput {
  scores: ScoreOutcome[];
  justification: string;
  // Enhanced error reporting fields (backward compatible - optional)
  metadata?: EvaluationMetadata;
  model_results?: ModelResult[];
  warnings?: Warning[];
  error?: string;  // Only present on catastrophic failure
}

interface LLMProvider {
  generateResponse: (prompt: string, model: string, options?: any) => Promise<string>;
  generateResponseWithAttachments?: (prompt: string, model: string, attachments: any[], options?: any) => Promise<string>;
  supportsAttachments: (model: string) => boolean;
  /** Only on a provider whose request has no place for a text attachment (Ollama); absent means it has one. */
  sendsTextAttachments?: (model: string) => boolean;
}

// Enhanced error reporting structures
interface EvaluationMetadata {
  models_requested: number;
  models_successful: number;
  models_failed: number;
  success_threshold_met: boolean;
  total_duration_ms?: number;
}

interface ModelResult {
  provider: string;
  model: string;
  status: 'success' | 'failed' | 'timeout' | 'parsing_error';
  duration_ms: number;
  /** The juror's weight in the panel, as requested. */
  weight?: number;
  /** The juror's own scores, in outcome order (success only): what the aggregate was averaged from. */
  scores?: number[];
  error_type?: string;
  error_message?: string;
  error_code?: string;
  http_status?: number;
  /** What the juror's web tools did (success and parsing_error only); see web-retrieval.ts. */
  web_retrieval?: WebRetrieval;
  /** How this juror was given each PDF of the request (only when it has one); see pdfRouting.ts. */
  pdf_inputs?: JurorPdfInput[];
}

/** One juror's share of a request's attachments. */
interface JurorState {
  support: NativePdfSupport;
  /**
   * What the juror is sent. It starts as the best form of each attachment the
   * juror can read and is replaced, for the rest of the request, when the
   * provider turns down a PDF or the model turns out to take no attachments.
   */
  view: JurorAttachments;
  /** The provider's answer to the request that carried PDFs as files, when it refused it. */
  pdfRejection?: string;
  /** The provider sends this model no attachments: it was shown none, and its prompt says so. */
  sentNoAttachments?: boolean;
  /** The provider's request carries images only: no document's text either, and its prompt says so. */
  sentImagesOnly?: boolean;
}

/**
 * Statuses with which a provider refuses a request for what is in it. After one
 * of these on a request that carried a PDF as a file, the juror is asked once
 * more with the PDF's text: a file one provider will not take (encrypted, a
 * page count the parser here could not read, a limit lower than documented)
 * must not cost the juror, since the text form is always accepted.
 */
const REQUEST_REJECTION_STATUSES = new Set([400, 413, 422]);

function rejectsRequest(error: any): boolean {
  const status = error?.status ?? error?.response?.status ?? error?.statusCode;
  return typeof status === 'number' && REQUEST_REJECTION_STATUSES.has(status);
}

interface Warning {
  type: string;
  message: string;
  severity: 'info' | 'warning' | 'error';
  model?: string;
  details?: any;
}

function logInteraction(message: string) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${message}\n`;
  
  // Log to console
  console.log(logMessage);

  // Log to file
  const logDir = path.join(process.cwd(), 'logs');
  const logFile = path.join(logDir, 'llm-interactions.log');

  try {
    // Create logs directory if it doesn't exist
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    
    fs.appendFileSync(logFile, logMessage);
  } catch (error) {
    console.error('Error writing to log file:', error);
  }
}

function stripThinkingBlocks(response: string): string {
  // Remove <think>...</think> blocks (case insensitive, multiline)
  const thinkRegex = /<think>[\s\S]*?<\/think>/gi;
  const cleaned = response.replace(thinkRegex, '').trim();
  
  // Log if thinking blocks were found and removed
  if (cleaned !== response.trim()) {
    console.log('Stripped <think> blocks from model response');
  }
  
  return cleaned;
}


export async function POST(request: Request) {
  const denied = requireServiceAuth(request);
  if (denied) return denied;
  const requestStartTime = Date.now();
  // The body is read once. A request with a codeReview field is a claim evaluation
  // (code mode, lib/code-review/handler.ts: its own deadline, envelope and prompt);
  // every other request takes the text-mode path below, unchanged. Reading the body
  // stays inside the text-mode REQUEST_TIMEOUT_MS budget, as it always was.
  let parsedBody: unknown;
  let parseFailed = false;
  let parseError: unknown;
  let parseTimer: NodeJS.Timeout | null = null;
  try {
    const read = await Promise.race([
      request.json().then(value => ({ value })),
      new Promise<'timeout'>(resolve => { parseTimer = setTimeout(() => resolve('timeout'), REQUEST_TIMEOUT_MS); }),
    ]);
    if (read === 'timeout') {
      const totalRequestTime = Date.now() - requestStartTime;
      console.error(`🚨 REQUEST_TIMEOUT_FINAL: Request timed out after ${totalRequestTime}ms`);
      return NextResponse.json({
        error: `Request timeout: exceeded ${REQUEST_TIMEOUT_MS}ms limit (actual: ${totalRequestTime}ms)`,
        scores: [] as ScoreOutcome[],
        justification: '',
        timeout: true,
        actualDuration: totalRequestTime,
        timeoutLimit: REQUEST_TIMEOUT_MS
      }, { status: 408 });
    }
    parsedBody = read.value;
  } catch (error) {
    parseFailed = true;
    parseError = error;
  } finally {
    if (parseTimer) clearTimeout(parseTimer);
  }
  if (!parseFailed && isCodeReviewBody(parsedBody)) {
    const result = await handleCodeReviewRequest(parsedBody, requestStartTime);
    return NextResponse.json(result.body, { status: result.status });
  }
  return textModePOST(parsedBody, parseFailed, parseError, requestStartTime);
}

async function textModePOST(parsedBody: unknown, parseFailed: boolean, parseError: unknown, requestStartTime: number) {
  const timingLog: { [key: string]: number } = {};
  
  function logTiming(operation: string, startTime: number, details?: any) {
    const duration = Date.now() - startTime;
    timingLog[operation] = duration;
    const detailsStr = details ? ` | ${JSON.stringify(details)}` : '';
    console.log(`⏱️ TIMING [${operation}]: ${duration}ms${detailsStr}`);
  }

  // Apply request-level timeout wrapper to ensure total response within budget
  let requestTimeoutId: NodeJS.Timeout | null = null;
  let requestCompleted = false;
  
  const requestTimeoutPromise = new Promise<never>((_, reject) => {
    requestTimeoutId = setTimeout(() => {
      if (!requestCompleted) {
        const elapsed = Date.now() - requestStartTime;
        console.error(`🚨 REQUEST_TIMEOUT: Request exceeded ${REQUEST_TIMEOUT_MS}ms limit (elapsed: ${elapsed}ms)`);
        requestCompleted = true;
        reject(new Error(`Request timeout: exceeded ${REQUEST_TIMEOUT_MS}ms limit`));
      }
    }, Math.max(0, REQUEST_TIMEOUT_MS - (Date.now() - requestStartTime))); // the body read counts, as before
  });

  const requestProcessingPromise = (async () => {
    try {
    console.log('POST request received at /api/rank-and-justify');
    const parseStartTime = Date.now();
    if (parseFailed) throw parseError;
    const body = parsedBody as RankAndJustifyInput;
    logTiming('request_parsing', parseStartTime);
    console.log('Request body:', {
      prompt: body.prompt,
      models: body.models,
      hasAttachments: body.attachments?.length ?? 0 > 0,
      attachmentsCount: body.attachments?.length ?? 0
    });

    // Input validation
    if (!body.prompt || !Array.isArray(body.models) || body.models.length === 0) {
      return NextResponse.json(
        { error: 'Invalid input. "prompt" and "models" are required.' },
        { status: 400 }
      );
    }

    const prompt = body.prompt;
    const iterations = body.iterations || 1;
    const models = body.models;
    
    // Initialize warnings array early (used during attachment processing)
    const warnings: Warning[] = [];

    // What the arbiter did to an attachment before the models saw it, one line each,
    // appended to each juror's prompt: a juror that is not told takes a file it was never
    // shown for a file the submitter never sent. These are the lines every juror gets
    // (the images); the lines about documents are each juror's own, because one juror
    // can be sent a PDF itself while another is sent its text (pdfRouting.ts).
    const attachmentNotes: string[] = [];
    // How a note names each attachment (its file name, or its number), index-aligned
    // with body.attachments as the steps below leave it.
    let attachmentNoteRefs: string[] = attachmentRefs(body.attachmentNames, body.attachments?.length ?? 0);

    // Make every image fit every provider's limits before any model sees it, so one
    // oversized screenshot can no longer fail the whole jury. Images that already fit
    // are passed through unchanged; the prompt only changes when an image did.
    if (body.attachments?.length) {
      const imageStartTime = Date.now();
      try {
        const normalized = await normalizeImageAttachments(body.attachments, {
          names: body.attachmentNames,
          models,
          requestTag: body.requestTag || `req_${requestStartTime}`,
        });
        body.attachments = normalized.attachments;
        attachmentNoteRefs = normalized.refs;
        attachmentNotes.push(...normalized.promptNotes);
        normalized.changes.forEach(change => {
          warnings.push({
            type: change.action === 'omitted' ? 'attachment_omitted' : 'image_normalized',
            message: change.note,
            severity: change.action === 'omitted' ? 'warning' : 'info'
          });
        });
        logTiming('image_normalization', imageStartTime, { changed: normalized.changes.length });
      } catch (error) {
        if (error instanceof UnprocessableImageError) {
          // DROP_UNPROCESSABLE_IMAGES is off: fail with the real cause rather than
          // letting every provider reject the image.
          console.error(`❌ IMAGE_ERROR: ${error.message}`);
          return NextResponse.json({
            error: error.message,
            scores: [] as ScoreOutcome[],
            justification: ''
          }, { status: 400 });
        }
        // A bug in normalization must not cost the evaluation: send the attachments as received.
        console.error('Image normalization failed; continuing with the original attachments:', error);
      }
    }

    // Every attachment is read once, in each form a juror can be sent; then each
    // juror gets the best form it can read (lib/attachments/pdfRouting.ts). Only a
    // PDF is ever sent as itself: every other document is its extracted text for
    // every juror, and a juror that is not sent a PDF as a PDF gets the text and a
    // line in its own prompt saying so (documentNotes).
    const attachmentStartTime = Date.now();
    const pdfSupport: NativePdfSupport[] = models.map(modelInfo =>
      nativePdfSupport(String(modelInfo?.provider ?? ''), String(modelInfo?.model ?? '')));
    let prepared: PreparedAttachments = {
      processed: { results: [], skippedCount: 0, skippedReasons: [], skipped: [] },
      pdfs: new Map(),
      count: 0,
    };
    if (body.attachments?.length) {
      try {
        prepared = await prepareAttachments(body.attachments, {
          countPdfPages: pdfSupport.some(support => support.native),
        });
        logAttachmentSummary(prepared.processed.results);
        if (prepared.processed.skippedCount > 0) {
          console.warn(`Skipped ${prepared.processed.skippedCount} attachment(s):`, prepared.processed.skippedReasons);
        }
        logTiming('attachment_text_extraction', attachmentStartTime, {
          count: prepared.processed.results.length,
          skipped: prepared.processed.skippedCount,
          pdfs: prepared.pdfs.size,
          type: 'per_juror'
        });
      } catch (error) {
        console.error('Error processing attachments:', error);
        // Continue without attachments rather than failing
        warnings.push({
          type: 'attachment_processing_error',
          message: error instanceof Error ? error.message : 'Unknown error processing attachments',
          severity: 'error'
        });
        logTiming('attachment_error_fallback', attachmentStartTime, { 
          error: error instanceof Error ? error.message : 'Unknown error',
          type: 'error' 
        });
      }
    } else {
      logTiming('attachment_skip_none', attachmentStartTime, { 
        count: 0, 
        type: 'none' 
      });
    }

    const requestHasPdf = prepared.pdfs.size > 0;
    const jurors: JurorState[] = models.map((modelInfo, index) => {
      const support = pdfSupport[index];
      const view = attachmentsForJuror(prepared, attachmentNoteRefs, support);
      if (requestHasPdf) {
        console.log(
          `📎 PDF_INPUT: ${modelInfo.provider}-${modelInfo.model} ${describePdfInputs(view.pdfInputs)} ` +
            `| ${support.reason} | ${JSON.stringify(view.pdfInputs)}`
        );
      }
      return { support, view };
    });

    // Initialize data structures
    const previousIterationResponses: string[] = [];
    const modelOutputs: number[][][] = [];
    const V_average: number[][] = [];
    const weights: number[] = [];
    const totalWeights = models.reduce((sum, m) => sum + m.weight, 0);
    const allJustifications: string[] = [];
    // Note: warnings array declared earlier (before attachment processing)
    
    // Validate total weights
    if (totalWeights <= 0 || totalWeights > models.length) {
      return NextResponse.json(
        { error: 'Invalid weights assigned to models.' },
        { status: 400 }
      );
    }

    console.log('Starting model invocations');

    let finalAggregatedScore: number[] = [];
    let finalJustification: string = '';
    let allStructuredModelResults: ModelResult[] = []; // NEW: Track all model results across iterations

    // Model Invocation
    for (let i = 0; i < iterations; i++) {
      const iterationStartTime = Date.now();
      console.log(`Starting iteration ${i + 1}`);
      
      const iterationOutputs: number[][] = [];
      const iterationWeights: number[] = [];
      const iterationJustifications: string[] = [];

      // The full prompt for this iteration. Every juror gets the same one except for
      // the attachment notes: the image notes are shared, and each juror is told which
      // PDFs it sees only as text (none for a juror that is sent the files).
      const previousResponsesText = i > 0 && previousIterationResponses.length > 0
        ? previousIterationResponses.join('\n\n')
        : null;
      const promptFor = (jurorNotes: string[]): string => {
        const jurorPrompt = appendAttachmentNotes(prompt, [...attachmentNotes, ...jurorNotes]);
        const iterationPrompt = `${prePromptConfig.getPrompt(body.outcomes)}\n\n${jurorPrompt}`;
        return previousResponsesText === null
          ? iterationPrompt
          : `${iterationPrompt}\n\n${postPromptConfig.prompt.replace('{{previousResponses}}', previousResponsesText)}`;
      };

      // Process all models in parallel for this iteration
      try {
        console.log(`🚀 PARALLEL_START: Starting ${models.length} models in parallel for iteration ${i + 1}`);
        const parallelStartTime = Date.now();
        
        const modelPromises = models.map((modelInfo, modelIndex) => {
          console.log(`📋 PARALLEL_QUEUE: Model ${modelIndex + 1}/${models.length}: ${modelInfo.provider}-${modelInfo.model} (weight: ${modelInfo.weight}, count: ${modelInfo.count || 1})`);
          
          // Apply model-level timeout wrapper with proper cleanup to prevent memory leaks
          return new Promise((resolve, reject) => {
            const modelStartTime = Date.now();
            let timeoutId: NodeJS.Timeout | null = null;
            let completed = false;
            
            const cleanup = () => {
              if (timeoutId && !completed) {
                clearTimeout(timeoutId);
                timeoutId = null;
              }
              completed = true;
            };
            
            // Start the timeout timer
            timeoutId = setTimeout(() => {
              if (!completed) {
                console.warn(`⏰ MODEL_TIMEOUT: Model ${modelInfo.provider}-${modelInfo.model} timed out after ${MODEL_TIMEOUT_MS}ms`);
                completed = true;
                const timeoutError: any = new Error(`Model ${modelInfo.provider}-${modelInfo.model} timed out after ${MODEL_TIMEOUT_MS}ms`);
                timeoutError.verdiktaDurationMs = Date.now() - modelStartTime;
                reject(timeoutError);
              }
            }, MODEL_TIMEOUT_MS);
            
            // Start the model processing
            processModelForIteration(
              modelInfo,
              modelIndex,
              promptFor,
              jurors[modelIndex],
              prepared,
              attachmentNoteRefs,
              i + 1,
              body.outcomes,
              logTiming
            )
            .then(result => {
              cleanup();
              resolve(result);
            })
            .catch(error => {
              cleanup();
              // Record how long the model actually took to fail, so the report shows the
              // measured time rather than the timeout constant (a 400 comes back in well
              // under a second; showing it as 120 s made it look like a timeout).
              if (error && typeof error === 'object' && error.verdiktaDurationMs === undefined) {
                error.verdiktaDurationMs = Date.now() - modelStartTime;
              }
              reject(error);
            });
          });
        });

        console.log(`⏳ PARALLEL_WAIT: Waiting for ${models.length} models to complete...`);
        // Use Promise.allSettled to continue with successful models even if some fail/timeout
        const modelSettledResults = await Promise.allSettled(modelPromises);
        
        // Extract successful results and handle failures gracefully
        const modelResults: any[] = [];
        const failedModels: string[] = [];
        const failureDetails: Array<{ model: string; reason: string }> = [];
        const structuredModelResults: ModelResult[] = []; // NEW: Collect structured model results
        
        modelSettledResults.forEach((result, index) => {
          const modelInfo = models[index];
          const modelKey = `${modelInfo.provider}-${modelInfo.model}`;
          
          if (result.status === 'fulfilled') {
            // Type assertion for fulfilled promise result
            const modelResult = result.value as {
              modelAverage: number[];
              weight: number;
              justifications: string[];
              timingData: any;
              webRetrieval: WebRetrieval;
            };
            
            modelResults.push(modelResult);
            
            // Check if the fulfilled result actually used fallback (parsing error)
            if (modelResult.timingData?.failed === true) {
              console.warn(`❌ MODEL_FAILED: ${modelKey} failed (parsing error): ${modelResult.timingData.failureReason || 'Unable to parse response'}`);
              failedModels.push(modelKey);
              failureDetails.push({ 
                model: modelKey, 
                reason: modelResult.timingData.failureReason || 'Unable to parse response' 
              });
              
              // Add structured model result for parsing error
              structuredModelResults.push({
                provider: modelInfo.provider,
                model: modelInfo.model,
                status: 'parsing_error',
                duration_ms: modelResult.timingData.duration_ms || 0,
                weight: modelInfo.weight,
                error_type: 'parsing_error',
                error_message: modelResult.timingData.failureReason || 'Unable to parse response',
                web_retrieval: modelResult.webRetrieval
              });
            } else {
              console.log(`✅ MODEL_SUCCESS: ${modelKey} completed successfully`);
              
              // Add structured model result for success
              structuredModelResults.push({
                provider: modelInfo.provider,
                model: modelInfo.model,
                status: 'success',
                duration_ms: modelResult.timingData.duration_ms || 0,
                weight: modelInfo.weight,
                scores: modelResult.modelAverage.map(score => Math.floor(score)),
                web_retrieval: modelResult.webRetrieval
              });
            }
          } else {
            console.warn(`❌ MODEL_FAILED: ${modelKey} failed: ${result.reason.message}`);
            failedModels.push(modelKey);
            failureDetails.push({ model: modelKey, reason: result.reason.message });
            
            // Extract error details from the rejected promise
            const errorDetails = (result.reason as any).verdiktaErrorDetails;
            const isTimeout = result.reason.message.includes('timed out');
            logProviderAuthFailure(modelInfo.provider, modelInfo.model, 'juror', errorDetails);
            const failedDurationMs: number = typeof (result.reason as any)?.verdiktaDurationMs === 'number'
              ? (result.reason as any).verdiktaDurationMs
              : MODEL_TIMEOUT_MS; // nothing measured (should not happen) → the ceiling
            
            // Create fallback result for failed model
            const numOutcomes = body.outcomes?.length || 2;
            const baseScore = Math.floor(1000000 / numOutcomes);
            const fallbackDecisionVector = Array(numOutcomes).fill(baseScore);
            fallbackDecisionVector[0] += 1000000 - (baseScore * numOutcomes);
            
            const fallbackResult = {
              modelAverage: fallbackDecisionVector,
              weight: modelInfo.weight,
              justifications: [`From model ${modelInfo.model}:\nModel timed out or failed: ${result.reason.message}`],
              timingData: {
                provider: modelInfo.provider,
                model: modelInfo.model,
                count: modelInfo.count || 1,
                weight: modelInfo.weight,
                duration_ms: failedDurationMs,
                failed: true,
                failureReason: result.reason.message,
                ...(errorDetails && {
                  errorType: errorDetails.errorType,
                  errorMessage: errorDetails.errorMessage,
                  errorCode: errorDetails.errorCode,
                  httpStatus: errorDetails.httpStatus
                })
              }
            };
            modelResults.push(fallbackResult);
            
            // Add structured model result for failure
            structuredModelResults.push({
              provider: modelInfo.provider,
              model: modelInfo.model,
              status: isTimeout ? 'timeout' : 'failed',
              duration_ms: failedDurationMs,
              weight: modelInfo.weight,
              ...(errorDetails && {
                error_type: errorDetails.errorType,
                error_message: errorDetails.errorMessage,
                error_code: errorDetails.errorCode,
                http_status: errorDetails.httpStatus
              }),
              ...(!errorDetails && {
                error_type: isTimeout ? 'timeout' : 'unknown',
                error_message: result.reason.message
              })
            });
          }
        });
        
        const parallelDuration = Date.now() - parallelStartTime;
        const successfulModels = models.length - failedModels.length;
        console.log(`✅ PARALLEL_COMPLETE: ${successfulModels}/${models.length} models completed in ${parallelDuration}ms`);
        
        // How each juror was given the request's PDFs, whatever became of its call.
        if (requestHasPdf) {
          structuredModelResults.forEach((modelResult, index) => {
            modelResult.pdf_inputs = jurors[index].view.pdfInputs;
          });
        }

        // Store structured model results from this iteration
        allStructuredModelResults = structuredModelResults;
        
        if (failedModels.length > 0) {
          console.warn(`⚠️ FAILED_MODELS: ${failedModels.length} models failed/timed out: ${failedModels.join(', ')}`);
          
          // Add warnings for each failed model (only if evaluation succeeds)
          structuredModelResults.forEach(modelResult => {
            if (modelResult.status !== 'success') {
              warnings.push({
                type: modelResult.status === 'timeout' ? 'model_timeout' : 'model_failure',
                message: `Model ${modelResult.provider}-${modelResult.model} ${modelResult.status === 'timeout' ? 'timed out' : 'failed'}: ${modelResult.error_message || 'Unknown error'}`,
                severity: 'warning',
                model: `${modelResult.provider}-${modelResult.model}`,
                details: {
                  error_type: modelResult.error_type,
                  duration_ms: modelResult.duration_ms,
                  http_status: modelResult.http_status
                }
              });
            }
          });
        }
        
        // Check if we have enough successful models to continue
        const MIN_SUCCESSFUL_MODELS_PERCENT = parseFloat(process.env.MIN_SUCCESSFUL_MODELS_PERCENT || '0.5');
        const minSuccessfulModels = Math.ceil(models.length * MIN_SUCCESSFUL_MODELS_PERCENT);
        
        if (successfulModels < minSuccessfulModels) {
          console.error(`❌ INSUFFICIENT_MODELS: Only ${successfulModels}/${models.length} models succeeded (minimum: ${minSuccessfulModels})`);
          
          // Build detailed error message including failure reasons
          const failureDetailStr = failureDetails.length > 0
            ? ` Failures: ${failureDetails.map(f => `${f.model} (${f.reason})`).join('; ')}`
            : '';
          
          throw new Error(`Insufficient successful models: ${successfulModels}/${models.length} (minimum required: ${minSuccessfulModels}).${failureDetailStr}`);
        }
        
        logTiming(`parallel_execution_iteration_${i + 1}`, parallelStartTime, {
          modelsCount: models.length,
          successfulModels: successfulModels,
          failedModels: failedModels.length,
          failedModelsList: failedModels,
          parallelDuration: parallelDuration,
          modelBreakdown: modelResults.map((result, idx) => ({
            provider: models[idx].provider,
            model: models[idx].model,
            failed: result.timingData?.failed || false
          }))
        });

        // Extract results in the same order as the input models
        for (let j = 0; j < modelResults.length; j++) {
          const result = modelResults[j];
          const modelInfo = models[j];
          
          // Only include successful models in the score aggregation
          // Failed models contribute their error justifications but not their fallback scores
          if (result.timingData?.failed !== true) {
            iterationOutputs.push(result.modelAverage);
            iterationWeights.push(result.weight);
          } else {
            console.log(`⚠️ EXCLUDING_FAILED_MODEL: ${modelInfo.provider}-${modelInfo.model} will not contribute to score aggregation (failed)`);
          }
          
          // Add justifications from ALL models (including failed ones for transparency)
          result.justifications.forEach((justification: string) => {
            iterationJustifications.push(justification);
            
            // Format for previous iteration responses if not the last iteration
            if (i < iterations - 1) {
              const formattedResponse = `From ${modelInfo.provider} - ${modelInfo.model}:\nScore: ${result.modelAverage}\nJustification: ${justification.replace(`From model ${modelInfo.model}:\n`, '')}`;
              previousIterationResponses.push(formattedResponse);
            }
          });
        }
      } catch (error: any) {
        // If any model fails, Promise.all will reject immediately
        console.error(`Critical error processing models in parallel (iteration ${i+1}):`, error);
        
        // Determine the specific error message and return appropriate response
        if (error.message?.includes('Invalid model input') || error.message?.includes('Unsupported provider')) {
          return NextResponse.json({
            error: error.message,
            scores: [] as ScoreOutcome[],
            justification: ''
          }, { status: 400 });
        } else {
          // Provider errors (API failures, network issues, etc.)
          return NextResponse.json({
            error: error.message,
            scores: [] as ScoreOutcome[],
            justification: ''
          }, { status: 400 });
        }
      }

      // Compute weighted average for this iteration
      finalAggregatedScore = computeAverageVectors(iterationOutputs, iterationWeights);
      
      // DEBUG: Log the aggregated scores
      console.log(`🔍 DEBUG - Final aggregated scores for iteration ${i + 1}:`, {
        finalAggregatedScore,
        outcomes: body.outcomes,
        mappedAggregatedScores: body.outcomes ? body.outcomes.map((outcome, idx) => `${outcome}: ${finalAggregatedScore[idx] || 'N/A'}`) : 'No outcomes provided'
      });

      logTiming(`iteration_${i + 1}`, iterationStartTime, {
        iteration: i + 1,
        modelsProcessed: models.length
      });

      // Generate justification only on the final iteration
      if (i === iterations - 1) {
        const justificationStartTime = Date.now();
        // The result as the response reports it, each juror's own scores and every juror
        // that gave none: printed above the justifier's text, and what it is asked to explain.
        const jurorRecords: JurorRecord[] = allStructuredModelResults.map(result => ({
          provider: result.provider,
          model: result.model,
          weight: result.weight ?? 0,
          ...(result.status === 'success' ? { scores: result.scores } : { failure: jurorFailure(result) }),
        }));
        const record = resultRecord(body.outcomes, finalAggregatedScore.map(score => Math.floor(score)), jurorRecords);
        console.log(`🎯 JUSTIFIER_START: Starting justification generation with ${justifierProviderName}-${justifierModelName}`);
        console.log(`📝 JUSTIFIER_INPUT: Aggregated scores: ${JSON.stringify(finalAggregatedScore)}, Individual justifications: ${iterationJustifications.length} items`);
        
        try {
          console.log(`🏭 JUSTIFIER_PROVIDER: Getting provider for ${justifierProviderName}...`);
          const justifierProviderSetupStart = Date.now();
          const justifierProvider = await LLMFactory.getProvider(justifierProviderName);
          const justifierProviderSetupTime = Date.now() - justifierProviderSetupStart;
          console.log(`✅ JUSTIFIER_PROVIDER_READY: ${justifierProviderName} provider ready in ${justifierProviderSetupTime}ms`);
          
          logInteraction(`Prompt to Justifier:
${appendAttachmentNotes(prompt, attachmentNotes)}\n`); // Assuming base prompt is sufficient context
          
          console.log(`📞 JUSTIFIER_API_CALL: Calling ${justifierProviderName}-${justifierModelName} for justification...`);
          const justifierCallStart = Date.now();
          
          // Apply timeout wrapper to justification generation with proper cleanup
          const JUSTIFICATION_TIMEOUT_MS = parseInt(process.env.JUSTIFICATION_TIMEOUT_MS || '45000'); // 45 seconds default
          
          let justificationTimeoutId: NodeJS.Timeout | null = null;
          let justificationCompleted = false;
          let justifierTimedOut = false; // the record can say "timed out" of a juror, so the text does not tell
          
          try {
            finalJustification = await new Promise<string>((resolve, reject) => {
              justificationTimeoutId = setTimeout(() => {
                if (!justificationCompleted) {
                  justificationCompleted = true;
                  reject(new Error(`Justification generation timed out after ${JUSTIFICATION_TIMEOUT_MS}ms`));
                }
              }, JUSTIFICATION_TIMEOUT_MS);
              
              generateJustification(
                record,
                iterationJustifications,
                justifierProvider,
                justifierModelName
              )
              .then(result => {
                if (justificationTimeoutId && !justificationCompleted) {
                  clearTimeout(justificationTimeoutId);
                  justificationCompleted = true;
                }
                resolve(result);
              })
              .catch(error => {
                if (justificationTimeoutId && !justificationCompleted) {
                  clearTimeout(justificationTimeoutId);
                  justificationCompleted = true;
                }
                reject(error);
              });
            });
            
            const justifierCallTime = Date.now() - justifierCallStart;
            console.log(`✅ JUSTIFIER_API_RESPONSE: ${justifierProviderName}-${justifierModelName} responded in ${justifierCallTime}ms`);
          } catch (timeoutError: any) {
            const justifierCallTime = Date.now() - justifierCallStart;
            if (timeoutError.message.includes('timed out')) {
              justifierTimedOut = true;
              console.warn(`⏰ JUSTIFIER_TIMEOUT: Justification generation timed out after ${justifierCallTime}ms (limit: ${JUSTIFICATION_TIMEOUT_MS}ms)`);
              console.log(`📝 FALLBACK_JUSTIFICATION: Using individual model responses as justification`);
              
              // Fallback to individual model responses
              if (iterationJustifications && iterationJustifications.length > 0) {
                finalJustification = `Justification generation timed out after ${(JUSTIFICATION_TIMEOUT_MS/1000).toFixed(1)} seconds. Below are the individual responses from each model:\n\n${iterationJustifications.join('\n\n')}`;
              } else {
                finalJustification = `Justification generation timed out after ${(JUSTIFICATION_TIMEOUT_MS/1000).toFixed(1)} seconds. The aggregated scores above represent the collective decision of ${models.length} AI model(s).`;
              }
            } else {
              console.error(`❌ JUSTIFIER_ERROR: Unexpected error during justification: ${timeoutError.message}`);
              logProviderAuthFailure(justifierProviderName, justifierModelName, 'justifier', extractProviderErrorDetails(timeoutError));
              // Also fallback to individual responses on error
              if (iterationJustifications && iterationJustifications.length > 0) {
                finalJustification = `Error generating consolidated justification: ${timeoutError.message}\n\nIndividual model responses:\n\n${iterationJustifications.join('\n\n')}`;
              } else {
                finalJustification = `Error generating justification: ${timeoutError.message}`;
              }
            }
          }
          
          // Strip thinking blocks from justifier response (handles both success and timeout cases)
          finalJustification = withResultRecord(record, stripThinkingBlocks(finalJustification));
          logInteraction(`Response from Justifier:
${finalJustification}\n`);
          
          const totalJustificationTime = Date.now() - justificationStartTime;
          const justifierCallTime = Date.now() - justifierCallStart;
          console.log(`🎯 JUSTIFIER_COMPLETE: Total justification generation took ${totalJustificationTime}ms`);
          
          logTiming('justification_generation', justificationStartTime, {
            provider: justifierProviderName,
            model: justifierModelName,
            providerSetupTime: justifierProviderSetupTime,
            apiCallTime: justifierCallTime,
            totalTime: totalJustificationTime,
            responseLength: finalJustification.length,
            timedOut: justifierTimedOut,
            timeoutThreshold: JUSTIFICATION_TIMEOUT_MS
          });
        } catch (error: any) {
          const errorTime = Date.now() - justificationStartTime;
          console.error(`❌ JUSTIFIER_ERROR: Error generating final justification after ${errorTime}ms:`, error);
          finalJustification = withResultRecord(record, 'Error generating final justification.'); // Handle error gracefully
          logTiming('justification_generation_error', justificationStartTime, {
            provider: justifierProviderName,
            model: justifierModelName,
            error: error.message,
            errorTime: errorTime
          });
        }
      }

      // Note: Logic for handling previousIterationResponses for multi-iteration prompts removed for clarity,
      // as the tests seem focused on single iteration or simple aggregation.
    }

    // What was not shown as it was delivered, from what each juror was sent in the end
    // (a provider may have turned a file down). An attachment the arbiter could not
    // read is one warning when nobody was sent it, and one per juror that was not when
    // another juror got the file itself. A PDF that a juror reads natively but got as
    // text (a limit, a rejection) is one per juror; a juror that is simply sent text
    // has no warning, as before: model_results[].pdf_inputs says which form it got.
    const jurorName = (index: number) => `${models[index].provider}-${models[index].model}`;
    prepared.processed.skipped.forEach((entry, position) => {
      // The file the number in the message stands for (the number counts image
      // parts too, so it is not the file's place in the submission).
      const details = { attachment: attachmentNoteRefs[entry.index] ?? null, media_type: entry.mediaType };
      const message = prepared.processed.skippedReasons[position];
      const sentTheFile = jurors.map(juror => juror.view.pdfInputByIndex.get(entry.index)?.form === 'native');
      if (!sentTheFile.some(Boolean)) {
        warnings.push({ type: 'attachment_skipped', message, severity: 'warning', details });
        return;
      }
      jurors.forEach((juror, index) => {
        if (sentTheFile[index]) return;
        warnings.push({
          type: 'attachment_skipped',
          message: `${message} Not shown to ${jurorName(index)}; the jurors that read PDFs were sent the file itself.`,
          severity: 'warning',
          model: jurorName(index),
          details: { ...details, reason: juror.view.pdfInputByIndex.get(entry.index)?.reason }
        });
      });
    });
    jurors.forEach((juror, index) => {
      if (juror.sentNoAttachments) {
        warnings.push({
          type: 'attachments_not_sent',
          message: `${jurorName(index)} is sent no attachments (its provider says the model takes none): it was shown none of this request's ${prepared.count}, and its prompt says so.`,
          severity: 'warning',
          model: jurorName(index)
        });
      }
      if (juror.sentImagesOnly) {
        warnings.push({
          type: 'attachments_not_sent',
          message: `${jurorName(index)} is sent images only (its provider's request carries nothing else): it was shown none of this request's documents and text attachments, and its prompt says so.`,
          severity: 'warning',
          model: jurorName(index)
        });
      }
      juror.view.pdfInputs.forEach(input => {
        if (input.form !== 'text' || input.reason === 'model') return;
        const why = input.reason === 'rejected' && juror.pdfRejection
          ? `rejected: ${juror.pdfRejection}`
          : input.reason;
        warnings.push({
          type: 'pdf_text_only',
          message: `Attachment ${input.attachment} was sent to ${jurorName(index)} as extracted text only (${why}); pictures and page images inside the PDF were not shown to it.`,
          severity: input.reason === 'rejected' ? 'warning' : 'info',
          model: jurorName(index),
          details: { attachment: input.attachment, reason: input.reason, pages: input.pages }
        });
      });
    });

    // Calculate metadata for enhanced error reporting
    const successfulModelsCount = allStructuredModelResults.filter(m => m.status === 'success').length;
    const failedModelsCount = allStructuredModelResults.filter(m => m.status !== 'success').length;
    
    // Format the final response using results from the LAST iteration
    const responseBody: RankAndJustifyOutput = {
       scores: body.outcomes
         ? finalAggregatedScore.map((score, index) => ({
             outcome: body.outcomes![index],
             score: Math.floor(score)
           }))
         : finalAggregatedScore.map(score => ({
             outcome: 'unnamed', // Match previous implicit behavior if no outcomes provided
             score: Math.floor(score)
           })),
       justification: finalJustification,
       // Enhanced error reporting fields (backward compatible)
       metadata: {
         models_requested: models.length,
         models_successful: successfulModelsCount,
         models_failed: failedModelsCount,
         success_threshold_met: true,
         total_duration_ms: Date.now() - requestStartTime
       },
       model_results: allStructuredModelResults,
       ...(warnings.length > 0 && { warnings: warnings }) // Only include if there are warnings
     };

    // Calculate total request time and log comprehensive timing summary
    const totalRequestTime = Date.now() - requestStartTime;
    timingLog.total_request = totalRequestTime;
    
    console.log(`🏁 REQUEST_COMPLETE: Total request completed in ${totalRequestTime}ms`);
    console.log(`📈 PERFORMANCE_BREAKDOWN: Models: ${body.models.length}, Iterations: ${iterations}, Attachments: ${body.attachments?.length || 0}, Outcomes: ${body.outcomes?.length || 0}`);
    
    // Analyze timing components for performance insights
    const modelTimes = Object.entries(timingLog).filter(([key]) => key.startsWith('model_total_')).map(([key, time]) => ({ model: key.replace('model_total_', ''), time }));
    const slowestModel = modelTimes.reduce((prev, current) => (prev.time > current.time) ? prev : current, { model: 'none', time: 0 });
    const fastestModel = modelTimes.reduce((prev, current) => (prev.time < current.time) ? prev : current, { model: 'none', time: Infinity });
    
    console.log(`⚡ PERFORMANCE_ANALYSIS: Slowest model: ${slowestModel.model} (${slowestModel.time}ms), Fastest model: ${fastestModel.model} (${fastestModel.time}ms)`);
    
    // Log extractable timing summary
    console.log('🎯 TIMING_SUMMARY', JSON.stringify({
      timestamp: new Date().toISOString(),
      total_duration_ms: totalRequestTime,
      components: timingLog,
      performance_analysis: {
        slowest_model: slowestModel,
        fastest_model: fastestModel,
        parallel_efficiency: modelTimes.length > 1 ? (slowestModel.time / modelTimes.reduce((sum, m) => sum + m.time, 0)) : 1
      },
      summary: {
        request_id: `req_${requestStartTime}`,
        models_count: body.models.length,
        iterations: iterations,
        has_attachments: (body.attachments?.length || 0) > 0,
        attachment_count: body.attachments?.length || 0,
        outcomes_count: body.outcomes?.length || 0
      }
    }));

    console.log('Sending final response:', responseBody);
    return NextResponse.json(responseBody);

  } catch (error: any) {
    // General error handling for the entire POST request
    const totalRequestTime = Date.now() - requestStartTime;
    timingLog.total_request_error = totalRequestTime;
    
    console.error('Error in POST /api/rank-and-justify:', {
      error: error.message,
      stack: error.stack,
      type: error.constructor.name
    });
    
    // Log timing summary even for errors
    console.log('🎯 TIMING_SUMMARY_ERROR', JSON.stringify({
      timestamp: new Date().toISOString(),
      total_duration_ms: totalRequestTime,
      components: timingLog,
      error: error.message,
      error_type: error.constructor.name
    }));
    
    return NextResponse.json({
      error: error.message || 'An error occurred while processing the request.',
      scores: [] as ScoreOutcome[],
      justification: ''
    }, { status: 500 });
  }
  })();

  // Race between request processing and timeout with proper cleanup
  try {
    const result = await Promise.race([requestProcessingPromise, requestTimeoutPromise]);
    
    // Clear the request timeout if the request completed successfully
    if (requestTimeoutId && !requestCompleted) {
      clearTimeout(requestTimeoutId);
      requestCompleted = true;
    }
    
    return result;
  } catch (timeoutError: any) {
    const totalRequestTime = Date.now() - requestStartTime;
    
    // Clear the timeout in error case too
    if (requestTimeoutId && !requestCompleted) {
      clearTimeout(requestTimeoutId);
      requestCompleted = true;
    }
    
    if (timeoutError.message.includes('Request timeout')) {
      console.error(`🚨 REQUEST_TIMEOUT_FINAL: Request timed out after ${totalRequestTime}ms`);
      return NextResponse.json({
        error: `Request timeout: exceeded ${REQUEST_TIMEOUT_MS}ms limit (actual: ${totalRequestTime}ms)`,
        scores: [] as ScoreOutcome[],
        justification: '',
        timeout: true,
        actualDuration: totalRequestTime,
        timeoutLimit: REQUEST_TIMEOUT_MS
      }, { status: 408 }); // 408 Request Timeout
    } else {
      // Re-throw non-timeout errors
      throw timeoutError;
    }
  }
}

// Helper function to extract detailed error information from provider errors
function extractProviderErrorDetails(error: any): {
  errorType: string;
  errorMessage: string;
  errorCode?: string;
  httpStatus?: number;
} {
  // Extract HTTP status if available
  const httpStatus = error.response?.status || error.status || error.statusCode;
  
  // Extract error message (try multiple common patterns)
  let errorMessage = error.message || 'Unknown error';
  if (error.response?.data?.error?.message) {
    errorMessage = error.response.data.error.message;
  } else if (error.response?.data?.message) {
    errorMessage = error.response.data.message;
  } else if (error.response?.data?.error) {
    errorMessage = typeof error.response.data.error === 'string' 
      ? error.response.data.error 
      : JSON.stringify(error.response.data.error);
  }
  
  // Extract error code if available
  const errorCode = error.code || error.response?.data?.error?.code || error.response?.data?.code;
  
  // Categorize error type based on status code and message
  let errorType = 'unknown';
  const lowerMessage = errorMessage.toLowerCase();
  
  if (httpStatus === 401 || lowerMessage.includes('unauthorized') || lowerMessage.includes('invalid api key') || lowerMessage.includes('authentication')) {
    errorType = 'authentication';
  } else if (httpStatus === 403 || lowerMessage.includes('forbidden') || lowerMessage.includes('access denied')) {
    errorType = 'authorization';
  } else if (httpStatus === 429 || lowerMessage.includes('rate limit') || lowerMessage.includes('too many requests')) {
    errorType = 'rate_limit';
  } else if (httpStatus === 404 || lowerMessage.includes('not found') || lowerMessage.includes('model not found')) {
    errorType = 'model_not_found';
  } else if (lowerMessage.includes('content policy') || lowerMessage.includes('safety') || lowerMessage.includes('flagged')) {
    errorType = 'content_policy';
  } else if (lowerMessage.includes('context length') || lowerMessage.includes('token limit') || lowerMessage.includes('max tokens')) {
    errorType = 'token_limit';
  } else if ((httpStatus === 400 || httpStatus === 413 || /http (400|413)/.test(lowerMessage)) &&
             /image|patch|pixel/.test(lowerMessage)) {
    // e.g. "rejected an image attachment ... exceeding the limit of 30000" (patches)
    errorType = 'invalid_image';
  } else if (httpStatus >= 500 || lowerMessage.includes('service unavailable') || lowerMessage.includes('internal error')) {
    errorType = 'provider_error';
  } else if (lowerMessage.includes('timeout') || error.code === 'ETIMEDOUT' || error.code === 'ECONNABORTED') {
    errorType = 'timeout';
  } else if (lowerMessage.includes('network') || error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED') {
    errorType = 'network';
  }
  
  return {
    errorType,
    errorMessage,
    errorCode,
    httpStatus
  };
}

/**
 * One fixed log line when a provider refuses this node's credentials (HTTP 401 / 403).
 *
 * The request still succeeds with the rest of the panel, so nothing else tells the operator:
 * one arbiter answered bounty 398 with a single juror, and a failed justifier, while OpenAI
 * returned 401 to its key. The doctor's ai.provider_auth reads this line. It carries no
 * provider text, which can quote the key.
 */
function logProviderAuthFailure(
  provider: string,
  model: string,
  role: 'juror' | 'justifier',
  details?: { errorType?: string; httpStatus?: number } | null,
): void {
  if (details?.errorType !== 'authentication' && details?.errorType !== 'authorization') return;
  console.error(`🔑 PROVIDER_AUTH_FAILED: provider=${provider} model=${model} role=${role} http_status=${details.httpStatus ?? 'unknown'}`);
}

// Helper function for processing a single model in parallel - NOT exported
async function processModelForIteration(
  modelInfo: ModelInput,
  modelIndex: number,
  promptFor: (jurorNotes: string[]) => string,
  juror: JurorState,
  prepared: PreparedAttachments,
  refs: string[],
  iterationNumber: number,
  outcomes: string[] | undefined,
  logTiming: (operation: string, startTime: number, details?: any) => void
): Promise<{
  modelAverage: number[];
  weight: number;
  justifications: string[];
  timingData: any;
  webRetrieval: WebRetrieval;
}> {
  const modelStartTime = Date.now();
  const count = modelInfo.count || 1;
  const weight = modelInfo.weight;
  const allOutputs: number[][] = [];
  const justifications: string[] = [];
  const webRetrievals: WebRetrieval[] = []; // one per call: what its web tools did
  let usedFallback = false; // Track if this model had to use fallback scores
  let failureReason = ''; // Track the reason for failure if fallback was used
  let errorDetails: {
    errorType: string;
    errorMessage: string;
    errorCode?: string;
    httpStatus?: number;
  } | null = null; // Track detailed error info

  console.log(`🔄 MODEL_START: Processing model ${modelInfo.provider}-${modelInfo.model} (iteration ${iterationNumber})`);
  console.log(`📊 MODEL_CONFIG: Provider=${modelInfo.provider}, Model=${modelInfo.model}, Weight=${weight}, Count=${count}`);

  if (!modelInfo.provider || !modelInfo.model || weight < 0 || weight > 1) {
    console.error(`❌ MODEL_ERROR: Invalid model configuration - Provider: ${modelInfo.provider}, Model: ${modelInfo.model}, Weight: ${weight}`);
    throw new Error('Invalid model input. Check provider, model, and weight.');
  }

  // Cast to unknown first to avoid type mismatch
  console.log(`🏭 PROVIDER_SETUP: Getting provider for ${modelInfo.provider}...`);
  const providerStartTime = Date.now();
  const llmProvider = await LLMFactory.getProvider(modelInfo.provider) as unknown as LLMProvider;
  const providerSetupTime = Date.now() - providerStartTime;
  console.log(`✅ PROVIDER_READY: ${modelInfo.provider} provider ready in ${providerSetupTime}ms`);
  
  if (!llmProvider) {
    console.error(`❌ PROVIDER_ERROR: Unsupported provider: ${modelInfo.provider}`);
    throw new Error(`Unsupported provider: ${modelInfo.provider}`);
  }

  // A model its provider sends no attachments to gets none, and is told what the
  // request held instead of answering as if the prompt were everything.
  if (juror.view.attachments.length > 0 && !llmProvider.supportsAttachments(modelInfo.model)) {
    console.warn(`📎 NO_ATTACHMENTS: ${modelInfo.provider}-${modelInfo.model} is sent no attachments; its prompt says what was delivered`);
    juror.view = withoutAttachments(prepared, refs);
    juror.sentNoAttachments = true;
  } else if (
    juror.view.attachments.some(attachment => attachment.type !== 'image') &&
    llmProvider.sendsTextAttachments?.(modelInfo.model) === false
  ) {
    // A request that carries a prompt and images (Ollama). The juror's notes said
    // "Only its text is shown to you" about a PDF whose text the provider then left
    // out; they now say what is true for it.
    console.warn(`📎 IMAGES_ONLY: ${modelInfo.provider}-${modelInfo.model} is sent images only; its prompt names what it is not shown`);
    juror.view = imagesOnly(prepared, refs);
    juror.sentImagesOnly = true;
  }

  if (juror.view.attachments.length > 0) {
    console.log(`Sending ${juror.view.attachments.length} attachments to ${modelInfo.provider}:`, 
      juror.view.attachments.map(att => ({
        type: att.type,
        mediaType: att.mediaType,
        contentLength: att.content.length
      }))
    );
  }

  // Detect reasoning models to apply appropriate options for token efficiency
  // For main model calls (not justifier), use effort: medium, verbosity: low
  const isReasoningModel = modelInfo.model.toLowerCase().includes('o1') || 
                          modelInfo.model.toLowerCase().includes('o3') ||
                          modelInfo.model.toLowerCase().includes('gpt-5') ||
                          modelInfo.model.toLowerCase().includes('gpt-4.1') ||
                          modelInfo.model.toLowerCase().includes('nano') ||
                          modelInfo.model.toLowerCase().includes('grok-4') ||
                          modelInfo.model.toLowerCase().includes('grok-3') ||
                          modelInfo.model.toLowerCase().includes('reasoning');
  
  const modelOptions = isReasoningModel 
    ? { reasoning: { effort: 'medium' as const }, verbosity: 'low' as const }
    : undefined;

  console.log(`🔧 MODEL_CONFIG: ${modelInfo.provider}-${modelInfo.model}, isReasoning: ${isReasoningModel}, options: ${JSON.stringify(modelOptions)}`);

  // Inner loop - process multiple calls for this model (kept serial as requested)
  console.log(`🔁 CALLS_START: Making ${count} call(s) to ${modelInfo.provider}-${modelInfo.model}`);
  for (let c = 0; c < count; c++) {
    const callStartTime = Date.now();
    console.log(`📞 API_CALL: Call ${c + 1}/${count} to ${modelInfo.provider}-${modelInfo.model} starting...`);
    let responseText: string;
    // Providers with web tools report what the tools did; a call nobody reports on had them off.
    const callRetrievals: WebRetrieval[] = [];
    const callOptions = { ...(modelOptions || {}), onWebRetrieval: (r: WebRetrieval) => { callRetrievals.push(r); } };

    // One call with what this juror is sent now: its attachments, and the prompt with its notes.
    const call = (view: JurorAttachments): Promise<string> => {
      const callPrompt = promptFor(view.notes);
      if (view.attachments.length > 0) {
        logInteraction(`Prompt to ${modelInfo.provider} - ${modelInfo.model} with attachments:\n${callPrompt}\n`);
        return llmProvider.generateResponseWithAttachments!(callPrompt, modelInfo.model, view.attachments, callOptions);
      }
      logInteraction(`Prompt to ${modelInfo.provider} - ${modelInfo.model}:\n${callPrompt}\n`);
      return llmProvider.generateResponse(callPrompt, modelInfo.model, callOptions);
    };

    try {
      try {
        responseText = await call(juror.view);
      } catch (firstError: any) {
        if (juror.view.nativePdfs === 0 || !rejectsRequest(firstError)) throw firstError;
        // The provider refused the request that carried a PDF as a file. Ask once more
        // with the PDF's text (and the note saying so), for this and every later call.
        const rejection = extractProviderErrorDetails(firstError);
        juror.pdfRejection = `HTTP ${rejection.httpStatus}: ${String(rejection.errorMessage).slice(0, 300)}`;
        console.warn(
          `📎 PDF_FALLBACK: ${modelInfo.provider}-${modelInfo.model} refused the request with ${juror.view.nativePdfs} PDF(s) ` +
            `after ${Date.now() - callStartTime}ms (${juror.pdfRejection}); asking again with the extracted text`
        );
        juror.view = attachmentsForJuror(prepared, refs, juror.support, { rejected: true });
        callRetrievals.length = 0; // what the refused request's web tools reported is not this answer's
        responseText = await call(juror.view);
      }
      // Strip thinking blocks from the response
      responseText = stripThinkingBlocks(responseText);
      const hasAttachments = juror.view.attachments.length > 0;
      const callDuration = Date.now() - callStartTime;
      console.log(`✅ API_RESPONSE: Call ${c + 1}/${count} to ${modelInfo.provider}-${modelInfo.model} completed in ${callDuration}ms (${hasAttachments ? 'with attachments' : 'no attachments'})`);
      logInteraction(`Response from ${modelInfo.provider} - ${modelInfo.model}:\n${responseText}\n`);
      logTiming(`model_call_${modelInfo.provider}_${modelInfo.model}_${hasAttachments ? 'with_attachments_' : ''}${c+1}`, callStartTime, {
        provider: modelInfo.provider,
        model: modelInfo.model,
        hasAttachments,
        callNumber: c + 1,
        responseLength: responseText.length
      });
    } catch (providerError: any) {
      // Capture detailed error information
      errorDetails = extractProviderErrorDetails(providerError);
      console.error(`Provider error from ${modelInfo.provider}/${modelInfo.model}:`, {
        error: providerError.message,
        errorType: errorDetails.errorType,
        httpStatus: errorDetails.httpStatus,
        stack: providerError.stack,
        attachments: juror.view.attachments.length > 0 ? 'Has attachments' : 'No attachments'
      });
      // Enhance the error with our details before re-throwing
      providerError.verdiktaErrorDetails = errorDetails;
      throw providerError; // Re-throw to be caught by Promise wrapper
    }

    let { decisionVector, justification, scores } = parseModelResponse(responseText, outcomes);
    let effectiveJustification = justification; // Store potentially modified justification

    if (!decisionVector) {
      // One short call without tools: the same model returns the scores its reply states
      // (a prose answer, or scores that do not sum to 1,000,000). See repairModelResponse.ts.
      const repairStartTime = Date.now();
      console.warn(`🔧 MODEL_REPAIR: ${modelInfo.provider}-${modelInfo.model} reply could not be parsed; asking it once for the scores it states`);
      const repaired = await repairModelScores(
        llmProvider,
        modelInfo.model,
        responseText,
        outcomes,
        isReasoningModel ? { reasoning: { effort: 'low' as const }, verbosity: 'low' as const } : undefined
      );
      if (repaired) {
        decisionVector = repaired;
        effectiveJustification = replyJustification(responseText);
        console.log(`🔧 MODEL_REPAIRED: ${modelInfo.provider}-${modelInfo.model} scores ${JSON.stringify(repaired)} in ${Date.now() - repairStartTime}ms`);
      } else {
        console.warn(`🔧 MODEL_REPAIR_FAILED: ${modelInfo.provider}-${modelInfo.model} after ${Date.now() - repairStartTime}ms`);
      }
    }

    // DEBUG: Log what each model actually returned
    console.log(`🔍 DEBUG - Model ${modelInfo.provider}/${modelInfo.model} returned:`, {
      decisionVector,
      outcomes: outcomes,
      mappedScores: outcomes ? outcomes.map((outcome, idx) => `${outcome}: ${decisionVector?.[idx] || 'N/A'}`) : 'No outcomes provided'
    });
    
    if (!decisionVector) {
      console.warn(`Failed to parse decision vector from model ${modelInfo.model}. Response: ${responseText}. Applying fallback.`);
      const numOutcomes = outcomes?.length || 2; // Default to 2 if outcomes not specified
      const baseScore = Math.floor(1000000 / numOutcomes);
      const fallbackDecisionVector = Array(numOutcomes).fill(baseScore);
      // Distribute remainder to ensure sum is exactly 1,000,000
      fallbackDecisionVector[0] += 1000000 - (baseScore * numOutcomes);
      
      decisionVector = fallbackDecisionVector; // Use fallback vector
      usedFallback = true; // Mark that this model used fallback scores
      failureReason = responseText.length > 100 
        ? `Unable to parse response: ${responseText.substring(0, 100)}...` 
        : `Unable to parse response: ${responseText}`;

      if (!justification) {
        effectiveJustification = `LLM_ERROR: ${responseText}`; // Create fallback justification
      }
      // No need to return an error, proceed with fallback values
    }

    allOutputs.push(decisionVector);
    webRetrievals.push(mergeWebRetrievals(callRetrievals));

    if (effectiveJustification) { // Use the potentially modified justification
      justifications.push(`From model ${modelInfo.model}:\n${effectiveJustification}`);
    }
  }

  // Average the outputs for this model if count > 1
  const modelAverage = count > 1 
    ? averageVectors(allOutputs)
    : allOutputs[0];

  const modelDuration = Date.now() - modelStartTime;
  
  // Build timing data with optional fields
  const timingData: any = {
    provider: modelInfo.provider,
    model: modelInfo.model,
    count: count,
    weight: weight,
    duration_ms: modelDuration,
    failed: usedFallback // Mark as failed if fallback scores were used
  };
  
  if (usedFallback && failureReason) {
    timingData.failureReason = failureReason;
  }
  
  if (errorDetails) {
    // Type assertion to work around TypeScript narrowing issue
    const details = errorDetails as { errorType: string; errorMessage: string; errorCode?: string; httpStatus?: number };
    timingData.errorType = details.errorType;
    timingData.errorMessage = details.errorMessage;
    if (details.errorCode) {
      timingData.errorCode = details.errorCode;
    }
    if (details.httpStatus) {
      timingData.httpStatus = details.httpStatus;
    }
  }

  logTiming(`model_total_${modelInfo.provider}_${modelInfo.model}`, modelStartTime, timingData);

  const webRetrieval = mergeWebRetrievals(webRetrievals);
  console.log(`🌐 WEB_RETRIEVAL: ${modelInfo.provider}-${modelInfo.model} ${describeWebRetrieval(webRetrieval)} | ${JSON.stringify(webRetrieval)}`);

  return {
    modelAverage,
    weight,
    justifications,
    timingData,
    webRetrieval
  };
}

// Helper function - NOT exported
async function generateJustification(
  record: string,
  allJustifications: string[],
  justifierProvider: any,
  justifierModel: string
): Promise<string> {
  // DEBUG: Log what's being sent to the justifier
  console.log(`🔍 DEBUG - Sending to justifier:`, {
    record,
    individualJustifications: allJustifications
  });
  
  // The justifier explains the recorded result; it is not asked to work one out (resultRecord.ts).
  const prompt = justifierPrompt(record, allJustifications);

  // For reasoning models, use low effort and low verbosity for faster justification generation
  const isReasoningModel = justifierModel.toLowerCase().includes('o1') || 
                          justifierModel.toLowerCase().includes('o3') || 
                          justifierModel.toLowerCase().includes('nano');
  
  const options = isReasoningModel 
    ? { reasoning: { effort: 'low' as const }, verbosity: 'low' as const }
    : undefined;

  // The justifier summarizes the jurors' answers; links quoted in them are not its to open.
  const response = await justifierProvider.generateResponse(prompt, justifierModel, { ...(options || {}), webAccess: false });
  return response;
}

// Helper function - NOT exported
function computeAverageVectors(vectors: number[][], weights: number[]): number[] {
  if (!vectors || vectors.length === 0 || vectors.length !== weights.length) {
    // Handle empty input or mismatched lengths
    console.warn('computeAverageVectors received invalid input:', { vectors: vectors?.length, weights: weights?.length });
    return []; 
  }
  const totalWeight = weights.reduce((sum, w) => sum + w, 0);
  if (totalWeight === 0) {
      console.warn('computeAverageVectors received zero total weight.');
      return [];
  }
  const dimensions = vectors[0].length;
  const result = new Array(dimensions).fill(0);

  for (let i = 0; i < vectors.length; i++) {
    for (let j = 0; j < dimensions; j++) {
      // Simplified weighted accumulation assuming vectors.length === weights.length
      result[j] += (vectors[i][j] * weights[i]) / totalWeight;
    }
  }

  return result;
}

// Helper function - NOT exported
function averageVectors(vectors: number[][]): number[] {
  const dimensions = vectors[0].length;
  const result = new Array(dimensions).fill(0);
  
  for (let i = 0; i < vectors.length; i++) {
    for (let j = 0; j < dimensions; j++) {
      result[j] += vectors[i][j];
    }
  }
  
  for (let j = 0; j < dimensions; j++) {
    result[j] = Math.floor(result[j] / vectors.length);
  }
  
  return result;
}
