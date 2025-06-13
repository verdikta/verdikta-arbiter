import { NextResponse } from 'next/server';
import { LLMFactory } from '../../../lib/llm/llm-factory';
import { fileToBase64 } from '../../../utils/fileUtils';
import { processAttachments, convertToLLMFormat, logAttachmentSummary } from '../../../utils/attachment-processor'; 


// Define the list of supported LLM providers
const PROVIDERS = ['Open-source', 'OpenAI', 'Anthropic'];

/**
 * GET handler for /api/generate
 * Fetches available models from all supported providers
 * @returns {Promise<NextResponse>} JSON response with all available models or an error message
 */
export async function GET() {
  try {
    console.log('GET request received for /api/generate');
    
    const providerModels = await Promise.all(
      PROVIDERS.map(async (provider) => {
        try {
          console.log(`Fetching models for provider: ${provider}`);
          const llmProvider = await LLMFactory.getProvider(provider);
          console.log(`Provider instance created for: ${provider}`);
          const models = await llmProvider.getModels();
          console.log(`Models for ${provider}:`, models);
          return { provider, models };
        } catch (error) {
          console.error(`Error fetching models for ${provider}:`, error);
          return { provider, models: [] };
        }
      })
    );

    const allModels = providerModels.flatMap(pm => 
      pm.models.map(model => ({
        provider: pm.provider,
        model,
        supportedInputs: ['text', ...(model.supportsImages ? ['image'] : [])],
      }))
    );

    console.log('All available models:', allModels);

    if (allModels.length === 0) {
      throw new Error('No models available from any provider');
    }

    return NextResponse.json({ models: allModels });
  } catch (error) {
    console.error('Error in GET /api/generate:', error);
    return NextResponse.json({ error: 'An error occurred while fetching models.' }, { status: 500 });
  }
}

/**
 * POST handler for /api/generate
 * Generates a response using the specified provider and model
 * @param {Request} request - The incoming request object
 * @returns {Promise<NextResponse>} JSON response with the generated result or an error message
 */
export async function POST(request: Request) {
  try {
    console.log('POST request received in generate/route.ts');
    const formData = await request.formData();
    
    // Log form data entries for debugging
    const entries = Array.from(formData.entries()).map(([key, value]) => ({
      key,
      type: typeof value,
      fileType: value instanceof Blob ? value.type : 'N/A'
    }));
    console.log('Form data entries:', entries);

    // Extract basic parameters
    const prompt = formData.get('prompt') as string;
    const providerName = formData.get('provider') as string;
    const modelName = formData.get('model') as string;

    console.log('Request details:', { prompt, providerName, modelName });

    // Process attachments using the new text extraction system
    const rawAttachments: Array<{ type: string; content: string; mediaType: string; filename?: string }> = [];

    // Process each form entry
    for (const [key, value] of Array.from(formData.entries())) {
      console.log('Processing form entry:', { key, isFile: value instanceof Blob });

      if (value instanceof Blob) {
        console.log('Processing attachment:', key);
        const fileDetails = {
          key,
          type: value.type,
          size: value.size,
          name: 'name' in value ? (value as any).name : 'unknown'
        };
        console.log('File details:', fileDetails);

        // Read the file content
        const arrayBuffer = await value.arrayBuffer();
        const base64Data = Buffer.from(arrayBuffer).toString('base64');
        
        rawAttachments.push({
          type: value.type.startsWith('image/') ? 'image' : 'document',
          content: base64Data,
          mediaType: value.type,
          filename: fileDetails.name
        });

        console.log('Added attachment for processing');
      }
    }

    // Process attachments with text extraction
    let attachments: Array<{ type: string; content: string; mediaType: string }> = [];
    if (rawAttachments.length > 0) {
      console.log('Processing attachments with text extraction...');
      try {
        const { results: processedAttachments, skippedCount, skippedReasons } = await processAttachments(
          rawAttachments, 
          providerName, 
          modelName
        );
        attachments = convertToLLMFormat(processedAttachments);
        logAttachmentSummary(processedAttachments);
        
        if (skippedCount > 0) {
          console.warn(`Skipped ${skippedCount} attachment(s):`, skippedReasons);
        }
      } catch (error) {
        console.error('Error processing attachments:', error);
        // Continue without attachments rather than failing
        attachments = [];
      }
    }

    // Get the provider
    const provider = await LLMFactory.getProvider(providerName);
    console.log('Provider created:', providerName);

    if (!provider) {
      return NextResponse.json(
        { error: `Unsupported provider: ${providerName}` },
        { status: 400 }
      );
    }

    let response: string;
    if (attachments.length > 0 && provider.supportsAttachments(modelName)) {
      response = await provider.generateResponseWithAttachments(
        prompt,
        modelName,
        attachments
      );
    } else {
      response = await provider.generateResponse(prompt, modelName);
    }

    return NextResponse.json({ result: response });

  } catch (error: any) {
    console.error('Error in POST /api/generate:', error);
    return NextResponse.json(
      { error: error.message || 'An error occurred while processing the request.' },
      { status: 500 }
    );
  }
}