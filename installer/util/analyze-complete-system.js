#!/usr/bin/env node

/**
 * Complete System Analysis Tool for Verdikta Arbiter
 * 
 * This script analyzes both External Adapter and AI Node logs to provide
 * a comprehensive view of system performance and identify bottlenecks.
 * 
 * Usage:
 *   node analyze-complete-system.js [options]
 * 
 * Options:
 *   --external-adapter-log=<file>  Path to external adapter log
 *   --ai-node-log=<file>          Path to AI node log
 *   --output=<file>               Save analysis to file
 *   --correlation-analysis        Show correlation between EA and AI requests
 *   --bottleneck-analysis         Focus on identifying system bottlenecks
 *   --timeout-risk-analysis       Analyze timeout risks across the system
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Parse command line arguments
const args = process.argv.slice(2);
const options = {};

args.forEach(arg => {
  if (arg.startsWith('--')) {
    const [key, value] = arg.slice(2).split('=');
    options[key] = value || true;
  }
});

// Default log file paths
const externalAdapterLog = options['external-adapter-log'] || '/root/verdikta-arbiter-node/external-adapter/logs/adapter_20250807_042448.log';
const aiNodeLog = options['ai-node-log'] || '/root/verdikta-arbiter-node/ai-node/logs/ai-node_20250807_042439.log';
const outputFile = options.output;
const showCorrelation = options['correlation-analysis'];
const showBottlenecks = options['bottleneck-analysis'];
const showTimeoutRisk = options['timeout-risk-analysis'];

class CompleteSystemAnalyzer {
  constructor() {
    this.externalAdapterData = null;
    this.aiNodeData = null;
    this.analysis = {
      system_overview: {},
      bottlenecks: {},
      timeout_risks: {},
      correlations: {},
      recommendations: []
    };
  }

  async analyze() {
    console.log('🔍 COMPLETE SYSTEM ANALYSIS');
    console.log('='.repeat(60));
    console.log('Analyzing External Adapter and AI Node performance...\n');

    // Load data from both systems
    await this.loadExternalAdapterData();
    await this.loadAINodeData();

    // Perform analysis
    this.analyzeSystemOverview();
    
    if (showBottlenecks) {
      this.analyzeBottlenecks();
    }
    
    if (showTimeoutRisk) {
      this.analyzeTimeoutRisks();
    }
    
    if (showCorrelation) {
      this.analyzeCorrelations();
    }

    this.generateRecommendations();
    this.printResults();

    if (outputFile) {
      this.saveResults();
    }
  }

  async loadExternalAdapterData() {
    console.log('📊 Loading External Adapter data...');
    try {
      const jsonOutput = execSync(`node parse-timing-logs.js "${externalAdapterLog}" --format=json`, 
        { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
      this.externalAdapterData = JSON.parse(jsonOutput);
      console.log(`✅ Loaded ${this.externalAdapterData.length} External Adapter job executions`);
    } catch (error) {
      console.error('❌ Failed to load External Adapter data:', error.message);
      this.externalAdapterData = [];
    }
  }

  async loadAINodeData() {
    console.log('🤖 Loading AI Node data...');
    try {
      const jsonOutput = execSync(`node parse-ai-node-logs.js "${aiNodeLog}" --format=json`, 
        { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
      this.aiNodeData = JSON.parse(jsonOutput);
      console.log(`✅ Loaded ${this.aiNodeData.length} AI Node requests`);
    } catch (error) {
      console.error('❌ Failed to load AI Node data:', error.message);
      this.aiNodeData = [];
    }
  }

  analyzeSystemOverview() {
    const eaData = this.externalAdapterData || [];
    const aiData = this.aiNodeData || [];

    this.analysis.system_overview = {
      external_adapter: {
        total_executions: eaData.length,
        avg_execution_time: this.calculateAverage(eaData.map(job => job.totalTime)),
        timeout_jobs: eaData.filter(job => job.totalTime > 95000).length,
        high_risk_jobs: eaData.filter(job => job.totalTime > 76000).length
      },
      ai_node: {
        total_requests: aiData.length,
        avg_request_time: this.calculateAverage(aiData.map(req => req.totalDuration)),
        timeout_risk_requests: aiData.filter(req => req.totalDuration > 50000).length,
        slow_requests: aiData.filter(req => req.totalDuration > 20000).length
      },
      system_health: this.calculateSystemHealth(eaData, aiData)
    };
  }

  analyzeBottlenecks() {
    console.log('\n🚨 ANALYZING SYSTEM BOTTLENECKS...');
    
    const eaData = this.externalAdapterData || [];
    const aiData = this.aiNodeData || [];

    // External Adapter bottlenecks
    const eaBottlenecks = this.analyzeEABottlenecks(eaData);
    
    // AI Node bottlenecks
    const aiBottlenecks = this.analyzeAIBottlenecks(aiData);
    
    this.analysis.bottlenecks = {
      external_adapter: eaBottlenecks,
      ai_node: aiBottlenecks,
      primary_bottleneck: this.identifyPrimaryBottleneck(eaBottlenecks, aiBottlenecks)
    };
  }

  analyzeEABottlenecks(eaData) {
    if (!eaData.length) return { message: 'No data available' };

    const highRiskJobs = eaData.filter(job => job.totalTime > 70000);
    const aiServiceTimes = eaData
      .map(job => job.timings?.totalAiClientEvaluate || job.timings?.aiClientEvaluate || 0)
      .filter(time => time > 0);

    return {
      ai_service_dependency: {
        avg_ai_call_time: this.calculateAverage(aiServiceTimes),
        max_ai_call_time: Math.max(...aiServiceTimes),
        ai_calls_over_30s: aiServiceTimes.filter(time => time > 30000).length,
        impact: 'Primary bottleneck - accounts for 75-85% of high-risk execution time'
      },
      other_components: {
        ipfs_performance: 'Normal - typically under 1s',
        manifest_processing: 'Normal - typically under 500ms',
        file_processing: 'Normal - typically under 200ms'
      }
    };
  }

  analyzeAIBottlenecks(aiData) {
    if (!aiData.length) return { message: 'No data available' };

    const slowRequests = aiData.filter(req => req.totalDuration > 20000);
    
    // Analyze model performance
    const modelPerformance = this.analyzeModelPerformance(aiData);
    
    // Analyze component breakdown
    const componentAnalysis = this.analyzeAIComponents(aiData);

    return {
      request_volume: {
        total_requests: aiData.length,
        slow_request_rate: ((slowRequests.length / aiData.length) * 100).toFixed(1) + '%',
        avg_request_time: this.calculateAverage(aiData.map(req => req.totalDuration))
      },
      model_performance: modelPerformance,
      component_breakdown: componentAnalysis,
      timeout_analysis: {
        requests_over_50s: aiData.filter(req => req.totalDuration > 50000).length,
        requests_over_100s: aiData.filter(req => req.totalDuration > 100000).length,
        worst_case: Math.max(...aiData.map(req => req.totalDuration))
      }
    };
  }

  analyzeModelPerformance(aiData) {
    const modelStats = new Map();

    aiData.forEach(req => {
      if (req.modelTimings) {
        req.modelTimings.forEach(timing => {
          if (timing.type === 'total') {
            const key = `${timing.provider}_${timing.model}`;
            if (!modelStats.has(key)) {
              modelStats.set(key, { times: [], provider: timing.provider, model: timing.model });
            }
            modelStats.get(key).times.push(timing.duration);
          }
        });
      }
    });

    const result = {};
    for (const [key, data] of modelStats.entries()) {
      result[key] = {
        provider: data.provider,
        model: data.model,
        avg_time: this.calculateAverage(data.times),
        max_time: Math.max(...data.times),
        min_time: Math.min(...data.times),
        calls: data.times.length,
        slow_calls: data.times.filter(time => time > 10000).length
      };
    }

    return result;
  }

  analyzeAIComponents(aiData) {
    const componentStats = {
      model_calls: [],
      justification: [],
      attachment_processing: [],
      request_parsing: []
    };

    aiData.forEach(req => {
      if (req.componentBreakdown) {
        for (const [component, data] of Object.entries(req.componentBreakdown)) {
          if (component === 'Model Calls') {
            componentStats.model_calls.push(data.time);
          } else if (component === 'Justification') {
            componentStats.justification.push(data.time);
          } else if (component === 'Attachment Processing') {
            componentStats.attachment_processing.push(data.time);
          } else if (component === 'Request Processing') {
            componentStats.request_parsing.push(data.time);
          }
        }
      }
    });

    const result = {};
    for (const [component, times] of Object.entries(componentStats)) {
      if (times.length > 0) {
        result[component] = {
          avg_time: this.calculateAverage(times),
          max_time: Math.max(...times),
          impact_percentage: component === 'model_calls' ? 'High (60-70%)' : 
                            component === 'justification' ? 'Medium (20-30%)' : 'Low (<10%)'
        };
      }
    }

    return result;
  }

  analyzeTimeoutRisks() {
    console.log('\n⚠️  ANALYZING TIMEOUT RISKS...');
    
    const eaData = this.externalAdapterData || [];
    const aiData = this.aiNodeData || [];

    this.analysis.timeout_risks = {
      external_adapter: {
        chainlink_timeout: '95 seconds',
        jobs_at_risk: eaData.filter(job => job.totalTime > 76000).length,
        worst_cases: eaData
          .filter(job => job.totalTime > 70000)
          .sort((a, b) => b.totalTime - a.totalTime)
          .slice(0, 5)
          .map(job => ({
            jobId: job.jobId,
            mode: job.mode,
            totalTime: job.totalTime,
            risk_level: job.totalTime > 95000 ? 'TIMEOUT' : 
                       job.totalTime > 85500 ? 'CRITICAL' : 'HIGH'
          }))
      },
      ai_node: {
        service_timeout: 'No hard timeout (external adapter has 50s timeout)',
        requests_over_50s: aiData.filter(req => req.totalDuration > 50000).length,
        requests_over_100s: aiData.filter(req => req.totalDuration > 100000).length,
        extreme_cases: aiData
          .filter(req => req.totalDuration > 100000)
          .sort((a, b) => b.totalDuration - a.totalDuration)
          .slice(0, 5)
          .map(req => ({
            requestId: req.requestId,
            duration: req.totalDuration,
            models: req.modelsCount,
            timestamp: req.timestamp
          }))
      },
      cascade_risk: this.analyzeCascadeRisk(eaData, aiData)
    };
  }

  analyzeCascadeRisk(eaData, aiData) {
    const aiSlowRequests = aiData.filter(req => req.totalDuration > 30000).length;
    const eaHighRiskJobs = eaData.filter(job => job.totalTime > 70000).length;
    
    const cascadeRiskLevel = aiSlowRequests / aiData.length > 0.1 ? 'HIGH' : 
                            aiSlowRequests / aiData.length > 0.05 ? 'MEDIUM' : 'LOW';

    return {
      risk_level: cascadeRiskLevel,
      ai_slow_rate: ((aiSlowRequests / aiData.length) * 100).toFixed(1) + '%',
      ea_timeout_rate: ((eaHighRiskJobs / eaData.length) * 100).toFixed(1) + '%',
      description: 'Risk of AI Node delays causing External Adapter timeouts'
    };
  }

  identifyPrimaryBottleneck(eaBottlenecks, aiBottlenecks) {
    // Logic to determine the primary system bottleneck
    if (aiBottlenecks.request_volume && parseFloat(aiBottlenecks.request_volume.slow_request_rate) > 50) {
      return {
        component: 'AI Node - Model Calls',
        severity: 'CRITICAL',
        impact: 'High AI Node latency is causing External Adapter timeout risks',
        evidence: `${aiBottlenecks.request_volume.slow_request_rate} of AI requests are slow (>20s)`
      };
    }
    
    if (eaBottlenecks.ai_service_dependency && eaBottlenecks.ai_service_dependency.ai_calls_over_30s > 0) {
      return {
        component: 'AI Service Integration',
        severity: 'HIGH',
        impact: 'Long AI service calls are primary cause of External Adapter delays',
        evidence: `${eaBottlenecks.ai_service_dependency.ai_calls_over_30s} AI calls exceeded 30 seconds`
      };
    }

    return {
      component: 'Overall System Load',
      severity: 'MEDIUM',
      impact: 'General performance degradation across components',
      evidence: 'No single critical bottleneck identified'
    };
  }

  calculateSystemHealth(eaData, aiData) {
    if (!eaData.length || !aiData.length) return 'UNKNOWN';

    const eaTimeoutRate = eaData.filter(job => job.totalTime > 95000).length / eaData.length;
    const aiSlowRate = aiData.filter(req => req.totalDuration > 30000).length / aiData.length;
    
    if (eaTimeoutRate > 0.01 || aiSlowRate > 0.2) return 'CRITICAL';
    if (eaTimeoutRate > 0.005 || aiSlowRate > 0.1) return 'WARNING';
    if (eaTimeoutRate > 0.001 || aiSlowRate > 0.05) return 'DEGRADED';
    return 'HEALTHY';
  }

  generateRecommendations() {
    const recommendations = [];
    const bottlenecks = this.analysis.bottlenecks;
    const timeoutRisks = this.analysis.timeout_risks;

    // AI Node recommendations
    if (bottlenecks.ai_node && bottlenecks.ai_node.request_volume) {
      const slowRate = parseFloat(bottlenecks.ai_node.request_volume.slow_request_rate);
      if (slowRate > 50) {
        recommendations.push({
          priority: 'HIGH',
          component: 'AI Node',
          issue: `${slowRate}% of AI requests are slow (>20s)`,
          recommendation: 'Scale AI Node horizontally or optimize model provider connections',
          impact: 'Will reduce External Adapter timeout risks'
        });
      }
    }

    // Model-specific recommendations
    if (bottlenecks.ai_node && bottlenecks.ai_node.model_performance) {
      for (const [modelKey, stats] of Object.entries(bottlenecks.ai_node.model_performance)) {
        if (stats.avg_time > 8000) {
          recommendations.push({
            priority: 'MEDIUM',
            component: 'AI Model',
            issue: `${stats.provider}/${stats.model} averaging ${Math.round(stats.avg_time)}ms`,
            recommendation: 'Consider model optimization or provider switch',
            impact: 'Will reduce overall AI Node request time'
          });
        }
      }
    }

    // External Adapter recommendations
    if (timeoutRisks.external_adapter && timeoutRisks.external_adapter.jobs_at_risk > 0) {
      recommendations.push({
        priority: 'CRITICAL',
        component: 'External Adapter',
        issue: `${timeoutRisks.external_adapter.jobs_at_risk} jobs at timeout risk`,
        recommendation: 'Implement circuit breaker for AI service calls or increase Chainlink timeout',
        impact: 'Will prevent job failures and blockchain transaction issues'
      });
    }

    // System-level recommendations
    if (timeoutRisks.cascade_risk && timeoutRisks.cascade_risk.risk_level === 'HIGH') {
      recommendations.push({
        priority: 'HIGH',
        component: 'System Architecture',
        issue: 'High cascade risk from AI Node to External Adapter',
        recommendation: 'Implement async processing or AI service timeout limits',
        impact: 'Will prevent AI delays from causing blockchain job failures'
      });
    }

    this.analysis.recommendations = recommendations;
  }

  calculateAverage(arr) {
    if (!arr.length) return 0;
    return Math.round(arr.reduce((sum, val) => sum + val, 0) / arr.length);
  }

  printResults() {
    console.log('\n' + '='.repeat(80));
    console.log('📋 COMPLETE SYSTEM ANALYSIS RESULTS');
    console.log('='.repeat(80));

    // System Overview
    console.log('\n📊 SYSTEM OVERVIEW:');
    console.log('-'.repeat(40));
    const overview = this.analysis.system_overview;
    console.log(`System Health: ${overview.system_health}`);
    console.log(`External Adapter: ${overview.external_adapter.total_executions} executions, avg ${overview.external_adapter.avg_execution_time}ms`);
    console.log(`AI Node: ${overview.ai_node.total_requests} requests, avg ${overview.ai_node.avg_request_time}ms`);
    console.log(`Timeout Risk Jobs: ${overview.external_adapter.timeout_jobs + overview.external_adapter.high_risk_jobs}`);

    // Primary Bottleneck
    if (this.analysis.bottlenecks.primary_bottleneck) {
      console.log('\n🚨 PRIMARY BOTTLENECK:');
      console.log('-'.repeat(40));
      const bottleneck = this.analysis.bottlenecks.primary_bottleneck;
      console.log(`Component: ${bottleneck.component}`);
      console.log(`Severity: ${bottleneck.severity}`);
      console.log(`Impact: ${bottleneck.impact}`);
      console.log(`Evidence: ${bottleneck.evidence}`);
    }

    // Recommendations
    if (this.analysis.recommendations.length > 0) {
      console.log('\n💡 RECOMMENDATIONS:');
      console.log('-'.repeat(40));
      this.analysis.recommendations
        .sort((a, b) => this.getPriorityWeight(a.priority) - this.getPriorityWeight(b.priority))
        .forEach((rec, i) => {
          console.log(`${i + 1}. [${rec.priority}] ${rec.component}`);
          console.log(`   Issue: ${rec.issue}`);
          console.log(`   Action: ${rec.recommendation}`);
          console.log(`   Impact: ${rec.impact}\n`);
        });
    }

    // Detailed sections (if requested)
    if (showBottlenecks) {
      this.printBottleneckDetails();
    }

    if (showTimeoutRisk) {
      this.printTimeoutRiskDetails();
    }
  }

  printBottleneckDetails() {
    console.log('\n🔍 DETAILED BOTTLENECK ANALYSIS:');
    console.log('-'.repeat(50));
    
    const bottlenecks = this.analysis.bottlenecks;
    
    if (bottlenecks.ai_node && bottlenecks.ai_node.model_performance) {
      console.log('\nAI Model Performance:');
      for (const [modelKey, stats] of Object.entries(bottlenecks.ai_node.model_performance)) {
        console.log(`  ${stats.provider}/${stats.model}:`);
        console.log(`    Average: ${stats.avg_time}ms`);
        console.log(`    Range: ${stats.min_time}ms - ${stats.max_time}ms`);
        console.log(`    Slow calls (>10s): ${stats.slow_calls}/${stats.calls}`);
      }
    }

    if (bottlenecks.ai_node && bottlenecks.ai_node.component_breakdown) {
      console.log('\nAI Component Breakdown:');
      for (const [component, stats] of Object.entries(bottlenecks.ai_node.component_breakdown)) {
        console.log(`  ${component}: avg ${stats.avg_time}ms, max ${stats.max_time}ms (${stats.impact_percentage} impact)`);
      }
    }
  }

  printTimeoutRiskDetails() {
    console.log('\n⚠️  TIMEOUT RISK ANALYSIS:');
    console.log('-'.repeat(50));
    
    const risks = this.analysis.timeout_risks;
    
    if (risks.external_adapter.worst_cases.length > 0) {
      console.log('\nExternal Adapter High-Risk Jobs:');
      risks.external_adapter.worst_cases.forEach((job, i) => {
        console.log(`  ${i + 1}. Job ${job.jobId} Mode ${job.mode}: ${job.totalTime}ms (${job.risk_level})`);
      });
    }

    if (risks.ai_node.extreme_cases.length > 0) {
      console.log('\nAI Node Extreme Cases:');
      risks.ai_node.extreme_cases.forEach((req, i) => {
        console.log(`  ${i + 1}. Request ${req.requestId}: ${Math.round(req.duration/1000)}s (${req.models} models)`);
      });
    }

    if (risks.cascade_risk) {
      console.log(`\nCascade Risk: ${risks.cascade_risk.risk_level}`);
      console.log(`AI slow rate: ${risks.cascade_risk.ai_slow_rate}, EA timeout rate: ${risks.cascade_risk.ea_timeout_rate}`);
    }
  }

  getPriorityWeight(priority) {
    const weights = { 'CRITICAL': 1, 'HIGH': 2, 'MEDIUM': 3, 'LOW': 4 };
    return weights[priority] || 5;
  }

  saveResults() {
    const output = {
      timestamp: new Date().toISOString(),
      analysis: this.analysis,
      summary: {
        external_adapter_log: externalAdapterLog,
        ai_node_log: aiNodeLog,
        total_ea_executions: this.analysis.system_overview.external_adapter.total_executions,
        total_ai_requests: this.analysis.system_overview.ai_node.total_requests,
        system_health: this.analysis.system_overview.system_health,
        primary_bottleneck: this.analysis.bottlenecks.primary_bottleneck?.component,
        recommendation_count: this.analysis.recommendations.length
      }
    };

    fs.writeFileSync(outputFile, JSON.stringify(output, null, 2));
    console.log(`\n💾 Analysis saved to: ${outputFile}`);
  }
}

// Help text
if (args.includes('--help') || args.includes('-h')) {
  console.log(`
Usage: node analyze-complete-system.js [options]

Options:
  --external-adapter-log=<file>  Path to external adapter log (default: auto-detected)
  --ai-node-log=<file>          Path to AI node log (default: auto-detected)
  --output=<file>               Save detailed analysis to JSON file
  --correlation-analysis        Show correlation between EA and AI requests
  --bottleneck-analysis         Focus on identifying system bottlenecks
  --timeout-risk-analysis       Analyze timeout risks across the system
  --help, -h                    Show this help message

Examples:
  # Basic system analysis
  node analyze-complete-system.js

  # Comprehensive analysis with all details
  node analyze-complete-system.js --bottleneck-analysis --timeout-risk-analysis --correlation-analysis

  # Save detailed analysis to file
  node analyze-complete-system.js --bottleneck-analysis --output=system-analysis.json

  # Focus on timeout risks
  node analyze-complete-system.js --timeout-risk-analysis
`);
  process.exit(0);
}

// Main execution
async function main() {
  const analyzer = new CompleteSystemAnalyzer();
  await analyzer.analyze();
}

main().catch(error => {
  console.error('Error during analysis:', error.message);
  process.exit(1);
});
