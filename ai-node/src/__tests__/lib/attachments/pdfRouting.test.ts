/**
 * @jest-environment node
 */
import {
  PDF_LIMITS,
  attachmentsForJuror,
  describePdfInputs,
  withoutAttachments,
} from '../../../lib/attachments/pdfRouting';
import { IMAGE_LIMITS } from '../../../lib/attachments/normalizeImages';
import { PAGE_COUNT_MAX_BYTES } from '../../../lib/attachments/pdfInfo';
import type { NativePdfSupport } from '../../../lib/llm/pdf-support';
import type { PreparedAttachment } from '../../../utils/attachment-processor';

const CLAUDE: NativePdfSupport = { native: true, family: 'anthropic', reason: 'anthropic reads PDFs natively' };
const GPT: NativePdfSupport = { native: true, family: 'openai', reason: 'openai reads PDFs natively' };
const TEXT_ONLY: NativePdfSupport = { native: false, family: null, reason: 'xai requests carry no PDF block' };
const NOTE = 'Only its text is shown to you: pictures and page images inside the PDF are not shown.';

const named = (name: string) => ({ display: name, ref: name });

/** A PDF as prepareAttachments reports it. `megabytes` is the decoded size; no real bytes are held. */
function pdf(name: string, sourceIndex: number, options: { pages?: number | null; megabytes?: number; text?: string | null } = {}): PreparedAttachment {
  const byteLength = Math.round((options.megabytes ?? 0.5) * 1_000_000);
  const text = options.text === undefined ? `text of ${name}` : options.text;
  return {
    sourceIndex,
    name: named(name),
    kind: 'pdf',
    common: text === null ? null : { type: 'text', content: text, mediaType: 'text/plain', size: text.length },
    ...(text === null && { skippedReason: 'PDF processing failed: No text content found. This may be due to the PDF containing only scanned images.' }),
    pdf: {
      content: `<base64 of ${name}>`,
      base64Length: Math.ceil(byteLength / 3) * 4,
      byteLength,
      pages: options.pages === undefined ? 10 : options.pages,
    },
  };
}

function image(name: string, sourceIndex: number): PreparedAttachment {
  return {
    sourceIndex,
    name: named(name),
    kind: 'image',
    common: { type: 'image', content: 'iVBORw0KGgo=', mediaType: 'image/png', size: 12 },
  };
}

function text(name: string, sourceIndex: number, content: string, kind: 'text' | 'document' = 'text'): PreparedAttachment {
  return { sourceIndex, name: named(name), kind, common: { type: 'text', content, mediaType: 'text/plain', size: content.length } };
}

