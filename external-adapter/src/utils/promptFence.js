/**
 * Hash-fence quoting for text the adapter itself joins into a juror prompt (the addendum on
 * the single-CID path, and the multi-CID fallback). The same format as @verdikta/common's
 * promptFence and the AI node's textFence.ts: quoted text cannot contain its own END line,
 * so it cannot close its block and speak as the requester.
 */
const crypto = require('crypto');

function fenceLabel(label) {
  return String(label == null ? '' : label).replace(/[^A-Za-z0-9 ._:/@()#+,'=-]/g, '_').slice(0, 200);
}

function oneLine(text, max = 200) {
  // eslint-disable-next-line no-control-regex -- collapse control characters to spaces
  return String(text == null ? '' : text).replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').trim().slice(0, max);
}

function fence(kind, label, content) {
  if (!/^[A-Z][A-Z ]{0,30}$/.test(kind)) throw new Error(`invalid fence kind: ${kind}`);
  const text = String(content == null ? '' : content);
  const safeLabel = fenceLabel(label);
  const digest = crypto.createHash('sha256').update(`${kind}\n${safeLabel}\n${text}`).digest('hex');
  for (const length of [16, 32, 64]) {
    const id = digest.slice(0, length);
    const end = `<<<END ${kind} ${id}>>>`;
    if (!text.includes(end)) return `<<<BEGIN ${kind} ${id}${safeLabel ? ` | ${safeLabel}` : ''}>>>\n${text}\n${end}`;
  }
  throw new Error('quoted content contains its own fence line');
}

/** "Addendum:" and the quoted value, as the adapter appends it to a prompt. */
function addendumSection(label, value) {
  return `\n\nAddendum: \n${oneLine(label)}:\n${fence('ADDENDUM', 'value supplied with the request', value)}`;
}

module.exports = { fence, fenceLabel, oneLine, addendumSection };
