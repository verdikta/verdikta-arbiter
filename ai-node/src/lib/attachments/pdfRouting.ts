/**
 * Which form of each attachment each juror is sent.
 *
 * Until this existed the whole request took one path: if every model in the
 * jury was on a list of PDF-capable models, every non-image attachment went to
 * every model as a raw base64 "document" (which broke Word files,
 * docs/ATTACHMENT_PROCESSING_ISSUE.md); otherwise every document was reduced to
 * its extracted text for every model. The lists had stopped at GPT-4.1 and
 * Claude 4.x, so current juries only ever got the text, and nobody could see a
 * picture that exists only inside a PDF (bounty 398).
 *
 * Now the decision is made per attachment and per juror:
 * - Only a PDF can be sent as itself. Every other document is always its
 *   extracted text, for every juror.
 * - A juror whose provider, model and route read PDFs (llm/pdf-support.ts) gets
 *   the file. Any other juror gets the extracted text and the line documentNotes
 *   writes for it (utils/attachment-processor.ts): only the text is shown,
 *   pictures and page images are not.
 * - A PDF that would put a juror's request over a provider limit is text for
 *   that juror, with the line. Images are fitted first (normalizeImages.ts,
 *   which counts each PDF in full, so they leave room for it); a PDF takes what
 *   is left, in attachment order.
 * - A PDF with no extractable text (a scan, a set of screenshots) is still sent
 *   to the jurors that read PDFs; the others are told it was delivered and
 *   could not be read.
 *
 * Whether a juror reads PDFs depends on the operator's gateway (a class routed
 * to OpenRouter gets text), so unlike the image decisions this one can differ
 * between operators for the same request. Within one node it follows from the
 * request alone.
 */

import { IMAGE_LIMITS } from './normalizeImages';
import type { NativePdfSupport, PdfProviderFamily } from '../llm/pdf-support';
import type { ProviderAttachment } from '../llm/provider-attachments';
import { PdfForm, PreparedAttachments, documentNotes } from '../../utils/attachment-processor';
import type { AttachmentProcessingResult } from '../text-extraction/types';

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
  | 'no_attachments'
  /** The model's request carries images only: no text attachment, so not a document's text either. */
  | 'images_only';

export const PDF_LIMITS = {
  /**
   * Anthropic: "Maximum pages per request | 600 (100 when the request's context
   * window is under 1M tokens)".
   * https://platform.claude.com/docs/en/build-with-claude/pdf-support#check-pdf-requirements
   * (read 2026-11-23). A model id does not say which window a request gets, so
   * 100 applies to every Claude juror, as IMAGE_LIMITS does for images.
   *
   * The same page says the API "converts each page of the document into an
   * image", and the image limit carries the same two figures (100 / 600). The
   * docs do not say whether pages and images share one allowance, so they are
   * counted together here against IMAGE_LIMITS.ANTHROPIC_MAX_IMAGES_PER_REQUEST:
   * the reading that cannot be rejected.
   */
  ANTHROPIC_MAX_PAGES_PER_REQUEST: 100,
  /**
   * Anthropic's size limit is on the whole request, PDFs included ("Both limits
   * are on the entire request payload, including any other content sent
   * alongside PDFs", same page): 128 MB on the first-party API, 32 MB on Claude
   * Platform on AWS, Google Cloud (Anthropic managed) and Foundry, 30 MB on
   * Google Cloud (Google managed), 20 MB on Bedrock.
   * https://platform.claude.com/docs/en/api/overview#request-size-limits (read
   * 2026-11-23). The figure used is IMAGE_LIMITS.ANTHROPIC_MAX_REQUEST_BYTES,
   * 20 MB, for the reason given there. "Standard PDF (no passwords/encryption)":
   * an encrypted PDF is not detected here; the provider rejects it and the
   * juror is asked again with the text (the route's fallback).
   *
   * OpenAI: "You can upload up to 100 pages and 32MB of total content in a
   * single request to the API, across multiple file inputs", and only models
   * with image input take PDFs (the PDF files guide,
   * platform.openai.com/docs/guides/pdf-files, as last read; the providers' own
   * 32 MB check dates from it). NOT re-read on 2026-11-23: developers.openai.com
   * and platform.openai.com were unreachable from the session that wrote this,
   * so re-check both numbers against the current guide. If it allows more, a
   * very large PDF only falls back to text sooner than it must; if it allows
   * less, OpenAI rejects the request and the juror is asked again with the text
   * (the route's fallback).
   */
  OPENAI_MAX_PAGES_PER_REQUEST: 100,
  /** Decoded file bytes, summed over the PDFs of one request. */
  OPENAI_MAX_FILE_BYTES_PER_REQUEST: 32 * 1024 * 1024,
} as const;

