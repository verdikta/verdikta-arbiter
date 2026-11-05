'use strict';

// Node A9: the L4 listings under the production builder key, which nothing here can reach. Every
// production path runs to its end with a test key in a child process's builder set
// (test/helpers/production-key-preload.js); with the real set, the same files are refused.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const AdmZip = require('adm-zip');
const { codeReview } = require('@verdikta/common');
const F = require('../../l2/claim/fixtures');
const repo = require('../../../../code-runner/test/docker/forgeFixture');
const { RUNNER_VERSION } = require('../../../../code-runner/src/version');

jest.setTimeout(60000);

const E2E = path.join(__dirname, '..', '..', '..');
const PREPARE = path.join(E2E, 'scripts', 'prepare-l4-listings.js');
const BUILD = path.join(E2E, 'scripts', 'build-l4-claims.js');
const PRELOAD = path.join(E2E, 'test', 'helpers', 'production-key-preload.js');
const IMAGE = `ghcr.io/verdikta/l4-fixture@sha256:${'b'.repeat(64)}`;
const COLD_IMAGE = `ghcr.io/verdikta/l4-fixture@sha256:${'c'.repeat(64)}`;
const BASE_COMMIT = 'a'.repeat(40);
const LISTINGS = ['listing', 'registry-failure', 'cold-cache'];
/** age's documented example recipient: its private half is public, so no real listing may use it (A7a). */
const AGE_EXAMPLE = 'age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p';

const testKey = codeReview.createDevBuilderKey();
const TRUST_TEST_KEY = {
  NODE_OPTIONS: `--require "${PRELOAD}"`,
  E2E_TEST_PRODUCTION_KEY: JSON.stringify({ keyId: testKey.keyId, publicKey: testKey.publicKey })
};

let dir;
let out;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-prepare-'));
  out = path.join(dir, 'out');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function run(command, args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: dir, env: { PATH: process.env.PATH, NODE_PATH: path.join(E2E, 'node_modules'), ...env } });
    let output = '';
    child.stdout.on('data', (c) => { output += c; });
    child.stderr.on('data', (c) => { output += c; });
    child.on('close', (code) => resolve({ code, out: output }));
  });
}
const script = (file, args, env) => run(process.execPath, [file, ...args], env);
const prepare = (extra = [], env) => script(PREPARE, ['prepare', '--image', IMAGE, '--cold-image', COLD_IMAGE, '--base-commit', BASE_COMMIT, '--out', out, ...extra], env);
const attach = (env) => script(PREPARE, ['attach', '--dir', out], env);
const bytesOf = (name) => fs.readFileSync(path.join(out, name, 'signing-bytes.bin'));
const signWith = (key) => {
  const signatures = {};
  for (const name of LISTINGS) signatures[name] = crypto.sign(null, bytesOf(name), key).toString('base64');
  fs.writeFileSync(path.join(out, 'signatures.json'), JSON.stringify(signatures));
};
const zipOf = (name) => path.join(out, `${name}.zip`);
const listingArgs = () => ['--listing-file', zipOf('listing'), '--registry-failure-listing-file', zipOf('registry-failure'), '--cold-listing-file', zipOf('cold-cache')];

async function preparedAndSigned() {
  const r = await prepare();
  expect(r.code).toBe(0);
  signWith(testKey.privateKey);
}

function walk(root) {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(root, e.name)) : [path.join(root, e.name)]));
}

