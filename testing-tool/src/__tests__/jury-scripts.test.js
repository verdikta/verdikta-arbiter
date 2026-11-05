'use strict';

// Node A7d: the shell around a paid run. The whole chain, with the real AI Node and stub providers, is the opt-in
// test/integration/jury-run.e2e.js; here, what can be held without it.

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCRIPTS = path.join(__dirname, '..', '..', 'scripts');
const VALUE = 'a-provider-key-value-0123456789';
let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-scripts-'));
  fs.writeFileSync(path.join(dir, 'keys.env'), `ANTHROPIC_API_KEY=${VALUE}\nexport OPENROUTER_API_KEY="quoted-value-9876543210"\n`, { mode: 0o600 });
  fs.mkdirSync(path.join(dir, 'logs'));
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const check = (...paths) => spawnSync('bash', [path.join(SCRIPTS, 'jury-check-no-keys.sh'), path.join(dir, 'keys.env'), ...paths], { encoding: 'utf8' });

describe('jury-check-no-keys.sh', () => {
  test('finds nothing where nothing is', () => {
    fs.writeFileSync(path.join(dir, 'logs', 'a.log'), 'nothing here\n');
    const out = check(path.join(dir, 'logs'));
    expect(out.status).toBe(0);
    expect(out.stdout).toMatch(/none of the\s+2 key value/);
  });

  test.each([[VALUE], ['quoted-value-9876543210']])('names the file holding %s, and never prints the value', (value) => {
    fs.writeFileSync(path.join(dir, 'logs', 'b.log'), `line\nsomething ${value} something\n`);
    const out = check(path.join(dir, 'logs'));
    expect(out.status).toBe(1);
    expect(out.stdout).toContain('b.log');
    expect(`${out.stdout}${out.stderr}`).not.toContain(value);
  });

  test('a path that does not exist is no pass', () => {
    const out = check(path.join(dir, 'nowhere'));
    expect(out.status).toBe(3);
    expect(out.stdout).toMatch(/nothing is known/);
  });

  test('a scan that fails is no pass', () => {
    const noRead = path.join(dir, 'logs', 'c.log');
    fs.writeFileSync(noRead, 'text\n');
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'grep'), `#!/bin/bash\nif [[ "$*" == *-rlF* ]]; then exit 2; fi\nexec /usr/bin/grep "$@"\n`, { mode: 0o755 });
    const out = spawnSync('bash', [path.join(SCRIPTS, 'jury-check-no-keys.sh'), path.join(dir, 'keys.env'), path.join(dir, 'logs')], { encoding: 'utf8', env: { PATH: `${bin}:${process.env.PATH}` } });
    expect(out.status).toBe(3);
    expect(out.stdout).toMatch(/scan failed/);
  });

  test('a key file with nothing in it is not a pass', () => {
    fs.writeFileSync(path.join(dir, 'keys.env'), '# empty\n');
    expect(check(path.join(dir, 'logs')).status).toBe(2);
  });
});

describe('jury-run.sh', () => {
  const text = fs.readFileSync(path.join(SCRIPTS, 'jury-run.sh'), 'utf8');

  test('the keys go to one subshell, which becomes the AI Node, with the panel\'s providers only', () => {
    const sourced = text.split('\n').filter((line) => /^\s*\.\s+"\$KEY_FILE"/.test(line));
    expect(sourced).toHaveLength(1);
    const subshell = text.slice(text.indexOf('\n(\n'), text.indexOf('\n) >>'));
    expect(subshell).toContain('. "$KEY_FILE"');
    expect(subshell).toMatch(/unset OPENAI_API_KEY XAI_API_KEY/);
    expect(subshell).toMatch(/exec "\$NODE_BIN\/node" node_modules\/next\/dist\/bin\/next start -H 127\.0\.0\.1/);
  });

  test('the meter and the testing tool start from an empty environment', () => {
    expect(text).toMatch(/env -i PATH=[^\n]* "\$NODE_BIN\/node" "\$REPO\/testing-tool\/src\/meter\.js"/);
    expect(text).toMatch(/env -i PATH=[^\n]* "\$NODE_BIN\/node" src\/index\.js test --type claim --jury real/);
  });

  test('nothing here would print a value', () => {
    for (const name of ['jury-run.sh', 'jury-prepare.sh', 'jury-check-no-keys.sh']) {
      const lines = fs.readFileSync(path.join(SCRIPTS, name), 'utf8').split('\n').filter((line) => !line.trim().startsWith('#'));
      expect(lines.filter((line) => /set -x|^\s*env\s*$|\bprintenv\b(?!.*"\$name")/.test(line))).toEqual([]);
      expect(lines).toContain('set +x');
    }
  });

  test('a TERM stops the batch first: it runs in the background and is waited for', () => {
    expect(text).toMatch(/--ai-node-url "http:\/\/127\.0\.0\.1:\$AI_PORT" "\$@" &\nBATCH_PID=\$!\nwait "\$BATCH_PID"/);
    expect(text.indexOf('stop_pid "$BATCH_PID"')).toBeLessThan(text.indexOf('stop_pid "$AI_PID"'));
  });

  test('a second driver stops before it touches the first one\'s marker', () => {
    expect(text.indexOf('mkdir "$LOCK"')).toBeLessThan(text.indexOf('rm -f "$RUN/done"'));
  });

  test('it clears its children\'s locks only after stopping them', () => {
    expect(text.indexOf('stop_pid "$METER_PID"')).toBeLessThan(text.indexOf('rm -f "$RUN/batch.lock" "$RUN/ledger.jsonl.lock"'));
  });

  test('it marks its end however it ends, and stops only what it started', () => {
    expect(text).toMatch(/trap finish EXIT/);
    expect(text).toMatch(/stop_pid "\$AI_PID"/);
    expect(text).toMatch(/stop_pid "\$METER_PID"/);
    expect(text).not.toMatch(/pkill|killall/);
  });
});
