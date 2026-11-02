'use strict';

/**
 * A fake env-image sandbox for the claim pipeline: it answers the docker
 * execs the claim steps make (the runner's scripts, git, the declared forge
 * commands) the way a forge repository at the listed commit would, so the
 * gates and the schedule can be driven without Docker. The image's git
 * objects are a real object store (test/helpers/gitStore.js): `git cat-file`
 * answers from it, and the packs the runner gives `git index-pack` are read
 * back and hashed independently, into the fresh repository. Every handler can be replaced per test; `execs()`
 * lists the execs in order, decoded.
 */

const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { fakeDocker, healthyDaemon, nonceOf } = require('./fakeDocker');
const { GitStore } = require('./gitStore');

const POC = '9e1b2d0000000000000000000000000000000000';

/** The default listed repository: a vault, its suite, foundry.toml, and forge-std as a submodule. */
function defaultImage(algo = 'sha1') {
  const store = new GitStore(algo);
  const dep = store.repo({ 'src/Test.sol': '// forge-std\n' }, 'forge-std');
  const files = {
    '.gitmodules': '[submodule "lib/forge-std"]\n\tpath = lib/forge-std\n\turl = https://github.com/foundry-rs/forge-std\n',
    'foundry.toml': '[profile.default]\n',
    'lib/forge-std': { gitlink: dep },
    'src/Vault.sol': 'contract Vault {}\n',
    'test/Vault.t.sol': 'contract VaultTest {}\n'
  };
  return { store, base: store.repo(files, 'base'), dep, files };
}

const BASE = defaultImage().base;

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

/** `/usr/bin/env -i K=V ... <command>`: the command and the fixed environment it gets (null when it is not run that way). */
function stripEnv(argv) {
  if (argv[0] !== '/usr/bin/env' || argv[1] !== '-i') return { argv, fixedEnv: null };
  const fixedEnv = {};
  let k = 2;
  for (; k < argv.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[k]); k += 1) {
    const eq = argv[k].indexOf('=');
    fixedEnv[argv[k].slice(0, eq)] = argv[k].slice(eq + 1);
  }
  return { argv: argv.slice(k), fixedEnv };
}

/**
 * Decode one exec: the program argv after the launcher (and after an
 * `env -i` prefix), the docker --env flags, the fixed environment, stdin.
 */
function decode(call) {
  const args = call.args;
  const i = args.indexOf('vcr-launch');
  const launched = i >= 0 ? args.slice(i + 2) : [];
  const { argv, fixedEnv } = stripEnv(launched);
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
  return { launched, argv, env, fixedEnv, stdin: call.stdin, kind, sub, nonce: nonceOf(args) };
}

