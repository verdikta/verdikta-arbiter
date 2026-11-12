#!/usr/bin/env node
'use strict';

/**
 * The L4 claim listings, signed with the production builder key. That key signs only in its own
 * service, and a statement it signs must be true when it is signed (design §8.2): the listing was
 * validated by the runner under gVisor, at a commit of a repository anyone can read. So every
 * statement here is built from a measurement, and nothing in one is written by hand.
 *
 *   fixture-repo  writes the fixture repository (the L4 fixture image's tree, one commit with the
 *                 image build's fixed dates) and prints its commit. It is published once, as the
 *                 branch FIXTURE_BRANCH of this repository, never deleted or moved. A new tree gets a
 *                 new branch, and each branch signed listings name is in SIGNED_FIXTURES:
 *                 claude/stake-attestation-l4-fixture holds 43679c1, the tree before the vault
 *                 documented deposit (A15), which the listings of the claim set committed at ffaa30d
 *                 are signed on; FIXTURE_BRANCH holds 22763ef, which the listings in
 *                 archives/l4-claim/claim-set.json are signed on. Both stay as they are: fixture-repo
 *                 prints a push only for a branch nothing is signed on, and refuses a tree that
 *                 commits as anything but a signed FIXTURE_BRANCH's commit.
 *   images        builds three images of that commit for linux/amd64 and pushes them: the fixture
 *                 image, a fresh digest for the cold-cache scenario, and one the owner removes from
 *                 the registry once it is signed (the registry-failure scenario). Writes images.json.
 *   specs         makes the three specs from images.json, each with its own disclosure key, as the
 *                 listing-check requests that e2e.yml takes (dispatch input l4_listing_requests). A spec
 *                 states no size yet: the class maximum stands in, and images.json's size is a note.
 *   check         (CI) starts the runner and runs its own listing check on each request under runsc,
 *                 twice: the first pass measures each image's size, the second checks the specs at that
 *                 size, exactly as they will be signed. Writes what it measured. --self-check builds the
 *                 fixture and checks it through a local registry; prepare never takes that. It goes on
 *                 while the fixture branch is not published yet, and says so.
 *   prepare       takes that CI run by id: e2e.yml, dispatched on the L4 branch, a success, these
 *                 requests, these versions. Writes the spec its second pass checked (these requests at the
 *                 measured size, byte for byte), builds each statement from what the runner measured, and
 *                 writes the bytes to sign and sign-in-cloudshell.sh.
 *   attach        puts the signatures in, holds every listing to production trust, and writes the
 *                 archives scripts/build-l4-claims.js takes. All of them or none.
 *
 * Nothing here holds or asks for a private key, and no signature is checked against anything but
 * @verdikta/common's builder set. A listing's disclosure key is its own: the private half is never
 * written, since nothing in the L4 path decrypts a claim.
 *
 * Needs `npm ci` in code-runner/ (the runner and the fixture repository) and here.
 */

const crypto = require('crypto');
const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { isDeepStrictEqual } = require('util');
const { program } = require('commander');
const { codeReview } = require('@verdikta/common');
const { version: COMMON_VERSION } = require('@verdikta/common/package.json');
const F = require('../src/l2/claim/fixtures');

const CODE_RUNNER = path.join(__dirname, '..', '..', 'code-runner');
const { DEFAULT_REGISTRY_ALLOWLIST } = require(path.join(CODE_RUNNER, 'src', 'registry'));
const { RUNNER_VERSION } = require(path.join(CODE_RUNNER, 'src', 'version'));
const RUNNER_COMMON = require(path.join(CODE_RUNNER, 'src', 'common'));

/** The most a raw message may be in the service that holds the key. */
const SIGNING_MESSAGE_LIMIT = 4096;
const GITHUB_REPO = 'verdikta/verdikta-arbiter';
/** The fixture's repository is this one: its tree is the one commit of a branch of its own. */
const FIXTURE_REPO = `https://github.com/${GITHUB_REPO}`;
/** The branch the listings to sign name. Each fixture tree has a branch of its own, so no signed listing's ever moves. */
const FIXTURE_BRANCH = 'claude/stake-attestation-l4-fixture-v2';
/**
 * The branches signed listings already name, each at its one commit, with the claim set those listings are in:
 * never deleted, moved or reused. No push is printed for any of them.
 */
const SIGNED_FIXTURES = Object.freeze([
  // The tree before the vault documented deposit. Its listings are history: the claim set committed at ffaa30d (Q56).
  Object.freeze({ branch: 'claude/stake-attestation-l4-fixture', commit: '43679c1856fbafe0dfe8d24c6e3c883511695002', signed: 'the claim set committed at ffaa30d' }),
  // FIXTURE_BRANCH, the vault with its documented deposit (A15): the owner re-signed the listings on it and pinned that set.
  Object.freeze({ branch: FIXTURE_BRANCH, commit: '22763ef92e5ff13197730b795bfa6f1139de3097', signed: 'archives/l4-claim/claim-set.json' })
]);
/** The SIGNED_FIXTURES entry for `branch`, or null while no signed listing names it. */
const signedFixture = (branch) => SIGNED_FIXTURES.find((f) => f.branch === branch) || null;
/** Where e2e.yml's L4 claim runs are dispatched from, and so where the check must have run. */
const L4_BRANCH = 'claude/stake-attestation';
const WORKFLOW = '.github/workflows/e2e.yml';
const ARTIFACT = 'l4-listing-measurement';
const MEASUREMENT = 'measurement.json';
const REQUESTS = 'check-requests.json';
/** What a workflow_dispatch input holds. */
const DISPATCH_INPUT_LIMIT = 65535;
/** The runner's own maximum (src/request.js). */
const CHECK_DEADLINE_MS = 900000;
const LISTINGS = Object.freeze(['listing', 'registry-failure', 'cold-cache']);
/** The files a statement binds, by their names in the listing. */
const BOUND_FILES = Object.freeze(['code_review.json', 'baseline.json', 'known_issues.json']);
const CODE_CLASS = 'code-standard';
const IMAGE = /^[^@\s]+@sha256:[0-9a-f]{64}$/;
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const REPOSITORY = /^[a-z0-9.:/_-]+$/;
const SIGNATURE = /^[A-Za-z0-9+/]{86}==$/;
const RUN_ID = /^[1-9][0-9]{0,19}$/;
const PLATFORM = codeReview.CLASS_HARD_LIMITS.platform;
/**
 * The size a spec declares before the runner has measured its image: the class maximum, which the listing check
 * takes for an undeclared one (listing.js). No statement can carry it: prepare holds a spec's size to the runner's.
 */
