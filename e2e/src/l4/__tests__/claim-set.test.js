'use strict';

// Node A6b: the claim set L4 reads. Built by the function the L2 harness uses, held to what
// the aggregator and the EA will take before anything is sent.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const AdmZip = require('adm-zip');
const { codeReview } = require('@verdikta/common');
const Hash = require('ipfs-only-hash');
const F = require('../../l2/claim/fixtures');
const { startLocalIpfs } = require('../../l2/claim/local-ipfs');
const { loadScenarios, resolveL4Claim, adapterCid, DEFAULT_SCENARIOS } = require('../../scenario-loader');
const repo = require('../../../../code-runner/test/docker/forgeFixture');

jest.setTimeout(60000);

const IMAGE = `registry.example/vault@sha256:${'b'.repeat(64)}`;
const BASE_COMMIT = 'a'.repeat(40);
const E2E = path.join(__dirname, '..', '..', '..');
const SCRIPT = path.join(E2E, 'scripts', 'build-l4-claims.js');

let dir;
let ipfs;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-claim-set-'));
  ipfs = await startLocalIpfs({ pinKey: 'local-test-key' });
});

afterEach(async () => {
  await ipfs.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const scenarioIn = (file, claim = 'valid') => ({ id: `s-${claim}`, suite: 'l4-claim', claim, claimSet: file, modes: ['commit-reveal'], minOutcomes: 6 });

async function setFile() {
  const set = await F.makeClaimSet({ image: IMAGE, baseCommit: BASE_COMMIT, repo, put: ipfs.put });
  const file = path.join(dir, 'claim-set.json');
  fs.writeFileSync(file, JSON.stringify(F.claimSetFile(set)));
  return { set, file };
}

describe('makeClaimSet', () => {
  it('builds a listing and the three claims, each with a disclosure the listing\'s key verifies', async () => {
    const { listing, listingCid, claims } = await F.makeClaimSet({ image: IMAGE, baseCommit: BASE_COMMIT, repo, put: ipfs.put });
    expect(listingCid).toBe(await Hash.of(listing.buffer));
    expect(Object.keys(claims).sort()).toEqual(['editsSource', 'outOfScope', 'valid']);
    for (const claim of Object.values(claims)) {
      expect(claim.cid).toBe(await Hash.of(claim.buffer));
      expect(claim.requestCid).toBe(`${listingCid},${claim.cid}:${claim.addendum}`);
      const parsed = codeReview.parseAddendum(claim.addendum);
      expect(parsed.ok).toBe(true);
      expect(parsed.dispute).toBeNull();
      expect(ipfs.get(parsed.disclosure.ciphertextCid)).toBeDefined();
    }
  });

  it('the claims are what their scenarios say: only the valid one is in scope and edits no source', async () => {
    const { claims } = await F.makeClaimSet({ image: IMAGE, baseCommit: BASE_COMMIT, repo, put: ipfs.put });
    const member = (claim, name) => new AdmZip(claim.buffer).getEntry(name).getData().toString('utf8');
    expect(JSON.parse(member(claims.valid, 'finding.json')).affectedPaths).toEqual(['src/Vault.sol']);
    expect(member(claims.valid, 'poc.patch')).toContain('b/test/Exploit.t.sol');
    expect(JSON.parse(member(claims.outOfScope, 'finding.json')).affectedPaths).toEqual(['test/Vault.t.sol']);
    expect(member(claims.editsSource, 'poc.patch')).toContain('b/src/Vault.sol');
  });

  it('builds claims against a listing signed elsewhere: the disclosure key is the listing\'s', async () => {
    const elsewhere = F.makeListing({ image: IMAGE, baseCommit: BASE_COMMIT, baseline: repo.vaultBaseline(BASE_COMMIT) });
    const listing = F.readListingArchive(elsewhere.buffer);
    expect(listing.builderPublicKey).toBeNull();
    expect(listing.disclosure.recipient).toBe(elsewhere.disclosure.recipient);
    const { listingCid, claims } = await F.makeClaimSet({ repo, put: ipfs.put, listing });
    expect(listingCid).toBe(await Hash.of(elsewhere.buffer));
    expect(codeReview.parseAddendum(claims.valid.addendum).ok).toBe(true);
  });
});

describe('resolveL4Claim', () => {
  it('gives L4 the [listing, claim] pair and the line, the same request L2 sends', async () => {
    const { set, file } = await setFile();
    const kinds = { valid: 'valid', 'front-gate': 'outOfScope', 'runner-gate': 'editsSource' };
    for (const [kind, key] of Object.entries(kinds)) {
      const s = resolveL4Claim(scenarioIn(file, kind));
      expect(s.cids).toEqual([set.listingCid, set.claims[key].cid]);
      expect(s.addendum).toBe(set.claims[key].addendum);
      expect(adapterCid(s.cids, s.addendum)).toBe(set.claims[key].requestCid);
    }
  });

  it('fits the aggregator: at most 100 bytes per CID and 1,000 of addendum', async () => {
    const { file } = await setFile();
    const s = resolveL4Claim(scenarioIn(file));
    expect(s.cids.every((c) => Buffer.byteLength(c) <= 100)).toBe(true);
    expect(Buffer.byteLength(s.addendum)).toBeLessThanOrEqual(1000);
  });

  it('leaves a scenario that is not an L4 claim alone', () => {
    const plain = { id: 'p', cids: ['QmA'], addendum: '', cid: 'QmA' };
    expect(resolveL4Claim(plain)).toBe(plain);
  });

  it('refuses when the claim set is missing, and says how to build it', () => {
    expect(() => resolveL4Claim(scenarioIn(path.join(dir, 'nope.json')))).toThrow(/s-valid.*build-l4-claims/s);
  });

  it.each([
    ['not JSON', () => 'nope', /not JSON/],
    ['no entry for the claim', (v) => ({ ...v, claims: { outOfScope: v.claims.outOfScope } }), /valid/],
    ['a listing CID that is not one', (v) => ({ ...v, listingCid: 'nope' }), /listingCid/],
    ['a claim CID that is not one', (v) => ({ ...v, claims: { ...v.claims, valid: { ...v.claims.valid, cid: 'nope' } } }), /cid/],
    ['the same CID twice', (v) => ({ ...v, claims: { ...v.claims, valid: { ...v.claims.valid, cid: v.listingCid } } }), /listing/],
    ['a line common cannot parse', (v) => ({ ...v, claims: { ...v.claims, valid: { ...v.claims.valid, addendum: 'verdikta-disclosure: nope' } } }), /addendum/],
    ['a line over the aggregator\'s limit', (v) => ({ ...v, claims: { ...v.claims, valid: { ...v.claims.valid, addendum: `${v.claims.valid.addendum}\n${'x'.repeat(1000)}` } } }), /1000/]
  ])('refuses a claim set with %s, before anything is sent', async (_name, change, message) => {
    const { file } = await setFile();
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    const changed = change(value);
    fs.writeFileSync(file, typeof changed === 'string' ? changed : JSON.stringify(changed));
    expect(() => resolveL4Claim(scenarioIn(file))).toThrow(message);
  });
});

describe('the committed scenarios', () => {
  const ids = ['claim-l4-valid', 'claim-l4-front-gate', 'claim-l4-runner-gate'];

  it('name the three, each one request, each over six outcomes', () => {
    const got = loadScenarios(DEFAULT_SCENARIOS, ids, { allowL4Claim: true });
    expect(got.map((s) => s.id)).toEqual(ids);
    expect(got.map((s) => s.claim)).toEqual(['valid', 'front-gate', 'runner-gate']);
    expect(got.every((s) => s.suite === 'l4-claim' && s.minOutcomes === 6)).toBe(true);
  });

  it('read the file the build script writes by default, relative to e2e/', () => {
    const got = loadScenarios(DEFAULT_SCENARIOS, ids, { allowL4Claim: true });
    expect(got.every((s) => s.claimSet === 'archives/l4-claim/claim-set.json')).toBe(true);
    expect(fs.readFileSync(SCRIPT, 'utf8')).toContain("const DEFAULT_OUT = 'archives/l4-claim/claim-set.json';");
  });
});

/** The script, as an operator runs it, with @verdikta/common from e2e (code-runner/ need not be installed for this path). */
function runScript(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], {
      cwd: dir,
      env: { PATH: process.env.PATH, NODE_PATH: path.join(E2E, 'node_modules'), ...env }
    });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { out += c; });
    child.on('close', (code) => resolve({ code, out }));
  });
}

