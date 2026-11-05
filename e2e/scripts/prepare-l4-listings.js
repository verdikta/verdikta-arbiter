#!/usr/bin/env node
'use strict';

/**
 * The L4 claim listings, signed with the production builder key. That key signs in a service
 * nothing here can reach, so this writes what it must sign, and later puts the answers in.
 *
 *   images   builds the fixture image and a second one with a fresh digest (the cold-cache
 *            scenario), for linux/amd64, and pushes both. Needs `docker login` to the registry.
 *   prepare  makes the three listings (the fixture image; the same repository on a digest no
 *            registry holds; the fresh digest), holds each to what an arbiter's front gates
 *            check, and writes the exact bytes to sign. It also writes sign-in-cloudshell.sh,
 *            which holds those bytes and no key name.
 *   attach   puts the signatures in, holds every listing to production trust, and writes the
 *            archives scripts/build-l4-claims.js takes. All of them or none. An archive holds
 *            the three files the statement binds, and a manifest and query made here from them.
 *
 * Nothing here holds or asks for a private key, and no signature is checked against anything but
 * @verdikta/common's builder set. A listing's disclosure key is its own: the private half is never
 * written, since nothing in the L4 path decrypts a claim.
 *
 * Needs `npm ci` in code-runner/ (the fixture repository) and here.
 */

const crypto = require('crypto');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { program } = require('commander');
const { codeReview } = require('@verdikta/common');
const F = require('../src/l2/claim/fixtures');

const CODE_RUNNER = path.join(__dirname, '..', '..', 'code-runner');
const { DEFAULT_REGISTRY_ALLOWLIST } = require(path.join(CODE_RUNNER, 'src', 'registry'));
const { RUNNER_VERSION } = require(path.join(CODE_RUNNER, 'src', 'version'));

/** The most a raw message may be in the service that holds the key. */
const SIGNING_MESSAGE_LIMIT = 4096;
/** A production signature on a fixture stays valid while the key is trusted: it names Verdikta's own, and chain 31337 in the spec. */
const FIXTURE_REPO = 'https://github.com/verdikta/stake-attestation-l4-fixture';
const LISTINGS = Object.freeze(['listing', 'registry-failure', 'cold-cache']);
/** The files a statement binds, by their names in the listing. */
const BOUND_FILES = Object.freeze(['code_review.json', 'baseline.json', 'known_issues.json']);
const CODE_CLASS = 'code-standard';
const IMAGE = /^[^@\s]+@sha256:[0-9a-f]{64}$/;
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const REPOSITORY = /^[a-z0-9.:/_-]+$/;
const SIGNATURE = /^[A-Za-z0-9+/]{86}==$/;
const PLATFORM = codeReview.CLASS_HARD_LIMITS.platform;

function runnerRepo() {
  try {
    return require(path.join(CODE_RUNNER, 'test', 'docker', 'forgeFixture'));
  } catch (error) {
    throw new Error(`cannot load the code runner's fixture repository (npm ci in code-runner/?): ${error.message}`);
  }
}

/**
 * Push `image` under `target` with the caller's own docker login. Gives its digest in that
 * repository and its unpacked size: the sum of its layers as the daemon lists them, as the builder
 * and the runner's listing check measure it. The statement says this number was measured.
 */
