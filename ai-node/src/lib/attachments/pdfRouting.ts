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
 *   the file. Any other juror gets the extracted text and a line in its prompt
 *   saying that it sees only the text.
 * - A PDF that would put a juror's request over a provider limit is text for
 *   that juror, with the line. Images are fitted first (normalizeImages.ts,
 *   which counts each PDF in full, so they leave room for it); a PDF takes what
 *   is left, in attachment order.
 * - A PDF with no extractable text (a scan, a set of screenshots) is still sent
 *   to the jurors that read PDFs; the others are told it is not shown to them.
 *
 * Whether a juror reads PDFs depends on the operator's gateway (a class routed
 * to OpenRouter gets text), so unlike the image decisions this one can differ
 * between operators for the same request. Within one node it follows from the
 * request alone.
 */

import { IMAGE_LIMITS } from './normalizeImages';
import type { NativePdfSupport, PdfProviderFamily } from '../llm/pdf-support';
import type { ProviderAttachment } from '../llm/provider-attachments';
import {
  DocumentNoteInput,
  PdfTextReason,
  PreparedAttachment,
  documentNotes,
} from '../../utils/attachment-processor';

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
  /** The request's name for the file, or "Attachment N". */
  name: string;
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
  /** How many PDFs are in `attachments` as files. */
  nativePdfs: number;
}

interface Allowance {
  /** PDF pages the request may still take. */
  pages: number;
  /** Bytes the PDFs may still add, in the unit `cost` measures. */
  bytes: number;
  cost: (attachment: PreparedAttachment) => number;
  pageLimit: string;
  sizeLimit: string;
}

/** What is left for PDFs in a juror's request once the images and the text are in it. */
function allowanceFor(family: PdfProviderFamily, prepared: PreparedAttachment[]): Allowance {
  let imageBlocks = 0;
  let commonBytes = 0;
  for (const attachment of prepared) {
    if (!attachment.common) continue;
    if (attachment.common.type === 'image') imageBlocks++;
    // A PDF's text is counted even though the file replaces it: at most 100,000 characters each.
    commonBytes += attachment.common.content.length;
  }

  if (family === 'anthropic') {
    const requestBytes = Math.floor(IMAGE_LIMITS.ANTHROPIC_MAX_REQUEST_BYTES * IMAGE_LIMITS.SAFETY_MARGIN);
    return {
      pages: Math.min(
        PDF_LIMITS.ANTHROPIC_MAX_PAGES_PER_REQUEST,
        IMAGE_LIMITS.ANTHROPIC_MAX_IMAGES_PER_REQUEST - imageBlocks,
      ),
      bytes: requestBytes - commonBytes,
      // The file travels base64-encoded inside the JSON request, and the limit is on the request.
      cost: attachment => attachment.pdf!.base64Length,
      pageLimit: `the ${PDF_LIMITS.ANTHROPIC_MAX_PAGES_PER_REQUEST} PDF pages and images a request to this model may hold`,
      sizeLimit: `this model's ${IMAGE_LIMITS.ANTHROPIC_MAX_REQUEST_BYTES / 1_000_000} MB request size limit`,
    };
  }
  return {
    pages: PDF_LIMITS.OPENAI_MAX_PAGES_PER_REQUEST,
    // The files' own bytes. OpenAI's 512 MB payload limit is normalizeImages' to
    // keep: it fits the images around every PDF counted in full.
    bytes: PDF_LIMITS.OPENAI_MAX_FILE_BYTES_PER_REQUEST,
    cost: attachment => attachment.pdf!.byteLength,
    pageLimit: `the ${PDF_LIMITS.OPENAI_MAX_PAGES_PER_REQUEST} PDF pages a request to this model may hold`,
    sizeLimit: `the ${PDF_LIMITS.OPENAI_MAX_FILE_BYTES_PER_REQUEST / (1024 * 1024)} MB of files a request to this model may hold`,
  };
}

export interface JurorRoutingOptions {
  /**
   * The provider turned down the request that carried PDFs as files: every PDF
   * that was a file becomes its text, and the juror is told why.
   */
  rejected?: boolean;
}

/**
 * The attachments of a request as one juror gets them.
 *
 * @param prepared - Every attachment in every form (prepareAttachments), in request order.
 * @param support - nativePdfSupport(provider, model) for this juror.
 */
