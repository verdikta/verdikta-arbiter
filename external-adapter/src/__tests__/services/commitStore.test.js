// The commit store must keep a commit's salt and result across an adapter restart: a promoted slot
// that cannot be revealed is a failed reveal for the keeper (T_MISS_FAILED, then a ban on repeats).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCommitStore, defaultDir } = require('../../services/commitStore');

const H = (n) => n.toString(16).padStart(64, '0');
const quiet = { error: jest.fn() };
let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'commit-store-unit-')); quiet.error.mockClear(); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); jest.restoreAllMocks(); });

const entry = (extra = {}) => ({
  result: { scores: [{ outcome: 'A', score: 600000 }], justification: 'j' },
  salt: '1234567890abcdef1234567890abcdef', expiresAt: Date.now() + 60_000, created: new Date().toISOString(),
  scope: { jobId: 'job', aggId: '0x' + '0'.repeat(63) + '5', operator: '0x' + '11'.repeat(20) }, ...extra,
});

test('a record saved before a restart is served after it (one 0600 file per commit, dir 0700)', async () => {
  const a = createCommitStore({ dir, logger: quiet });
  const e1 = entry();
  await a.save(H(1), e1);
  await a.save(H(2), entry({ justificationCid: 'QmX' }));
  const files = fs.readdirSync(dir).sort();
  expect(files).toEqual([`${H(1)}.json`, `${H(2)}.json`]);
  expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
  for (const f of files) expect(fs.statSync(path.join(dir, f)).mode & 0o777).toBe(0o600);

  const b = createCommitStore({ dir, logger: quiet });          // the restarted adapter
  expect(await b.init()).toBe(2);
  expect(await b.get(H(1))).toEqual(e1);
  expect((await b.get(H(2))).justificationCid).toBe('QmX');
});

test('a crash mid-write leaves no torn record: the old one or nothing, and the temp file is cleaned up', async () => {
  const a = createCommitStore({ dir, logger: quiet });
  await a.save(H(1), entry({ salt: 'a'.repeat(32) }));
  // a write that dies between writing its temp file and the rename
  const rename = jest.spyOn(fs.promises, 'rename').mockRejectedValueOnce(Object.assign(new Error('crash'), { code: 'EIO' }));
  await expect(a.save(H(1), entry({ salt: 'b'.repeat(32) }))).rejects.toThrow('crash');
  await expect(a.save(H(3), entry())).resolves.toBeUndefined();      // the next write works
  rename.mockRestore();
  expect((await a.get(H(1))).salt).toBe('a'.repeat(32));            // memory still matches the disk
  // a process killed after the temp write: a half-written temp file is left behind
  fs.writeFileSync(path.join(dir, `${H(4)}.123.abcdef.tmp`), '{"salt":"cc');
  const b = createCommitStore({ dir, logger: quiet });
  expect(await b.init()).toBe(2);
  expect((await b.get(H(1))).salt).toBe('a'.repeat(32));
  expect(await b.get(H(4))).toBeUndefined();
  expect(fs.readdirSync(dir).filter(f => f.endsWith('.tmp'))).toEqual([]);
});

test('an unreadable record is skipped without quoting it', async () => {
  fs.writeFileSync(path.join(dir, `${H(5)}.json`), '{"salt":"secret');
  const s = createCommitStore({ dir, logger: quiet });
  expect(await s.init()).toBe(0);
  expect(quiet.error).toHaveBeenCalledTimes(1);
  expect(quiet.error.mock.calls[0][0]).not.toContain('secret');
});

test('expiry removes the record from memory and disk, also after a restart; live ones stay', async () => {
  const a = createCommitStore({ dir, logger: quiet });
  await a.save(H(1), entry({ expiresAt: Date.now() - 1 }));
  await a.save(H(2), entry());
  await a.save(H(3), entry({ expiresAt: undefined, created: new Date(Date.now() - 4 * 86400_000).toISOString() }));
  const b = createCommitStore({ dir, logger: quiet });
  expect(await b.purgeStale()).toBe(2);
  expect(await b.get(H(1))).toBeUndefined();
  expect(await b.get(H(3))).toBeUndefined();
  expect(await b.get(H(2))).toBeDefined();
  expect(fs.readdirSync(dir)).toEqual([`${H(2)}.json`]);
});

test('a commit lives at least 2 days (the handler sets 3): longer than a one-day deadline plus the reveal window', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'handlers', 'evaluateHandler.js'), 'utf8');
  const ttl = eval(/const COMMIT_TTL_MS = ([^;]+);/.exec(src)[1]);   // eslint-disable-line no-eval
  expect(ttl).toBeGreaterThanOrEqual(2 * 86400_000);
});

test('concurrent saves, reads and deletes are serialized and all reach the disk', async () => {
  const a = createCommitStore({ dir, logger: quiet });
  await Promise.all(Array.from({ length: 50 }, (_, i) => a.save(H(i + 1), entry({ salt: String(i).padStart(32, '0') }))));
  await Promise.all([
    ...Array.from({ length: 25 }, (_, i) => a.del(H(i + 1))),
    ...Array.from({ length: 25 }, (_, i) => a.save(H(i + 26), entry({ justificationCid: `Qm${i}` }))),
  ]);
  const b = createCommitStore({ dir, logger: quiet });
  expect(await b.init()).toBe(25);
  for (let i = 0; i < 25; i++) expect(await b.get(H(i + 1))).toBeUndefined();
  for (let i = 0; i < 25; i++) expect((await b.get(H(i + 26))).justificationCid).toBe(`Qm${i}`);
  expect(fs.readdirSync(dir).filter(f => f.endsWith('.tmp'))).toEqual([]);
});

test('rejects keys that are not commitments (no path tricks), and reading one is just a miss', async () => {
  const a = createCommitStore({ dir, logger: quiet });
  await expect(a.save('../x', entry())).rejects.toThrow('bad key');
  expect(await a.get('../x')).toBeUndefined();
  expect(fs.readdirSync(dir)).toEqual([]);
});

test('location: COMMIT_STORE_DIR, else <install>/commit-store beside external-adapter/', () => {
  expect(defaultDir({ COMMIT_STORE_DIR: ' /var/x ' })).toBe('/var/x');
  expect(defaultDir({})).toBe(path.resolve(__dirname, '..', '..', '..', '..', 'commit-store'));
});
