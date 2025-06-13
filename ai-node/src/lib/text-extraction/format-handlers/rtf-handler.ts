import { FormatHandler } from '../types';

/**
 * RTF Format Handler
 * Extracts plain text from Rich Text Format files
 */
export class RTFHandler implements FormatHandler {
  supportedMimeTypes = ['text/rtf', 'application/rtf'];

  canHandle(mimeType: string): boolean {
    return this.supportedMimeTypes.includes(mimeType.toLowerCase());
  }

  async extractText(buffer: Buffer, mimeType: string): Promise<string> {
    try {
      const rtfContent = buffer.toString('utf-8');
      return this.parseRTF(rtfContent);
    } catch (error) {
      throw new Error(`Failed to extract text from RTF: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Parse RTF content and extract plain text
   * This is a simplified RTF parser that handles the most common RTF constructs
   */
  private parseRTF(rtfContent: string): string {
    let text = rtfContent;

    // Remove RTF header
    text = text.replace(/^{\s*\\rtf\d+[^}]*}/, '');

    // Remove control sequences (backslash followed by letters and optional parameter)
    text = text.replace(/\\[a-zA-Z]+\d*\s?/g, '');

    // Remove control symbols (backslash followed by single character)
    text = text.replace(/\\[^a-zA-Z\s]/g, '');

    // Remove braces
    text = text.replace(/[{}]/g, '');

    // Handle common RTF escape sequences
    text = text.replace(/\\'/g, "'");
    text = text.replace(/\\"/g, '"');
    text = text.replace(/\\\\/g, '\\');

    // Remove excessive whitespace and newlines
    text = text.replace(/\s+/g, ' ');
    text = text.replace(/\n+/g, '\n');

    // Clean up leading/trailing whitespace
    text = text.trim();

    // Handle Unicode escapes (simplified)
    text = text.replace(/\\u(\d+)\s?/g, (match, code) => {
      try {
        return String.fromCharCode(parseInt(code));
      } catch {
        return '';
      }
    });

    // Remove any remaining control characters
    text = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

    return text;
  }
} 