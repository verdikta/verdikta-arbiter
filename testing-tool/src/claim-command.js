const path = require('path');
const chalk = require('chalk');
const { loadClaimScenarios } = require('./claim-scenarios');
const { runClaimScenario } = require('./claim-runner');
const resultsManager = require('./results-manager');
const TestRunner = require('./test-runner');

const DEFAULT_CLAIMS_DIR = path.join(__dirname, '../scenarios/claims');
const list = (value) => value.split(',').map((item) => item.trim()).filter(Boolean);

/**
 * `test --type claim`. Exits non-zero on anything that is not a finished run: a scenario
 * that does not load, a refused flag, an AI Node that is not there, a request with no
 * verdict. A verdict that differs from the expected outcome is a measurement, and is
 * reported, since measuring it is what the claim type is for.
 *
 * @param {object} options - the `test` command's options
 * @param {object} toolConfig
 * @returns {Promise<number>} the exit code
 */
async function runClaimCommand(options, toolConfig) {
  const refuse = (message) => {
    console.error(chalk.red(`❌ ${message}`));
    return 1;
  };
  if (options.juries) return refuse('--juries does not apply to --type claim: the panel is the listing\'s (manifest juryParameters)');
  if (!options.dryRun && options.jury !== 'real') {
    return refuse('A claim calls the listing\'s panel on the AI Node\'s providers, which spends money: pass --jury real, or --dry-run to validate without calling anything');
  }

  const dir = options.claimsDir ? path.resolve(options.claimsDir) : DEFAULT_CLAIMS_DIR;
  const scenarios = await loadClaimScenarios(dir, {
    scenarioIds: options.scenarioIds ? list(options.scenarioIds) : undefined,
    tags: options.tags ? list(options.tags) : undefined
  });
  if (scenarios.length === 0) return refuse('No claim scenarios match those filters');

  console.log(chalk.blue(`📊 Claim scenarios (${scenarios.length}):`));
  for (const scenario of scenarios) {
    console.log(chalk.blue(`  • ${scenario.scenario_id}: ${scenario.input.priorFindings.length} prior finding(s), ${scenario.input.contextPack.files.length} pack file(s), expected ${scenario.expected_outcome || '(none)'}`));
  }
  if (options.dryRun) {
    console.log(chalk.yellow('🏁 Dry run complete - every scenario is valid, and nothing was called'));
    return 0;
  }

  const runner = new TestRunner(toolConfig);
  if (!await runner.testConnection()) return refuse(`Cannot connect to the AI node at ${toolConfig.aiNodeUrl}`);

  const results = [];
  for (const scenario of scenarios) {
    console.log(chalk.cyan(`🧪 ${scenario.scenario_id}…`));
    const result = await runClaimScenario(scenario, { aiNodeUrl: toolConfig.aiNodeUrl });
    results.push(result);
    if (result.error) console.log(chalk.red(`  ❌ ${result.error}`));
    else console.log(chalk.gray(`  settles ${result.settled.outcome}${result.expected_outcome ? ` (expected ${result.expected_outcome})` : ''} in ${result.execution_time_ms} ms`));
  }

  const failedTests = results.filter((result) => result.error).length;
  const compared = results.filter((result) => result.agrees !== null);
  const started = results[0].timestamp;
  if (options.resultsDir) resultsManager.resultsDir = path.resolve(options.resultsDir);
  const saved = await resultsManager.saveTestRun({
    runId: started.replace(/[:.]/g, '-').replace('T', '_').slice(0, 19),
    timestamp: started,
    type: 'claim',
    juryIds: ['listing'],
    scenarioIds: scenarios.map((scenario) => scenario.scenario_id),
    results,
    statistics: {
      totalScenarios: scenarios.length,
      totalJuries: 1,
      successfulTests: results.length - failedTests,
      failedTests,
      averageExecutionTime: Math.round(results.reduce((sum, result) => sum + result.execution_time_ms, 0) / results.length),
      compared: compared.length,
      agreed: compared.filter((result) => result.agrees).length
    }
  });
  console.log(chalk.green(`🎉 ${results.length - failedTests}/${results.length} gave a verdict; ${compared.filter((result) => result.agrees).length}/${compared.length} agree with the expected outcome`));
  console.log(chalk.yellow(`📁 Results saved to: ${saved}/`));
  return failedTests === 0 ? 0 : 1;
}

module.exports = { runClaimCommand };
