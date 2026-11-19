// Real ZIP extraction, common parser, EA handler, AI payload construction and
// commit store. Only IPFS/provider HTTP edges are mocked; no live services.
const fs = require('fs');
const os = require('os');
const path = require('path');
const AdmZip = require('adm-zip');
const cidFor = require('../helpers/cid.cjs');

jest.mock('axios');
const axios = require('axios');
const mockPost = jest.fn();
axios.create.mockReturnValue({ post: mockPost });

const mockState = {};
jest.mock('@verdikta/common', () => {
  const actual = jest.requireActual('@verdikta/common');
  return { ...actual, createClient: cfg => {
    const client = actual.createClient({ ...cfg, logging: { level: 'error', console: false } });
    if (cfg.ipfs) {
      client.ipfsClient.fetchFromIPFS = jest.fn();
      client.ipfsClient.uploadToIPFS = jest.fn();
      mockState.fetch = client.ipfsClient.fetchFromIPFS;
      mockState.client = client;
    }
    return client;
  } };
});

const evaluate = require('../../handlers/evaluateHandler');
const commitStore = require('../../services/commitStore');
const PRIMARY = cidFor('primary'), BCID = cidFor('submission'), ATTACHMENT = cidFor('attachment');
const AI_RESULT = { scores: [{ outcome: 'DONT_FUND', score: 1000000 }, { outcome: 'FUND', score: 0 }], justification: 'test' };
const request = cids => ({ id: 'boundary-test', data: { cid: cids, aggId: '0x' + 'ab'.repeat(32) } });
const primary = () => ({ version: '1.0', primary: { filename: 'primary.json' },
  juryParameters: { NUMBER_OF_OUTCOMES: 2, ITERATIONS: 1,
    AI_NODES: [{ AI_PROVIDER: 'OpenAI', AI_MODEL: 'gpt-4o', WEIGHT: 1, NO_COUNTS: 1 }] } });

function archive(manifest, files = {}, wrapper = '') {
  const zip = new AdmZip();
  for (const [name, content] of Object.entries({
    'manifest.json': JSON.stringify(manifest),
    'primary.json': JSON.stringify({ query: 'Evaluate the supplied evidence carefully.', outcomes: ['DONT_FUND', 'FUND'], references: [] }),
    ...files
  })) zip.addFile(wrapper + name, Buffer.from(content));
  return zip.toBuffer();
}

