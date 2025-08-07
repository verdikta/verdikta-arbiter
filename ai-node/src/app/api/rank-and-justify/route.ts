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
  generateResponse: (prompt: string, model: string) => Promise<string>;
  generateResponseWithAttachments?: (prompt: string, model: string, attachments: any[]) => Promise<string>;
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

export async function POST(request: Request) {
  const requestStartTime = Date.now();
  const timingLog: { [key: string]: number } = {};
  
  function logTiming(operation: string, startTime: number, details?: any) {
    const duration = Date.now() - startTime;
    timingLog[operation] = duration;
    const detailsStr = details ? ` | ${JSON.stringify(details)}` : '';
    console.log(`⏱️ TIMING [${operation}]: ${duration}ms${detailsStr}`);
  }

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
        const supported = ['gpt-4o', 'gpt-4o-mini', 'o1', 'gpt-4.1', 'gpt-4.1-mini'].some(supportedModel =>
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

      // Process each model for this iteration
      for (let j = 0; j < models.length; j++) {
        const modelStartTime = Date.now();
        const modelInfo = models[j];
        const count = modelInfo.count || 1;
        const weight = modelInfo.weight;
        const allOutputs: number[][] = [];

        console.log(`Processing model: ${modelInfo.provider} - ${modelInfo.model}`);

        if (!modelInfo.provider || !modelInfo.model || weight < 0 || weight > 1) {
          return NextResponse.json(
            { error: 'Invalid model input. Check provider, model, and weight.' },
            { status: 400 }
          );
        }

        try {
          // Cast to unknown first to avoid type mismatch
          const llmProvider = await LLMFactory.getProvider(modelInfo.provider) as unknown as LLMProvider;
          if (!llmProvider) {
            return NextResponse.json(
              { error: `Unsupported provider: ${modelInfo.provider}` },
              { status: 400 }
            );
          }

          // Construct the full prompt based on iteration
          let iterationPrompt = `${prePromptConfig.getPrompt(body.outcomes)}\n\n${prompt}`;
          
          if (i > 0 && previousIterationResponses.length > 0) {
            const previousResponsesText = previousIterationResponses.join('\n\n');
            iterationPrompt = `${iterationPrompt}\n\n${postPromptConfig.prompt.replace('{{previousResponses}}', previousResponsesText)}`;
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

          for (let c = 0; c < count; c++) {
            const callStartTime = Date.now();
            let responseText: string;
            if (attachments.length > 0 && llmProvider.supportsAttachments(modelInfo.model)) {
              logInteraction(`Prompt to ${modelInfo.provider} - ${modelInfo.model} with attachments:\n${iterationPrompt}\n`);
              try {
                responseText = await llmProvider.generateResponseWithAttachments!(
                  iterationPrompt,
                  modelInfo.model,
                  attachments
                );
                logInteraction(`Response from ${modelInfo.provider} - ${modelInfo.model}:\n${responseText}\n`);
                logTiming(`model_call_${modelInfo.provider}_${modelInfo.model}_with_attachments_${c+1}`, callStartTime, {
                  provider: modelInfo.provider,
                  model: modelInfo.model,
                  hasAttachments: true,
                  callNumber: c + 1
                });
              } catch (providerError: any) {
                console.error(`Provider error from ${modelInfo.provider}/${modelInfo.model}:`, {
                  error: providerError.message,
                  stack: providerError.stack,
                  attachments: attachments.length > 0 ? 'Has attachments' : 'No attachments'
                });
                return NextResponse.json({
                  error: providerError.message,
                  scores: [] as ScoreOutcome[],
                  justification: ''
                }, { status: 400 });
              }
            } else {
              logInteraction(`Prompt to ${modelInfo.provider} - ${modelInfo.model}:\n${iterationPrompt}\n`);
              try {
                responseText = await llmProvider.generateResponse(
                  iterationPrompt,
                  modelInfo.model
                );
                logInteraction(`Response from ${modelInfo.provider} - ${modelInfo.model}:\n${responseText}\n`);
                logTiming(`model_call_${modelInfo.provider}_${modelInfo.model}_${c+1}`, callStartTime, {
                  provider: modelInfo.provider,
                  model: modelInfo.model,
                  hasAttachments: false,
                  callNumber: c + 1
                });
              } catch (providerError: any) {
                console.error(`Provider error from ${modelInfo.provider}/${modelInfo.model}:`, {
                  error: providerError.message,
                  stack: providerError.stack,
                  attachments: attachments.length > 0 ? 'Has attachments' : 'No attachments'
                });
                return NextResponse.json({
                  error: providerError.message,
                  scores: [] as ScoreOutcome[],
                  justification: ''
                }, { status: 400 });
              }
            }

            let { decisionVector, justification, scores } = parseModelResponse(responseText, body.outcomes);
            let effectiveJustification = justification; // Store potentially modified justification
            
            // DEBUG: Log what each model actually returned
            console.log(`🔍 DEBUG - Model ${modelInfo.provider}/${modelInfo.model} returned:`, {
              decisionVector,
              outcomes: body.outcomes,
              mappedScores: body.outcomes ? body.outcomes.map((outcome, idx) => `${outcome}: ${decisionVector?.[idx] || 'N/A'}`) : 'No outcomes provided'
            });
            
            if (!decisionVector) {
              console.warn(`Failed to parse decision vector from model ${modelInfo.model}. Response: ${responseText}. Applying fallback.`);
              const numOutcomes = body.outcomes?.length || 2; // Default to 2 if outcomes not specified
              const baseScore = Math.floor(1000000 / numOutcomes);
              const fallbackDecisionVector = Array(numOutcomes).fill(baseScore);
              // Distribute remainder to ensure sum is exactly 1,000,000
              fallbackDecisionVector[0] += 1000000 - (baseScore * numOutcomes);
              
              decisionVector = fallbackDecisionVector; // Use fallback vector

              if (!justification) {
                effectiveJustification = `LLM_ERROR: ${responseText}`; // Create fallback justification
              }
              // No need to return an error, proceed with fallback values
            }

            allOutputs.push(decisionVector);
            
            if (effectiveJustification) { // Use the potentially modified justification
              const formattedResponse = `From ${modelInfo.provider} - ${modelInfo.model}:\nScore: ${decisionVector}\nJustification: ${effectiveJustification}`;
              iterationJustifications.push(`From model ${modelInfo.model}:\n${effectiveJustification}`);
              
              if (i < iterations - 1) {
                previousIterationResponses.push(formattedResponse);
              }
            }
          }

          // Average the outputs for this model if count > 1
          const modelAverage = count > 1 
            ? averageVectors(allOutputs)
            : allOutputs[0];

          iterationOutputs.push(modelAverage);
          iterationWeights.push(weight);
          
          logTiming(`model_total_${modelInfo.provider}_${modelInfo.model}`, modelStartTime, {
            provider: modelInfo.provider,
            model: modelInfo.model,
            count: count,
            weight: weight
          });
        } catch (error: any) {
          // If we get here, an error occurred trying to get the provider or during model setup.
          console.error(`Critical error processing model ${modelInfo.provider} - ${modelInfo.model} (iteration ${i+1}):`, error);
          
          // === ADD THIS: Return 400 immediately on provider setup error ===
          return NextResponse.json({
            error: `Failed to process model configuration: ${modelInfo.provider} - ${modelInfo.model}. Reason: ${error.message}`,
            scores: [] as ScoreOutcome[],
            justification: ''
          }, { status: 400 });
          // === END ADDITION ===

          // Optionally, add a placeholder or skip this model's contribution (Original behavior - now replaced by the return above)
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
        try {
          const justifierProvider = await LLMFactory.getProvider(justifierProviderName);
          logInteraction(`Prompt to Justifier:
${prompt}\n`); // Assuming base prompt is sufficient context
          finalJustification = await generateJustification(
            finalAggregatedScore,
            iterationJustifications, // Pass justifications from this iteration
            justifierProvider,
            justifierModelName
          );
          logInteraction(`Response from Justifier:
${finalJustification}\n`);
          logTiming('justification_generation', justificationStartTime, {
            provider: justifierProviderName,
            model: justifierModelName
          });
        } catch (error: any) {
          console.error('Error generating final justification in iteration:', error);
          finalJustification = 'Error generating final justification.'; // Handle error gracefully
          logTiming('justification_generation_error', justificationStartTime, {
            provider: justifierProviderName,
            model: justifierModelName,
            error: error.message
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
    
    // Log extractable timing summary
    console.log('🎯 TIMING_SUMMARY', JSON.stringify({
      timestamp: new Date().toISOString(),
      total_duration_ms: totalRequestTime,
      components: timingLog,
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

  const response = await justifierProvider.generateResponse(prompt, justifierModel);
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
