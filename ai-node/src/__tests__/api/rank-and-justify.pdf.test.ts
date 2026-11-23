/**
 * @jest-environment node
 *
 * What each provider is actually sent when a request carries a PDF.
 *
 * Nothing here mocks a provider class or an SDK: the route, LLMFactory, the
 * OpenAI and Anthropic providers and their real client libraries (openai,
 * @anthropic-ai/sdk, LangChain for a text-only Claude call) run as they do on a
 * node, and a stub on 127.0.0.1 stands in for every provider API with throwaway
 * keys. The assertions are on the JSON bodies that crossed HTTP. No request
 * leaves this machine: this proves the requests this code builds, not that the
 * real APIs accept them (docs/release-runbook.md 3b, the pdf-canary scenario).
 *
 * The jury is the one of bounty 398 (openai / gpt-5.6-terra, anthropic /
 * claude-sonnet-5, as a manifest names them), where a hunter's 16 recording
 * frames sat in a 19-page PDF and neither juror was shown a page.
 */
import http from 'http';
import type { AddressInfo, Socket } from 'net';
import sharp from 'sharp';
import {
  DOCX_MEDIA_TYPE,
  buildDocx,
  buildPdf,
  dataUri,
  frameJpeg,
} from '../../../test-support/attachment-fixtures';

// The model table as ClassID integration writes it on a node (the checked-in
// table predates these ids); grok-9-text stands for a model its provider sends no attachments to.
jest.mock('../../config/models', () => ({
  modelConfig: {
    openai: [{ name: 'gpt-5.6-terra', supportsImages: true, supportsAttachments: true }],
    anthropic: [{ name: 'claude-sonnet-5', supportsImages: true, supportsAttachments: true }],
    xai: [
      { name: 'grok-4.6', supportsImages: true, supportsAttachments: true },
      { name: 'grok-9-text', supportsImages: false, supportsAttachments: false },
    ],
    hyperbolic: [],
    ollama: [],
    openrouter: [],
  },
}));
// Authentication is covered through the real handlers in service-auth.test.ts.
jest.mock('../../lib/service-auth', () => ({ requireServiceAuth: () => null }));
jest.mock('next/server', () => ({
  NextResponse: {
    json: jest.fn((data, options) => ({
      status: options?.status || 200,
      json: jest.fn().mockResolvedValue(data),
    })),
  },
}));

jest.setTimeout(60_000);

const TERRA = { provider: 'openai', model: 'gpt-5.6-terra', weight: 0.5 };
const SONNET = { provider: 'anthropic', model: 'claude-sonnet-5', weight: 0.5 };
const GROK = { provider: 'xai', model: 'grok-4.6', weight: 0.5 };
const SCORES = JSON.stringify({ score: [300000, 700000], justification: 'The frames show the run.' });
/** The line documentNotes writes for a juror that is sent a PDF's text (the count is the text's length). */
const textOnlyNote = (ref: string) => new RegExp(
  `- Attachment ${ref.replace(/[.]/g, '\\.')} is a PDF\\. Only its text is shown to you \\(\\d[\\d,]* characters\\); ` +
    'pictures and page images inside the PDF are not shown\\.',
);
const TEXT_ONLY = 'Only its text is shown to you';
const NOTES_HEADING = 'Notes on the attachments (added by the arbiter while preparing them for the models):';

interface Seen {
  api: 'anthropic' | 'openai' | 'xai' | 'openrouter';
  path: string;
  headers: http.IncomingHttpHeaders;
  body: any;
}
type Reply = { status: number; body: unknown };
/** Return a reply to override the default answer for one request. */
type Behaviour = (request: Seen, index: number) => Reply | undefined;

const anthropicMessage = (text: string) => ({
  id: 'msg_stub', type: 'message', role: 'assistant', model: 'stub',
  content: [{ type: 'text', text }],
  stop_reason: 'end_turn', stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1 },
});
const chatCompletion = (text: string) => ({
  id: 'chatcmpl-stub', object: 'chat.completion', created: 0, model: 'stub',
  choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
});
const responsesReply = (text: string) => ({
  id: 'resp_stub', object: 'response', status: 'completed', model: 'stub',
  output: [{ id: 'msg_1', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }],
});

