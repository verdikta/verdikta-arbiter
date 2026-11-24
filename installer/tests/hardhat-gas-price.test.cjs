// arbiter-operator/hardhat.config.js prices every installer on-chain call
// (register, deregister, key authorization, deployment). It had fixed prices,
// sent as legacy transactions that pay all of it: 5 gwei on Base Sepolia while
// the network asked 0.005. This test loads the REAL config file, with Hardhat's
// plugins stubbed (the installer's CI job installs no dependencies), and reads
// what each network is given.
// Run: node --test installer/tests/hardhat-gas-price.test.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CONFIG = path.resolve(__dirname, '../../arbiter-operator/hardhat.config.js');
const NETWORKS = ['sepolia', 'base_sepolia', 'base_mainnet'];

const LOADER = `
const Module = require('module');
const load = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'dotenv') return { config() {} };
  if (request === '@nomicfoundation/hardhat-ethers' || request === 'hardhat-deploy') return {};
  if (request === 'hardhat/config') return { subtask() { return { setAction() {} }; } };
  if (request === 'hardhat/builtin-tasks/task-names') return {};
  return load.call(this, request, ...rest);
};
const config = require(process.argv[1]);
const out = {};
for (const name of ${JSON.stringify(NETWORKS)}) out[name] = config.networks[name].gasPrice;
process.stdout.write(JSON.stringify(out));
`;

function gasPrices(value) {
  const env = { PATH: process.env.PATH };
  if (value !== undefined) env.VERDIKTA_GAS_PRICE_GWEI = value;
  const run = spawnSync(process.execPath, ['-e', LOADER, CONFIG], { env, encoding: 'utf8' });
  return { status: run.status, out: run.status === 0 ? JSON.parse(run.stdout) : null, err: run.stderr };
}

test('with nothing set, every network pays the network price', () => {
  const { status, out, err } = gasPrices(undefined);
  assert.equal(status, 0, err);
  for (const name of NETWORKS) assert.equal(out[name], 'auto', name);
});

test('an empty value and "auto" mean the same', () => {
  for (const value of ['', '  ', 'auto', 'AUTO']) {
    const { status, out, err } = gasPrices(value);
    assert.equal(status, 0, `${JSON.stringify(value)}: ${err}`);
    for (const name of NETWORKS) assert.equal(out[name], 'auto', `${JSON.stringify(value)} ${name}`);
  }
});

test('VERDIKTA_GAS_PRICE_GWEI pins a price, in wei, on every network', () => {
  for (const [value, wei] of [['5', 5_000_000_000], ['0.05', 50_000_000], ['0.000000001', 1], [' 1.5 ', 1_500_000_000], ['500', 500_000_000_000]]) {
    const { status, out, err } = gasPrices(value);
    assert.equal(status, 0, `${value}: ${err}`);
    for (const name of NETWORKS) assert.equal(out[name], wei, `${value} ${name}`);
  }
});

test('a value that is not a price stops the command and names the variable', () => {
  for (const value of ['abc', '-1', '0', '0.0', '1e3', '5 gwei', '0x10', '1.', '.5', '0.0000000001', '501', '5000000000']) {
    const { status, err } = gasPrices(value);
    assert.notEqual(status, 0, `${value} was accepted`);
    assert.match(err, /VERDIKTA_GAS_PRICE_GWEI=/, value);
    assert.match(err, /leave it unset to pay the network's price/, value);
  }
});

test('no network has a price written into the file', () => {
  const source = fs.readFileSync(CONFIG, 'utf8');
  const fixed = source.split('\n').filter((line) => /^\s*gasPrice\s*:/.test(line) && !/gasPrice:\s*GAS_PRICE,/.test(line));
  assert.deepEqual(fixed, []);
  assert.equal((source.match(/gasPrice:\s*GAS_PRICE,/g) || []).length, NETWORKS.length);
});

// configure-node.sh (key re-authorization) and deploy-contracts.sh copy
// hardhat.config.js ALONE into a build directory and run Hardhat there: a
// require of one of our own files would break both.
test('the config requires nothing of ours', () => {
  const source = fs.readFileSync(CONFIG, 'utf8');
  const local = [...source.matchAll(/require\(\s*["'](\.{1,2}\/[^"']*)["']\s*\)/g)].map((m) => m[1]);
  assert.deepEqual(local, []);
  for (const script of ['bin/configure-node.sh', 'bin/deploy-contracts.sh']) {
    const text = fs.readFileSync(path.resolve(__dirname, '..', script), 'utf8');
    assert.match(text, /cp "\$ARBITER_OPERATOR_SRC_DIR\/hardhat\.config\.js"/, `${script} no longer copies the config alone: this pin can go`);
  }
});

// Hardhat 2.30.0 (2026-11-24) needs Node 22: its native module's platform
// package declares that engine, npm on Node 20 skips it without a word, and
// `hardhat test` then dies with "Cannot find native binding". The installer
// puts operators on Node 20.18 and there is no lockfile here, so an open range
// took the new release the day it was published.
test('Hardhat stays on a release that runs on the Node the installer installs', () => {
  const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../arbiter-operator/package.json'), 'utf8'));
  const range = pkg.devDependencies.hardhat;
  const upper = /<\s*2\.(\d+)\.0\b/.exec(range);
  assert.ok(upper && Number(upper[1]) <= 30, `hardhat "${range}" has no upper bound below 2.30.0: raise it only together with the Node version in installer/bin/setup-environment.sh and the workflows`);
  assert.doesNotMatch(range, /^[\^~]/, range);
});
