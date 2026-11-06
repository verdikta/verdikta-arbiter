'use strict';

// Node A9: the L4 listings under the production builder key, which nothing here can reach. Every
// production path runs to its end with a test key in a child process's builder set
// (test/helpers/production-key-preload.js); with the real set, the same files are refused.
// git ls-remote and gh are stubbed: the fixture branch and the CI run are files the test writes.

const crypto = require('crypto');
const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const AdmZip = require('adm-zip');
const { codeReview } = require('@verdikta/common');
const { version: COMMON_VERSION } = require('@verdikta/common/package.json');
const F = require('../../l2/claim/fixtures');
const repo = require('../../../../code-runner/test/docker/forgeFixture');
const { RUNNER_VERSION } = require('../../../../code-runner/src/version');
const { sourceSha256 } = require('../../../../code-runner/src/conformance');

jest.setTimeout(60000);

const E2E = path.join(__dirname, '..', '..', '..');
const PREPARE = path.join(E2E, 'scripts', 'prepare-l4-listings.js');
const BUILD = path.join(E2E, 'scripts', 'build-l4-claims.js');
const PRELOAD = path.join(E2E, 'test', 'helpers', 'production-key-preload.js');
const IMAGE = `ghcr.io/verdikta/l4-fixture@sha256:${'b'.repeat(64)}`;
const GONE_IMAGE = `ghcr.io/verdikta/l4-fixture@sha256:${'d'.repeat(64)}`;
const COLD_IMAGE = `ghcr.io/verdikta/l4-fixture@sha256:${'c'.repeat(64)}`;
const BASE_COMMIT = 'a'.repeat(40);
/** What images measured on its own daemon: a note in images.json, which decides nothing (A9b). */
const LOCAL_SIZE = 620331192;
/** What the runner measured in CI: the size a signed spec states. */
const MEASURED = 641318912;
/** The size specs declares before anything is measured: the class maximum, which the check assumes for an undeclared one. */
const PLACEHOLDER = codeReview.CLASS_HARD_LIMITS.imageUnpackedBytes;
const FIXTURE_COMMIT = '43679c1856fbafe0dfe8d24c6e3c883511695002';
const LISTINGS = ['listing', 'registry-failure', 'cold-cache'];
const IMAGES = { listing: IMAGE, 'registry-failure': GONE_IMAGE, 'cold-cache': COLD_IMAGE };
const FIXTURE_REPO = 'https://github.com/verdikta/verdikta-arbiter';
const FIXTURE_BRANCH = 'claude/stake-attestation-l4-fixture';
const RUN_ID = '4242424242';
const HEAD_SHA = 'e'.repeat(40);
const DEPOSIT = 'test/Vault.t.sol > VaultTest > test_deposit()';
const FLAKY = 'test/Vault.t.sol > VaultTest > test_flaky()';
/** What a runner measured: not vaultBaseline(), so a statement can only have it from the measurement. */
const measuredBaseline = (baseCommit = BASE_COMMIT) => ({
  version: 1, baseCommit, framework: 'forge', runs: 3,
  tests: [{ id: DEPOSIT, results: ['pass', 'pass', 'pass'] }, { id: FLAKY, results: ['pass', 'fail', 'pass'] }],
  stable: [DEPOSIT], unstable: [FLAKY]
});
const BASE = codeReview.BASE_IMAGE_PINS.foundry.reference;
const hashOf = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
/** The code the check ran, as prepare computes it for this checkout. */
const CODE = {
  runnerSource: sourceSha256(),
  harness: hashOf(path.join(__dirname, '..', '..', '..', 'scripts', 'prepare-l4-listings.js')),
  fixtures: hashOf(path.join(__dirname, '..', '..', 'l2', 'claim', 'fixtures.js')),
  lockfile: hashOf(path.join(__dirname, '..', '..', '..', 'package-lock.json')),
  workflow: hashOf(path.join(__dirname, '..', '..', '..', '..', '.github', 'workflows', 'e2e.yml'))
};
/** age's documented example recipient: its private half is public, so no real listing may use it (A7a). */
const AGE_EXAMPLE = 'age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p';

