#!/usr/bin/env node
'use strict';

/**
 * A paid run with nothing paid (node A7d): scripts/jury-run.sh with its real meter and its real AI Node (a production
 * build, with LangChain and the provider SDKs), and stub providers on loopback in place of the real ones. It proves what
 * no unit test can: that the AI Node's calls do go through the meter, unstreamed, each with its own provider's key, and
 * that everything stops by itself.
 *
 *   (cd ai-node && npm ci && npx next build) && (cd testing-tool && npm ci) && npm run test:jury-e2e --prefix testing-tool
 */

const assert = require('assert');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { writeClaimScenario } = require('../helpers/claimFixture');

const REPO = path.join(__dirname, '..', '..', '..');
const KEYS = Object.freeze({ OPENAI_API_KEY: 'fake-openai-aaaaaaaaaaaaaaaa', ANTHROPIC_API_KEY: 'fake-anthropic-bbbbbbbbbbbbbbbb', OPENROUTER_API_KEY: 'fake-openrouter-cccccccccccccccc', XAI_API_KEY: 'fake-xai-dddddddddddddddd' });
const reply = (score) => JSON.stringify({ score, justification: 'stub reasons' });

async function main() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'jury-e2e-'));
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      seen.push({ url: req.url, model: body.model, stream: body.stream, maxTokens: body.max_tokens, apiKey: req.headers['x-api-key'], authorization: req.headers.authorization });
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.url.startsWith('/v1/messages')) {
        const juror = body.model === 'claude-sonnet-5-5';
        res.end(JSON.stringify({ id: 'msg', type: 'message', role: 'assistant', model: body.model, stop_reason: 'end_turn', stop_sequence: null, content: [{ type: 'text', text: juror ? reply([0, 0, 0, 0, 1000000, 0]) : 'The panel.' }], usage: { input_tokens: 5000, output_tokens: 700 } }));
      } else {
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: reply([0, 0, 0, 0, 1000000, 0]) } }], usage: { prompt_tokens: 5000, completion_tokens: 900 } }));
      }
    });
  });
  try {
    fs.mkdirSync(path.join(work, 'node'));
    fs.symlinkSync(REPO, path.join(work, 'repo'));
    fs.symlinkSync(path.dirname(process.execPath), path.join(work, 'node', 'bin'));
    const keyFile = path.join(work, 'keys.env');
    fs.writeFileSync(keyFile, Object.entries(KEYS).map(([k, v]) => `${k}=${v}\n`).join(''), { mode: 0o600 });
    for (const id of ['one', 'two']) await writeClaimScenario(path.join(work, 'claims'), { id, priors: 0, scenario: { id, expected_outcome: 'HIGH' } });
    await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
    const stub = `http://127.0.0.1:${server.address().port}`;
    const run = path.join(work, 'run');
    fs.mkdirSync(run);
    const log = fs.openSync(path.join(run, 'driver.log'), 'a');
    const child = spawn('bash', [path.join(REPO, 'testing-tool', 'scripts', 'jury-run.sh'), work, keyFile], {
      stdio: ['ignore', log, log],
      env: { PATH: process.env.PATH, STOP_USD: '5', METER_ARGS: `--upstream-anthropic ${stub} --upstream-openrouter ${stub}` }
    });
    const code = await new Promise((resolve) => { child.on('exit', resolve); });
    assert.strictEqual(code, 0, fs.readFileSync(path.join(run, 'driver.log'), 'utf8').slice(-2000));

    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(run, 'done'), 'utf8')).exit, 0);
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(run, 'summary.json'), 'utf8')).reason, 'finished');
    assert.strictEqual(seen.length, 6, 'two jurors and a justifier, for each of two claims');
    for (const call of seen) {
      assert.notStrictEqual(call.stream, true);
      if (call.url.startsWith('/v1/messages')) assert.strictEqual(call.apiKey, KEYS.ANTHROPIC_API_KEY);
      else assert.strictEqual(call.authorization, `Bearer ${KEYS.OPENROUTER_API_KEY}`);
    }
    const one = JSON.parse(fs.readFileSync(path.join(run, 'claims', 'one.json'), 'utf8'));
    assert.strictEqual(one.settled.outcome, 'HIGH');
    assert.strictEqual(one.spend.calls.length, 3);
    assert.deepStrictEqual(one.jurors.map((j) => j.vector), [[0, 0, 0, 0, 1000000, 0], [0, 0, 0, 0, 1000000, 0]]);

    const check = spawnSync('bash', [path.join(REPO, 'testing-tool', 'scripts', 'jury-check-no-keys.sh'), keyFile, run], { encoding: 'utf8' });
    assert.strictEqual(check.status, 0, check.stdout);

    // A re-run calls nothing: both claims have their results.
    const before = seen.length;
    const again = spawn('bash', [path.join(REPO, 'testing-tool', 'scripts', 'jury-run.sh'), work, keyFile], {
      stdio: ['ignore', log, log],
      env: { PATH: process.env.PATH, STOP_USD: '5', METER_ARGS: `--upstream-anthropic ${stub} --upstream-openrouter ${stub}` }
    });
    assert.strictEqual(await new Promise((resolve) => { again.on('exit', resolve); }), 0);
    assert.strictEqual(seen.length, before, 'a re-run called no provider');
    process.stdout.write('jury-run e2e: passed\n');
  } finally {
    server.closeAllConnections();
    server.close();
    fs.rmSync(work, { recursive: true, force: true });
  }
}

main().then(() => process.exit(0), (error) => {
  process.stderr.write(`jury-run e2e: ${error.stack}\n`);
  process.exit(1);
});
