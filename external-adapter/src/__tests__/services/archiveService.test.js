const fs = require('fs');
const path = require('path');
const os = require('os');
const archiveService = require('../../services/archiveService');

describe('ArchiveService', () => {
  let tempDir;

  beforeAll(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'archive-test-'));
  });

  afterAll(async () => {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('extractArchive', () => {
    it('should extract the archive to the specified directory', async () => {
      const mockArchivePath = path.join(__dirname, '..', 'integration', 'fixtures', 'mockArchive.zip');
      const archiveData = await fs.promises.readFile(mockArchivePath);
      const extractedPath = await archiveService.extractArchive(archiveData, 'mockArchive.zip', tempDir);
      expect(extractedPath).toBe(path.join(tempDir, 'mockArchive'));
    });
  });
});
