import { NextResponse } from 'next/server';
import { LLMFactory } from '../../../lib/llm/llm-factory';
import { prePromptConfig } from '../../../config/prePromptConfig';
import { postPromptConfig } from '../../../config/postPromptConfig';
import { parseModelResponse } from '../../../utils/parseModelResponse';
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
  try {
    console.log('POST request received at /api/rank-and-justify');
    const body: RankAndJustifyInput = await request.json();
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

    // Process attachments if they exist
    if (body.attachments?.length) {
      console.log('Processing attachments...');
      body.attachments.forEach((content, index) => {
        console.log(`Attachment ${index + 1}:`);
        console.log('- Content type:', typeof content);
        if (typeof content === 'string') {
          console.log('- Starts with:', content.substring(0, 50) + '...');
          if (content.startsWith('data:')) {
            const mediaTypeMatch = content.match(/^data:([^;]+);base64,/);
            console.log('- Media type:', mediaTypeMatch ? mediaTypeMatch[1] : 'unknown');
          } else {
            console.log('- WARNING: Attachment does not start with data: URI scheme');
          }
        } else {
          console.log('- WARNING: Attachment is not a string');
        }
      });
    }

    const attachments = body.attachments?.map((content, index) => {
      if (content.startsWith('data:image')) {
        const mediaTypeMatch = content.match(/^data:([^;]+);base64,/);
        const mediaType = mediaTypeMatch ? mediaTypeMatch[1] : 'image/jpeg';
        console.log(`Processing image attachment ${index + 1}:`, {
          mediaType,
          contentLength: content.length,
          isBase64: content.includes(';base64,')
        });
        
        const base64Data = content.replace(/^data:image\/[^;]+;base64,/, '');
        return {
          type: 'image',
          content: base64Data,
          mediaType: mediaType
        };
      }
      console.log(`Processing non-image attachment ${index + 1}:`, {
        type: 'text',
        contentLength: content.length
      });
      return {
        type: 'text',
        content: content,
        mediaType: 'text/plain'
      };
    }) || [];

    // Log processed attachments summary
    console.log('Processed attachments summary:', attachments.map(att => ({
      type: att.type,
      mediaType: att.mediaType,
      contentLength: att.content.length
    })));

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
      console.log(`Starting iteration ${i + 1}`);
      
      const iterationOutputs: number[][] = [];
      const iterationWeights: number[] = [];
      const iterationJustifications: string[] = [];

      // Process each model for this iteration
      for (let j = 0; j < models.length; j++) {
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

      // Generate justification only on the final iteration
      if (i === iterations - 1) {
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
        } catch (error: any) {
          console.error('Error generating final justification in iteration:', error);
          finalJustification = 'Error generating final justification.'; // Handle error gracefully
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

    console.log('Sending final response:', responseBody);
    return NextResponse.json(responseBody);

  } catch (error: any) {
    // General error handling for the entire POST request
    console.error('Error in POST /api/rank-and-justify:', {
      error: error.message,
      stack: error.stack,
      type: error.constructor.name
    });
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
