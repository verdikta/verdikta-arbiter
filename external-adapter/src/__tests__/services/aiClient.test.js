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
    mockPost.mockResolvedValue({ data: { scores: [{ outcome: 'DONT_FUND', score: 1000000 }, { outcome: 'FUND', score: 0 }], justification: 'ok' } });
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
    expect(mockPost.mock.calls[0][2]).toEqual({
      headers: { Authorization: `Bearer ${process.env.AI_NODE_API_TOKEN}` }, maxRedirects: 0,
    });
  });

  test.each(['additional', 'support'])('rejects an outside %s path instead of omitting it and calling the AI', async section => {
    const file = { name: 'unsafe', path: path.join(dir, '..', 'outside-marker.txt'), type: 'text/plain' };
    const query = { prompt: 'Judge it', models: [], additional: [] };
    if (section === 'additional') query.additional = [file];
    else fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ support: [file] }));
    await expect(aiClient.evaluate(query, dir)).rejects.toMatchObject({ code: 'UNSAFE_EVIDENCE' });
    expect(mockPost).not.toHaveBeenCalled();
  });

  test('rejects a symlink attachment before sending the request', async () => {
    fs.symlinkSync(path.join(dir, 'notes.txt'), path.join(dir, 'linked.txt'));
    await expect(aiClient.evaluate({ prompt: 'Judge it', additional: [{ filename: 'linked.txt' }] }, dir))
      .rejects.toMatchObject({ code: 'UNSAFE_EVIDENCE' });
    expect(mockPost).not.toHaveBeenCalled();
  });

  test('missing AI credential fails before making a request', async () => {
    const token = process.env.AI_NODE_API_TOKEN;
    try {
      delete process.env.AI_NODE_API_TOKEN;
      await expect(aiClient.evaluate({ prompt: 'Judge it' }, dir)).rejects.toThrow('AI Node service authentication is not configured');
      expect(mockPost).not.toHaveBeenCalled();
    } finally { process.env.AI_NODE_API_TOKEN = token; }
  });
});
