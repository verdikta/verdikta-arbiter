import { FormatHandler } from '../types';
import { promisify } from 'util';

/**
 * Textract Fallback Handler
 * Uses textract library as a fallback for various file formats
 */
export class TextractHandler implements FormatHandler {
  supportedMimeTypes = [
    'text/html',
    'application/vnd.oasis.opendocument.text', // ODT
    'text/csv',
    // Add more as needed
  ];

  canHandle(mimeType: string): boolean {
    return this.supportedMimeTypes.includes(mimeType.toLowerCase());
  }

  async extractText(buffer: Buffer, mimeType: string): Promise<string> {
    try {
      // Dynamic import to avoid build issues with textract
      const textract = (await import('textract')).default;
      const textractFromBuffer = promisify(textract.fromBufferWithMime);
      const text = await textractFromBuffer(mimeType, buffer) as string;

      const cleanedText = this.cleanExtractedText(text);

      if (!cleanedText || cleanedText.trim().length === 0) {
        throw new Error('No text content found in document');
      }

      return cleanedText;
    } catch (error) {
      throw new Error(`Failed to extract text using textract: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Clean up extracted text
   */
  private cleanExtractedText(text: string): string {
    // Remove excessive whitespace
    text = text.replace(/\s+/g, ' ');
    
    // Clean up line breaks
    text = text.replace(/\n\s*\n\s*\n/g, '\n\n'); // Max 2 consecutive newlines
    text = text.replace(/\n\s+/g, '\n'); // Remove leading spaces after newlines
    
    // Remove control characters but preserve newlines and tabs
    text = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
    
    // Clean up leading/trailing whitespace
    text = text.trim();
    
    return text;
  }
} 