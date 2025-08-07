#!/usr/bin/env node

/**
 * Timing Analysis Script for Verdikta External Adapter
 * 
 * This script processes timing data to generate statistical insights and identify
 * performance bottlenecks in the external adapter.
 * 
 * Usage:
 *   node scripts/analyze-timing.js [log-file] [options]
 * 
 * Options:
 *   --percentiles=50,90,95,99  Calculate specific percentiles (default: 50,90,95,99)
 *   --group-by=mode|hour|day   Group analysis by mode, hour, or day
 *   --threshold=<ms>           Highlight operations above threshold
 *   --chart                    Generate simple ASCII charts
 *   --output=<file>            Save analysis to file
 *   --format=text|json         Output format (default: text)
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
const percentiles = options.percentiles ? options.percentiles.split(',').map(Number) : [50, 90, 95, 99];
const groupBy = options['group-by'] || 'mode';
const threshold = options.threshold ? parseInt(options.threshold) : 10000; // 10 seconds default
const showCharts = options.chart;
const outputFile = options.output;
const format = options.format || 'text';
const chainlinkTimeout = options['chainlink-timeout'] ? parseInt(options['chainlink-timeout']) : 95000; // 95 seconds default
const showTimeouts = options.timeouts;

class TimingAnalyzer {
  constructor() {
    this.jobs = [];
    this.stats = {};
  }

  loadTimingData(logFile) {
    // Use the parser script to get timing data
    const { execSync } = require('child_process');
    const parserPath = require('path').join(__dirname, 'parse-timing-logs.js');
    
    try {
      const jsonOutput = execSync(`node "${parserPath}" "${logFile}" --format=json`, { encoding: 'utf8' });
      this.jobs = JSON.parse(jsonOutput);
      console.log(`Loaded ${this.jobs.length} jobs for analysis`);
    } catch (error) {
      console.error('Error loading timing data:', error.message);
      process.exit(1);
    }
  }

  calculateStatistics() {
    if (this.jobs.length === 0) {
      return { error: 'No jobs found' };
    }

    this.stats = {
      overall: this.analyzeJobs(this.jobs),
      byMode: {},
      byTimeRange: {},
      operations: this.analyzeOperations(),
      bottlenecks: this.identifyBottlenecks(),
      outliers: this.findOutliers(),
      timeouts: this.analyzeTimeouts()
    };

    // Group by mode
    for (let mode = 0; mode <= 2; mode++) {
      const modeJobs = this.jobs.filter(job => job.mode === mode);
      if (modeJobs.length > 0) {
        this.stats.byMode[mode] = this.analyzeJobs(modeJobs);
      }
    }

    // Group by time if requested
    if (groupBy === 'hour' || groupBy === 'day') {
      this.stats.byTimeRange = this.groupByTime(groupBy);
    }

    return this.stats;
  }

  analyzeJobs(jobs) {
    const totalTimes = jobs.map(job => job.totalTime).filter(time => time > 0);
    
    if (totalTimes.length === 0) {
      return { count: 0, error: 'No valid timing data' };
    }

    return {
      count: jobs.length,
      min: Math.min(...totalTimes),
      max: Math.max(...totalTimes),
      mean: this.calculateMean(totalTimes),
      median: this.calculatePercentile(totalTimes, 50),
      percentiles: this.calculatePercentiles(totalTimes, percentiles),
      stdDev: this.calculateStdDev(totalTimes),
      aboveThreshold: totalTimes.filter(time => time > threshold).length,
      distribution: this.createDistribution(totalTimes)
    };
  }

  analyzeOperations() {
    const operationStats = {};
    
    // Collect all timing operations
    const allOperations = new Set();
    this.jobs.forEach(job => {
      Object.keys(job.timings).forEach(op => allOperations.add(op));
    });

    for (const operation of allOperations) {
      const times = this.jobs
        .map(job => job.timings[operation])
        .filter(time => time && time > 0);
      
      if (times.length > 0) {
        operationStats[operation] = {
          count: times.length,
          mean: this.calculateMean(times),
          median: this.calculatePercentile(times, 50),
          p95: this.calculatePercentile(times, 95),
          max: Math.max(...times),
          contribution: this.calculateMean(times) / this.stats.overall?.mean || 0
        };
      }
    }

    return operationStats;
  }

  identifyBottlenecks() {
    const bottlenecks = [];
    const operations = this.stats.operations || this.analyzeOperations();

    // Find operations that take significant time
    Object.entries(operations).forEach(([operation, stats]) => {
      if (stats.mean > 1000) { // More than 1 second average
        bottlenecks.push({
          operation,
          avgTime: stats.mean,
          maxTime: stats.max,
          frequency: stats.count,
          severity: this.calculateSeverity(stats)
        });
      }
    });

    return bottlenecks.sort((a, b) => b.severity - a.severity);
  }

  calculateSeverity(operationStats) {
    // Severity = average time * frequency * (how much above normal it is)
    const normalTime = 100; // Consider 100ms as normal
    const timeMultiplier = operationStats.mean / normalTime;
    return operationStats.mean * operationStats.count * Math.max(1, timeMultiplier);
  }

  findOutliers() {
    const totalTimes = this.jobs.map(job => job.totalTime).filter(time => time > 0);
    const q1 = this.calculatePercentile(totalTimes, 25);
    const q3 = this.calculatePercentile(totalTimes, 75);
    const iqr = q3 - q1;
    const lowerBound = q1 - 1.5 * iqr;
    const upperBound = q3 + 1.5 * iqr;

    return this.jobs.filter(job => job.totalTime < lowerBound || job.totalTime > upperBound)
      .sort((a, b) => b.totalTime - a.totalTime);
  }

  analyzeTimeouts() {
    const timeoutJobs = this.jobs.filter(job => job.totalTime > chainlinkTimeout);
    const totalJobs = this.jobs.length;
    
    if (timeoutJobs.length === 0) {
      return {
        count: 0,
        percentage: 0,
        totalJobs,
        threshold: chainlinkTimeout
      };
    }

    const timeoutTimes = timeoutJobs.map(job => job.totalTime);
    const exceedAmounts = timeoutJobs.map(job => job.totalTime - chainlinkTimeout);

    return {
      count: timeoutJobs.length,
      percentage: (timeoutJobs.length / totalJobs) * 100,
      totalJobs,
      threshold: chainlinkTimeout,
      avgTime: this.calculateMean(timeoutTimes),
      maxTime: Math.max(...timeoutTimes),
      minTime: Math.min(...timeoutTimes),
      avgExceed: this.calculateMean(exceedAmounts),
      maxExceed: Math.max(...exceedAmounts),
      minExceed: Math.min(...exceedAmounts),
      jobs: timeoutJobs.sort((a, b) => b.totalTime - a.totalTime)
    };
  }

  groupByTime(interval) {
    // This would require timestamp parsing from logs
    // For now, return empty object
    return {};
  }

  calculateMean(values) {
    return values.reduce((sum, val) => sum + val, 0) / values.length;
  }

  calculatePercentile(values, percentile) {
    const sorted = [...values].sort((a, b) => a - b);
    const index = (percentile / 100) * (sorted.length - 1);
    const lower = Math.floor(index);
    const upper = Math.ceil(index);
    
    if (lower === upper) {
      return sorted[lower];
    }
    
    return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
  }

  calculatePercentiles(values, percentileList) {
    const result = {};
    percentileList.forEach(p => {
      result[`p${p}`] = this.calculatePercentile(values, p);
    });
    return result;
  }

  calculateStdDev(values) {
    const mean = this.calculateMean(values);
    const squaredDiffs = values.map(value => Math.pow(value - mean, 2));
    const avgSquaredDiff = this.calculateMean(squaredDiffs);
    return Math.sqrt(avgSquaredDiff);
  }

  createDistribution(values) {
    const buckets = 10;
    const min = Math.min(...values);
    const max = Math.max(...values);
    const bucketSize = (max - min) / buckets;
    
    const distribution = new Array(buckets).fill(0);
    
    values.forEach(value => {
      const bucketIndex = Math.min(Math.floor((value - min) / bucketSize), buckets - 1);
      distribution[bucketIndex]++;
    });

    return distribution.map((count, index) => ({
      range: `${Math.round(min + index * bucketSize)}-${Math.round(min + (index + 1) * bucketSize)}ms`,
      count
    }));
  }

  generateTextReport() {
    let report = [];
    
    report.push('='.repeat(60));
    report.push('VERDIKTA EXTERNAL ADAPTER TIMING ANALYSIS');
    report.push('='.repeat(60));
    
    // Overall statistics
    if (this.stats.overall) {
      report.push('\n📊 OVERALL PERFORMANCE');
      report.push('-'.repeat(30));
      report.push(`Total Jobs: ${this.stats.overall.count}`);
      report.push(`Mean Time: ${Math.round(this.stats.overall.mean)}ms`);
      report.push(`Median Time: ${Math.round(this.stats.overall.median)}ms`);
      report.push(`Min Time: ${this.stats.overall.min}ms`);
      report.push(`Max Time: ${this.stats.overall.max}ms`);
      report.push(`Standard Deviation: ${Math.round(this.stats.overall.stdDev)}ms`);
      report.push(`Jobs Above ${threshold}ms: ${this.stats.overall.aboveThreshold}`);
      
      // Percentiles
      report.push('\nPercentiles:');
      Object.entries(this.stats.overall.percentiles).forEach(([p, value]) => {
        report.push(`  ${p}: ${Math.round(value)}ms`);
      });
    }

    // By mode analysis
    report.push('\n🎯 PERFORMANCE BY MODE');
    report.push('-'.repeat(30));
    const modeNames = { 0: 'Standard', 1: 'Commit', 2: 'Reveal' };
    
    Object.entries(this.stats.byMode).forEach(([mode, stats]) => {
      report.push(`\n${modeNames[mode]} (Mode ${mode}):`);
      report.push(`  Jobs: ${stats.count}`);
      report.push(`  Mean: ${Math.round(stats.mean)}ms`);
      report.push(`  Median: ${Math.round(stats.median)}ms`);
      report.push(`  P95: ${Math.round(stats.percentiles.p95)}ms`);
    });

    // Bottlenecks
    if (this.stats.bottlenecks.length > 0) {
      report.push('\n🚨 PERFORMANCE BOTTLENECKS');
      report.push('-'.repeat(30));
      
      this.stats.bottlenecks.slice(0, 5).forEach((bottleneck, index) => {
        report.push(`\n${index + 1}. ${bottleneck.operation}`);
        report.push(`   Average Time: ${Math.round(bottleneck.avgTime)}ms`);
        report.push(`   Max Time: ${Math.round(bottleneck.maxTime)}ms`);
        report.push(`   Frequency: ${bottleneck.frequency} jobs`);
        report.push(`   Severity Score: ${Math.round(bottleneck.severity)}`);
      });
    }

    // Top operations by time
    report.push('\n⏱️  TOP OPERATIONS BY AVERAGE TIME');
    report.push('-'.repeat(30));
    
    const sortedOps = Object.entries(this.stats.operations)
      .sort(([,a], [,b]) => b.mean - a.mean)
      .slice(0, 10);
    
    sortedOps.forEach(([operation, stats]) => {
      report.push(`${operation.padEnd(25)}: ${Math.round(stats.mean).toString().padStart(6)}ms (P95: ${Math.round(stats.p95)}ms)`);
    });

    // Chainlink Timeout Analysis
    if (this.stats.timeouts) {
      report.push('\n🚨 CHAINLINK TIMEOUT ANALYSIS');
      report.push('-'.repeat(30));
      report.push(`Timeout Threshold: ${this.stats.timeouts.threshold}ms (${(this.stats.timeouts.threshold/1000).toFixed(1)}s)`);
      report.push(`Jobs Exceeding Timeout: ${this.stats.timeouts.count} of ${this.stats.timeouts.totalJobs} (${this.stats.timeouts.percentage.toFixed(1)}%)`);
      
      if (this.stats.timeouts.count > 0) {
        report.push(`\nTimeout Job Statistics:`);
        report.push(`  Average Time: ${Math.round(this.stats.timeouts.avgTime)}ms (${(this.stats.timeouts.avgTime/1000).toFixed(1)}s)`);
        report.push(`  Longest Job: ${this.stats.timeouts.maxTime}ms (${(this.stats.timeouts.maxTime/1000).toFixed(1)}s)`);
        report.push(`  Average Exceed: ${Math.round(this.stats.timeouts.avgExceed)}ms`);
        report.push(`  Maximum Exceed: ${this.stats.timeouts.maxExceed}ms`);
        
        report.push(`\nWorst Timeout Cases:`);
        this.stats.timeouts.jobs.slice(0, 3).forEach((job, index) => {
          const exceedBy = job.totalTime - this.stats.timeouts.threshold;
          report.push(`  ${index + 1}. Job ${job.jobId} (Mode ${job.mode}): ${job.totalTime}ms (+${exceedBy}ms)`);
        });
      } else {
        report.push('✅ No jobs exceeded the Chainlink timeout threshold!');
      }
    }

    // Outliers
    if (this.stats.outliers.length > 0) {
      report.push('\n🔍 PERFORMANCE OUTLIERS');
      report.push('-'.repeat(30));
      
      this.stats.outliers.slice(0, 5).forEach(job => {
        report.push(`Job ${job.jobId} (Mode ${job.mode}): ${job.totalTime}ms`);
      });
    }

    // Distribution chart
    if (showCharts && this.stats.overall.distribution) {
      report.push('\n📈 TIME DISTRIBUTION');
      report.push('-'.repeat(30));
      this.generateASCIIChart(this.stats.overall.distribution, report);
    }

    return report.join('\n');
  }

  generateASCIIChart(distribution, report) {
    const maxCount = Math.max(...distribution.map(d => d.count));
    const chartWidth = 40;
    
    distribution.forEach(bucket => {
      const barLength = Math.round((bucket.count / maxCount) * chartWidth);
      const bar = '█'.repeat(barLength) + '░'.repeat(chartWidth - barLength);
      report.push(`${bucket.range.padEnd(15)} │${bar}│ ${bucket.count}`);
    });
  }

  generateJSONReport() {
    return JSON.stringify(this.stats, null, 2);
  }
}

// Main execution
function main() {
  const analyzer = new TimingAnalyzer();
  
  console.log('Loading timing data...');
  analyzer.loadTimingData(logFile);
  
  console.log('Calculating statistics...');
  analyzer.calculateStatistics();
  
  let output;
  if (format === 'json') {
    output = analyzer.generateJSONReport();
  } else {
    output = analyzer.generateTextReport();
  }
  
  if (outputFile) {
    fs.writeFileSync(outputFile, output);
    console.log(`\nAnalysis saved to: ${outputFile}`);
  } else {
    console.log('\n' + output);
  }
}

// Help text
if (args.includes('--help') || args.includes('-h')) {
  console.log(`
Usage: node scripts/analyze-timing.js [log-file] [options]

Options:
  --percentiles=50,90,95,99  Calculate specific percentiles (default: 50,90,95,99)
  --group-by=mode|hour|day   Group analysis by mode, hour, or day
  --threshold=<ms>           Highlight operations above threshold (default: 10000)
  --chainlink-timeout=<ms>   Set Chainlink timeout threshold (default: 95000ms)
  --chart                    Generate simple ASCII charts
  --output=<file>            Save analysis to file
  --format=text|json         Output format (default: text)
  --help, -h                 Show this help message

Examples:
  # Basic timing analysis (includes Chainlink timeout analysis)
  node scripts/analyze-timing.js

  # Detailed analysis with charts
  node scripts/analyze-timing.js --chart --threshold=5000

  # Custom Chainlink timeout threshold
  node scripts/analyze-timing.js --chainlink-timeout=60000

  # Export analysis as JSON
  node scripts/analyze-timing.js --format=json --output=timing-analysis.json

  # Custom percentiles
  node scripts/analyze-timing.js --percentiles=75,90,95,99.9
`);
  process.exit(0);
}

main();