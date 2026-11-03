'use strict';

// Node A2d against real forge (the base pinned in @verdikta/common, v1.8.5), owner Q40: the listing check refuses a vyper on
// PATH and a vyper setting, before any build, with one listing-only code; a .vy file alone is no reason. What forge does with
// a .vy file and where it looks for a vyper is pinned here too, because the rule rests on it. Under runc locally (arm64 on a
// Mac); CI runs this file on linux/amd64 under runc and under gVisor (runsc). Every container and image is removed.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { executeRun } = require('../../src/pipeline');
const { discoverForge } = require('../../src/integrity');
const forgeLib = require('../../src/forge');
const { Prefix } = require('../../src/capture');
const { silent, instanceId, dockerTestConfig, dockerFor, removeAll, smallLimits } = require('./helpers');
const { VAULT_REPO, buildFixture, addFilesPatch, forgeStdFiles } = require('./forgeFixture');
const { BASE_PATH, writeFile, COUNTER, BUILDER_ENV, AS_BUILDER, INSTALL_MARKERS, body, check, DRAIN, claim, show, stepNames } = require('./listingHarness');

const TIMEOUT = 900000;
const builder = dockerFor(dockerTestConfig());
const fixtures = new Map();

const TOOLS_BIN = '/opt/verdikta/tools/bin';
const VY = '# @version ^0.4.0\n@external\ndef fee() -> uint256:\n    return 1\n';
const VY_NO_PRAGMA = '@external\ndef fee() -> uint256:\n    return 1\n';
/** Valid Solidity in a file named .vy. */
const SOL_IN_VY = '// SPDX-License-Identifier: MIT\npragma solidity ^0.8.0;\ncontract Fee { function fee() public pure returns (uint256) { return 1; } }\n';
const SOL_PROBE = '// SPDX-License-Identifier: MIT\npragma solidity ^0.8.0;\ncontract Probe {}\n';
/** A fake that answers forge, and writes a watched place when forge compiles with it, which the build's check sees. */
const FAKE_VYPER = '#!/bin/sh\ncase " $* " in *" --version "*) echo "0.4.0+commit.e9db8d9f" ;; *) printf x > /work/lib/trap.sol; printf "{}" ;; esac\n';
/** A fake that logs each run and does nothing else. */
const LOGGING_VYPER = '#!/bin/sh\nprintf "%s\\n" "$*" >> /tmp/vyper-ran\ncase " $* " in *" --version "*) echo "0.4.0+commit.e9db8d9f" ;; *) cat >/dev/null; printf "{\\"contracts\\":{},\\"sources\\":{},\\"errors\\":[]}" ;; esac\n';
const CLEAN_REPO = Object.freeze({ ...VAULT_REPO, 'lib/.keep': '' });
const VY_REPO = Object.freeze({ ...CLEAN_REPO, 'src/Fee.vy': VY });
const TOOLS_REPO = Object.freeze({ ...CLEAN_REPO, 'tools/.keep': '' });
const inTools = (text, mode = '0755') => `mkdir -p ${TOOLS_BIN} && ${writeFile(`${TOOLS_BIN}/vyper`, text)} && chmod -R a+rX /opt/verdikta && chmod ${mode} ${TOOLS_BIN}/vyper`;
const FAKE_NAMED = `mkdir -p /opt/fake && ${writeFile('/opt/fake/vyper', FAKE_VYPER)} && chmod -R a+rX /opt/fake`;
const PATH_VYPER = `mkdir -p /opt/pathvyper && ${writeFile('/opt/pathvyper/vyper', FAKE_VYPER)} && chmod -R a+rX /opt/pathvyper`;
const importing = (what) => VAULT_REPO['src/Vault.sol'].replace('contract Vault {', `import "${what}";\ncontract Vault {`);
const SEEN = /Found Vyper sources, but no compiler versions are available for it/;

