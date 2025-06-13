import { 
  TextExtractionResult, 
  TextExtractionConfig, 
  FormatHandler, 
  DEFAULT_CONFIG 
} from './types';
import { RTFHandler } from './format-handlers/rtf-handler';
import { PDFHandler } from './format-handlers/pdf-handler';
import { MarkdownHandler } from './format-handlers/markdown-handler';
import { WordHandler } from './format-handlers/word-handler';
import { TextractHandler } from './format-handlers/textract-handler';

/**
 * Main Text Extraction Service
 * Coordinates multiple format handlers to extract text from various file formats
 */
export class TextExtractor {
  private config: TextExtractionConfig;
  private handlers: FormatHandler[];

  constructor(config: Partial<TextExtractionConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.handlers = this.initializeHandlers();
  }

  /**
   * Initialize all format handlers
   */
  private initializeHandlers(): FormatHandler[] {
    return [
      new RTFHandler(),
      new PDFHandler(), // Now uses hybrid approach: pdf-parse with textract fallback
      new MarkdownHandler(),
      new WordHandler(),
      new TextractHandler(),
    ];
  }

  /**
   * Extract text from buffer
   */
  async extractText(buffer: Buffer, mimeType: string): Promise<TextExtractionResult> {
    const startTime = Date.now();
    const warnings: string[] = [];

    try {
      // Validate input
      this.validateInput(buffer, mimeType);

      // Check file size
      if (buffer.length > this.config.maxFileSize) {
        throw new Error(`File size (${buffer.length} bytes) exceeds maximum allowed size (${this.config.maxFileSize} bytes)`);
      }

      // Find appropriate handler
      const handler = this.findHandler(mimeType);
      if (!handler) {
        if (this.config.enableFallback) {
          // Return original content as fallback
          return this.createFallbackResult(buffer, mimeType, warnings, startTime);
        } else {
          throw new Error(`Unsupported file format: ${mimeType}`);
        }
      }

      // Extract text with timeout
      const extractedText = await this.extractWithTimeout(handler, buffer, mimeType);

      // Validate and truncate extracted text if necessary
      let finalText = extractedText;
      if (finalText.length > this.config.maxExtractedLength) {
        finalText = finalText.substring(0, this.config.maxExtractedLength);
        warnings.push(`Text truncated to ${this.config.maxExtractedLength} characters`);
      }

      const processingTime = Date.now() - startTime;

      this.log(`Successfully extracted ${finalText.length} characters from ${mimeType} in ${processingTime}ms`);

      return {
        content: finalText,
        originalFormat: mimeType,
        extractedLength: finalText.length,
        processingTime,
        warnings: warnings.length > 0 ? warnings : undefined,
        success: true,
      };

    } catch (error) {
      const processingTime = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      this.log(`Extraction failed for ${mimeType}: ${errorMessage}`);

      if (this.config.enableFallback) {
        warnings.push(`Extraction failed: ${errorMessage}, using fallback`);
        return this.createFallbackResult(buffer, mimeType, warnings, startTime);
      }

      return {
        content: '',
        originalFormat: mimeType,
        extractedLength: 0,
        processingTime,
        warnings,
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Extract text from base64 data
   */
  async extractFromBase64(base64Data: string, mimeType: string): Promise<TextExtractionResult> {
    try {
      // Handle data URLs
      let actualBase64 = base64Data;
      if (base64Data.startsWith('data:')) {
        const parts = base64Data.split(',');
        if (parts.length === 2) {
          actualBase64 = parts[1];
          // Extract MIME type from data URL if not provided
          if (!mimeType || mimeType === 'application/octet-stream') {
            const headerMatch = parts[0].match(/data:([^;]+)/);
            if (headerMatch) {
              mimeType = headerMatch[1];
            }
          }
        }
      }

      const buffer = Buffer.from(actualBase64, 'base64');
      return await this.extractText(buffer, mimeType);
    } catch (error) {
      throw new Error(`Failed to process base64 data: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Get list of supported formats
   */
  getSupportedFormats(): string[] {
    const formats = new Set<string>();
    for (const handler of this.handlers) {
      handler.supportedMimeTypes.forEach(type => formats.add(type));
    }
    return Array.from(formats).sort();
  }

  /**
   * Check if a format is supported
   */
  isFormatSupported(mimeType: string): boolean {
    return this.findHandler(mimeType) !== null;
  }

  /**
   * Validate input parameters
   */
  private validateInput(buffer: Buffer, mimeType: string): void {
    if (!buffer || buffer.length === 0) {
      throw new Error('Buffer is empty or invalid');
    }
    if (!mimeType || typeof mimeType !== 'string') {
      throw new Error('MIME type is required and must be a string');
    }
  }

  /**
   * Find appropriate handler for MIME type
   */
  private findHandler(mimeType: string): FormatHandler | null {
    return this.handlers.find(handler => handler.canHandle(mimeType)) || null;
  }

  /**
   * Extract text with timeout protection
   */
  private async extractWithTimeout(
    handler: FormatHandler, 
    buffer: Buffer, 
    mimeType: string
  ): Promise<string> {
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(new Error(`Text extraction timed out after ${this.config.extractionTimeout}ms`));
      }, this.config.extractionTimeout);
    });

    const extractionPromise = handler.extractText(buffer, mimeType);

    return Promise.race([extractionPromise, timeoutPromise]);
  }

  /**
   * Create fallback result using original buffer content
   */
  private createFallbackResult(
    buffer: Buffer, 
    mimeType: string, 
    warnings: string[], 
    startTime: number
  ): TextExtractionResult {
    const processingTime = Date.now() - startTime;

    // Check if this is a binary format that we shouldn't try to decode as text
    const binaryFormats = [
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.oasis.opendocument.text'
    ];

    if (binaryFormats.includes(mimeType.toLowerCase())) {
      // For binary formats, don't try to decode as text - provide a meaningful error
      const errorMessage = `Unable to extract text from ${mimeType} file (${Math.round(buffer.length / 1024)}KB). The file may be too large, corrupted, or in an unsupported format.`;
      warnings.push(errorMessage);

      return {
        content: errorMessage,
        originalFormat: mimeType,
        extractedLength: errorMessage.length,
        processingTime,
        warnings,
        success: false,
        error: errorMessage
      };
    }

    // For text-based formats, try to decode as text
    let content: string;
    try {
      content = buffer.toString('utf-8');
      
      // Check if content looks like binary (contains null bytes or excessive control characters)
      const nullBytes = (content.match(/\0/g) || []).length;
      const controlChars = (content.match(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g) || []).length;
      
      if (nullBytes > 10 || controlChars > content.length * 0.1) {
        // This looks like binary content
        const errorMessage = `File appears to contain binary data and cannot be processed as text (${Math.round(buffer.length / 1024)}KB).`;
        warnings.push(errorMessage);
        
        return {
          content: errorMessage,
          originalFormat: mimeType,
          extractedLength: errorMessage.length,
          processingTime,
          warnings,
          success: false,
          error: errorMessage
        };
      }

      // Basic cleanup for text content
      content = content.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
      content = content.trim();
      
      if (!content || content.length === 0) {
        const errorMessage = `No readable text content found in file.`;
        warnings.push(errorMessage);
        return {
          content: errorMessage,
          originalFormat: mimeType,
          extractedLength: errorMessage.length,
          processingTime,
          warnings,
          success: false,
          error: errorMessage
        };
      }

    } catch (error) {
      const errorMessage = `Failed to process file content: ${error instanceof Error ? error.message : 'Unknown error'}`;
      content = errorMessage;
      warnings.push(errorMessage);
      
      return {
        content,
        originalFormat: mimeType,
        extractedLength: content.length,
        processingTime,
        warnings,
        success: false,
        error: errorMessage
      };
    }

    // Truncate if necessary
    if (content.length > this.config.maxExtractedLength) {
      content = content.substring(0, this.config.maxExtractedLength);
      warnings.push(`Fallback content truncated to ${this.config.maxExtractedLength} characters`);
    }

    return {
      content,
      originalFormat: mimeType,
      extractedLength: content.length,
      processingTime,
      warnings,
      success: true,
    };
  }

  /**
   * Log messages if logging is enabled
   */
  private log(message: string): void {
    if (this.config.enableLogging) {
      console.log(`[TextExtractor] ${message}`);
    }
  }
}

// Export singleton instance
export const textExtractor = new TextExtractor(); 