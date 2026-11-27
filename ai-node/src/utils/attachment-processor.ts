import { textExtractor } from '../lib/text-extraction/text-extractor';
import { AttachmentProcessingResult, ProcessedAttachment } from '../lib/text-extraction/types';
import { pdfPageCount } from '../lib/attachments/pdfInfo';
import { resolveMediaType, sniffMediaType } from './media-type';
import { fence, limitText } from './textFence';

/** Text the AI node extracted from a file: quoted, since whoever made the file wrote it (textFence.ts). */
function fenceExtracted(text: string, index: number, mediaType: string): string {
  return fence('FILE', `attachment ${index + 1}, text extracted from a ${mediaType} file`, text);
}

/**
 * Unified Attachment Processor
 * Handles attachment processing for both generate and rank-and-justify routes.
 *
 * Every attachment has a form any model can be sent: an image stays an image,
 * text stays text, and a document (PDF, DOCX, DOC, RTF, ...) becomes the text
 * extracted from it. A PDF has a second form, the file itself, for a model that
 * reads PDFs natively (lib/llm/pdf-support.ts). No other document has one: a
 * Word file sent as itself is rejected or misread by every provider, which is
 * what docs/ATTACHMENT_PROCESSING_ISSUE.md records.
 *
 * - processAttachments: one form per attachment (the generate route, one model).
 * - prepareAttachments: both forms, once per request; which juror gets which is
 *   decided in lib/attachments/pdfRouting.ts.
 * - documentNotes: what a juror is told about each document it does not see as
 *   it was delivered. Written per juror: a juror that is sent a PDF itself gets
 *   no line about it.
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

const PDF_MEDIA_TYPE = 'application/pdf';

export interface ProcessAttachmentsOptions {
  /**
   * Whether the one model these attachments are for reads PDFs natively
   * (nativePdfSupport(provider, model).native). true keeps a PDF as a document;
   * false, the default, extracts its text. Every other document is always text.
   */
  nativePdf?: boolean;
}

export interface ProcessedAttachments {
  results: AttachmentProcessingResult[];
  skippedCount: number;
  skippedReasons: string[];
  skipped: SkippedAttachment[];
}

/**
 * Process attachments for LLM consumption
 * Extracts text from document formats and prepares all attachments
 */
export async function processAttachments(
  attachments: string[] | InputAttachment[],
  options: ProcessAttachmentsOptions = {},
): Promise<ProcessedAttachments> {
  const results: AttachmentProcessingResult[] = [];
  let skippedCount = 0;
  const skippedReasons: string[] = [];
  const skipped: SkippedAttachment[] = [];

  // Whether a PDF stays a file. The caller decides (lib/llm/pdf-support.ts); there is no model list here.
  const supportsNativePDF = options.nativePdf === true;
  
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
        },
        sourceIndex: i,
      });
    }
  }

  return { results, skippedCount, skippedReasons, skipped };
}

/** A PDF as the file itself: what a juror that reads PDFs natively is sent. */
export interface PdfForm {
  /** Base64 of the file, without the data-URI header and without line breaks. */
  content: string;
  /** Length of `content`: what the PDF adds to a JSON request body. */
  base64Length: number;
  /** Size of the decoded file. */
  byteLength: number;
  /** Null when the parser could not open the file, or was not asked to; the provider may still read it. */
  pages: number | null;
}

/** The attachments of a rank-and-justify request, in every form a juror can be sent. */
export interface PreparedAttachments {
  /** Every attachment in the form any model can be sent: images, text, and each document's extracted text. */
  processed: ProcessedAttachments;
  /** The PDFs as files, by their index in the attachments. */
  pdfs: Map<number, PdfForm>;
  /** How many attachments were read. */
  count: number;
}

export interface PrepareAttachmentsOptions {
  /**
   * false when no juror of the request reads PDFs natively: a page count only
   * decides whether a PDF may be sent as a file, so without such a juror the
   * file is not opened for one. Default true.
   */
  countPdfPages?: boolean;
}

/** One juror's PDFs, for documentNotes. */
export interface JurorPdfForms {
  /** Indexes of the PDFs this juror is sent as files: it sees them whole and gets no note. */
  sentAsFile?: ReadonlySet<number>;
  /** By index, a sentence saying what the arbiter did with a file this juror is not sent. */
  whyNotAFile?: ReadonlyMap<number, string>;
}

