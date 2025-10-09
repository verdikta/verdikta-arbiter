// src/__tests__/handlers/evaluateHandler.test.js

// Mock external dependencies
jest.mock('../../services/aiClient');

// Create shared mock services
const mockServices = {
  archiveService: {
    getArchive: jest.fn(),
    extractArchive: jest.fn(),
    validateManifest: jest.fn(),
    processMultipleCIDs: jest.fn(),
    cleanup: jest.fn()
  },
  ipfsClient: {
    uploadToIPFS: jest.fn()
  },
  manifestParser: {
    parse: jest.fn(),
    parseMultipleManifests: jest.fn(),
    constructCombinedQuery: jest.fn()
  },
  validator: {
    validateRequest: jest.fn()
  },
  logger: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn()
  }
};

// Mock @verdikta/common package
jest.mock('@verdikta/common', () => ({
  createClient: jest.fn(() => mockServices),
  validateRequest: jest.fn().mockResolvedValue(true),
  requestSchema: {}
}));
jest.mock('unzipper', () => ({
  Open: {
    file: jest.fn()
  }
}));
jest.mock('fs', () => ({
  promises: {
    mkdtemp: jest.fn().mockResolvedValue('/tmp/test'),
    writeFile: jest.fn().mockResolvedValue(undefined),
    rm: jest.fn().mockResolvedValue(undefined)
  },
  existsSync: jest.fn().mockReturnValue(true),
  mkdirSync: jest.fn(),
  createWriteStream: jest.fn().mockReturnValue({ 
    on: jest.fn(),
    write: jest.fn(),
    end: jest.fn()
  }),
  stat: jest.fn((path, callback) => callback(null, {
    isFile: () => true,
    size: 12345
  }))
}));

const evaluateHandler = require('../../handlers/evaluateHandler');
const { createClient, validateRequest } = require('@verdikta/common');
const aiClient = require('../../services/aiClient');
const fs = require('fs').promises;

// Get the mocked services from the shared mock
const { archiveService, ipfsClient, manifestParser, validator, logger } = mockServices;

