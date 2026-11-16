'use strict';

// git objects as data (src/objects.js): the runner's own hashing and strict
// reading of the env image's commit, tree and blob objects (attempt 2 of A2a,
// acceptance item 1), checked against known git ids and against an object
// store written independently (test/helpers/gitStore.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  algorithmOf, hashObject, parseCommitTree, parseTree, treeObjects, BatchReader, packObjects, commitObject
} = require('../../src/objects');
const { GitStore } = require('../helpers/gitStore');
const { parsePack } = require('../helpers/fakeClaim');

const id20 = (c) => c.repeat(40);
const raw = (hex) => Buffer.from(hex, 'hex');
const entry = (mode, name, id) => Buffer.concat([Buffer.from(`${mode} ${name}\0`, 'latin1'), raw(id)]);

test('hashObject: `<type> <size>\\0<content>`, SHA-1, or SHA-256 for a SHA-256 repository (known git ids)', () => {
  assert.equal(hashObject('sha1', 'blob', Buffer.alloc(0)), 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
  assert.equal(hashObject('sha1', 'blob', Buffer.from('hello\n')), 'ce013625030ba8dba906f756967f9e9ca394464a');
  assert.equal(hashObject('sha1', 'tree', Buffer.alloc(0)), '4b825dc642cb6eb9a060e54bf8d69288fbee4904');
  assert.equal(hashObject('sha256', 'blob', Buffer.alloc(0)), '473a0f4c3be8a93681a267e3b1e9a7dcda1185436fe141f7749120a303721813');
  assert.equal(hashObject('sha256', 'tree', Buffer.alloc(0)), '6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321');
  assert.equal(algorithmOf('a'.repeat(40)), 'sha1');
  assert.equal(algorithmOf('a'.repeat(64)), 'sha256');
  for (const bad of ['a'.repeat(39), 'A'.repeat(40), 'g'.repeat(64), '']) assert.throws(() => algorithmOf(bad), TypeError);
});

test('parseCommitTree: the tree line must come first, with a full id of the repository\'s format', () => {
  const t = id20('1');
  assert.equal(parseCommitTree(Buffer.from(`tree ${t}\nauthor x\n\nmsg\n`), 'sha1'), t);
  assert.equal(parseCommitTree(Buffer.from(`tree ${'2'.repeat(64)}\n\n`), 'sha256'), '2'.repeat(64));
  for (const bad of [`author x\ntree ${t}\n`, `tree ${t.slice(1)}\n`, `tree  ${t}\n`, `tree ${t}`, `tree ${'A'.repeat(40)}\n`, '']) {
    assert.equal(parseCommitTree(Buffer.from(bad), 'sha1'), null, JSON.stringify(bad));
  }
  assert.equal(parseCommitTree(Buffer.from(`tree ${t}\n`), 'sha256'), null, 'a SHA-1 id in a SHA-256 repository');
});

test('parseTree: every kind of entry, git\'s canonical modes, byte-string names', () => {
  const content = Buffer.concat([
    entry('100644', '-dash', id20('1')),
    entry('100755', 'run.sh', id20('2')),
    entry('120000', 'sp ace', id20('3')),
    entry('40000', 'src', id20('4')),
    entry('160000', 'src0', id20('5')),
    entry('100664', 'z-old', id20('6')),
    entry('040000', 'zz', id20('7')),
    entry('100644', 'ÿ\n"q', id20('8'))
  ]);
  const p = parseTree(content, 'sha1');
  assert.ok(p.ok, p.reason);
  assert.deepEqual(p.entries.map((e) => [e.name, e.kind]), [
    ['-dash', 'blob'], ['run.sh', 'exec'], ['sp ace', 'link'], ['src', 'tree'], ['src0', 'gitlink'], ['z-old', 'blob'], ['zz', 'tree'], ['ÿ\n"q', 'blob']
  ]);
  assert.equal(p.entries[3].id, id20('4'));
  // Names that differ only in case are two paths on Linux: both are kept.
  const both = parseTree(Buffer.concat([entry('100644', 'A.sol', id20('1')), entry('100644', 'a.sol', id20('2'))]), 'sha1');
  assert.ok(both.ok);
  assert.equal(both.entries.length, 2);
  assert.deepEqual(parseTree(Buffer.alloc(0), 'sha1'), { ok: true, entries: [] });
});

test('parseTree: refuses what git would not check out, and a tree out of git\'s order', () => {
  const cases = [
    [[entry('100644', '.git', id20('1'))], /\.git/],
    [[entry('40000', '.GIT', id20('1'))], /\.GIT/],
    [[entry('100644', '..', id20('1'))], /"\.\."/],
    [[entry('100644', '.', id20('1'))], /"\."/],
    [[entry('100644', '', id20('1'))], /empty name/],
    [[entry('100644', 'a/b', id20('1'))], /"\/"/],
    [[entry('100644', 'x'.repeat(256), id20('1'))], /255 bytes/],
    [[entry('20000', 'dev', id20('1'))], /mode 20000/],
    [[entry('0', 'zero', id20('1'))], /mode 0/],
    [[entry('100644', 'b', id20('1')), entry('100644', 'a', id20('2'))], /order/],
    // "a" as a tree sorts as "a/", after "a.b"; listed before it, it is out of order.
    [[entry('40000', 'a', id20('1')), entry('100644', 'a.b', id20('2'))], /order/],
    // The same name twice, a file and a tree (git's order allows both, apart): a duplicate.
    [[entry('100644', 'a', id20('1')), entry('100644', 'a.b', id20('2')), entry('40000', 'a', id20('3'))], /twice/],
    [[Buffer.from('100644 cut'), Buffer.from([0]), raw(id20('1')).subarray(0, 10)], /cut short/],
    [[Buffer.from('100644 noend')], /does not end/],
    [[Buffer.from('1006x4 a\0'), raw(id20('1'))], /mode/],
    [[Buffer.from(' a\0'), raw(id20('1'))], /without a mode/]
  ];
  for (const [parts, re] of cases) {
    const p = parseTree(Buffer.concat(parts), 'sha1');
    assert.equal(p.ok, false, String(re));
    assert.match(p.reason, re);
  }
  // A SHA-256 tree's ids are 32 bytes.
  const sha = parseTree(Buffer.concat([Buffer.from('100644 a\0'), Buffer.alloc(32, 1)]), 'sha256');
  assert.ok(sha.ok);
  assert.equal(sha.entries[0].id, '01'.repeat(32));
  assert.equal(parseTree(Buffer.concat([Buffer.from('100644 a\0'), Buffer.alloc(20, 1)]), 'sha256').ok, false);
});

test('treeObjects: the same tree ids as an independent store, nested, with modes and SHA-256', () => {
  for (const algo of ['sha1', 'sha256']) {
    const store = new GitStore(algo);
    const files = { 'a.txt': 'a', 'a-b/x': 'x', 'a/b/c.sol': 'c', 'run.sh': { exec: '#!/bin/sh\n' }, 'l': { link: '../a.txt' }, 'a.b': 'dot' };
    const expected = store.treeOf(files);
    const blob = (c) => hashObject(algo, 'blob', Buffer.from(c));
    const list = [
      { path: 'a.txt', kind: 'blob', id: blob('a') },
      { path: 'a-b/x', kind: 'blob', id: blob('x') },
      { path: 'a/b/c.sol', kind: 'blob', id: blob('c') },
      { path: 'run.sh', kind: 'exec', id: blob('#!/bin/sh\n') },
      { path: 'l', kind: 'link', id: blob('../a.txt') },
      { path: 'a.b', kind: 'blob', id: blob('dot') }
    ];
    const t = treeObjects(list, algo);
    assert.equal(t.id, expected, algo);
    for (const [id, content] of t.objects) assert.equal(hashObject(algo, 'tree', content), id);
  }
  assert.equal(treeObjects([], 'sha1').id, '4b825dc642cb6eb9a060e54bf8d69288fbee4904');
  assert.throws(() => treeObjects([{ path: 'a', kind: 'blob', id: id20('1') }, { path: 'a/b', kind: 'blob', id: id20('2') }], 'sha1'), /a file and a directory|two entries/);
});

test('BatchReader: records the same however the output is cut, missing objects, --batch-check', () => {
  const a = Buffer.from('hello\n');
  const b = Buffer.from([0, 1, 2, 0x0a, 255]);
  const ida = hashObject('sha1', 'blob', a);
  const idb = hashObject('sha1', 'blob', b);
  const out = Buffer.concat([
    Buffer.from(`${ida} blob ${a.length}\n`), a, Buffer.from('\n'),
    Buffer.from(`${id20('9')} missing\n`),
    Buffer.from(`${idb} blob ${b.length}\n`), b, Buffer.from('\n')
  ]);
  for (const step of [1, 2, 3, 7, out.length]) {
    const r = new BatchReader({ algo: 'sha1', maxObjectBytes: 100, maxTotalBytes: 100 });
    for (let i = 0; i < out.length; i += step) assert.equal(r.write(out.subarray(i, i + step)), true, 'never stops the producer');
    const f = r.finish();
    assert.ok(f.ok, f.reason);
    assert.deepEqual(f.records.map((x) => [x.id, x.missing || false, x.content ? x.content.toString('hex') : null]),
      [[ida, false, a.toString('hex')], [id20('9'), true, null], [idb, false, b.toString('hex')]], `step ${step}`);
    assert.equal(f.overflow, false);
  }
  const check = new BatchReader({ algo: 'sha1', check: true });
  check.write(Buffer.from(`${ida} blob 6\n${id20('9')} missing\n`));
  assert.deepEqual(check.finish().records, [{ id: ida, type: 'blob', size: 6 }, { id: id20('9'), missing: true }]);
});

test('BatchReader: an object above its cap is counted, not kept; garbage, a long header or a cut record is unreadable', () => {
  const big = Buffer.alloc(50, 7);
  const r = new BatchReader({ algo: 'sha1', maxObjectBytes: 10, maxTotalBytes: 100 });
  r.write(Buffer.concat([Buffer.from(`${id20('1')} blob 50\n`), big, Buffer.from('\n'), Buffer.from(`${id20('2')} blob 1\nx\n`)]));
  const f = r.finish();
  assert.ok(f.ok);
  assert.equal(f.overflow, true);
  assert.equal(f.records[0].content, null);
  assert.equal(f.records[1].content.toString(), 'x');
  const total = new BatchReader({ algo: 'sha1', maxObjectBytes: 100, maxTotalBytes: 60 });
  total.write(Buffer.concat([Buffer.from(`${id20('1')} blob 50\n`), big, Buffer.from(`\n${id20('2')} blob 50\n`), big, Buffer.from('\n')]));
  assert.equal(total.finish().overflow, true);
  assert.equal(total.finish().records[1].content, null);

  const bad = [
    'not a header\n',
    `${id20('1')} blob 5\nabcdeX`,
    `${id20('1')} blob\n`,
    `${id20('1')} ambiguous\n`,
    `${'x'.repeat(300)}`,
    `${id20('1')} blob 5\nabc`,
    `${id20('1')} blo`
  ];
  for (const text of bad) {
    const b = new BatchReader({ algo: 'sha1', maxObjectBytes: 100, maxTotalBytes: 100 });
    b.write(Buffer.from(text));
    assert.equal(b.finish().ok, false, JSON.stringify(text));
  }
  // A SHA-1 id in a SHA-256 store's output is not a record.
  const sha = new BatchReader({ algo: 'sha256', check: true });
  sha.write(Buffer.from(`${id20('1')} blob 1\n`));
  assert.equal(sha.finish().ok, false);
});

test('packObjects: a version 2 pack of the runner\'s bytes, read back independently, for SHA-1 and SHA-256', () => {
  for (const algo of ['sha1', 'sha256']) {
    const objects = [
      { type: 'blob', content: Buffer.alloc(0) },
      { type: 'blob', content: Buffer.from('short') },
      { type: 'blob', content: Buffer.from([0, 0x0a, 0xff, 0x80]) },
      { type: 'blob', content: Buffer.alloc(16, 1) },
      { type: 'blob', content: Buffer.alloc(300000, 7) },
      { type: 'tree', content: Buffer.from(`100644 a\0${'1'.repeat(algo === 'sha1' ? 40 : 64)}`.replace(/1+$/, ''), 'latin1') },
      { type: 'commit', content: commitObject({ tree: hashObject(algo, 'tree', Buffer.alloc(0)), ident: 'V <v@x.invalid>', date: '1767225600 +0000', message: 'listed commit x\n' }) }
    ];
    const pack = packObjects(algo, objects);
    const back = parsePack(pack, algo);
    assert.deepEqual(back.map((o) => [o.type, o.content.toString('hex')]), objects.map((o) => [o.type, o.content.toString('hex')]), algo);
    assert.equal(pack.readUInt32BE(8), objects.length);
  }
  assert.throws(() => packObjects('sha1', [{ type: 'tag', content: Buffer.alloc(0) }]), /no pack type/);
  // A pack with no object still has its header and trailing hash.
  assert.equal(packObjects('sha1', []).length, 12 + 20);
});

test('commitObject: a root commit with the runner\'s identity and date, hashed as git would', () => {
  const tree = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
  const c = commitObject({ tree, ident: 'Verdikta code runner <code-runner@verdikta.invalid>', date: '1767225600 +0000', message: 'listed commit abc\n' });
  assert.equal(c.toString(), `tree ${tree}\nauthor Verdikta code runner <code-runner@verdikta.invalid> 1767225600 +0000\ncommitter Verdikta code runner <code-runner@verdikta.invalid> 1767225600 +0000\n\nlisted commit abc\n`);
  assert.equal(parseCommitTree(c, 'sha1'), tree);
  const store = new GitStore('sha1');
  assert.equal(store.add('commit', c), hashObject('sha1', 'commit', c));
});