function defaultReply(request: Seen): Reply {
  if (request.api === 'anthropic') return { status: 200, body: anthropicMessage(SCORES) };
  if (request.path.endsWith('/responses')) return { status: 200, body: responsesReply(SCORES) };
  return { status: 200, body: chatCompletion(SCORES) };
}

let server: http.Server;
let seen: Seen[] = [];
let behaviour: Behaviour = () => undefined;
const sockets = new Set<Socket>();
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_CLASS_PROVIDER', 'ANTHROPIC_CLASS_MODEL',
  'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_CLASS_PROVIDER', 'OPENAI_CLASS_MODEL', 'OPENAI_ORG_ID', 'OPENAI_PROJECT_ID',
  'OPENROUTER_API_KEY', 'OPENROUTER_BASE_URL',
  'XAI_API_KEY', 'XAI_BASE_URL', 'XAI_CLASS_PROVIDER', 'GROK_API_KEY', 'GROK_BASE_URL',
  'AI_GATEWAY', 'AI_WEB_ACCESS', 'JUSTIFIER_MODEL', 'VERDIKTA_TEST_MOCK_PROVIDER',
];

let POST: (request: Request) => Promise<any>;
let framesPdf: Buffer;      // 19 pages, 16 of them a picture, as on bounty 398
let scannedPdf: Buffer;     // pictures only: no text to extract
let longPdf: Buffer;        // 101 pages: one over both providers' limit
let coverLetter: Buffer;    // a Word file

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const path = req.url || '';
      const entry: Seen = {
        api: path.split('/')[1] as Seen['api'],
        path,
        headers: req.headers,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      };
      const index = seen.push(entry) - 1;
      const reply = behaviour(entry, index) ?? defaultReply(entry);
      res.writeHead(reply.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply.body));
    });
  });
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.OPENAI_API_KEY = 'stub-key';
  process.env.OPENAI_BASE_URL = `${origin}/openai/v1`;
  process.env.ANTHROPIC_API_KEY = 'stub-key';
  process.env.ANTHROPIC_BASE_URL = `${origin}/anthropic`;
  process.env.XAI_API_KEY = 'stub-key';
  process.env.XAI_BASE_URL = `${origin}/xai/v1`;
  process.env.OPENROUTER_BASE_URL = `${origin}/openrouter/v1`;
  // The route reads the justifier at module load, so it is loaded after this.
  process.env.JUSTIFIER_MODEL = 'OpenAI:gpt-5.6-terra';
  POST = require('../../app/api/rank-and-justify/route').POST;

  const frame = await frameJpeg();
  framesPdf = buildPdf([
    { text: 'Recording of the submission, 16 frames.' },
    ...Array.from({ length: 16 }, () => ({ jpeg: frame })),
    { text: 'Frame notes: the counter reads 42 in frame 9.' },
    { text: 'End of recording.' },
  ]);
  scannedPdf = buildPdf([{ jpeg: frame }, { jpeg: frame }]);
  longPdf = buildPdf(Array.from({ length: 101 }, (_, page) => ({ text: `Appendix page ${page + 1}.` })));
  coverLetter = await buildDocx(['Cover letter from the hunter.', 'The recording is in the PDF.']);
});

