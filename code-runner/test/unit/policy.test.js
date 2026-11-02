'use strict';

// Review focus: no claim content executes on the host; no shell. A static
// guard over src/ so a later node cannot quietly add a shell, a host mount or
// a copy-out of container files.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', '..', 'src');

function sources(dir = SRC) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return sources(p);
    return e.name.endsWith('.js') ? [p] : [];
  });
}

function code(file) {
  // Comments may describe what is forbidden; only code counts.
  return fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

const FORBIDDEN = [
  [/\bexecSync\b|\bexecFileSync\b|\bspawnSync\b/, 'synchronous child processes'],
  [/child_process['"]\)\.(exec|execFile)\b|\{[^}]*\b(exec|execFile)\b[^}]*\}\s*=\s*require\(\s*['"](node:)?child_process/, 'child_process.exec (a shell)'],
  [/shell\s*:\s*true/, 'shell: true'],
  [/\beval\s*\(|new\s+Function\s*\(/, 'eval / new Function'],
  [/['"]--volume['"]|['"]-v['"]|['"]--mount['"]|['"]--privileged['"]|['"]--cap-add['"]/, 'a mount or privilege flag'],
  [/docker\.sock/, 'the Docker socket'],
  [/\[\s*['"]cp['"]/, 'docker cp (results are read as capped streams)'],
  [/\brequire\(\s*['"]vm['"]\s*\)|node:vm/, 'the vm module']
];

test('src/ has no shell, no eval, no mount, no docker cp', () => {
  const files = sources();
  assert.ok(files.length > 5, 'found the sources');
  for (const file of files) {
    const text = code(file);
    for (const [re, what] of FORBIDDEN) {
      assert.doesNotMatch(text, re, `${path.relative(SRC, file)} uses ${what}`);
    }
  }
});

test('only src/docker.js spawns processes, and it passes shell: false', () => {
  for (const file of sources()) {
    const text = code(file);
    const spawns = /child_process/.test(text);
    if (path.basename(file) === 'docker.js') {
      assert.ok(spawns, 'docker.js drives the CLI');
      assert.match(text, /shell:\s*false/);
    } else {
      assert.ok(!spawns, `${path.relative(SRC, file)} must go through docker.js`);
    }
  }
});

test('the runner writes no files on the host (it only creates its own empty state directories)', () => {
  const writers = /\b(writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|copyFile|copyFileSync|rename|renameSync|symlink|symlinkSync)\s*\(/;
  for (const file of sources()) {
    assert.doesNotMatch(code(file), writers, `${path.relative(SRC, file)} writes files`);
  }
});

// A2a attempt 2, acceptance item 1 (owner decision Q25): the forced checkout
// never runs git with the env image's git state, and every git object it uses
// is re-hashed by the runner. Behaviour: test/unit/checkout.test.js.

test('git runs only as src/git.js builds it: an empty environment, then the runner\'s, in one of the runner\'s two repositories', () => {
  const { git, hermetic, GIT_DIRS, GIT_DIR, STAGE_DIR } = require('../../src/git');
  assert.deepEqual(GIT_DIRS, ['/work/.git', '/work/.git/vcr-image']);
  for (const gitDir of [GIT_DIR, STAGE_DIR]) {
    const argv = git(['status'], { gitDir });
    assert.deepEqual(argv.slice(0, 2), ['/usr/bin/env', '-i']);
    const program = argv.indexOf('git');
    assert.ok(argv.slice(2, program).every((a) => /^[A-Z_]+=/.test(a)), 'only fixed variables before git');
    assert.ok(argv.includes(`GIT_DIR=${gitDir}`));
  }
  for (const gitDir of ['/repo/.git', '/work/lib/dep/.git', '/work/.git/modules/x']) assert.throws(() => git(['status'], { gitDir }), /runner's repositories/);
  assert.throws(() => git(['status'], { env: { GIT_CONFIG_PARAMETERS: "'core.fsmonitor=x'" } }), /takes no GIT_CONFIG_PARAMETERS/);
  assert.deepEqual(hermetic('exit 0', 'x').slice(0, 2), ['/usr/bin/env', '-i']);
  // No other module names git as a program, or spawns a git argv of its own.
  for (const file of sources()) {
    if (path.basename(file) === 'git.js') continue;
    assert.doesNotMatch(code(file), /\[\s*['"](?:\/usr\/bin\/)?git['"]/, `${path.relative(SRC, file)} builds a git argv`);
  }
  // The runner's shell scripts run no git (a command word "git", not ".git" or "vcr-git-entries").
  const claim = require('../../src/claim');
  const checkout = require('../../src/checkout');
  for (const [name, s] of Object.entries({ ...claim, ...checkout }).filter(([k, v]) => /_SCRIPT$/.test(k) && typeof v === 'string')) {
    assert.doesNotMatch(s, /(^|[\s;&|({])git(\s|$)/m, `${name} runs git`);
  }
});

test('every git object the checkout uses is re-hashed by the runner: object CONTENT is read only in checkout.js, and only through the hash check', () => {
  // `cat-file --batch` (content) lives only in checkout.js; claim.js may read `--batch-check=%(objectsize)` (a size),
  // but never object content, and only against the runner's own repository (not the image's staging store).
  for (const f of sources()) {
    const c = code(f);
    const base = path.relative(SRC, f);
    const content = /cat-file[^\n]*--batch(?!-check)|cat-file['"\s,\]]/.test(c) && !/--batch-check/.test(c.match(/cat-file[^\n]*/)[0] || '');
    if (base !== 'checkout.js') assert.ok(!content, `${base} reads git object content`);
    for (const m of c.match(/cat-file[^\n]*/g) || []) {
      if (base === 'claim.js') assert.match(m, /--batch-check=%\(objectsize\)/, 'claim.js reads only object sizes');
    }
  }
  const text = code(path.join(SRC, 'checkout.js'));
  // One reader of git's object output, and every record with content goes through the runner's own hash before it is kept.
  assert.equal((text.match(/new BatchReader\(/g) || []).length, 1);
  assert.match(text, /if \(hashObject\(algo, rec\.type, rec\.content\) !== rec\.id\) \{\s*throw invalid\(/);
  assert.ok(text.indexOf('hashObject(algo, rec.type, rec.content)') < text.indexOf('got.set(rec.id, rec)'), 'hashed before it is used');
  const objects = code(path.join(SRC, 'objects.js'));
  assert.match(objects, /crypto\.createHash\(algo\)\.update\(`\$\{type\} \$\{content\.length\}\\0`\)\.update\(content\)/);
  // The image's checkout is named once, as the copy step's source: git is never pointed at it.
  assert.equal((text.match(/IMAGE_CHECKOUT\b/g) || []).length >= 2, true);
  assert.doesNotMatch(text, /gitDir:\s*IMAGE_CHECKOUT|GIT_DIR=\/repo|'\/repo\/\.git/);
});
