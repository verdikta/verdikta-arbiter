/**
 * Quoting for text-mode juror prompts (the evaluation of a bounty submission or any other
 * request): attachments, the jurors' own replies when another call reads them, and the
 * repair call's input.
 *
 * The same hash fence as code mode (lib/code-review/claim-prompt.ts) and as
 * @verdikta/common's constructCombinedQuery, which quotes a bCID's text the same way: the
 * content sits between a BEGIN and an END line with the same id, the first 16 hex digits of
 * SHA-256 over kind, label and content, so quoted text cannot contain its own END line and
 * cannot close its block to speak as the requester. A pure function: every juror on every
 * arbiter reads the same bytes.
 */
import crypto from 'crypto';

/** A label stays on its BEGIN line: no line breaks, no angle brackets, at most 200 characters. */
export function fenceLabel(label: string): string {
  return String(label ?? '').replace(/[^A-Za-z0-9 ._:/@()#+,'=-]/g, '_').slice(0, 200);
}

export function fence(kind: string, label: string, content: string): string {
  if (!/^[A-Z][A-Z ]{0,30}$/.test(kind)) throw new Error(`invalid fence kind: ${kind}`);
  const text = String(content ?? '');
  const safeLabel = fenceLabel(label);
  const digest = crypto.createHash('sha256').update(`${kind}\n${safeLabel}\n${text}`).digest('hex');
  for (const length of [16, 32, 64]) {
    const id = digest.slice(0, length);
    const end = `<<<END ${kind} ${id}>>>`;
    if (!text.includes(end)) {
      return `<<<BEGIN ${kind} ${id}${safeLabel ? ` | ${safeLabel}` : ''}>>>\n${text}\n${end}`;
    }
  }
  throw new Error('quoted content contains its own fence line');
}

const END_LINE = /\n(<<<END [A-Z][A-Z ]{0,30} [0-9a-f]{16,64}>>>)$/;

/**
 * `text` cut to at most `max` characters. A fenced block keeps its END line, so a long
 * attachment cannot leave its block open for whatever follows it; the cut is said inside.
 */
export function limitText(text: string, max: number): string {
  if (text.length <= max) return text;
  const end = text.startsWith('<<<BEGIN ') ? text.match(END_LINE) : null;
  if (!end) return text.substring(0, max);
  const marker = `\n[... ${text.length - max} more characters were cut here ...]\n`;
  const keep = Math.max(0, max - end[1].length - marker.length);
  return `${text.substring(0, keep)}${marker}${end[1]}`;
}

/** Who supplied an attachment, as the external adapter reports it (attachmentSources). */
export type AttachmentSource = 'requester' | 'submitted' | undefined;

export function attachmentSource(sources: unknown, index: number): AttachmentSource {
  const value = Array.isArray(sources) ? sources[index] : undefined;
  return value === 'requester' || value === 'submitted' ? value : undefined;
}

/**
 * The fence for one text attachment. Only the adapter's word makes a block the requester's:
 * a file whose source is unknown is quoted like submitted material.
 */
export function fenceAttachment(text: string, index: number, name: unknown, source: AttachmentSource): string {
  const shown = typeof name === 'string' && name.trim() ? `: ${name.trim()}` : '';
  if (source === 'requester') {
    return fence('REQUESTER FILE', `attachment ${index + 1}${shown}, supplied by the requester`, text);
  }
  const who = source === 'submitted' ? ', submitted for evaluation' : '';
  return fence('FILE', `attachment ${index + 1}${shown}${who}`, text);
}

const TEXT_DATA_URI = /^data:(text\/[A-Za-z0-9.+-]+|application\/json)(?:;[^,]*)?;base64,/i;

/**
 * Quote every text attachment of a rank-and-justify request before anything else reads it,
 * index-aligned with the names and sources the adapter sent. A text file sent as a base64
 * data URI (text/markdown, application/json) is decoded first, so the models read its text
 * inside a block rather than base64 outside one. Images, PDFs and other binary files pass
 * through: text the AI node extracts from them is quoted where it is extracted
 * (utils/attachment-processor.ts).
 */
export function fenceTextAttachments(attachments: string[], names?: unknown, sources?: unknown): string[] {
  const nameList = Array.isArray(names) ? names : [];
  return attachments.map((attachment, index) => {
    if (typeof attachment !== 'string') return attachment;
    let text: string | null = null;
    if (!attachment.startsWith('data:')) {
      text = attachment;
    } else if (TEXT_DATA_URI.test(attachment)) {
      const decoded = Buffer.from(attachment.slice(attachment.indexOf(',') + 1), 'base64').toString('utf8');
      if (!decoded.includes('\u0000')) text = decoded;
    }
    if (text === null) return attachment;
    return fenceAttachment(text, index, nameList[index], attachmentSource(sources, index));
  });
}
