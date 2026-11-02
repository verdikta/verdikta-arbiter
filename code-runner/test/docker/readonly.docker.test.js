'use strict';

// Acceptance: every sandbox runs with a read-only root filesystem. The only
// writable places are the capped tmpfs mounts for the work tree, $HOME and
// /tmp, so claim code cannot create, replace or retarget anything on
// /bin/sh's path; the launcher path check stays as a second check. A real
// forge build and test still pass.

const test = require('node:test');
const assert = require('node:assert/strict');
const { executeRun } = require('../../src/pipeline');
const { createArgs, SCRATCH_MB } = require('../../src/sandbox');
const { LAUNCHER_CHECK } = require('../../src/launcher');
const { runText } = require('../../src/docker');
const {
  RUNTIME, PLATFORM, TEST_IMAGE, silent, dockerTestConfig, dockerFor, ensureImage, ensureTestImage, leftovers, removeAll, smallLimits
} = require('./helpers');
const { foundryBase, solcBytes } = require('./forgeFixture');

/** The forge base pinned in @verdikta/common (v1.8.5) and solc 0.8.31, as the claim fixtures use them. */
const FOUNDRY_IMAGE = foundryBase();

function run(config, docker, steps, { image = TEST_IMAGE, limits } = {}) {
  const receivedAt = Date.now();
  return executeRun({
    docker, config, limits: smallLimits(limits), image, runId: '00000000000000c1', steps,
    receivedAt, deadlineAt: receivedAt + 300000, active: new Set(), log: silent
  });
}

test('the root is read-only; /work, $HOME and /tmp are the capped, writable tmpfs mounts', { timeout: 180000 }, async (t) => {
  const config = dockerTestConfig();
  const docker = dockerFor(config);
  t.after(() => removeAll(docker, config.instance));
  await ensureTestImage(docker);
  const got = {};
  const result = await run(config, docker, [async (ctx) => {
    const sh = async (name, script) => { got[name] = await ctx.exec(['sh', '-c', script], { name, timeoutMs: 30000 }); };
    await sh('mounts', 'cat /proc/mounts');
    await sh('where', 'pwd; echo "$HOME"');
    await sh('scratch', 'touch /work/a "$HOME/a" /tmp/a && mkdir -p /work/out /work/cache "$HOME/.foundry" && echo ok');
    // Every write outside the scratch fails, whatever the permissions would allow.
    for (const [name, script] of Object.entries({
      root: 'touch /x',
      etc: 'touch /etc/x',
      usrBin: 'touch /usr/bin/x',
      varTmp: 'touch /var/tmp/x',
      replaceSh: 'cp /tmp/a /bin/sh',
      retargetSh: 'ln -sfn /tmp/a /bin/sh',
      newBin: 'mkdir /bin2',
      shm: 'touch /dev/shm/x'
    })) {
      await sh(name, `${script} 2>&1; echo "rc=$?"`);
    }
    // /var/tmp is world-writable in the image: only the read-only root stops this.
    await sh('after', 'ls -A /var/tmp; readlink /bin/sh; [ -e /bin2 ] && echo bin2');
  }]);
  assert.equal(result.outcome, 'definitive', JSON.stringify(result.abstain));

  const mounts = got.mounts.stdout.text.split('\n').map((l) => l.split(' '));
  const at = (p) => mounts.find((m) => m[1] === p);
  assert.match(at('/')[3], /(^|,)ro(,|$)/, `/ is read-only: ${at('/').join(' ')}`);
  for (const [p, mb] of [['/work', SCRATCH_MB.work], ['/tmp', SCRATCH_MB.tmp], ['/home/sandbox', SCRATCH_MB.home]]) {
    const m = at(p);
    assert.ok(m, `${p} is mounted`);
    assert.equal(m[2], 'tmpfs', p);
    assert.match(m[3], /(^|,)rw(,|$)/, p);
    if (RUNTIME === 'runc') assert.match(m[3], new RegExp(`size=${mb * 1024}k`), `${p} is capped at ${mb} MiB: ${m[3]}`);
  }
  assert.equal(got.where.stdout.text, '/work\n/home/sandbox\n');
  assert.equal(got.scratch.stdout.text.trim(), 'ok');
  for (const name of ['root', 'etc', 'usrBin', 'varTmp', 'replaceSh', 'retargetSh', 'newBin', 'shm']) {
    const out = got[name].stdout.text;
    assert.doesNotMatch(out, /rc=0/, `${name} must fail: ${out}`);
  }
  // runc reports EROFS first; gVisor checks permissions first, so where the
  // modes already forbid the write it says EACCES. /var/tmp (mode 1777) is
  // the case where only the read-only root can refuse.
  for (const name of ['root', 'etc', 'usrBin', 'replaceSh', 'retargetSh', 'newBin']) {
    assert.match(got[name].stdout.text, /Read-only file system|Permission denied/i, `${name}: ${got[name].stdout.text}`);
  }
  assert.match(got.varTmp.stdout.text, /Read-only file system/i, `varTmp: ${got.varTmp.stdout.text}`);
  assert.equal(got.after.stdout.text, 'dash\n', 'nothing was created or retargeted');
  assert.deepEqual(await leftovers(docker, config.instance), []);
});

