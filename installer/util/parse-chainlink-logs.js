#!/usr/bin/env node

/**
 * Comprehensive Chainlink Log Parser for Verdikta
 * Analyzes job execution flow, bridge calls, and transaction submissions
 * 
 * Usage:
 *   node parse-chainlink-logs.js [options]
 * 
 * Options:
 *   --container=<name>       Docker container name (default: chainlink)
 *   --since=<time>          Time filter (e.g., "1h", "2025-09-23T21:00:00")
 *   --job-id=<id>           Filter by specific job ID
 *   --agg-id=<id>           Filter by aggregation ID
 *   --detailed              Show detailed pipeline analysis
 *   --errors-only           Show only errors and warnings
 *   --help                  Show this help message
 */

const { spawn } = require('child_process');
const fs = require('fs');

// Parse command line arguments
const args = process.argv.slice(2);
const options = {};

args.forEach(arg => {
  if (arg.startsWith('--')) {
    const [key, value] = arg.slice(2).split('=');
    options[key] = value || true;
  }
});

// Default values
const CONTAINER_NAME = options.container || 'chainlink';
const SINCE_TIME = options.since;
const TARGET_JOB_ID = options['job-id'];
const TARGET_AGG_ID = options['agg-id'];
const DETAILED = options.detailed;
const ERRORS_ONLY = options['errors-only'];

// Help text
if (options.help) {
  console.log(`
Chainlink Log Parser for Verdikta Analysis

Usage: node parse-chainlink-logs.js [options]

Options:
  --container=<name>       Docker container name (default: chainlink)
  --since=<time>          Time filter (e.g., "1h", "2025-09-23T21:00:00")
  --job-id=<id>           Filter by specific job ID
  --agg-id=<id>           Filter by aggregation ID
  --detailed              Show detailed pipeline analysis
  --errors-only           Show only errors and warnings
  --help                  Show this help message

Examples:
  # Analyze recent logs
  node parse-chainlink-logs.js --since=1h

  # Focus on specific aggregation
  node parse-chainlink-logs.js --agg-id=0206893719284c822390f026e70d45195908959d12b83ede56d0f7add3752a42

  # Show only errors
  node parse-chainlink-logs.js --errors-only

  # Detailed pipeline analysis
  node parse-chainlink-logs.js --detailed
`);
  process.exit(0);
}

class ChainlinkLogParser {
  constructor() {
    this.jobRuns = new Map();
    this.bridgeCalls = [];
    this.transactions = [];
    this.errors = [];
    this.aggregations = new Map();
  }

  async parseDockerLogs() {
    return new Promise((resolve, reject) => {
      const dockerArgs = ['logs', CONTAINER_NAME];
      if (SINCE_TIME) {
        dockerArgs.push('--since', SINCE_TIME);
      }

      const docker = spawn('docker', dockerArgs);
      let logData = '';

      docker.stdout.on('data', (data) => {
        logData += data.toString();
      });

      docker.stderr.on('data', (data) => {
        logData += data.toString();
      });

      docker.on('close', (code) => {
        if (code === 0) {
          resolve(logData);
        } else {
          reject(new Error(`Docker logs command failed with code ${code}`));
        }
      });

      docker.on('error', (error) => {
        reject(error);
      });
    });
  }

  parseLogs(logData) {
    const lines = logData.split('\n');
    
    console.log(`🔍 Parsing ${lines.length} log lines...`);
    
    for (const line of lines) {
      this.parseLine(line);
    }
  }

  parseLine(line) {
    if (!line.trim()) return;

    // Parse different types of log entries
    this.parseOracleRequest(line);
    this.parsePipelineRun(line);
    this.parseBridgeCall(line);
    this.parseTransaction(line);
    this.parseError(line);
  }

