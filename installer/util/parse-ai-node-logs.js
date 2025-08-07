#!/usr/bin/env node

/**
 * AI Node Log Parser for Verdikta AI Service
 * 
 * This script parses AI Node logs to extract timing data from the TIMING_SUMMARY
 * entries and component-level timing information for performance analysis.
 * 
 * Usage:
 *   node parse-ai-node-logs.js [log-file] [options]
 * 
 * Options:
 *   --format=json|csv|table    Output format (default: table)
 *   --min-time=<ms>           Only show requests taking longer than specified time
 *   --output=<file>           Save output to file
 *   --detailed                Show detailed breakdown of all timing components
 *   --slow-requests           Show requests taking longer than 20 seconds
 *   --model-analysis          Show model-specific performance analysis
 *   --timeout-threshold=<ms>  Set custom timeout threshold (default: 50000ms - 50s)
 */

const fs = require('fs');
const path = require('path');

// Parse command line arguments
const args = process.argv.slice(2);
const logFile = args[0] || '/root/verdikta-arbiter-node/ai-node/logs/ai-node_20250807_042439.log';
const options = {};

args.slice(1).forEach(arg => {
  if (arg.startsWith('--')) {
    const [key, value] = arg.slice(2).split('=');
    options[key] = value || true;
  }
});

// Default options
const format = options.format || 'table';
const minTimeFilter = options['min-time'] ? parseInt(options['min-time']) : 0;
const outputFile = options.output;
const showDetailed = options.detailed;
const showSlowRequests = options['slow-requests'];
const showModelAnalysis = options['model-analysis'];
const timeoutThreshold = options['timeout-threshold'] ? parseInt(options['timeout-threshold']) : 50000; // 50 seconds default

class AINodeLogParser {
  constructor() {
    this.requests = [];
    this.modelStats = new Map();
    this.componentStats = new Map();
  }

  parseLogFile(filePath, format = 'table') {
    if (!fs.existsSync(filePath)) {
      console.error(`Log file not found: ${filePath}`);
      process.exit(1);
    }

    if (format !== 'json') {
      console.log(`Parsing AI Node log file: ${filePath}`);
    }
    
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n');

    let parsedCount = 0;
    for (const line of lines) {
      if (this.parseTimingSummaryLine(line)) {
        parsedCount++;
      }
    }

    if (format !== 'json') {
      console.log(`Parsed ${parsedCount} AI Node requests`);
    }

    return this.getFilteredRequests();
  }

  parseTimingSummaryLine(line) {
    // Look for TIMING_SUMMARY entries
    const summaryMatch = line.match(/🎯 TIMING_SUMMARY (.+)/);
    if (!summaryMatch) return false;

    try {
      const timingData = JSON.parse(summaryMatch[1]);
      
      const request = {
        timestamp: timingData.timestamp,
        totalDuration: timingData.total_duration_ms,
        requestId: timingData.summary.request_id,
        modelsCount: timingData.summary.models_count,
        iterations: timingData.summary.iterations,
        hasAttachments: timingData.summary.has_attachments,
        attachmentCount: timingData.summary.attachment_count,
        outcomesCount: timingData.summary.outcomes_count,
        components: timingData.components || {},
        status: 'completed'
      };

      // Extract model-specific timings
      request.modelTimings = this.extractModelTimings(timingData.components);
      
      // Calculate component percentages
      request.componentBreakdown = this.calculateComponentBreakdown(timingData.components, request.totalDuration);

      // Determine performance category
      request.performanceCategory = this.categorizePerformance(request.totalDuration);

      this.requests.push(request);
      this.updateStats(request);
      
      return true;
    } catch (error) {
      console.warn(`Failed to parse timing summary: ${error.message}`);
      return false;
    }
  }

