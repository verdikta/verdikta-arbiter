// Handler-level tests for the malformed submitted-work (bCID) archive path.
//
// Only the network edges are mocked: IPFS fetch (archiveService.getArchive),
// IPFS upload (ipfsClient.uploadToIPFS) and the AI Node (aiClient). Extraction,
// validation, manifest parsing, the commit store and the commitment hash are
// the real thing, so mode 1 → mode 2 exercises the same code a live arbiter runs.

const fs = require('fs');
const path = require('path');

jest.mock('../../services/aiClient');

const mockState = {};
jest.mock('@verdikta/common', () => {
  const actual = jest.requireActual('@verdikta/common');
  return {
    ...actual,
    createClient: (cfg) => {
      const client = actual.createClient({ ...cfg, logging: { level: 'error', console: false } });
      client.archiveService.getArchive = jest.fn();
      client.ipfsClient.uploadToIPFS = jest.fn();
      mockState.client = client; // the handler creates exactly one client at load
      return client;
    }
  };
});

const evaluateHandler = require('../../handlers/evaluateHandler');
const aiClient = require('../../services/aiClient');
const commitStore = require('../../services/commitStore');
const { CHECKS } = require('../../utils/bcidValidation');

const FIXTURES = path.join(__dirname, '..', 'integration', 'fixtures', 'bcid');
const fixture = (name) => fs.readFileSync(path.join(FIXTURES, name));

// CIDs must satisfy @verdikta/common's request schema (Qm + 44 base58 chars)
const cid = (label) => 'Qm' + label.padEnd(44, 'a');
const PRIMARY = cid('BountyPrimary');
const CONFORMING = cid('Conforming');
const NOT_JSON = cid('PrimaryNotJson');   // bounty 59
const NO_PRIMARY = cid('NoPrimary');      // bounty 58
const NOT_ZIP = cid('NotZip');            // bounty 57

const ARCHIVES = {
  [PRIMARY]: 'bounty-primary.zip',
  [CONFORMING]: 'bcid-conforming.zip',
  [NOT_JSON]: 'bcid-primary-not-json.zip',
  [NO_PRIMARY]: 'bcid-no-primary.zip',
  [NOT_ZIP]: 'bcid-not-a-zip.zip'
};

const AI_RESULT = {
  scores: [{ outcome: 'DONT_FUND', score: 250000 }, { outcome: 'FUND', score: 750000 }],
  justification: 'AI panel says fund it'
};

let uploaded; // justification JSON captured at upload time (the temp dir is removed right after)

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'log').mockImplementation(() => {}); // manifestParser.parse is chatty
  uploaded = [];
  const { archiveService, ipfsClient } = mockState.client;
  archiveService.getArchive.mockImplementation(async (c) => {
    if (!ARCHIVES[c]) throw new Error('Unable to fetch archive from IPFS.');
    return fixture(ARCHIVES[c]);
  });
  ipfsClient.uploadToIPFS.mockImplementation(async (filePath) => {
    uploaded.push(JSON.parse(fs.readFileSync(filePath, 'utf8')));
    return `QmJustification${uploaded.length}`;
  });
  aiClient.evaluate.mockResolvedValue(AI_RESULT);
});

afterEach(() => {
  console.log.mockRestore();
});

const request = (cidString, id = 'job-1') => ({ id, data: { cid: cidString, aggId: '0xagg' } });

