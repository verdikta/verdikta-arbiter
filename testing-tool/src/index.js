#!/usr/bin/env node

require('dotenv').config();
const { Command } = require('commander');
const chalk = require('chalk');
const ProgressBar = require('progress');
const path = require('path');

// Import our modules
const configManager = require('./config-manager');
const scenarioLoader = require('./scenario-loader');
const attachmentHandler = require('./attachment-handler');
const TestRunner = require('./test-runner');
const resultsManager = require('./results-manager');
const logger = require('./logger');

// CLI Setup
const program = new Command();
program
  .name('verdikta-testing-tool')
  .description('Standalone testing tool for Verdikta AI arbiters')
  .version('1.0.0');

// Initialize command
program
  .command('init')
  .description('Initialize the testing tool with example configurations')
  .action(async () => {
    try {
      console.log(chalk.blue('🚀 Initializing Verdikta Testing Tool...'));
      
      await configManager.initialize();
      
      // Create example scenarios CSV only if it doesn't exist
      const scenariosPath = path.join(__dirname, '../scenarios/scenarios.csv');
      const scenariosTemplatePath = path.join(__dirname, '../scenarios/scenarios.csv.template');
      
      // Always create/update template
      await scenarioLoader.createExampleCsv(scenariosTemplatePath);
      
      // Only create actual file if it doesn't exist
      if (!await require('fs-extra').pathExists(scenariosPath)) {
        await scenarioLoader.createExampleCsv(scenariosPath);
        console.log(chalk.green('✅ Created scenarios.csv from template'));
      } else {
        console.log(chalk.yellow('⚠️  scenarios.csv already exists - preserved existing file'));
        console.log(chalk.cyan('💡 Updated template available at scenarios.csv.template'));
      }
      
      // Create example archives directory
      const attachmentsDir = path.join(__dirname, '../scenarios/attachments');
      await require('fs-extra').ensureDir(attachmentsDir);
      
      const exampleArchives = ['energy-invest.zip', 'product-launch.zip', 'merger-decision.zip'];
      let archivesCreated = 0;
      let archivesSkipped = 0;
      
      for (const archive of exampleArchives) {
        const archivePath = path.join(attachmentsDir, archive);
        if (!await require('fs-extra').pathExists(archivePath)) {
          const scenarioId = archive.replace('.zip', '');
          await attachmentHandler.createExampleArchive(scenarioId, archivePath);
          archivesCreated++;
        } else {
          archivesSkipped++;
        }
      }
      
      if (archivesCreated > 0) {
        console.log(chalk.green(`✅ Created ${archivesCreated} example archives`));
      }
      if (archivesSkipped > 0) {
        console.log(chalk.yellow(`⚠️  Preserved ${archivesSkipped} existing archives`));
      }
      
      console.log(chalk.green('✅ Initialization complete!'));
      console.log(chalk.yellow('📁 Configuration files ready in: config/'));
      console.log(chalk.yellow('📋 Scenarios file: scenarios/scenarios.csv'));
      console.log(chalk.yellow('📦 Archives directory: scenarios/attachments/'));
      console.log(chalk.gray('📄 Templates available: scenarios.csv.template'));
      console.log(chalk.cyan('\n🔧 Next steps:'));
      console.log(chalk.cyan('  1. Edit config/tool-config.json to set your AI node URL'));
      console.log(chalk.cyan('  2. Configure jury panels in config/juries/'));
      console.log(chalk.cyan('  3. Edit scenarios/scenarios.csv with your test scenarios'));
      console.log(chalk.cyan('  4. Run "npm start test" to execute tests'));
      console.log(chalk.gray('\n💡 Tip: Running init again will not overwrite your existing configurations'));
      
    } catch (error) {
      console.error(chalk.red('❌ Initialization failed:'), error.message);
      process.exit(1);
    }
  });