const UNMEASURED = codeReview.CLASS_HARD_LIMITS.imageUnpackedBytes;
/** forgeFixture.js commits the image's repository with these dates. */
const FIXTURE_DATE = '1700000000 +0000';

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
/** What decides a check's answer besides the runner itself: this script, the fixtures it builds specs with, their lockfile, the job. */
const CODE_FILES = Object.freeze({
  harness: path.join(__dirname, 'prepare-l4-listings.js'),
  fixtures: path.join(__dirname, '..', 'src', 'l2', 'claim', 'fixtures.js'),
  lockfile: path.join(__dirname, '..', 'package-lock.json'),
  workflow: path.join(__dirname, '..', '..', '.github', 'workflows', 'e2e.yml')
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const digestOf = (image) => image.slice(image.indexOf('@') + 1);

function runnerFixtures() {
  // The fixtures read these when they load: an image for the class platform, whatever this host is.
  if (!process.env.CODE_RUNNER_RUNTIME) process.env.CODE_RUNNER_RUNTIME = 'runc';
  if (!process.env.CODE_RUNNER_PLATFORM) process.env.CODE_RUNNER_PLATFORM = PLATFORM;
  try {
    return {
      ...require(path.join(CODE_RUNNER, 'test', 'docker', 'forgeFixture')),
      H: require(path.join(CODE_RUNNER, 'test', 'docker', 'helpers')),
      CANARY: require(path.join(CODE_RUNNER, 'test', 'docker', 'determinismPocs')).CANARY_IMAGE_OPTIONS
    };
  } catch (error) {
    throw new Error(`cannot load the code runner's fixture repository (npm ci in code-runner/?): ${error.message}`);
  }
}

/** A directory to write into: new, or empty. */
function newDirectory(dir, flag) {
  if (!dir) throw new Error(`${flag} must name a directory`);
  const out = path.resolve(dir);
  if (fs.existsSync(out) && fs.readdirSync(out).length) throw new Error(`${out} is not empty: use a new directory`);
  return out;
}

// ------------------------------------------------------------------ the fixture repository

function git(args, { cwd, env = {} } = {}) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      // No one's own git configuration reaches the commit.
      env: { PATH: process.env.PATH, HOME: os.tmpdir(), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull, LC_ALL: 'C', ...env }
    });
  } catch (error) {
    throw new Error(`git ${args[0]} failed: ${String(error.stderr || error.message).trim()}`);
  }
}

