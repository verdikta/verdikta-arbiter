/**
 * The page count of a PDF, read with the same parser the text extraction uses
 * (format-handlers/pdf-handler.ts says how it has to be loaded and what bytes
 * it has to be given).
 *
 * The providers limit PDF input by pages (attachments/pdfRouting.ts), and a PDF
 * with no text layer (a scan, a set of screenshots) fails text extraction while
 * its page count is still readable, so this is separate from the extraction.
 */

import { loadPdfParse, plainBytes } from '../text-extraction/format-handlers/pdf-handler';

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
 * @returns The number of pages, or null when the parser cannot open the file
 *          (encrypted, damaged, or a structure pdf.js 1.10 does not read) or the
 *          file is over PAGE_COUNT_MAX_BYTES.
 */
export async function pdfPageCount(buffer: Buffer): Promise<number | null> {
  if (buffer.length > PAGE_COUNT_MAX_BYTES) return null;
  let timer: NodeJS.Timeout | null = null;
  try {
    const pdfParse = await loadPdfParse();
    const parsed = await Promise.race([
      // One page, and no text built from it: only the document structure is read.
      pdfParse(plainBytes(buffer), { max: 1, pagerender: async () => '' }),
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