const VARIANTS = Object.freeze({
  // ------------------------------------------------- a vyper on PATH
  vyperonpath: { files: VY_REPO, setup: inTools(FAKE_VYPER), env: BUILDER_ENV },
  vyperalone: { files: CLEAN_REPO, setup: inTools(FAKE_VYPER), env: BUILDER_ENV },
  vyperfirst: { files: VY_REPO, setup: PATH_VYPER, env: [`PATH=/opt/pathvyper:${BASE_PATH}`] },
  vyperlink: {
    files: VY_REPO,
    setup: `mkdir -p ${TOOLS_BIN} /opt/elsewhere && ${writeFile('/opt/elsewhere/v', FAKE_VYPER)} && ln -s /opt/elsewhere/v /opt/elsewhere/w && ln -s /opt/elsewhere/w ${TOOLS_BIN}/vyper && chmod -R a+rX /opt/verdikta /opt/elsewhere`,
    env: BUILDER_ENV
  },
  vyperdirlink: { files: VY_REPO, setup: `mkdir -p /opt/real && ${writeFile('/opt/real/vyper', FAKE_VYPER)} && ln -s /opt/real /opt/linked && chmod -R a+rX /opt/real`, env: [`PATH=/opt/linked:${BASE_PATH}`] },
  vyperdangling: { files: VY_REPO, setup: `mkdir -p ${TOOLS_BIN} && ln -s /opt/nowhere/vyper ${TOOLS_BIN}/vyper && chmod -R a+rX /opt/verdikta`, env: BUILDER_ENV },
  vypernoexec: { files: VY_REPO, setup: inTools(FAKE_VYPER, '0644'), env: BUILDER_ENV },
  vyperunreadable: { files: VY_REPO, setup: inTools(FAKE_VYPER, '0111'), env: BUILDER_ENV },
  // ------------------------------------------------- a PATH directory in the work tree, with nothing in it yet or with one
  vyperintree: { files: TOOLS_REPO, env: [`PATH=/work/tools:${BASE_PATH}`] },
  vyperrelative: { files: TOOLS_REPO, env: [`PATH=tools:${BASE_PATH}`] },
  vyperempty: { files: CLEAN_REPO, env: [`PATH=${BASE_PATH}:`] },
  vyperheld: { files: { ...CLEAN_REPO, 'tools/vyper': FAKE_VYPER }, setup: 'chmod 0755 tools/vyper', env: [`PATH=/work/tools:${BASE_PATH}`] },
  // ------------------------------------------------- a vyper setting, on the real listing path; the other forms forge reads are in the lookup test
  vysetpath: { files: VY_REPO, toml: '[vyper]\npath = "/opt/fake/vyper"', setup: FAKE_NAMED },
  vysetnovy: { files: CLEAN_REPO, toml: '[vyper]\npath = "/opt/fake/vyper"', setup: FAKE_NAMED },
  vysetoptimize: { files: VY_REPO, toml: '[vyper]\noptimize = "gas"' },
  vysetenv: { files: { ...VY_REPO, '.env': 'FOUNDRY_VYPER_PATH=/opt/fake/vyper\n' }, setup: FAKE_NAMED },
  // Untracked, as an ignored .env in the image would be: the forced checkout leaves it, and forge reads it.
  vysetenvuntracked: { files: VY_REPO, setup: `${FAKE_NAMED} && printf 'FOUNDRY_VYPER_PATH=/opt/fake/vyper\\n' > .env` },
  vysetenvprofile: { files: { ...VY_REPO, '.env': 'FOUNDRY_PROFILE=alt\n' }, toml: '[profile.alt.vyper]\npath = "/opt/fake/vyper"', setup: FAKE_NAMED },
  // ------------------------------------------------- what a claim refuses too, by its own code, before the look
  vysetintree: { files: VY_REPO, toml: '[vyper]\npath = "test/vyper"' },
  vyperthroughtree: { files: VY_REPO, setup: `mkdir -p ${TOOLS_BIN} && ln -s /work/test/vyper ${TOOLS_BIN}/vyper && chmod -R a+rX /opt/verdikta`, env: BUILDER_ENV },
  // A PATH directory in the work tree by a way that does not start with /work/ (found on this node's own attempt to get past the look).
  vypathslash: { files: TOOLS_REPO, env: [`PATH=//work/tools:${BASE_PATH}`] },
  vypathlink: { files: TOOLS_REPO, setup: 'ln -s /work/tools /opt/x', env: [`PATH=/opt/x:${BASE_PATH}`] },
  // ------------------------------------------------- a .vy file and no vyper: forge's own answer, no rule here
  vyinsrc: { files: VY_REPO },
  vyintest: { files: { ...CLEAN_REPO, 'test/Fee.vy': VY } },
  vyimportvyper: { files: { ...VAULT_REPO, 'lib/dep/Fee.vy': VY, 'src/Vault.sol': importing('../lib/dep/Fee.vy') } },
  vyimportsrc: { files: { ...CLEAN_REPO, 'src/Fee.vy': SOL_IN_VY, 'src/Vault.sol': importing('./Fee.vy') } },
  // Places forge reads no setting from, or reads too late for a compile, each naming a fake that writes a watched place.
  vynotread: {
    files: {
      ...VY_REPO,
      '.env.local': 'FOUNDRY_VYPER_PATH=/opt/fake/vyper\n',
      '.envrc': 'export FOUNDRY_VYPER_PATH=/opt/fake/vyper\n',
      'src/.env': 'FOUNDRY_VYPER_PATH=/opt/fake/vyper\n',
      'test/.env': 'FOUNDRY_VYPER_PATH=/opt/fake/vyper\n',
      'foundry.local.toml': '[vyper]\npath = "/opt/fake/vyper"\n',
      'test/foundry.toml': '[vyper]\npath = "/opt/fake/vyper"\n',
      'test/Vault.t.sol': VAULT_REPO['test/Vault.t.sol'].replace('contract VaultTest', '/// forge-config: default.vyper.path = "/opt/fake/vyper"\ncontract VaultTest')
    },
    setup: `${FAKE_NAMED} && mkdir -p /etc/foundry && printf 'FOUNDRY_VYPER_PATH=/opt/fake/vyper\\n' > /.env && printf '[vyper]\\npath = "/opt/fake/vyper"\\n' > /foundry.toml && cp /foundry.toml /etc/foundry/foundry.toml`
  },
  // ------------------------------------------------- a .vy that must not be refused
  vylib: { files: { ...VAULT_REPO, 'lib/dep/src/Fee.vy': VY, 'lib/dep/src/IFee.vyi': '# an interface\n', 'lib/dep/test/Fee.t.vy': VY } },
  vylibreal: {
    files: null,
    extra: { 'lib/vyper-dep/src/Token.vy': VY, 'lib/vyper-dep/src/interfaces/IToken.vyi': '# an interface\n', 'lib/forge-std/test/fixtures/Stub.vy': VY },
    installed: ['0.8.31'],
    setup: `${INSTALL_MARKERS('0.8.31')} && chmod -R a+rX /opt/verdikta && ${AS_BUILDER}`,
    env: BUILDER_ENV
  },
  vyimportsol: { files: { ...VAULT_REPO, 'lib/dep/Fee.vy': SOL_IN_VY, 'src/Vault.sol': importing('../lib/dep/Fee.vy') } },
  // Neither is a setting: forge answers `"vyper": {}` to an empty table with an unknown key, and to a profile nothing selects.
  // A directory named vyper on PATH is no compiler.
  vynosetting: {
    files: { ...VAULT_REPO, 'lib/dep/Fee.vy': VY },
    toml: '[vyper]\nunknown_key = 1\n\n[profile.ci.vyper]\npath = "/opt/fake/vyper"',
    setup: `${FAKE_NAMED} && mkdir -p ${TOOLS_BIN}/vyper && chmod -R a+rX /opt/verdikta`,
    env: BUILDER_ENV
  },
  // ------------------------------------------------- forge's lookup, with one planted where it never looks
  vyplanted: {
    setup: [
      ...['/opt/verdikta/tools/share/svm/vyper', '/opt/verdikta/tools/share/svm/0.4.0/vyper-0.4.0', '/opt/verdikta/tools/share/vvm/vyper', '/opt/verdikta/tools/share/vvm/0.4.0/vyper',
        '/opt/verdikta/tools/share/vyper/vyper', '/opt/verdikta/tools/vyper', '/opt/verdikta/tools/libexec/vyper', '/usr/local/lib/vyper', '/usr/lib/vyper', '/usr/share/vyper/vyper', '/opt/solc/vyper', '/opt/vvm/vyper', '/opt/vvm/.vvm/vyper'
      ].flatMap((f) => [`mkdir -p "$(dirname ${f})"`, writeFile(f, LOGGING_VYPER)]),
      'chmod -R a+rX /opt/verdikta /opt/vvm /usr/share/vyper'
    ].join(' && ')
  }
});