/** The fixture's tree as a repository in `dir`, committed as the image build commits it (forgeFixture.js). */
function writeFixtureRepo(dir) {
  const { FOUNDRY_TOML, CANARY } = runnerFixtures();
  const files = { 'foundry.toml': FOUNDRY_TOML(CANARY.toml), ...CANARY.files };
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content, { mode: 0o644 });
  }
  // Not `init -b`, which git before 2.28 does not have: the branch's name is in no object, so the commit is the same.
  git(['init', '-q'], { cwd: dir });
  git(['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: dir });
  git(['add', '-A'], { cwd: dir });
  git(['-c', 'user.name=fixture', '-c', 'user.email=fixture@verdikta.invalid', '-c', 'commit.gpgsign=false', 'commit', '-q', '--no-verify', '-m', 'base'],
    { cwd: dir, env: { GIT_AUTHOR_DATE: FIXTURE_DATE, GIT_COMMITTER_DATE: FIXTURE_DATE } });
  return git(['rev-parse', '--verify', 'HEAD^{commit}'], { cwd: dir }).trim();
}

function fixtureCommit() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l4-fixture-'));
  try {
    return writeFixtureRepo(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The code a check ran, as hashes: the runner's own source hash (src/ and its lockfile, as a conformance pass
 * binds it) and CODE_FILES. prepare takes a run only when this checkout gives the same.
 */
function codeFingerprint() {
  const { sourceSha256 } = require(path.join(CODE_RUNNER, 'src', 'conformance'));
  const files = {};
  for (const [name, file] of Object.entries(CODE_FILES)) files[name] = sha256(fs.readFileSync(file));
  return { runnerSource: sourceSha256(), ...files };
}

/**
 * The commit the fixture branch holds, as anyone reads it. `unpublished: true` gives null for a branch that does not
 * exist yet, which only the self-check takes; any other answer that names no one commit is refused either way.
 */
function publishedFixtureCommit({ unpublished = false } = {}) {
  const out = git(['ls-remote', '--', `${FIXTURE_REPO}.git`, `refs/heads/${FIXTURE_BRANCH}`]);
  const lines = out.split('\n').filter(Boolean);
  if (unpublished && lines.length === 0) return null;
  const m = lines.length === 1 ? /^([0-9a-f]{40}|[0-9a-f]{64})\trefs\/heads\/(.+)$/.exec(lines[0]) : null;
  if (!m || m[2] !== FIXTURE_BRANCH) throw new Error(`${FIXTURE_REPO} has no branch ${FIXTURE_BRANCH} (git ls-remote: ${JSON.stringify(out.trim())})`);
  return m[1];
}

/** A signed FIXTURE_BRANCH holds its one commit: a tree that commits as another is refused, and needs a branch of its own. */
function assertSignedBranchHolds(commit, what) {
  const signed = signedFixture(FIXTURE_BRANCH);
  if (signed && signed.commit !== commit) {
    throw new Error(`${FIXTURE_BRANCH} is signed at ${signed.commit}, and ${what} commits as ${commit}: a new tree needs a branch of its own (FIXTURE_BRANCH), and no signed branch ever moves`);
  }
  return signed;
}

function fixtureRepo(opts) {
  const out = newDirectory(opts.out, '--out');
  fs.mkdirSync(out, { recursive: true });
  const commit = writeFixtureRepo(out);
  // A signed branch is published already, at this commit: nothing to push.
  const signed = assertSignedBranchHolds(commit, 'this tree');
  console.log(commit);
  if (!signed) {
    console.log(`\nPublished once, as ${FIXTURE_BRANCH} of ${GITHUB_REPO}, and never deleted or moved:`);
    console.log(`  git fetch ${out} main && git push origin FETCH_HEAD:refs/heads/${FIXTURE_BRANCH}`);
  }
  for (const f of SIGNED_FIXTURES) console.log(`${f.branch} stays at ${f.commit}: the listings in ${f.signed} are signed on it.`);
}

// ------------------------------------------------------------------ images

/** The image's unpacked size: the sum of its layers as the daemon lists them, as the runner's listing check measures it. */
function unpackedBytes(ref, platform) {
  const run = (args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  const built = run(['image', 'inspect', '--format', '{{.Os}}/{{.Architecture}}', ref]).trim();
  if (built !== platform) throw new Error(`${ref} is ${built}, not ${platform}`);
  const layers = run(['history', '--human=false', '--no-trunc', '--format', '{{.Size}}', ref]).split('\n').map((l) => l.trim()).filter(Boolean);
  if (!layers.length || !layers.every((l) => /^[0-9]{1,15}$/.test(l))) throw new Error(`docker history did not list the layer sizes of ${ref}`);
  return layers.reduce((n, l) => n + Number(l), 0);
}

/** Push `image` under `target` with the caller's own docker login. Gives its digest in that repository and its size. */
function push(image, target) {
  const repository = target.slice(0, target.lastIndexOf(':'));
  const run = (args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  run(['tag', image, target]);
  const size = unpackedBytes(target, PLATFORM);
  run(['push', target]);
  const digests = JSON.parse(run(['image', 'inspect', '--format', '{{json .RepoDigests}}', target]).trim() || '[]') || [];
  const found = digests.find((d) => d.startsWith(`${repository}@sha256:`));
  if (!found) throw new Error(`the push of ${target} left no digest in ${repository}: ${JSON.stringify(digests)}`);
  return { image: found, unpackedBytes: size, tag: target.slice(target.lastIndexOf(':') + 1) };
}

async function images(opts) {
  const repository = opts.repository || '';
  if (!REPOSITORY.test(repository) || !repository.startsWith(`${DEFAULT_REGISTRY_ALLOWLIST}/`)) {
    throw new Error(`--repository must name a repository under ${DEFAULT_REGISTRY_ALLOWLIST} (the only registry an arbiter pulls from by default), with no tag and no digest`);
  }
  if (!opts.out) throw new Error('--out must name the file to write');
  const outFile = path.resolve(opts.out);
  if (fs.existsSync(outFile)) throw new Error(`${outFile} exists`);
  process.env.CODE_RUNNER_RUNTIME = 'runc';
  process.env.CODE_RUNNER_PLATFORM = PLATFORM;
  const published = publishedFixtureCommit();
  const local = fixtureCommit();
  if (local !== published) throw new Error(`${FIXTURE_BRANCH} holds ${published}, and this checkout's fixture commits as ${local}`);

  const { buildFixture, H, CANARY } = runnerFixtures();
  const docker = H.dockerFor(H.dockerTestConfig());
  const instance = `l4${crypto.randomBytes(4).toString('hex')}`;
  const word = crypto.randomBytes(8).toString('hex');
  const publish = async (env, tag) => {
    const built = await buildFixture(docker, { ...CANARY, instance, env });
    try {
      if (built.baseCommit !== published) throw new Error(`the image's repository is at ${built.baseCommit}, not ${published}`);
      return push(built.image, `${repository}:${tag}`);
    } finally {
      await built.remove();
    }
  };
  // The cold and gone images differ from the fixture image by an ENV line: the same layers, another digest.
  const listings = {
    listing: await publish([], 'l4'),
    'registry-failure': await publish([`L4_GONE=${word}`], `l4-gone-${word}`),
    'cold-cache': await publish([`L4_COLD=${word}`], `l4-cold-${word}`)
  };
  if (new Set(LISTINGS.map((n) => digestOf(listings[n].image))).size !== LISTINGS.length) throw new Error('two of the images have one digest');
  const record = { version: 1, repository, fixture: { repo: FIXTURE_REPO, branch: FIXTURE_BRANCH, commit: published }, listings };
  fs.writeFileSync(outFile, `${JSON.stringify(record, null, 2)}\n`);
  for (const name of LISTINGS) console.log(`${name.padEnd(17)} ${listings[name].image}  (tag ${listings[name].tag}, ${listings[name].unpackedBytes} bytes unpacked)`);
  console.log(`\nWrote ${outFile}. Make ${repository} public, then: node scripts/prepare-l4-listings.js specs --images ${outFile} --out <a new directory>`);
}

// ------------------------------------------------------------------ specs

function readImages(file) {
  const record = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
  if (!record || record.version !== 1 || !record.fixture || !record.listings) throw new Error(`${file} is not what images wrote`);
  const baseCommit = record.fixture.commit;
  if (!COMMIT.test(baseCommit || '')) throw new Error(`${file}: the fixture commit must be a whole commit hash`);
  const digests = new Set();
  for (const name of LISTINGS) {
    const l = record.listings[name];
    if (!l || !IMAGE.test(l.image || '')) throw new Error(`${file}: the ${name} image must be named by digest: <repository>@sha256:<64 hex>`);
    // A signature on a listing a default arbiter will not pull is wasted, and would settle a claim as an abstention.
    if (!l.image.startsWith(`${DEFAULT_REGISTRY_ALLOWLIST}/`)) throw new Error(`${file}: ${l.image} is outside ${DEFAULT_REGISTRY_ALLOWLIST}, the only registry an arbiter pulls from by default`);
    // The digest is what a runner caches by, so one digest under two names is one image.
    if (digests.has(digestOf(l.image))) throw new Error(`${file}: each listing needs a digest of its own, and ${name} repeats one`);
    digests.add(digestOf(l.image));
    // Its unpackedBytes is what this host's daemon said, a note: the size a spec states is the runner's (check).
  }
  return { baseCommit, listings: record.listings };
}

function specs(opts) {
  if (!opts.images) throw new Error('--images must name the file images wrote');
  const { baseCommit, listings } = readImages(opts.images);
  const out = newDirectory(opts.out, '--out');
  const published = publishedFixtureCommit();
  if (published !== baseCommit) throw new Error(`the images hold ${baseCommit}, and ${FIXTURE_BRANCH} holds ${published}`);

  const requests = { version: 1, repo: FIXTURE_REPO, baseCommit, listings: {} };
  const files = {};
  for (const name of LISTINGS) {
    const { recipient } = codeReview.generateDisclosureKeyPair();
    const spec = F.specFor({ image: listings[name].image, baseCommit, disclosureKey: recipient, repo: FIXTURE_REPO, unpackedBytes: UNMEASURED });
    const valid = codeReview.validateCodeReviewSpec(spec);
    if (!valid.ok) throw new Error(`the ${name} spec would be refused: ${JSON.stringify(valid.issues)}`);
    // code_review.json comes later: prepare writes the spec the run checked, at the size the runner measured.
    files[name] = { 'known_issues.json': F.bytes([]) };
    requests.listings[name] = { spec, image: spec.env.image, deadline: CHECK_DEADLINE_MS };
  }
  const requestBytes = Buffer.from(`${JSON.stringify(requests)}\n`);
  const input = requestBytes.toString('base64').length;
  if (input > DISPATCH_INPUT_LIMIT) throw new Error(`the requests are ${input} characters in base64; a dispatch input holds ${DISPATCH_INPUT_LIMIT}`);

  for (const name of LISTINGS) {
    fs.mkdirSync(path.join(out, name, 'members'), { recursive: true });
    for (const [file, bytes] of Object.entries(files[name])) fs.writeFileSync(path.join(out, name, 'members', file), bytes);
  }
  const requestsFile = path.join(out, REQUESTS);
  fs.writeFileSync(requestsFile, requestBytes);
  console.log(`Wrote ${out}: ${REQUESTS} (sha256 ${sha256(requestBytes)}), three specs whose size the check measures.\n`);
  console.log('Run the runner\'s listing check on them in CI, then take that run:');
  console.log(`  gh workflow run e2e.yml -R ${GITHUB_REPO} --ref ${L4_BRANCH} -f l4_listing_requests="$(base64 < ${requestsFile} | tr -d '\\n')"`);
  console.log(`  gh run list -R ${GITHUB_REPO} --workflow e2e.yml --event workflow_dispatch --branch ${L4_BRANCH} --limit 1`);
  console.log(`  node scripts/prepare-l4-listings.js prepare --dir ${out} --run <its id>`);
}

/** The requests specs wrote, as check and prepare hold them. */
function readRequests(record, { selfCheck = false } = {}) {
  if (!record || record.version !== 1 || record.repo !== FIXTURE_REPO || !COMMIT.test(record.baseCommit || '') || !record.listings) {
    throw new Error('the requests are not what specs wrote');
  }
  const names = Object.keys(record.listings);
  const expected = selfCheck ? ['listing'] : LISTINGS;
  if (names.length !== expected.length || !expected.every((n) => names.includes(n))) throw new Error(`the requests name ${names.join(', ')}, not ${expected.join(', ')}`);
  for (const name of names) {
    const body = record.listings[name];
    const keys = Object.keys(body || {}).sort();
    if (keys.join() !== 'deadline,image,spec') throw new Error(`the ${name} request holds ${keys.join(', ')}`);
    if (!IMAGE.test(body.image || '') || (!selfCheck && !body.image.startsWith(`${DEFAULT_REGISTRY_ALLOWLIST}/`))) throw new Error(`the ${name} request's image is not an image under ${DEFAULT_REGISTRY_ALLOWLIST} by digest`);
    const spec = body.spec || {};
    if (!spec.env || spec.env.image !== body.image || spec.repo !== FIXTURE_REPO || spec.baseCommit !== record.baseCommit || body.deadline !== CHECK_DEADLINE_MS) {
      throw new Error(`the ${name} request's spec does not name its image, ${FIXTURE_REPO} and ${record.baseCommit}`);
    }
  }
  return record;
}

// ------------------------------------------------------------------ check (CI)

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** One request to the runner. No client timeout but the socket's, since a listing check answers only when it is done. */
function request(runner, method, pathname, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const data = body === null ? null : Buffer.from(JSON.stringify(body));
    const headers = { authorization: `Bearer ${runner.token}`, ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}) };
    const req = http.request(`${runner.url}${pathname}`, { method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('error', reject);
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let response = null;
        try {
          response = JSON.parse(text);
        } catch {
          // kept as text below
        }
        resolve({ httpStatus: res.statusCode, response, ...(response === null ? { text: text.slice(0, 4000) } : {}) });
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`no answer in ${timeoutMs} ms`)));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

/** The runner as an operator runs it (`npm start`), on loopback, with a token of its own and an environment of nothing else. */
async function startRunner({ runtime, platform, allowlist, logFile }) {
  const port = await freePort();
  const token = crypto.randomBytes(32).toString('hex');
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'l4-runner-'));
  const log = fs.openSync(logFile, 'a');
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME || os.tmpdir(),
    CODE_RUNNER_HOST: '127.0.0.1',
    CODE_RUNNER_PORT: String(port),
    CODE_RUNNER_TOKEN: token,
    CODE_RUNNER_RUNTIME: runtime,
    CODE_RUNNER_PLATFORM: platform,
    CODE_RUNNER_STATE_DIR: state,
    ...(process.env.DOCKER_HOST ? { DOCKER_HOST: process.env.DOCKER_HOST } : {}),
    ...(allowlist ? { CODE_RUNNER_REGISTRY_ALLOWLIST: allowlist } : {})
  };
  const child = spawn(process.execPath, [path.join(CODE_RUNNER, 'src', 'index.js')], { cwd: CODE_RUNNER, env, stdio: ['ignore', log, log] });
  let exited = null;
  const done = new Promise((resolve) => child.on('exit', (code, signal) => {
    exited = { code, signal };
    resolve();
  }));
  const runner = {
    url: `http://127.0.0.1:${port}`,
    token,
    stop: async () => {
      if (!exited) {
        child.kill('SIGTERM');
        await Promise.race([done, sleep(120000)]);
        if (!exited) child.kill('SIGKILL');
        await done;
      }
      fs.closeSync(log);
      fs.rmSync(state, { recursive: true, force: true });
    }
  };
  const until = Date.now() + 120000;
  for (;;) {
    if (exited) {
      await runner.stop();
      throw new Error(`the runner exited (${JSON.stringify(exited)}) before it answered; its log: ${fs.readFileSync(logFile, 'utf8').slice(-2000)}`);
    }
    try {
      const health = await request(runner, 'GET', '/health', null, 10000);
      console.log(`runner ${RUNNER_VERSION} up under ${runtime}: /health ${health.httpStatus}`);
      return runner;
    } catch (error) {
      if (Date.now() > until) {
        await runner.stop();
        throw new Error(`the runner did not answer in 120 s: ${error.message}`);
      }
      await sleep(1000);
    }
  }
}