/** How one juror was given one PDF; reported as `model_results[].pdf_inputs`. */
export interface JurorPdfInput {
  /** The request's name for the file, or its number in the request (as the notes and warnings name it). */
  attachment: string;
  /** native: the file itself. text: its extracted text only. not_shown: nothing of it. */
  form: 'native' | 'text' | 'not_shown';
  /** Pages, when the parser could count them. */
  pages?: number;
  /** Why it was not sent as a PDF; absent for `native`. */
  reason?: PdfTextReason;
}

/** What one juror is sent besides the prompt, and what the prompt must say about it. */
export interface JurorAttachments {
  attachments: ProviderAttachment[];
  /** Lines for this juror's attachment notes (after the image notes every juror gets). */
  notes: string[];
  /** One entry per PDF of the request, in request order. */
  pdfInputs: JurorPdfInput[];
  /** The same entries by the PDF's index in the attachments (two files can share a name). */
  pdfInputByIndex: Map<number, JurorPdfInput>;
  /** How many PDFs are in `attachments` as files. */
  nativePdfs: number;
}

interface Allowance {
  /** PDF pages the request may still take. */
  pages: number;
  /** Bytes the PDFs may still add, in the unit `cost` measures. */
  bytes: number;
  cost: (pdf: PdfForm) => number;
  /** What the arbiter did with a file over a limit, for the juror's note. */
  overPages: (pdf: PdfForm) => string;
  overSize: string;
}

/** What is left for PDFs in a juror's request once the images and the text are in it. */
function allowanceFor(family: PdfProviderFamily, results: AttachmentProcessingResult[]): Allowance {
  let imageBlocks = 0;
  let commonBytes = 0;
  for (const { attachment } of results) {
    if (attachment.type === 'image') imageBlocks++;
    // A PDF's text is counted even though the file replaces it: at most 100,000 characters each.
    commonBytes += attachment.content.length;
  }
  const pagesOf = (pdf: PdfForm) => (pdf.pages ? `its ${pdf.pages} pages` : 'its pages');

  if (family === 'anthropic') {
    const requestBytes = Math.floor(IMAGE_LIMITS.ANTHROPIC_MAX_REQUEST_BYTES * IMAGE_LIMITS.SAFETY_MARGIN);
    return {
      pages: Math.min(
        PDF_LIMITS.ANTHROPIC_MAX_PAGES_PER_REQUEST,
        IMAGE_LIMITS.ANTHROPIC_MAX_IMAGES_PER_REQUEST - imageBlocks,
      ),
      bytes: requestBytes - commonBytes,
      // The file travels base64-encoded inside the JSON request, and the limit is on the request.
      cost: pdf => pdf.base64Length,
      overPages: pdf =>
        `The file itself was not sent: ${pagesOf(pdf)} would put this request over the ` +
        `${PDF_LIMITS.ANTHROPIC_MAX_PAGES_PER_REQUEST} PDF pages and images a request to this model may hold.`,
      overSize:
        `The file itself was not sent: it would put this request over this model's ` +
        `${IMAGE_LIMITS.ANTHROPIC_MAX_REQUEST_BYTES / 1_000_000} MB request size limit.`,
    };
  }
  return {
    pages: PDF_LIMITS.OPENAI_MAX_PAGES_PER_REQUEST,
    // The files' own bytes. OpenAI's 512 MB payload limit is normalizeImages' to
    // keep: it fits the images around every PDF counted in full.
    bytes: PDF_LIMITS.OPENAI_MAX_FILE_BYTES_PER_REQUEST,
    cost: pdf => pdf.byteLength,
    overPages: pdf =>
      `The file itself was not sent: ${pagesOf(pdf)} would put this request over the ` +
      `${PDF_LIMITS.OPENAI_MAX_PAGES_PER_REQUEST} PDF pages a request to this model may hold.`,
    overSize:
      `The file itself was not sent: it would put this request over the ` +
      `${PDF_LIMITS.OPENAI_MAX_FILE_BYTES_PER_REQUEST / (1024 * 1024)} MB of files a request to this model may hold.`,
  };
}