describe('evaluateHandler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    
    // Mock successful validation by default
    validateRequest.mockResolvedValue(true);
    
    // Mock cleanup by default
    archiveService.cleanup.mockResolvedValue(true);
  });

  it('should handle errors appropriately', async () => {
    const request = {
      id: '1',
      data: { cid: 'QmTestaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }
    };

    // Mock the error
    archiveService.getArchive.mockRejectedValue(new Error('Test error'));
    archiveService.cleanup.mockResolvedValue(true);

    const result = await evaluateHandler(request);

    expect(result).toEqual({
      jobRunID: '1',
      status: 'errored',
      statusCode: 500,
      error: 'Test error',
      data: {
        aggregatedScore: [0],
        error: 'Test error',
        justification: ''
      }
    });
  });

  it('should handle IPFS upload errors', async () => {
    const request = {
      id: '1',
      data: { cid: 'QmTestaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }
    };

    // Mock successful archive retrieval and extraction
    archiveService.getArchive.mockResolvedValue(Buffer.from('test'));
    archiveService.extractArchive.mockResolvedValue('/tmp/test');
    archiveService.validateManifest.mockResolvedValue(true);
    archiveService.cleanup.mockResolvedValue(true);

    // Mock successful manifest parsing with outcomes
    manifestParser.parse.mockResolvedValue({
      prompt: 'Test query',
      models: [{
        provider: 'OpenAI',
        model: 'gpt-4',
        weight: 1.0,
        count: 1
      }],
      iterations: 1,
      outcomes: ['True', 'False']
    });

    // Mock successful AI evaluation with new scores format
    aiClient.evaluate.mockResolvedValue({
      scores: [
        { outcome: 'True', score: 0.8 },
        { outcome: 'False', score: 0.2 }
      ],
      justification: 'test justification'
    });

    // Mock IPFS upload failure
    ipfsClient.uploadToIPFS.mockRejectedValue(new Error('IPFS upload failed'));

    const result = await evaluateHandler(request);

    expect(result).toEqual({
      jobRunID: '1',
      status: 'errored',
      statusCode: 500,
      error: 'IPFS upload failed',
      data: {
        aggregatedScore: [0],
        error: 'IPFS upload failed',
        justification: ''
      }
    });
  });

  it('should handle successful evaluation with outcomes', async () => {
    const request = {
      id: '1',
      data: { cid: 'QmTestaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }
    };

    // Mock successful archive retrieval and extraction
    archiveService.getArchive.mockResolvedValue(Buffer.from('test'));
    archiveService.extractArchive.mockResolvedValue('/tmp/test');
    archiveService.validateManifest.mockResolvedValue(true);
    archiveService.cleanup.mockResolvedValue(true);

    // Mock successful manifest parsing with outcomes
    manifestParser.parse.mockResolvedValue({
      prompt: 'Test query',
      models: [{
        provider: 'OpenAI',
        model: 'gpt-4',
        weight: 1.0,
        count: 1
      }],
      iterations: 1,
      outcomes: ['True', 'False']
    });

    // Mock successful AI evaluation with new scores format
    const mockScores = [
      { outcome: 'True', score: 0.8 },
      { outcome: 'False', score: 0.2 }
    ];
    aiClient.evaluate.mockResolvedValue({
      scores: mockScores,
      justification: 'test justification'
    });

    // Mock successful IPFS upload
    ipfsClient.uploadToIPFS.mockResolvedValue('QmTestJustification');

    const result = await evaluateHandler(request);

    expect(result).toEqual({
      jobRunID: '1',
      status: 'success',
      statusCode: 200,
      data: {
        aggregatedScore: mockScores.map(s => s.score),
        justificationCid: 'QmTestJustification'
      }
    });

    // Verify the justification content
    expect(fs.writeFile).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String)
    );
    
    // Get the justification content from the mock call
    const writeFileArgs = fs.writeFile.mock.calls[0];
    const justificationContent = JSON.parse(writeFileArgs[1]);
    
    expect(justificationContent).toEqual({
      scores: mockScores,
      justification: 'test justification',
      timestamp: expect.any(String)
    });
  });

  it('should handle provider errors with new scores format', async () => {
    const request = {
      id: '1',
      data: { cid: 'QmTestaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }
    };

    // Mock successful archive retrieval and extraction
    archiveService.getArchive.mockResolvedValue(Buffer.from('test'));
    archiveService.extractArchive.mockResolvedValue('/tmp/test');
    archiveService.validateManifest.mockResolvedValue(true);
    archiveService.cleanup.mockResolvedValue(true);

    // Mock successful manifest parsing
    manifestParser.parse.mockResolvedValue({
      prompt: 'Test query',
      models: [{
        provider: 'OpenAI',
        model: 'gpt-4',
        weight: 1.0,
        count: 1
      }],
      iterations: 1
    });

    // Mock AI evaluation with provider error
    const providerError = new Error('PROVIDER_ERROR: Model not available');
    aiClient.evaluate.mockRejectedValue(providerError);

    // Mock successful IPFS upload for error justification
    ipfsClient.uploadToIPFS.mockResolvedValue('QmTestErrorJustification');

    const result = await evaluateHandler(request);

    expect(result).toEqual({
      jobRunID: '1',
      statusCode: 200,
      data: {
        aggregatedScore: [0],
        justification: '',
        error: 'Model not available',
        justificationCid: 'QmTestErrorJustification'
      }
    });

    // Verify the error justification content
    expect(fs.writeFile).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String)
    );
    
    // Get the justification content from the mock call
    const writeFileArgs = fs.writeFile.mock.calls[0];
    const justificationContent = JSON.parse(writeFileArgs[1]);
    
    expect(justificationContent).toEqual({
      scores: [{outcome: 'error', score: 0}],
      justification: '',
      error: 'Model not available',
      timestamp: expect.any(String)
    });
  });
}); 