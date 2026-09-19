// Unit tests for the submitted-work (bCID) archive classifier.
// No network: fixtures are extracted with the real @verdikta/common archive
// service and checked with its real validator, so what the classifier accepts
// is exactly what manifestParser.parse() accepts.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createClient, validator } = require('@verdikta/common');
const {
  CHECKS,
  MalformedArchiveError,
  isMalformedArchiveError,
  classifyEvaluationError,
  assertArchiveIsZip,
  validateBCIDArchive,
  fetchAndTriageArchives,
  buildMalformedSubmissionVerdict,
  FULL_SCORE
} = require('../../utils/bcidValidation');

const FIXTURES = path.join(__dirname, '..', 'integration', 'fixtures', 'bcid');
const fixture = (name) => fs.readFileSync(path.join(FIXTURES, name));

const { archiveService } = createClient({ logging: { level: 'error' } });
const quietLogger = { info() {}, warn() {}, error() {}, debug() {} };

describe('bcidValidation', () => {
  let tempDir;
  beforeEach(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bcid-test-'));
  });
  afterEach(async () => {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  async function extract(zipName) {
    return archiveService.extractArchive(fixture(zipName), `${zipName}`, tempDir);
  }

  describe('assertArchiveIsZip', () => {
    it('accepts a real ZIP', async () => {
      await expect(assertArchiveIsZip(fixture('bcid-conforming.zip'), { cid: 'c' })).resolves.toBeUndefined();
    });

    it('rejects the bounty-57 shape (markdown pinned as the archive) as deterministic', async () => {
      const err = await assertArchiveIsZip(fixture('bcid-not-a-zip.zip'), { cid: 'c57', expectedName: 'submittedWork' })
        .catch(e => e);
      expect(err).toBeInstanceOf(MalformedArchiveError);
      expect(err.check).toBe(CHECKS.NOT_A_ZIP);
      expect(err.archiveRole).toBe('bCID');
      expect(err.cid).toBe('c57');
      expect(classifyEvaluationError(err)).toBe('deterministic');
    });

    it('rejects an empty body', async () => {
      const err = await assertArchiveIsZip(Buffer.alloc(0), { cid: 'c' }).catch(e => e);
      expect(err.check).toBe(CHECKS.NOT_A_ZIP);
    });
  });

  describe('validateBCIDArchive', () => {
    it('accepts the conforming shape the bounty API builds', async () => {
      const extracted = await extract('bcid-conforming.zip');
      const { manifest } = await validateBCIDArchive(extracted, { cid: 'c', expectedName: 'submittedWork', validator });
      expect(manifest.primary.filename).toBe('primary_query.json');
    });

    it('bounty 59: primary.filename pointing at markdown → primary-not-json', async () => {
      const extracted = await extract('bcid-primary-not-json.zip');
      const err = await validateBCIDArchive(extracted, { cid: 'c59', expectedName: 'submittedWork', validator }).catch(e => e);
      expect(err).toBeInstanceOf(MalformedArchiveError);
      expect(err.check).toBe(CHECKS.PRIMARY_NOT_JSON);
      expect(err.reason).toMatch(/submission\.md.*not valid JSON/);
      expect(err.manifest).toEqual({ version: '1.0', name: 'submittedWork', primary: { filename: 'submission.md' } });
    });

    it('bounty 58: manifest with "files" but no "primary" → manifest-primary-missing', async () => {
      const extracted = await extract('bcid-no-primary.zip');
      const err = await validateBCIDArchive(extracted, { cid: 'c58', expectedName: 'submittedWork', validator }).catch(e => e);
      expect(err.check).toBe(CHECKS.PRIMARY_MISSING);
      expect(err.manifest.files).toHaveLength(1);
    });

    it('missing manifest.json → manifest-missing', async () => {
      const dir = path.join(tempDir, 'nomanifest');
      await fs.promises.mkdir(dir);
      await fs.promises.writeFile(path.join(dir, 'submission.md'), '# work');
      const err = await validateBCIDArchive(dir, { cid: 'c', validator }).catch(e => e);
      expect(err.check).toBe(CHECKS.MANIFEST_MISSING);
      expect(err.manifest).toBeNull();
    });

    it('manifest.json that is not JSON → manifest-not-json', async () => {
      const dir = path.join(tempDir, 'badjson');
      await fs.promises.mkdir(dir);
      await fs.promises.writeFile(path.join(dir, 'manifest.json'), '{ "version": "1.0", ');
      const err = await validateBCIDArchive(dir, { cid: 'c', validator }).catch(e => e);
      expect(err.check).toBe(CHECKS.MANIFEST_NOT_JSON);
    });

    it('primary.filename naming a file that is not in the archive → primary-file-missing', async () => {
      const dir = path.join(tempDir, 'nofile');
      await fs.promises.mkdir(dir);
      await fs.promises.writeFile(path.join(dir, 'manifest.json'),
        JSON.stringify({ version: '1.0', name: 'submittedWork', primary: { filename: 'primary_query.json' } }));
      const err = await validateBCIDArchive(dir, { cid: 'c', expectedName: 'submittedWork', validator }).catch(e => e);
      expect(err.check).toBe(CHECKS.PRIMARY_FILE_MISSING);
    });

    it('manifest failing the library schema (no version) → manifest-schema', async () => {
      const dir = path.join(tempDir, 'noversion');
      await fs.promises.mkdir(dir);
      await fs.promises.writeFile(path.join(dir, 'manifest.json'),
        JSON.stringify({ name: 'submittedWork', primary: { filename: 'p.json' } }));
      await fs.promises.writeFile(path.join(dir, 'p.json'), JSON.stringify({ query: 'a query long enough' }));
      const err = await validateBCIDArchive(dir, { cid: 'c', validator }).catch(e => e);
      expect(err.check).toBe(CHECKS.MANIFEST_SCHEMA);
      expect(err.reason).toMatch(/version/);
    });

    it('primary JSON without a query → primary-schema', async () => {
      const dir = path.join(tempDir, 'noquery');
      await fs.promises.mkdir(dir);
      await fs.promises.writeFile(path.join(dir, 'manifest.json'),
        JSON.stringify({ version: '1.0', name: 'submittedWork', primary: { filename: 'p.json' } }));
      await fs.promises.writeFile(path.join(dir, 'p.json'), JSON.stringify({ text: 'no query here' }));
      const err = await validateBCIDArchive(dir, { cid: 'c', validator }).catch(e => e);
      expect(err.check).toBe(CHECKS.PRIMARY_SCHEMA);
      expect(err.reason).toMatch(/query/);
    });

    it('bCID name that contradicts the primary manifest → bcid-name-mismatch', async () => {
      const extracted = await extract('bcid-conforming.zip');
      const err = await validateBCIDArchive(extracted, { cid: 'c', expectedName: 'defendantRebuttal', validator }).catch(e => e);
      expect(err.check).toBe(CHECKS.NAME_MISMATCH);
      expect(err.reason).toMatch(/"submittedWork".*"defendantRebuttal"/);
    });

    it('a bCID without a name is accepted for any slot (the library only checks names that are present)', async () => {
      const dir = path.join(tempDir, 'noname');
      await fs.promises.mkdir(dir);
      await fs.promises.writeFile(path.join(dir, 'manifest.json'),
        JSON.stringify({ version: '1.0', primary: { filename: 'p.json' } }));
      await fs.promises.writeFile(path.join(dir, 'p.json'), JSON.stringify({ query: 'a query long enough' }));
      await expect(validateBCIDArchive(dir, { cid: 'c', expectedName: 'submittedWork', validator })).resolves.toBeTruthy();
    });
  });

  describe('classifyEvaluationError — only content problems are deterministic', () => {
    const transientErrors = [
      ['IPFS fetch failure (archiveService wrapper)', new Error('Unable to fetch archive from IPFS.')],
      ['gateway 429', Object.assign(new Error('Request failed with status code 429'), { response: { status: 429 } })],
      ['gateway 504', Object.assign(new Error('Request failed with status code 504'), { response: { status: 504 } })],
      ['socket timeout', Object.assign(new Error('timeout of 30000ms exceeded'), { code: 'ECONNABORTED' })],
      ['AI provider error', new Error('PROVIDER_ERROR: Model not available')],
      ['disk', Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })],
      ['unknown', new Error('something else entirely')],
      ['not an error', undefined]
    ];
    it.each(transientErrors)('%s → transient', (_label, err) => {
      expect(classifyEvaluationError(err)).toBe('transient');
      expect(isMalformedArchiveError(err)).toBe(false);
    });

    it('MalformedArchiveError → deterministic', () => {
      const err = new MalformedArchiveError({ cid: 'c', check: CHECKS.PRIMARY_NOT_JSON, reason: 'x' });
      expect(classifyEvaluationError(err)).toBe('deterministic');
    });
  });

  describe('fetchAndTriageArchives', () => {
    const P = 'QmPrimary', C = 'QmConforming', M = 'QmMalformed', N = 'QmNotZip';
    const buffers = {
      [P]: fixture('bounty-primary.zip'),
      [C]: fixture('bcid-conforming.zip'),
      [M]: fixture('bcid-primary-not-json.zip'),
      [N]: fixture('bcid-not-a-zip.zip')
    };
    const fetchingService = (overrides = {}) => ({
      getArchive: jest.fn(async (cid) => {
        if (overrides[cid]) throw overrides[cid];
        return buffers[cid];
      }),
      extractArchive: archiveService.extractArchive.bind(archiveService),
      validateManifest: archiveService.validateManifest.bind(archiveService)
    });
    const opts = (svc) => ({ archiveService: svc, validator, logger: quietLogger, runTag: '[t]' });

    it('conforming bCID: nothing malformed, both paths extracted', async () => {
      const r = await fetchAndTriageArchives([P, C], tempDir, opts(fetchingService()));
      expect(r.malformedBCIDs).toEqual([]);
      expect(fs.existsSync(path.join(r.extractedPaths[P], 'manifest.json'))).toBe(true);
      expect(fs.existsSync(path.join(r.extractedPaths[C], 'submission.md'))).toBe(true);
    });

    it('malformed bCIDs are collected with the slot name from the primary manifest', async () => {
      const r = await fetchAndTriageArchives([P, M], tempDir, opts(fetchingService()));
      expect(r.malformedBCIDs).toHaveLength(1);
      expect(r.malformedBCIDs[0].check).toBe(CHECKS.PRIMARY_NOT_JSON);
      expect(r.malformedBCIDs[0].expectedName).toBe('submittedWork');
      expect(r.malformedBCIDs[0].cid).toBe(M);
    });

    it('a non-ZIP bCID never touches the parser and is collected', async () => {
      const r = await fetchAndTriageArchives([P, N], tempDir, opts(fetchingService()));
      expect(r.malformedBCIDs.map(e => e.check)).toEqual([CHECKS.NOT_A_ZIP]);
      expect(r.extractedPaths[N]).toBeUndefined();
    });

    it('an extraction I/O error on the bCID propagates untouched and is NOT collected as malformed', async () => {
      const svc = fetchingService();
      const realExtract = svc.extractArchive;
      const disk = Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
      svc.extractArchive = jest.fn(async (data, name, dir) => {
        if (name.includes(M)) throw disk;
        return realExtract(data, name, dir);
      });
      await expect(fetchAndTriageArchives([P, M], tempDir, opts(svc))).rejects.toBe(disk);
    });

    it('an unexpected error thrown by the library validator propagates (a bug is not a verdict)', async () => {
      const svc = fetchingService();
      const boom = new TypeError('validator exploded');
      const broken = { ...validator, validateManifest: async () => { throw boom; } };
      await expect(fetchAndTriageArchives([P, C], tempDir, { ...opts(svc), validator: broken })).rejects.toBe(boom);

      const broken2 = { ...validator, validateCompleteWorkflow: async () => { throw boom; } };
      await expect(fetchAndTriageArchives([P, C], tempDir, { ...opts(svc), validator: broken2 })).rejects.toBe(boom);
    });

    it('an IPFS failure on the bCID propagates untouched (transient wins)', async () => {
      const boom = new Error('Unable to fetch archive from IPFS.');
      await expect(fetchAndTriageArchives([P, M], tempDir, opts(fetchingService({ [M]: boom }))))
        .rejects.toBe(boom);
    });

    it('a malformed PRIMARY archive is never classified: triage passes it through and the parser rejects it as a plain error', async () => {
      // bcid-primary-not-json.zip as the requester's package: valid manifest, primary file is markdown
      const r = await fetchAndTriageArchives([M, C], tempDir, opts(fetchingService()));
      expect(r.malformedBCIDs).toEqual([]);
      const { manifestParser } = createClient({ logging: { level: 'error' } });
      jest.spyOn(console, 'log').mockImplementation(() => {});
      const err = await manifestParser.parse(r.extractedPaths[M]).catch(e => e);
      console.log.mockRestore();
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toMatch(/Invalid JSON in primary file/);
      expect(isMalformedArchiveError(err)).toBe(false); // → errored path in the handler, no verdict
    });
  });

  describe('buildMalformedSubmissionVerdict', () => {
    const primaryManifest = { outcomes: ['DONT_FUND', 'FUND'], prompt: 'q' };
    const err = new MalformedArchiveError({
      cid: 'QmX', expectedName: 'submittedWork', check: CHECKS.PRIMARY_NOT_JSON,
      reason: 'primary file "submission.md" is not valid JSON: Unexpected token #',
      manifest: { version: '1.0', name: 'submittedWork', primary: { filename: 'submission.md' } }
    });

    it('puts the whole 1,000,000 on the FIRST outcome, derived from the primary manifest', () => {
      const v = buildMalformedSubmissionVerdict(primaryManifest, [err]);
      expect(v.scores).toEqual([{ outcome: 'DONT_FUND', score: FULL_SCORE }, { outcome: 'FUND', score: 0 }]);
      expect(v.scores.reduce((s, x) => s + x.score, 0)).toBe(FULL_SCORE);

      const other = buildMalformedSubmissionVerdict({ outcomes: ['Reject', 'Accept', 'Revise'] }, [err]);
      expect(other.scores.map(s => s.score)).toEqual([FULL_SCORE, 0, 0]);
      expect(other.scores[0].outcome).toBe('Reject');
    });

    it('is deterministic: identical input → identical output', () => {
      const a = buildMalformedSubmissionVerdict(primaryManifest, [err]);
      const b = buildMalformedSubmissionVerdict(primaryManifest, [err]);
      expect(a).toEqual(b);
    });

    it('justification names the failed check, the manifest found and the conforming shape', () => {
      const { justification, metadata } = buildMalformedSubmissionVerdict(primaryManifest, [err]);
      expect(justification).toContain('Verdict: DONT_FUND');
      expect(justification).toContain(CHECKS.PRIMARY_NOT_JSON);
      expect(justification).toContain('"filename":"submission.md"');
      expect(justification).toContain('"filename":"primary_query.json"');
      expect(justification).toContain('Submitted-work (bCID) archives');
      expect(metadata.verdict_source).toBe('malformed-bcid-archive');
      expect(metadata.malformed_archives[0]).toMatchObject({ cid: 'QmX', check: CHECKS.PRIMARY_NOT_JSON });
    });
  });
});