/** The base image an env image says it is built FROM: common's pin for env.from, for this platform. */
function basePin(from, platform) {
  const pin = RUNNER_COMMON.BASE_IMAGE_PINS[from];
  if (!pin) throw new Error(`@verdikta/common pins no base image for ${from}`);
  return { reference: pin.reference, pull: platform === pin.platform ? `${pin.repository}@${pin.digest}` : `${pin.repository}@${pin.indexDigest}` };
}

/**
 * That `image` is built on `from`'s pinned base: the base's layers are the image's first layers, by their
 * uncompressed digests. Both are pulled by digest here, so what is compared is what the registry serves.
 */
function verifiedBase(image, from, platform) {
  const pin = basePin(from, platform);
  const docker = (args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const layers = (ref) => {
    docker(['pull', '--quiet', '--platform', platform, ref]);
    const list = JSON.parse(docker(['image', 'inspect', '--format', '{{json .RootFS.Layers}}', ref]).trim() || 'null');
    if (!Array.isArray(list) || !list.length) throw new Error(`docker listed no layers for ${ref}`);
    return list;
  };
  const base = layers(pin.pull);
  const own = layers(image);
  if (base.length >= own.length || !base.every((digest, i) => own[i] === digest)) {
    throw new Error(`${image} is not built on ${pin.reference}: its first ${base.length} layers are not the base's`);
  }
  return { reference: pin.reference, layers: base.length };
}

/** The gVisor release docker's runsc is. */
function runscRelease() {
  const runtimes = JSON.parse(execFileSync('docker', ['info', '--format', '{{json .Runtimes}}'], { encoding: 'utf8' }));
  const runsc = runtimes && runtimes.runsc;
  if (!runsc || !runsc.path) throw new Error('docker has no runsc runtime');
  const m = /release-[0-9]{8}\.[0-9]+/.exec(execFileSync(runsc.path, ['--version'], { encoding: 'utf8' }));
  if (!m) throw new Error(`${runsc.path} --version names no release`);
  return m[0];
}

/**
 * The fixture branch for a self-check, before anything is built: the commit it holds, which must be this checkout's
 * fixture commit, or null while it is not published. A new fixture's branch is published once the change that makes
 * it has merged, and that change runs the self-check first. Nothing that leads to a signature takes an unpublished
 * branch: images, specs, a check of requests and prepare each refuse one. A signed branch is held to its own commit
 * first, published or not, so no fixture that commits as another is told the branch must hold it.
 */
function selfCheckBranch(local) {
  assertSignedBranchHolds(local, 'the fixture written here');
  const published = publishedFixtureCommit({ unpublished: true });
  if (published === null) {
    console.log(`${FIXTURE_BRANCH} is not published yet: it must hold this checkout's fixture commit, ${local}, before images, specs, a check of requests or prepare.`);
  } else if (published !== local) {
    throw new Error(`${FIXTURE_BRANCH} holds ${published}, and the fixture written here commits as ${local}`);
  }
  return published;
}

/** The fixture built here, through a local registry, as one request: the path runs in CI on every change. */
async function selfCheckRequests(cleanup, platform, local) {
  process.env.VCR_TEST_FIXTURE_REGISTRY = '1';
  process.env.CODE_RUNNER_PLATFORM = platform;
  const { buildFixture, H, CANARY } = runnerFixtures();
  const docker = H.dockerFor(H.dockerTestConfig());
  const built = await buildFixture(docker, { ...CANARY, instance: `l4s${crypto.randomBytes(4).toString('hex')}` });
  cleanup.push(built.remove);
  if (built.baseCommit !== local) throw new Error(`the image's repository is at ${built.baseCommit}, and the fixture written here commits as ${local}`);
  const spec = F.specFor({
    image: built.image, baseCommit: built.baseCommit, disclosureKey: codeReview.generateDisclosureKeyPair().recipient,
    repo: FIXTURE_REPO, unpackedBytes: UNMEASURED
  });
  const requests = { version: 1, repo: FIXTURE_REPO, baseCommit: built.baseCommit, listings: { listing: { spec, image: built.image, deadline: CHECK_DEADLINE_MS } } };
  return { requests: readRequests(requests, { selfCheck: true }), allowlist: built.image.slice(0, built.image.indexOf('/')) };
}

function accepted(l, runtime) {
  const r = l.response || {};
  return l.httpStatus === 200 && r.outcome === 'definitive' && Boolean(r.listing) && r.listing.status === 'accepted' && Boolean(r.runner) && r.runner.runtime === runtime;
}

async function check(opts) {
  if (Boolean(opts.selfCheck) === Boolean(opts.requests)) throw new Error('pass exactly one of --requests and --self-check');
  if (!opts.out) throw new Error('--out must name the file to write');
  const outFile = path.resolve(opts.out);
  if (fs.existsSync(outFile)) throw new Error(`${outFile} exists`);
  const runtime = process.env.CODE_RUNNER_RUNTIME || 'runsc';
  const platform = opts.selfCheck ? (process.env.CODE_RUNNER_PLATFORM || PLATFORM) : PLATFORM;
  const cleanup = [];
  try {
    let requests;
    let requestsSha256 = null;
    let allowlist = null;
    let published;
    if (opts.requests) {
      if (runtime !== 'runsc') throw new Error('a listing check for a signature runs under runsc: the statement names the gVisor release it ran with');
      const bytes = fs.readFileSync(path.resolve(opts.requests));
      requestsSha256 = sha256(bytes);
      requests = readRequests(JSON.parse(bytes.toString('utf8')));
      published = publishedFixtureCommit();
      if (published !== requests.baseCommit) throw new Error(`the requests name ${requests.baseCommit}, and ${FIXTURE_BRANCH} holds ${published}`);
    } else {
      const local = fixtureCommit();
      published = selfCheckBranch(local);
      ({ requests, allowlist } = await selfCheckRequests(cleanup, platform, local));
    }
    const gvisor = runtime === 'runsc' ? runscRelease() : null;
    if (runtime === 'runsc' && gvisor !== RUNNER_COMMON.GVISOR_RELEASE) throw new Error(`docker's runsc is ${gvisor}; the runner pins ${RUNNER_COMMON.GVISOR_RELEASE}`);

    const bases = {};
    for (const [name, body] of Object.entries(requests.listings)) {
      bases[name] = verifiedBase(body.image, body.spec.env.from, platform);
      console.log(`${name}: built on ${bases[name].reference} (its first ${bases[name].layers} layers)`);
    }

    const runner = await startRunner({ runtime, platform, allowlist, logFile: `${outFile}.runner.log` });
    cleanup.push(runner.stop);
    const pass = async (label, all) => {
      const answers = {};
      for (const [name, body] of Object.entries(all.listings)) {
        console.log(`${name}: ${label} ${body.image} at ${body.spec.env.unpackedBytes} bytes`);
        answers[name] = { image: body.image, base: bases[name], specSha256: sha256(F.bytes(body.spec)), ...(await request(runner, 'POST', '/v1/listing-checks', body, body.deadline + 120000)) };
        const r = answers[name].response || {};
        console.log(`${name}: ${answers[name].httpStatus} ${r.outcome || ''} ${r.listing ? r.listing.status : ''} ${r.listing ? JSON.stringify(r.listing.refusals) : answers[name].text || ''}`);
      }
      return answers;
    };
    // First pass: the runner measures each image. Second: the specs at that size, the bytes prepare will sign.
    const first = await pass('measuring', requests);
    const sizing = {};
    const checked = { ...requests, listings: {} };
    for (const [name, body] of Object.entries(requests.listings)) {
      const r = first[name].response || {};
      const measured = r.listing && r.listing.image ? r.listing.image.unpackedBytes : null;
      if (!Number.isSafeInteger(measured) || measured < 1) throw new Error(`${name}: the runner measured no size: ${JSON.stringify(first[name]).slice(0, 2000)}`);
      sizing[name] = { declared: body.spec.env.unpackedBytes, measured };
      checked.listings[name] = { ...body, spec: { ...body.spec, env: { ...body.spec.env, unpackedBytes: measured } } };
    }
    const listings = await pass('checking', checked);
    const measurement = {
      version: 1,
      kind: 'l4-listing-check',
      mode: opts.selfCheck ? 'self-check' : 'dispatch',
      requestsSha256,
      repo: requests.repo,
      baseCommit: requests.baseCommit,
      fixture: { branch: FIXTURE_BRANCH, commit: published },
      runner: { version: RUNNER_VERSION, common: RUNNER_COMMON.COMMON_VERSION, runtime, platform },
      code: codeFingerprint(),
      gvisor,
      // Semgrep runs on a claim's PoC, not in a listing check: this is the rule set the release in this run pins.
      semgrepRules: { pinned: RUNNER_COMMON.SEMGREP_RULES_VERSION, ran: false },
      github: { runId: process.env.GITHUB_RUN_ID || null, sha: process.env.GITHUB_SHA || null, ref: process.env.GITHUB_REF || null },
      sizing,
      checked,
      listings
    };
    fs.writeFileSync(outFile, `${JSON.stringify(measurement, null, 2)}\n`);
    const refused = Object.entries(listings).filter(([, l]) => !accepted(l, runtime)).map(([name]) => name);
    if (refused.length) throw new Error(`not accepted: ${refused.join(', ')}. What the runner answered is in ${outFile}`);
    if (opts.selfCheck && runtime === 'runsc' && platform === PLATFORM) {
      // What prepare holds each answer to, against a real runner's: the size, the image, the baseline.
      for (const [name, body] of Object.entries(checked.listings)) {
        const baseline = measuredBaseline(name, measurement, body.spec);
        console.log(`${name}: prepare would take it: ${baseline.stable.length} stable, ${baseline.unstable.length} unstable, at ${baseline.baseCommit}`);
      }
    }
    console.log(`\nEvery listing accepted. Wrote ${outFile}.`);
  } finally {
    for (const fn of cleanup.reverse()) {
      try {
        await fn();
      } catch (error) {
        console.error(`cleanup: ${error.message}`);
      }
    }
  }
}

// ------------------------------------------------------------------ prepare

function gh(args) {
  try {
    return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    throw new Error(`gh ${args.slice(0, 2).join(' ')} failed: ${String(error.stderr || error.message).trim()}`);
  }
}

/** The run, held to being the one that may have measured these listings, and its measurement. */
function measuredRun(id) {
  const run = JSON.parse(gh(['api', `repos/${GITHUB_REPO}/actions/runs/${id}`]));
  const facts = [
    [String(run.id) === id, `answered as run ${run.id}`],
    [Boolean(run.repository) && run.repository.full_name === GITHUB_REPO, `is not a run of ${GITHUB_REPO}`],
    [Boolean(run.head_repository) && run.head_repository.full_name === GITHUB_REPO, `ran code from ${run.head_repository && run.head_repository.full_name}`],
    [run.path === WORKFLOW, `is ${run.path}, not ${WORKFLOW}`],
    [run.event === 'workflow_dispatch', `was started by ${run.event}, not a dispatch`],
    [run.head_branch === L4_BRANCH, `ran on ${run.head_branch}, not ${L4_BRANCH}`],
    [run.status === 'completed' && run.conclusion === 'success', `is ${run.status}, ${run.conclusion}: not a success`]
  ];
  for (const [ok, what] of facts) if (!ok) throw new Error(`run ${id} ${what}`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'l4-measurement-'));
  try {
    gh(['run', 'download', id, '-R', GITHUB_REPO, '-n', ARTIFACT, '-D', tmp]);
    return { run, bytes: fs.readFileSync(path.join(tmp, MEASUREMENT)) };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function checkMeasurement(m, { run, requestsSha256, requests }) {
  const runner = m.runner || {};
  const facts = [
    [m.version === 1 && m.kind === 'l4-listing-check', 'is not a listing-check measurement'],
    [m.mode === 'dispatch', `is a ${m.mode} run, which checks no listing a signature may cover`],
    [m.requestsSha256 === requestsSha256, `checked other requests than this directory's ${REQUESTS}`],
    [Boolean(m.github) && String(m.github.runId) === String(run.id) && m.github.sha === run.head_sha, 'was written by another run'],
    [runner.version === RUNNER_VERSION, `ran runner ${runner.version}; this checkout's is ${RUNNER_VERSION}`],
    [runner.common === COMMON_VERSION, `ran @verdikta/common ${runner.common}; this checkout's is ${COMMON_VERSION}`],
    [runner.runtime === 'runsc' && runner.platform === PLATFORM, `ran under ${runner.runtime} on ${runner.platform}, not runsc on ${PLATFORM}`],
    ...Object.entries(codeFingerprint()).map(([part, hash]) => [Boolean(m.code) && m.code[part] === hash,
      `ran another ${part} than this checkout's (${m.code && m.code[part]}, here ${hash}): check out the run's commit ${run.head_sha}, with nothing changed`]),
    [m.gvisor === codeReview.GVISOR_RELEASE, `ran gVisor ${m.gvisor}; @verdikta/common pins ${codeReview.GVISOR_RELEASE}`],
    [Boolean(m.semgrepRules) && m.semgrepRules.pinned === codeReview.SEMGREP_RULES_VERSION, 'names another Semgrep rule set than @verdikta/common pins'],
    [m.baseCommit === requests.baseCommit && Boolean(m.fixture) && m.fixture.commit === requests.baseCommit, `checked ${m.baseCommit}, not ${requests.baseCommit}`]
  ];
  for (const [ok, what] of facts) if (!ok) throw new Error(`the measurement ${what}`);
}

/** What the runner measured for one listing, held to the spec that will be signed. Gives the baseline as it measured it. */
function measuredBaseline(name, m, spec) {
  const l = (m.listings || {})[name];
  if (!l) throw new Error(`the run measured no ${name} listing`);
  const r = l.response || {};
  const listing = r.listing || {};
  const image = listing.image || {};
  const facts = [
    [l.httpStatus === 200 && r.outcome === 'definitive', `the check did not finish: ${l.httpStatus} ${r.outcome}`],
    [listing.status === 'accepted' && Array.isArray(listing.refusals) && listing.refusals.length === 0, `the runner did not accept it: ${JSON.stringify(listing.refusals)}`],
    [Boolean(r.runner) && r.runner.version === RUNNER_VERSION && r.runner.runtime === 'runsc' && r.runner.platform === PLATFORM, `the runner answered as ${JSON.stringify(r.runner)}`],
    [l.image === spec.env.image && image.ref === spec.env.image, `the runner checked ${image.ref}, not ${spec.env.image}`],
    [image.unpackedBytes === spec.env.unpackedBytes, `the runner measured ${image.unpackedBytes} bytes unpacked, and the spec says ${spec.env.unpackedBytes}`],
    [Boolean(l.base) && l.base.reference === basePin(spec.env.from, PLATFORM).reference && Number.isInteger(l.base.layers) && l.base.layers > 0,
      `the run did not find the image built on ${basePin(spec.env.from, PLATFORM).reference}: ${JSON.stringify(l.base)}`]
  ];
  for (const [ok, what] of facts) if (!ok) throw new Error(`${name}: ${what}`);
  const baseline = listing.baseline;
  const valid = codeReview.validateBaseline(baseline, spec);
  if (!valid.ok) throw new Error(`${name}: the measured baseline does not validate: ${JSON.stringify(valid.issues)}`);
  if (baseline.baseCommit !== spec.baseCommit) throw new Error(`${name}: the measured baseline is for ${baseline.baseCommit}, not ${spec.baseCommit}`);
  return baseline;
}

/** The script to run where the key can sign. It holds the bytes; the key's name comes from its environment. */
function signingScript(messages) {
  const lines = [
    '#!/usr/bin/env bash',
    '# Signs the L4 claim listings with the production builder key. Written by prepare-l4-listings.js.',
    '# It holds the bytes to sign, which are public, and no key name or secret.',
    '#   BUILDER_KEY=<the key id or ARN> bash sign-in-cloudshell.sh',
    'set -euo pipefail',
    'shopt -s inherit_errexit 2>/dev/null || true',
    ': "${BUILDER_KEY:?set BUILDER_KEY to the builder key}"',
    'work=$(mktemp -d)',
    'trap \'rm -rf "$work"\' EXIT',
    'sign() {',
    '  printf \'%s\' "$2" | base64 -d > "$work/$1"',
    '  aws kms sign --key-id "$BUILDER_KEY" --message-type RAW --signing-algorithm ED25519_SHA_512 \\',
    '    --message "fileb://$work/$1" --query Signature --output text',
    '}'
  ];
  const variable = (name) => `sig_${name.replace(/-/g, '_')}`;
  for (const [name, bytes] of Object.entries(messages)) lines.push(`${variable(name)}=$(sign ${name} '${bytes.toString('base64')}')`);
  lines.push('cat > signatures.json <<JSON', '{');
  Object.keys(messages).forEach((name, i, all) => lines.push(`  "${name}": "\${${variable(name)}}"${i < all.length - 1 ? ',' : ''}`));
  lines.push('}', 'JSON', 'cat signatures.json', '');
  return lines.join('\n');
}

/** What an arbiter's front gates hold a listing to, before anyone signs what they would refuse. */
function assertFrontGates(name, { spec, members }, baseline) {
  const checks = {
    spec: codeReview.validateCodeReviewSpec(spec),
    baseline: codeReview.validateBaseline(baseline, spec),
    'known issues': codeReview.validateKnownIssues(JSON.parse(members['known_issues.json'].toString('utf8'))),
    panel: codeReview.validateClassEnvelope(JSON.parse(members['manifest.json'].toString('utf8')).juryParameters, CODE_CLASS)
  };
  for (const [what, result] of Object.entries(checks)) {
    if (!result.ok) throw new Error(`the ${name} listing's ${what} would be refused: ${JSON.stringify(result.issues)}`);
  }
}

function prepare(opts) {
  if (!opts.dir) throw new Error('--dir must name the directory specs wrote');
  const dir = path.resolve(opts.dir);
  if (!RUN_ID.test(opts.run || '')) throw new Error('--run must be the id of the e2e.yml run that checked these listings');
  const requestsFile = path.join(dir, REQUESTS);
  if (!fs.existsSync(requestsFile)) throw new Error(`${dir} has no ${REQUESTS}: run specs first`);
  for (const file of ['sign-in-cloudshell.sh', MEASUREMENT, ...LISTINGS.map((n) => path.join(n, 'statement.json'))]) {
    if (fs.existsSync(path.join(dir, file))) throw new Error(`${dir} is prepared already: run specs into a new directory`);
  }
  const requestBytes = fs.readFileSync(requestsFile);
  const requests = readRequests(JSON.parse(requestBytes.toString('utf8')));
  const published = publishedFixtureCommit();
  if (published !== requests.baseCommit) throw new Error(`the specs name ${requests.baseCommit}, and ${FIXTURE_BRANCH} holds ${published}`);
  const { run, bytes } = measuredRun(opts.run);
  const measurement = JSON.parse(bytes.toString('utf8'));
  checkMeasurement(measurement, { run, requestsSha256: sha256(requestBytes), requests });

  // What the second pass checked: these requests, each spec at the size the first pass measured, and nothing else.
  const checked = readRequests(measurement.checked);
  if (checked.baseCommit !== requests.baseCommit) throw new Error(`the run checked ${checked.baseCommit}, not ${requests.baseCommit}`);
  const prepared = {};
  for (const name of LISTINGS) {
    const member = (file) => fs.readFileSync(path.join(dir, name, 'members', file));
    const spec = checked.listings[name].spec;
    const asked = requests.listings[name].spec;
    if (!isDeepStrictEqual({ ...spec, env: { ...spec.env, unpackedBytes: asked.env.unpackedBytes } }, asked)) {
      throw new Error(`${name}: the run checked another spec than specs wrote, not only another size`);
    }
    const baseline = measuredBaseline(name, measurement, spec);
    const codeReviewBytes = F.bytes(spec);
    if (sha256(codeReviewBytes) !== measurement.listings[name].specSha256) throw new Error(`${name}: the run checked other bytes than these for code_review.json`);
    const files = { codeReview: codeReviewBytes, baseline: F.bytes(baseline), knownIssues: member('known_issues.json') };
    const statement = codeReview.createAttestationStatement({
      files,
      trust: 'production',
      base: measurement.listings[name].base.reference,
      tools: { runner: measurement.runner.version, gvisor: measurement.gvisor, semgrepRules: measurement.semgrepRules.pinned }
    });
    assertFrontGates(name, { spec, members: F.listingMembers(files) }, baseline);
    const message = codeReview.attestationSigningBytes(statement);
    if (message.length > SIGNING_MESSAGE_LIMIT) throw new Error(`the ${name} listing's statement is ${message.length} bytes; the signing service takes ${SIGNING_MESSAGE_LIMIT}`);
    prepared[name] = { codeReview: files.codeReview, baseline: files.baseline, statement, message };
  }

  const messages = {};
  for (const [name, { codeReview: specBytes, baseline, statement, message }] of Object.entries(prepared)) {
    fs.writeFileSync(path.join(dir, name, 'members', 'code_review.json'), specBytes);
    fs.writeFileSync(path.join(dir, name, 'members', 'baseline.json'), baseline);
    fs.writeFileSync(path.join(dir, name, 'statement.json'), `${JSON.stringify(statement, null, 2)}\n`);
    fs.writeFileSync(path.join(dir, name, 'signing-bytes.bin'), message);
    messages[name] = message;
    console.log(`${name.padEnd(17)} ${String(message.length).padStart(5)} bytes to sign (limit ${SIGNING_MESSAGE_LIMIT})  ${statement.env.image}`);
  }
  fs.writeFileSync(path.join(dir, MEASUREMENT), bytes);
  const script = path.join(dir, 'sign-in-cloudshell.sh');
  fs.writeFileSync(script, signingScript(messages), { mode: 0o755 });
  console.log(`\nFrom run ${run.id} (${run.head_sha}). Wrote ${dir}. Run ${path.basename(script)} where the builder key can sign, and bring back signatures.json.`);
}

// ------------------------------------------------------------------ attach

/** The one key `attach` names: the set's own entry, so a signature is only ever checked against what arbiters trust. */
function productionKeyId() {
  const keys = codeReview.PRODUCTION_BUILDER_KEYS.filter((k) => !k.retiredAt);
  if (keys.length !== 1) throw new Error(`@verdikta/common's builder set has ${keys.length} keys in use: this expects one`);
  return keys[0].keyId;
}

function attach(opts) {
  const dir = path.resolve(opts.dir || '');
  if (!opts.dir || !fs.existsSync(dir)) throw new Error('--dir must name the directory prepare wrote');
  const signaturesFile = path.resolve(opts.signatures || path.join(dir, 'signatures.json'));
  const signatures = JSON.parse(fs.readFileSync(signaturesFile, 'utf8'));
  const keyId = productionKeyId();

  const archives = {};
  for (const name of LISTINGS) {
    const value = signatures[name];
    if (typeof value !== 'string' || !SIGNATURE.test(value)) throw new Error(`${signaturesFile} has no 64-byte base64 signature for ${name}`);
    const statement = JSON.parse(fs.readFileSync(path.join(dir, name, 'statement.json'), 'utf8'));
    if (!codeReview.attestationSigningBytes(statement).equals(fs.readFileSync(path.join(dir, name, 'signing-bytes.bin')))) {
      throw new Error(`${name}: statement.json is not the statement signing-bytes.bin came from`);
    }
    const member = (file) => fs.readFileSync(path.join(dir, name, 'members', file));
    const members = F.listingMembers({ codeReview: member('code_review.json'), baseline: member('baseline.json'), knownIssues: member('known_issues.json') });
    const buffer = F.listingArchive(members, { ...statement, signature: { algorithm: codeReview.ATTESTATION_SIGNATURE_ALGORITHM, keyId, value } });
    const verified = F.verifyProductionTrust(buffer);
    if (!verified.ok) throw new Error(`${name} does not verify in production trust: ${verified.issues.map((i) => `${i.code} (${i.detail})`).join('; ')}`);
    for (const warning of verified.warnings) console.log(`${name}: ${warning.code}: ${warning.detail}`);
    archives[name] = buffer;
  }
  const file = (name) => path.join(dir, `${name}.zip`);
  for (const [name, buffer] of Object.entries(archives)) {
    fs.writeFileSync(file(name), buffer);
    console.log(`${name.padEnd(17)} verifies in production trust under key ${keyId}: ${file(name)}`);
  }
  console.log('\nNext, check, then pin:');
  const args = `--listing-file ${file('listing')} --registry-failure-listing-file ${file('registry-failure')} --cold-listing-file ${file('cold-cache')}`;
  console.log(`  node scripts/build-l4-claims.js ${args} --dry-run`);
  console.log(`  IPFS_PINNING_KEY=<pinata-jwt> node scripts/build-l4-claims.js ${args} --pin`);
}

const fail = (error) => {
  console.error(`prepare-l4-listings: ${error.message}`);
  process.exit(1);
};
const guarded = (fn) => (opts) => Promise.resolve().then(() => fn(opts)).catch(fail);

program.command('fixture-repo')
  .description('write the fixture repository and print its commit')
  .option('--out <dir>', 'a new directory')
  .action(guarded(fixtureRepo));
program.command('images')
  .description('build the three images of the fixture commit, push them, and write images.json')
  .option('--repository <name>', `where every canary may pull from, under ${DEFAULT_REGISTRY_ALLOWLIST}`)
  .option('--out <file>', 'the file to write (images.json)')
  .action(guarded(images));
program.command('specs')
  .description('write the three specs and the listing-check requests for CI')
  .option('--images <file>', 'the file images wrote')
  .option('--out <dir>', 'a new directory')
  .action(guarded(specs));
program.command('check')
  .description('(CI) run the runner\'s listing check on each request under runsc, and write what it measured')
  .option('--requests <file>', 'the check-requests.json specs wrote')
  .option('--self-check', 'build the fixture and check it through a local registry (never signed)')
  .option('--out <file>', 'the measurement to write')
  .action(guarded(check));
program.command('prepare')
  .description('take the CI run\'s measurement, and write the statements and the bytes to sign')
  .option('--dir <dir>', 'the directory specs wrote')
  .option('--run <id>', 'the e2e.yml run that checked these listings')
  .action(guarded(prepare));
program.command('attach')
  .description('put the signatures in, verify in production trust, write the archives')
  .option('--dir <dir>', 'the directory prepare wrote')
  .option('--signatures <file>', 'the signing script\'s signatures.json (default: in --dir)')
  .action(guarded(attach));
program.parseAsync(process.argv).catch(fail);