const testKey = codeReview.createDevBuilderKey();
const TRUST_TEST_KEY = {
  NODE_OPTIONS: `--require "${PRELOAD}"`,
  E2E_TEST_PRODUCTION_KEY: JSON.stringify({ keyId: testKey.keyId, publicKey: testKey.publicKey })
};
const REAL_GIT = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();

let dir;
let out;
let bin;
let imagesFile;

function branchHolds(commit) {
  fs.writeFileSync(path.join(bin, 'branch.txt'), commit ? `${commit}\trefs/heads/${FIXTURE_BRANCH}\n` : '');
}

function writeImages(change = (r) => r) {
  const listings = {};
  for (const name of LISTINGS) listings[name] = { image: IMAGES[name], unpackedBytes: LOCAL_SIZE, tag: name };
  const record = { version: 1, repository: 'ghcr.io/verdikta/l4-fixture', fixture: { repo: FIXTURE_REPO, branch: FIXTURE_BRANCH, commit: BASE_COMMIT }, listings };
  fs.writeFileSync(imagesFile, JSON.stringify(change(record)));
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-prepare-'));
  out = path.join(dir, 'out');
  bin = path.join(dir, 'bin');
  imagesFile = path.join(dir, 'images.json');
  fs.mkdirSync(bin);
  // git: ls-remote answers from branch.txt beside it; everything else is the real git.
  fs.writeFileSync(path.join(bin, 'git'), [
    '#!/usr/bin/env bash',
    'here=$(cd "$(dirname "$0")" && pwd)',
    'if [ "$1" = "ls-remote" ]; then echo "$*" >> "$here/git.log"; cat "$here/branch.txt" 2>/dev/null; exit 0; fi',
    // git before 2.28 has no `init -b`.
    'if [ -e "$here/old-git" ] && [ "$1" = "init" ]; then for a in "$@"; do if [ "$a" = "-b" ]; then echo "error: unknown switch b" >&2; exit 129; fi; done; fi',
    `exec "${REAL_GIT}" "$@"`, ''
  ].join('\n'), { mode: 0o755 });
  // gh: the run is run.json beside it, and the artifact is measurement.json.
  fs.writeFileSync(path.join(bin, 'gh'), [
    '#!/usr/bin/env bash',
    'here=$(cd "$(dirname "$0")" && pwd)',
    'echo "$*" >> "$here/gh.log"',
    'if [ "$1" = "api" ]; then cat "$here/run.json"; exit 0; fi',
    'if [ "$1" = "run" ] && [ "$2" = "download" ]; then',
    '  dest=""; while [ $# -gt 0 ]; do if [ "$1" = "-D" ]; then dest="$2"; fi; shift; done',
    '  cp "$here/measurement.json" "$dest/measurement.json"; exit 0',
    'fi',
    'exit 2', ''
  ].join('\n'), { mode: 0o755 });
  branchHolds(BASE_COMMIT);
  writeImages();
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function run(command, args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: dir, env: { PATH: `${bin}:${process.env.PATH}`, NODE_PATH: path.join(E2E, 'node_modules'), ...env } });
    let output = '';
    child.stdout.on('data', (c) => { output += c; });
    child.stderr.on('data', (c) => { output += c; });
    child.on('close', (code) => resolve({ code, out: output }));
  });
}
const script = (file, args, env) => run(process.execPath, [file, ...args], env);
const specs = (extra = []) => script(PREPARE, ['specs', '--images', imagesFile, '--out', out, ...extra]);
const prepareRun = (extra = []) => script(PREPARE, ['prepare', '--dir', out, '--run', RUN_ID, ...extra]);
const attach = (env) => script(PREPARE, ['attach', '--dir', out], env);
const bytesOf = (name) => fs.readFileSync(path.join(out, name, 'signing-bytes.bin'));
const requestBytes = () => fs.readFileSync(path.join(out, 'check-requests.json'));
const specOf = (name) => JSON.parse(fs.readFileSync(path.join(out, name, 'members', 'code_review.json'), 'utf8'));
const requestOf = (name) => JSON.parse(requestBytes().toString('utf8')).listings[name];
/** A request's spec at the size the runner measured: what the check's second pass posts. */
const sized = (spec, size = MEASURED) => ({ ...spec, env: { ...spec.env, unpackedBytes: size } });
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

