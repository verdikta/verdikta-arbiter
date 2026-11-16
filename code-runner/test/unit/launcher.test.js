'use strict';

// A step's result is definitive only if the runner's launcher wrote the
// per-exec start nonce before the step's command ran.

const test = require('node:test');
const assert = require('node:assert/strict');
const { launcherArgv, newNonce, StartGate, LAUNCHER_SCRIPT, LAUNCHER_PATH, MARKER } = require('../../src/launcher');
const { Capped } = require('../../src/capture');

const NONCE = 'a'.repeat(32);

function collect() {
  const chunks = [];
  return { write: (c) => { chunks.push(Buffer.from(c)); return true; }, text: () => Buffer.concat(chunks).toString() };
}

test('the launcher argv: /bin/sh, the fixed script, the nonce, then the step argv unchanged', () => {
  assert.equal(LAUNCHER_PATH, '/bin/sh');
  assert.equal(LAUNCHER_SCRIPT, 'printf "vcr-start %s\\n" "$1" && shift && exec "$@"');
  assert.deepEqual(launcherArgv(NONCE, ['forge', 'test', '--match-path', 'test/A.t.sol']),
    ['/bin/sh', '-c', LAUNCHER_SCRIPT, 'vcr-launch', NONCE, 'forge', 'test', '--match-path', 'test/A.t.sol']);
  // Shell-looking arguments are data: "$@" passes each one as it is.
  assert.deepEqual(launcherArgv(NONCE, ['printf', '%s|', 'a b', '$(x)', '']).slice(5), ['printf', '%s|', 'a b', '$(x)', '']);
  for (const bad of [[], ['-c', 'x'], [''], [7]]) assert.throws(() => launcherArgv(NONCE, bad), /program/, JSON.stringify(bad));
  for (const nonce of ['', 'A'.repeat(32), 'a'.repeat(31), `${'a'.repeat(31)};`]) assert.throws(() => launcherArgv(nonce, ['true']), /nonce/);
});

test('nonces are fresh 128-bit values', () => {
  const seen = new Set(Array.from({ length: 1000 }, () => newNonce()));
  assert.equal(seen.size, 1000);
  for (const n of seen) assert.match(n, /^[0-9a-f]{32}$/);
});

test('the gate strips the start line and passes the program\'s bytes on exactly', () => {
  const line = Buffer.from(`${MARKER} ${NONCE}\n`);
  const body = Buffer.from([0, 1, 2, 255, 10, 13]);
  const all = Buffer.concat([line, body]);
  for (const split of [1, 5, line.length - 1, line.length, line.length + 2]) {
    const forwarded = [];
    const gate = new StartGate(NONCE, { write: (c) => { forwarded.push(Buffer.from(c)); return true; } });
    gate.write(all.subarray(0, split));
    gate.write(all.subarray(split));
    gate.finish();
    assert.equal(gate.seen, true, `split ${split}`);
    assert.deepEqual(Buffer.concat(forwarded), body, `split ${split}`);
  }
});

test('anything else first, a wrong nonce, or a partial line: not seen, and every byte kept for the diagnostic', () => {
  const cases = [
    'OCI runtime exec failed: exec failed: unable to start container process: ...\n',
    `${MARKER} ${'b'.repeat(32)}\n`,
    `${MARKER} ${NONCE}`,
    `${MARKER} ${NONCE.slice(0, 10)}`,
    `x${MARKER} ${NONCE}\n`,
    ''
  ];
  for (const text of cases) {
    const out = collect();
    const gate = new StartGate(NONCE, out);
    if (text) gate.write(Buffer.from(text));
    gate.finish();
    assert.equal(gate.seen, false, JSON.stringify(text));
    assert.equal(out.text(), text);
  }
});

test('a start line that arrives later (after other output) does not count', () => {
  const out = collect();
  const gate = new StartGate(NONCE, out);
  gate.write(Buffer.from('noise\n'));
  gate.write(Buffer.from(`${MARKER} ${NONCE}\n`));
  gate.finish();
  assert.equal(gate.seen, false);
});

test('a capped sink behind the gate counts only the program\'s bytes and can still stop the read', () => {
  const sink = new Capped(4);
  const gate = new StartGate(NONCE, sink);
  assert.equal(gate.write(Buffer.from(`${MARKER} ${NONCE}\n`)), true);
  assert.equal(gate.write(Buffer.from('abcdef')), false, 'the cap reaches the CLI through the gate');
  assert.equal(sink.bytes().toString(), 'abcd');
});
