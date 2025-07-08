const path = require('path');
const evaluateHandler = require('../../handlers/evaluateHandler');
const aiClient = require('../../services/aiClient');

// Use the real 'fs' module but mock specific operations
jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  promises: {
    ...jest.requireActual('fs').promises,
    mkdtemp: jest.fn().mockResolvedValue('/tmp/mock'),
    // Keep actual file operations for integration testing
    writeFile: jest.requireActual('fs').promises.writeFile,
    mkdir: jest.requireActual('fs').promises.mkdir
  }
}));

// archiveService is now from @verdikta/common (no longer needs unmocking)

describe('EvaluateHandler Integration', () => {
  const originalTestMode = process.env.TEST_MODE;
  const FIXTURES_DIR = path.join(__dirname, 'fixtures');

  beforeEach(() => {
    // Force TEST_MODE to false for this specific integration test
    jest.resetModules(); // Clear module cache
    process.env.TEST_MODE = 'false';
    // archiveService is now from @verdikta/common (no longer needs local re-require)
  });

  afterEach(() => {
    // Restore original TEST_MODE
    process.env.TEST_MODE = originalTestMode;
  });

  it('should process a basic archive successfully', async () => {
    const request = {
      id: 'test-basic',
      data: { cid: 'QmcMjSr4pL8dpNzjhGWaZ6vRmvv7fN3xsLJCDpqVsH7gv7' }
    };

    const result = await evaluateHandler(request);

    expect(result).toHaveProperty('jobRunID', 'test-basic');
    expect(result).toHaveProperty('statusCode', 200);
    expect(result.data).toHaveProperty('aggregatedScore');
    expect(Array.isArray(result.data.aggregatedScore)).toBe(true);
    expect(result.data.aggregatedScore.length).toBeGreaterThan(0);
  }, 60000); // Increased timeout to 60s

  it('should process an archive with a local image file', async () => {
    const request = {
      id: 'test-local-image',
      data: { cid: 'QmXYCQeM9vfFxV5dobNN7krbhDzwwx3Vj7ETuKUsrzPwWA' }
    };

    const result = await evaluateHandler(request);

    expect(result).toHaveProperty('jobRunID', 'test-local-image');
    expect(result).toHaveProperty('statusCode', 200);
    expect(result.data).toHaveProperty('aggregatedScore');
    expect(Array.isArray(result.data.aggregatedScore)).toBe(true);
    expect(result.data.justificationCID).toBeDefined();
  }, 60000); // Increased timeout to 60s

  it('should process an archive with multiple images', async () => {
    const request = {
      id: 'test-multiple-images',
      data: { cid: 'QmY8Lg9C1Sz5peUFfR56awP6ZH5WrWAyy8zPkvodcBqbjn' }
    };

    const result = await evaluateHandler(request);

    expect(result).toHaveProperty('jobRunID', 'test-multiple-images');
    expect(result).toHaveProperty('statusCode', 200);
    expect(result.data).toHaveProperty('aggregatedScore');
    expect(Array.isArray(result.data.aggregatedScore)).toBe(true);
    expect(result.data.justificationCID).toBeDefined();
  }, 60000); // Increased timeout for multiple images

  it('should process an archive with IPFS file references', async () => {
    const request = {
      id: 'test-ipfs-refs',
      data: { cid: 'QmZZN9xHG1Q8RFZSV7WvHAA8YPXeqrKTdEyb2rb6jazba1' }
    };

    const result = await evaluateHandler(request);

    // For IPFS file references, we expect a 500 status code if the manifest validation fails
    if (result.statusCode === 500) {
      expect(result.error).toContain('Manifest validation failed');
    } else {
      expect(result).toHaveProperty('statusCode', 200);
      expect(result.data).toHaveProperty('aggregatedScore');
      expect(Array.isArray(result.data.aggregatedScore)).toBe(true);
      expect(result.data.justificationCID).toBeDefined();
    }
  }, 60000); // Increased timeout for IPFS operations

  it('should handle provider errors gracefully', async () => {
    const request = {
      id: 'test-provider-error',
      data: { cid: 'QmcMjSr4pL8dpNzjhGWaZ6vRmvv7fN3xsLJCDpqVsH7gv7' }
    };

    // Mock only the AI evaluation to simulate a provider error
    const originalEvaluate = aiClient.evaluate;
    aiClient.evaluate = jest.fn().mockRejectedValue(
      new Error('PROVIDER_ERROR: AI model capacity exceeded')
    );

    const result = await evaluateHandler(request);

    // Restore original evaluate function
    aiClient.evaluate = originalEvaluate;

    expect(result).toMatchObject({
      jobRunID: 'test-provider-error',
      statusCode: 200,
      data: {
        aggregatedScore: [0],
        error: 'AI model capacity exceeded',
        justification: ''
      }
    });
  }, 30000);
});