/** The CI run, as the API gives it. */
function writeRun(change = (r) => r) {
  const runRecord = {
    id: Number(RUN_ID), path: '.github/workflows/e2e.yml', event: 'workflow_dispatch', head_branch: 'claude/stake-attestation',
    head_sha: HEAD_SHA, status: 'completed', conclusion: 'success',
    repository: { full_name: 'verdikta/verdikta-arbiter' }, head_repository: { full_name: 'verdikta/verdikta-arbiter' }
  };
  fs.writeFileSync(path.join(bin, 'run.json'), JSON.stringify(change(runRecord)));
}

/** What the check job uploads for the requests specs wrote: the runner's own answers. */
function writeMeasurement(change = (m) => m) {
  const requests = JSON.parse(requestBytes().toString('utf8'));
  const checked = { ...requests, listings: {} };
  const sizing = {};
  const listings = {};
  for (const name of LISTINGS) {
    const body = { ...requests.listings[name], spec: sized(requests.listings[name].spec) };
    checked.listings[name] = body;
    sizing[name] = { declared: requests.listings[name].spec.env.unpackedBytes, measured: MEASURED };
    listings[name] = {
      image: body.image,
      base: { reference: BASE, layers: 5 },
      specSha256: sha256(F.bytes(body.spec)),
      httpStatus: 200,
      response: {
        outcome: 'definitive', kind: 'listing-check', checkId: `c-${name}`,
        runner: { version: RUNNER_VERSION, runtime: 'runsc', platform: 'linux/amd64' },
        listing: { status: 'accepted', refusals: [], warnings: [], image: { ref: body.image, unpackedBytes: MEASURED }, baseline: measuredBaseline(requests.baseCommit) }
      }
    };
  }
  const measurement = {
    version: 1, kind: 'l4-listing-check', mode: 'dispatch',
    requestsSha256: crypto.createHash('sha256').update(requestBytes()).digest('hex'),
    repo: requests.repo, baseCommit: requests.baseCommit, fixture: { branch: FIXTURE_BRANCH, commit: requests.baseCommit },
    runner: { version: RUNNER_VERSION, common: COMMON_VERSION, runtime: 'runsc', platform: 'linux/amd64' },
    code: CODE,
    gvisor: codeReview.GVISOR_RELEASE,
    semgrepRules: { pinned: codeReview.SEMGREP_RULES_VERSION, ran: false },
    github: { runId: RUN_ID, sha: HEAD_SHA, ref: 'refs/heads/claude/stake-attestation' },
    sizing,
    checked,
    listings
  };
  fs.writeFileSync(path.join(bin, 'measurement.json'), JSON.stringify(change(measurement)));
}

/** specs, the CI run, then prepare. */
async function prepared({ run: changeRun, measurement: changeMeasurement } = {}) {
  const s = await specs();
  expect(s.code).toBe(0);
  writeRun(changeRun);
  writeMeasurement(changeMeasurement);
  return prepareRun();
}

async function preparedAndSigned() {
  const r = await prepared();
  expect(r.code).toBe(0);
  const signatures = {};
  for (const name of LISTINGS) signatures[name] = crypto.sign(null, bytesOf(name), testKey.privateKey).toString('base64');
  fs.writeFileSync(path.join(out, 'signatures.json'), JSON.stringify(signatures));
}
const zipOf = (name) => path.join(out, `${name}.zip`);
const listingArgs = () => ['--listing-file', zipOf('listing'), '--registry-failure-listing-file', zipOf('registry-failure'), '--cold-listing-file', zipOf('cold-cache')];

function walk(root) {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(root, e.name)) : [path.join(root, e.name)]));
}