async function fixture(variant) {
  if (!fixtures.has(variant)) {
    const { extra = {}, ...v } = VARIANTS[variant];
    const files = v.files === null ? { ...COUNTER, ...await forgeStdFiles(), ...extra } : v.files;
    fixtures.set(variant, buildFixture(builder, { ...v, files, instance: `${instanceId()}${variant}` }));
  }
  return fixtures.get(variant);
}

test.after(async () => {
  for (const f of fixtures.values()) {
    try { await (await f).remove(); } catch (_) { /* the build failed: nothing to remove */ }
  }
});

const outputOf = (r, step) => {
  const s = r.steps.find((x) => x.name === step);
  return `${s.stdout.text}\n${s.stderr.text}`;
};

// ---------------------------------------------------------- what the rule refuses

test('A2d (a known limit of A2c until now): a fake `vyper` on PATH and a .vy file: the look refuses it before any build, and a claim, which never reads the rule, still runs it', { timeout: TIMEOUT }, async (t) => {
  const fx = await fixture('vyperonpath');
  const r = await check(t, body(fx));
  assert.equal(r.outcome, 'definitive', show(r));
  assert.deepEqual(r.facts.listing.refusals.map((x) => x.code), ['VYPER_NOT_SUPPORTED'], show(r));
  assert.ok(stepNames(r).includes('prepare:vyper'), 'the look ran');
  assert.ok(!stepNames(r).includes('build'), 'forge compiled nothing, so the fake never ran');
  // The route the look now stops, on an image that never went through it: it writes a watched place, and the build's check sees it.
  const asClaim = await claim(t, fx);
  assert.equal(asClaim.outcome, 'requester_error', show(asClaim));
  assert.deepEqual(asClaim.issues.map((i) => i.code), ['IMAGE_WATCH_CHANGED_BY_BUILD'], show(asClaim));
  assert.ok(!stepNames(asClaim).includes('prepare:vyper'), 'a claim does not look');
});

