const fs = require('fs');
const os = require('os');
const path = require('path');
const AdmZip = require('adm-zip');
const cidFor = require('../helpers/cid.cjs');
const {
  UnsafeEvidenceError, assertBareCID, resolveEvidenceFile, readEvidenceFile,
  assertManifestReferences, extractEvidenceArchive
} = require('../../utils/evidenceBoundary');

describe('evidence filesystem boundary', () => {
  let temp, root;
  beforeEach(() => {
    temp = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-boundary-'));
    root = path.join(temp, 'archive');
    fs.mkdirSync(root);
    fs.mkdirSync(path.join(root, 'nested'));
    fs.writeFileSync(path.join(root, 'nested', 'ok.txt'), 'safe evidence');
    fs.writeFileSync(path.join(temp, 'outside.txt'), 'outside marker');
  });
  afterEach(() => fs.rmSync(temp, { recursive: true, force: true }));

  test.each(['../outside.txt', 'nested/../../outside.txt', '/etc/passwd',
    'C:\\secrets.txt', 'C:secrets.txt', '\\\\host\\share', '..\\outside.txt',
    'nested\\..\\outside.txt', 'file.txt:stream', 'a\0b', '.', ''])('rejects unsafe path %j', filename => {
    expect(() => resolveEvidenceFile(root, filename, { allowMissing: true })).toThrow(UnsafeEvidenceError);
  });

  test('nested paths and a canonical spelling of a trusted root work', async () => {
    await expect(readEvidenceFile([root], { filename: 'nested/ok.txt' }, 'utf8')).resolves.toBe('safe evidence');
    await expect(readEvidenceFile([root], { path: fs.realpathSync(path.join(root, 'nested/ok.txt')) }, 'utf8'))
      .resolves.toBe('safe evidence');
  });

  test.each(['leaf', 'directory', 'hardlink'])('rejects a %s escape', async kind => {
    let filename;
    if (kind === 'directory') {
      fs.symlinkSync(temp, path.join(root, 'link'));
      filename = 'link/outside.txt';
    } else {
      filename = 'link';
      if (kind === 'hardlink') fs.linkSync(path.join(temp, 'outside.txt'), path.join(root, filename));
      else fs.symlinkSync(path.join(temp, 'outside.txt'), path.join(root, filename));
    }
    await expect(readEvidenceFile([root], { filename })).rejects.toBeInstanceOf(UnsafeEvidenceError);
    expect(fs.readFileSync(path.join(temp, 'outside.txt'), 'utf8')).toBe('outside marker');
  });

  test('rejects sibling-root prefix tricks and another request\'s attachments', async () => {
    const other = `${root}-other`;
    fs.mkdirSync(other);
    fs.writeFileSync(path.join(other, 'note'), 'other request');
    await expect(readEvidenceFile([root], { path: path.join(other, 'note') })).rejects.toBeInstanceOf(UnsafeEvidenceError);
    await expect(readEvidenceFile([root, other], { path: path.join(other, 'note') }, 'utf8')).resolves.toBe('other request');
  });

  test('valid CIDv0 and CIDv1 are accepted', async () => {
    const cid = cidFor('valid');
    const { CID } = await import('multiformats/cid');
    await expect(assertBareCID(cid)).resolves.toBeUndefined();
    await expect(assertBareCID(CID.parse(cid).toV1().toString())).resolves.toBeUndefined();
  });

  test.each(['#/../../outside.txt', '/../../outside.txt', '?a=1', '%2f..', ' ', '\n', 'garbage'])(
    'rejects CID suffix %j', async suffix => {
      await expect(assertBareCID(cidFor('valid') + suffix)).rejects.toBeInstanceOf(UnsafeEvidenceError);
    });

  test.each(['primary', 'additional', 'support'])('preflights %s filenames and hash references', async section => {
    const manifest = entry => ({ [section]: section === 'primary' ? entry : [entry] });
    await expect(assertManifestReferences(manifest({ filename: '../outside.txt' }), root))
      .rejects.toBeInstanceOf(UnsafeEvidenceError);
    for (const hash of [cidFor('bad') + '#/../../outside.txt', { cid: cidFor('bad') + '#/../../outside.txt' }]) {
      await expect(assertManifestReferences(manifest({ hash }), root)).rejects.toBeInstanceOf(UnsafeEvidenceError);
    }
    await expect(assertManifestReferences(manifest({ path: path.join(temp, 'outside.txt') }), root))
      .rejects.toBeInstanceOf(UnsafeEvidenceError);
  });

  test('rejects a link placed at a future CID download destination', async () => {
    const hash = cidFor('download');
    fs.symlinkSync(path.join(temp, 'outside.txt'), path.join(root, `additional_${hash}`));
    await expect(assertManifestReferences({ additional: [{ type: 'ipfs/cid', hash }] }, root))
      .rejects.toBeInstanceOf(UnsafeEvidenceError);
  });

  test.each(['../outside.txt', '/absolute.txt', '..\\outside.txt', 'symlink', 'fifo'])(
    'rejects ZIP entry %j before extraction', async name => {
      const zip = new AdmZip();
      zip.addFile('entry', Buffer.from('marker'));
      const entry = zip.getEntry('entry');
      entry.entryName = name; // bypass addFile's path sanitization
      if (name === 'symlink') entry.attr = (0o120777 << 16) >>> 0;
      if (name === 'fifo') entry.attr = (0o010600 << 16) >>> 0;
      const service = { extractArchive: jest.fn() };
      await expect(extractEvidenceArchive(service, zip.toBuffer(), 'archive.zip', root))
        .rejects.toBeInstanceOf(UnsafeEvidenceError);
      expect(service.extractArchive).not.toHaveBeenCalled();
    });
});