/** What a juror is told when its provider turned the file down and it was asked again with the text. */
const FILE_NOT_ACCEPTED = 'The file itself was sent to this model first and was not accepted.';

export interface JurorRoutingOptions {
  /**
   * The provider turned down the request that carried PDFs as files: every PDF
   * that was a file becomes its text, and the juror is told why.
   */
  rejected?: boolean;
}

/**
 * A juror whose provider's request carries images and nothing else (Ollama: a
 * prompt and one image). It is sent the images; every other attachment, a
 * document's text included, is not shown to it, and its prompt says so in one
 * line instead of claiming a PDF's text is shown.
 */
export function imagesOnly(prepared: PreparedAttachments, refs: string[]): JurorAttachments {
  const attachments: ProviderAttachment[] = [];
  const imageIndexes = new Set<number>();
  for (const result of prepared.processed.results) {
    if (result.attachment.type !== 'image' || result.sourceIndex === undefined) continue;
    attachments.push(toProviderAttachment(result));
    imageIndexes.add(result.sourceIndex);
  }
  // By name: the parts of a split image share one, and the labels between them are not files.
  const imageRefs = new Set(Array.from(imageIndexes, index => attachmentRef(refs, index)));
  const names = Array.from(new Set(Array.from({ length: prepared.count }, (_, index) => attachmentRef(refs, index))))
    .filter(name => !imageRefs.has(name));
  const pdfInputByIndex = notShownPdfs(prepared, refs, 'images_only');
  return {
    attachments,
    notes: names.length === 0 ? [] : [notDeliveredNote(names, 'this model is sent images only')],
    pdfInputs: Array.from(pdfInputByIndex.values()),
    pdfInputByIndex,
    nativePdfs: 0,
  };
}

/**
 * The attachments of a request as one juror gets them.
 *
 * @param prepared - Every attachment in every form (prepareAttachments).
 * @param refs - How each attachment is named (normalizeImageAttachments' `refs`), index-aligned with them.
 * @param support - nativePdfSupport(provider, model) for this juror.
 */
export function attachmentsForJuror(
  prepared: PreparedAttachments,
  refs: string[],
  support: NativePdfSupport,
  options: JurorRoutingOptions = {},
): JurorAttachments {
  const { results } = prepared.processed;
  const commonForm = new Map<number, AttachmentProcessingResult>();
  results.forEach(result => {
    if (result.sourceIndex !== undefined) commonForm.set(result.sourceIndex, result);
  });
  const allowance = support.native && support.family ? allowanceFor(support.family, results) : null;

  const attachments: ProviderAttachment[] = [];
  const pdfInputByIndex = new Map<number, JurorPdfInput>();
  const sentAsFile = new Set<number>();
  const whyNotAFile = new Map<number, string>();

  for (let index = 0; index < prepared.count; index++) {
    const pdf = prepared.pdfs.get(index);
    const common = commonForm.get(index);
    if (!pdf) {
      if (common) attachments.push(toProviderAttachment(common));
      continue;
    }

    // An unreadable page count is taken as one page: the provider counts them itself.
    const pages = pdf.pages ?? 1;
    let reason: PdfTextReason | null = null;
    if (!allowance) {
      reason = 'model';
    } else if (pages > allowance.pages) {
      reason = 'page_limit';
      whyNotAFile.set(index, allowance.overPages(pdf));
    } else if (allowance.cost(pdf) > allowance.bytes) {
      reason = 'size_limit';
      whyNotAFile.set(index, allowance.overSize);
    }

    const attachment = attachmentRef(refs, index);
    const known = pdf.pages !== null ? { pages: pdf.pages } : {};
    if (!reason && allowance) {
      // This file is one the juror is sent. It takes its share of the allowance in the
      // request after a rejection too, so the files that did not fit beside it keep
      // their own reason: only a file that was sent can have been turned down.
      allowance.pages -= pages;
      allowance.bytes -= allowance.cost(pdf);
      if (options.rejected) {
        reason = 'rejected';
        whyNotAFile.set(index, FILE_NOT_ACCEPTED);
      } else {
        sentAsFile.add(index);
        const name = fileName(attachment);
        attachments.push({
          type: 'document',
          content: pdf.content,
          mediaType: 'application/pdf',
          ...(name && { name }),
          // Not sent: where a link inside the PDF is looked for (web-access.ts).
          ...(common && { extractedText: common.attachment.content }),
        });
        pdfInputByIndex.set(index, { attachment, form: 'native', ...known });
        continue;
      }
    }

    if (common) attachments.push(toProviderAttachment(common));
    pdfInputByIndex.set(index, { attachment, form: common ? 'text' : 'not_shown', ...known, reason: reason! });
  }

  return {
    attachments,
    // One writer for every line about a document, whoever the juror is.
    notes: documentNotes(prepared.processed, refs, { sentAsFile, whyNotAFile }),
    pdfInputs: Array.from(pdfInputByIndex.values()),
    pdfInputByIndex,
    nativePdfs: sentAsFile.size,
  };
}

