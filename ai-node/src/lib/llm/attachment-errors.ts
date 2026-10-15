/**
 * Errors from provider requests that carry attachments.
 *
 * The native-PDF paths used to rewrite every failure as a PDF problem - "OpenAI
 * PDF processing failed: ...", or worse, "PDF has too many pages" for any
 * message containing "100" - including image rejections on requests that had
 * no PDF at all. That hid the real cause of the bounty-171 failures (an image
 * over the patch limit). This keeps the provider's HTTP status and message and
 * says which input the message is about.
 */

export interface AttachmentContext {
  hasPdf: boolean;
  hasImage: boolean;
}

export type AttachmentStage = 'image' | 'pdf' | 'request';

/** Which part of the request a provider error message is about. */
export function attachmentStage(message: string, context: AttachmentContext): AttachmentStage {
  const lower = message.toLowerCase();
  if (context.hasImage && /image|patch|pixel/.test(lower)) return 'image';
  if (context.hasPdf && /pdf|document|file|page/.test(lower)) return 'pdf';
  return 'request';
}

/**
 * Wraps a provider error from a request with attachments. The result keeps the
 * original `status` and `code` (the route reports them as http_status and
 * error_code) and the original error as `cause`.
 */
export function attachmentRequestError(
  provider: string,
  model: string,
  error: any,
  context: AttachmentContext,
): Error {
  const message: string = error?.message ?? String(error);
  const status: number | undefined = error?.status ?? error?.response?.status;
  const httpStatus = status ? ` (HTTP ${status})` : '';

  let text: string;
  switch (attachmentStage(message, context)) {
    case 'image':
      text = `${provider} rejected an image attachment for ${model}${httpStatus}: ${message}`;
      break;
    case 'pdf':
      text = `${provider} rejected a PDF attachment for ${model}${httpStatus}: ${message}`;
      break;
    default:
      text = `${provider} request with attachments failed for ${model}${httpStatus}: ${message}`;
  }

  const wrapped = new Error(text) as Error & { status?: number; code?: string; cause?: unknown };
  if (status !== undefined) wrapped.status = status;
  if (error?.code !== undefined) wrapped.code = error.code;
  wrapped.cause = error;
  return wrapped;
}
