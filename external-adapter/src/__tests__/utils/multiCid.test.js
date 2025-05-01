const path = require('path');
const manifestParser = require('../../utils/manifestParser');
const logger = require('../../utils/logger');

// Mock logger
jest.mock('../../utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
}));

// Create test data
const mockPrimaryManifest = {
  name: "Dispute over Eth price",
  prompt: "There are two parties in a dispute. The plaintiff will make a case, then the defendant. You must choose which party is correct after weighing all of the data.",
  references: [],
  outcomes: ["Plaintiff", "Defendant"],
  models: [{ provider: 'OpenAI', model: 'gpt-4', weight: 0.7, count: 2 }],
  iterations: 1,
  bCIDs: {
    plaintiffComplaint: "the dispute launched by client X",
    defendantRebuttal: "Rebuttal by vendor Y"
  },
  addendum: "The price of Ethereum at the time of the dispute"
};

const mockPlaintiffManifest = {
  name: "plaintiffComplaint",
  prompt: "You can tell from the transcript that I clearly told the defendant that I would only purchase 10 ETH from him if the price fell below $2000 by March 1, 2025",
  references: ["argument-transcript"],
  additional: [
    {
      name: "argument-transcript",
      type: "UTF8",
      filename: "transcript.txt",
      path: "/tmp/extract/plaintiff/transcript.txt"
    }
  ]
};

const mockDefendantManifest = {
  name: "defendantRebuttal",
  prompt: "Once you review the emails you will see that the Plaintiff agreed to purchase 10 ETH from me and though we discussed price fluctuation the price was not part of the agreement.",
  references: ["emails-with-plaintiff"],
  additional: [
    {
      name: "emails-with-plaintiff",
      type: "UTF8",
      filename: "emails.txt",
      path: "/tmp/extract/defendant/emails.txt"
    }
  ]
};

