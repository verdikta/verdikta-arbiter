'use strict';

// Node A3a attempt 2, R11-F1 (owner decision Q29): the runner's forge
// (src/shim.js). The maker's commands run forge with the configuration the
// runner probed, or not at all. Pure parts here; on Linux (dash, GNU awk or
// mawk, coreutils) the real shim script runs against a stand-in forge for each
// override route. The pipeline's use is in integrity.pipeline.test.js; real
// forge in test/docker/integrity.docker.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const shim = require('../../src/shim');
const integrity = require('../../src/integrity');
const { forgeConfig, initialTree } = require('../helpers/fakeClaim');

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

/** A `forge config --json` text the way forge 1.8.5 prints it: nested fields named like watched ones included. */
function forgeJson(over = {}) {
  const v = { src: 'src', test: 'test', script: 'script', out: 'out', libs: ['lib'], remappings: ['forge-std/=lib/forge-std/src/'], cache: true, cache_path: 'cache', snapshots: 'snapshots', broadcast: 'broadcast', allow_paths: [], include_paths: [], solc: null, optimizer: false, doc: { out: 'docs' }, bind_json: { out: 'utils/JsonBindings.sol' }, ...over };
  return `${JSON.stringify(v, null, 2)}\n`;
}

test('the watched fields of `forge config --json`: the top-level ones the checks use, nested namesakes and the rest left out', () => {
  const text = shim.watchedConfigText(forgeJson());
  assert.match(text, /^ {2}"src": "src",$/m);
  assert.match(text, /^ {2}"libs": \[\n {4}"lib"\n {2}\],$/m);
  assert.match(text, /^ {2}"solc": null,$/m);
  assert.doesNotMatch(text, /docs|JsonBindings|optimizer|"cache": true/);
  // A setting the checks do not use leaves the digest alone; a watched one, anywhere in it, moves it.
  assert.equal(shim.watchedConfigDigest(forgeJson({ optimizer: true })), shim.watchedConfigDigest(forgeJson()));
  for (const over of [{ out: 'ci-out' }, { cache_path: 'ci-cache' }, { libs: ['lib', 'vendor'] }, { remappings: ['x/=vendor/x/'] }, { src: 'contracts' }, { include_paths: ['/tmp'] }]) {
    assert.notEqual(shim.watchedConfigDigest(forgeJson(over)), shim.watchedConfigDigest(forgeJson()), JSON.stringify(over));
  }
  assert.equal(shim.watchedConfigDigest(forgeJson()), sha(shim.watchedConfigText(forgeJson())));
});

