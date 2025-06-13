/**
 * Text Extraction Types and Interfaces
 */

export interface TextExtractionResult {
  /** Extracted plain text content */
  content: string;
  /** Original file format/MIME type */
  originalFormat: string;
  /** Length of extracted text in characters */
  extractedLength: number;
  /** Time taken for extraction in milliseconds */
  processingTime: number;
  /** Any warnings encountered during extraction */
  warnings?: string[];
  /** Whether extraction was successful */
  success: boolean;
  /** Error message if extraction failed */
  error?: string;
}

export interface TextExtractionConfig {
  /** Maximum file size to process (bytes) */
  maxFileSize: number;
  /** Maximum length of extracted text (characters) */
  maxExtractedLength: number;
  /** Whether to fall back to original content if extraction fails */
  enableFallback: boolean;
  /** List of supported MIME types */
  supportedFormats: string[];
  /** Timeout for extraction process (milliseconds) */
  extractionTimeout: number;
  /** Whether to enable debug logging */
  enableLogging: boolean;
}

export interface FormatHandler {
  /** MIME types this handler supports */
  supportedMimeTypes: string[];
  /** Extract text from buffer */
  extractText: (buffer: Buffer, mimeType: string) => Promise<string>;
  /** Check if this handler can process the given MIME type */
  canHandle: (mimeType: string) => boolean;
}

export interface AttachmentProcessingResult {
  /** Processed attachment data */
  attachment: ProcessedAttachment;
  /** Extraction result details */
  extractionResult?: TextExtractionResult;
}

export interface ProcessedAttachment {
  /** Type of attachment (text, image, etc.) */
  type: 'text' | 'image' | 'document';
  /** Processed content */
  content: string;
  /** Media type of the original file */
  mediaType: string;
  /** Original filename if available */
  filename?: string;
  /** Size of processed content */
  size: number;
}

export type SupportedFormat = 
  | 'text/rtf'
  | 'application/pdf'
  | 'text/markdown'
  | 'text/plain'
  | 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  | 'application/msword'
  | 'text/html'
  | 'application/vnd.oasis.opendocument.text';

export const DEFAULT_CONFIG: TextExtractionConfig = {
  maxFileSize: 50 * 1024 * 1024, // 50MB - increased for larger PDFs
  maxExtractedLength: 100000, // 100k characters - increased for longer documents
  enableFallback: true,
  supportedFormats: [
    'text/rtf',
    'application/pdf',
    'text/markdown',
    'text/plain',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/msword',
    'text/html'
  ],
  extractionTimeout: 60000, // 60 seconds - increased for larger files
  enableLogging: process.env.NODE_ENV === 'development'
}; 