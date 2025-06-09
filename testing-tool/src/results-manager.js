const fs = require('fs-extra');
const path = require('path');
const createCsvWriter = require('csv-writer').createObjectCsvWriter;
const logger = require('./logger');

/**
 * Results manager for saving and analyzing test results
 */
class ResultsManager {
  constructor() {
    this.resultsDir = path.join(__dirname, '../results');
  }

  /**
   * Save test run results
   * @param {import('./types').TestRun} testRun - Complete test run data
   * @returns {string} Path to saved results directory
   */
  async saveTestRun(testRun) {
    try {
      // Create run directory
      const runDir = path.join(this.resultsDir, `run-${testRun.runId}`);
      await fs.ensureDir(runDir);
      await fs.ensureDir(path.join(runDir, 'detailed'));
      await fs.ensureDir(path.join(runDir, 'analysis'));

      // Save summary JSON
      await fs.writeJson(path.join(runDir, 'summary.json'), testRun, { spaces: 2 });

      // Save detailed results as CSV
      await this.saveResultsAsCsv(testRun.results, path.join(runDir, 'results.csv'));

      // Save detailed individual results
      await this.saveDetailedResults(testRun.results, path.join(runDir, 'detailed'));

      // Generate analysis reports
      await this.generateAnalysisReports(testRun, path.join(runDir, 'analysis'));

      logger.info(`Test run results saved to: ${runDir}`);
      return runDir;

    } catch (error) {
      logger.error('Failed to save test run results:', error);
      throw error;
    }
  }

  /**
   * Save results as CSV for easy comparison
   * @param {Array<import('./types').TestResult>} results
   * @param {string} csvPath
   */
  async saveResultsAsCsv(results, csvPath) {
    // Flatten results for CSV format
    const csvRecords = [];
    
    for (const result of results) {
      const baseRecord = {
        scenario_id: result.scenario_id,
        jury_id: result.jury_id,
        execution_time_ms: result.execution_time_ms,
        timestamp: result.timestamp,
        error: result.error || '',
        justification_preview: result.justification.substring(0, 100) + (result.justification.length > 100 ? '...' : '')
      };

      if (result.scores && result.scores.length > 0) {
        // Create one row per outcome
        result.scores.forEach((score, index) => {
          csvRecords.push({
            ...baseRecord,
            outcome: score.outcome,
            score: score.score,
            outcome_rank: index + 1
          });
        });
      } else {
        // No scores - add error row
        csvRecords.push({
          ...baseRecord,
          outcome: 'ERROR',
          score: 0,
          outcome_rank: 0
        });
      }
    }

    const csvWriter = createCsvWriter({
      path: csvPath,
      header: [
        { id: 'scenario_id', title: 'Scenario ID' },
        { id: 'jury_id', title: 'Jury ID' },
        { id: 'outcome', title: 'Outcome' },
        { id: 'score', title: 'Score' },
        { id: 'outcome_rank', title: 'Rank' },
        { id: 'execution_time_ms', title: 'Execution Time (ms)' },
        { id: 'timestamp', title: 'Timestamp' },
        { id: 'error', title: 'Error' },
        { id: 'justification_preview', title: 'Justification Preview' }
      ]
    });

    await csvWriter.writeRecords(csvRecords);
    logger.info(`Results saved to CSV: ${csvPath}`);
  }

  /**
   * Save detailed individual results as JSON files
   * @param {Array<import('./types').TestResult>} results
   * @param {string} detailedDir
   */
  async saveDetailedResults(results, detailedDir) {
    for (const result of results) {
      const filename = `${result.scenario_id}_jury${result.jury_id}.json`;
      const filePath = path.join(detailedDir, filename);
      await fs.writeJson(filePath, result, { spaces: 2 });
    }
    
    logger.info(`Detailed results saved to: ${detailedDir}`);
  }

  /**
   * Generate analysis reports
   * @param {import('./types').TestRun} testRun
   * @param {string} analysisDir
   */
  async generateAnalysisReports(testRun, analysisDir) {
    // Generate jury comparison report
    const juryComparison = await this.generateJuryComparison(testRun.results);
    await fs.writeJson(path.join(analysisDir, 'jury-comparison.json'), juryComparison, { spaces: 2 });

    // Generate scenario analysis
    const scenarioAnalysis = await this.generateScenarioAnalysis(testRun.results);
    await fs.writeJson(path.join(analysisDir, 'scenario-analysis.json'), scenarioAnalysis, { spaces: 2 });

    // Generate performance report
    const performance = await this.generatePerformanceReport(testRun.results);
    await fs.writeJson(path.join(analysisDir, 'performance.json'), performance, { spaces: 2 });

    // Generate agreement matrix
    const agreementMatrix = await this.generateAgreementMatrix(testRun.results);
    await fs.writeJson(path.join(analysisDir, 'agreement-matrix.json'), agreementMatrix, { spaces: 2 });

    logger.info(`Analysis reports generated in: ${analysisDir}`);
  }