  extractModelTimings(components) {
    const modelTimings = [];
    
    for (const [key, value] of Object.entries(components)) {
      // Match patterns like: model_call_OpenAI_gpt-4o_with_attachments_1 or model_total_OpenAI_gpt-4o
      const modelCallMatch = key.match(/^model_call_([^_]+)_(.+?)(?:_with_attachments)?_(\d+)$/);
      const modelTotalMatch = key.match(/^model_total_([^_]+)_(.+)$/);
      
      if (modelCallMatch) {
        const [, provider, model, callNumber] = modelCallMatch;
        modelTimings.push({
          type: 'call',
          provider,
          model,
          callNumber: parseInt(callNumber),
          duration: value,
          hasAttachments: key.includes('_with_attachments_')
        });
      } else if (modelTotalMatch) {
        const [, provider, model] = modelTotalMatch;
        modelTimings.push({
          type: 'total',
          provider,
          model,
          duration: value
        });
      }
    }
    
    return modelTimings;
  }

  calculateComponentBreakdown(components, totalDuration) {
    const breakdown = {};
    const categoryMapping = {
      'request_parsing': 'Request Processing',
      'attachment_native_processing': 'Attachment Processing',
      'attachment_text_extraction': 'Attachment Processing',
      'iteration_1': 'Model Processing',
      'justification_generation': 'Justification',
      'total_request': 'Total'
    };

    for (const [key, value] of Object.entries(components)) {
      let category = 'Other';
      
      // Only count model_total_ entries to avoid double-counting with model_call_ entries
      if (key.startsWith('model_total_')) {
        category = 'Model Calls';
      } else if (key.startsWith('model_call_')) {
        // Skip individual model calls since they're included in model_total_
        continue;
      } else if (categoryMapping[key]) {
        category = categoryMapping[key];
      }

      if (!breakdown[category]) {
        breakdown[category] = 0;
      }
      
      if (key !== 'total_request') { // Don't double-count total
        breakdown[category] += value;
      }
    }

    // Calculate percentages
    const result = {};
    for (const [category, time] of Object.entries(breakdown)) {
      result[category] = {
        time,
        percentage: ((time / totalDuration) * 100).toFixed(1)
      };
    }

    return result;
  }

  categorizePerformance(duration) {
    if (duration > timeoutThreshold) return 'TIMEOUT_RISK';
    if (duration > timeoutThreshold * 0.8) return 'HIGH_RISK';
    if (duration > timeoutThreshold * 0.6) return 'MEDIUM_RISK';
    if (duration > 10000) return 'SLOW';
    if (duration > 5000) return 'MODERATE';
    return 'FAST';
  }

  updateStats(request) {
    // Update model statistics
    for (const modelTiming of request.modelTimings) {
      if (modelTiming.type === 'total') {
        const modelKey = `${modelTiming.provider}_${modelTiming.model}`;
        if (!this.modelStats.has(modelKey)) {
          this.modelStats.set(modelKey, {
            provider: modelTiming.provider,
            model: modelTiming.model,
            totalCalls: 0,
            totalTime: 0,
            minTime: Infinity,
            maxTime: 0,
            timeouts: 0
          });
        }
        
        const stats = this.modelStats.get(modelKey);
        stats.totalCalls++;
        stats.totalTime += modelTiming.duration;
        stats.minTime = Math.min(stats.minTime, modelTiming.duration);
        stats.maxTime = Math.max(stats.maxTime, modelTiming.duration);
        
        if (modelTiming.duration > 30000) { // 30 second threshold for individual model calls
          stats.timeouts++;
        }
      }
    }

    // Update component statistics
    for (const [component, data] of Object.entries(request.componentBreakdown)) {
      if (!this.componentStats.has(component)) {
        this.componentStats.set(component, {
          totalTime: 0,
          count: 0,
          avgTime: 0
        });
      }
      
      const stats = this.componentStats.get(component);
      stats.totalTime += data.time;
      stats.count++;
      stats.avgTime = stats.totalTime / stats.count;
    }
  }

  getFilteredRequests() {
    let filtered = this.requests;
    
    if (minTimeFilter > 0) {
      filtered = filtered.filter(req => req.totalDuration >= minTimeFilter);
    }

    return filtered.sort((a, b) => b.totalDuration - a.totalDuration);
  }

