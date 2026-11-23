// Health-call answers for the v2 keeper (verdikta-dispatcher ReputationKeeper.answerHealthCall /
// rotateChain): the hash chain, its file, the handler the Chainlink health job calls, and the route.
// The keeper accepts a value v only if keccak256(abi.encodePacked(v)) equals its current head, and
// then makes v the head; `keeperAnswer` below is that rule.
const fs = require('fs');
const os = require('os');
const path = require('path');
const ethers = require('ethers');
const request = require('supertest');
jest.mock('../../services/aiClient');

const { Chain, KeyChains, createChain, currentHead, defaultDir, WINDOW } = require('../../health/chainStore');
const { createHealthHandler, isHealthRequest, parseBytes32 } = require('../../health/healthHandler');
const { createApp } = require('../../app');

const KEY = '0x' + '1f'.repeat(32);
const hashOf = (v) => ethers.utils.keccak256(v);
let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'health-chains-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

/** the keeper's rule: returns the new head, or throws as BadPreimage would. A plain answer
 *  (newHead == preimage) whose value is not a preimage re-syncs: the value becomes the head. */
function keeperAnswer(head, preimage, newHead) {
  if (hashOf(preimage) !== head) {
    if (newHead !== preimage) throw new Error('BadPreimage');
    return preimage;                                           // a re-sync (ChainResynced)
  }
  return newHead;
}

describe('Chain', () => {
  it('each value hashes to the one before it, ending in the head, across checkpoint windows', () => {
    const seed = '0x' + 'ab'.repeat(32);
    const n = 2 * WINDOW + 7;
    const c = new Chain(seed, n);
    expect(c.value(n)).toBe(seed);
    expect(c.value(0)).toBe(c.head);
    for (const i of [1, 2, WINDOW - 1, WINDOW, WINDOW + 1, n - WINDOW, n - 1, n]) expect(hashOf(c.value(i))).toBe(c.value(i - 1));
    let v = seed;
    for (let i = 0; i < n; i++) v = hashOf(v);
    expect(c.head).toBe(v);
  });

  it('finds any value by index, from any hint', () => {
    const c = new Chain('0x' + 'cd'.repeat(32), 3 * WINDOW);
    for (const i of [0, 1, WINDOW, WINDOW + 3, 2 * WINDOW + 999, 3 * WINDOW]) {
      expect(c.indexOf(c.value(i))).toBe(i);
      expect(c.indexOf(c.value(i), 2 * WINDOW)).toBe(i);
      expect(c.indexOf(c.value(i).toUpperCase().replace('0X', '0x'))).toBe(i);
    }
    expect(c.indexOf('0x' + '00'.repeat(32))).toBe(-1);
  });
});

describe('chain files', () => {
  it('createChain writes a 0600 file in a 0700 directory and refuses to overwrite it', () => {
    const sub = path.join(dir, 'state');
    const head = createChain(KEY, { dir: sub, length: 50 });
    const file = path.join(sub, `${KEY}.json`);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(sub).mode & 0o777).toBe(0o700);
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(data.chains).toHaveLength(1);
    expect(new Chain(data.chains[0].seed, 50).head).toBe(head);
    expect(currentHead(KEY, { dir: sub })).toBe(head);
    expect(() => createChain(KEY, { dir: sub, length: 50 })).toThrow(/already exists/);
    expect(currentHead('0x' + '2e'.repeat(32), { dir: sub })).toBeNull();
  });

  it('refuses a file whose stored head does not match its seed', () => {
    createChain(KEY, { dir, length: 20 });
    const file = path.join(dir, `${KEY}.json`);
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    data.chains[0].head = '0x' + '00'.repeat(32);
    fs.writeFileSync(file, JSON.stringify(data));
    expect(() => new KeyChains(KEY, { dir })).toThrow(/does not match/);
  });

  it('defaults to the health-chains directory beside the adapter, or HEALTH_CHAIN_DIR', () => {
    expect(defaultDir({})).toBe(path.resolve(__dirname, '..', '..', '..', '..', 'health-chains'));
    expect(defaultDir({ HEALTH_CHAIN_DIR: '/srv/x' })).toBe('/srv/x');
  });
});