// Test command
program
  .command('test')
  .description('Run test scenarios against AI juries')
  .option('-s, --scenarios <file>', 'CSV file with scenarios', 'scenarios/scenarios.csv')
  .option('-j, --juries <ids>', 'Comma-separated jury IDs to test (default: all)')
  .option('--scenario-ids <ids>', 'Comma-separated scenario IDs to test (default: all)')
  .option('--tags <tags>', 'Comma-separated tags to filter scenarios')
  .option('--dry-run', 'Validate setup without executing tests')
  .action(async (options) => {
    // Debug: log the parsed options
    logger.debug('Parsed command options:', options);
    try {
      console.log(chalk.blue('🧪 Starting Verdikta Testing Tool...'));
      
      // Initialize configuration
      await configManager.initialize();
      const toolConfig = await configManager.getToolConfig();
      
      // Load scenarios
      console.log(chalk.cyan('📋 Loading scenarios...'));
      const scenariosPath = path.resolve(options.scenarios);
      const loadOptions = {};
      
      if (options.scenarioIds) {
        loadOptions.scenarioIds = options.scenarioIds.split(',').map(s => s.trim());
        console.log(chalk.gray(`🔍 Filtering by scenario IDs: ${loadOptions.scenarioIds.join(', ')}`));
      }
      if (options.tags) {
        loadOptions.tags = options.tags.split(',').map(t => t.trim());
        console.log(chalk.gray(`🏷️  Filtering by tags: ${loadOptions.tags.join(', ')}`));
      }
      
      const scenarios = await scenarioLoader.loadScenarios(scenariosPath, loadOptions);
      if (scenarios.length === 0) {
        console.log(chalk.yellow('⚠️  No scenarios found matching criteria'));
        return;
      }
      
      // Load juries
      console.log(chalk.cyan('👥 Loading jury configurations...'));
      let juries = await configManager.getAllJuries();
      
      if (options.juries) {
        const requestedJuryIds = options.juries.split(',').map(id => parseInt(id.trim()));
        juries = juries.filter(jury => requestedJuryIds.includes(jury.id));
      }
      
      if (juries.length === 0) {
        console.log(chalk.yellow('⚠️  No juries found matching criteria'));
        return;
      }
      
      // Validate configurations
      console.log(chalk.cyan('🔍 Validating configurations...'));
      for (const jury of juries) {
        configManager.validateJuryConfig(jury);
      }
      
      // Validate attachments
      const attachmentValidation = await scenarioLoader.validateAttachments(scenarios);
      const missingAttachments = attachmentValidation.filter(v => !v.exists);
      
      if (missingAttachments.length > 0) {
        console.log(chalk.red('❌ Missing attachment files:'));
        missingAttachments.forEach(v => {
          console.log(chalk.red(`  - ${v.scenario_id}: ${v.attachment_archive} (${v.error})`));
        });
        return;
      }
      
      // Test AI node connection
      console.log(chalk.cyan('🔗 Testing AI node connection...'));
      const testRunner = new TestRunner(toolConfig);
      const connectionOk = await testRunner.testConnection();
      
      if (!connectionOk) {
        console.log(chalk.red('❌ Cannot connect to AI node at'), toolConfig.aiNodeUrl);
        console.log(chalk.yellow('💡 Check that the AI node is running and accessible'));
        return;
      }
      
      // Display test plan
      console.log(chalk.green('\n✅ Validation complete!'));
      console.log(chalk.blue('📊 Test Plan:'));
      console.log(chalk.blue(`  • Scenarios: ${scenarios.length}`));
      console.log(chalk.blue(`  • Juries: ${juries.length}`));
      console.log(chalk.blue(`  • Total tests: ${scenarios.length * juries.length}`));
      console.log(chalk.blue(`  • AI Node: ${toolConfig.aiNodeUrl}`));
      
      // Show scenario stats
      const stats = scenarioLoader.getScenarioStats(scenarios);
      console.log(chalk.blue(`  • Outcome counts: ${JSON.stringify(stats.outcomeCounts)}`));
      if (stats.uniqueTags.length > 0) {
        console.log(chalk.blue(`  • Tags: ${stats.uniqueTags.join(', ')}`));
      }
      
      if (options.dryRun) {
        console.log(chalk.yellow('🏁 Dry run complete - no tests executed'));
        return;
      }
      
      // Execute tests
      console.log(chalk.green('\n🚀 Starting test execution...'));
      const runId = generateRunId();
      const startTime = new Date();
      
      // Progress tracking
      let progressBar;
      const totalTests = scenarios.length * juries.length;
      
      const results = await testRunner.executeScenarios(scenarios, juries, (progress) => {
        if (!progressBar) {
          progressBar = new ProgressBar(
            chalk.cyan('Testing [:bar] :percent :current/:total (:etas remaining)'), 
            {
              complete: '█',
              incomplete: '░',
              width: 30,
              total: totalTests
            }
          );
        }
        
        progressBar.update(progress.completed / progress.total);
        
        if (progress.error) {
          console.log(chalk.red(`\n❌ ${progress.currentScenario} (${progress.currentJury}): ${progress.error}`));
        } else if (progress.lastResult && !progress.lastResult.error) {
          const winner = progress.lastResult.scores?.[0]?.outcome || 'Unknown';
          console.log(chalk.gray(`\n✓ ${progress.currentScenario} (${progress.currentJury}): Winner = ${winner}`));
        }
      });
      
      if (progressBar) {
        progressBar.terminate();
      }
      
      // Generate final test run object
      const testRun = {
        runId,
        timestamp: startTime.toISOString(),
        juryIds: juries.map(j => j.id),
        scenarioIds: scenarios.map(s => s.scenario_id),
        results,
        statistics: generateRunStatistics(results, scenarios, juries)
      };
      
      // Save results
      console.log(chalk.cyan('\n💾 Saving results...'));
      const resultsDir = await resultsManager.saveTestRun(testRun);
      
      // Display summary
      console.log(chalk.green('\n🎉 Test execution complete!'));
      displayTestSummary(testRun.statistics, resultsDir);
      
    } catch (error) {
      console.error(chalk.red('❌ Test execution failed:'), error.message);
      logger.error('Test execution error:', error);
      process.exit(1);
    }
  });

