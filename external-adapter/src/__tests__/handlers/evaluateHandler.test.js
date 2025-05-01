// src/__tests__/handlers/evaluateHandler.test.js

// Mock all external dependencies
jest.mock('../../services/archiveService');
jest.mock('../../services/aiClient');
jest.mock('../../services/ipfsClient');
jest.mock('../../utils/manifestParser');
jest.mock('../../utils/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn()
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
const archiveService = require('../../services/archiveService');
const aiClient = require('../../services/aiClient');
const ipfsClient = require('../../services/ipfsClient');
const manifestParser = require('../../utils/manifestParser');
const fs = require('fs').promises;

describe('evaluateHandler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should handle errors appropriately', async () => {
    const request = {
      id: '1',
      data: { cid: 'QmTest' }
    };

    // Mock the error
    archiveService.getArchive.mockRejectedValue(new Error('Test error'));

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
      data: { cid: 'QmTest' }
    };

    // Mock successful archive retrieval and extraction
    archiveService.getArchive.mockResolvedValue(Buffer.from('test'));
    archiveService.extractArchive.mockResolvedValue('/tmp/test');
    archiveService.validateManifest.mockResolvedValue(true);

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
      data: { cid: 'QmTest' }
    };

    // Mock successful archive retrieval and extraction
    archiveService.getArchive.mockResolvedValue(Buffer.from('test'));
    archiveService.extractArchive.mockResolvedValue('/tmp/test');
    archiveService.validateManifest.mockResolvedValue(true);

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
        justificationCID: 'QmTestJustification'
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
      data: { cid: 'QmTest' }
    };

    // Mock successful archive retrieval and extraction
    archiveService.getArchive.mockResolvedValue(Buffer.from('test'));
    archiveService.extractArchive.mockResolvedValue('/tmp/test');
    archiveService.validateManifest.mockResolvedValue(true);

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
        justificationCID: 'QmTestErrorJustification'
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