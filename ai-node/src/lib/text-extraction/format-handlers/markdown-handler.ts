import { FormatHandler } from '../types';

/**
 * Markdown Format Handler
 * Processes Markdown files and converts to plain text
 */
export class MarkdownHandler implements FormatHandler {
  supportedMimeTypes = ['text/markdown', 'text/x-markdown', 'text/md'];

  canHandle(mimeType: string): boolean {
    return this.supportedMimeTypes.includes(mimeType.toLowerCase());
  }

  async extractText(buffer: Buffer, mimeType: string): Promise<string> {
    try {
      const markdownContent = buffer.toString('utf-8');
      
      // Dynamic import to avoid build issues
      const { marked } = await import('marked');
      
      // Convert markdown to HTML first
      const html = await marked(markdownContent, {
        // Configure marked to be safe and minimal
        breaks: true,
        gfm: true,
      });

      // Convert HTML to plain text
      const plainText = this.htmlToPlainText(html);

      return this.cleanExtractedText(plainText);
    } catch (error) {
      throw new Error(`Failed to extract text from Markdown: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Convert HTML to plain text
   */
  private htmlToPlainText(html: string): string {
    let text = html;

    // Remove script and style elements
    text = text.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '');

    // Convert block elements to newlines
    text = text.replace(/<\/(div|p|h[1-6]|li|blockquote|pre)>/gi, '\n');
    text = text.replace(/<(br|hr)\s*\/?>/gi, '\n');

    // Convert list items
    text = text.replace(/<li[^>]*>/gi, '• ');

    // Remove all remaining HTML tags
    text = text.replace(/<[^>]*>/g, '');

    // Decode HTML entities
    text = text.replace(/&nbsp;/g, ' ');
    text = text.replace(/&amp;/g, '&');
    text = text.replace(/&lt;/g, '<');
    text = text.replace(/&gt;/g, '>');
    text = text.replace(/&quot;/g, '"');
    text = text.replace(/&#39;/g, "'");

    return text;
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
    
    // Clean up leading/trailing whitespace
    text = text.trim();
    
    return text;
  }
} 