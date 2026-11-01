'use strict';

// Acceptance: every sandbox runs with a read-only root filesystem. The only
// writable places are the capped tmpfs mounts for the work tree, $HOME and
// /tmp, so claim code cannot create, replace or retarget anything on
// /bin/sh's path; the launcher path check stays as a second check. A real
// forge build and test still pass.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { executeRun } = require('../../src/pipeline');
const { createArgs, SCRATCH_MB } = require('../../src/sandbox');
const { LAUNCHER_CHECK } = require('../../src/launcher');
const { runText } = require('../../src/docker');
const {
  RUNTIME, PLATFORM, TEST_IMAGE, silent, dockerTestConfig, dockerFor, ensureImage, ensureTestImage, leftovers, removeAll, smallLimits
} = require('./helpers');

/** Foundry's published image (stable, 1.5.1), the multi-platform index pinned by digest. */
const FOUNDRY_IMAGE = 'ghcr.io/foundry-rs/foundry@sha256:043752653d5be351c71709091b3db97c4421c907eb40ea294195e7f532aadf46';
/** solc 0.8.31 static builds, as binaries.soliditylang.org lists them. */
const SOLC = {
  'linux/amd64': { url: 'https://binaries.soliditylang.org/linux-amd64/solc-linux-amd64-v0.8.31+commit.fd3a2265', sha256: 'aac9cd0116e9ae0cd3d8f64a8641381845dc9f12e2a52653de36fb619323e557' },
  'linux/arm64': { url: 'https://binaries.soliditylang.org/linux-arm64/solc-linux-arm64-v0.8.31+commit.fd3a2265', sha256: 'acf358d82da7db033debb2f4db11e1c9cfcb02b0cb5b5ddbb9635ad817b41bdd' }
};

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
  for (const name of ['root', 'etc', 'usrBin', 'varTmp', 'replaceSh', 'retargetSh', 'newBin']) {
    assert.match(got[name].stdout.text, /Read-only file system/i, `${name}: ${got[name].stdout.text}`);
  }
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
  for (const [name, script] of Object.entries(attacks)) {
    const r = await asClaim(script);
    assert.notEqual(r.exitCode, 0, `${name} succeeded`);
    assert.match(r.stderr, /Read-only file system/i, `${name}: ${r.stderr}`);
  }
  // The path still resolves as the image had it.
  assert.equal((await asClaim('readlink /opt/owned/current')).stdout.trim(), '/usr/bin');
  // The backup check still refuses such an image at launch.
  const backup = await runText(docker, ['exec', '--user', '10001:10001', box, '/bin/sh', '-c', LAUNCHER_CHECK, 'vcr-launcher-check', '/bin/sh'], { timeoutMs: 60000 });
  assert.equal(backup.exitCode, 1, backup.stderr);

  // Control: the same image without --read-only lets the claim retarget the link.
  const c = await runText(docker, ['run', '--detach', '--pull', 'never', '--platform', PLATFORM, '--name', control, '--network', 'none', '--user', '10001:10001', '--entrypoint', 'sleep', image, '300'], { timeoutMs: 120000 });
  assert.equal(c.exitCode, 0, c.stderr);
  const retarget = await runText(docker, ['exec', control, 'sh', '-c', 'ln -sfn /tmp /opt/owned/current && readlink /opt/owned/current'], { timeoutMs: 60000 });
  assert.equal(retarget.stdout.trim(), '/tmp', 'without the read-only root the write would have worked');
});

async function solcBytes(platform) {
  const pin = SOLC[platform];
  const cached = path.join(os.tmpdir(), `vcr-${path.basename(pin.url)}`);
  if (fs.existsSync(cached)) {
    const bytes = fs.readFileSync(cached);
    if (crypto.createHash('sha256').update(bytes).digest('hex') === pin.sha256) return bytes;
  }
  const res = await fetch(pin.url);
  assert.equal(res.status, 200, `GET ${pin.url}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), pin.sha256, 'solc checksum');
  fs.writeFileSync(cached, bytes);
  return bytes;
}

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
