const ipfsClient = require('./src/services/ipfsClient');
const fs = require('fs');
const path = require('path');

async function uploadMultiCidArchives() {
  console.log('Uploading multi-CID test archives to IPFS...');
  
  const fixturesDir = path.join(__dirname, 'src/__tests__/integration/fixtures');
  const archives = [
    'multi-cid-primary.zip',
    'multi-cid-plaintiff.zip',
    'multi-cid-defendant.zip'
  ];

  const cidMap = {};

  for (const archive of archives) {
    const filePath = path.join(fixturesDir, archive);
    
    if (!fs.existsSync(filePath)) {
      console.error(`File not found: ${filePath}`);
      continue;
    }
    
    try {
      console.log(`Uploading ${archive}...`);
      const cid = await ipfsClient.uploadToIPFS(filePath);
      cidMap[archive] = cid;
      console.log(`${archive}: ${cid}`);
    } catch (error) {
      console.error(`Failed to upload ${archive}:`, error);
    }
  }

  console.log('\nCID Map for testing:');
  console.log(JSON.stringify(cidMap, null, 2));
  
  console.log('\nUpdated test request format:');
  const testRequest = {
    id: 'test-multi-cid',
    data: {
      cid: `${cidMap['multi-cid-primary.zip']},${cidMap['multi-cid-plaintiff.zip']},${cidMap['multi-cid-defendant.zip']}:2,127.50`
    }
  };
  console.log(JSON.stringify(testRequest, null, 2));
  
  return cidMap;
}

// Run the function if this script is executed directly
if (require.main === module) {
  uploadMultiCidArchives()
    .then(() => {
      console.log('Upload completed.');
    })
    .catch(error => {
      console.error('Error uploading archives:', error);
    });
}

module.exports = { uploadMultiCidArchives }; 