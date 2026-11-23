/**
 * @jest-environment node
 */
import sharp from 'sharp';
import {
  DOCX_MEDIA_TYPE,
  buildDocx,
  buildPdf,
  dataUri,
  frameJpeg,
} from '../../test-support/attachment-fixtures';
import { pdfPageCount } from '../../src/lib/attachments/pdfInfo';
import { textExtractor } from '../../src/lib/text-extraction/text-extractor';
import {
  PreparedAttachment,
  documentNotes,
  prepareAttachments,
  processAttachments,
} from '../../src/utils/attachment-processor';

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

      const prepared = await prepareAttachments(
        [dataUri(PDF, pdf), dataUri(DOCX_MEDIA_TYPE, docx), dataUri('image/png', png), 'A plain note.'],
        { names: ['submission/recording.pdf', 'letter.docx', 'shot.png'] },
      );

      expect(prepared.map(attachment => attachment.kind)).toEqual(['pdf', 'document', 'image', 'text']);
      expect(prepared.map(attachment => attachment.name.display)).toEqual([
        'submission/recording.pdf', 'letter.docx', 'shot.png', 'Attachment 4',
      ]);

      // The PDF: its text for a juror that is sent text, the file for one that reads PDFs.
      expect(prepared[0].common).toMatchObject({ type: 'text', mediaType: 'text/plain' });
      expect(prepared[0].common!.content).toBe('Page one of the recording. Frame 9: the counter reads 42.');
      expect(prepared[0].pdf).toEqual({
        content: pdf.toString('base64'),
        base64Length: pdf.toString('base64').length,
        byteLength: pdf.length,
        pages: 3,
      });

      // Everything else has exactly one form: no file to send for a Word document.
      expect(prepared[1].common).toMatchObject({ type: 'text', content: 'Cover letter. Second paragraph.' });
      expect(prepared[1].pdf).toBeUndefined();
      expect(prepared[2].common).toMatchObject({ type: 'image', mediaType: 'image/png', content: png.toString('base64') });
      expect(prepared[3].common).toMatchObject({ type: 'text', content: 'A plain note.' });
    });

    test('a PDF with no text layer keeps its file and its page count, and says why it has no text', async () => {
      const scan = buildPdf([{ jpeg: frame }, { jpeg: frame }]);

      const [prepared] = await prepareAttachments([dataUri(PDF, scan)], { names: ['scan.pdf'] });

      expect(prepared.kind).toBe('pdf');
      expect(prepared.common).toBeNull();
      expect(prepared.skippedReason).toMatch(/^PDF processing failed: /);
      expect(prepared.pdf).toMatchObject({ pages: 2, byteLength: scan.length });
    });

    test('a file that only says it is a PDF is still read: the bytes decide, not the header', async () => {
      const pdf = buildPdf([{ text: 'Mislabelled but real.' }]);

      const [prepared] = await prepareAttachments([dataUri('application/octet-stream', pdf)]);

      expect(prepared.kind).toBe('pdf');
      expect(prepared.pdf?.pages).toBe(1);
      expect(prepared.common?.content).toBe('Mislabelled but real.');
    });

    test('base64 wrapped across lines is unbroken in the file form: the providers take no line breaks', async () => {
      const pdf = buildPdf([{ text: 'Wrapped in transit.', jpeg: frame }]);
      const wrapped = pdf.toString('base64').replace(/(.{76})/g, '$1\r\n');
      expect(wrapped).toMatch(/\r\n/);

      const [prepared] = await prepareAttachments([`data:${PDF};base64,${wrapped}`]);

      expect(prepared.pdf).toEqual({
        content: pdf.toString('base64'),
        base64Length: pdf.toString('base64').length,
        byteLength: pdf.length,
        pages: 1,
      });
      expect(prepared.common?.content).toBe('Wrapped in transit.');
    });

    test('a PDF the parser cannot open has no page count, and the file is kept for the provider to judge', async () => {
      const broken = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(600, 0x41)]);

      const [prepared] = await prepareAttachments([dataUri(PDF, broken)], { names: ['broken.pdf'] });

      expect(prepared.kind).toBe('pdf');
      expect(prepared.pdf).toMatchObject({ pages: null, byteLength: broken.length });
    });

    test('with no juror that reads PDFs the file is not opened for a page count', async () => {
      const pdf = buildPdf([{ text: 'Nobody will be sent this file.' }, { text: 'Page two.' }]);

      const [prepared] = await prepareAttachments([dataUri(PDF, pdf)], { countPdfPages: false });

      expect(prepared.pdf).toMatchObject({ pages: null, byteLength: pdf.length });
      expect(prepared.common?.content).toBe('Nobody will be sent this file. Page two.');
    });

    test('names follow the attachment through image normalization (sourceIndexes)', async () => {
      // As after a screenshot at index 1 was split into two labelled parts.
      const pdf = buildPdf([{ text: 'After the screenshot.' }]);
      const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#00ff00' } }).png().toBuffer();

      const prepared = await prepareAttachments(
        ['first note', '[page.png (part 1 of 2)]', dataUri('image/png', png), '[page.png (part 2 of 2)]', dataUri('image/png', png), dataUri(PDF, pdf)],
        { names: ['note.txt', 'page.png', 'recording.pdf'], sourceIndexes: [0, 1, 1, 1, 1, 2] },
      );

      expect(prepared.map(attachment => [attachment.sourceIndex, attachment.name.display])).toEqual([
        [0, 'note.txt'], [1, 'page.png'], [1, 'page.png'], [1, 'page.png'], [1, 'page.png'], [2, 'recording.pdf'],
      ]);
    });

    test('text cut off at the extraction limit is marked, so the juror can be told', async () => {
      const line = 'A long report line that repeats to fill many pages of text. ';
      const long = buildPdf(Array.from({ length: 60 }, () => ({ text: line.repeat(30) })));

      const [prepared] = await prepareAttachments([dataUri(PDF, long)], { names: ['long.pdf'] });

      expect(prepared.common!.content.length).toBe(100000);
      expect(prepared.truncatedAt).toBe(100000);
    });
  });

  describe('small PDFs are read from their own bytes', () => {
    // pdf.js 1.10 reads sub-streams from the underlying ArrayBuffer and drops the
    // view's offset. A Node Buffer under 4 kB sits at an offset in a shared pool, so
    // before pdfParseInput these three, parsed in turn, gave "bad XRef entry" or the
    // text and page count of whichever file was parsed before (measured in plain Node).
    const small = () => [
      { pdf: buildPdf([{ text: 'Alpha one.' }, { text: 'Alpha two.' }, { text: 'Alpha three.' }]), pages: 3, text: 'Alpha one. Alpha two. Alpha three.' },
      { pdf: buildPdf([{ text: 'Beta one.' }, { text: 'Beta two.' }]), pages: 2, text: 'Beta one. Beta two.' },
      { pdf: buildPdf(Array.from({ length: 7 }, (_, page) => ({ text: `Gamma ${page + 1}.` }))), pages: 7, text: 'Gamma 1. Gamma 2. Gamma 3. Gamma 4. Gamma 5. Gamma 6. Gamma 7.' },
    ];

    test('page counts', async () => {
      const files = small();
      files.forEach(file => expect(file.pdf.length).toBeLessThan(4096));

      for (const file of [...files, ...files.slice().reverse()]) {
        expect(await pdfPageCount(file.pdf)).toBe(file.pages);
      }
    });

    test('extracted text, without the pdftotext fallback', async () => {
      const warn = console.warn as jest.Mock;
      for (const file of [...small(), ...small().reverse()]) {
        // As the route decodes it: a Buffer from base64, pooled when small.
        const result = await textExtractor.extractFromBase64(dataUri(PDF, file.pdf), PDF);
        expect(result).toMatchObject({ success: true, content: file.text });
      }
      // pdf-parse read every file itself.
      expect(warn.mock.calls.filter(call => String(call[0]).includes('pdf-parse failed'))).toEqual([]);
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

    test('without it (the default) a PDF is its text', async () => {
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

    test('a PDF with no text is skipped with its reason, as before', async () => {
      const scan = buildPdf([{ jpeg: frame }]);

      const { results, skippedCount, skippedReasons } = await processAttachments([dataUri(PDF, scan)]);

      expect(results).toEqual([]);
      expect(skippedCount).toBe(1);
      expect(skippedReasons[0]).toMatch(/^Attachment 1: PDF processing failed: /);
    });
  });

  describe('documentNotes', () => {
    const attachment = (overrides: Partial<PreparedAttachment> = {}): PreparedAttachment => ({
      sourceIndex: 0,
      name: { display: 'recording.pdf', ref: 'recording.pdf' },
      kind: 'pdf',
      common: { type: 'text', content: 'text', mediaType: 'text/plain', size: 4 },
      pdf: { content: '', base64Length: 0, byteLength: 0, pages: 19 },
      ...overrides,
    });

    test('says that only the text is shown, in the words a juror can act on', () => {
      expect(documentNotes([{ attachment: attachment(), form: 'text', reason: 'model' }])).toEqual([
        'Attachment recording.pdf is a PDF. Only its text is shown to you: pictures and page images inside the PDF are not shown.',
      ]);
    });

    test('one line per PDF, in order, and none for an empty list', () => {
      expect(documentNotes([])).toEqual([]);
      const notes = documentNotes([
        { attachment: attachment(), form: 'text', reason: 'model' },
        { attachment: attachment({ name: { display: 'Attachment 4', ref: '4' } }), form: 'text', reason: 'rejected' },
      ]);
      expect(notes).toHaveLength(2);
      expect(notes[1]).toMatch(/^Attachment 4 is a PDF\. .* The file itself was sent first and was not accepted\.$/);
    });
  });
});
