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
import type { PreparedAttachments, SkippedAttachment } from '../../../utils/attachment-processor';
import type { AttachmentProcessingResult } from '../../../lib/text-extraction/types';

const CLAUDE: NativePdfSupport = { native: true, family: 'anthropic', reason: 'anthropic reads PDFs natively' };
const GPT: NativePdfSupport = { native: true, family: 'openai', reason: 'openai reads PDFs natively' };
const TEXT_ONLY: NativePdfSupport = { native: false, family: null, reason: 'xai requests carry no PDF block' };

/** What a juror that is sent a PDF's text is told (documentNotes), for a text of `characters`. */
const textOnlyNote = (ref: string, characters: number) =>
  `Attachment ${ref} is a PDF. Only its text is shown to you (${characters} characters); ` +
  'pictures and page images inside the PDF are not shown.';

type Item =
  | { kind: 'text'; name: string; content: string }
  | { kind: 'image'; name: string; base64Length?: number }
  | { kind: 'document'; name: string; content: string }
  | { kind: 'pdf'; name: string; pages?: number | null; megabytes?: number; text?: string | null };

const pdf = (name: string, options: Omit<Extract<Item, { kind: 'pdf' }>, 'kind' | 'name'> = {}): Item => ({ kind: 'pdf', name, ...options });
const image = (name: string, base64Length?: number): Item => ({ kind: 'image', name, base64Length });
const text = (name: string, content: string): Item => ({ kind: 'text', name, content });

/** A request as prepareAttachments reports it. A PDF's `megabytes` is its decoded size; no real bytes are held. */
function request(items: Item[]): { prepared: PreparedAttachments; refs: string[] } {
  const results: AttachmentProcessingResult[] = [];
  const skipped: SkippedAttachment[] = [];
  const skippedReasons: string[] = [];
  const pdfs: PreparedAttachments['pdfs'] = new Map();

  items.forEach((item, index) => {
    if (item.kind === 'text') {
      results.push({ sourceIndex: index, attachment: { type: 'text', content: item.content, mediaType: 'text/plain', size: item.content.length } });
    } else if (item.kind === 'image') {
      const content = 'x'.repeat(item.base64Length ?? 12);
      results.push({ sourceIndex: index, attachment: { type: 'image', content, mediaType: 'image/png', size: content.length } });
    } else if (item.kind === 'document') {
      results.push({
        sourceIndex: index,
        attachment: { type: 'text', content: item.content, mediaType: 'text/plain', size: item.content.length },
        extractionResult: {
          content: item.content, extractedLength: item.content.length, processingTime: 1, success: true,
          originalFormat: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        },
      });
    } else {
      const byteLength = Math.round((item.megabytes ?? 0.5) * 1_000_000);
      pdfs.set(index, {
        content: `<base64 of ${item.name}>`,
        base64Length: Math.ceil(byteLength / 3) * 4,
        byteLength,
        pages: item.pages === undefined ? 10 : item.pages,
      });
      const content = item.text === undefined ? `text of ${item.name}` : item.text;
      if (content === null) {
        skipped.push({ index, reason: 'PDF processing failed: no text layer', mediaType: 'application/pdf', bytes: byteLength });
        skippedReasons.push(`Attachment ${index + 1}: PDF processing failed: no text layer`);
      } else {
        results.push({
          sourceIndex: index,
          attachment: { type: 'text', content, mediaType: 'text/plain', size: content.length },
          extractionResult: { content, extractedLength: content.length, processingTime: 1, success: true, originalFormat: 'application/pdf' },
        });
      }
    }
  });

  return {
    prepared: { processed: { results, skipped, skippedReasons, skippedCount: skipped.length }, pdfs, count: items.length },
    refs: items.map(item => item.name),
  };
}

const route = (items: Item[], support: NativePdfSupport, options?: { rejected?: boolean }) => {
  const { prepared, refs } = request(items);
  return attachmentsForJuror(prepared, refs, support, options);
};