describe('specs', () => {
  it('writes the requests for three specs on Verdikta\'s fixture branch, each with its own disclosure key, and no size of its own', async () => {
    const r = await specs();
    expect(r.code).toBe(0);
    const requests = JSON.parse(requestBytes().toString('utf8'));
    expect(requests).toMatchObject({ version: 1, repo: FIXTURE_REPO, baseCommit: BASE_COMMIT });
    const keys = [];
    for (const name of LISTINGS) {
      const { spec } = requests.listings[name];
      expect(spec.repo).toBe(FIXTURE_REPO);
      expect(spec.baseCommit).toBe(BASE_COMMIT);
      expect(spec.env.image).toBe(IMAGES[name]);
      // The local daemon's figure decides nothing: the check measures, and checks the spec at what it measured.
      expect(spec.env.unpackedBytes).toBe(PLACEHOLDER);
      expect(spec.artifact.chainId).toBe(31337);
      expect(requests.listings[name]).toEqual({ spec, image: IMAGES[name], deadline: 900000 });
      // No code_review.json until prepare writes the one the run checked.
      expect(fs.readdirSync(path.join(out, name, 'members')).sort()).toEqual(['known_issues.json']);
      keys.push(spec.stake.disclosureKey);
    }
    expect(new Set(keys).size).toBe(3);
    for (const key of keys) {
      expect(key).not.toBe(AGE_EXAMPLE);
      expect(() => codeReview.parseDisclosureKey(key)).not.toThrow();
    }
    for (const file of walk(out)) expect(fs.readFileSync(file, 'utf8')).not.toMatch(/AGE-SECRET|PRIVATE KEY/);
    expect(r.out).toContain('gh workflow run e2e.yml -R verdikta/verdikta-arbiter --ref claude/stake-attestation -f l4_listing_requests=');
    expect(fs.readFileSync(path.join(bin, 'git.log'), 'utf8')).toContain(`ls-remote -- ${FIXTURE_REPO}.git refs/heads/${FIXTURE_BRANCH}`);
  });

  const listing = (name, change) => (r) => ({ ...r, listings: { ...r.listings, [name]: { ...r.listings[name], ...change } } });
  it.each([
    ['an image by tag', listing('listing', { image: 'ghcr.io/verdikta/l4-fixture:latest' }), /listing image must be named by digest/],
    ['an image an arbiter would not pull', listing('cold-cache', { image: `registry.example/vault@sha256:${'c'.repeat(64)}` }), /outside ghcr\.io\/verdikta/],
    ['the same digest twice', listing('cold-cache', { image: IMAGE }), /digest of its own/],
    ['the same digest under another name', listing('registry-failure', { image: IMAGE.replace('@', '-gone@') }), /digest of its own/],
    ['a short commit', (r) => ({ ...r, fixture: { ...r.fixture, commit: 'abc' } }), /whole commit hash/],
    ['a listing missing', (r) => ({ ...r, listings: { listing: r.listings.listing, 'cold-cache': r.listings['cold-cache'] } }), /registry-failure image/]
  ])('refuses %s, and writes nothing', async (_label, change, message) => {
    writeImages(change);
    const r = await specs();
    expect(r.code).toBe(1);
    expect(r.out).toMatch(message);
    expect(fs.existsSync(out)).toBe(false);
  });

  it.each([
    ['another commit', 'f'.repeat(40), /claude\/stake-attestation-l4-fixture holds ffff/],
    ['no branch', null, /has no branch claude\/stake-attestation-l4-fixture/]
  ])('refuses images of a commit the fixture branch does not hold: %s', async (_label, commit, message) => {
    branchHolds(commit);
    const r = await specs();
    expect(r.code).toBe(1);
    expect(r.out).toMatch(message);
    expect(fs.existsSync(out)).toBe(false);
  });

  it('takes images.json as A9\'s images wrote it, whatever size it noted', async () => {
    writeImages((r) => ({ ...r, listings: Object.fromEntries(Object.entries(r.listings).map(([n, l]) => [n, { ...l, unpackedBytes: 1 }])) }));
    expect((await specs()).code).toBe(0);
    for (const name of LISTINGS) expect(requestOf(name).spec.env.unpackedBytes).toBe(PLACEHOLDER);
  });

  it('refuses a directory holding anything: each run makes new disclosure keys', async () => {
    fs.mkdirSync(out);
    fs.writeFileSync(path.join(out, 'old'), 'x');
    const r = await specs();
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/not empty/);
  });
});