afterAll(async () => {
  sockets.forEach(socket => socket.destroy());
  await new Promise(resolve => server.close(resolve));
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

beforeEach(() => {
  seen = [];
  behaviour = () => undefined;
  delete process.env.ANTHROPIC_CLASS_PROVIDER;
  delete process.env.OPENROUTER_API_KEY;
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

const base64 = (bytes: Buffer) => bytes.toString('base64');

async function evaluate(body: Record<string, unknown>) {
  const response = await POST({
    json: async () => ({ prompt: 'Does the recording show the run to the end?', outcomes: ['DONT_FUND', 'FUND'], ...body }),
  } as unknown as Request);
  return { status: response.status as number, body: await response.json() };
}

/** The jurors' requests, by API: a juror sends a list of content parts, the justifier a plain string. */
const jurorRequests = (api: Seen['api']) =>
  seen.filter(request =>
    request.api === api &&
    (request.path.endsWith('/responses') || Array.isArray(request.body.messages?.[0]?.content)));

/** The prompt of a juror request, wherever that API puts it. */
function promptOf(request: Seen): string {
  const parts: any[] = request.path.endsWith('/responses') ? request.body.input[0].content : request.body.messages[0].content;
  if (typeof parts === 'string') return parts;
  // The prompt is the one part that holds the request's question.
  return parts.map(part => part.text).find(text => typeof text === 'string' && text.includes('Does the recording show')) ?? '';
}

describe('a PDF with pictures, jury gpt-5.6-terra + claude-sonnet-5', () => {
  test('each provider is sent the PDF itself, and a Word file is still its extracted text', async () => {
    const { status, body } = await evaluate({
      models: [TERRA, SONNET],
      attachments: [dataUri('application/pdf', framesPdf), dataUri(DOCX_MEDIA_TYPE, coverLetter)],
      attachmentNames: ['submission/recording frames.pdf', 'submission/cover-letter.docx'],
    });

    expect(status).toBe(200);
    expect(body.metadata).toMatchObject({ models_requested: 2, models_successful: 2, models_failed: 0 });

    // OpenAI: Chat Completions, the PDF as a file part with its own name.
    const [openai] = jurorRequests('openai');
    expect(jurorRequests('openai')).toHaveLength(1);
    expect(openai.path).toBe('/openai/v1/chat/completions');
    expect(openai.body.model).toBe('gpt-5.6-terra');
    const openaiParts = openai.body.messages[0].content;
    expect(openaiParts.map((part: any) => part.type)).toEqual(['text', 'file', 'text']);
    expect(openaiParts[1]).toEqual({
      type: 'file',
      file: { file_data: `data:application/pdf;base64,${base64(framesPdf)}`, filename: 'recording frames.pdf' },
    });
    expect(openaiParts[2]).toEqual({ type: 'text', text: 'Cover letter from the hunter. The recording is in the PDF.' });
    expect(openai.body.max_completion_tokens).toBe(16000);

    // Anthropic: the Messages API, the PDF as a base64 document block before the prompt.
    const [anthropic] = jurorRequests('anthropic');
    expect(jurorRequests('anthropic')).toHaveLength(1);
    expect(anthropic.path).toBe('/anthropic/v1/messages');
    expect(anthropic.body.model).toBe('claude-sonnet-5');
    const anthropicBlocks = anthropic.body.messages[0].content;
    expect(anthropicBlocks.map((block: any) => block.type)).toEqual(['document', 'text', 'text']);
    expect(anthropicBlocks[0]).toEqual({
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: base64(framesPdf) },
      title: 'submission/recording frames.pdf',
    });
    expect(anthropicBlocks[2]).toEqual({ type: 'text', text: 'Cover letter from the hunter. The recording is in the PDF.' });
    // Room for a justification (this request used to say 1000), and no sampling parameter Claude 5 rejects.
    expect(anthropic.body.max_tokens).toBe(8192);
    expect(anthropic.body).not.toHaveProperty('temperature');
    expect(anthropic.body).not.toHaveProperty('tools');

    // Neither juror is told it sees only text: both were sent the pages.
    for (const request of [openai, anthropic]) {
      expect(promptOf(request)).toContain('Does the recording show the run to the end?');
      expect(promptOf(request)).not.toContain(TEXT_ONLY);
      expect(promptOf(request)).not.toContain(NOTES_HEADING);
      // The Word file went nowhere as a file.
      expect(JSON.stringify(request.body)).not.toContain(base64(coverLetter).slice(0, 80));
    }

    const native = [{ attachment: 'submission/recording frames.pdf', form: 'native', pages: 19 }];
    expect(body.model_results.map((result: any) => result.pdf_inputs)).toEqual([native, native]);
    expect(body.warnings).toBeUndefined();
  });

  test('with a link in the request (the web-tools requests) the PDF is still sent as a file', async () => {
    const { status, body } = await evaluate({
      prompt: 'Does the recording show the run to the end? The rules are at https://example.org/bounty/398',
      models: [TERRA, SONNET],
      attachments: [dataUri('application/pdf', framesPdf), dataUri(DOCX_MEDIA_TYPE, coverLetter)],
      attachmentNames: ['recording.pdf', 'cover-letter.docx'],
    });

    expect(status).toBe(200);
    expect(body.metadata).toMatchObject({ models_successful: 2 });

    // OpenAI: the Responses API with web_search, the PDF as input_file.
    const [openai] = jurorRequests('openai');
    expect(openai.path).toBe('/openai/v1/responses');
    expect(openai.body.tools).toEqual([{ type: 'web_search' }]);
    const input = openai.body.input[0].content;
    expect(input.map((part: any) => part.type)).toEqual(['input_text', 'input_file', 'input_text']);
    expect(input[1]).toEqual({
      type: 'input_file',
      filename: 'recording.pdf',
      file_data: `data:application/pdf;base64,${base64(framesPdf)}`,
    });
    expect(input[2].text).toBe('Cover letter from the hunter. The recording is in the PDF.');

    // Anthropic: web_fetch and web_search, the same document block.
    const [anthropic] = jurorRequests('anthropic');
    expect(anthropic.headers['anthropic-beta']).toBe('web-fetch-2025-09-10');
    expect(anthropic.body.tools.map((tool: any) => tool.name)).toEqual(['web_fetch', 'web_search']);
    const blocks = anthropic.body.messages[0].content;
    expect(blocks.map((block: any) => block.type)).toEqual(['document', 'text', 'text']);
    expect(blocks[0].source).toEqual({ type: 'base64', media_type: 'application/pdf', data: base64(framesPdf) });

    expect(body.model_results.map((result: any) => result.pdf_inputs[0].form)).toEqual(['native', 'native']);
  });

  // When both jurors got a PDF as its text, a link in that text turned their web tools on
  // (AI_WEB_ACCESS=auto). The file's base64 cannot be searched for one, so sending the file
  // would have turned them off for exactly the juries this change is for.
  test('a link that is only inside the PDF still turns the web tools on, and the text it was found in is not sent', async () => {
    const frame = await frameJpeg();
    const linkedPdf = buildPdf([{ text: 'Run log: https://example.org/run/42 (frame 9).' }, { jpeg: frame }]);

    const { status, body } = await evaluate({
      models: [TERRA, SONNET],
      attachments: [dataUri('application/pdf', linkedPdf)],
      attachmentNames: ['recording.pdf'],
    });

    expect(status).toBe(200);
    expect(body.model_results.map((result: any) => result.pdf_inputs[0].form)).toEqual(['native', 'native']);

    const [openai] = jurorRequests('openai');
    expect(openai.path).toBe('/openai/v1/responses');
    expect(openai.body.tools).toEqual([{ type: 'web_search' }]);
    expect(openai.body.input[0].content.map((part: any) => part.type)).toEqual(['input_text', 'input_file']);

    const [anthropic] = jurorRequests('anthropic');
    expect(anthropic.body.tools.map((tool: any) => tool.name)).toEqual(['web_fetch', 'web_search']);
    expect(anthropic.body.messages[0].content.map((block: any) => block.type)).toEqual(['document', 'text']);

    // The file is what is sent. The extracted text was only read for the link.
    for (const request of [openai, anthropic]) {
      expect(JSON.stringify(request.body)).not.toContain('Run log:');
      expect(JSON.stringify(request.body)).not.toContain('extractedText');
    }
  });

  test('a Word file alone goes to both as text, with nothing sent as a file', async () => {
    const { status } = await evaluate({
      models: [TERRA, SONNET],
      attachments: [dataUri(DOCX_MEDIA_TYPE, coverLetter)],
      attachmentNames: ['cover-letter.docx'],
    });

    expect(status).toBe(200);
    const openaiParts = jurorRequests('openai')[0].body.messages[0].content;
    expect(openaiParts.map((part: any) => part.type)).toEqual(['text', 'text']);
    expect(openaiParts[1].text).toBe('Cover letter from the hunter. The recording is in the PDF.');
    // No PDF: Claude's request is the LangChain one it always was, with the text in it.
    const anthropicBlocks = jurorRequests('anthropic')[0].body.messages[0].content;
    expect(anthropicBlocks.map((block: any) => block.type)).toEqual(['text', 'text']);
    expect(anthropicBlocks[1].text).toBe('Cover letter from the hunter. The recording is in the PDF.');
  });
});

describe('a juror that is not sent the PDF as a PDF gets its text and is told so', () => {
  test('xAI in the jury: Grok gets the text and the note, the other two the file and no note', async () => {
    const { status, body } = await evaluate({
      models: [{ ...TERRA, weight: 0.4 }, { ...SONNET, weight: 0.3 }, { ...GROK, weight: 0.3 }],
      attachments: [dataUri('application/pdf', framesPdf)],
      attachmentNames: ['recording.pdf'],
    });

    expect(status).toBe(200);
    expect(body.metadata).toMatchObject({ models_requested: 3, models_successful: 3 });

    const [grok] = jurorRequests('xai');
    const grokParts = grok.body.messages[0].content;
    expect(grokParts.map((part: any) => part.type)).toEqual(['text', 'text']);
    expect(grokParts[1].text).toBe(
      'Recording of the submission, 16 frames. Frame notes: the counter reads 42 in frame 9. End of recording.',
    );
    expect(grokParts[0].text).toContain(NOTES_HEADING);
    expect(grokParts[0].text).toMatch(textOnlyNote('recording.pdf'));
    expect(JSON.stringify(grok.body)).not.toContain(base64(framesPdf).slice(0, 80));

    // The note is Grok's alone.
    expect(jurorRequests('openai')[0].body.messages[0].content[1].type).toBe('file');
    expect(promptOf(jurorRequests('openai')[0])).not.toContain(TEXT_ONLY);
    expect(jurorRequests('anthropic')[0].body.messages[0].content[0].type).toBe('document');
    expect(promptOf(jurorRequests('anthropic')[0])).not.toContain(TEXT_ONLY);

    expect(body.model_results.map((result: any) => result.pdf_inputs[0])).toEqual([
      { attachment: 'recording.pdf', form: 'native', pages: 19 },
      { attachment: 'recording.pdf', form: 'native', pages: 19 },
      { attachment: 'recording.pdf', form: 'text', pages: 19, reason: 'model' },
    ]);
    // A juror that is simply sent text is no warning: pdf_inputs says which form it got.
    expect(body.warnings).toBeUndefined();
  });

  test('Claude routed through OpenRouter gets the text and the note; OpenAI on its own key still gets the file', async () => {
    process.env.ANTHROPIC_CLASS_PROVIDER = 'openrouter';
    process.env.OPENROUTER_API_KEY = 'stub-key';

    const { status, body } = await evaluate({
      models: [TERRA, SONNET],
      attachments: [dataUri('application/pdf', framesPdf)],
      attachmentNames: ['recording.pdf'],
    });

    expect(status).toBe(200);
    expect(jurorRequests('anthropic')).toHaveLength(0);
    const [claude] = jurorRequests('openrouter');
    expect(claude.body.model).toBe('anthropic/claude-sonnet-5');
    const parts = claude.body.messages[0].content;
    expect(parts.map((part: any) => part.type)).toEqual(['text', 'text']);
    expect(parts[0].text).toMatch(textOnlyNote('recording.pdf'));
    expect(parts[1].text).toContain('the counter reads 42 in frame 9');

    expect(jurorRequests('openai')[0].body.messages[0].content[1].type).toBe('file');
    expect(body.model_results.map((result: any) => result.pdf_inputs[0].form)).toEqual(['native', 'text']);
  });

  test('a jury with no juror that reads PDFs: everyone gets the text and the note, and the file is not opened to count pages', async () => {
    process.env.ANTHROPIC_CLASS_PROVIDER = 'openrouter';
    process.env.OPENROUTER_API_KEY = 'stub-key';

    const { status, body } = await evaluate({
      models: [SONNET, GROK],
      attachments: [dataUri('application/pdf', framesPdf)],
      attachmentNames: ['recording.pdf'],
    });

    expect(status).toBe(200);
    for (const request of [...jurorRequests('openrouter'), ...jurorRequests('xai')]) {
      expect(request.body.messages[0].content[0].text).toMatch(textOnlyNote('recording.pdf'));
      expect(request.body.messages[0].content[1].text).toContain('the counter reads 42 in frame 9');
    }
    expect(jurorRequests('openrouter')).toHaveLength(1);
    expect(jurorRequests('xai')).toHaveLength(1);
    // No page count: nobody could have been sent the file.
    expect(body.model_results.map((result: any) => result.pdf_inputs)).toEqual([
      [{ attachment: 'recording.pdf', form: 'text', reason: 'model' }],
      [{ attachment: 'recording.pdf', form: 'text', reason: 'model' }],
    ]);
    expect(body.warnings).toBeUndefined();
  });

  test('a PDF over the page limit is text for the jurors it is over the limit for, with the reason', async () => {
    const { status, body } = await evaluate({
      models: [TERRA, SONNET],
      attachments: [dataUri('application/pdf', longPdf), dataUri('application/pdf', framesPdf)],
      attachmentNames: ['appendix.pdf', 'recording.pdf'],
    });

    expect(status).toBe(200);
    // 101 pages is over both providers' 100; the 19-page PDF after it still goes as a file.
    const openaiParts = jurorRequests('openai')[0].body.messages[0].content;
    // (The provider puts a request's files before its other attachments.)
    expect(openaiParts.map((part: any) => part.type)).toEqual(['text', 'file', 'text']);
    expect(openaiParts[1].file.filename).toBe('recording.pdf');
    expect(openaiParts[2].text).toContain('Appendix page 101.');
    expect(openaiParts[0].text).toMatch(textOnlyNote('appendix.pdf'));
    expect(openaiParts[0].text).toContain(
      'pictures and page images inside the PDF are not shown. The file itself was not sent: its 101 pages ' +
        'would put this request over the 100 PDF pages a request to this model may hold.',
    );
    const anthropicBlocks = jurorRequests('anthropic')[0].body.messages[0].content;
    expect(anthropicBlocks.map((block: any) => block.type)).toEqual(['document', 'text', 'text']);
    expect(anthropicBlocks[0].title).toBe('recording.pdf');
    expect(anthropicBlocks[1].text).toContain(
      'The file itself was not sent: its 101 pages would put this request over the 100 PDF pages and images a request to this model may hold.',
    );
    // Only appendix.pdf has a line: the recording was sent whole.
    expect(anthropicBlocks[1].text).not.toMatch(textOnlyNote('recording.pdf'));

    expect(body.model_results[0].pdf_inputs).toEqual([
      { attachment: 'appendix.pdf', form: 'text', pages: 101, reason: 'page_limit' },
      { attachment: 'recording.pdf', form: 'native', pages: 19 },
    ]);
    expect(body.warnings.map((warning: any) => [warning.type, warning.model, warning.details.reason])).toEqual([
      ['pdf_text_only', 'openai-gpt-5.6-terra', 'page_limit'],
      ['pdf_text_only', 'anthropic-claude-sonnet-5', 'page_limit'],
    ]);
  });

  test('a PDF with no text layer still reaches the jurors that read PDFs; the one that cannot is told it is not shown', async () => {
    const { status, body } = await evaluate({
      models: [{ ...TERRA, weight: 0.4 }, { ...SONNET, weight: 0.3 }, { ...GROK, weight: 0.3 }],
      attachments: [dataUri('application/pdf', scannedPdf)],
      attachmentNames: ['scan.pdf'],
    });

    expect(status).toBe(200);
    expect(jurorRequests('openai')[0].body.messages[0].content[1].file.file_data).toBe(
      `data:application/pdf;base64,${base64(scannedPdf)}`,
    );
    expect(jurorRequests('anthropic')[0].body.messages[0].content[0].source.data).toBe(base64(scannedPdf));

    // Grok has nothing of it: no attachment at all, and a prompt that says so.
    const [grok] = seen.filter(request => request.api === 'xai');
    const grokPrompt = typeof grok.body.messages[0].content === 'string'
      ? grok.body.messages[0].content
      : grok.body.messages[0].content[0].text;
    expect(grokPrompt).toMatch(
      /- Attachment scan\.pdf \(PDF, \d+ KB\) was delivered with this request, but the arbiter could not read it, so its content is not shown to you\. The file is not missing from the request\.$/,
    );
    // The jurors that have the file are not told the arbiter could not read it.
    expect(promptOf(jurorRequests('openai')[0])).not.toContain('could not read it');
    expect(promptOf(jurorRequests('anthropic')[0])).not.toContain('could not read it');

    expect(body.model_results.map((result: any) => result.pdf_inputs[0])).toEqual([
      { attachment: 'scan.pdf', form: 'native', pages: 2 },
      { attachment: 'scan.pdf', form: 'native', pages: 2 },
      { attachment: 'scan.pdf', form: 'not_shown', pages: 2, reason: 'model' },
    ]);
    // One warning, for the one juror that was shown nothing of it.
    expect(body.warnings).toEqual([
      {
        type: 'attachment_skipped',
        severity: 'warning',
        model: 'xai-grok-4.6',
        message: expect.stringMatching(/^Attachment 1: PDF processing failed: .* Not shown to xai-grok-4\.6; the jurors that read PDFs were sent the file itself\.$/),
        details: { attachment: 'scan.pdf', media_type: 'application/pdf', reason: 'model' },
      },
    ]);
  });

  test('a model its provider sends no attachments to is told what the request held', async () => {
    const { status, body } = await evaluate({
      models: [TERRA, { provider: 'xai', model: 'grok-9-text', weight: 0.5 }],
      attachments: [dataUri('application/pdf', framesPdf), 'A note from the hunter.'],
      attachmentNames: ['recording.pdf', 'note.txt'],
    });

    expect(status).toBe(200);
    const [grok] = seen.filter(request => request.api === 'xai');
    expect(typeof grok.body.messages[0].content).toBe('string'); // the plain request: no attachment parts
    expect(grok.body.messages[0].content).toContain(
      '- Attachments recording.pdf, note.txt were delivered with this request, but this model is sent no attachments, ' +
        'so their content is not shown to you. The files are not missing from the request.',
    );
    expect(body.model_results[1].pdf_inputs).toEqual([
      { attachment: 'recording.pdf', form: 'not_shown', pages: 19, reason: 'no_attachments' },
    ]);
    expect(body.warnings).toEqual([
      expect.objectContaining({ type: 'attachments_not_sent', severity: 'warning', model: 'xai-grok-9-text' }),
    ]);
  });
});

describe('a provider whose request carries images only (Ollama)', () => {
  // Ollama is always the local daemon (LLMFactory builds it with no URL), so its three
  // calls are answered here and every other request goes on to the stub as usual.
  const OLLAMA = 'http://localhost:11434';
  let ollamaRequests: Array<{ path: string; body: any }>;

  beforeEach(() => {
    ollamaRequests = [];
    const realFetch = global.fetch;
    jest.spyOn(global, 'fetch').mockImplementation(async (input: any, init?: any) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (!url.startsWith(OLLAMA)) return realFetch(input, init);
      const path = url.slice(OLLAMA.length);
      if (path === '/api/tags') {
        return new Response(JSON.stringify({ models: [{ name: 'llava:7b', details: { families: ['llama', 'clip'] } }] }));
      }
      ollamaRequests.push({ path, body: JSON.parse(init.body) });
      return new Response(`${JSON.stringify({ response: SCORES, done: true })}\n`);
    });
  });

  test('the juror is sent its image and told what it is not shown, not that a text it never gets "is shown"', async () => {
    const shot = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#00ff00' } }).png().toBuffer();

    const { status, body } = await evaluate({
      models: [TERRA, { provider: 'ollama', model: 'llava:7b', weight: 0.5 }],
      attachments: [dataUri('application/pdf', framesPdf), dataUri('image/png', shot), 'A note from the hunter.'],
      attachmentNames: ['recording.pdf', 'shot.png', 'note.txt'],
    });

    expect(status).toBe(200);
    expect(body.metadata).toMatchObject({ models_successful: 2 });

    expect(ollamaRequests).toHaveLength(1);
    const [ollama] = ollamaRequests;
    expect(ollama.path).toBe('/api/generate');
    expect(ollama.body.images).toEqual([shot.toString('base64')]);
    expect(ollama.body.prompt).toContain(
      '- Attachments recording.pdf, note.txt were delivered with this request, but this model is sent images only, ' +
        'so their content is not shown to you. The files are not missing from the request.',
    );
    // What it said before: a line about text the provider then left out of the request.
    expect(ollama.body.prompt).not.toContain(TEXT_ONLY);
    expect(ollama.body.prompt).not.toContain('Frame notes: the counter reads 42');
    // The route already said it, so the provider's own line has nothing left to name.
    expect(ollama.body.prompt).not.toContain('cannot carry');

    // The juror beside it is unchanged: the file, and no line about it.
    const [openai] = jurorRequests('openai');
    expect(openai.body.messages[0].content.map((part: any) => part.type)).toEqual(['text', 'file', 'image_url', 'text']);
    expect(promptOf(openai)).not.toContain('images only');

    expect(body.model_results[0].pdf_inputs).toEqual([{ attachment: 'recording.pdf', form: 'native', pages: 19 }]);
    expect(body.model_results[1].pdf_inputs).toEqual([
      { attachment: 'recording.pdf', form: 'not_shown', pages: 19, reason: 'images_only' },
    ]);
    expect(body.warnings).toEqual([
      expect.objectContaining({ type: 'attachments_not_sent', severity: 'warning', model: 'ollama-llava:7b' }),
    ]);
  });
});

describe('a provider that turns the PDF down does not cost the juror', () => {
  test('Anthropic answers 400 to the request with the file: Claude is asked again with the text and told why', async () => {
    behaviour = request =>
      request.api === 'anthropic' && JSON.stringify(request.body).includes('"type":"document"')
        ? { status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: 'The PDF specified is password protected.' } } }
        : undefined;

    const { status, body } = await evaluate({
      models: [TERRA, SONNET],
      attachments: [dataUri('application/pdf', framesPdf)],
      attachmentNames: ['recording.pdf'],
    });

    expect(status).toBe(200);
    expect(body.metadata).toMatchObject({ models_requested: 2, models_successful: 2, models_failed: 0 });

    const anthropic = jurorRequests('anthropic');
    expect(anthropic).toHaveLength(2);
    expect(anthropic[0].body.messages[0].content[0].type).toBe('document');
    // The second request has no file: the text, and a prompt that says what happened.
    const retry = anthropic[1].body.messages[0].content;
    expect(JSON.stringify(retry)).not.toContain('"document"');
    expect(JSON.stringify(retry)).toContain('the counter reads 42 in frame 9');
    expect(retry.map((block: any) => block.text).join('\n')).toMatch(textOnlyNote('recording.pdf'));
    expect(JSON.stringify(retry)).toContain(
      'pictures and page images inside the PDF are not shown. The file itself was sent to this model first and was not accepted.',
    );

    // OpenAI was not disturbed.
    expect(jurorRequests('openai')).toHaveLength(1);
    expect(body.model_results.map((result: any) => result.pdf_inputs[0])).toEqual([
      { attachment: 'recording.pdf', form: 'native', pages: 19 },
      { attachment: 'recording.pdf', form: 'text', pages: 19, reason: 'rejected' },
    ]);
    expect(body.warnings).toEqual([
      expect.objectContaining({
        type: 'pdf_text_only',
        severity: 'warning',
        model: 'anthropic-claude-sonnet-5',
        message: expect.stringContaining('rejected: HTTP 400'),
        details: { attachment: 'recording.pdf', reason: 'rejected', pages: 19 },
      }),
    ]);
    expect(body.warnings[0].message).toContain('The PDF specified is password protected.');
  });

  test('a failure that is not about the request (a 500) is not retried as text', async () => {
    behaviour = request => (request.api === 'openai' && Array.isArray(request.body.messages?.[0]?.content)
      ? { status: 500, body: { error: { message: 'The server had an error', type: 'server_error' } } }
      : undefined);

    const { status, body } = await evaluate({
      models: [TERRA, SONNET],
      attachments: [dataUri('application/pdf', framesPdf)],
      attachmentNames: ['recording.pdf'],
    });

    expect(status).toBe(200); // one of two jurors is the minimum
    const openai = jurorRequests('openai');
    // The SDK's own retries of a 500, each with the file; never the text form.
    expect(openai.length).toBeGreaterThanOrEqual(1);
    openai.forEach(request => expect(request.body.messages[0].content[1].type).toBe('file'));
    expect(body.model_results[0]).toMatchObject({ status: 'failed', pdf_inputs: [{ form: 'native' }] });
  });
});
