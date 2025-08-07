#!/usr/bin/env node

/**
 * Log Timing Parser for Verdikta External Adapter
 * 
 * This script parses log files from the external adapter to extract timing data
 * for performance analysis and debugging.
 * 
 * Usage:
 *   node scripts/parse-timing-logs.js [log-file] [options]
 * 
 * Options:
 *   --format=json|csv|table    Output format (default: table)
 *   --job-id=<id>             Filter by specific job ID
 *   --mode=<0|1|2>            Filter by specific mode
 *   --min-time=<ms>           Only show jobs taking longer than specified time
 *   --output=<file>           Save output to file
 *   --detailed                Show detailed breakdown of all timing components
 */

const fs = require('fs');
const path = require('path');

// Parse command line arguments
const args = process.argv.slice(2);
const logFile = args[0] || '/var/log/verdikta-external-adapter.log';
const options = {};

args.slice(1).forEach(arg => {
  if (arg.startsWith('--')) {
    const [key, value] = arg.slice(2).split('=');
    options[key] = value || true;
  }
});

// Default options
const format = options.format || 'table';
const jobIdFilter = options['job-id'];
const modeFilter = options.mode;
const minTimeFilter = options['min-time'] ? parseInt(options['min-time']) : 0;
const outputFile = options.output;
const showDetailed = options.detailed;
const showTimeouts = options.timeouts;
const chainlinkTimeout = options['chainlink-timeout'] ? parseInt(options['chainlink-timeout']) : 95000; // 95 seconds default

