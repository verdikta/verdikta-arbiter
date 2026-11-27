/**
 * @jest-environment node
 */
// A PDF's text must be readable on a host that has nothing but Node: no poppler
// (`pdftotext`), which no installer step provides. Bounty 398's second submission lost
// its PDF because pdf-parse never loaded inside the server and textract found no pdftotext.
// (jest gives a test its own copy of process.env, so PATH cannot hide the binary from
// textract's child process: both conditions are mocked here instead.)

import { PDFHandler } from '../../src/lib/text-extraction/format-handlers/pdf-handler';
import { buildPdf } from '../../test-support/pdf-fixture';

// A host without poppler: textract answers as it does when `pdftotext` is not installed.
jest.mock('textract', () => ({
  __esModule: true,
  default: {
    fromBufferWithMime: (_mime: string, _buffer: Buffer, callback: (error: Error) => void) =>
      callback(new Error("INFO: 'pdftotext' does not appear to be installed, so textract will be unable to extract PDFs.")),
  },
}));

// The package root's index.js runs a self-test inside a bundle and throws ENOENT, which is
// what the Next.js server saw on every PDF. Nothing may load it.
jest.mock('pdf-parse', () => {
  throw new Error("ENOENT: no such file or directory, open './test/data/05-versions-space.pdf'");
});

jest.setTimeout(60_000);

describe('PDFHandler without pdftotext on the host', () => {
  beforeAll(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterAll(() => {
    jest.restoreAllMocks();
  });

  test('reads the text layer of every page', async () => {
    const pdf = buildPdf(['E3 - Recording frames and metadata', 'Frame at 0:18: chosen bounty detail']);
    const text = await new PDFHandler().extractText(pdf, 'application/pdf');
    expect(text).toContain('E3 - Recording frames and metadata');
    expect(text).toContain('Frame at 0:18: chosen bounty detail');
  });

  test('reads a small PDF decoded into Node\'s shared buffer pool', async () => {
    // What the route does with an attachment: base64 to Buffer. Under 4 KB that is a slice
    // of the 8 KB pool, where the bundled pdf.js used to read some other bytes. Several
    // in a row, so the pool offset moves between them.
    for (const line of ['A one-line attestation', 'Second small document', 'Third small document']) {
      const pooled = Buffer.from(buildPdf([line]).toString('base64'), 'base64');
      expect(pooled.buffer.byteLength).toBeGreaterThan(pooled.length);
      await expect(new PDFHandler().extractText(pooled, 'application/pdf')).resolves.toContain(line);
    }
  });

  test('says a PDF of pictures has no text layer, rather than calling it corrupt', async () => {
    const scanned = buildPdf(['', '']);
    await expect(new PDFHandler().extractText(scanned, 'application/pdf')).rejects.toThrow(
      /pdf-parse: no text layer in 2 page\(s\) \(scanned pages or images only\)\. textract: .*pdftotext/,
    );
  });

  test('a PDF that is not one is an error that names both attempts', async () => {
    await expect(new PDFHandler().extractText(Buffer.from('%PDF-1.4 not really'), 'application/pdf')).rejects.toThrow(
      /PDF extraction failed with both methods\. pdf-parse: .+ textract: .*pdftotext/,
    );
  });
});
