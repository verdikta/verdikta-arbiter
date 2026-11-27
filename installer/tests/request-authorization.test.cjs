const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { checkRequestAuthorization, VERSION_SELECTOR } = require('../util/check-request-authorization.cjs');
const operator = '0x1111111111111111111111111111111111111111';
const one = `0x${'0'.repeat(63)}1`, zero = `0x${'0'.repeat(64)}`;
const options = { operator, chainId: 84532, rpcUrls: 'https://rpc.invalid/SECRET' };
const valid = request => request.method === 'eth_chainId' ? '0x14a34' : request.method === 'eth_getCode' ? '0x6080' :
  request.params[0].data === VERSION_SELECTOR ? one : zero;
const fetcher = result => async (_url, init) => {
  assert.equal(init.redirect, 'error'); assert.ok(init.signal);
  const request = JSON.parse(init.body);
  assert.ok(['eth_chainId', 'eth_getCode', 'eth_call'].includes(request.method));
  return { ok: true, json: async () => ({ jsonrpc: '2.0', id: request.id, result: result(request) }) };
};
test('read-only preflight verifies chain, deployed code, version and nonexistent-request denial', async () => {
  const calls = [];
  await checkRequestAuthorization({ ...options, fetchImpl: fetcher(request => { calls.push(request); return valid(request); }) });
  assert.deepEqual(calls.map(call => call.method), ['eth_chainId', 'eth_getCode', 'eth_call', 'eth_call']);
  for (const call of calls.filter(call => call.method === 'eth_call')) assert.equal(call.params[1], 'latest');
});
for (const [name, change] of [
  ['wrong chain', req => req.method === 'eth_chainId' ? '0x2105' : valid(req)],
  ['missing code', req => req.method === 'eth_getCode' ? '0x' : valid(req)],
  ['old operator', req => req.method === 'eth_call' ? '0x' : valid(req)],
  ['wrong version', req => req.method === 'eth_call' ? zero : valid(req)],
  ['oversized version', req => req.method === 'eth_call' ? one + '00' : valid(req)],
  ['always-true fallback', req => req.method === 'eth_call' ? one : valid(req)],
]) test(`preflight refuses ${name}`, async () => {
  await assert.rejects(() => checkRequestAuthorization({ ...options, fetchImpl: fetcher(change) }), /Cannot verify request-authorization/);
});
test('RPC errors, malformed JSON, wrong response IDs and failures do not expose URLs or pass', async () => {
  for (const fetchImpl of [
    async () => { throw new Error('https://rpc.invalid/SECRET'); },
    async () => ({ ok: false }),
    async () => ({ ok: true, json: async () => { throw new Error('SECRET'); } }),
    async () => ({ ok: true, json: async () => ({ jsonrpc: '2.0', id: 99, result: '0x14a34' }) }),
    async () => ({ ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, error: { message: 'SECRET' } }) }),
  ]) await assert.rejects(() => checkRequestAuthorization({ ...options, fetchImpl }), error => {
    assert.match(error.message, /Cannot verify/); assert.doesNotMatch(error.message, /SECRET/); return true;
  });
});
test('tries another configured endpoint but still verifies its chain', async () => {
  const visited = [];
  await checkRequestAuthorization({ ...options, rpcUrls: 'https://bad.invalid;https://good.invalid',
    fetchImpl: async (url, init) => {
      visited.push(url); if (url.includes('bad')) throw new Error('offline'); return fetcher(valid)(url, init);
    } });
  assert.deepEqual([...new Set(visited)], ['https://bad.invalid', 'https://good.invalid']);
});
test('rejects incomplete configuration before contacting a provider', async () => {
  for (const override of [{ operator: '' }, { operator: `0x${'0'.repeat(40)}` }, { chainId: 1 }, { rpcUrls: '' }]) {
    await assert.rejects(() => checkRequestAuthorization({ ...options, ...override,
      fetchImpl: async () => assert.fail('RPC must not run') }));
  }
});
test('a changed job template does not end the upgrade: declined regeneration means the in-place update', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'verdikta-admission-gate-'));
  try {
    const source = fs.readFileSync(path.join(__dirname, '../bin/upgrade-arbiter.sh'), 'utf8');
    // A top-level function of the script, by name: from "name() {" to the "}" that closes it.
    const fn = name => { const at = source.indexOf(`\n${name}() {`); assert.ok(at >= 0, name); return source.slice(at, source.indexOf('\n}\n', at) + 3); };
    const gate = fn('job_template_without_timeouts') + fn('check_job_spec_template');
    const repo = path.join(root, 'repo'), target = path.join(root, 'target');
    fs.mkdirSync(repo); fs.mkdirSync(target);
    const template = fs.readFileSync(path.join(__dirname, '../../chainlink-node/basicJobSpec'), 'utf8');
    fs.writeFileSync(path.join(repo, 'basicJobSpec'), template);
    for (const modified of [
      template.replace('    authorize [type="conditional"', '    authorize [type="noop"'),
      template.replace('    reauthorize [type="conditional"', '    reauthorize [type="noop"'),
      template.replace('authorize -> decode_cbor', 'decode_log -> decode_cbor'),
      template.replace('reauthorize -> submit_tx', 'encode_tx -> submit_tx'),
    ]) {
      fs.writeFileSync(path.join(target, 'basicJobSpec'), modified);
      const run = accept => spawnSync('bash', ['-c', `set -e
        ask_yes_no() { test "$ACCEPT" = yes; }
        regenerate_job_specs() { echo REGENERATED; }
        cleanup_on_error() { echo ARBITER-RESTARTED; exit 1; }
        ${gate}
        check_job_spec_template
      `], { encoding: 'utf8', env: { ...process.env, ACCEPT: accept, REPO_CHAINLINK_NODE: repo, TARGET_CHAINLINK_NODE: target } });
      // Any difference is seen (a name-only check would miss removed edges or gates moved
      // after work), and the answer to it is the same: the live jobs are replaced under their
      // own ids after the restart. Nothing ends the upgrade here, and nothing is regenerated.
      const declined = run('no');
      assert.equal(declined.status, 0);
      assert.match(declined.stdout, /updated in place after the restart/);
      assert.doesNotMatch(declined.stdout, /ARBITER-RESTARTED|REGENERATED/);
      assert.equal(run('yes').status, 0);
      assert.match(run('yes').stdout, /REGENERATED/);
      assert.doesNotMatch(run('yes').stdout, /ARBITER-RESTARTED/);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('operator preflight precedes shutdown/job changes and deployment never removes hooks', () => {
  const read = name => fs.readFileSync(path.join(__dirname, '../bin', name), 'utf8');
  const upgrade = read('upgrade-arbiter.sh'), configure = read('configure-node.sh'), deploy = read('deploy-contracts.sh');
  const modeRead = 'node "$UTIL_DIR/job-template.cjs" mode --install-dir "$TARGET_DIR"';
  assert.ok(upgrade.indexOf(modeRead) > 0 && upgrade.indexOf(modeRead) < upgrade.indexOf('"$TARGET_DIR/stop-arbiter.sh"'));
  // The live jobs are measured and replaced after the restart, with no question in between,
  // and before the timeouts step (which then finds this release's limits already there).
  const after = upgrade.indexOf('\n# Job template, after the restart.'), timeouts = upgrade.indexOf('\n# Job timeouts, after the restart');
  assert.ok(after > upgrade.indexOf('"$TARGET_DIR/stop-arbiter.sh"') && after < timeouts);
  assert.doesNotMatch(upgrade.slice(after, timeouts), /ask_yes_no/);
  // The job template's question is settled before the stop too, and nothing after the stop exits bare.
  const stop = upgrade.indexOf('"$TARGET_DIR/stop-arbiter.sh"');
  assert.ok(upgrade.indexOf('\njob_template_preflight || JOB_PREFLIGHT_RC=$?') > 0);
  assert.ok(upgrade.indexOf('\njob_template_preflight || JOB_PREFLIGHT_RC=$?') < stop);
  const template = upgrade.slice(upgrade.indexOf('\ncheck_job_spec_template() {'), upgrade.indexOf('\n}\n', upgrade.indexOf('\ncheck_job_spec_template() {')));
  assert.doesNotMatch(template, /^\s*exit\b/m, 'check_job_spec_template runs with the arbiter stopped: it must not exit without restarting it');
  const configureRead = 'node "$INSTALLER_DIR/util/job-template.cjs" mode';
  assert.ok(configure.indexOf(configureRead) > 0 && configure.indexOf(configureRead) < configure.indexOf('ensure_keys_exist "$ARBITER_COUNT"'));
  assert.ok(configure.indexOf(configureRead) < configure.indexOf('-X DELETE'));
  assert.ok(configure.indexOf('ensure_keys_exist "$ARBITER_COUNT"') > 0 && configure.indexOf('-X DELETE') > 0);
  // A legacy operator's jobs get the keeper gate before the credential is written into them.
  assert.ok(configure.indexOf('job-template.cjs" gate "$JOB_SPEC_FILE_ARBITER"') < configure.indexOf('render-job "$AUTH_INSTALL_ROOT" "$JOB_SPEC_FILE_ARBITER"'));
  assert.doesNotMatch(deploy, /sed.*OperatorMod|Remove the pre-request hook/);
  const registration = fs.readFileSync(path.join(__dirname, '../../arbiter-operator/scripts/register-oracle-cl.js'), 'utf8');
  assert.ok(registration.indexOf('await ensureRequestAuthorization(') < registration.indexOf('if (pendingJobs.length === 0)'));
  assert.ok(registration.indexOf('await ensureRequestAuthorization(') < registration.indexOf('await verdikta.approve('));
});