describe('prepare', () => {
  it('writes three production statements, each under the signing limit, and the exact bytes to sign', async () => {
    const r = await prepare();
    expect(r.code).toBe(0);
    const images = [];
    for (const name of LISTINGS) {
      const statement = JSON.parse(fs.readFileSync(path.join(out, name, 'statement.json'), 'utf8'));
      expect(statement.trust).toBe('production');
      expect(statement.signature).toBeUndefined();
      expect(statement.tools.runner).toBe(RUNNER_VERSION);
      expect(bytesOf(name).equals(codeReview.attestationSigningBytes(statement))).toBe(true);
      expect(bytesOf(name).length).toBeLessThan(4096);
      expect(r.out).toContain(`${bytesOf(name).length} bytes to sign`);
      images.push(statement.env.image);
    }
    expect(images).toEqual([IMAGE, F.absentDigest(IMAGE), COLD_IMAGE]);
  });

  it('a listing has its own disclosure key and names Verdikta\'s fixture, and no private half is written', async () => {
    expect((await prepare()).code).toBe(0);
    const specs = LISTINGS.map((name) => JSON.parse(fs.readFileSync(path.join(out, name, 'members', 'code_review.json'), 'utf8')));
    const keys = specs.map((s) => s.stake.disclosureKey);
    expect(new Set(keys).size).toBe(3);
    for (const key of keys) {
      expect(key).not.toBe(AGE_EXAMPLE);
      expect(() => codeReview.parseDisclosureKey(key)).not.toThrow();
    }
    for (const spec of specs) {
      expect(spec.repo).toBe('https://github.com/verdikta/stake-attestation-l4-fixture');
      expect(spec.artifact.chainId).toBe(31337);
    }
    for (const file of walk(out)) expect(fs.readFileSync(file, 'utf8')).not.toMatch(/AGE-SECRET|PRIVATE KEY/);
  });

  it.each([
    ['an image by tag', ['--image', 'ghcr.io/verdikta/l4-fixture:latest'], /--image/],
    ['a cold image by tag', ['--cold-image', 'ghcr.io/verdikta/l4-fixture:cold'], /--cold-image/],
    ['the same digest twice', ['--cold-image', IMAGE], /another digest/],
    ['an image an arbiter would not pull', ['--image', `registry.example/vault@sha256:${'b'.repeat(64)}`], /outside ghcr\.io\/verdikta/],
    ['a short commit', ['--base-commit', 'abc'], /--base-commit/]
  ])('refuses %s, and writes nothing', async (_label, extra, message) => {
    const r = await prepare(extra);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(message);
    expect(fs.existsSync(out)).toBe(false);
  });

  it('refuses a directory holding anything: signatures from another run could not verify', async () => {
    fs.mkdirSync(out);
    fs.writeFileSync(path.join(out, 'old'), 'x');
    const r = await prepare();
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/not empty/);
  });
});

describe('the signing script', () => {
  const writeAwsStub = () => {
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    // Signs raw bytes as the key service does under these flags (PureEdDSA), and refuses any other flags.
    const signer = path.join(dir, 'aws-stub.js');
    fs.writeFileSync(signer, `
      const crypto = require('crypto');
      const fs = require('fs');
      const a = process.argv.slice(2);
      const flag = (n) => a[a.indexOf(n) + 1];
      fs.appendFileSync(process.env.AWS_LOG, a.join(' ') + '\\n');
      if (a[0] !== 'kms' || a[1] !== 'sign' || flag('--message-type') !== 'RAW' || flag('--signing-algorithm') !== 'ED25519_SHA_512' || flag('--query') !== 'Signature' || flag('--output') !== 'text') process.exit(9);
      const message = fs.readFileSync(flag('--message').replace(/^fileb:\\/\\//, ''));
      if (message.length > 4096) process.exit(8);
      process.stdout.write(crypto.sign(null, message, process.env.SIGNING_KEY).toString('base64') + '\\n');
    `);
    fs.writeFileSync(path.join(bin, 'aws'), `#!/usr/bin/env bash\nexec "${process.execPath}" "${signer}" "$@"\n`, { mode: 0o755 });
    return bin;
  };

  it('holds no key name, and needs one', async () => {
    expect((await prepare()).code).toBe(0);
    const file = path.join(out, 'sign-in-cloudshell.sh');
    expect(fs.readFileSync(file, 'utf8')).not.toMatch(/arn:|alias\/|[0-9a-f]{8}-[0-9a-f]{4}-/);
    const r = await run('bash', [file]);
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/BUILDER_KEY/);
  });

  it('signs the bytes prepare wrote, and what it writes is what attach takes', async () => {
    expect((await prepare()).code).toBe(0);
    const bin = writeAwsStub();
    const log = path.join(dir, 'aws.log');
    const pem = testKey.privateKey.export({ type: 'pkcs8', format: 'pem' });
    const r = await spawnInOut(bin, log, pem);
    expect(r.code).toBe(0);
    const signatures = JSON.parse(fs.readFileSync(path.join(out, 'signatures.json'), 'utf8'));
    expect(Object.keys(signatures)).toEqual(LISTINGS);
    expect(fs.readFileSync(log, 'utf8').trim().split('\n')).toHaveLength(3);
    expect(fs.readFileSync(log, 'utf8')).toContain('--key-id the-key ');
    expect((await attach(TRUST_TEST_KEY)).code).toBe(0);
    for (const name of LISTINGS) expect(fs.existsSync(zipOf(name))).toBe(true);
  });

  /** The owner's command, in the directory the script writes signatures.json to. */
  function spawnInOut(bin, log, pem) {
    return new Promise((resolve) => {
      const child = spawn('bash', ['sign-in-cloudshell.sh'], {
        cwd: out,
        env: { PATH: `${bin}:${process.env.PATH}`, BUILDER_KEY: 'the-key', AWS_LOG: log, SIGNING_KEY: pem }
      });
      let output = '';
      child.stdout.on('data', (c) => { output += c; });
      child.stderr.on('data', (c) => { output += c; });
      child.on('close', (code) => resolve({ code, out: output }));
    });
  }
});