test('Codex\'s round 7-9 setups: a /bin/sh path through a uid-10001 directory cannot be changed, because the write fails', { timeout: 300000 }, async (t) => {
  const config = dockerTestConfig();
  const docker = dockerFor(config);
  await ensureTestImage(docker);
  // The fixture image routes /bin/sh through /opt/owned, owned by uid 10001,
  // holding an owned interpreter (round 7), a directory link (round 8) and a
  // link whose name ends in a newline (round 9). The sandbox user cannot build
  // this, so it is made as root and committed.
  const builder = `vcr-fixture-b-${config.instance}`;
  const box = `vcr-fixture-s-${config.instance}`;
  const control = `vcr-fixture-c-${config.instance}`;
  let image = null;
  t.after(async () => {
    await runText(docker, ['rm', '--force', builder, box, control], { timeoutMs: 60000 });
    if (image) await runText(docker, ['rmi', '--force', image], { timeoutMs: 60000 });
  });
  const b = await runText(docker, ['run', '--detach', '--pull', 'never', '--platform', PLATFORM, '--name', builder, '--network', 'none', '--entrypoint', 'sleep', TEST_IMAGE, '300'], { timeoutMs: 120000 });
  assert.equal(b.exitCode, 0, b.stderr);
  const setup = await runText(docker, ['exec', '--user', '0', builder, 'sh', '-c', [
    'set -e',
    'mkdir -p /opt/owned',
    'cp /usr/bin/dash /opt/owned/sh7',
    'ln -s /usr/bin /opt/owned/current',
    'ln -s /usr/bin "/opt/owned/route\n"',
    'chown -h 10001:10001 /opt/owned /opt/owned/sh7 /opt/owned/current "/opt/owned/route\n"',
    'chmod 0555 /opt/owned/sh7',
    'ln -sf /opt/owned/current/dash /usr/bin/sh'
  ].join('\n')], { timeoutMs: 60000 });
  assert.equal(setup.exitCode, 0, setup.stderr);
  const commit = await runText(docker, ['commit', builder], { timeoutMs: 120000 });
  assert.equal(commit.exitCode, 0, commit.stderr);
  image = commit.stdout.trim();
  assert.match(image, /^sha256:[0-9a-f]{64}$/);

  // The sandbox's exact flags, with the fixture image in place of the env image.
  const now = Math.floor(Date.now() / 1000);
  const argv = createArgs({ name: 'vcr-00000000000000c2-1', image: TEST_IMAGE, runtime: RUNTIME, platform: PLATFORM,
    limits: { cpus: 1, memoryMb: 512, pids: 512 }, instance: config.instance, runId: '00000000000000c2', expiresAt: now + 300, keepaliveSeconds: 300 });
  argv[argv.indexOf('--name') + 1] = box;
  argv[argv.length - 2] = image;
  const created = await runText(docker, argv, { timeoutMs: 120000 });
  assert.equal(created.exitCode, 0, created.stderr);
  const started = await runText(docker, ['start', box], { timeoutMs: 120000 });
  assert.equal(started.exitCode, 0, started.stderr);

  const asClaim = (script) => runText(docker, ['exec', '--user', '10001:10001', box, 'sh', '-c', script], { timeoutMs: 60000 });
  const attacks = {
    round7Replace: 'cp /usr/bin/true /opt/owned/sh7',
    round7Chmod: 'chmod 0755 /opt/owned/sh7',
    round8Retarget: 'ln -sfn /tmp /opt/owned/current',
    round9Replace: 'rm "/opt/owned/route\n"',
    newEntry: 'touch /opt/owned/new'
  };
  // Each of these is allowed by the modes (uid 10001 owns /opt/owned, the
  // interpreter and the links); only the read-only root refuses them. (gVisor
  // reports EACCES for the 0555 file's content, which its mode forbids anyway.)
  for (const [name, script] of Object.entries(attacks)) {
    const r = await asClaim(script);
    assert.notEqual(r.exitCode, 0, `${name} succeeded`);
    const expected = name === 'round7Replace' ? /Read-only file system|Permission denied/i : /Read-only file system/i;
    assert.match(r.stderr, expected, `${name}: ${r.stderr}`);
  }
  // And nothing changed: the path still resolves as the image had it.
  const state = await asClaim('readlink /opt/owned/current; readlink "/opt/owned/route\n"; stat -c %a /opt/owned/sh7; cmp -s /opt/owned/sh7 /usr/bin/dash && echo same; [ -e /opt/owned/new ] && echo new; readlink -f /bin/sh');
  assert.equal(state.stdout, '/usr/bin\n/usr/bin\n555\nsame\n/usr/bin/dash\n', state.stderr);
  // The backup check still refuses such an image at launch.
  const backup = await runText(docker, ['exec', '--user', '10001:10001', box, '/bin/sh', '-c', LAUNCHER_CHECK, 'vcr-launcher-check', '/bin/sh'], { timeoutMs: 60000 });
  assert.equal(backup.exitCode, 1, backup.stderr);

  // Control: the same image without --read-only lets the claim retarget the link.
  const c = await runText(docker, ['run', '--detach', '--pull', 'never', '--platform', PLATFORM, '--name', control, '--network', 'none', '--user', '10001:10001', '--entrypoint', 'sleep', image, '300'], { timeoutMs: 120000 });
  assert.equal(c.exitCode, 0, c.stderr);
  const retarget = await runText(docker, ['exec', control, 'sh', '-c', 'ln -sfn /tmp /opt/owned/current && readlink /opt/owned/current'], { timeoutMs: 60000 });
  assert.equal(retarget.stdout.trim(), '/tmp', 'without the read-only root the write would have worked');
});

