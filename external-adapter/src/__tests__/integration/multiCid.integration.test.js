const path = require('path');
const evaluateHandler = require('../../handlers/evaluateHandler');

// Use real CIDs that were uploaded to IPFS
const PRIMARY_CID = 'Qmc4ZQoShjPJHh6UGCoMSYC2BaHVXcWCZJ5VqEdsz7jZZq';
const PLAINTIFF_CID = 'QmNkkkb4LMDKWCjz5jdAZLKHNgUJsyWzvNEKuqSTJ8EZ52';
const DEFENDANT_CID = 'Qme7Hpfz5UScy5eLx88VvwZL5ga2K8k3NonzogzmE3ejhQ';
const STANDALONE_CID = 'QmSnynnZVufbeb9GVNLBjxBJ45FyHgjPYUHTvMK5VmQZcS';

describe('Multi-CID Integration Tests', () => {
  const originalTestMode = process.env.TEST_MODE;
  
  beforeAll(() => {
    // Set TEST_MODE to true to use mock data instead of real AI service
    process.env.TEST_MODE = 'true';
    
    // Set longer timeout for tests that make real IPFS calls
    jest.setTimeout(120000); // 2 minutes
  });
  
  afterAll(() => {
    // Restore environment variables
    process.env.TEST_MODE = originalTestMode;
  });

  it('should process multiple CIDs with addendum', async () => {
    const addendumValue = '2,127.50'; // Current ETH price addendum
    const request = {
      id: 'test-multi-cid',
      data: { 
        cid: `${PRIMARY_CID},${PLAINTIFF_CID},${DEFENDANT_CID}:${addendumValue}` 
      }
    };

    const result = await evaluateHandler(request);

    // Verify the response
    expect(result).toHaveProperty('jobRunID', 'test-multi-cid');
    expect(result).toHaveProperty('statusCode', 200);
    expect(result.data).toHaveProperty('aggregatedScore');
    expect(Array.isArray(result.data.aggregatedScore)).toBe(true);
    expect(result.data).toHaveProperty('justificationCID');
  }, 120000); // Extend timeout to 2 minutes

  it('should process single CID for backward compatibility', async () => {
    const request = {
      id: 'test-single-cid',
      data: { 
        cid: STANDALONE_CID  // Use a standalone CID with no bCID dependencies
      }
    };

    const result = await evaluateHandler(request);

    // Verify the response for backward compatibility
    expect(result).toHaveProperty('jobRunID', 'test-single-cid');
    expect(result).toHaveProperty('statusCode', 200);
    expect(result.data).toHaveProperty('aggregatedScore');
    expect(Array.isArray(result.data.aggregatedScore)).toBe(true);
    expect(result.data).toHaveProperty('justificationCID');
  }, 60000); // Extend timeout to 1 minute
}); 