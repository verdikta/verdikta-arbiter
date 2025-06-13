const fs = require('fs-extra');
const path = require('path');
const csv = require('csv-parser');
const logger = require('./logger');

/**
 * Scenario loader for CSV files
 */
class ScenarioLoader {
  constructor() {
    this.scenariosDir = path.join(__dirname, '../scenarios');
    this.attachmentsDir = path.join(this.scenariosDir, 'attachments');
  }

  /**
   * Load scenarios from CSV file
   * @param {string} csvFilePath - Path to CSV file
   * @param {Object} options - Loading options
   * @param {Array<string>} [options.scenarioIds] - Filter by specific scenario IDs
   * @param {Array<string>} [options.tags] - Filter by tags
   * @returns {Array<import('./types').ScenarioRecord>}
   */
  async loadScenarios(csvFilePath, options = {}) {
    try {
      if (!await fs.pathExists(csvFilePath)) {
        throw new Error(`CSV file not found: ${csvFilePath}`);
      }

      const scenarios = [];
      const { scenarioIds, tags } = options;

      return new Promise((resolve, reject) => {
        fs.createReadStream(csvFilePath)
          .pipe(csv())
          .on('data', (row) => {
            try {
              const scenario = this.parseScenarioRow(row);
              
              // Apply filters
              if (scenarioIds && !scenarioIds.includes(scenario.scenario_id)) {
                return;
              }
              
              if (tags && !this.scenarioMatchesTags(scenario, tags)) {
                return;
              }
              
              scenarios.push(scenario);
            } catch (error) {
              logger.error(`Error parsing scenario row:`, error);
              reject(error);
            }
          })
          .on('end', () => {
            logger.info(`Loaded ${scenarios.length} scenarios from ${path.basename(csvFilePath)}`);
            resolve(scenarios);
          })
          .on('error', reject);
      });
    } catch (error) {
      logger.error('Failed to load scenarios:', error);
      throw error;
    }
  }

  /**
   * Parse and validate a single scenario row
   * @param {Object} row - Raw CSV row
   * @returns {import('./types').ScenarioRecord}
   */
  parseScenarioRow(row) {
    // Validate required fields (attachment_archive is now optional)
    if (!row.scenario_id || !row.prompt || !row.outcomes) {
      throw new Error('Missing required fields: scenario_id, prompt, outcomes');
    }

    // Parse outcomes
    const outcomes = row.outcomes.split(',').map(o => o.trim()).filter(o => o);
    if (outcomes.length === 0) {
      throw new Error('At least one outcome must be specified');
    }

    // Parse tags if present
    const tags = row.tags ? row.tags.split(',').map(t => t.trim()).filter(t => t) : [];

    const scenario = {
      scenario_id: row.scenario_id.trim(),
      prompt: row.prompt.trim(),
      outcomes: row.outcomes.trim(),
      attachment_archive: row.attachment_archive ? row.attachment_archive.trim() : undefined,
      expected_winner: row.expected_winner ? row.expected_winner.trim() : undefined,
      tags: row.tags ? row.tags.trim() : undefined,
      notes: row.notes ? row.notes.trim() : undefined,
      // Parsed arrays for easier use
      _parsedOutcomes: outcomes,
      _parsedTags: tags
    };

    return scenario;
  }

  /**
   * Check if scenario matches any of the provided tags
   * @param {import('./types').ScenarioRecord} scenario
   * @param {Array<string>} tags
   * @returns {boolean}
   */
  scenarioMatchesTags(scenario, tags) {
    if (!scenario._parsedTags || scenario._parsedTags.length === 0) {
      return false;
    }
    
    return tags.some(tag => 
      scenario._parsedTags.some(scenarioTag => 
        scenarioTag.toLowerCase().includes(tag.toLowerCase())
      )
    );
  }

