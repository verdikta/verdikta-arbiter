#!/usr/bin/env node

/**
 * Existing Log Timing Parser for Verdikta External Adapter
 * 
 * This script parses existing log format to extract timing data
 * for performance analysis and debugging.
 * 
 * Usage:
 *   node parse-existing-logs.js [log-file] [options]
 * 
 * Options:
 *   --format=json|csv|table    Output format (default: table)
 *   --job-id=<id>             Filter by specific job ID
 *   --mode=<0|1|2>            Filter by specific mode
 *   --min-time=<ms>           Only show operations taking longer than specified time
 *   --output=<file>           Save output to file
 *   --detailed                Show detailed breakdown of operations
 */

const fs = require('fs');

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

class ExistingLogParser {
  constructor() {
    this.jobs = new Map();
    this.patterns = {
      // Extract job info and timing
      ipfsGetArchive: /\[EA\s+([^\s]+)\s+(\d+)\]\s+IPFS getArchive took (\d+)ms/,
      extractArchive: /\[EA\s+([^\s]+)\s+(\d+)\]\s+extractArchive took (\d+)ms/,
      validateManifest: /\[EA\s+([^\s]+)\s+(\d+)\]\s+validateManifest took (\d+)ms/,
      parseManifest: /\[EA\s+([^\s]+)\s+(\d+)\]\s+parseManifest took (\d+)ms/,
      aiClientEvaluate: /\[EA\s+([^\s]+)\s+(\d+)\]\s+aiClient\.evaluate took (\d+)ms/,
      justificationUpload: /\[EA\s+([^\s]+)\s+(\d+)\]\s+justification upload took (\d+)ms/,
      totalTime: /\[EA\s+([^\s]+)\s+(\d+)\]\s+TOTAL time: (\d+)ms/,
      
      // Look for job completion patterns
      returnData: /\[EA\s+([^\s]+)\s+(\d+)\]\s+RETURN/,
      commitReturn: /\[EA\s+([^\s]+)\s+(\d+)\]\s+RETURN commit/
    };
  }

  parseLogFile(filePath) {
    if (!fs.existsSync(filePath)) {
      console.error(`Log file not found: ${filePath}`);
      process.exit(1);
    }

    console.log(`Parsing existing log file: ${filePath}`);
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n');

    for (const line of lines) {
      this.parseLine(line);
    }

    return this.getJobsArray();
  }

  parseLine(line) {
    for (const [operation, pattern] of Object.entries(this.patterns)) {
      const match = line.match(pattern);
      if (match) {
        const jobId = match[1];
        const mode = parseInt(match[2]);
        
        if (operation === 'returnData' || operation === 'commitReturn') {
          this.markJobComplete(jobId, mode);
        } else {
          const timing = parseInt(match[3]);
          this.addJobTiming(jobId, mode, operation, timing);
        }
        break;
      }
    }
  }

  addJobTiming(jobId, mode, operation, timing) {
    const key = `${jobId}_${mode}`;
    
    if (!this.jobs.has(key)) {
      this.jobs.set(key, {
        jobId: jobId.substring(0, 8) + '...', // Shorten for display
        fullJobId: jobId,
        mode,
        timings: {},
        totalTime: 0,
        completed: false
      });
    }

    const job = this.jobs.get(key);
    job.timings[operation] = timing;

    // Calculate estimated total time from components
    if (operation === 'aiClientEvaluate') {
      job.aiClientTime = timing;
    }
    
    this.updateTotalTime(job);
  }

  markJobComplete(jobId, mode) {
    const key = `${jobId}_${mode}`;
    if (this.jobs.has(key)) {
      this.jobs.get(key).completed = true;
    }
  }

  updateTotalTime(job) {
    // Estimate total time from major components
    const ipfsTime = job.timings.ipfsGetArchive || 0;
    const extractTime = job.timings.extractArchive || 0;
    const validateTime = job.timings.validateManifest || 0;
    const parseTime = job.timings.parseManifest || 0;
    const aiTime = job.timings.aiClientEvaluate || 0;
    const justificationTime = job.timings.justificationUpload || 0;
    
    job.totalTime = job.timings.totalTime || (ipfsTime + extractTime + validateTime + parseTime + aiTime + justificationTime);
  }

  getJobsArray() {
    const jobs = Array.from(this.jobs.values());
    
    // Apply filters
    let filtered = jobs;
    
    if (jobIdFilter) {
      filtered = filtered.filter(job => job.fullJobId.includes(jobIdFilter));
    }
    
    if (modeFilter !== undefined) {
      filtered = filtered.filter(job => job.mode === parseInt(modeFilter));
    }
    
    if (minTimeFilter > 0) {
      filtered = filtered.filter(job => {
        const maxTime = Math.max(job.totalTime, job.aiClientTime || 0);
        return maxTime >= minTimeFilter;
      });
    }

    return filtered.sort((a, b) => {
      const aMax = Math.max(a.totalTime, a.aiClientTime || 0);
      const bMax = Math.max(b.totalTime, b.aiClientTime || 0);
      return bMax - aMax;
    });
  }