  formatAsTable(requests) {
    if (requests.length === 0) {
      return 'No requests found matching the criteria.';
    }

    if (showSlowRequests) {
      this.printSlowRequestsAnalysis(requests);
      return;
    }

    if (showModelAnalysis) {
      this.printModelAnalysis();
      return;
    }

    console.log('\n=== AI Node Request Analysis ===');
    console.log('Request ID'.padEnd(18) + 'Duration'.padEnd(10) + 'Models'.padEnd(8) + 'Attachments'.padEnd(12) + 'Category'.padEnd(12) + 'Timestamp');
    console.log('─'.repeat(80));

    for (const request of requests.slice(0, 20)) { // Show top 20
      const duration = `${request.totalDuration}ms`;
      const models = `${request.modelsCount}`;
      const attachments = request.hasAttachments ? `${request.attachmentCount}` : 'None';
      const category = request.performanceCategory;
      const time = new Date(request.timestamp).toLocaleTimeString();

      console.log(
        request.requestId.substring(4, 18).padEnd(18) +
        duration.padEnd(10) +
        models.padEnd(8) +
        attachments.padEnd(12) +
        category.padEnd(12) +
        time
      );
    }

    if (showDetailed) {
      console.log('\n=== Detailed Component Breakdown (Top 5) ===');
      for (const request of requests.slice(0, 5)) {
        this.printDetailedRequest(request);
      }
    }

    this.printSummaryStats(requests);
  }

  printSlowRequestsAnalysis(requests) {
    const slowRequests = requests.filter(req => req.totalDuration > 20000);
    
    console.log('\n🐌 SLOW REQUESTS ANALYSIS (>20s)');
    console.log('='.repeat(60));
    console.log(`Found ${slowRequests.length} slow requests out of ${requests.length} total`);
    console.log(`Slow request rate: ${((slowRequests.length / requests.length) * 100).toFixed(1)}%`);
    
    if (slowRequests.length === 0) {
      console.log('✅ No slow requests found!');
      return;
    }

    console.log('\n📊 SLOW REQUESTS BREAKDOWN:');
    console.log('-'.repeat(80));
    console.log('Duration'.padEnd(10) + 'Models'.padEnd(8) + 'Attachments'.padEnd(12) + 'Top Bottleneck'.padEnd(25) + 'Timestamp');
    console.log('─'.repeat(80));

    for (const request of slowRequests.slice(0, 10)) {
      const topBottleneck = this.getTopBottleneck(request);
      const duration = `${request.totalDuration}ms`;
      const models = `${request.modelsCount}`;
      const attachments = request.hasAttachments ? `${request.attachmentCount}` : 'None';
      const time = new Date(request.timestamp).toLocaleTimeString();

      console.log(
        duration.padEnd(10) +
        models.padEnd(8) +
        attachments.padEnd(12) +
        topBottleneck.padEnd(25) +
        time
      );
    }

    // Analyze common patterns in slow requests
    this.analyzeSlowRequestPatterns(slowRequests);
  }

  printModelAnalysis() {
    console.log('\n🤖 MODEL PERFORMANCE ANALYSIS');
    console.log('='.repeat(60));

    if (this.modelStats.size === 0) {
      console.log('No model statistics available.');
      return;
    }

    console.log('Model'.padEnd(35) + 'Calls'.padEnd(8) + 'Avg Time'.padEnd(10) + 'Min'.padEnd(8) + 'Max'.padEnd(8) + 'Timeouts');
    console.log('─'.repeat(80));

    const sortedModels = Array.from(this.modelStats.entries())
      .sort(([,a], [,b]) => (b.totalTime / b.totalCalls) - (a.totalTime / a.totalCalls));

    for (const [modelKey, stats] of sortedModels) {
      const avgTime = Math.round(stats.totalTime / stats.totalCalls);
      const modelName = `${stats.provider}/${stats.model}`.substring(0, 34);
      const timeoutRate = ((stats.timeouts / stats.totalCalls) * 100).toFixed(1);

      console.log(
        modelName.padEnd(35) +
        stats.totalCalls.toString().padEnd(8) +
        `${avgTime}ms`.padEnd(10) +
        `${stats.minTime}ms`.padEnd(8) +
        `${stats.maxTime}ms`.padEnd(8) +
        `${stats.timeouts} (${timeoutRate}%)`
      );
    }

    console.log('\n📈 MODEL INSIGHTS:');
    const insights = this.generateModelInsights(sortedModels);
    insights.forEach(insight => console.log(`  • ${insight}`));
  }

