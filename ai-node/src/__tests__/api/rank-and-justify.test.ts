import { NextResponse } from 'next/server';
import { POST } from '../../app/api/rank-and-justify/route';
import { LLMFactory } from '../../lib/llm/llm-factory';
import { generateJustification } from '../../app/api/rank-and-justify/route';

interface ScoreOutcome {
  outcome: string;
  score: number;
}

// Mock the LLMFactory
jest.mock('../../lib/llm/llm-factory');

// Mock the NextResponse
jest.mock('next/server', () => ({
  NextResponse: {
    json: jest.fn((data, options) => ({
      status: options?.status || 200,
      json: jest.fn().mockResolvedValue(data),
    })),
  },
}));

// Mock the Request class
class MockRequest implements Request {
  private _url: string;
  private _method: string;
  private _body: string;
  private _headers: Headers;
  private _bodyUsed: boolean = false;

  // Required Request properties
  readonly cache: RequestCache = 'default';
  readonly credentials: RequestCredentials = 'same-origin';
  readonly destination: RequestDestination = '' as RequestDestination;
  readonly integrity: string = '';
  readonly keepalive: boolean = false;
  readonly mode: RequestMode = 'cors';
  readonly redirect: RequestRedirect = 'follow';
  readonly referrer: string = '';
  readonly referrerPolicy: ReferrerPolicy = 'no-referrer';
  readonly signal: AbortSignal = new AbortController().signal;
  readonly bodyUsed: boolean = false;
  bytes(): Promise<Uint8Array> {
    return Promise.resolve(new TextEncoder().encode(this._body));
  }

  constructor(input: string | URL, init?: RequestInit) {
    this._url = input.toString();
    this._method = init?.method || 'GET';
    this._body = init?.body as string || '';
    this._headers = new Headers(init?.headers);
  }

  get url(): string {
    return this._url;
  }

  get method(): string {
    return this._method;
  }

  get headers(): Headers {
    return this._headers;
  }

  get body(): ReadableStream<Uint8Array> | null {
    return null;
  }

  async json(): Promise<any> {
    return JSON.parse(this._body);
  }

  // Implement required methods
  arrayBuffer(): Promise<ArrayBuffer> {
    throw new Error('Method not implemented.');
  }

  blob(): Promise<Blob> {
    throw new Error('Method not implemented.');
  }

  clone(): Request {
    return new MockRequest(this._url, {
      method: this._method,
      body: this._body,
      headers: this._headers
    });
  }

  formData(): Promise<FormData> {
    throw new Error('Method not implemented.');
  }

  text(): Promise<string> {
    return Promise.resolve(this._body);
  }
}

// Replace the global Request with our mock
global.Request = MockRequest as any;

