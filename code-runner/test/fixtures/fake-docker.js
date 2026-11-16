#!/usr/bin/env node
'use strict';

// Stand-in for the docker CLI in test/unit/docker.test.js. It is spawned
// exactly as the real binary would be, so the tests see the argv and the
// environment the runner hands to Docker.

const crypto = require('node:crypto');

const [cmd, ...rest] = process.argv.slice(2);

switch (cmd) {
  case 'echo-env':
    process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), env: process.env }));
    break;
  case 'sleep':
    setTimeout(() => process.exit(0), Number(rest[0]) * 1000);
    break;
  case 'spew': {
    let left = Number(rest[0]);
    const chunk = Buffer.alloc(65536, 'a');
    const pump = () => {
      while (left > 0) {
        const piece = left >= chunk.length ? chunk : chunk.subarray(0, left);
        left -= piece.length;
        if (!process.stdout.write(piece)) {
          process.stdout.once('drain', pump);
          return;
        }
      }
    };
    pump();
    break;
  }
  case 'stdin': {
    const hash = crypto.createHash('sha256');
    let n = 0;
    process.stdin.on('data', (c) => { hash.update(c); n += c.length; });
    process.stdin.on('end', () => process.stdout.write(`${n} ${hash.digest('hex')}`));
    break;
  }
  case 'fail':
    process.stderr.write(rest.slice(1).join(' '));
    process.exit(Number(rest[0]));
    break;
  default:
    process.exit(0);
}
