const ipfsClient = require('../../services/ipfsClient');
const path = require('path');
const config = require('../../config');



describe('IPFS Client Integration', () => {
  jest.setTimeout(60000);

  afterEach(() => {
    ipfsClient.gateway = config.ipfs.gateway;
    ipfsClient.pinningService = config.ipfs.pinningService;
    ipfsClient.pinningKey = config.ipfs.pinningKey;
    ipfsClient.cleanup();

  });

  afterAll(() => {
    ipfsClient.cleanup();
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
    const originalGateway = ipfsClient.gateway;
    ipfsClient.gateway = 'http://invalid.gateway';
    
    await expect(
      ipfsClient.fetchFromIPFS('QmTestHash')
    ).rejects.toThrow('Failed to fetch from IPFS');
    
    ipfsClient.gateway = originalGateway;
  });

  it('should upload file to IPFS', async () => {
    const testFilePath = path.join(__dirname, '../integration/fixtures/mockArchive.zip');
    
    const cid = await ipfsClient.uploadToIPFS(testFilePath);
    expect(cid).toBeDefined();
    expect(typeof cid).toBe('string');
    expect(cid.startsWith('Qm')).toBe(true);
  });
  
});






