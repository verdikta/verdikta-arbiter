/**
 * @fileoverview The addendum's machine lines (design §13.3, errata E1 and E2).
 *
 * StakeAttestation.reveal writes the addendum as one disclosure line and, on
 * a dispute, an LF and one dispute line:
 *
 *   verdikta-disclosure: 0x<archiveSha256> 0x<ciphertextSha256> <ciphertextCid> 0x<contentKey> 0x<ephemeralKey>
 *   verdikta-dispute: <statementCid>
 *
 * @verdikta/common parses them strictly (parseAddendum) and says what of the
 * addendum a model may see (stripAddendum: '' for every addendum the contract
 * writes). This module adds two things the EA needs: who is at fault when the
 * addendum does not parse, and a form of the addendum that is safe to log.
 */

const { codeReview } = require('@verdikta/common');

/** Any machine-line prefix, anywhere, in any case: such an addendum is never logged. */
const MACHINE_LINE = /verdikta-(?:disclosure|dispute):/i;

/**
 * The addendum as the adapter may log it: unchanged, unless it carries (or
 * looks like it carries) a machine line, whose keys must never reach a log.
 * @param {string} addendum
 * @returns {string}
 */
function addendumForLog(addendum) {
  if (typeof addendum !== 'string' || !MACHINE_LINE.test(addendum)) return addendum;
  return `<withheld: ${Buffer.byteLength(addendum, 'utf8')} bytes carrying a verdikta machine line>`;
}

/**
 * Read the machine lines of a code-review request.
 *
 * Fault: the disclosure line is the claim's (the hunter's reveal supplies its
 * keys), so a framing or disclosure-line failure settles INVALID through the
 * disclosure gate. A recognisable dispute line that is malformed after a good
 * disclosure line is the disputing maker's: a requester error, never INVALID
 * against the hunter.
 *
 * @param {unknown} addendum
 * @returns {{ ok: true, disclosure: object, dispute: { statementCid: string }|null, text: string }
 *   | { ok: false, fault: 'claim'|'requester', issues: { code: string, path: string, detail: string }[], text: null }}
 */
function readMachineLines(addendum) {
  const parsed = codeReview.parseAddendum(addendum);
  if (parsed.ok) {
    return { ok: true, disclosure: parsed.disclosure, dispute: parsed.dispute, text: codeReview.stripAddendum(addendum).text };
  }
  const lines = typeof addendum === 'string' ? addendum.split('\n') : [];
  const disputeLineOnly = lines.length === 2
    && lines[1].startsWith(codeReview.DISPUTE_LINE_PREFIX)
    && parsed.issues.length > 0
    && parsed.issues.every((issue) => typeof issue.path === 'string' && issue.path.startsWith('/dispute'));
  return {
    ok: false,
    fault: disputeLineOnly ? 'requester' : 'claim',
    issues: parsed.issues.map(({ code, path, detail }) => ({ code, path, detail })),
    text: null
  };
}

module.exports = { MACHINE_LINE, addendumForLog, readMachineLines };
