'use strict';
// A temporary probe (not for merging): what Semgrep's large answer does under the real runtime.
const test = require('node:test');
const crypto = require('node:crypto');
const { executeRun } = require('../../src/pipeline');
const scanner = require('../../src/scanner');
const { Prefix } = require('../../src/capture');
const { TEST_IMAGE, silent, dockerTestConfig, dockerFor, ensureImage, ensureTestImage, removeAll, smallLimits, RUNTIME } = require('./helpers');
const fill = (u, n) => u.repeat(Math.ceil(n / u.length)).slice(0, n);
const room = scanner.SCAN_LIMITS.fileBytes - 200;
const src = (body) => `pragma solidity ^0.8.20;\ncontract E { function t() public {\nvm.etch(a, b);\n${body}\n} }\n`;
const CASES = { many8k: fill('a.etch;\n', room), many2k: fill('a.etch;\n', 16000), many1k: fill('a.etch;\n', 8000) };
test('probe', { timeout: 1500000 }, async (t) => {
  const config = dockerTestConfig();
  const docker = dockerFor(config);
  t.after(() => removeAll(docker, config.instance).catch(() => {}));
  await ensureTestImage(docker);
  await ensureImage(docker, scanner.SEMGREP.reference);
  const say = (m) => { console.log(`PROBE ${RUNTIME} ${m}`); };
  const receivedAt = Date.now();
  const result = await executeRun({
    docker, config, limits: smallLimits({ memoryMb: 512, runSeconds: 1200, testSeconds: 120 }), image: TEST_IMAGE, runId: crypto.randomBytes(8).toString('hex'),
    steps: [async (ctx) => {
      await ctx.closeSandbox();
      ctx.beginToolBudget(1400000);
      const h = await ctx.openSandbox({ image: scanner.SEMGREP.reference, limits: scanner.SCAN_SANDBOX_LIMITS, tool: true });
      const names = Object.keys(CASES);
      await h.exec(['/bin/tar', '-xf', '-', '-C', '/work'], { name: 'unpack', timeoutMs: 30000, workdir: '/work', stdin: scanner.scanTar([{ name: 'rules/honesty.yml', bytes: scanner.ruleBytes('honesty') }, ...names.map((n, i) => ({ name: `src/f${i}.sol`, bytes: Buffer.from(src(CASES[n])) }))]) });
      for (let i = 0; i < names.length; i += 1) {
        const argv = scanner.semgrepArgv({ rules: 'honesty', targets: [`f${i}.sol`] });
        const out = new Prefix(scanner.OUTPUT_MAX_BYTES);
        const t0 = Date.now();
        const r = await h.exec(argv, { name: `stdout:${names[i]}`, timeoutMs: 400000, workdir: '/work/src', tee: out });
        const b = out.bytes();
        let parsed = 'bad';
        try { const d = JSON.parse(b.toString('utf8')); parsed = `results=${d.results.length} errors=${d.errors.length}`; } catch (e) { parsed = `not json: ${e.message.slice(0, 80)}`; }
        say(`${names[i]} stdout exit=${r.exitCode} ms=${Date.now() - t0} bytes=${b.length} total=${out.totalBytes} truncated=${out.truncated} ${parsed}`);
        say(`  head=${JSON.stringify(b.subarray(0, 120).toString('utf8'))}`);
        say(`  tail=${JSON.stringify(b.subarray(Math.max(0, b.length - 200)).toString('utf8'))}`);
        say(`  stderr=${JSON.stringify(String(r.stderr && r.stderr.text).slice(0, 400))}`);
        const f = new Prefix(1024);
        const t1 = Date.now();
        const r2 = await h.exec([...argv.slice(0, 2), '--output', `/work/o${i}.json`, ...argv.slice(2)], { name: `file:${names[i]}`, timeoutMs: 400000, workdir: '/work/src', tee: f });
        const sum = new Prefix(1024);
        await h.exec(['/bin/sh', '-c', `wc -c < /work/o${i}.json; sha256sum /work/o${i}.json; tail -c 60 /work/o${i}.json`, 'vcr-sum'], { name: `sum:${names[i]}`, timeoutMs: 30000, tee: sum });
        const c = new Prefix(scanner.OUTPUT_MAX_BYTES);
        await h.exec(['/bin/cat', `/work/o${i}.json`], { name: `cat:${names[i]}`, timeoutMs: 60000, tee: c });
        let p2 = 'bad';
        try { const d = JSON.parse(c.bytes().toString('utf8')); p2 = `results=${d.results.length}`; } catch (e) { p2 = `not json: ${e.message.slice(0, 80)}`; }
        say(`${names[i]} file exit=${r2.exitCode} ms=${Date.now() - t1} stdoutBytes=${f.totalBytes} sum=${JSON.stringify(sum.bytes().toString('utf8'))} catBytes=${c.bytes().length} sha=${crypto.createHash('sha256').update(c.bytes()).digest('hex').slice(0, 16)} ${p2}`);
      }
    }],
    receivedAt, deadlineAt: receivedAt + 1500000, active: new Set(), log: silent
  });
  say(`outcome=${result.outcome} ${JSON.stringify(result.abstain)}`);
});