describe('P0 evidence attacks through the real evaluation handler', () => {
  let temp, blobs, saved;
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    temp = fs.mkdtempSync(path.join(os.tmpdir(), 'boundary-markers-'));
    fs.writeFileSync(path.join(temp, 'read-marker.txt'), 'PRIVATE MARKER');
    fs.writeFileSync(path.join(temp, 'write-marker.txt'), 'ORIGINAL');
    blobs = { [PRIMARY]: archive(primary()), [ATTACHMENT]: Buffer.from('downloaded evidence') };
    for (const c of [PRIMARY, BCID, ATTACHMENT]) evaluate.fetchCache.forget(c);
    mockState.fetch.mockImplementation(async cid => {
      if (!blobs[cid]) throw new Error('Unexpected CID fetch');
      return blobs[cid];
    });
    mockState.client.ipfsClient.uploadToIPFS.mockResolvedValue(cidFor('justification'));
    mockPost.mockResolvedValue({ data: AI_RESULT });
    saved = jest.spyOn(commitStore, 'save');
  });
  afterEach(async () => {
    for (const [hash] of saved.mock.calls) await commitStore.del(hash);
    saved.mockRestore();
    console.log.mockRestore();
    fs.rmSync(temp, { recursive: true, force: true });
  });

  test.each(['primary', 'additional', 'support'])('blocks outside %s filenames before any model call or commitment', async section => {
    const manifest = primary();
    const entry = { name: 'attack', type: 'text/plain', filename: `../../${path.basename(temp)}/read-marker.txt` };
    manifest[section] = section === 'primary' ? { filename: entry.filename } : [entry];
    blobs[PRIMARY] = archive(manifest);
    const result = await evaluate(request(`1:${PRIMARY}`));
    expect(result.statusCode).toBe(500);
    expect(result.error).toContain('Unsafe evidence');
    expect(mockPost).not.toHaveBeenCalled();
    expect(saved).not.toHaveBeenCalled();
    expect(mockState.client.ipfsClient.uploadToIPFS).not.toHaveBeenCalled();
  });

  test.each(['primary', 'additional', 'support'])('blocks %s CID fragments before downloading or writing', async section => {
    const manifest = primary();
    const hash = `${ATTACHMENT}#/../../../${path.basename(temp)}/write-marker.txt`;
    manifest[section] = section === 'primary' ? { hash: { cid: hash } } : [{ name: 'attack', type: 'ipfs/cid', hash }];
    blobs[PRIMARY] = archive(manifest);
    const result = await evaluate(request(`1:${PRIMARY}`));
    expect(result.statusCode).toBe(500);
    expect(mockState.fetch.mock.calls.map(([cid]) => cid)).toEqual([PRIMARY]);
    expect(mockPost).not.toHaveBeenCalled();
    expect(saved).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(temp, 'write-marker.txt'), 'utf8')).toBe('ORIGINAL');
  });

  test.each(['../escape', '#/../../escape', '?extra=1'])('rejects an outer CID suffix %s before fetching', async suffix => {
    const result = await evaluate(request(`1:${PRIMARY}${suffix}`));
    expect(result.statusCode).toBe(500);
    expect(mockState.fetch).not.toHaveBeenCalled();
    expect(saved).not.toHaveBeenCalled();
  });

  test('mode 0 also rejects traversal without uploading a justification', async () => {
    const manifest = primary();
    manifest.primary.filename = path.join(temp, 'read-marker.txt');
    blobs[PRIMARY] = archive(manifest);
    const result = await evaluate(request(PRIMARY));
    expect(result.statusCode).toBe(500);
    expect(mockPost).not.toHaveBeenCalled();
    expect(mockState.client.ipfsClient.uploadToIPFS).not.toHaveBeenCalled();
  });

  test.each(['primary', 'bCID'])('rejects a ZIP symlink in the %s before extraction', async role => {
    const manifest = primary();
    manifest.bCIDs = { submittedWork: 'Work submitted by the hunter' };
    const zip = new AdmZip(archive(role === 'primary' ? primary() : {
      version: '1.0', name: 'submittedWork', primary: { filename: 'primary.json' }
    }));
    zip.addFile('link', Buffer.from(path.join(temp, 'read-marker.txt')));
    zip.getEntry('link').attr = (0o120777 << 16) >>> 0;
    blobs[PRIMARY] = role === 'primary' ? zip.toBuffer() : archive(manifest);
    blobs[BCID] = zip.toBuffer();
    const extract = jest.spyOn(mockState.client.archiveService, 'extractArchive');
    try {
      const result = await evaluate(request(role === 'primary' ? `1:${PRIMARY}` : `1:${PRIMARY},${BCID}`));
      expect(result.statusCode).toBe(role === 'primary' ? 500 : 200);
      expect(extract).toHaveBeenCalledTimes(role === 'primary' ? 0 : 1);
      expect(mockPost).not.toHaveBeenCalled();
      if (role === 'bCID') expect(saved.mock.calls[0][1].result.metadata.malformed_archives[0].check)
        .toBe('unsafe-evidence-reference');
    } finally {
      extract.mockRestore();
    }
  });

  test('an unsafe bCID settles as malformed without reading the outside file', async () => {
    const manifest = primary();
    manifest.bCIDs = { submittedWork: 'Work submitted by the hunter' };
    blobs[PRIMARY] = archive(manifest);
    blobs[BCID] = archive({ version: '1.0', name: 'submittedWork', primary: { filename: 'primary.json' },
      additional: [{ name: 'attack', type: 'text/plain', filename: path.join(temp, 'read-marker.txt') }] });
    const result = await evaluate(request(`1:${PRIMARY},${BCID}`));
    expect(result.statusCode).toBe(200);
    expect(mockPost).not.toHaveBeenCalled();
    expect(saved).toHaveBeenCalledTimes(1);
    const stored = saved.mock.calls[0][1];
    expect(stored.result.metadata.malformed_archives[0].check).toBe('unsafe-evidence-reference');
    expect(stored.result.justification).not.toContain('PRIVATE MARKER');
    expect(stored.result.scores.map(s => s.score)).toEqual([1000000, 0]);
  });

  test('valid nested and CID-fetched attachments survive commit and reveal', async () => {
    const manifest = primary();
    manifest.primary.filename = 'nested/query.json';
    manifest.additional = [
      { name: 'notes', type: 'text/plain', filename: 'nested/notes.txt' },
      { name: 'download', type: 'ipfs/cid', hash: ATTACHMENT }
    ];
    blobs[PRIMARY] = archive(manifest, {
      'nested/query.json': JSON.stringify({ query: 'Judge the evidence carefully.', outcomes: ['DONT_FUND', 'FUND'] }),
      'nested/notes.txt': 'nested evidence'
    }, 'wrapped/');
    const result = await evaluate(request(`1:${PRIMARY}`));
    expect(result.statusCode).toBe(200);
    const payload = mockPost.mock.calls[0][1];
    expect(payload.attachments[0]).toBe('nested evidence');
    expect(payload.attachments).toHaveLength(2);
    expect(mockState.fetch.mock.calls.map(([cid]) => cid)).toEqual([PRIMARY, ATTACHMENT]);
    const reveal = await evaluate(request(`2:${result.data.aggregatedScore[0]}`));
    expect(reveal.statusCode).toBe(200);
    expect(reveal.data.aggregatedScore).toEqual([1000000, 0]);
  });

  test('valid attachments from both party roots reach the AI payload', async () => {
    const manifest = primary();
    manifest.bCIDs = { submittedWork: 'The hunter work' };
    manifest.additional = [{ name: 'rubric', type: 'text/plain', filename: 'nested/rubric.txt' }];
    blobs[PRIMARY] = archive(manifest, { 'nested/rubric.txt': 'requester evidence' });
    blobs[BCID] = archive({ version: '1.0', name: 'submittedWork', primary: { filename: 'primary.json' },
      additional: [{ name: 'work', type: 'text/plain', filename: 'submission/work.txt' }] },
    { 'submission/work.txt': 'hunter evidence' }, 'wrapped/');
    const result = await evaluate(request(`1:${PRIMARY},${BCID}`));
    expect(result.statusCode).toBe(200);
    expect(mockPost.mock.calls[0][1].attachments).toEqual(['requester evidence', 'hunter evidence']);
  });
});
