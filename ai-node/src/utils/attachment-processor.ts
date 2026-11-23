import { textExtractor } from '../lib/text-extraction/text-extractor';
import { AttachmentProcessingResult, ProcessedAttachment } from '../lib/text-extraction/types';
import { AttachmentName, attachmentName } from '../lib/attachments/normalizeImages';
import { pdfPageCount } from '../lib/attachments/pdfInfo';
import { resolveMediaType, sniffMediaType } from './media-type';

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
 * - processAttachments: one model, one form per attachment (the generate route).
 * - prepareAttachments: both forms of each attachment, once per request; which
 *   juror gets which is decided in lib/attachments/pdfRouting.ts.
 * - documentNotes: what a juror is told about a PDF it was not sent as a PDF.
 */

interface InputAttachment {
  type?: string;
  content: string;
  mediaType: string;
  filename?: string;
}

const PDF_MEDIA_TYPE = 'application/pdf';

export interface ProcessAttachmentsOptions {
  /**
   * Whether the one model these attachments are for reads PDFs natively
   * (nativePdfSupport(provider, model).native). true keeps a PDF as a document;
   * false, the default, extracts its text. Every other document is always text.
   */
  nativePdf?: boolean;
}

type ProcessOutcome = { result: AttachmentProcessingResult } | { skipped: string };

/**
 * Process attachments for LLM consumption
 * Extracts text from document formats and prepares all attachments
 */
export async function processAttachments(
  attachments: string[] | InputAttachment[],
  options: ProcessAttachmentsOptions = {},
): Promise<{ results: AttachmentProcessingResult[]; skippedCount: number; skippedReasons: string[] }> {
  const results: AttachmentProcessingResult[] = [];
  const skippedReasons: string[] = [];
  const nativePdf = options.nativePdf === true;

  for (let i = 0; i < attachments.length; i++) {
    const outcome = await processOne(attachments[i], i, nativePdf);
    if ('skipped' in outcome) {
      skippedReasons.push(`Attachment ${i + 1}: ${outcome.skipped}`);
    } else {
      results.push(outcome.result);
    }
  }

  return { results, skippedCount: skippedReasons.length, skippedReasons };
}

/**
 * One attachment in the form asked for. A document that gives no text is
 * skipped, with the reason, rather than replaced by an error message the model
 * would read as content; any other failure becomes a short error text.
 */
async function processOne(
  attachment: string | InputAttachment,
  index: number,
  nativePdf: boolean,
): Promise<ProcessOutcome> {
  try {
    return {
      result:
        typeof attachment === 'string'
          ? await processStringAttachment(attachment, index, nativePdf) // rank-and-justify route
          : await processObjectAttachment(attachment, index, nativePdf), // generate route
    };
  } catch (error) {
    console.error(`Error processing attachment ${index + 1}:`, error);

    // For binary files that can't be processed, skip them entirely
    // rather than sending error messages to the LLM
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    if (errorMessage.includes('too large') ||
        errorMessage.includes('binary data') ||
        errorMessage.includes('Unable to extract text') ||
        errorMessage.includes('PDF extraction failed with both methods') ||
        errorMessage.includes('requires system dependencies') ||
        errorMessage.includes('may not be available')) {
      console.warn(`Skipping attachment ${index + 1}: ${errorMessage}`);
      return { skipped: errorMessage };
    }

    // For other errors, create a minimal error attachment
    return {
      result: {
        attachment: {
          type: 'text',
          content: `[Error processing attachment ${index + 1}: ${errorMessage}]`,
          mediaType: 'text/plain',
          size: 0,
        }
      }
    };
  }
}

