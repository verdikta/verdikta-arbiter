// Mock 'fs' before requiring modules that use it
jest.mock('fs', () => ({
  existsSync: jest.fn().mockReturnValue(true),
  readFileSync: jest.fn().mockImplementation((filePath) => {
    // Return same content as readFile to maintain consistency
    if (filePath.includes('manifest.json')) {
      return JSON.stringify({
        version: "1.0",
        juryParameters: { NUMBER_OF_OUTCOMES: 2 }
      });
    }
    return '{}';
  }),
  promises: {
    readFile: jest.fn(),
    writeFile: jest.fn().mockResolvedValue(undefined)
  }
}));

// Mock winston to prevent file logging
jest.mock('winston', () => {
  const mockFormat = {
    combine: jest.fn().mockReturnValue({}),
    timestamp: jest.fn().mockReturnValue({}),
    json: jest.fn().mockReturnValue({}),
    colorize: jest.fn().mockReturnValue({}),
    simple: jest.fn().mockReturnValue({})
  };
  
  const mockLogger = {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn()
  };
  
  return {
    format: mockFormat,
    createLogger: jest.fn().mockReturnValue(mockLogger),
    transports: {
      Console: jest.fn(),
      File: jest.fn()
    }
  };
});

jest.mock('../../services/ipfsClient', () => ({
  fetchFromIPFS: jest.fn()
}));

const fs = require('fs').promises;
const path = require('path');
const manifestParser = require('../../utils/manifestParser');
const ipfsClient = require('../../services/ipfsClient');