describe('prepare', () => {
  it('builds each statement from what the runner measured, and writes the exact bytes to sign', async () => {
    const r = await prepared();
    expect(r.out).toContain(`From run ${RUN_ID}`);
    expect(r.code).toBe(0);
    for (const name of LISTINGS) {
      const statement = JSON.parse(fs.readFileSync(path.join(out, name, 'statement.json'), 'utf8'));
      expect(statement.trust).toBe('production');
      expect(statement.signature).toBeUndefined();
      expect(statement.repo).toBe(FIXTURE_REPO);
      expect(statement.baseCommit).toBe(BASE_COMMIT);
      expect(statement.env.image).toBe(IMAGES[name]);
      expect(statement.env.unpackedBytes).toBe(MEASURED);
      expect(statement.env.base).toBe(BASE);
      // The spec signed is the one the run checked, at the size the runner measured, byte for byte.
      const spec = fs.readFileSync(path.join(out, name, 'members', 'code_review.json'));
      expect(JSON.parse(spec.toString('utf8'))).toEqual(sized(requestOf(name).spec));
      expect(sha256(spec)).toBe(statement.sha256.codeReview);
      expect(sha256(spec)).toBe(JSON.parse(fs.readFileSync(path.join(bin, 'measurement.json'), 'utf8')).listings[name].specSha256);
      expect(statement.tools).toEqual({ runner: RUNNER_VERSION, gvisor: codeReview.GVISOR_RELEASE, semgrepRules: codeReview.SEMGREP_RULES_VERSION });
      const baseline = fs.readFileSync(path.join(out, name, 'members', 'baseline.json'));
      expect(JSON.parse(baseline.toString('utf8'))).toEqual(measuredBaseline());
      expect(JSON.parse(baseline.toString('utf8'))).not.toEqual(repo.vaultBaseline(BASE_COMMIT));
      expect(statement.sha256.baseline).toBe(crypto.createHash('sha256').update(baseline).digest('hex'));
      expect(bytesOf(name).equals(codeReview.attestationSigningBytes(statement))).toBe(true);
      expect(bytesOf(name).length).toBeLessThan(4096);
      expect(r.out).toContain(`${bytesOf(name).length} bytes to sign`);
      expect(fs.readdirSync(path.join(out, name, 'members')).sort()).toEqual(['baseline.json', 'code_review.json', 'known_issues.json']);
    }
    const asked = fs.readFileSync(path.join(bin, 'gh.log'), 'utf8');
    expect(asked).toContain(`api repos/verdikta/verdikta-arbiter/actions/runs/${RUN_ID}`);
    expect(asked).toContain(`run download ${RUN_ID} -R verdikta/verdikta-arbiter -n l4-listing-measurement -D `);
    expect(fs.readFileSync(path.join(out, 'measurement.json'), 'utf8')).toBe(fs.readFileSync(path.join(bin, 'measurement.json'), 'utf8'));
  });

  it.each([
    ['another workflow', (r) => ({ ...r, path: '.github/workflows/code-runner.yml' }), /is \.github\/workflows\/code-runner\.yml, not \.github\/workflows\/e2e\.yml/],
    ['another branch', (r) => ({ ...r, head_branch: 'claude/sa-A9' }), /ran on claude\/sa-A9, not claude\/stake-attestation/],
    ['a pull request run', (r) => ({ ...r, event: 'pull_request' }), /not a dispatch/],
    ['a failed run', (r) => ({ ...r, conclusion: 'failure' }), /not a success/],
    ['a run still going', (r) => ({ ...r, status: 'in_progress', conclusion: null }), /not a success/],
    ['code from a fork', (r) => ({ ...r, head_repository: { full_name: 'someone/verdikta-arbiter' } }), /ran code from someone\/verdikta-arbiter/],
    ['another run', (r) => ({ ...r, id: 1 }), /answered as run 1/]
  ])('refuses %s, and writes no statement', async (_label, change, message) => {
    const r = await prepared({ run: change });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(message);
    for (const name of LISTINGS) expect(fs.existsSync(path.join(out, name, 'statement.json'))).toBe(false);
    expect(fs.existsSync(path.join(out, 'sign-in-cloudshell.sh'))).toBe(false);
  });

  const answer = (name, change) => (m) => ({ ...m, listings: { ...m.listings, [name]: change(m.listings[name]) } });
  const listingOf = (change) => (l) => ({ ...l, response: { ...l.response, listing: change(l.response.listing) } });
  it.each([
    ['a self-check', (m) => ({ ...m, mode: 'self-check' }), /self-check run/],
    ['other requests', (m) => ({ ...m, requestsSha256: '0'.repeat(64) }), /checked other requests/],
    ['another run\'s artifact', (m) => ({ ...m, github: { ...m.github, runId: '1' } }), /written by another run/],
    ['another runner version', (m) => ({ ...m, runner: { ...m.runner, version: '0.1.9' } }), /ran runner 0\.1\.9/],
    ['another common', (m) => ({ ...m, runner: { ...m.runner, common: '1.9.0-attest.2' } }), /ran @verdikta\/common 1\.9\.0-attest\.2/],
    ['runc', (m) => ({ ...m, runner: { ...m.runner, runtime: 'runc' } }), /ran under runc/],
    ['another gVisor', (m) => ({ ...m, gvisor: 'release-20260101.0' }), /ran gVisor release-20260101\.0/],
    ['other runner source at the same version', (m) => ({ ...m, code: { ...m.code, runnerSource: '0'.repeat(64) } }), /ran another runnerSource than this checkout's .*check out the run's commit e+/],
    ['another check script', (m) => ({ ...m, code: { ...m.code, harness: '0'.repeat(64) } }), /ran another harness than this checkout's/],
    ['another workflow file', (m) => ({ ...m, code: { ...m.code, workflow: '0'.repeat(64) } }), /ran another workflow than this checkout's/],
    ['no code fingerprint', (m) => ({ ...m, code: undefined }), /ran another runnerSource/],
    ['an image on another base', answer('cold-cache', (l) => ({ ...l, base: { reference: 'ghcr.io/foundry-rs/foundry:v1.0.0@sha256:' + '1'.repeat(64), layers: 5 } })), /cold-cache: the run did not find the image built on ghcr\.io\/foundry-rs\/foundry:v1\.8\.5/],
    ['no base check', answer('listing', (l) => ({ ...l, base: undefined })), /listing: the run did not find the image built on/],
    ['another commit', (m) => ({ ...m, baseCommit: 'f'.repeat(40) }), /checked ffff/],
    ['a listing it did not check', (m) => ({ ...m, listings: { listing: m.listings.listing, 'cold-cache': m.listings['cold-cache'] } }), /measured no registry-failure listing/],
    ['a refused listing', answer('cold-cache', listingOf((l) => ({ ...l, status: 'refused', refusals: [{ code: 'BUILD_FAILED' }] }))), /cold-cache: the runner did not accept it: .*BUILD_FAILED/],
    ['an abstention', answer('listing', (l) => ({ ...l, httpStatus: 503, response: { ...l.response, outcome: 'abstain', listing: null } })), /listing: the check did not finish: 503 abstain/],
    ['an answer from runc', answer('listing', (l) => ({ ...l, response: { ...l.response, runner: { ...l.response.runner, runtime: 'runc' } } })), /listing: the runner answered as/],
    ['another image', answer('registry-failure', listingOf((l) => ({ ...l, image: { ...l.image, ref: IMAGE } }))), /registry-failure: the runner checked ghcr\.io\/verdikta\/l4-fixture@sha256:b+, not/],
    ['another size', answer('listing', listingOf((l) => ({ ...l, image: { ...l.image, unpackedBytes: MEASURED + 1 } }))), /listing: the runner measured 641318913 bytes unpacked, and the spec says 641318912/],
    ['the placeholder checked as the size', (m) => ({ ...m, checked: { ...m.checked, listings: { ...m.checked.listings, listing: { ...m.checked.listings.listing, spec: sized(m.checked.listings.listing.spec, PLACEHOLDER) } } } }), /listing: the runner measured 641318912 bytes unpacked, and the spec says/],
    ['a checked spec that differs in more than its size', (m) => ({ ...m, checked: { ...m.checked, listings: { ...m.checked.listings, 'cold-cache': { ...m.checked.listings['cold-cache'], spec: { ...m.checked.listings['cold-cache'].spec, stake: { ...m.checked.listings['cold-cache'].spec.stake, valueAtRiskUsd: 1001 } } } } } }), /cold-cache: the run checked another spec than specs wrote/],
    ['no checked requests', (m) => ({ ...m, checked: undefined }), /the requests are not what specs wrote/],
    ['other bytes for the checked spec', answer('registry-failure', (l) => ({ ...l, specSha256: '0'.repeat(64) })), /registry-failure: the run checked other bytes than these/],
    ['a baseline of another commit', answer('listing', listingOf((l) => ({ ...l, baseline: measuredBaseline('f'.repeat(40)) }))), /listing: the measured baseline/],
    ['a baseline that does not validate', answer('listing', listingOf((l) => ({ ...l, baseline: { ...l.baseline, runs: 2 } }))), /listing: the measured baseline does not validate/]
  ])('refuses a measurement of %s, and writes no statement', async (_label, change, message) => {
    const r = await prepared({ measurement: change });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(message);
    for (const name of LISTINGS) expect(fs.existsSync(path.join(out, name, 'statement.json'))).toBe(false);
  });

  it('refuses requests changed after the check', async () => {
    expect((await specs()).code).toBe(0);
    writeRun();
    writeMeasurement();
    const file = path.join(out, 'check-requests.json');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('"valueAtRiskUsd":1000', '"valueAtRiskUsd":1001'));
    const r = await prepareRun();
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/checked other requests than this directory's check-requests\.json/);
  });

  it('refuses once the fixture branch holds another commit', async () => {
    expect((await specs()).code).toBe(0);
    writeRun();
    writeMeasurement();
    branchHolds('f'.repeat(40));
    const r = await prepareRun();
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/claude\/stake-attestation-l4-fixture holds ffff/);
  });

  it('refuses a run id that is not one, and a directory prepared already', async () => {
    expect((await prepared()).code).toBe(0);
    const again = await prepareRun();
    expect(again.code).toBe(1);
    expect(again.out).toMatch(/prepared already/);
    const bad = await script(PREPARE, ['prepare', '--dir', out, '--run', '12; rm -rf /']);
    expect(bad.code).toBe(1);
    expect(bad.out).toMatch(/--run must be the id/);
  });
});