  /**
   * Validate that attachment archives exist and are accessible
   * @param {Array<import('./types').ScenarioRecord>} scenarios
   * @returns {Array<Object>} Validation results
   */
  async validateAttachments(scenarios) {
    const results = [];
    
    for (const scenario of scenarios) {
      // Skip validation for scenarios without attachments
      if (!scenario.attachment_archive) {
        const result = {
          scenario_id: scenario.scenario_id,
          attachment_archive: null,
          exists: true, // Mark as valid since no attachment is expected
          error: null,
          noAttachments: true
        };
        logger.debug(`Scenario ${scenario.scenario_id} has no attachments - skipping validation`);
        results.push(result);
        continue;
      }

      const attachmentPath = path.join(this.attachmentsDir, scenario.attachment_archive);
      const result = {
        scenario_id: scenario.scenario_id,
        attachment_archive: scenario.attachment_archive,
        exists: false,
        error: null,
        noAttachments: false
      };
      
      try {
        if (await fs.pathExists(attachmentPath)) {
          // Check if it's a valid ZIP file by trying to read it
          const stats = await fs.stat(attachmentPath);
          if (stats.isFile() && stats.size > 0) {
            result.exists = true;
            logger.debug(`Attachment validated: ${scenario.attachment_archive}`);
          } else {
            result.error = 'File exists but is empty or not a regular file';
          }
        } else {
          result.error = 'File does not exist';
        }
      } catch (error) {
        result.error = error.message;
      }
      
      if (!result.exists) {
        logger.warn(`Attachment validation failed for ${scenario.scenario_id}: ${result.error}`);
      }
      
      results.push(result);
    }
    
    return results;
  }

  /**
   * Create an example scenarios CSV file
   * @param {string} outputPath - Where to create the example file
   */
  async createExampleCsv(outputPath) {
    const exampleContent = `scenario_id,prompt,outcomes,attachment_archive,expected_winner,tags,notes
energy-invest,"Should we invest in renewable energy infrastructure?","Invest,Wait,Reject",energy-invest.zip,Invest,"energy,investment","Q3 strategic decision with attachments"
product-launch,"Launch new product line in emerging markets?","Launch,Delay,Cancel",product-launch.zip,Launch,"product,strategy","New market entry decision"
merger-decision,"Should we proceed with the proposed merger?","Proceed,Negotiate,Reject",merger-decision.zip,,"merger,finance","Board-level strategic decision"
simple-decision,"Should we approve the budget increase for marketing?","Approve,Reject,Modify",,Approve,"budget,simple","Simple text-only decision"
policy-change,"Should we implement remote work policy?","Implement,Delay,Reject",,Implement,"policy,hr","HR policy decision without attachments"`;

    await fs.writeFile(outputPath, exampleContent);
    logger.info(`Created example scenarios CSV: ${outputPath}`);
  }

  /**
   * Get summary statistics about loaded scenarios
   * @param {Array<import('./types').ScenarioRecord>} scenarios
   * @returns {Object}
   */
  getScenarioStats(scenarios) {
    const stats = {
      totalScenarios: scenarios.length,
      uniqueTags: new Set(),
      outcomeCounts: {},
      withExpectedWinner: 0,
      withNotes: 0
    };

    scenarios.forEach(scenario => {
      // Collect tags
      if (scenario._parsedTags) {
        scenario._parsedTags.forEach(tag => stats.uniqueTags.add(tag));
      }

      // Count outcomes
      const outcomeCount = scenario._parsedOutcomes.length;
      stats.outcomeCounts[outcomeCount] = (stats.outcomeCounts[outcomeCount] || 0) + 1;

      // Count scenarios with expected winners and notes
      if (scenario.expected_winner) stats.withExpectedWinner++;
      if (scenario.notes) stats.withNotes++;
    });

    return {
      ...stats,
      uniqueTags: Array.from(stats.uniqueTags).sort()
    };
  }
}

module.exports = new ScenarioLoader(); 