  getTopBottleneck(request) {
    let maxTime = 0;
    let topComponent = 'Unknown';

    for (const [component, data] of Object.entries(request.componentBreakdown)) {
      if (data.time > maxTime) {
        maxTime = data.time;
        topComponent = component;
      }
    }

    return `${topComponent} (${maxTime}ms)`;
  }

  analyzeSlowRequestPatterns(slowRequests) {
    console.log('\n🔍 SLOW REQUEST PATTERNS:');
    console.log('-'.repeat(40));

    // Pattern 1: Attachment correlation
    const withAttachments = slowRequests.filter(req => req.hasAttachments).length;
    const attachmentRate = ((withAttachments / slowRequests.length) * 100).toFixed(1);
    console.log(`• Requests with attachments: ${withAttachments}/${slowRequests.length} (${attachmentRate}%)`);

    // Pattern 2: Model count correlation
    const multiModel = slowRequests.filter(req => req.modelsCount > 1).length;
    const multiModelRate = ((multiModel / slowRequests.length) * 100).toFixed(1);
    console.log(`• Multi-model requests: ${multiModel}/${slowRequests.length} (${multiModelRate}%)`);

    // Pattern 3: Top bottlenecks
    const bottlenecks = {};
    slowRequests.forEach(req => {
      for (const [component, data] of Object.entries(req.componentBreakdown)) {
        if (!bottlenecks[component]) bottlenecks[component] = { count: 0, totalTime: 0 };
        bottlenecks[component].count++;
        bottlenecks[component].totalTime += data.time;
      }
    });

    const topBottlenecks = Object.entries(bottlenecks)
      .map(([comp, data]) => ({ component: comp, avgTime: data.totalTime / data.count, count: data.count }))
      .sort((a, b) => b.avgTime - a.avgTime)
      .slice(0, 3);

    console.log('• Top bottlenecks in slow requests:');
    topBottlenecks.forEach((bottleneck, i) => {
      console.log(`  ${i + 1}. ${bottleneck.component}: avg ${Math.round(bottleneck.avgTime)}ms (${bottleneck.count} requests)`);
    });
  }

  generateModelInsights(sortedModels) {
    const insights = [];
    
    if (sortedModels.length === 0) return insights;

    const fastest = sortedModels[sortedModels.length - 1];
    const slowest = sortedModels[0];
    
    const fastestAvg = Math.round(fastest[1].totalTime / fastest[1].totalCalls);
    const slowestAvg = Math.round(slowest[1].totalTime / slowest[1].totalCalls);

    insights.push(`Fastest model: ${fastest[1].provider}/${fastest[1].model} (avg ${fastestAvg}ms)`);
    insights.push(`Slowest model: ${slowest[1].provider}/${slowest[1].model} (avg ${slowestAvg}ms)`);
    
    const speedDifference = ((slowestAvg - fastestAvg) / fastestAvg * 100).toFixed(1);
    insights.push(`Performance gap: ${speedDifference}% slower`);

    // Find models with high timeout rates
    const highTimeoutModels = sortedModels.filter(([, stats]) => (stats.timeouts / stats.totalCalls) > 0.1);
    if (highTimeoutModels.length > 0) {
      insights.push(`Models with high timeout rates (>10%): ${highTimeoutModels.length}`);
    }

    return insights;
  }