  parseOracleRequest(line) {
    const oracleMatch = line.match(/Oracle request received.*jobName=([^\\s]+).*externalJobID=([^\\s]+).*requestId=([^\\s]+).*requester=([^\\s]+)/);
    if (oracleMatch) {
      const [, jobName, externalJobID, requestId, requester] = oracleMatch;
      
      // Extract aggregation ID from the data field if present
      const dataMatch = line.match(/data=([a-f0-9]+)/);
      let aggId = null;
      if (dataMatch) {
        try {
          // Decode hex data to find aggregation ID
          const hexData = dataMatch[1];
          // Look for aggregation ID pattern in the hex data
          const aggIdMatch = hexData.match(/([a-f0-9]{64})/g);
          if (aggIdMatch && aggIdMatch.length > 1) {
            aggId = '0x' + aggIdMatch[1]; // Second 64-char hex string is usually the aggId
          }
        } catch (e) {
          // Ignore parsing errors
        }
      }
      
      const timestamp = this.extractTimestamp(line);
      
      if (!this.jobRuns.has(externalJobID)) {
        this.jobRuns.set(externalJobID, {
          jobName,
          externalJobID,
          requests: [],
          pipelineRuns: [],
          bridgeCalls: [],
          transactions: [],
          errors: []
        });
      }
      
      this.jobRuns.get(externalJobID).requests.push({
        requestId,
        requester,
        aggId,
        timestamp
      });

      // Track aggregation
      if (aggId) {
        if (!this.aggregations.has(aggId)) {
          this.aggregations.set(aggId, {
            aggId,
            jobRequests: [],
            commits: [],
            reveals: []
          });
        }
        this.aggregations.get(aggId).jobRequests.push({
          jobName,
          externalJobID,
          requestId,
          timestamp
        });
      }
    }
  }

