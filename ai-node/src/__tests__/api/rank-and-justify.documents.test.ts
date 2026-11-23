/**
 * @jest-environment node
 */
// Bounty 398, submission 2, through the route: a jury of today's models, a hunter's PDF,
// and an arbiter host without poppler. The PDF used to vanish between the request and the
// models, and both jurors reported it as "not included in the actual submission".
//
// These are jurors that are sent a PDF's text: both classes are routed through OpenRouter
// here, whose request carries no PDF block (lib/llm/pdf-support.ts). On its own keys the
// same jury is sent the file itself and gets none of these lines about it:
// rank-and-justify.pdf.test.ts.

import { POST } from '../../app/api/rank-and-justify/route';
import { LLMFactory } from '../../lib/llm/llm-factory';
import { pdfDataUri } from '../../../test-support/pdf-fixture';

jest.mock('../../lib/llm/llm-factory');
// Authentication is covered through the real handlers in service-auth.test.ts.
jest.mock('../../lib/service-auth', () => ({ requireServiceAuth: () => null }));
// An arbiter host: no pdftotext.
jest.mock('textract', () => ({
  __esModule: true,
  default: {
    fromBufferWithMime: (_mime: string, _buffer: Buffer, callback: (error: Error) => void) =>
      callback(new Error("INFO: 'pdftotext' does not appear to be installed, so textract will be unable to extract PDFs.")),
  },
}));

jest.mock('next/server', () => ({
  NextResponse: {
    json: jest.fn((data, options) => ({
      status: options?.status || 200,
      json: jest.fn().mockResolvedValue(data),
    })),
  },
}));

jest.setTimeout(60_000);

// The panel of bounty 398, with the provider names its manifest uses.
const JURY = [
  { provider: 'openai', model: 'gpt-5.6-terra', weight: 0.5 },
  { provider: 'anthropic', model: 'claude-sonnet-5', weight: 0.5 },
];

type Attachment = { type: string; content: string; mediaType: string };

function juror(name: string) {
  return {
    generateResponse: jest.fn(),
    supportsAttachments: jest.fn().mockReturnValue(true),
    generateResponseWithAttachments: jest.fn(async () =>
      JSON.stringify({ score: [100000, 900000], justification: `${name} read the evidence.` }),
    ),
  };
}

function post(body: object) {
  return POST({ json: async () => body } as unknown as Request);
}

describe('POST /api/rank-and-justify with documents', () => {
  let openai: ReturnType<typeof juror>;
  let anthropic: ReturnType<typeof juror>;
  const corruptPng = `data:image/png;base64,${Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(64, 7),
  ]).toString('base64')}`;

  const savedEnv = { AI_GATEWAY: process.env.AI_GATEWAY, OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY };

  beforeAll(() => {
    process.env.AI_GATEWAY = 'openrouter';
    process.env.OPENROUTER_API_KEY = 'test-key';
  });

  afterAll(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    openai = juror('GPT');
    anthropic = juror('Claude');
    const justifier = { generateResponse: jest.fn().mockResolvedValue('Both jurors fund.') };
    (LLMFactory.getProvider as jest.Mock).mockImplementation(async (provider: string) =>
      provider === 'openai' ? openai : provider === 'anthropic' ? anthropic : justifier,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('a PDF with a text layer reaches every juror as text, with a note that its pictures do not', async () => {
    const response = await post({
      prompt: 'Does the submission meet the rubric?',
      outcomes: ['DONT_FUND', 'FUND'],
      models: JURY,
      attachments: ['{"evidence":[{"filename":"E3_recording_frames.pdf"}]}', pdfDataUri(['E3 - Recording frames and metadata', 'Frame at 0:18'])],
      attachmentNames: ['submission/R1.json', 'submission/R4.pdf'],
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.metadata).toMatchObject({ models_requested: 2, models_successful: 2 });
    expect(body.warnings).toBeUndefined();

    for (const provider of [openai, anthropic]) {
      const [prompt, , attachments] = provider.generateResponseWithAttachments.mock.calls[0] as unknown as [string, string, Attachment[]];
      expect(attachments.map(a => a.type)).toEqual(['text', 'text']);
      expect(attachments[1].content).toContain('E3 - Recording frames and metadata');
      expect(attachments[1].content).toContain('Frame at 0:18');
      expect(prompt).toContain('Notes on the attachments (added by the arbiter while preparing them for the models):');
      expect(prompt).toContain(
        '- Attachment submission/R4.pdf is a PDF. Only its text is shown to you (48 characters); pictures and page images inside the PDF are not shown.',
      );
    }
  });

  test('a PDF the arbiter cannot read is named in the prompt as delivered, and in the warning', async () => {
    const response = await post({
      prompt: 'Does the submission meet the rubric?',
      outcomes: ['DONT_FUND', 'FUND'],
      models: JURY,
      // The omitted image moves every later attachment up by one; the notes still name the files.
      attachments: [corruptPng, 'The hunter\'s cover note.', pdfDataUri(['', ''])],
      attachmentNames: ['submission/broken.png', 'submission/note.txt', 'submission/scan.pdf'],
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.metadata).toMatchObject({ models_requested: 2, models_successful: 2 });

    for (const provider of [openai, anthropic]) {
      const [prompt, , attachments] = provider.generateResponseWithAttachments.mock.calls[0] as unknown as [string, string, Attachment[]];
      expect(attachments).toEqual([{ type: 'text', content: 'The hunter\'s cover note.', mediaType: 'text/plain' }]);
      // One notes section: the image's line, then the document's.
      expect(prompt.match(/Notes on the attachments/g)).toHaveLength(1);
      expect(prompt.indexOf('- Attachment submission/broken.png could not be processed and was omitted')).toBeGreaterThan(0);
      expect(prompt).toMatch(
        /- Attachment submission\/scan\.pdf \(PDF, \d+ bytes\) was delivered with this request, but the arbiter could not read it, so its content is not shown to you\. The file is not missing from the request\.$/,
      );
    }

    const skipped = body.warnings.filter((warning: { type: string }) => warning.type === 'attachment_skipped');
    expect(skipped).toHaveLength(1);
    // The operator's line keeps the cause; details name the file the number stands for.
    expect(skipped[0].message).toMatch(/^Attachment 2: PDF processing failed: /);
    expect(skipped[0].details).toEqual({ attachment: 'submission/scan.pdf', media_type: 'application/pdf' });
  });

  test('a request whose documents are all shown whole has no notes', async () => {
    await post({
      prompt: 'Does the submission meet the rubric?',
      outcomes: ['DONT_FUND', 'FUND'],
      models: JURY,
      attachments: ['The hunter\'s cover note.'],
      attachmentNames: ['submission/note.txt'],
    });
    const [prompt] = openai.generateResponseWithAttachments.mock.calls[0] as unknown as [string];
    expect(prompt).not.toContain('Notes on the attachments');
    expect(prompt.endsWith('Does the submission meet the rubric?')).toBe(true);
  });
});