describe('attach', () => {
  it('writes every archive once every signature verifies, and build-l4-claims takes them', async () => {
    await preparedAndSigned();
    const r = await attach(TRUST_TEST_KEY);
    expect(r.out).toMatch(/verifies in production trust/);
    expect(r.code).toBe(0);
    for (const name of LISTINGS) {
      const archive = new AdmZip(zipOf(name));
      expect(archive.getEntries().map((e) => e.entryName).sort()).toEqual(['attestation.json', 'baseline.json', 'code_review.json', 'known_issues.json', 'manifest.json', 'primary_query.json']);
      expect(JSON.parse(archive.getEntry('attestation.json').getData().toString('utf8')).signature.keyId).toBe(testKey.keyId);
    }
    const built = await script(BUILD, [...listingArgs(), '--dry-run'], TRUST_TEST_KEY);
    expect(built.out).toMatch(/production trust/);
    expect(built.out).not.toMatch(/CODE_REVIEW_DEV_KEYS/);
    expect(built.code).toBe(0);
  });

  it('with the real builder set, a signature from another key is refused and no archive is written', async () => {
    await preparedAndSigned();
    const r = await attach();
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/ATTESTATION_BAD_SIGNATURE/);
    for (const name of LISTINGS) expect(fs.existsSync(zipOf(name))).toBe(false);
  });

  it('names the key the release trusts: the production builder key', async () => {
    await preparedAndSigned();
    const r = await attach();
    expect(r.out).toContain(codeReview.PRODUCTION_BUILDER_KEYS[0].keyId);
    expect(codeReview.PRODUCTION_BUILDER_KEYS[0].keyId).toBe('c400af59dc75cf7cb0bc2430833d29047955ae99c18a1d007700588a84b45b13');
  });

  it('one bad signature among three writes none', async () => {
    await preparedAndSigned();
    const file = path.join(out, 'signatures.json');
    const signatures = JSON.parse(fs.readFileSync(file, 'utf8'));
    signatures['cold-cache'] = crypto.sign(null, Buffer.from('something else'), testKey.privateKey).toString('base64');
    fs.writeFileSync(file, JSON.stringify(signatures));
    const r = await attach(TRUST_TEST_KEY);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/cold-cache.*ATTESTATION_BAD_SIGNATURE/);
    for (const name of LISTINGS) expect(fs.existsSync(zipOf(name))).toBe(false);
  });

  it('refuses a missing or malformed signature', async () => {
    await preparedAndSigned();
    const file = path.join(out, 'signatures.json');
    const signatures = JSON.parse(fs.readFileSync(file, 'utf8'));
    delete signatures.listing;
    fs.writeFileSync(file, JSON.stringify(signatures));
    const missing = await attach(TRUST_TEST_KEY);
    expect(missing.code).toBe(1);
    expect(missing.out).toMatch(/no 64-byte base64 signature for listing/);
  });

  it('refuses a member changed after the signature: the statement binds its bytes', async () => {
    await preparedAndSigned();
    const file = path.join(out, 'listing', 'members', 'code_review.json');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('"valueAtRiskUsd": 1000', '"valueAtRiskUsd": 1001'));
    const r = await attach(TRUST_TEST_KEY);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/listing does not verify in production trust.*ATTESTATION/);
  });

  it('refuses a statement that is not the one the bytes came from', async () => {
    await preparedAndSigned();
    const file = path.join(out, 'listing', 'statement.json');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('"production"', '"dev"'));
    const r = await attach(TRUST_TEST_KEY);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/not the statement signing-bytes\.bin came from/);
  });
});