/**
 * A juror whose model is sent no attachments at all (the provider says so for
 * that model): nothing is attached, and the prompt says what was delivered.
 */
export function withoutAttachments(prepared: PreparedAttachments, refs: string[]): JurorAttachments {
  const names = Array.from(new Set(Array.from({ length: prepared.count }, (_, index) => attachmentRef(refs, index))));
  const pdfInputByIndex = notShownPdfs(prepared, refs, 'no_attachments');
  return {
    attachments: [],
    notes: names.length === 0 ? [] : [notDeliveredNote(names, 'this model is sent no attachments')],
    pdfInputs: Array.from(pdfInputByIndex.values()),
    pdfInputByIndex,
    nativePdfs: 0,
  };
}

/** One line for the attachments a juror is not sent at all: what was delivered, and why it is not shown. */
function notDeliveredNote(names: string[], because: string): string {
  const listed = names.slice(0, 20).join(', ') + (names.length > 20 ? `, and ${names.length - 20} more` : '');
  const one = names.length === 1;
  return (
    `${one ? 'Attachment' : 'Attachments'} ${listed} ${one ? 'was' : 'were'} delivered with this request, but ` +
    `${because}, so ${one ? 'its' : 'their'} content is not shown to you. ` +
    `${one ? 'The file is' : 'The files are'} not missing from the request.`
  );
}

/** Every PDF of the request as not shown to a juror, for the same reason. */
function notShownPdfs(
  prepared: PreparedAttachments,
  refs: string[],
  reason: 'no_attachments' | 'images_only',
): Map<number, JurorPdfInput> {
  return new Map(
    Array.from(prepared.pdfs.entries())
      .sort(([a], [b]) => a - b)
      .map(([index, pdf]): [number, JurorPdfInput] => [
        index,
        { attachment: attachmentRef(refs, index), form: 'not_shown', ...(pdf.pages !== null ? { pages: pdf.pages } : {}), reason },
      ]),
  );
}

/** The request's name for an attachment, or its number: what the notes put after "Attachment". */
function attachmentRef(refs: string[], index: number): string {
  return refs[index] ?? String(index + 1);
}

/**
 * A ref that is only a number is an attachment the request did not name: no file name to pass on.
 * A named ref is quoted, as the notes write it (normalizeImages.ts attachmentName); the file name
 * passed to a provider (OpenAI's filename, Anthropic's title) is the name without the quotes.
 */
function fileName(ref: string): string | undefined {
  if (/^\d+$/.test(ref)) return undefined;
  return /^"[^"]*"$/.test(ref) ? ref.slice(1, -1) : ref;
}

function toProviderAttachment(result: AttachmentProcessingResult): ProviderAttachment {
  const { type, content, mediaType } = result.attachment;
  return { type, content, mediaType };
}

/** One log line per juror: which form each PDF took. Never the content. */
export function describePdfInputs(pdfInputs: JurorPdfInput[]): string {
  if (pdfInputs.length === 0) return 'no PDF';
  return pdfInputs
    .map(input => {
      const pages = input.pages !== undefined ? `${input.pages} page${input.pages === 1 ? '' : 's'}` : '';
      const detail = [input.reason, pages].filter(Boolean).join(', ');
      return `${input.attachment} ${input.form}${detail ? ` (${detail})` : ''}`;
    })
    .join('; ');
}