describe('fixture-repo', () => {
  it.each([
    ['this git', false],
    ['a git before 2.28, which has no init -b', true]
  ])('writes the published fixture commit with %s', async (_label, old) => {
    if (old) fs.writeFileSync(path.join(bin, 'old-git'), '');
    const r = await script(PREPARE, ['fixture-repo', '--out', path.join(dir, 'fixture')]);
    expect(r.out.split('\n')[0]).toBe(FIXTURE_COMMIT);
    expect(r.code).toBe(0);
    expect(execFileSync(REAL_GIT, ['-C', path.join(dir, 'fixture'), 'symbolic-ref', 'HEAD'], { encoding: 'utf8' }).trim()).toBe('refs/heads/main');
  });
});

describe('check', () => {
  const requestsFile = () => path.join(dir, 'requests.json');
  const writeRequests = (change) => {
    const requests = JSON.parse(requestBytes().toString('utf8'));
    fs.writeFileSync(requestsFile(), JSON.stringify(change(requests)));
  };
  const check = (env = { CODE_RUNNER_RUNTIME: 'runsc' }) => script(PREPARE, ['check', '--requests', requestsFile(), '--out', path.join(dir, 'm.json')], env);
  const body = (name, change) => (r) => ({ ...r, listings: { ...r.listings, [name]: change(r.listings[name]) } });

  it.each([
    ['an image outside ghcr.io/verdikta', body('listing', (b) => ({ ...b, image: `registry.example/x@sha256:${'b'.repeat(64)}` })), /not an image under ghcr\.io\/verdikta/],
    ['a spec naming another image', body('listing', (b) => ({ ...b, spec: { ...b.spec, env: { ...b.spec.env, image: COLD_IMAGE } } })), /does not name its image/],
    ['a spec naming another repository', body('cold-cache', (b) => ({ ...b, spec: { ...b.spec, repo: 'https://github.com/acme/vault' } })), /does not name its image, https:\/\/github\.com\/verdikta\/verdikta-arbiter/],
    ['a field the runner would not take', body('listing', (b) => ({ ...b, baseline: {} })), /holds baseline, deadline, image, spec/],
    ['a listing too many', (r) => ({ ...r, listings: { ...r.listings, extra: r.listings.listing } }), /the requests name/]
  ])('refuses %s, before any runner starts', async (_label, change, message) => {
    expect((await specs()).code).toBe(0);
    writeRequests(change);
    const r = await check();
    expect(r.code).toBe(1);
    expect(r.out).toMatch(message);
    expect(fs.existsSync(path.join(dir, 'm.json'))).toBe(false);
  });

  it('measures for a signature only under runsc', async () => {
    expect((await specs()).code).toBe(0);
    writeRequests((r) => r);
    const r = await check({ CODE_RUNNER_RUNTIME: 'runc' });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/runs under runsc/);
  });
});