describe('attachmentsForJuror', () => {
  test('a juror that reads PDFs gets the file, in place, with the request\'s name and no note', () => {
    const view = attachmentsForJuror(
      [text('note.txt', 0, 'cover note'), pdf('recording.pdf', 1, { pages: 19 }), image('shot.png', 2)],
      CLAUDE,
    );

    expect(view.attachments).toEqual([
      { type: 'text', content: 'cover note', mediaType: 'text/plain' },
      { type: 'document', content: '<base64 of recording.pdf>', mediaType: 'application/pdf', name: 'recording.pdf' },
      { type: 'image', content: 'iVBORw0KGgo=', mediaType: 'image/png' },
    ]);
    expect(view.notes).toEqual([]);
    expect(view.pdfInputs).toEqual([{ name: 'recording.pdf', form: 'native', pages: 19 }]);
    expect(view.nativePdfs).toBe(1);
  });

  test('a juror that does not gets the text in the same place, and one line saying so', () => {
    const view = attachmentsForJuror(
      [text('note.txt', 0, 'cover note'), pdf('recording.pdf', 1, { pages: 19 })],
      TEXT_ONLY,
    );

    expect(view.attachments).toEqual([
      { type: 'text', content: 'cover note', mediaType: 'text/plain' },
      { type: 'text', content: 'text of recording.pdf', mediaType: 'text/plain' },
    ]);
    expect(view.notes).toEqual([`Attachment recording.pdf is a PDF. ${NOTE}`]);
    expect(view.pdfInputs).toEqual([{ name: 'recording.pdf', form: 'text', pages: 19, reason: 'model' }]);
    expect(view.nativePdfs).toBe(0);
  });

  test('only a PDF is ever a file: a Word document is its text for a juror that reads PDFs too', () => {
    const view = attachmentsForJuror([text('letter.docx', 0, 'the letter', 'document')], CLAUDE);

    expect(view.attachments).toEqual([{ type: 'text', content: 'the letter', mediaType: 'text/plain' }]);
    expect(view.notes).toEqual([]);
    expect(view.pdfInputs).toEqual([]);
  });

  describe('page limits', () => {
    test('both providers take 100 pages and not 101', () => {
      for (const support of [CLAUDE, GPT]) {
        expect(attachmentsForJuror([pdf('a.pdf', 0, { pages: 100 })], support).pdfInputs[0].form).toBe('native');
        const over = attachmentsForJuror([pdf('a.pdf', 0, { pages: 101 })], support);
        expect(over.pdfInputs).toEqual([{ name: 'a.pdf', form: 'text', pages: 101, reason: 'page_limit' }]);
        expect(over.attachments).toEqual([{ type: 'text', content: 'text of a.pdf', mediaType: 'text/plain' }]);
      }
      expect(PDF_LIMITS.ANTHROPIC_MAX_PAGES_PER_REQUEST).toBe(100);
      expect(PDF_LIMITS.OPENAI_MAX_PAGES_PER_REQUEST).toBe(100);
    });

    test('pages add up across the PDFs of a request, in attachment order; a later, smaller one can still fit', () => {
      const view = attachmentsForJuror(
        [pdf('a.pdf', 0, { pages: 60 }), pdf('b.pdf', 1, { pages: 50 }), pdf('c.pdf', 2, { pages: 40 })],
        GPT,
      );

      expect(view.pdfInputs.map(input => [input.name, input.form])).toEqual([
        ['a.pdf', 'native'], ['b.pdf', 'text'], ['c.pdf', 'native'],
      ]);
      expect(view.notes).toEqual([
        `Attachment b.pdf is a PDF. ${NOTE} The file itself was left out because its 50 pages would put this ` +
          'request over the 100 PDF pages a request to this model may hold.',
      ]);
    });

    test('for Claude the images of the request count with the pages (100 images and documents per request); for OpenAI they do not', () => {
      const images = Array.from({ length: 85 }, (_, index) => image(`shot-${index}.png`, index));
      const request = [...images, pdf('recording.pdf', 85, { pages: 19 })];

      // 85 images + 19 pages is over Claude's 100; 85 + 15 is not.
      const claude = attachmentsForJuror(request, CLAUDE);
      expect(claude.pdfInputs).toEqual([{ name: 'recording.pdf', form: 'text', pages: 19, reason: 'page_limit' }]);
      expect(claude.notes[0]).toContain('over the 100 PDF pages and images a request to this model may hold.');
      expect(attachmentsForJuror([...images, pdf('recording.pdf', 85, { pages: 15 })], CLAUDE).pdfInputs[0].form).toBe('native');

      expect(attachmentsForJuror(request, GPT).pdfInputs[0].form).toBe('native');
      expect(IMAGE_LIMITS.ANTHROPIC_MAX_IMAGES_PER_REQUEST).toBe(100);
    });

    test('a PDF the parser could not count is sent as one page: the provider counts for itself', () => {
      const view = attachmentsForJuror([pdf('odd.pdf', 0, { pages: null })], CLAUDE);

      expect(view.pdfInputs).toEqual([{ name: 'odd.pdf', form: 'native' }]);
    });
  });

  describe('size limits', () => {
    test('Claude: the whole request, base64 and all, stays under 20 MB less the safety margin', () => {
      // 14 MB of PDF is 18.7 MB of base64: inside 19 MB. 14.5 MB is 19.3 MB: outside.
      expect(attachmentsForJuror([pdf('a.pdf', 0, { megabytes: 14 })], CLAUDE).pdfInputs[0].form).toBe('native');

      const over = attachmentsForJuror([pdf('a.pdf', 0, { megabytes: 14.5 })], CLAUDE);
      expect(over.pdfInputs).toEqual([{ name: 'a.pdf', form: 'text', pages: 10, reason: 'size_limit' }]);
      expect(over.notes).toEqual([
        `Attachment a.pdf is a PDF. ${NOTE} The file itself was left out because it would put this request over ` +
          "this model's 20 MB request size limit.",
      ]);
      expect(IMAGE_LIMITS.ANTHROPIC_MAX_REQUEST_BYTES).toBe(20_000_000);
    });

    test('Claude: what the images and the text already take is not available to the PDF', () => {
      const tenMegabytesOfImages: PreparedAttachment = {
        ...image('big.png', 0),
        common: { type: 'image', content: 'x'.repeat(10_000_000), mediaType: 'image/png', size: 10_000_000 },
      };

      // 6 MB of PDF is 8 MB of base64: fits beside 10 MB of images. 7 MB (9.3 MB) does not.
      expect(attachmentsForJuror([tenMegabytesOfImages, pdf('a.pdf', 1, { megabytes: 6 })], CLAUDE).pdfInputs[0].form).toBe('native');
      expect(attachmentsForJuror([tenMegabytesOfImages, pdf('a.pdf', 1, { megabytes: 7 })], CLAUDE).pdfInputs[0]).toMatchObject({
        form: 'text', reason: 'size_limit',
      });
    });

    test('the same PDF can be a file for OpenAI (32 MB of files) and text for Claude (20 MB request)', () => {
      const request = [pdf('big.pdf', 0, { megabytes: 20 })];

      expect(attachmentsForJuror(request, GPT).pdfInputs[0].form).toBe('native');
      expect(attachmentsForJuror(request, CLAUDE).pdfInputs[0]).toMatchObject({ form: 'text', reason: 'size_limit' });
    });

    test('OpenAI: the files of a request add up to at most 32 MB', () => {
      const view = attachmentsForJuror([pdf('a.pdf', 0, { megabytes: 20 }), pdf('b.pdf', 1, { megabytes: 20 })], GPT);

      expect(view.pdfInputs.map(input => input.form)).toEqual(['native', 'text']);
      expect(view.notes[0]).toContain('over the 32 MB of files a request to this model may hold.');
      expect(PDF_LIMITS.OPENAI_MAX_FILE_BYTES_PER_REQUEST).toBe(32 * 1024 * 1024);
    });
  });

  describe('a PDF with no text to extract', () => {
    test('still goes to a juror that reads PDFs', () => {
      const view = attachmentsForJuror([pdf('scan.pdf', 0, { pages: 2, text: null })], GPT);

      expect(view.pdfInputs).toEqual([{ name: 'scan.pdf', form: 'native', pages: 2 }]);
      expect(view.notes).toEqual([]);
    });

    test('a juror that does not is sent nothing of it and told so', () => {
      const view = attachmentsForJuror([pdf('scan.pdf', 0, { pages: 2, text: null })], TEXT_ONLY);

      expect(view.attachments).toEqual([]);
      expect(view.pdfInputs).toEqual([{ name: 'scan.pdf', form: 'not_shown', pages: 2, reason: 'model' }]);
      expect(view.notes).toEqual([
        'Attachment scan.pdf is a PDF that is not shown to you: no text could be extracted from it ' +
          '(PDF processing failed: No text content found), and you are not sent the file itself. ' +
          'Judge without it and say so in your justification.',
      ]);
    });
  });

  test('after the provider turned the files down, every PDF that was a file is text, and the note says what happened', () => {
    const request = [pdf('recording.pdf', 0, { pages: 19 }), pdf('long.pdf', 1, { pages: 300 })];

    const first = attachmentsForJuror(request, CLAUDE);
    expect(first.pdfInputs.map(input => input.form)).toEqual(['native', 'text']);

    const again = attachmentsForJuror(request, CLAUDE, { rejected: true });
    expect(again.nativePdfs).toBe(0);
    expect(again.pdfInputs).toEqual([
      { name: 'recording.pdf', form: 'text', pages: 19, reason: 'rejected' },
      { name: 'long.pdf', form: 'text', pages: 300, reason: 'page_limit' },
    ]);
    expect(again.notes[0]).toBe(
      `Attachment recording.pdf is a PDF. ${NOTE} The file itself was sent first and was not accepted.`,
    );
  });

  test('text that was cut off is said to be cut off', () => {
    const long = pdf('long.pdf', 0);
    long.truncatedAt = 100000;

    expect(attachmentsForJuror([long], TEXT_ONLY).notes).toEqual([
      `Attachment long.pdf is a PDF. ${NOTE} Its text was cut off after 100,000 characters.`,
    ]);
    // A juror with the file has the whole document: nothing to say.
    expect(attachmentsForJuror([long], GPT).notes).toEqual([]);
  });

  test('a document that gave no text is named to every juror instead of vanishing', () => {
    const broken: PreparedAttachment = {
      sourceIndex: 0,
      name: named('letter.docx'),
      kind: 'document',
      common: null,
      skippedReason: 'Unable to extract text from application/msword file (12KB).',
    };

    for (const support of [CLAUDE, TEXT_ONLY]) {
      const view = attachmentsForJuror([broken], support);
      expect(view.attachments).toEqual([]);
      expect(view.notes).toEqual([
        'Attachment letter.docx could not be read and is not shown to you: Unable to extract text from application/msword file (12KB).',
      ]);
    }
  });

  test('an attachment without a name is called by its number in the request', () => {
    const unnamed: PreparedAttachment = { ...pdf('x', 2), name: { display: 'Attachment 3', ref: '3' } };

    const view = attachmentsForJuror([unnamed], TEXT_ONLY);
    expect(view.notes).toEqual([`Attachment 3 is a PDF. ${NOTE}`]);
    expect(view.pdfInputs[0].name).toBe('Attachment 3');
  });
});

