'use strict';

/**
 * The pdf-canary scenario's archive: the committed PDF is what its script builds, and
 * the answer is in no text a node could extract from it.
 */

const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const { loadScenarios, DEFAULT_SCENARIOS } = require('../scenario-loader');
const { buildPdf, renderPicture, OUT, ANSWER, CANARY_CODE, PAGE_1_TEXT, PAGE_3_TEXT } = require('../../scripts/build-pdf-canary');

const E2E = path.join(__dirname, '..', '..');
const ARCHIVE = path.join(E2E, 'archives', 'pdf-canary');
const scenario = () => JSON.parse(fs.readFileSync(DEFAULT_SCENARIOS, 'utf8')).find((s) => s.id === 'pdf-canary');

describe('the pdf-canary archive', () => {
  const committed = fs.readFileSync(OUT);

  it('holds the PDF its script builds, byte for byte, so the pinned CID can be rebuilt', () => {
    expect(OUT).toBe(path.join(ARCHIVE, 'evidence.pdf'));
    expect(buildPdf().equals(committed)).toBe(true);
    // Twice in one process: nothing in the build depends on time or order.
    expect(buildPdf().equals(buildPdf())).toBe(true);
  });

  it('is a three-page PDF with a plain cross-reference table whose offsets are right', () => {
    const text = committed.toString('latin1');
    expect(text.startsWith('%PDF-1.4\n')).toBe(true);
    expect(text).toMatch(/\/Type \/Pages \/Kids \[\d+ 0 R \d+ 0 R \d+ 0 R\] \/Count 3 /);
    const xref = Number(/startxref\n(\d+)\n%%EOF\n$/.exec(text)[1]);
    const lines = text.slice(xref).split('\n');
    expect(lines[0]).toBe('xref');
    const count = Number(lines[1].split(' ')[1]);
    for (let object = 1; object < count; object++) {
      const offset = Number(lines[2 + object].slice(0, 10));
      expect(text.slice(offset, offset + `${object} 0 obj\n`.length)).toBe(`${object} 0 obj\n`);
    }
  });

  it('says the answer and the code only in the picture: no byte of the file spells either', () => {
    // Nothing in the file is compressed, so a text layer (or metadata) naming them would show here.
    const text = committed.toString('latin1');
    expect(text).not.toContain(ANSWER);
    expect(text).not.toContain(CANARY_CODE);
    for (const colour of ['AMBER', 'COBALT', 'VIOLET']) expect(text).not.toContain(colour);
    // The text pages are there, and say where the answer is.
    for (const line of [...PAGE_1_TEXT, ...PAGE_3_TEXT]) expect(text).toContain(`(${line}) Tj`);
    expect(PAGE_1_TEXT.join(' ')).toContain('It is shown in the picture on page 2.');
  });

  it('draws the picture as a 1-bit image with dark letters on white', () => {
    const picture = renderPicture([`ANSWER: ${ANSWER}`, `CANARY CODE: ${CANARY_CODE}`]);
    expect(committed.toString('latin1')).toContain(
      `/Subtype /Image /Width ${picture.width} /Height ${picture.height} /ColorSpace /DeviceGray /BitsPerComponent 1 `
    );
    expect(picture.data.length).toBe(Math.ceil(picture.width / 8) * picture.height);
    const black = picture.data.reduce((sum, byte) => sum + (8 - byte.toString(2).replace(/0/g, '').length), 0);
    const share = black / (picture.width * picture.height);
    expect(share).toBeGreaterThan(0.05);
    expect(share).toBeLessThan(0.4);
    // The top margin is white.
    expect(picture.data.subarray(0, Math.ceil(picture.width / 8) * 8).every((byte) => byte === 0xff)).toBe(true);
  });

  it('names the PDF in its manifest, the outcome in its scenario, and the jury of bounty 398', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(ARCHIVE, 'manifest.json'), 'utf8'));
    const query = JSON.parse(fs.readFileSync(path.join(ARCHIVE, 'primary_query.json'), 'utf8'));

    expect(manifest.additional).toEqual([expect.objectContaining({ name: 'evidence', type: 'application/pdf', filename: 'evidence.pdf' })]);
    expect(query.references).toEqual(['evidence']);
    expect(manifest.juryParameters.AI_NODES.map((node) => `${node.AI_PROVIDER}/${node.AI_MODEL}`)).toEqual([
      'OpenAI/gpt-5.6-terra', 'Anthropic/claude-sonnet-5',
    ]);
    expect(manifest.juryParameters.NUMBER_OF_OUTCOMES).toBe(query.outcomes.length);
    expect(query.outcomes[scenario().expectedWinnerIndex]).toBe(ANSWER);
    expect(query.outcomes[0]).toBe('CANNOT_SEE');
    // The query does not give the answer away either.
    expect(query.query).not.toContain(CANARY_CODE);
    expect(fs.readdirSync(ARCHIVE).sort()).toEqual(['evidence.pdf', 'manifest.json', 'primary_query.json']);
  });

  it('zips to the same bytes every time (what build-archive pins)', () => {
    const zip = () => {
      const archive = new AdmZip();
      for (const file of fs.readdirSync(ARCHIVE).sort()) archive.addFile(file, fs.readFileSync(path.join(ARCHIVE, file)));
      archive.getEntries().forEach((entry) => { entry.header.time = new Date('2020-01-01T00:00:00Z'); });
      return archive.toBuffer();
    };
    expect(zip().equals(zip())).toBe(true);
  });
});

describe('the pdf-canary scenario', () => {
  it('is manual-only, asserts a winner, and holds every juror to a native PDF', () => {
    expect(scenario()).toMatchObject({
      cidFile: 'archives/pdf-canary.cid',
      manualOnly: true,
      modes: ['commit-reveal'],
      minOutcomes: 4,
      expectedWinnerIndex: 3,
      expectPdfInputs: 'native',
    });
  });

  it('is never in a full run, and L2 refuses it by name', () => {
    const full = loadScenarios(DEFAULT_SCENARIOS, null, { allowManualOnly: true, allowL4Claim: true });
    expect(full.map((s) => s.id)).not.toContain('pdf-canary');
    expect(() => loadScenarios(DEFAULT_SCENARIOS, ['pdf-canary'])).toThrow(/"pdf-canary" are manualOnly: run them with L4/);
  });

  it('runs by name on L4 once its archive is pinned, and says so until then', () => {
    const pinned = fs.existsSync(path.join(E2E, 'archives', 'pdf-canary.cid'));
    const load = () => loadScenarios(DEFAULT_SCENARIOS, ['pdf-canary'], { allowManualOnly: true });
    if (pinned) {
      expect(load()[0]).toMatchObject({ id: 'pdf-canary', expectPdfInputs: 'native' });
    } else {
      expect(load).toThrow(/Scenario "pdf-canary" has no resolvable CID \(cidFile "archives\/pdf-canary.cid" not found — pin the archive first\)/);
    }
  });

  it('expectPdfInputs can only ask for native', () => {
    const file = path.join(require('os').tmpdir(), `pdf-canary-scenarios-${process.pid}.json`);
    fs.writeFileSync(file, JSON.stringify([{ id: 'x', cid: 'QmSHXfBcrfFf4pnuRYCbHA8rjKkDh1wjqas3Rpk3a2uAWH', expectPdfInputs: 'text' }]));
    try {
      expect(() => loadScenarios(file)).toThrow(/Scenario "x": "expectPdfInputs" can only be "native"/);
    } finally {
      fs.rmSync(file, { force: true });
    }
  });
});