// List juries command
program
  .command('juries')
  .description('List available jury configurations')
  .action(async () => {
    try {
      await configManager.initialize();
      const juries = await configManager.getAllJuries();
      
      if (juries.length === 0) {
        console.log(chalk.yellow('No jury configurations found. Run "init" to create examples.'));
        return;
      }
      
      console.log(chalk.blue('👥 Available Jury Configurations:'));
      juries.forEach(jury => {
        console.log(chalk.cyan(`\n${jury.id}. ${jury.name}`));
        console.log(chalk.gray(`   Iterations: ${jury.iterations || 1}`));
        console.log(chalk.gray('   Models:'));
        jury.models.forEach(model => {
          console.log(chalk.gray(`     - ${model.AI_PROVIDER}:${model.AI_MODEL} (weight: ${model.WEIGHT})`));
        });
      });
    } catch (error) {
      console.error(chalk.red('❌ Failed to list juries:'), error.message);
      process.exit(1);
    }
  });

// Results command
program
  .command('results')
  .description('List and analyze previous test runs')
  .option('-r, --run <id>', 'Show details for specific run ID')
  .action(async (options) => {
    try {
      if (options.run) {
        // Show specific run details
        const testRun = await resultsManager.loadTestRun(options.run);
        if (!testRun) {
          console.log(chalk.red(`❌ Test run ${options.run} not found`));
          return;
        }
        
        console.log(chalk.blue(`📊 Test Run: ${testRun.runId}`));
        console.log(chalk.gray(`   Timestamp: ${testRun.timestamp}`));
        console.log(chalk.gray(`   Scenarios: ${testRun.scenarioIds.length}`));
        console.log(chalk.gray(`   Juries: ${testRun.juryIds.length}`));
        console.log(chalk.gray(`   Total Tests: ${testRun.results.length}`));
        
        displayTestSummary(testRun.statistics, `results/run-${testRun.runId}`);
        
      } else {
        // List all runs
        const runs = await resultsManager.listTestRuns();
        
        if (runs.length === 0) {
          console.log(chalk.yellow('No test runs found. Run some tests first!'));
          return;
        }
        
        console.log(chalk.blue('📋 Test Run History:'));
        runs.forEach(run => {
          console.log(chalk.cyan(`\n${run.runId}`));
          console.log(chalk.gray(`   Date: ${new Date(run.timestamp).toLocaleString()}`));
          console.log(chalk.gray(`   Tests: ${run.totalTests} (${run.scenarioCount} scenarios × ${run.juryCount} juries)`));
        });
        
        console.log(chalk.yellow('\n💡 Use --run <id> to see details for a specific run'));
      }
    } catch (error) {
      console.error(chalk.red('❌ Failed to load results:'), error.message);
      process.exit(1);
    }
  });