const VYPER_REFUSED = Object.freeze([
  // A vyper on PATH.
  ['a fake vyper in the tools folder, with no .vy anywhere: the rule is on the vyper', 'vyperalone', /\/opt\/verdikta\/tools\/bin\/vyper \(on PATH\) is a vyper/],
  ['the first PATH directory', 'vyperfirst', /\/opt\/pathvyper\/vyper \(on PATH\) is a vyper/],
  ['behind a chain of links', 'vyperlink', /\/opt\/verdikta\/tools\/bin\/vyper \(on PATH\) is a vyper/],
  ['in a PATH directory that is itself a link', 'vyperdirlink', /\/opt\/linked\/vyper \(on PATH\) is a vyper/],
  ['a link that leads nowhere', 'vyperdangling', /\/opt\/verdikta\/tools\/bin\/vyper \(on PATH\) is a link that leads nowhere/],
  ['a file forge would skip, not executable', 'vypernoexec', /\/opt\/verdikta\/tools\/bin\/vyper \(on PATH\) is a vyper/],
  ['one the sandbox user can run but not read', 'vyperunreadable', /\/opt\/verdikta\/tools\/bin\/vyper \(on PATH\) cannot be read/],
  // A PATH directory in the work tree, where a patch or a fix could add one after the look.
  ['a relative PATH entry', 'vyperrelative', /PATH directory \/work\/tools is in the work tree/],
  ['an empty PATH entry, forge\'s own directory', 'vyperempty', /PATH directory \/work is in the work tree/],
  ['one holding a vyper', 'vyperheld', /\/work\/tools\/vyper \(on PATH\) is a vyper/],
  // A vyper setting, wherever forge reads it from.
  ['[vyper] path', 'vysetpath', /vyper\.path/],
  ['[vyper] path, with no .vy anywhere', 'vysetnovy', /vyper\.path/],
  ['[vyper] optimize, naming no compiler', 'vysetoptimize', /vyper\.optimize/],
  ['FOUNDRY_VYPER_PATH in a .env', 'vysetenv', /vyper\.path/],
  ['a .env the commit does not track', 'vysetenvuntracked', /vyper\.path/],
  ['the profile a .env selects', 'vysetenvprofile', /vyper\.path/]
]);

for (const [what, variant, detail] of VYPER_REFUSED) {
  test(`A2d under real forge: VYPER_NOT_SUPPORTED: ${what}, before any build`, { timeout: TIMEOUT }, async (t) => {
    const r = await check(t, body(await fixture(variant)));
    assert.equal(r.outcome, 'definitive', show(r));
    assert.equal(r.facts.listing.status, 'refused', show(r));
    assert.deepEqual(r.facts.listing.refusals.map((x) => x.code), ['VYPER_NOT_SUPPORTED'], show(r));
    assert.match(r.facts.listing.refusals[0].detail, detail);
    assert.match(r.facts.listing.refusals[0].detail, /no official list of release hashes/);
    assert.ok(!stepNames(r).includes('build'), 'no build ran');
    assert.equal(r.facts.listing.baseline, null);
  });
}

test('A2d under real forge: the same images as a claim get no such refusal: a claim never reads the rule, and with no .vy in the tree forge never starts the fake', { timeout: TIMEOUT }, async (t) => {
  for (const variant of ['vyperalone', 'vysetnovy']) {
    const r = await claim(t, await fixture(variant));
    assert.equal(r.outcome, 'definitive', `${variant}: ${show(r)}`);
    assert.ok(!stepNames(r).includes('prepare:vyper'), variant);
    assert.equal(r.gates.reproduces.status, 'pass', `${variant}: ${show(r)}`);
    assert.equal(r.gates.integrity.status, 'pass', `${variant}: the fake did not run: ${show(r)}`);
  }
});

