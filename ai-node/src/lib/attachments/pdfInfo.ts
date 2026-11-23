/**
 * The page count of a PDF, read with the same parser the text extraction uses.
 *
 * The providers limit PDF input by pages (attachments/pdfRouting.ts), and a PDF
 * with no text layer (a scan, a set of screenshots) fails text extraction while
 * its page count is still readable, so this is separate from the extraction.
 */

/** Parsing is bounded: a PDF that takes longer to open than this is treated as unreadable. */
const PAGE_COUNT_TIMEOUT_MS = 15_000;

/**
 * No provider takes a larger PDF as a file (pdfRouting.ts, PDF_LIMITS; held to
 * them by pdfRouting.test.ts), so a larger one is not opened to count pages it
 * can never be sent with. The file is a submitter's, and this parser runs in
 * the server's own process.
 */
export const PAGE_COUNT_MAX_BYTES = 32 * 1024 * 1024;

/**
 * The bytes of a PDF in the form pdf-parse must be given.
 *
 * pdf.js 1.10 (inside pdf-parse) builds its sub-streams, the cross-reference
 * table among them, from the underlying ArrayBuffer and drops the view's offset
 * (`makeSubStream`: `new Stream(this.bytes.buffer, start, length)`). It also
 * copies whatever it is handed with the value's own constructor. Handed a Node
 * Buffer, the copy is a Buffer, and a Buffer under 4 kB lives at an offset
 * inside Node's shared 8 kB pool: pdf.js then reads the table from another
 * buffer's bytes. Measured on three small PDFs parsed in turn: "bad XRef
 * entry" three times, then 2 pages and no text for a 3-page file.
 *
 * Handed a plain Uint8Array, the copy is a Uint8Array with an ArrayBuffer of
 * its own and offset 0, and every file parses. This is a view, not a copy.
 */
export function pdfParseInput(buffer: Buffer): Buffer {
  // pdf-parse is typed for Buffer; pdf.js takes any Uint8Array.
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength) as unknown as Buffer;
}

/**
 * @returns The number of pages, or null when the parser cannot open the file
 *          (encrypted, damaged, or a structure pdf.js 1.10 does not read) or the
 *          file is over PAGE_COUNT_MAX_BYTES.
 */
export async function pdfPageCount(buffer: Buffer): Promise<number | null> {
  if (buffer.length > PAGE_COUNT_MAX_BYTES) return null;
  let timer: NodeJS.Timeout | null = null;
  try {
    // The library file itself: the package's index.js runs a self-test on a file
    // that only exists in its own repository when it is not loaded through require().
    const pdfParse = (await import('pdf-parse/lib/pdf-parse.js')).default;
    const parsed = await Promise.race([
      // One page, and no text built from it: only the document structure is read.
      pdfParse(pdfParseInput(buffer), { max: 1, pagerender: async () => '' }),
      new Promise<null>(resolve => {
        timer = setTimeout(() => resolve(null), PAGE_COUNT_TIMEOUT_MS);
      }),
    ]);
    const pages = parsed?.numpages;
    return typeof pages === 'number' && Number.isInteger(pages) && pages > 0 ? pages : null;
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
