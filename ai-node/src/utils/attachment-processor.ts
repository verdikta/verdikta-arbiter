import { textExtractor } from '../lib/text-extraction/text-extractor';
import { AttachmentProcessingResult, ProcessedAttachment } from '../lib/text-extraction/types';
import { resolveMediaType } from './media-type';

/**
 * Unified Attachment Processor
 * Handles attachment processing for both generate and rank-and-justify routes
 */

interface InputAttachment {
  type?: string;
  content: string;
  mediaType: string;
  filename?: string;
}

/** An attachment that was received but is not passed to the models. */
export interface SkippedAttachment {
  /** Its index in the attachments passed to processAttachments. */
  index: number;
  /** The technical cause, for the operator (logs, the response's warnings). */
  reason: string;
  /** What the file is, from its bytes where they say (media-type.ts). */
  mediaType: string;
  /** Its size as received, in bytes. */
  bytes: number;
}

/** Plain text attachments are cut to this many characters. */
export const MAX_PLAIN_TEXT_CHARS = 50000;

/**
 * Process attachments for LLM consumption
 * Extracts text from document formats and prepares all attachments
 */
export async function processAttachments(
  attachments: string[] | InputAttachment[],
  providerName?: string,
  modelName?: string
): Promise<{
  results: AttachmentProcessingResult[];
  skippedCount: number;
  skippedReasons: string[];
  skipped: SkippedAttachment[];
}> {
  const results: AttachmentProcessingResult[] = [];
  let skippedCount = 0;
  const skippedReasons: string[] = [];
  const skipped: SkippedAttachment[] = [];

  // Check if provider supports native PDF processing
  const supportsNativePDF = checkNativePDFSupport(providerName, modelName);
  
  for (let i = 0; i < attachments.length; i++) {
    const attachment = attachments[i];
    
    try {
      if (typeof attachment === 'string') {
        // Handle string attachments (from rank-and-justify route)
        const result = await processStringAttachment(attachment, i, supportsNativePDF);
        results.push({ ...result, sourceIndex: i });
      } else {
        // Handle object attachments (from generate route)
        const result = await processObjectAttachment(attachment, i, supportsNativePDF);
        results.push({ ...result, sourceIndex: i });
      }
    } catch (error) {
      console.error(`Error processing attachment ${i + 1}:`, error);
      
      // For binary files that can't be processed, skip them entirely
      // rather than sending error messages to the LLM
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      
      if (errorMessage.includes('too large') || 
          errorMessage.includes('binary data') || 
          errorMessage.includes('Unable to extract text') ||
          errorMessage.includes('PDF extraction failed with both methods') ||
          errorMessage.includes('requires system dependencies') ||
          errorMessage.includes('may not be available')) {
        console.warn(`Skipping attachment ${i + 1}: ${errorMessage}`);
        skippedCount++;
        skippedReasons.push(`Attachment ${i + 1}: ${errorMessage}`);
        skipped.push({ index: i, reason: errorMessage, ...describeInput(attachment) });
        // Not added to results: the models do not get it. The caller says so in the
        // prompt (documentNotes), so a juror does not take the file for missing.
        continue;
      }
      
      // For other errors, create a minimal error attachment
      results.push({
        attachment: {
          type: 'text',
          content: `[Error processing attachment ${i + 1}: ${errorMessage}]`,
          mediaType: 'text/plain',
          size: 0,
        }
      });
    }
  }

  return { results, skippedCount, skippedReasons, skipped };
}

/** The media type and size of an attachment as it was received. */
function describeInput(attachment: string | InputAttachment): { mediaType: string; bytes: number } {
  if (typeof attachment !== 'string') {
    return { mediaType: attachment.mediaType, bytes: base64Bytes(attachment.content) };
  }
  if (!attachment.startsWith('data:')) {
    return { mediaType: 'text/plain', bytes: Buffer.byteLength(attachment) };
  }
  const declared = attachment.match(/^data:([^;,]+)/)?.[1] ?? 'application/octet-stream';
  const payload = attachment.slice(attachment.indexOf(',') + 1);
  return { mediaType: resolveMediaType(declared, payload), bytes: base64Bytes(payload) };
}