  parsePipelineRun(line) {
    // Parse pipeline run completion
    const pipelineMatch = line.match(/Completed pipeline run.*executionID=([^\\s]+).*jobID=([^\\s]+).*jobName=([^\\s]+).*fatal=(true|false)/);
    if (pipelineMatch) {
      const [, executionID, jobID, jobName, fatal] = pipelineMatch;
      const timestamp = this.extractTimestamp(line);
      
      // Extract error details if present
      const errorMatch = line.match(/run\.Errors=\[([^\]]+)\]/);
      const errors = errorMatch ? errorMatch[1].split(',').map(e => e.replace(/"/g, '').trim()) : [];
      
      // Find the job run by name or ID
      for (const [externalJobID, jobRun] of this.jobRuns) {
        if (jobRun.jobName === jobName) {
          jobRun.pipelineRuns.push({
            executionID,
            timestamp,
            fatal: fatal === 'true',
            errors
          });
          break;
        }
      }
    }
  }

  parseBridgeCall(line) {
    // Parse bridge call attempts and responses
    const bridgeMatch = line.match(/bridge.*verdikta-ai/);
    if (bridgeMatch) {
      const timestamp = this.extractTimestamp(line);
      this.bridgeCalls.push({
        timestamp,
        line: line.trim()
      });
    }
  }

  parseTransaction(line) {
    // Parse transaction submissions and confirmations
    const txMatch = line.match(/submit.*transaction|transaction.*submit|ethtx/i);
    if (txMatch) {
      const timestamp = this.extractTimestamp(line);
      this.transactions.push({
        timestamp,
        line: line.trim()
      });
    }
  }

  parseError(line) {
    if (line.includes('[ERROR]') || line.includes('[WARN]') || line.includes('error') || line.includes('failed')) {
      const timestamp = this.extractTimestamp(line);
      this.errors.push({
        timestamp,
        line: line.trim()
      });
    }
  }

  extractTimestamp(line) {
    const timestampMatch = line.match(/^([0-9-T:.Z]+)/);
    return timestampMatch ? timestampMatch[1] : null;
  }

  analyze() {
    console.log('\n🔍 CHAINLINK LOG ANALYSIS');
    console.log('='.repeat(60));
    
    if (ERRORS_ONLY) {
      this.showErrors();
      return;
    }

    this.showJobSummary();
    this.showAggregationAnalysis();
    this.showBridgeAnalysis();
    this.showTransactionAnalysis();
    this.showErrorAnalysis();
    
    if (DETAILED) {
      this.showDetailedPipelineAnalysis();
    }
  }

  showJobSummary() {
    console.log(`\n📋 JOB EXECUTION SUMMARY:`);
    console.log('─'.repeat(40));
    console.log(`Total jobs tracked: ${this.jobRuns.size}`);
    
    for (const [externalJobID, jobRun] of this.jobRuns) {
      if (TARGET_JOB_ID && !externalJobID.includes(TARGET_JOB_ID)) continue;
      
      console.log(`\n🔧 ${jobRun.jobName} (${externalJobID.substring(0, 8)}...)`);
      console.log(`   Requests received: ${jobRun.requests.length}`);
      console.log(`   Pipeline runs: ${jobRun.pipelineRuns.length}`);
      
      // Show request details
      jobRun.requests.forEach((req, idx) => {
        console.log(`   Request ${idx + 1}: ${req.requestId.substring(0, 10)}... at ${req.timestamp}`);
        if (req.aggId) {
          console.log(`     Aggregation: ${req.aggId.substring(0, 20)}...`);
        }
      });
      
      // Show pipeline run results
      jobRun.pipelineRuns.forEach((run, idx) => {
        const status = run.fatal ? '❌ FAILED' : '✅ SUCCESS';
        console.log(`   Pipeline ${idx + 1}: ${status} at ${run.timestamp}`);
        if (run.errors.length > 0) {
          console.log(`     Errors: ${run.errors.slice(0, 2).join(', ')}${run.errors.length > 2 ? '...' : ''}`);
        }
      });
    }
  }

  showAggregationAnalysis() {
    console.log(`\n🎯 AGGREGATION ANALYSIS:`);
    console.log('─'.repeat(40));
    
    for (const [aggId, agg] of this.aggregations) {
      if (TARGET_AGG_ID && !aggId.includes(TARGET_AGG_ID)) continue;
      
      console.log(`\n📊 Aggregation: ${aggId.substring(0, 20)}...`);
      console.log(`   Job requests: ${agg.jobRequests.length}`);
      
      // Group by timestamp to see the flow
      const timeGroups = {};
      agg.jobRequests.forEach(req => {
        const timeKey = req.timestamp ? req.timestamp.substring(0, 19) : 'unknown';
        if (!timeGroups[timeKey]) timeGroups[timeKey] = [];
        timeGroups[timeKey].push(req);
      });
      
      for (const [time, reqs] of Object.entries(timeGroups)) {
        console.log(`   ${time}: ${reqs.length} jobs triggered`);
        reqs.forEach(req => {
          console.log(`     ${req.jobName}: ${req.requestId.substring(0, 10)}...`);
        });
      }
    }
  }

  showBridgeAnalysis() {
    console.log(`\n🌉 BRIDGE CALL ANALYSIS:`);
    console.log('─'.repeat(40));
    console.log(`Total bridge-related logs: ${this.bridgeCalls.length}`);
    
    if (this.bridgeCalls.length > 0) {
      console.log('\nRecent bridge activity:');
      this.bridgeCalls.slice(-10).forEach(call => {
        console.log(`   ${call.timestamp}: ${call.line.substring(0, 100)}...`);
      });
    } else {
      console.log('❌ No bridge call logs found');
    }
  }

  showTransactionAnalysis() {
    console.log(`\n📤 TRANSACTION ANALYSIS:`);
    console.log('─'.repeat(40));
    console.log(`Total transaction-related logs: ${this.transactions.length}`);
    
    if (this.transactions.length > 0) {
      console.log('\nRecent transaction activity:');
      this.transactions.slice(-10).forEach(tx => {
        console.log(`   ${tx.timestamp}: ${tx.line.substring(0, 100)}...`);
      });
    } else {
      console.log('❌ No transaction submission logs found');
    }
  }

  showErrorAnalysis() {
    console.log(`\n⚠️ ERROR ANALYSIS:`);
    console.log('─'.repeat(40));
    console.log(`Total errors/warnings: ${this.errors.length}`);
    
    if (this.errors.length > 0) {
      // Group errors by type
      const errorTypes = {};
      this.errors.forEach(error => {
        let type = 'Other';
        if (error.line.includes('EOF')) type = 'Connection EOF';
        else if (error.line.includes('gas')) type = 'Gas Issues';
        else if (error.line.includes('transaction')) type = 'Transaction Issues';
        else if (error.line.includes('bridge')) type = 'Bridge Issues';
        else if (error.line.includes('timeout')) type = 'Timeout Issues';
        else if (error.line.includes('context canceled')) type = 'Context Canceled';
        else if (error.line.includes('securecookie')) type = 'Session Issues';
        
        if (!errorTypes[type]) errorTypes[type] = [];
        errorTypes[type].push(error);
      });
      
      console.log('\nError breakdown:');
      for (const [type, errors] of Object.entries(errorTypes)) {
        console.log(`   ${type}: ${errors.length} occurrences`);
        if (type === 'Connection EOF' || type === 'Bridge Issues') {
          console.log('     Latest examples:');
          errors.slice(-3).forEach(error => {
            console.log(`       ${error.timestamp}: ${error.line.substring(0, 120)}...`);
          });
        }
      }
    }
  }

  showErrors() {
    console.log('\n⚠️ ERRORS AND WARNINGS ONLY:');
    console.log('='.repeat(60));
    
    this.errors.forEach(error => {
      console.log(`${error.timestamp}: ${error.line}`);
    });
  }

  showDetailedPipelineAnalysis() {
    console.log(`\n🔬 DETAILED PIPELINE ANALYSIS:`);
    console.log('─'.repeat(50));
    
    for (const [externalJobID, jobRun] of this.jobRuns) {
      if (TARGET_JOB_ID && !externalJobID.includes(TARGET_JOB_ID)) continue;
      
      console.log(`\n🔧 ${jobRun.jobName}:`);
      
      jobRun.pipelineRuns.forEach((run, idx) => {
        console.log(`\n  Pipeline Run ${idx + 1} (${run.executionID.substring(0, 8)}...):`);
        console.log(`    Status: ${run.fatal ? '❌ FATAL ERROR' : '✅ SUCCESS'}`);
        console.log(`    Timestamp: ${run.timestamp}`);
        
        if (run.errors.length > 0) {
          console.log(`    Errors:`);
          run.errors.forEach(error => {
            console.log(`      • ${error}`);
          });
        }
      });
    }
  }

  generateDiagnosis() {
    console.log(`\n🩺 DIAGNOSIS AND RECOMMENDATIONS:`);
    console.log('='.repeat(50));
    
    const issues = [];
    const insights = [];
    
    // Check job execution
    const totalJobs = this.jobRuns.size;
    const jobsWithRequests = Array.from(this.jobRuns.values()).filter(job => job.requests.length > 0).length;
    const jobsWithPipelineRuns = Array.from(this.jobRuns.values()).filter(job => job.pipelineRuns.length > 0).length;
    const jobsWithErrors = Array.from(this.jobRuns.values()).filter(job => 
      job.pipelineRuns.some(run => run.fatal || run.errors.length > 0)
    ).length;
    
    console.log(`📊 STATISTICS:`);
    console.log(`   Jobs tracked: ${totalJobs}`);
    console.log(`   Jobs with requests: ${jobsWithRequests}`);
    console.log(`   Jobs with pipeline runs: ${jobsWithPipelineRuns}`);
    console.log(`   Jobs with errors: ${jobsWithErrors}`);
    console.log(`   Bridge calls: ${this.bridgeCalls.length}`);
    console.log(`   Transactions: ${this.transactions.length}`);
    console.log(`   Total errors: ${this.errors.length}`);
    
    // Analyze patterns
    if (jobsWithRequests > 0 && jobsWithPipelineRuns === 0) {
      issues.push('🚨 CRITICAL: Jobs receive requests but no pipeline execution');
    }
    
    if (jobsWithPipelineRuns > 0 && jobsWithErrors === jobsWithPipelineRuns) {
      issues.push('🚨 CRITICAL: All pipeline runs are failing');
    }
    
    if (this.bridgeCalls.length === 0) {
      issues.push('⚠️ No bridge calls detected - external adapter not being called');
    }
    
    if (this.transactions.length === 0) {
      issues.push('⚠️ No transaction submissions detected - responses not reaching blockchain');
    }
    
    // Check for specific error patterns
    const eofErrors = this.errors.filter(e => e.line.includes('EOF')).length;
    const timeoutErrors = this.errors.filter(e => e.line.includes('timeout') || e.line.includes('context canceled')).length;
    const gasErrors = this.errors.filter(e => e.line.includes('gas') || e.line.includes('insufficient')).length;
    
    if (eofErrors > 0) {
      issues.push(`⚠️ ${eofErrors} EOF errors detected - connection issues with external adapter`);
    }
    
    if (timeoutErrors > 0) {
      issues.push(`⚠️ ${timeoutErrors} timeout/cancellation errors - network or timing issues`);
    }
    
    if (gasErrors > 0) {
      issues.push(`⚠️ ${gasErrors} gas-related errors - insufficient gas or gas estimation failures`);
    }
    
    // Print results
    if (issues.length > 0) {
      console.log(`\n🚨 ISSUES IDENTIFIED:`);
      issues.forEach(issue => console.log(`  ${issue}`));
    }
    
    if (insights.length > 0) {
      console.log(`\n✅ POSITIVE FINDINGS:`);
      insights.forEach(insight => console.log(`  ${insight}`));
    }
    
    // Provide specific recommendations
    this.provideRecommendations(issues);
  }

  provideRecommendations(issues) {
    console.log(`\n💡 RECOMMENDATIONS:`);
    console.log('─'.repeat(30));
    
    if (issues.some(i => i.includes('pipeline execution'))) {
      console.log('🔧 1. Check job configuration - jobs may not be properly loaded');
    }
    
    if (issues.some(i => i.includes('All pipeline runs are failing'))) {
      console.log('🔧 2. Check bridge configuration and external adapter connectivity');
    }
    
    if (issues.some(i => i.includes('EOF errors'))) {
      console.log('🔧 3. Check external adapter binding and network connectivity');
      console.log('   - Verify external adapter is listening on all interfaces');
      console.log('   - Test: docker exec chainlink curl -f http://147.93.187.143:8080/health');
    }
    
    if (issues.some(i => i.includes('timeout'))) {
      console.log('🔧 4. Increase timeouts in job specifications');
      console.log('   - Verify maxTaskDuration is set to 300s');
      console.log('   - Check bridge timeout configuration');
    }
    
    if (issues.some(i => i.includes('No transaction submissions'))) {
      console.log('🔧 5. Check transaction submission pipeline');
      console.log('   - Verify gas limits and ETH balances');
      console.log('   - Check contract address configuration');
    }
  }
}

// Main execution
async function main() {
  console.log('🚀 Starting Chainlink Log Analysis...\n');
  
  try {
    const parser = new ChainlinkLogParser();
    
    console.log(`📥 Fetching logs from container: ${CONTAINER_NAME}`);
    if (SINCE_TIME) {
      console.log(`⏰ Time filter: ${SINCE_TIME}`);
    }
    
    const logData = await parser.parseDockerLogs();
    parser.parseLogs(logData);
    parser.analyze();
    parser.generateDiagnosis();
    
    console.log('\n✅ Analysis complete!');
    
  } catch (error) {
    console.error('❌ Analysis failed:', error.message);
    process.exit(1);
  }
}

// Error handling
process.on('unhandledRejection', (error) => {
  console.error('❌ Unhandled error:', error.message);
  process.exit(1);
});

main();
