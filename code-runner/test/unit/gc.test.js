'use strict';

// Acceptance: GC of labelled leftovers (design §9.2 step 10: a host-side GC
// timer removes anything a crash left behind).

const test = require('node:test');
const assert = require('node:assert/strict');
const { collectLeftovers, psArgs } = require('../../src/gc');
const { fakeDocker } = require('../helpers/fakeDocker');

const NOW = 1790000000;

test('lists only this instance\'s labelled containers', () => {
  assert.deepEqual(psArgs('default'), [
    'ps', '--all', '--no-trunc',
    '--filter', 'label=verdikta.code-runner.instance=default',
    '--format', '{{.Names}}\t{{.Label "verdikta.code-runner.expires"}}'
  ]);
  assert.throws(() => psArgs('a b'), /instance/);
});

test('removes what no live run owns, and anything past its expiry', async () => {
  const docker = fakeDocker({
    ps: () => ({
      stdout: [
        `vcr-aaaaaaaaaaaaaaaa-1\t${NOW + 600}`, // a crashed run's container, not expired yet
        `vcr-bbbbbbbbbbbbbbbb-1\t${NOW + 600}`, // live run
        `vcr-cccccccccccccccc-1\t${NOW - 1}`, // live run, but past its expiry
        `vcr-dddddddddddddddd-2\t`, // no expiry label
        'not-ours\t1', // name outside the runner's pattern: never touched
        ''
      ].join('\n')
    }),
    rm: () => ({})
  });
  const active = new Set(['vcr-bbbbbbbbbbbbbbbb-1', 'vcr-cccccccccccccccc-1']);
  const r = await collectLeftovers({ docker, instance: 'default', active, now: NOW });
  assert.deepEqual(r.removed.sort(), ['vcr-aaaaaaaaaaaaaaaa-1', 'vcr-cccccccccccccccc-1', 'vcr-dddddddddddddddd-2']);
  const rm = docker.callsOf('rm');
  assert.equal(rm.length, 1);
  assert.deepEqual(rm[0].args.slice(0, 3), ['rm', '--force', '--volumes']);
  assert.deepEqual(rm[0].args.slice(3).sort(), r.removed.sort());
});

test('nothing to remove means no rm call', async () => {
  const docker = fakeDocker({ ps: () => ({ stdout: `vcr-bbbbbbbbbbbbbbbb-1\t${NOW + 600}\n` }) });
  const r = await collectLeftovers({ docker, instance: 'default', active: new Set(['vcr-bbbbbbbbbbbbbbbb-1']), now: NOW });
  assert.deepEqual(r.removed, []);
  assert.equal(docker.callsOf('rm').length, 0);
});

test('an unreachable daemon is reported, not thrown', async () => {
  const docker = fakeDocker({ ps: () => ({ exitCode: 1, stderr: 'Cannot connect to the Docker daemon' }) });
  const r = await collectLeftovers({ docker, instance: 'default', active: new Set(), now: NOW });
  assert.deepEqual(r.removed, []);
  assert.match(r.error, /Cannot connect/);
});