test('the shim names the probed forge and digest, single-quoted; it refuses what is not an absolute path or a digest', () => {
  const want = 'a'.repeat(64);
  const s = shim.shimScript({ real: "/opt/it's/forge", want });
  assert.match(s, /^#!\/bin\/sh\n/);
  assert.ok(s.includes("real='/opt/it'\\''s/forge'"), s);
  assert.ok(s.includes(`want=${want}`));
  assert.ok(s.includes(`exit ${shim.SHIM_STATUS}`));
  assert.match(s, /exec "\$real" "\$@"\n$/, 'an accepted call is forge itself, its arguments untouched');
  for (const flag of ['--profile', '--config-path', '--root', ...shim.PATH_FLAGS]) assert.ok(s.includes(flag), flag);
  assert.throws(() => shim.shimScript({ real: 'forge', want }), /absolute/);
  assert.throws(() => shim.shimScript({ real: '/usr/local/bin/forge', want: 'x' }), /digest/);
});

test('the maker\'s commands get the shim first on PATH and a FOUNDRY_CONFIG only the shim removes', () => {
  assert.deepEqual(shim.commandEnv('/usr/local/bin:/usr/bin'), { PATH: '/vcr:/usr/local/bin:/usr/bin', FOUNDRY_CONFIG: '/vcr/no-forge-config' });
  assert.equal(shim.SHIM_USER, '10002:10002', 'not the sandbox user');
  assert.match(shim.INSTALL_SCRIPT, /command -v awk .* command -v sha256sum .*\|\| exit 4/);
  assert.match(shim.INSTALL_SCRIPT, /chmod 0555 \/vcr\/forge\.new\nmv -f \/vcr\/forge\.new \/vcr\/forge/);
});

test('a step\'s stderr: the shim\'s refusal record, or forge\'s error on the poison, named; nothing else is a refusal', () => {
  assert.match(shim.refusalOf('vcr-forge-config refused watched-paths\n'), /FOUNDRY_PROFILE or another FOUNDRY_\* variable/);
  assert.match(shim.refusalOf('Compiling...\nvcr-forge-config refused --config-path\n'), /forge was given --config-path/);
  assert.match(shim.refusalOf('vcr-forge-config refused --out\n'), /forge was given --out, which sets a path/);
  assert.match(shim.refusalOf('vcr-forge-config refused directory\n'), /outside \/work/);
  assert.match(shim.refusalOf('Error: failed to extract foundry config:\nfoundry config error: Is a directory (os error 21) for setting `/vcr/no-forge-config`\n'), /without the runner's forge/);
  assert.equal(shim.refusalOf('Error: compilation failed\n'), null);
  assert.equal(shim.refusalOf('vcr-forge-config refused\n'), null, 'a record without a code is not the shim\'s');
});

test('the probed configuration\'s digest is the one the fake sandbox\'s forge config gives (the Watch keeps it)', () => {
  const text = forgeConfig(initialTree());
  const p = integrity.parseFramework(Buffer.from(`vcr-forge /usr/local/bin/forge\nvcr-path /usr/bin\n${text}`));
  assert.equal(p.configText, text);
  assert.equal(shim.watchedConfigDigest(p.configText), sha(shim.watchedConfigText(text)));
});

// ------------------------------------------- the real shim (Linux: dash, awk, coreutils)

/**
 * Run the shim from `work` (the shim is generated for it) with a stand-in
 * forge: `config --json` prints forgeJson() with out from FOUNDRY_PROFILE's
 * profile (`ci` changes out, `opt` only the optimizer) or FOUNDRY_OUT, any
 * other call prints `ran <args>`; with FOUNDRY_CONFIG set it fails as forge
 * 1.8.5 does on a directory.
 */
function realShim() {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { spawnSync } = require('node:child_process');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vcr-shim-')));
  const bin = path.join(root, 'bin');
  const work = path.join(root, 'work');
  fs.mkdirSync(bin);
  fs.mkdirSync(path.join(work, 'sub'), { recursive: true });
  const json = (out, optimizer) => forgeJson({ out, optimizer }).replace(/'/g, '');
  fs.writeFileSync(path.join(bin, 'real-forge'), [
    '#!/bin/sh',
    'if [ -n "${FOUNDRY_CONFIG-}" ]; then echo "foundry config error: Is a directory (os error 21) for setting \\`$FOUNDRY_CONFIG\\`" >&2; exit 1; fi',
    'if [ "$1" = config ]; then',
    '  case ${FOUNDRY_PROFILE-default} in',
    `    ci) printf '%s' '${json('ci-out', false)}' ;;`,
    `    opt) printf '%s' '${json('out', true)}' ;;`,
    `    *) printf '%s' '${json('out', false)}' ;;`,
    '  esac; exit 0',
    'fi',
    'echo "ran $*"'
  ].join('\n'), { mode: 0o755 });
  const want = shim.watchedConfigDigest(json('out', false));
  // The shim as the runner writes it, held to `work` instead of /work (where a Linux CI runner cannot write).
  const script = shim.shimScript({ real: path.join(bin, 'real-forge'), want }).replace(`[ "$(pwd -P)" = /work ]`, `[ "$(pwd -P)" = '${work}' ]`);
  fs.writeFileSync(path.join(bin, 'forge'), script, { mode: 0o555 });
  const run = (argv, { env = {}, cwd = work } = {}) => {
    const r = spawnSync(argv[0], argv.slice(1), { cwd, env: { PATH: `${bin}:/usr/bin:/bin`, FOUNDRY_CONFIG: shim.POISON, ...env }, encoding: 'utf8' });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  return { run, root, bin, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const linux = { skip: process.platform !== 'linux' };

test('the real shim: a plain call runs forge with its arguments untouched (the JS and awk filters agree), and a FOUNDRY_* that moves no watched path is fine', linux, () => {
  const s = realShim();
  try {
    const plain = s.run(['forge', 'test', '--match-path', 'test/A.t.sol', '-vvv']);
    assert.equal(plain.status, 0, plain.stderr);
    assert.equal(plain.stdout, 'ran test --match-path test/A.t.sol -vvv\n');
    assert.equal(plain.stderr, '', 'nothing printed on an accepted call');
    assert.equal(s.run(['forge', 'test'], { env: { FOUNDRY_PROFILE: 'opt' } }).status, 0);
    assert.equal(s.run(['env', 'FOUNDRY_FUZZ_RUNS=10', 'forge', 'test']).status, 0);
  } finally {
    s.cleanup();
  }
});

test('the real shim refuses each override route with its fixed status and a named record: FOUNDRY_PROFILE, --config-path, --root, through env, and fails an absolute-path call on the poison', linux, () => {
  const s = realShim();
  try {
    const cases = [
      ['FOUNDRY_PROFILE', ['forge', 'build'], { env: { FOUNDRY_PROFILE: 'ci' } }, 'watched-paths'],
      ['--config-path', ['forge', 'build', '--config-path', 'foundry.toml'], {}, '--config-path'],
      ['--config-path=', ['forge', 'build', '--config-path=foundry.toml'], {}, '--config-path'],
      ['--root', ['forge', 'test', '--root', '/work'], {}, '--root'],
      ['--profile', ['forge', 'test', '--profile', 'ci'], {}, '--profile'],
      ['through env', ['env', 'FOUNDRY_PROFILE=ci', 'forge', 'test'], {}, 'watched-paths'],
      ['a path flag', ['forge', 'build', '--out', 'out'], {}, '--out'],
      ['a short cluster', ['forge', 'build', '-vo', 'x'], {}, 'cluster'],
      ['another FOUNDRY_CONFIG', ['forge', 'build'], { env: { FOUNDRY_CONFIG: 'foundry.toml' } }, 'FOUNDRY_CONFIG'],
      ['another directory', ['forge', 'build'], { cwd: require('node:path').join(s.root, 'work', 'sub') }, 'directory']
    ];
    for (const [what, argv, o, code] of cases) {
      const r = s.run(argv, o);
      assert.equal(r.status, shim.SHIM_STATUS, `${what}: ${r.stderr}`);
      assert.equal(r.stdout, '', `${what}: forge never ran`);
      assert.equal(r.stderr, `vcr-forge-config refused ${code}\n`, what);
      assert.ok(shim.refusalOf(r.stderr), what);
    }
    // The image's forge by its absolute path never meets the shim: the poisoned FOUNDRY_CONFIG stops it.
    const abs = s.run([require('node:path').join(s.bin, 'real-forge'), 'build']);
    assert.equal(abs.status, 1);
    assert.equal(abs.stdout, '');
    assert.match(shim.refusalOf(abs.stderr), /without the runner's forge/);
  } finally {
    s.cleanup();
  }
});
