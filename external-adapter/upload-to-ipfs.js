const path = require('path');
const { createClient } = require('@verdikta/common');

async function uploadToIPFS() {
  try {
    console.log('🚀 Initializing IPFS client...');
    
    // Create IPFS client using the verdikta-common library
    const verdikta = createClient({
      ipfs: {
        pinningService: process.env.IPFS_PINNING_SERVICE || 'https://api.pinata.cloud',
        pinningKey: process.env.IPFS_PINNING_KEY,
        timeout: 30000
      },
      logging: {
        level: 'info',
        console: true
      }
    });

    const { ipfsClient } = verdikta;
    
    console.log('📦 Uploading fixed-standalone-test.zip to IPFS...');
    const filePath = '/tmp/fixed-standalone-test.zip';
    
    const cid = await ipfsClient.uploadToIPFS(filePath);
    
    console.log('✅ Upload successful!');
    console.log('🔗 New CID:', cid);
    console.log('🌐 IPFS URL:', `https://ipfs.io/ipfs/${cid}`);
    console.log('🌐 Cloudflare URL:', `https://cloudflare-ipfs.com/ipfs/${cid}`);
    console.log('');
    console.log('📝 Update the test file with this new CID:');
    console.log(`const STANDALONE_CID = '${cid}';`);
    
    return cid;
  } catch (error) {
    console.error('❌ Upload failed:', error.message);
    
    if (error.message.includes('Authentication') || error.message.includes('401') || error.message.includes('403')) {
      console.log('');
      console.log('🔑 Make sure your IPFS_PINNING_KEY environment variable is set:');
      console.log('export IPFS_PINNING_KEY="your_pinata_jwt_token"');
    }
    
    process.exit(1);
  }
}

// Run the upload
uploadToIPFS(); 