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
 *
 * Node A3a: each container (the PoC's sandbox, and the fix check's second
 * one) has its own state, including a model of the files the integrity
 * snapshots watch (`box.tree`: absolute path → { type, mode, content } or a
 * link), which `vcr-manifest` lists the way GNU find and sha256sum would
 * and `vcr-framework` answers from (forge's path, PATH, `forge config
 * --json`). The build, the commit, the runs and the reset change the tree
 * the way forge and git do (out/ and cache/ written, the index rewritten);
 * a test changes it from a PoC handler to model a claim that tampers.
 *
 * Node A3a attempt 3: the runner runs forge itself, as an argv
 * (`/usr/bin/env -i <forge's environment> <forge> <args>`, no shell).
 * decode() names those execs by what forge was asked: `forge build` is
 * `vcr-build`, `forge config` is `forge-config`, and `forge test` is
 * `vcr-poc` when the runner's placeholders filled a matching flag
 * (`--match-path=` or `--match-test=`: testFiles, testIds) and `vcr-suite`
 * otherwise (commands.test). The framework probe is two execs: `vcr-framework`
 * (where forge is, PATH) and `forge-config`; a `vcr-framework` handler still
 * answers both at once (the header lines, then the configuration, with the
 * configuration's exit code and stderr), called once per probe.
 */

const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { fakeDocker, healthyDaemon, nonceOf } = require('./fakeDocker');
const { GitStore } = require('./gitStore');

const POC = '9e1b2d0000000000000000000000000000000000';
const FIX_COMMIT = 'f1f1f10000000000000000000000000000000000';

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

/** A fix: Vault.sol changed (source, outside paths.tests). */
const FIX_PATCH = [
  'diff --git a/src/Vault.sol b/src/Vault.sol',
  '--- a/src/Vault.sol',
  '+++ b/src/Vault.sol',
  '@@ -1 +1 @@',
  '-contract Vault {}',
  '+contract Vault { uint256 fixed; }',
  ''
].join('\n');

const FIX_DIFF = [
  'diff --git a/src/Vault.sol b/src/Vault.sol',
  'index 1111111..2222222 100644',
  '--- a/src/Vault.sol',
  '+++ b/src/Vault.sol',
  '@@ -1 +1 @@',
  '-contract Vault {}',
  '+contract Vault { uint256 fixed; }',
  ''
].join('\n');

function xmlAttr(s) {
  return String(s).replace(/&(?![a-z]+;|#)/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}

/**
 * forge's JUnit (forge 1.8.5's junit_xml_report) for a list of suites:
 * [{ suite: 'file:Contract', cases: [{ name, failure?, skipped?, error?, gas?, out? }] }]. Every
 * record's system-out is forge's `[STATUS] signature (gas: N)` line, every suite carries forge's own
 * summary (`Suite result: …`), and the counts on <testsuite> and <testsuites> follow the records.
 * `o.summary: false` leaves the suite summaries out (a hand-written JUnit); `o.totals` overrides the
 * root's counts; `o.suiteSummary(suite, counts)` replaces a summary line.
 */
function junit(suites, o = {}) {
  const totals = { tests: 0, skipped: 0, failures: 0, errors: 0 };
  const body = suites.map(({ suite, cases }) => {
    const c = { tests: cases.length, skipped: 0, failures: 0, errors: 0, passed: 0 };
    const records = cases.map((k) => {
      let inner = '';
      let status = 'PASS';
      if (k.failure !== undefined) {
        c.failures += 1;
        inner = k.failure === null ? '<failure/>' : `<failure message="${xmlAttr(k.failure)}"/>`;
        status = `FAIL${k.failure ? `: ${xmlAttr(k.failure)}` : ''}`;
      } else if (k.error !== undefined) {
        c.errors += 1;
        inner = `<error message="${xmlAttr(k.error)}"/>`;
        status = `FAIL: ${xmlAttr(k.error)}`;
      } else if (k.skipped) {
        c.skipped += 1;
        inner = '<skipped/>';
        status = 'SKIP';
      } else {
        c.passed += 1;
      }
      const gas = k.gas !== undefined ? k.gas : (k.skipped ? 0 : 3266);
      const out = k.out !== undefined ? k.out : `[${status}] ${xmlAttr(k.name)} (gas: ${gas})`;
      return `        <testcase name="${xmlAttr(k.name)}" time="0.000">${inner}<system-out>${out}</system-out></testcase>`;
    });
    totals.tests += c.tests;
    totals.skipped += c.skipped;
    totals.failures += c.failures;
    totals.errors += c.errors;
    const failed = c.failures + c.errors;
    let summary = `Suite result: ${failed ? 'FAILED' : 'ok'}. ${c.passed} passed; ${failed} failed; ${c.skipped} skipped; finished in 264.34µs (129.98µs CPU time)`;
    if (o.suiteSummary) summary = o.suiteSummary(suite, c, summary);
    return [
      `    <testsuite name="${xmlAttr(suite)}" tests="${c.tests}" skipped="${c.skipped}" errors="${c.errors}" failures="${c.failures}" time="0.001">`,
      ...records,
      ...(o.summary === false || summary === null ? [] : [`        <system-out>${summary}</system-out>`]),
      '    </testsuite>'
    ].join('\n');
  }).join('\n');
  const t = { ...totals, ...(o.totals || {}) };
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="Test run" tests="${t.tests}" skipped="${t.skipped}" failures="${t.failures}" errors="${t.errors}" timestamp="2026-11-01T17:03:58.228+00:00" time="0.003">\n${body}\n</testsuites>\n`;
}

/** The PoC's JUnit on one run: test_drain() failing as an assertion. */
function drainFails(message = 'vault drained') {
  return junit([{ suite: 'test/Exploit.t.sol:ExploitTest', cases: [{ name: 'test_drain()', failure: message }] }]);
}

/** The fixed suite's JUnit (commands.test, the fix check): the PoC passes, the maker's stable test passes. */
function suitePasses(over = {}) {
  return junit([
    { suite: 'test/Exploit.t.sol:ExploitTest', cases: [{ name: 'test_drain()', ...(over.poc || {}) }] },
    { suite: 'test/Vault.t.sol:VaultTest', cases: [{ name: 'test_deposit()', ...(over.deposit || {}) }] }
  ]);
}

/** Whether a JUnit text records a failure (forge exits 1 exactly then). */
function hasFailure(text) {
  return /<(?:failure|error)\b/.test(String(text));
}

/** What forge was asked, by its argv after `env -i`: the fake's name for the exec (see the header), or null when it is not forge. */
function forgeKind(argv) {
  if (argv.length < 2 || !argv[0].startsWith('/')) return null;
  if (argv[1] === 'build') return 'vcr-build';
  if (argv[1] === 'config') return 'forge-config';
  if (argv[1] === 'test') return argv.some((a) => a.startsWith('--match-path=') || a.startsWith('--match-test=')) ? 'vcr-poc' : 'vcr-suite';
  return null;
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

const CONTAINER = /^vcr-[0-9a-f]+-([0-9]+)$/;

/**
 * Decode one exec: the program argv after the launcher (and after an
 * `env -i` prefix), the docker --env flags, the fixed environment, stdin,
 * and the container (`box`: 1 the PoC's sandbox, 2 the fix check's).
 */
function decode(call) {
  const args = call.args;
  const i = args.indexOf('vcr-launch');
  const launched = i >= 0 ? args.slice(i + 2) : [];
  const { argv, fixedEnv } = stripEnv(launched);
  const env = {};
  let container = null;
  let user = null;
  for (let j = 0; j < (i >= 0 ? i : args.length); j += 1) {
    if (args[j] === '--user') user = args[j + 1];
    if (args[j] === '--env') {
      const kv = args[j + 1];
      const eq = kv.indexOf('=');
      env[kv.slice(0, eq)] = kv.slice(eq + 1);
    }
    if (CONTAINER.test(args[j])) container = args[j];
  }
  let kind = null;
  let sub = null;
  let forge = false;
  let workdir = null;
  for (let j = 0; j < (i >= 0 ? i : args.length); j += 1) if (args[j] === '--workdir') workdir = args[j + 1];
  if (fixedEnv && forgeKind(argv)) {
    kind = forgeKind(argv);
    forge = true;
  } else if (argv[0] === 'git') {
    kind = 'git';
    let k = 1;
    while (argv[k] === '-c') k += 2;
    sub = argv.slice(k);
  } else if (argv[0] === '/bin/sh' && argv[1] === '-c') {
    kind = argv[3] || 'sh';
  } else if (argv[0] === 'cat') {
    kind = 'cat';
  }
  const box = container ? Number(CONTAINER.exec(container)[1]) : null;
  return { launched, argv, env, fixedEnv, stdin: call.stdin, kind, sub, nonce: nonceOf(args), container, box, user, forge, workdir };
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

const HOME = '/home/sandbox';
/** The fake's tracked files (the listed commit's, and the patch's): what a reset --hard rewrites. */
const TRACKED = /^\/work\/(?:\.gitmodules|foundry\.toml|lib\/forge-std\/|src\/|test\/)/;

/** The watched files of a freshly forced checkout, as the integrity snapshots see them. */
function initialTree() {
  const f = (content, mode = '644') => ({ type: 'f', mode, content });
  return new Map([
    ['/work/.gitmodules', f('[submodule "lib/forge-std"]\n')],
    ['/work/foundry.toml', f('[profile.default]\n')],
    ['/work/lib/forge-std/src/Test.sol', f('// forge-std\n')],
    ['/work/src/Vault.sol', f('contract Vault {}\n')],
    ['/work/test/Vault.t.sol', f('contract VaultTest {}\n')],
    ['/work/.git/HEAD', f('ref: refs/heads/main\n')],
    ['/work/.git/config', f('[core]\n\trepositoryformatversion = 0\n')],
    ['/work/.git/index', f('index: checkout')],
    ['/work/.git/info/attributes', f('* !filter !diff !merge !text !crlf !eol !ident !working-tree-encoding\n')]
  ]);
}

/** forge's resolved configuration as `forge config --json` prints it, from the files forge reads (the fake's model). */
function forgeConfig(tree, over = {}) {
  const read = (p) => (tree.has(p) && tree.get(p).type === 'f' ? String(tree.get(p).content) : null);
  return `${JSON.stringify({
    src: 'src', test: 'test', out: 'out', libs: ['lib'], cache_path: 'cache', broadcast: 'broadcast', snapshots: 'snapshots', solc: '/opt/solc/solc',
    remappings: read('/work/remappings.txt'), project: read('/work/foundry.toml'), global: read(`${HOME}/.foundry/foundry.toml`), dotenv: read('/work/.env'),
    // forge's defaults for what else it writes in a run (RUN_OUTPUT_SETTINGS).
    test_failures_file: 'cache/test-failures', build_info_path: null,
    fuzz: { failure_persist_dir: 'cache/fuzz', corpus_dir: null, frontier_dir: null }, invariant: { failure_persist_dir: 'cache/invariant', corpus_dir: null, frontier_dir: null },
    ...over
  }, null, 2)}\n`;
}

/** `vcr-manifest`'s output for a tree: GNU find's records, then sha256sum -z's lines (as src/integrity.js reads them). */
function manifestOf(tree, findArgs) {
  const roots = [];
  let k = 0;
  while (k < findArgs.length && findArgs[k].startsWith('/')) roots.push(findArgs[k++]);
  const prunes = [];
  for (let j = k; j < findArgs.length; j += 1) if (findArgs[j] === '-path') prunes.push(findArgs[j + 1].replace(/\\(.)/g, '$1'));
  const under = (p, d) => p === d || p.startsWith(`${d}/`);
  const listed = [...tree.entries()]
    .filter(([p]) => roots.some((r) => under(p, r)) && !prunes.some((x) => under(p, x)))
    .sort(([a], [b]) => (a < b ? -1 : 1));
  const meta = [];
  const hashes = [];
  for (const [p, e] of listed) {
    if (e.type === 'l') {
      meta.push(Buffer.from(`l\x00777\x00${Buffer.byteLength(e.target, 'latin1')}\0${p}\0${e.target}\0`, 'latin1'));
      continue;
    }
    const content = Buffer.isBuffer(e.content) ? e.content : Buffer.from(String(e.content), 'latin1');
    meta.push(Buffer.from(`${e.type}\0${e.mode}\0${content.length}\0${p}\0\0`, 'latin1'));
    if (e.type === 'f' && !e.unreadable) hashes.push(Buffer.from(`${crypto.createHash('sha256').update(content).digest('hex')}  ${p}\0`, 'latin1'));
  }
  return Buffer.concat([...meta, Buffer.from('vcr-hashes\0'), ...hashes]);
}

/** A `vcr-framework` handler's answer split into the discovery's header lines and forge config's output. */
function splitProbe(r) {
  const text = Buffer.isBuffer(r.stdout) ? r.stdout.toString('utf8') : String(r.stdout || '');
  const m = /^vcr-forge [^\n]*\nvcr-path [^\n]*\n(?:vcr-real [^\n]*\n)?/.exec(text);
  return { head: m ? m[0] : text, rest: m ? text.slice(m[0].length) : '', exitCode: r.exitCode || 0, stderr: r.stderr || '' };
}

/** Directories that exist in every sandbox whether or not the fake's tree has an entry under them. */
const FAKE_DIRS = Object.freeze(['/', '/work', '/tmp', '/home', HOME]);

/**
 * The kernel's path resolution over a fake tree, as the runner's link script
 * sees it (test-only): components walked from /, a link followed where it
 * sits (its target read relative to the physical directory reached so far),
 * `..` taken from that physical directory, at most 40 links. A directory is
 * any path an entry lies under (or one of FAKE_DIRS). Returns, per absolute
 * path, `{ kind: 'd'|'f', real }` or `{ kind: '?', real: '' }` (missing, a
 * loop, a file used as a directory).
 * @param {Map} tree
 * @returns {(p: string) => {kind:string, real:string}}
 */
function kernelResolver(tree) {
  const dirs = new Set(FAKE_DIRS);
  for (const k of tree.keys()) {
    for (let i = k.lastIndexOf('/'); i > 0; i = k.lastIndexOf('/', i - 1)) {
      const d = k.slice(0, i);
      if (dirs.has(d)) break;
      dirs.add(d);
    }
  }
  const none = { kind: '?', real: '' };
  return (p) => {
    let cur = [];
    let queue = p.split('/');
    let hops = 0;
    while (queue.length) {
      const c = queue.shift();
      if (c === '' || c === '.') continue;
      if (c === '..') { cur.pop(); continue; }
      const next = `/${[...cur, c].join('/')}`;
      const e = tree.get(next);
      if (e && e.type === 'l') {
        hops += 1;
        if (hops > 40) return none;
        if (e.target.startsWith('/')) cur = [];
        queue = [...e.target.split('/'), ...queue];
        continue;
      }
      if (e) {
        // A file with anything after it (even a trailing slash) is ENOTDIR.
        if (queue.length) return none;
        cur.push(c);
        continue;
      }
      if (!dirs.has(next)) return none;
      cur.push(c);
    }
    const real = `/${cur.join('/')}`;
    if (tree.has(real)) return { kind: 'f', real };
    return dirs.has(real) ? { kind: 'd', real } : none;
  };
}

/** `vcr-links`'s output for the paths on its stdin (NUL-separated): one `kind\0path\0real\0` record each, in order. */
function linksOf(tree, stdin) {
  const resolve = kernelResolver(tree);
  const paths = stdin ? Buffer.from(stdin).toString('latin1').split('\0').filter((x) => x !== '') : [];
  return Buffer.from(paths.map((p) => {
    const r = resolve(p);
    return `${r.kind}\0${p}\0${r.real}\0`;
  }).join(''), 'latin1');
}

/**
 * `vcr-external-roots`'s output for the paths on its stdin: a record for each offender among them and the symbolic
 * links directly in those that are directories (`path\0w\0`: the walk from / meets the work tree, $HOME or /tmp, as
 * A1's launcher check would; `path\0!\0`: a directory it cannot list). Nothing when all is safe. The fake's tree
 * models the read-only root's links too (a `/opt/helpers` entry is never listed: the manifest holds /work and $HOME only).
 */
function externalRootsOf(tree, stdin) {
  const WRITABLE = ['/work', '/tmp', HOME];
  const walksWritable = (p) => {
    let cur = [];
    let queue = p.split('/');
    let hops = 0;
    while (queue.length) {
      const c = queue.shift();
      if (c === '' || c === '.') continue;
      if (c === '..') { cur.pop(); continue; }
      const next = `/${[...cur, c].join('/')}`;
      if (WRITABLE.some((w) => next === w || next.startsWith(`${w}/`))) return true;
      const e = tree.get(next);
      if (e && e.type === 'l') {
        hops += 1;
        if (hops > 40) return false;
        if (e.target.startsWith('/')) cur = [];
        queue = [...e.target.split('/'), ...queue];
        continue;
      }
      cur.push(c);
    }
    return false;
  };
  const resolve = kernelResolver(tree);
  const paths = stdin ? Buffer.from(stdin).toString('latin1').split('\0').filter((x) => x !== '') : [];
  const parts = [];
  for (const p of paths) {
    if (tree.has(p) && tree.get(p).type === 'd') { parts.push(`${p}\0!\0`); continue; }
    if (walksWritable(p)) { parts.push(`${p}\0w\0`); continue; }
    const r = resolve(p);
    if (r.kind !== 'd') continue;
    for (const [k, e] of tree) {
      if (e.type !== 'l' || !k.startsWith(`${r.real}/`) || k.slice(r.real.length + 1).includes('/')) continue;
      const link = `${p}/${k.slice(r.real.length + 1)}`;
      if (walksWritable(link)) parts.push(`${link}\0w\0`);
    }
  }
  return Buffer.from(parts.join(''), 'latin1');
}

/**
 * @param {object} [o]
 * @param {object} [o.image] - { store, base } (default: defaultImage())
 * @param {Function} [o.objects] - (a copy of the image's Map id → {type, content}) → the Map cat-file answers from
 * @param {string[]} [o.corrected] - the tracked paths `git diff-files` reports before the checkout
 * @param {number} [o.freeBytes] - the work tree's free bytes `vcr-freespace` reports (default 1 GiB)
 * @param {number} [o.writtenBytes] - the bytes the applied patch wrote, as the measurement sums (default 120)
 * @param {Function[]|string[]} [o.poc] - per PoC run (1-3): the JUnit text, or a handler (d, run, box) returning
 *   { exitCode, stdout, stderr }; a text's exit code is forge's (1 when it records a failure)
 * @param {object} [o.git] - overrides by git subcommand key (see `key` below), both containers
 * @param {object} [o.scripts] - overrides by runner script name (vcr-procs, vcr-stage, vcr-freespace, vcr-dirs, vcr-clear,
 *   vcr-unstage, vcr-cleanup, vcr-framework, vcr-manifest, vcr-links, vcr-external-roots, vcr-inline-config) or forge exec (vcr-build, vcr-poc, vcr-suite; see
 *   the header), both containers; a handler gets (d, box)
 * @param {Function} [o.onBox] - (box) => void, when a container's state is made (to seed its tree)
 * @param {object} [o.fix] - the fix check's container: { patch (bytes the fix apply carries; default FIX_PATCH),
 *   nameStatus, numstat, diff, raw, writtenBytes, applyExit, build (handler), suite (JUnit text or handler) }
 * @param {object} [o.handlers] - more docker subcommand handlers (fakeDocker's), e.g. `history` for the listing check
 */
function claimSandbox({
  image = defaultImage(), objects = (m) => m, corrected = [], freeBytes = 1024 * 1024 * 1024, writtenBytes = 120,
  poc = [drainFails(), drainFails(), drainFails()], git = {}, scripts = {}, diff = POC_DIFF, onBox = null, fix = {}, handlers = {}
} = {}) {
  const hexLen = image.store.algo === 'sha256' ? 64 : 40;
  const imageObjects = objects(new Map(image.store.objects));
  const fixBytes = Buffer.from(fix.patch || FIX_PATCH);
  const boxes = new Map();
  function newBox(n) {
    // The runner's fresh repository, as the runner's packs fill it (every object hashed here, independently).
    const fresh = new GitStore(image.store.algo);
    fresh.objects.algo = image.store.algo;
    const b = {
      n, committed: false, fixApplied: false, fixCommitted: false, lastApply: null, pocRun: 0, suiteRun: 0,
      tree: initialTree(), configOver: {},
      repo: { commit: null, tree: null, files: null, packs: [], objects: fresh.objects },
      fresh
    };
    if (onBox) onBox(b);
    return b;
  }
  const boxOf = (d) => {
    const n = d.box || 1;
    if (!boxes.has(n)) boxes.set(n, newBox(n));
    return boxes.get(n);
  };
  const isFix = (b) => b.lastApply === 'fix';
  const gitDefaults = {
    init: () => ({ exitCode: 0 }),
    'cat-file --batch': (d) => ({ stdout: catFile(imageObjects, d.stdin.toString('latin1').split('\n').filter(Boolean), false) }),
    'cat-file --batch-check': (d) => ({ stdout: catFile(imageObjects, d.stdin.toString('latin1').split('\n').filter(Boolean), true) }),
    'index-pack': (d, b) => {
      const objs = parsePack(d.stdin, image.store.algo);
      b.repo.packs.push(objs.map((o) => ({ ...o, id: b.fresh.add(o.type, o.content) })));
      return { exitCode: 0, stdout: 'pack\n' };
    },
    'update-ref': (d, b) => {
      const id = d.sub[2];
      const o = b.fresh.objects.get(id);
      if (!o || o.type !== 'commit') return { exitCode: 128, stderr: `fatal: ${id}: not a valid SHA1\n` };
      b.repo.commit = id;
      b.repo.tree = /^tree ([0-9a-f]+)/.exec(o.content.toString())[1];
      b.repo.files = filesOf(b.fresh.objects, b.repo.tree);
      for (const f of b.repo.files) if (!b.fresh.objects.has(f.id)) return { exitCode: 128, stderr: `fatal: missing blob ${f.id}\n` };
      return { exitCode: 0 };
    },
    'rev-parse': (d, b) => {
      if (d.sub.includes('refs/heads/main^{commit}')) return { stdout: `${b.repo.commit}\n${b.repo.tree}\n` };
      if (b.fixCommitted) return { stdout: `${FIX_COMMIT}\n` };
      return { stdout: `${b.committed ? POC : b.repo.commit}\n` };
    },
    'read-tree': () => ({ exitCode: 0 }),
    'update-index': () => ({ exitCode: 0 }),
    'diff-files --name-only': () => ({ stdout: Buffer.from(corrected.map((p) => `${p}\0`).join(''), 'latin1') }),
    'diff-files --quiet': () => ({ exitCode: 0 }),
    'checkout-index': () => ({ exitCode: 0 }),
    'apply --index': (d, b) => {
      b.lastApply = d.stdin && Buffer.from(d.stdin).equals(fixBytes) ? 'fix' : 'poc';
      if (b.lastApply === 'fix' && fix.applyExit) return { exitCode: fix.applyExit, stderr: 'error: patch failed: src/Vault.sol:1\n' };
      return { exitCode: 0 };
    },
    // The applied patch adds test/Exploit.t.sol: the measurement reads its postimage from the raw diff, then its size.
    'diff --raw': (d, b) => ({
      stdout: Buffer.from(isFix(b)
        ? (fix.raw || `:100644 100644 ${'1'.repeat(hexLen)} ${'b'.repeat(hexLen)} M\0src/Vault.sol\0`)
        : `:000000 100644 ${'0'.repeat(hexLen)} ${'a'.repeat(hexLen)} A\0test/Exploit.t.sol\0`, 'latin1')
    }),
    'cat-file --sizes': (d, b) => ({
      stdout: d.stdin.toString('latin1').split('\n').filter(Boolean).map(() => `${isFix(b) && fix.writtenBytes !== undefined ? fix.writtenBytes : writtenBytes}\n`).join('')
    }),
    'diff --name-status': (d, b) => ({ stdout: isFix(b) ? (fix.nameStatus || 'M\0src/Vault.sol\0') : 'A\0test/Exploit.t.sol\0' }),
    'diff --numstat': (d, b) => ({ stdout: isFix(b) ? (fix.numstat || '1\t1\tsrc/Vault.sol\0') : '3\t0\ttest/Exploit.t.sol\0' }),
    'diff -U0': (d, b) => ({ stdout: isFix(b) ? (fix.diff || FIX_DIFF) : diff }),
    'ls-tree': (d, b) => ({ stdout: Buffer.from(b.repo.files.map((f) => `${f.path}\0`).join(''), 'latin1') }),
    checkout: () => ({ exitCode: 0 }),
    commit: (d, b) => {
      if (d.sub.includes('fix.patch')) {
        b.fixCommitted = true;
        b.tree.set('/work/src/Vault.sol', { type: 'f', mode: '644', content: 'contract Vault { uint256 fixed; }\n' });
      } else {
        b.committed = true;
        b.tree.set('/work/test/Exploit.t.sol', { type: 'f', mode: '644', content: POC_DIFF });
      }
      b.tree.set('/work/.git/index', { type: 'f', mode: '644', content: `index: commit ${b.fixCommitted ? 'fix' : 'poc'}` });
      // The committed (tracked) files, which the runner's reset --hard restores.
      b.committedTree = new Map([...b.tree].filter(([p]) => TRACKED.test(p)));
      return { exitCode: 0 };
    },
    // The runner's own reset between runs rewrites the index and ORIG_HEAD (never a claim's doing).
    reset: (d, b) => {
      for (const [p, e] of b.committedTree || []) b.tree.set(p, e);
      b.tree.set('/work/.git/index', { type: 'f', mode: '644', content: `index: reset ${b.pocRun}` });
      b.tree.set('/work/.git/ORIG_HEAD', { type: 'f', mode: '644', content: `${POC}\n` });
      return { exitCode: 0 };
    }
  };
  const scriptDefaults = {
    'vcr-procs': () => ({ stdout: '1\n7\n' }),
    'vcr-stage': () => ({ stdout: 'vcr-git-entries 2\n' }),
    'vcr-freespace': () => ({ stdout: `vcr-free ${freeBytes}\n` }),
    'vcr-dirs': () => ({ exitCode: 0 }),
    'vcr-clear': () => ({ exitCode: 0 }),
    'vcr-unstage': () => ({ exitCode: 0 }),
    'vcr-build': (d, b) => {
      if (b.n === 2 && fix.build) return fix.build(d, b);
      // forge build writes its artifacts, its cache and its signature cache in $HOME.
      b.tree.set('/work/out/Vault.sol/Vault.json', { type: 'f', mode: '644', content: '{"bytecode":"0x6080"}' });
      b.tree.set('/work/out/Exploit.t.sol/ExploitTest.json', { type: 'f', mode: '644', content: '{"bytecode":"0x6081"}' });
      b.tree.set('/work/cache/solidity-files-cache.json', { type: 'f', mode: '644', content: '{}' });
      b.tree.set(`${HOME}/.foundry/cache/signatures`, { type: 'f', mode: '644', content: '{}' });
      return { exitCode: 0, stdout: 'Compiling 3 files with Solc 0.8.31\n' };
    },
    'vcr-cleanup': () => ({ stdout: 'killed 0\n' }),
    'vcr-framework': (d, b) => ({ stdout: `vcr-forge /usr/local/bin/forge\nvcr-path /usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin\n${forgeConfig(b.tree, b.configOver)}` }),
    'vcr-manifest': (d, b) => ({ stdout: manifestOf(b.tree, d.argv.slice(4)) }),
    'vcr-links': (d, b) => ({ stdout: linksOf(b.tree, d.stdin) }),
    'vcr-external-roots': (d, b) => ({ stdout: externalRootsOf(b.tree, d.stdin) }),
    'vcr-svm': (d, b) => {
      const dir = d.argv[d.argv.length - 1];
      const names = [...b.tree.keys()].filter((p) => p.startsWith(`${dir}/`)).map((p) => `${dir}/${p.slice(dir.length + 1).split('/')[0]}`);
      return { stdout: Buffer.from(names.length ? [dir, ...new Set(names)].map((p) => `${p}\0`).join('') : '', 'latin1') };
    },
    'vcr-inline-config': (d, b) => {
      const files = [...b.tree].filter(([p, e]) => p.startsWith('/work/') && p.endsWith('.sol') && e.type === 'f' && /forge-config:.*(_dir|_file|_path|\\)/.test(String(e.content))).map(([p]) => p);
      const toml = b.tree.get('/work/foundry.toml');
      if (toml && toml.type === 'f' && /^[ \t]*([^#\s].*)?(extends|\\)/m.test(String(toml.content))) files.push('/work/foundry.toml');
      for (const f of ['/work/foundry.toml', '/work/.env']) if (b.tree.has(f) && b.tree.get(f).type === 'l') files.push(`link:${f}`);
      return { stdout: Buffer.from(files.map((f) => `${f}\0`).join(''), 'latin1') };
    },
    'vcr-poc': (d, b) => {
      b.pocRun += 1;
      // forge writes the failing tests' names to its cache on every run.
      b.tree.set('/work/cache/test-failures', { type: 'f', mode: '644', content: `run ${b.pocRun}` });
      const h = poc[b.pocRun - 1];
      if (typeof h === 'function') return h(d, b.pocRun, b);
      return { exitCode: hasFailure(h) ? 1 : 0, stdout: h === undefined ? '' : h };
    },
    'vcr-suite': (d, b) => {
      b.suiteRun += 1;
      const h = fix.suite === undefined ? suitePasses() : fix.suite;
      if (typeof h === 'function') return h(d, b.suiteRun, b);
      return { exitCode: hasFailure(h) ? 1 : 0, stdout: h };
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
  const docker = fakeDocker({ ...healthyDaemon({
    // The exec's own argv and stdin (with two sandboxes, the last call recorded may be the other one's).
    step: (args, opts) => {
      const d = decode({ args, stdin: opts && opts.stdin ? Buffer.from(opts.stdin) : null });
      const b = boxOf(d);
      if (d.kind === 'git') {
        const k = key(d.sub);
        // A test's override answers the PoC's diffs in both containers; the fix's own diffs stay the fake's.
        const own = b.n === 2 && isFix(b) && /^(?:diff|cat-file --sizes|apply)/.test(k);
        const h = (!own && git[k]) || gitDefaults[k];
        if (!h) throw new Error(`unexpected git ${d.sub.join(' ')}`);
        return h(d, b);
      }
      // The framework probe: the discovery's exec answers with the handler's header lines; `forge config` with the rest.
      if (d.kind === 'vcr-framework' || d.kind === 'forge-config') {
        const h = scripts['vcr-framework'] || scriptDefaults['vcr-framework'];
        if (d.kind === 'vcr-framework') b.probe = splitProbe(h(d, b));
        const p = b.probe || splitProbe(h(d, b));
        if (d.kind === 'forge-config') b.probe = null;
        if (d.kind === 'vcr-framework') return { exitCode: p.exitCode === 3 || /^vcr-forge \n/.test(p.head) ? 3 : 0, stdout: p.head };
        return { exitCode: p.exitCode, stdout: p.rest, stderr: p.stderr };
      }
      const h = scripts[d.kind] || scriptDefaults[d.kind];
      if (!h) throw new Error(`unexpected exec ${JSON.stringify(d.argv.slice(0, 4))}`);
      return h(d, b);
    }
  }), ...handlers });
  const decoded = () => docker.callsOf('exec').map(decode).filter((d) => d.kind && d.argv[3] !== 'vcr-probe' && d.argv[3] !== 'vcr-launcher-check');
  /** Every container's execs, in order (a claim without a fix check, and the listing check's probes, use one at a time). */
  const execs = () => decoded();
  /** A claim's PoC sandbox's execs (the first container). */
  const pocExecs = () => decoded().filter((d) => (d.box || 1) === 1);
  /** A claim's fix check's execs (the second container). */
  const fixExecs = () => decoded().filter((d) => d.box === 2);
  const box = (n = 1) => {
    if (!boxes.has(n)) boxes.set(n, newBox(n));
    return boxes.get(n);
  };
  return {
    docker, execs, pocExecs, fixExecs, image, box,
    get repo() { return box(1).repo; }
  };
}

module.exports = {
  BASE, POC, FIX_COMMIT, POC_PATCH, POC_DIFF, FIX_PATCH, FIX_DIFF, HOME, junit, drainFails, suitePasses, hasFailure, decode, stripEnv, forgeKind, splitProbe, externalRootsOf,
  claimSandbox, defaultImage, parsePack, filesOf, initialTree, forgeConfig, manifestOf, kernelResolver, linksOf
};
