'use strict';

// Node A26 (owner decision Q84): the class time floors. A listing's limits are
// measured by its listing check on the signing workflow's runner, which is
// several times faster than an arbiter running claims under gVisor, so a claim
// gets at least @verdikta/common's CLASS_TIME_FLOORS (build 60 s, test 30 s,
// run 180 s), whatever its listing says. common's effectiveTimeLimits is the
// one place the floors are applied: checkSpec calls it, and the runner holds no
// copy of the values. What checkSpec refuses is unchanged.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { checkSpec } = require('../../src/classLimits');
const common = require('../../src/common');
const { createServer } = require('../../src/server');
const { fakeDocker, healthyDaemon } = require('../helpers/fakeDocker');
const { testConfig, request } = require('../helpers/http');
const { spec, runRequest } = require('../helpers/requests');

/** The owner's Q84 values, as @verdikta/common 1.9.0-attest.6 holds them. */
const Q84 = Object.freeze({ buildSeconds: 60, testSeconds: 30, runSeconds: 180 });
const time = (l) => ({ buildSeconds: l.buildSeconds, testSeconds: l.testSeconds, runSeconds: l.runSeconds });
const withTime = (t) => spec({ limits: { cpus: 1, memoryMb: 1024, maxPatchBytes: 1000, ...t } });

test('Q84: a spec whose time limits are 12/4/46 runs with the class floors, 60/30/180; its other limits are its own', () => {
  const r = checkSpec(withTime({ buildSeconds: 12, testSeconds: 4, runSeconds: 46 }));
  assert.equal(r.ok, true, JSON.stringify(r.issues));
  assert.deepEqual({ ...r.limits }, {
    cpus: 1, memoryMb: 1024, pids: 4096, buildSeconds: 60, testSeconds: 30, runSeconds: 180,
    maxPatchBytes: 1000, patchExpansionBytes: 50000000, platform: 'linux/amd64'
  });
  assert.ok(Object.isFrozen(r.limits));
  // The schema's minimum (1) still holds: the least a spec may state is 1, and it gets the floor.
  assert.deepEqual(time(checkSpec(withTime({ buildSeconds: 1, testSeconds: 1, runSeconds: 1 })).limits), Q84);
});

test('Q84: a time limit at or above its floor keeps its own value; each limit is floored on its own', () => {
  for (const t of [
    { buildSeconds: 60, testSeconds: 30, runSeconds: 180 },
    { buildSeconds: 61, testSeconds: 31, runSeconds: 181 },
    { buildSeconds: 90, testSeconds: 180, runSeconds: 360 },
    { buildSeconds: 90, testSeconds: 360, runSeconds: 360 }
  ]) {
    const r = checkSpec(withTime(t));
    assert.equal(r.ok, true, JSON.stringify(r.issues));
    assert.deepEqual(time(r.limits), t, JSON.stringify(t));
  }
  // One below, the others above: only that one moves.
  assert.deepEqual(time(checkSpec(withTime({ buildSeconds: 12, testSeconds: 100, runSeconds: 200 })).limits), { buildSeconds: 60, testSeconds: 100, runSeconds: 200 });
  assert.deepEqual(time(checkSpec(withTime({ buildSeconds: 75, testSeconds: 4, runSeconds: 200 })).limits), { buildSeconds: 75, testSeconds: 30, runSeconds: 200 });
  assert.deepEqual(time(checkSpec(withTime({ buildSeconds: 75, testSeconds: 40, runSeconds: 46 })).limits), { buildSeconds: 75, testSeconds: 40, runSeconds: 180 });
});

test('Q84: a time limit the spec leaves out is the class maximum, as before (every floor is below its maximum)', () => {
  assert.deepEqual(time(checkSpec(withTime({ testSeconds: 4 })).limits), { buildSeconds: 90, testSeconds: 30, runSeconds: 360 });
  const none = spec();
  delete none.limits;
  assert.deepEqual(time(checkSpec(none).limits), { buildSeconds: 90, testSeconds: 360, runSeconds: 360 });
});