describe('ManifestParser', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    // Set up fs.promises.readFile mock with default data
    fs.readFile.mockImplementation((filePath) => {
      const baseManifest = {
        version: "1.0",
        primary: {
          filename: "primary_query.json"
        },
        juryParameters: {
          NUMBER_OF_OUTCOMES: 2,
          AI_NODES: [
            {
              AI_MODEL: "GPT-4",
              AI_PROVIDER: "OpenAI",
              NO_COUNTS: 3,
              WEIGHT: 1.0
            }
          ],
          ITERATIONS: 1
        }
      };

      const primaryData = {
        query: "Is this test working?",
        references: ["testFile"]
      };

      if (filePath === path.join('/mock/path', 'manifest.json')) {
        return Promise.resolve(JSON.stringify(baseManifest));
      } else if (filePath === path.join('/mock/path', 'primary_query.json')) {
        return Promise.resolve(JSON.stringify(primaryData));
      }

      return Promise.reject(new Error(`Unexpected file path: ${filePath}`));
    });
  });

  it('should parse manifest and primary file correctly', async () => {
    const result = await manifestParser.parse('/mock/path');

    expect(result).toEqual({
      prompt: 'Is this test working?',
      models: [{
        provider: 'OpenAI',
        model: 'GPT-4',
        weight: 1.0,
        count: 3
      }],
      iterations: 1,
      outcomes: ['outcome1', 'outcome2'],
      name: undefined,
      addendum: undefined,
      bCIDs: undefined,
      references: ['testFile']
    });
  });

  it('should parse manifest with multiple AI models correctly', async () => {
    // Modify the mock to include multiple AI models
    fs.readFile.mockImplementation((filePath) => {
      const manifestData = JSON.stringify({
        version: "1.0",
        primary: {
          filename: "primary_query.json"
        },
        juryParameters: {
          NUMBER_OF_OUTCOMES: 3,
          AI_NODES: [
            {
              AI_MODEL: "GPT-4",
              AI_PROVIDER: "OpenAI",
              NO_COUNTS: 2,
              WEIGHT: 0.7
            },
            {
              AI_MODEL: "BERT",
              AI_PROVIDER: "Google",
              NO_COUNTS: 1,
              WEIGHT: 0.3
            }
          ],
          ITERATIONS: 2
        }
      });

      const primaryData = JSON.stringify({
        query: "Analyze the following code for potential improvements.",
        references: ["codeSample"]
      });

      if (filePath === path.join('/mock/path', 'manifest.json')) {
        return Promise.resolve(manifestData);
      } else if (filePath === path.join('/mock/path', 'primary_query.json')) {
        return Promise.resolve(primaryData);
      }

      return Promise.reject(new Error(`Unexpected file path: ${filePath}`));
    });

    const result = await manifestParser.parse('/mock/path');

    expect(result).toEqual({
      prompt: 'Analyze the following code for potential improvements.',
      models: [
        {
          provider: 'OpenAI',
          model: 'GPT-4',
          weight: 0.7,
          count: 2
        },
        {
          provider: 'Google',
          model: 'BERT',
          weight: 0.3,
          count: 1
        }
      ],
      iterations: 2,
      outcomes: ['outcome1', 'outcome2'],
      name: undefined,
      addendum: undefined,
      bCIDs: undefined,
      references: ['codeSample']
    });
  });

  it('should parse manifest with additional and support sections correctly', async () => {
    // Mock IPFS client response
    const mockSupportContent = Buffer.from('Support file content');
    ipfsClient.fetchFromIPFS.mockResolvedValue(mockSupportContent);

    // Modify the mock to include additional and support sections
    fs.readFile.mockImplementation((filePath) => {
      const manifestData = JSON.stringify({
        version: "1.0",
        primary: {
          filename: "primary_query.json"
        },
        additional: [
          {
            name: "transcript",
            type: "UTF8",
            filename: "transcript.txt"
          }
        ],
        support: [
          {
            hash: {
              cid: "bafybeid7yg3zb76beig63l3x7lxn6kyxyf4gwczp6xkjnju6spj3k2ry6q",
              description: "Support file",
              id: 1234567890
            }
          }
        ],
        juryParameters: {
          NUMBER_OF_OUTCOMES: 3,
          AI_NODES: [
            {
              AI_MODEL: "Whisper",
              AI_PROVIDER: "OpenAI",
              NO_COUNTS: 5,
              WEIGHT: 0.8
            },
            {
              AI_MODEL: "DeepSpeech",
              AI_PROVIDER: "Mozilla",
              NO_COUNTS: 2,
              WEIGHT: 0.2
            }
          ],
          ITERATIONS: 2
        }
      });

      const primaryData = JSON.stringify({
        query: "Transcribe the provided audio file and determine the speaker\'s sentiment (Positive, Neutral, Negative).",
        references: ["audioFile"]
      });

      if (filePath === path.join('/mock/path', 'manifest.json')) {
        return Promise.resolve(manifestData);
      } else if (filePath === path.join('/mock/path', 'primary_query.json')) {
        return Promise.resolve(primaryData);
      } else if (filePath === path.join('/mock/path', 'transcript.txt')) {
        return Promise.resolve('Sample transcript content.');
      }

      return Promise.reject(new Error(`Unexpected file path: ${filePath}`));
    });

    const result = await manifestParser.parse('/mock/path');

    expect(result).toEqual({
      prompt: 'Transcribe the provided audio file and determine the speaker\'s sentiment (Positive, Neutral, Negative).',
      models: [
        {
          provider: 'OpenAI',
          model: 'Whisper',
          weight: 0.8,
          count: 5
        },
        {
          provider: 'Mozilla',
          model: 'DeepSpeech',
          weight: 0.2,
          count: 2
        }
      ],
      iterations: 2,
      outcomes: ['outcome1', 'outcome2'],
      name: undefined,
      addendum: undefined,
      bCIDs: undefined,
      references: ['audioFile'],
      support: [
        {
          description: undefined,
          hash: {
            cid: 'bafybeid7yg3zb76beig63l3x7lxn6kyxyf4gwczp6xkjnju6spj3k2ry6q',
            description: 'Support file',
            id: 1234567890
          },
          path: '/mock/path/support_bafybeid7yg3zb76beig63l3x7lxn6kyxyf4gwczp6xkjnju6spj3k2ry6q',
          name: undefined
        }
      ],
      additional: [
        {
          name: 'transcript',
          filename: 'transcript.txt',
          type: 'UTF8',
          path: '/mock/path/transcript.txt'
        }
      ]
    });

    // Verify IPFS client calls
    expect(ipfsClient.fetchFromIPFS).toHaveBeenCalledWith('bafybeid7yg3zb76beig63l3x7lxn6kyxyf4gwczp6xkjnju6spj3k2ry6q');

    // Verify files were written
    expect(fs.writeFile).toHaveBeenCalledWith(
      expect.stringContaining('support_bafybeid7yg3zb76beig63l3x7lxn6kyxyf4gwczp6xkjnju6spj3k2ry6q'),
      mockSupportContent
    );
  });

  it('should throw error when primary file is missing both filename and hash', async () => {
    // Modify the mock to provide both filename and hash (which should not happen)
    fs.readFile.mockImplementation((filePath) => {
      const manifestData = JSON.stringify({
        version: "1.0",
        primary: {
          filename: "primary_query.json",
          hash: "somehashvalue"
        },
        juryParameters: {
          NUMBER_OF_OUTCOMES: 2,
          AI_NODES: [
            {
              AI_MODEL: "GPT-4",
              AI_PROVIDER: "OpenAI",
              NO_COUNTS: 3,
              WEIGHT: 1.0
            }
          ],
          ITERATIONS: 1
        }
      });

      const primaryData = JSON.stringify({
        query: "Is this test working?",
        references: ["testFile"]
      });

      if (filePath === path.join('/mock/path', 'manifest.json')) {
        return Promise.resolve(manifestData);
      } else if (filePath === path.join('/mock/path', 'primary_query.json')) {
        return Promise.resolve(primaryData);
      }

      return Promise.reject(new Error(`Unexpected file path: ${filePath}`));
    });

    await expect(manifestParser.parse('/mock/path'))
      .rejects
      .toThrow('Invalid manifest: primary must have either "filename" or "hash", but not both');
  });

  it('should throw error when QUERY is missing in primary content', async () => {
    // Modify the mock to have primary content without QUERY
    fs.readFile.mockImplementation((filePath) => {
      const manifestData = JSON.stringify({
        version: "1.0",
        primary: {
          filename: "primary_query.json"
        },
        juryParameters: {
          NUMBER_OF_OUTCOMES: 2,
          AI_NODES: [
            {
              AI_MODEL: "GPT-4",
              AI_PROVIDER: "OpenAI",
              NO_COUNTS: 3,
              WEIGHT: 1.0
            }
          ],
          ITERATIONS: 1
        }
      });

      const primaryData = JSON.stringify({
        references: ["testFileOnly"]
      });

      if (filePath === path.join('/mock/path', 'manifest.json')) {
        return Promise.resolve(manifestData);
      } else if (filePath === path.join('/mock/path', 'primary_query.json')) {
        return Promise.resolve(primaryData);
      }

      return Promise.reject(new Error(`Unexpected file path: ${filePath}`));
    });

    await expect(manifestParser.parse('/mock/path'))
      .rejects
      .toThrow('No QUERY found in primary file');
  });

  it('should throw error for invalid JSON in manifest', async () => {
    // Modify the mock to return invalid JSON
    fs.readFile.mockImplementation((filePath) => {
      if (filePath === path.join('/mock/path', 'manifest.json')) {
        return Promise.resolve('invalid json');
      } else if (filePath === path.join('/mock/path', 'primary_query.json')) {
        return Promise.resolve(JSON.stringify({
          query: "Is this test working?",
          references: ["testFile"]
        }));
      }
      return Promise.reject(new Error(`Unexpected file path: ${filePath}`));
    });

    await expect(manifestParser.parse('/mock/path'))
      .rejects
      .toThrow('Invalid JSON in manifest file');
  });

  it('should throw error for missing required fields in manifest', async () => {
    // Modify the mock to omit required fields
    fs.readFile.mockImplementation((filePath) => {
      const incompleteManifest = JSON.stringify({
        version: "1.0"
        // Missing "primary" field
      });

      if (filePath === path.join('/mock/path', 'manifest.json')) {
        return Promise.resolve(incompleteManifest);
      }
      return Promise.reject(new Error(`Unexpected file path: ${filePath}`));
    });

    await expect(manifestParser.parse('/mock/path'))
      .rejects
      .toThrow('Invalid manifest: missing required fields "version" or "primary"');
  });

  it('should handle CID references in manifest correctly', async () => {
    // Mock IPFS client response
    const mockSupportContent = Buffer.from('Support file content');
    const mockPrimaryContent = Buffer.from(JSON.stringify({
      query: "Test query with CID reference",
      references: []
    }));

    ipfsClient.fetchFromIPFS
      .mockImplementation((cid) => {
        if (cid === 'QmPrimaryTestCID') {
          return Promise.resolve(mockPrimaryContent);
        } else if (cid === 'QmSupportTestCID') {
          return Promise.resolve(mockSupportContent);
        }
        return Promise.reject(new Error(`Unexpected CID: ${cid}`));
      });

    // Modify the mock to include CID references
    fs.readFile.mockImplementation((filePath) => {
      if (filePath === path.join('/mock/path', 'manifest.json')) {
        const manifestData = {
          version: "1.0",
          primary: {
            hash: "QmPrimaryTestCID"
          },
          support: [
            {
              hash: {
                cid: "QmSupportTestCID",
                description: "Support file",
                id: 1234567890
              }
            }
          ],
          juryParameters: {
            NUMBER_OF_OUTCOMES: 2,
            AI_NODES: [
              {
                AI_MODEL: "gpt-4",
                AI_PROVIDER: "OpenAI",
                NO_COUNTS: 1,
                WEIGHT: 1
              }
            ],
            ITERATIONS: 1
          }
        };
        return Promise.resolve(JSON.stringify(manifestData));
      }
      return Promise.reject(new Error(`Unexpected file path: ${filePath}`));
    });

    const result = await manifestParser.parse('/mock/path');

    // Verify the result
    expect(result).toMatchObject({
      prompt: "Test query with CID reference",
      models: [{
        provider: 'OpenAI',
        model: 'gpt-4',
        weight: 1,
        count: 1
      }],
      iterations: 1,
      outcomes: ['outcome1', 'outcome2'],
      support: [{
        hash: {
          cid: "QmSupportTestCID",
          description: "Support file",
          id: 1234567890
        },
        path: expect.stringContaining('support_QmSupportTestCID')
      }]
    });

    // Verify IPFS client calls
    expect(ipfsClient.fetchFromIPFS).toHaveBeenCalledWith('QmPrimaryTestCID');
    expect(ipfsClient.fetchFromIPFS).toHaveBeenCalledWith('QmSupportTestCID');

    // Verify files were written
    expect(fs.writeFile).toHaveBeenCalledWith(
      expect.stringContaining('primary_QmPrimaryTestCID'),
      mockPrimaryContent
    );
    expect(fs.writeFile).toHaveBeenCalledWith(
      expect.stringContaining('support_QmSupportTestCID'),
      mockSupportContent
    );
  });
});
