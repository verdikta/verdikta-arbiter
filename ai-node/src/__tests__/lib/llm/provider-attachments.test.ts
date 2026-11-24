/**
 * @jest-environment node
 *
 * No provider leaves an attachment out without saying so.
 *
 * The rank-and-justify route never hands a provider a file it cannot send: it
 * turns a PDF into text and a note first (attachments/pdfRouting.ts). These
 * tests are the second line, for any other caller: a PDF sent as itself, or a
 * document that was not turned into text, reaches each provider directly, and
 * the request that leaves must say what the model was not shown.
 */
import { HyperbolicProvider } from '../../../lib/llm/hyperbolic-provider';
import { OllamaProvider } from '../../../lib/llm/ollama-provider';
import { OpenRouterProvider } from '../../../lib/llm/openrouter-provider';
import { XAIProvider } from '../../../lib/llm/xai-provider';
import {
  ProviderAttachment,
  isPdfAttachment,
  notShownNote,
  partitionAttachments,
  pdfFileName,
  withNotShownNote,
} from '../../../lib/llm/provider-attachments';

jest.mock('../../../config/models', () => ({
  modelConfig: {
    xai: [{ name: 'grok-4.6', supportsImages: true, supportsAttachments: true }],
    hyperbolic: [{ name: 'Qwen/Qwen3-235B-A22B-Instruct-2507', supportsImages: true, supportsAttachments: true }],
  },
}));

const PDF: ProviderAttachment = { type: 'document', content: 'JVBERi0xLjQK', mediaType: 'application/pdf', name: 'recording.pdf' };
const DOCX: ProviderAttachment = {
  type: 'document',
  content: 'UEsDBBQABgAIAAAAIQ',
  mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};
const IMAGE: ProviderAttachment = { type: 'image', content: 'iVBORw0KGgo=', mediaType: 'image/png' };
const TEXT: ProviderAttachment = { type: 'text', content: 'A cover note.', mediaType: 'text/plain' };

describe('the shared helper', () => {
  test('a PDF is a PDF only as a file: its extracted text is text', () => {
    expect(isPdfAttachment(PDF)).toBe(true);
    expect(isPdfAttachment({ type: 'text', content: 'words', mediaType: 'application/pdf' })).toBe(false);
    expect(isPdfAttachment(DOCX)).toBe(false);
  });

  test('partition: PDFs apart when the request takes them, anything it cannot carry apart always', () => {
    const all = [TEXT, PDF, IMAGE, DOCX];

    expect(partitionAttachments(all, true)).toEqual({ pdfs: [PDF], inline: [TEXT, IMAGE], notShown: [DOCX] });
    expect(partitionAttachments(all, false)).toEqual({ pdfs: [], inline: [TEXT, IMAGE], notShown: [PDF, DOCX] });
    // A request with no place for text attachments (Ollama).
    expect(partitionAttachments(all, false, false)).toEqual({ pdfs: [], inline: [IMAGE], notShown: [TEXT, PDF, DOCX] });
  });

  test('the note names what is missing and why, and there is none when nothing is', () => {
    expect(notShownNote([], 'xAI grok-4.6')).toBeNull();
    expect(withNotShownNote('Judge this.', [], 'xAI grok-4.6')).toBe('Judge this.');
    // What was done with the file, and that it was delivered: never what to conclude.
    expect(notShownNote([PDF], 'xAI grok-4.6')).toBe(
      '[One attachment (PDF "recording.pdf") was delivered with this request, but a request to xAI grok-4.6 cannot ' +
        'carry it, so its content is not shown to you. The file is not missing from the request.]',
    );
    expect(withNotShownNote('Judge this.', [PDF, DOCX], 'OpenRouter openai/gpt-6-luna')).toBe(
      'Judge this.\n\n[2 attachments (PDF "recording.pdf", ' +
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document file) were delivered with this request, ' +
        'but a request to OpenRouter openai/gpt-6-luna cannot carry them, so their content is not shown to you. ' +
        'The files are not missing from the request.]',
    );
    expect(notShownNote([PDF], 'xAI grok-4.6')).not.toMatch(/judge|justification|score/i);
  });

  test.each([
    ['submission/recording frames.pdf', 0, 'recording frames.pdf'],
    ['C:\\Users\\hunter\\proof.PDF', 0, 'proof.PDF'],
    ['evidence', 0, 'evidence.pdf'],
    ['отчёт №3.pdf', 0, '3.pdf'],
    ['../../etc/passwd', 0, 'passwd.pdf'],
    ['.pdf', 0, 'document.pdf'],
    ['', 0, 'document.pdf'],
    [undefined, 0, 'document.pdf'],
    [undefined, 2, 'document-3.pdf'],
    ['Attachment 3', 2, 'Attachment 3.pdf'],
  ])('pdfFileName(%j, %i) is %j: one path segment, plain characters, always .pdf', (name, position, expected) => {
    expect(pdfFileName(name as string | undefined, position)).toBe(expected);
  });

  test('pdfFileName keeps a very long name to 96 characters and the extension', () => {
    expect(pdfFileName(`${'a'.repeat(300)}.pdf`, 0)).toBe(`${'a'.repeat(96)}.pdf`);
  });
});

