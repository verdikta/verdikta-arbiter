import { FormatHandler } from '../types';

/**
 * PDF Format Handler
 * Extracts plain text from PDF files using pdf-parse
 */
export class PDFHandler implements FormatHandler {
  supportedMimeTypes = ['application/pdf'];

  canHandle(mimeType: string): boolean {
    return this.supportedMimeTypes.includes(mimeType.toLowerCase());
  }

  async extractText(buffer: Buffer, mimeType: string): Promise<string> {
    // Try pdf-parse first, fall back to textract if it fails
    let text: string | null = null;
    let lastError: Error | null = null;

    // Attempt 1: Use pdf-parse
    try {
      console.log('[PDFHandler] Attempting extraction with pdf-parse...');
      const pdfParse = (await import('pdf-parse')).default;
      
      let pdfData;
      try {
        pdfData = await pdfParse(buffer, {
          max: 0, // Parse all pages
        });
      } catch (parseError: any) {
        if (parseError.message?.includes('ENOENT') && parseError.message?.includes('test/data')) {
          console.warn('[PDFHandler] pdf-parse test file issue detected, trying without options');
          pdfData = await pdfParse(buffer);
        } else {
          throw parseError;
        }
      }

      text = pdfData.text;
      if (text && text.trim().length > 0) {
        console.log(`[PDFHandler] pdf-parse succeeded, extracted ${text.length} characters`);
        return this.cleanExtractedText(text);
      } else {
        throw new Error('No text content found with pdf-parse');
      }
    } catch (error: any) {
      console.warn(`[PDFHandler] pdf-parse failed: ${error.message}`);
      lastError = error;
      
      // Check if this is the ENOENT test file error - if so, try textract
      if (error.message?.includes('ENOENT') && error.message?.includes('test/data')) {
        console.log('[PDFHandler] Falling back to textract due to pdf-parse test file issue');
      }
    }

    // Attempt 2: Fall back to textract
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