describe('attachmentsForJuror', () => {
  test('a juror that reads PDFs gets the file, in place, with the request\'s name and no note', () => {
    const view = route([text('note.txt', 'cover note'), pdf('recording.pdf', { pages: 19 }), image('shot.png')], CLAUDE);

    expect(view.attachments).toEqual([
      { type: 'text', content: 'cover note', mediaType: 'text/plain' },
      { type: 'document', content: '<base64 of recording.pdf>', mediaType: 'application/pdf', name: 'recording.pdf' },
      { type: 'image', content: 'x'.repeat(12), mediaType: 'image/png' },
    ]);
    expect(view.notes).toEqual([]);
    expect(view.pdfInputs).toEqual([{ attachment: 'recording.pdf', form: 'native', pages: 19 }]);
    expect(view.nativePdfs).toBe(1);
  });

  test('a juror that does not gets the text in the same place, and the line saying so', () => {
    const view = route([text('note.txt', 'cover note'), pdf('recording.pdf', { pages: 19 })], TEXT_ONLY);

    expect(view.attachments).toEqual([
      { type: 'text', content: 'cover note', mediaType: 'text/plain' },
      { type: 'text', content: 'text of recording.pdf', mediaType: 'text/plain' },
    ]);
    expect(view.notes).toEqual([textOnlyNote('recording.pdf', 21)]);
    expect(view.pdfInputs).toEqual([{ attachment: 'recording.pdf', form: 'text', pages: 19, reason: 'model' }]);
    expect(view.nativePdfs).toBe(0);
  });

  test('only a PDF is ever a file: a Word document is its text for a juror that reads PDFs too', () => {
    const view = route([{ kind: 'document', name: 'letter.docx', content: 'the letter' }], CLAUDE);

    expect(view.attachments).toEqual([{ type: 'text', content: 'the letter', mediaType: 'text/plain' }]);
    expect(view.notes).toEqual([]);
    expect(view.pdfInputs).toEqual([]);
  });

  test('a PDF the request did not name is called by its number and sent without a file name', () => {
    const { prepared } = request([text('a', 'x'), text('b', 'y'), pdf('unnamed', { pages: 2 })]);
    const refs = ['a', 'b', '3']; // normalizeImages' refs for an attachment with no name

    const native = attachmentsForJuror(prepared, refs, GPT);
    expect(native.attachments[2]).toEqual({ type: 'document', content: '<base64 of unnamed>', mediaType: 'application/pdf' });
    expect(native.pdfInputs).toEqual([{ attachment: '3', form: 'native', pages: 2 }]);

    expect(attachmentsForJuror(prepared, refs, TEXT_ONLY).notes[0]).toMatch(/^Attachment 3 is a PDF\. /);
  });

  describe('page limits', () => {
    test('both providers take 100 pages and not 101', () => {
      for (const support of [CLAUDE, GPT]) {
        expect(route([pdf('a.pdf', { pages: 100 })], support).pdfInputs[0].form).toBe('native');
        const over = route([pdf('a.pdf', { pages: 101 })], support);
        expect(over.pdfInputs).toEqual([{ attachment: 'a.pdf', form: 'text', pages: 101, reason: 'page_limit' }]);
        expect(over.attachments).toEqual([{ type: 'text', content: 'text of a.pdf', mediaType: 'text/plain' }]);
      }
      expect(PDF_LIMITS.ANTHROPIC_MAX_PAGES_PER_REQUEST).toBe(100);
      expect(PDF_LIMITS.OPENAI_MAX_PAGES_PER_REQUEST).toBe(100);
    });

    test('pages add up across the PDFs of a request, in attachment order; a later, smaller one can still fit', () => {
      const view = route([pdf('a.pdf', { pages: 60 }), pdf('b.pdf', { pages: 50 }), pdf('c.pdf', { pages: 40 })], GPT);

      expect(view.pdfInputs.map(input => [input.attachment, input.form])).toEqual([
        ['a.pdf', 'native'], ['b.pdf', 'text'], ['c.pdf', 'native'],
      ]);
      // The line says what the arbiter did with the file, not what to make of it.
      expect(view.notes).toEqual([
        `${textOnlyNote('b.pdf', 13)} The file itself was not sent: its 50 pages would put this request over the ` +
          '100 PDF pages a request to this model may hold.',
      ]);
    });

    test('for Claude the images of the request count with the pages (100 images and documents per request); for OpenAI they do not', () => {
      const images = Array.from({ length: 85 }, (_, index) => image(`shot-${index}.png`));

      // 85 images + 19 pages is over Claude's 100; 85 + 15 is not.
      const claude = route([...images, pdf('recording.pdf', { pages: 19 })], CLAUDE);
      expect(claude.pdfInputs).toEqual([{ attachment: 'recording.pdf', form: 'text', pages: 19, reason: 'page_limit' }]);
      expect(claude.notes[0]).toContain('over the 100 PDF pages and images a request to this model may hold.');
      expect(route([...images, pdf('recording.pdf', { pages: 15 })], CLAUDE).pdfInputs[0].form).toBe('native');

      expect(route([...images, pdf('recording.pdf', { pages: 19 })], GPT).pdfInputs[0].form).toBe('native');
      expect(IMAGE_LIMITS.ANTHROPIC_MAX_IMAGES_PER_REQUEST).toBe(100);
    });

    test('a PDF the parser could not count is sent as one page: the provider counts for itself', () => {
      expect(route([pdf('odd.pdf', { pages: null })], CLAUDE).pdfInputs).toEqual([{ attachment: 'odd.pdf', form: 'native' }]);
    });
  });

  describe('size limits', () => {
    test('Claude: the whole request, base64 and all, stays under 20 MB less the safety margin', () => {
      // 14 MB of PDF is 18.7 MB of base64: inside 19 MB. 14.5 MB is 19.3 MB: outside.
      expect(route([pdf('a.pdf', { megabytes: 14 })], CLAUDE).pdfInputs[0].form).toBe('native');

      const over = route([pdf('a.pdf', { megabytes: 14.5 })], CLAUDE);
      expect(over.pdfInputs).toEqual([{ attachment: 'a.pdf', form: 'text', pages: 10, reason: 'size_limit' }]);
      expect(over.notes).toEqual([
        `${textOnlyNote('a.pdf', 13)} The file itself was not sent: it would put this request over this model's ` +
          '20 MB request size limit.',
      ]);
      expect(IMAGE_LIMITS.ANTHROPIC_MAX_REQUEST_BYTES).toBe(20_000_000);
    });

    test('Claude: what the images and the text already take is not available to the PDF', () => {
      const tenMegabytesOfImages = image('big.png', 10_000_000);

      // 6 MB of PDF is 8 MB of base64: fits beside 10 MB of images. 7 MB (9.3 MB) does not.
      expect(route([tenMegabytesOfImages, pdf('a.pdf', { megabytes: 6 })], CLAUDE).pdfInputs[0].form).toBe('native');
      expect(route([tenMegabytesOfImages, pdf('a.pdf', { megabytes: 7 })], CLAUDE).pdfInputs[0]).toMatchObject({
        form: 'text', reason: 'size_limit',
      });
    });

    test('the same PDF can be a file for OpenAI (32 MB of files) and text for Claude (20 MB request)', () => {
      const items = [pdf('big.pdf', { megabytes: 20 })];

      expect(route(items, GPT).pdfInputs[0].form).toBe('native');
      expect(route(items, CLAUDE).pdfInputs[0]).toMatchObject({ form: 'text', reason: 'size_limit' });
    });

    test('OpenAI: the files of a request add up to at most 32 MB', () => {
      const view = route([pdf('a.pdf', { megabytes: 20 }), pdf('b.pdf', { megabytes: 20 })], GPT);

      expect(view.pdfInputs.map(input => input.form)).toEqual(['native', 'text']);
      expect(view.notes[0]).toContain('over the 32 MB of files a request to this model may hold.');
      expect(PDF_LIMITS.OPENAI_MAX_FILE_BYTES_PER_REQUEST).toBe(32 * 1024 * 1024);
    });
  });

  describe('a PDF with no text to extract', () => {
    test('still goes to a juror that reads PDFs, with nothing said about the arbiter not reading it', () => {
      const view = route([pdf('scan.pdf', { pages: 2, text: null })], GPT);

      expect(view.attachments).toEqual([
        { type: 'document', content: '<base64 of scan.pdf>', mediaType: 'application/pdf', name: 'scan.pdf' },
      ]);
      expect(view.pdfInputs).toEqual([{ attachment: 'scan.pdf', form: 'native', pages: 2 }]);
      expect(view.notes).toEqual([]);
    });

    test('a juror that does not is sent nothing of it and told it was delivered', () => {
      const view = route([pdf('scan.pdf', { pages: 2, megabytes: 0.5, text: null })], TEXT_ONLY);

      expect(view.attachments).toEqual([]);
      expect(view.pdfInputs).toEqual([{ attachment: 'scan.pdf', form: 'not_shown', pages: 2, reason: 'model' }]);
      expect(view.notes).toEqual([
        'Attachment scan.pdf (PDF, 488 KB) was delivered with this request, but the arbiter could not read it, ' +
          'so its content is not shown to you. The file is not missing from the request.',
      ]);
    });
  });

  test('after the provider turned the files down, every PDF that was a file is text, and the line says what happened', () => {
    const items = [pdf('recording.pdf', { pages: 19 }), pdf('long.pdf', { pages: 300 })];

    expect(route(items, CLAUDE).pdfInputs.map(input => input.form)).toEqual(['native', 'text']);

    const again = route(items, CLAUDE, { rejected: true });
    expect(again.nativePdfs).toBe(0);
    expect(again.pdfInputs).toEqual([
      { attachment: 'recording.pdf', form: 'text', pages: 19, reason: 'rejected' },
      { attachment: 'long.pdf', form: 'text', pages: 300, reason: 'page_limit' },
    ]);
    expect(again.notes[0]).toBe(
      `${textOnlyNote('recording.pdf', 21)} The file itself was sent to this model first and was not accepted.`,
    );
  });

  test('two PDFs with the same name are told apart by their place in the request', () => {
    const { prepared, refs } = request([pdf('report.pdf', { pages: 90 }), pdf('report.pdf', { pages: 20 })]);

    const view = attachmentsForJuror(prepared, refs, GPT);
    expect(view.pdfInputs.map(input => input.form)).toEqual(['native', 'text']);
    expect(view.pdfInputByIndex.get(0)?.form).toBe('native');
    expect(view.pdfInputByIndex.get(1)).toMatchObject({ form: 'text', reason: 'page_limit' });
  });
});