describe('Multi-CID Functionality', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    
    // Mock the manifestParser.parse method directly
    manifestParser.parse = jest.fn().mockImplementation((extractedPath) => {
      if (extractedPath.includes('primary')) {
        return Promise.resolve(mockPrimaryManifest);
      } else if (extractedPath.includes('plaintiff')) {
        return Promise.resolve(mockPlaintiffManifest);
      } else if (extractedPath.includes('defendant')) {
        return Promise.resolve(mockDefendantManifest);
      }
      return Promise.reject(new Error(`Mock not found for path: ${extractedPath}`));
    });
    
    // Restore the original parseMultipleManifests and constructCombinedQuery methods
    const original = jest.requireActual('../../utils/manifestParser');
    manifestParser.parseMultipleManifests = original.parseMultipleManifests;
    manifestParser.constructCombinedQuery = original.constructCombinedQuery;
  });
  
  test('parseMultipleManifests should process primary and bCID manifests', async () => {
    const extractedPaths = {
      'primary-cid': '/tmp/extract/primary',
      'plaintiff-cid': '/tmp/extract/plaintiff',
      'defendant-cid': '/tmp/extract/defendant'
    };
    
    const cidOrder = ['primary-cid', 'plaintiff-cid', 'defendant-cid'];
    
    const result = await manifestParser.parseMultipleManifests(extractedPaths, cidOrder);
    
    expect(result).toHaveProperty('primaryManifest');
    expect(result).toHaveProperty('bCIDManifests');
    expect(result.bCIDManifests.length).toBe(2);
    expect(result.primaryManifest.name).toBe(mockPrimaryManifest.name);
    expect(result.bCIDManifests[0].expectedName).toBe('plaintiffComplaint');
    expect(result.bCIDManifests[1].expectedName).toBe('defendantRebuttal');
  });
  
  test('constructCombinedQuery should create a properly formatted query', async () => {
    const bCIDManifests = [
      {
        expectedName: 'plaintiffComplaint',
        manifest: mockPlaintiffManifest
      },
      {
        expectedName: 'defendantRebuttal',
        manifest: mockDefendantManifest
      }
    ];
    
    const addendumString = '2,009.67';
    
    const combinedQuery = manifestParser.constructCombinedQuery(
      mockPrimaryManifest,
      bCIDManifests,
      addendumString
    );
    
    // Check that the combined query contains all parts
    expect(combinedQuery.prompt).toContain("There are two parties in a dispute");
    expect(combinedQuery.prompt).toContain("You can tell from the transcript");
    expect(combinedQuery.prompt).toContain("Once you review the emails");
    expect(combinedQuery.prompt).toContain('dispute launched by client X');
    expect(combinedQuery.prompt).toContain('Rebuttal by vendor Y');
    expect(combinedQuery.prompt).toContain('Addendum:');
    expect(combinedQuery.prompt).toContain('2,009.67');
    
    // Check that references are combined correctly
    expect(combinedQuery.references).toContain('argument-transcript');
    expect(combinedQuery.references).toContain('emails-with-plaintiff');
    
    // Check that outcomes are preserved from primary manifest
    expect(combinedQuery.outcomes).toEqual(['Plaintiff', 'Defendant']);
    
    // Check that models and iterations are preserved from primary manifest
    expect(combinedQuery.models).toEqual([{ provider: 'OpenAI', model: 'gpt-4', weight: 0.7, count: 2 }]);
    expect(combinedQuery.iterations).toBe(1);
  });
  
  test('should handle mismatched bCID counts properly', async () => {
    // For this specific test, simulate a primary manifest with more bCIDs than provided
    manifestParser.parse = jest.fn().mockImplementation((extractedPath) => {
      if (extractedPath.includes('primary')) {
        return Promise.resolve(mockPrimaryManifest);
      } else if (extractedPath.includes('plaintiff')) {
        return Promise.resolve(mockPlaintiffManifest);
      }
      return Promise.reject(new Error(`Mock not found for path: ${extractedPath}`));
    });
    
    const extractedPaths = {
      'primary-cid': '/tmp/extract/primary',
      'plaintiff-cid': '/tmp/extract/plaintiff'
    };
    
    const cidOrder = ['primary-cid', 'plaintiff-cid'];
    
    // This should throw an error because mockPrimaryManifest has 2 bCIDs 
    // but we're only providing 1 additional CID
    await expect(
      manifestParser.parseMultipleManifests(extractedPaths, cidOrder)
    ).rejects.toThrow('Number of bCIDs in manifest');
  });
  
  test('should warn about mismatched bCID names', async () => {
    // Create a custom implementation with mismatched name
    const mockPlaintiffWithWrongName = {
      ...mockPlaintiffManifest,
      name: 'wrongName'
    };
    
    // Directly mock the logger.warn function for this test
    const mockWarn = jest.fn();
    logger.warn = mockWarn;
    
    manifestParser.parse = jest.fn().mockImplementation((extractedPath) => {
      if (extractedPath.includes('primary')) {
        return Promise.resolve(mockPrimaryManifest);
      } else if (extractedPath.includes('plaintiff')) {
        return Promise.resolve(mockPlaintiffWithWrongName);
      } else if (extractedPath.includes('defendant')) {
        return Promise.resolve(mockDefendantManifest);
      }
      return Promise.reject(new Error(`Mock not found for path: ${extractedPath}`));
    });
    
    const extractedPaths = {
      'primary-cid': '/tmp/extract/primary',
      'plaintiff-cid': '/tmp/extract/plaintiff',
      'defendant-cid': '/tmp/extract/defendant'
    };
    
    const cidOrder = ['primary-cid', 'plaintiff-cid', 'defendant-cid'];
    
    await manifestParser.parseMultipleManifests(extractedPaths, cidOrder);
    
    // Verify that the warning was logged
    expect(mockWarn).toHaveBeenCalledWith(
      expect.stringContaining('Warning: bCID manifest name')
    );
  });
  
  test('sanitizes addendum string for security', async () => {
    const maliciousAddendum = '<script>alert("XSS")</script>{badCode}';
    
    const result = manifestParser.constructCombinedQuery(
      mockPrimaryManifest,
      [],
      maliciousAddendum
    );
    
    // Check that dangerous characters are removed
    expect(result.prompt).not.toContain('<script>');
    expect(result.prompt).not.toContain('</script>');
    expect(result.prompt).not.toContain('{badCode}');
    
    // Check that the content is still there but sanitized
    expect(result.prompt).toContain('script');
    expect(result.prompt).toContain('alert');
    expect(result.prompt).toContain('XSS');
    expect(result.prompt).toContain('badCode');
  });
}); 