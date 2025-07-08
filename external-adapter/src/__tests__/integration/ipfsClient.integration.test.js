const { createClient } = require('@verdikta/common');
const path = require('path');
const config = require('../../config');

// Create test client
const testClient = createClient({
  ipfs: {
    pinningService: config.ipfs.pinningService,
    pinningKey: config.ipfs.pinningKey,
    gateway: config.ipfs.gateway
  },
  logging: { level: 'error' }
});
const { ipfsClient } = testClient;



describe('IPFS Client Integration', () => {
  jest.setTimeout(60000);

  afterEach(() => {
    // Note: With @verdikta/common, ipfsClient configuration is handled internally
    if (ipfsClient.cleanup) {
      ipfsClient.cleanup();
    }
  });

  afterAll(() => {
    if (ipfsClient.cleanup) {
      ipfsClient.cleanup();
    }
  });

  it('should fetch content from IPFS gateway', async () => {
    const testCid = 'QmcMjSr4pL8dpNzjhGWaZ6vRmvv7fN3xsLJCDpqVsH7gv7';
    
    const result = await ipfsClient.fetchFromIPFS(testCid);
    
    expect(Buffer.isBuffer(result)).toBe(true);
    expect(result.length).toBeGreaterThan(0);
  });

  it('should handle invalid CID errors', async () => {
    const invalidCid = 'invalid-cid';
    
    await expect(
      ipfsClient.fetchFromIPFS(invalidCid)
    ).rejects.toThrow('Failed to fetch from IPFS');
  });

  it('should handle network errors', async () => {
    // Create a client with invalid gateway for this test
    const invalidClient = createClient({
      ipfs: {
        gateway: 'http://invalid.gateway'
      },
      logging: { level: 'error' }
    });
    
    await expect(
      invalidClient.ipfsClient.fetchFromIPFS('QmTestHash')
    ).rejects.toThrow('Failed to fetch from IPFS');
  });

  it('should upload file to IPFS', async () => {
    const testFilePath = path.join(__dirname, '../integration/fixtures/mockArchive.zip');
    
    const cid = await ipfsClient.uploadToIPFS(testFilePath);
    expect(cid).toBeDefined();
    expect(typeof cid).toBe('string');
    expect(cid.startsWith('Qm')).toBe(true);
  });
  
});






