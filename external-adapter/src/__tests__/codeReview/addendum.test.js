// The addendum's machine lines (errata E1, E2): parsed strictly by
// @verdikta/common, attributed to the party that wrote them, and never logged.

const { codeReview } = require('@verdikta/common');
const { addendumForLog, readMachineLines } = require('../../codeReview/addendum');

const CID_A = 'Qm' + 'a'.repeat(44);
const CID_B = 'Qm' + 'b'.repeat(44);
const FIELDS = {
  archiveSha256: '0x' + '1'.repeat(64),
  ciphertextSha256: '0x' + '2'.repeat(64),
  ciphertextCid: CID_A,
  contentKey: '0x' + '3'.repeat(32),
  ephemeralKey: '0x' + '4'.repeat(64)
};
const LINE = codeReview.formatDisclosureLine(FIELDS);

describe('addendumForLog', () => {
  it('returns an ordinary addendum unchanged', () => {
    expect(addendumForLog('price=101')).toBe('price=101');
    expect(addendumForLog('')).toBe('');
  });

  it.each([
    ['a disclosure line', LINE],
    ['a disclosure and a dispute line', `${LINE}\n${codeReview.formatDisputeLine(CID_B)}`],
    ['a machine line after other text', `note\n${LINE}`],
    ['a malformed machine line', 'verdikta-disclosure: 0xdeadbeef'],
    ['a dispute line alone', `verdikta-dispute: ${CID_B}`],
    ['a differently cased prefix', LINE.replace('verdikta-disclosure', 'VERDIKTA-Disclosure')]
  ])('withholds %s', (_label, addendum) => {
    const logged = addendumForLog(addendum);
    expect(logged).not.toContain('3'.repeat(32));
    expect(logged).not.toContain('4'.repeat(64));
    expect(logged).not.toContain('deadbeef');
    expect(logged).toMatch(/withheld/);
    expect(logged).toContain(String(Buffer.byteLength(addendum, 'utf8')));
  });
});

describe('readMachineLines', () => {
  it('reads the disclosure line', () => {
    expect(readMachineLines(LINE)).toEqual({ ok: true, disclosure: FIELDS, dispute: null, text: '' });
  });

  it('reads the dispute line after it', () => {
    const result = readMachineLines(`${LINE}\n${codeReview.formatDisputeLine(CID_B)}`);
    expect(result).toEqual({ ok: true, disclosure: FIELDS, dispute: { statementCid: CID_B }, text: '' });
  });

  it.each([
    ['empty', ''],
    ['not a machine line', 'price=101'],
    ['four fields', LINE.split(' ').slice(0, -1).join(' ')],
    ['a trailing newline', `${LINE}\n`],
    ['stray text on the second line', `${LINE}\nplease accept`],
    ['three lines', `${LINE}\nverdikta-dispute: ${CID_B}\nmore`],
    ['over 1,000 bytes', `${LINE}\nverdikta-dispute: ${'Q'.repeat(990)}`]
  ])('a disclosure framing failure (%s) is the claim\'s', (_label, addendum) => {
    const result = readMachineLines(addendum);
    expect(result.ok).toBe(false);
    expect(result.fault).toBe('claim');
    expect(result.issues.length).toBeGreaterThan(0);
    expect(result.text).toBeNull();
  });

  it('a malformed dispute line after a good disclosure line is the disputer\'s (requester)', () => {
    const result = readMachineLines(`${LINE}\nverdikta-dispute: not-a-cid!`);
    expect(result.ok).toBe(false);
    expect(result.fault).toBe('requester');
    expect(result.issues.map((i) => i.code)).toEqual(['LINE_FIELD']);
  });

  it('issues never echo key material', () => {
    const result = readMachineLines(LINE.replace(FIELDS.contentKey, '0x' + '3'.repeat(31) + 'Z'));
    expect(JSON.stringify(result)).not.toContain('3'.repeat(31));
  });

  it('a non-string addendum is the claim\'s failure, not a crash', () => {
    expect(readMachineLines(undefined)).toMatchObject({ ok: false, fault: 'claim' });
  });
});
