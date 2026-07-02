#!/usr/bin/env node
'use strict';

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { program } = require('commander');
const chalk = require('chalk');
const { loadScenarios } = require('./scenario-loader');
const Reporter = require('./reporter');
const { runL2 } = require('./l2/run-l2');
const { runL4 } = require('./l4/run-l4');

const CONFIG_FILE = path.join(__dirname, '..', 'config', 'e2e-config.json');

/** Merge config file, environment overrides, and CLI options into one config. */
function buildConfig(cliOpts = {}) {
  const base = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  return {
    ...base,
    adapterUrl: cliOpts.adapterUrl || process.env.ADAPTER_URL || base.adapterUrl,
    aiNodeUrl: process.env.AI_NODE_URL || base.aiNodeUrl,
    ipfs: {
      ...base.ipfs,
      // Try our own Pinata pin first (always immediately available since we
      // just uploaded it there), then public gateways as fallback — public
      // gateways can have propagation delay or rate-limit fresh pins.
      gateways: process.env.IPFS_GATEWAY ? [process.env.IPFS_GATEWAY] : base.ipfs.gateways,
      checkJustificationFetch: process.env.E2E_SKIP_IPFS_CHECK === 'true'
        ? false
        : base.ipfs.checkJustificationFetch,
    },
    mockAi: {
      ...base.mockAi,
      port: parseInt(process.env.MOCK_AI_PORT || base.mockAi.port, 10),
    },
  };
}

async function executeL2(cliOpts) {
  const cfg = buildConfig(cliOpts);
  const mock = cliOpts.real ? false : true; // default to mock unless --real given
  const ids = cliOpts.scenario ? cliOpts.scenario.split(',').map((s) => s.trim()) : null;
  const scenarios = loadScenarios(cliOpts.scenarios, ids);

  console.log(chalk.bold(`\nVerdikta E2E — L2 (${mock ? 'mock' : 'real'} AI) — ${scenarios.length} scenario(s)\n`));

  const reporter = new Reporter();
  await runL2(cfg, scenarios, {
    mock,
    reporter,
    assertWinner: cliOpts.assertWinner,
    bootAdapter: cliOpts.bootAdapter,
  });
  reporter.printConsole();

  if (cliOpts.report) reporter.writeJson(cliOpts.report);
  if (cliOpts.junit) reporter.writeJUnit(cliOpts.junit);

  process.exit(reporter.failed === 0 ? 0 : 1);
}

async function executeL4(cliOpts) {
  const cfg = buildConfig(cliOpts);
  const ids = cliOpts.scenario ? cliOpts.scenario.split(',').map((s) => s.trim()) : null;
  const scenarios = loadScenarios(cliOpts.scenarios, ids);

  console.log(chalk.bold(`\nVerdikta E2E — L4 (live testnet) — ${scenarios.length} scenario(s)\n`));

  const reporter = new Reporter();
  await runL4(cfg, scenarios, { reporter, assertWinner: cliOpts.assertWinner });
  reporter.printConsole();

  if (cliOpts.report) reporter.writeJson(cliOpts.report);
  if (cliOpts.junit) reporter.writeJUnit(cliOpts.junit);

  process.exit(reporter.failed === 0 ? 0 : 1);
}

program
  .name('verdikta-e2e')
  .description('End-to-end tests for the Verdikta Arbiter node');

program
  .command('l2')
  .description('L2: off-chain arbiter pipeline (External Adapter → AI Node → IPFS)')
  .option('--mock', 'use the bundled deterministic mock AI Node (default)')
  .option('--real', 'use a real AI Node behind the External Adapter')
  .option('--boot-adapter', 'spawn the External Adapter automatically (turnkey; requires external-adapter deps + Pinata JWT)')
  .option('--adapter-url <url>', 'External Adapter base URL')
  .option('--scenario <ids>', 'comma-separated scenario ids to run')
  .option('--scenarios <file>', 'path to a scenarios JSON file')
  .option('--assert-winner', 'in --real mode, also assert the winning outcome index')
  .option('--report <file>', 'write JSON report to file')
  .option('--junit <file>', 'write JUnit XML report to file')
  .action((opts) => executeL2(opts).catch((err) => {
    console.error(chalk.red(`\nL2 run failed: ${err.message}\n`));
    process.exit(1);
  }));

program
  .command('smoke')
  .description('Quick single-scenario check against the LIVE pipeline (real AI Node, structural assertions only) for post-deploy verification')
  .option('--adapter-url <url>', 'External Adapter base URL')
  .option('--scenario <id>', 'scenario id to run', 'frontend-default')
  .action((opts) => executeL2({
    real: true, // hit the real running arbiter, not the mock
    adapterUrl: opts.adapterUrl,
    scenario: opts.scenario,
  }).catch((err) => {
    console.error(chalk.red(`\nSmoke run failed: ${err.message}\n`));
    process.exit(1);
  }));

program
  .command('l4')
  .description('L4: live testnet acceptance (on-chain requestAIEvaluationWithApproval → getEvaluation)')
  .option('--scenario <ids>', 'comma-separated scenario ids to run')
  .option('--scenarios <file>', 'path to a scenarios JSON file')
  .option('--assert-winner', 'also assert the winning outcome index (needs expectedWinnerIndex)')
  .option('--report <file>', 'write JSON report to file')
  .option('--junit <file>', 'write JUnit XML report to file')
  .action((opts) => executeL4(opts).catch((err) => {
    console.error(chalk.red(`\nL4 run failed: ${err.message}\n`));
    process.exit(1);
  }));

program.parseAsync(process.argv);
