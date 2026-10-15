const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

jest.mock('axios');
const axios = require('axios');

const mockPost = jest.fn();
axios.create.mockReturnValue({ post: mockPost });

// aiClient writes logs only through this logger, so its calls are everything that
// could reach an operator's log.
const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.mock('@verdikta/common', () => ({ createClient: () => ({ logger: mockLogger }) }));

const aiClient = require('../../services/aiClient');

function loggedText() {
  return Object.values(mockLogger)
    .flatMap(fn => fn.mock.calls)
    .map(args => args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '))
    .join('\n');
}

describe('aiClient.evaluate logging', () => {
  let dir;
  let pngBase64;
  let jpegBase64;
  const notes = 'Submitted notes that belong to the hunter, not the log.';
  const query = {
    prompt: 'Judge it',
    models: [{ provider: 'OpenAI', model: 'gpt-4o', weight: 1, count: 1 }],
    iterations: 1,
    outcomes: ['DONT_FUND', 'FUND'],
    additional: [
      { name: 'screenshot', filename: 'shot.png', type: 'image/png' },
      { name: 'notes', filename: 'notes.txt', type: 'text/plain' },
    ],
  };

  beforeEach(() => {
    Object.values(mockLogger).forEach(fn => fn.mockReset());
    mockPost.mockReset();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiclient-log-'));
    // Real signatures for MIME detection; random bodies so any leaked slice is unmistakable.
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), crypto.randomBytes(300 * 1024)]);
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8]), crypto.randomBytes(100 * 1024)]);
    pngBase64 = png.toString('base64');
    jpegBase64 = jpeg.toString('base64');
    fs.writeFileSync(path.join(dir, 'shot.png'), png);
    fs.writeFileSync(path.join(dir, 'notes.txt'), notes);
    fs.writeFileSync(path.join(dir, 'support.jpg'), jpeg);
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ version: '1.0', support: [{ filename: 'support.jpg' }] }));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function expectNoAttachmentContents() {
    const text = loggedText();
    expect(text).not.toContain(';base64,');
    for (const b64 of [pngBase64, jpegBase64]) {
      expect(text).not.toContain(b64.slice(0, 64));
      expect(text).not.toContain(b64.slice(10000, 10064));
    }
    expect(text).not.toContain(notes);
  }

  test('logs each attachment\'s shape, never its contents', async () => {
    mockPost.mockResolvedValue({ data: { scores: [], justification: 'ok' } });

    await aiClient.evaluate(query, dir, '[EA job1]');

    // The request itself still carries the data.
    const payload = mockPost.mock.calls[0][1];
    expect(payload.attachments[0]).toBe(`data:image/png;base64,${pngBase64}`);
    expect(payload.attachments[1]).toBe(notes);

    expectNoAttachmentContents();

    const summaryCall = mockLogger.info.mock.calls.find(([msg]) => msg.includes('Sending request to AI Node'));
    expect(summaryCall[1]).toEqual({
      promptLength: query.prompt.length,
      models: [{ provider: 'OpenAI', model: 'gpt-4o', weight: 1, count: 1 }],
      iterations: 1,
      outcomes: ['DONT_FUND', 'FUND'],
      attachmentsCount: 3,
      attachments: [
        { name: 'shot.png', mediaType: 'image/png', length: payload.attachments[0].length },
        { name: 'notes.txt', mediaType: 'text/plain', length: notes.length },
        { name: 'support.jpg', mediaType: 'image/jpeg', length: payload.attachments[2].length },
      ],
    });
  });

  test('the error path does not log the request body', async () => {
    mockPost.mockImplementation((url, body) => {
      const error = new Error('Request failed with status code 400');
      error.config = { url, method: 'post', headers: { 'Content-Type': 'application/json' }, data: JSON.stringify(body) };
      error.response = { status: 400, statusText: 'Bad Request', data: { error: 'image exceeds 5 MB maximum', scores: [], justification: '' } };
      return Promise.reject(error);
    });

    await expect(aiClient.evaluate(query, dir, '[EA job2]')).rejects.toThrow(/^PROVIDER_ERROR: image exceeds 5 MB maximum/);

    expect(mockLogger.error).toHaveBeenCalled();
    expectNoAttachmentContents();
  });
});
