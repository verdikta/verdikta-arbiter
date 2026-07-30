/**
 * Media type detection from magic bytes.
 *
 * Attachments arrive as data URIs whose `data:<mediaType>;base64,` header is
 * supplied by the submitter. That header is a claim, not a fact - a JPEG
 * labelled `image/png` is accepted by our own parsing but rejected by provider
 * APIs, which sniff the payload themselves. Anthropic answers such a request
 * with `400 invalid_request_error: ... specified using the image/png media
 * type, but the image appears to be a image/jpeg image`, failing the whole
 * evaluation. So we sniff the bytes and trust those over the declared header.
 */

/** Number of base64 characters to decode when sniffing (48 bytes - all signatures fit). */
const SNIFF_BASE64_CHARS = 64;

/**
 * Identifies a media type from a buffer's leading bytes.
 * @param buffer - Decoded attachment bytes (at least the first 12)
 * @returns The detected media type, or null if no signature matches
 */
export function sniffMediaType(buffer: Buffer): string | null {
  // WEBP: "RIFF" then 4 size bytes then "WEBP"
  if (buffer.length >= 12 &&
      buffer[0] === 0x52 && buffer[1] === 0x49 &&
      buffer[2] === 0x46 && buffer[3] === 0x46 &&
      buffer[8] === 0x57 && buffer[9] === 0x45 &&
      buffer[10] === 0x42 && buffer[11] === 0x50) {
    return 'image/webp';
  }

  // PNG: \x89 P N G
  if (buffer.length >= 8 &&
      buffer[0] === 0x89 && buffer[1] === 0x50 &&
      buffer[2] === 0x4E && buffer[3] === 0x47) {
    return 'image/png';
  }

  // JPEG: FF D8
  if (buffer.length >= 2 && buffer[0] === 0xFF && buffer[1] === 0xD8) {
    return 'image/jpeg';
  }

  // GIF: "GIF8" then '7' or '9' then 'a'
  if (buffer.length >= 6 &&
      buffer[0] === 0x47 && buffer[1] === 0x49 &&
      buffer[2] === 0x46 && buffer[3] === 0x38 &&
      (buffer[4] === 0x37 || buffer[4] === 0x39) &&
      buffer[5] === 0x61) {
    return 'image/gif';
  }

  // PDF: "%PDF"
  if (buffer.length >= 4 &&
      buffer[0] === 0x25 && buffer[1] === 0x50 &&
      buffer[2] === 0x44 && buffer[3] === 0x46) {
    return 'application/pdf';
  }

  return null;
}

/**
 * Resolves the media type of a base64 attachment, preferring sniffed bytes over
 * the declared header.
 *
 * Falls back to `declared` whenever the bytes carry no signature we recognise -
 * SVG and plain text are text-based and have no reliable magic number, so a
 * correctly-declared one must survive.
 *
 * @param declared - Media type taken from the data URI header
 * @param base64Content - Attachment payload, base64 without the data URI prefix
 * @returns The media type to send to the provider
 */
export function resolveMediaType(declared: string, base64Content: string): string {
  if (!base64Content) return declared;

  let sniffed: string | null = null;
  try {
    // Base64 may be wrapped across lines; strip whitespace before decoding.
    const prefix = base64Content.replace(/\s/g, '').slice(0, SNIFF_BASE64_CHARS);
    sniffed = sniffMediaType(Buffer.from(prefix, 'base64'));
  } catch {
    return declared;
  }

  if (!sniffed) return declared;

  if (sniffed !== declared) {
    console.warn(
      `Attachment declared "${declared}" but its bytes are "${sniffed}" - using the sniffed type. ` +
      `Provider APIs reject mislabelled attachments.`
    );
  }

  return sniffed;
}