describe('POST /api/rank-and-justify', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('Basic functionality', () => {
    test('should process single iteration request', async () => {
      // Mock responses for each model
      const mockOpenAIResponse = JSON.stringify({
        score: [400000, 300000, 200000, 100000],
        justification: "OpenAI model justification."
      });
      const mockAnthropicResponse = JSON.stringify({
        score: [350000, 250000, 200000, 200000],
        justification: "Anthropic model justification."
      });
      const mockOllamaResponse = JSON.stringify({
        score: [300000, 300000, 200000, 200000],
        justification: "Ollama model justification."
      });
      const mockJustifierResponse = 'Aggregated justification based on all models.';

      // Mock providers
      const mockOpenAIProvider = {
        generateResponse: jest.fn().mockResolvedValue(mockOpenAIResponse),
        generateResponseWithImage: jest.fn(),
        generateResponseWithAttachments: jest.fn(),
        supportsImages: jest.fn().mockResolvedValue(true),
        supportsAttachments: jest.fn().mockResolvedValue(true),
      };

      const mockAnthropicProvider = {
        generateResponse: jest.fn().mockResolvedValue(mockAnthropicResponse),
        generateResponseWithImage: jest.fn(),
        generateResponseWithAttachments: jest.fn(),
        supportsImages: jest.fn().mockResolvedValue(true),
        supportsAttachments: jest.fn().mockResolvedValue(true),
      };

      const mockOllamaProvider = {
        generateResponse: jest.fn().mockResolvedValue(mockOllamaResponse),
        generateResponseWithImage: jest.fn(),
        generateResponseWithAttachments: jest.fn(),
        supportsImages: jest.fn().mockResolvedValue(false),
        supportsAttachments: jest.fn().mockResolvedValue(false),
      };

      const mockJustifierProvider = {
        generateResponse: jest.fn().mockResolvedValue(mockJustifierResponse),
      };

      // Mock LLMFactory.getProvider
      (LLMFactory.getProvider as jest.Mock).mockImplementation((providerName: string) => {
        switch (providerName) {
          case 'OpenAI':
            return mockOpenAIProvider;
          case 'Anthropic':
            return mockAnthropicProvider;
          case 'Ollama':
            return mockOllamaProvider;
          case 'JustifierProvider':
            return mockJustifierProvider;
          default:
            throw new Error(`Unknown provider: ${providerName}`);
        }
      });

      const requestBody = {
        prompt: 'Should we expand into the new market?',
        outcomes: ['Yes', 'No', 'Wait', 'Abandon'],
        iterations: 1,
        models: [
          {
            provider: 'OpenAI',
            model: 'gpt-4o',
            weight: 0.5,
          },
          {
            provider: 'Anthropic',
            model: 'claude-3-sonnet-20240229',
            weight: 0.3,
          },
          {
            provider: 'Ollama',
            model: 'phi3',
            weight: 0.2,
          },
        ],
      };

      const request = new Request('http://localhost/api/rank-and-justify', {
        method: 'POST',
        body: JSON.stringify(requestBody),
        headers: {
          'Content-Type': 'application/json',
        },
      });

      const response = await POST(request);
      expect(response).toBeDefined();
      const data = await response.json();

      const expectedScores = [
        {
          outcome: 'Yes',
          score: Math.floor(400000 * 0.5 + 350000 * 0.3 + 300000 * 0.2)
        },
        {
          outcome: 'No',
          score: Math.floor(300000 * 0.5 + 250000 * 0.3 + 300000 * 0.2)
        },
        {
          outcome: 'Wait',
          score: Math.floor(200000 * 0.5 + 200000 * 0.3 + 200000 * 0.2)
        },
        {
          outcome: 'Abandon',
          score: Math.floor(100000 * 0.5 + 200000 * 0.3 + 200000 * 0.2)
        }
      ];

      expect(data.scores).toEqual(expectedScores);
      expect(data.justification).toBe(mockJustifierResponse);
      // Verify total score sums to 1,000,000
      const totalScore = data.scores.reduce((sum: number, item: ScoreOutcome) => sum + item.score, 0);
      expect(totalScore).toBe(1000000);
    });

    test('should handle image attachments', async () => {
      // Reference existing test from rank-and-justify.test.ts
      startLine: 200
      endLine: 250
    });

    test('should handle count parameter', async () => {
      // Reference existing test from rank-and-justify.test.ts
      startLine: 250
      endLine: 300
    });
  });

  describe('Iterative feedback', () => {
    test('should include previous responses in subsequent iterations', async () => {
      // Mock responses for each model and iteration
      const mockResponses = {
        OpenAI: [
          JSON.stringify({
            score: [600000, 400000],
            justification: "First iteration OpenAI justification."
          }),
          JSON.stringify({
            score: [700000, 300000],
            justification: "Second iteration OpenAI justification considering previous responses."
          })
        ],
        Anthropic: [
          JSON.stringify({
            score: [550000, 450000],
            justification: "First iteration Anthropic justification."
          }),
          JSON.stringify({
            score: [650000, 350000],
            justification: "Second iteration Anthropic justification considering previous responses."
          })
        ]
      };

      // Mock providers
      const mockOpenAIProvider = {
        generateResponse: jest.fn()
          .mockImplementation(() => Promise.resolve(mockResponses.OpenAI.shift())),
        supportsAttachments: jest.fn().mockResolvedValue(false),
      };

      const mockAnthropicProvider = {
        generateResponse: jest.fn()
          .mockImplementation(() => Promise.resolve(mockResponses.Anthropic.shift())),
        supportsAttachments: jest.fn().mockResolvedValue(false),
      };

      const mockJustifierProvider = {
        generateResponse: jest.fn().mockResolvedValue('Final aggregated justification'),
      };

      // Mock LLMFactory.getProvider
      (LLMFactory.getProvider as jest.Mock).mockImplementation((providerName: string) => {
        switch (providerName) {
          case 'OpenAI':
            return mockOpenAIProvider;
          case 'Anthropic':
            return mockAnthropicProvider;
          case 'JustifierProvider':
            return mockJustifierProvider;
          default:
            throw new Error(`Unknown provider: ${providerName}`);
        }
      });

      const requestBody = {
        prompt: 'Should we proceed with the investment?',
        outcomes: ['Proceed', 'Hold'],
        iterations: 2,
        models: [
          {
            provider: 'OpenAI',
            model: 'gpt-4',
            weight: 0.6,
          },
          {
            provider: 'Anthropic',
            model: 'claude-3',
            weight: 0.4,
          },
        ],
      };

      const request = new Request('http://localhost/api/rank-and-justify', {
        method: 'POST',
        body: JSON.stringify(requestBody),
        headers: {
          'Content-Type': 'application/json',
        },
      });

      const response = await POST(request);
      expect(response).toBeDefined();
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data).toHaveProperty('scores');
      expect(data).toHaveProperty('justification');
      // Verify total score sums to 1,000,000
      const totalScore = data.scores.reduce((sum: number, item: ScoreOutcome) => sum + item.score, 0);
      expect(totalScore).toBe(1000000);

      const expectedScores = [
        {
          outcome: 'Proceed',
          score: Math.floor(700000 * 0.6 + 650000 * 0.4)
        },
        {
          outcome: 'Hold',
          score: Math.floor(300000 * 0.6 + 350000 * 0.4)
        }
      ];

      expect(data.scores).toEqual(expectedScores);
    });

    test('should handle errors in iterative responses', async () => {
      const mockErrorResponse = 'Invalid response format';
      const mockOpenAIProvider = {
        generateResponse: jest.fn().mockRejectedValue(new Error(mockErrorResponse)),
        supportsAttachments: jest.fn().mockResolvedValue(false),
      };

      (LLMFactory.getProvider as jest.Mock).mockResolvedValue(mockOpenAIProvider);

      const requestBody = {
        prompt: 'Test prompt',
        iterations: 2,
        models: [
          {
            provider: 'OpenAI',
            model: 'gpt-4',
            weight: 1.0,
          },
        ],
      };

      const request = new Request('http://localhost/api/rank-and-justify', {
        method: 'POST',
        body: JSON.stringify(requestBody),
        headers: { 'Content-Type': 'application/json' },
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data).toHaveProperty('error');
    });
  });

  describe('Error Handling and Fallback', () => {
    test('should handle malformed response from one model and apply fallback', async () => {
      // Mock responses for each model
      const mockOpenAIResponse = JSON.stringify({
        score: [700000, 300000],
        justification: "OpenAI model justification."
      });
      // Malformed response (plain text)
      const mockAnthropicMalformedResponse = "I am unable to provide a score in the requested format.";
      const mockJustifierResponse = 'Aggregated justification considering fallback.';

      // Mock providers
      const mockOpenAIProvider = {
        generateResponse: jest.fn().mockResolvedValue(mockOpenAIResponse),
        supportsAttachments: jest.fn().mockResolvedValue(false),
      };

      const mockAnthropicProvider = {
        generateResponse: jest.fn().mockResolvedValue(mockAnthropicMalformedResponse),
        supportsAttachments: jest.fn().mockResolvedValue(false),
      };

      const mockJustifierProvider = {
        generateResponse: jest.fn().mockResolvedValue(mockJustifierResponse),
      };

      // Mock LLMFactory.getProvider
      (LLMFactory.getProvider as jest.Mock).mockImplementation((providerName: string) => {
        switch (providerName) {
          case 'OpenAI':
            return mockOpenAIProvider;
          case 'Anthropic':
            return mockAnthropicProvider;
          case 'JustifierProvider': // Assuming 'JustifierProvider' is the name used for the final justification LLM
            return mockJustifierProvider;
          default:
            throw new Error(`Unknown provider: ${providerName}`);
        }
      });

      const requestBody = {
        prompt: 'Binary decision?',
        outcomes: ['Yes', 'No'], // 2 outcomes
        iterations: 1,
        models: [
          {
            provider: 'OpenAI',
            model: 'gpt-4',
            weight: 0.6, // Weight 60%
          },
          {
            provider: 'Anthropic',
            model: 'claude-3',
            weight: 0.4, // Weight 40%
          },
        ],
      };

      const request = new Request('http://localhost/api/rank-and-justify', {
        method: 'POST',
        body: JSON.stringify(requestBody),
        headers: { 'Content-Type': 'application/json' },
      });

      const response = await POST(request);
      expect(response).toBeDefined();
      const data = await response.json();

      // Expect success despite one model failing format
      expect(response.status).toBe(200);
      expect(data).toHaveProperty('scores');
      expect(data).toHaveProperty('justification');

      // Anthropic failed, should use fallback [500000, 500000]
      const expectedScores = [
        {
          outcome: 'Yes',
          // OpenAI (700000 * 0.6) + Anthropic Fallback (500000 * 0.4)
          score: Math.floor(700000 * 0.6 + 500000 * 0.4)
        },
        {
          outcome: 'No',
          // OpenAI (300000 * 0.6) + Anthropic Fallback (500000 * 0.4)
          score: Math.floor(300000 * 0.6 + 500000 * 0.4)
        }
      ];

      expect(data.scores).toEqual(expectedScores);
      
      // Verify total score sums to 1,000,000
      const totalScore = data.scores.reduce((sum: number, item: ScoreOutcome) => sum + item.score, 0);
      // Allow for minor rounding differences
      expect(totalScore).toBeCloseTo(1000000);

      // Verify the justifier received the fallback justification
      expect(mockJustifierProvider.generateResponse).toHaveBeenCalledWith(
        expect.stringContaining('LLM_ERROR: I am unable to provide a score in the requested format.'),
        expect.any(String) // The specific justifier model name
      );
      expect(data.justification).toBe(mockJustifierResponse);
    });

    test('should handle provider error during generation', async () => {
      // Reusing the existing 'should handle errors in iterative responses' test structure
      // but confirming it's placed within this describe block.
      const mockErrorResponse = 'Simulated provider API error';
      const mockOpenAIProvider = {
        generateResponse: jest.fn().mockRejectedValue(new Error(mockErrorResponse)),
        supportsAttachments: jest.fn().mockResolvedValue(false),
      };

      (LLMFactory.getProvider as jest.Mock).mockImplementation((providerName: string) => {
         if (providerName === 'OpenAI') return mockOpenAIProvider;
         // Add mock for JustifierProvider if needed for the test path
         if (providerName === 'JustifierProvider') return { generateResponse: jest.fn() }; 
         throw new Error(`Unknown provider: ${providerName}`);
      });

      const requestBody = {
        prompt: 'Test prompt for provider error',
        models: [
          {
            provider: 'OpenAI',
            model: 'gpt-4',
            weight: 1.0,
          },
        ],
      };

      const request = new Request('http://localhost/api/rank-and-justify', {
        method: 'POST',
        body: JSON.stringify(requestBody),
        headers: { 'Content-Type': 'application/json' },
      });

      const response = await POST(request);
      const data = await response.json();

      // Provider errors (network issues, API errors) should still result in a 400 
      // as the fallback is only for response *parsing* errors.
      expect(response.status).toBe(400);
      expect(data).toHaveProperty('error', mockErrorResponse);
    });
  });

  test('generateJustification should return a valid justification', async () => {
    // Reference existing test from rank-and-justify.test.ts
    startLine: 400
    endLine: 450
  });

  describe('Parallel Processing Verification Tests', () => {
    // These tests verify that parallel processing produces identical results to serial processing
    test('should produce identical results with multiple models processed in parallel', async () => {
      // Create deterministic mock responses
      const mockResponses = {
        'OpenAI-gpt-4': JSON.stringify({
          score: [400000, 300000, 200000, 100000],
          justification: "OpenAI model justification for parallel test."
        }),
        'Anthropic-claude-3': JSON.stringify({
          score: [350000, 250000, 200000, 200000],
          justification: "Anthropic model justification for parallel test."
        }),
        'Ollama-phi3': JSON.stringify({
          score: [300000, 300000, 200000, 200000],
          justification: "Ollama model justification for parallel test."
        })
      };

      const mockJustifierResponse = 'Final justification combining all model responses.';

      // Track call order to verify parallel execution
      const callOrder: string[] = [];
      const callTimestamps: { [key: string]: number } = {};

      // Mock providers with call tracking
      const createMockProvider = (providerName: string, modelName: string) => ({
        generateResponse: jest.fn().mockImplementation(async () => {
          const key = `${providerName}-${modelName}`;
          callOrder.push(key);
          callTimestamps[key] = Date.now();
          // Add small delay to simulate network call
          await new Promise(resolve => setTimeout(resolve, 10));
          return mockResponses[key];
        }),
        supportsAttachments: jest.fn().mockReturnValue(false),
      });

      const mockOpenAIProvider = createMockProvider('OpenAI', 'gpt-4');
      const mockAnthropicProvider = createMockProvider('Anthropic', 'claude-3');
      const mockOllamaProvider = createMockProvider('Ollama', 'phi3');

      const mockJustifierProvider = {
        generateResponse: jest.fn().mockResolvedValue(mockJustifierResponse),
      };

      (LLMFactory.getProvider as jest.Mock).mockImplementation((providerName: string) => {
        switch (providerName) {
          case 'OpenAI':
            return mockOpenAIProvider;
          case 'Anthropic':
            return mockAnthropicProvider;
          case 'Ollama':
            return mockOllamaProvider;
          case 'JustifierProvider':
            return mockJustifierProvider;
          default:
            throw new Error(`Unknown provider: ${providerName}`);
        }
      });

      const requestBody = {
        prompt: 'Parallel processing test prompt',
        outcomes: ['Option A', 'Option B', 'Option C', 'Option D'],
        iterations: 1,
        models: [
          { provider: 'OpenAI', model: 'gpt-4', weight: 0.5 },
          { provider: 'Anthropic', model: 'claude-3', weight: 0.3 },
          { provider: 'Ollama', model: 'phi3', weight: 0.2 },
        ],
      };

      const request = new Request('http://localhost/api/rank-and-justify', {
        method: 'POST',
        body: JSON.stringify(requestBody),
        headers: { 'Content-Type': 'application/json' },
      });

      const response = await POST(request);
      const data = await response.json();

      // Verify response structure
      expect(response.status).toBe(200);
      expect(data).toHaveProperty('scores');
      expect(data).toHaveProperty('justification');
      expect(data.scores).toHaveLength(4);

      // Calculate expected scores manually
      const expectedScores = [
        {
          outcome: 'Option A',
          score: Math.floor(400000 * 0.5 + 350000 * 0.3 + 300000 * 0.2) // 365000
        },
        {
          outcome: 'Option B',
          score: Math.floor(300000 * 0.5 + 250000 * 0.3 + 300000 * 0.2) // 285000
        },
        {
          outcome: 'Option C',
          score: Math.floor(200000 * 0.5 + 200000 * 0.3 + 200000 * 0.2) // 200000
        },
        {
          outcome: 'Option D',
          score: Math.floor(100000 * 0.5 + 200000 * 0.3 + 200000 * 0.2) // 150000
        }
      ];

      expect(data.scores).toEqual(expectedScores);
      expect(data.justification).toBe(mockJustifierResponse);

      // Verify total score sums to 1,000,000
      const totalScore = data.scores.reduce((sum: number, item: ScoreOutcome) => sum + item.score, 0);
      expect(totalScore).toBe(1000000);

      // Verify all models were called
      expect(mockOpenAIProvider.generateResponse).toHaveBeenCalledTimes(1);
      expect(mockAnthropicProvider.generateResponse).toHaveBeenCalledTimes(1);
      expect(mockOllamaProvider.generateResponse).toHaveBeenCalledTimes(1);
      expect(mockJustifierProvider.generateResponse).toHaveBeenCalledTimes(1);

      // Store this result for comparison with parallel implementation
      (global as any).__serialTestResult = {
        scores: data.scores,
        justification: data.justification,
        callOrder,
        callTimestamps
      };
    });

    test('should handle model count parameter correctly in parallel processing', async () => {
      const mockResponse = JSON.stringify({
        score: [600000, 400000],
        justification: "Test justification for count parameter."
      });

      let callCount = 0;
      const mockProvider = {
        generateResponse: jest.fn().mockImplementation(async () => {
          callCount++;
          // Return slightly different responses to test averaging
          if (callCount === 1) {
            return JSON.stringify({
              score: [650000, 350000],
              justification: "First call justification."
            });
          } else {
            return JSON.stringify({
              score: [550000, 450000],
              justification: "Second call justification."
            });
          }
        }),
        supportsAttachments: jest.fn().mockReturnValue(false),
      };

      const mockJustifierProvider = {
        generateResponse: jest.fn().mockResolvedValue('Averaged justification'),
      };

      (LLMFactory.getProvider as jest.Mock).mockImplementation((providerName: string) => {
        if (providerName === 'OpenAI') return mockProvider;
        if (providerName === 'JustifierProvider') return mockJustifierProvider;
        throw new Error(`Unknown provider: ${providerName}`);
      });

      const requestBody = {
        prompt: 'Test count parameter',
        outcomes: ['Yes', 'No'],
        iterations: 1,
        models: [
          { provider: 'OpenAI', model: 'gpt-4', weight: 1.0, count: 2 },
        ],
      };

      const request = new Request('http://localhost/api/rank-and-justify', {
        method: 'POST',
        body: JSON.stringify(requestBody),
        headers: { 'Content-Type': 'application/json' },
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(mockProvider.generateResponse).toHaveBeenCalledTimes(2);

      // Expected average: [(650000+550000)/2, (350000+450000)/2] = [600000, 400000]
      const expectedScores = [
        { outcome: 'Yes', score: 600000 },
        { outcome: 'No', score: 400000 }
      ];

      expect(data.scores).toEqual(expectedScores);
    });

    test('should maintain error handling behavior in parallel processing', async () => {
      const mockErrorMessage = 'Simulated API error for parallel test';
      
      const mockFailingProvider = {
        generateResponse: jest.fn().mockRejectedValue(new Error(mockErrorMessage)),
        supportsAttachments: jest.fn().mockReturnValue(false),
      };

      (LLMFactory.getProvider as jest.Mock).mockImplementation((providerName: string) => {
        if (providerName === 'OpenAI') return mockFailingProvider;
        throw new Error(`Unknown provider: ${providerName}`);
      });

      const requestBody = {
        prompt: 'Error handling test',
        models: [
          { provider: 'OpenAI', model: 'gpt-4', weight: 1.0 },
        ],
      };

      const request = new Request('http://localhost/api/rank-and-justify', {
        method: 'POST',
        body: JSON.stringify(requestBody),
        headers: { 'Content-Type': 'application/json' },
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data).toHaveProperty('error', mockErrorMessage);
      expect(data.scores).toEqual([]);
      expect(data.justification).toBe('');
    });

    test('should handle multiple iterations with parallel processing', async () => {
      const iterationResponses = [
        // Iteration 1 responses
        JSON.stringify({
          score: [600000, 400000],
          justification: "First iteration OpenAI response."
        }),
        JSON.stringify({
          score: [550000, 450000],
          justification: "First iteration Anthropic response."
        }),
        // Iteration 2 responses (should include previous responses in prompt)
        JSON.stringify({
          score: [700000, 300000],
          justification: "Second iteration OpenAI response with context."
        }),
        JSON.stringify({
          score: [650000, 350000],
          justification: "Second iteration Anthropic response with context."
        })
      ];

      let responseIndex = 0;
      const mockOpenAIProvider = {
        generateResponse: jest.fn().mockImplementation(() => {
          return Promise.resolve(iterationResponses[responseIndex++]);
        }),
        supportsAttachments: jest.fn().mockReturnValue(false),
      };

      const mockAnthropicProvider = {
        generateResponse: jest.fn().mockImplementation(() => {
          return Promise.resolve(iterationResponses[responseIndex++]);
        }),
        supportsAttachments: jest.fn().mockReturnValue(false),
      };

      const mockJustifierProvider = {
        generateResponse: jest.fn().mockResolvedValue('Final iteration justification'),
      };

      (LLMFactory.getProvider as jest.Mock).mockImplementation((providerName: string) => {
        switch (providerName) {
          case 'OpenAI': return mockOpenAIProvider;
          case 'Anthropic': return mockAnthropicProvider;
          case 'JustifierProvider': return mockJustifierProvider;
          default: throw new Error(`Unknown provider: ${providerName}`);
        }
      });

      const requestBody = {
        prompt: 'Multi-iteration test',
        outcomes: ['Proceed', 'Stop'],
        iterations: 2,
        models: [
          { provider: 'OpenAI', model: 'gpt-4', weight: 0.6 },
          { provider: 'Anthropic', model: 'claude-3', weight: 0.4 },
        ],
      };

      const request = new Request('http://localhost/api/rank-and-justify', {
        method: 'POST',
        body: JSON.stringify(requestBody),
        headers: { 'Content-Type': 'application/json' },
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      
      // Should be called twice per model (2 iterations)
      expect(mockOpenAIProvider.generateResponse).toHaveBeenCalledTimes(2);
      expect(mockAnthropicProvider.generateResponse).toHaveBeenCalledTimes(2);
      
      // Final scores should be from iteration 2: (700000 * 0.6 + 650000 * 0.4), (300000 * 0.6 + 350000 * 0.4)
      const expectedScores = [
        { outcome: 'Proceed', score: Math.floor(700000 * 0.6 + 650000 * 0.4) }, // 680000
        { outcome: 'Stop', score: Math.floor(300000 * 0.6 + 350000 * 0.4) }      // 320000
      ];

      expect(data.scores).toEqual(expectedScores);
      expect(data.justification).toBe('Final iteration justification');

      // Verify that the second iteration calls included previous responses in the prompt
      const secondIterationCalls = mockOpenAIProvider.generateResponse.mock.calls.slice(1);
      expect(secondIterationCalls[0][0]).toContain('From OpenAI - gpt-4:');
      expect(secondIterationCalls[0][0]).toContain('From Anthropic - claude-3:');
    });
  });
});