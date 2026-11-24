#!/usr/bin/env node
'use strict';

/**
 * Builds e2e/archives/pdf-canary/evidence.pdf, the PDF of the `pdf-canary`
 * scenario: a three-page PDF whose answer exists only as a picture.
 *
 * Page 1 and page 3 are text. Page 2 is one image, and the words in it (the
 * answer and a canary code) are pixels: they are in no text layer, so the text
 * a node extracts from the file (pdf-parse, pdftotext) holds neither. A juror
 * that is sent only the extracted text cannot name the answer or quote the
 * code; a juror that is sent the PDF itself sees the page and can. That is the
 * difference bounty 398 turned on (16 recording frames inside a PDF that no
 * juror was shown).
 *
 * The file is written without any dependency and without compression (a 1-bit
 * image, a built-in font, a plain cross-reference table), so the same bytes
 * come out on every machine and Node version, and the pinned archive's CID
 * stays the one committed. src/__tests__/pdf-canary.test.js holds the
 * committed file to this script.
 *
 * Usage:
 *   node scripts/build-pdf-canary.js            # write the file
 *   node scripts/build-pdf-canary.js --check    # exit 1 if the committed file differs
 */

const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'archives', 'pdf-canary', 'evidence.pdf');

/** What the picture says. The outcome and the code appear nowhere else in the archive. */
const ANSWER = 'VIOLET';
const CANARY_CODE = '7Q4M9X2K';
const PICTURE_LINES = [`ANSWER: ${ANSWER}`, `CANARY CODE: ${CANARY_CODE}`];

const PAGE_1_TEXT = [
  'VERDIKTA PDF CANARY',
  'This document tests whether an AI juror is shown the pages of a PDF.',
  'The answer is not written in this text. It is shown in the picture on page 2.',
];
const PAGE_3_TEXT = ['End of document. Nothing on this page names the answer.'];

