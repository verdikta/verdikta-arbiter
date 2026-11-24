/**
 * Attachment files built at test time: PDFs with a chosen number of pages, text
 * and embedded pictures, and a Word document. Nothing binary is committed.
 *
 * The PDFs are complete PDF 1.4 files (catalog, page tree, a cross-reference
 * table with real offsets), so pdf.js reads them as it reads a hunter's file.
 */
import JSZip from 'jszip';
import sharp from 'sharp';

export interface PdfPage {
  /** A line of selectable text on the page. Omit for a page that is only a picture. */
  text?: string;
  /** A JPEG placed on the page as an image, as a screenshot or a recording frame is. */
  jpeg?: { data: Buffer; width: number; height: number };
}

const pdfString = (text: string) => text.replace(/[\\()]/g, char => `\\${char}`);

/** A PDF with these pages. */
export function buildPdf(pages: PdfPage[]): Buffer {
  const objects: Buffer[] = [];
  const add = (body: string | Buffer): number => {
    objects.push(typeof body === 'string' ? Buffer.from(body, 'latin1') : body);
    return objects.length; // object numbers start at 1
  };
  const stream = (dictionary: string, data: Buffer): Buffer =>
    Buffer.concat([
      Buffer.from(`<< ${dictionary} /Length ${data.length} >>\nstream\n`, 'latin1'),
      data,
      Buffer.from('\nendstream', 'latin1'),
    ]);

  const catalog = add('<< /Type /Catalog /Pages 2 0 R >>');
  const pageTree = add(''); // filled in once the pages have their numbers
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');

  const kids: number[] = [];
  for (const page of pages) {
    const operators: string[] = [];
    let xobjects = '';
    if (page.jpeg) {
      const image = add(
        stream(
          `/Type /XObject /Subtype /Image /Width ${page.jpeg.width} /Height ${page.jpeg.height} ` +
            '/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode',
          page.jpeg.data,
        ),
      );
      xobjects = ` /XObject << /Im1 ${image} 0 R >>`;
      operators.push('q 468 0 0 292 72 380 cm /Im1 Do Q');
    }
    if (page.text) operators.push(`BT /F1 12 Tf 72 720 Td (${pdfString(page.text)}) Tj ET`);
    const contents = add(stream('', Buffer.from(operators.join('\n'), 'latin1')));
    kids.push(
      add(
        `<< /Type /Page /Parent ${pageTree} 0 R /MediaBox [0 0 612 792] ` +
          `/Resources << /Font << /F1 ${font} 0 R >>${xobjects} >> /Contents ${contents} 0 R >>`,
      ),
    );
  }
  objects[pageTree - 1] = Buffer.from(
    `<< /Type /Pages /Kids [${kids.map(kid => `${kid} 0 R`).join(' ')}] /Count ${kids.length} >>`,
    'latin1',
  );

  const parts: Buffer[] = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  const offsets: number[] = [];
  let length = parts[0].length;
  objects.forEach((body, index) => {
    offsets.push(length);
    const object = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`, 'latin1'), body, Buffer.from('\nendobj\n', 'latin1')]);
    parts.push(object);
    length += object.length;
  });
  const xref =
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
    offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('') +
    `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${length}\n%%EOF\n`;
  parts.push(Buffer.from(xref, 'latin1'));
  return Buffer.concat(parts);
}

/** A small JPEG of one colour, standing in for a recording frame. */
export async function frameJpeg(background = '#2255aa'): Promise<{ data: Buffer; width: number; height: number }> {
  const width = 320;
  const height = 200;
  const data = await sharp({ create: { width, height, channels: 3, background } }).jpeg({ quality: 80 }).toBuffer();
  return { data, width, height };
}

/** A .docx with these paragraphs. */
export async function buildDocx(paragraphs: string[]): Promise<Buffer> {
  const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      '</Types>',
  );
  zip.file(
    '_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
      '</Relationships>',
  );
  zip.file(
    'word/document.xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
      paragraphs.map(text => `<w:p><w:r><w:t>${escape(text)}</w:t></w:r></w:p>`).join('') +
      '</w:body></w:document>',
  );
  return zip.generateAsync({ type: 'nodebuffer' });
}

export const DOCX_MEDIA_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export const dataUri = (mediaType: string, bytes: Buffer) => `data:${mediaType};base64,${bytes.toString('base64')}`;