describe('healthHandler', () => {
  const ask = (h, head, id = 'job-h') => h({ id, data: { healthKey: KEY, head } });

  it('answers each call with the next value, which the keeper accepts, and never twice while in flight', async () => {
    let t = 1_000_000;
    let head = createChain(KEY, { dir, length: 5000 });
    const h = createHealthHandler({ dir, now: () => t });
    for (let call = 0; call < 5; call++) {
      const r = await ask(h, head);
      expect(r.statusCode).toBe(200);
      expect(r.data.answer).toBe(true);
      expect(r.data.newHead).toBe(r.data.preimage);           // a plain answer
      // the transaction has not landed: the next run sees the same head and must not answer again
      expect((await ask(h, head)).data).toEqual({ answer: false, reason: 'in flight' });
      head = keeperAnswer(head, r.data.preimage, r.data.newHead);
      t += 1000;
    }
  });

  it('answers again once the in-flight window has passed without the head moving (a dropped transaction)', async () => {
    let t = 0;
    const head = createChain(KEY, { dir, length: 100 });
    const h = createHealthHandler({ dir, now: () => t, inFlightMs: 20_000 });
    const first = await ask(h, head);
    t += 20_001;
    expect(await ask(h, head)).toEqual(first);
  });

  it('rotates before the chain ends: the keeper takes the new head, and answers then come from the new chain', async () => {
    let t = 0;
    let head = createChain(KEY, { dir, length: 30 });
    const h = createHealthHandler({ dir, now: () => (t += 60_000), rotateMargin: 10 });
    let rotated = null;
    for (let call = 0; call < 30; call++) {             // the second chain would rotate at call 39
      const r = await ask(h, head);
      expect(r.data.answer).toBe(true);
      if (r.data.newHead !== r.data.preimage) {
        expect(rotated).toBeNull();                            // one rotation per chain
        rotated = { call, newHead: r.data.newHead };
      }
      head = keeperAnswer(head, r.data.preimage, r.data.newHead);
    }
    expect(rotated.call).toBe(19);                             // value 20 = length - margin
    const data = JSON.parse(fs.readFileSync(path.join(dir, `${KEY}.json`), 'utf8'));
    expect(data.chains).toHaveLength(1);                       // the old chain is dropped once unused
    expect(data.chains[0].head).toBe(rotated.newHead);
  });

  it('a rotation that has not landed is sent again, with the same new head, and survives a restart', async () => {
    let t = 0;
    const head = createChain(KEY, { dir, length: 12 });
    const h1 = createHealthHandler({ dir, now: () => (t += 60_000), rotateMargin: 11 });
    const r1 = await ask(h1, head);                            // value 1 >= 12 - 11: rotate at once
    expect(r1.data.newHead).not.toBe(r1.data.preimage);
    const h2 = createHealthHandler({ dir, now: () => (t += 60_000), rotateMargin: 11 });   // a restart
    const r2 = await ask(h2, head);
    expect(r2.data).toEqual(r1.data);
    expect(keeperAnswer(head, r2.data.preimage, r2.data.newHead)).toBe(r1.data.newHead);
  });

  it('refuses malformed input', async () => {
    createChain(KEY, { dir, length: 20 });
    const h = createHealthHandler({ dir });
    expect((await h({ id: 'x', data: { healthKey: '0x12', head: '0x' + '00'.repeat(32) } })).statusCode).toBe(400);
    expect((await h({ id: 'x', data: { healthKey: KEY } })).statusCode).toBe(400);
  });

  describe('chain re-sync (the keeper adopts a mismatched plain answer as its head)', () => {
    const ZERO = '0x' + '00'.repeat(32);

    it('a head on no stored chain (registered with head 0): re-syncs onto a fresh chain, then answers from it', async () => {
      let t = 0;
      const old = createChain(KEY, { dir, length: 20 });
      const h = createHealthHandler({ dir, now: () => (t += 60_000), chainLength: 50, rotateMargin: 5 });
      const r = await ask(h, ZERO);
      expect(r.statusCode).toBe(200);
      expect(r.data).toMatchObject({ answer: true, resync: true });
      expect(r.data.newHead).toBe(r.data.preimage);           // the job's plain-answer form
      expect(r.data.preimage).not.toBe(old);                   // a fresh chain, never one already used
      let head = keeperAnswer(ZERO, r.data.preimage, r.data.newHead);
      expect(head).toBe(r.data.preimage);
      for (let call = 0; call < 3; call++) {                   // then ordinary answers from the new chain
        const a = await ask(h, head);
        expect(a.data.resync).toBeUndefined();
        head = keeperAnswer(head, a.data.preimage, a.data.newHead);
      }
      const data = JSON.parse(fs.readFileSync(path.join(dir, `${KEY}.json`), 'utf8'));
      expect(data.chains).toHaveLength(1);                     // the unused old chain is dropped
      expect(data.chains[0].head).toBe(r.data.preimage);
    });

    it('a key with no chain file (lost): creates one and re-syncs', async () => {
      const h = createHealthHandler({ dir, chainLength: 50 });
      const r = await ask(h, '0x' + 'ab'.repeat(32));
      expect(r.data).toMatchObject({ answer: true, resync: true });
      expect(currentHead(KEY, { dir })).toBe(r.data.preimage);
    });

    it('a re-sync that has not landed is sent again with the same head, also after a restart', async () => {
      let t = 0;
      createChain(KEY, { dir, length: 20 });
      const h1 = createHealthHandler({ dir, now: () => (t += 60_000), chainLength: 50 });
      const r1 = await ask(h1, ZERO);
      const h2 = createHealthHandler({ dir, now: () => (t += 60_000), chainLength: 50 });
      const r2 = await ask(h2, ZERO);
      expect(r2.data).toEqual(r1.data);
      const data = JSON.parse(fs.readFileSync(path.join(dir, `${KEY}.json`), 'utf8'));
      expect(data.chains).toHaveLength(2);                     // one fresh chain, not one per attempt
    });

    it('a used-up chain (the keeper holds its seed): re-syncs onto a fresh chain', async () => {
      createChain(KEY, { dir, length: 3 });
      const { seed } = JSON.parse(fs.readFileSync(path.join(dir, `${KEY}.json`), 'utf8')).chains[0];
      const h = createHealthHandler({ dir, chainLength: 50 });
      const r = await ask(h, seed);                            // head = the seed: nothing left to reveal
      expect(r.data).toMatchObject({ answer: true, resync: true });
      expect(r.data.preimage).not.toBe(seed);
    });
  });

  it('takes the head as 0x-hex or as a decimal (a uint256 from the job)', () => {
    const v = '0x' + '0'.repeat(62) + 'ff';
    expect(parseBytes32(v.toUpperCase().replace('0X', '0x'))).toBe(v);
    expect(parseBytes32('255')).toBe(v);
    expect(parseBytes32((1n << 256n).toString())).toBeNull();
    expect(parseBytes32('ff')).toBeNull();
  });
});

describe('the /evaluate route', () => {
  const TOKEN = process.env.EA_API_TOKEN;
  it('sends a body with data.healthKey to the health handler, behind the same service authentication', async () => {
    const evaluate = jest.fn(async () => ({ statusCode: 200, data: { evaluated: true } }));
    const health = jest.fn(async (body) => ({ statusCode: 200, data: { answer: false, key: body.data.healthKey } }));
    const app = createApp({ evaluateHandler: evaluate, healthHandler: health });
    const body = { id: 'job-h', data: { healthKey: KEY, head: '0x' + '00'.repeat(32) } };
    expect((await request(app).post('/evaluate').send(body)).status).toBe(401);
    const ok = await request(app).post('/evaluate').set('Authorization', `Bearer ${TOKEN}`).send(body);
    expect(ok.status).toBe(200);
    expect(ok.body.data).toEqual({ answer: false, key: KEY });
    expect(evaluate).not.toHaveBeenCalled();
    await request(app).post('/evaluate').set('Authorization', `Bearer ${TOKEN}`).send({ id: 'e', data: { cid: 'Qm', aggId: '0x' } });
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(isHealthRequest({ data: { cid: 'Qm' } })).toBe(false);
  });
});
