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

test('A1b: only src/registry.js builds a docker pull argv; nothing pulls every tag or forces an image removal', () => {
  for (const file of sources()) {
    const text = code(file);
    const base = path.relative(SRC, file);
    if (base !== 'registry.js') assert.doesNotMatch(text, /['"]pull['"]\s*,/, `${base} builds a pull argv`);
    assert.doesNotMatch(text, /--all-tags|['"]-a['"]/, `${base} could pull every tag`);
    if (base === 'images.js') assert.doesNotMatch(text, /['"](--force|-f)['"]/, 'images.js forces an image removal');
  }
});