/**
 * Reads every attachment of a request once: the form every model can be sent
 * (processAttachments, every document as its text) and, for a PDF, the file
 * itself with its size and page count.
 *
 * The text of a PDF is extracted even when every juror reads PDFs: it is what a
 * juror falls back to when its provider turns the file down.
 *
 * @param attachments - Data URIs and raw text, after image normalization.
 */
export async function prepareAttachments(
  attachments: string[],
  options: PrepareAttachmentsOptions = {},
): Promise<PreparedAttachments> {
  const processed = await processAttachments(attachments);
  const pdfs = new Map<number, PdfForm>();

  for (let index = 0; index < attachments.length; index++) {
    const attachment = attachments[index];
    if (typeof attachment !== 'string' || !attachment.startsWith('data:')) continue;
    const comma = attachment.indexOf(',');
    if (comma < 0) continue;
    const payload = attachment.slice(comma + 1);
    // A file is sent as a PDF only when its bytes are one, whatever its header declares:
    // a provider rejects anything else in a document block.
    if (!startsAsPdf(payload)) continue;

    // Base64 may arrive wrapped across lines; the providers take it unbroken.
    const content = /\s/.test(payload) ? payload.replace(/\s/g, '') : payload;
    const buffer = Buffer.from(content, 'base64');
    pdfs.set(index, {
      content,
      base64Length: content.length,
      byteLength: buffer.length,
      pages: options.countPdfPages === false ? null : await pdfPageCount(buffer),
    });
  }
  return { processed, pdfs, count: attachments.length };
}

/** Whether a base64 payload begins with the PDF signature. */
function startsAsPdf(payload: string): boolean {
  try {
    // Base64 may be wrapped across lines; only the first bytes are needed.
    const prefix = payload.slice(0, 256).replace(/\s/g, '').slice(0, 64);
    return sniffMediaType(Buffer.from(prefix, 'base64')) === PDF_MEDIA_TYPE;
  } catch {
    return false;
  }
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
 * The notes are one juror's. A juror that reads PDFs is sent the file itself
 * (lib/attachments/pdfRouting.ts) and so sees every page: it gets no line about that PDF,
 * while another juror of the same request, sent the text, does.
 *
 * @param refs - How a note names each attachment (normalizeImageAttachments' `refs`),
 *               index-aligned with the attachments that were processed.
 * @param juror - Which PDFs this juror is sent as files, and why it is not sent the others.
 *                Omitted: a juror that is sent text only.
 */
export function documentNotes(
  processed: { results: AttachmentProcessingResult[]; skipped: SkippedAttachment[] },
  refs: string[] = [],
  juror: JurorPdfForms = {},
): string[] {
  const notes: Array<{ index: number; note: string }> = [];
  const ref = (index: number) => refs[index] ?? String(index + 1);
  const sentAsFile = (index: number) => juror.sentAsFile?.has(index) === true;
  // What the arbiter did with the file itself, where that is more than "this juror is sent text".
  const why = (index: number) => {
    const sentence = juror.whyNotAFile?.get(index);
    return sentence ? ` ${sentence}` : '';
  };

  for (const entry of processed.skipped) {
    // The arbiter could not read it, but this juror has the file and reads it itself.
    if (sentAsFile(entry.index)) continue;
    // A type this table does not know is the submitter's own header: it is not quoted
    // in a line the prompt presents as the arbiter's.
    const kind = DOCUMENT_KINDS[entry.mediaType.toLowerCase()] ?? 'file';
    notes.push({
      index: entry.index,
      note:
        `Attachment ${ref(entry.index)} (${kind}, ${formatSize(entry.bytes)}) was delivered with this request, ` +
        `but the arbiter could not read it, so its content is not shown to you. The file is not missing from the request.` +
        why(entry.index),
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
        // This juror is sent the PDF itself: pages, pictures and all. Nothing to say.
        if (sentAsFile(index)) continue;
        notes.push({
          index,
          note:
            `Attachment ${ref(index)} is a PDF. Only its text is shown to you (${truncated ? `the first ${length}` : length}); ` +
            `pictures and page images inside the PDF are not shown.` +
            why(index),
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
        if (mediaType === PDF_MEDIA_TYPE && supportsNativePDF) {
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
              content: fenceExtracted(extractionResult.content, index, mediaType),
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
                content: fenceExtracted(fallbackText, index, mediaType),
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
        // Limit text length (documentNotes says so); a quoted attachment keeps its END line (textFence.ts)
        content: limitText(content, MAX_PLAIN_TEXT_CHARS),
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
    if (mediaType === PDF_MEDIA_TYPE && supportsNativePDF) {
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