// Status command
program
  .command('status')
  .description('Check AI node status and tool configuration')
  .action(async () => {
    try {
      await configManager.initialize();
      const toolConfig = await configManager.getToolConfig();
      
      console.log(chalk.blue('🔧 Tool Configuration:'));
      console.log(chalk.gray(`   AI Node URL: ${toolConfig.aiNodeUrl}`));
      console.log(chalk.gray(`   Timeout: ${toolConfig.timeoutMs}ms`));
      console.log(chalk.gray(`   Max Retries: ${toolConfig.maxRetries}`));
      console.log(chalk.gray(`   Log Level: ${toolConfig.logLevel}`));
      
      console.log(chalk.blue('\n🔗 AI Node Status:'));
      const testRunner = new TestRunner(toolConfig);
      const connectionOk = await testRunner.testConnection();
      
      if (connectionOk) {
        console.log(chalk.green('   ✅ Connection: OK'));
        
        const healthInfo = await testRunner.getHealthInfo();
        if (healthInfo) {
          console.log(chalk.green(`   ✅ Health: ${healthInfo.status}`));
        }
      } else {
        console.log(chalk.red('   ❌ Connection: Failed'));
        console.log(chalk.yellow('   💡 Check that the AI node is running and accessible'));
      }
      
      // Check juries
      const juries = await configManager.getAllJuries();
      console.log(chalk.blue(`\n👥 Juries: ${juries.length} configured`));
      
      // Check scenarios
      const scenariosPath = path.join(__dirname, '../scenarios/scenarios.csv');
      try {
        const scenarios = await scenarioLoader.loadScenarios(scenariosPath);
        console.log(chalk.blue(`📋 Scenarios: ${scenarios.length} available`));
        
        const validation = await scenarioLoader.validateAttachments(scenarios);
        const missing = validation.filter(v => !v.exists);
        if (missing.length > 0) {
          console.log(chalk.yellow(`   ⚠️  ${missing.length} scenarios have missing attachments`));
        } else {
          console.log(chalk.green('   ✅ All attachments available'));
        }
      } catch (error) {
        console.log(chalk.yellow('   ⚠️  No scenarios file found'));
      }
      
    } catch (error) {
      console.error(chalk.red('❌ Status check failed:'), error.message);
      process.exit(1);
    }
  });

// Helper functions
function generateRunId() {
  const now = new Date();
  return now.toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
}

function generateRunStatistics(results, scenarios, juries) {
  const successfulTests = results.filter(r => !r.error).length;
  const failedTests = results.filter(r => r.error).length;
  const executionTimes = results.map(r => r.execution_time_ms);
  
  return {
    totalScenarios: scenarios.length,
    totalJuries: juries.length,
    successfulTests,
    failedTests,
    averageExecutionTime: Math.round(executionTimes.reduce((a, b) => a + b, 0) / executionTimes.length)
  };
}

function displayTestSummary(statistics, resultsDir) {
  console.log(chalk.blue('📈 Test Summary:'));
  console.log(chalk.gray(`   Success Rate: ${(statistics.successfulTests / (statistics.successfulTests + statistics.failedTests) * 100).toFixed(1)}%`));
  console.log(chalk.gray(`   Successful: ${statistics.successfulTests}`));
  console.log(chalk.gray(`   Failed: ${statistics.failedTests}`));
  console.log(chalk.gray(`   Avg Execution Time: ${statistics.averageExecutionTime}ms`));
  console.log(chalk.yellow(`\n📁 Results saved to: ${resultsDir}/`));
  console.log(chalk.yellow('📊 View analysis reports in: analysis/ subdirectory'));
  console.log(chalk.yellow('📋 Compare results in: results.csv'));
}

// Parse command line arguments
program.parse();

// If no command provided, show help
if (!process.argv.slice(2).length) {
  program.outputHelp();
} 