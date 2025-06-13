import { FormatHandler } from '../types';

/**
 * Word Document Format Handler
 * Extracts plain text from DOC and DOCX files using mammoth
 */
export class WordHandler implements FormatHandler {
  supportedMimeTypes = [
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // .docx
    'application/msword', // .doc
  ];

  canHandle(mimeType: string): boolean {
    return this.supportedMimeTypes.includes(mimeType.toLowerCase());
  }

  async extractText(buffer: Buffer, mimeType: string): Promise<string> {
    try {
      // Dynamic import to avoid build issues
      const mammoth = (await import('mammoth')).default;
      // mammoth works with both DOC and DOCX formats
      const result = await mammoth.extractRawText({ buffer });

      let text = result.value;

      // Log any warnings from mammoth
      if (result.messages && result.messages.length > 0) {
        console.warn('Mammoth extraction warnings:', result.messages);
      }

      // Clean up the extracted text
      text = this.cleanExtractedText(text);

      if (!text || text.trim().length === 0) {
        throw new Error('No text content found in Word document');
      }

      return text;
    } catch (error) {
      throw new Error(`Failed to extract text from Word document: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Clean up extracted text from Word documents
   */
  private cleanExtractedText(text: string): string {
    // Remove excessive whitespace
    text = text.replace(/\s+/g, ' ');
    
    // Clean up line breaks - preserve paragraph breaks
    text = text.replace(/\n\s*\n/g, '\n\n'); // Preserve paragraph breaks
    text = text.replace(/(?<!\n)\n(?!\n)/g, ' '); // Replace single line breaks with spaces
    
    // Remove control characters but preserve newlines and tabs
    text = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
    
    // Clean up leading/trailing whitespace
    text = text.trim();
    
    return text;
  }
} 