describe('withoutAttachments', () => {
  test('nothing is attached, the prompt says what was delivered, and every PDF is reported not shown', () => {
    const { prepared, refs } = request([pdf('recording.pdf', { pages: 19 }), text('note.txt', 'note'), image('shot.png')]);

    const view = withoutAttachments(prepared, refs);
    expect(view.attachments).toEqual([]);
    expect(view.notes).toEqual([
      'Attachments recording.pdf, note.txt, shot.png were delivered with this request, but this model is sent no ' +
        'attachments, so their content is not shown to you. The files are not missing from the request.',
    ]);
    expect(view.pdfInputs).toEqual([{ attachment: 'recording.pdf', form: 'not_shown', pages: 19, reason: 'no_attachments' }]);
  });

  test('the parts of a split image are one attachment', () => {
    const { prepared } = request([text('label', '[page.png (part 1 of 2)]'), image('part'), text('label', '[page.png (part 2 of 2)]'), image('part')]);

    expect(withoutAttachments(prepared, ['page.png', 'page.png', 'page.png', 'page.png']).notes).toEqual([
      'Attachment page.png was delivered with this request, but this model is sent no attachments, so its content ' +
        'is not shown to you. The file is not missing from the request.',
    ]);
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
    { attachment: 'recording.pdf', form: 'native', pages: 19 },
    { attachment: 'long.pdf', form: 'text', pages: 300, reason: 'page_limit' },
    { attachment: 'odd.pdf', form: 'native' },
  ])).toBe('recording.pdf native (19 pages); long.pdf text (page_limit, 300 pages); odd.pdf native');
});