function base64Bytes(payload: string): number {
  const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((payload.length * 3) / 4) - padding);
}

const DOCUMENT_KINDS: Record<string, string> = {
  'application/pdf': 'PDF',
  'application/msword': 'Word document',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'Word document',
  'application/vnd.oasis.opendocument.text': 'OpenDocument text',
  'text/rtf': 'RTF document',
  'application/rtf': 'RTF document',
};

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} bytes`;
}

/**
 * Prompt notes for every document the models do not see as it was delivered.
 *
 * A juror only sees the blocks it is sent. A document the extractor could not read used to
 * be dropped with a server-side warning and nothing in the prompt, so both jurors of bounty
 * 398's second submission reported the hunter's PDF as "not included in the actual
 * submission" and failed a mandatory criterion on it. The same holds, more quietly, for a
 * PDF shown as its text layer (its pictures are gone) and for text cut at a length limit.
 * Each note states what the arbiter did, in the words of normalizeImages' notes; it does
 * not tell the juror what to conclude.
 *
 * @param refs - How a note names each attachment (normalizeImageAttachments' `refs`),
 *               index-aligned with the attachments that were processed.
 */
export function documentNotes(
  processed: { results: AttachmentProcessingResult[]; skipped: SkippedAttachment[] },
  refs: string[] = [],
): string[] {
  const notes: Array<{ index: number; note: string }> = [];
  const ref = (index: number) => refs[index] ?? String(index + 1);

  for (const entry of processed.skipped) {
    // A type this table does not know is the submitter's own header: it is not quoted
    // in a line the prompt presents as the arbiter's.
    const kind = DOCUMENT_KINDS[entry.mediaType.toLowerCase()] ?? 'file';
    notes.push({
      index: entry.index,
      note:
        `Attachment ${ref(entry.index)} (${kind}, ${formatSize(entry.bytes)}) was delivered with this request, ` +
        `but the arbiter could not read it, so its content is not shown to you. The file is not missing from the request.`,
    });
  }

  for (const result of processed.results) {
    const index = result.sourceIndex;
    if (index === undefined) continue;
    const extraction = result.extractionResult;
    if (extraction?.success && result.attachment.type === 'text') {
      const truncated = (extraction.warnings ?? []).some(warning => /truncated/i.test(warning));
      const length = `${extraction.extractedLength.toLocaleString('en-US')} characters`;
      if (extraction.originalFormat.toLowerCase() === 'application/pdf') {
        notes.push({
          index,
          note:
            `Attachment ${ref(index)} is a PDF. Only its text is shown to you (${truncated ? `the first ${length}` : length}); ` +
            `pictures and page images inside the PDF are not shown.`,
        });
      } else if (truncated) {
        notes.push({
          index,
          note: `Attachment ${ref(index)} is long: only the first ${length} of its text are shown to you.`,
        });
      }
    } else if (!extraction && result.attachment.type === 'text' && result.attachment.size > result.attachment.content.length) {
      notes.push({
        index,
        note:
          `Attachment ${ref(index)} is long: only the first ${result.attachment.content.length.toLocaleString('en-US')} ` +
          `of its ${result.attachment.size.toLocaleString('en-US')} characters are shown to you.`,
      });
    }
  }

  return notes.sort((a, b) => a.index - b.index).map(entry => entry.note);
}

/**
 * Check if provider supports native PDF processing
 */
function checkNativePDFSupport(providerName?: string, modelName?: string): boolean {
  if (!providerName || !modelName) return false;
  
  const provider = providerName.toLowerCase();
  const model = modelName.toLowerCase();
  
  // OpenAI native PDF support
  if (provider === 'openai') {
    return ['gpt-4o', 'gpt-4o-mini', 'o1'].some(supportedModel => 
      model.includes(supportedModel)
    );
  }
  
  // Anthropic native PDF support
  if (provider === 'anthropic') {
    return [
      'claude-opus-4', 'claude-sonnet-4', 'claude-3-7-sonnet', 
      'claude-3-5-sonnet', 'claude-3-5-haiku'
    ].some(supportedModel => model.includes(supportedModel));
  }
  
  return false;
}

/**
 * Process string attachment (data URI format)
 */
async function processStringAttachment(
  content: string, 
  index: number,
  supportsNativePDF: boolean = false
): Promise<AttachmentProcessingResult> {
  // Check if it's a data URI
  if (content.startsWith('data:')) {
    const mediaTypeMatch = content.match(/^data:([^;]+);base64,/);
    const declaredMediaType = mediaTypeMatch ? mediaTypeMatch[1] : 'application/octet-stream';
    // Strip the header on the comma rather than on the declared type: sniffing can
    // move an attachment between the image and document branches below, and a
    // type-keyed strip would then leave the `data:...;base64,` prefix in place.
    const payload = content.slice(content.indexOf(',') + 1);
    // The declared header is submitter-supplied; provider APIs sniff the bytes and
    // reject mismatches, so sniff them ourselves first.
    const mediaType = resolveMediaType(declaredMediaType, payload);

    if (mediaType.startsWith('image/')) {
      // Handle image attachment
      const base64Data = payload;
      return {
        attachment: {
          type: 'image',
          content: base64Data,
          mediaType,
          size: base64Data.length,
        }
      };
          } else {
        // For PDFs with native support, pass through without extraction
        if (mediaType === 'application/pdf' && supportsNativePDF) {
          console.log(`Processing PDF attachment ${index + 1} with native provider support`);
          const base64Data = payload || content;
          return {
            attachment: {
              type: 'document', // Keep as document for native processing
              content: base64Data,
              mediaType: 'application/pdf', // Keep original MIME type
              size: base64Data.length,
            }
          };
        }
        
        // Handle document attachment - extract text
        try {
          const extractionResult = await textExtractor.extractFromBase64(content, mediaType);
          
          // Check if extraction was successful
          if (!extractionResult.success) {
            console.warn(`Text extraction failed for attachment ${index + 1}:`, extractionResult.error);
            throw new Error(extractionResult.error || 'Text extraction failed');
          }
          
          return {
            attachment: {
              type: 'text',
              content: extractionResult.content,
              mediaType: 'text/plain', // Convert to plain text
              size: extractionResult.content.length,
            },
            extractionResult
          };
        } catch (error) {
          console.warn(`Text extraction failed for attachment ${index + 1}:`, error instanceof Error ? error.message : 'Unknown error');
          
          // For binary formats, don't try fallback - throw the error  
          const binaryFormats = [
            'application/pdf',
            'application/msword', 
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
          ];
          
          if (binaryFormats.includes(mediaType.toLowerCase())) {
            // For PDFs, provide more helpful error message
            if (mediaType === 'application/pdf') {
              throw new Error(`PDF processing failed: ${error instanceof Error ? error.message : 'Unknown error'}. This may be due to the PDF being password-protected, corrupted, or containing only scanned images.`);
            }
            throw error; // Re-throw so it gets caught in the main processing loop
          }
          
          // For other formats, try a limited fallback
          try {
            const base64Data = content.split(',')[1] || content;
            const buffer = Buffer.from(base64Data, 'base64');
            let fallbackText = buffer.toString('utf-8').substring(0, 5000); // Smaller limit
            
            // Quick check if this looks like text
            const nullBytes = (fallbackText.match(/\0/g) || []).length;
            if (nullBytes > 5) {
              throw new Error('Content appears to be binary');
            }
            
            fallbackText = fallbackText.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').trim();
            
            if (!fallbackText || fallbackText.length < 10) {
              throw new Error('No readable text content found');
            }

            return {
              attachment: {
                type: 'text',
                content: fallbackText,
                mediaType: 'text/plain',
                size: fallbackText.length,
              }
            };
          } catch (fallbackError) {
            throw new Error(`Unable to process attachment: ${error instanceof Error ? error.message : 'Unknown error'}`);
          }
        }
      }
  } else {
    // Plain text content
    return {
      attachment: {
        type: 'text',
        content: content.substring(0, MAX_PLAIN_TEXT_CHARS), // Limit text length (documentNotes says so)
        mediaType: 'text/plain',
        size: content.length,
      }
    };
  }
}

/**
 * Process object attachment (from generate route)
 */
async function processObjectAttachment(
  attachment: InputAttachment,
  index: number,
  supportsNativePDF: boolean = false
): Promise<AttachmentProcessingResult> {
  const { content, mediaType, filename } = attachment;

  if (mediaType.startsWith('image/')) {
    // Handle image attachment
    return {
      attachment: {
        type: 'image',
        content,
        mediaType,
        filename,
        size: content.length,
      }
    };
  } else {
    // For PDFs with native support, pass through without extraction
    if (mediaType === 'application/pdf' && supportsNativePDF) {
      console.log(`Processing PDF attachment ${index + 1} with native provider support`);
      return {
        attachment: {
          type: 'document', // Keep as document for native processing
          content,
          mediaType: 'application/pdf', // Keep original MIME type
          filename,
          size: content.length,
        }
      };
    }
    
    // Handle document attachment - extract text
    try {
      const buffer = Buffer.from(content, 'base64');
      const extractionResult = await textExtractor.extractText(buffer, mediaType);
      
      // Check if extraction was successful
      if (!extractionResult.success) {
        console.warn(`Text extraction failed for attachment ${index + 1}:`, extractionResult.error);
        throw new Error(extractionResult.error || 'Text extraction failed');
      }
      
      return {
        attachment: {
          type: 'text',
          content: extractionResult.content,
          mediaType: 'text/plain', // Convert to plain text
          filename,
          size: extractionResult.content.length,
        },
        extractionResult
      };
    } catch (error) {
      console.warn(`Text extraction failed for attachment ${index + 1}:`, error instanceof Error ? error.message : 'Unknown error');
      
                // For binary formats, don't try fallback - throw the error  
          const binaryFormats = [
            'application/pdf',
            'application/msword', 
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
          ];
          
          if (binaryFormats.includes(mediaType.toLowerCase())) {
            // For PDFs, provide more helpful error message
            if (mediaType === 'application/pdf') {
              throw new Error(`PDF processing failed: ${error instanceof Error ? error.message : 'Unknown error'}. This may be due to the PDF being password-protected, corrupted, or containing only scanned images.`);
            }
            throw error; // Re-throw so it gets caught in the main processing loop
          }
      
      // For other formats, try a limited fallback
      try {
        const buffer = Buffer.from(content, 'base64');
        let fallbackText = buffer.toString('utf-8').substring(0, 5000); // Smaller limit
        
        // Quick check if this looks like text
        const nullBytes = (fallbackText.match(/\0/g) || []).length;
        if (nullBytes > 5) {
          throw new Error('Content appears to be binary');
        }
        
        fallbackText = fallbackText.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').trim();
        
        if (!fallbackText || fallbackText.length < 10) {
          throw new Error('No readable text content found');
        }

        return {
          attachment: {
            type: 'text',
            content: fallbackText,
            mediaType: 'text/plain',
            filename,
            size: fallbackText.length,
          }
        };
      } catch (fallbackError) {
        throw new Error(`Unable to process attachment: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    }
  }
}

/**
 * Convert processed attachments to format expected by LLM providers
 */
export function convertToLLMFormat(
  processedAttachments: AttachmentProcessingResult[]
): Array<{ type: string; content: string; mediaType: string }> {
  return processedAttachments.map(result => ({
    type: result.attachment.type,
    content: result.attachment.content,
    mediaType: result.attachment.mediaType,
  }));
}

/**
 * Log attachment processing summary
 */
export function logAttachmentSummary(
  processedAttachments: AttachmentProcessingResult[]
): void {
  console.log('Processed attachments summary:', processedAttachments.map((result, index) => ({
    index: index + 1,
    type: result.attachment.type,
    mediaType: result.attachment.mediaType,
    size: result.attachment.size,
    hasExtraction: !!result.extractionResult,
    extractionSuccess: result.extractionResult?.success,
    processingTime: result.extractionResult?.processingTime,
    warnings: result.extractionResult?.warnings,
  })));
} 