test('Q84: the floors lift nothing checkSpec refuses: above a maximum, a test limit above the run limit, an unknown field, below the schema minimum', () => {
  const issues = (t) => checkSpec(withTime(t)).issues.map((i) => `${i.code} ${i.path}`);
  assert.deepEqual(issues({ buildSeconds: 91, testSeconds: 361, runSeconds: 361 }),
    ['LIMIT_ABOVE_CLASS_MAX /spec/limits/buildSeconds', 'LIMIT_ABOVE_CLASS_MAX /spec/limits/testSeconds', 'LIMIT_ABOVE_CLASS_MAX /spec/limits/runSeconds']);
  // Both below their floors, which would raise them to 30 and 180: the spec as stated is still refused.
  assert.deepEqual(issues({ buildSeconds: 12, testSeconds: 20, runSeconds: 10 }), ['LIMIT_TEST_ABOVE_RUN /spec/limits/testSeconds']);
  assert.deepEqual(issues({ buildSeconds: 12, testSeconds: 40, runSeconds: 35 }), ['LIMIT_TEST_ABOVE_RUN /spec/limits/testSeconds']);
  assert.deepEqual(issues({ buildSeconds: 12, timeSeconds: 4 }), ['UNKNOWN_FIELD /spec/limits/timeSeconds']);
  assert.deepEqual(issues({ buildSeconds: 0, testSeconds: 4.5, runSeconds: '46' }),
    ['SCHEMA /spec/limits/buildSeconds', 'SCHEMA /spec/limits/testSeconds', 'SCHEMA /spec/limits/runSeconds']);
  for (const t of [{ buildSeconds: 91 }, { testSeconds: 20, runSeconds: 10 }, { buildSeconds: 0 }]) assert.equal(checkSpec(withTime(t)).limits, null, JSON.stringify(t));
});

test('Q84: the floors are common\'s, applied by common\'s function: checkSpec gives what effectiveTimeLimits gives', () => {
  const { codeReview } = require('@verdikta/common');
  assert.equal(typeof codeReview.effectiveTimeLimits, 'function', '@verdikta/common has effectiveTimeLimits (1.9.0-attest.6)');
  assert.deepEqual({ ...codeReview.CLASS_TIME_FLOORS }, Q84, 'common holds the owner\'s values');
  assert.equal(common.effectiveTimeLimits, codeReview.effectiveTimeLimits, 'the runner reads common\'s function, not a copy');
  for (const t of [{ buildSeconds: 12, testSeconds: 4, runSeconds: 46 }, { buildSeconds: 89, testSeconds: 29, runSeconds: 181 }, { testSeconds: 4 }]) {
    assert.deepEqual(time(checkSpec(withTime(t)).limits), time(codeReview.effectiveTimeLimits({ buildSeconds: 90, testSeconds: 360, runSeconds: 360, ...t })), JSON.stringify(t));
  }
});

test('Q84 review focus: no copy of the floors in src/: not the name, not the values beside a time limit', () => {
  const SRC = path.join(__dirname, '..', '..', 'src');
  const LOCAL = [
    [/\bCLASS_TIME_FLOORS\b/, 'the floors by name (src/ calls effectiveTimeLimits)'],
    [/\b(?:buildSeconds|testSeconds|runSeconds)\b[^\n]{0,40}\b(?:60|30|180)\b(?![.0-9])/, 'a floor value beside a time limit'],
    [/\b(?:60|30|180)\b(?![.0-9])[^\n]{0,40}\b(?:buildSeconds|testSeconds|runSeconds)\b/, 'a floor value beside a time limit'],
    [/\bMath\.max\([^)\n]*\b(?:60|30|180)\b(?![.0-9])/, 'a floor applied by hand']
  ];
  for (const name of fs.readdirSync(SRC).filter((f) => f.endsWith('.js'))) {
    const code = fs.readFileSync(path.join(SRC, name), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
    for (const [re, what] of LOCAL) assert.doesNotMatch(code, re, `${name} holds its own copy of ${what}`);
  }
});

test('Q84 over HTTP: POST /v1/runs with a spec stating 12/4/46 runs its steps under 60/30/180, and its answer says so', async (t) => {
  const seen = [];
  const runner = createServer({
    config: testConfig(), docker: fakeDocker(healthyDaemon()), log: { info() {}, warn() {}, error() {}, debug() {} },
    statfs: async () => ({ bavail: 1000, bsize: 4096 }), meminfo: async () => ({ availableMb: 1e6, error: null }),
    stepsFor: (req, limits) => { seen.push(limits); return []; }
  });
  const address = await runner.listen();
  t.after(() => runner.close());
  const target = address.socketPath ? { socketPath: address.socketPath } : { host: address.host, port: address.port };
  const res = await request(target, { method: 'POST', path: '/v1/runs', body: runRequest({ spec: withTime({ buildSeconds: 12, testSeconds: 4, runSeconds: 46 }) }) });
  assert.equal(res.status, 200, res.raw);
  assert.deepEqual(time(res.body.limits), Q84);
  assert.equal(seen.length, 1);
  assert.deepEqual(time(seen[0]), Q84, 'the claim steps are built with the floored limits');
});
