'use strict';

// Against a real daemon: the container really has the §9.1 isolation, steps
// run through docker exec with argv arrays, and definitive results carry
// their exit codes and 32 KiB head/tail logs.

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const { executeRun } = require('../../src/pipeline');
const { runText } = require('../../src/docker');
const {
  RUNTIME, PLATFORM, TEST_IMAGE, silent, dockerTestConfig, dockerFor, ensureTestImage, leftovers, removeAll, smallLimits
} = require('./helpers');

function run(config, docker, steps, over = {}) {
  const receivedAt = Date.now();
  return executeRun({
    docker, config, limits: smallLimits(over.limits), image: TEST_IMAGE, runId: over.runId || '00000000000000a1', steps,
    receivedAt, deadlineAt: receivedAt + (over.deadlineMs || 120000), active: new Set(), log: silent
  });
}

test('the sandbox has the §9.1 isolation, whatever the image would like', { timeout: 180000 }, async (t) => {
  const config = dockerTestConfig();
  const docker = dockerFor(config);
  t.after(() => removeAll(docker, config.instance));
  await ensureTestImage(docker);

  let inspected;
  const inside = {};
  const steps = [async (ctx) => {
    const name = ctx.sandboxName;
    const r = await runText(docker, ['inspect', '--format', '{{json .}}', name], { timeoutMs: 30000 });
    inspected = JSON.parse(r.stdout);
    for (const [key, argv] of Object.entries({
      uid: ['id', '-u'],
      gid: ['id', '-g'],
      status: ['cat', '/proc/self/status'],
      netdev: ['cat', '/proc/net/dev'],
      route: ['cat', '/proc/net/route'],
      hostname: ['hostname'],
      env: ['env'],
      kernel: ['uname', '-r'],
      machine: ['uname', '-m']
    })) {
      inside[key] = (await ctx.exec(argv, { name: key, timeoutMs: 30000 })).stdout.text;
    }
  }];
  const result = await run(config, docker, steps);
  assert.equal(result.outcome, 'definitive', JSON.stringify(result.abstain));

  const hc = inspected.HostConfig;
  assert.equal(hc.Runtime, RUNTIME);
  assert.equal(hc.NetworkMode, 'none');
  assert.deepEqual(hc.CapDrop, ['ALL']);
  assert.equal(hc.CapAdd, null);
  assert.deepEqual(hc.SecurityOpt, ['no-new-privileges']);
  assert.equal(hc.Privileged, false);
  assert.equal(hc.PidsLimit, 512);
  assert.equal(hc.Memory, 512 * 1024 * 1024);
  assert.equal(hc.MemorySwap, 512 * 1024 * 1024);
  assert.equal(hc.NanoCpus, 1e9);
  assert.equal(hc.Init, true);
  assert.equal(hc.LogConfig.Type, 'none');
  assert.ok(!hc.Binds || hc.Binds.length === 0, 'no binds');
  assert.deepEqual(inspected.Mounts, []);
  assert.equal(inspected.Config.User, '10001:10001');
  assert.equal(inspected.Config.Hostname, 'sandbox');
  assert.deepEqual(inspected.Config.Entrypoint, ['sleep']);
  for (const kv of ['TZ=UTC', 'LANG=C.UTF-8', 'CI=true', 'PYTHONHASHSEED=0']) {
    assert.ok(inspected.Config.Env.includes(kv), kv);
  }

  // The platform asked for is the one that runs.
  assert.equal(inside.machine.trim(), PLATFORM === 'linux/amd64' ? 'x86_64' : 'aarch64');
  assert.equal(result.platform, PLATFORM);
  assert.equal(inside.uid.trim(), '10001');
  assert.equal(inside.gid.trim(), '10001');
  assert.match(inside.status, /^CapEff:\s*0+$/m);
  assert.match(inside.status, /^NoNewPrivs:\s*1$/m);
  // --network none: loopback only. (Some kernels add idle tunnel devices,
  // tunl0, gre0 ..., to every namespace; none of them is a way out.)
  const interfaces = inside.netdev.split('\n').slice(2).map((l) => l.split(':')[0].trim()).filter(Boolean);
  assert.ok(interfaces.includes('lo'), `interfaces: ${interfaces}`);
  assert.deepEqual(interfaces.filter((i) => /^(eth|en|veth|wl|br|docker)/.test(i)), [], `interfaces: ${interfaces}`);
  assert.deepEqual(inside.route.split('\n').slice(1).filter((l) => l.trim()), [], 'no IPv4 route');
  assert.equal(inside.hostname.trim(), 'sandbox');
  assert.match(inside.env, /^TZ=UTC$/m);
  assert.doesNotMatch(inside.env, /CODE_RUNNER|TOKEN|API_KEY/);
  if (RUNTIME === 'runsc') {
    // gVisor presents its own kernel, not the host's.
    assert.notEqual(inside.kernel.trim(), os.release());
  }
  assert.deepEqual(await leftovers(docker, config.instance), []);
});

