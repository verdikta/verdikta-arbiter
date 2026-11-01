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

/** Any machine-line prefix (with or without its colon), anywhere, in any case: such text is never logged. */
const MACHINE_LINE = /verdikta-(?:disclosure|dispute)/i;

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
 * disclosure gate. The dispute line is the disputing maker's, and it is read
 * on its own, whatever the disclosure line looks like: a line after the first
 * that starts with `verdikta-dispute: ` is the dispute line, and a malformed
 * one (or more than one) is a requester error, never INVALID against the
 * hunter. When the addendum as a whole does not parse but its dispute line
 * does, `dispute` is still returned, so the statement's own checks (a
 * requester's) run before the claim is settled.
 *
 * @param {unknown} addendum
 * @returns {{ ok: true, disclosure: object, dispute: { statementCid: string }|null, text: string }
 *   | { ok: false, fault: 'claim'|'requester', issues: { code: string, path: string, detail: string }[],
 *       dispute: { statementCid: string }|null, text: null }}
 */
function readMachineLines(addendum) {
  const parsed = codeReview.parseAddendum(addendum);
  if (parsed.ok) {
    return { ok: true, disclosure: parsed.disclosure, dispute: parsed.dispute, text: codeReview.stripAddendum(addendum).text };
  }
  const issuesOf = (list) => list.map(({ code, path, detail }) => ({ code, path, detail }));
  const failed = (fault, issues, dispute = null) => ({ ok: false, fault, issues: issuesOf(issues), dispute, text: null });

  const lines = typeof addendum === 'string' ? addendum.split('\n') : [];
  const disputeLines = lines.slice(1).filter((line) => line.startsWith(codeReview.DISPUTE_LINE_PREFIX));
  if (disputeLines.length > 1) {
    return failed('requester', [{ code: 'LINE_COUNT', path: '/dispute', detail: 'the addendum carries more than one dispute line' }]);
  }
  if (disputeLines.length === 1) {
    const dispute = codeReview.parseDisputeLine(disputeLines[0]);
    if (!dispute.ok) return failed('requester', dispute.issues);
    return failed('claim', parsed.issues, { statementCid: dispute.statementCid });
  }
  return failed('claim', parsed.issues);
}

/**
 * Text for a log line or an error response, cut where it starts quoting a
 * machine line (an error from request validation can quote the addendum).
 * @param {string} text
 * @returns {string}
 */
function redactMachineLines(text) {
  if (typeof text !== 'string') return text;
  const match = MACHINE_LINE.exec(text);
  return match ? `${text.slice(0, match.index)}<withheld: quotes a verdikta machine line>` : text;
}

module.exports = { MACHINE_LINE, addendumForLog, readMachineLines, redactMachineLines };