describe('evaluateHandler — malformed bCID (submitted-work) archives', () => {
  describe('mode 1 commit → mode 2 reveal', () => {
    it.each([
      ['bounty 59: primary.filename is markdown', NOT_JSON, CHECKS.PRIMARY_NOT_JSON],
      ['bounty 58: no primary in manifest', NO_PRIMARY, CHECKS.PRIMARY_MISSING],
      ['bounty 57: not a ZIP at all', NOT_ZIP, CHECKS.NOT_A_ZIP]
    ])('%s → a real commitment, then a reveal of [1000000, 0] on DONT_FUND', async (_label, bcid, check) => {
      const commit = await evaluateHandler(request(`1:${PRIMARY},${bcid}`));

      expect(commit.statusCode).toBe(200);
      expect(commit.status).toBe('success');
      expect(commit.data.justificationCid).toBe('');
      const [commitment] = commit.data.aggregatedScore;
      expect(commit.data.aggregatedScore).toHaveLength(1);
      expect(commitment).toMatch(/^[0-9]+$/);
      expect(commitment).not.toBe('0');
      expect(BigInt(commitment) > 0n).toBe(true);
      expect(aiClient.evaluate).not.toHaveBeenCalled();
      expect(uploaded).toHaveLength(0); // nothing goes to IPFS at commit time

      const hashHex = BigInt(commitment).toString(16).padStart(32, '0');
      const stored = await commitStore.get(hashHex);
      expect(stored.result.scores).toEqual([{ outcome: 'DONT_FUND', score: 1000000 }, { outcome: 'FUND', score: 0 }]);

      const reveal = await evaluateHandler(request(`2:${commitment}`, 'job-2'));
      expect(reveal.statusCode).toBe(200);
      expect(reveal.data.aggregatedScore).toEqual([1000000, 0]);
      expect(reveal.data.justificationCid).toMatch(/^QmJustification1:[0-9a-f]{20}$/);
      expect(await commitStore.get(hashHex)).toBeUndefined(); // burned after reveal

      expect(uploaded).toHaveLength(1);
      expect(uploaded[0].scores[0]).toEqual({ outcome: 'DONT_FUND', score: 1000000 });
      expect(uploaded[0].justification).toContain(check);
      expect(uploaded[0].metadata.verdict_source).toBe('malformed-bcid-archive');
      expect(uploaded[0].metadata.malformed_archives[0]).toMatchObject({ cid: bcid, check, expectedName: 'submittedWork' });
    });

    it('two arbiters (two runs) commit to the same score vector', async () => {
      const a = await evaluateHandler(request(`1:${PRIMARY},${NOT_JSON}`, 'a'));
      const b = await evaluateHandler(request(`1:${PRIMARY},${NOT_JSON}`, 'b'));
      const hex = (r) => BigInt(r.data.aggregatedScore[0]).toString(16).padStart(32, '0');
      const [sa, sb] = await Promise.all([commitStore.get(hex(a)), commitStore.get(hex(b))]);
      expect(sa.result.scores).toEqual(sb.result.scores);
      expect(sa.result.justification).toEqual(sb.result.justification);
      expect(hex(a)).not.toBe(hex(b)); // different salts, as intended
    });
  });

  describe('mode 0', () => {
    it('returns the DONT_FUND vector and a justification that names the failed check', async () => {
      const res = await evaluateHandler(request(`${PRIMARY},${NOT_JSON}`));
      expect(res.statusCode).toBe(200);
      expect(res.status).toBe('success');
      expect(res.data.aggregatedScore).toEqual([1000000, 0]);
      expect(res.data.justificationCid).toBe('QmJustification1');
      expect(aiClient.evaluate).not.toHaveBeenCalled();

      const j = uploaded[0];
      expect(j.scores).toEqual([{ outcome: 'DONT_FUND', score: 1000000 }, { outcome: 'FUND', score: 0 }]);
      expect(j.justification).toContain('Verdict: DONT_FUND');
      expect(j.justification).toContain(`Failed check: ${CHECKS.PRIMARY_NOT_JSON}`);
      expect(j.justification).toContain('"submission.md" is not valid JSON');
      expect(j.justification).toContain('"primary":{"filename":"submission.md"}');   // what it found
      expect(j.justification).toContain('"primary":{"filename":"primary_query.json"}'); // what it needs
    });

    it('with the mode prefix "0:" behaves the same', async () => {
      const res = await evaluateHandler(request(`0:${PRIMARY},${NO_PRIMARY}`));
      expect(res.data.aggregatedScore).toEqual([1000000, 0]);
      expect(uploaded[0].justification).toContain(CHECKS.PRIMARY_MISSING);
    });
  });

  describe('control: conforming submission still goes to the AI panel', () => {
    it('evaluates through aiClient with the submission attached', async () => {
      const res = await evaluateHandler(request(`${PRIMARY},${CONFORMING}`));
      expect(res.statusCode).toBe(200);
      expect(res.data.aggregatedScore).toEqual([250000, 750000]);
      expect(aiClient.evaluate).toHaveBeenCalledTimes(1);
      const [query] = aiClient.evaluate.mock.calls[0];
      expect(query.prompt).toContain('multi-model AI panel');            // bounty question
      expect(query.prompt).toContain('The work submitted by a hunter.');  // bCID description
      expect(query.prompt).toContain('Submitted work: a short note');     // bCID query
      expect(query.outcomes).toEqual(['DONT_FUND', 'FUND']);
      expect(query.additional.map(a => a.filename)).toContain('submission.md');
      expect(uploaded[0].justification).toBe('AI panel says fund it');
    });

    it('mode 1 on a conforming submission commits the AI result', async () => {
      const res = await evaluateHandler(request(`1:${PRIMARY},${CONFORMING}`));
      expect(aiClient.evaluate).toHaveBeenCalledTimes(1);
      const hex = BigInt(res.data.aggregatedScore[0]).toString(16).padStart(32, '0');
      expect((await commitStore.get(hex)).result).toEqual(AI_RESULT);
    });
  });

  describe('transient failures never become a verdict', () => {
    it.each([
      ['mode 0', ''],
      ['mode 1', '1:']
    ])('%s: IPFS fetch failure on the bCID → errored 500, no AI call, no upload, no commit', async (_label, prefix) => {
      const { archiveService } = mockState.client;
      archiveService.getArchive.mockImplementation(async (c) => {
        if (c === NOT_JSON) {
          const e = new Error('Unable to fetch archive from IPFS.');
          e.response = { status: 429 };
          throw e;
        }
        return fixture(ARCHIVES[c]);
      });

      const res = await evaluateHandler(request(`${prefix}${PRIMARY},${NOT_JSON}`));
      expect(res.statusCode).toBe(500);
      expect(res.status).toBe('errored');
      expect(res.error).toBe('Unable to fetch archive from IPFS.');
      expect(res.data.aggregatedScore).toEqual([0]);
      expect(res.data.justificationCid).toBeUndefined();
      expect(aiClient.evaluate).not.toHaveBeenCalled();
      expect(uploaded).toHaveLength(0);
    });

    it('mode 1: a disk error while extracting the bCID → errored 500, no commit, no verdict', async () => {
      const { archiveService } = mockState.client;
      const disk = Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
      const realExtract = archiveService.constructor.prototype.extractArchive;
      // the primary extracts through the real implementation; only the bCID fails
      const spy = jest.spyOn(archiveService, 'extractArchive').mockImplementation(async (data, name, dir) => {
        if (name.includes(NOT_JSON)) throw disk;
        return realExtract.call(archiveService, data, name, dir);
      });
      try {
        const res = await evaluateHandler(request(`1:${PRIMARY},${NOT_JSON}`));
        expect(res.statusCode).toBe(500);
        expect(res.status).toBe('errored');
        expect(res.error).toBe(disk.message);
        expect(res.data.aggregatedScore).toEqual([0]);
        expect(aiClient.evaluate).not.toHaveBeenCalled();
        expect(uploaded).toHaveLength(0);
      } finally {
        spy.mockRestore();
      }
    });

    it('a malformed PRIMARY archive (the requester\'s package) stays on the error path', async () => {
      const res = await evaluateHandler(request(`1:${NOT_JSON},${CONFORMING}`));
      expect(res.statusCode).toBe(500);
      expect(res.status).toBe('errored');
      expect(aiClient.evaluate).not.toHaveBeenCalled();
      expect(uploaded).toHaveLength(0);
    });

    it('a request whose bCID count contradicts the primary manifest stays on the error path even with a malformed bCID', async () => {
      const res = await evaluateHandler(request(`1:${PRIMARY},${NOT_JSON},${CONFORMING}`));
      expect(res.statusCode).toBe(500);
      expect(res.error).toMatch(/Expected 2 bCIDs/);
      expect(aiClient.evaluate).not.toHaveBeenCalled();
    });

    it('an AI provider error in mode 1 is errored (not a [0] "commitment")', async () => {
      aiClient.evaluate.mockRejectedValue(new Error('PROVIDER_ERROR: Model not available'));
      const res = await evaluateHandler(request(`1:${PRIMARY},${CONFORMING}`));
      expect(res.statusCode).toBe(500);
      expect(res.status).toBe('errored');
      expect(res.data.aggregatedScore).toEqual([0]);
      expect(res.data.justificationCid).toBeUndefined();
      expect(uploaded).toHaveLength(0);
    });
  });
});
