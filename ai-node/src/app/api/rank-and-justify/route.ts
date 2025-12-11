import { NextResponse } from 'next/server';
import { LLMFactory } from '../../../lib/llm/llm-factory';
import { prePromptConfig } from '../../../config/prePromptConfig';
import { postPromptConfig } from '../../../config/postPromptConfig';
import { parseModelResponse } from '../../../utils/parseModelResponse';
import { processAttachments, convertToLLMFormat, logAttachmentSummary } from '../../../utils/attachment-processor';
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
}

interface ScoreOutcome {
  outcome: string;
  score: number;
}

interface RankAndJustifyOutput {
  scores: ScoreOutcome[];
  justification: string;
}

interface LLMProvider {
  generateResponse: (prompt: string, model: string, options?: any) => Promise<string>;
  generateResponseWithAttachments?: (prompt: string, model: string, attachments: any[], options?: any) => Promise<string>;
  supportsAttachments: (model: string) => boolean;
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
  const requestStartTime = Date.now();
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
    }, REQUEST_TIMEOUT_MS);
  });

  const requestProcessingPromise = (async () => {
    try {
    console.log('POST request received at /api/rank-and-justify');
    const parseStartTime = Date.now();
    const body: RankAndJustifyInput = await request.json();
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

    // Add this before the check
    console.log('DEBUG: Checking native PDF support for each model:');
    body.models.forEach(modelInfo => {
      if (modelInfo.provider === 'OpenAI') {
        const supported = ['gpt-4o', 'gpt-4o-mini', 'o1', 'gpt-4.1', 'gpt-4.1-mini', 'gpt-5', 'gpt-5-mini'].some(supportedModel =>
          modelInfo.model.toLowerCase().includes(supportedModel.toLowerCase())
        );
        console.log(`[OpenAI] Model: ${modelInfo.model}, Supported: ${supported}`);
      } else if (modelInfo.provider === 'Anthropic') {
        const pdfCapableModels = [
          'claude-opus-4', 'claude-sonnet-4', 'claude-4-sonnet', 'claude-4-opus',
          'claude-3-7-sonnet', 'claude-3-5-sonnet', 'claude-3-5-haiku',
          'claude-sonnet-4-20250514'
        ];
        const supported = pdfCapableModels.some(supportedModel => modelInfo.model.includes(supportedModel));
        console.log(`[Anthropic] Model: ${modelInfo.model}, Supported: ${supported}`);
      } else if (modelInfo.provider === 'xAI' || modelInfo.provider === 'xai') {
        // xAI Grok models support text attachments but not native PDF processing
        console.log(`[xAI] Model: ${modelInfo.model}, Native PDF Supported: false (will use text extraction)`);
      } else {
        console.log(`[Other] Provider: ${modelInfo.provider}, Model: ${modelInfo.model}, Supported: false`);
      }
    });

    const allModelsSupportNativePDF = body.models.every(modelInfo => {
      if (modelInfo.provider === 'OpenAI') {
        return ['gpt-4o', 'gpt-4o-mini', 'o1', 'gpt-4.1', 'gpt-4.1-mini'].some(supportedModel => 
          modelInfo.model.toLowerCase().includes(supportedModel.toLowerCase())
        );
      } else if (modelInfo.provider === 'Anthropic') {
        const pdfCapableModels = [
          'claude-opus-4', 'claude-sonnet-4', 'claude-4-sonnet', 'claude-4-opus',
          'claude-3-7-sonnet', 'claude-3-5-sonnet', 'claude-3-5-haiku',
          'claude-sonnet-4-20250514'
        ];
        return pdfCapableModels.some(supportedModel => modelInfo.model.includes(supportedModel));
      } else if (modelInfo.provider === 'xAI' || modelInfo.provider === 'xai') {
        // xAI Grok models don't support native PDF - will use text extraction
        return false;
      }
      return false;
    });

    console.log('DEBUG: allModelsSupportNativePDF:', allModelsSupportNativePDF);

    // Process attachments
    const attachmentStartTime = Date.now();
    let attachments: Array<{ type: string; content: string; mediaType: string }> = [];
    if (body.attachments?.length) {
      if (allModelsSupportNativePDF) {
        console.log('All models support native PDF processing - passing attachments directly...');
        // Convert base64 attachments to LLM format without text extraction
        attachments = body.attachments.map(attachment => {
          if (attachment.startsWith('data:')) {
            const [header, base64Data] = attachment.split(',');
            const mediaType = header.split(';')[0].replace('data:', '');
            return {
              type: mediaType.startsWith('image/') ? 'image' : 'document',
              content: base64Data,
              mediaType: mediaType
            };
          } else {
            // Assume it's already base64 encoded (fallback)
            return {
              type: 'document',
              content: attachment,
              mediaType: 'application/octet-stream'
            };
          }
        });
        console.log(`Prepared ${attachments.length} attachments for native processing:`, 
          attachments.map(att => ({ type: att.type, mediaType: att.mediaType, size: att.content.length }))
        );
        logTiming('attachment_native_processing', attachmentStartTime, { 
          count: attachments.length, 
          type: 'native' 
        });
      } else {
        console.log('Some models do not support native PDF processing - using text extraction...');
        try {
          const primaryModel = body.models?.[0];
          const providerName = primaryModel?.provider;
          const modelName = primaryModel?.model;
          
          const { results: processedAttachments, skippedCount, skippedReasons } = await processAttachments(
            body.attachments,
            providerName,
            modelName
          );
          attachments = convertToLLMFormat(processedAttachments);
          logAttachmentSummary(processedAttachments);
          
          if (skippedCount > 0) {
            console.warn(`Skipped ${skippedCount} attachment(s):`, skippedReasons);
          }
          logTiming('attachment_text_extraction', attachmentStartTime, { 
            count: attachments.length, 
            skipped: skippedCount,
            type: 'text_extraction' 
          });
        } catch (error) {
          console.error('Error processing attachments:', error);
          // Continue without attachments rather than failing
          attachments = [];
          logTiming('attachment_error_fallback', attachmentStartTime, { 
            error: error instanceof Error ? error.message : 'Unknown error',
            type: 'error' 
          });
        }
      }
    } else {
      logTiming('attachment_skip_none', attachmentStartTime, { 
        count: 0, 
        type: 'none' 
      });
    }

    // Initialize data structures
    const previousIterationResponses: string[] = [];
    const modelOutputs: number[][][] = [];
    const V_average: number[][] = [];
    const weights: number[] = [];
    const totalWeights = models.reduce((sum, m) => sum + m.weight, 0);
    const allJustifications: string[] = [];
    
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

    // Model Invocation
    for (let i = 0; i < iterations; i++) {
      const iterationStartTime = Date.now();
      console.log(`Starting iteration ${i + 1}`);
      
      const iterationOutputs: number[][] = [];
      const iterationWeights: number[] = [];
      const iterationJustifications: string[] = [];

      // Construct the full prompt based on iteration (shared across all models)
      let iterationPrompt = `${prePromptConfig.getPrompt(body.outcomes)}\n\n${prompt}`;
      
      if (i > 0 && previousIterationResponses.length > 0) {
        const previousResponsesText = previousIterationResponses.join('\n\n');
        iterationPrompt = `${iterationPrompt}\n\n${postPromptConfig.prompt.replace('{{previousResponses}}', previousResponsesText)}`;
      }

      // Process all models in parallel for this iteration
      try {
        console.log(`🚀 PARALLEL_START: Starting ${models.length} models in parallel for iteration ${i + 1}`);
        const parallelStartTime = Date.now();
        
        const modelPromises = models.map((modelInfo, modelIndex) => {
          console.log(`📋 PARALLEL_QUEUE: Model ${modelIndex + 1}/${models.length}: ${modelInfo.provider}-${modelInfo.model} (weight: ${modelInfo.weight}, count: ${modelInfo.count || 1})`);
          
          // Apply model-level timeout wrapper with proper cleanup to prevent memory leaks
          return new Promise((resolve, reject) => {
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
                reject(new Error(`Model ${modelInfo.provider}-${modelInfo.model} timed out after ${MODEL_TIMEOUT_MS}ms`));
              }
            }, MODEL_TIMEOUT_MS);
            
            // Start the model processing
            processModelForIteration(
              modelInfo,
              modelIndex,
              iterationPrompt,
              attachments,
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
        
        modelSettledResults.forEach((result, index) => {
          const modelInfo = models[index];
          const modelKey = `${modelInfo.provider}-${modelInfo.model}`;
          
          if (result.status === 'fulfilled') {
            modelResults.push(result.value);
            
            // Check if the fulfilled result actually used fallback (parsing error)
            if (result.value.timingData?.failed === true) {
              console.warn(`❌ MODEL_FAILED: ${modelKey} failed (parsing error): ${result.value.timingData.failureReason || 'Unable to parse response'}`);
              failedModels.push(modelKey);
              failureDetails.push({ 
                model: modelKey, 
                reason: result.value.timingData.failureReason || 'Unable to parse response' 
              });
            } else {
              console.log(`✅ MODEL_SUCCESS: ${modelKey} completed successfully`);
            }
          } else {
            console.warn(`❌ MODEL_FAILED: ${modelKey} failed: ${result.reason.message}`);
            failedModels.push(modelKey);
            failureDetails.push({ model: modelKey, reason: result.reason.message });
            
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
                failed: true,
                failureReason: result.reason.message
              }
            };
            modelResults.push(fallbackResult);
          }
        });
        
        const parallelDuration = Date.now() - parallelStartTime;
        const successfulModels = models.length - failedModels.length;
        console.log(`✅ PARALLEL_COMPLETE: ${successfulModels}/${models.length} models completed in ${parallelDuration}ms`);
        
        if (failedModels.length > 0) {
          console.warn(`⚠️ FAILED_MODELS: ${failedModels.length} models failed/timed out: ${failedModels.join(', ')}`);
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
        console.log(`🎯 JUSTIFIER_START: Starting justification generation with ${justifierProviderName}-${justifierModelName}`);
        console.log(`📝 JUSTIFIER_INPUT: Aggregated scores: ${JSON.stringify(finalAggregatedScore)}, Individual justifications: ${iterationJustifications.length} items`);
        
        try {
          console.log(`🏭 JUSTIFIER_PROVIDER: Getting provider for ${justifierProviderName}...`);
          const justifierProviderSetupStart = Date.now();
          const justifierProvider = await LLMFactory.getProvider(justifierProviderName);
          const justifierProviderSetupTime = Date.now() - justifierProviderSetupStart;
          console.log(`✅ JUSTIFIER_PROVIDER_READY: ${justifierProviderName} provider ready in ${justifierProviderSetupTime}ms`);
          
          logInteraction(`Prompt to Justifier:
${prompt}\n`); // Assuming base prompt is sufficient context
          
          console.log(`📞 JUSTIFIER_API_CALL: Calling ${justifierProviderName}-${justifierModelName} for justification...`);
          const justifierCallStart = Date.now();
          
          // Apply timeout wrapper to justification generation with proper cleanup
          const JUSTIFICATION_TIMEOUT_MS = parseInt(process.env.JUSTIFICATION_TIMEOUT_MS || '45000'); // 45 seconds default
          
          let justificationTimeoutId: NodeJS.Timeout | null = null;
          let justificationCompleted = false;
          
          try {
            finalJustification = await new Promise<string>((resolve, reject) => {
              justificationTimeoutId = setTimeout(() => {
                if (!justificationCompleted) {
                  justificationCompleted = true;
                  reject(new Error(`Justification generation timed out after ${JUSTIFICATION_TIMEOUT_MS}ms`));
                }
              }, JUSTIFICATION_TIMEOUT_MS);
              
              generateJustification(
                finalAggregatedScore,
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
              // Also fallback to individual responses on error
              if (iterationJustifications && iterationJustifications.length > 0) {
                finalJustification = `Error generating consolidated justification: ${timeoutError.message}\n\nIndividual model responses:\n\n${iterationJustifications.join('\n\n')}`;
              } else {
                finalJustification = `Error generating justification: ${timeoutError.message}`;
              }
            }
          }
          
          // Strip thinking blocks from justifier response (handles both success and timeout cases)
          finalJustification = stripThinkingBlocks(finalJustification);
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
            timedOut: finalJustification.includes('timed out'),
            timeoutThreshold: JUSTIFICATION_TIMEOUT_MS
          });
        } catch (error: any) {
          const errorTime = Date.now() - justificationStartTime;
          console.error(`❌ JUSTIFIER_ERROR: Error generating final justification after ${errorTime}ms:`, error);
          finalJustification = 'Error generating final justification.'; // Handle error gracefully
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
       justification: finalJustification
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

// Helper function for processing a single model in parallel - NOT exported
async function processModelForIteration(
  modelInfo: ModelInput,
  modelIndex: number,
  iterationPrompt: string,
  attachments: Array<{ type: string; content: string; mediaType: string }>,
  iterationNumber: number,
  outcomes: string[] | undefined,
  logTiming: (operation: string, startTime: number, details?: any) => void
): Promise<{
  modelAverage: number[];
  weight: number;
  justifications: string[];
  timingData: any;
}> {
  const modelStartTime = Date.now();
  const count = modelInfo.count || 1;
  const weight = modelInfo.weight;
  const allOutputs: number[][] = [];
  const justifications: string[] = [];
  let usedFallback = false; // Track if this model had to use fallback scores
  let failureReason = ''; // Track the reason for failure if fallback was used

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

  if (attachments.length > 0) {
    console.log(`Sending ${attachments.length} attachments to ${modelInfo.provider}:`, 
      attachments.map(att => ({
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
    
    if (attachments.length > 0 && llmProvider.supportsAttachments(modelInfo.model)) {
      logInteraction(`Prompt to ${modelInfo.provider} - ${modelInfo.model} with attachments:\n${iterationPrompt}\n`);
      try {
        responseText = await llmProvider.generateResponseWithAttachments!(
          iterationPrompt,
          modelInfo.model,
          attachments,
          modelOptions
        );
        // Strip thinking blocks from the response
        responseText = stripThinkingBlocks(responseText);
        const callDuration = Date.now() - callStartTime;
        console.log(`✅ API_RESPONSE: Call ${c + 1}/${count} to ${modelInfo.provider}-${modelInfo.model} completed in ${callDuration}ms (with attachments)`);
        logInteraction(`Response from ${modelInfo.provider} - ${modelInfo.model}:\n${responseText}\n`);
        logTiming(`model_call_${modelInfo.provider}_${modelInfo.model}_with_attachments_${c+1}`, callStartTime, {
          provider: modelInfo.provider,
          model: modelInfo.model,
          hasAttachments: true,
          callNumber: c + 1,
          responseLength: responseText.length
        });
      } catch (providerError: any) {
        console.error(`Provider error from ${modelInfo.provider}/${modelInfo.model}:`, {
          error: providerError.message,
          stack: providerError.stack,
          attachments: attachments.length > 0 ? 'Has attachments' : 'No attachments'
        });
        throw providerError; // Re-throw to be caught by Promise.all()
      }
    } else {
      logInteraction(`Prompt to ${modelInfo.provider} - ${modelInfo.model}:\n${iterationPrompt}\n`);
      try {
        responseText = await llmProvider.generateResponse(
          iterationPrompt,
          modelInfo.model,
          modelOptions
        );
        // Strip thinking blocks from the response
        responseText = stripThinkingBlocks(responseText);
        const callDuration = Date.now() - callStartTime;
        console.log(`✅ API_RESPONSE: Call ${c + 1}/${count} to ${modelInfo.provider}-${modelInfo.model} completed in ${callDuration}ms (no attachments)`);
        logInteraction(`Response from ${modelInfo.provider} - ${modelInfo.model}:\n${responseText}\n`);
        logTiming(`model_call_${modelInfo.provider}_${modelInfo.model}_${c+1}`, callStartTime, {
          provider: modelInfo.provider,
          model: modelInfo.model,
          hasAttachments: false,
          callNumber: c + 1,
          responseLength: responseText.length
        });
      } catch (providerError: any) {
        console.error(`Provider error from ${modelInfo.provider}/${modelInfo.model}:`, {
          error: providerError.message,
          stack: providerError.stack,
          attachments: attachments.length > 0 ? 'Has attachments' : 'No attachments'
        });
        throw providerError; // Re-throw to be caught by Promise.all()
      }
    }

    let { decisionVector, justification, scores } = parseModelResponse(responseText, outcomes);
    let effectiveJustification = justification; // Store potentially modified justification
    
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
    
    if (effectiveJustification) { // Use the potentially modified justification
      justifications.push(`From model ${modelInfo.model}:\n${effectiveJustification}`);
    }
  }

  // Average the outputs for this model if count > 1
  const modelAverage = count > 1 
    ? averageVectors(allOutputs)
    : allOutputs[0];

  const timingData = {
    provider: modelInfo.provider,
    model: modelInfo.model,
    count: count,
    weight: weight,
    failed: usedFallback, // Mark as failed if fallback scores were used
    ...(usedFallback && { failureReason: failureReason }) // Include failure reason if fallback was used
  };

  logTiming(`model_total_${modelInfo.provider}_${modelInfo.model}`, modelStartTime, timingData);

  return {
    modelAverage,
    weight,
    justifications,
    timingData
  };
}

// Helper function - NOT exported
async function generateJustification(
  V_total: number[],
  allJustifications: string[],
  justifierProvider: any,
  justifierModel: string
): Promise<string> {
  // DEBUG: Log what's being sent to the justifier
  console.log(`🔍 DEBUG - Sending to justifier:`, {
    aggregatedVector: V_total,
    individualJustifications: allJustifications
  });
  
  const prompt = `Using the aggregated decision vector ${JSON.stringify(
    V_total
  )}, and considering the following justifications from individual models:\n\n${allJustifications.join(
    '\n\n'
  )}\n\nProvide a comprehensive justification for the result.`;

  // For reasoning models, use low effort and low verbosity for faster justification generation
  const isReasoningModel = justifierModel.toLowerCase().includes('o1') || 
                          justifierModel.toLowerCase().includes('o3') || 
                          justifierModel.toLowerCase().includes('nano');
  
  const options = isReasoningModel 
    ? { reasoning: { effort: 'low' as const }, verbosity: 'low' as const }
    : undefined;

  const response = await justifierProvider.generateResponse(prompt, justifierModel, options);
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