export function attachmentsForJuror(
  prepared: PreparedAttachment[],
  support: NativePdfSupport,
  options: JurorRoutingOptions = {},
): JurorAttachments {
  const attachments: ProviderAttachment[] = [];
  const pdfInputs: JurorPdfInput[] = [];
  const noteInputs: DocumentNoteInput[] = [];
  const unreadable: string[] = [];
  const allowance = support.native && support.family ? allowanceFor(support.family, prepared) : null;
  let nativePdfs = 0;

  for (const attachment of prepared) {
    if (attachment.kind !== 'pdf' || !attachment.pdf) {
      if (attachment.common) {
        attachments.push(toProviderAttachment(attachment.common));
      } else {
        unreadable.push(
          `Attachment ${attachment.name.ref} could not be read and is not shown to you` +
            `${attachment.skippedReason ? `: ${withoutFinalStop(attachment.skippedReason)}` : ''}.`,
        );
      }
      continue;
    }

    // An unreadable page count is taken as one page: the provider counts them itself.
    const pages = attachment.pdf.pages ?? 1;
    let reason: PdfTextReason | null = null;
    let limit: string | undefined;
    if (!allowance) {
      reason = 'model';
    } else if (pages > allowance.pages) {
      reason = 'page_limit';
      limit = allowance.pageLimit;
    } else if (allowance.cost(attachment) > allowance.bytes) {
      reason = 'size_limit';
      limit = allowance.sizeLimit;
    } else if (options.rejected) {
      reason = 'rejected';
    }

    const known = attachment.pdf.pages !== null ? { pages: attachment.pdf.pages } : {};
    if (!reason && allowance) {
      allowance.pages -= pages;
      allowance.bytes -= allowance.cost(attachment);
      nativePdfs++;
      attachments.push({
        type: 'document',
        content: attachment.pdf.content,
        mediaType: 'application/pdf',
        name: attachment.name.display,
      });
      pdfInputs.push({ name: attachment.name.display, form: 'native', ...known });
      continue;
    }

    const form = attachment.common ? 'text' : 'not_shown';
    if (attachment.common) attachments.push(toProviderAttachment(attachment.common));
    pdfInputs.push({ name: attachment.name.display, form, ...known, reason: reason! });
    noteInputs.push({ attachment, form, reason: reason!, limit });
  }

  return { attachments, notes: [...unreadable, ...documentNotes(noteInputs)], pdfInputs, nativePdfs };
}

/**
 * A juror whose model is sent no attachments at all (the provider says so for
 * that model): nothing is attached, and the prompt says what the request held.
 */
export function withoutAttachments(prepared: PreparedAttachment[]): JurorAttachments {
  const names = Array.from(new Set(prepared.map(attachment => attachment.name.display)));
  const shown = names.slice(0, 20).join(', ') + (names.length > 20 ? `, and ${names.length - 20} more` : '');
  return {
    attachments: [],
    notes:
      names.length === 0
        ? []
        : [
            `This request has ${names.length === 1 ? 'an attachment' : `${names.length} attachments`} (${shown}) that ` +
              `${names.length === 1 ? 'is' : 'are'} not shown to you: this model is sent no attachments. Judge without ` +
              `${names.length === 1 ? 'it' : 'them'} and say so in your justification.`,
          ],
    pdfInputs: prepared
      .filter(attachment => attachment.kind === 'pdf')
      .map(attachment => ({
        name: attachment.name.display,
        form: 'not_shown' as const,
        ...(attachment.pdf && attachment.pdf.pages !== null ? { pages: attachment.pdf.pages } : {}),
        reason: 'no_attachments' as const,
      })),
    nativePdfs: 0,
  };
}

function toProviderAttachment(common: { type: string; content: string; mediaType: string }): ProviderAttachment {
  return { type: common.type, content: common.content, mediaType: common.mediaType };
}

function withoutFinalStop(text: string): string {
  return text.trim().replace(/\.$/, '');
}

/** One log line per juror: which form each PDF took. Never the content. */
export function describePdfInputs(pdfInputs: JurorPdfInput[]): string {
  if (pdfInputs.length === 0) return 'no PDF';
  return pdfInputs
    .map(input => {
      const pages = input.pages !== undefined ? `, ${input.pages} page${input.pages === 1 ? '' : 's'}` : '';
      return `${input.name} ${input.form}${input.reason ? ` (${input.reason}${pages})` : pages ? ` (${pages.slice(2)})` : ''}`;
    })
    .join('; ');
}