describe('scripts/build-l4-claims.js', () => {
  const base = ['--image', IMAGE, '--base-commit', BASE_COMMIT];

  it('--dry-run builds and checks everything and touches neither the network nor a file', async () => {
    const out = path.join(dir, 'claim-set.json');
    const r = await runScript([...base, '--out', out, '--dry-run']);
    expect(r.out).toMatch(/dry run/i);
    expect(r.code).toBe(0);
    expect(fs.existsSync(out)).toBe(false);
  });

  it('--pin needs a pinning key', async () => {
    const r = await runScript([...base, '--out', path.join(dir, 'x.json'), '--pin']);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/IPFS_PINNING_KEY/);
  });

  it('needs an image by digest and a whole commit', async () => {
    expect((await runScript(['--image', 'registry.example/vault:latest', '--base-commit', BASE_COMMIT, '--dry-run'])).code).toBe(1);
    expect((await runScript(['--image', IMAGE, '--base-commit', 'abc', '--dry-run'])).code).toBe(1);
    expect((await runScript(['--dry-run'])).code).toBe(1);
  });

  it('asks for --dry-run or --pin: it does not pin by default', async () => {
    const r = await runScript(base);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/--dry-run|--pin/);
    expect(ipfs.pins).toEqual([]);
  });

  it('--pin pins every archive and writes what L4 reads, keeping no private key', async () => {
    const out = path.join(dir, 'claim-set.json');
    const r = await runScript([...base, '--out', out, '--pin'], { IPFS_PINNING_KEY: 'local-test-key', IPFS_PINNING_SERVICE: ipfs.url });
    expect(r.out).toMatch(/CODE_REVIEW_DEV_KEYS/);
    expect(r.code).toBe(0);
    const value = JSON.parse(fs.readFileSync(out, 'utf8'));
    expect(value).toMatchObject({ version: 1, image: IMAGE, baseCommit: BASE_COMMIT });
    expect(typeof value.builderPublicKey).toBe('string');
    expect(JSON.stringify(value)).not.toMatch(/privateKey|identity|AGE-SECRET/i);
    expect(r.out).not.toMatch(/privateKey|AGE-SECRET/i);
    // The listing, three claims and three ciphertexts.
    expect(ipfs.pins).toHaveLength(7);
    for (const kind of ['valid', 'front-gate', 'runner-gate']) {
      const s = resolveL4Claim(scenarioIn(out, kind));
      expect(ipfs.get(s.cids[0])).toBeDefined();
      expect(ipfs.get(s.cids[1])).toBeDefined();
    }
  });

  it('--listing-file builds claims against a listing it did not sign', async () => {
    const listing = path.join(dir, 'listing.zip');
    const elsewhere = F.makeListing({ image: IMAGE, baseCommit: BASE_COMMIT, baseline: repo.vaultBaseline(BASE_COMMIT) });
    fs.writeFileSync(listing, elsewhere.buffer);
    const out = path.join(dir, 'claim-set.json');
    const r = await runScript(['--listing-file', listing, '--out', out, '--pin'], { IPFS_PINNING_KEY: 'local-test-key', IPFS_PINNING_SERVICE: ipfs.url });
    expect(r.code).toBe(0);
    const value = JSON.parse(fs.readFileSync(out, 'utf8'));
    expect(value.builderPublicKey).toBeNull();
    expect(value.listingCid).toBe(await Hash.of(elsewhere.buffer));
    expect(value.image).toBe(IMAGE);
    expect(value.baseCommit).toBe(BASE_COMMIT);
  });
});
