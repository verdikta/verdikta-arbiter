import { NextResponse } from 'next/server';
import { LLMFactory } from '../../../lib/llm/llm-factory';
import { fileToBase64 } from '../../../utils/fileUtils'; 


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

    // Process attachments
    const attachments: Array<{ type: string; content: string; mediaType: string }> = [];

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
        const dataUri = `data:${value.type};base64,${base64Data}`;
        
        console.log('Image processed successfully:', {
          key,
          dataLength: dataUri.length
        });

        attachments.push({
          type: 'image',
          content: base64Data,
          mediaType: value.type
        });

        console.log('Added image attachment');
      }
    }

    console.log('Total attachments:', attachments.length);
    console.log('Processed attachments:', attachments.map(att => ({
      type: att.type,
      contentLength: att.content.length,
      mediaType: att.mediaType
    })));

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