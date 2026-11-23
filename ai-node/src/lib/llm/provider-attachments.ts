/**
 * What a provider does with the attachments it is handed.
 *
 * A provider request carries three things: images, text, and (Anthropic and
 * OpenAI only) PDFs. Each provider used to decide for itself what happened to
 * anything else, and the answer was usually "nothing": the Anthropic provider
 * left a PDF out of the request for a model missing from its own list, xAI and
 * Hyperbolic skipped every attachment that was not an image or text, and the
 * OpenRouter and OpenAI fallbacks sent a document's base64 as if it were its
 * text. The juror was never told.
 *
 * The rank-and-justify route no longer hands a provider a PDF it cannot send
 * (attachments/pdfRouting.ts turns it into text and a note first). This is the
 * second line: whatever still arrives and cannot go into the request becomes a
 * line in the prompt, so no caller can lose an attachment silently.
 */

export interface ProviderAttachment {
  /** 'image', 'text', or 'document' (a file sent as itself: only a PDF can be). */
  type: string;
  /** Base64 for an image or a document, the text itself for text. */
  content: string;
  mediaType: string;
  /** The file's name in the request, when the caller knows it. */
  name?: string;
  /**
   * For a PDF sent as a file: the text extracted from it, when there is any. It is
   * never sent. It is what a link inside the PDF is found in (web-access.ts): the
   * file's base64 cannot be searched for one.
   */
  extractedText?: string;
}

export const PDF_MEDIA_TYPE = 'application/pdf';

export function isPdfAttachment(attachment: ProviderAttachment): boolean {
  return attachment.type !== 'text' && attachment.type !== 'image' && attachment.mediaType === PDF_MEDIA_TYPE;
}

export interface PartitionedAttachments {
  /** PDFs to send as document / file blocks, in request order. */
  pdfs: ProviderAttachment[];
  /** Images and text, in request order. */
  inline: ProviderAttachment[];
  /** What this request cannot carry. */
  notShown: ProviderAttachment[];
}

/**
 * Splits attachments by what the request can carry.
 *
 * @param sendsPdf - Whether this provider and model take a PDF block.
 * @param sendsText - false for a provider whose request has no place for text attachments (Ollama).
 */
export function partitionAttachments(
  attachments: ProviderAttachment[],
  sendsPdf: boolean,
  sendsText = true,
): PartitionedAttachments {
  const result: PartitionedAttachments = { pdfs: [], inline: [], notShown: [] };
  for (const attachment of attachments) {
    if (attachment.type === 'image') result.inline.push(attachment);
    else if (attachment.type === 'text') (sendsText ? result.inline : result.notShown).push(attachment);
    else if (sendsPdf && isPdfAttachment(attachment)) result.pdfs.push(attachment);
    else result.notShown.push(attachment);
  }
  return result;
}

function describe(attachment: ProviderAttachment): string {
  const kind =
    attachment.type === 'text' ? 'text attachment' : isPdfAttachment(attachment) ? 'PDF' : `${attachment.mediaType} file`;
  return attachment.name ? `${kind} "${attachment.name}"` : kind;
}

/**
 * The line that tells the model what it was not shown, or null when it was shown everything.
 * Like the arbiter's other attachment notes (documentNotes), it says what was done with
 * the file and that the file was delivered; it does not say what to conclude.
 *
 * @param who - The provider and model, for the reason ("xAI grok-4.6").
 */
export function notShownNote(notShown: ProviderAttachment[], who: string): string | null {
  if (notShown.length === 0) return null;
  const list = notShown.map(describe).join(', ');
  const one = notShown.length === 1;
  return (
    `[${one ? 'One attachment' : `${notShown.length} attachments`} (${list}) ${one ? 'was' : 'were'} delivered with this ` +
    `request, but a request to ${who} cannot carry ${one ? 'it' : 'them'}, so ${one ? 'its' : 'their'} content is not ` +
    `shown to you. ${one ? 'The file is' : 'The files are'} not missing from the request.]`
  );
}

/** The prompt with the not-shown line appended, or the prompt itself. */
export function withNotShownNote(prompt: string, notShown: ProviderAttachment[], who: string): string {
  const note = notShownNote(notShown, who);
  return note ? `${prompt}\n\n${note}` : prompt;
}

/**
 * A file name for a PDF block. OpenAI reads the type from the name's extension,
 * so it always ends in ".pdf"; the rest is the request's own name for the file,
 * reduced to its last path segment and to characters every API takes, so the
 * model can match it to how the prompt refers to it.
 */
export function pdfFileName(name: string | undefined, position: number): string {
  const fallback = position > 0 ? `document-${position + 1}.pdf` : 'document.pdf';
  if (typeof name !== 'string') return fallback;
  const base = (name.split(/[\\/]/).pop() || '')
    .replace(/[^A-Za-z0-9._ -]+/g, '_')
    .replace(/^[._ -]+/, '')
    .slice(0, 96)
    .trim();
  if (!base || /^\.?pdf$/i.test(base)) return fallback;
  return /\.pdf$/i.test(base) ? base : `${base}.pdf`;
}