const PACK_TYPES = Object.freeze({ 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' });

/**
 * A pack the runner writes for `git index-pack --stdin`, read back
 * independently: [{ type, content }]. Throws when it is not a well-formed,
 * undeltified version 2 pack with the right trailing hash.
 */
function parsePack(buf, algo = 'sha1') {
  const hashLen = algo === 'sha256' ? 32 : 20;
  if (buf.toString('latin1', 0, 4) !== 'PACK' || buf.readUInt32BE(4) !== 2) throw new Error('pack: bad header');
  const body = buf.subarray(0, buf.length - hashLen);
  if (!crypto.createHash(algo).update(body).digest().equals(buf.subarray(buf.length - hashLen))) throw new Error('pack: bad trailing hash');
  const count = buf.readUInt32BE(8);
  const out = [];
  let pos = 12;
  for (let i = 0; i < count; i += 1) {
    let c = buf[pos++];
    const type = PACK_TYPES[(c >> 4) & 7];
    let size = c & 0x0f;
    let shift = 4;
    while (c & 0x80) { c = buf[pos++]; size += (c & 0x7f) * 2 ** shift; shift += 7; }
    if (!type) throw new Error('pack: a deltified or unknown entry');
    const r = zlib.inflateSync(buf.subarray(pos, body.length), { info: true });
    if (r.buffer.length !== size) throw new Error('pack: an entry whose size does not match');
    out.push({ type, content: r.buffer });
    pos += r.engine.bytesWritten;
  }
  if (pos !== body.length) throw new Error('pack: trailing bytes');
  return out;
}

/** The files a commit's trees describe, flattened: [{ path, mode, id }] (byte-string paths). */
function filesOf(objects, treeId, prefix = '') {
  const content = objects.get(treeId).content;
  const out = [];
  for (let pos = 0; pos < content.length;) {
    const sp = content.indexOf(0x20, pos);
    const nul = content.indexOf(0, sp);
    const mode = content.toString('latin1', pos, sp);
    const name = content.toString('latin1', sp + 1, nul);
    const id = content.toString('hex', nul + 1, nul + 21 + (objects.algo === 'sha256' ? 12 : 0));
    pos = nul + 1 + (objects.algo === 'sha256' ? 32 : 20);
    if (mode === '40000') out.push(...filesOf(objects, id, `${prefix}${name}/`));
    else out.push({ path: `${prefix}${name}`, mode, id });
  }
  return out;
}

/** `git cat-file --batch` / `--batch-check` output for `ids` from a Map id → { type, content, size? }. */
function catFile(objects, ids, check) {
  const parts = [];
  for (const id of ids) {
    const o = objects.get(id);
    if (!o) { parts.push(Buffer.from(`${id} missing\n`)); continue; }
    parts.push(Buffer.from(`${id} ${o.type} ${o.size !== undefined ? o.size : o.content.length}\n`));
    if (!check) parts.push(o.content, Buffer.from('\n'));
  }
  return Buffer.concat(parts);
}

/**
 * @param {object} [o]
 * @param {object} [o.image] - { store, base } (default: defaultImage())
 * @param {Function} [o.objects] - (a copy of the image's Map id → {type, content}) → the Map cat-file answers from
 * @param {string[]} [o.corrected] - the tracked paths `git diff-files` reports before the checkout
 * @param {number} [o.freeBytes] - the work tree's free bytes `vcr-freespace` reports (default 1 GiB)
 * @param {number} [o.writtenBytes] - the bytes the applied patch wrote, as the measurement sums (default 120)
 * @param {Function[]|string[]} [o.poc] - per PoC run (1-3): the JUnit text, or a handler returning { exitCode, stdout, stderr }
 * @param {object} [o.git] - overrides by git subcommand key (see `key` below)
 * @param {object} [o.scripts] - overrides by runner script name (vcr-procs, vcr-stage, vcr-freespace, vcr-dirs, vcr-clear, vcr-unstage, vcr-build, vcr-cleanup)
 */
function claimSandbox({
  image = defaultImage(), objects = (m) => m, corrected = [], freeBytes = 1024 * 1024 * 1024, writtenBytes = 120,
  poc = [drainFails(), drainFails(), drainFails()], git = {}, scripts = {}, diff = POC_DIFF
} = {}) {
  let committed = false;
  let pocRun = 0;
  const hexLen = image.store.algo === 'sha256' ? 64 : 40;
  const imageObjects = objects(new Map(image.store.objects));
  // The runner's fresh repository, as the runner's packs fill it (every object hashed here, independently).
  const fresh = new GitStore(image.store.algo);
  fresh.objects.algo = image.store.algo;
  const repo = { commit: null, tree: null, files: null, packs: [], objects: fresh.objects };
  const gitDefaults = {
    init: () => ({ exitCode: 0 }),
    'cat-file --batch': (d) => ({ stdout: catFile(imageObjects, d.stdin.toString('latin1').split('\n').filter(Boolean), false) }),
    'cat-file --batch-check': (d) => ({ stdout: catFile(imageObjects, d.stdin.toString('latin1').split('\n').filter(Boolean), true) }),
    'index-pack': (d) => {
      const objs = parsePack(d.stdin, image.store.algo);
      repo.packs.push(objs.map((o) => ({ ...o, id: fresh.add(o.type, o.content) })));
      return { exitCode: 0, stdout: 'pack\n' };
    },
    'update-ref': (d) => {
      const id = d.sub[2];
      const o = fresh.objects.get(id);
      if (!o || o.type !== 'commit') return { exitCode: 128, stderr: `fatal: ${id}: not a valid SHA1\n` };
      repo.commit = id;
      repo.tree = /^tree ([0-9a-f]+)/.exec(o.content.toString())[1];
      repo.files = filesOf(fresh.objects, repo.tree);
      for (const f of repo.files) if (!fresh.objects.has(f.id)) return { exitCode: 128, stderr: `fatal: missing blob ${f.id}\n` };
      return { exitCode: 0 };
    },
    'rev-parse': (d) => (d.sub.includes('refs/heads/main^{commit}')
      ? { stdout: `${repo.commit}\n${repo.tree}\n` }
      : { stdout: `${committed ? POC : repo.commit}\n` }),
    'read-tree': () => ({ exitCode: 0 }),
    'update-index': () => ({ exitCode: 0 }),
    'diff-files --name-only': () => ({ stdout: Buffer.from(corrected.map((p) => `${p}\0`).join(''), 'latin1') }),
    'diff-files --quiet': () => ({ exitCode: 0 }),
    'checkout-index': () => ({ exitCode: 0 }),
    'apply --index': () => ({ exitCode: 0 }),
    // The applied patch adds test/Exploit.t.sol: the measurement reads its postimage from the raw diff, then its size.
    'diff --raw': () => ({ stdout: Buffer.from(`:000000 100644 ${'0'.repeat(hexLen)} ${'a'.repeat(hexLen)} A\0test/Exploit.t.sol\0`, 'latin1') }),
    'cat-file --sizes': (d) => ({ stdout: d.stdin.toString('latin1').split('\n').filter(Boolean).map(() => `${writtenBytes}\n`).join('') }),
    'diff --name-status': () => ({ stdout: 'A\0test/Exploit.t.sol\0' }),
    'diff --numstat': () => ({ stdout: '3\t0\ttest/Exploit.t.sol\0' }),
    'diff -U0': () => ({ stdout: diff }),
    'ls-tree': () => ({ stdout: Buffer.from(repo.files.map((f) => `${f.path}\0`).join(''), 'latin1') }),
    checkout: () => ({ exitCode: 0 }),
    commit: () => { committed = true; return { exitCode: 0 }; },
    reset: () => ({ exitCode: 0 })
  };
  const scriptDefaults = {
    'vcr-procs': () => ({ stdout: '1\n7\n' }),
    'vcr-stage': () => ({ stdout: 'vcr-git-entries 2\n' }),
    'vcr-freespace': () => ({ stdout: `vcr-free ${freeBytes}\n` }),
    'vcr-dirs': () => ({ exitCode: 0 }),
    'vcr-clear': () => ({ exitCode: 0 }),
    'vcr-unstage': () => ({ exitCode: 0 }),
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
    if (sub[0] === 'apply') return 'apply --index';
    if (sub[0] === 'diff') {
      if (sub.includes('--raw')) return 'diff --raw';
      return sub.includes('--name-status') ? 'diff --name-status' : sub.includes('--numstat') ? 'diff --numstat' : 'diff -U0';
    }
    if (sub[0] === 'cat-file') {
      if (sub.some((a) => a.startsWith('--batch-check=%(objectsize)'))) return 'cat-file --sizes';
      return sub.includes('--batch-check') ? 'cat-file --batch-check' : 'cat-file --batch';
    }
    if (sub[0] === 'diff-files') return sub.includes('--quiet') ? 'diff-files --quiet' : 'diff-files --name-only';
    return sub[0];
  };
  const docker = fakeDocker(healthyDaemon({
    step: (args, opts, calls) => {
      const d = decode(calls[calls.length - 1]);
      if (d.kind === 'git') {
        const k = key(d.sub);
        const h = git[k] || gitDefaults[k];
        if (!h) throw new Error(`unexpected git ${d.sub.join(' ')}`);
        return h(d, repo);
      }
      const h = scripts[d.kind] || scriptDefaults[d.kind];
      if (!h) throw new Error(`unexpected exec ${JSON.stringify(d.argv.slice(0, 4))}`);
      return h(d, repo);
    }
  }));
  const execs = () => docker.callsOf('exec').map(decode).filter((d) => d.kind && d.argv[3] !== 'vcr-probe' && d.argv[3] !== 'vcr-launcher-check');
  return { docker, execs, repo, image };
}

module.exports = { BASE, POC, POC_PATCH, POC_DIFF, junit, drainFails, decode, stripEnv, claimSandbox, defaultImage, parsePack, filesOf };