class TimingLogParser {
  constructor() {
    this.jobs = new Map();
    this.patterns = {
      // Helper function to strip ANSI color codes
      stripAnsi: (str) => str.replace(/\x1b\[[0-9;]*m/g, ''),
      
      // Job start pattern - updated to handle ANSI codes and info: prefix
      jobStart: /\[EA\s+([^\s]+)\s+(\d+)\]/,
      
      // Timing patterns based on actual log format with info: prefix
      ipfsGetArchive: /\[EA\s+([^\s]+)\s+(\d+)\]\s+IPFS getArchive took (\d+)ms/,
      extractArchive: /\[EA\s+([^\s]+)\s+(\d+)\]\s+extractArchive took (\d+)ms/,
      validateManifest: /\[EA\s+([^\s]+)\s+(\d+)\]\s+validateManifest took (\d+)ms/,
      validateManifestAll: /\[EA\s+([^\s]+)\s+(\d+)\]\s+validateManifest \(all\) took (\d+)ms/,
      manifestParserParse: /\[EA\s+([^\s]+)\s+(\d+)\]\s+manifestParser\.parse took (\d+)ms/,
      parseMultipleManifests: /\[EA\s+([^\s]+)\s+(\d+)\]\s+parseMultipleManifests took (\d+)ms/,
      processMultipleCIDs: /\[EA\s+([^\s]+)\s+(\d+)\]\s+processMultipleCIDs took (\d+)ms/,
      constructCombinedQuery: /\[EA\s+([^\s]+)\s+(\d+)\]\s+constructCombinedQuery took (\d+)ms/,
      aiClientEvaluate: /\[EA\s+([^\s]+)\s+(\d+)\]\s+aiClient\.evaluate took (\d+)ms/,
      aiClientEvaluateMulti: /\[EA\s+([^\s]+)\s+(\d+)\]\s+aiClient\.evaluate \(multi-CID\) took (\d+)ms/,
      createAndUploadJustification: /\[EA\s+([^\s]+)\s+(\d+)\]\s+createAndUploadJustification took (\d+)ms/,
      createAndUploadJustificationMulti: /\[EA\s+([^\s]+)\s+(\d+)\]\s+createAndUploadJustification \(multi-CID\) took (\d+)ms/,
      
      // AI Client internal timing
      manifestRead: /\[EA\s+([^\s]+)\s+(\d+)\]\s+Manifest read took (\d+)ms/,
      additionalFilesProcessing: /\[EA\s+([^\s]+)\s+(\d+)\]\s+Additional files processing took (\d+)ms/,
      supportFilesProcessing: /\[EA\s+([^\s]+)\s+(\d+)\]\s+Support files processing took (\d+)ms/,
      payloadConstruction: /\[EA\s+([^\s]+)\s+(\d+)\]\s+Payload construction took (\d+)ms/,
      apiCallRankAndJustify: /\[EA\s+([^\s]+)\s+(\d+)\]\s+API call to \/api\/rank-and-justify took (\d+)ms/,
      responseTransformation: /\[EA\s+([^\s]+)\s+(\d+)\]\s+Response transformation took (\d+)ms/,
      totalAiClientEvaluate: /\[EA\s+([^\s]+)\s+(\d+)\]\s+Total aiClient\.evaluate took (\d+)ms \(attempt \d+\)/,
      
      // Mode-specific operations
      mode2RevealTook: /\[EA\s+([^\s]+)\s+(\d+)\]\s+Mode 2 reveal took (\d+)ms/,
      mode2RevealJustificationUpload: /Mode 2 reveal justification upload took (\d+)ms/,
      
      // IPFS operations
      ipfsJustificationUpload: /IPFS justification upload took (\d+)ms/,
      ipfsErrorJustificationUpload: /IPFS error justification upload took (\d+)ms/,
      
      // Total times
      totalExecutionTime: /\[EA\s+([^\s]+)\s+(\d+)\]\s+TOTAL execution time: (\d+)ms/,
      
      // Error timing
      aiNodeError: /\[EA\s+([^\s]+)\s+(\d+)\]\s+AI Node error after (\d+)ms/
    };
  }

  parseLogFile(filePath, format = 'table') {
    if (!fs.existsSync(filePath)) {
      console.error(`Log file not found: ${filePath}`);
      process.exit(1);
    }

    if (format !== 'json') {
      console.log(`Parsing log file: ${filePath}`);
    }
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n');

    for (const line of lines) {
      this.parseLine(line);
    }

    return this.getJobsArray();
  }

  parseLine(line) {
    // Strip ANSI color codes first
    const cleanLine = line.replace(/\x1b\[[0-9;]*m/g, '');
    
    // Extract job information from each line
    for (const [name, pattern] of Object.entries(this.patterns)) {
      if (name === 'stripAnsi') continue; // Skip the helper function
      
      const match = cleanLine.match(pattern);
      if (match) {
        let jobId, mode, timing;
        
        // Handle patterns that don't have job ID/mode (IPFS operations without EA tag)
        if (name === 'mode2RevealJustificationUpload' || 
            name === 'ipfsJustificationUpload' || 
            name === 'ipfsErrorJustificationUpload') {
          // Extract job info from earlier in the line or context
          const eaMatch = cleanLine.match(/\[EA\s+([^\s]+)\s+(\d+)\]/);
          if (eaMatch) {
            jobId = eaMatch[1];
            mode = eaMatch[2];
            timing = parseInt(match[1]);
          } else {
            // Skip if we can't find EA context
            continue;
          }
        } else {
          jobId = match[1];
          mode = match[2];
          timing = this.extractTiming(match, name);
        }
        this.addJobTiming(jobId, mode, name, timing, cleanLine);
        // Note: Don't break here - let other patterns match the same line if needed
      }
    }
  }

  extractTiming(match, patternName) {
    switch (patternName) {
      case 'totalAiClientEvaluate':
        return parseInt(match[3]); // Skip the attempt number part
      case 'totalExecutionTime':
        return parseInt(match[3]);
      default:
        return parseInt(match[3]);
    }
  }

  addJobTiming(jobId, mode, operation, timing, originalLine) {
    // For timeout analysis, we need to track each individual execution
    // Instead of aggregating by jobId_mode, create unique entries for each execution
    if (operation === 'totalExecutionTime') {
      const executionKey = `${jobId}_${mode}_${Date.now()}_${Math.random()}`;
      this.jobs.set(executionKey, {
        jobId,
        mode: parseInt(mode),
        timings: { [operation]: timing },
        totalTime: timing,
        startTime: null,
        endTime: null,
        logLines: [originalLine]
      });
      return;
    }

    // For other timing operations, still use the aggregated approach
    const key = `${jobId}_${mode}`;
    
    if (!this.jobs.has(key)) {
      this.jobs.set(key, {
        jobId,
        mode: parseInt(mode),
        timings: {},
        totalTime: 0,
        startTime: null,
        endTime: null
      });
    }

    const job = this.jobs.get(key);
    job.timings[operation] = timing;

    // Store the original log line for reference
    if (!job.logLines) {
      job.logLines = [];
    }
    job.logLines.push(originalLine);
  }

  getJobsArray() {
    const jobs = Array.from(this.jobs.values());
    
    // Apply filters
    let filtered = jobs;
    
    if (jobIdFilter) {
      filtered = filtered.filter(job => job.jobId === jobIdFilter);
    }
    
    if (modeFilter !== undefined) {
      filtered = filtered.filter(job => job.mode === parseInt(modeFilter));
    }
    
    if (minTimeFilter > 0) {
      filtered = filtered.filter(job => job.totalTime >= minTimeFilter);
    }

    return filtered.sort((a, b) => b.totalTime - a.totalTime);
  }

  formatAsTable(jobs) {
    if (jobs.length === 0) {
      return 'No jobs found matching the criteria.';
    }

    // Check for timeout analysis
    if (showTimeouts) {
      this.printTimeoutAnalysis(jobs);
      return;
    }

    console.log('\n=== Timing Analysis Summary ===');
    console.log('Job ID'.padEnd(20) + 'Mode'.padEnd(6) + 'Total Time'.padEnd(12) + 'AI Client'.padEnd(12) + 'Archive'.padEnd(10) + 'Status');
    console.log('─'.repeat(70));

    for (const job of jobs) {
      const aiTime = job.timings.totalAiClientEvaluate || job.timings.aiClientEvaluate || job.timings.aiClientEvaluateMulti || 0;
      const archiveTime = (job.timings.ipfsGetArchive || 0) + (job.timings.extractArchive || 0);
      
      console.log(
        job.jobId.padEnd(20) +
        job.mode.toString().padEnd(6) +
        `${job.totalTime}ms`.padEnd(12) +
        `${aiTime}ms`.padEnd(12) +
        `${archiveTime}ms`.padEnd(10) +
        this.getJobStatus(job)
      );
    }

    if (showDetailed) {
      console.log('\n=== Detailed Breakdown ===');
      for (const job of jobs) {
        this.printDetailedJob(job);
      }
    }
  }

  printDetailedJob(job) {
    console.log(`\nJob ${job.jobId} (Mode ${job.mode}) - Total: ${job.totalTime}ms`);
    console.log('─'.repeat(50));
    
    const categories = {
      'Archive Operations': ['ipfsGetArchive', 'extractArchive', 'processMultipleCIDs'],
      'Manifest Processing': ['validateManifest', 'validateManifestAll', 'manifestParserParse', 'parseMultipleManifests', 'manifestRead'],
      'Query Processing': ['constructCombinedQuery', 'additionalFilesProcessing', 'supportFilesProcessing'],
      'AI Client': ['payloadConstruction', 'apiCallRankAndJustify', 'responseTransformation', 'totalAiClientEvaluate', 'aiClientEvaluate', 'aiClientEvaluateMulti'],
      'IPFS Operations': ['createAndUploadJustification', 'createAndUploadJustificationMulti', 'ipfsJustificationUpload', 'ipfsErrorJustificationUpload'],
      'Mode Operations': ['mode2RevealTook', 'mode2RevealJustificationUpload'],
      'Total Times': ['totalExecutionTime'],
      'Errors': ['aiNodeError']
    };

    for (const [category, operations] of Object.entries(categories)) {
      const categoryTimings = operations.filter(op => job.timings[op]).map(op => ({
        operation: op,
        time: job.timings[op]
      }));

      if (categoryTimings.length > 0) {
        console.log(`  ${category}:`);
        for (const { operation, time } of categoryTimings) {
          console.log(`    ${operation.padEnd(20)}: ${time}ms`);
        }
      }
    }
  }

  getJobStatus(job) {
    if (job.timings.aiNodeError) return 'ERROR';
    if (job.totalTime > chainlinkTimeout) return 'TIMEOUT';
    if (job.mode === 1) return 'COMMIT';
    if (job.mode === 2) return 'REVEAL';
    return 'COMPLETE';
  }

  printTimeoutAnalysis(jobs) {
    const timeoutJobs = jobs.filter(job => job.totalTime > chainlinkTimeout);
    const nearTimeoutJobs = jobs.filter(job => job.totalTime > chainlinkTimeout * 0.8 && job.totalTime <= chainlinkTimeout);
    const warningJobs = jobs.filter(job => job.totalTime > chainlinkTimeout * 0.6 && job.totalTime <= chainlinkTimeout * 0.8);
    const totalJobs = jobs.length;
    
    console.log('\n🚨 CHAINLINK TIMEOUT ANALYSIS');
    console.log('='.repeat(60));
    console.log(`Chainlink Timeout Threshold: ${chainlinkTimeout}ms (${chainlinkTimeout/1000}s)`);
    console.log(`Total Jobs Analyzed: ${totalJobs}`);
    console.log(`Jobs Exceeding Timeout: ${timeoutJobs.length} (${((timeoutJobs.length/totalJobs)*100).toFixed(1)}%)`);
    console.log(`Jobs at High Risk (80-100%): ${nearTimeoutJobs.length} (${((nearTimeoutJobs.length/totalJobs)*100).toFixed(1)}%)`);
    console.log(`Jobs at Medium Risk (60-80%): ${warningJobs.length} (${((warningJobs.length/totalJobs)*100).toFixed(1)}%)`);
    
    if (timeoutJobs.length === 0 && nearTimeoutJobs.length === 0) {
      console.log('\n✅ No jobs exceeded the timeout threshold or are at high risk!');
      if (warningJobs.length > 0) {
        console.log(`⚠️  However, ${warningJobs.length} jobs are at medium risk (60-80% of timeout)`);
      }
      return;
    }
    
    if (timeoutJobs.length === 0) {
      console.log('\n⚠️  No jobs exceeded timeout, but some are at HIGH RISK!');
    }

    // Show high-risk and timeout jobs
    const allRiskyJobs = [...timeoutJobs, ...nearTimeoutJobs].sort((a, b) => b.totalTime - a.totalTime);
    
    console.log('\n📊 HIGH RISK & TIMEOUT JOBS SUMMARY');
    console.log('-'.repeat(75));
    console.log('Job ID'.padEnd(20) + 'Mode'.padEnd(6) + 'Total Time'.padEnd(15) + 'Risk Level'.padEnd(15) + 'Threshold %'.padEnd(12) + 'Status');
    console.log('─'.repeat(75));

    for (const job of allRiskyJobs) {
      const pctOfTimeout = ((job.totalTime / chainlinkTimeout) * 100).toFixed(1);
      let riskLevel;
      if (job.totalTime > chainlinkTimeout) riskLevel = 'TIMEOUT';
      else if (job.totalTime > chainlinkTimeout * 0.8) riskLevel = 'HIGH RISK';
      else riskLevel = 'MEDIUM RISK';
      
      console.log(
        job.jobId.substring(0, 18).padEnd(20) +
        job.mode.toString().padEnd(6) +
        `${job.totalTime}ms`.padEnd(15) +
        riskLevel.padEnd(15) +
        `${pctOfTimeout}%`.padEnd(12) +
        this.getJobStatus(job)
      );
    }

    // Legacy timeout job processing for detailed breakdown
    const sortedTimeoutJobs = timeoutJobs.sort((a, b) => b.totalTime - a.totalTime);
    
    for (const job of sortedTimeoutJobs) {
      const exceedBy = job.totalTime - chainlinkTimeout;
      console.log(
        job.jobId.substring(0, 18).padEnd(20) +
        job.mode.toString().padEnd(6) +
        `${job.totalTime}ms`.padEnd(15) +
        `+${exceedBy}ms`.padEnd(12) +
        this.getJobStatus(job)
      );
    }

    // Show detailed breakdown for the worst cases (timeout + high risk)
    const top5Cases = allRiskyJobs.slice(0, 5);
    if (top5Cases.length > 0) {
      console.log('\n🔍 DETAILED BREAKDOWN - TOP 5 WORST CASES');
      console.log('='.repeat(60));
      
      for (let i = 0; i < top5Cases.length; i++) {
        const job = top5Cases[i];
        const pctOfTimeout = ((job.totalTime / chainlinkTimeout) * 100).toFixed(1);
        let riskDesc;
        if (job.totalTime > chainlinkTimeout) {
          const exceedBy = job.totalTime - chainlinkTimeout;
          riskDesc = `TIMEOUT - Exceeded by ${exceedBy}ms (${(exceedBy/1000).toFixed(1)}s)`;
        } else {
          const marginMs = chainlinkTimeout - job.totalTime;
          riskDesc = `HIGH RISK - Only ${marginMs}ms (${(marginMs/1000).toFixed(1)}s) under timeout`;
        }
        
        console.log(`\n${i + 1}. Job ${job.jobId} (Mode ${job.mode})`);
        console.log(`   Total Time: ${job.totalTime}ms (${(job.totalTime/1000).toFixed(1)}s)`);
        console.log(`   Risk Level: ${riskDesc}`);
        console.log(`   Timeout Percentage: ${pctOfTimeout}%`);
        console.log('   ─'.repeat(55));
        
        this.printDetailedTimingBreakdown(job);
      }
    }

    // Statistics
    console.log('\n📈 TIMEOUT STATISTICS');
    console.log('-'.repeat(60));
    const timeoutTimes = timeoutJobs.map(job => job.totalTime);
    const avgTimeout = timeoutTimes.reduce((sum, time) => sum + time, 0) / timeoutTimes.length;
    const maxTimeout = Math.max(...timeoutTimes);
    const minTimeout = Math.min(...timeoutTimes);
    
    console.log(`Average timeout job time: ${Math.round(avgTimeout)}ms (${(avgTimeout/1000).toFixed(1)}s)`);
    console.log(`Longest timeout job: ${maxTimeout}ms (${(maxTimeout/1000).toFixed(1)}s)`);
    console.log(`Shortest timeout job: ${minTimeout}ms (${(minTimeout/1000).toFixed(1)}s)`);
    console.log(`Average exceed amount: ${Math.round(avgTimeout - chainlinkTimeout)}ms`);
  }

  printDetailedTimingBreakdown(job) {
    const operations = [
      { name: 'IPFS Archive Retrieval', key: 'ipfsGetArchive' },
      { name: 'Archive Extraction', key: 'extractArchive' },
      { name: 'Manifest Validation', key: 'validateManifest' },
      { name: 'Manifest Parsing', key: 'manifestParserParse' },
      { name: 'AI Client - Manifest Read', key: 'manifestRead' },
      { name: 'AI Client - Additional Files', key: 'additionalFilesProcessing' },
      { name: 'AI Client - Support Files', key: 'supportFilesProcessing' },
      { name: 'AI Client - Payload Construction', key: 'payloadConstruction' },
      { name: 'AI Client - API Call', key: 'apiCallRankAndJustify' },
      { name: 'AI Client - Response Transform', key: 'responseTransformation' },
      { name: 'AI Client - Total Evaluate', key: 'totalAiClientEvaluate' },
      { name: 'Justification Upload', key: 'createAndUploadJustification' },
      { name: 'Multi-CID Processing', key: 'processMultipleCIDs' },
      { name: 'Combined Query Construction', key: 'constructCombinedQuery' }
    ];

    let totalAccounted = 0;
    const breakdown = [];

    for (const op of operations) {
      if (job.timings[op.key]) {
        const time = job.timings[op.key];
        const percentage = ((time / job.totalTime) * 100).toFixed(1);
        breakdown.push({ name: op.name, time, percentage });
        totalAccounted += time;
      }
    }

    // Sort by time (largest first)
    breakdown.sort((a, b) => b.time - a.time);

    // Show only significant operations (> 1% of total time or > 100ms)
    const significantOps = breakdown.filter(op => op.time > 100 || parseFloat(op.percentage) > 1);

    for (const op of significantOps) {
      const bar = '█'.repeat(Math.min(Math.round(parseFloat(op.percentage) / 2), 30));
      console.log(`   ${op.name.padEnd(25)}: ${op.time.toString().padStart(6)}ms (${op.percentage.padStart(5)}%) ${bar}`);
    }

    const unaccounted = job.totalTime - totalAccounted;
    if (unaccounted > 100) {
      const unaccountedPct = ((unaccounted / job.totalTime) * 100).toFixed(1);
      console.log(`   ${'Other/Unaccounted'.padEnd(25)}: ${unaccounted.toString().padStart(6)}ms (${unaccountedPct.padStart(5)}%)`);
    }
  }

  formatAsJSON(jobs) {
    return JSON.stringify(jobs, null, 2);
  }

  formatAsCSV(jobs) {
    if (jobs.length === 0) return 'No data';

    // Get all unique timing operations
    const allOperations = new Set();
    jobs.forEach(job => {
      Object.keys(job.timings).forEach(op => allOperations.add(op));
    });

    const headers = ['jobId', 'mode', 'totalTime', ...Array.from(allOperations).sort()];
    const csvLines = [headers.join(',')];

    for (const job of jobs) {
      const row = [
        job.jobId,
        job.mode,
        job.totalTime,
        ...headers.slice(3).map(op => job.timings[op] || '')
      ];
      csvLines.push(row.join(','));
    }

    return csvLines.join('\n');
  }
}

// Main execution
function main() {
  const parser = new TimingLogParser();
  const jobs = parser.parseLogFile(logFile, format);

  let output;
  switch (format) {
    case 'json':
      output = parser.formatAsJSON(jobs);
      break;
    case 'csv':
      output = parser.formatAsCSV(jobs);
      break;
    case 'table':
    default:
      parser.formatAsTable(jobs);
      return; // Table format prints directly
  }

  if (outputFile) {
    fs.writeFileSync(outputFile, output);
    console.log(`Output saved to: ${outputFile}`);
  } else {
    console.log(output);
  }
}

// Help text
if (args.includes('--help') || args.includes('-h')) {
  console.log(`
Usage: node scripts/parse-timing-logs.js [log-file] [options]

Options:
  --format=json|csv|table    Output format (default: table)
  --job-id=<id>             Filter by specific job ID
  --mode=<0|1|2>            Filter by specific mode (0=standard, 1=commit, 2=reveal)
  --min-time=<ms>           Only show jobs taking longer than specified time
  --output=<file>           Save output to file
  --detailed                Show detailed breakdown of all timing components
  --timeouts                Show Chainlink timeout analysis (95s default)
  --chainlink-timeout=<ms>  Set custom timeout threshold (default: 95000ms)
  --help, -h                Show this help message

Examples:
  # Show all jobs in table format
  node scripts/parse-timing-logs.js

  # Show jobs taking longer than 5 seconds
  node scripts/parse-timing-logs.js --min-time=5000 --detailed

  # Analyze Chainlink timeout violations
  node scripts/parse-timing-logs.js --timeouts

  # Custom timeout threshold (60 seconds)
  node scripts/parse-timing-logs.js --timeouts --chainlink-timeout=60000

  # Export all timing data to CSV
  node scripts/parse-timing-logs.js --format=csv --output=timing-data.csv

  # Analyze specific job
  node scripts/parse-timing-logs.js --job-id=123 --detailed

  # Show only commit operations (mode 1)
  node scripts/parse-timing-logs.js --mode=1
`);
  process.exit(0);
}

main();