  /**
   * Generate jury comparison analysis
   * @param {Array<import('./types').TestResult>} results
   * @returns {Object}
   */
  async generateJuryComparison(results) {
    const juryStats = {};
    const juryResults = {};

    // Group results by jury
    results.forEach(result => {
      if (!juryStats[result.jury_id]) {
        juryStats[result.jury_id] = {
          total_tests: 0,
          successful_tests: 0,
          failed_tests: 0,
          average_execution_time: 0,
          total_execution_time: 0
        };
        juryResults[result.jury_id] = [];
      }

      juryStats[result.jury_id].total_tests++;
      juryResults[result.jury_id].push(result);
      juryStats[result.jury_id].total_execution_time += result.execution_time_ms;

      if (result.error) {
        juryStats[result.jury_id].failed_tests++;
      } else {
        juryStats[result.jury_id].successful_tests++;
      }
    });

    // Calculate averages
    Object.keys(juryStats).forEach(juryId => {
      const stats = juryStats[juryId];
      stats.average_execution_time = Math.round(stats.total_execution_time / stats.total_tests);
      stats.success_rate = (stats.successful_tests / stats.total_tests * 100).toFixed(2);
    });

    return {
      summary: juryStats,
      details: juryResults
    };
  }

  /**
   * Generate scenario analysis
   * @param {Array<import('./types').TestResult>} results
   * @returns {Object}
   */
  async generateScenarioAnalysis(results) {
    const scenarioStats = {};

    // Group results by scenario
    results.forEach(result => {
      if (!scenarioStats[result.scenario_id]) {
        scenarioStats[result.scenario_id] = {
          jury_results: {},
          consensus_winner: null,
          disagreement_level: 0,
          average_execution_time: 0,
          total_execution_time: 0,
          jury_count: 0
        };
      }

      const scenario = scenarioStats[result.scenario_id];
      scenario.jury_results[result.jury_id] = result;
      scenario.total_execution_time += result.execution_time_ms;
      scenario.jury_count++;
    });

    // Analyze each scenario
    Object.keys(scenarioStats).forEach(scenarioId => {
      const scenario = scenarioStats[scenarioId];
      scenario.average_execution_time = Math.round(scenario.total_execution_time / scenario.jury_count);

      // Find consensus winner and disagreement level
      const winners = {};
      Object.values(scenario.jury_results).forEach(result => {
        if (result.scores && result.scores.length > 0) {
          const winner = result.scores[0].outcome; // Highest score
          winners[winner] = (winners[winner] || 0) + 1;
        }
      });

      if (Object.keys(winners).length > 0) {
        const sortedWinners = Object.entries(winners).sort((a, b) => b[1] - a[1]);
        scenario.consensus_winner = sortedWinners[0][0];
        scenario.consensus_strength = (sortedWinners[0][1] / scenario.jury_count * 100).toFixed(2);
        
        // Disagreement level based on distribution of winners
        const totalJuries = scenario.jury_count;
        const maxAgreement = Math.max(...Object.values(winners));
        scenario.disagreement_level = ((totalJuries - maxAgreement) / totalJuries * 100).toFixed(2);
      }
    });

    return scenarioStats;
  }

  /**
   * Generate performance report
   * @param {Array<import('./types').TestResult>} results
   * @returns {Object}
   */
  async generatePerformanceReport(results) {
    const executionTimes = results.map(r => r.execution_time_ms);
    const successfulResults = results.filter(r => !r.error);
    const failedResults = results.filter(r => r.error);

    return {
      total_tests: results.length,
      successful_tests: successfulResults.length,
      failed_tests: failedResults.length,
      success_rate: (successfulResults.length / results.length * 100).toFixed(2),
      execution_times: {
        min: Math.min(...executionTimes),
        max: Math.max(...executionTimes),
        average: Math.round(executionTimes.reduce((a, b) => a + b, 0) / executionTimes.length),
        median: this.calculateMedian(executionTimes)
      },
      errors: this.analyzeErrors(failedResults)
    };
  }

  /**
   * Generate agreement matrix between juries
   * @param {Array<import('./types').TestResult>} results
   * @returns {Object}
   */
  async generateAgreementMatrix(results) {
    // Group results by scenario
    const scenarioGroups = {};
    results.forEach(result => {
      if (!scenarioGroups[result.scenario_id]) {
        scenarioGroups[result.scenario_id] = {};
      }
      scenarioGroups[result.scenario_id][result.jury_id] = result;
    });

    // Calculate pairwise agreement between juries
    const juryIds = [...new Set(results.map(r => r.jury_id))].sort();
    const agreementMatrix = {};
    
    for (let i = 0; i < juryIds.length; i++) {
      const jury1 = juryIds[i];
      agreementMatrix[jury1] = {};
      
      for (let j = 0; j < juryIds.length; j++) {
        const jury2 = juryIds[j];
        
        if (i === j) {
          agreementMatrix[jury1][jury2] = 100; // Perfect agreement with self
        } else {
          const agreement = this.calculateJuryAgreement(jury1, jury2, scenarioGroups);
          agreementMatrix[jury1][jury2] = agreement;
        }
      }
    }

    return {
      matrix: agreementMatrix,
      average_agreement: this.calculateAverageAgreement(agreementMatrix, juryIds),
      jury_ids: juryIds
    };
  }

