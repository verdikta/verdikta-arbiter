/**
 * @jest-environment node
 */
// prepareAttachments: every attachment of a request in each form a juror can be sent.
// What a juror is told about a document is documentNotes.test.ts; the text of a PDF on a
// host with nothing but Node is pdfHandler.test.ts.

import sharp from 'sharp';
import {
  DOCX_MEDIA_TYPE,
  buildDocx,
  buildPdf,
  dataUri,
  frameJpeg,
} from '../../test-support/attachment-fixtures';
import { PAGE_COUNT_MAX_BYTES, pdfPageCount } from '../../src/lib/attachments/pdfInfo';
import { prepareAttachments, processAttachments } from '../../src/utils/attachment-processor';

const PDF = 'application/pdf';

describe('attachment processor', () => {
  let frame: { data: Buffer; width: number; height: number };

  beforeAll(async () => {
    frame = await frameJpeg();
  });

  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('prepareAttachments: every form of each attachment, once per request', () => {
    test('a PDF with text and pictures has both forms; a Word file, an image and text have one', async () => {
      const pdf = buildPdf([{ text: 'Page one of the recording.' }, { jpeg: frame }, { text: 'Frame 9: the counter reads 42.', jpeg: frame }]);
      const docx = await buildDocx(['Cover letter.', 'Second paragraph.']);
      const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#ff0000' } }).png().toBuffer();

      const prepared = await prepareAttachments([
        dataUri(PDF, pdf), dataUri(DOCX_MEDIA_TYPE, docx), dataUri('image/png', png), 'A plain note.',
      ]);

      expect(prepared.count).toBe(4);
      expect(prepared.processed.skipped).toEqual([]);
      // The form every model can be sent, by position in the request.
      expect(prepared.processed.results.map(result => [result.sourceIndex, result.attachment.type])).toEqual([
        [0, 'text'], [1, 'text'], [2, 'image'], [3, 'text'],
      ]);
      expect(prepared.processed.results[0].attachment.content).toBe('Page one of the recording. Frame 9: the counter reads 42.');
      expect(prepared.processed.results[1].attachment.content).toBe('Cover letter. Second paragraph.');
      expect(prepared.processed.results[2].attachment).toMatchObject({ mediaType: 'image/png', content: png.toString('base64') });
      expect(prepared.processed.results[3].attachment.content).toBe('A plain note.');

      // Only the PDF has a second form: the file itself. There is none for a Word document.
      expect(Array.from(prepared.pdfs.keys())).toEqual([0]);
      expect(prepared.pdfs.get(0)).toEqual({
        content: pdf.toString('base64'),
        base64Length: pdf.toString('base64').length,
        byteLength: pdf.length,
        pages: 3,
      });
    });

    test('a PDF with no text layer keeps its file and its page count, and is listed as unread', async () => {
      const scan = buildPdf([{ jpeg: frame }, { jpeg: frame }]);

      const prepared = await prepareAttachments(['A cover note.', dataUri(PDF, scan)]);

      expect(prepared.processed.results.map(result => result.sourceIndex)).toEqual([0]);
      expect(prepared.processed.skipped).toEqual([
        expect.objectContaining({ index: 1, mediaType: PDF, reason: expect.stringMatching(/^PDF processing failed: /) }),
      ]);
      expect(prepared.pdfs.get(1)).toMatchObject({ pages: 2, byteLength: scan.length });
    });

    test('a file that only says it is something else is still a PDF: the bytes decide, not the header', async () => {
      const pdf = buildPdf([{ text: 'Mislabelled but real.' }]);

      const prepared = await prepareAttachments([dataUri('application/octet-stream', pdf)]);

      expect(prepared.pdfs.get(0)?.pages).toBe(1);
      expect(prepared.processed.results[0].attachment.content).toBe('Mislabelled but real.');
    });

    test('a file that only says it is a PDF is not one', async () => {
      const prepared = await prepareAttachments([dataUri(PDF, await buildDocx(['Really a Word file.']))]);

      expect(prepared.pdfs.size).toBe(0);
    });

    test('base64 wrapped across lines is unbroken in the file form: the providers take no line breaks', async () => {
      const pdf = buildPdf([{ text: 'Wrapped in transit.', jpeg: frame }]);
      const wrapped = pdf.toString('base64').replace(/(.{76})/g, '$1\r\n');
      expect(wrapped).toMatch(/\r\n/);

      const prepared = await prepareAttachments([`data:${PDF};base64,${wrapped}`]);

      expect(prepared.pdfs.get(0)).toEqual({
        content: pdf.toString('base64'),
        base64Length: pdf.toString('base64').length,
        byteLength: pdf.length,
        pages: 1,
      });
      expect(prepared.processed.results[0].attachment.content).toBe('Wrapped in transit.');
    });

    test('a PDF the parser cannot open has no page count, and the file is kept for the provider to judge', async () => {
      const broken = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(600, 0x41)]);

      const prepared = await prepareAttachments([dataUri(PDF, broken)]);

      expect(prepared.pdfs.get(0)).toMatchObject({ pages: null, byteLength: broken.length });
      expect(prepared.processed.skipped).toHaveLength(1);
    });

    test('with no juror that reads PDFs the file is not opened for a page count', async () => {
      const pdf = buildPdf([{ text: 'Nobody will be sent this file.' }, { text: 'Page two.' }]);

      const prepared = await prepareAttachments([dataUri(PDF, pdf)], { countPdfPages: false });

      expect(prepared.pdfs.get(0)).toMatchObject({ pages: null, byteLength: pdf.length });
      expect(prepared.processed.results[0].attachment.content).toBe('Nobody will be sent this file. Page two.');
    });

    test('an attachment that could not be processed for another reason is still sent, as its error text', async () => {
      // Not a string and not an attachment object: processing throws, and the models get a line saying so.
      const prepared = await prepareAttachments(['first', 42 as unknown as string, 'third']);

      expect(prepared.processed.results.map(result => result.sourceIndex)).toEqual([0, 1, 2]);
      expect(prepared.processed.results[1].attachment.content).toMatch(/^\[Error processing attachment 2: /);
    });
  });

  describe('the page count', () => {
    // pdf.js 1.10 reads a small Buffer's cross-reference table from the wrong bytes
    // (pdf-handler.ts, plainBytes): parsed in turn, these gave "bad XRef entry" or the
    // page count of whichever file was parsed before.
    test('small PDFs are counted from their own bytes', async () => {
      const files = [
        { pdf: buildPdf([{ text: 'Alpha one.' }, { text: 'Alpha two.' }, { text: 'Alpha three.' }]), pages: 3 },
        { pdf: buildPdf([{ text: 'Beta one.' }, { text: 'Beta two.' }]), pages: 2 },
        { pdf: buildPdf(Array.from({ length: 7 }, (_, page) => ({ text: `Gamma ${page + 1}.` }))), pages: 7 },
      ];
      files.forEach(file => expect(file.pdf.length).toBeLessThan(4096));

      for (const file of [...files, ...files.slice().reverse()]) {
        expect(await pdfPageCount(file.pdf)).toBe(file.pages);
      }
    });

    test('a PDF of pictures has pages to count', async () => {
      expect(await pdfPageCount(buildPdf(Array.from({ length: 19 }, () => ({ jpeg: frame }))))).toBe(19);
    });

    test('a file no provider would take as a file is not opened', async () => {
      const tooLarge = Buffer.alloc(PAGE_COUNT_MAX_BYTES + 1, 0x20);
      buildPdf([{ text: 'Real, but padded past the limit.' }]).copy(tooLarge);

      expect(await pdfPageCount(tooLarge)).toBeNull();
    });
  });

  describe('processAttachments: one model, one form per attachment', () => {
    test('nativePdf keeps a PDF as a document and still extracts a Word file', async () => {
      const pdf = buildPdf([{ text: 'Kept whole.', jpeg: frame }]);
      const docx = await buildDocx(['Always text.']);

      const { results, skippedCount } = await processAttachments(
        [dataUri(PDF, pdf), dataUri(DOCX_MEDIA_TYPE, docx)],
        { nativePdf: true },
      );

      expect(skippedCount).toBe(0);
      expect(results.map(result => result.attachment)).toEqual([
        { type: 'document', content: pdf.toString('base64'), mediaType: PDF, size: pdf.toString('base64').length },
        { type: 'text', content: 'Always text.', mediaType: 'text/plain', size: 12 },
      ]);
    });

    test('without it (the default) a PDF is its text, whatever the model: there is no model list here', async () => {
      const pdf = buildPdf([{ text: 'Only the words.', jpeg: frame }]);

      for (const options of [undefined, {}, { nativePdf: false }]) {
        const { results } = await processAttachments([dataUri(PDF, pdf)], options);
        expect(results.map(result => result.attachment)).toEqual([
          { type: 'text', content: 'Only the words.', mediaType: 'text/plain', size: 15 },
        ]);
      }
    });

    test('object attachments (the generate route) follow the same rule', async () => {
      const pdf = buildPdf([{ text: 'From a form upload.' }]);
      const upload = { type: 'document', content: pdf.toString('base64'), mediaType: PDF, filename: 'upload.pdf' };

      const native = await processAttachments([upload], { nativePdf: true });
      expect(native.results[0].attachment).toMatchObject({ type: 'document', mediaType: PDF, filename: 'upload.pdf' });

      const text = await processAttachments([upload], { nativePdf: false });
      expect(text.results[0].attachment).toMatchObject({ type: 'text', content: 'From a form upload.', filename: 'upload.pdf' });
    });
  });
});
