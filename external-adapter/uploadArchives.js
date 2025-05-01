const ipfsClient = require('./src/services/ipfsClient');
const fs = require('fs');
const path = require('path');

async function uploadTestArchives() {
  const fixturesDir = path.join(__dirname, 'src/__tests__/integration/fixtures');
  const archives = [
    'mockArchive.zip',
    'singleImageTest-onefilelocal.zip',
    'fourImageTest.zip',
    'ipfs-file-test.zip'
  ];

  for (const archive of archives) {
    const filePath = path.join(fixturesDir, archive);
    try {
      const cid = await ipfsClient.uploadToIPFS(filePath);
      console.log(`${archive}: ${cid}`);
    } catch (error) {
      console.error(`Failed to upload ${archive}:`, error);
    }
  }
}

uploadTestArchives(); 