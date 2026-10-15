/**
 * @fileoverview What the EA logs about a `/api/rank-and-justify` request.
 *
 * Attachments are data URIs (images, other binaries) or raw text, and they are
 * the evidence and submitted work themselves: one screenshot is megabytes of
 * base64. The summary records each attachment's shape — media type, encoded
 * length, archive name — and never its contents.
 */

// Room for any real media type plus parameters; bounds the search for the
// comma that ends a data URI's header in a multi-megabyte string.
const MAX_DATA_URI_HEADER = 256;

/**
 * @param {*} attachment - an entry of `payload.attachments`
 * @param {string} [name] - its entry in `payload.attachmentNames`, if sent
 * @returns {{ name?: string, mediaType: string, length?: number }}
 */
function summarizeAttachment(attachment, name) {
  const summary = name ? { name } : {};
  if (typeof attachment !== 'string') {
    summary.mediaType = 'unknown';
    return summary;
  }
  if (attachment.startsWith('data:')) {
    const comma = attachment.slice(0, MAX_DATA_URI_HEADER).indexOf(',');
    // "data:image/png;base64,…" → "image/png"
    summary.mediaType = comma === -1 ? 'unknown' : attachment.slice(5, comma).split(';')[0] || 'unknown';
  } else {
    // encodeAttachment sends text files as the raw string.
    summary.mediaType = 'text/plain';
  }
  summary.length = attachment.length;
  return summary;
}

/**
 * @param {Object} payload - the body POSTed to `/api/rank-and-justify`
 * @returns {Object} loggable summary; contains no attachment contents
 */
function summarizePayload(payload) {
  const attachments = Array.isArray(payload.attachments) ? payload.attachments : [];
  const names = Array.isArray(payload.attachmentNames) ? payload.attachmentNames : [];
  return {
    promptLength: typeof payload.prompt === 'string' ? payload.prompt.length : 0,
    models: (payload.models || []).map(m => ({
      provider: m.provider,
      model: m.model,
      weight: m.weight,
      count: m.count
    })),
    iterations: payload.iterations,
    outcomes: payload.outcomes || [],
    attachmentsCount: attachments.length,
    attachments: attachments.map((a, i) => summarizeAttachment(a, names[i]))
  };
}

module.exports = { summarizeAttachment, summarizePayload };