// A 5 x 7 dot-matrix font: the letters, digits and punctuation the picture uses.
const FONT = {
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  C: ['01110', '10001', '10000', '10000', '10000', '10001', '01110'],
  D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  G: ['01110', '10001', '10000', '10111', '10001', '10001', '01111'],
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  I: ['01110', '00100', '00100', '00100', '00100', '00100', '01110'],
  J: ['00111', '00010', '00010', '00010', '00010', '10010', '01100'],
  K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  Q: ['01110', '10001', '10001', '10001', '10101', '10010', '01101'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
  W: ['10001', '10001', '10001', '10101', '10101', '10101', '01010'],
  X: ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
  Y: ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
  Z: ['11111', '00001', '00010', '00100', '01000', '10000', '11111'],
  0: ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  1: ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  2: ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  3: ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  4: ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  5: ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  6: ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  7: ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  8: ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  9: ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
  ':': ['00000', '00100', '00100', '00000', '00100', '00100', '00000'],
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
};

const SCALE = 8;        // each font dot is 8 x 8 pixels
const MARGIN = 48;
const LINE_GAP = 40;
const ADVANCE = 6 * SCALE; // 5 dots and one of spacing

/** The picture as a 1-bit image: black letters (0) on white (1), rows padded to whole bytes. */
function renderPicture(lines) {
  const width = MARGIN * 2 + Math.max(...lines.map((line) => line.length)) * ADVANCE - SCALE;
  const height = MARGIN * 2 + lines.length * 7 * SCALE + (lines.length - 1) * LINE_GAP;
  const rowBytes = Math.ceil(width / 8);
  const data = Buffer.alloc(rowBytes * height, 0xff);
  const setBlack = (x, y) => { data[y * rowBytes + (x >> 3)] &= ~(0x80 >> (x & 7)); };

  lines.forEach((line, lineIndex) => {
    const top = MARGIN + lineIndex * (7 * SCALE + LINE_GAP);
    [...line].forEach((char, column) => {
      const glyph = FONT[char];
      if (!glyph) throw new Error(`The picture font has no glyph for "${char}"`);
      const left = MARGIN + column * ADVANCE;
      glyph.forEach((row, dotY) => {
        [...row].forEach((dot, dotX) => {
          if (dot !== '1') return;
          for (let y = 0; y < SCALE; y++) {
            for (let x = 0; x < SCALE; x++) setBlack(left + dotX * SCALE + x, top + dotY * SCALE + y);
          }
        });
      });
    });
  });
  return { width, height, data };
}

const pdfString = (text) => text.replace(/[\\()]/g, (char) => `\\${char}`);

function textPage(lines) {
  const operators = ['BT', '/F1 13 Tf', '72 720 Td', '18 TL'];
  lines.forEach((line) => operators.push(`(${pdfString(line)}) Tj`, 'T*'));
  operators.push('ET');
  return operators.join('\n');
}

function buildPdf() {
  const picture = renderPicture(PICTURE_LINES);
  const objects = [];
  const add = (body) => { objects.push(Buffer.isBuffer(body) ? body : Buffer.from(body, 'latin1')); return objects.length; };
  const stream = (dictionary, data) => Buffer.concat([
    Buffer.from(`<< ${dictionary}/Length ${data.length} >>\nstream\n`, 'latin1'),
    data,
    Buffer.from('\nendstream', 'latin1'),
  ]);

  const catalog = add('<< /Type /Catalog /Pages 2 0 R >>');
  const pageTree = add('');
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const image = add(stream(
    `/Type /XObject /Subtype /Image /Width ${picture.width} /Height ${picture.height} ` +
      '/ColorSpace /DeviceGray /BitsPerComponent 1 ',
    picture.data,
  ));

  const page = (contents, resources) => add(
    `<< /Type /Page /Parent ${pageTree} 0 R /MediaBox [0 0 612 792] /Resources << ${resources} >> /Contents ${contents} 0 R >>`,
  );
  // The picture is drawn 468 pt wide, centred on the page, at its own proportions.
  const drawnHeight = Math.round((468 * picture.height) / picture.width);
  const kids = [
    page(add(stream('', Buffer.from(textPage(PAGE_1_TEXT), 'latin1'))), `/Font << /F1 ${font} 0 R >>`),
    page(
      add(stream('', Buffer.from(`q 468 0 0 ${drawnHeight} 72 ${Math.round((792 - drawnHeight) / 2)} cm /Im1 Do Q`, 'latin1'))),
      `/XObject << /Im1 ${image} 0 R >>`,
    ),
    page(add(stream('', Buffer.from(textPage(PAGE_3_TEXT), 'latin1'))), `/Font << /F1 ${font} 0 R >>`),
  ];
  objects[pageTree - 1] = Buffer.from(
    `<< /Type /Pages /Kids [${kids.map((kid) => `${kid} 0 R`).join(' ')}] /Count ${kids.length} >>`,
    'latin1',
  );

  const parts = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  const offsets = [];
  let length = parts[0].length;
  objects.forEach((body, index) => {
    offsets.push(length);
    const object = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`, 'latin1'), body, Buffer.from('\nendobj\n', 'latin1')]);
    parts.push(object);
    length += object.length;
  });
  parts.push(Buffer.from(
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
      offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('') +
      `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${length}\n%%EOF\n`,
    'latin1',
  ));
  return Buffer.concat(parts);
}

module.exports = { buildPdf, renderPicture, OUT, ANSWER, CANARY_CODE, PAGE_1_TEXT, PAGE_3_TEXT };

if (require.main === module) {
  const pdf = buildPdf();
  if (process.argv.includes('--check')) {
    const committed = fs.existsSync(OUT) ? fs.readFileSync(OUT) : null;
    if (!committed || !committed.equals(pdf)) {
      console.error(`${OUT} is not what this script builds. Run it without --check and commit the file.`);
      process.exit(1);
    }
    console.log(`${OUT} matches (${pdf.length} bytes).`);
  } else {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, pdf);
    console.log(`Wrote ${OUT} (${pdf.length} bytes).`);
  }
}
