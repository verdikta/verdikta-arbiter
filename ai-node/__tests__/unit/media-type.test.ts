import { sniffMediaType, resolveMediaType } from '../../src/utils/media-type';

// Mock console to avoid cluttering test output
console.warn = jest.fn();

/** Builds a base64 payload whose leading bytes are `signature`. */
const b64 = (signature: number[], padTo = 32): string => {
  const buf = Buffer.alloc(padTo);
  Buffer.from(signature).copy(buf);
  return buf.toString('base64');
};

const PNG = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
const JPEG = [0xFF, 0xD8, 0xFF, 0xE0];
const GIF = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61];
const WEBP = [0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50];
const PDF = [0x25, 0x50, 0x44, 0x46, 0x2D];

describe('sniffMediaType', () => {
  it.each([
    ['image/png', PNG],
    ['image/jpeg', JPEG],
    ['image/gif', GIF],
    ['image/webp', WEBP],
    ['application/pdf', PDF],
  ])('detects %s from its signature', (expected, signature) => {
    expect(sniffMediaType(Buffer.from(signature))).toBe(expected);
  });

  it('returns null when no signature matches', () => {
    expect(sniffMediaType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(sniffMediaType(Buffer.from('plain text'))).toBeNull();
  });

  it('returns null for buffers too short to carry a signature', () => {
    expect(sniffMediaType(Buffer.alloc(0))).toBeNull();
    expect(sniffMediaType(Buffer.from([0xFF]))).toBeNull();
  });

  it('does not mistake a truncated RIFF header for WEBP', () => {
    // "RIFF" present but the WEBP fourcc is absent (e.g. a WAV file)
    const wav = [0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45];
    expect(sniffMediaType(Buffer.from(wav))).toBeNull();
  });
});

describe('resolveMediaType', () => {
  it('overrides a mislabelled attachment with the sniffed type', () => {
    // The exact production failure: JPEG bytes declared as image/png, which
    // Anthropic rejects with 400 invalid_request_error.
    expect(resolveMediaType('image/png', b64(JPEG))).toBe('image/jpeg');
  });

  it('warns when the declared type disagrees with the bytes', () => {
    (console.warn as jest.Mock).mockClear();
    resolveMediaType('image/png', b64(JPEG));
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('declared "image/png" but its bytes are "image/jpeg"')
    );
  });

  it('keeps the declared type when it already matches the bytes', () => {
    (console.warn as jest.Mock).mockClear();
    expect(resolveMediaType('image/png', b64(PNG))).toBe('image/png');
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('falls back to the declared type for formats with no magic number', () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64');
    expect(resolveMediaType('image/svg+xml', svg)).toBe('image/svg+xml');
    expect(resolveMediaType('text/plain', Buffer.from('hello').toString('base64'))).toBe('text/plain');
  });

  it('corrects a document mislabelled as an image, and vice versa', () => {
    expect(resolveMediaType('image/png', b64(PDF))).toBe('application/pdf');
    expect(resolveMediaType('application/pdf', b64(PNG))).toBe('image/png');
  });

  it('falls back to the declared type when there is no payload', () => {
    expect(resolveMediaType('image/png', '')).toBe('image/png');
  });

  it('sniffs base64 that is wrapped across lines', () => {
    const wrapped = b64(JPEG).replace(/(.{4})/g, '$1\n');
    expect(resolveMediaType('image/png', wrapped)).toBe('image/jpeg');
  });

  it('falls back to the declared type when the payload is not valid base64', () => {
    expect(resolveMediaType('image/png', '!!!not base64!!!')).toBe('image/png');
  });
});