describe('the signing script', () => {
  const writeAwsStub = () => {
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
  };

  it('holds no key name, and needs one', async () => {
    expect((await prepared()).code).toBe(0);
    const file = path.join(out, 'sign-in-cloudshell.sh');
    expect(fs.readFileSync(file, 'utf8')).not.toMatch(/arn:|alias\/|[0-9a-f]{8}-[0-9a-f]{4}-/);
    const r = await run('bash', [file]);
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/BUILDER_KEY/);
  });

  it('signs the bytes prepare wrote, and what it writes is what attach takes', async () => {
    expect((await prepared()).code).toBe(0);
    writeAwsStub();
    const log = path.join(dir, 'aws.log');
    const pem = testKey.privateKey.export({ type: 'pkcs8', format: 'pem' });
    const r = await spawnInOut(log, pem);
    expect(r.code).toBe(0);
    const signatures = JSON.parse(fs.readFileSync(path.join(out, 'signatures.json'), 'utf8'));
    expect(Object.keys(signatures)).toEqual(LISTINGS);
    expect(fs.readFileSync(log, 'utf8').trim().split('\n')).toHaveLength(3);
    expect(fs.readFileSync(log, 'utf8')).toContain('--key-id the-key ');
    expect((await attach(TRUST_TEST_KEY)).code).toBe(0);
    for (const name of LISTINGS) expect(fs.existsSync(zipOf(name))).toBe(true);
  });

  /** The owner's command, in the directory the script writes signatures.json to. */
  function spawnInOut(log, pem) {
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
      expect(JSON.parse(archive.getEntry('baseline.json').getData().toString('utf8'))).toEqual(measuredBaseline());
    }
    const built = await script(BUILD, [...listingArgs(), '--dry-run'], TRUST_TEST_KEY);
    expect(built.out).toMatch(/production trust/);
    expect(built.out).not.toMatch(/CODE_REVIEW_DEV_KEYS/);
    expect(built.code).toBe(0);
  });

  it('an archive is exactly the bound files and what is made from them, whatever else is in the directory', async () => {
    await preparedAndSigned();
    fs.writeFileSync(path.join(out, 'listing', 'members', '.DS_Store'), 'x');
    fs.writeFileSync(path.join(out, 'listing', 'members', 'manifest.json'), '{"juryParameters":"changed"}');
    expect((await attach(TRUST_TEST_KEY)).code).toBe(0);
    const archive = new AdmZip(zipOf('listing'));
    expect(archive.getEntries().map((e) => e.entryName).sort()).toEqual(['attestation.json', 'baseline.json', 'code_review.json', 'known_issues.json', 'manifest.json', 'primary_query.json']);
    const manifest = JSON.parse(archive.getEntry('manifest.json').getData().toString('utf8'));
    expect(manifest.juryParameters).toEqual(codeReview.CODE_STANDARD_PANEL);
    expect(manifest.codeReview).toBe('code_review.json');
    expect(codeReview.validateClassEnvelope(manifest.juryParameters, 'code-standard').ok).toBe(true);
    const spec = JSON.parse(archive.getEntry('code_review.json').getData().toString('utf8'));
    expect(JSON.parse(archive.getEntry('primary_query.json').getData().toString('utf8')).query).toBe(codeReview.buildClaimQuery(spec));
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
    const file = path.join(out, 'listing', 'members', 'baseline.json');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(FLAKY, FLAKY.replace('flaky', 'other')));
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
