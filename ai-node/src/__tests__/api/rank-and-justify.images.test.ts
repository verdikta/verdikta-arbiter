/**
 * @jest-environment node
 */
// The bounty-171 failure end to end through the route, with providers that reject
// images over their limits the way the real APIs do.

import sharp from 'sharp';
import { POST } from '../../app/api/rank-and-justify/route';
import { LLMFactory } from '../../lib/llm/llm-factory';

jest.mock('../../lib/llm/llm-factory');

jest.mock('next/server', () => ({
  NextResponse: {
    json: jest.fn((data, options) => ({
      status: options?.status || 200,
      json: jest.fn().mockResolvedValue(data),
    })),
  },
}));

jest.setTimeout(60_000);

const JURY = [
  { provider: 'OpenAI', model: 'gpt-5.6-sol', weight: 0.5 },
  { provider: 'Anthropic', model: 'claude-sonnet-5', weight: 0.5 },
];

type Attachment = { type: string; content: string; mediaType: string };

/** A provider that, like the real APIs, rejects an image over 8000 px or 30,000 patches. */
function strictProvider(name: string) {
  return {
    generateResponse: jest.fn(),
    supportsAttachments: jest.fn().mockReturnValue(true),
    generateResponseWithAttachments: jest.fn(async (_prompt: string, _model: string, attachments: Attachment[]) => {
      for (const attachment of attachments.filter(a => a.type === 'image')) {
        const { width = 0, height = 0 } = await sharp(Buffer.from(attachment.content, 'base64')).metadata();
        if (Math.max(width, height) > 8000 || Math.ceil(width / 32) * Math.ceil(height / 32) > 30000) {
          throw Object.assign(new Error(`400 ${name}: image ${width}x${height} exceeds the input limits`), { status: 400 });
        }
      }
      return JSON.stringify({ score: [700000, 300000], justification: `${name} read every part.` });
    }),
  };
}

function post(body: object) {
  return POST({ json: async () => body } as unknown as Request);
}

describe('POST /api/rank-and-justify with oversized and unusable images', () => {
  let openai: ReturnType<typeof strictProvider>;
  let anthropic: ReturnType<typeof strictProvider>;
  let tallScreenshot: string;
  const corruptPng = `data:image/png;base64,${Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(64, 7),
  ]).toString('base64')}`;

  beforeAll(async () => {
    const png = await sharp({ create: { width: 2560, height: 12268, channels: 3, background: '#f4f4f4' } }).png().toBuffer();
    tallScreenshot = `data:image/png;base64,${png.toString('base64')}`;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    openai = strictProvider('OpenAI');
    anthropic = strictProvider('Anthropic');
    const justifier = { generateResponse: jest.fn().mockResolvedValue('Both models agree.') };
    (LLMFactory.getProvider as jest.Mock).mockImplementation(async (provider: string) =>
      provider === 'OpenAI' ? openai : provider === 'Anthropic' ? anthropic : justifier,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
    delete process.env.DROP_UNPROCESSABLE_IMAGES;
  });

  test('every model succeeds: the screenshot is split, the corrupt file omitted, and the prompt says so', async () => {
    const response = await post({
      prompt: 'Does the article meet the bounty rubric?',
      outcomes: ['DONT_FUND', 'FUND'],
      models: JURY,
      attachments: [tallScreenshot, corruptPng, 'The hunter\'s cover note.'],
      attachmentNames: ['submission/medium_article.png', 'submission/broken.png', 'submission/note.txt'],
      requestTag: '[EA job agg=0x554fa500 mode=1]',
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.metadata).toMatchObject({ models_requested: 2, models_successful: 2, models_failed: 0 });
    expect(body.scores).toEqual([
      { outcome: 'DONT_FUND', score: 700000 },
      { outcome: 'FUND', score: 300000 },
    ]);

    for (const provider of [openai, anthropic]) {
      expect(provider.generateResponseWithAttachments).toHaveBeenCalledTimes(1);
      const [prompt, , attachments] = provider.generateResponseWithAttachments.mock.calls[0];
      expect(prompt).toContain('- submission/medium_article.png was split into 5 parts, top to bottom');
      expect(prompt).toContain(
        '- Attachment submission/broken.png could not be processed and was omitted: Input buffer has corrupt header.',
      );
      expect(attachments.filter((a: Attachment) => a.type === 'image')).toHaveLength(5);
      expect(attachments.map((a: Attachment) => a.content)).toContain('[submission/medium_article.png (part 1 of 5)]');
      expect(attachments[attachments.length - 1].content).toBe('The hunter\'s cover note.');
    }
    // Both models saw identical attachments.
    expect(openai.generateResponseWithAttachments.mock.calls[0][2]).toEqual(
      anthropic.generateResponseWithAttachments.mock.calls[0][2],
    );

    expect(body.warnings.map((w: { type: string }) => w.type)).toEqual(['image_normalized', 'attachment_omitted']);
  });

  test('with DROP_UNPROCESSABLE_IMAGES=false a corrupt image fails the request with its real cause', async () => {
    process.env.DROP_UNPROCESSABLE_IMAGES = 'false';

    const response = await post({
      prompt: 'Does the article meet the bounty rubric?',
      outcomes: ['DONT_FUND', 'FUND'],
      models: JURY,
      attachments: [tallScreenshot, corruptPng],
      attachmentNames: ['submission/medium_article.png', 'submission/broken.png'],
    });
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe('Image attachment submission/broken.png could not be processed: Input buffer has corrupt header');
    expect(openai.generateResponseWithAttachments).not.toHaveBeenCalled();
    expect(anthropic.generateResponseWithAttachments).not.toHaveBeenCalled();
  });
});