describe('providers whose request carries images and text only', () => {
  const savedEnv = { ...process.env };
  let fetchMock: jest.Mock;

  beforeEach(() => {
    process.env.XAI_API_KEY = 'test-key';
    process.env.HYPERBOLIC_API_KEY = 'test-key';
    process.env.OPENROUTER_API_KEY = 'test-key';
    fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: '{"score":[1000000,0],"justification":"ok"}' } }] }),
      text: async () => '',
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
    process.env = { ...savedEnv };
  });

  const sentContent = () => JSON.parse(fetchMock.mock.calls[0][1].body).messages[0].content as any[];
  const expectTold = (content: any[], who: string) => {
    // The prompt says what is missing, and no part of the request holds the file's base64.
    expect(content[0].text).toContain(
      `[2 attachments (PDF "recording.pdf", ${DOCX.mediaType} file) were delivered with this request, ` +
        `but a request to ${who} cannot carry them, so their content is not shown to you.`,
    );
    expect(JSON.stringify(content)).not.toContain(PDF.content);
    expect(JSON.stringify(content)).not.toContain(DOCX.content);
  };

  test('xAI: a file used to be skipped without a word', async () => {
    await new XAIProvider().generateResponseWithAttachments('Judge this.', 'grok-4.6', [TEXT, PDF, IMAGE, DOCX]);

    const content = sentContent();
    expect(content.map(part => part.type)).toEqual(['text', 'text', 'image_url']);
    expect(content[1].text).toBe('A cover note.');
    expectTold(content, 'xAI grok-4.6');
  });

  test('Hyperbolic: a file used to be skipped without a word', async () => {
    await new HyperbolicProvider().generateResponseWithAttachments(
      'Judge this.', 'Qwen/Qwen3-235B-A22B-Instruct-2507', [TEXT, PDF, IMAGE, DOCX],
    );

    const content = sentContent();
    expect(content.map(part => part.type)).toEqual(['text', 'text', 'image_url']);
    expectTold(content, 'Hyperbolic Qwen/Qwen3-235B-A22B-Instruct-2507');
  });

  test('OpenRouter: a file used to go out as if its base64 were its text', async () => {
    await new OpenRouterProvider(undefined, 'anthropic').generateResponseWithAttachments(
      'Judge this.', 'claude-sonnet-5', [TEXT, PDF, IMAGE, DOCX],
    );

    const content = sentContent();
    expect(content.map(part => part.type)).toEqual(['text', 'text', 'image_url']);
    expect(content[1].text).toBe('A cover note.');
    expectTold(content, 'OpenRouter claude-sonnet-5');
  });

  test.each([
    ['xAI', () => new XAIProvider().generateResponseWithAttachments('Judge this.', 'grok-4.6', [TEXT, IMAGE])],
    ['OpenRouter', () => new OpenRouterProvider(undefined, 'openai').generateResponseWithAttachments('Judge this.', 'gpt-6-luna', [TEXT, IMAGE])],
  ])('%s: a request with only text and images is unchanged', async (_name, call) => {
    await call();

    const content = sentContent();
    expect(content[0]).toEqual({ type: 'text', text: 'Judge this.' });
    expect(content.map(part => part.type)).toEqual(['text', 'text', 'image_url']);
  });
});

describe('Ollama: a prompt and at most one image', () => {
  let provider: OllamaProvider;

  beforeEach(() => {
    provider = new OllamaProvider('http://localhost:11434');
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('text attachments (a PDF reaches Ollama as its text) used to be left out without a word', async () => {
    const generate = jest.spyOn(provider, 'generateResponse').mockResolvedValue('answer');

    await provider.generateResponseWithAttachments('Judge this.', 'llava:7b', [
      { type: 'text', content: 'text of recording.pdf', mediaType: 'text/plain', name: 'recording.pdf' },
    ]);

    expect(generate).toHaveBeenCalledWith(
      'Judge this.\n\n[One attachment (text attachment "recording.pdf") was delivered with this request, but a request ' +
        'to Ollama llava:7b cannot carry it, so its content is not shown to you. The file is not missing from the request.]',
      'llava:7b',
    );
  });

  test('the note goes with the image too', async () => {
    const withImage = jest.spyOn(provider, 'generateResponseWithImage').mockResolvedValue('answer');

    await provider.generateResponseWithAttachments('Judge this.', 'llava:7b', [IMAGE, TEXT]);

    const [prompt, model, content, mediaType] = withImage.mock.calls[0];
    expect(prompt).toContain('[One attachment (text attachment) was delivered with this request, but a request to Ollama llava:7b cannot carry it');
    expect([model, content, mediaType]).toEqual(['llava:7b', IMAGE.content, 'image/png']);
  });

  test('an image alone is sent as before', async () => {
    const withImage = jest.spyOn(provider, 'generateResponseWithImage').mockResolvedValue('answer');

    await provider.generateResponseWithAttachments('Judge this.', 'llava:7b', [IMAGE]);

    expect(withImage).toHaveBeenCalledWith('Judge this.', 'llava:7b', IMAGE.content, 'image/png');
  });
});