  printDetailedRequest(request) {
    console.log(`\n📋 Request ${request.requestId} - ${request.totalDuration}ms`);
    console.log('─'.repeat(50));
    
    console.log('Component Breakdown:');
    const sortedComponents = Object.entries(request.componentBreakdown)
      .sort(([,a], [,b]) => b.time - a.time);

    for (const [component, data] of sortedComponents) {
      const bar = '█'.repeat(Math.min(Math.round(parseFloat(data.percentage) / 3), 25));
      console.log(`  ${component.padEnd(20)}: ${data.time.toString().padStart(6)}ms (${data.percentage.padStart(5)}%) ${bar}`);
    }
  }

  printSummaryStats(requests) {
    console.log('\n📊 SUMMARY STATISTICS');
    console.log('─'.repeat(40));
    
    const totalRequests = requests.length;
    const avgDuration = Math.round(requests.reduce((sum, req) => sum + req.totalDuration, 0) / totalRequests);
    const medianDuration = this.getMedian(requests.map(req => req.totalDuration));
    const maxDuration = Math.max(...requests.map(req => req.totalDuration));
    const minDuration = Math.min(...requests.map(req => req.totalDuration));

    console.log(`Total requests: ${totalRequests}`);
    console.log(`Average duration: ${avgDuration}ms`);
    console.log(`Median duration: ${medianDuration}ms`);
    console.log(`Min/Max duration: ${minDuration}ms / ${maxDuration}ms`);

    // Performance distribution
    const categories = {};
    requests.forEach(req => {
      categories[req.performanceCategory] = (categories[req.performanceCategory] || 0) + 1;
    });

    console.log('\nPerformance Distribution:');
    for (const [category, count] of Object.entries(categories)) {
      const percentage = ((count / totalRequests) * 100).toFixed(1);
      console.log(`  ${category}: ${count} (${percentage}%)`);
    }
  }

  getMedian(arr) {
    const sorted = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 !== 0 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
  }

  formatAsJSON(requests) {
    return JSON.stringify(requests, null, 2);
  }

  formatAsCSV(requests) {
    if (requests.length === 0) return 'No data';

    const headers = [
      'requestId', 'timestamp', 'totalDuration', 'modelsCount', 'iterations',
      'hasAttachments', 'attachmentCount', 'outcomesCount', 'performanceCategory'
    ];
    
    const csvLines = [headers.join(',')];

    for (const request of requests) {
      const row = [
        request.requestId,
        request.timestamp,
        request.totalDuration,
        request.modelsCount,
        request.iterations,
        request.hasAttachments,
        request.attachmentCount,
        request.outcomesCount,
        request.performanceCategory
      ];
      csvLines.push(row.join(','));
    }

    return csvLines.join('\n');
  }
}

// Main execution
function main() {
  const parser = new AINodeLogParser();
  const requests = parser.parseLogFile(logFile, format);

  let output;
  switch (format) {
    case 'json':
      output = parser.formatAsJSON(requests);
      break;
    case 'csv':
      output = parser.formatAsCSV(requests);
      break;
    case 'table':
    default:
      parser.formatAsTable(requests);
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
Usage: node parse-ai-node-logs.js [log-file] [options]

Options:
  --format=json|csv|table    Output format (default: table)
  --min-time=<ms>           Only show requests taking longer than specified time
  --output=<file>           Save output to file
  --detailed                Show detailed breakdown of timing components
  --slow-requests           Analyze requests taking longer than 20 seconds
  --model-analysis          Show model-specific performance analysis
  --timeout-threshold=<ms>  Set custom timeout threshold (default: 50000ms)
  --help, -h                Show this help message

Examples:
  # Show all requests in table format
  node parse-ai-node-logs.js

  # Analyze slow requests
  node parse-ai-node-logs.js --slow-requests

  # Show model performance analysis
  node parse-ai-node-logs.js --model-analysis

  # Show requests taking longer than 30 seconds
  node parse-ai-node-logs.js --min-time=30000 --detailed

  # Export all data to JSON
  node parse-ai-node-logs.js --format=json --output=ai-node-timing.json

  # Analyze with custom timeout threshold (40 seconds)
  node parse-ai-node-logs.js --timeout-threshold=40000 --slow-requests
`);
  process.exit(0);
}

main();