for (const [variant, detail] of [
  ['vysetintree', /vyper\.path \(test\/vyper\) is in the work tree/],
  ['vyperthroughtree', /\/opt\/verdikta\/tools\/bin\/vyper/],
  ['vypathslash', /\/\/work\/tools/],
  ['vypathlink', /\/opt\/x/]
]) {
  test(`A2d under real forge: a vyper the sandbox could change (${variant}) keeps the code a claim gives, before the look`, { timeout: TIMEOUT }, async (t) => {
    const fx = await fixture(variant);
    const listing = await check(t, body(fx));
    assert.equal(listing.outcome, 'requester_error', show(listing));
    assert.deepEqual(listing.issues.map((i) => i.code), ['IMAGE_WATCH_ROOT_UNCOVERED'], show(listing));
    assert.match(listing.issues[0].detail, detail);
    assert.ok(!stepNames(listing).includes('prepare:vyper') && !stepNames(listing).includes('build'), 'neither the look nor a build');
    const asClaim = await claim(t, fx);
    assert.deepEqual(asClaim.issues.map((i) => [i.code, i.detail]), listing.issues.map((i) => [i.code, i.detail]), 'the same words');
  });
}

test('A2d under real forge: why a PATH directory in the work tree is refused: a listing with no vyper, then a patch adds one and a .vy: forge runs the patch\'s compiler; refused at listing', { timeout: TIMEOUT }, async (t) => {
  const fx = await fixture('vyperintree');
  // forgeOutOfReach refuses a PATH directory under paths.tests. This one is not: only the file a patch would add is.
  const paths = { tests: ['test/**', 'tools/vyper'], protected: ['foundry.toml', 'lib/**', '.gitignore'] };
  const listing = await check(t, body(fx, { paths }));
  assert.deepEqual((listing.facts.listing || { refusals: [] }).refusals.map((x) => x.code), ['VYPER_NOT_SUPPORTED'], show(listing));
  assert.match(listing.facts.listing.refusals[0].detail, /PATH directory \/work\/tools is in the work tree/);
  const pocPatch = Buffer.concat([addFilesPatch({ 'test/Exploit.t.sol': DRAIN, 'test/Fee.vy': VY }), addFilesPatch({ 'tools/vyper': FAKE_VYPER }, '100755')]);
  const asClaim = await claim(t, fx, { pocPatch, paths });
  assert.equal(asClaim.outcome, 'requester_error', show(asClaim));
  assert.deepEqual(asClaim.issues.map((i) => i.code), ['IMAGE_WATCH_CHANGED_BY_BUILD'], `the fake wrote where the build's check sees it: ${show(asClaim)}`);
  assert.match(asClaim.issues[0].detail, /lib\/trap\.sol added/);
});

// ---------------------------------------------------------- a .vy file alone is no reason

const VY_BUILD_FAILS = Object.freeze([
  ['a .vy in src/', 'vyinsrc', SEEN],
  ['a .vy in test/', 'vyintest', SEEN],
  ['Solidity importing a .vy under lib/ holding Vyper with a version pragma: forge reads it as Solidity', 'vyimportvyper', /invalid compiler version in lib\/dep\/Fee\.vy/],
  ['Solidity importing a .vy in src/ holding Solidity: it is a Vyper source too', 'vyimportsrc', SEEN],
  ['a fake named only where forge reads no setting: other .env and toml files, one in test/, one on the root, inline configuration', 'vynotread', SEEN]
]);

for (const [what, variant, output] of VY_BUILD_FAILS) {
  test(`A2d under real forge: no rule on a .vy file: ${what}, with no vyper: not this refusal, but forge's own failed build`, { timeout: TIMEOUT }, async (t) => {
    const r = await check(t, body(await fixture(variant)));
    assert.equal(r.outcome, 'definitive', show(r));
    assert.deepEqual(r.facts.listing.refusals.map((x) => x.code), ['BUILD_FAILED'], show(r));
    assert.ok(stepNames(r).includes('prepare:vyper') && stepNames(r).includes('build'), 'past the look, to the build');
    assert.match(outputOf(r, 'build'), output, show(r));
  });
}

test('A2d under real forge: no false refusal: a .vy and a .vyi only under lib/, no vyper: the listing is accepted, forge never needed a compiler for them, and a claim on it passes', { timeout: TIMEOUT }, async (t) => {
  const fx = await fixture('vylib');
  const r = await check(t, body(fx));
  assert.equal(r.outcome, 'definitive', show(r));
  assert.equal(r.facts.listing.status, 'accepted', show(r));
  assert.ok(r.facts.listing.baseline.stable.includes('test/Vault.t.sol > VaultTest > test_deposit()'), show(r));
  const asClaim = await claim(t, fx);
  assert.equal(asClaim.outcome, 'definitive', show(asClaim));
  assert.equal(asClaim.gates.reproduces.status, 'pass', show(asClaim));
  assert.equal(asClaim.gates.integrity.status, 'pass', show(asClaim));
});

