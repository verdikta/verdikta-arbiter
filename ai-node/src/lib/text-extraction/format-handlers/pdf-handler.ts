import { FormatHandler } from '../types';

type PdfParse = (
  data: Uint8Array,
  options?: { max?: number; pagerender?: (page: unknown) => string | Promise<string> },
) => Promise<{ text: string; numpages: number }>;

/**
 * pdf-parse, loaded by its library file.
 *
 * The package's index.js runs a self-test whenever `module.parent` is unset: it opens
 * './test/data/05-versions-space.pdf' relative to the working directory and throws ENOENT.
 * `module.parent` is always unset inside the Next.js server bundle, so importing the package
 * root failed on every call there, and every PDF fell through to textract, which shells out to
 * poppler's `pdftotext`. No installer step provides that binary, so on an arbiter host each
 * PDF was "unreadable" and was dropped (bounty 398, submission 2: a 19-page PDF with a text
 * layer, read here in ~130 ms). The library file has no self-test.
 */
export async function loadPdfParse(): Promise<PdfParse> {
  const loaded: unknown = await import('pdf-parse/lib/pdf-parse.js');
  return ((loaded as { default?: PdfParse }).default ?? loaded) as PdfParse;
}

/**
 * The same bytes as a plain Uint8Array (a view, nothing is copied here).
 *
 * The pdf.js inside pdf-parse (1.10.100) hands the document to its in-process worker by
 * cloning it with `new data.constructor(data)`, and then reads the clone's ArrayBuffer
 * from offset 0. For a Node Buffer that constructor is Buffer, which puts anything under
 * 4 KB into Node's shared 8 KB pool at some other offset: a small PDF was parsed as
 * whatever else the pool held and failed with "bad XRef entry", every time. A Uint8Array
 * is cloned into an ArrayBuffer of its own.
 */
export function plainBytes(buffer: Buffer): Uint8Array {
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.length);
}

/**
 * PDF Format Handler
 * Extracts the text layer of a PDF with pdf-parse; textract (pdftotext) is a second
 * attempt on hosts that have it.
 */
export class PDFHandler implements FormatHandler {
  supportedMimeTypes = ['application/pdf'];

  canHandle(mimeType: string): boolean {
    return this.supportedMimeTypes.includes(mimeType.toLowerCase());
  }

  async extractText(buffer: Buffer, mimeType: string): Promise<string> {
    let text: string | null = null;
    let lastError: Error | null = null;

    // Attempt 1: pdf-parse (pure JavaScript, no system dependency)
    try {
      console.log('[PDFHandler] Attempting extraction with pdf-parse...');
      const pdfParse = await loadPdfParse();
      const pdfData = await pdfParse(plainBytes(buffer), {
        max: 0, // Parse all pages
      });

      text = pdfData.text;
      if (text && text.trim().length > 0) {
        console.log(`[PDFHandler] pdf-parse succeeded, extracted ${text.length} characters from ${pdfData.numpages} page(s)`);
        return this.cleanExtractedText(text);
      } else {
        throw new Error(`no text layer in ${pdfData.numpages} page(s) (scanned pages or images only)`);
      }
    } catch (error: any) {
      console.warn(`[PDFHandler] pdf-parse failed: ${error.message}`);
      lastError = error;
    }

    // Attempt 2: textract, which needs poppler's pdftotext on the host
    try {
      console.log('[PDFHandler] Attempting extraction with textract fallback...');
      const textract = (await import('textract')).default;
      const { promisify } = await import('util');
      const textractFromBuffer = promisify(textract.fromBufferWithMime);

      text = await textractFromBuffer('application/pdf', buffer) as string;

      if (text && text.trim().length > 0) {
        console.log(`[PDFHandler] textract succeeded, extracted ${text.length} characters`);
        return this.cleanExtractedText(text);
      } else {
        throw new Error('No text content found with textract');
      }
    } catch (textractError: any) {
      console.error(`[PDFHandler] textract also failed: ${textractError.message}`);

      // Both methods failed - throw a comprehensive error
      const combinedError = `PDF extraction failed with both methods. pdf-parse: ${lastError?.message || 'unknown error'}. textract: ${textractError.message}`;
      throw new Error(combinedError);
    }
  }

  /**
   * Clean up extracted PDF text
   */
  private cleanExtractedText(text: string): string {
    // Remove excessive whitespace
    text = text.replace(/\s+/g, ' ');

    // Clean up line breaks - preserve paragraph breaks but remove random line breaks
    text = text.replace(/\n\s*\n/g, '\n\n'); // Preserve paragraph breaks
    text = text.replace(/(?<!\n)\n(?!\n)/g, ' '); // Replace single line breaks with spaces

    // Remove control characters but preserve newlines and tabs
    text = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

    // Clean up leading/trailing whitespace
    text = text.trim();

    return text;
  }
}
