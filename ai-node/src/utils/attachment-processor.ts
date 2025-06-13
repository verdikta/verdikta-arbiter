import { textExtractor } from '../lib/text-extraction/text-extractor';
import { AttachmentProcessingResult, ProcessedAttachment } from '../lib/text-extraction/types';

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

/**
 * Process attachments for LLM consumption
 * Extracts text from document formats and prepares all attachments
 */
export async function processAttachments(
  attachments: string[] | InputAttachment[],
  providerName?: string,
  modelName?: string
): Promise<{ results: AttachmentProcessingResult[]; skippedCount: number; skippedReasons: string[] }> {
  const results: AttachmentProcessingResult[] = [];
  let skippedCount = 0;
  const skippedReasons: string[] = [];

  // Check if provider supports native PDF processing
  const supportsNativePDF = checkNativePDFSupport(providerName, modelName);
  
  for (let i = 0; i < attachments.length; i++) {
    const attachment = attachments[i];
    
    try {
      if (typeof attachment === 'string') {
        // Handle string attachments (from rank-and-justify route)
        const result = await processStringAttachment(attachment, i, supportsNativePDF);
        results.push(result);
      } else {
        // Handle object attachments (from generate route)
        const result = await processObjectAttachment(attachment, i, supportsNativePDF);
        results.push(result);
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
        // Don't add to results - skip this attachment entirely
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

  return { results, skippedCount, skippedReasons };
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
    const mediaType = mediaTypeMatch ? mediaTypeMatch[1] : 'application/octet-stream';

    if (mediaType.startsWith('image/')) {
      // Handle image attachment
      const base64Data = content.replace(/^data:image\/[^;]+;base64,/, '');
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
          const base64Data = content.split(',')[1] || content;
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
        content: content.substring(0, 50000), // Limit text length
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