'use strict';

/**
 * A git object store for the unit tests, written independently of
 * src/objects.js so the two check each other: `<type> <size>\0<content>`
 * ids, trees in git's order, commits. A repository is built from a map of
 * paths to files:
 *
 *   'src/A.sol': 'text'                  a regular file (100644)
 *   'run.sh': { exec: 'text' }           an executable (100755)
 *   'link': { link: 'target' }           a symbolic link (120000)
 *   'lib/dep': { gitlink: '<commit>' }   a submodule (160000)
 */

const crypto = require('node:crypto');

class GitStore {
  constructor(algo = 'sha1') {
    this.algo = algo;
    this.objects = new Map();
  }

  add(type, content) {
    const body = Buffer.isBuffer(content) ? content : Buffer.from(content, 'latin1');
    const id = crypto.createHash(this.algo).update(Buffer.concat([Buffer.from(`${type} ${body.length}\0`), body])).digest('hex');
    this.objects.set(id, { type, content: body });
    return id;
  }

  /** A tree from [{ mode, name, id }], sorted as git sorts (a tree's name as if it ended in '/'). */
  tree(entries) {
    const key = (e) => (e.mode === '40000' ? `${e.name}/` : e.name);
    const sorted = [...entries].sort((a, b) => (key(a) < key(b) ? -1 : 1));
    return this.add('tree', Buffer.concat(sorted.map((e) => Buffer.concat([Buffer.from(`${e.mode} ${e.name}\0`, 'latin1'), Buffer.from(e.id, 'hex')]))));
  }

  /** The root tree of `files` (see the module comment). */
  treeOf(files) {
    const root = {};
    for (const [path, file] of Object.entries(files)) {
      const parts = path.split('/');
      let dir = root;
      for (const p of parts.slice(0, -1)) dir = (dir[p] = dir[p] || {});
      dir[parts[parts.length - 1]] = { file };
    }
    const write = (dir) => this.tree(Object.entries(dir).map(([name, node]) => {
      if (!node.file) return { mode: '40000', name, id: write(node) };
      const f = node.file;
      if (typeof f === 'string' || Buffer.isBuffer(f)) return { mode: '100644', name, id: this.add('blob', f) };
      if (f.exec !== undefined) return { mode: '100755', name, id: this.add('blob', f.exec) };
      if (f.link !== undefined) return { mode: '120000', name, id: this.add('blob', f.link) };
      if (f.gitlink !== undefined) return { mode: '160000', name, id: f.gitlink };
      throw new Error(`unknown file at ${name}`);
    }));
    return write(root);
  }

  /** The root tree of [{ mode, path, id }] (what a fast-import commit's M lines describe). */
  treeOfEntries(list) {
    const root = {};
    for (const e of list) {
      const parts = e.path.split('/');
      let dir = root;
      for (const p of parts.slice(0, -1)) dir = (dir[p] = dir[p] || {});
      dir[parts[parts.length - 1]] = { entry: e };
    }
    const write = (dir) => this.tree(Object.entries(dir).map(([name, node]) => (node.entry
      ? { mode: node.entry.mode, name, id: node.entry.id }
      : { mode: '40000', name, id: write(node) })));
    return write(root);
  }

  commit(tree, message = 'm', parents = []) {
    const lines = [`tree ${tree}`, ...parents.map((p) => `parent ${p}`), 'author A <a@example.invalid> 1700000000 +0000', 'committer A <a@example.invalid> 1700000000 +0000', '', message, ''];
    return this.add('commit', lines.join('\n'));
  }

  /** A commit of `files`. */
  repo(files, message) {
    return this.commit(this.treeOf(files), message);
  }
}

module.exports = { GitStore };
