'use strict';

// Node A7d: the shell around a paid run. The whole chain, with the real AI Node and stub providers, is the opt-in
// test/integration/jury-run.e2e.js; here, what can be held without it.

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const http = require('http');
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
    expect(text.indexOf('stop_pid "$METER_PID"')).toBeLessThan(text.indexOf('clear_lock "$RUN/batch.lock"'));
  });

  test('a driver that stops at the start touches no one else\'s lock, and still marks its end', async () => {
    const work = path.join(dir, 'work');
    fs.mkdirSync(path.join(work, 'run'), { recursive: true });
    fs.mkdirSync(path.join(work, 'node'));
    fs.symlinkSync(path.dirname(process.execPath), path.join(work, 'node', 'bin'));
    const lock = path.join(work, 'run', 'ledger.jsonl.lock');
    fs.writeFileSync(lock, '12345\n');
    fs.writeFileSync(path.join(work, 'run', 'batch.lock'), '12346\n');
    const taken = http.createServer((_req, res) => res.end('another service'));
    await new Promise((resolve) => { taken.listen(0, '127.0.0.1', resolve); });
    const out = await new Promise((resolve) => {
      const child = spawn('bash', [path.join(SCRIPTS, 'jury-run.sh'), work, path.join(dir, 'keys.env')], { env: { PATH: process.env.PATH, METER_PORT: String(taken.address().port) }, stdio: ['ignore', 'pipe', 'pipe'] });
      let text2 = '';
      child.stdout.on('data', (c) => { text2 += c; });
      child.on('exit', (code) => resolve({ code, text: text2 }));
    });
    taken.closeAllConnections();
    await new Promise((resolve) => { taken.close(resolve); });
    expect(out.code).toBe(8);
    expect(out.text).toMatch(/is taken/);
    expect(fs.readFileSync(lock, 'utf8')).toBe('12345\n');
    expect(fs.readFileSync(path.join(work, 'run', 'batch.lock'), 'utf8')).toBe('12346\n');
    expect(JSON.parse(fs.readFileSync(path.join(work, 'run', 'done'), 'utf8')).exit).toBe(8);
    expect(fs.existsSync(path.join(work, 'run', 'driver.lock'))).toBe(false);
  });

  test('it marks its end however it ends, and stops only what it started', () => {
    expect(text).toMatch(/trap finish EXIT/);
    expect(text).toMatch(/stop_pid "\$AI_PID"/);
    expect(text).toMatch(/stop_pid "\$METER_PID"/);
    expect(text).not.toMatch(/pkill|killall/);
  });
});

describe('jury-prepare.sh', () => {
  /** A repository holding the paths its fingerprint reads, and a harness that records each run and writes one scenario. */
  function prepareWork() {
    const work = path.join(dir, 'work');
    const repo = path.join(work, 'repo');
    const calibration = path.join(repo, 'code-runner', 'calibration');
    for (const sub of ['cases', 'listings', 'repos', 'lib']) {
      fs.mkdirSync(path.join(calibration, sub), { recursive: true });
      fs.writeFileSync(path.join(calibration, sub, 'x'), 'x\n');
    }
    fs.mkdirSync(path.join(repo, 'code-runner', 'src'));
    fs.writeFileSync(path.join(repo, 'code-runner', 'src', 'x'), 'x\n');
    fs.writeFileSync(path.join(calibration, 'run.js'), `
      const fs = require('fs');
      const path = require('path');
      const args = process.argv.slice(2);
      if (args[0] === '--list-listings') { console.log(JSON.stringify(['one', 'two'])); process.exit(0); }
      const at = (flag) => args[args.indexOf(flag) + 1];
      const listing = at('--listing');
      fs.appendFileSync(path.join(process.env.HOME, 'runs.txt'), listing + ' ' + process.env.CODE_RUNNER_RUNTIME + '\\n');
      for (const id of ['adversarial.' + listing, 'adversarial.' + listing + '.control', 'adversarial.injected-critical.control']) {
        fs.mkdirSync(path.join(at('--export'), id), { recursive: true });
        fs.writeFileSync(path.join(at('--export'), id, 'scenario.json'), '{}');
      }
    `);
    const git = (...args) => spawnSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' });
    expect(git('init', '-q').status).toBe(0);
    git('add', '-A');
    expect(git('commit', '-q', '-m', 'x').status).toBe(0);
    fs.mkdirSync(path.join(work, 'node'));
    fs.symlinkSync(path.dirname(process.execPath), path.join(work, 'node', 'bin'));
    const run = (runtime, ...listings) => spawnSync('bash', [path.join(SCRIPTS, 'jury-prepare.sh'), work, ...listings], { encoding: 'utf8', env: { PATH: process.env.PATH, CODE_RUNNER_RUNTIME: runtime } });
    const runs = () => (fs.existsSync(path.join(work, 'runs.txt')) ? fs.readFileSync(path.join(work, 'runs.txt'), 'utf8').trim().split('\n') : []);
    return { work, repo, git, run, runs };
  }

  test('claims/ waits for every listing, then holds the claims and the one control', () => {
    const { work, run } = prepareWork();
    expect(run('runsc', 'one').status).toBe(0);
    expect(fs.existsSync(path.join(work, 'claims'))).toBe(false);
    expect(run('runsc', 'two').status).toBe(0);
    expect(fs.readdirSync(path.join(work, 'claims')).sort()).toEqual(['adversarial.injected-critical.control', 'adversarial.one', 'adversarial.two']);
  });

  test('a listing that agreed is not run again', () => {
    const { run, runs } = prepareWork();
    run('runsc');
    run('runsc');
    expect(runs()).toEqual(['one runsc', 'two runsc']);
  });

  test('another runtime runs every listing again: nothing is mixed', () => {
    const { work, run, runs } = prepareWork();
    run('runc', 'one');
    expect(run('runsc').status).toBe(0);
    expect(runs()).toEqual(['one runc', 'one runsc', 'two runsc']);
    expect(fs.readFileSync(path.join(work, 'prepared', 'one'), 'utf8')).toMatch(/^runsc /);
  });

  test('a change to the corpus or the runner runs them again; a change elsewhere does not', () => {
    const { repo, git, run, runs } = prepareWork();
    run('runsc');
    fs.writeFileSync(path.join(repo, 'README.md'), 'words\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'docs');
    run('runsc');
    expect(runs()).toHaveLength(2);
    fs.writeFileSync(path.join(repo, 'code-runner', 'calibration', 'cases', 'x'), 'changed\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'a case');
    run('runsc');
    expect(runs()).toHaveLength(4);
  });
});