  formatAsTable(jobs) {
    if (jobs.length === 0) {
      return 'No jobs found matching the criteria.';
    }

    console.log('\n=== Timing Analysis Summary ===');
    console.log('Job ID'.padEnd(12) + 'Mode'.padEnd(6) + 'AI Client'.padEnd(12) + 'IPFS'.padEnd(10) + 'Extract'.padEnd(10) + 'Total Est.'.padEnd(12) + 'Status');
    console.log('─'.repeat(80));

    for (const job of jobs) {
      const aiTime = job.timings.aiClientEvaluate || 0;
      const ipfsTime = job.timings.ipfsGetArchive || 0;
      const extractTime = job.timings.extractArchive || 0;
      const statusIcon = job.completed ? '✓' : '⋯';
      
      console.log(
        job.jobId.padEnd(12) +
        job.mode.toString().padEnd(6) +
        `${aiTime}ms`.padEnd(12) +
        `${ipfsTime}ms`.padEnd(10) +
        `${extractTime}ms`.padEnd(10) +
        `${job.totalTime}ms`.padEnd(12) +
        statusIcon
      );
    }

    if (showDetailed) {
      console.log('\n=== Detailed Breakdown ===');
      for (const job of jobs.slice(0, 10)) { // Show top 10 detailed
        this.printDetailedJob(job);
      }
    }

    // Summary statistics
    const aiTimes = jobs.map(j => j.timings.aiClientEvaluate).filter(t => t > 0);
    if (aiTimes.length > 0) {
      const avgAiTime = aiTimes.reduce((a, b) => a + b, 0) / aiTimes.length;
      const maxAiTime = Math.max(...aiTimes);
      const minAiTime = Math.min(...aiTimes);
      
      console.log('\n=== AI Client Performance Summary ===');
      console.log(`Jobs analyzed: ${aiTimes.length}`);
      console.log(`Average AI Client time: ${Math.round(avgAiTime)}ms`);
      console.log(`Min AI Client time: ${minAiTime}ms`);
      console.log(`Max AI Client time: ${maxAiTime}ms`);
      console.log(`Jobs over 30s: ${aiTimes.filter(t => t > 30000).length}`);
      console.log(`Jobs over 60s: ${aiTimes.filter(t => t > 60000).length}`);
    }
  }

  printDetailedJob(job) {
    console.log(`\nJob ${job.jobId} (Mode ${job.mode})`);
    console.log('─'.repeat(40));
    
    const operations = [
      ['IPFS Retrieval', 'ipfsGetArchive'],
      ['Archive Extraction', 'extractArchive'],
      ['Manifest Validation', 'validateManifest'],
      ['Manifest Parsing', 'parseManifest'],
      ['AI Client Evaluate', 'aiClientEvaluate'],
      ['Justification Upload', 'justificationUpload']
    ];

    let total = 0;
    for (const [label, key] of operations) {
      if (job.timings[key]) {
        console.log(`  ${label.padEnd(20)}: ${job.timings[key]}ms`);
        total += job.timings[key];
      }
    }
    console.log(`  ${'TOTAL MEASURED'.padEnd(20)}: ${total}ms`);
    
    if (job.aiClientTime && job.aiClientTime > 30000) {
      console.log(`  ⚠️  AI Client time is very high (${job.aiClientTime}ms)`);
    }
  }

  formatAsJSON(jobs) {
    return JSON.stringify(jobs, null, 2);
  }

  formatAsCSV(jobs) {
    if (jobs.length === 0) return 'No data';

    const headers = ['jobId', 'fullJobId', 'mode', 'completed', 'aiClientEvaluate', 'ipfsGetArchive', 'extractArchive', 'validateManifest', 'parseManifest', 'justificationUpload', 'totalTime'];
    const csvLines = [headers.join(',')];

    for (const job of jobs) {
      const row = [
        job.jobId,
        job.fullJobId,
        job.mode,
        job.completed,
        job.timings.aiClientEvaluate || '',
        job.timings.ipfsGetArchive || '',
        job.timings.extractArchive || '',
        job.timings.validateManifest || '',
        job.timings.parseManifest || '',
        job.timings.justificationUpload || '',
        job.totalTime
      ];
      csvLines.push(row.join(','));
    }

    return csvLines.join('\n');
  }
}

// Main execution
function main() {
  const parser = new ExistingLogParser();
  const jobs = parser.parseLogFile(logFile);

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
Usage: node parse-existing-logs.js [log-file] [options]

Options:
  --format=json|csv|table    Output format (default: table)
  --job-id=<id>             Filter by job ID substring
  --mode=<0|1|2>            Filter by specific mode (0=standard, 1=commit, 2=reveal)
  --min-time=<ms>           Only show operations taking longer than specified time
  --output=<file>           Save output to file
  --detailed                Show detailed breakdown of timing components
  --help, -h                Show this help message

Examples:
  # Show all jobs in table format
  node parse-existing-logs.js /path/to/adapter.log

  # Show jobs with AI client time over 30 seconds
  node parse-existing-logs.js /path/to/adapter.log --min-time=30000 --detailed

  # Export timing data to CSV
  node parse-existing-logs.js /path/to/adapter.log --format=csv --output=timing-data.csv

  # Analyze specific job
  node parse-existing-logs.js /path/to/adapter.log --job-id=0x304b --detailed
`);
  process.exit(0);
}

main();