  /**
   * Calculate agreement between two juries
   * @param {number} jury1Id
   * @param {number} jury2Id
   * @param {Object} scenarioGroups
   * @returns {number} Agreement percentage
   */
  calculateJuryAgreement(jury1Id, jury2Id, scenarioGroups) {
    let agreements = 0;
    let totalComparisons = 0;

    Object.values(scenarioGroups).forEach(scenarioResults => {
      if (scenarioResults[jury1Id] && scenarioResults[jury2Id]) {
        const result1 = scenarioResults[jury1Id];
        const result2 = scenarioResults[jury2Id];

        if (result1.scores?.length > 0 && result2.scores?.length > 0) {
          const winner1 = result1.scores[0].outcome;
          const winner2 = result2.scores[0].outcome;
          
          if (winner1 === winner2) {
            agreements++;
          }
          totalComparisons++;
        }
      }
    });

    return totalComparisons > 0 ? ((agreements / totalComparisons) * 100).toFixed(2) : 0;
  }

  /**
   * Calculate average agreement across all jury pairs
   * @param {Object} agreementMatrix
   * @param {Array} juryIds
   * @returns {number}
   */
  calculateAverageAgreement(agreementMatrix, juryIds) {
    let totalAgreement = 0;
    let pairCount = 0;

    for (let i = 0; i < juryIds.length; i++) {
      for (let j = i + 1; j < juryIds.length; j++) {
        totalAgreement += parseFloat(agreementMatrix[juryIds[i]][juryIds[j]]);
        pairCount++;
      }
    }

    return pairCount > 0 ? (totalAgreement / pairCount).toFixed(2) : 0;
  }

  /**
   * Analyze error patterns
   * @param {Array<import('./types').TestResult>} failedResults
   * @returns {Object}
   */
  analyzeErrors(failedResults) {
    const errorTypes = {};
    
    failedResults.forEach(result => {
      const errorType = this.categorizeError(result.error);
      errorTypes[errorType] = (errorTypes[errorType] || 0) + 1;
    });

    return {
      by_type: errorTypes,
      total_failures: failedResults.length,
      examples: failedResults.slice(0, 5).map(r => ({
        scenario_id: r.scenario_id,
        jury_id: r.jury_id,
        error: r.error
      }))
    };
  }

  /**
   * Categorize error for analysis
   * @param {string} errorMessage
   * @returns {string}
   */
  categorizeError(errorMessage) {
    if (!errorMessage) return 'Unknown';
    
    const error = errorMessage.toLowerCase();
    
    if (error.includes('timeout') || error.includes('timed out')) {
      return 'Timeout';
    } else if (error.includes('connection') || error.includes('network')) {
      return 'Connection';
    } else if (error.includes('provider') || error.includes('api key')) {
      return 'Provider';
    } else if (error.includes('parse') || error.includes('json')) {
      return 'Parsing';
    } else if (error.includes('archive') || error.includes('manifest')) {
      return 'Archive';
    } else {
      return 'Other';
    }
  }

  /**
   * Calculate median value
   * @param {Array<number>} values
   * @returns {number}
   */
  calculateMedian(values) {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    
    return sorted.length % 2 !== 0 
      ? sorted[mid] 
      : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
  }

  /**
   * Load existing test run
   * @param {string} runId - Run identifier
   * @returns {import('./types').TestRun|null}
   */
  async loadTestRun(runId) {
    try {
      const runDir = path.join(this.resultsDir, `run-${runId}`);
      const summaryPath = path.join(runDir, 'summary.json');
      
      if (await fs.pathExists(summaryPath)) {
        return await fs.readJson(summaryPath);
      }
      
      return null;
    } catch (error) {
      logger.error(`Failed to load test run ${runId}:`, error);
      return null;
    }
  }

  /**
   * List all available test runs
   * @returns {Array<Object>}
   */
  async listTestRuns() {
    try {
      if (!await fs.pathExists(this.resultsDir)) {
        return [];
      }

      const entries = await fs.readdir(this.resultsDir, { withFileTypes: true });
      const runs = [];

      for (const entry of entries) {
        if (entry.isDirectory() && entry.name.startsWith('run-')) {
          const runId = entry.name.replace('run-', '');
          const summaryPath = path.join(this.resultsDir, entry.name, 'summary.json');
          
          if (await fs.pathExists(summaryPath)) {
            const summary = await fs.readJson(summaryPath);
            runs.push({
              runId,
              timestamp: summary.timestamp,
              scenarioCount: summary.scenarioIds?.length || 0,
              juryCount: summary.juryIds?.length || 0,
              totalTests: summary.results?.length || 0
            });
          }
        }
      }

      return runs.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    } catch (error) {
      logger.error('Failed to list test runs:', error);
      return [];
    }
  }
}

module.exports = new ResultsManager(); 