test('a legitimate forge build and test pass on the read-only root', { timeout: 600000 }, async (t) => {
  const config = dockerTestConfig();
  const docker = dockerFor(config);
  t.after(() => removeAll(docker, config.instance));
  await ensureImage(docker, FOUNDRY_IMAGE);
  const solc = await solcBytes(PLATFORM);
  const toml = '[profile.default]\nsrc = "src"\ntest = "test"\nout = "out"\ncache_path = "cache"\nsolc = "/work/solc"\noffline = true\n';
  const counter = '// SPDX-License-Identifier: MIT\npragma solidity ^0.8.0;\ncontract Counter { uint256 public number; function increment() public { number++; } }\n';
  const counterTest = '// SPDX-License-Identifier: MIT\npragma solidity ^0.8.0;\nimport {Counter} from "../src/Counter.sol";\n'
    + 'contract CounterTest { function test_increment() public { Counter c = new Counter(); c.increment(); require(c.number() == 1, "bad"); } }\n';
  const got = {};
  const result = await run(config, docker, [async (ctx) => {
    const put = (file, bytes, mode = '0644') => ctx.exec(['sh', '-c', `mkdir -p "$(dirname "$1")" && cat > "$1" && chmod ${mode} "$1"`, 'put', file], { name: `put:${file}`, stdin: Buffer.from(bytes), timeoutMs: 60000 });
    // solc arrives on stdin, as claim content does; the work tree is the one tmpfs that may hold programs.
    await put('/work/solc', solc, '0755');
    await put('/work/foundry.toml', toml);
    await put('/work/src/Counter.sol', counter);
    await put('/work/test/Counter.t.sol', counterTest);
    got.build = await ctx.exec(['forge', 'build'], { name: 'build', timeoutMs: 240000 });
    got.test = await ctx.exec(['forge', 'test'], { name: 'test', timeoutMs: 240000 });
    got.wrote = await ctx.exec(['sh', '-c', 'ls -d /work/out /work/cache; ls -A "$HOME"'], { name: 'wrote', timeoutMs: 30000 });
  }], { image: FOUNDRY_IMAGE, limits: { memoryMb: 2048, cpus: 2, pids: 1024, runSeconds: 240, testSeconds: 240 } });
  assert.equal(result.outcome, 'definitive', JSON.stringify(result.abstain));
  assert.equal(got.build.exitCode, 0, got.build.stdout.text + got.build.stderr.text);
  assert.equal(got.test.exitCode, 0, got.test.stdout.text + got.test.stderr.text);
  assert.match(got.test.stdout.text, /\[PASS\] test_increment\(\)/);
  assert.match(got.wrote.stdout.text, /^\/work\/out$/m);
  assert.match(got.wrote.stdout.text, /^\/work\/cache$/m);
  assert.match(got.wrote.stdout.text, /\.foundry/, 'forge writes ~/.foundry, inside the $HOME tmpfs');
  assert.deepEqual(await leftovers(docker, config.instance), []);
});