test('definitive steps: exit codes as they are, logs cut to 32 KiB head and tail', { timeout: 180000 }, async (t) => {
  const config = dockerTestConfig();
  const docker = dockerFor(config);
  t.after(() => removeAll(docker, config.instance));
  await ensureTestImage(docker);

  const records = {};
  const steps = [async (ctx) => {
    records.ok = await ctx.exec(['true'], { name: 'ok', timeoutMs: 30000 });
    records.three = await ctx.exec(['sh', '-c', 'echo to-stderr >&2; exit 3'], { name: 'three', timeoutMs: 30000 });
    records.missing = await ctx.exec(['no-such-binary'], { name: 'missing', timeoutMs: 30000 });
    // 200 KiB of output: the step keeps the first and last 32 KiB.
    records.loud = await ctx.exec(['sh', '-c', 'head -c 204800 /dev/zero | tr "\\0" "a"; printf END'], { name: 'loud', timeoutMs: 30000 });
    records.stdin = await ctx.exec(['wc', '-c'], { name: 'stdin', timeoutMs: 30000, stdin: Buffer.alloc(12345, 1) });
    // After the launcher's exec, the program sees neither the launcher nor its nonce.
    records.self = await ctx.exec(['sh', '-c', 'tr "\\000" " " < /proc/self/cmdline; echo; env'], { name: 'self', timeoutMs: 30000 });
    const file = await ctx.readFile('/etc/hostname', { maxBytes: 4 });
    records.file = file;
  }];
  const result = await run(config, docker, steps);
  assert.equal(result.outcome, 'definitive', JSON.stringify(result.abstain));
  assert.equal(records.ok.exitCode, 0);
  assert.equal(records.three.exitCode, 3);
  assert.equal(records.three.stderr.text, 'to-stderr\n');
  assert.equal(records.missing.exitCode, 127);
  assert.equal(records.loud.stdout.totalBytes, 204803);
  assert.equal(records.loud.stdout.omittedBytes, 204803 - 65536);
  assert.ok(records.loud.stdout.text.endsWith('aaaEND'));
  assert.equal(records.stdin.stdout.text.trim(), '12345');
  for (const r of Object.values(records).filter((x) => x && x.stdout && typeof x.stdout.text === 'string')) {
    assert.ok(!r.stdout.text.startsWith('vcr-start'), `${r.name}: the start line is stripped`);
  }
  assert.match(records.self.stdout.text, /^sh -c /);
  assert.doesNotMatch(records.self.stdout.text, /vcr-launch|vcr-start|[0-9a-f]{32}/);
  assert.equal(records.missing.started, true, 'the launcher started; exec found no program');
  assert.equal(records.file.overLimit, true);
  assert.equal(records.file.bytes.toString(), 'sand');
  assert.deepEqual(result.steps.map((s) => s.name), ['ok', 'three', 'missing', 'loud', 'stdin', 'self', 'read:/etc/hostname']);
  assert.deepEqual(await leftovers(docker, config.instance), []);
});

test('the launcher check and the counters probe, run for real in the sandbox', { timeout: 180000 }, async (t) => {
  const { LAUNCHER_CHECK, PROBE_SCRIPT } = require('../../src/launcher');
  const config = dockerTestConfig();
  const docker = dockerFor(config);
  t.after(() => removeAll(docker, config.instance));
  await ensureTestImage(docker);

  const got = {};
  const check = (p) => ['/bin/sh', '-c', LAUNCHER_CHECK, 'vcr-launcher-check', p];
  const probe = (...files) => ['/bin/sh', '-c', PROBE_SCRIPT, 'vcr-probe', ...files];
  const steps = [async (ctx) => {
    const run = async (name, argv) => { got[name] = await ctx.exec(argv, { name, timeoutMs: 30000 }); };
    await run('setup', ['sh', '-c', [
      'set -e',
      // An interpreter the sandbox user owns: read-only mode does not help, the owner can chmod it.
      'mkdir -p /tmp/own && cp /bin/sh /tmp/own/sh && chmod 0555 /tmp/own/sh',
      // A root-owned interpreter reached through a link in a directory the user owns.
      'mkdir -p /tmp/anc && ln -sf /bin/sh /tmp/anc/sh && chmod 0555 /tmp/anc',
      // Counter-like files: one readable, one that exists but cannot be read.
      'mkdir -p /tmp/cg && printf "oom_kill 0\\n" > /tmp/cg/memory.events && printf "max 0\\n" > /tmp/cg/pids.events',
      'cp /tmp/cg/pids.events /tmp/cg/locked.events && chmod 000 /tmp/cg/locked.events'
    ].join('\n')]);
    await run('checkImage', check('/bin/sh'));
    await run('checkOwned', check('/tmp/own/sh'));
    await run('checkAncestor', check('/tmp/anc/sh'));
    await run('probeOk', probe('/tmp/cg/memory.events', '/tmp/cg/pids.events', '/tmp/cg/absent'));
    await run('probeLocked', probe('/tmp/cg/memory.events', '/tmp/cg/locked.events'));
  }];
  const receivedAt = Date.now();
  const result = await executeRun({
    docker, config, limits: smallLimits(), image: TEST_IMAGE, runId: '00000000000000a3', steps,
    receivedAt, deadlineAt: receivedAt + 120000, active: new Set(), log: silent
  });
  assert.equal(result.outcome, 'definitive', JSON.stringify(result.abstain));
  assert.equal(got.setup.exitCode, 0, got.setup.stderr.text);
  assert.equal(got.checkImage.exitCode, 0, 'the image\'s own /bin/sh is safe');
  assert.equal(got.checkOwned.exitCode, 1, 'an interpreter the sandbox user owns is refused');
  assert.equal(got.checkAncestor.exitCode, 1, 'a link in a directory the sandbox user owns is refused');
  assert.equal(got.probeOk.exitCode, 0);
  assert.equal(got.probeOk.stdout.text, '==> /tmp/cg/memory.events <==\noom_kill 0\n==> /tmp/cg/pids.events <==\nmax 0\n');
  assert.equal(got.probeLocked.exitCode, 4, 'a counter file that exists but cannot be read fails the probe');
  assert.deepEqual(await leftovers(docker, config.instance), []);
});