describe('withoutAttachments', () => {
  test('nothing is attached, the prompt names what the request held, and every PDF is reported not shown', () => {
    const view = withoutAttachments([pdf('recording.pdf', 0, { pages: 19 }), text('note.txt', 1, 'note'), image('shot.png', 2)]);

    expect(view.attachments).toEqual([]);
    expect(view.notes).toEqual([
      'This request has 3 attachments (recording.pdf, note.txt, shot.png) that are not shown to you: this model is ' +
        'sent no attachments. Judge without them and say so in your justification.',
    ]);
    expect(view.pdfInputs).toEqual([{ name: 'recording.pdf', form: 'not_shown', pages: 19, reason: 'no_attachments' }]);
  });

  test('the parts of a split image are one attachment', () => {
    const parts = [text('page.png', 0, '[page.png (part 1 of 2)]'), image('page.png', 0), text('page.png', 0, '[page.png (part 2 of 2)]'), image('page.png', 0)];

    expect(withoutAttachments(parts).notes[0]).toMatch(/^This request has an attachment \(page\.png\) that is not shown to you/);
  });
});

test('no PDF over the size the page counter opens could have been sent as a file anyway', () => {
  // The whole request to Claude is at most 20 MB, base64 included; OpenAI takes 32 MB of files.
  expect(PAGE_COUNT_MAX_BYTES).toBeGreaterThanOrEqual(PDF_LIMITS.OPENAI_MAX_FILE_BYTES_PER_REQUEST);
  expect(PAGE_COUNT_MAX_BYTES).toBeGreaterThanOrEqual(IMAGE_LIMITS.ANTHROPIC_MAX_REQUEST_BYTES);
});

test('describePdfInputs is one short line for the log', () => {
  expect(describePdfInputs([])).toBe('no PDF');
  expect(describePdfInputs([
    { name: 'recording.pdf', form: 'native', pages: 19 },
    { name: 'long.pdf', form: 'text', pages: 300, reason: 'page_limit' },
    { name: 'odd.pdf', form: 'native' },
  ])).toBe('recording.pdf native (19 pages); long.pdf text (page_limit, 300 pages); odd.pdf native');
});