/** The media type a data URI declares, and its base64 payload. */
function splitDataUri(content: string): { declaredMediaType: string; payload: string } {
  const mediaTypeMatch = content.match(/^data:([^;]+);base64,/);
  return {
    declaredMediaType: mediaTypeMatch ? mediaTypeMatch[1] : 'application/octet-stream',
    // Strip the header on the comma rather than on the declared type: sniffing can
    // move an attachment between the image and document branches, and a
    // type-keyed strip would then leave the `data:...;base64,` prefix in place.
    payload: content.slice(content.indexOf(',') + 1),
  };
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
    const { declaredMediaType, payload } = splitDataUri(content);
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
              mediaType: PDF_MEDIA_TYPE, // Keep original MIME type
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
    if (mediaType === PDF_MEDIA_TYPE && supportsNativePDF) {
      console.log(`Processing PDF attachment ${index + 1} with native provider support`);
      return {
        attachment: {
          type: 'document', // Keep as document for native processing
          content,
          mediaType: PDF_MEDIA_TYPE, // Keep original MIME type
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

/** A PDF as the file itself: what a juror that reads PDFs natively is sent. */
export interface PdfForm {
  /** Base64 of the file, without the data-URI header. */
  content: string;
  /** Length of `content`: what the PDF adds to a JSON request body. */
  base64Length: number;
  /** Size of the decoded file. */
  byteLength: number;
  /** Null when the parser could not open the file; the provider may still read it. */
  pages: number | null;
}

/** One attachment of a rank-and-justify request, in every form a juror can be sent. */
export interface PreparedAttachment {
  /** Its index in the request as received, before images were split or omitted. */
  sourceIndex: number;
  /** How notes name it: the request's file name for it, or its number. */
  name: AttachmentName;
  kind: 'image' | 'text' | 'pdf' | 'document';
  /**
   * The form every model can be sent: the image, the text, or a document's
   * extracted text. Null when a document gave no text.
   */
  common: ProcessedAttachment | null;
  /** Why `common` is null. */
  skippedReason?: string;
  /** Set when the extracted text was cut off at this many characters. */
  truncatedAt?: number;
  /** PDFs only. */
  pdf?: PdfForm;
}

export interface PrepareAttachmentsOptions {
  /** Original file names, index-aligned with the request's attachments (untrusted input). */
  names?: unknown;
  /** For each attachment, its index in the request as received (normalizeImages' sourceIndexes). */
  sourceIndexes?: number[];
  /**
   * false when no juror of the request reads PDFs natively: a page count only
   * decides whether a PDF may be sent as a file, so without such a juror the
   * file is not opened for one. Default true.
   */
  countPdfPages?: boolean;
}

/**
 * Reads every attachment of a request once: the form every model can be sent
 * and, for a PDF, the file itself with its size and page count.
 *
 * @param attachments - Data URIs and raw text, after image normalization.
 */
export async function prepareAttachments(
  attachments: string[],
  options: PrepareAttachmentsOptions = {},
): Promise<PreparedAttachment[]> {
  const names = Array.isArray(options.names) ? options.names : [];
  const prepared: PreparedAttachment[] = [];

  for (let i = 0; i < attachments.length; i++) {
    const attachment = attachments[i];
    const sourceIndex = options.sourceIndexes?.[i] ?? i;
    const entry: PreparedAttachment = {
      sourceIndex,
      name: attachmentName(names, sourceIndex),
      kind: 'text',
      common: null,
    };

    const data = typeof attachment === 'string' && attachment.startsWith('data:') ? splitDataUri(attachment) : null;
    if (data) {
      const mediaType = sniffedMediaType(data.declaredMediaType, data.payload);
      entry.kind = mediaType.startsWith('image/') ? 'image' : mediaType === PDF_MEDIA_TYPE ? 'pdf' : 'document';
    }

    // The text form of a PDF is extracted even when every juror reads PDFs: it is
    // what a juror falls back to when its provider turns the file down.
    const outcome = await processOne(attachment, i, false);
    if ('skipped' in outcome) {
      entry.skippedReason = outcome.skipped;
    } else {
      entry.common = outcome.result.attachment;
      const truncated = outcome.result.extractionResult?.warnings?.some(warning => /truncated/i.test(warning));
      if (truncated) entry.truncatedAt = outcome.result.attachment.content.length;
    }

    if (data && entry.kind === 'pdf') {
      // Base64 may arrive wrapped across lines; the providers take it unbroken.
      const content = /\s/.test(data.payload) ? data.payload.replace(/\s/g, '') : data.payload;
      const buffer = Buffer.from(content, 'base64');
      entry.pdf = {
        content,
        base64Length: content.length,
        byteLength: buffer.length,
        pages: options.countPdfPages === false ? null : await pdfPageCount(buffer),
      };
    }
    prepared.push(entry);
  }
  return prepared;
}

/** What resolveMediaType answers, without its mismatch warning: processOne logs that once for the same attachment. */
function sniffedMediaType(declared: string, payload: string): string {
  try {
    // Base64 may be wrapped across lines; only the first bytes are needed.
    const prefix = payload.slice(0, 256).replace(/\s/g, '').slice(0, 64);
    return sniffMediaType(Buffer.from(prefix, 'base64')) ?? declared;
  } catch {
    return declared;
  }
}

/** Why a juror was not sent a PDF as a PDF. */
export type PdfTextReason =
  /** This provider, model or route is sent text only. */
  | 'model'
  /** With it the request would hold more PDF pages than the provider accepts. */
  | 'page_limit'
  /** With it the request would be larger than the provider accepts. */
  | 'size_limit'
  /** The provider turned down the request that carried it; the juror was asked again with the text. */
  | 'rejected'
  /** The model is sent no attachments at all. */
  | 'no_attachments';

export interface DocumentNoteInput {
  attachment: PreparedAttachment;
  /** 'text': the juror has its extracted text. 'not_shown': the juror has nothing of it. */
  form: 'text' | 'not_shown';
  reason: PdfTextReason;
  /** The limit the PDF would break, in the limit's own unit, for 'page_limit' and 'size_limit'. */
  limit?: string;
}

/**
 * What one juror is told about the PDFs it was not sent as PDFs, one line each,
 * for the prompt's attachment notes. A juror that gets the file itself needs no
 * line. Written per juror: in a mixed jury one model sees the pages and the
 * other only the text, and each has to know which it is.
 */
export function documentNotes(inputs: DocumentNoteInput[]): string[] {
  return inputs.map(({ attachment, form, reason, limit }) => {
    const ref = `Attachment ${attachment.name.ref}`;
    if (form === 'not_shown') {
      const why = attachment.skippedReason ? ` (${firstSentence(attachment.skippedReason)})` : '';
      return (
        `${ref} is a PDF that is not shown to you: no text could be extracted from it${why}, and you are not ` +
        `sent the file itself. Judge without it and say so in your justification.`
      );
    }
    const sentences = [
      `${ref} is a PDF. Only its text is shown to you: pictures and page images inside the PDF are not shown.`,
    ];
    if (reason === 'page_limit') {
      const pages = attachment.pdf?.pages;
      sentences.push(
        `The file itself was left out because ${pages ? `its ${pages} pages` : 'its pages'} would put this request over ${limit ?? 'the page limit'}.`,
      );
    } else if (reason === 'size_limit') {
      sentences.push(`The file itself was left out because it would put this request over ${limit ?? 'the size limit'}.`);
    } else if (reason === 'rejected') {
      sentences.push('The file itself was sent first and was not accepted.');
    }
    if (attachment.truncatedAt) {
      sentences.push(`Its text was cut off after ${attachment.truncatedAt.toLocaleString('en-US')} characters.`);
    }
    return sentences.join(' ');
  });
}

function firstSentence(text: string): string {
  const first = text.split(/(?<=\.)\s/)[0].trim().replace(/\.$/, '');
  return first.length > 200 ? `${first.slice(0, 200)}…` : first;
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