function push(image, target, platform) {
  const repository = target.slice(0, target.lastIndexOf(':'));
  const run = (args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  run(['tag', image, target]);
  const built = run(['image', 'inspect', '--format', '{{.Os}}/{{.Architecture}}', target]).trim();
  if (built !== platform) throw new Error(`${target} is ${built}, not ${platform}`);
  const layers = run(['history', '--human=false', '--no-trunc', '--format', '{{.Size}}', target]).split('\n').map((l) => l.trim()).filter(Boolean);
  if (!layers.length || !layers.every((l) => /^[0-9]{1,15}$/.test(l))) throw new Error(`docker history did not list the layer sizes of ${target}`);
  run(['push', target]);
  const digests = JSON.parse(run(['image', 'inspect', '--format', '{{json .RepoDigests}}', target]).trim() || '[]') || [];
  const found = digests.find((d) => d.startsWith(`${repository}@sha256:`));
  if (!found) throw new Error(`the push of ${target} left no digest in ${repository}: ${JSON.stringify(digests)}`);
  return { image: found, unpackedBytes: layers.reduce((n, l) => n + Number(l), 0) };
}

async function images(opts) {
  if (!REPOSITORY.test(opts.repository || '')) throw new Error('--repository must name a repository, with no tag and no digest');
  // The fixtures read these when they load: an image for the class platform, whatever this host is.
  process.env.CODE_RUNNER_RUNTIME = 'runc';
  process.env.CODE_RUNNER_PLATFORM = PLATFORM;
  const { buildFixture } = runnerRepo();
  const H = require(path.join(CODE_RUNNER, 'test', 'docker', 'helpers'));
  const { CANARY_IMAGE_OPTIONS } = require(path.join(CODE_RUNNER, 'test', 'docker', 'determinismPocs'));
  const docker = H.dockerFor(H.dockerTestConfig());
  const instance = `l4${crypto.randomBytes(4).toString('hex')}`;
  const word = crypto.randomBytes(8).toString('hex');

  const publish = async (options, tag) => {
    const built = await buildFixture(docker, { ...CANARY_IMAGE_OPTIONS, instance, ...options });
    try {
      return { baseCommit: built.baseCommit, ...push(built.image, `${opts.repository}:${tag}`, PLATFORM) };
    } finally {
      await built.remove();
    }
  };
  const main = await publish({}, 'l4');
  const cold = await publish({ env: [`L4_COLD=${word}`] }, `l4-cold-${word}`);
  if (main.baseCommit !== cold.baseCommit) throw new Error(`two builds of one repository gave ${main.baseCommit} and ${cold.baseCommit}`);
  if (main.image === cold.image) throw new Error('the cold-cache image has the fixture image\'s digest');
  console.log(`--image ${main.image}`);
  console.log(`--cold-image ${cold.image}`);
  console.log(`--base-commit ${main.baseCommit}`);
  // The cold image differs by an ENV line, which adds no layer bytes: the larger, so neither is understated.
  console.log(`--unpacked-bytes ${Math.max(main.unpackedBytes, cold.unpackedBytes)}`);
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
  if (!IMAGE.test(opts.image || '')) throw new Error('--image must name the env image by digest: <repository>@sha256:<64 hex>');
  if (!IMAGE.test(opts.coldImage || '')) throw new Error('--cold-image must name a fresh image by digest: <repository>@sha256:<64 hex>');
  // The digest is what a runner caches by, so the same digest under another name is not cold.
  if (opts.image.split('@')[1] === opts.coldImage.split('@')[1]) throw new Error('--cold-image must be another digest than --image');
  if (!COMMIT.test(opts.baseCommit || '')) throw new Error('--base-commit must be a whole commit hash');
  const unpackedBytes = Number(opts.unpackedBytes);
  if (!/^[0-9]+$/.test(opts.unpackedBytes || '') || !Number.isSafeInteger(unpackedBytes) || unpackedBytes < 1) throw new Error('--unpacked-bytes must be the size images printed, a whole number of bytes');
  if (unpackedBytes > codeReview.CLASS_HARD_LIMITS.imageUnpackedBytes) throw new Error(`--unpacked-bytes is over the class limit of ${codeReview.CLASS_HARD_LIMITS.imageUnpackedBytes}`);
  // A signature on a listing a default arbiter will not pull is wasted, and would settle a claim as an abstention.
  for (const image of [opts.image, opts.coldImage]) {
    if (!image.startsWith(`${DEFAULT_REGISTRY_ALLOWLIST}/`)) throw new Error(`${image} is outside ${DEFAULT_REGISTRY_ALLOWLIST}, the only registry an arbiter pulls from by default`);
  }
  if (!opts.out) throw new Error('--out must name a directory');
  const out = path.resolve(opts.out);
  // Each run makes new disclosure keys and a new time: signatures from another run could not verify.
  if (fs.existsSync(out) && fs.readdirSync(out).length) throw new Error(`${out} is not empty: prepare into a new directory`);

  const repo = runnerRepo();
  const baseline = repo.vaultBaseline(opts.baseCommit);
  const imageOf = { listing: opts.image, 'registry-failure': F.absentDigest(opts.image), 'cold-cache': opts.coldImage };
  const prepared = {};
  for (const name of LISTINGS) {
    const unsigned = F.unsignedListing({ image: imageOf[name], baseCommit: opts.baseCommit, baseline, trust: 'production', runner: RUNNER_VERSION, repo: FIXTURE_REPO, unpackedBytes });
    assertFrontGates(name, unsigned, baseline);
    const message = codeReview.attestationSigningBytes(unsigned.statement);
    if (message.length > SIGNING_MESSAGE_LIMIT) throw new Error(`the ${name} listing's statement is ${message.length} bytes; the signing service takes ${SIGNING_MESSAGE_LIMIT}`);
    prepared[name] = { ...unsigned, message };
  }

  const messages = {};
  for (const [name, { members, statement, message }] of Object.entries(prepared)) {
    const dir = path.join(out, name);
    fs.mkdirSync(path.join(dir, 'members'), { recursive: true });
    for (const file of BOUND_FILES) fs.writeFileSync(path.join(dir, 'members', file), members[file]);
    fs.writeFileSync(path.join(dir, 'statement.json'), `${JSON.stringify(statement, null, 2)}\n`);
    fs.writeFileSync(path.join(dir, 'signing-bytes.bin'), message);
    messages[name] = message;
    console.log(`${name.padEnd(17)} ${String(message.length).padStart(5)} bytes to sign (limit ${SIGNING_MESSAGE_LIMIT})  ${statement.env.image}`);
  }
  const script = path.join(out, 'sign-in-cloudshell.sh');
  fs.writeFileSync(script, signingScript(messages), { mode: 0o755 });
  console.log(`\nWrote ${out}. Run ${path.basename(script)} where the builder key can sign, and bring back signatures.json.`);
}

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

program.command('images')
  .description('build the fixture image and a fresh digest of it, and push both')
  .option('--repository <name>', `where every canary may pull from, under ${DEFAULT_REGISTRY_ALLOWLIST}`)
  .action(guarded(images));
program.command('prepare')
  .description('write the three listings and the bytes to sign')
  .option('--image <ref>', 'the env image, by digest')
  .option('--cold-image <ref>', 'the fresh digest, for claim-l4-cold-cache')
  .option('--base-commit <hash>', 'the fixture repository\'s commit in those images')
  .option('--unpacked-bytes <n>', 'the images\' unpacked size, as images printed it')
  .option('--out <dir>', 'a new directory')
  .action(guarded(prepare));
program.command('attach')
  .description('put the signatures in, verify in production trust, write the archives')
  .option('--dir <dir>', 'the directory prepare wrote')
  .option('--signatures <file>', 'the signing script\'s signatures.json (default: in --dir)')
  .action(guarded(attach));
program.parseAsync(process.argv).catch(fail);
