'use strict';

/**
 * The text rules' worst case, measured in a process of its own: what a claim's
 * hostile files cost the runner's event loop and heap, from prepareTargets to
 * the flags. test/unit/scanner.test.js runs it under a small heap, and its
 * answer is the table in the README.
 *
 *   node --expose-gc test/helpers/scanWorst.js [<line> [<paths> [<blob bytes>]]]
 */

const scanner = require('../../src/scanner');

const [line = 'vm.store\n', paths = '25', size = String(scanner.TEXT_LIMITS.fileBytes)] = process.argv.slice(2);
const blob = Buffer.from(line.repeat(Math.floor(Number(size) / Buffer.byteLength(line))));
const entries = [];
for (let i = 0; i < Number(paths); i += 1) {
  entries.push({ path: `test/p${String(i).padStart(4, '0')}.txt`, mode: '100644', status: 'M', modeOnly: true, size: blob.length, bytes: blob, added: new Set() });
}
if (global.gc) global.gc();
const before = process.memoryUsage().heapUsed;
const t0 = process.hrtime.bigint();
const { targets, unscanned, texts } = scanner.prepareTargets(entries);
const text = scanner.readText(texts);
const nothing = { hits: [], partial: new Map(), unreadable: new Map(), capped: [], missing: [] };
const flags = scanner.honestyFlags(nothing, targets, unscanned, text, texts);
const blockedMs = Number(process.hrtime.bigint() - t0) / 1e6;
const heap = process.memoryUsage().heapUsed;
const note = flags.find((f) => f.rule === 'verdikta.honesty.truncated');
process.stdout.write(`${JSON.stringify({
  line, paths: Number(paths), blobBytes: blob.length, textBytes: texts.reduce((n, t) => n + t.bytes.length, 0), read: texts.length, stated: unscanned.length,
  flags: flags.length, notListed: note ? Number(/(\d+) more/.exec(note.message)[1]) : 0, blockedMs: Math.round(blockedMs), heapMiB: Math.round((heap - before) / 1048576)
})}\n`);
