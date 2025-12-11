# AI-Enabled Web App with Multi-Model Deliberation

This is a [Next.js](https://nextjs.org/) project that serves as a platform for AI-enabled web applications with advanced deliberation capabilities. It demonstrates integration with various Language Model (LLM) providers, including open-source models, OpenAI, and Anthropic's Claude.

## Application Overview

This application extends beyond traditional AI chatbots by introducing a unique multi-model deliberation system. Key features include:

- **Multi-LLM Integration**: Connect with multiple AI providers simultaneously (OpenAI, Anthropic Claude, xAI, Hyperbolic, and local Ollama models)
- **Collective Decision Making**: Employ multiple AI models to deliberate on questions or statements
- **Weighted Voting System**: Assign different weights to various models based on their reliability or expertise
- **Outcome Ranking**: Vote on and rank possible outcomes for a given prompt
- **Detailed Justifications**: Generate comprehensive explanations for collective decisions
- **Support for Attachments**: Process images, documents (RTF, PDF, Word, Markdown), and text inputs for richer context
- **Text Extraction**: Automatically extracts plain text from various document formats to optimize token usage
- **Interaction Logging**: Track and analyze all LLM interactions

The application's standout feature is its ability to aggregate insights from multiple AI models, creating a more balanced and nuanced response than any single model could provide alone.

## Getting Started

First, ensure you have Node.js installed on your system. Then, follow these steps:

1. Clone this repository to your local machine.
2. Install the dependencies:

npm install

3. Set up your environment variables:
   - Create a `.env.local` file in the root directory
   - Add your API keys for the LLM providers you want to use:
     ```
     OPENAI_API_KEY=your_openai_api_key
     ANTHROPIC_API_KEY=your_anthropic_api_key
     XAI_API_KEY=your_xai_api_key
     ```

4. Run the development server:

npm run dev

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

## Running in Production

To run the application in production mode, follow these steps:

1.  **Set Environment Variables:** Ensure all required environment variables (e.g., `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `JUSTIFIER_MODEL`) are set in your production environment. Note that `.env.local` is **not** loaded in production builds; these variables must be set directly in the server environment or through a `.env.production` file (though environment variables usually take precedence).

2.  **Install Dependencies:** Run `npm install` (or `npm ci --omit=dev` for a cleaner install using `package-lock.json` and skipping development dependencies).

3.  **Build the Application:** Create an optimized production build:
    ```bash
    npm run build
    ```
    This command compiles the application and outputs the result to the `.next` directory.

4.  **Start the Production Server:** Start the server using the built application:
    ```bash
    npm start
    ```
    This command starts the Next.js production server, which serves the optimized application, typically on port 3000 unless configured otherwise (e.g., via the `PORT` environment variable).

## Project Structure

- `src/app/`: Contains the main application pages and API routes
  - `page.tsx`: The main page component with the UI for interacting with LLMs
  - `api/generate/`: API route for fetching available models and generating responses
  - `api/rank-and-justify/`: API route for multi-model deliberation and outcome ranking
- `src/lib/llm/`: Contains the LLM provider implementations
  - `llm-provider-interface.ts`: Defines the interface for LLM providers
  - `llm-factory.ts`: Factory class for creating LLM provider instances
  - `openai-provider.ts`: OpenAI provider implementation
  - `claude-provider.ts`: Anthropic's Claude provider implementation
  - `ollama-provider.ts`: Ollama (open-source) provider implementation
- `src/config/`: Configuration files
  - `models.ts`: Model configuration for different providers
  - `prePromptConfig.ts`: Configuration for prompts sent before user input
  - `postPromptConfig.ts`: Configuration for prompts sent after initial responses

## How It Works

### Basic LLM Interaction

1. The main page (`src/app/page.tsx`) allows users to:
   - Select an LLM provider
   - Choose a specific model from the selected provider
   - Enter a prompt
   - Generate a response based on the prompt and selected model

2. The application fetches available models from all providers when the page loads.

3. When a user submits a prompt:
   - The application sends a POST request to the `/api/generate` endpoint
   - The server-side code uses the appropriate LLM provider to generate a response
   - The generated response is sent back to the client and displayed on the page

### Multi-Model Deliberation

The application's advanced feature is the rank-and-justify system:

1. Multiple models from different providers can be assigned to deliberate on a prompt
2. Each model:
   - Receives the same input (with optional attachments)
   - Assigns scores to possible outcomes
   - Provides detailed justification for its decision
3. The system:
   - Weights each model's vote based on assigned importance
   - Aggregates scores across all participating models
   - Generates a final justification based on all individual justifications
   - Returns the ranked outcomes with the collective justification

This deliberation process creates a more balanced perspective by combining insights from multiple AI sources, reducing the bias or limitations of any single model.

## Customization

You can customize this template by:
- Adding new LLM providers in the `src/lib/llm/` directory
- Modifying the UI in `src/app/page.tsx`
- Extending the API functionality in `src/app/api/generate/route.ts`

## Testing

This project uses [Jest](https://jestjs.io/) as its testing framework, along with [React Testing Library](https://testing-library.com/docs/react-testing-library/intro/) for component testing. Tests are located primarily within the `src/__tests__` directory.

### Running Tests

To run all tests:

```bash
npm test
```

To run tests in watch mode:

```bash
npm run test:watch
```

To run a specific test file:

```bash
npm test -- path/to/your/test/file.test.ts
```

### Writing Effective Tests

1.  **Naming:** Use descriptive test names (`describe`, `it`, `test`) that clearly explain the expected behavior.
2.  **Isolation:** Mock external dependencies (like APIs, `fetch`, or libraries) to isolate the component or module under test. This ensures tests are reliable and focus on the unit's logic.
3.  **Coverage:** Test both successful execution paths and expected error scenarios (e.g., invalid input, API failures).
4.  **Setup/Teardown:** Use `beforeEach` for common setup and `afterEach` for cleanup if needed to keep tests independent.
5.  **Component Testing:** Use React Testing Library's queries that resemble how users interact with the application (e.g., `getByText`, `getByRole`, `getByLabelText`) rather than testing implementation details.

### Test Structure Guidelines

1.  **Location:** Place test files in appropriate subdirectories within `src/__tests__` (e.g., `src/__tests__/api`, `src/__tests__/components`, `src/__tests__/lib`).
2.  **Naming Convention:** Use the naming convention `[component-name].test.tsx` or `[module-name].test.ts`.
3.  **Imports:** Import necessary testing utilities and the specific component/module to be tested.
4.  **Grouping:** Use `describe` blocks to group related test cases for a specific function or component feature.

Remember to keep tests up-to-date as functionality evolves. Well-maintained tests serve as living documentation and help prevent regressions.

## Learn More

To learn more about the technologies used in this project, check out the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.
- [LangChain Documentation](https://js.langchain.com/docs/) - learn about LangChain, the library used for interacting with LLMs.

## Deployment

This project can be easily deployed on platforms like Vercel. Make sure to set up your environment variables in your deployment platform's settings.

For more details on deployment, refer to the [Next.js deployment documentation](https://nextjs.org/docs/deployment).

## Downloading Ollama Models Locally

To use Ollama models locally:

1. Install Ollama by following the instructions at [https://ollama.ai/](https://ollama.ai/).

2. Open a terminal and run the following command to download a model (e.g., llama2):

   ```
   ollama pull llama2
   ```

3. Repeat for any other models you want to use locally.

4. Ensure the Ollama service is running before starting your Next.js application.

## Updating Available Models

To change which models can be selected by the user:

1. Open `src/config/models.ts` and update the `modelConfig` object:

   ```typescript
   export const modelConfig = {
     openai: [
       { name: 'gpt-3.5-turbo', supportsImages: false },
       { name: 'gpt-4', supportsImages: false },
       { name: 'gpt-4o', supportsImages: true },
     ],
     anthropic: [
       { name: 'claude-2.1', supportsImages: false },
       { name: 'claude-3-sonnet-20240229', supportsImages: true },
     ],
     xai: [
       { name: 'grok-4-1-fast-reasoning', supportsImages: true },
       { name: 'grok-4-fast-reasoning', supportsImages: true },
       { name: 'grok-4-0709', supportsImages: true },
     ],
   };
   ```

   Add, remove, or modify the models for OpenAI and Anthropic as needed. The `supportsImages` property determines whether the model can process image inputs.

2. For Open-source (local) models, use ollama as described above.   Models availble to the AI web template will be the ones listed with the command 

ollama list

New models can be added by pulling them using 

ollama pull model-name

A complete list of the models available can be found at the Ollama Library (https://ollama.com/library)

3. If you want to add or remove entire providers, update the `PROVIDERS` array in `src/app/api/generate/route.ts`:

   ```typescript
   const PROVIDERS = ['Open-source', 'OpenAI', 'Anthropic', 'xAI', 'Hyperbolic', 'NewProvider'];
   ```

   Then, update the `LLMFactory` in `src/lib/llm/llm-factory.ts` to handle the new provider.

## xAI Integration

To use xAI's Grok models:

1. Obtain an API key from the [xAI Console](https://console.x.ai/)

2. Add your API key to `.env.local`:
   ```
   XAI_API_KEY=your_xai_api_key
   ```

3. Available Grok models include:
   - `grok-4-1-fast-reasoning` - Latest multimodal reasoning model (2M context, images supported)
   - `grok-4-1-fast-non-reasoning` - Fast non-reasoning variant (2M context, images supported)
   - `grok-4-fast-reasoning` - High-performance reasoning (2M context, images supported)
   - `grok-4-fast-non-reasoning` - Cost-efficient variant (2M context, images supported)
   - `grok-4-0709` - Base Grok 4 model (256K context, images supported)
   - `grok-code-fast-1` - Code-focused model (256K context, images supported)

4. The xAI API is OpenAI-compatible, making integration seamless with existing workflows.

Remember to restart your development server after making these changes for them to take effect.

## Text Extraction and Document Processing

The application includes a comprehensive text extraction system that automatically processes various document formats to optimize them for LLM consumption. This system solves token limit issues by extracting plain text from rich document formats.

### Supported Document Formats

- **RTF (Rich Text Format)**: `.rtf` files - Removes formatting markup and extracts plain text
- **PDF**: `.pdf` files - Extracts text content using hybrid approach (pdf-parse with textract fallback)
- **Microsoft Word**: `.doc` and `.docx` files - Extracts text from Word documents
- **Markdown**: `.md` files - Converts markdown to plain text
- **HTML**: `.html` files - Strips HTML tags and extracts text content
- **Plain Text**: `.txt` files - Passed through unchanged
- **Images**: `.jpg`, `.png`, `.gif`, `.webp` - Processed as visual content (no text extraction)

### Text Extraction Features

- **Automatic Format Detection**: Identifies document format based on MIME type
- **Size Limits**: Configurable file size limits (default: 50MB)
- **Content Limits**: Configurable extracted text limits (default: 100k characters)  
- **Timeout Protection**: Prevents hanging on problematic documents (default: 60s)
- **Fallback Handling**: Graceful degradation if extraction fails
- **Performance Monitoring**: Tracks extraction time and success rates

### Configuration

The text extraction system can be configured via environment variables or programmatically:

```typescript
// Default configuration
{
  maxFileSize: 50 * 1024 * 1024,     // 50MB (increased for larger PDFs)
  maxExtractedLength: 100000,        // 100k characters (increased for longer documents)
  enableFallback: true,              // Use original content if extraction fails
  extractionTimeout: 60000,          // 60 seconds (increased for larger files)
  enableLogging: true                // Log extraction details in development
}
```

### Troubleshooting Text Extraction

**File Size Issues:**
- Files larger than 50MB will be skipped with a warning
- Large PDFs may take longer to process (up to 60 seconds)
- Consider compressing or splitting very large documents

**Extraction Failures:**
- Binary files that can't be processed are automatically skipped
- Corrupted or password-protected files will fail extraction
- Scanned PDFs (images) may not extract text properly
- PDF processing uses hybrid approach: attempts pdf-parse first, falls back to textract if needed

**Performance Tips:**
- Text-based formats (RTF, TXT, MD) process fastest
- PDF processing depends on document complexity
- Multiple attachments are processed sequentially

**Expected Behavior:**
- Successfully processed attachments are sent to the LLM
- Failed/unsupported attachments are skipped with console warnings
- Image attachments bypass text extraction and are sent directly

## Additional Environment Variables

For the rank-and-justify feature, you may configure an additional environment variable:

```
JUSTIFIER_MODEL=provider:model-name
```

This defines which model will be used to generate the final justification for multi-model deliberations.

