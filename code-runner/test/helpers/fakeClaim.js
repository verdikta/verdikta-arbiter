'use strict';

/**
 * A fake env-image sandbox for the claim pipeline: it answers the docker
 * execs the claim steps make (the runner's scripts, git, the declared forge
 * commands) the way a forge repository at the listed commit would, so the
 * gates and the schedule can be driven without Docker. Every handler can be
 * replaced per test; `calls()` lists the execs in order, decoded.
 */

const { fakeDocker, healthyDaemon, nonceOf } = require('./fakeDocker');

const BASE = '7f3a9c0000000000000000000000000000000000';
const POC = '9e1b2d0000000000000000000000000000000000';

const POC_PATCH = [
  'diff --git a/test/Exploit.t.sol b/test/Exploit.t.sol',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/test/Exploit.t.sol',
  '@@ -0,0 +1,3 @@',
  '+pragma solidity ^0.8.0;',
  '+contract ExploitTest { function test_drain() public { revert("vault drained"); } }',
  '+// end',
  ''
].join('\n');

const POC_DIFF = [
  'diff --git a/test/Exploit.t.sol b/test/Exploit.t.sol',
  'new file mode 100644',
  'index 0000000..95fbe20',
  '--- /dev/null',
  '+++ b/test/Exploit.t.sol',
  '@@ -0,0 +1,3 @@',
  '+pragma solidity ^0.8.0;',
  '+contract ExploitTest { function test_drain() public { revert("vault drained"); } }',
  '+// end',
  ''
].join('\n');

/** forge's JUnit for a list of suites: [{ suite: 'file:Contract', cases: [{ name, failure?, skipped?, error? }] }]. */
function junit(suites) {
  const body = suites.map(({ suite, cases }) => [
    `    <testsuite name="${suite}" tests="${cases.length}" skipped="0" errors="0" failures="0" time="0.001">`,
    ...cases.map((c) => {
      const inner = c.failure !== undefined ? `<failure message="${c.failure}"/>`
        : c.skipped ? '<skipped/>'
          : c.error !== undefined ? `<error message="${c.error}"/>` : '';
      return `        <testcase name="${c.name}" time="0.000">${inner}<system-out>[x] ${c.name}</system-out></testcase>`;
    }),
    '        <system-out>Suite result: FAILED.</system-out>',
    '    </testsuite>'
  ].join('\n')).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="Test run" tests="1" skipped="0" failures="1" errors="0" timestamp="2026-11-01T17:03:58.228+00:00" time="0.003">\n${body}\n</testsuites>\n`;
}

/** The PoC's JUnit on one run: test_drain() failing as an assertion. */
function drainFails(message = 'vault drained') {
  return junit([{ suite: 'test/Exploit.t.sol:ExploitTest', cases: [{ name: 'test_drain()', failure: message }] }]);
}

/** Decode one exec's argv: the program argv after the launcher, its env and stdin. */
function decode(call) {
  const args = call.args;
  const i = args.indexOf('vcr-launch');
  const argv = i >= 0 ? args.slice(i + 2) : [];
  const env = {};
  for (let j = 0; j < (i >= 0 ? i : args.length); j += 1) {
    if (args[j] === '--env') {
      const kv = args[j + 1];
      const eq = kv.indexOf('=');
      env[kv.slice(0, eq)] = kv.slice(eq + 1);
    }
  }
  let kind = null;
  let sub = null;
  if (argv[0] === 'git') {
    kind = 'git';
    let k = 1;
    while (argv[k] === '-c') k += 2;
    sub = argv.slice(k);
  } else if (argv[0] === '/bin/sh' && argv[1] === '-c') {
    kind = argv[3] || 'sh';
  } else if (argv[0] === 'cat') {
    kind = 'cat';
  }
  return { argv, env, stdin: call.stdin, kind, sub, nonce: nonceOf(args) };
}

/**
 * @param {object} [o]
 * @param {Function[]|string[]} [o.poc] - per PoC run (1-3): the JUnit text, or a handler returning { exitCode, stdout, stderr }
 * @param {object} [o.git] - overrides by git subcommand key (see `key` below)
 * @param {object} [o.scripts] - overrides by runner script name (vcr-procs, vcr-checkout, vcr-build, vcr-cleanup)
 */
function claimSandbox({ poc = [drainFails(), drainFails(), drainFails()], git = {}, scripts = {}, diff = POC_DIFF } = {}) {
  let committed = false;
  let pocRun = 0;
  const gitDefaults = {
    'rev-parse': (d) => (d.sub.includes('--git-common-dir') ? { stdout: '/work/.git\n/work/.git\n' } : { stdout: `${committed ? POC : BASE}\n` }),
    'read-tree': () => ({ exitCode: 0 }),
    submodule: () => ({ exitCode: 0 }),
    'update-index': () => ({ exitCode: 0 }),
    status: () => ({ stdout: '' }),
    'apply --numstat': () => ({ stdout: '3\t0\ttest/Exploit.t.sol\0' }),
    'apply --index': () => ({ exitCode: 0 }),
    'diff --name-status': () => ({ stdout: 'A\0test/Exploit.t.sol\0' }),
    'diff --numstat': () => ({ stdout: '3\t0\ttest/Exploit.t.sol\0' }),
    'diff -U0': () => ({ stdout: diff }),
    'ls-tree': () => ({ stdout: 'foundry.toml\0lib/forge-std\0src/Vault.sol\0test/Vault.t.sol\0' }),
    checkout: () => ({ exitCode: 0 }),
    commit: () => { committed = true; return { exitCode: 0 }; },
    reset: () => ({ exitCode: 0 })
  };
  const scriptDefaults = {
    'vcr-procs': () => ({ stdout: '1\n7\n' }),
    'vcr-checkout': () => ({ exitCode: 0 }),
    'vcr-build': () => ({ exitCode: 0, stdout: 'Compiling 3 files with Solc 0.8.31\n' }),
    'vcr-cleanup': () => ({ stdout: 'killed 0\n' }),
    'vcr-poc': (d) => {
      pocRun += 1;
      const h = poc[pocRun - 1];
      if (typeof h === 'function') return h(d, pocRun);
      return { exitCode: 1, stdout: h === undefined ? '' : h };
    }
  };
  const key = (sub) => {
    if (sub[0] === 'apply') return sub.includes('--numstat') ? 'apply --numstat' : 'apply --index';
    if (sub[0] === 'diff') return sub.includes('--name-status') ? 'diff --name-status' : sub.includes('--numstat') ? 'diff --numstat' : 'diff -U0';
    return sub[0];
  };
  const docker = fakeDocker(healthyDaemon({
    step: (args, opts, calls) => {
      const d = decode(calls[calls.length - 1]);
      if (d.kind === 'git') {
        const k = key(d.sub);
        const h = git[k] || gitDefaults[k];
        if (!h) throw new Error(`unexpected git ${d.sub.join(' ')}`);
        return h(d);
      }
      const h = scripts[d.kind] || scriptDefaults[d.kind];
      if (!h) throw new Error(`unexpected exec ${JSON.stringify(d.argv.slice(0, 4))}`);
      return h(d);
    }
  }));
  const execs = () => docker.callsOf('exec').map(decode).filter((d) => d.kind && d.argv[3] !== 'vcr-probe' && d.argv[3] !== 'vcr-launcher-check');
  return { docker, execs };
}

module.exports = { BASE, POC, POC_PATCH, POC_DIFF, junit, drainFails, decode, claimSandbox };
