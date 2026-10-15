const fs = require('fs');
const os = require('os');
const path = require('path');

jest.mock('axios');
const axios = require('axios');

const mockPost = jest.fn();
axios.create.mockReturnValue({ post: mockPost });

const aiClient = require('../../services/aiClient');

describe('aiClient.evaluate payload', () => {
  let dir;

  beforeEach(() => {
    mockPost.mockReset();
    mockPost.mockResolvedValue({ data: { scores: [], justification: 'ok' } });
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiclient-'));
    fs.mkdirSync(path.join(dir, 'submission'));
    // PNG signature is enough for MIME detection; the AI Node does the decoding.
    fs.writeFileSync(path.join(dir, 'submission', 'medium_article.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'plain text notes');
    fs.writeFileSync(path.join(dir, 'additional_QmCid'), 'fetched by CID');
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ version: '1.0' }));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('sends each attachment\'s file name, index-aligned, and the run tag', async () => {
    const query = {
      prompt: 'Judge it',
      models: [{ provider: 'OpenAI', model: 'gpt-5.6-sol', weight: 1 }],
      outcomes: ['DONT_FUND', 'FUND'],
      additional: [
        { name: 'screenshot', filename: 'submission/medium_article.png', type: 'image/png' },
        { name: 'missing', filename: 'not-there.png', type: 'image/png' }, // unreadable: skipped
        { name: 'notes', filename: 'notes.txt', type: 'text/plain' },
        { name: 'byCid', type: 'ipfs/cid', path: path.join(dir, 'additional_QmCid') },
      ],
    };

    await aiClient.evaluate(query, dir, '[EA job1 agg=0xabc mode=1]');

    const [url, payload] = mockPost.mock.calls[0];
    expect(url).toBe('/api/rank-and-justify');
    expect(payload.attachments).toHaveLength(3);
    expect(payload.attachments[0]).toMatch(/^data:image\/png;base64,/);
    expect(payload.attachmentNames).toEqual(['submission/medium_article.png', 'notes.txt', 'byCid']);
    expect(payload.requestTag).toBe('[EA job1 agg=0xabc mode=1]');
  });
});