test('A2d under real forge: no false refusal: an ordinary project (real forge-std, the builder\'s image shape) with a dependency that ships .vy files, no vyper: accepted', { timeout: TIMEOUT }, async (t) => {
  const fx = await fixture('vylibreal');
  const r = await check(t, body(fx, { paths: { tests: ['test/**'], protected: ['foundry.toml', 'lib/**'] } }));
  assert.equal(r.outcome, 'definitive', show(r));
  assert.equal(r.facts.listing.status, 'accepted', show(r));
  assert.ok(r.facts.listing.baseline.stable.length >= 3, show(r));
});

test('A2d under real forge: Solidity importing a .vy under lib/ that holds Solidity: forge compiles it with solc as Solidity, so no vyper is involved and nothing is refused', { timeout: TIMEOUT }, async (t) => {
  const r = await check(t, body(await fixture('vyimportsol')));
  assert.equal(r.outcome, 'definitive', show(r));
  assert.equal(r.facts.listing.status, 'accepted', show(r));
});

test('A2d under real forge: what is not a setting and not a vyper: an empty table with an unknown key, a profile nothing selects, a directory named vyper on PATH: accepted', { timeout: TIMEOUT }, async (t) => {
  const r = await check(t, body(await fixture('vynosetting')));
  assert.equal(r.outcome, 'definitive', show(r));
  assert.equal(r.facts.listing.status, 'accepted', show(r));
});

test('A2d under real forge: a hunter\'s patch adding a .vy on an image with no vyper fails the build gate, the hunter\'s own cost, however it is added', { timeout: TIMEOUT }, async (t) => {
  const fx = await buildFixture(builder, { files: CLEAN_REPO, instance: `${instanceId()}plain` });
  t.after(() => fx.remove());
  for (const [what, patch, output] of [
    ['beside the proof', { 'test/Exploit.t.sol': DRAIN, 'test/Fee.vy': VY_NO_PRAGMA }, SEEN],
    ['imported by the proof, holding Solidity', { 'test/Exploit.t.sol': `import "./Fee.vy";\n${DRAIN}`, 'test/Fee.vy': SOL_IN_VY }, SEEN],
    // forge's wording varies here from run to run (by a probe of 30 builds, about half each way); the failed build does not.
    ['imported by the proof, holding Vyper', { 'test/Exploit.t.sol': `import "./Fee.vy";\n${DRAIN}`, 'test/Fee.vy': VY }, /invalid compiler version in test\/Fee\.vy|Found Vyper sources/]
  ]) {
    const r = await claim(t, fx, { pocPatch: addFilesPatch(patch) });
    assert.equal(r.outcome, 'definitive', `${what}: ${show(r)}`);
    assert.equal(r.gates.applies.status, 'pass', what);
    assert.equal(r.gates.testPathsOnly.status, 'pass', what);
    assert.equal(r.gates.build.status, 'fail', `${what}: ${show(r)}`);
    assert.match(outputOf(r, 'build'), output, `${what}: ${show(r)}`);
  }
});

// ---------------------------------------------------------- what the rule rests on

