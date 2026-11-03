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

const ALL_CLAIMS = [
  'dispute', 'editsSource', 'faultCancellation', 'faultNearLimit', 'faultProviderTimeout', 'faultSlowJustifier', 'flaky',
  'outOfScope', 'randomnessDependent', 'registryControl', 'registryFailure', 'timeDependent', 'valid'
];
const COLD_IMAGE = `registry.example/vault@sha256:${'c'.repeat(64)}`;

describe('makeClaimSet', () => {
  it('builds a listing and the claims, each with a disclosure the listing\'s key verifies', async () => {
    const { listing, listingCid, claims } = await F.makeClaimSet({ image: IMAGE, baseCommit: BASE_COMMIT, repo, put: ipfs.put });
    expect(listingCid).toBe(await Hash.of(listing.buffer));
    expect(Object.keys(claims).sort()).toEqual(ALL_CLAIMS);
    for (const claim of Object.values(claims)) {
      expect(claim.cid).toBe(await Hash.of(claim.buffer));
      expect(claim.requestCid).toBe(`${claim.listingCid || listingCid},${claim.cid}:${claim.addendum}`);
      const parsed = codeReview.parseAddendum(claim.addendum);
      expect(parsed.ok).toBe(true);
      expect(parsed.dispute).toBeNull();
      expect(ipfs.get(parsed.disclosure.ciphertextCid)).toBeDefined();
    }
  });

  it('every claim is its own CID: the fault plan names exact claims', async () => {
    const { claims } = await F.makeClaimSet({ image: IMAGE, baseCommit: BASE_COMMIT, repo, put: ipfs.put });
    const cids = Object.values(claims).map((c) => c.cid);
    expect(new Set(cids).size).toBe(cids.length);
  });

  it('the fault plan names the four fault claims, and nothing else', async () => {
    const set = await F.makeClaimSet({ image: IMAGE, baseCommit: BASE_COMMIT, repo, put: ipfs.put });
    expect(F.faultPlan(set)).toBe([
      `${set.claims.faultNearLimit.cid}=near-limit-juror`,
      `${set.claims.faultProviderTimeout.cid}=provider-timeout`,
      `${set.claims.faultSlowJustifier.cid}=slow-justifier`,
      `${set.claims.faultCancellation.cid}=cancellation`
    ].join(','));
  });

  it('the determinism PoCs are the code runner\'s own (A3b\'s named fixtures), not others', async () => {
    const { claims } = await F.makeClaimSet({ image: IMAGE, baseCommit: BASE_COMMIT, repo, put: ipfs.put });
    const P = require('../../../../code-runner/test/docker/determinismPocs');
    const member = (claim, name) => new AdmZip(claim.buffer).getEntry(name).getData().toString('utf8');
    const lines = (text) => text.split('\n').filter(Boolean);
    const added = (claim) => member(claim, 'poc.patch').split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).map((l) => l.slice(1));
    for (const [claim, poc] of [[claims.timeDependent, P.TIME_POC], [claims.randomnessDependent, P.RANDOM_POC], [claims.flaky, P.FLAKY_POC]]) {
      expect(added(claim)).toEqual(expect.arrayContaining(lines(poc)));
    }
  });

  it('a registry failure: a signed listing on a digest no registry holds, in the same repository, with its control', async () => {
    const { listingCid, claims, registryFailure } = await F.makeClaimSet({ image: IMAGE, baseCommit: BASE_COMMIT, repo, put: ipfs.put });
    expect(registryFailure.spec.env.image).toMatch(/^registry\.example\/vault@sha256:[0-9a-f]{64}$/);
    expect(registryFailure.spec.env.image).not.toBe(IMAGE);
    expect(claims.registryFailure.listingCid).not.toBe(listingCid);
    expect(claims.registryControl.listingCid).toBe(claims.registryFailure.listingCid);
    expect(JSON.parse(new AdmZip(claims.registryControl.buffer).getEntry('finding.json').getData().toString('utf8')).affectedPaths).toEqual(['test/Vault.t.sol']);
  });

  it('the listings of one set share one builder key: the canaries trust one', async () => {
    const set = await F.makeClaimSet({ image: IMAGE, baseCommit: BASE_COMMIT, coldImage: COLD_IMAGE, repo, put: ipfs.put });
    expect(set.registryFailure.builderPublicKey).toBe(set.listing.builderPublicKey);
    expect(set.coldListing.builderPublicKey).toBe(set.listing.builderPublicKey);
  });

  it('a cold-cache claim only when a fresh image is named, on a listing of that image', async () => {
    const without = await F.makeClaimSet({ image: IMAGE, baseCommit: BASE_COMMIT, repo, put: ipfs.put });
    expect(without.claims.coldCache).toBeUndefined();
    const set = await F.makeClaimSet({ image: IMAGE, baseCommit: BASE_COMMIT, coldImage: COLD_IMAGE, repo, put: ipfs.put });
    expect(set.coldListing.spec.env.image).toBe(COLD_IMAGE);
    expect(set.claims.coldCache.listingCid).not.toBe(set.listingCid);
  });

  it('a dispute: the claim\'s disclosure line, then the statement by CID, as ClaimLogic.dispute composes it', async () => {
    const { claims } = await F.makeClaimSet({ image: IMAGE, baseCommit: BASE_COMMIT, repo, put: ipfs.put });
    const { dispute } = claims;
    expect(dispute.disputeAddendum).toBe(`${dispute.addendum}\nverdikta-dispute: ${dispute.statementCid}`);
    const parsed = codeReview.parseAddendum(dispute.disputeAddendum);
    expect(parsed.ok).toBe(true);
    expect(parsed.dispute.statementCid).toBe(dispute.statementCid);
    expect(Buffer.byteLength(dispute.disputeAddendum)).toBeLessThanOrEqual(1000);
    expect(Buffer.byteLength(ipfs.get(dispute.statementCid))).toBeLessThanOrEqual(codeReview.MAX_DISPUTE_STATEMENT_BYTES);
  });

  it('the dispute round goes to the listing\'s dispute archive: the same members, common\'s dispute panel', async () => {
    const { listing, claims } = await F.makeClaimSet({ image: IMAGE, baseCommit: BASE_COMMIT, repo, put: ipfs.put });
    const read = (buffer) => Object.fromEntries(new AdmZip(buffer).getEntries().map((e) => [e.entryName, e.getData().toString('utf8')]));
    const a = read(listing.buffer);
    const b = read(ipfs.get(claims.dispute.disputeListingCid));
    expect(Object.keys(b).sort()).toEqual(Object.keys(a).sort());
    for (const name of Object.keys(a)) if (name !== 'manifest.json') expect(b[name]).toBe(a[name]);
    expect(JSON.parse(a['manifest.json']).juryParameters).toEqual(JSON.parse(JSON.stringify(codeReview.CODE_STANDARD_PANEL)));
    expect(JSON.parse(b['manifest.json']).juryParameters).toEqual(JSON.parse(JSON.stringify(codeReview.CODE_STANDARD_DISPUTE_PANEL)));
    const { juryParameters, ...restA } = JSON.parse(a['manifest.json']);
    const { juryParameters: _other, ...restB } = JSON.parse(b['manifest.json']);
    expect(juryParameters).toBeDefined();
    expect(restB).toEqual(restA);
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
    const kinds = {
      valid: 'valid', 'front-gate': 'outOfScope', 'runner-gate': 'editsSource', 'time-dependent': 'timeDependent', 'randomness-dependent': 'randomnessDependent',
      flaky: 'flaky', 'near-limit-juror': 'faultNearLimit', 'provider-timeout': 'faultProviderTimeout', 'slow-justifier': 'faultSlowJustifier',
      cancellation: 'faultCancellation', dispute: 'dispute', 'registry-failure': 'registryFailure'
    };
    for (const [kind, key] of Object.entries(kinds)) {
      const s = resolveL4Claim(scenarioIn(file, kind));
      expect(s.cids).toEqual([set.claims[key].listingCid || set.listingCid, set.claims[key].cid]);
      expect(s.addendum).toBe(set.claims[key].addendum);
      expect(adapterCid(s.cids, s.addendum)).toBe(set.claims[key].requestCid);
    }
  });

  it('an abstention scenario carries its control: an out-of-scope claim on the same listing', async () => {
    const { set, file } = await setFile();
    const registry = resolveL4Claim(scenarioIn(file, 'registry-failure'));
    expect(registry.control.cids).toEqual([set.claims.registryControl.listingCid, set.claims.registryControl.cid]);
    expect(registry.control.addendum).toBe(set.claims.registryControl.addendum);
    const cancel = resolveL4Claim(scenarioIn(file, 'cancellation'));
    expect(cancel.control.cids).toEqual([set.listingCid, set.claims.outOfScope.cid]);
    expect(resolveL4Claim(scenarioIn(file, 'valid')).control).toBeUndefined();
  });

  it('a dispute scenario carries its second round', async () => {
    const { set, file } = await setFile();
    const s = resolveL4Claim(scenarioIn(file, 'dispute'));
    expect(s.cids).toEqual([set.listingCid, set.claims.dispute.cid]);
    expect(s.disputeRound).toEqual({ cids: [set.claims.dispute.disputeListingCid, set.claims.dispute.cid], addendum: set.claims.dispute.disputeAddendum, statementCid: set.claims.dispute.statementCid });
  });

  it('a cold-cache scenario on a set with no fresh image says how to get one', async () => {
    const { file } = await setFile();
    expect(() => resolveL4Claim(scenarioIn(file, 'cold-cache'))).toThrow(/--cold-image/);
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
  const claimOf = {
    'claim-l4-valid': 'valid',
    'claim-l4-front-gate': 'front-gate',
    'claim-l4-runner-gate': 'runner-gate',
    'claim-l4-time-dependent': 'time-dependent',
    'claim-l4-randomness-dependent': 'randomness-dependent',
    'claim-l4-flaky': 'flaky',
    'claim-l4-registry-failure': 'registry-failure',
    'claim-l4-near-limit-juror': 'near-limit-juror',
    'claim-l4-provider-timeout': 'provider-timeout',
    'claim-l4-slow-justifier': 'slow-justifier',
    'claim-l4-cancellation': 'cancellation',
    'claim-l4-cold-cache': 'cold-cache',
    'claim-l4-dispute': 'dispute'
  };
  const ids = Object.keys(claimOf);

  it('name them all, each over six outcomes', () => {
    const got = loadScenarios(DEFAULT_SCENARIOS, ids, { allowL4Claim: true });
    expect(got.map((s) => s.id).sort()).toEqual([...ids].sort());
    for (const s of got) expect(s.claim).toBe(claimOf[s.id]);
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
    // The listing, 11 claims, 11 ciphertexts, the dispute archive and statement; the registry listing, 2 claims and 2 ciphertexts.
    expect(ipfs.pins).toHaveLength(30);
    expect(r.out).toContain(`VERDIKTA_CANARY_FAULTS=${value.faultPlan}`);
    expect(value.faultPlan.split(',')).toHaveLength(4);
    for (const kind of ['valid', 'front-gate', 'runner-gate', 'flaky', 'registry-failure', 'dispute']) {
      const s = resolveL4Claim(scenarioIn(out, kind));
      expect(ipfs.get(s.cids[0])).toBeDefined();
      expect(ipfs.get(s.cids[1])).toBeDefined();
    }
  });

  it('--cold-image adds the cold-cache listing and claim', async () => {
    const out = path.join(dir, 'claim-set.json');
    const r = await runScript([...base, '--cold-image', COLD_IMAGE, '--out', out, '--pin'], { IPFS_PINNING_KEY: 'local-test-key', IPFS_PINNING_SERVICE: ipfs.url });
    expect(r.code).toBe(0);
    expect(ipfs.pins).toHaveLength(33);
    const s = resolveL4Claim(scenarioIn(out, 'cold-cache'));
    expect(ipfs.get(s.cids[0])).toBeDefined();
    expect(JSON.parse(fs.readFileSync(out, 'utf8')).claims.coldCache.image).toBe(COLD_IMAGE);
  });

  it('--cold-image needs an image by digest', async () => {
    const r = await runScript([...base, '--cold-image', 'registry.example/vault:latest', '--dry-run']);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/--cold-image/);
  });

  it('--listing-file: no listing can be signed here, so what needs its own comes in by file too', async () => {
    const listing = path.join(dir, 'listing.zip');
    const registry = path.join(dir, 'registry.zip');
    const cold = path.join(dir, 'cold.zip');
    const fixture = (image) => F.makeListing({ image, baseCommit: BASE_COMMIT, baseline: repo.vaultBaseline(BASE_COMMIT) }).buffer;
    fs.writeFileSync(listing, fixture(IMAGE));
    fs.writeFileSync(registry, fixture(`registry.example/vault@sha256:${'d'.repeat(64)}`));
    fs.writeFileSync(cold, fixture(COLD_IMAGE));
    const out = path.join(dir, 'claim-set.json');
    const r = await runScript(['--listing-file', listing, '--registry-failure-listing-file', registry, '--cold-listing-file', cold, '--out', out, '--pin'], { IPFS_PINNING_KEY: 'local-test-key', IPFS_PINNING_SERVICE: ipfs.url });
    expect(r.code).toBe(0);
    const value = JSON.parse(fs.readFileSync(out, 'utf8'));
    expect(value.claims.registryFailure.listingCid).toBe(await Hash.of(fs.readFileSync(registry)));
    expect(value.claims.coldCache.listingCid).toBe(await Hash.of(fs.readFileSync(cold)));
    // Without them those scenarios say what is missing, and the rest still run.
    const plain = path.join(dir, 'plain.json');
    expect((await runScript(['--listing-file', listing, '--out', plain, '--pin'], { IPFS_PINNING_KEY: 'local-test-key', IPFS_PINNING_SERVICE: ipfs.url })).code).toBe(0);
    expect(() => resolveL4Claim(scenarioIn(plain, 'registry-failure'))).toThrow(/--registry-failure-listing-file/);
    expect(resolveL4Claim(scenarioIn(plain, 'valid')).cids).toHaveLength(2);
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