describe('build-l4-claims --listing-file holds every listing to production trust', () => {
  const devListing = (image = IMAGE) => F.makeListing({ image, baseCommit: BASE_COMMIT, baseline: repo.vaultBaseline(BASE_COMMIT) });

  it.each([
    ['--listing-file', (dev) => ['--listing-file', dev]],
    ['--registry-failure-listing-file', (dev) => ['--listing-file', zipOf('listing'), '--registry-failure-listing-file', dev]],
    ['--cold-listing-file', (dev) => ['--listing-file', zipOf('listing'), '--cold-listing-file', dev]]
  ])('%s refuses a dev-signed listing, before anything is pinned', async (_flag, args) => {
    await preparedAndSigned();
    expect((await attach(TRUST_TEST_KEY)).code).toBe(0);
    const dev = path.join(dir, 'dev.zip');
    fs.writeFileSync(dev, devListing().buffer);
    const r = await script(BUILD, [...args(dev), '--dry-run'], TRUST_TEST_KEY);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/dev\.zip does not verify in production trust: .*ATTESTATION_/);
  });

  it('no setting of a canary\'s widens it: dev keys in the environment change nothing', async () => {
    const key = codeReview.createDevBuilderKey();
    const listing = F.makeListing({ image: IMAGE, baseCommit: BASE_COMMIT, baseline: repo.vaultBaseline(BASE_COMMIT), builderKey: key });
    const dev = path.join(dir, 'dev.zip');
    fs.writeFileSync(dev, listing.buffer);
    const r = await script(BUILD, ['--listing-file', dev, '--dry-run'], { CODE_REVIEW_TRUST: 'dev', CODE_REVIEW_DEV_KEYS: key.publicKey, NETWORK_CHAIN_ID: '84532' });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/does not verify in production trust/);
  });

  it('a dev statement signed by the trusted key itself is refused: the set a statement is for is in the signed bytes', async () => {
    const unsigned = F.unsignedListing({ image: IMAGE, baseCommit: BASE_COMMIT, baseline: repo.vaultBaseline(BASE_COMMIT), trust: 'dev', runner: RUNNER_VERSION });
    const file = path.join(dir, 'dev-statement.zip');
    fs.writeFileSync(file, F.listingArchive(unsigned.members, codeReview.signAttestation(unsigned.statement, testKey.privateKey)));
    const r = await script(BUILD, ['--listing-file', file, '--dry-run'], TRUST_TEST_KEY);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/ATTESTATION_TRUST_MODE_MISMATCH/);
  });

  it('an archive with no attestation is refused', async () => {
    const unsigned = F.unsignedListing({ image: IMAGE, baseCommit: BASE_COMMIT, baseline: repo.vaultBaseline(BASE_COMMIT), trust: 'production', runner: RUNNER_VERSION });
    const archive = new AdmZip();
    for (const [name, bytes] of Object.entries(unsigned.members)) archive.addFile(name, bytes);
    const file = path.join(dir, 'unsigned.zip');
    fs.writeFileSync(file, archive.toBuffer());
    const r = await script(BUILD, ['--listing-file', file, '--dry-run'], TRUST_TEST_KEY);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/ATTESTATION_MISSING/);
  });
});