test('A2d under real forge: where forge looks: what it reads as a vyper setting is what its build runs; a vyper planted at every other place never runs; its configuration read runs none; and what a .vy does, imported by Solidity or not', { timeout: TIMEOUT }, async (t) => {
  const fx = await fixture('vyplanted');
  const config = dockerTestConfig();
  const docker = dockerFor(config);
  t.after(() => removeAll(docker, config.instance).catch(() => {}));
  const FAKE = '/opt/vvm/vyper';
  const report = [];
  const step = async (ctx) => {
    const found = await discoverForge(ctx, 'find');
    let n = 0;
    const sh = (script) => { n += 1; return ctx.exec(['/bin/sh', '-c', script], { name: `s${n}`, timeoutMs: 60000 }); };
    const forge = async (args, tool = found) => {
      n += 1;
      const out = new Prefix(1024 * 1024);
      const record = await ctx.exec(forgeLib.forgeArgv({ ...tool, solc: '/opt/solc/solc' }, args), { name: `s${n}`, timeoutMs: 120000, workdir: forgeLib.FORGE_WORKDIR, tee: out });
      return { exit: record.exitCode, stdout: out.bytes().toString('utf8'), output: `${out.bytes().toString('utf8')}\n${record.stderr.text}` };
    };
    const onPath = { ...found, path: `/opt/vvm:${found.path}` };
    const b64 = (text) => Buffer.from(text).toString('base64');
    const project = async ({ toml = '', env = null, files = {} } = {}) => {
      const lines = [
        'cd /work && find . -mindepth 1 -delete; rm -rf /tmp/vyper-ran "$HOME/.foundry" "$HOME/.vvm" "$HOME/.vyper" "$HOME/.local" "$HOME/.cargo" "$HOME/.svm"; mkdir -p src test lib',
        'printf \'[profile.default]\\nsrc = "src"\\ntest = "test"\\nout = "out"\\ncache_path = "cache"\\nlibs = ["lib"]\\noffline = true\\n\' > foundry.toml',
        `printf '%s' '${b64(SOL_PROBE)}' | base64 -d > src/Probe.sol`
      ];
      if (toml) lines.push(`printf '%s' '${b64(toml)}' | base64 -d >> foundry.toml`);
      if (env) lines.push(`printf '%s' '${b64(env)}' | base64 -d > .env`);
      for (const [f, text] of Object.entries(files)) lines.push(`mkdir -p "$(dirname '${f}')"; printf '%s' '${b64(text)}' | base64 -d > '${f}'`);
      assert.equal((await sh(lines.join('\n'))).exitCode, 0, 'the project was written');
    };
    const ran = async () => {
      n += 1;
      const out = new Prefix(64 * 1024);
      await ctx.exec(['/bin/sh', '-c', 'cat /tmp/vyper-ran 2>/dev/null; exit 0'], { name: `s${n}`, timeoutMs: 60000, tee: out });
      return out.bytes().toString('utf8').split('\n').filter(Boolean);
    };
    const shownBy = async () => JSON.parse((await forge(['config', '--json'])).stdout).vyper;

    // What forge reads as a setting is what its build runs: with a .vy in src/, each of these runs the fake it names.
    for (const [what, form] of [
      ['[vyper] path', { toml: `\n[vyper]\npath = "${FAKE}"\n` }],
      ['[profile.default.vyper]', { toml: `\n[profile.default.vyper]\npath = "${FAKE}"\n` }],
      ['an inline table', { toml: `\n[profile.alt]\nvyper = { path = "${FAKE}" }\n`, env: 'FOUNDRY_PROFILE=alt\n' }],
      ['.env FOUNDRY_VYPER_PATH', { env: `FOUNDRY_VYPER_PATH=${FAKE}\n` }],
      ['.env FOUNDRY_VYPER', { env: `FOUNDRY_VYPER={path="${FAKE}"}\n` }],
      ['.env DAPP_VYPER', { env: `DAPP_VYPER={path="${FAKE}"}\n` }],
      ['.env FOUNDRY_VYPER.PATH', { env: `FOUNDRY_VYPER.PATH=${FAKE}\n` }],
      ['.env FOUNDRY_PROFILE', { toml: `\n[profile.alt.vyper]\npath = "${FAKE}"\n`, env: 'FOUNDRY_PROFILE=alt\n' }],
      ['$HOME/.foundry/foundry.toml', { files: { '/home/sandbox/.foundry/foundry.toml': `[vyper]\npath = "${FAKE}"\n` } }]
    ]) {
      await project({ ...form, files: { ...(form.files || {}), 'src/Fee.vy': VY } });
      assert.deepEqual(await shownBy(), { path: FAKE }, `${what}: forge config shows it`);
      assert.deepEqual(await ran(), [], `${what}: reading the configuration ran nothing`);
      await forge(['build']);
      report.push({ what, ran: await ran() });
    }

    // A vyper on PATH: only a build that has a .vy to compile runs it, and forge config never does.
    await project({ files: { 'src/Fee.vy': VY } });
    await forge(['config', '--json'], onPath);
    assert.deepEqual(await ran(), [], 'forge config ran no vyper on PATH');
    await forge(['build'], onPath);
    assert.deepEqual((await ran()).slice(0, 2), ['--version', '--standard-json'], 'on PATH with a .vy in src/, the control');
    await project();
    await forge(['build'], onPath);
    assert.deepEqual(await ran(), [], 'on PATH with no .vy, not started');
    await project({ files: { 'lib/dep/Fee.vy': VY } });
    const libOnly = await forge(['build'], onPath);
    assert.equal(libOnly.exit, 0, libOnly.output);
    assert.deepEqual(await ran(), [], 'on PATH with a .vy only under lib/, not started');

    // A .vy with no vyper, in forms cheaper to run here than each as a listing: every build fails, by forge's own words.
    const imports = (what) => `// SPDX-License-Identifier: MIT\npragma solidity ^0.8.0;\nimport "${what}";\ncontract Importer {}\n`;
    for (const [what, files, output] of [
      ['a .vy in script/', { 'script/Fee.vy': VY }, SEEN],
      ['a .vyi in src/', { 'src/IFee.vyi': '# an interface\n' }, SEEN],
      ['imported from lib/, Vyper with no pragma: solc reads it', { 'src/Importer.sol': imports('../lib/dep/Fee.vy'), 'lib/dep/Fee.vy': VY_NO_PRAGMA }, /Compiler run failed[\s\S]*lib\/dep\/Fee\.vy/],
      // forge's wording varies here from run to run; the failed build does not.
      ['imported from src/, Vyper with a pragma', { 'src/Importer.sol': imports('./Fee.vy'), 'src/Fee.vy': VY }, /invalid compiler version in src\/Fee\.vy|Found Vyper sources/]
    ]) {
      await project({ files });
      const build = await forge(['build']);
      assert.notEqual(build.exit, 0, `${what}: ${build.output}`);
      assert.match(build.output, output, what);
    }

    // Solidity importing a .vy, with a vyper on PATH.
    await project({ files: { 'src/Importer.sol': imports('../lib/dep/Fee.vy'), 'lib/dep/Fee.vy': VY } });
    const libVyper = await forge(['build'], onPath);
    assert.notEqual(libVyper.exit, 0, libVyper.output);
    assert.match(libVyper.output, /invalid compiler version in lib\/dep\/Fee\.vy/);
    assert.deepEqual(await ran(), [], 'a .vy under lib/ that Solidity imports starts no vyper');
    await project({ files: { 'src/Importer.sol': imports('../lib/dep/Fee.vy'), 'lib/dep/Fee.vy': SOL_IN_VY } });
    const libSol = await forge(['build'], onPath);
    assert.equal(libSol.exit, 0, libSol.output);
    assert.deepEqual(await ran(), [], 'nor when it holds Solidity, which solc compiled');
    await project({ files: { 'src/Importer.sol': imports('./Fee.vy'), 'src/Fee.vy': VY } });
    const srcVyper = await forge(['build'], onPath);
    assert.notEqual(srcVyper.exit, 0, srcVyper.output);
    assert.deepEqual(await ran(), ['--version'], 'a .vy in src/ that Solidity imports starts it, to ask its version');

    // Everything else: a vyper planted at every other place, then whatever a .env can say that forge does not read as a setting.
    const planted = [
      '$HOME/.vvm/vyper', '$HOME/.vvm/vyper-0.4.0', '$HOME/.vvm/0.4.0/vyper', '$HOME/.vvm/0.4.0/vyper-0.4.0', '$HOME/.vyper/vyper', '$HOME/.local/bin/vyper',
      '$HOME/.foundry/bin/vyper', '$HOME/.cargo/bin/vyper', '$HOME/.svm/vyper', '/work/vyper', '/work/bin/vyper', '/work/.vyper/vyper', '/work/lib/vyper',
      '/work/node_modules/.bin/vyper', '/work/src/vyper', '/tmp/vyper', '/tmp/bin/vyper'
    ];
    const plantAll = planted.map((p) => `mkdir -p "$(dirname "${p}")"; cp ${FAKE} "${p}"; chmod 0755 "${p}"`).join('\n');
    for (const [what, env] of [
      ['nothing else', null],
      ['DAPP_VYPER_PATH', `DAPP_VYPER_PATH=${FAKE}\n`],
      ['FOUNDRY_VYPER__PATH', `FOUNDRY_VYPER__PATH=${FAKE}\n`],
      ['lower case', `foundry_vyper_path=${FAKE}\n`],
      ['other names', `VYPER=${FAKE}\nVYPER_PATH=${FAKE}\nFOUNDRY_VYPER_BIN=${FAKE}\n`],
      ['PATH', 'PATH=/opt/vvm:/usr/bin:/bin\n'],
      ['HOME and XDG_DATA_HOME', 'HOME=/opt/vvm\nXDG_DATA_HOME=/opt/vvm\n']
    ]) {
      await project({ env, files: { 'src/Fee.vy': VY } });
      assert.equal((await sh(plantAll)).exitCode, 0, 'planted');
      assert.deepEqual(await shownBy(), {}, `${what}: forge config shows no setting`);
      const build = await forge(['build']);
      assert.notEqual(build.exit, 0, `${what}: ${build.output}`);
      assert.match(build.output, SEEN, what);
      assert.deepEqual(await ran(), [], `${what}: nothing planted ran`);
    }
  };
  const receivedAt = Date.now();
  const r = await executeRun({
    docker, config, limits: smallLimits({ memoryMb: 2048, cpus: 2, pids: 1024, runSeconds: 800, testSeconds: 240, buildSeconds: 240 }), image: fx.image, runId: crypto.randomBytes(8).toString('hex'),
    steps: [step], receivedAt, deadlineAt: receivedAt + 850000, active: new Set(), log: silent
  });
  assert.equal(r.outcome, 'definitive', JSON.stringify(r.abstain));
  assert.equal(report.length, 9, 'every form was run');
  for (const g of report) assert.deepEqual(g.ran.slice(0, 2), ['--version', '--standard-json'], `${g.what}: forge's build ran what it read`);
});
